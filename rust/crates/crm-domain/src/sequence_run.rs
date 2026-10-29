//! `ExecuteSequenceWorkflow` (`@weldsuite/crm-domain/workflows/execute-sequence`)
//! as the job `crm.execute-sequence`: one run per enrollment (the job key is
//! the enrollment id, as the Workflow instance id is), each sequence step a
//! durable step, delays and sending-limit waits durable sleeps, and a pause
//! parked on the `sequence-resume` signal with a daily re-check.
//!
//! The sequence editor offers three step types (`send_email`, `delay`,
//! `condition`); those run as in TypeScript, `send_email` behind the outbound
//! guard (`guarded_send`, source `crm_sequence`, a new thread). `log` runs
//! too. The other WeldConnect action types the legacy executor knows
//! (records, AI, helpdesk, webhooks, …) fail their step with a message: no
//! sequence the editor builds has them. A type the executor does not know at
//! all passes through, as it does there.
//!
//! Not ported: the `workflow_runs` usage meter (`USAGE_METER`, mail-api's
//! Durable Object). The run is not metered, as in a worker without the
//! binding (TypeScript fails open the same way).

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_core_domain::js::{Js, as_text};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_mail_domain::outbound::guard::{GuardedSendError, SubjectInput, guarded_send};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, DenialDetails, OutboundBindings, OutboundDenied, OutboundKind,
    SendEmailParams, send_email,
};
use weldsuite_ports::{
    BoxFuture, DynCache, DynRealtimePublisher, Job, JobContext, JobError, RealtimeMessage,
    StepRetry, step,
};

use crate::drizzle_row;

/// The job's name (the Workflow class, `EXECUTE_SEQUENCE`).
pub const EXECUTE_SEQUENCE_JOB: &str = "crm.execute-sequence";

/// `SEQUENCE_RESUME_EVENT`: the signal the routes send to wake a run parked
/// on a pause. Only a hint: the run re-reads the database after every wake.
pub const SEQUENCE_RESUME_EVENT: &str = "sequence-resume";

/// `SEND_DEFER_BUDGET_MS`: the longest a send step waits in total for a
/// sending limit to clear before its enrollment is stopped.
pub const SEND_DEFER_BUDGET_MS: i64 = 24 * 60 * 60 * 1000;
/// The shortest sleep for a limit.
const SEND_DEFER_MIN_MS: i64 = 10_000;
/// Waits per step at most.
const SEND_DEFER_MAX_ATTEMPTS: u32 = 30;
/// How long a parked run waits for the resume signal before it re-checks.
const PAUSE_RECHECK_TIMEOUT: Duration = Duration::from_hours(24);
/// Re-checks of one pause at most (about a year).
const MAX_PAUSE_RECHECKS: u32 = 400;

/// What the job is started with (`ExecuteSequenceParams`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSequenceParams {
    /// The Clerk org id (the tenant, realtime, the guard's subject).
    pub workspace_id: String,
    pub user_id: String,
    /// `workflows.id`.
    pub sequence_id: String,
    /// `sequence_enrollments.id`, also the job key.
    pub enrollment_id: String,
    pub customer_id: String,
}

/// Opens a workspace's tenant database by its id or Clerk org id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The job, with what it reaches outside the database.
pub struct ExecuteSequenceJob {
    pub tenants: TenantDatabases,
    /// `SEND_EMAIL` and the guard's ledgers.
    pub outbound: OutboundBindings,
    /// The master database (the guard's sender ownership).
    pub master: Option<PgPool>,
    /// The guard's ownership cache.
    pub cache: Option<Arc<dyn DynCache>>,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
}

// ── Gate ────────────────────────────────────────────────────────────────────

/// `RunGate`: whether a run may take its next step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum RunGate {
    Run,
    Paused,
    Stop { reason: String },
}

/// `readRunGate(db, params)`.
pub async fn read_run_gate(
    db: &PgPool,
    sequence_id: &str,
    enrollment_id: &str,
) -> Result<RunGate, sqlx::Error> {
    let sequence: Option<Option<String>> = sqlx::query_scalar(
        "select status from workflows where id = $1 and deleted_at is null limit 1",
    )
    .bind(sequence_id)
    .fetch_optional(db)
    .await?;
    let Some(sequence) = sequence else {
        return Ok(stop("Sequence not found"));
    };
    let enrollment: Option<String> =
        sqlx::query_scalar("select status from sequence_enrollments where id = $1 limit 1")
            .bind(enrollment_id)
            .fetch_optional(db)
            .await?;
    let Some(enrollment) = enrollment else {
        return Ok(stop("Enrollment not found"));
    };
    let sequence = sequence.unwrap_or_default();
    Ok(match (enrollment.as_str(), sequence.as_str()) {
        ("paused", _) => RunGate::Paused,
        (status, _) if status != "active" => stop(&format!("Enrollment status is {status}")),
        (_, "paused") => RunGate::Paused,
        (_, status) if status != "active" => stop(&format!("Sequence status is {status}")),
        _ => RunGate::Run,
    })
}

fn stop(reason: &str) -> RunGate {
    RunGate::Stop {
        reason: reason.to_owned(),
    }
}

// ── Sending limits ──────────────────────────────────────────────────────────

/// `planSendDeferral(details, now, waited)`: how long a refused send sleeps
/// before it is tried again, or `None` (do not wait).
pub fn plan_send_deferral(
    details: &DenialDetails,
    now_ms: i64,
    attempts: u32,
    waited_ms: i64,
) -> Option<i64> {
    let retry_after = details.retry_after.as_deref()?;
    if attempts >= SEND_DEFER_MAX_ATTEMPTS {
        return None;
    }
    let retry_at = weldsuite_mail_domain::outbound::clock::parse_iso(retry_after)?;
    let wait_ms = (retry_at - now_ms).max(SEND_DEFER_MIN_MS);
    (waited_ms + wait_ms <= SEND_DEFER_BUDGET_MS).then_some(wait_ms)
}

/// `sendingLimitedMessage(err)`.
pub fn sending_limited_message(denied: &OutboundDenied) -> String {
    format!(
        "sending_limited: {} ({})",
        denied.message(),
        denied.code().as_str()
    )
}

// ── Inputs and conditions ───────────────────────────────────────────────────

/// What `{{…}}` references and conditions read.
pub struct Sources<'a> {
    pub previous_results: &'a Map<String, Value>,
    pub trigger: &'a Value,
    pub variables: &'a Map<String, Value>,
    pub contact: &'a Map<String, Value>,
}

/// `obj?.[prop]` down `props`.
fn nested<'v>(root: Option<&'v Value>, props: &[&str]) -> Option<&'v Value> {
    props.iter().try_fold(root?, |value, prop| match value {
        Value::Object(fields) => fields.get(*prop),
        Value::Array(items) => prop.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

/// `lookupReference(path, sources)`; `None` is `undefined`.
fn lookup(path: &str, sources: &Sources<'_>) -> Option<Value> {
    if let Some(rest) = path.strip_prefix("steps.") {
        let mut parts = rest.split('.');
        let step_id = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        return nested(sources.previous_results.get(step_id), &props).cloned();
    }
    if let Some(rest) = path.strip_prefix("trigger.") {
        let props: Vec<&str> = rest.split('.').collect();
        return nested(Some(sources.trigger), &props).cloned();
    }
    if let Some(name) = path.strip_prefix("variables.") {
        return sources.variables.get(name).cloned();
    }
    if let Some(key) = path.strip_prefix("contact.") {
        return sources.contact.get(key).cloned();
    }
    None
}

/// `asText(value)` (`@weldsuite/text`); `undefined` reads `"undefined"`.
pub fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), |v| as_text(&Js::from_jsonb(v)))
}

/// The `{{path}}` matches of `/\{\{([^{}]+)\}\}/g`: (start, end, path).
fn template_matches(text: &str) -> Vec<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at + 1 < bytes.len() {
        if bytes[at] == b'{' && bytes[at + 1] == b'{' {
            let inner_start = at + 2;
            let mut end = inner_start;
            while end < bytes.len() && bytes[end] != b'{' && bytes[end] != b'}' {
                end += 1;
            }
            if end > inner_start && text[end..].starts_with("}}") {
                out.push((at, end + 2, &text[inner_start..end]));
                at = end + 2;
                continue;
            }
        }
        at += 1;
    }
    out
}

/// `resolveString(value, sources)`.
fn resolve_string(value: &str, sources: &Sources<'_>) -> Value {
    if !(value.contains("{{") && value.contains("}}")) {
        return Value::String(value.to_owned());
    }
    let matches = template_matches(value);
    let mut resolved = String::new();
    let mut last = 0;
    for (start, end, path) in &matches {
        resolved.push_str(&value[last..*start]);
        if let Some(found) = lookup(path.trim(), sources) {
            resolved.push_str(&text_of(Some(&found)));
        } else {
            tracing::warn!("Unresolved template: {}", &value[*start..*end]);
        }
        last = *end;
    }
    resolved.push_str(&value[last..]);
    if let [(0, end, path)] = matches.as_slice()
        && *end == value.len()
        && let Some(found) = lookup(path.trim(), sources)
    {
        return found;
    }
    Value::String(resolved)
}

/// `resolveValue(value, sources)`.
fn resolve_value(value: &Value, sources: &Sources<'_>) -> Value {
    match value {
        Value::String(text) => resolve_string(text, sources),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::Object(fields) => Value::Object(resolve_inputs(fields, sources)),
                    // `Object.entries` of an array: its indexes as keys.
                    Value::Array(inner) => Value::Object(
                        inner
                            .iter()
                            .enumerate()
                            .map(|(i, v)| (i.to_string(), resolve_value(v, sources)))
                            .collect(),
                    ),
                    other => other.clone(),
                })
                .collect(),
        ),
        Value::Object(fields) => Value::Object(resolve_inputs(fields, sources)),
        other => other.clone(),
    }
}

/// `resolveInputs(inputs, previousResults, triggerData, variables, contactData)`.
pub fn resolve_inputs(inputs: &Map<String, Value>, sources: &Sources<'_>) -> Map<String, Value> {
    inputs
        .iter()
        .map(|(key, value)| (key.clone(), resolve_value(value, sources)))
        .collect()
}

/// JavaScript truthiness of a JSON value (`undefined` is falsy).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number(value)`.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => string_to_number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [only] if !only.is_array() && !only.is_object() => {
                string_to_number(&text_of(Some(only)))
            }
            _ => f64::NAN,
        },
    }
}

fn string_to_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            #[allow(clippy::cast_precision_loss)]
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    let plain = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if plain {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `a === b` of two JSON values (objects and arrays are never the same object).
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// The operators `evaluateCondition` and `handleCondition` share; `None` for
/// an operator neither knows.
fn apply_operator(
    operator: &str,
    field: Option<&Value>,
    value: Option<&Value>,
) -> Option<Result<bool, String>> {
    let number = || (to_number(field), to_number(value));
    let texts = || (text_of(field), text_of(value));
    let listed = |list: Option<&Value>| match list {
        Some(Value::Array(items)) => Some(items.iter().any(|item| strict_equal(Some(item), field))),
        _ => None,
    };
    Some(Ok(match operator {
        "eq" | "equals" => strict_equal(field, value),
        "neq" | "not_equals" => !strict_equal(field, value),
        "gt" | "greater_than" => {
            let (a, b) = number();
            a > b
        }
        "gte" | "greater_than_or_equals" => {
            let (a, b) = number();
            a >= b
        }
        "lt" | "less_than" => {
            let (a, b) = number();
            a < b
        }
        "lte" | "less_than_or_equals" => {
            let (a, b) = number();
            a <= b
        }
        "contains" => {
            let (a, b) = texts();
            a.contains(&b)
        }
        "starts_with" => {
            let (a, b) = texts();
            a.starts_with(&b)
        }
        "ends_with" => {
            let (a, b) = texts();
            a.ends_with(&b)
        }
        "exists" => !matches!(field, None | Some(Value::Null)),
        "not_exists" => matches!(field, None | Some(Value::Null)),
        "in" => listed(value).unwrap_or(false),
        "not_in" => listed(value).is_none_or(|found| !found),
        "matches" => {
            let (subject, pattern) = texts();
            return Some(
                regex::Regex::new(&pattern)
                    .map(|re| re.is_match(&subject))
                    .map_err(|_| format!("Invalid regular expression: /{pattern}/")),
            );
        }
        _ => return None,
    }))
}

/// `evaluateCondition(condition, previousResults, triggerData, variables, contactData)`.
pub fn evaluate_condition(condition: &Value, sources: &Sources<'_>) -> Result<bool, String> {
    let field = condition.get("field");
    let operator = condition.get("operator");
    if !truthy(field) || !truthy(operator) {
        tracing::warn!("Condition missing field or operator, failing closed");
        return Ok(false);
    }
    let field_text = text_of(field);
    let field_value = if field_text.starts_with("steps.")
        || field_text.starts_with("trigger.")
        || field_text.starts_with("variables.")
        || field_text.starts_with("contact.")
    {
        lookup(&field_text, sources)
    } else {
        field.cloned()
    };
    let operator = operator.and_then(Value::as_str).unwrap_or_default();
    apply_operator(operator, field_value.as_ref(), condition.get("value")).unwrap_or_else(|| {
        tracing::warn!("Unknown operator: {operator}");
        Ok(false)
    })
}

// ── Step actions ────────────────────────────────────────────────────────────

/// The action types the legacy executor (`actionHandlers`) has; the ones not
/// ported here fail their step instead of passing through.
const EXECUTOR_TYPES: [&str; 27] = [
    "send_email",
    "send_notification",
    "send_sms",
    "create_record",
    "update_record",
    "delete_record",
    "query_data",
    "set_variable",
    "loop",
    "condition",
    "delay",
    "transform",
    "webhook",
    "http_request",
    "ai_generate",
    "ai_classify",
    "log",
    "assign_conversation",
    "tag_conversation",
    "change_conversation_status",
    "change_priority",
    "send_reply",
    "add_internal_note",
    "manual_step",
    "send_message",
    "send_choices",
    "collect_input",
];

/// Why a step's action failed.
enum ActionError {
    /// The outbound guard refused the send.
    Denied(OutboundDenied),
    Failed(String),
}

impl From<String> for ActionError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<sqlx::Error> for ActionError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// `handleDelay(inputs)`: the duration, which the run sleeps after the step.
fn handle_delay(inputs: &Map<String, Value>) -> Value {
    let units = [
        ("days", 86_400_000.0, "day(s)"),
        ("hours", 3_600_000.0, "hour(s)"),
        ("minutes", 60_000.0, "minute(s)"),
        ("seconds", 1_000.0, "second(s)"),
    ];
    let mut duration_ms = 1000.0;
    let mut description = "1 second".to_owned();
    let picked = units
        .iter()
        .find(|(key, _, _)| truthy(inputs.get(*key)) && to_number(inputs.get(*key)) > 0.0);
    if let Some((key, factor, unit)) = picked {
        duration_ms = to_number(inputs.get(*key)) * factor;
        description = format!("{} {unit}", text_of(inputs.get(*key)));
    } else if truthy(inputs.get("duration")) || truthy(inputs.get("ms")) {
        let raw = if truthy(inputs.get("duration")) {
            inputs.get("duration")
        } else {
            inputs.get("ms")
        };
        duration_ms = to_number(raw);
        let seconds = (duration_ms / 1000.0).ceil();
        description = format!(
            "{} second(s)",
            weldsuite_core_domain::js::number_text(seconds)
        );
    }
    let ms = weldsuite_core_domain::js::number_value(duration_ms);
    json!({ "delayed": true, "duration": description, "durationMs": ms, "__delayMs": ms })
}

/// `handleCondition(inputs, ctx)`.
fn handle_condition(inputs: &Map<String, Value>, sources: &Sources<'_>) -> Result<Value, String> {
    let operator = if truthy(inputs.get("operator")) {
        text_of(inputs.get("operator"))
    } else {
        "eq".to_owned()
    };
    let field_value = match inputs
        .get("field")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty())
    {
        None => None,
        Some(field)
            if field.starts_with("steps.")
                || field.starts_with("trigger.")
                || field.starts_with("variables.") =>
        {
            lookup(field, sources)
        }
        // No loop runs in a sequence.
        Some(field) if field.starts_with("loop.") => None,
        Some(field) => inputs.get(field).cloned(),
    };
    let passed =
        apply_operator(&operator, field_value.as_ref(), inputs.get("value")).unwrap_or(Ok(true))?;
    let mut out = Map::new();
    out.insert("passed".into(), Value::Bool(passed));
    if let Some(result) = field_value {
        out.insert("result".into(), result);
    }
    Ok(Value::Object(out))
}

/// `handleLog(inputs)`.
fn handle_log(inputs: &Map<String, Value>) -> Value {
    let message = if truthy(inputs.get("message")) {
        text_of(inputs.get("message"))
    } else if truthy(inputs.get("text")) {
        text_of(inputs.get("text"))
    } else {
        String::new()
    };
    let level = if truthy(inputs.get("level")) {
        text_of(inputs.get("level")).to_lowercase()
    } else {
        "info".to_owned()
    };
    match level.as_str() {
        "error" => tracing::error!("[LOG] {message}"),
        "warn" | "warning" => tracing::warn!("[LOG] {message}"),
        _ => tracing::info!("[LOG] {message}"),
    }
    json!({ "logged": true, "message": message })
}

/// An address list input (`to`, `cc`, `bcc`).
fn address_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| truthy(Some(item)))
            .map(|item| text_of(Some(item)))
            .collect(),
        _ => Vec::new(),
    }
}

/// `text.replaceAll(/<[^<>]*>/g, '')`.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        match after.find(['<', '>']) {
            Some(close) if after.as_bytes()[close] == b'>' => {
                out.push_str(&rest[..open]);
                rest = &after[close + 1..];
            }
            _ => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

impl ExecuteSequenceJob {
    async fn db(&self, workspace: &str) -> Result<PgPool, String> {
        (self.tenants)(workspace.to_owned()).await
    }

    /// `rt.workflowExecutionEvent(workspaceId, executionId, event, data)`.
    async fn publish(&self, workspace: &str, execution_id: &str, event: &str, data: Value) {
        let Some(realtime) = &self.realtime else {
            return;
        };
        let message = RealtimeMessage::workspace(
            workspace,
            &format!("workflow_execution.{execution_id}"),
            event,
            data,
            "system",
        );
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::warn!(%error, event, "[execute-sequence] realtime publish failed");
        }
    }

    /// `handleSendEmail(inputs, ctx)`.
    async fn send_email_step(
        &self,
        db: &PgPool,
        workspace: &str,
        inputs: &Map<String, Value>,
    ) -> Result<Value, ActionError> {
        let to = inputs.get("to");
        let defined = truthy(to)
            && !matches!(to, Some(Value::String(text)) if text.trim().is_empty())
            && !matches!(to, Some(Value::Array(items)) if items.is_empty());
        if !defined {
            return Err("No recipients defined for send_email action"
                .to_owned()
                .into());
        }
        let recipients: Vec<String> = match to {
            Some(Value::String(text)) => text
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            Some(Value::Array(_)) => address_list(to),
            _ => return Err("to.filter is not a function".to_owned().into()),
        };
        if recipients.is_empty() {
            return Err("No valid recipients after parsing".to_owned().into());
        }
        let accounts: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from mail_accounts t
             where t.status = 'active' and t.deleted_at is null limit 5",
        )
        .fetch_all(db)
        .await?;
        let accounts: Vec<Value> = accounts.into_iter().map(drizzle_row).collect();
        let account = match inputs.get("from") {
            Some(from) if truthy(Some(from)) => accounts.iter().find(|a| {
                strict_equal(a.get("email"), Some(from)) || strict_equal(a.get("id"), Some(from))
            }),
            _ => accounts
                .iter()
                .find(|a| truthy(a.get("isDefault")))
                .or_else(|| accounts.first()),
        };
        let Some(account) = account else {
            return Err("No email account configured".to_owned().into());
        };
        let Some(transport) = self.outbound.transport.clone() else {
            return Err("SEND_EMAIL binding not configured for email sending"
                .to_owned()
                .into());
        };
        let email = text_of(account.get("email"));
        let from = if truthy(account.get("displayName")) {
            format!("{} <{email}>", text_of(account.get("displayName")))
        } else {
            email.clone()
        };
        let pick = |keys: &[&str]| {
            keys.iter()
                .map(|key| inputs.get(*key))
                .find(|value| truthy(*value))
                .map_or_else(String::new, |value| text_of(value))
        };
        let subject = pick(&["subject"]);
        let html = pick(&["body", "html"]);
        let text = strip_tags(&pick(&["body"]));
        let cc = address_list(inputs.get("cc"));
        let bcc = address_list(inputs.get("bcc"));

        let mut check = CheckOutboundInput::new(
            SubjectInput::Workspace {
                clerk_org_id: workspace.to_owned(),
                workspace_id: None,
            },
            "crm_sequence",
            OutboundKind::NewThread,
            &from,
            recipients.clone(),
        );
        check.cc.clone_from(&cc);
        check.bcc.clone_from(&bcc);
        check.subject_line = Some(subject.clone());
        check.text = Some(text.clone());
        check.html = Some(html.clone());
        let params = SendEmailParams {
            from,
            to: recipients,
            cc,
            bcc,
            subject,
            text: Some(text),
            html: Some(html),
            ..SendEmailParams::default()
        };
        let guard = self.outbound.guard(self.master.clone(), self.cache.clone());
        let sent = guarded_send(&guard, Some(db), &check, || {
            send_email(transport.as_ref(), &params)
        })
        .await
        .map_err(|error| match error {
            GuardedSendError::Denied(denied) => ActionError::Denied(denied),
            GuardedSendError::Send(error) => ActionError::Failed(error.to_string()),
        })?;
        Ok(json!({ "success": true, "messageId": sent.message_id, "from": email }))
    }

    /// `executeAction(type, inputs, ctx)` for the types a sequence has.
    async fn execute_action(
        &self,
        db: &PgPool,
        run: &Run<'_>,
        kind: &str,
        inputs: Map<String, Value>,
        previous: &Map<String, Value>,
    ) -> Result<Value, ActionError> {
        let sources = run.sources(previous);
        match kind {
            "send_email" => {
                self.send_email_step(db, &run.params.workspace_id, &inputs)
                    .await
            }
            "delay" => Ok(handle_delay(&inputs)),
            "condition" => Ok(handle_condition(&inputs, &sources)?),
            "log" => Ok(handle_log(&inputs)),
            known if EXECUTOR_TYPES.contains(&known) => Err(ActionError::Failed(format!(
                "Step type \"{known}\" is not available on this server"
            ))),
            other => {
                tracing::warn!("Unknown action type: {other}, executing as passthrough");
                Ok(json!({ "executed": true, "type": other, "inputs": inputs }))
            }
        }
    }
}

// ── The run ─────────────────────────────────────────────────────────────────

/// One step's outcome, as the journal keeps it (`StepOutcome`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StepOutcome {
    Skipped {
        step_id: String,
    },
    SendDeferred {
        step_id: String,
        step_execution_id: String,
        wait_ms: i64,
    },
    Completed {
        step_id: String,
        result: Value,
        delay_ms: Option<f64>,
    },
    Failed {
        step_id: String,
        error: String,
    },
    ErrorContinued {
        step_id: String,
        error: String,
    },
}

/// `SendRetry`: what a re-run of a send step carries over.
#[derive(Debug, Clone)]
struct SendRetry {
    step_execution_id: String,
    attempts: u32,
    waited_ms: i64,
}

/// What `load-sequence` hands on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Loaded {
    Skipped {
        reason: String,
    },
    Ready {
        name: String,
        version: i64,
        steps: Vec<Value>,
        variables: Map<String, Value>,
        contact: Map<String, Value>,
    },
}

/// `SequenceRunContext`.
struct Run<'a> {
    params: &'a ExecuteSequenceParams,
    execution_id: String,
    steps: Vec<Value>,
    variables: Map<String, Value>,
    contact: Map<String, Value>,
    trigger: Value,
}

impl Run<'_> {
    fn sources<'s>(&'s self, previous: &'s Map<String, Value>) -> Sources<'s> {
        Sources {
            previous_results: previous,
            trigger: &self.trigger,
            variables: &self.variables,
            contact: &self.contact,
        }
    }
}

fn now_iso() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

fn now_ms() -> i64 {
    weldsuite_mail_domain::outbound::clock::now_ms()
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

fn step_text<'v>(step: &'v Value, key: &str) -> Option<&'v str> {
    step.get(key).and_then(Value::as_str)
}

fn json_text(value: Option<&Value>) -> Option<String> {
    value.filter(|v| !v.is_null()).map(Value::to_string)
}

impl ExecuteSequenceJob {
    /// `readRunGate` in a durable step.
    async fn gate_step(
        &self,
        ctx: &dyn JobContext,
        name: &str,
        params: &ExecuteSequenceParams,
    ) -> Result<RunGate, JobError> {
        step(ctx, name, StepRetry::default(), || async {
            let db = self.db(&params.workspace_id).await.map_err(failed)?;
            read_run_gate(&db, &params.sequence_id, &params.enrollment_id)
                .await
                .map_err(failed)
        })
        .await
    }

    /// `waitUntilRunnable(step, readGate, label)`: `Run` or `Stop`, never `Paused`.
    async fn check_gate(
        &self,
        ctx: &dyn JobContext,
        params: &ExecuteSequenceParams,
        label: &str,
    ) -> Result<RunGate, JobError> {
        let mut gate = self
            .gate_step(ctx, &format!("gate-{label}"), params)
            .await?;
        let mut attempt = 0;
        while gate == RunGate::Paused && attempt < MAX_PAUSE_RECHECKS {
            ctx.wait_for_signal(
                &format!("paused-{label}-{attempt}"),
                SEQUENCE_RESUME_EVENT,
                PAUSE_RECHECK_TIMEOUT,
            )
            .await?;
            gate = self
                .gate_step(ctx, &format!("gate-{label}-{attempt}"), params)
                .await?;
            attempt += 1;
        }
        Ok(if gate == RunGate::Paused {
            stop("Paused for too long")
        } else {
            gate
        })
    }

    /// Step 2: `loadSequenceDefinition`.
    async fn load(&self, params: &ExecuteSequenceParams) -> Result<Loaded, JobError> {
        let db = self.db(&params.workspace_id).await.map_err(failed)?;
        let workflow: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from workflows t where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(&params.sequence_id)
        .fetch_optional(&db)
        .await
        .map_err(failed)?;
        let Some(workflow) = workflow.map(drizzle_row) else {
            return Err(failed(format!("Sequence {} not found", params.sequence_id)));
        };
        if workflow.get("status").and_then(Value::as_str) != Some("active") {
            return Ok(Loaded::Skipped {
                reason: "Sequence not active".to_owned(),
            });
        }
        let enrollment: Option<(String, Option<Value>)> = sqlx::query_as(
            "select status, customer_snapshot from sequence_enrollments where id = $1 limit 1",
        )
        .bind(&params.enrollment_id)
        .fetch_optional(&db)
        .await
        .map_err(failed)?;
        let Some((status, snapshot)) = enrollment else {
            return Err(failed(format!(
                "Enrollment {} not found",
                params.enrollment_id
            )));
        };
        if status != "active" {
            return Ok(Loaded::Skipped {
                reason: format!("Enrollment status is {status}"),
            });
        }
        let records: Vec<(String, Option<Value>)> = sqlx::query_as(
            "select name, value from workflow_variables
             where (workflow_id = $1 or workflow_id is null) and deleted_at is null",
        )
        .bind(&params.sequence_id)
        .fetch_all(&db)
        .await
        .map_err(failed)?;
        let variables = records
            .into_iter()
            .map(|(name, value)| (name, value.unwrap_or(Value::Null)))
            .collect();
        let steps = match workflow.get("steps") {
            Some(Value::Array(steps)) => steps.clone(),
            _ => Vec::new(),
        };
        Ok(Loaded::Ready {
            name: text_of(workflow.get("name")),
            version: workflow.get("version").and_then(Value::as_i64).unwrap_or(1),
            steps,
            variables,
            contact: match snapshot {
                Some(Value::Object(fields)) => fields,
                _ => Map::new(),
            },
        })
    }

    /// Step 3: `createExecutionRecord`.
    async fn create_execution(
        &self,
        params: &ExecuteSequenceParams,
        instance_id: &str,
        name: &str,
        version: i64,
        step_count: usize,
    ) -> Result<String, JobError> {
        let db = self.db(&params.workspace_id).await.map_err(failed)?;
        let id = generate_id("wex");
        let now = now_iso();
        let trigger = json!({
            "source": "sequence_enrollment",
            "enrollmentId": params.enrollment_id,
            "customerId": params.customer_id,
        });
        let total = i32::try_from(step_count).unwrap_or(i32::MAX);
        sqlx::query(
            "insert into workflow_executions (id, workflow_id, workflow_version, workflow_name,
               status, triggered_by, trigger_type, trigger_data, started_at, total_steps,
               current_step_index, cf_workflow_instance_id, created_at, updated_at)
             values ($1, $2, $3, $4, 'running', $5, 'manual', $6::jsonb, $7::timestamp, $8, 0,
               $9, $7::timestamp, $7::timestamp)",
        )
        .bind(&id)
        .bind(&params.sequence_id)
        .bind(i32::try_from(version).unwrap_or(1))
        .bind(name)
        .bind(&params.user_id)
        .bind(trigger.to_string())
        .bind(&now)
        .bind(total)
        .bind(instance_id)
        .execute(&db)
        .await
        .map_err(failed)?;
        self.publish(
            &params.workspace_id,
            &id,
            "started",
            json!({
                "executionId": id,
                "workflowId": params.sequence_id,
                "workflowName": name,
                "totalSteps": step_count,
            }),
        )
        .await;
        Ok(id)
    }

    /// `runSequenceStep(ctx, wfStep, i, retry)`.
    async fn run_step(
        &self,
        run: &Run<'_>,
        previous: &Map<String, Value>,
        index: usize,
        retry: Option<&SendRetry>,
    ) -> Result<StepOutcome, JobError> {
        let params = run.params;
        let wf_step = &run.steps[index];
        let step_id = step_text(wf_step, "id").unwrap_or_default().to_owned();
        let step_name = step_text(wf_step, "name");
        let db = self.db(&params.workspace_id).await.map_err(failed)?;
        let step_execution_id = retry.map_or_else(
            || generate_id("wes"),
            |retry| retry.step_execution_id.clone(),
        );
        let step_index = index + 1;
        let total = run.steps.len();
        if retry.is_none() {
            self.publish(
                &params.workspace_id,
                &run.execution_id,
                "step_started",
                json!({
                    "stepIndex": step_index, "totalSteps": total, "stepId": wf_step.get("id"),
                    "stepName": wf_step.get("name"), "stepType": wf_step.get("type"),
                }),
            )
            .await;
            let now = now_iso();
            sqlx::query(
                "insert into workflow_execution_steps (id, execution_id, step_id, step_name,
                   step_type, step_index, status, input, started_at, created_at)
                 values ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8::timestamp, $8::timestamp)",
            )
            .bind(&step_execution_id)
            .bind(&run.execution_id)
            .bind(step_text(wf_step, "id"))
            .bind(step_name)
            .bind(step_text(wf_step, "type"))
            .bind(i32::try_from(step_index).unwrap_or(i32::MAX))
            .bind(json_text(wf_step.get("inputs")))
            .bind(&now)
            .execute(&db)
            .await
            .map_err(failed)?;
        }
        sqlx::query(
            "update workflow_executions set current_step_id = $2, current_step_index = $3,
               updated_at = $4::timestamp where id = $1",
        )
        .bind(&run.execution_id)
        .bind(step_text(wf_step, "id"))
        .bind(i32::try_from(step_index).unwrap_or(i32::MAX))
        .bind(now_iso())
        .execute(&db)
        .await
        .map_err(failed)?;

        let attempted = self
            .attempt_step(&db, run, previous, index, &step_execution_id)
            .await;
        match attempted {
            Ok(outcome) => Ok(outcome),
            Err(ActionError::Denied(denied)) => {
                let (attempts, waited) = retry.map_or((0, 0), |r| (r.attempts, r.waited_ms));
                if let Some(wait_ms) =
                    plan_send_deferral(&denied.details, now_ms(), attempts, waited)
                {
                    return self
                        .defer_send(
                            &db,
                            &step_id,
                            &step_execution_id,
                            &denied,
                            wait_ms,
                            attempts,
                        )
                        .await;
                }
                tracing::warn!(
                    "[execute-sequence] send refused for enrollment {}: {}",
                    params.enrollment_id,
                    denied.code().as_str()
                );
                self.record_failure(
                    &db,
                    run,
                    index,
                    &step_execution_id,
                    &sending_limited_message(&denied),
                    Some(denied.code().as_str()),
                )
                .await
            }
            Err(ActionError::Failed(message)) => {
                self.record_failure(&db, run, index, &step_execution_id, &message, None)
                    .await
            }
        }
    }

    /// The `try` of `runSequenceStep`: the condition, then the action.
    async fn attempt_step(
        &self,
        db: &PgPool,
        run: &Run<'_>,
        previous: &Map<String, Value>,
        index: usize,
        step_execution_id: &str,
    ) -> Result<StepOutcome, ActionError> {
        let params = run.params;
        let wf_step = &run.steps[index];
        let step_id = step_text(wf_step, "id").unwrap_or_default().to_owned();
        let step_index = index + 1;
        let total = run.steps.len();
        let sources = run.sources(previous);

        // `skipStepIfConditionFails`.
        if let Some(condition) = wf_step.get("condition").filter(|c| truthy(Some(c)))
            && !evaluate_condition(condition, &sources)?
        {
            sqlx::query(
                "update workflow_execution_steps set status = 'skipped',
                   completed_at = $2::timestamp,
                   output = '{\"skipped\": true, \"reason\": \"Condition not met\"}'::jsonb
                 where id = $1",
            )
            .bind(step_execution_id)
            .bind(now_iso())
            .execute(db)
            .await?;
            self.publish(
                &params.workspace_id,
                &run.execution_id,
                "step_skipped",
                json!({
                    "stepIndex": step_index, "totalSteps": total, "stepId": wf_step.get("id"),
                    "stepName": wf_step.get("name"), "reason": "Condition not met",
                }),
            )
            .await;
            return Ok(StepOutcome::Skipped { step_id });
        }

        // `executeStepAction`.
        let raw = [wf_step.get("config"), wf_step.get("inputs")]
            .into_iter()
            .find(|value| truthy(*value))
            .flatten();
        let fields = match raw {
            Some(Value::Object(fields)) => fields.clone(),
            _ => Map::new(),
        };
        let mut inputs = resolve_inputs(&fields, &sources);
        inputs.insert(
            "__stepId".into(),
            wf_step.get("id").cloned().unwrap_or(Value::Null),
        );
        let kind = step_text(wf_step, "type").unwrap_or_default();
        let result = self.execute_action(db, run, kind, inputs, previous).await?;
        let delay_ms = result.get("__delayMs").and_then(Value::as_f64);
        sqlx::query(
            "update workflow_execution_steps set status = 'completed',
               completed_at = $2::timestamp, output = $3::jsonb where id = $1",
        )
        .bind(step_execution_id)
        .bind(now_iso())
        .bind(result.to_string())
        .execute(db)
        .await?;
        self.publish(
            &params.workspace_id,
            &run.execution_id,
            "step_completed",
            json!({
                "stepIndex": step_index, "totalSteps": total, "stepId": wf_step.get("id"),
                "stepName": wf_step.get("name"),
            }),
        )
        .await;
        if let Err(error) =
            sqlx::query("update sequence_enrollments set current_step_index = $2 where id = $1")
                .bind(&params.enrollment_id)
                .bind(i32::try_from(step_index).unwrap_or(i32::MAX))
                .execute(db)
                .await
        {
            tracing::warn!(%error, "Failed to update enrollment progress");
        }
        Ok(StepOutcome::Completed {
            step_id,
            result,
            delay_ms,
        })
    }

    /// `recordStepFailure(ctx, db, wfStep, stepIndex, stepExecutionId, error, code)`.
    async fn record_failure(
        &self,
        db: &PgPool,
        run: &Run<'_>,
        index: usize,
        step_execution_id: &str,
        message: &str,
        code: Option<&str>,
    ) -> Result<StepOutcome, JobError> {
        let params = run.params;
        let wf_step = &run.steps[index];
        let step_id = step_text(wf_step, "id").unwrap_or_default().to_owned();
        let step_name = step_text(wf_step, "name");
        let step_index = index + 1;
        let error = match code {
            Some(code) => json!({ "message": message, "code": code }),
            None => json!({ "message": message }),
        };
        sqlx::query(
            "update workflow_execution_steps set status = 'failed',
               completed_at = $2::timestamp, error = $3::jsonb where id = $1",
        )
        .bind(step_execution_id)
        .bind(now_iso())
        .bind(error.to_string())
        .execute(db)
        .await
        .map_err(failed)?;
        self.publish(
            &params.workspace_id,
            &run.execution_id,
            "step_failed",
            json!({
                "stepIndex": step_index, "totalSteps": run.steps.len(), "stepId": wf_step.get("id"),
                "stepName": wf_step.get("name"), "error": message,
            }),
        )
        .await;
        if truthy(wf_step.get("continueOnError")) {
            return Ok(StepOutcome::ErrorContinued {
                step_id,
                error: message.to_owned(),
            });
        }
        let now = now_iso();
        let execution_error = json!({ "message": message, "stepId": wf_step.get("id"), "stepName": wf_step.get("name") });
        sqlx::query(
            "update workflow_executions set status = 'failed', completed_at = $2::timestamp,
               updated_at = $2::timestamp, error = $3::jsonb where id = $1",
        )
        .bind(&run.execution_id)
        .bind(&now)
        .bind(execution_error.to_string())
        .execute(db)
        .await
        .map_err(failed)?;
        sqlx::query(
            "insert into workflow_error_logs (id, workflow_id, execution_id, error_message,
               step_id, step_name, severity, input, created_at, occurred_at)
             values ($1, $2, $3, $4, $5, $6, 'error', $7::jsonb, $8::timestamp, $8::timestamp)",
        )
        .bind(generate_id("wel"))
        .bind(&params.sequence_id)
        .bind(&run.execution_id)
        .bind(message)
        .bind(step_text(wf_step, "id"))
        .bind(step_name)
        .bind(json_text(wf_step.get("inputs")))
        .bind(&now)
        .execute(db)
        .await
        .map_err(failed)?;
        let enrollment_message = format!(
            "Step \"{}\" failed: {message}",
            text_of(wf_step.get("name"))
        );
        if let Err(error) = sqlx::query(
            "update sequence_enrollments set status = 'failed', failed_at = $2::timestamp,
               error_message = $3, current_step_index = $4 where id = $1",
        )
        .bind(&params.enrollment_id)
        .bind(&now)
        .bind(enrollment_message)
        .bind(i32::try_from(step_index).unwrap_or(i32::MAX))
        .execute(db)
        .await
        {
            tracing::warn!(%error, "Failed to update enrollment failure status");
        }
        Ok(StepOutcome::Failed {
            step_id,
            error: message.to_owned(),
        })
    }

    /// `deferSend(db, wfStep, stepExecutionId, err, waitMs, retry)`.
    async fn defer_send(
        &self,
        db: &PgPool,
        step_id: &str,
        step_execution_id: &str,
        denied: &OutboundDenied,
        wait_ms: i64,
        attempts: u32,
    ) -> Result<StepOutcome, JobError> {
        let now = now_ms();
        let mut data = Map::new();
        data.insert("code".into(), json!(denied.code().as_str()));
        if let Some(window) = &denied.details.window {
            data.insert("window".into(), json!(window));
        }
        if let Some(retry_after) = &denied.details.retry_after {
            data.insert("retryAfter".into(), json!(retry_after));
        }
        let logs = json!([{
            "timestamp": weldsuite_mail_domain::outbound::clock::iso(now),
            "level": "warn",
            "message": format!(
                "{} Waiting until {} to send.",
                denied.message(),
                weldsuite_mail_domain::outbound::clock::iso(now + wait_ms)
            ),
            "data": data,
        }]);
        sqlx::query(
            "update workflow_execution_steps set retry_count = $2, max_retries = $3,
               logs = $4::jsonb where id = $1",
        )
        .bind(step_execution_id)
        .bind(i32::try_from(attempts + 1).unwrap_or(i32::MAX))
        .bind(i32::try_from(SEND_DEFER_MAX_ATTEMPTS).unwrap_or(i32::MAX))
        .bind(logs.to_string())
        .execute(db)
        .await
        .map_err(failed)?;
        Ok(StepOutcome::SendDeferred {
            step_id: step_id.to_owned(),
            step_execution_id: step_execution_id.to_owned(),
            wait_ms,
        })
    }

    /// `stopRun(env, params, executionId, reason, step, waitingStepExecutionId)`.
    async fn stop_run(
        &self,
        ctx: &dyn JobContext,
        run: &Run<'_>,
        reason: &str,
        waiting_step: Option<&str>,
    ) -> Result<(), JobError> {
        step(ctx, "stop-run", StepRetry::default(), || async {
            let db = self.db(&run.params.workspace_id).await.map_err(failed)?;
            let now = now_iso();
            let error = json!({ "message": format!("Stopped: {reason}") }).to_string();
            sqlx::query(
                "update workflow_executions set status = 'cancelled', completed_at = $2::timestamp,
                   updated_at = $2::timestamp, error = $3::jsonb where id = $1",
            )
            .bind(&run.execution_id)
            .bind(&now)
            .bind(&error)
            .execute(&db)
            .await
            .map_err(failed)?;
            if let Some(waiting) = waiting_step {
                sqlx::query(
                    "update workflow_execution_steps set status = 'cancelled',
                       completed_at = $2::timestamp, error = $3::jsonb where id = $1",
                )
                .bind(waiting)
                .bind(&now)
                .bind(&error)
                .execute(&db)
                .await
                .map_err(failed)?;
            }
            Ok(())
        })
        .await
    }

    /// `runStepWithSendWaits`: `Ok(Some(outcome))`, or `Ok(None)` when the
    /// gate stopped the run during a wait.
    async fn run_with_send_waits(
        &self,
        ctx: &dyn JobContext,
        run: &Run<'_>,
        previous: &Map<String, Value>,
        index: usize,
    ) -> Result<Option<StepOutcome>, JobError> {
        let step_id = step_text(&run.steps[index], "id").unwrap_or_default();
        let name = format!("step-{index}-{step_id}");
        let mut outcome: StepOutcome = step(ctx, &name, StepRetry::default(), || {
            self.run_step(run, previous, index, None)
        })
        .await?;
        let mut attempt = 0;
        let mut waited_ms = 0;
        while let StepOutcome::SendDeferred {
            step_execution_id,
            wait_ms,
            ..
        } = &outcome
        {
            attempt += 1;
            waited_ms += wait_ms;
            let pause = Duration::from_millis(u64::try_from(*wait_ms).unwrap_or(0));
            ctx.sleep(&format!("send-wait-{index}-{attempt}"), pause)
                .await?;
            let gate = self
                .check_gate(ctx, run.params, &format!("send-{index}-{attempt}"))
                .await?;
            if let RunGate::Stop { reason } = gate {
                self.stop_run(ctx, run, &reason, Some(step_execution_id))
                    .await?;
                return Ok(None);
            }
            let retry = SendRetry {
                step_execution_id: step_execution_id.clone(),
                attempts: attempt,
                waited_ms,
            };
            let name = format!("step-{index}-{step_id}-send-{attempt}");
            outcome = step(ctx, &name, StepRetry::default(), || {
                self.run_step(run, previous, index, Some(&retry))
            })
            .await?;
        }
        Ok(Some(outcome))
    }

    /// `updateSequenceStats(db, sequenceId)`.
    async fn update_stats(db: &PgPool, sequence_id: &str) {
        let now = now_iso();
        let result = sqlx::query(
            "update workflows set execution_count = coalesce(execution_count, 0) + 1,
               last_executed_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(sequence_id)
        .bind(now)
        .execute(db)
        .await;
        if let Err(error) = result {
            tracing::error!(%error, "Failed to update sequence stats");
        }
    }

    /// Step 5: `finalizeSequence`.
    async fn finalize(
        &self,
        run: &Run<'_>,
        results: &Map<String, Value>,
        started_ms: i64,
    ) -> Result<(), JobError> {
        let db = self.db(&run.params.workspace_id).await.map_err(failed)?;
        let end = now_ms();
        let end_iso = weldsuite_mail_domain::outbound::clock::iso(end);
        sqlx::query(
            "update workflow_executions set status = 'completed', completed_at = $2::timestamp,
               output = $3::jsonb, duration = $4, updated_at = $2::timestamp where id = $1",
        )
        .bind(&run.execution_id)
        .bind(&end_iso)
        .bind(Value::Object(results.clone()).to_string())
        .bind(i32::try_from(end - started_ms).unwrap_or(i32::MAX))
        .execute(&db)
        .await
        .map_err(failed)?;
        Self::update_stats(&db, &run.params.sequence_id).await;
        if let Err(error) = sqlx::query(
            "update sequence_enrollments set status = 'completed', completed_at = $2::timestamp,
               current_step_index = $3 where id = $1",
        )
        .bind(&run.params.enrollment_id)
        .bind(&end_iso)
        .bind(i32::try_from(run.steps.len()).unwrap_or(i32::MAX))
        .execute(&db)
        .await
        {
            tracing::warn!(%error, "Failed to update enrollment completion status");
        }
        Ok(())
    }

    /// `ExecuteSequenceWorkflow.run(event, step)`.
    #[allow(clippy::too_many_lines)] // the run's steps in order, as TypeScript has them
    async fn execute(
        &self,
        ctx: &dyn JobContext,
        params: &ExecuteSequenceParams,
    ) -> Result<(), JobError> {
        if let RunGate::Stop { reason } = self.check_gate(ctx, params, "start").await? {
            tracing::info!(reason, "[execute-sequence] skipped");
            return Ok(());
        }
        // Step 1 (`check-limits`, the `workflow_runs` meter) is not ported.
        let loaded: Loaded = step(ctx, "load-sequence", StepRetry::default(), || {
            self.load(params)
        })
        .await?;
        let Loaded::Ready {
            name,
            version,
            steps,
            variables,
            contact,
        } = loaded
        else {
            return Ok(());
        };
        let instance_id = ctx.key().to_owned();
        let execution_id: String = step(ctx, "create-execution", StepRetry::default(), || {
            self.create_execution(params, &instance_id, &name, version, steps.len())
        })
        .await?;
        let trigger = json!({
            "source": "sequence_enrollment",
            "enrollmentId": params.enrollment_id,
            "customerId": params.customer_id,
            "userId": params.user_id,
            "workspaceId": params.workspace_id,
            "timestamp": now_iso(),
            "triggerType": "manual",
            "workflowId": params.sequence_id,
            "workflowName": name,
            "executionId": execution_id,
        });
        let run = Run {
            params,
            execution_id,
            steps,
            variables,
            contact,
            trigger,
        };
        let started_ms = now_ms();
        let mut results = Map::new();

        for index in 0..run.steps.len() {
            if index > 0
                && let RunGate::Stop { reason } = self
                    .check_gate(ctx, params, &format!("step-{index}"))
                    .await?
            {
                return self.stop_run(ctx, &run, &reason, None).await;
            }
            let Some(outcome) = self.run_with_send_waits(ctx, &run, &results, index).await? else {
                return Ok(());
            };
            let delay_ms = match outcome {
                StepOutcome::Failed { step_id, error } => {
                    self.publish(
                        &params.workspace_id,
                        &run.execution_id,
                        "failed",
                        json!({ "executionId": run.execution_id, "error": error, "failedStepId": step_id }),
                    )
                    .await;
                    step(ctx, "update-stats-failed", StepRetry::default(), || async {
                        let db = self.db(&params.workspace_id).await.map_err(failed)?;
                        Self::update_stats(&db, &params.sequence_id).await;
                        Ok(())
                    })
                    .await?;
                    return Ok(());
                }
                StepOutcome::Skipped { step_id } => {
                    results.insert(step_id, json!({ "skipped": true }));
                    0.0
                }
                StepOutcome::ErrorContinued { step_id, error } => {
                    results.insert(step_id, json!({ "error": error }));
                    0.0
                }
                StepOutcome::Completed {
                    step_id,
                    result,
                    delay_ms,
                } => {
                    results.insert(step_id, result);
                    delay_ms.filter(|ms| *ms > 0.0).unwrap_or(0.0)
                }
                StepOutcome::SendDeferred { .. } => 0.0,
            };
            if delay_ms > 0.0 {
                ctx.sleep(
                    &format!("delay-{index}"),
                    Duration::from_secs_f64(delay_ms / 1000.0),
                )
                .await?;
            }
        }

        if let RunGate::Stop { reason } = self.check_gate(ctx, params, "finalize").await? {
            return self.stop_run(ctx, &run, &reason, None).await;
        }
        step(ctx, "finalize", StepRetry::default(), || {
            self.finalize(&run, &results, started_ms)
        })
        .await?;
        self.publish(
            &params.workspace_id,
            &run.execution_id,
            "completed",
            json!({
                "executionId": run.execution_id,
                "duration": now_ms() - started_ms,
                "stepsCompleted": run.steps.len(),
            }),
        )
        .await;
        Ok(())
    }
}

impl Job for ExecuteSequenceJob {
    fn name(&self) -> &'static str {
        EXECUTE_SEQUENCE_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: ExecuteSequenceParams = serde_json::from_value(payload)?;
            self.execute(ctx, &params).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_mail_domain::outbound::DenialCode;

    fn map(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect()
    }

    fn details(retry_after: Option<&str>) -> DenialDetails {
        let details = DenialDetails::new(DenialCode::SendingLimited);
        match retry_after {
            Some(at) => details.retry_after(at.to_owned()),
            None => details,
        }
    }

    const NOW: i64 = 1_767_258_000_000; // 2026-01-01T09:00:00Z

    #[test]
    fn waits_until_retry_after_within_the_budget() {
        let at = weldsuite_mail_domain::outbound::clock::iso(NOW + 3_600_000);
        assert_eq!(
            plan_send_deferral(&details(Some(&at)), NOW, 0, 0),
            Some(3_600_000)
        );
        let past = weldsuite_mail_domain::outbound::clock::iso(NOW - 5_000);
        assert_eq!(
            plan_send_deferral(&details(Some(&past)), NOW, 0, 0),
            Some(SEND_DEFER_MIN_MS)
        );
        assert_eq!(plan_send_deferral(&details(None), NOW, 0, 0), None);
        assert_eq!(plan_send_deferral(&details(Some("soon")), NOW, 0, 0), None);
        let late = weldsuite_mail_domain::outbound::clock::iso(NOW + SEND_DEFER_BUDGET_MS);
        assert_eq!(plan_send_deferral(&details(Some(&late)), NOW, 1, 1), None);
        assert_eq!(
            plan_send_deferral(&details(Some(&at)), NOW, SEND_DEFER_MAX_ATTEMPTS, 0),
            None
        );
    }

    type Fixture = (
        Map<String, Value>,
        Value,
        Map<String, Value>,
        Map<String, Value>,
    );

    fn sources_fixture() -> Fixture {
        (
            map(&[("s1", json!({ "messageId": "m1", "list": [1, 2] }))]),
            json!({ "enrollmentId": "senr_1" }),
            map(&[("greeting", json!("Hi"))]),
            map(&[("firstName", json!("Anna")), ("age", json!(42))]),
        )
    }

    #[test]
    fn resolves_templates_like_resolve_inputs() {
        let (previous, trigger, variables, contact) = sources_fixture();
        let sources = Sources {
            previous_results: &previous,
            trigger: &trigger,
            variables: &variables,
            contact: &contact,
        };
        let inputs = map(&[
            (
                "subject",
                json!("{{variables.greeting}} {{contact.firstName}}!"),
            ),
            ("age", json!("{{contact.age}}")),
            ("missing", json!("x{{contact.nope}}y")),
            ("nested", json!({ "id": "{{steps.s1.messageId}}" })),
            (
                "items",
                json!(["{{contact.firstName}}", { "a": "{{trigger.enrollmentId}}" }]),
            ),
            ("braces", json!("{{{contact.firstName}}}")),
        ]);
        let out = resolve_inputs(&inputs, &sources);
        assert_eq!(out["subject"], json!("Hi Anna!"));
        assert_eq!(out["age"], json!(42));
        assert_eq!(out["missing"], json!("xy"));
        assert_eq!(out["nested"], json!({ "id": "m1" }));
        assert_eq!(
            out["items"],
            json!(["{{contact.firstName}}", { "a": "senr_1" }])
        );
        assert_eq!(out["braces"], json!("{Anna}"));
    }

    #[test]
    fn evaluates_conditions_like_typescript() {
        let (previous, trigger, variables, contact) = sources_fixture();
        let sources = Sources {
            previous_results: &previous,
            trigger: &trigger,
            variables: &variables,
            contact: &contact,
        };
        let check = |condition: Value| evaluate_condition(&condition, &sources).expect("evaluates");
        assert!(check(
            json!({ "field": "contact.firstName", "operator": "eq", "value": "Anna" })
        ));
        assert!(check(
            json!({ "field": "contact.age", "operator": "gt", "value": "41" })
        ));
        assert!(check(
            json!({ "field": "contact.nope", "operator": "not_exists" })
        ));
        assert!(check(
            json!({ "field": "steps.s1.list", "operator": "contains", "value": "1,2" })
        ));
        assert!(check(
            json!({ "field": "contact.age", "operator": "in", "value": [41, 42] })
        ));
        assert!(!check(
            json!({ "field": "contact.age", "operator": "weird" })
        ));
        assert!(!check(json!({ "operator": "eq" })));
        assert!(check(
            json!({ "field": "contact.firstName", "operator": "matches", "value": "^An" })
        ));
    }

    #[test]
    fn delays_read_their_largest_unit() {
        assert_eq!(
            handle_delay(&map(&[("days", json!(2))])),
            json!({ "delayed": true, "duration": "2 day(s)", "durationMs": 172_800_000, "__delayMs": 172_800_000 })
        );
        assert_eq!(
            handle_delay(&map(&[("minutes", json!("5"))]))["durationMs"],
            json!(300_000)
        );
        assert_eq!(
            handle_delay(&map(&[("ms", json!(1500))]))["duration"],
            json!("2 second(s)")
        );
        assert_eq!(handle_delay(&Map::new())["duration"], json!("1 second"));
    }

    #[test]
    fn strips_tags_like_the_regex() {
        assert_eq!(strip_tags("<p>Hi <b>there</b></p>"), "Hi there");
        assert_eq!(strip_tags("a < b > c"), "a  c");
        assert_eq!(strip_tags("1 < 2"), "1 < 2");
        assert_eq!(strip_tags("<<b>x"), "<x");
    }
}
