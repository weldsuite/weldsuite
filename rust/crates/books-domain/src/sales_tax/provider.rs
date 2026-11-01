//! Shared plumbing of the provider engines (`sales-tax/provider-common.ts`):
//! one HTTP call with the error mapping, form bodies, Basic credentials.
//!
//! An engine failure never posts zero tax: every failure is an
//! [`EngineError`] the caller can retry or surface. The calls go through the
//! [`OutboundHttp`] port (the conformance outbound bridge compares them).

use base64::Engine as _;
use serde_json::Value;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::errors::EngineError;

/// `new SalesTaxEngineError(message, code, retryable)`.
pub fn engine_error(message: impl Into<String>, code: &'static str, retryable: bool) -> EngineError {
    EngineError {
        message: message.into(),
        code,
        retryable,
    }
}

/// `invalid_request`, not retryable.
pub fn invalid_request(message: impl Into<String>) -> EngineError {
    engine_error(message, "invalid_request", false)
}

/// `not_configured`, not retryable.
pub fn not_configured(message: impl Into<String>) -> EngineError {
    engine_error(message, "not_configured", false)
}

/// The error text a provider put in its JSON body, if any.
fn error_text(body: &Value) -> Option<String> {
    let root = body.as_object()?;
    match root.get("error") {
        Some(Value::Object(error)) => {
            let detail = error
                .get("details")
                .and_then(Value::as_array)
                .and_then(|d| {
                    d.iter()
                        .find_map(|item| item.get("message").and_then(Value::as_str))
                });
            let message = error.get("message").and_then(Value::as_str);
            match (message, detail) {
                (Some(message), Some(detail)) if detail != message => {
                    Some(format!("{message} ({detail})"))
                }
                (message, _) => message.map(str::to_owned),
            }
        }
        // `error && typeof error === 'object'` fails (a string, a number, an
        // array still is an object): fall through to `message`.
        Some(Value::Array(_)) => None,
        _ => root.get("message").and_then(Value::as_str).map(str::to_owned),
    }
}

/// One provider call (`ProviderCall`).
pub struct ProviderCall<'a> {
    pub provider: &'static str,
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
    pub http: Option<&'a OutboundHttp>,
}

/// `callProvider(call)`: the JSON answer (`{}` for an empty body), or an
/// [`EngineError`] on a network failure or a non-2xx answer.
pub async fn call_provider(call: ProviderCall<'_>) -> Result<Value, EngineError> {
    let Some(http) = call.http else {
        return Err(engine_error(
            format!("{} is unreachable: network error", call.provider),
            "unreachable",
            true,
        ));
    };
    let mut request = HttpRequest::empty(call.method, call.url);
    for (name, value) in call.headers {
        request = request.header(name, value);
    }
    request.body = call.body.map(String::into_bytes);
    let response = match http.send(request).await {
        Ok(response) => response,
        Err(error) => {
            return Err(engine_error(
                format!("{} is unreachable: {error}", call.provider),
                "unreachable",
                true,
            ));
        }
    };
    let text = response.text();
    let body: Option<Value> = if text.is_empty() {
        None
    } else {
        serde_json::from_str(&text).ok()
    };
    if response.ok() {
        return Ok(body.unwrap_or_else(|| Value::Object(serde_json::Map::new())));
    }
    let suffix = body
        .as_ref()
        .and_then(error_text)
        .map(|d| format!(": {d}"))
        .unwrap_or_default();
    let status = response.status;
    let provider = call.provider;
    Err(match status {
        401 | 403 => engine_error(
            format!("{provider} rejected the credentials (HTTP {status}){suffix}"),
            "auth",
            false,
        ),
        429 => engine_error(
            format!("{provider} rate limit reached{suffix}"),
            "rate_limited",
            true,
        ),
        s if s >= 500 => engine_error(
            format!("{provider} failed (HTTP {status}){suffix}"),
            "unreachable",
            true,
        ),
        _ => invalid_request(format!(
            "{provider} refused the request (HTTP {status}){suffix}"
        )),
    })
}

/// `toBase64(value)`: UTF-8 bytes, standard alphabet with padding.
pub fn to_base64(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
}

/// A form field value (`string | number | boolean`), as `String(value)`.
pub enum FormValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

impl FormValue {
    fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Number(n) => crate::js::number_text(*n),
            Self::Bool(b) => b.to_string(),
        }
    }
}

/// `formEncode(fields)`: an `application/x-www-form-urlencoded` body
/// (`URLSearchParams`); `None` values are left out.
pub fn form_encode(fields: &[(String, Option<FormValue>)]) -> String {
    let mut out = form_urlencoded::Serializer::new(String::new());
    for (key, value) in fields {
        if let Some(value) = value {
            out.append_pair(key, &value.text());
        }
    }
    out.finish()
}

/// `encodeURIComponent(value)`.
pub fn encode_uri_component(value: &str) -> String {
    weldsuite_kit::cursor::encode_uri_component(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn forms_and_errors() {
        let body = form_encode(&[
            ("currency".into(), Some(FormValue::Text("usd".into()))),
            (
                "line_items[0][amount]".into(),
                Some(FormValue::Number(1250.0)),
            ),
            ("skip".into(), None),
            ("a b".into(), Some(FormValue::Text("x&y z".into()))),
        ]);
        assert_eq!(
            body,
            "currency=usd&line_items%5B0%5D%5Bamount%5D=1250&a+b=x%26y+z"
        );
        assert_eq!(to_base64("acc:key"), "YWNjOmtleQ==");
        assert_eq!(
            error_text(&json!({ "error": { "message": "Bad", "details": [{ "message": "zip" }] } }))
                .as_deref(),
            Some("Bad (zip)")
        );
        assert_eq!(
            error_text(&json!({ "message": "Nope" })).as_deref(),
            Some("Nope")
        );
    }
}
