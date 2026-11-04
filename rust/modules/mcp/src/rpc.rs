//! The JSON-RPC methods the worker's `McpServer` answers: the SDK's
//! `Server` (`initialize`, `ping`), and what `createMcpServer` registers
//! (`tools/list`, `tools/call`, `resources/list`, `resources/templates/list`,
//! `resources/read`). Anything else is `-32601 Method not found`.

use http::request::Parts;
use serde_json::{Map, Value, json};

use crate::catalog::catalog;
use crate::permissions::{Grants, can_use_scope};
use crate::transport::SUPPORTED_PROTOCOL_VERSIONS;
use crate::{McpSession, McpState, call, user_apps};

/// The URI of the one resource, `workspace-info`.
const WORKSPACE_INFO_URI: &str = "weldsuite://workspace/info";

/// A thrown `McpError`: its code, and the message as the SDK words it.
fn mcp_error(code: i64, message: &str) -> (i64, String) {
    (code, format!("MCP error {code}: {message}"))
}

/// Answer one request message.
pub(crate) async fn handle(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    message: &Value,
) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let empty = Value::Object(Map::new());
    let params = message.get("params").unwrap_or(&empty);
    let outcome = match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list(state, session, parts).await),
        "tools/call" => Ok(call::call_tool(state, session, parts, params).await),
        "resources/list" => Ok(catalog().resources.clone()),
        "resources/templates/list" => Ok(catalog().resource_templates.clone()),
        "resources/read" => resources_read(session, params),
        _ => Err((-32601, "Method not found".to_owned())),
    };
    match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    }
}

/// `_oninitialize`: the client's version when the SDK supports it, else the
/// latest.
fn initialize(params: &Value) -> Value {
    let mut result = catalog().initialize.clone();
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|version| SUPPORTED_PROTOCOL_VERSIONS.contains(version))
        .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0]);
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "protocolVersion".to_owned(),
            Value::String(version.to_owned()),
        );
    }
    result
}

/// The session's grants and member denies.
pub(crate) fn grants_of(session: &McpSession) -> Grants {
    Grants {
        permissions: session.permissions.clone(),
        denies: session.permission_denies.clone(),
    }
}

/// `tools/list`: the house tools the member's role could use, in
/// registration order, then the WeldApps agent tools.
async fn tools_list(state: &McpState, session: &McpSession, parts: &Parts) -> Value {
    let grants = grants_of(session);
    let mut tools: Vec<Value> = Vec::new();
    for tool in &catalog().tools {
        if can_use_scope(&grants, &tool.scope) && state.serves(tool).await {
            tools.push(tool.definition.clone());
        }
    }
    let mut taken: Vec<String> = catalog()
        .tools
        .iter()
        .filter(|tool| can_use_scope(&grants, &tool.scope))
        .map(|tool| tool.name.clone())
        .collect();
    if can_use_scope(&grants, user_apps::SCOPE) {
        for tool in user_apps::registered(state, session, parts, &mut taken).await {
            tools.push(tool.definition());
        }
    }
    json!({ "tools": tools })
}

/// `resources/read`: the workspace-info resource.
fn resources_read(session: &McpSession, params: &Value) -> Result<Value, (i64, String)> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if uri != WORKSPACE_INFO_URI {
        return Err(mcp_error(-32602, &format!("Resource {uri} not found")));
    }
    // `JSON.stringify(info, null, 2)`, in the object's key order.
    let field = |value: &str| Value::String(value.to_owned()).to_string();
    let text = format!(
        "{{\n  \"workspaceId\": {},\n  \"workspaceName\": {},\n  \"tier\": {},\n  \"userId\": {},\n  \"role\": {}\n}}",
        field(&session.workspace_id),
        field(&session.workspace_name),
        field(&session.tier),
        field(&session.user_id),
        field(&session.role),
    );
    Ok(json!({
        "contents": [{ "uri": WORKSPACE_INFO_URI, "mimeType": "application/json", "text": text }]
    }))
}
