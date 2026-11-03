//! `tools/call` (`lib/proxy.ts` behind the SDK's argument check): the
//! arguments validated with the tool's Zod shape, the request built from the
//! tool's method and path, the `/v1` API run in process with the member as its
//! caller, a name looked up after a 404, and the answer presented.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::OriginalUri;
use axum::extract::{MatchedPath, Request};
use axum::response::IntoResponse;
use http::request::Parts;
use http::{Method, StatusCode, header};
use serde_json::{Map, Value, json};
use tower::ServiceExt;
use weldsuite_db::Tenant;
use weldsuite_external_api::zod::{Z, parse_issues};
use weldsuite_external_api::{ApiSession, KeyType, MemberScopes, insert_session};

use crate::catalog::{Tool, catalog};
use crate::js::{Order, as_text, encode_uri_component, string_of, stringify};
use crate::permissions::{MemberRule, can_use_scope};
use crate::present::{label_for, present};
use crate::rpc::grants_of;
use crate::{McpSession, McpState, args_gen, user_apps};

/// How many candidates a name lookup reads, and offers back when ambiguous.
const NAME_RESOLUTION_LIMIT: usize = 5;
/// Fields a person reads off a screen (`REFERENCE_FIELDS`).
const REFERENCE_FIELDS: [&str; 5] = ["number", "reference", "code", "sku", "slug"];
/// The longest `error.details` kept on a tool error.
const ERROR_DETAILS_MAX_CHARS: usize = 600;
/// The largest internal answer read.
const MAX_ANSWER_BYTES: usize = 64 * 1024 * 1024;

/// A `CallToolResult` with text.
pub(crate) fn tool_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// `toolError(message)`.
pub(crate) fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

/// `tools/call`.
pub(crate) async fn call_tool(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    params: &Value,
) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let empty = Value::Object(Map::new());
    let arguments = params.get("arguments").unwrap_or(&empty);
    let grants = grants_of(session);
    if let Some(tool) = catalog().tool(name)
        && can_use_scope(&grants, &tool.scope)
        && state.serves(tool).await
    {
        let Some(shape) = args_gen::args(name) else {
            return tool_error(&format!("MCP error -32602: Tool {name} not found"));
        };
        let args = match validate(name, shape, arguments) {
            Ok(args) => args,
            Err(error) => return error,
        };
        return execute(state, session, parts, tool, &args).await;
    }
    if can_use_scope(&grants, user_apps::SCOPE)
        && let Some(result) = user_apps::call(state, session, parts, name, arguments).await
    {
        return result;
    }
    tool_error(&format!("MCP error -32602: Tool {name} not found"))
}

/// The SDK's `validateToolInput`: the parsed arguments, or the error result
/// worded from Zod's issues (`message at path`, one per line).
pub(crate) fn validate(
    name: &str,
    shape: &Z,
    arguments: &Value,
) -> Result<Map<String, Value>, Value> {
    match parse_issues(shape, arguments) {
        Ok(parsed) => Ok(parsed.body),
        Err(issues) => {
            let lines: Vec<String> = issues
                .iter()
                .map(|issue| {
                    let message = issue.get("message").map(string_of).unwrap_or_default();
                    match issue.get("path").and_then(Value::as_array) {
                        Some(path) if !path.is_empty() => {
                            format!("{message} at {}", dot_path(path))
                        }
                        _ => message,
                    }
                })
                .collect();
            Err(tool_error(&format!(
                "MCP error -32602: Input validation error: Invalid arguments for tool {name}: {}",
                lines.join("\n")
            )))
        }
    }
}

/// `getDotPath`: `a.b[0]`.
fn dot_path(path: &[Value]) -> String {
    let mut out = String::new();
    for (index, segment) in path.iter().enumerate() {
        match segment {
            Value::Number(number) if index > 0 => out.push_str(&format!("[{number}]")),
            other if index == 0 => out.push_str(&string_of(other)),
            other => {
                out.push('.');
                out.push_str(&string_of(other));
            }
        }
    }
    out
}

/// The member as the `/v1` routes' caller (`toApiSession`).
fn api_session(session: &McpSession) -> ApiSession {
    ApiSession {
        key_id: session.token_id.clone(),
        key_type: KeyType::Personal,
        workspace_id: session.workspace_id.clone(),
        user_id: Some(session.user_id.clone()),
        scopes: session.permissions.clone(),
        tier: session.tier.clone(),
        clerk_org_id: Some(session.clerk_org_id.clone()),
        licensed_apps: session.licensed_apps.clone(),
        read_only: session.read_only,
        read_only_reason: session.read_only_reason.clone(),
        app_id: None,
        app_code: None,
        install_id: None,
        member: Some(MemberScopes(Arc::new(MemberRule(grants_of(session))))),
    }
}

/// An internal answer: status and body.
pub(crate) struct Answer {
    pub(crate) status: StatusCode,
    pub(crate) body: Vec<u8>,
}

/// `apiApp.fetch(request)`: the worker's `/v1` copy, in process. A path the
/// copy does not mount answers Hono's plain 404 once the licence gate let it
/// through; a thrown error is Hono's plain 500.
pub(crate) async fn dispatch(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    method: &Method,
    target: &str,
    body: Option<String>,
) -> Answer {
    dispatch_with_app(state, session, parts, method, target, body, None).await
}

/// [`dispatch`] for a WeldApps tool: `X-App-Code` names the app.
pub(crate) async fn dispatch_with_app(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    method: &Method,
    target: &str,
    body: Option<String>,
    app_code: Option<&str>,
) -> Answer {
    let Some(tenant) = parts.extensions.get::<Tenant>().cloned() else {
        tracing::error!("mcp: a tool call without the tenant database");
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    };
    let mut extensions = parts.extensions.clone();
    extensions.remove::<OriginalUri>();
    extensions.remove::<MatchedPath>();
    insert_session(&mut extensions, api_session(session), tenant);
    let path = target.split('?').next().unwrap_or_default();
    let router: &Router = if catalog().api_route(method, path) {
        &state.internal
    } else {
        &state.unmounted
    };
    let mut builder = Request::builder()
        .method(method.clone())
        .uri(target)
        .header(header::ACCEPT, "application/json");
    if let Some(code) = app_code {
        builder = builder.header("x-app-code", code);
    }
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let Ok(mut request) = builder.body(body.map_or_else(Body::empty, Body::from)) else {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    };
    *request.extensions_mut() = extensions;
    let response = match router.clone().oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let status = response.status();
    let body = to_bytes(response.into_body(), MAX_ANSWER_BYTES)
        .await
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    if status == StatusCode::INTERNAL_SERVER_ERROR && is_thrown_error(&body) {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
    }
    Answer { status, body }
}

/// external-api's answer to an unexpected error, which the worker's copy
/// answers as Hono's plain text.
fn is_thrown_error(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body).is_ok_and(|value| {
        value
            == json!({ "error": { "code": "INTERNAL_ERROR", "message": "An internal server error occurred" } })
    })
}

fn plain(status: StatusCode, text: &str) -> Answer {
    Answer {
        status,
        body: text.as_bytes().to_vec(),
    }
}

/// Hono's plain 404 for a path the worker's copy does not mount.
pub(crate) async fn hono_not_found() -> axum::response::Response {
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

/// `executeTool`.
async fn execute(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    tool: &Tool,
    args: &Map<String, Value>,
) -> Value {
    let mut path = tool.path.clone();
    let mut consumed: Vec<&str> = Vec::new();
    for (placeholder, field) in &tool.path_params {
        let value = args.get(field);
        let missing = match value {
            None | Some(Value::Null) => true,
            Some(Value::String(text)) => text.is_empty(),
            Some(_) => false,
        };
        if missing {
            return tool_error(&format!("Missing required parameter: {field}"));
        }
        let text = as_text(value.unwrap_or(&Value::Null));
        path = path.replacen(&format!(":{placeholder}"), &encode_uri_component(&text), 1);
        consumed.push(field);
    }
    let rest: Map<String, Value> = args
        .iter()
        .filter(|(key, _)| !consumed.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let has_body = tool.method != Method::GET && tool.method != Method::DELETE;
    let (search, body) = if has_body {
        (
            String::new(),
            Some(stringify(&Value::Object(rest), Order::Jsonb)),
        )
    } else {
        (query_string(&rest), None)
    };
    let target = |path: &str| {
        if search.is_empty() {
            path.to_owned()
        } else {
            format!("{path}?{search}")
        }
    };
    let mut answer = dispatch(
        state,
        session,
        parts,
        &tool.method,
        &target(&path),
        body.clone(),
    )
    .await;
    if answer.status == StatusCode::NOT_FOUND && tool.path_params.len() == 1 && !tool.exact_id {
        let (placeholder, field) = &tool.path_params[0];
        let supplied = args.get(field).map(string_of).unwrap_or_default();
        match resolve_id_by_name(state, session, parts, tool, &supplied).await {
            Some(Resolved::Id(id)) => {
                let retry =
                    tool.path
                        .replacen(&format!(":{placeholder}"), &encode_uri_component(&id), 1);
                answer = dispatch(state, session, parts, &tool.method, &target(&retry), body).await;
            }
            Some(Resolved::Ambiguous(labels)) => {
                return tool_error(&format!(
                    "\"{supplied}\" matches several records: {}. Ask which one is meant, then retry with a more specific name.",
                    labels.join("; ")
                ));
            }
            None => {}
        }
    }
    shape_response(&answer)
}

/// The remaining inputs as a query string (`URLSearchParams`): an array
/// repeats its key.
fn query_string(rest: &Map<String, Value>) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in rest {
        match value {
            Value::Array(items) => {
                for item in items {
                    serializer.append_pair(key, &string_of(item));
                }
            }
            other => {
                serializer.append_pair(key, &string_of(other));
            }
        }
    }
    serializer.finish()
}

enum Resolved {
    Id(String),
    Ambiguous(Vec<String>),
}

/// "#734" → "734", "TASK-734" → "734".
fn reference_core(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let lower = lower.strip_prefix('#').unwrap_or(&lower).to_owned();
    let letters = lower.chars().take_while(char::is_ascii_lowercase).count();
    if letters > 0
        && lower[letters..].starts_with('-')
        && lower[letters + 1..].starts_with(|c: char| c.is_ascii_digit())
    {
        return lower[letters + 1..].to_owned();
    }
    lower
}

fn matches_reference(row: &Map<String, Value>, wanted: &str) -> bool {
    REFERENCE_FIELDS.iter().any(|field| match row.get(*field) {
        Some(value @ (Value::String(_) | Value::Number(_))) => {
            let reference = string_of(value).trim().to_lowercase();
            reference == wanted || reference_core(&reference) == reference_core(wanted)
        }
        _ => false,
    })
}

/// `resolveIdByName`: the record a name means, after a 404.
async fn resolve_id_by_name(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    tool: &Tool,
    name: &str,
) -> Option<Resolved> {
    let collection = tool.path.split("/:").next().unwrap_or_default();
    if collection.is_empty() || collection == tool.path {
        return None;
    }
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("search", name)
        .append_pair("limit", &NAME_RESOLUTION_LIMIT.to_string())
        .finish();
    let answer = dispatch(
        state,
        session,
        parts,
        &Method::GET,
        &format!("{collection}?{query}"),
        None,
    )
    .await;
    if !answer.status.is_success() {
        return None;
    }
    let json: Value = serde_json::from_slice(&answer.body).ok()?;
    let rows: Vec<&Map<String, Value>> = json
        .get("data")?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .collect();
    if rows.is_empty() {
        return None;
    }
    let wanted = name.trim().to_lowercase();
    let by_reference: Vec<&Map<String, Value>> = rows
        .iter()
        .copied()
        .filter(|row| matches_reference(row, &wanted))
        .collect();
    let exact: Vec<&Map<String, Value>> = if by_reference.is_empty() {
        rows.iter()
            .copied()
            .filter(|row| label_for(row).is_some_and(|label| label.trim().to_lowercase() == wanted))
            .collect()
    } else {
        by_reference
    };
    let shortlist = if exact.is_empty() { rows } else { exact };
    if shortlist.len() == 1 {
        return shortlist[0]
            .get("id")
            .and_then(Value::as_str)
            .map(|id| Resolved::Id(id.to_owned()));
    }
    Some(Resolved::Ambiguous(
        shortlist.iter().filter_map(|row| label_for(row)).collect(),
    ))
}

/// `errorDetails`.
fn error_details(details: Option<&Value>) -> String {
    let Some(details) = details.filter(|details| !details.is_null()) else {
        return String::new();
    };
    let text = stringify(details, Order::Jsonb);
    if text.is_empty() || text == "{}" || text == "[]" {
        return String::new();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let shown = if units.len() > ERROR_DETAILS_MAX_CHARS {
        format!(
            "{}…",
            String::from_utf16_lossy(&units[..ERROR_DETAILS_MAX_CHARS])
        )
    } else {
        text
    };
    format!(" (details: {shown})")
}

/// `shapeResponse`: an internal answer as a tool result.
pub(crate) fn shape_response(answer: &Answer) -> Value {
    if answer.status == StatusCode::NO_CONTENT {
        return tool_result(present(&json!({ "data": { "success": true } })));
    }
    let text = String::from_utf8_lossy(&answer.body);
    let json: Value = if text.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_str(&text) {
            Ok(json) => json,
            Err(_) => {
                return tool_error(&format!(
                    "Unexpected non-JSON response ({})",
                    answer.status.as_u16()
                ));
            }
        }
    };
    if !answer.status.is_success() {
        let error = json.get("error").filter(|error| error.is_object());
        let message = error
            .and_then(|error| error.get("message"))
            .filter(|message| !message.is_null())
            .map_or_else(
                || format!("Request failed with status {}", answer.status.as_u16()),
                string_of,
            );
        let message = message + &error_details(error.and_then(|error| error.get("details")));
        let code = error
            .and_then(|error| error.get("code"))
            .filter(|code| crate::present::truthy_value(code));
        return tool_error(&match code {
            Some(code) => format!("{}: {message}", string_of(code)),
            None => message,
        });
    }
    tool_result(present(&json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_lose_their_prefix() {
        assert_eq!(reference_core("TASK-734"), "734");
        assert_eq!(reference_core("#12"), "12");
        assert_eq!(reference_core("abc"), "abc");
        assert_eq!(dot_path(&[json!("a"), json!(0), json!("b")]), "a[0].b");
    }
}
