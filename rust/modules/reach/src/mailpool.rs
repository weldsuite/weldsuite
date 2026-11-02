//! `lib/mailpool`: the Mailpool REST client (WeldSuite's own account),
//! through the outbound HTTP port. Retries on 429 / 5xx and network
//! failures with backoff; a POST only on 429 / 503, where Mailpool certainly
//! did not process it (every mailbox costs money).

use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_reach_domain::ReachError;
use weldsuite_reach_domain::credentials::MailServerCredentials;

/// `MAILPOOL_DEFAULT_BASE_URL`.
pub(crate) const DEFAULT_BASE_URL: &str = "https://app.mailpool.io/v1/api";
const MAX_RETRIES: u32 = 3;
const BASE_BACKOFF_MS: u64 = 300;
const MAX_BACKOFF_MS: u64 = 5_000;

/// `MailpoolError`: Mailpool answered with an error, or could not be reached.
#[derive(Debug, Clone)]
pub(crate) struct MailpoolError {
    pub(crate) status: u16,
    pub(crate) message: String,
}

impl MailpoolError {
    pub(crate) fn is_not_found(&self) -> bool {
        self.status == 404
    }
}

/// A Mailpool failure as the routes answer it (`mapReachError`).
pub(crate) fn upstream(error: &MailpoolError) -> ReachError {
    tracing::error!(status = error.status, message = %error.message, "[reach] UPSTREAM_ERROR: Mailpool");
    ReachError::new(
        502,
        "UPSTREAM_ERROR",
        "The mailbox provider could not complete the request. Try again in a moment.",
    )
}

/// `MailpoolNotConfiguredError` as the routes answer it.
pub(crate) fn not_configured() -> ReachError {
    ReachError::new(
        503,
        "SERVICE_UNAVAILABLE",
        "Outreach mailbox provider is not configured.",
    )
}

fn message_from(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(weldsuite_reach_domain::js_slice(s, 300)),
        Value::Object(map) => map.get("message").and_then(|m| match m {
            Value::String(s) if !s.is_empty() => Some(weldsuite_reach_domain::js_slice(s, 300)),
            _ => None,
        }),
        _ => None,
    }
}

/// `extractMessage(body)`.
fn extract_message(body: Option<&Value>) -> Option<String> {
    match body? {
        Value::String(s) => (!s.is_empty()).then(|| weldsuite_reach_domain::js_slice(s, 300)),
        Value::Object(map) => ["message", "error", "detail"]
            .iter()
            .find_map(|key| map.get(*key).and_then(message_from)),
        _ => None,
    }
}

/// The client (`createMailpoolClient(env)`).
#[derive(Clone)]
pub(crate) struct Mailpool {
    api_key: String,
    base_url: String,
    http: OutboundHttp,
}

/// `encodeURIComponent(id)`.
fn segment(id: &str) -> String {
    weldsuite_reach_domain::dns::encode_uri_component(id)
}

impl Mailpool {
    /// `createMailpoolClient(env)`: `None` without `MAILPOOL_API_KEY`.
    pub(crate) fn new(
        api_key: Option<String>,
        base_url: Option<String>,
        http: OutboundHttp,
    ) -> Option<Self> {
        let api_key = api_key.filter(|k| !k.is_empty())?;
        let base = base_url
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        Some(Self {
            api_key,
            base_url: base.trim_end_matches('/').to_owned(),
            http,
        })
    }

    fn should_retry(method: &str, status: u16) -> bool {
        if status == 429 {
            return true;
        }
        if method == "POST" {
            return status == 503;
        }
        status >= 500
    }

    fn backoff(retry: u32, retry_after: Option<&str>) -> u64 {
        if let Some(seconds) = retry_after.and_then(|s| s.trim().parse::<f64>().ok())
            && seconds.is_finite()
            && seconds >= 0.0
        {
            return ((seconds * 1000.0) as u64).min(MAX_BACKOFF_MS);
        }
        let jitter = weldsuite_kit::random_string(2, "0123456789")
            .parse::<u64>()
            .unwrap_or_default();
        (BASE_BACKOFF_MS * 2u64.pow(retry) + jitter).min(MAX_BACKOFF_MS)
    }

    fn read_body(bytes: &[u8]) -> Option<Value> {
        if bytes.is_empty() {
            return None;
        }
        Some(
            serde_json::from_slice(bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned())),
        )
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Option<Value>, MailpoolError> {
        let mut url = format!("{}{path}", self.base_url);
        if !query.is_empty() {
            let qs = form_urlencoded_pairs(query);
            url.push('?');
            url.push_str(&qs);
        }
        let mut retry = 0u32;
        loop {
            let mut headers = vec![
                ("X-Api-Authorization".to_owned(), self.api_key.clone()),
                ("Accept".to_owned(), "application/json".to_owned()),
            ];
            if body.is_some() {
                headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
            }
            let request = HttpRequest {
                method: method.to_owned(),
                url: url.clone(),
                headers,
                body: body.map(|b| b.to_string().into_bytes()),
            };
            match self.http.send(request).await {
                Err(_) => {
                    if method != "POST" && retry < MAX_RETRIES {
                        tokio::time::sleep(Duration::from_millis(Self::backoff(retry, None))).await;
                        retry += 1;
                        continue;
                    }
                    return Err(MailpoolError {
                        status: 0,
                        message: format!("Mailpool {method} {path} failed: no response"),
                    });
                }
                Ok(response) => {
                    if (200..300).contains(&response.status) {
                        return Ok(Self::read_body(&response.body));
                    }
                    if Self::should_retry(method, response.status) && retry < MAX_RETRIES {
                        let retry_after = response
                            .headers
                            .iter()
                            .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
                            .map(|(_, value)| value.as_str());
                        tokio::time::sleep(Duration::from_millis(Self::backoff(
                            retry,
                            retry_after,
                        )))
                        .await;
                        retry += 1;
                        continue;
                    }
                    let parsed = Self::read_body(&response.body);
                    let prefix = format!("Mailpool {method} {path}");
                    let message = match extract_message(parsed.as_ref()) {
                        Some(detail) => {
                            format!("{prefix} failed with {}: {detail}", response.status)
                        }
                        None => format!("{prefix} failed with {}", response.status),
                    };
                    return Err(MailpoolError {
                        status: response.status,
                        message,
                    });
                }
            }
        }
    }

    pub(crate) async fn get_domain(&self, id: &str) -> Result<Value, MailpoolError> {
        Ok(self
            .request("GET", &format!("/domains/{}", segment(id)), &[], None)
            .await?
            .unwrap_or(Value::Null))
    }

    pub(crate) async fn delete_domain(&self, id: &str) -> Result<(), MailpoolError> {
        self.request("DELETE", &format!("/domains/{}", segment(id)), &[], None)
            .await
            .map(|_| ())
    }

    pub(crate) async fn get_domain_dns(&self, id: &str) -> Result<Vec<Value>, MailpoolError> {
        Ok(self
            .request("GET", &format!("/domains/{}/dns", segment(id)), &[], None)
            .await?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default())
    }

    /// `connectCloudflareDomains(domains)`: (connected, skipped).
    pub(crate) async fn connect_cloudflare_domains(
        &self,
        domains: &[String],
    ) -> Result<(Vec<Value>, Vec<Value>), MailpoolError> {
        let res = self
            .request(
                "POST",
                "/domains/cloudflare/connect",
                &[],
                Some(&json!({ "domains": domains })),
            )
            .await?;
        let list = |key: &str| {
            res.as_ref()
                .and_then(|r| r.get(key))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        Ok((list("connected"), list("skipped")))
    }

    /// `createMailbox(input)`: the API takes an array and answers `{ emails }`.
    pub(crate) async fn create_mailbox(&self, input: &Value) -> Result<Value, MailpoolError> {
        let res = self
            .request("POST", "/mailboxes", &[], Some(&json!([input])))
            .await?;
        res.as_ref()
            .and_then(|r| r.get("emails"))
            .and_then(|e| e.get(0))
            .cloned()
            .ok_or_else(|| MailpoolError {
                status: 502,
                message: "Mailpool accepted the request but returned no mailbox".to_owned(),
            })
    }

    /// `listMailboxes({ domainId, limit, offset })`: the page's mailboxes.
    pub(crate) async fn list_mailboxes(
        &self,
        domain_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Value>, MailpoolError> {
        let res = self
            .request(
                "GET",
                "/mailboxes",
                &[
                    ("domainId", domain_id.to_owned()),
                    ("limit", limit.to_string()),
                    ("offset", offset.to_string()),
                ],
                None,
            )
            .await?;
        Ok(res
            .as_ref()
            .and_then(|r| r.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) async fn get_mailbox(&self, id: &str) -> Result<Value, MailpoolError> {
        Ok(self
            .request("GET", &format!("/mailboxes/{}", segment(id)), &[], None)
            .await?
            .unwrap_or(Value::Null))
    }

    pub(crate) async fn update_mailbox(
        &self,
        id: &str,
        patch: &Value,
    ) -> Result<(), MailpoolError> {
        self.request(
            "PUT",
            &format!("/mailboxes/{}", segment(id)),
            &[],
            Some(patch),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn delete_mailbox(&self, id: &str) -> Result<(), MailpoolError> {
        self.request("DELETE", &format!("/mailboxes/{}", segment(id)), &[], None)
            .await
            .map(|_| ())
    }

    /// `getSlots()`: (mailboxes, slots).
    pub(crate) async fn get_slots(&self) -> Result<(Value, Value), MailpoolError> {
        let res = self
            .request("GET", "/subscriptions/slots", &[], None)
            .await?;
        let part = |key: &str| {
            res.as_ref()
                .and_then(|r| r.get(key))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({}))
        };
        Ok((part("mailboxes"), part("slots")))
    }

    pub(crate) async fn increase_slots(&self, kind: &str, by: i64) -> Result<(), MailpoolError> {
        self.request(
            "POST",
            "/subscriptions/increase",
            &[],
            Some(&json!({ "type": kind, "increaseBy": by })),
        )
        .await
        .map(|_| ())
    }
}

/// `URLSearchParams` text of the pairs.
fn form_urlencoded_pairs(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", url_param(k), url_param(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `application/x-www-form-urlencoded` of one value, as `URLSearchParams` writes it.
fn url_param(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn port_of(value: Option<&Value>) -> Option<u16> {
    let port = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .or_else(|| s.is_empty().then_some(0.0))?,
        _ => return None,
    };
    (port.fract() == 0.0 && port > 0.0 && port < 65536.0).then_some(port as u16)
}

fn login(mailbox: &Value, prefix: &str) -> Option<MailServerCredentials> {
    let text = |key: &str| {
        mailbox
            .get(format!("{prefix}{key}"))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let port = port_of(mailbox.get(format!("{prefix}Port")))?;
    Some(MailServerCredentials {
        host: text("Host")?,
        port,
        tls: mailbox.get(format!("{prefix}TLS")).and_then(Value::as_bool) != Some(false),
        username: text("Username")?,
        password: text("Password")?,
    })
}

/// `smtpCredentialsOf(mailbox)`.
pub(crate) fn smtp_credentials_of(mailbox: &Value) -> Option<MailServerCredentials> {
    login(mailbox, "smtp")
}

/// `imapCredentialsOf(mailbox)`.
pub(crate) fn imap_credentials_of(mailbox: &Value) -> Option<MailServerCredentials> {
    login(mailbox, "imap")
}

/// The id Mailpool gave a record, as text (`String(id)`).
pub(crate) fn id_text(value: &Value) -> String {
    match value.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) if !other.is_null() => other.to_string(),
        _ => "undefined".to_owned(),
    }
}
