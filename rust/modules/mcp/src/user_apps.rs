//! The agent tools WeldApps declare (`src/tools/user-apps.ts`): read from
//! `GET /v1/user-apps/agent-tools`, kept a minute per member, listed as
//! `<appCode>_<name>` (`_2`, `_3` on a collision), each acting on the app's
//! storage or on a `/v1` path its granted scopes allow.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use http::Method;
use http::request::Parts;
use serde_json::{Map, Value, json};

use crate::annotations::{annotations_for, tool_title};
use crate::call::{Answer, dispatch, dispatch_with_app, tool_error, tool_result};
use crate::js::{Order, as_text, encode_uri_component, string_of, stringify};
use crate::present::present;
use crate::{McpSession, McpState};

/// The scope that offers WeldApps' tools.
pub(crate) const SCOPE: &str = "user-apps:manage";
const CACHE_TTL: Duration = Duration::from_secs(60);

/// One agent tool as the API lists it (`userAppToolSchema`).
#[derive(Debug, Clone)]
pub(crate) struct AppTool {
    /// The name it is listed under.
    pub(crate) registered: String,
    /// The name the manifest gives it.
    name: String,
    app_code: String,
    app_name: String,
    description: String,
    parameters: Option<Map<String, Value>>,
    action: Map<String, Value>,
    granted_scopes: Vec<String>,
}

/// Each member's entries and when they expire.
type Cache = HashMap<String, (Instant, Vec<Value>)>;

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn non_empty(entry: &Map<String, Value>, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `userAppToolSchema.safeParse(entry)`.
fn parse_entry(entry: &Value) -> Option<AppTool> {
    let entry = entry.as_object()?;
    let action = entry.get("action")?.as_object()?;
    let kinds = [
        "storage.list",
        "storage.create",
        "storage.update",
        "storage.delete",
        "api.request",
    ];
    if !action
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| kinds.contains(&t))
    {
        return None;
    }
    for key in ["collection", "method", "path"] {
        if action.get(key).is_some_and(|v| !v.is_string()) {
            return None;
        }
    }
    let parameters = match entry.get("parameters") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map.clone()),
        Some(_) => return None,
    };
    let granted_scopes = match entry.get("grantedScopes") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| i.as_str().map(str::to_owned))
            .collect::<Option<_>>()?,
        Some(_) => return None,
    };
    let name = non_empty(entry, "name")?;
    Some(AppTool {
        registered: name.clone(),
        name,
        app_code: non_empty(entry, "appCode")?,
        app_name: non_empty(entry, "appName")?,
        description: entry.get("description")?.as_str()?.to_owned(),
        parameters,
        action: action.clone(),
        granted_scopes,
    })
}

/// `loadUserAppTools`: the entries, cached a minute per member.
async fn load(state: &McpState, session: &McpSession, parts: &Parts) -> Vec<AppTool> {
    let key = format!("{}:{}", session.workspace_id, session.user_id);
    let now = Instant::now();
    {
        let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        cache.retain(|_, (expires, _)| *expires > now);
        if let Some((_, entries)) = cache.get(&key) {
            return entries.iter().filter_map(parse_entry).collect();
        }
    }
    let answer = dispatch(
        state,
        session,
        parts,
        &Method::GET,
        "/v1/user-apps/agent-tools",
        None,
    )
    .await;
    if !answer.status.is_success() {
        return Vec::new();
    }
    let Ok(json) = serde_json::from_slice::<Value>(&answer.body) else {
        return Vec::new();
    };
    let Some(entries) = json.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let valid: Vec<Value> = entries
        .iter()
        .filter(|e| parse_entry(e).is_some())
        .cloned()
        .collect();
    CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key, (now + CACHE_TTL, valid.clone()));
    valid.iter().filter_map(parse_entry).collect()
}

/// The tools as registered: `<appCode>_<name>`, deduplicated against `taken`.
pub(crate) async fn registered(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    taken: &mut Vec<String>,
) -> Vec<AppTool> {
    let mut tools = load(state, session, parts).await;
    for tool in &mut tools {
        let base = format!("{}_{}", tool.app_code, tool.name);
        let mut name = base.clone();
        let mut suffix = 2;
        while taken.contains(&name) {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        taken.push(name.clone());
        tool.registered = name;
    }
    tools
}

/// The `properties` entries in their declared order is lost in JSON
/// objects here; the schema's properties follow the manifest's keys.
fn property_schema(prop: &Map<String, Value>) -> Value {
    let mut schema = match prop.get("type").and_then(Value::as_str) {
        Some("string") => json!({ "type": "string" }),
        Some("number") => json!({ "type": "number" }),
        Some("integer") => json!({ "type": "integer" }),
        Some("boolean") => json!({ "type": "boolean" }),
        Some("array") => json!({ "type": "array" }),
        Some("object") => json!({ "type": "object", "additionalProperties": {} }),
        _ => json!({}),
    };
    if let Some(description) = prop
        .get("description")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        && let Some(object) = schema.as_object_mut()
    {
        object.insert(
            "description".to_owned(),
            Value::String(description.to_owned()),
        );
    }
    schema
}

impl AppTool {
    fn required(&self) -> Vec<String> {
        self.parameters
            .as_ref()
            .and_then(|p| p.get("required"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn properties(&self) -> Option<&Map<String, Value>> {
        self.parameters.as_ref()?.get("properties")?.as_object()
    }

    /// `userAppToolMethod`: the HTTP method the action calls, for its
    /// annotations. An `api.request` passes its manifest method on as is.
    fn method(&self) -> Option<&str> {
        match self.action.get("type").and_then(Value::as_str)? {
            "api.request" => self.action.get("method").and_then(Value::as_str),
            "storage.list" => Some("GET"),
            "storage.create" => Some("POST"),
            "storage.update" => Some("PATCH"),
            "storage.delete" => Some("DELETE"),
            _ => None,
        }
    }

    /// The tool as `tools/list` answers it.
    pub(crate) fn definition(&self) -> Value {
        let required = self.required();
        let mut properties = Map::new();
        let mut listed_required = Vec::new();
        for (key, prop) in self.properties().into_iter().flatten() {
            let empty = Map::new();
            properties.insert(
                key.clone(),
                property_schema(prop.as_object().unwrap_or(&empty)),
            );
            if required.contains(key) {
                listed_required.push(Value::String(key.clone()));
            }
        }
        let mut input = json!({
            "type": "object",
            "properties": properties,
            "additionalProperties": false,
            "$schema": "http://json-schema.org/draft-07/schema#",
        });
        if !listed_required.is_empty()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("required".to_owned(), Value::Array(listed_required));
        }
        let title = format!("{}: {}", self.app_name, tool_title(&self.name));
        json!({
            "name": self.registered,
            "title": title,
            "description": format!("[{}] {}", self.app_name, self.description),
            "inputSchema": input,
            "annotations": annotations_for(self.method(), &title),
            "execution": { "taskSupport": "forbidden" },
        })
    }

    /// `z.object(userAppInputShape(parameters))`: the parsed arguments, or the
    /// SDK's error result.
    fn validate(&self, arguments: &Value) -> Result<Map<String, Value>, Value> {
        let required = self.required();
        let empty = Map::new();
        let arguments = arguments.as_object().unwrap_or(&empty);
        let mut out = Map::new();
        let mut problems = Vec::new();
        for (key, prop) in self.properties().into_iter().flatten() {
            let kind = prop.get("type").and_then(Value::as_str);
            match arguments.get(key) {
                None => {
                    if required.contains(key)
                        && kind.is_some_and(|k| k != "unknown")
                        && matches!(
                            kind,
                            Some("string" | "number" | "integer" | "boolean" | "array" | "object")
                        )
                    {
                        problems.push(format!("Required at {key}"));
                    }
                }
                Some(value) => {
                    let expected = match kind {
                        Some("string") => (!value.is_string()).then_some("string"),
                        Some("number" | "integer") => (!value.is_number()).then_some("number"),
                        Some("boolean") => (!value.is_boolean()).then_some("boolean"),
                        Some("array") => (!value.is_array()).then_some("array"),
                        Some("object") => (!value.is_object()).then_some("object"),
                        _ => None,
                    };
                    if let Some(expected) = expected {
                        problems.push(format!(
                            "Expected {expected}, received {} at {key}",
                            js_type(value)
                        ));
                    } else if kind == Some("integer")
                        && value.as_f64().is_some_and(|n| n.fract() != 0.0)
                    {
                        problems.push(format!("Expected integer, received float at {key}"));
                    } else {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        if problems.is_empty() {
            return Ok(out);
        }
        Err(tool_error(&format!(
            "MCP error -32602: Input validation error: Invalid arguments for tool {}: {}",
            self.registered,
            problems.join("\n")
        )))
    }
}

fn js_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `appScopesAllow`.
fn app_scopes_allow(granted: &[String], required: &str) -> bool {
    if granted.iter().any(|g| g == "*" || g == required) {
        return true;
    }
    let parts: Vec<&str> = required.split(':').collect();
    (1..parts.len())
        .rev()
        .any(|i| granted.contains(&format!("{}:*", parts[..i].join(":"))))
}

/// `tools/call` for a WeldApps tool, or `None` when `name` is not one.
pub(crate) async fn call(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    name: &str,
    arguments: &Value,
) -> Option<Value> {
    let mut taken: Vec<String> = Vec::new();
    let tool = registered(state, session, parts, &mut taken)
        .await
        .into_iter()
        .find(|tool| tool.registered == name)?;
    let args = match tool.validate(arguments) {
        Ok(args) => args,
        Err(error) => return Some(error),
    };
    Some(execute(state, session, parts, &tool, &args).await)
}

fn records_path(collection: &str, id: Option<&str>) -> String {
    let base = format!(
        "/v1/app-storage/collections/{}/records",
        encode_uri_component(collection)
    );
    match id {
        Some(id) => format!("{base}/{}", encode_uri_component(id)),
        None => base,
    }
}

/// `shapeRequest`: method, path, query and body, or the refusal.
/// Method, path, query and body.
type Shaped = (Method, String, Map<String, Value>, Option<Value>);

#[allow(clippy::too_many_lines)] // one arm per action, as user-apps.ts shapes them
fn shape(tool: &AppTool, args: &Map<String, Value>) -> Result<Shaped, String> {
    let kind = tool
        .action
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "api.request" {
        let raw = tool.action.get("method").and_then(Value::as_str);
        let method = raw.map(str::to_uppercase);
        let method = match method.as_deref() {
            Some(m @ ("GET" | "POST" | "PATCH" | "PUT" | "DELETE")) => {
                Method::from_bytes(m.as_bytes()).unwrap_or(Method::GET)
            }
            _ => {
                return Err(format!(
                    "Unsupported API request method: {}",
                    raw.unwrap_or("(none)")
                ));
            }
        };
        let path = tool
            .action
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let plain = path.strip_prefix("/v1/").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
        });
        if !plain || path.contains("..") || path.contains("//") {
            return Err("API request paths must be a plain /v1/... path".to_owned());
        }
        if !path.starts_with("/v1/app-storage/") {
            let resource = path.split('/').nth(2).unwrap_or_default();
            let action = match method.as_str() {
                "GET" => "read",
                "POST" => "create",
                "DELETE" => "delete",
                _ => "update",
            };
            let required = format!("{resource}:{action}");
            if !app_scopes_allow(&tool.granted_scopes, &required) {
                return Err(format!("The app's granted scopes do not allow {required}"));
            }
        }
        if method == Method::GET || method == Method::DELETE {
            return Ok((method, path, args.clone(), None));
        }
        return Ok((method, path, Map::new(), Some(Value::Object(args.clone()))));
    }
    let Some(collection) = tool
        .action
        .get("collection")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    else {
        return Err("Tool action is missing a storage collection".to_owned());
    };
    match kind {
        "storage.list" => {
            let mut query = Map::new();
            if let Some(limit) = args.get("limit") {
                query.insert("limit".to_owned(), limit.clone());
            }
            if let Some(filter) = args.get("filter") {
                let text = match filter {
                    Value::String(text) => text.clone(),
                    other => stringify(other, Order::Jsonb),
                };
                query.insert("filter".to_owned(), Value::String(text));
            }
            Ok((Method::GET, records_path(collection, None), query, None))
        }
        "storage.create" => Ok((
            Method::POST,
            records_path(collection, None),
            Map::new(),
            Some(json!({ "data": args })),
        )),
        _ => {
            let Some(id) = args
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return Err("Missing required parameter: id".to_owned());
            };
            if kind == "storage.update" {
                let data = match args.get("data") {
                    Some(data) if !data.is_null() => data.clone(),
                    _ => Value::Object(
                        args.iter()
                            .filter(|(k, _)| k.as_str() != "id")
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect(),
                    ),
                };
                return Ok((
                    Method::PATCH,
                    records_path(collection, Some(id)),
                    Map::new(),
                    Some(json!({ "data": data })),
                ));
            }
            Ok((
                Method::DELETE,
                records_path(collection, Some(id)),
                Map::new(),
                None,
            ))
        }
    }
}

/// `executeUserAppTool`.
async fn execute(
    state: &McpState,
    session: &McpSession,
    parts: &Parts,
    tool: &AppTool,
    args: &Map<String, Value>,
) -> Value {
    let (method, path, query, body) = match shape(tool, args) {
        Ok(shaped) => shaped,
        Err(message) => return tool_error(&message),
    };
    let search = {
        let mut serializer = form_urlencoded::Serializer::new(String::new());
        for (key, value) in &query {
            match value {
                Value::Null => {}
                Value::Array(items) => {
                    for item in items {
                        serializer.append_pair(key, &string_of(item));
                    }
                }
                other => {
                    serializer.append_pair(key, &as_text(other));
                }
            }
        }
        serializer.finish()
    };
    let target = if search.is_empty() {
        path
    } else {
        format!("{path}?{search}")
    };
    let answer: Answer = dispatch_with_app(
        state,
        session,
        parts,
        &method,
        &target,
        body.map(|b| stringify(&b, Order::Jsonb)),
        Some(&tool.app_code),
    )
    .await;
    if answer.status == http::StatusCode::NO_CONTENT {
        return tool_result(&present(&json!({ "data": { "success": true } })));
    }
    let text = String::from_utf8_lossy(&answer.body);
    let json: Value = if text.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_str(&text) {
            Ok(json) => json,
            Err(_) => {
                return tool_error(&format!(
                    "Unexpected non-JSON response ({}) from the WeldSuite API",
                    answer.status.as_u16()
                ));
            }
        }
    };
    if !answer.status.is_success() {
        let error = json.get("error").filter(|e| e.is_object());
        let message = error
            .and_then(|e| e.get("message"))
            .filter(|m| !m.is_null())
            .map_or_else(
                || format!("Request failed with status {}", answer.status.as_u16()),
                string_of,
            );
        let code = error
            .and_then(|e| e.get("code"))
            .filter(|c| crate::present::truthy_value(c));
        return tool_error(&match code {
            Some(code) => format!("{}: {message}", string_of(code)),
            None => message,
        });
    }
    tool_result(&present(&json))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::parse_entry;

    /// One tool of the app `Stock` per action, as the API lists it.
    fn definition(name: &str, action: Value) -> Value {
        let mut entry = json!({
            "appCode": "stock",
            "appName": "Stock",
            "name": name,
            "description": name,
            "parameters": null,
        });
        entry["action"] = action;
        parse_entry(&entry).expect(name).definition()
    }

    #[test]
    fn derives_hints_from_the_call_they_make() {
        let list = definition(
            "list_items",
            json!({ "type": "storage.list", "collection": "items" }),
        );
        assert_eq!(list["title"], "Stock: List items");
        assert_eq!(
            list["annotations"],
            json!({ "title": "Stock: List items", "readOnlyHint": true, "openWorldHint": false })
        );
        for (name, kind) in [
            ("add_item", "storage.create"),
            ("edit_item", "storage.update"),
        ] {
            let hints =
                &definition(name, json!({ "type": kind, "collection": "items" }))["annotations"];
            assert_eq!(hints["readOnlyHint"], false, "{name}");
            assert_eq!(hints["destructiveHint"], false, "{name}");
        }
        let drop = definition(
            "drop_item",
            json!({ "type": "storage.delete", "collection": "items" }),
        );
        assert_eq!(drop["annotations"]["destructiveHint"], true);
        let read = definition(
            "read_contacts",
            json!({ "type": "api.request", "method": "get", "path": "/v1/contacts" }),
        );
        assert_eq!(read["annotations"]["readOnlyHint"], true);
        // An unknown method is refused at call time; until then assume the worst.
        let odd = definition(
            "odd_call",
            json!({ "type": "api.request", "method": "TRACE", "path": "/v1/contacts" }),
        );
        assert_eq!(odd["annotations"]["readOnlyHint"], false);
        assert_eq!(odd["annotations"]["destructiveHint"], true);
    }

    #[test]
    fn titles_the_manifest_name_not_the_listed_one() {
        let mut tool = parse_entry(&json!({
            "appCode": "stock",
            "appName": "Stock",
            "name": "list_items",
            "description": "",
            "action": { "type": "storage.list", "collection": "items" },
        }))
        .expect("tool");
        tool.registered = "stock_list_items_2".to_owned();
        let definition = tool.definition();
        assert_eq!(definition["name"], "stock_list_items_2");
        assert_eq!(definition["title"], "Stock: List items");
        assert_eq!(definition["annotations"]["title"], "Stock: List items");
    }
}
