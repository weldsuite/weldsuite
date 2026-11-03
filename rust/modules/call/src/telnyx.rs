//! Telnyx's REST API (`lib/telnyx.ts`, `lib/telnyx-porting.ts`): the two
//! request helpers the worker has (the general one and the porting one,
//! which classifies failures), Call Control actions, AI assistants and the
//! webhook signature check.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::Unreachable;
use crate::js::{self, Ordered};

pub(crate) const TELNYX_API_BASE: &str = "https://api.telnyx.com/v2";

/// Countries whose numbers need a verified Telnyx address before purchase
/// (`COUNTRIES_REQUIRING_ADDRESS`).
pub(crate) const COUNTRIES_REQUIRING_ADDRESS: [&str; 18] = [
    "NL", "DE", "BE", "AT", "CH", "FR", "ES", "IT", "PT", "SE", "NO", "DK", "FI", "PL", "CZ", "HU",
    "IE", "LU",
];

/// A request body: JSON, or a multipart form with one file.
pub(crate) enum Body {
    Json(Value),
    File {
        name: String,
        content_type: String,
        bytes: Vec<u8>,
    },
}

/// Why `telnyxRequest` threw; `Display` is the error's message.
#[derive(Debug)]
pub(crate) enum TelnyxError {
    NotConfigured,
    OutsideBase,
    /// The `fetch` itself failed.
    Network(String),
    /// A non-2xx answer: `Telnyx API error: <status> - <detail>`.
    Api(String),
    /// A 2xx answer that isn't JSON.
    BadJson(String),
}

impl std::fmt::Display for TelnyxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => f.write_str("Telnyx API key is not configured"),
            Self::OutsideBase => f.write_str("Telnyx API endpoint is outside the API base"),
            Self::Network(message) | Self::Api(message) | Self::BadJson(message) => {
                f.write_str(message)
            }
        }
    }
}

/// `TelnyxPortingErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortingCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    ValidationFailed,
    RateLimited,
    TelnyxUnavailable,
    Unknown,
}

impl PortingCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::ValidationFailed => "validation_failed",
            Self::RateLimited => "rate_limited",
            Self::TelnyxUnavailable => "telnyx_unavailable",
            Self::Unknown => "unknown",
        }
    }

    fn of(status: u16) -> Self {
        match status {
            401 => Self::Unauthorized,
            403 => Self::Forbidden,
            404 => Self::NotFound,
            409 => Self::Conflict,
            422 => Self::ValidationFailed,
            429 => Self::RateLimited,
            s if s >= 500 => Self::TelnyxUnavailable,
            _ => Self::Unknown,
        }
    }
}

/// `TelnyxPortingError`, or anything else the porting helpers threw.
#[derive(Debug)]
pub(crate) enum PortingError {
    Telnyx {
        code: PortingCode,
        message: String,
        telnyx_errors: Value,
    },
    /// Not a `TelnyxPortingError` (a body that isn't JSON).
    Other(String),
}

impl std::fmt::Display for PortingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Telnyx { message, .. } | Self::Other(message) => f.write_str(message),
        }
    }
}

impl PortingError {
    fn telnyx(code: PortingCode, message: impl Into<String>) -> Self {
        Self::Telnyx {
            code,
            message: message.into(),
            telnyx_errors: Value::Null,
        }
    }
}

/// What a porting request answered: JSON, or a PDF's bytes.
pub(crate) enum PortingBody {
    Json(Value),
    Bytes(Vec<u8>),
}

impl PortingBody {
    pub(crate) fn json(self) -> Value {
        match self {
            Self::Json(value) => value,
            Self::Bytes(_) => Value::Null,
        }
    }
}

/// Telnyx with the deployment's key (`TELNYX_API_KEY`).
pub(crate) struct Telnyx {
    api_key: Option<String>,
    http: OutboundHttp,
}

/// A random multipart boundary.
fn boundary() -> String {
    format!("----weldsuite{}", uuid::Uuid::new_v4().simple())
}

/// `FormData` with one file field named `file`, as `fetch` sends it.
fn multipart(name: &str, content_type: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = boundary();
    let escaped = name
        .replace('\r', "%0D")
        .replace('\n', "%0A")
        .replace('"', "%22");
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{escaped}\"\r\nContent-Type: {content_type}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// `errors[0].detail || errors[0].title` of a Telnyx error body.
fn first_error(body: &Value) -> Value {
    let first = &body["errors"][0];
    js::or(&[&first["detail"], &first["title"]]).clone()
}

impl Telnyx {
    pub(crate) fn new(api_key: Option<String>, http: Option<OutboundHttp>) -> Self {
        Self {
            api_key,
            http: http.unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable))),
        }
    }

    /// `isTelnyxConfigured(env)`.
    pub(crate) fn configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub(crate) fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    /// A raw call (the WebRTC token route calls `fetch` itself).
    pub(crate) async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.http
            .send(request)
            .await
            .map_err(|error| error.to_string())
    }

    /// `resolveTelnyxUrl(endpoint)`: inside `https://api.telnyx.com/v2/`,
    /// `..` collapsed as `new URL` does.
    fn resolve(endpoint: &str) -> Result<String, TelnyxError> {
        let raw = if endpoint.starts_with("http") {
            endpoint.to_owned()
        } else {
            format!("{TELNYX_API_BASE}{endpoint}")
        };
        let url = url::Url::parse(&raw).map_err(|_| TelnyxError::OutsideBase)?;
        if url.scheme() != "https"
            || url.host_str() != Some("api.telnyx.com")
            || url.port().is_some()
            || !url.path().starts_with("/v2/")
        {
            return Err(TelnyxError::OutsideBase);
        }
        Ok(url.to_string())
    }

    /// `telnyxRequest(env, endpoint, { method, body })`.
    pub(crate) async fn request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Body>,
    ) -> Result<Value, TelnyxError> {
        let Some(key) = &self.api_key else {
            return Err(TelnyxError::NotConfigured);
        };
        let url = Self::resolve(endpoint)?;
        let mut request =
            HttpRequest::empty(method, url).header("Authorization", format!("Bearer {key}"));
        match body {
            Some(Body::File {
                name,
                content_type,
                bytes,
            }) => {
                let (content_type, bytes) = multipart(&name, &content_type, &bytes);
                request = request.header("Content-Type", content_type);
                request.body = Some(bytes);
            }
            Some(Body::Json(value)) => {
                request = request.header("Content-Type", "application/json");
                request.body = Some(value.to_string().into_bytes());
            }
            None => request = request.header("Content-Type", "application/json"),
        }
        let response = self
            .http
            .send(request)
            .await
            .map_err(|error| TelnyxError::Network(error.to_string()))?;
        if !response.ok() {
            let error = serde_json::from_slice::<Value>(&response.body).unwrap_or(json!({}));
            // `response.statusText` is not reported through the port: it
            // reads as empty, as it does for an HTTP/2 answer.
            let detail = first_error(&error);
            let detail = if js::truthy(&detail) {
                js::string(&detail)
            } else {
                String::new()
            };
            return Err(TelnyxError::Api(format!(
                "Telnyx API error: {} - {detail}",
                response.status
            )));
        }
        if response.status == 204 {
            return Ok(Value::Object(Map::new()));
        }
        serde_json::from_slice(&response.body)
            .map_err(|error| TelnyxError::BadJson(error.to_string()))
    }

    /// `telnyxPortingRequest(env, endpoint, options)`.
    pub(crate) async fn porting(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Body>,
        accept_pdf: bool,
    ) -> Result<PortingBody, PortingError> {
        let Some(key) = &self.api_key else {
            return Err(PortingError::telnyx(
                PortingCode::TelnyxUnavailable,
                "Telnyx API key is not configured on this worker",
            ));
        };
        let url = if endpoint.starts_with("http") {
            endpoint.to_owned()
        } else {
            format!("{TELNYX_API_BASE}{endpoint}")
        };
        let mut request = HttpRequest::empty(method, url)
            .header("Authorization", format!("Bearer {key}"))
            .header(
                "Accept",
                if accept_pdf {
                    "application/pdf"
                } else {
                    "application/json"
                },
            );
        match body {
            Some(Body::Json(value)) => {
                request = request.header("Content-Type", "application/json");
                request.body = Some(value.to_string().into_bytes());
            }
            Some(Body::File {
                name,
                content_type,
                bytes,
            }) => {
                let (content_type, bytes) = multipart(&name, &content_type, &bytes);
                request = request.header("Content-Type", content_type);
                request.body = Some(bytes);
            }
            None => {}
        }
        let response = match self.http.send(request).await {
            Ok(response) => response,
            Err(error) => {
                return Err(PortingError::telnyx(
                    PortingCode::TelnyxUnavailable,
                    format!("Telnyx network error: {error}"),
                ));
            }
        };
        if !response.ok() {
            let raw = response.text();
            let parsed = if raw.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(&raw).ok()
            };
            let detail = parsed.as_ref().map_or(Value::Null, first_error);
            let message = if js::truthy(&detail) {
                format!("Telnyx {}: {}", response.status, js::string(&detail))
            } else {
                let note = if raw.is_empty() {
                    String::new()
                } else {
                    format!(" — body: {}", js::slice_utf16(&raw, 300))
                };
                format!("Telnyx {} on {endpoint} — no body{note}", response.status)
            };
            tracing::error!(status = response.status, %endpoint, "[TelnyxPorting] Request failed");
            let telnyx_errors = parsed
                .as_ref()
                .map_or(Value::Null, |body| body["errors"].clone());
            return Err(PortingError::Telnyx {
                code: PortingCode::of(response.status),
                message,
                telnyx_errors,
            });
        }
        if response.status == 204 {
            return Ok(PortingBody::Json(Value::Object(Map::new())));
        }
        let content_type = response.header("content-type").unwrap_or_default();
        if content_type.contains("application/pdf") || content_type.contains("octet-stream") {
            return Ok(PortingBody::Bytes(response.body));
        }
        serde_json::from_slice(&response.body)
            .map(PortingBody::Json)
            .map_err(|error| PortingError::Other(error.to_string()))
    }

    // ── Call Control ────────────────────────────────────────────────────────

    /// `callControlAction(env, callControlId, action, body)`.
    async fn action(
        &self,
        call_control_id: &str,
        action: &str,
        body: Value,
    ) -> Result<Value, TelnyxError> {
        self.request(
            "POST",
            &format!(
                "/calls/{}/actions/{}",
                js::encode_uri_component(call_control_id),
                js::encode_uri_component(action)
            ),
            Some(Body::Json(body)),
        )
        .await
    }

    /// `telnyxAnswer(env, id, { clientState })`.
    pub(crate) async fn answer(
        &self,
        id: &str,
        client_state: Option<&str>,
    ) -> Result<Value, TelnyxError> {
        self.action(id, "answer", with_client_state(Map::new(), client_state))
            .await
    }

    /// `telnyxHangup(env, id, { clientState })`.
    pub(crate) async fn hangup(
        &self,
        id: &str,
        client_state: Option<&str>,
    ) -> Result<Value, TelnyxError> {
        self.action(id, "hangup", with_client_state(Map::new(), client_state))
            .await
    }

    /// `telnyxTransfer(env, id, to, { clientState, from })`.
    pub(crate) async fn transfer(
        &self,
        id: &str,
        to: &str,
        client_state: Option<&str>,
        from: Option<&str>,
    ) -> Result<Value, TelnyxError> {
        let mut body = Map::new();
        body.insert("to".to_owned(), json!(to));
        if let Some(from) = from.filter(|f| !f.is_empty()) {
            body.insert("from".to_owned(), json!(from));
        }
        self.action(id, "transfer", with_client_state(body, client_state))
            .await
    }

    /// `telnyxRecordStart(env, id)`: dual-channel mp3.
    pub(crate) async fn record_start(&self, id: &str) -> Result<Value, TelnyxError> {
        self.action(
            id,
            "record_start",
            json!({ "channels": "dual", "format": "mp3" }),
        )
        .await
    }

    /// `telnyxAiAssistantStart(env, id, assistantId, opts)`.
    pub(crate) async fn ai_assistant_start(
        &self,
        id: &str,
        assistant_id: &str,
        start: AssistantStart,
    ) -> Result<Value, TelnyxError> {
        let mut assistant = Map::new();
        assistant.insert("id".to_owned(), json!(assistant_id));
        if !start.instructions.is_empty() {
            assistant.insert("instructions".to_owned(), json!(start.instructions));
        }
        if let Some(tools) = start.tools {
            assistant.insert("tools".to_owned(), Value::Array(tools));
        }
        if let Some(variables) = start.dynamic_variables {
            assistant.insert("dynamic_variables".to_owned(), Value::Object(variables));
        }
        let mut body = Map::new();
        body.insert("assistant".to_owned(), Value::Object(assistant));
        body.insert("send_message_history_updates".to_owned(), json!(true));
        self.action(
            id,
            "ai_assistant_start",
            with_client_state(body, Some(&start.client_state)),
        )
        .await
    }

    // ── AI assistants ───────────────────────────────────────────────────────

    /// `telnyxCreateAssistant(env, input)`: the new assistant's id.
    pub(crate) async fn create_assistant(
        &self,
        input: &AssistantInput,
    ) -> Result<String, TelnyxError> {
        let response = self
            .request("POST", "/ai/assistants", Some(Body::Json(input.payload())))
            .await?;
        Ok(js::string(&response["data"]["id"]))
    }

    /// `telnyxUpdateAssistant(env, id, input)`.
    pub(crate) async fn update_assistant(
        &self,
        id: &str,
        input: &AssistantInput,
    ) -> Result<(), TelnyxError> {
        self.request(
            "POST",
            &format!("/ai/assistants/{}", js::encode_uri_component(id)),
            Some(Body::Json(input.payload())),
        )
        .await
        .map(|_| ())
    }

    /// `telnyxDeleteAssistant(env, id)`.
    pub(crate) async fn delete_assistant(&self, id: &str) -> Result<(), TelnyxError> {
        self.request(
            "DELETE",
            &format!("/ai/assistants/{}", js::encode_uri_component(id)),
            None,
        )
        .await
        .map(|_| ())
    }
}

/// `...(clientState ? { client_state } : {})`.
fn with_client_state(mut body: Map<String, Value>, client_state: Option<&str>) -> Value {
    if let Some(state) = client_state.filter(|s| !s.is_empty()) {
        body.insert("client_state".to_owned(), json!(state));
    }
    Value::Object(body)
}

/// `telnyxAiAssistantStart`'s options as the inbound route passes them.
pub(crate) struct AssistantStart {
    pub(crate) client_state: String,
    pub(crate) instructions: String,
    pub(crate) tools: Option<Vec<Value>>,
    pub(crate) dynamic_variables: Option<Map<String, Value>>,
}

/// `TelnyxAssistantInput`.
pub(crate) struct AssistantInput {
    pub(crate) name: String,
    pub(crate) instructions: String,
    pub(crate) greeting: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) voice: Option<String>,
    pub(crate) transfer_to_e164: Option<String>,
    pub(crate) extra_tools: Vec<Value>,
}

impl AssistantInput {
    /// `assistantPayload(input)`.
    fn payload(&self) -> Value {
        let mut tools = vec![json!({ "type": "hangup" })];
        tools.extend(self.extra_tools.iter().cloned());
        if let Some(to) = self.transfer_to_e164.as_deref().filter(|t| !t.is_empty()) {
            tools.push(transfer_tool(to));
        }
        let mut payload = Map::new();
        payload.insert("name".to_owned(), json!(self.name));
        payload.insert("instructions".to_owned(), json!(self.instructions));
        payload.insert(
            "model".to_owned(),
            json!(
                self.model
                    .as_deref()
                    .filter(|m| !m.is_empty())
                    .unwrap_or("meta-llama/Meta-Llama-3.1-70B-Instruct")
            ),
        );
        payload.insert("enabled_features".to_owned(), json!(["telephony"]));
        payload.insert("tools".to_owned(), Value::Array(tools));
        payload.insert(
            "telephony_settings".to_owned(),
            json!({ "send_message_history_updates": true }),
        );
        if let Some(greeting) = self.greeting.as_deref().filter(|g| !g.is_empty()) {
            payload.insert("greeting".to_owned(), json!(greeting));
        }
        if let Some(voice) = self.voice.as_deref().filter(|v| !v.is_empty()) {
            payload.insert("voice_settings".to_owned(), json!({ "voice": voice }));
        }
        Value::Object(payload)
    }
}

/// The cold-transfer tool to a human at `to`.
pub(crate) fn transfer_tool(to: &str) -> Value {
    json!({
        "type": "transfer",
        "transfer": { "from": null, "targets": [{ "name": "Human", "to": to }] },
    })
}

/// `encodeClientState(state)`: `btoa(JSON.stringify(state))`, keys in the
/// order given.
pub(crate) fn encode_client_state(state: &Ordered) -> String {
    js::btoa(&state.stringify())
}

/// `decodeClientState(clientState)`: `{}` for anything that isn't base64
/// JSON. Values are read as strings where they are strings.
pub(crate) fn decode_client_state(client_state: Option<&str>) -> Map<String, Value> {
    let Some(text) = client_state.filter(|t| !t.is_empty()) else {
        return Map::new();
    };
    let Some(bytes) = js::atob(text) else {
        return Map::new();
    };
    // `atob` yields one character per byte (Latin-1).
    let latin1: String = bytes.iter().map(|&b| char::from(b)).collect();
    match serde_json::from_str::<Value>(&latin1) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

// ── Webhook signatures (Ed25519) ─────────────────────────────────────────────

/// Allowed clock skew between `telnyx-timestamp` and now.
const SIGNATURE_TOLERANCE_SECONDS: f64 = 5.0 * 60.0;

/// `verifyTelnyxSignature({ publicKeyB64, rawBody, signatureB64, timestamp })`:
/// Telnyx signs `<timestamp>|<raw body>` with the account's Ed25519 key.
pub(crate) fn verify_signature(
    public_key_b64: &str,
    raw_body: &str,
    signature_b64: Option<&str>,
    timestamp: Option<&str>,
    now_seconds: i64,
) -> bool {
    let (Some(signature), Some(timestamp)) = (
        signature_b64.filter(|s| !s.is_empty()),
        timestamp.filter(|t| !t.is_empty()),
    ) else {
        return false;
    };
    let ts = weldsuite_kit::validation::js_number(timestamp);
    if !ts.is_finite() {
        return false;
    }
    #[allow(clippy::cast_precision_loss)]
    if ((now_seconds as f64) - ts).abs() > SIGNATURE_TOLERANCE_SECONDS {
        return false;
    }
    let (Some(key), Some(signature)) = (js::atob(public_key_b64), js::atob(signature)) else {
        return false;
    };
    if key.len() != 32 {
        tracing::error!("[telnyx] signature verification errored: bad key length");
        return false;
    }
    let message = format!("{timestamp}|{raw_body}");
    aws_lc_rs::signature::UnparsedPublicKey::new(&aws_lc_rs::signature::ED25519, key)
        .verify(message.as_bytes(), &signature)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    use super::*;

    #[test]
    fn signatures_are_checked_like_the_worker() {
        let rng = aws_lc_rs::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("key");
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("pair");
        let public = STANDARD.encode(pair.public_key().as_ref());
        let body = r#"{"data":{"event_type":"call.hangup"}}"#;
        let now = 1_800_000_000_i64;
        let stamp = now.to_string();
        let signature = STANDARD.encode(pair.sign(format!("{stamp}|{body}").as_bytes()).as_ref());
        assert!(verify_signature(
            &public,
            body,
            Some(&signature),
            Some(&stamp),
            now
        ));
        assert!(!verify_signature(
            &public,
            "{}",
            Some(&signature),
            Some(&stamp),
            now
        ));
        assert!(!verify_signature(
            &public,
            body,
            Some(&signature),
            Some(&stamp),
            now + 301
        ));
        assert!(!verify_signature(&public, body, None, Some(&stamp), now));
        assert!(!verify_signature(
            &public,
            body,
            Some("AAAA"),
            Some(&stamp),
            now
        ));
        assert!(!verify_signature(
            "AAAA",
            body,
            Some(&signature),
            Some(&stamp),
            now
        ));
        assert!(!verify_signature(
            &public,
            body,
            Some(&signature),
            Some("soon"),
            now
        ));
    }

    #[test]
    fn client_state_round_trips_in_key_order() {
        let state = Ordered::new()
            .with("callId", "vcall_1")
            .with("workspaceId", "org_1");
        let encoded = encode_client_state(&state);
        assert_eq!(
            encoded,
            "eyJjYWxsSWQiOiJ2Y2FsbF8xIiwid29ya3NwYWNlSWQiOiJvcmdfMSJ9"
        );
        let decoded = decode_client_state(Some(&encoded));
        assert_eq!(decoded["callId"], "vcall_1");
        assert!(decode_client_state(Some("not base64!")).is_empty());
        assert!(decode_client_state(None).is_empty());
    }

    #[test]
    fn urls_stay_inside_the_api_base() {
        assert_eq!(
            Telnyx::resolve("/available_phone_numbers?filter%5Bcountry_code%5D=NL").expect("url"),
            "https://api.telnyx.com/v2/available_phone_numbers?filter%5Bcountry_code%5D=NL"
        );
        assert!(Telnyx::resolve("/../../evil").is_err());
        assert!(Telnyx::resolve("https://evil.example/v2/x").is_err());
    }
}
