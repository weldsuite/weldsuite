//! The WeldConnect MVP gate (`services/weldconnect-mvp.ts`): what a workflow
//! may use to go live, and the normalised schedule and webhook triggers the
//! syncs work from.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::is_known_action;

use crate::cron::{is_valid_timezone, zoned_time_to_utc};
use crate::js::{as_text, bag, is_blank, js_number, js_string};

/// Tag carried by CRM sequence workflows.
pub(crate) const SEQUENCE_WORKFLOW_TAG: &str = "__type:sequence";

const TRIGGER_TYPES: &[&str] = &["entity_event", "schedule", "webhook", "workflow_complete"];
const SCHEDULE_TYPES: &[&str] = &["recurring", "one_time"];
const WORKFLOW_COMPLETE_OUTCOMES: &[&str] = &["success", "failure", "both"];

/// `WELDCONNECT_ACTION_TYPES`.
pub(crate) const ACTION_TYPES: &[&str] = &[
    "send_email",
    "create_customer",
    "create_contact",
    "update_contact",
    "create_lead",
    "create_deal",
    "move_deal_stage",
    "log_activity",
    "create_task",
    "create_conversation",
    "send_notification",
    "post_chat_message",
    "http_request",
    "ai_generate",
    "ai_classify",
    "condition",
    "loop",
    "delay",
    "slack.post_message",
    "github.create_issue",
    "github.create_comment",
    "google_sheets.append_row",
    "google_sheets.update_row",
    "gmail.send_email",
    "google_calendar.create_event",
    "manual_step",
];

/// One `WorkflowIssue`; absent fields stay out of the JSON.
#[derive(Debug, Clone, Default)]
pub(crate) struct Issue {
    pub(crate) code: &'static str,
    pub(crate) trigger_id: Option<String>,
    pub(crate) step_id: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) field: Option<String>,
}

impl Issue {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            ..Self::default()
        }
    }

    fn trigger(code: &'static str, trigger_id: Option<&str>) -> Self {
        Self {
            code,
            trigger_id: trigger_id.map(str::to_owned),
            ..Self::default()
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".into(), json!(self.code));
        if let Some(v) = &self.trigger_id {
            out.insert("triggerId".into(), json!(v));
        }
        if let Some(v) = &self.step_id {
            out.insert("stepId".into(), json!(v));
        }
        if let Some(v) = &self.kind {
            out.insert("type".into(), json!(v));
        }
        if let Some(v) = &self.field {
            out.insert("field".into(), json!(v));
        }
        Value::Object(out)
    }
}

/// `trigger[key] ?? asBag(trigger.config)[key]`.
fn trigger_field<'a>(trigger: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match trigger.get(key) {
        Some(value) if !value.is_null() => Some(value),
        _ => bag(trigger.get("config")).get(key),
    }
}

fn string_id(map: &Map<String, Value>) -> Option<&str> {
    map.get("id").and_then(Value::as_str)
}

/// `isSequenceWorkflow(tags)`.
pub(crate) fn is_sequence_workflow(tags: Option<&Value>) -> bool {
    tags.and_then(Value::as_array).is_some_and(|tags| {
        tags.iter()
            .any(|t| t.as_str() == Some(SEQUENCE_WORKFLOW_TAG))
    })
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn valid_cron_field(field: &str, min: f64, max: f64) -> bool {
    if field == "*" {
        return true;
    }
    if let Some(step) = field.strip_prefix("*/") {
        if !is_digits(step) {
            return false;
        }
        let n: f64 = step.parse().unwrap_or(f64::NAN);
        return n >= 1.0 && n <= max;
    }
    field.split(',').all(|token| {
        if let Some((a, b)) = token.split_once('-')
            && is_digits(a)
            && is_digits(b)
        {
            let a: f64 = a.parse().unwrap_or(f64::NAN);
            let b: f64 = b.parse().unwrap_or(f64::NAN);
            return a >= min && b <= max && a <= b;
        }
        if !is_digits(token) {
            return false;
        }
        let n: f64 = token.parse().unwrap_or(f64::NAN);
        n >= min && n <= max
    })
}

/// `isValidCronExpression(expression)`.
pub(crate) fn is_valid_cron_expression(expression: &str) -> bool {
    const BOUNDS: [(f64, f64); 5] = [
        (0.0, 59.0),
        (0.0, 23.0),
        (1.0, 31.0),
        (1.0, 12.0),
        (0.0, 6.0),
    ];
    let fields: Vec<&str> = expression.split_whitespace().collect();
    fields.len() == 5
        && fields
            .iter()
            .zip(BOUNDS)
            .all(|(field, (min, max))| valid_cron_field(field, min, max))
}

fn blank(config: &Map<String, Value>, field: &str) -> bool {
    is_blank(config.get(field))
}

fn missing(config: &Map<String, Value>, fields: &[&'static str]) -> Vec<&'static str> {
    fields
        .iter()
        .copied()
        .filter(|f| blank(config, f))
        .collect()
}

/// `REQUIRED_ACTION_FIELDS[type](config)`.
fn required_fields(kind: &str, c: &Map<String, Value>) -> Vec<&'static str> {
    match kind {
        "send_email" | "gmail.send_email" => missing(c, &["to", "subject", "body"]),
        "create_customer" => missing(c, &["name"]),
        "http_request" => missing(c, &["url"]),
        "create_contact" => {
            if blank(c, "firstName") && blank(c, "lastName") && blank(c, "email") {
                vec!["name"]
            } else {
                vec![]
            }
        }
        "update_contact" => missing(c, &["contactId"]),
        "create_lead" => missing(c, &["email"]),
        "create_deal" => missing(c, &["name", "customerId"]),
        "move_deal_stage" => missing(c, &["dealId", "stageId"]),
        "log_activity" => missing(c, &["subject"]),
        "create_task" => missing(c, &["projectId", "title"]),
        "create_conversation" => missing(c, &["message"]),
        "send_notification" => missing(c, &["title"]),
        "post_chat_message" => {
            let mut out = missing(c, &["channelId"]);
            if blank(c, "message") && blank(c, "content") {
                out.push("message");
            }
            out
        }
        "ai_generate" => missing(c, &["prompt"]),
        "ai_classify" => {
            let mut out = Vec::new();
            if blank(c, "text") && blank(c, "input") {
                out.push("text");
            }
            let categories = match c.get("categories") {
                Some(v) if !v.is_null() => Some(v),
                _ => c.get("labels"),
            };
            if !categories
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                out.push("categories");
            }
            out
        }
        "condition" => {
            let mut out = missing(c, &["field"]);
            let operator = match c.get("operator") {
                Some(v) if !v.is_null() => as_text(Some(v)),
                _ => "eq".to_owned(),
            };
            if !c.get("branches").is_some_and(Value::is_array)
                && operator != "isEmpty"
                && operator != "isNotEmpty"
                && blank(c, "value")
            {
                out.push("value");
            }
            out
        }
        "loop" => missing(c, &["items"]),
        "delay" => {
            if ["seconds", "minutes", "hours", "days"]
                .iter()
                .any(|unit| js_number(c.get(*unit)) > 0.0)
            {
                vec![]
            } else {
                vec!["duration"]
            }
        }
        "slack.post_message" => missing(c, &["channel", "text"]),
        "github.create_issue" => missing(c, &["repo", "title"]),
        "github.create_comment" => missing(c, &["repo", "issueNumber", "body"]),
        "google_sheets.append_row" => missing(c, &["spreadsheetId", "columnMapping"]),
        "google_sheets.update_row" => {
            let mut out = missing(c, &["spreadsheetId", "columnMapping"]);
            let has_row = !blank(c, "rowNumber");
            let has_lookup = !blank(c, "lookupColumn") && !blank(c, "lookupValue");
            if !has_row && !has_lookup {
                out.push("rowNumber");
            }
            out
        }
        "google_calendar.create_event" => missing(c, &["summary", "startDateTime", "endDateTime"]),
        "manual_step" => missing(c, &["title"]),
        _ => vec![],
    }
}

/// `asText(step.type ?? '')`.
fn type_text(map: &Map<String, Value>) -> String {
    match map.get("type") {
        None | Some(Value::Null) => String::new(),
        other => as_text(other),
    }
}

/// `asText(step.id ?? '')`.
fn id_text(map: &Map<String, Value>) -> String {
    match map.get("id") {
        None | Some(Value::Null) => String::new(),
        other => as_text(other),
    }
}

fn branch_ids_of(step: &Map<String, Value>) -> Vec<String> {
    let id = id_text(step);
    match step.get("type").and_then(Value::as_str) {
        Some("loop") => vec![format!("{id}_each")],
        Some("condition") => match bag(step.get("config")).get("branches") {
            Some(Value::Array(branches)) => branches
                .iter()
                .map(|b| {
                    let value = match bag(Some(b)).get("value") {
                        None | Some(Value::Null) => String::new(),
                        other => as_text(other),
                    };
                    format!("{id}_branch_{value}")
                })
                .collect(),
            _ => vec![format!("{id}_if"), format!("{id}_if_not")],
        },
        _ => vec![],
    }
}

fn validate_branches(steps: &[&Map<String, Value>]) -> Vec<Issue> {
    let branch_ids: std::collections::HashSet<String> =
        steps.iter().flat_map(|s| branch_ids_of(s)).collect();
    let parents: std::collections::HashSet<&str> = steps
        .iter()
        .filter_map(|s| s.get("parentBranchId").and_then(Value::as_str))
        .filter(|p| !p.is_empty())
        .collect();
    let mut issues = Vec::new();
    for step in steps {
        let step_id = string_id(step).map(str::to_owned);
        let parent = step
            .get("parentBranchId")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        if let Some(parent) = parent
            && !branch_ids.contains(parent)
        {
            issues.push(Issue {
                code: "orphan_step",
                step_id: step_id.clone(),
                kind: Some(type_text(step)),
                ..Issue::default()
            });
        }
        if step.get("type").and_then(Value::as_str) == Some("loop")
            && !parents.contains(format!("{}_each", id_text(step)).as_str())
        {
            issues.push(Issue {
                code: "empty_loop",
                step_id: step_id.clone(),
                kind: Some("loop".into()),
                ..Issue::default()
            });
        }
        if type_text(step) == "manual_step" && parent.is_some() {
            issues.push(Issue {
                code: "nested_waiting_step",
                step_id,
                kind: Some(js_string(step.get("type"))),
                ..Issue::default()
            });
        }
    }
    issues
}

fn validate_entity_event(trigger: &Map<String, Value>, id: Option<&str>) -> Vec<Issue> {
    let entity_type = trigger_field(trigger, "entityType");
    let event_type = trigger_field(trigger, "eventType");
    if is_blank(entity_type) || is_blank(event_type) {
        return vec![Issue::trigger("incomplete_entity_event", id)];
    }
    if !is_known_action(&js_string(entity_type), &js_string(event_type)) {
        return vec![Issue::trigger("unknown_entity_event", id)];
    }
    vec![]
}

fn validate_one_time(trigger: &Map<String, Value>, id: Option<&str>) -> Vec<Issue> {
    let mut issues = Vec::new();
    let timezone = trigger_field(trigger, "timezone");
    let timezone_valid = match timezone {
        None => true,
        Some(Value::String(tz)) => is_valid_timezone(tz),
        Some(_) => false,
    };
    if !timezone_valid {
        issues.push(Issue::trigger("invalid_timezone", id));
    }
    let execute_at = match trigger_field(trigger, "executeAt") {
        Some(Value::String(text)) if !text.trim().is_empty() => text,
        _ => {
            issues.push(Issue::trigger("invalid_execute_at", id));
            return issues;
        }
    };
    let zone = match timezone {
        Some(Value::String(tz)) if timezone_valid => tz.as_str(),
        _ => "UTC",
    };
    let Some(at) = zoned_time_to_utc(execute_at, zone) else {
        issues.push(Issue::trigger("invalid_execute_at", id));
        return issues;
    };
    let now = i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(i64::MAX);
    if at <= now {
        issues.push(Issue::trigger("schedule_run_at_past", id));
    }
    issues
}

fn validate_schedule(trigger: &Map<String, Value>, id: Option<&str>) -> Vec<Issue> {
    let schedule_type = trigger_field(trigger, "scheduleType");
    if let Some(kind) = schedule_type
        && !SCHEDULE_TYPES.contains(&as_text(Some(kind)).as_str())
    {
        return vec![Issue::trigger("schedule_not_recurring", id)];
    }
    if schedule_type.and_then(Value::as_str) == Some("one_time") {
        return validate_one_time(trigger, id);
    }
    let mut issues = Vec::new();
    match trigger_field(trigger, "cronExpression") {
        Some(Value::String(cron)) if is_valid_cron_expression(cron) => {}
        _ => issues.push(Issue::trigger("invalid_cron", id)),
    }
    match trigger_field(trigger, "timezone") {
        None => {}
        Some(Value::String(tz)) if is_valid_timezone(tz) => {}
        Some(_) => issues.push(Issue::trigger("invalid_timezone", id)),
    }
    issues
}

fn validate_workflow_complete(
    trigger: &Map<String, Value>,
    id: Option<&str>,
    workflow_id: Option<&str>,
) -> Vec<Issue> {
    let mut issues = Vec::new();
    let source = trigger_field(trigger, "sourceWorkflowId");
    if is_blank(source) {
        issues.push(Issue::trigger("missing_source_workflow", id));
    } else if let Some(workflow_id) = workflow_id.filter(|w| !w.is_empty())
        && source.and_then(Value::as_str) == Some(workflow_id)
    {
        issues.push(Issue::trigger("self_chained_workflow", id));
    }
    let outcome = trigger_field(trigger, "triggerOn");
    if !is_blank(outcome)
        && !outcome
            .and_then(Value::as_str)
            .is_some_and(|o| WORKFLOW_COMPLETE_OUTCOMES.contains(&o))
    {
        issues.push(Issue::trigger("invalid_trigger_on", id));
    }
    issues
}

/// `workflowCompleteSourceIds(triggers)`: `(triggerId, sourceWorkflowId)`.
pub(crate) fn workflow_complete_sources(triggers: Option<&Value>) -> Vec<(Option<String>, String)> {
    let Some(Value::Array(triggers)) = triggers else {
        return vec![];
    };
    triggers
        .iter()
        .map(|t| bag(Some(t)))
        .filter(|t| t.get("type").and_then(Value::as_str) == Some("workflow_complete"))
        .filter(|t| !matches!(t.get("isEnabled"), Some(Value::Bool(false))))
        .filter_map(|t| {
            let source = trigger_field(t, "sourceWorkflowId")?.as_str()?;
            (!source.trim().is_empty())
                .then(|| (string_id(t).map(str::to_owned), source.to_owned()))
        })
        .collect()
}

fn validate_trigger(trigger: &Map<String, Value>, workflow_id: Option<&str>) -> Vec<Issue> {
    let id = string_id(trigger);
    let kind = type_text(trigger);
    if !TRIGGER_TYPES.contains(&kind.as_str()) {
        return vec![Issue {
            code: "unsupported_trigger",
            trigger_id: id.map(str::to_owned),
            kind: Some(kind),
            ..Issue::default()
        }];
    }
    match kind.as_str() {
        "entity_event" => validate_entity_event(trigger, id),
        "webhook" => vec![],
        "workflow_complete" => validate_workflow_complete(trigger, id, workflow_id),
        _ => validate_schedule(trigger, id),
    }
}

/// `step.config ?? step.inputs` as a bag.
fn step_config(step: &Map<String, Value>) -> &Map<String, Value> {
    match step.get("config") {
        Some(v) if !v.is_null() => bag(Some(v)),
        _ => bag(step.get("inputs")),
    }
}

fn validate_step(step: &Map<String, Value>) -> Vec<Issue> {
    let step_id = string_id(step).map(str::to_owned);
    let kind = type_text(step);
    if !ACTION_TYPES.contains(&kind.as_str()) {
        return vec![Issue {
            code: "unsupported_action",
            step_id,
            kind: Some(kind),
            ..Issue::default()
        }];
    }
    required_fields(&kind, step_config(step))
        .into_iter()
        .map(|field| Issue {
            code: "missing_field",
            step_id: step_id.clone(),
            kind: Some(kind.clone()),
            field: Some(field.to_owned()),
            ..Issue::default()
        })
        .collect()
}

/// `validateWeldConnectWorkflow({ triggers, steps }, { workflowId })`.
pub(crate) fn validate_workflow(
    triggers: Option<&Value>,
    steps: Option<&Value>,
    workflow_id: Option<&str>,
) -> Vec<Issue> {
    let triggers: Vec<&Map<String, Value>> = crate::js::array(triggers)
        .iter()
        .map(|t| bag(Some(t)))
        .filter(|t| !matches!(t.get("isEnabled"), Some(Value::Bool(false))))
        .collect();
    let steps: Vec<&Map<String, Value>> = crate::js::array(steps)
        .iter()
        .map(|s| bag(Some(s)))
        .collect();
    let mut issues = Vec::new();
    if triggers.is_empty() {
        issues.push(Issue::new("no_trigger"));
    }
    for trigger in &triggers {
        issues.extend(validate_trigger(trigger, workflow_id));
    }
    if steps.is_empty() {
        issues.push(Issue::new("no_steps"));
    }
    for step in &steps {
        issues.extend(validate_step(step));
    }
    issues.extend(validate_branches(&steps));
    issues
}

/// `validateWeldConnectIntegrations(steps, integrations)`; `integrations`
/// are `(id, type, status)` rows.
pub(crate) fn validate_integrations(
    steps: Option<&Value>,
    integrations: &[(String, String, String)],
) -> Vec<Issue> {
    let Some(Value::Array(steps)) = steps else {
        return vec![];
    };
    let mut issues = Vec::new();
    for raw in steps {
        let step = bag(Some(raw));
        let kind = type_text(step);
        let Some(dot) = kind.find('.').filter(|dot| *dot > 0) else {
            continue;
        };
        let provider = &kind[..dot];
        let integration_id = step_config(step)
            .get("integrationId")
            .and_then(Value::as_str);
        let mut candidates = integrations.iter().filter(|(_, t, _)| t == provider);
        let found = match integration_id {
            Some(id) => candidates.find(|(i, _, _)| i == id),
            None => candidates.next(),
        };
        if found.is_none_or(|(_, _, status)| status != "connected") {
            issues.push(Issue {
                code: "integration_not_connected",
                step_id: string_id(step).map(str::to_owned),
                kind: Some(kind.clone()),
                ..Issue::default()
            });
        }
    }
    issues
}

/// A schedule trigger's id, when it fits `workflow_schedules.trigger_id`.
fn schedule_like_id<'a>(trigger: &'a Map<String, Value>, kind: &str) -> Option<&'a str> {
    (trigger.get("type").and_then(Value::as_str) == Some(kind))
        .then(|| string_id(trigger))
        .flatten()
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 30)
}

fn trigger_name(trigger: &Map<String, Value>) -> Option<String> {
    trigger
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
}

/// `RecurringScheduleTrigger`.
pub(crate) struct RecurringTrigger {
    pub(crate) trigger_id: String,
    pub(crate) name: Option<String>,
    pub(crate) cron_expression: String,
    pub(crate) timezone: String,
    pub(crate) is_enabled: bool,
}

/// `recurringScheduleTriggers(triggers)`.
pub(crate) fn recurring_triggers(triggers: Option<&Value>) -> Vec<RecurringTrigger> {
    let mut out = Vec::new();
    for raw in crate::js::array(triggers) {
        let trigger = bag(Some(raw));
        let Some(id) = schedule_like_id(trigger, "schedule") else {
            continue;
        };
        let schedule_type = trigger_field(trigger, "scheduleType");
        if schedule_type.is_some() && schedule_type.and_then(Value::as_str) != Some("recurring") {
            continue;
        }
        let Some(Value::String(cron)) = trigger_field(trigger, "cronExpression") else {
            continue;
        };
        if !is_valid_cron_expression(cron) {
            continue;
        }
        let timezone = match trigger_field(trigger, "timezone") {
            Some(Value::String(tz)) if is_valid_timezone(tz) => tz.clone(),
            _ => "UTC".to_owned(),
        };
        out.push(RecurringTrigger {
            trigger_id: id.to_owned(),
            name: trigger_name(trigger),
            cron_expression: cron.trim().to_owned(),
            timezone,
            is_enabled: !matches!(trigger.get("isEnabled"), Some(Value::Bool(false))),
        });
    }
    out
}

/// `OneTimeScheduleTrigger` (`executeAt` in epoch ms).
pub(crate) struct OneTimeTrigger {
    pub(crate) trigger_id: String,
    pub(crate) name: Option<String>,
    pub(crate) execute_at: i64,
    pub(crate) timezone: String,
    pub(crate) is_enabled: bool,
}

/// `oneTimeScheduleTriggers(triggers)`.
pub(crate) fn one_time_triggers(triggers: Option<&Value>) -> Vec<OneTimeTrigger> {
    let mut out = Vec::new();
    for raw in crate::js::array(triggers) {
        let trigger = bag(Some(raw));
        let Some(id) = schedule_like_id(trigger, "schedule") else {
            continue;
        };
        if trigger_field(trigger, "scheduleType").and_then(Value::as_str) != Some("one_time") {
            continue;
        }
        let Some(Value::String(raw_at)) = trigger_field(trigger, "executeAt") else {
            continue;
        };
        if raw_at.trim().is_empty() {
            continue;
        }
        let timezone = match trigger_field(trigger, "timezone") {
            Some(Value::String(tz)) if is_valid_timezone(tz) => tz.clone(),
            _ => "UTC".to_owned(),
        };
        let Some(execute_at) = zoned_time_to_utc(raw_at, &timezone) else {
            continue;
        };
        out.push(OneTimeTrigger {
            trigger_id: id.to_owned(),
            name: trigger_name(trigger),
            execute_at,
            timezone,
            is_enabled: !matches!(trigger.get("isEnabled"), Some(Value::Bool(false))),
        });
    }
    out
}

/// `scheduleTriggerIds(triggers)`.
pub(crate) fn schedule_trigger_ids(triggers: Option<&Value>) -> Vec<String> {
    crate::js::array(triggers)
        .iter()
        .filter_map(|t| schedule_like_id(bag(Some(t)), "schedule").map(str::to_owned))
        .collect()
}

/// `WebhookTrigger`.
pub(crate) struct WebhookTrigger {
    pub(crate) trigger_id: String,
    pub(crate) name: Option<String>,
    pub(crate) is_enabled: bool,
}

/// `webhookTriggers(triggers)`.
pub(crate) fn webhook_triggers(triggers: Option<&Value>) -> Vec<WebhookTrigger> {
    crate::js::array(triggers)
        .iter()
        .filter_map(|raw| {
            let trigger = bag(Some(raw));
            let id = schedule_like_id(trigger, "webhook")?;
            Some(WebhookTrigger {
                trigger_id: id.to_owned(),
                name: trigger_name(trigger),
                is_enabled: !matches!(trigger.get("isEnabled"), Some(Value::Bool(false))),
            })
        })
        .collect()
}

/// `webhookTriggerIds(triggers)`.
pub(crate) fn webhook_trigger_ids(triggers: Option<&Value>) -> Vec<String> {
    crate::js::array(triggers)
        .iter()
        .filter_map(|t| schedule_like_id(bag(Some(t)), "webhook").map(str::to_owned))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gates_activation() {
        let triggers = json!([{ "id": "t1", "type": "manual" }]);
        let steps = json!([{ "id": "s1", "type": "ai_agent", "config": {} }]);
        let codes: Vec<&str> = validate_workflow(Some(&triggers), Some(&steps), None)
            .iter()
            .map(|i| i.code)
            .collect();
        assert_eq!(codes, ["unsupported_trigger", "unsupported_action"]);
        assert!(is_valid_cron_expression("*/15 9-17 * * 1-5"));
        assert!(!is_valid_cron_expression("0 24 * * *"));
        let ok = json!([{ "id": "t1", "type": "entity_event", "entityType": "person", "eventType": "created" }]);
        let send = json!([{ "id": "s", "type": "send_email", "config": { "to": "a", "subject": "b", "body": "c" } }]);
        assert!(validate_workflow(Some(&ok), Some(&send), None).is_empty());
    }
}
