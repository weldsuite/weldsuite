//! The store clients a product's sales channels push to: a port of the
//! pieces of `@weldsuite/connectors` (`packages/core/connectors/src`) and
//! `@weldsuite/connect-domain` (`packages/domains/connect/src/connectors`)
//! commerce-api imports, to be deduplicated with the WeldConnect port:
//!
//! - `getConnector(provider)` → [`connector`] (label, category, the product
//!   sync's `externalEntityType`), `resolveConnectorObjectDirection` +
//!   `allowsOutboundSync` → [`allows_outbound`];
//! - `ConnectorApiError`, `classifyStatus`, `parseRetryAfter`,
//!   `retryDelayMs`, `runWithRetries` → [`ConnectorError`], [`with_retries`];
//! - `WooCommerceClient` (`normalizeStoreUrl`, the pretty / `rest_route`
//!   and Basic / query-key fallbacks, manual redirects, the PHP-notice JSON
//!   tolerance), `ShopifyClient` (`normalizeShopDomain`, GraphQL SKU lookup,
//!   REST writes) and `PicqerClient` (`normalizePicqerSubdomain`): only
//!   `findProductBySku`, `createProduct`, `updateProduct`, `deleteProduct`
//!   and `storeUrl` → [`StoreClient`];
//! - `createProductWriteClient` / `createConnectorProviderClient` →
//!   [`product_write_client`]; `decryptCredentials` (`maybeDecryptField`)
//!   → [`decrypt_credentials`].
//!
//! Every call goes through the outbound HTTP port.

use std::time::Duration;

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_db::Keyring;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::js::{number_text, number_value};

/// A connector's catalog entry (`ConnectorDef`), what commerce reads of it.
pub(crate) struct Connector {
    pub(crate) label: &'static str,
    pub(crate) category: &'static str,
    /// The product sync's `externalEntityType`, when it has one.
    pub(crate) product_entity: Option<&'static str>,
}

/// `getConnector(provider)`.
pub(crate) fn connector(provider: &str) -> Option<Connector> {
    let (label, category, product_entity) = match provider {
        "woocommerce" => ("WooCommerce", "ecommerce", Some("woocommerce_product")),
        "shopify" => ("Shopify", "ecommerce", Some("shopify_product")),
        "moneybird" => ("Moneybird", "accounting", Some("moneybird_product")),
        "stripe" => ("Stripe", "accounting", None),
        "picqer" => ("Picqer", "wms", Some("picqer_product")),
        _ => return None,
    };
    Some(Connector {
        label,
        category,
        product_entity,
    })
}

/// `allowsOutboundSync(resolveConnectorObjectDirection({ direction,
/// objectSyncDirections, settingKey }))`.
pub(crate) fn allows_outbound(
    direction: Option<&str>,
    per_object: Option<&Value>,
    key: &str,
) -> bool {
    let resolved = per_object
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .or(direction)
        .unwrap_or("inbound");
    resolved == "outbound" || resolved == "bidirectional"
}

/// `ConnectorErrorKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Auth,
    RateLimit,
    Transient,
    Permanent,
}

/// `ConnectorApiError`.
#[derive(Debug, Clone)]
pub(crate) struct ConnectorError {
    pub(crate) message: String,
    pub(crate) status: u16,
    pub(crate) kind: Kind,
    pub(crate) body: Option<String>,
    pub(crate) retry_after: Option<f64>,
}

impl ConnectorError {
    fn new(message: impl Into<String>, status: u16, kind: Kind) -> Self {
        Self {
            message: message.into(),
            status,
            kind,
            body: None,
            retry_after: None,
        }
    }

    fn retryable(&self) -> bool {
        matches!(self.kind, Kind::RateLimit | Kind::Transient)
    }
}

/// `classifyStatus(status)`.
fn classify(status: u16) -> Kind {
    match status {
        401 | 403 => Kind::Auth,
        429 => Kind::RateLimit,
        s if s >= 500 => Kind::Transient,
        _ => Kind::Permanent,
    }
}

/// `parseRetryAfter(header)`: seconds, or an HTTP date from now.
fn parse_retry_after(header: Option<&str>) -> Option<f64> {
    let trimmed = weldsuite_kit::validation::js_trim(header?);
    if trimmed.is_empty() {
        return None;
    }
    let number = weldsuite_kit::validation::js_number(trimmed);
    if number.is_finite() {
        return Some(number.max(0.0));
    }
    let date = time::OffsetDateTime::parse(trimmed, &time::format_description::well_known::Rfc2822)
        .ok()?;
    let seconds = (date - time::OffsetDateTime::now_utc()).as_seconds_f64();
    Some((seconds).ceil().max(0.0))
}

/// `text.slice(0, 500)` in UTF-16 units.
fn slice500(text: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > 500 {
            break;
        }
        out.push(c);
    }
    out
}

fn http_error(
    response: &HttpResponse,
    text: &str,
    auth_message: &str,
    provider: &str,
) -> ConnectorError {
    let status = response.status;
    ConnectorError {
        message: if status == 401 || status == 403 {
            auth_message.to_owned()
        } else {
            format!("{provider} request failed ({status})")
        },
        status,
        kind: classify(status),
        body: Some(slice500(text)),
        retry_after: parse_retry_after(response.header("retry-after")),
    }
}

/// `retryDelayMs(error, attempt)`.
fn retry_delay(error: &ConnectorError, attempt: u32) -> Duration {
    match error.retry_after.filter(|s| *s > 0.0) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(seconds) => Duration::from_millis((seconds * 1000.0) as u64),
        None => Duration::from_millis(400 * 2u64.pow(attempt)),
    }
}

const MAX_RETRIES: u32 = 2;
const TIMEOUT: Duration = Duration::from_secs(20);

/// One attempt's failure: an HTTP/payload error, or the request never got
/// an answer (the message `fetch` threw with, or a timeout).
enum Attempt {
    Api(ConnectorError),
    Network { timed_out: bool },
}

async fn send(http: Option<&OutboundHttp>, request: HttpRequest) -> Result<HttpResponse, Attempt> {
    let Some(http) = http else {
        return Err(Attempt::Network { timed_out: false });
    };
    match tokio::time::timeout(TIMEOUT, http.send(request)).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(_)) => Err(Attempt::Network { timed_out: false }),
        Err(_) => Err(Attempt::Network { timed_out: true }),
    }
}

/// `runWithRetries` (Shopify, Picqer).
async fn with_retries<F, Fut>(
    unreachable: &str,
    mut attempt_once: F,
) -> Result<HttpResponse, ConnectorError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<HttpResponse, Attempt>>,
{
    for attempt in 0..=MAX_RETRIES {
        match attempt_once().await {
            Ok(response) => return Ok(response),
            Err(Attempt::Api(error)) => {
                if !error.retryable() || attempt == MAX_RETRIES {
                    return Err(error);
                }
                tokio::time::sleep(retry_delay(&error, attempt)).await;
            }
            Err(Attempt::Network { .. }) => {
                if attempt == MAX_RETRIES {
                    return Err(ConnectorError::new(unreachable, 503, Kind::Transient));
                }
                tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt))).await;
            }
        }
    }
    Err(ConnectorError::new(unreachable, 503, Kind::Transient))
}

/// `asText(value)` for an id.
fn as_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), number_text),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// A remote listing (`ExternalProductRef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProductRef {
    pub(crate) id: String,
    pub(crate) url: Option<String>,
}

/// The product pushed to a store (`OutboundCatalogProduct`): the JSON the
/// route builds (`toOutboundProduct`).
pub(crate) type CatalogProduct = Value;

fn text_of<'a>(product: &'a Value, key: &str) -> Option<&'a str> {
    product.get(key).and_then(Value::as_str)
}

/// `x || undefined`.
fn truthy_text(product: &Value, key: &str) -> Option<String> {
    text_of(product, key)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn images(product: &Value) -> Option<Value> {
    let list: Vec<Value> = product
        .get("images")
        .and_then(Value::as_array)
        .map(|images| {
            images
                .iter()
                .filter(|img| {
                    img.get("url")
                        .is_some_and(|u| !u.is_null() && u != "" && u != &json!(false))
                })
                .map(|img| {
                    let mut out = Map::new();
                    out.insert("src".to_owned(), img["url"].clone());
                    if let Some(alt) = img
                        .get("altText")
                        .filter(|a| a.as_str().is_some_and(|s| !s.is_empty()))
                    {
                        out.insert("alt".to_owned(), alt.clone());
                    }
                    Value::Object(out)
                })
                .collect()
        })
        .unwrap_or_default();
    (!list.is_empty()).then_some(Value::Array(list))
}

fn trimmed_sku(product: &Value) -> Option<String> {
    text_of(product, "sku")
        .map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
        .filter(|s| !s.is_empty())
}

/// `Number(x)` of a product's numeric text.
fn number(text: &str) -> Value {
    number_value(weldsuite_kit::validation::js_number(text))
}

// ── WooCommerce ─────────────────────────────────────────────────────────────

pub(crate) struct Woo {
    store_url: String,
    key: String,
    secret: String,
}

/// `normalizeStoreUrl(url)`.
fn normalize_store_url(url: &str) -> Result<String, ConnectorError> {
    let trimmed = weldsuite_kit::validation::js_trim(url);
    if trimmed.is_empty() {
        return Err(ConnectorError::new(
            "Store URL is required",
            400,
            Kind::Permanent,
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    let with_protocol = if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let mut parsed = url::Url::parse(&with_protocol)
        .map_err(|_| ConnectorError::new("Store URL is not a valid URL", 400, Kind::Permanent))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(ConnectorError::new(
            "Store URL must be http or https",
            400,
            Kind::Permanent,
        ));
    }
    let path = strip_trailing_slashes(parsed.path()).to_owned();
    parsed.set_path(&path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(strip_trailing_slashes(parsed.as_str()).to_owned())
}

/// `.replace(/(?<!\/)\/+$/, '')`: the whole run of trailing slashes (the
/// match starts at the run's first slash).
fn strip_trailing_slashes(text: &str) -> &str {
    text.trim_end_matches('/')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Pretty,
    RestRoute,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Auth {
    Basic,
    Query,
}

fn looks_like_html(body: &str) -> bool {
    let head: String = body
        .trim_start()
        .chars()
        .take(32)
        .collect::<String>()
        .to_lowercase();
    head.starts_with("<!doctype") || head.starts_with("<html") || head.starts_with("<head")
}

/// `parseWooJson(body)`: PHP notices before the JSON are skipped.
fn parse_woo_json(body: &str) -> Option<Value> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Some(Value::Null);
    }
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Some(value);
    }
    let start = [trimmed.find('{'), trimmed.find('[')]
        .into_iter()
        .flatten()
        .min()?;
    serde_json::from_str(&trimmed[start..]).ok()
}

impl Woo {
    fn url(&self, path: &str, search: &[(&str, String)], style: Style, auth: Auth) -> String {
        let origin = self
            .store_url
            .strip_prefix("http://")
            .map_or_else(|| self.store_url.clone(), |rest| format!("https://{rest}"));
        let resource = path.trim_start_matches('/');
        let mut url = match style {
            Style::Pretty => url::Url::parse(&format!("{origin}/wp-json/wc/v3/{resource}")),
            Style::RestRoute => url::Url::parse(&origin).map(|mut parsed| {
                let base = strip_trailing_slashes(parsed.path()).to_owned();
                parsed.set_path(if base.is_empty() { "/" } else { &base });
                parsed
                    .query_pairs_mut()
                    .append_pair("rest_route", &format!("/wc/v3/{resource}"));
                parsed
            }),
        }
        .unwrap_or_else(|_| url::Url::parse("https://invalid.invalid/").expect("a valid URL"));
        for (key, value) in search {
            if !value.is_empty() {
                set_param(&mut url, key, value);
            }
        }
        if auth == Auth::Query {
            set_param(&mut url, "consumer_key", &self.key);
            set_param(&mut url, "consumer_secret", &self.secret);
        }
        url.to_string()
    }

    fn headers(&self, auth: Auth, body: bool) -> Vec<(String, String)> {
        let mut headers = vec![
            ("Accept".to_owned(), "application/json".to_owned()),
            (
                "User-Agent".to_owned(),
                "WeldSuite-WooCommerce/1.0 (+https://weldsuite.org)".to_owned(),
            ),
        ];
        if auth == Auth::Basic {
            let token = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", self.key, self.secret));
            headers.push(("Authorization".to_owned(), format!("Basic {token}")));
        }
        if body {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        headers
    }

    /// `fetchFollow`: redirects followed by hand, 303 as a GET.
    async fn follow(
        http: Option<&OutboundHttp>,
        mut request: HttpRequest,
    ) -> Result<HttpResponse, Attempt> {
        for _ in 0..=5 {
            let response = send(http, request.clone()).await?;
            if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let Some(location) = response.header("location").map(str::to_owned) else {
                return Ok(response);
            };
            let next = url::Url::parse(&request.url)
                .and_then(|base| base.join(&location))
                .map(|u| u.to_string())
                .unwrap_or(location);
            if response.status == 303 {
                request.method = "GET".to_owned();
                request.body = None;
            }
            request.url = next;
        }
        send(http, request).await
    }

    async fn attempt(http: Option<&OutboundHttp>, request: HttpRequest) -> Result<Value, Attempt> {
        let response = Self::follow(http, request).await?;
        let text = response.text();
        if !response.ok() {
            return Err(Attempt::Api(http_error(
                &response,
                &text,
                "WooCommerce rejected the consumer key or secret",
                "WooCommerce",
            )));
        }
        if looks_like_html(&text) {
            let mut error = ConnectorError::new(
                "WooCommerce REST API returned a web page instead of JSON. Pretty permalinks may be disabled, or a firewall is blocking /wp-json/.",
                502,
                Kind::Permanent,
            );
            error.body = Some(slice500(&text));
            return Err(Attempt::Api(error));
        }
        parse_woo_json(&text).ok_or_else(|| {
            let mut error = ConnectorError::new(
                "WooCommerce REST API returned a response that was not JSON",
                502,
                Kind::Permanent,
            );
            error.body = Some(slice500(&text));
            Attempt::Api(error)
        })
    }

    /// `requestWithRetries`.
    async fn with_retries(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        search: &[(&str, String)],
        body: Option<&Value>,
        style: Style,
        auth: Auth,
    ) -> Result<Value, ConnectorError> {
        let request = HttpRequest {
            method: method.to_owned(),
            url: self.url(path, search, style, auth),
            headers: self.headers(auth, body.is_some()),
            body: body.map(|b| b.to_string().into_bytes()),
        };
        for attempt in 0..=MAX_RETRIES {
            match Self::attempt(http, request.clone()).await {
                Ok(value) => return Ok(value),
                Err(Attempt::Api(error)) => {
                    if attempt == MAX_RETRIES || !error.retryable() {
                        return Err(error);
                    }
                    tokio::time::sleep(retry_delay(&error, attempt)).await;
                }
                Err(Attempt::Network { timed_out }) => {
                    if attempt == MAX_RETRIES {
                        return Err(if timed_out {
                            ConnectorError::new("WooCommerce store timed out", 504, Kind::Transient)
                        } else {
                            ConnectorError::new(
                                "Could not reach the WooCommerce store (fetch failed)",
                                503,
                                Kind::Transient,
                            )
                        });
                    }
                    tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt))).await;
                }
            }
        }
        Err(ConnectorError::new(
            "Could not reach the WooCommerce store (fetch failed)",
            503,
            Kind::Transient,
        ))
    }

    fn should_try_rest_route(error: &ConnectorError) -> bool {
        error.status == 404
            || error.status == 405
            || error.body.as_deref().is_some_and(looks_like_html)
            || error.message.contains("web page instead of JSON")
            || error.message.contains("was not JSON")
    }

    /// `request(path, { method, search, body })` with its fallbacks.
    async fn request(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        search: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, ConnectorError> {
        let run = |style, auth| self.with_retries(http, method, path, search, body, style, auth);
        match run(Style::Pretty, Auth::Basic).await {
            Ok(value) => Ok(value),
            Err(error) if error.kind == Kind::Auth => run(Style::Pretty, Auth::Query).await,
            Err(error) if Self::should_try_rest_route(&error) => {
                match run(Style::RestRoute, Auth::Basic).await {
                    Err(rest) if rest.kind == Kind::Auth => {
                        run(Style::RestRoute, Auth::Query).await
                    }
                    other => other,
                }
            }
            Err(error) => Err(error),
        }
    }

    fn body(product: &CatalogProduct) -> Value {
        let status = match text_of(product, "status") {
            Some("active") => "publish",
            Some("inactive") => "private",
            _ => "draft",
        };
        let mut body = Map::new();
        body.insert(
            "name".to_owned(),
            product.get("name").cloned().unwrap_or(Value::Null),
        );
        body.insert("type".to_owned(), json!("simple"));
        body.insert("status".to_owned(), json!(status));
        body.insert("description".to_owned(), or_empty(product, "description"));
        body.insert(
            "short_description".to_owned(),
            or_empty(product, "shortDescription"),
        );
        if let Some(sku) = trimmed_sku(product) {
            body.insert("sku".to_owned(), json!(sku));
        }
        body.insert(
            "regular_price".to_owned(),
            product.get("price").cloned().unwrap_or(Value::Null),
        );
        if let Some(slug) = truthy_text(product, "slug") {
            body.insert("slug".to_owned(), json!(slug));
        }
        if let Some(weight) = truthy_text(product, "weight") {
            body.insert("weight".to_owned(), json!(weight));
        }
        let dims = ["length", "width", "height"];
        if dims.iter().any(|d| truthy_text(product, d).is_some()) {
            body.insert(
                "dimensions".to_owned(),
                json!({
                    "length": or_empty(product, "length"),
                    "width": or_empty(product, "width"),
                    "height": or_empty(product, "height"),
                }),
            );
        }
        if let Some(images) = images(product) {
            body.insert("images".to_owned(), images);
        }
        if let Some(track) = product.get("trackInventory").and_then(Value::as_bool) {
            body.insert("manage_stock".to_owned(), json!(track));
            if track {
                body.insert(
                    "stock_quantity".to_owned(),
                    product
                        .get("inventoryQuantity")
                        .filter(|q| !q.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!(0)),
                );
            }
        }
        Value::Object(body)
    }

    fn product_ref(&self, data: &Value) -> ProductRef {
        let id = data
            .get("id")
            .filter(|v| !v.is_null())
            .map(as_text)
            .unwrap_or_default();
        let url = match data.get("permalink") {
            Some(Value::String(link)) => Some(link.clone()),
            _ if !id.is_empty() => Some(format!("{}/?p={id}", self.store_url)),
            _ => None,
        };
        ProductRef { id, url }
    }
}

/// `x ?? ''`.
fn or_empty(product: &Value, key: &str) -> Value {
    product
        .get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!(""))
}

fn set_param(url: &mut url::Url, key: &str, value: &str) {
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != key)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    let mut query = url.query_pairs_mut();
    for (k, v) in &pairs {
        query.append_pair(k, v);
    }
    query.append_pair(key, value);
}

// ── Shopify ─────────────────────────────────────────────────────────────────

pub(crate) struct Shopify {
    domain: String,
    token: String,
}

/// `normalizeShopDomain(domain)`.
fn normalize_shop_domain(domain: &str) -> Result<String, ConnectorError> {
    let trimmed = weldsuite_kit::validation::js_trim(domain);
    let lower = trimmed.to_ascii_lowercase();
    let without = if lower.starts_with("https://") {
        &trimmed[8..]
    } else if lower.starts_with("http://") {
        &trimmed[7..]
    } else {
        trimmed
    };
    let without = strip_trailing_slashes(without);
    if without.is_empty() {
        return Err(ConnectorError::new(
            "Shop domain is required",
            400,
            Kind::Permanent,
        ));
    }
    let host = without.split('/').next().unwrap_or_default().to_lowercase();
    if !host.contains('.') {
        return Ok(format!("{host}.myshopify.com"));
    }
    let valid = host.len() >= 2
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && host
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && host
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !valid {
        return Err(ConnectorError::new(
            "Shop domain is not valid",
            400,
            Kind::Permanent,
        ));
    }
    Ok(host)
}

impl Shopify {
    fn store_url(&self) -> String {
        format!("https://{}", self.domain)
    }

    async fn request(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, ConnectorError> {
        let url = format!(
            "{}/admin/api/2024-10/{}",
            self.store_url(),
            path.trim_start_matches('/')
        );
        let mut headers = vec![
            ("X-Shopify-Access-Token".to_owned(), self.token.clone()),
            ("Accept".to_owned(), "application/json".to_owned()),
        ];
        if body.is_some() {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        let request = HttpRequest {
            method: method.to_owned(),
            url,
            headers,
            body: body.map(|b| b.to_string().into_bytes()),
        };
        let response = with_retries("Could not reach the Shopify store", || {
            let request = request.clone();
            async move {
                let response = send(http, request).await?;
                if response.ok() {
                    Ok(response)
                } else {
                    let text = response.text();
                    Err(Attempt::Api(http_error(
                        &response,
                        &text,
                        "Shopify rejected the Admin API access token",
                        "Shopify",
                    )))
                }
            }
        })
        .await?;
        let text = response.text();
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|_| ConnectorError::new("Shopify request failed", 503, Kind::Transient))
    }

    fn body(product: &CatalogProduct) -> Value {
        let status = match text_of(product, "status") {
            Some("active") => "active",
            Some("inactive") => "archived",
            _ => "draft",
        };
        let mut variant = Map::new();
        variant.insert(
            "price".to_owned(),
            product.get("price").cloned().unwrap_or(Value::Null),
        );
        if let Some(sku) = trimmed_sku(product) {
            variant.insert("sku".to_owned(), json!(sku));
        }
        if let Some(weight) = truthy_text(product, "weight") {
            variant.insert("weight".to_owned(), number(&weight));
        }
        match product.get("trackInventory").and_then(Value::as_bool) {
            Some(true) => {
                variant.insert("inventory_management".to_owned(), json!("shopify"));
                variant.insert(
                    "inventory_quantity".to_owned(),
                    product
                        .get("inventoryQuantity")
                        .filter(|q| !q.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!(0)),
                );
            }
            Some(false) => {
                variant.insert("inventory_management".to_owned(), Value::Null);
            }
            None => {}
        }
        let mut body = Map::new();
        body.insert(
            "title".to_owned(),
            product.get("name").cloned().unwrap_or(Value::Null),
        );
        body.insert("body_html".to_owned(), or_empty(product, "description"));
        if let Some(vendor) = truthy_text(product, "vendor") {
            body.insert("vendor".to_owned(), json!(vendor));
        }
        if let Some(kind) = truthy_text(product, "productType") {
            body.insert("product_type".to_owned(), json!(kind));
        }
        if let Some(slug) = truthy_text(product, "slug") {
            body.insert("handle".to_owned(), json!(slug));
        }
        body.insert("status".to_owned(), json!(status));
        body.insert("variants".to_owned(), json!([Value::Object(variant)]));
        if let Some(images) = images(product) {
            body.insert("images".to_owned(), images);
        }
        json!({ "product": Value::Object(body) })
    }

    fn product_ref(&self, data: &Value) -> ProductRef {
        let product = data.get("product");
        let id = product
            .and_then(|p| p.get("id"))
            .filter(|v| !v.is_null())
            .map(as_text)
            .unwrap_or_default();
        let url = product
            .and_then(|p| p.get("handle"))
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty())
            .map(|handle| format!("{}/products/{handle}", self.store_url()));
        ProductRef { id, url }
    }
}

// ── Picqer ──────────────────────────────────────────────────────────────────

pub(crate) struct Picqer {
    subdomain: String,
    key: String,
}

/// `normalizePicqerSubdomain(subdomain)` (also what the factory does with
/// the account id).
fn picqer_strip(text: &str) -> String {
    let trimmed = weldsuite_kit::validation::js_trim(text);
    let lower = trimmed.to_ascii_lowercase();
    let without = if lower.starts_with("https://") {
        &trimmed[8..]
    } else if lower.starts_with("http://") {
        &trimmed[7..]
    } else {
        trimmed
    };
    let cut = without
        .to_ascii_lowercase()
        .find(".picqer.com")
        .map_or(without, |at| &without[..at]);
    strip_trailing_slashes(cut).to_owned()
}

fn normalize_picqer(subdomain: &str) -> Result<String, ConnectorError> {
    let trimmed = picqer_strip(subdomain).to_lowercase();
    if trimmed.is_empty() {
        return Err(ConnectorError::new(
            "Picqer subdomain is required",
            400,
            Kind::Permanent,
        ));
    }
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = trimmed.as_bytes();
    let valid = bytes.iter().all(|b| alnum(*b) || *b == b'-')
        && bytes.first().is_some_and(|b| alnum(*b))
        && bytes.last().is_some_and(|b| alnum(*b));
    if !valid {
        return Err(ConnectorError::new(
            "Picqer subdomain is not valid",
            400,
            Kind::Permanent,
        ));
    }
    Ok(trimmed)
}

impl Picqer {
    async fn request(
        &self,
        http: Option<&OutboundHttp>,
        method: &str,
        path: &str,
        search: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, ConnectorError> {
        let mut url = url::Url::parse(&format!(
            "https://{}.picqer.com/api/v1/{}",
            self.subdomain,
            path.trim_start_matches('/')
        ))
        .map_err(|_| ConnectorError::new("Picqer subdomain is not valid", 400, Kind::Permanent))?;
        for (key, value) in search {
            if !value.is_empty() {
                set_param(&mut url, key, value);
            }
        }
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:", self.key));
        let mut headers = vec![
            ("Authorization".to_owned(), format!("Basic {token}")),
            ("Accept".to_owned(), "application/json".to_owned()),
            (
                "User-Agent".to_owned(),
                "WeldSuite Picqer Connector (weldsuite.com)".to_owned(),
            ),
        ];
        if body.is_some() {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        let request = HttpRequest {
            method: method.to_owned(),
            url: url.to_string(),
            headers,
            body: body.map(|b| b.to_string().into_bytes()),
        };
        let response = with_retries("Could not reach Picqer", || {
            let request = request.clone();
            async move {
                let response = send(http, request).await?;
                if response.ok() {
                    return Ok(response);
                }
                let text = response.text();
                let mut error =
                    http_error(&response, &text, "Picqer rejected the API key", "Picqer");
                if error.retry_after.is_none() && response.status == 429 {
                    error.retry_after = Some(20.0);
                }
                Err(Attempt::Api(error))
            }
        })
        .await?;
        let text = response.text();
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|_| ConnectorError::new("Picqer request failed", 503, Kind::Transient))
    }

    fn body(product: &CatalogProduct) -> Value {
        let mut body = Map::new();
        body.insert(
            "name".to_owned(),
            product.get("name").cloned().unwrap_or(Value::Null),
        );
        if let Some(sku) = trimmed_sku(product) {
            body.insert("productcode".to_owned(), json!(sku));
        }
        body.insert("description".to_owned(), or_empty(product, "description"));
        let price = weldsuite_kit::validation::js_number_of(product.get("price"));
        body.insert(
            "price".to_owned(),
            number_value(if price.is_nan() { 0.0 } else { price }),
        );
        if let Some(weight) = truthy_text(product, "weight") {
            body.insert("weight".to_owned(), number(&weight));
        }
        body.insert(
            "active".to_owned(),
            json!(text_of(product, "status") == Some("active")),
        );
        Value::Object(body)
    }

    fn id_of(data: &Value) -> Option<&Value> {
        data.get("idproduct")
            .filter(|v| !v.is_null())
            .or_else(|| data.get("id").filter(|v| !v.is_null()))
    }
}

// ── the client ──────────────────────────────────────────────────────────────

/// A product write client (`ShopifyClient | WooCommerceClient | PicqerClient`).
pub(crate) enum StoreClient {
    Woo(Woo),
    Shopify(Shopify),
    Picqer(Picqer),
}

fn credential<'a>(credentials: &'a Map<String, Value>, key: &str) -> &'a str {
    credentials
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `createProductWriteClient(provider, credentials, fallbackAccountId)`.
pub(crate) fn product_write_client(
    provider: &str,
    credentials: &Map<String, Value>,
    fallback: Option<&str>,
) -> Result<StoreClient, ConnectorError> {
    let or = |key: &str| {
        let own = credential(credentials, key);
        if own.is_empty() {
            fallback.unwrap_or_default().to_owned()
        } else {
            own.to_owned()
        }
    };
    match provider {
        "woocommerce" => Ok(StoreClient::Woo(Woo {
            store_url: normalize_store_url(&or("storeUrl"))?,
            key: weldsuite_kit::validation::js_trim(credential(credentials, "consumerKey"))
                .to_owned(),
            secret: weldsuite_kit::validation::js_trim(credential(credentials, "consumerSecret"))
                .to_owned(),
        })),
        "shopify" => Ok(StoreClient::Shopify(Shopify {
            domain: normalize_shop_domain(&or("shopDomain"))?,
            token: weldsuite_kit::validation::js_trim(credential(credentials, "accessToken"))
                .to_owned(),
        })),
        "picqer" => {
            let own =
                weldsuite_kit::validation::js_trim(credential(credentials, "subdomain")).to_owned();
            let subdomain = if own.is_empty() {
                picqer_strip(fallback.unwrap_or_default())
            } else {
                own
            };
            Ok(StoreClient::Picqer(Picqer {
                subdomain: normalize_picqer(&subdomain)?,
                key: weldsuite_kit::validation::js_trim(credential(credentials, "apiKey"))
                    .to_owned(),
            }))
        }
        // Moneybird and Stripe build their own clients, which push no products.
        "moneybird" | "stripe" => Err(ConnectorError::new(
            format!("Provider '{provider}' does not support pushing catalog products"),
            400,
            Kind::Permanent,
        )),
        _ => Err(ConnectorError::new(
            format!("No sync client for provider '{provider}'"),
            400,
            Kind::Permanent,
        )),
    }
}

impl StoreClient {
    /// `client.findProductBySku(sku)`.
    pub(crate) async fn find_by_sku(
        &self,
        http: Option<&OutboundHttp>,
        sku: &str,
    ) -> Result<Option<ProductRef>, ConnectorError> {
        let sku = weldsuite_kit::validation::js_trim(sku);
        if sku.is_empty() {
            return Ok(None);
        }
        match self {
            Self::Woo(woo) => {
                let data = woo
                    .request(
                        http,
                        "GET",
                        "products",
                        &[("sku", sku.to_owned()), ("per_page", "1".to_owned())],
                        None,
                    )
                    .await?;
                let Some(found) = data.as_array().and_then(|a| a.first()) else {
                    return Ok(None);
                };
                let Some(id) = found.get("id").filter(|v| !v.is_null()) else {
                    return Ok(None);
                };
                Ok(Some(ProductRef {
                    id: as_text(id),
                    url: found
                        .get("permalink")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }))
            }
            Self::Shopify(shop) => {
                let body = json!({
                    "query": "query($q: String!) { products(first: 1, query: $q) { edges { node { id handle onlineStoreUrl } } } }",
                    "variables": { "q": format!("sku:{sku}") },
                });
                let data = shop
                    .request(http, "POST", "graphql.json", Some(&body))
                    .await?;
                let node = data.pointer("/data/products/edges/0/node");
                let Some(gid) = node
                    .and_then(|n| n.get("id"))
                    .and_then(Value::as_str)
                    .filter(|g| !g.is_empty())
                else {
                    return Ok(None);
                };
                let id = gid
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(gid)
                    .to_owned();
                let node = node.unwrap_or(&Value::Null);
                let url = node
                    .get("onlineStoreUrl")
                    .and_then(Value::as_str)
                    .filter(|u| !u.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        node.get("handle")
                            .and_then(Value::as_str)
                            .filter(|h| !h.is_empty())
                            .map(|h| format!("{}/products/{h}", shop.store_url()))
                    });
                Ok(Some(ProductRef { id, url }))
            }
            Self::Picqer(picqer) => {
                let data = picqer
                    .request(
                        http,
                        "GET",
                        "products",
                        &[("productcode", sku.to_owned())],
                        None,
                    )
                    .await?;
                let Some(product) = data.as_array().and_then(|a| a.first()) else {
                    return Ok(None);
                };
                Ok(Picqer::id_of(product).map(|id| ProductRef {
                    id: as_text(id),
                    url: None,
                }))
            }
        }
    }

    /// `client.createProduct(product)`.
    pub(crate) async fn create(
        &self,
        http: Option<&OutboundHttp>,
        product: &CatalogProduct,
    ) -> Result<ProductRef, ConnectorError> {
        match self {
            Self::Woo(woo) => {
                let data = woo
                    .request(http, "POST", "products", &[], Some(&Woo::body(product)))
                    .await?;
                Ok(woo.product_ref(&data))
            }
            Self::Shopify(shop) => {
                let data = shop
                    .request(http, "POST", "products.json", Some(&Shopify::body(product)))
                    .await?;
                Ok(shop.product_ref(&data))
            }
            Self::Picqer(picqer) => {
                let data = picqer
                    .request(http, "POST", "products", &[], Some(&Picqer::body(product)))
                    .await?;
                Ok(ProductRef {
                    id: Picqer::id_of(&data).map(as_text).unwrap_or_default(),
                    url: None,
                })
            }
        }
    }

    /// `client.updateProduct(id, product)`.
    pub(crate) async fn update(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
        product: &CatalogProduct,
    ) -> Result<ProductRef, ConnectorError> {
        match self {
            Self::Woo(woo) => {
                let data = woo
                    .request(
                        http,
                        "PUT",
                        &format!("products/{id}"),
                        &[],
                        Some(&Woo::body(product)),
                    )
                    .await?;
                Ok(woo.product_ref(&data))
            }
            Self::Shopify(shop) => {
                let data = shop
                    .request(
                        http,
                        "PUT",
                        &format!("products/{id}.json"),
                        Some(&Shopify::body(product)),
                    )
                    .await?;
                Ok(shop.product_ref(&data))
            }
            Self::Picqer(picqer) => {
                let data = picqer
                    .request(
                        http,
                        "PUT",
                        &format!("products/{id}"),
                        &[],
                        Some(&Picqer::body(product)),
                    )
                    .await?;
                Ok(ProductRef {
                    id: Picqer::id_of(&data).map_or_else(|| id.to_owned(), as_text),
                    url: None,
                })
            }
        }
    }

    /// `client.deleteProduct(id)`.
    pub(crate) async fn delete(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        match self {
            Self::Woo(woo) => woo
                .request(
                    http,
                    "DELETE",
                    &format!("products/{id}"),
                    &[("force", "true".to_owned())],
                    None,
                )
                .await
                .map(|_| ()),
            Self::Shopify(shop) => shop
                .request(http, "DELETE", &format!("products/{id}.json"), None)
                .await
                .map(|_| ()),
            Self::Picqer(picqer) => picqer
                .request(http, "DELETE", &format!("products/{id}"), &[], None)
                .await
                .map(|_| ()),
        }
    }
}

/// `decryptCredentials(credentials, keyring)`: each truthy value opened
/// with `maybeDecryptField`.
pub(crate) fn decrypt_credentials(
    credentials: Option<&Value>,
    keyring: &Keyring,
) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(Value::Object(stored)) = credentials else {
        return out;
    };
    for (key, value) in stored {
        let text = match value {
            Value::String(s) if !s.is_empty() => s.clone(),
            Value::String(_) | Value::Null | Value::Bool(false) => continue,
            Value::Number(n) if n.as_f64() == Some(0.0) => continue,
            other => other.to_string(),
        };
        out.insert(
            key.clone(),
            json!(crate::crypto::maybe_decrypt_field(&text, keyring)),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_store_urls_and_domains() {
        assert_eq!(
            normalize_store_url("shop.example/").expect("url"),
            "https://shop.example"
        );
        assert_eq!(
            normalize_store_url("http://a.test/x//?q=1#h").expect("url"),
            "http://a.test/x"
        );
        assert!(normalize_store_url("  ").is_err());
        assert_eq!(
            normalize_shop_domain("Weld-Test").expect("domain"),
            "weld-test.myshopify.com"
        );
        assert_eq!(
            normalize_shop_domain("https://weld-test.myshopify.com/").expect("domain"),
            "weld-test.myshopify.com"
        );
        assert_eq!(
            normalize_picqer(&picqer_strip("https://Acme.picqer.com/api")).expect("sub"),
            "acme"
        );
    }
}
