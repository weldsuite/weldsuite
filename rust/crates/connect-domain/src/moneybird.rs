//! The Moneybird connector (`@weldsuite/connectors` `moneybird/client.ts` and
//! `moneybird/auth.ts`): API v2 with an OAuth access token and an
//! administration id. Lists (contacts, invoices, products, purchase
//! invoices, receipts, financial accounts and mutations), the webhook, binary
//! downloads, the write side the WeldBooks → Moneybird push uses, and the
//! OAuth token calls.
//!
//! Every call goes through the outbound HTTP port.

use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::clients::{
    Attempt, ConnectorError, Kind, as_text, classify, parse_retry_after, send, send_within,
    slice500, with_retries,
};
use crate::js::{date_parse, string};
use crate::stripe::{ListPage, Tested, WebhookCreated};

pub const AUTHORIZE_URL: &str = "https://moneybird.com/oauth/authorize";
pub const TOKEN_URL: &str = "https://moneybird.com/oauth/token";
pub const REVOKE_URL: &str = "https://moneybird.com/oauth/revoke";
pub const API_BASE: &str = "https://moneybird.com/api/v2";
pub const SCOPES: [&str; 4] = ["sales_invoices", "documents", "settings", "bank"];
pub const AUTH_STATE_TTL_SECONDS: u64 = 15 * 60;
pub const CALLBACK_PATH: &str = "/weldconnect/connectors/callback";

const DEFAULT_PER_PAGE: u32 = 100;
/// Binary downloads (PDF redirects) can be slower than JSON list calls.
const BINARY_TIMEOUT: Duration = Duration::from_secs(45);

/// `textId(value)`.
fn text_id(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => as_text(value),
    }
}

/// A Moneybird administration.
#[derive(Debug, Clone)]
pub struct Administration {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub currency: Option<String>,
}

impl Administration {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "language": self.language,
            "currency": self.currency,
        })
    }
}

/// `MoneybirdLedgerAccount`.
#[derive(Debug, Clone)]
pub struct LedgerAccount {
    pub id: String,
    pub name: String,
    pub account_type: Option<String>,
    pub account_id: Option<String>,
}

/// `MoneybirdTaxRate`.
#[derive(Debug, Clone)]
pub struct TaxRate {
    pub id: String,
    pub name: String,
    pub percentage: Option<f64>,
    pub tax_rate_type: Option<String>,
    pub country: Option<String>,
    pub active: bool,
}

/// A binary download (`MoneybirdBinaryDownload`).
#[derive(Debug, Clone)]
pub struct Download {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub filename: Option<String>,
}

/// `MoneybirdDocumentAttachmentKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    SalesInvoice,
    PurchaseInvoice,
    Receipt,
}

fn attachment_path(kind: AttachmentKind, document_id: &str, attachment_id: &str) -> String {
    match kind {
        AttachmentKind::SalesInvoice => {
            format!("sales_invoices/{document_id}/attachments/{attachment_id}/download")
        }
        AttachmentKind::PurchaseInvoice => format!(
            "documents/purchase_invoices/{document_id}/attachments/{attachment_id}/download"
        ),
        AttachmentKind::Receipt => {
            format!("documents/receipts/{document_id}/attachments/{attachment_id}/download")
        }
    }
}

/// `filenameFromContentDisposition(header)`.
fn filename_from_disposition(header: Option<&str>) -> Option<String> {
    let header = header.filter(|h| !h.is_empty())?;
    let lower = header.to_ascii_lowercase();
    let strip_quotes = |s: &str| -> String {
        let s = s.strip_prefix('"').unwrap_or(s);
        s.strip_suffix('"').unwrap_or(s).to_owned()
    };
    if let Some(at) = lower.find("filename*=utf-8''") {
        let rest = &header[at + "filename*=utf-8''".len()..];
        let value = rest.split(';').next().unwrap_or_default();
        if !value.is_empty() {
            let cleaned = strip_quotes(value.trim());
            return match urlencoding_decode(&cleaned) {
                Some(decoded) => Some(decoded),
                None => Some(cleaned).filter(|c| !c.is_empty()),
            };
        }
    }
    let at = lower.find("filename=")?;
    let rest = &header[at + "filename=".len()..];
    let rest = rest.strip_prefix('"').unwrap_or(rest);
    let value: String = rest
        .chars()
        .take_while(|c| *c != '"' && *c != ';')
        .collect();
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// `decodeURIComponent(text)`: `None` where it throws (malformed escapes).
fn urlencoding_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn describe_failure(status: u16, snippet: &str, label: &str) -> String {
    if status == 401 || status == 403 {
        "Moneybird rejected the access token".to_owned()
    } else if !snippet.is_empty() {
        format!("Moneybird {label} failed ({status}): {snippet}")
    } else {
        format!("Moneybird {label} failed ({status})")
    }
}

fn http_error(response: &HttpResponse, text: &str, label: &str) -> ConnectorError {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet: String = {
        let units: Vec<u16> = collapsed.encode_utf16().take(200).collect();
        String::from_utf16_lossy(&units)
    };
    ConnectorError {
        message: describe_failure(response.status, &snippet, label),
        status: response.status,
        kind: classify(response.status),
        body: Some(slice500(text)),
        retry_after: parse_retry_after(response.header("retry-after")),
    }
}

/// `parseNextPage(linkHeader, page, itemCount, perPage)`.
fn next_page(link: Option<&str>, page: u32, count: usize, per_page: u32) -> (bool, Option<String>) {
    let short = count < per_page as usize;
    match link.filter(|l| !l.is_empty()) {
        Some(link) => {
            let has_next = link.split(',').any(|part| part.contains("rel=\"next\""));
            (
                !has_next || count == 0,
                has_next.then(|| (page + 1).to_string()),
            )
        }
        None => (
            short || count == 0,
            (!short).then(|| (page + 1).to_string()),
        ),
    }
}

/// `listFilter({ updatedAfter, extra })`.
fn list_filter(updated_after: Option<&str>, extra: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(extra) = extra {
        parts.push(extra.to_owned());
    }
    if let Some(after) = updated_after.filter(|a| !a.is_empty()) {
        parts.push(format!("updated_after:{after}"));
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// `MoneybirdClient`.
#[derive(Debug, Clone)]
pub struct Moneybird {
    pub administration_id: String,
    access_token: String,
}

/// `MoneybirdListOptions`.
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub page: Option<u32>,
    pub per_page: Option<u32>,
    pub updated_after: Option<String>,
}

impl Moneybird {
    /// `new MoneybirdClient({ accessToken, administrationId })`.
    pub fn new(access_token: &str, administration_id: Option<&str>) -> Self {
        Self {
            administration_id: weldsuite_kit::validation::js_trim(
                administration_id.unwrap_or_default(),
            )
            .to_owned(),
            access_token: weldsuite_kit::validation::js_trim(access_token).to_owned(),
        }
    }

    /// As the factory builds it from stored credentials.
    pub fn from_credentials(credentials: &Map<String, Value>, fallback: Option<&str>) -> Self {
        let pick = |key: &str| {
            credentials
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
        };
        Self::new(
            pick("accessToken").unwrap_or_default(),
            pick("administrationId").or(fallback.filter(|f| !f.is_empty())),
        )
    }

    /// `client.storeUrl`.
    pub fn store_url(&self) -> String {
        if self.administration_id.is_empty() {
            "https://moneybird.com".to_owned()
        } else {
            format!("https://moneybird.com/{}", self.administration_id)
        }
    }

    fn not_selected() -> ConnectorError {
        ConnectorError::new(
            "Moneybird administration is not selected",
            400,
            Kind::Permanent,
        )
    }

    /// `buildRequestUrl(path, { search, skipAdmin })`.
    fn url(
        &self,
        path: &str,
        search: &[(&str, Option<String>)],
        skip_admin: bool,
    ) -> Result<String, ConnectorError> {
        if !skip_admin && self.administration_id.is_empty() {
            return Err(Self::not_selected());
        }
        let root = if skip_admin {
            API_BASE.to_owned()
        } else {
            format!("{API_BASE}/{}", self.administration_id)
        };
        let mut url = url::Url::parse(&format!("{root}/{}", path.trim_start_matches('/')))
            .map_err(|_| ConnectorError::new("Moneybird request failed", 400, Kind::Permanent))?;
        if std::path::Path::new(url.path())
            .extension()
            .is_none_or(|ext| ext != "json")
        {
            let with = format!("{}.json", url.path());
            url.set_path(&with);
        }
        let pairs: Vec<(&str, &String)> = search
            .iter()
            .filter_map(|(k, v)| v.as_ref().filter(|v| !v.is_empty()).map(|v| (*k, v)))
            .collect();
        if !pairs.is_empty() {
            let mut query = url.query_pairs_mut();
            for (k, v) in pairs {
                query.append_pair(k, v);
            }
        }
        Ok(url.to_string())
    }

    fn headers(&self, accept: &str, json_body: bool) -> Vec<(String, String)> {
        let mut headers = vec![
            (
                "Authorization".to_owned(),
                format!("Bearer {}", self.access_token),
            ),
            ("Accept".to_owned(), accept.to_owned()),
        ];
        if json_body {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        headers
    }

    /// `request(path, { method, search, body, skipAdmin })`: the parsed JSON
    /// (`null` for an empty body) and the answer's `Link` header.
    async fn request(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        search: &[(&str, Option<String>)],
        body: Option<&Value>,
        skip_admin: bool,
    ) -> Result<(Value, Option<String>), ConnectorError> {
        let url = self.url(path, search, skip_admin)?;
        let request = HttpRequest {
            method: method.to_owned(),
            url,
            headers: self.headers("application/json", body.is_some()),
            body: body.map(|b| b.to_string().into_bytes()),
        };
        let response = with_retries("Could not reach Moneybird", || {
            let request = request.clone();
            async move {
                let response = send(http, request).await?;
                let text = response.text();
                if !response.ok() {
                    return Err(Attempt::Api(http_error(&response, &text, "request")));
                }
                if !text.is_empty() && serde_json::from_str::<Value>(&text).is_err() {
                    return Err(Attempt::Network { timed_out: false });
                }
                Ok(response)
            }
        })
        .await?;
        let text = response.text();
        let data = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        Ok((data, response.header("link").map(str::to_owned)))
    }

    async fn get(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
        search: &[(&str, Option<String>)],
    ) -> Result<Value, ConnectorError> {
        Ok(self
            .request(http, "GET", path, search, None, false)
            .await?
            .0)
    }

    /// `client.test()`.
    pub async fn test(&self, http: Option<&OutboundHttp>) -> Result<Tested, String> {
        let read = if self.administration_id.is_empty() {
            self.list_administrations(http).await.map(|_| ())
        } else {
            self.get(http, "contacts", &[("per_page", Some("1".to_owned()))])
                .await
                .map(|_| ())
        };
        match read {
            Ok(()) => Ok(Tested {
                store_url: self.store_url(),
                account_name: None,
            }),
            Err(error) => Err(error.message),
        }
    }

    /// `client.listAdministrations()`.
    pub async fn list_administrations(
        &self,
        http: Option<&OutboundHttp>,
    ) -> Result<Vec<Administration>, ConnectorError> {
        let (data, _) = self
            .request(http, "GET", "administrations", &[], None, true)
            .await?;
        Ok(array(&data)
            .iter()
            .map(|row| Administration {
                id: text_id(row.get("id")),
                name: administration_name(row),
                language: string(row.get("language")).map(str::to_owned),
                currency: string(row.get("currency")).map(str::to_owned),
            })
            .filter(|a| !a.id.is_empty())
            .collect())
    }

    async fn list_path(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
        options: &ListOptions,
        filter: Option<String>,
    ) -> Result<ListPage, ConnectorError> {
        let page = options.page.unwrap_or(1);
        let per_page = options.per_page.unwrap_or(DEFAULT_PER_PAGE);
        let (data, link) = self
            .request(
                http,
                "GET",
                path,
                &[
                    ("page", Some(page.to_string())),
                    ("per_page", Some(per_page.to_string())),
                    ("filter", filter),
                ],
                None,
                false,
            )
            .await?;
        let items = array(&data);
        let (done, next_cursor) = next_page(link.as_deref(), page, items.len(), per_page);
        Ok(ListPage {
            items,
            done,
            next_cursor,
        })
    }

    pub async fn list_contacts(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let filter = list_filter(options.updated_after.as_deref(), None);
        self.list_path(http, "contacts", options, filter).await
    }

    pub async fn list_sales_invoices(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let filter = list_filter(options.updated_after.as_deref(), Some("state:all"));
        self.list_path(http, "sales_invoices", options, filter)
            .await
    }

    pub async fn list_products(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let filter = list_filter(options.updated_after.as_deref(), None);
        self.list_path(http, "products", options, filter).await
    }

    pub async fn list_purchase_invoices(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let filter = list_filter(options.updated_after.as_deref(), Some("state:all"));
        self.list_path(http, "documents/purchase_invoices", options, filter)
            .await
    }

    pub async fn list_receipts(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let filter = list_filter(options.updated_after.as_deref(), Some("state:all"));
        self.list_path(http, "documents/receipts", options, filter)
            .await
    }

    /// Active financial accounts only, unpaginated.
    pub async fn list_financial_accounts(
        &self,
        http: Option<&OutboundHttp>,
    ) -> Result<ListPage, ConnectorError> {
        let data = self.get(http, "financial_accounts", &[]).await?;
        Ok(ListPage {
            items: array(&data),
            done: true,
            next_cursor: None,
        })
    }

    /// Financial mutations through the synchronisation API: a 1-based page
    /// into the filtered id list, each page posting up to `per_page` ids.
    pub async fn list_financial_mutations(
        &self,
        http: Option<&OutboundHttp>,
        options: &ListOptions,
    ) -> Result<ListPage, ConnectorError> {
        let page = options.page.unwrap_or(1);
        let per_page = options.per_page.unwrap_or(DEFAULT_PER_PAGE) as usize;
        let versions = self
            .get(http, "financial_mutations/synchronization", &[])
            .await?;
        let rows = array(&versions);
        let since = options
            .updated_after
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(date_parse);
        let filtered: Vec<&Value> = match since {
            Some(since) => rows
                .iter()
                .filter(|row| {
                    let version = match row.get("version") {
                        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                        other => weldsuite_kit::validation::js_number_of(other),
                    };
                    if !version.is_finite() {
                        return true;
                    }
                    let ms = if version > 1e12 {
                        version
                    } else {
                        version * 1000.0
                    };
                    ms > since
                })
                .collect(),
            None => rows.iter().collect(),
        };
        let start = (page.max(1) as usize - 1) * per_page;
        let slice: Vec<&&Value> = filtered.iter().skip(start).take(per_page).collect();
        if slice.is_empty() {
            return Ok(ListPage::empty());
        }
        let ids: Vec<String> = slice
            .iter()
            .map(|row| text_id(row.get("id")))
            .filter(|id| !id.is_empty())
            .collect();
        let (data, _) = self
            .request(
                http,
                "POST",
                "financial_mutations/synchronization",
                &[],
                Some(&json!({ "ids": ids })),
                false,
            )
            .await?;
        let done = start + slice.len() >= filtered.len();
        Ok(ListPage {
            items: array(&data),
            done,
            next_cursor: (!done).then(|| (page + 1).to_string()),
        })
    }

    /// `client.listSync(sync, { page, cursor, limit, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        sync_name: &str,
        page: u32,
        cursor: Option<&str>,
        limit: u32,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let page = match cursor.filter(|c| !c.is_empty()) {
            Some(cursor) => {
                let n = weldsuite_kit::validation::js_number(cursor);
                if n.is_finite() && n != 0.0 {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    {
                        n as u32
                    }
                } else {
                    page
                }
            }
            None => page,
        };
        let options = ListOptions {
            page: Some(page),
            per_page: Some(limit),
            updated_after: modified_after.map(str::to_owned),
        };
        match sync_name {
            "moneybird-contacts" => self.list_contacts(http, &options).await,
            "moneybird-sales-invoices" => self.list_sales_invoices(http, &options).await,
            "moneybird-products" => self.list_products(http, &options).await,
            "moneybird-purchase-invoices" => self.list_purchase_invoices(http, &options).await,
            "moneybird-receipts" => self.list_receipts(http, &options).await,
            "moneybird-financial-accounts" => self.list_financial_accounts(http).await,
            "moneybird-financial-mutations" => self.list_financial_mutations(http, &options).await,
            _ => Ok(ListPage::empty()),
        }
    }

    /// `client.hasUpdatesSince(resource, since)`.
    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        since: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        let options = ListOptions {
            page: Some(1),
            per_page: Some(1),
            updated_after: since.map(str::to_owned),
        };
        Ok(match resource {
            "contacts" => !self.list_contacts(http, &options).await?.items.is_empty(),
            "invoices" => !self
                .list_sales_invoices(http, &options)
                .await?
                .items
                .is_empty(),
            "products" => !self.list_products(http, &options).await?.items.is_empty(),
            "bills" => {
                let purchases = self.list_purchase_invoices(http, &options).await?;
                let receipts = self.list_receipts(http, &options).await?;
                !purchases.items.is_empty() || !receipts.items.is_empty()
            }
            "bankAccounts" => {
                let page = self.list_financial_accounts(http).await?;
                let since_ms = since.filter(|s| !s.is_empty()).map(date_parse);
                match since_ms {
                    None | Some(None) => !page.items.is_empty(),
                    Some(Some(since_ms)) => page.items.iter().any(|item| {
                        string(item.get("updated_at"))
                            .and_then(date_parse)
                            .is_some_and(|u| u > since_ms)
                    }),
                }
            }
            "bankTransactions" => !self
                .list_financial_mutations(http, &options)
                .await?
                .items
                .is_empty(),
            _ => false,
        })
    }

    async fn count_path(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
    ) -> Result<usize, ConnectorError> {
        let data = self
            .get(http, &format!("{path}/synchronization"), &[])
            .await?;
        Ok(data.as_array().map_or(0, Vec::len))
    }

    /// `client.countResource(resource)`.
    pub async fn count_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
    ) -> Result<usize, ConnectorError> {
        Ok(match resource {
            "contacts" => self.count_path(http, "contacts").await?,
            "invoices" => self.count_path(http, "sales_invoices").await?,
            "products" => self.count_path(http, "products").await?,
            "bills" => {
                self.count_path(http, "documents/purchase_invoices").await?
                    + self.count_path(http, "documents/receipts").await?
            }
            "bankAccounts" => self.list_financial_accounts(http).await?.items.len(),
            "bankTransactions" => self.count_path(http, "financial_mutations").await?,
            _ => 0,
        })
    }

    /// `client.registerWebhooks({ deliveryUrl, topics })`: one registration.
    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        let mut events: Vec<String> = Vec::new();
        for topic in topics {
            if !events.contains(topic) {
                events.push(topic.clone());
            }
        }
        let (data, _) = self
            .request(
                http,
                "POST",
                "webhooks",
                &[],
                Some(&json!({ "url": delivery_url, "enabled_events": events })),
                false,
            )
            .await?;
        let id = text_id(data.get("id"));
        let topic = match data.get("enabled_events").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .map(|v| v.as_str().map_or_else(|| as_text(v), str::to_owned))
                .collect::<Vec<_>>()
                .join(","),
            None => events.join(","),
        };
        Ok(vec![WebhookCreated {
            id,
            topic,
            delivery_url: string(data.get("url"))
                .map_or_else(|| delivery_url.to_owned(), str::to_owned),
            secret: string(data.get("secret")).map(str::to_owned),
        }])
    }

    /// `client.deleteWebhook(id)`.
    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        self.request(http, "DELETE", &format!("webhooks/{id}"), &[], None, false)
            .await
            .map(|_| ())
    }

    /// `requestBinary(path)`: a download, the redirect followed.
    async fn request_binary(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
    ) -> Result<Download, ConnectorError> {
        if self.administration_id.is_empty() {
            return Err(Self::not_selected());
        }
        let url = self.url(path, &[], false)?;
        let request = HttpRequest {
            method: "GET".to_owned(),
            url,
            headers: self.headers("*/*", false),
            body: None,
        };
        let response = with_retries("Could not reach Moneybird", || {
            let request = request.clone();
            async move {
                let response = send_within(http, request, BINARY_TIMEOUT).await?;
                if !response.ok() {
                    let text = response.text();
                    return Err(Attempt::Api(http_error(&response, &text, "download")));
                }
                Ok(response)
            }
        })
        .await?;
        Ok(Download {
            content_type: response
                .header("content-type")
                .filter(|t| !t.is_empty())
                .unwrap_or("application/octet-stream")
                .to_owned(),
            filename: filename_from_disposition(response.header("content-disposition")),
            bytes: response.body,
        })
    }

    pub async fn download_sales_invoice_pdf(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<Download, ConnectorError> {
        self.request_binary(http, &format!("sales_invoices/{id}/download_pdf"))
            .await
    }

    pub async fn download_document_attachment(
        &self,
        http: Option<&OutboundHttp>,
        kind: AttachmentKind,
        document_id: &str,
        attachment_id: &str,
    ) -> Result<Download, ConnectorError> {
        self.request_binary(http, &attachment_path(kind, document_id, attachment_id))
            .await
    }

    // ── write side (WeldBooks → Moneybird push) ──────────────────────────

    pub async fn list_ledger_accounts(
        &self,
        http: Option<&OutboundHttp>,
    ) -> Result<Vec<LedgerAccount>, ConnectorError> {
        let data = self.get(http, "ledger_accounts", &[]).await?;
        Ok(array(&data)
            .iter()
            .map(|row| LedgerAccount {
                id: text_id(row.get("id")),
                name: string(row.get("name")).map_or_else(|| text_id(row.get("id")), str::to_owned),
                account_type: string(row.get("account_type")).map(str::to_owned),
                account_id: string(row.get("account_id")).map(str::to_owned),
            })
            .filter(|row| !row.id.is_empty())
            .collect())
    }

    pub async fn list_tax_rates(
        &self,
        http: Option<&OutboundHttp>,
    ) -> Result<Vec<TaxRate>, ConnectorError> {
        let data = self
            .get(http, "tax_rates", &[("per_page", Some("100".to_owned()))])
            .await?;
        Ok(array(&data)
            .iter()
            .map(|row| TaxRate {
                id: text_id(row.get("id")),
                name: string(row.get("name")).map_or_else(|| text_id(row.get("id")), str::to_owned),
                percentage: match row.get("percentage") {
                    None | Some(Value::Null) => None,
                    Some(Value::Number(n)) => n.as_f64(),
                    other => Some(weldsuite_kit::validation::js_number_of(other)),
                },
                tax_rate_type: string(row.get("tax_rate_type")).map(str::to_owned),
                country: string(row.get("country")).map(str::to_owned),
                active: row.get("active") != Some(&Value::Bool(false)),
            })
            .filter(|row| !row.id.is_empty())
            .collect())
    }

    /// Contacts matching a free-text query.
    pub async fn search_contacts(
        &self,
        http: Option<&OutboundHttp>,
        query: &str,
    ) -> Result<Vec<Value>, ConnectorError> {
        let data = self
            .get(
                http,
                "contacts",
                &[
                    ("query", Some(query.to_owned())),
                    ("per_page", Some("10".to_owned())),
                ],
            )
            .await?;
        Ok(array(&data))
    }

    async fn post(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, ConnectorError> {
        Ok(self
            .request(http, method, path, &[], Some(body), false)
            .await?
            .0)
    }

    pub async fn create_contact(
        &self,
        http: Option<&OutboundHttp>,
        contact: Value,
    ) -> Result<Value, ConnectorError> {
        self.post(http, "POST", "contacts", &json!({ "contact": contact }))
            .await
    }

    pub async fn create_external_sales_invoice(
        &self,
        http: Option<&OutboundHttp>,
        invoice: Value,
    ) -> Result<Value, ConnectorError> {
        self.post(
            http,
            "POST",
            "external_sales_invoices",
            &json!({ "external_sales_invoice": invoice }),
        )
        .await
    }

    pub async fn delete_external_sales_invoice(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        self.request(
            http,
            "DELETE",
            &format!("external_sales_invoices/{id}"),
            &[],
            None,
            false,
        )
        .await
        .map(|_| ())
    }

    pub async fn create_external_sales_invoice_payment(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
        payment: Value,
    ) -> Result<Value, ConnectorError> {
        self.post(
            http,
            "POST",
            &format!("external_sales_invoices/{id}/payments"),
            &json!({ "payment": payment }),
        )
        .await
    }

    /// `uploadExternalSalesInvoiceAttachment(id, file)`: a multipart form
    /// with the file as `file`.
    pub async fn upload_external_sales_invoice_attachment(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
        bytes: &[u8],
        filename: &str,
        content_type: &str,
    ) -> Result<(), ConnectorError> {
        let url = self.url(
            &format!("external_sales_invoices/{id}/attachment"),
            &[],
            false,
        )?;
        let boundary = format!("----WeldSuiteFormBoundary{}", uuid_like());
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n\r\n",
                filename.replace('"', "%22")
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut headers = self.headers("application/json", false);
        headers.push((
            "Content-Type".to_owned(),
            format!("multipart/form-data; boundary={boundary}"),
        ));
        let request = HttpRequest {
            method: "POST".to_owned(),
            url,
            headers,
            body: Some(body),
        };
        with_retries("Could not reach Moneybird", || {
            let request = request.clone();
            async move {
                let response = send_within(http, request, BINARY_TIMEOUT).await?;
                if !response.ok() {
                    let text = response.text();
                    return Err(Attempt::Api(http_error(&response, &text, "request")));
                }
                Ok(response)
            }
        })
        .await
        .map(|_| ())
    }

    /// `createFinancialStatement(...)`: lines as an index-keyed hash.
    pub async fn create_financial_statement(
        &self,
        http: Option<&OutboundHttp>,
        financial_account_id: &str,
        reference: &str,
        official_date: Option<&str>,
        mutations: &[Value],
    ) -> Result<Value, ConnectorError> {
        let mut attributes = Map::new();
        for (index, mutation) in mutations.iter().enumerate() {
            attributes.insert((index + 1).to_string(), mutation.clone());
        }
        let mut statement = Map::new();
        statement.insert(
            "financial_account_id".to_owned(),
            json!(financial_account_id),
        );
        statement.insert("reference".to_owned(), json!(reference));
        if let Some(date) = official_date.filter(|d| !d.is_empty()) {
            statement.insert("official_date".to_owned(), json!(date));
        }
        statement.insert(
            "financial_mutations_attributes".to_owned(),
            Value::Object(attributes),
        );
        self.post(
            http,
            "POST",
            "financial_statements",
            &json!({ "financial_statement": statement }),
        )
        .await
    }

    /// `linkFinancialMutation(id, booking)`.
    pub async fn link_financial_mutation(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
        booking_type: &str,
        booking_id: &str,
        price_base: &str,
        description: Option<&str>,
    ) -> Result<(), ConnectorError> {
        let mut body = Map::new();
        body.insert("booking_type".to_owned(), json!(booking_type));
        body.insert("booking_id".to_owned(), json!(booking_id));
        body.insert("price_base".to_owned(), json!(price_base));
        if let Some(description) = description.filter(|d| !d.is_empty()) {
            body.insert("description".to_owned(), json!(description));
        }
        self.post(
            http,
            "PATCH",
            &format!("financial_mutations/{id}/link_booking"),
            &Value::Object(body),
        )
        .await
        .map(|_| ())
    }
}

fn uuid_like() -> String {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    format!("{nanos:x}")
}

/// `administrationName(row)`.
fn administration_name(row: &Value) -> String {
    if let Some(name) = string(row.get("name")) {
        return name.to_owned();
    }
    if let Some(name) = string(row.get("company_name")) {
        return name.to_owned();
    }
    match row.get("id") {
        None => String::new(),
        Some(id) => as_text(id),
    }
}

// ── OAuth (`moneybird/auth.ts`) ─────────────────────────────────────────────

/// `moneybirdRedirectUri(publicAppUrl)`.
pub fn redirect_uri(public_app_url: &str) -> String {
    format!("{}{CALLBACK_PATH}", public_app_url.trim_end_matches('/'))
}

/// `buildMoneybirdAuthorizeUrl({ clientId, redirectUri, state })`.
pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("scope", &SCOPES.join(" "))
        .finish();
    format!("{AUTHORIZE_URL}?{query}")
}

/// `MoneybirdOAuthTokens`.
#[derive(Debug, Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
}

/// A token call that failed: the `Error`'s message; `network` when `fetch`
/// threw or the answer was not JSON (`JSON.parse` threw).
#[derive(Debug, Clone)]
pub struct OAuthError {
    pub message: String,
    pub network: bool,
}

async fn token_request(
    http: Option<&OutboundHttp>,
    fields: &[(&str, &str)],
) -> Result<OAuthTokens, OAuthError> {
    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in fields {
            form.append_pair(k, v);
        }
        form.finish()
    };
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: TOKEN_URL.to_owned(),
        headers: vec![
            ("Accept".to_owned(), "application/json".to_owned()),
            (
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
        ],
        body: Some(body.into_bytes()),
    };
    let Some(http) = http else {
        return Err(OAuthError {
            message: "fetch failed".to_owned(),
            network: true,
        });
    };
    let response = http.send(request).await.map_err(|e| OAuthError {
        message: e.to_string(),
        network: true,
    })?;
    if !response.ok() {
        return Err(OAuthError {
            message: format!("Moneybird token request failed ({})", response.status),
            network: false,
        });
    }
    let text = response.text();
    let json: Value = if text.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).map_err(|e| OAuthError {
            message: e.to_string(),
            network: true,
        })?
    };
    let access_token = string(json.get("access_token")).unwrap_or_default();
    if access_token.is_empty() {
        return Err(OAuthError {
            message: "Moneybird token response did not include an access token".to_owned(),
            network: false,
        });
    }
    Ok(OAuthTokens {
        access_token: access_token.to_owned(),
        refresh_token: string(json.get("refresh_token")).map(str::to_owned),
        scope: string(json.get("scope")).map(str::to_owned),
    })
}

/// `exchangeMoneybirdCode({ clientId, clientSecret, code, redirectUri })`.
pub async fn exchange_code(
    http: Option<&OutboundHttp>,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, OAuthError> {
    token_request(
        http,
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ],
    )
    .await
}

/// `refreshMoneybirdToken({ clientId, clientSecret, refreshToken })`.
pub async fn refresh_token(
    http: Option<&OutboundHttp>,
    client_id: &str,
    client_secret: &str,
    refresh: &str,
) -> Result<OAuthTokens, OAuthError> {
    token_request(
        http,
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_paging() {
        let client = Moneybird::new(" tok ", Some("123"));
        assert_eq!(
            client
                .url(
                    "contacts",
                    &[
                        ("page", Some("1".to_owned())),
                        (
                            "filter",
                            Some("state:all,updated_after:2026-01-01".to_owned())
                        )
                    ],
                    false
                )
                .expect("url"),
            "https://moneybird.com/api/v2/123/contacts.json?page=1&filter=state%3Aall%2Cupdated_after%3A2026-01-01"
        );
        assert!(
            Moneybird::new("t", None)
                .url("contacts", &[], false)
                .is_err()
        );
        assert_eq!(next_page(None, 1, 100, 100), (false, Some("2".to_owned())));
        assert_eq!(next_page(None, 1, 3, 100), (true, None));
        assert_eq!(
            next_page(Some("<x>; rel=\"next\""), 2, 5, 100),
            (false, Some("3".to_owned()))
        );
        assert_eq!(
            filename_from_disposition(Some("attachment; filename=\"inv 1.pdf\"")),
            Some("inv 1.pdf".to_owned())
        );
        assert_eq!(
            filename_from_disposition(Some("attachment; filename*=UTF-8''a%20b.pdf")),
            Some("a b.pdf".to_owned())
        );
    }
}
