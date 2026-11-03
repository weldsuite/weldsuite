//! The transport: `serveMcpRequest` (`lib/mcp-transport.ts`) over the SDK's
//! `WebStandardStreamableHTTPServerTransport`, stateless and answering JSON.
//! Its checks run in the SDK's order; the body is parsed first, as the
//! worker does (`request.json()`), so malformed JSON is the worker's 500.

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::{McpSession, McpState, rpc};

/// The SDK's `MAX_BATCH_SIZE`.
const MAX_BATCH_SIZE: usize = 100;
/// The SDK's `SUPPORTED_PROTOCOL_VERSIONS`.
pub(crate) const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
/// The largest body read (the SDK's default limit is 4 MB).
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// A JSON-RPC error answer outside any request (`createJsonErrorResponse`).
pub(crate) fn json_error(status: StatusCode, code: i64, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null })
            .to_string(),
    )
        .into_response()
}

/// The worker's `onError`: anything thrown while serving `/mcp`.
pub(crate) fn internal_error() -> Response {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        -32603,
        "Internal server error",
    )
}

/// `/mcp`, every method.
pub async fn serve(State(state): State<McpState>, request: Request) -> Response {
    let Some(session) = request.extensions().get::<McpSession>().cloned() else {
        // The authentication layer always sets one.
        tracing::error!("mcp: /mcp without a session");
        return internal_error();
    };
    let (parts, body) = request.into_parts();
    match parts.method {
        Method::POST => post(&state, &session, parts, body).await,
        Method::GET => {
            let accepts = header_text(&parts.headers, header::ACCEPT)
                .is_some_and(|accept| accept.contains("text/event-stream"));
            if !accepts {
                return json_error(
                    StatusCode::NOT_ACCEPTABLE,
                    -32000,
                    "Not Acceptable: Client must accept text/event-stream",
                );
            }
            if let Some(refused) = protocol_version_error(&parts.headers) {
                return refused;
            }
            // The standalone stream closes with the request's transport.
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "text/event-stream"),
                    (header::CACHE_CONTROL, "no-cache, no-transform"),
                ],
                Body::empty(),
            )
                .into_response()
        }
        Method::DELETE => {
            protocol_version_error(&parts.headers).unwrap_or_else(|| StatusCode::OK.into_response())
        }
        _ => {
            let mut response = json_error(
                StatusCode::METHOD_NOT_ALLOWED,
                -32000,
                "Method not allowed.",
            );
            response
                .headers_mut()
                .insert(header::ALLOW, HeaderValue::from_static("GET, POST, DELETE"));
            response
        }
    }
}

async fn post(
    state: &McpState,
    session: &McpSession,
    parts: http::request::Parts,
    body: Body,
) -> Response {
    let Ok(bytes) = to_bytes(body, MAX_BODY_BYTES).await else {
        return internal_error();
    };
    let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
        return internal_error();
    };
    let accept = header_text(&parts.headers, header::ACCEPT).unwrap_or_default();
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return json_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    if !is_json_content_type(header_text(&parts.headers, header::CONTENT_TYPE)) {
        return json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    let messages = match raw {
        Value::Array(items) => {
            if items.len() > MAX_BATCH_SIZE {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    -32600,
                    &format!("Invalid Request: Batch must not exceed {MAX_BATCH_SIZE} messages"),
                );
            }
            items
        }
        single => vec![single],
    };
    if !messages.iter().all(is_jsonrpc_message) {
        return json_error(
            StatusCode::BAD_REQUEST,
            -32700,
            "Parse error: Invalid JSON-RPC message",
        );
    }
    let initializing = messages.iter().any(is_initialize_request);
    if initializing && messages.len() > 1 {
        return json_error(
            StatusCode::BAD_REQUEST,
            -32600,
            "Invalid Request: Only one initialization request is allowed",
        );
    }
    if !initializing && let Some(refused) = protocol_version_error(&parts.headers) {
        return refused;
    }
    if !messages.iter().any(is_request) {
        return StatusCode::ACCEPTED.into_response();
    }
    let mut answers = Vec::new();
    for message in &messages {
        if is_request(message) {
            answers.push(rpc::handle(state, session, &parts, message).await);
        }
    }
    let body = if answers.len() == 1 {
        answers.pop().unwrap_or(Value::Null)
    } else {
        Value::Array(answers)
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// `isJsonContentType`: the media type, parameters aside, is JSON.
fn is_json_content_type(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
    })
}

/// `validateProtocolVersion`: a header naming a version the SDK does not
/// know is a 400.
fn protocol_version_error(headers: &HeaderMap) -> Option<Response> {
    let version = headers.get("mcp-protocol-version")?;
    let text = version.to_str().unwrap_or_default();
    if SUPPORTED_PROTOCOL_VERSIONS.contains(&text) {
        return None;
    }
    Some(json_error(
        StatusCode::BAD_REQUEST,
        -32000,
        &format!(
            "Bad Request: Unsupported protocol version: {text} (supported versions: {})",
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        ),
    ))
}

/// A request id: a string or an integer.
fn is_request_id(value: &Value) -> bool {
    value.is_string() || value.as_i64().is_some() || value.as_u64().is_some()
}

/// Only `allowed` keys, `jsonrpc` is `"2.0"` (the SDK's strict schemas).
fn strict_object<'a>(
    message: &'a Value,
    allowed: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = message.as_object()?;
    if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
        return None;
    }
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(object)
}

fn params_ok(object: &serde_json::Map<String, Value>) -> bool {
    match object.get("params") {
        None => true,
        Some(params) => params.is_object(),
    }
}

/// `isJSONRPCRequest`.
pub(crate) fn is_request(message: &Value) -> bool {
    strict_object(message, &["jsonrpc", "id", "method", "params"]).is_some_and(|object| {
        object.get("id").is_some_and(is_request_id)
            && object.get("method").is_some_and(Value::is_string)
            && params_ok(object)
    })
}

fn is_notification(message: &Value) -> bool {
    strict_object(message, &["jsonrpc", "method", "params"]).is_some_and(|object| {
        object.get("method").is_some_and(Value::is_string) && params_ok(object)
    })
}

fn is_response(message: &Value) -> bool {
    strict_object(message, &["jsonrpc", "id", "result"]).is_some_and(|object| {
        object.get("id").is_some_and(is_request_id)
            && object.get("result").is_some_and(Value::is_object)
    })
}

fn is_error_response(message: &Value) -> bool {
    strict_object(message, &["jsonrpc", "id", "error"]).is_some_and(|object| {
        object.get("id").is_none_or(is_request_id)
            && object
                .get("error")
                .and_then(Value::as_object)
                .is_some_and(|error| {
                    error
                        .get("code")
                        .is_some_and(|code| code.as_i64().is_some())
                        && error.get("message").is_some_and(Value::is_string)
                })
    })
}

/// `JSONRPCMessageSchema`.
fn is_jsonrpc_message(message: &Value) -> bool {
    is_request(message)
        || is_notification(message)
        || is_response(message)
        || is_error_response(message)
}

fn is_initialize_request(message: &Value) -> bool {
    is_request(message) && message.get("method").and_then(Value::as_str) == Some("initialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_follow_the_sdk_schemas() {
        assert!(is_request(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })
        ));
        assert!(!is_request(
            &json!({ "jsonrpc": "2.0", "id": 1.5, "method": "ping" })
        ));
        assert!(!is_jsonrpc_message(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "x": 1 })
        ));
        assert!(is_jsonrpc_message(
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
        ));
        assert!(!is_jsonrpc_message(
            &json!({ "jsonrpc": "1.0", "method": "ping" })
        ));
        assert!(is_json_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(!is_json_content_type(Some("text/json")));
    }
}
