//! The Stripe connector (`@weldsuite/connectors` `stripe/client.ts` and
//! `stripe/auth.ts`): finalized invoices, the balance per currency, and paid
//! payouts with the balance transactions they settled, read with a pasted
//! key or the platform key plus `Stripe-Account` (Connect OAuth); the
//! webhook endpoint of an API-key connection; and the Connect OAuth calls.
//!
//! Every call goes through the outbound HTTP port.

use std::sync::LazyLock;

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::clients::{
    Attempt, ConnectorError, Kind, classify, parse_retry_after, send, slice500, with_retries,
};
use crate::js::{
    date_parse, encode_uri_component, iso_from_unix, now_iso, number_value, record, string,
};

pub const STRIPE_API_BASE: &str = "https://api.stripe.com/v1";
pub const STRIPE_API_VERSION: &str = "2024-06-20";

/// Invoice events that change what we import.
pub const INVOICE_EVENT_TYPES: [&str; 6] = [
    "invoice.finalized",
    "invoice.updated",
    "invoice.paid",
    "invoice.payment_succeeded",
    "invoice.voided",
    "invoice.marked_uncollectible",
];
pub const PAYOUT_EVENT_TYPES: [&str; 1] = ["payout.paid"];

const INVOICES_PER_PAGE: u32 = 50;
const EVENTS_PER_PAGE: u32 = 50;
const PAYOUTS_PER_PAGE: u32 = 5;
/// Paid payouts can be created well before they land; re-read this far back.
const PAYOUT_LOOKBACK_SECONDS: i64 = 14 * 24 * 60 * 60;

const ZERO_DECIMAL: [&str; 16] = [
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV",
    "XAF", "XOF", "XPF",
];
const THREE_DECIMAL: [&str; 5] = ["BHD", "JOD", "KWD", "OMR", "TND"];

/// `stripeMinorUnits(currency)`.
pub fn minor_units(currency: Option<&str>) -> i32 {
    let code = currency.unwrap_or_default().to_uppercase();
    if ZERO_DECIMAL.contains(&code.as_str()) {
        0
    } else if THREE_DECIMAL.contains(&code.as_str()) {
        3
    } else {
        2
    }
}

/// `stripeAmountToDecimal(amount, currency, places)`.
pub fn amount_to_decimal(amount: Option<&Value>, currency: Option<&str>, places: usize) -> String {
    let raw = match amount {
        Some(Value::String(text)) => Some(weldsuite_kit::validation::js_number(text)),
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    match raw.filter(|n| n.is_finite()) {
        None => crate::js::to_fixed(0.0, places),
        Some(raw) => crate::js::to_fixed(raw / 10f64.powi(minor_units(currency)), places),
    }
}

/// `stripeBalanceAccountId(currency)`.
pub fn balance_account_id(currency: &str) -> String {
    format!("balance_{}", currency.to_uppercase())
}

/// `unixFromDate(value)`.
fn unix_from_date(value: Option<&str>) -> Option<i64> {
    let value = value.filter(|v| !v.is_empty())?;
    let text = if value.encode_utf16().count() == 10 {
        format!("{value}T00:00:00Z")
    } else {
        value.to_owned()
    };
    #[allow(clippy::cast_possible_truncation)]
    date_parse(&text).map(|ms| (ms / 1000.0).floor() as i64)
}

/// `idOf(value)`: a non-empty string, or an object's string `id`.
pub fn id_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        other => record(other)
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn records(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter(|i| i.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// `toList(value)`.
fn to_list(value: &Value) -> (Vec<Value>, bool) {
    let r = record(Some(value));
    (
        records(r.and_then(|r| r.get("data"))),
        r.and_then(|r| r.get("has_more")) == Some(&Value::Bool(true)),
    )
}

/// `describeStripeError(status, text)`.
fn describe_error(status: u16, text: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(text)
        && let Some(message) = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
    {
        return format!("Stripe: {message}");
    }
    match status {
        401 => "Stripe rejected the API key".to_owned(),
        403 => "The Stripe key is missing a permission this connector needs".to_owned(),
        _ => format!("Stripe request failed ({status})"),
    }
}

/// `fetch` threw: the request never got an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchFailed;

/// A connector list page (`ConnectorListPage`).
#[derive(Debug, Clone, Default)]
pub struct ListPage {
    pub items: Vec<Value>,
    pub done: bool,
    pub next_cursor: Option<String>,
}

impl ListPage {
    pub fn empty() -> Self {
        Self {
            items: Vec::new(),
            done: true,
            next_cursor: None,
        }
    }
}

/// A webhook a provider created (`ConnectorWebhookCreated`).
#[derive(Debug, Clone)]
pub struct WebhookCreated {
    pub id: String,
    pub topic: String,
    pub delivery_url: String,
    pub secret: Option<String>,
}

/// What `client.test()` answered.
#[derive(Debug, Clone)]
pub struct Tested {
    pub store_url: String,
    pub account_name: Option<String>,
}

/// `StripeAuthMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    ApiKey,
    OAuth,
}

/// `StripeClient`.
#[derive(Debug, Clone)]
pub struct Stripe {
    pub account_id: Option<String>,
    pub mode: Mode,
    bearer: String,
    send_account_header: bool,
    import_start: Option<i64>,
}

fn trimmed(credentials: &Map<String, Value>, key: &str) -> String {
    weldsuite_kit::validation::js_trim(
        credentials
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .to_owned()
}

impl Stripe {
    /// `new StripeClient({ apiKey, accountId, platformSecretKey,
    /// importStartDate })` as the factory builds it from credentials.
    pub fn from_credentials(credentials: &Map<String, Value>, fallback: Option<&str>) -> Self {
        let pick = |key: &str| {
            credentials
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let account =
            pick("stripeUserId").or_else(|| fallback.filter(|f| !f.is_empty()).map(str::to_owned));
        let api_key = trimmed(credentials, "apiKey");
        let platform = trimmed(credentials, "platformSecretKey");
        let account_id = account
            .map(|a| weldsuite_kit::validation::js_trim(&a).to_owned())
            .filter(|a| !a.is_empty());
        let mode = if api_key.is_empty() {
            Mode::OAuth
        } else {
            Mode::ApiKey
        };
        let use_platform = api_key.is_empty() && !platform.is_empty() && account_id.is_some();
        let bearer = if !api_key.is_empty() {
            api_key
        } else if use_platform {
            platform
        } else {
            // No `accessToken`: the factory never passes one.
            String::new()
        };
        Self {
            account_id,
            mode,
            bearer,
            send_account_header: use_platform,
            import_start: unix_from_date(pick("importStartDate").as_deref()),
        }
    }

    /// `client.storeUrl`.
    pub fn store_url(&self) -> String {
        self.account_id
            .clone()
            .unwrap_or_else(|| "stripe".to_owned())
    }

    async fn request(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, ConnectorError> {
        if self.bearer.is_empty() {
            return Err(ConnectorError::new(
                "Stripe is not connected (no API key)",
                401,
                Kind::Auth,
            ));
        }
        let mut url = format!("{STRIPE_API_BASE}/{}", path.trim_start_matches('/'));
        let encoded = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in params {
                form.append_pair(key, value);
            }
            form.finish()
        };
        let mut headers = vec![
            (
                "Authorization".to_owned(),
                format!("Bearer {}", self.bearer),
            ),
            ("Stripe-Version".to_owned(), STRIPE_API_VERSION.to_owned()),
            ("Accept".to_owned(), "application/json".to_owned()),
        ];
        if self.send_account_header
            && let Some(account) = &self.account_id
        {
            headers.push(("Stripe-Account".to_owned(), account.clone()));
        }
        let body = if method == "GET" {
            if !encoded.is_empty() {
                url.push('?');
                url.push_str(&encoded);
            }
            None
        } else {
            if method == "POST" {
                headers.push((
                    "Content-Type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ));
            }
            (method == "POST").then(|| encoded.into_bytes())
        };
        let request = HttpRequest {
            method: method.to_owned(),
            url,
            headers,
            body,
        };
        let response = with_retries("Could not reach Stripe", || {
            let request = request.clone();
            async move {
                let response = send(http, request).await?;
                let text = response.text();
                if !response.ok() {
                    return Err(Attempt::Api(ConnectorError {
                        message: describe_error(response.status, &text),
                        status: response.status,
                        kind: classify(response.status),
                        body: Some(slice500(&text)),
                        retry_after: parse_retry_after(response.header("retry-after")),
                    }));
                }
                if text.is_empty() {
                    return Ok(response);
                }
                // `JSON.parse` throwing is a failed attempt like a network error.
                match serde_json::from_str::<Value>(&text) {
                    Ok(_) => Ok(response),
                    Err(_) => Err(Attempt::Network { timed_out: false }),
                }
            }
        })
        .await?;
        let text = response.text();
        if text.is_empty() {
            return Ok(json!({}));
        }
        Ok(serde_json::from_str(&text).unwrap_or_else(|_| json!({})))
    }

    async fn get(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, ConnectorError> {
        self.request(http, "GET", path, params).await
    }

    /// `client.test()`.
    pub async fn test(&self, http: Option<&OutboundHttp>) -> Result<Tested, String> {
        match self.get(http, "account", &[]).await {
            Ok(account) => {
                let id = id_of(Some(&account));
                let dashboard = record(account.get("settings"))
                    .and_then(|s| s.get("dashboard"))
                    .and_then(Value::as_object);
                let profile = record(account.get("business_profile"));
                let name = dashboard
                    .and_then(|d| d.get("display_name"))
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())
                    .or_else(|| {
                        profile
                            .and_then(|p| p.get("name"))
                            .and_then(Value::as_str)
                            .filter(|n| !n.is_empty())
                    })
                    .map(str::to_owned);
                Ok(Tested {
                    store_url: id.unwrap_or_else(|| self.store_url()),
                    account_name: name,
                })
            }
            Err(error) if error.status == 403 && self.mode == Mode::ApiKey => {
                match self.get(http, "balance", &[]).await {
                    Ok(_) => {
                        let tail: String = {
                            let units: Vec<u16> = self.bearer.encode_utf16().collect();
                            String::from_utf16_lossy(&units[units.len().saturating_sub(4)..])
                        };
                        Ok(Tested {
                            store_url: self
                                .account_id
                                .clone()
                                .unwrap_or_else(|| format!("key_{tail}")),
                            account_name: None,
                        })
                    }
                    Err(inner) => Err(inner.message),
                }
            }
            Err(error) => Err(error.message),
        }
    }

    // ── invoices ───────────────────────────────────────────────────────────

    /// `completeInvoice(invoice, modifiedAt)`.
    async fn complete_invoice(
        &self,
        http: Option<&OutboundHttp>,
        invoice: Value,
        modified_at: Option<String>,
    ) -> Result<Value, ConnectorError> {
        let (data, has_more) = to_list(invoice.get("lines").unwrap_or(&Value::Null));
        let mut lines = data;
        if has_more && let Some(id) = invoice.get("id").and_then(Value::as_str) {
            lines = self
                .list_all(http, &format!("invoices/{id}/lines"), &[])
                .await?;
        }
        let created = invoice.get("created").and_then(Value::as_f64);
        let updated_at = modified_at.or_else(|| iso_from_unix(invoice.get("created")));
        let skip = match (self.import_start, created) {
            #[allow(clippy::cast_precision_loss)]
            (Some(start), Some(created)) => created < start as f64,
            _ => false,
        };
        let mut out = invoice.as_object().cloned().unwrap_or_default();
        out.insert(
            "lines".to_owned(),
            json!({ "object": "list", "data": lines, "has_more": false }),
        );
        out.insert("updated_at".to_owned(), json!(updated_at));
        out.insert("_weld_skip".to_owned(), json!(skip));
        Ok(Value::Object(out))
    }

    /// `listAll(path, params)`: up to 50 pages of 100.
    async fn list_all(
        &self,
        http: Option<&OutboundHttp>,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Vec<Value>, ConnectorError> {
        let mut out = Vec::new();
        let mut starting_after: Option<String> = None;
        for _ in 0..50 {
            let mut all = params.to_vec();
            all.push(("limit".to_owned(), "100".to_owned()));
            if let Some(after) = &starting_after {
                all.push(("starting_after".to_owned(), after.clone()));
            }
            let (data, has_more) = to_list(&self.get(http, path, &all).await?);
            let last_id = data
                .last()
                .and_then(|l| l.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let empty = data.is_empty();
            out.extend(data);
            match last_id {
                Some(id) if has_more && !empty => starting_after = Some(id),
                _ => break,
            }
        }
        Ok(out)
    }

    /// `client.getInvoice(id, modifiedAt)`: `None` on a 404.
    pub async fn get_invoice(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
        modified_at: Option<String>,
    ) -> Result<Option<Value>, ConnectorError> {
        let params = [(
            "expand[]".to_owned(),
            "total_tax_amounts.tax_rate".to_owned(),
        )];
        match self
            .get(
                http,
                &format!("invoices/{}", encode_uri_component(id)),
                &params,
            )
            .await
        {
            Ok(invoice) => Ok(Some(
                self.complete_invoice(http, invoice, modified_at).await?,
            )),
            Err(error) if error.status == 404 => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn list_invoices(
        &self,
        http: Option<&OutboundHttp>,
        cursor: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let mut params = vec![
            ("limit".to_owned(), INVOICES_PER_PAGE.to_string()),
            (
                "expand[]".to_owned(),
                "data.total_tax_amounts.tax_rate".to_owned(),
            ),
        ];
        if let Some(start) = self.import_start {
            params.push(("created[gte]".to_owned(), start.to_string()));
        }
        if let Some(cursor) = cursor {
            params.push(("starting_after".to_owned(), cursor.to_owned()));
        }
        let (data, has_more) = to_list(&self.get(http, "invoices", &params).await?);
        let next = if has_more { id_of(data.last()) } else { None };
        let mut items = Vec::with_capacity(data.len());
        for invoice in data {
            items.push(self.complete_invoice(http, invoice, None).await?);
        }
        Ok(ListPage {
            items,
            done: !has_more,
            next_cursor: next,
        })
    }

    async fn list_events(
        &self,
        http: Option<&OutboundHttp>,
        types: &[&str],
        since: i64,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<Value>, bool), ConnectorError> {
        let mut params = vec![
            ("limit".to_owned(), limit.to_string()),
            ("created[gt]".to_owned(), since.to_string()),
        ];
        for kind in types {
            params.push(("types[]".to_owned(), (*kind).to_owned()));
        }
        if let Some(cursor) = cursor {
            params.push(("starting_after".to_owned(), cursor.to_owned()));
        }
        Ok(to_list(&self.get(http, "events", &params).await?))
    }

    async fn list_changed_invoices(
        &self,
        http: Option<&OutboundHttp>,
        cursor: Option<&str>,
        since: &str,
    ) -> Result<ListPage, ConnectorError> {
        let since_unix = unix_from_date(Some(since)).unwrap_or(0);
        let (events, has_more) = self
            .list_events(
                http,
                &INVOICE_EVENT_TYPES,
                since_unix,
                cursor,
                EVENTS_PER_PAGE,
            )
            .await?;
        let mut newest: Vec<(String, Option<String>)> = Vec::new();
        for event in &events {
            let object = record(event.get("data")).and_then(|d| d.get("object"));
            let Some(invoice_id) = id_of(object.filter(|o| o.is_object())) else {
                continue;
            };
            if !newest.iter().any(|(id, _)| *id == invoice_id) {
                newest.push((invoice_id, iso_from_unix(event.get("created"))));
            }
        }
        let mut items = Vec::new();
        for (id, at) in newest {
            if let Some(invoice) = self.get_invoice(http, &id, at).await? {
                items.push(invoice);
            }
        }
        Ok(ListPage {
            items,
            done: !has_more,
            next_cursor: if has_more { id_of(events.last()) } else { None },
        })
    }

    // ── balance ────────────────────────────────────────────────────────────

    async fn list_balances(&self, http: Option<&OutboundHttp>) -> Result<ListPage, ConnectorError> {
        let balance = self.get(http, "balance", &[]).await?;
        let mut by_currency: Vec<(String, f64, f64)> = Vec::new();
        for (index, bucket) in ["available", "pending"].into_iter().enumerate() {
            for row in records(balance.get(bucket)) {
                let Some(currency) = row.get("currency").and_then(Value::as_str) else {
                    continue;
                };
                let currency = currency.to_uppercase();
                let amount = row.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
                let entry = match by_currency.iter_mut().position(|(c, _, _)| *c == currency) {
                    Some(at) => &mut by_currency[at],
                    None => {
                        by_currency.push((currency, 0.0, 0.0));
                        by_currency.last_mut().expect("just pushed")
                    }
                };
                if index == 0 {
                    entry.1 += amount;
                } else {
                    entry.2 += amount;
                }
            }
        }
        let items = by_currency
            .into_iter()
            .map(|(currency, available, pending)| {
                json!({
                    "id": balance_account_id(&currency),
                    "object": "stripe_balance",
                    "currency": currency,
                    "available": number_value(available),
                    "pending": number_value(pending),
                    "account_id": self.account_id,
                })
            })
            .collect();
        Ok(ListPage {
            items,
            done: true,
            next_cursor: None,
        })
    }

    /// `client.payoutLines(payout)`: gross, fee, and the payout itself.
    pub async fn payout_lines(
        &self,
        http: Option<&OutboundHttp>,
        payout: &Value,
    ) -> Result<Vec<Value>, ConnectorError> {
        let Some(payout_id) = id_of(Some(payout)) else {
            return Ok(Vec::new());
        };
        let currency = payout
            .get("currency")
            .and_then(Value::as_str)
            .map_or_else(|| "EUR".to_owned(), str::to_uppercase);
        let mut base = Map::new();
        base.insert("object".to_owned(), json!("stripe_line"));
        base.insert("payout_id".to_owned(), json!(payout_id));
        base.insert(
            "payout_arrival_date".to_owned(),
            json!(iso_from_unix(payout.get("arrival_date"))),
        );
        base.insert(
            "balance_account".to_owned(),
            json!(balance_account_id(&currency)),
        );
        base.insert(
            "updated_at".to_owned(),
            json!(iso_from_unix(payout.get("created"))),
        );
        let transactions = if payout.get("automatic") == Some(&Value::Bool(true)) {
            self.list_all(
                http,
                "balance_transactions",
                &[
                    ("payout".to_owned(), payout_id.clone()),
                    ("expand[]".to_owned(), "data.source".to_owned()),
                ],
            )
            .await?
        } else {
            Vec::new()
        };
        let mut lines: Vec<Value> = transactions
            .iter()
            .flat_map(|txn| transaction_lines(txn, &base, &currency))
            .collect();
        if !lines.iter().any(|l| l["line"] == "payout") {
            lines.push(payout_own_line(payout, &payout_id, &base, &currency));
        }
        Ok(lines)
    }

    fn payout_lower_bound(&self, modified_after: Option<&str>) -> Option<i64> {
        let incremental = unix_from_date(modified_after).map(|s| s - PAYOUT_LOOKBACK_SECONDS);
        match (incremental, self.import_start) {
            (None, start) => start,
            (Some(inc), None) => Some(inc),
            (Some(inc), Some(start)) => Some(inc.max(start)),
        }
    }

    async fn list_payout_lines(
        &self,
        http: Option<&OutboundHttp>,
        cursor: Option<&str>,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let mut params = vec![
            ("limit".to_owned(), PAYOUTS_PER_PAGE.to_string()),
            ("status".to_owned(), "paid".to_owned()),
        ];
        if let Some(lower) = self.payout_lower_bound(modified_after) {
            params.push(("created[gte]".to_owned(), lower.to_string()));
        }
        if let Some(cursor) = cursor {
            params.push(("starting_after".to_owned(), cursor.to_owned()));
        }
        let (data, has_more) = to_list(&self.get(http, "payouts", &params).await?);
        let mut items = Vec::new();
        for payout in &data {
            items.extend(self.payout_lines(http, payout).await?);
        }
        Ok(ListPage {
            items,
            done: !has_more,
            next_cursor: if has_more { id_of(data.last()) } else { None },
        })
    }

    /// `client.getPayout(id)`: `None` on a 404.
    pub async fn get_payout(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<Option<Value>, ConnectorError> {
        match self
            .get(http, &format!("payouts/{}", encode_uri_component(id)), &[])
            .await
        {
            Ok(payout) => Ok(Some(payout)),
            Err(error) if error.status == 404 => Ok(None),
            Err(error) => Err(error),
        }
    }

    // ── connector surface ─────────────────────────────────────────────────

    /// `client.listSync(sync, { cursor, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        sync_name: &str,
        cursor: Option<&str>,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        match sync_name {
            "stripe-invoices" => match modified_after.filter(|m| !m.is_empty()) {
                Some(since) => self.list_changed_invoices(http, cursor, since).await,
                None => self.list_invoices(http, cursor).await,
            },
            "stripe-balances" => self.list_balances(http).await,
            "stripe-balance-transactions" => {
                self.list_payout_lines(http, cursor, modified_after).await
            }
            _ => Ok(ListPage::empty()),
        }
    }

    /// `client.hydrateWebhookRecords(sync, record)`: re-read truncated
    /// invoices and expand a payout into its lines.
    pub async fn hydrate_webhook_records(
        &self,
        http: Option<&OutboundHttp>,
        sync_name: &str,
        record: &Value,
    ) -> Result<Vec<Value>, ConnectorError> {
        let Some(id) = id_of(Some(record)) else {
            return Ok(Vec::new());
        };
        if sync_name == "stripe-invoices" {
            return Ok(self
                .get_invoice(http, &id, Some(now_iso()))
                .await?
                .into_iter()
                .collect());
        }
        if sync_name == "stripe-balance-transactions" {
            let Some(payout) = self.get_payout(http, &id).await? else {
                return Ok(Vec::new());
            };
            if payout.get("status").and_then(Value::as_str) != Some("paid") {
                return Ok(Vec::new());
            }
            let created = payout.get("created").and_then(Value::as_f64);
            #[allow(clippy::cast_precision_loss)]
            if let (Some(start), Some(created)) = (self.import_start, created)
                && created < start as f64
            {
                return Ok(Vec::new());
            }
            return self.payout_lines(http, &payout).await;
        }
        Ok(vec![record.clone()])
    }

    /// `client.hasUpdatesSince(resource, since)`.
    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        since: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        let since = since.filter(|s| !s.is_empty());
        if resource == "bankAccounts" {
            return Ok(since.is_none());
        }
        if resource != "invoices" && resource != "bankTransactions" {
            return Ok(false);
        }
        let Some(since) = since else {
            return Ok(true);
        };
        let types: &[&str] = if resource == "invoices" {
            &INVOICE_EVENT_TYPES
        } else {
            &PAYOUT_EVENT_TYPES
        };
        let Some(since_unix) = unix_from_date(Some(since)) else {
            return Ok(true);
        };
        let (events, _) = self.list_events(http, types, since_unix, None, 1).await?;
        Ok(!events.is_empty())
    }

    /// `client.registerWebhooks(...)`: API-key connections only.
    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        if self.mode != Mode::ApiKey {
            return Ok(Vec::new());
        }
        let mut events: Vec<String> = Vec::new();
        for topic in topics {
            if !events.contains(topic) {
                events.push(topic.clone());
            }
        }
        let mut params = vec![
            ("url".to_owned(), delivery_url.to_owned()),
            ("api_version".to_owned(), STRIPE_API_VERSION.to_owned()),
            (
                "description".to_owned(),
                "WeldSuite (WeldBooks import)".to_owned(),
            ),
        ];
        for event in &events {
            params.push(("enabled_events[]".to_owned(), event.clone()));
        }
        let created = self
            .request(http, "POST", "webhook_endpoints", &params)
            .await?;
        Ok(vec![WebhookCreated {
            id: id_of(Some(&created)).unwrap_or_default(),
            topic: events.join(","),
            delivery_url: string(created.get("url"))
                .map_or_else(|| delivery_url.to_owned(), str::to_owned),
            secret: string(created.get("secret")).map(str::to_owned),
        }])
    }

    /// `client.deleteWebhook(id)`.
    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        if self.mode != Mode::ApiKey {
            return Ok(());
        }
        self.request(
            http,
            "DELETE",
            &format!("webhook_endpoints/{}", encode_uri_component(id)),
            &[],
        )
        .await
        .map(|_| ())
    }

    /// `client.downloadInvoicePdf(url)`: Stripe's hosted invoice PDF, no auth
    /// header. `Ok(None)` for a link that is not Stripe's or a failed answer;
    /// `Err` when the request never got an answer (`fetch` threw).
    pub async fn download_invoice_pdf(
        &self,
        http: Option<&OutboundHttp>,
        url: &str,
    ) -> Result<Option<(Vec<u8>, String)>, FetchFailed> {
        static STRIPE_HOST: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)^https://([a-z0-9-]+\.)*stripe\.com/").expect("pattern")
        });
        if !STRIPE_HOST.is_match(url) {
            return Ok(None);
        }
        let Some(http) = http else {
            return Err(FetchFailed);
        };
        let response = http
            .send(HttpRequest::empty("GET", url))
            .await
            .map_err(|_| FetchFailed)?;
        if !response.ok() {
            return Ok(None);
        }
        let content_type = response
            .header("content-type")
            .filter(|t| !t.is_empty())
            .unwrap_or("application/pdf")
            .to_owned();
        Ok(Some((response.body, content_type)))
    }
}

/// A balance transaction as one gross line (or the payout line), plus its
/// fee as a line of its own.
fn transaction_lines(txn: &Value, base: &Map<String, Value>, payout_currency: &str) -> Vec<Value> {
    let kind = string(txn.get("type")).unwrap_or("adjustment");
    let currency =
        string(txn.get("currency")).map_or_else(|| payout_currency.to_owned(), str::to_uppercase);
    let source = record(txn.get("source"));
    let charge = source.filter(|s| s.get("object").and_then(Value::as_str) == Some("charge"));
    let billing = charge.and_then(|c| record(c.get("billing_details")));
    let mut shared = base.clone();
    shared.insert(
        "balance_transaction_id".to_owned(),
        txn.get("id").cloned().unwrap_or(Value::Null),
    );
    shared.insert("currency".to_owned(), json!(currency));
    shared.insert(
        "created".to_owned(),
        json!(iso_from_unix(txn.get("created"))),
    );
    shared.insert(
        "available_on".to_owned(),
        json!(iso_from_unix(txn.get("available_on"))),
    );
    shared.insert("source_id".to_owned(), json!(id_of(txn.get("source"))));
    let charge_value = charge.map(|c| Value::Object(c.clone()));
    let mut gross = shared.clone();
    gross.insert(
        "id".to_owned(),
        txn.get("id").cloned().unwrap_or(Value::Null),
    );
    gross.insert(
        "line".to_owned(),
        json!(if kind == "payout" { "payout" } else { "gross" }),
    );
    gross.insert("type".to_owned(), json!(kind));
    gross.insert(
        "reporting_category".to_owned(),
        txn.get("reporting_category")
            .cloned()
            .unwrap_or(Value::Null),
    );
    gross.insert(
        "amount".to_owned(),
        txn.get("amount").cloned().unwrap_or(Value::Null),
    );
    gross.insert(
        "description".to_owned(),
        txn.get("description").cloned().unwrap_or(Value::Null),
    );
    gross.insert(
        "charge_id".to_owned(),
        json!(charge_value.as_ref().and_then(|c| id_of(Some(c)))),
    );
    gross.insert(
        "invoice_id".to_owned(),
        json!(charge.and_then(|c| id_of(c.get("invoice")))),
    );
    gross.insert(
        "customer_name".to_owned(),
        json!(billing.and_then(|b| string(b.get("name")))),
    );
    let fee = txn.get("fee").and_then(Value::as_f64).unwrap_or(0.0);
    if fee == 0.0 || kind == "payout" {
        return vec![Value::Object(gross)];
    }
    let txn_id = crate::clients::as_text(txn.get("id").unwrap_or(&Value::Null));
    let mut fee_line = shared;
    fee_line.insert("id".to_owned(), json!(format!("{txn_id}_fee")));
    fee_line.insert("line".to_owned(), json!("fee"));
    fee_line.insert("type".to_owned(), json!("stripe_fee"));
    fee_line.insert("amount".to_owned(), number_value(-fee));
    fee_line.insert(
        "description".to_owned(),
        json!(format!(
            "Stripe fee {}",
            id_of(txn.get("source")).unwrap_or(txn_id)
        )),
    );
    fee_line.insert(
        "fee_details".to_owned(),
        txn.get("fee_details").cloned().unwrap_or(Value::Null),
    );
    vec![Value::Object(gross), Value::Object(fee_line)]
}

/// The payout itself, when its transaction was not in the list.
fn payout_own_line(
    payout: &Value,
    payout_id: &str,
    base: &Map<String, Value>,
    currency: &str,
) -> Value {
    let mut line = base.clone();
    let txn = id_of(payout.get("balance_transaction"));
    line.insert(
        "id".to_owned(),
        json!(txn.clone().unwrap_or_else(|| payout_id.to_owned())),
    );
    line.insert("line".to_owned(), json!("payout"));
    line.insert("balance_transaction_id".to_owned(), json!(txn));
    line.insert("type".to_owned(), json!("payout"));
    let amount = payout
        .get("amount")
        .filter(|a| a.is_number())
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    line.insert("amount".to_owned(), number_value(-amount));
    line.insert("currency".to_owned(), json!(currency));
    line.insert(
        "created".to_owned(),
        json!(iso_from_unix(payout.get("created"))),
    );
    line.insert(
        "available_on".to_owned(),
        json!(iso_from_unix(payout.get("arrival_date"))),
    );
    line.insert(
        "description".to_owned(),
        json!(
            string(payout.get("statement_descriptor"))
                .map_or_else(|| format!("Stripe payout {payout_id}"), str::to_owned)
        ),
    );
    line.insert("source_id".to_owned(), json!(payout_id));
    Value::Object(line)
}

// ── Connect OAuth (`stripe/auth.ts`) ────────────────────────────────────────

pub const CONNECT_AUTHORIZE_URL: &str = "https://connect.stripe.com/oauth/authorize";
pub const CONNECT_TOKEN_URL: &str = "https://connect.stripe.com/oauth/token";
pub const CONNECT_DEAUTHORIZE_URL: &str = "https://connect.stripe.com/oauth/deauthorize";
pub const CONNECT_SCOPE: &str = "read_write";
pub const OAUTH_STATE_PREFIX: &str = "stripe_";
pub const AUTH_STATE_TTL_SECONDS: u64 = 15 * 60;
pub const CALLBACK_PATH: &str = "/weldconnect/connectors/callback";

/// `stripeRedirectUri(publicAppUrl)`.
pub fn redirect_uri(public_app_url: &str) -> String {
    format!("{}{CALLBACK_PATH}", public_app_url.trim_end_matches('/'))
}

/// `isStripeOAuthState(state)`.
pub fn is_oauth_state(state: Option<&str>) -> bool {
    state.is_some_and(|s| s.starts_with(OAUTH_STATE_PREFIX))
}

/// `buildStripeAuthorizeUrl({ clientId, redirectUri, state })`.
pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("scope", CONNECT_SCOPE)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state)
        .append_pair("stripe_landing", "login")
        .finish();
    format!("{CONNECT_AUTHORIZE_URL}?{query}")
}

fn basic_auth(secret_key: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{secret_key}:"))
    )
}

fn oauth_error_message(json: &Value, status: u16, fallback: &str) -> String {
    string(json.get("error_description"))
        .or_else(|| string(json.get("error")))
        .map_or_else(|| format!("{fallback} ({status})"), str::to_owned)
}

fn form_request(url: &str, secret_key: &str, fields: &[(&str, &str)]) -> HttpRequest {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in fields {
        form.append_pair(k, v);
    }
    HttpRequest {
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: vec![
            ("Authorization".to_owned(), basic_auth(secret_key)),
            ("Accept".to_owned(), "application/json".to_owned()),
            (
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
        ],
        body: Some(form.finish().into_bytes()),
    }
}

/// `StripeOAuthTokens`.
#[derive(Debug, Clone)]
pub struct OAuthTokens {
    pub stripe_user_id: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub livemode: bool,
    pub scope: Option<String>,
}

/// Why an OAuth call failed: the message the TypeScript `Error` carries.
/// `network` when `fetch` itself threw.
#[derive(Debug, Clone)]
pub struct OAuthError {
    pub message: String,
    pub network: bool,
}

fn read_json(body: &[u8]) -> Value {
    if body.is_empty() {
        return json!({});
    }
    serde_json::from_slice(body).unwrap_or_else(|_| json!({}))
}

/// `exchangeStripeCode({ secretKey, code })`.
pub async fn exchange_code(
    http: Option<&OutboundHttp>,
    secret_key: &str,
    code: &str,
) -> Result<OAuthTokens, OAuthError> {
    let request = form_request(
        CONNECT_TOKEN_URL,
        secret_key,
        &[("grant_type", "authorization_code"), ("code", code)],
    );
    let response = match http {
        Some(http) => http.send(request).await.map_err(|e| OAuthError {
            message: e.to_string(),
            network: true,
        })?,
        None => {
            return Err(OAuthError {
                message: "fetch failed".to_owned(),
                network: true,
            });
        }
    };
    let json = read_json(&response.body);
    if !response.ok() {
        return Err(OAuthError {
            message: oauth_error_message(&json, response.status, "Stripe token request failed"),
            network: false,
        });
    }
    let stripe_user_id = string(json.get("stripe_user_id")).unwrap_or_default();
    if stripe_user_id.is_empty() {
        return Err(OAuthError {
            message: "Stripe did not return the connected account id".to_owned(),
            network: false,
        });
    }
    let nonempty = |key: &str| {
        string(json.get(key))
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Ok(OAuthTokens {
        stripe_user_id: stripe_user_id.to_owned(),
        access_token: nonempty("access_token"),
        refresh_token: nonempty("refresh_token"),
        livemode: json.get("livemode") == Some(&Value::Bool(true)),
        scope: string(json.get("scope")).map(str::to_owned),
    })
}

/// `deauthorizeStripeAccount({ secretKey, clientId, stripeUserId })`: a 401
/// counts as done.
pub async fn deauthorize(
    http: Option<&OutboundHttp>,
    secret_key: &str,
    client_id: &str,
    stripe_user_id: &str,
) -> Result<(), OAuthError> {
    let request = form_request(
        CONNECT_DEAUTHORIZE_URL,
        secret_key,
        &[("client_id", client_id), ("stripe_user_id", stripe_user_id)],
    );
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
    if response.ok() || response.status == 401 {
        return Ok(());
    }
    let json = read_json(&response.body);
    Err(OAuthError {
        message: oauth_error_message(&json, response.status, "Stripe deauthorize failed"),
        network: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_follow_the_currency_minor_unit() {
        assert_eq!(
            amount_to_decimal(Some(&json!(1234)), Some("eur"), 2),
            "12.34"
        );
        assert_eq!(
            amount_to_decimal(Some(&json!(1234)), Some("JPY"), 2),
            "1234.00"
        );
        assert_eq!(
            amount_to_decimal(Some(&json!("1500")), Some("KWD"), 3),
            "1.500"
        );
        assert_eq!(amount_to_decimal(None, Some("EUR"), 2), "0.00");
        assert_eq!(amount_to_decimal(Some(&json!(5)), Some("EUR"), 2), "0.05");
    }

    #[test]
    fn credentials_pick_the_bearer() {
        let key = Stripe::from_credentials(
            json!({ "apiKey": " rk_live_x ", "stripeUserId": "acct_1" })
                .as_object()
                .expect("object"),
            None,
        );
        assert_eq!(key.mode, Mode::ApiKey);
        assert!(!key.send_account_header);
        let oauth = Stripe::from_credentials(
            json!({ "stripeUserId": "acct_1", "platformSecretKey": "sk_p", "importStartDate": "2026-01-01" })
                .as_object()
                .expect("object"),
            None,
        );
        assert_eq!(oauth.mode, Mode::OAuth);
        assert!(oauth.send_account_header);
        assert_eq!(oauth.import_start, Some(1_767_225_600));
        assert_eq!(
            authorize_url("ca_1", "https://app.test/cb", "stripe_x"),
            "https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_1&scope=read_write&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&state=stripe_x&stripe_landing=login"
        );
    }
}
