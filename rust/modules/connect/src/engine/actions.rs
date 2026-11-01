//! The engine's action handlers (`engine/actions/*`): what each step type
//! does. An action answers its result, or an [`ActionError`] the engine
//! retries (or not, when it is non-retryable) as the Workflow did.

use std::sync::Arc;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{HttpRequest, OutboundHttp, RealtimeMessage, Room};

use super::steps::RunInfo;
use super::{EngineDeps, engine_id, now_ms, now_text};
use crate::js::{as_text, js_number, js_string, truthy};

mod records;

/// A failed action: its message, its error class (`Error`,
/// `NonRetryableStepError`, …), the details the step row keeps, and whether
/// a retry could help.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionError {
    pub(crate) message: String,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<Value>,
    #[serde(default)]
    pub(crate) non_retryable: bool,
}

impl ActionError {
    /// `new Error(message)`: retried while attempts are left.
    pub(crate) fn plain(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            name: "Error".into(),
            details: None,
            non_retryable: false,
        }
    }

    /// `new NonRetryableStepError(message)`.
    pub(crate) fn fatal(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            name: "NonRetryableStepError".into(),
            details: None,
            non_retryable: true,
        }
    }

    pub(crate) fn fatal_with(message: &str, details: Value) -> Self {
        Self {
            details: Some(details),
            ..Self::fatal(message)
        }
    }

    /// An error of another class (`IntegrationNotFoundError`, …), retried.
    fn named(name: &str, message: &str) -> Self {
        Self {
            name: name.to_owned(),
            ..Self::plain(message)
        }
    }

    fn database(error: &sqlx::Error) -> Self {
        Self::plain(&error.to_string())
    }
}

/// `ActionContext`.
#[allow(dead_code)] // `stepId` is read by the CRM actions' callers in workflow-worker only
pub(crate) struct ActionCtx<'a> {
    pub(crate) deps: &'a EngineDeps,
    pub(crate) db: &'a PgPool,
    pub(crate) info: &'a RunInfo,
    pub(crate) step_id: &'a str,
    pub(crate) previous_results: &'a Map<String, Value>,
    pub(crate) trigger_data: &'a Value,
    pub(crate) variables: &'a Map<String, Value>,
    pub(crate) loop_scope: Option<(&'a Value, usize)>,
}

type ActionResult = Result<Value, ActionError>;

/// The step types the Kubernetes editions don't run yet. A run reaching
/// one fails that step, without retries, with a message that says so.
const NOT_YET: &[&str] = &[
    "send_email",
    "send_sms",
    "slack_message",
    "create_record",
    "update_record",
    "delete_record",
    "query_data",
    "slack.post_message",
    "google_sheets.append_row",
    "google_sheets.update_row",
    "gmail.send_email",
    "google_calendar.create_event",
    "teams.post_message",
    "twilio.send_sms",
    "notion.create_page",
    "notion.update_page",
    "airtable.create_record",
    "airtable.update_record",
    "github.create_issue",
    "github.create_comment",
    "asana.create_task",
    "asana.update_task",
    "create_conversation",
    "assign_conversation",
    "tag_conversation",
    "change_conversation_status",
    "change_priority",
    "send_reply",
    "add_internal_note",
];

/// The AI steps: Workers AI, which the Kubernetes editions lack
/// (`weldconnect-ai` is unavailable there).
const AI_STEPS: &[&str] = &["ai_generate", "ai_classify"];

/// `executeAction(actionType, inputs, context)`.
pub(crate) async fn execute_action(
    kind: &str,
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    match kind {
        "set_variable" => set_variable(inputs),
        "log" => Ok(log(inputs)),
        "condition" => condition(inputs, ctx),
        "loop" => loop_items(inputs),
        "delay" => delay(inputs),
        "transform" => transform(inputs, ctx),
        "send_notification" => send_notification(inputs, ctx).await,
        "manual_step" => manual_step(inputs, ctx).await,
        "send_message" | "send_choices" | "collect_input" => interactive(kind, inputs, ctx).await,
        "http_request" => http_request(inputs, ctx, false).await,
        "webhook" => http_request(inputs, ctx, true).await,
        "create_customer" => records::create_customer(inputs, ctx).await,
        "create_contact" => records::create_contact(inputs, ctx).await,
        "update_contact" => records::update_contact(inputs, ctx).await,
        "create_lead" => records::create_lead(inputs, ctx).await,
        "create_deal" => records::create_deal(inputs, ctx).await,
        "move_deal_stage" => records::move_deal_stage(inputs, ctx).await,
        "log_activity" => records::log_activity(inputs, ctx).await,
        "post_chat_message" => records::post_chat_message(inputs, ctx).await,
        "create_task" => records::create_task(inputs, ctx).await,
        _ if AI_STEPS.contains(&kind) => Err(ActionError::fatal(
            "AI steps are not available on this deployment",
        )),
        _ if NOT_YET.contains(&kind) => Err(ActionError::fatal(&format!(
            "Step type \"{kind}\" is not available on this deployment yet"
        ))),
        _ => Err(ActionError::fatal(&format!(
            "Step type \"{kind}\" is not supported by the workflow engine"
        ))),
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// `a || b || …`: the first truthy value.
fn either<'v>(values: &[Option<&'v Value>]) -> Option<&'v Value> {
    values
        .iter()
        .copied()
        .find(|v| v.is_some_and(truthy))
        .flatten()
}

/// `asText(a || b || fallback)`.
fn text_or(values: &[Option<&Value>], fallback: &str) -> String {
    either(values).map_or_else(|| fallback.to_owned(), |v| as_text(Some(v)))
}

/// A JavaScript number as JSON: integral values print without a fraction.
pub(crate) fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        let integer = value as i64;
        json!(integer)
    } else if value.is_finite() {
        json!(value)
    } else {
        Value::Null
    }
}

/// `obj?.[a]?.[b]…` for the condition step's field paths.
fn get_path<'v>(root: Option<&'v Value>, props: &[&str]) -> Option<&'v Value> {
    super::template::get_path(root, props)
}

// ── Control ─────────────────────────────────────────────────────────────────

fn set_variable(inputs: &Map<String, Value>) -> ActionResult {
    let name = text_or(&[inputs.get("name"), inputs.get("variableName")], "");
    if name.is_empty() {
        return Err(ActionError::plain("Variable name is required"));
    }
    let mut result = json!({ "set": true, "name": name });
    if let Some(value) = inputs.get("value") {
        result["value"] = value.clone();
    }
    Ok(result)
}

fn log(inputs: &Map<String, Value>) -> Value {
    let message = text_or(&[inputs.get("message"), inputs.get("text")], "");
    let level = text_or(&[inputs.get("level")], "info").to_lowercase();
    match level.as_str() {
        "error" => tracing::error!("[LOG] {message}"),
        "warn" | "warning" => tracing::warn!("[LOG] {message}"),
        _ => tracing::info!("[LOG] {message}"),
    }
    json!({ "logged": true, "message": message })
}

fn path_reference() -> &'static Regex {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^(steps|trigger|variables|loop)\.[A-Za-z0-9_.-]+$").expect("a valid pattern")
    })
}

/// `resolveConditionField(field, ctx)`.
fn condition_field<'v>(field: &'v Value, ctx: &'v ActionCtx<'_>) -> Option<&'v Value> {
    let Value::String(text) = field else {
        return Some(field);
    };
    if !path_reference().is_match(text) {
        return Some(field);
    }
    if let Some(rest) = text.strip_prefix("steps.") {
        let mut parts = rest.split('.');
        let step = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        return get_path(ctx.previous_results.get(step), &props);
    }
    if let Some(rest) = text.strip_prefix("trigger.") {
        let props: Vec<&str> = rest.split('.').collect();
        return get_path(Some(ctx.trigger_data), &props);
    }
    if let Some(rest) = text.strip_prefix("variables.") {
        let mut parts = rest.split('.');
        let first = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        return get_path(ctx.variables.get(first), &props);
    }
    let rest = text.strip_prefix("loop.").unwrap_or_default();
    let mut parts = rest.split('.');
    let prop = parts.next().unwrap_or_default();
    let props: Vec<&str> = parts.collect();
    // `loop.index` is read by the caller.
    match (prop, ctx.loop_scope) {
        ("item", Some((item, _))) => get_path(Some(item), &props),
        _ => None,
    }
}

/// `isEmptyValue(value)`.
fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(map)) => map.is_empty(),
        _ => false,
    }
}

/// `looseEquals(a, b)`.
fn loose_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    if super::template::strict_equals(a, b) {
        return true;
    }
    if matches!(a, None | Some(Value::Null)) || matches!(b, None | Some(Value::Null)) {
        return is_empty(a) && is_empty(b);
    }
    if matches!(a, Some(Value::Object(_) | Value::Array(_)))
        || matches!(b, Some(Value::Object(_) | Value::Array(_)))
    {
        return a.map(crate::js::json_text) == b.map(crate::js::json_text);
    }
    as_text(a).trim() == as_text(b).trim()
}

/// `toNumber(value)`.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if !s.trim().is_empty() => js_number(value),
        _ => f64::NAN,
    }
}

fn compare_numbers(a: Option<&Value>, b: Option<&Value>, test: fn(f64, f64) -> bool) -> bool {
    let (x, y) = (to_number(a), to_number(b));
    !x.is_nan() && !y.is_nan() && test(x, y)
}

/// `toList(value)`.
fn to_list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| json!(p))
            .collect(),
        None | Some(Value::Null) => Vec::new(),
        Some(other) => vec![other.clone()],
    }
}

/// `containsValue(haystack, needle)`.
fn contains_value(haystack: Option<&Value>, needle: Option<&Value>) -> bool {
    match haystack {
        Some(Value::Array(items)) => items.iter().any(|item| loose_equals(Some(item), needle)),
        None | Some(Value::Null) => false,
        Some(other) => as_text(Some(other)).to_lowercase().contains(&lower(needle)),
    }
}

/// `asText(value ?? '').toLowerCase()`.
fn lower(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => as_text(other).to_lowercase(),
    }
}

/// `asText(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => as_text(other),
    }
}

/// `compareValues(operator, fieldValue, value)`.
pub(crate) fn compare_values(
    operator: &str,
    field: Option<&Value>,
    value: Option<&Value>,
) -> Result<bool, ActionError> {
    let canonical = match operator {
        "equals" => "eq",
        "neq" | "not_equals" => "ne",
        "greater_than" => "gt",
        "greater_than_or_equals" => "gte",
        "less_than" => "lt",
        "less_than_or_equals" => "lte",
        "starts_with" => "startswith",
        "ends_with" => "endswith",
        "exists" | "is_not_empty" => "isNotEmpty",
        "not_exists" | "is_empty" => "isEmpty",
        "matches" => "regex",
        other => other,
    };
    Ok(match canonical {
        "eq" => loose_equals(field, value),
        "ne" => !loose_equals(field, value),
        "gt" => compare_numbers(field, value, |x, y| x > y),
        "gte" => compare_numbers(field, value, |x, y| x >= y),
        "lt" => compare_numbers(field, value, |x, y| x < y),
        "lte" => compare_numbers(field, value, |x, y| x <= y),
        "contains" => contains_value(field, value),
        "not_contains" => !contains_value(field, value),
        "startswith" => lower(field).starts_with(&lower(value)),
        "endswith" => lower(field).ends_with(&lower(value)),
        "isEmpty" => is_empty(field),
        "isNotEmpty" => !is_empty(field),
        "in" => to_list(value)
            .iter()
            .any(|item| loose_equals(Some(item), field)),
        "not_in" => !to_list(value)
            .iter()
            .any(|item| loose_equals(Some(item), field)),
        "regex" => {
            let pattern = text_or_empty(value);
            let regex = js_regex(&pattern).map_err(|_| {
                ActionError::fatal(&format!(
                    "\"{}\" is not a valid regular expression",
                    js_string(value)
                ))
            })?;
            regex.is_match(&text_or_empty(field))
        }
        _ => {
            return Err(ActionError::fatal(&format!(
                "Unknown condition operator \"{operator}\""
            )));
        }
    })
}

fn condition(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let Some(field) = inputs.get("field") else {
        return Err(ActionError::fatal("Choose the value this condition checks"));
    };
    let index_value;
    let field_value = if field.as_str() == Some("loop.index") {
        index_value = ctx.loop_scope.map(|(_, i)| json!(i));
        index_value.as_ref()
    } else {
        condition_field(field, ctx)
    };
    if let Some(Value::Array(branches)) = inputs.get("branches") {
        let values: Vec<String> = branches
            .iter()
            .map(|b| text_or_empty(b.get("value")))
            .collect();
        let matched = values
            .iter()
            .find(|v| v.as_str() != "default" && loose_equals(field_value, Some(&json!(v))))
            .cloned()
            .or_else(|| {
                values
                    .iter()
                    .any(|v| v == "default")
                    .then(|| "default".into())
            });
        let mut result = json!({ "matchedBranch": matched });
        if let Some(value) = field_value {
            result["value"] = value.clone();
        }
        return Ok(result);
    }
    let operator = text_or(&[inputs.get("operator")], "eq");
    let passed = compare_values(&operator, field_value, inputs.get("value"))?;
    let mut result = json!({ "passed": passed });
    if let Some(value) = field_value {
        result["value"] = value.clone();
        result["result"] = value.clone();
    }
    Ok(result)
}

/// `MAX_LOOP_ITEMS`.
const MAX_LOOP_ITEMS: usize = 100;

fn loop_items(inputs: &Map<String, Value>) -> ActionResult {
    let mut items = match inputs.get("items") {
        None | Some(Value::Null) => json!([]),
        Some(Value::String(s)) if s.is_empty() => json!([]),
        Some(other) => other.clone(),
    };
    if let Value::String(text) = &items
        && let Ok(parsed) = serde_json::from_str::<Value>(text)
    {
        items = parsed;
    }
    let Value::Array(list) = &items else {
        return Err(ActionError::fatal(
            "The loop needs a list of items, for example {{trigger.data.lineItems}}",
        ));
    };
    if list.len() > MAX_LOOP_ITEMS {
        return Err(ActionError::fatal(&format!(
            "The list has {} items; a loop can run over at most {MAX_LOOP_ITEMS}",
            list.len()
        )));
    }
    let count = list.len();
    Ok(json!({ "items": items, "count": count }))
}

const MAX_DELAY_MS: f64 = 365.0 * 86_400_000.0;

fn delay(inputs: &Map<String, Value>) -> ActionResult {
    const UNITS: [(&str, f64, &str); 4] = [
        ("days", 86_400_000.0, "day(s)"),
        ("hours", 3_600_000.0, "hour(s)"),
        ("minutes", 60_000.0, "minute(s)"),
        ("seconds", 1000.0, "second(s)"),
    ];
    let mut duration_ms = 1000.0;
    let mut description = "1 second".to_owned();
    let unit = UNITS
        .iter()
        .find(|(key, _, _)| inputs.get(*key).is_some() && js_number(inputs.get(*key)) > 0.0);
    if let Some((key, ms, label)) = unit {
        duration_ms = js_number(inputs.get(*key)) * ms;
        description = format!("{} {label}", js_string(inputs.get(*key)));
    } else if let Some(raw) = either(&[inputs.get("duration"), inputs.get("ms")]) {
        duration_ms = js_number(Some(raw));
        description = format!(
            "{} second(s)",
            js_string(Some(&num((duration_ms / 1000.0).ceil())))
        );
    }
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return Err(ActionError::fatal(
            "The wait time must be a positive number",
        ));
    }
    if duration_ms > MAX_DELAY_MS {
        return Err(ActionError::fatal("A delay can wait at most 365 days"));
    }
    Ok(json!({
        "delayed": true,
        "duration": description,
        "durationMs": num(duration_ms),
        "__delayMs": num(duration_ms),
    }))
}

fn transform(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let operation = text_or(&[inputs.get("transform"), inputs.get("operation")], "pick");
    let previous = Value::Object(ctx.previous_results.clone());
    let data = either(&[inputs.get("data")]).unwrap_or(&previous);
    let source = either(&[inputs.get("source")]).unwrap_or(data);
    match operation.as_str() {
        "pick" => {
            let Some(Value::Array(fields)) = inputs.get("fields") else {
                return Err(ActionError::plain("Fields array is required for pick"));
            };
            let mut result = Map::new();
            for field in fields {
                let key = js_string(Some(field));
                if let Some(value) = data.get(&key) {
                    result.insert(key, value.clone());
                }
            }
            Ok(Value::Object(result))
        }
        "map" => {
            let Value::Array(items) = source else {
                return Err(ActionError::plain("Source must be an array for map"));
            };
            let field = text_or(&[inputs.get("mapField")], "id");
            Ok(Value::Array(
                items
                    .iter()
                    .map(|item| item.get(&field).cloned().unwrap_or(Value::Null))
                    .collect(),
            ))
        }
        "filter" => {
            let Value::Array(items) = source else {
                return Err(ActionError::plain("Source must be an array for filter"));
            };
            let field = text_or(&[inputs.get("filterField")], "");
            Ok(Value::Array(
                items
                    .iter()
                    .filter(|item| {
                        super::template::strict_equals(item.get(&field), inputs.get("filterValue"))
                    })
                    .cloned()
                    .collect(),
            ))
        }
        "merge" => {
            let Some(Value::Array(objects)) = inputs.get("objects") else {
                return Err(ActionError::plain("Objects array is required for merge"));
            };
            let mut merged = Map::new();
            for object in objects {
                if let Value::Object(map) = object {
                    for (k, v) in map {
                        merged.insert(k.clone(), v.clone());
                    }
                }
            }
            Ok(Value::Object(merged))
        }
        "stringify" => Ok(json!(crate::js::json_text(data))),
        "parse" => match data {
            Value::String(text) => serde_json::from_str(text)
                .map_err(|error| ActionError::named("SyntaxError", &error.to_string())),
            other => Ok(other.clone()),
        },
        _ => Ok(data.clone()),
    }
}

/// `new RegExp(pattern)`: the regex crate here has no Unicode classes, so
/// JavaScript's ASCII character classes (`\d`, `\w`, `\s`, `\b`) are spelled out.
pub(crate) fn js_regex(pattern: &str) -> Result<Regex, regex::Error> {
    Regex::new(pattern).or_else(|_| {
        let ascii = pattern
            .replace(r"\d", "[0-9]")
            .replace(r"\D", "[^0-9]")
            .replace(r"\w", "[A-Za-z0-9_]")
            .replace(r"\W", "[^A-Za-z0-9_]")
            .replace(r"\s", r"[\t\n\x0B\x0C\r \u{A0}\u{FEFF}]")
            .replace(r"\S", r"[^\t\n\x0B\x0C\r \u{A0}\u{FEFF}]")
            .replace(r"\b", r"(?-u:\b)")
            .replace(r"\B", r"(?-u:\B)");
        Regex::new(&ascii)
    })
}

// ── Notifications and approvals ─────────────────────────────────────────────

/// The live notification (`RealtimePublisher.notify`).
async fn notify_live(ctx: &ActionCtx<'_>, user_id: &str, notification: Value) {
    let Some(realtime) = &ctx.deps.realtime else {
        return;
    };
    let message = RealtimeMessage::personal(
        &ctx.info.workspace_id,
        &format!("notification.{user_id}"),
        "created",
        notification,
        user_id,
    );
    if let Err(error) = realtime.publish_boxed(&message).await {
        tracing::warn!(%error, "[send_notification] live publish failed");
    }
}

/// Live members among `requested`, in `requested`'s order.
async fn members(db: &PgPool, requested: &[String]) -> Result<Vec<String>, ActionError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = any($1) and deleted_at is null",
    )
    .bind(requested)
    .fetch_all(db)
    .await
    .map_err(|e| ActionError::database(&e))?;
    Ok(requested
        .iter()
        .filter(|id| rows.contains(id))
        .cloned()
        .collect())
}

/// Unique, trimmed, non-empty ids.
fn unique_ids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_owned();
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

async fn send_notification(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let title = text_or(&[inputs.get("title")], "").trim().to_owned();
    let body = text_or(&[inputs.get("body"), inputs.get("message")], "");
    if title.is_empty() {
        return Err(ActionError::fatal("Notification title is required"));
    }
    let raw = match inputs.get("userIds") {
        Some(Value::Array(ids)) if !ids.is_empty() => Some(inputs["userIds"].clone()),
        _ => inputs.get("userId").cloned(),
    };
    let ids: Vec<String> = match &raw {
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| match id {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect(),
        other => text_or_empty(other.as_ref())
            .split(',')
            .map(str::to_owned)
            .collect(),
    };
    let mut requested = unique_ids(ids);
    if requested.is_empty() {
        let fallback = ctx
            .info
            .owner_user_id
            .clone()
            .or_else(|| (ctx.info.user_id != "system").then(|| ctx.info.user_id.clone()));
        requested = fallback.into_iter().collect();
    }
    if requested.is_empty() {
        return Err(ActionError::fatal("Choose at least one member to notify"));
    }
    let user_ids = members(ctx.db, &requested).await?;
    if user_ids.is_empty() {
        return Err(ActionError::fatal(
            "None of the recipients is a member of this workspace",
        ));
    }
    let now = now_text();
    let category = text_or(&[inputs.get("category")], "task");
    let notification_type = text_or(
        &[inputs.get("notificationType"), inputs.get("type")],
        "custom",
    );
    let severity = text_or(&[inputs.get("severity")], "info");
    let optional = |key: &str| {
        inputs
            .get(key)
            .filter(|v| truthy(v))
            .map(|v| as_text(Some(v)))
    };
    let action_url = optional("actionUrl");
    let entity_type = optional("entityType");
    let entity_id = optional("entityId");
    let icon = optional("icon").unwrap_or_else(|| "workflow".into());
    let data = inputs.get("data").filter(|v| truthy(v)).cloned();
    let mut notification_ids = Vec::new();
    for user_id in &user_ids {
        let id = engine_id("notif");
        notification_ids.push(id.clone());
        sqlx::query(
            "insert into notifications
                (id, user_id, title, body, category, notification_type, entity_type, entity_id,
                 action_url, icon, severity, data, actor_type, is_read, delivered_in_app,
                 delivered_email, delivered_push, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'system', false, true, false,
                     false, $13::timestamp)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(&title)
        .bind((!body.is_empty()).then_some(&body))
        .bind(&category)
        .bind(&notification_type)
        .bind(&entity_type)
        .bind(&entity_id)
        .bind(&action_url)
        .bind(&icon)
        .bind(&severity)
        .bind(&data)
        .bind(&now)
        .execute(ctx.db)
        .await
        .map_err(|e| ActionError::database(&e))?;
        notify_live(
            ctx,
            user_id,
            json!({
                "id": id, "title": title, "body": body, "category": category,
                "notificationType": notification_type, "actionUrl": action_url,
                "entityType": entity_type, "entityId": entity_id, "createdAt": now,
                "isRead": false, "severity": severity, "actorType": "system", "actorId": null,
            }),
        )
        .await;
    }
    Ok(json!({
        "sent": true,
        "notificationIds": notification_ids,
        "notifiedUserIds": user_ids,
        "count": notification_ids.len(),
        "skipped": requested.len() - user_ids.len(),
    }))
}

/// `manualStepApproverIds(inputs)`.
fn approver_ids(inputs: &Map<String, Value>) -> Vec<String> {
    let raw: Vec<Value> = match inputs.get("approverIds") {
        Some(Value::Array(ids)) => ids.clone(),
        _ if inputs.get("assignTo") == Some(&json!("specific_user"))
            && inputs.get("assigneeId").is_some_and(truthy) =>
        {
            vec![inputs["assigneeId"].clone()]
        }
        _ => Vec::new(),
    };
    unique_ids(raw.iter().map(|id| text_or_empty(Some(id))))
}

async fn manual_step(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let title = {
        let title = text_or(&[inputs.get("title")], "").trim().to_owned();
        if title.is_empty() {
            "Approval needed".to_owned()
        } else {
            title
        }
    };
    let description = inputs
        .get("description")
        .filter(|d| truthy(d))
        .map(|d| as_text(Some(d)));
    let requested = approver_ids(inputs);
    let mut approvers = Vec::new();
    if !requested.is_empty() {
        approvers = members(ctx.db, &requested).await?;
        if approvers.is_empty() {
            return Err(ActionError::fatal(
                "None of the approvers is a member of this workspace",
            ));
        }
    }
    let body = description.clone().unwrap_or_else(|| {
        match ctx.trigger_data.get("workflowName").and_then(Value::as_str) {
            Some(name) if !name.is_empty() => format!("\"{name}\" is waiting for your approval."),
            _ => "A workflow is waiting for your approval.".into(),
        }
    });
    let mut notification = Map::new();
    notification.insert("title".into(), json!(title));
    notification.insert("body".into(), json!(body));
    notification.insert("userIds".into(), json!(approvers));
    notification.insert("category".into(), json!("task"));
    notification.insert("notificationType".into(), json!("manual_step"));
    notification.insert("severity".into(), json!("warning"));
    notification.insert("icon".into(), json!("workflow"));
    notification.insert(
        "actionUrl".into(),
        json!(format!("/weldconnect/executions/{}", ctx.info.execution_id)),
    );
    notification.insert("entityType".into(), json!("workflow_execution"));
    notification.insert("entityId".into(), json!(ctx.info.execution_id));
    let sent = send_notification(&notification, ctx).await?;
    Ok(json!({
        "__waitingForInput": true,
        "stepType": "manual_step",
        "title": title,
        "description": description,
        "approverIds": approvers,
        "notifiedUserIds": sent["notifiedUserIds"].clone(),
    }))
}

// ── Conversation steps ──────────────────────────────────────────────────────

/// `resolveConversationId(inputs, context)`.
fn conversation_id(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> Option<String> {
    if let Some(id) = inputs.get("conversationId").filter(|v| truthy(v)) {
        return Some(as_text(Some(id)));
    }
    let td = ctx.trigger_data;
    if matches!(
        td.get("entityType").and_then(Value::as_str),
        Some("helpdesk_conversation" | "desk_conversation")
    ) {
        return Some(js_string(td.get("entityId")));
    }
    if let Some(Value::Object(data)) = td.get("data")
        && data.contains_key("conversationId")
    {
        return Some(js_string(data.get("conversationId")));
    }
    None
}

async fn interactive(kind: &str, inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let Some(conversation_id) = conversation_id(inputs, ctx) else {
        return Ok(json!({ "success": false, "error": "No conversation ID" }));
    };
    let content = text_or(&[inputs.get("message")], "");
    let message_id = engine_id("msg");
    let now = now_text();
    let step_ref = text_or(&[inputs.get("__stepId")], "unknown");
    let metadata = match kind {
        "send_choices" => Some(json!({
            "interactiveType": "choices",
            "workflowExecutionId": ctx.info.execution_id,
            "workflowStepId": step_ref,
            "options": either(&[inputs.get("options")]).cloned().unwrap_or_else(|| json!([])),
        })),
        "collect_input" => Some(json!({
            "interactiveType": "collect_input",
            "workflowExecutionId": ctx.info.execution_id,
            "workflowStepId": step_ref,
            "fields": either(&[inputs.get("fields")]).cloned().unwrap_or_else(|| json!([])),
        })),
        _ => None,
    };
    sqlx::query(
        "insert into helpdesk_conversation_messages
            (id, conversation_id, content, author_type, author_id, author_name, type, is_public, status,
             metadata, created_at, updated_at)
         values ($1, $2, $3, 'system', 'system', 'Bot', 'message', true, 'sent', $4, $5::timestamp,
                 $5::timestamp)",
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(&content)
    .bind(&metadata)
    .bind(&now)
    .execute(ctx.db)
    .await
    .map_err(|e| ActionError::database(&e))?;
    if let Some(realtime) = &ctx.deps.realtime {
        let mut payload = json!({
            "type": "message:new",
            "id": message_id,
            "conversationId": conversation_id,
            "content": content,
            "sender": "agent",
            "timestamp": now,
            "ts": now_ms(),
        });
        if let Some(metadata) = &metadata {
            payload["metadata"] = metadata.clone();
        }
        let message = RealtimeMessage::room(Room::Conversation, &conversation_id, payload);
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::warn!(%error, "[Realtime] Failed to publish message:new");
        }
    }
    Ok(match kind {
        "send_message" => {
            json!({ "success": true, "messageId": message_id, "conversationId": conversation_id })
        }
        _ => json!({
            "__waitingForInput": true,
            "conversationId": conversation_id,
            "messageId": message_id,
            "stepType": kind,
        }),
    })
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const MAX_TIMEOUT_MS: f64 = 120_000.0;
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_INTEGRATION_REDIRECTS: usize = 5;

fn integration_hosts(kind: &str) -> &'static [&'static str] {
    match kind {
        "airtable" => &["api.airtable.com"],
        "asana" => &["app.asana.com"],
        "attio" => &["api.attio.com"],
        "github" => &["api.github.com"],
        "gmail" | "google_calendar" | "google_sheets" => &["*.googleapis.com"],
        "hubspot" => &["api.hubapi.com", "api.hubspot.com"],
        "notion" => &["api.notion.com"],
        "slack" => &["slack.com", "*.slack.com"],
        "teams" => &[
            "graph.microsoft.com",
            "outlook.office.com",
            "*.webhook.office.com",
        ],
        "twilio" => &["api.twilio.com", "*.twilio.com"],
        _ => &[],
    }
}

fn normalize_host(host: &str) -> String {
    host.to_lowercase().trim_end_matches('.').to_owned()
}

fn is_integration_host(kind: &str, host: &str) -> bool {
    integration_hosts(kind)
        .iter()
        .any(|pattern| match pattern.strip_prefix('*') {
            Some(suffix) => host.ends_with(suffix),
            None => host == *pattern,
        })
}

fn is_private_ipv4(host: &str) -> bool {
    let octets: Vec<&str> = host.split('.').collect();
    let first = octets.first().and_then(|o| o.parse::<u16>().ok());
    let second = octets.get(1).and_then(|o| o.parse::<u16>().ok());
    host.starts_with("0.")
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || (first == Some(172)
            && second.is_some_and(|s| (16..=31).contains(&s))
            && host.starts_with("172."))
        || host.starts_with("169.254.")
        || (first == Some(100)
            && second.is_some_and(|s| (64..=127).contains(&s))
            && host.starts_with("100."))
}

fn is_private_ipv6(literal: &str) -> bool {
    let address = literal.trim_start_matches('[').trim_end_matches(']');
    if !address.contains(':') {
        return false;
    }
    if address == "::" || address == "::1" {
        return true;
    }
    let first = address.split(':').next().unwrap_or_default();
    if first.len() == 4 && (first.starts_with("fc") || first.starts_with("fd")) {
        return true;
    }
    if first.len() == 4
        && ["fe8", "fe9", "fea", "feb"]
            .iter()
            .any(|p| first.starts_with(p))
    {
        return true;
    }
    match address.parse::<std::net::Ipv6Addr>() {
        Ok(ip) => ip
            .to_ipv4_mapped()
            .is_some_and(|v4| is_private_ipv4(&v4.to_string())),
        Err(_) => false,
    }
}

/// `isBlockedTarget(hostname)`.
fn is_blocked(hostname: &str) -> bool {
    let host = normalize_host(hostname);
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if matches!(host.rsplit('.').next(), Some("internal" | "local")) && host.contains('.') {
        return true;
    }
    if host == "metadata" || host == "instance-data" {
        return true;
    }
    if ["weldsuite.org", "workers.dev"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return true;
    }
    is_private_ipv6(&host) || is_private_ipv4(&host)
}

/// `parseRequestUrl(raw)`.
fn parse_url(raw: &str) -> Result<url::Url, ActionError> {
    let url =
        url::Url::parse(raw).map_err(|_| ActionError::fatal(&format!("Invalid URL: {raw}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ActionError::fatal(&format!(
            "Unsupported URL scheme: {}:",
            url.scheme()
        )));
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    if is_blocked(&host) {
        return Err(ActionError::fatal(&format!(
            "URL targets a disallowed host: {host}"
        )));
    }
    Ok(url)
}

fn status_text(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        520 => "Unknown Error (Cloudflare)",
        521 => "Web Server Is Down (Cloudflare)",
        522 => "Connection Timed Out (Cloudflare)",
        523 => "Origin Is Unreachable (Cloudflare)",
        524 => "A Timeout Occurred (Cloudflare)",
        530 => "Origin DNS Error (Cloudflare)",
        _ => return None,
    })
}

fn status_label(status: u16) -> String {
    status_text(status).map_or_else(|| status.to_string(), |text| format!("{status} {text}"))
}

/// `resolveIntegration(db, { integrationId, type })` and its bearer token.
async fn integration_token(
    db: &PgPool,
    integration_id: Option<&str>,
    kind: Option<&str>,
) -> Result<(String, Option<String>), ActionError> {
    let selector = integration_id.map_or_else(
        || format!("type={}", kind.unwrap_or_default()),
        |id| format!("id={id}"),
    );
    let row: Option<Value> = if let Some(id) = integration_id {
        sqlx::query_scalar(
            "select to_jsonb(t) from workflow_integrations t where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(id)
        .fetch_optional(db)
        .await
    } else {
        sqlx::query_scalar(
            "select to_jsonb(t) from workflow_integrations t where t.type = $1 and t.deleted_at is null limit 1",
        )
        .bind(kind.unwrap_or_default())
        .fetch_optional(db)
        .await
    }
    .map_err(|e| ActionError::database(&e))?;
    let Some(row) = row else {
        return Err(ActionError::named(
            "IntegrationNotFoundError",
            &format!("Integration not found: {selector}"),
        ));
    };
    let status = js_string(row.get("status"));
    if status != "connected" {
        return Err(ActionError::named(
            "IntegrationNotConnectedError",
            &format!("Integration {selector} is not connected (status: {status})"),
        ));
    }
    let tokens = &row["oauth_tokens"];
    let credentials = &row["credentials"];
    let token = tokens["accessToken"]
        .as_str()
        .or_else(|| {
            ["accessToken", "botToken", "apiKey", "token"]
                .iter()
                .find_map(|key| credentials[*key].as_str())
        })
        .map(str::to_owned);
    Ok((js_string(row.get("type")), token))
}

async fn http_request(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
    webhook: bool,
) -> ActionResult {
    let raw_url = if webhook {
        text_or(&[inputs.get("url"), inputs.get("webhookUrl")], "")
    } else {
        text_or(&[inputs.get("url")], "")
    };
    if raw_url.is_empty() {
        return Err(if webhook {
            ActionError::plain("Webhook URL is required")
        } else {
            ActionError::fatal("URL is required")
        });
    }
    let url = parse_url(&raw_url)?;
    let method = text_or(
        &[inputs.get("method")],
        if webhook { "POST" } else { "GET" },
    )
    .to_uppercase();
    let mut headers: Vec<(String, String)> = match either(&[inputs.get("headers")]) {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), js_string(Some(v))))
            .collect(),
        _ => Vec::new(),
    };
    let body = if webhook {
        either(&[
            inputs.get("body"),
            inputs.get("payload"),
            inputs.get("data"),
        ])
        .cloned()
    } else {
        inputs.get("body").cloned()
    };
    let timeout = {
        let t = js_number(inputs.get("timeout"));
        if t.is_nan() || t == 0.0 {
            DEFAULT_TIMEOUT_MS
        } else {
            t.min(MAX_TIMEOUT_MS)
        }
    };
    // The integration's bearer token, only to its own API host.
    let integration_id = inputs
        .get("integrationId")
        .filter(|v| truthy(v))
        .map(|v| as_text(Some(v)));
    let integration_type = inputs
        .get("integrationType")
        .filter(|v| truthy(v))
        .map(|v| as_text(Some(v)));
    let mut auth_type = None;
    if (integration_id.is_some() || integration_type.is_some())
        && !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
    {
        let (kind, token) = integration_token(
            ctx.db,
            integration_id.as_deref(),
            integration_type.as_deref(),
        )
        .await?;
        if let Some(token) = token {
            let host = normalize_host(url.host_str().unwrap_or_default());
            if !is_integration_host(&kind, &host) {
                return Err(ActionError::fatal(&format!(
                    "The {kind} integration's token can only be sent to its own API host, not to {host}. Remove the integration from this step to call another server, or set the Authorization header yourself."
                )));
            }
            headers.push(("Authorization".into(), format!("Bearer {token}")));
            auth_type = Some(kind);
        }
    }
    let mut all_headers = vec![("Content-Type".to_owned(), "application/json".to_owned())];
    for (key, value) in headers {
        if let Some(existing) = all_headers.iter_mut().find(|(k, _)| *k == key) {
            existing.1 = value;
        } else {
            all_headers.push((key, value));
        }
    }
    let body_text = match &body {
        Some(value) if !webhook || truthy(value) => Some(crate::js::json_text(value)),
        _ => None,
    };
    let http = ctx
        .deps
        .http
        .clone()
        .unwrap_or_else(|| OutboundHttp(Arc::new(crate::Unreachable)));
    let (status, response, final_url) = fetch(
        &http,
        url,
        &method,
        &all_headers,
        body_text,
        timeout,
        auth_type.as_deref(),
    )
    .await?;
    let mut text = response.text();
    if text.len() > MAX_RESPONSE_BYTES {
        let mut cut = MAX_RESPONSE_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    let host = final_url.host_str().unwrap_or_default().to_owned();
    if status == 530 {
        let code = Regex::new(r"(?-u:\b)(1[0-9]{3})(?-u:\b)")
            .ok()
            .and_then(|re| re.captures(&text).map(|c| c[1].to_owned()));
        return Err(match code.as_deref() {
            None | Some("1016") => ActionError::fatal_with(
                &format!("Could not resolve host {host}"),
                json!({ "status": status }),
            ),
            Some(code) => ActionError::fatal_with(
                &format!("Could not reach {host}: Cloudflare error {code}"),
                json!({ "status": status }),
            ),
        });
    }
    if webhook {
        let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!(text));
        if !(200..300).contains(&status) {
            let snippet: String = text.chars().take(200).collect();
            return Err(ActionError::plain(&format!(
                "Webhook failed: {} - {snippet}",
                status_label(status)
            )));
        }
        return Ok(json!({ "success": true, "status": status, "response": data }));
    }
    let content_type = response
        .header("content-type")
        .unwrap_or_default()
        .to_owned();
    let parsed = if content_type.contains("application/json") || content_type.contains("+json") {
        serde_json::from_str(&text).unwrap_or_else(|_| json!(text))
    } else {
        json!(text)
    };
    let mut response_headers = Map::new();
    for (name, value) in &response.headers {
        if name == "set-cookie" || name == "set-cookie2" {
            continue;
        }
        match response_headers.get_mut(name) {
            Some(Value::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                response_headers.insert(name.clone(), json!(value));
            }
        }
    }
    if (400..500).contains(&status) {
        return Err(ActionError::fatal_with(
            &format!("HTTP request failed: {}", status_label(status)),
            json!({ "status": status, "headers": response_headers, "body": parsed }),
        ));
    }
    if status >= 500 {
        return Err(ActionError::plain(&format!(
            "HTTP request failed: {}",
            status_label(status)
        )));
    }
    Ok(json!({
        "status": status,
        "ok": (200..300).contains(&status),
        "headers": response_headers,
        "body": parsed,
    }))
}

/// `fetchWithTimeout(url, init, timeoutMs, integrationType)`: an
/// integration's call follows its redirects itself, only to its own API.
async fn fetch(
    http: &OutboundHttp,
    url: url::Url,
    method: &str,
    headers: &[(String, String)],
    body: Option<String>,
    timeout_ms: f64,
    integration: Option<&str>,
) -> Result<(u16, weldsuite_ports::HttpResponse, url::Url), ActionError> {
    let original_host = url.host_str().unwrap_or_default().to_owned();
    let mut current = url;
    let mut method = method.to_owned();
    let mut headers = headers.to_vec();
    let mut body = body;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let timeout = std::time::Duration::from_millis(timeout_ms.max(0.0) as u64);
    for hops in 0.. {
        let mut request = HttpRequest::empty(&method, current.as_str());
        for (name, value) in &headers {
            request = request.header(name, value.clone());
        }
        request.body = body.clone().map(String::into_bytes);
        let sent = tokio::time::timeout(timeout, http.send(request)).await;
        let response = match sent {
            Err(_) => {
                return Err(ActionError::plain(&format!(
                    "Request timed out after {}ms",
                    num(timeout_ms)
                )));
            }
            Ok(Err(error)) => {
                return Err(ActionError::fatal(&format!(
                    "Could not connect to {}: {error}",
                    current.host_str().unwrap_or_default()
                )));
            }
            Ok(Ok(response)) => response,
        };
        let location = response.header("location").map(str::to_owned);
        let Some(kind) = integration else {
            return Ok((response.status, response, current));
        };
        let Some(location) =
            location.filter(|_| [301, 302, 303, 307, 308].contains(&response.status))
        else {
            return Ok((response.status, response, current));
        };
        if hops >= MAX_INTEGRATION_REDIRECTS {
            return Err(ActionError::fatal(&format!(
                "Too many redirects (more than {MAX_INTEGRATION_REDIRECTS}) calling {original_host}"
            )));
        }
        let from = current.host_str().unwrap_or_default().to_owned();
        let target = current
            .join(&location)
            .map_err(|_| ActionError::fatal(&format!("{from} redirected to an invalid URL")))?;
        let next = parse_url(target.as_str())?;
        let next_host = normalize_host(next.host_str().unwrap_or_default());
        if !is_integration_host(kind, &next_host) {
            return Err(ActionError::fatal(&format!(
                "{from} redirected to {}, which is not the {kind} API host; the integration token was not sent",
                next.host_str().unwrap_or_default()
            )));
        }
        let status = response.status;
        let to_get = if status == 303 {
            method != "GET" && method != "HEAD"
        } else {
            (status == 301 || status == 302) && method == "POST"
        };
        if to_get {
            method = "GET".into();
            body = None;
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
        }
        current = next;
    }
    unreachable!("the redirect loop returns")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn comparisons_follow_the_condition_step() {
        let v = |x: Value| Some(x);
        assert!(compare_values("eq", v(json!("5")).as_ref(), v(json!(5)).as_ref()).unwrap());
        assert!(compare_values("eq", None, v(json!("")).as_ref()).unwrap());
        assert!(
            compare_values(
                "contains",
                v(json!("Hello World")).as_ref(),
                v(json!("world")).as_ref()
            )
            .unwrap()
        );
        assert!(compare_values("in", v(json!("b")).as_ref(), v(json!("a, b")).as_ref()).unwrap());
        assert!(!compare_values("gt", v(json!("x")).as_ref(), v(json!(1)).as_ref()).unwrap());
        assert!(compare_values("bogus", None, None).is_err());
        assert!(compare_values("regex", v(json!("a")).as_ref(), v(json!("(")).as_ref()).is_err());
    }

    #[test]
    fn delays_read_their_unit() {
        let inputs: Map<String, Value> = serde_json::from_value(json!({ "minutes": "2" })).unwrap();
        let result = delay(&inputs).unwrap();
        assert_eq!(result["durationMs"], json!(120_000));
        assert_eq!(result["duration"], json!("2 minute(s)"));
        let inputs: Map<String, Value> =
            serde_json::from_value(json!({ "duration": 1500 })).unwrap();
        assert_eq!(delay(&inputs).unwrap()["duration"], json!("2 second(s)"));
        let inputs: Map<String, Value> = serde_json::from_value(json!({ "days": 400 })).unwrap();
        assert!(delay(&inputs).is_err());
    }

    #[test]
    fn blocked_hosts() {
        for host in [
            "localhost",
            "10.1.2.3",
            "172.20.0.1",
            "app.weldsuite.org",
            "[::1]",
            "metadata",
            "100.64.0.1",
        ] {
            assert!(is_blocked(host), "{host}");
        }
        for host in ["example.com", "172.32.0.1", "8.8.8.8"] {
            assert!(!is_blocked(host), "{host}");
        }
    }
}
