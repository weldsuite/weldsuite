//! Cloudflare's API as the official `cloudflare` SDK (v7) calls it from
//! `@weldsuite/cloudflare-zones` and `@weldsuite/cloudflare-registrar`: the
//! same URLs, bodies, retries (two, on 408/409/429/5xx and connection
//! failures; none for a zone create), page walk and error messages, over the
//! outbound HTTP port.
//!
//! Cloudflare hosts the DNS here as on Global; [`CloudflareDns`] is the
//! [`DnsHost`] adapter. The legacy Cloudflare Registrar
//! ([`CloudflareRegistrar`]) only serves rows with `registrar = 'cloudflare'`.

use std::fmt;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use crate::dns_host::{Created, DnsHost, DnsRecord, RecordInput, Zone, ZoneError, ZoneErrorKind};
use crate::js::{encode_uri_path, number_json, number_of, number_text};

const API: &str = "https://api.cloudflare.com/client/v4";

/// The SDK's `APIError` (an `APIConnectionError` has no status).
#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    pub(crate) status: Option<u16>,
    /// `errors[]` as `(code, message)`.
    pub(crate) errors: Vec<(i64, String)>,
    pub(crate) message: String,
    /// A connection failure (`APIConnectionError`), not an answer.
    pub(crate) connection: bool,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// `JSON.stringify(JSON.parse(text))`: the text without insignificant
/// whitespace, keys in their order.
fn minify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

/// `APIError.makeMessage(status, error, message)`.
fn status_message(status: u16, text: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(text).ok();
    let message = match &parsed {
        Some(error) if crate::js::truthy(Some(error)) || error.is_object() || error.is_array() => {
            match error.get("message") {
                Some(Value::String(m)) if !m.is_empty() => Some(m.clone()),
                Some(other) if crate::js::truthy(Some(other)) => Some(other.to_string()),
                _ => Some(minify(text)),
            }
        }
        Some(_) => Some(text.to_owned()).filter(|t| !t.is_empty()),
        None => Some(text.to_owned()).filter(|t| !t.is_empty()),
    };
    match message {
        Some(message) => format!("{status} {message}"),
        None => format!("{status} status code (no body)"),
    }
}

/// The SDK client: one per call, as the packages build one per call.
#[derive(Clone)]
struct Client {
    http: OutboundHttp,
    token: String,
}

impl Client {
    /// One API call with the SDK's retries; `Ok` with the parsed body.
    async fn call(
        &self,
        method: &str,
        path: &str,
        query: &str,
        body: Option<&Value>,
        max_retries: u32,
    ) -> Result<Value, ApiError> {
        let url = if query.is_empty() {
            format!("{API}{path}")
        } else {
            format!("{API}{path}?{query}")
        };
        let mut retries_remaining = max_retries;
        loop {
            let mut request = HttpRequest::empty(method, url.clone())
                .header("authorization", format!("Bearer {}", self.token))
                .header("accept", "application/json");
            if let Some(body) = body {
                request = request.header("content-type", "application/json");
                request.body = Some(body.to_string().into_bytes());
            }
            let response = match self.http.send(request).await {
                Ok(response) => response,
                Err(error) => {
                    if retries_remaining > 0 {
                        sleep_before_retry(None, retries_remaining, max_retries).await;
                        retries_remaining -= 1;
                        continue;
                    }
                    let timed_out = error.to_string().to_lowercase().contains("timed out")
                        || error.to_string().to_lowercase().contains("timeout");
                    return Err(ApiError {
                        status: None,
                        errors: Vec::new(),
                        message: if timed_out {
                            "Request timed out.".to_owned()
                        } else {
                            "Connection error.".to_owned()
                        },
                        connection: true,
                    });
                }
            };
            if !response.ok() {
                if retries_remaining > 0 && should_retry(&response) {
                    sleep_before_retry(Some(&response), retries_remaining, max_retries).await;
                    retries_remaining -= 1;
                    continue;
                }
                let text = response.text();
                let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let errors = parsed
                    .get("errors")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .map(|e| {
                                #[allow(clippy::cast_possible_truncation)]
                                let code = match e.get("code") {
                                    Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) as i64,
                                    Some(Value::String(s)) => number_of(s).unwrap_or(0.0) as i64,
                                    _ => 0,
                                };
                                let message = match e.get("message") {
                                    None | Some(Value::Null) => String::new(),
                                    Some(other) => crate::js::as_text(other),
                                };
                                (code, message)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return Err(ApiError {
                    status: Some(response.status),
                    errors,
                    message: status_message(response.status, &text),
                    connection: false,
                });
            }
            return Ok(serde_json::from_slice(&response.body).unwrap_or(Value::Null));
        }
    }
}

/// `shouldRetry`.
fn should_retry(response: &HttpResponse) -> bool {
    match response.header("x-should-retry") {
        Some("true") => return true,
        Some("false") => return false,
        _ => {}
    }
    matches!(response.status, 408 | 409 | 429) || response.status >= 500
}

/// `retryRequest`'s wait: `retry-after-ms`, `retry-after`, else exponential
/// backoff from half a second (jitter left out).
async fn sleep_before_retry(response: Option<&HttpResponse>, remaining: u32, max: u32) {
    let header = |name: &str| {
        response
            .and_then(|r| r.header(name))
            .and_then(|v| v.trim().parse::<f64>().ok())
    };
    let millis = header("retry-after-ms")
        .or_else(|| header("retry-after").map(|s| s * 1000.0))
        .filter(|ms| (0.0..60_000.0).contains(ms))
        .unwrap_or_else(|| {
            let attempt = f64::from(max - remaining);
            (0.5 * 2_f64.powf(attempt)).min(8.0) * 0.875 * 1000.0
        });
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    tokio::time::sleep(Duration::from_millis(millis as u64)).await;
}

// ── Zones and DNS records (`@weldsuite/cloudflare-zones`) ───────────────────

/// `toZoneError`.
fn to_zone_error(error: &ApiError) -> ZoneError {
    let codes: Vec<i64> = error.errors.iter().map(|(code, _)| *code).collect();
    let first = error.errors.first().map(|(_, message)| message.clone());
    let has = |code: i64| codes.contains(&code);
    let (kind, message) = if has(1061) || has(1100) {
        (
            ZoneErrorKind::InAnotherAccount,
            first.unwrap_or_else(|| "Domain is already in use on Cloudflare".to_owned()),
        )
    } else if matches!(error.status, Some(401 | 403)) {
        (
            ZoneErrorKind::AuthFailed,
            "Cloudflare API token is missing or lacks the required scope".to_owned(),
        )
    } else if has(1049) || has(1097) {
        (
            ZoneErrorKind::InvalidDomain,
            first.unwrap_or_else(|| "Invalid domain".to_owned()),
        )
    } else {
        let status = error
            .status
            .map_or_else(|| "(no status)".to_owned(), |s| s.to_string());
        (
            ZoneErrorKind::Unknown,
            format!(
                "Cloudflare API error {status}: {}",
                first.unwrap_or_else(|| error.message.clone())
            ),
        )
    };
    ZoneError {
        kind,
        message,
        codes,
        status: error.status,
    }
}

fn zone_of(result: &Value) -> Zone {
    Zone {
        zone_id: result
            .get("id")
            .map(crate::js::as_text)
            .unwrap_or_default(),
        nameservers: result
            .get("name_servers")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(crate::js::as_text).collect())
            .unwrap_or_default(),
        status: result
            .get("status")
            .filter(|s| !s.is_null())
            .map_or_else(|| "pending".to_owned(), crate::js::as_text),
    }
}

static QUOTED_TXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^("(?:[^"\\]|\\.)*")(?:\s+"(?:[^"\\]|\\.)*")*$"#).expect("the TXT pattern compiles")
});
static TXT_CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""((?:[^"\\]|\\.)*)""#).expect("the chunk pattern compiles"));
static WHITESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the whitespace pattern compiles"));

/// `quoteTxtContent`.
fn quote_txt(content: &str) -> String {
    if content.is_empty() {
        return "\"\"".to_owned();
    }
    let trimmed = crate::js::js_trim(content);
    if QUOTED_TXT.is_match(trimmed) {
        return trimmed.to_owned();
    }
    format!("\"{}\"", content.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `unwrapTxtContent`.
fn unwrap_txt(content: &str) -> String {
    let trimmed = crate::js::js_trim(content);
    if !QUOTED_TXT.is_match(trimmed) {
        return content.to_owned();
    }
    TXT_CHUNK
        .captures_iter(trimmed)
        .map(|c| c[1].replace("\\\"", "\"").replace("\\\\", "\\"))
        .collect()
}

/// `Number(text)` as JSON (`NaN` is `null`).
fn number_value(text: Option<&str>) -> Value {
    text.and_then(number_of).map_or(Value::Null, number_json)
}

/// `toCreateParams` without `zone_id` (the SDK puts it in the path).
fn create_params(record: &RecordInput) -> Value {
    let mut body = Map::new();
    body.insert("name".to_owned(), json!(record.name));
    body.insert(
        "ttl".to_owned(),
        record.ttl.map_or_else(|| json!(3600), number_json),
    );
    if let Some(comment) = record.comment.as_deref().filter(|c| !c.is_empty()) {
        body.insert("comment".to_owned(), json!(comment));
    }
    body.insert("type".to_owned(), json!(record.kind));
    let parts: Vec<&str> = WHITESPACE.split(crate::js::js_trim(&record.content)).collect();
    match record.kind.as_str() {
        "SRV" => {
            let mut data = Map::new();
            data.insert(
                "priority".to_owned(),
                record
                    .priority
                    .map_or_else(|| number_value(parts.first().copied()), number_json),
            );
            data.insert("weight".to_owned(), number_value(parts.get(1).copied()));
            data.insert("port".to_owned(), number_value(parts.get(2).copied()));
            let target = parts.get(3..).map(|rest| rest.join(" ")).unwrap_or_default();
            if !target.is_empty() {
                data.insert("target".to_owned(), json!(target));
            }
            body.insert("data".to_owned(), Value::Object(data));
        }
        "CAA" => {
            let mut data = Map::new();
            data.insert("flags".to_owned(), number_value(parts.first().copied()));
            if let Some(tag) = parts.get(1) {
                data.insert("tag".to_owned(), json!(tag));
            }
            let value = parts.get(2..).map(|rest| rest.join(" ")).unwrap_or_default();
            let value = value.strip_prefix('"').unwrap_or(&value);
            let value = value.strip_suffix('"').unwrap_or(value);
            if !value.is_empty() {
                data.insert("value".to_owned(), json!(value));
            }
            body.insert("data".to_owned(), Value::Object(data));
        }
        "MX" => {
            body.insert("content".to_owned(), json!(record.content));
            body.insert(
                "priority".to_owned(),
                record.priority.map_or_else(|| json!(0), number_json),
            );
            body.insert("proxied".to_owned(), json!(false));
        }
        "NS" => {
            body.insert("content".to_owned(), json!(record.content));
        }
        "TXT" => {
            body.insert("content".to_owned(), json!(quote_txt(&record.content)));
            body.insert("proxied".to_owned(), json!(false));
        }
        _ => {
            body.insert("content".to_owned(), json!(record.content));
            body.insert("proxied".to_owned(), json!(false));
        }
    }
    Value::Object(body)
}

/// `${n}` of a JSON value in a template.
fn template(value: &Value) -> String {
    match value {
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), number_text),
        other => crate::js::as_text(other),
    }
}

/// `contentFromData`.
fn content_from_data(kind: &str, data: &Value) -> Option<String> {
    let data = data.as_object()?;
    match kind {
        "SRV" => {
            let target = data.get("value").or_else(|| data.get("target"))?;
            let priority = data.get("priority")?;
            let weight = data.get("weight")?;
            let port = data.get("port")?;
            Some(format!(
                "{} {} {} {}",
                template(priority),
                template(weight),
                template(port),
                template(target)
            ))
        }
        "CAA" => {
            let flags = data.get("flags")?;
            let tag = data.get("tag")?;
            let value = data.get("value")?;
            Some(format!(
                "{} {} \"{}\"",
                template(flags),
                template(tag),
                template(value)
            ))
        }
        _ => None,
    }
}

/// `toDnsRecord`.
fn dns_record(r: &Value) -> DnsRecord {
    let raw_type = r.get("type").map(crate::js::as_text).unwrap_or_default();
    let data = r.get("data").cloned().unwrap_or(Value::Null);
    let raw_content = r
        .get("content")
        .filter(|c| !c.is_null())
        .map(crate::js::as_text)
        .or_else(|| content_from_data(&raw_type, &data))
        .unwrap_or_default();
    let editable = matches!(
        raw_type.as_str(),
        "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA" | "SRV" | "NS"
    );
    DnsRecord {
        id: r.get("id").map(crate::js::as_text).unwrap_or_default(),
        editable_type: editable.then(|| raw_type.clone()),
        name: r.get("name").map(crate::js::as_text).unwrap_or_default(),
        content: if raw_type == "TXT" {
            unwrap_txt(&raw_content)
        } else {
            raw_content
        },
        ttl: match r.get("ttl") {
            Some(ttl @ Value::Number(_)) => ttl.clone(),
            _ => json!(1),
        },
        priority: r.get("priority").cloned().unwrap_or(Value::Null),
        comment: r.get("comment").cloned().unwrap_or(Value::Null),
        data,
    }
}

/// Cloudflare as the DNS host.
pub(crate) struct CloudflareDns {
    client: Client,
}

impl CloudflareDns {
    pub(crate) fn new(http: OutboundHttp, token: &str) -> Self {
        Self {
            client: Client {
                http,
                token: token.to_owned(),
            },
        }
    }
}

impl DnsHost for CloudflareDns {
    fn create_zone<'a>(
        &'a self,
        account: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<Zone, ZoneError>> {
        Box::pin(async move {
            // Not idempotent: one attempt (`maxRetries: 0`).
            let body = json!({ "name": domain, "account": { "id": account }, "type": "full" });
            let result = self
                .client
                .call("POST", "/zones", "", Some(&body), 0)
                .await
                .map_err(|e| to_zone_error(&e))?;
            Ok(zone_of(&result["result"]))
        })
    }

    fn get_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, Result<Option<Zone>, ZoneError>> {
        Box::pin(async move {
            let path = format!("/zones/{}", encode_uri_path(zone_id));
            match self.client.call("GET", &path, "", None, 2).await {
                Ok(result) => Ok(Some(zone_of(&result["result"]))),
                Err(error) => {
                    let zone_error = to_zone_error(&error);
                    if zone_error.kind == ZoneErrorKind::Unknown
                        && (zone_error.codes.iter().any(|c| *c == 1001 || *c == 7003)
                            || zone_error.status == Some(404))
                    {
                        return Ok(None);
                    }
                    Err(zone_error)
                }
            }
        })
    }

    fn delete_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let path = format!("/zones/{}", encode_uri_path(zone_id));
            if let Err(error) = self.client.call("DELETE", &path, "", None, 2).await {
                tracing::error!(zone_id, %error, "[CloudflareZones] Rollback delete failed for zone");
            }
        })
    }

    fn list_records<'a>(
        &'a self,
        zone_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<DnsRecord>, ZoneError>> {
        Box::pin(async move {
            let path = format!("/zones/{}/dns_records", encode_uri_path(zone_id));
            let mut out = Vec::new();
            let mut page: u32 = 1;
            loop {
                let query = if page == 1 {
                    "per_page=100".to_owned()
                } else {
                    format!("per_page=100&page={page}")
                };
                let body = self
                    .client
                    .call("GET", &path, &query, None, 2)
                    .await
                    .map_err(|e| to_zone_error(&e))?;
                let items = body
                    .get("result")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if items.is_empty() {
                    break;
                }
                out.extend(items.iter().map(dns_record));
                page += 1;
            }
            Ok(out)
        })
    }

    fn create_record<'a>(
        &'a self,
        zone_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<Created, ZoneError>> {
        Box::pin(async move {
            let path = format!("/zones/{}/dns_records", encode_uri_path(zone_id));
            match self
                .client
                .call("POST", &path, "", Some(&create_params(record)), 2)
                .await
            {
                Ok(_) => Ok(Created::Created),
                Err(error) => {
                    let zone_error = to_zone_error(&error);
                    if zone_error.codes.iter().any(|c| *c == 81057 || *c == 81058) {
                        return Ok(Created::Duplicate);
                    }
                    Err(zone_error)
                }
            }
        })
    }

    fn update_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<(), ZoneError>> {
        Box::pin(async move {
            let path = format!(
                "/zones/{}/dns_records/{}",
                encode_uri_path(zone_id),
                encode_uri_path(record_id)
            );
            self.client
                .call("PUT", &path, "", Some(&create_params(record)), 2)
                .await
                .map(|_| ())
                .map_err(|e| to_zone_error(&e))
        })
    }

    fn delete_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
    ) -> BoxFuture<'a, Result<(), ZoneError>> {
        Box::pin(async move {
            let path = format!(
                "/zones/{}/dns_records/{}",
                encode_uri_path(zone_id),
                encode_uri_path(record_id)
            );
            match self.client.call("DELETE", &path, "", None, 2).await {
                Ok(_) => Ok(()),
                Err(error) => {
                    let zone_error = to_zone_error(&error);
                    if zone_error.codes.iter().any(|c| *c == 81044 || *c == 7003) {
                        return Ok(());
                    }
                    Err(zone_error)
                }
            }
        })
    }
}

// ── The legacy registrar (`@weldsuite/cloudflare-registrar`) ────────────────

/// `CloudflareApiError`, or a connection failure the package re-throws as
/// it is.
#[derive(Debug, Clone)]
pub(crate) enum RegistrarError {
    Api {
        status: u16,
        message: String,
    },
    Connection(String),
}

impl fmt::Display for RegistrarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api { status, message } => write!(f, "CloudflareApiError {status}: {message}"),
            Self::Connection(message) => f.write_str(message),
        }
    }
}

/// `translateErrors(endpoint, …)`.
fn registrar_error(endpoint: &str, error: ApiError) -> RegistrarError {
    if error.connection {
        return RegistrarError::Connection(error.message);
    }
    let detail = if error.errors.is_empty() {
        error.message.clone()
    } else {
        error
            .errors
            .iter()
            .map(|(code, message)| format!("{message} (code {code})"))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let status = error
        .status
        .map_or_else(|| "(no status)".to_owned(), |s| s.to_string());
    RegistrarError::Api {
        status: error.status.unwrap_or(0),
        message: format!("Cloudflare API {status} on {endpoint}: {detail}"),
    }
}

/// A registration as `getDomain` maps it.
#[derive(Debug, Clone)]
pub(crate) struct Registration {
    pub(crate) id: String,
    pub(crate) status: Value,
    pub(crate) expires_at: Option<String>,
    pub(crate) auto_renew: Value,
    pub(crate) locked: Value,
}

/// `CloudflareRegistrar`.
#[derive(Clone)]
pub(crate) struct CloudflareRegistrar {
    client: Client,
    account: String,
}

impl CloudflareRegistrar {
    pub(crate) fn new(http: OutboundHttp, token: &str, account: &str) -> Self {
        Self {
            client: Client {
                http,
                token: token.to_owned(),
            },
            account: account.to_owned(),
        }
    }

    fn path(&self, resource: &str, name: &str) -> String {
        format!(
            "/accounts/{}/registrar/{resource}/{}",
            encode_uri_path(&self.account),
            encode_uri_path(name)
        )
    }

    /// `getDomain`: `GET /accounts/{account}/registrar/registrations/{domain}`.
    pub(crate) async fn get_domain(&self, name: &str) -> Result<Registration, RegistrarError> {
        let body = self
            .client
            .call("GET", &self.path("registrations", name), "", None, 2)
            .await
            .map_err(|e| registrar_error("registrations", e))?;
        let r = &body["result"];
        Ok(Registration {
            id: r.get("domain_name").map(crate::js::as_text).unwrap_or_default(),
            status: r.get("status").cloned().unwrap_or(Value::Null),
            expires_at: r
                .get("expires_at")
                .filter(|v| !v.is_null())
                .map(crate::js::as_text),
            auto_renew: r.get("auto_renew").cloned().unwrap_or(Value::Null),
            locked: r.get("locked").cloned().unwrap_or(Value::Null),
        })
    }

    /// `updateDomain(name, { autoRenew, locked })`.
    pub(crate) async fn update_domain(
        &self,
        name: &str,
        auto_renew: Option<bool>,
        locked: Option<bool>,
    ) -> Result<(), RegistrarError> {
        if let Some(auto_renew) = auto_renew {
            self.client
                .call(
                    "PATCH",
                    &self.path("registrations", name),
                    "",
                    Some(&json!({ "auto_renew": auto_renew })),
                    2,
                )
                .await
                .map_err(|e| registrar_error("registrations", e))?;
        }
        if let Some(locked) = locked {
            self.client
                .call(
                    "PUT",
                    &self.path("domains", name),
                    "",
                    Some(&json!({ "locked": locked })),
                    2,
                )
                .await
                .map_err(|e| registrar_error("domains", e))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_quoting_round_trips() {
        assert_eq!(quote_txt("v=spf1 -all"), "\"v=spf1 -all\"");
        assert_eq!(quote_txt(" \"a\" \"b\" "), "\"a\" \"b\"");
        assert_eq!(quote_txt(""), "\"\"");
        assert_eq!(unwrap_txt("\"a\" \"b\""), "ab");
        assert_eq!(unwrap_txt("plain"), "plain");
        assert_eq!(unwrap_txt("\"say \\\"hi\\\"\""), "say \"hi\"");
    }

    #[test]
    fn create_params_follow_the_sdk_union() {
        let srv = create_params(&RecordInput {
            kind: "SRV".to_owned(),
            name: "_sip._tcp".to_owned(),
            content: "10 5 5060 sip.example.com".to_owned(),
            ttl: None,
            priority: None,
            comment: None,
        });
        assert_eq!(srv["data"], json!({ "priority": 10, "weight": 5, "port": 5060, "target": "sip.example.com" }));
        assert_eq!(srv["ttl"], json!(3600));
        let mx = create_params(&RecordInput {
            kind: "MX".to_owned(),
            name: "@".to_owned(),
            content: "mx.example.com".to_owned(),
            ttl: Some(300.0),
            priority: None,
            comment: Some(String::new()),
        });
        assert_eq!(mx, json!({ "name": "@", "ttl": 300, "type": "MX", "content": "mx.example.com", "priority": 0, "proxied": false }));
    }

    #[test]
    fn error_messages_match_the_sdk() {
        assert_eq!(
            status_message(403, r#"{ "success": false, "errors": [] }"#),
            r#"403 {"success":false,"errors":[]}"#
        );
        assert_eq!(status_message(500, ""), "500 status code (no body)");
        assert_eq!(status_message(502, "Bad gateway"), "502 Bad gateway");
        let error = to_zone_error(&ApiError {
            status: Some(400),
            errors: vec![(81058, "dup".to_owned())],
            message: String::new(),
            connection: false,
        });
        assert_eq!(error.kind, ZoneErrorKind::Unknown);
        assert_eq!(error.message, "Cloudflare API error 400: dup");
    }
}
