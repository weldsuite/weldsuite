//! The engine's pure helpers (`workflow-worker/src/engine/`): input
//! templates (`resolve-inputs.ts`), step conditions
//! (`evaluate-condition.ts`), the step tree (`step-tree.ts`) and the
//! trigger data a run sees (`trigger-data.ts`).

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::js::{as_text, js_number, js_string};

/// `obj?.[prop]` along `props`.
pub(crate) fn get_path<'a>(root: Option<&'a Value>, props: &[&str]) -> Option<&'a Value> {
    let mut current = root;
    for prop in props {
        current = match current? {
            Value::Object(map) => map.get(*prop),
            Value::Array(items) => prop.parse::<usize>().ok().and_then(|i| items.get(i)),
            _ => None,
        };
    }
    current
}

/// The values a template or a condition reads.
pub(crate) struct Scope<'a> {
    pub(crate) previous_results: &'a Map<String, Value>,
    pub(crate) trigger_data: &'a Value,
    pub(crate) variables: &'a Map<String, Value>,
    pub(crate) contact_data: &'a Map<String, Value>,
    /// The loop's item and index, inside a loop.
    pub(crate) iteration: Option<(&'a Value, usize)>,
}

/// `lookupTemplatePath(path, scope)`; `Err` stands for `undefined`.
fn lookup(path: &str, scope: &Scope<'_>) -> Option<Value> {
    if let Some(rest) = path.strip_prefix("steps.") {
        let mut parts = rest.split('.');
        let step_id = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        return get_path(scope.previous_results.get(step_id), &props).cloned();
    }
    if let Some(rest) = path.strip_prefix("trigger.") {
        let props: Vec<&str> = rest.split('.').collect();
        return get_path(Some(scope.trigger_data), &props).cloned();
    }
    if let Some(name) = path.strip_prefix("variables.") {
        return scope.variables.get(name).cloned();
    }
    if let Some(name) = path.strip_prefix("contact.") {
        return scope.contact_data.get(name).cloned();
    }
    if let (Some(rest), Some((item, index))) = (path.strip_prefix("loop."), scope.iteration) {
        let mut parts = rest.split('.');
        let prop = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        if prop == "index" {
            return Some(json!(index));
        }
        if prop == "item" {
            return get_path(Some(item), &props).cloned();
        }
    }
    None
}

/// `escapeHtml(value)`.
pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `stringifyForTemplate(value)`.
fn stringify(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => crate::js::json_text(value),
        other => as_text(Some(other)),
    }
}

fn template_pattern() -> &'static Regex {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\{\{([^{}]+)\}\}").expect("a valid pattern"))
}

fn whole_template() -> &'static Regex {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\{\{[^{}]+\}\}$").expect("a valid pattern"))
}

fn resolve_string(value: &str, scope: &Scope<'_>, escape: bool) -> Value {
    if !(value.contains("{{") && value.contains("}}")) {
        return Value::String(value.to_owned());
    }
    let escaped = |text: String| if escape { escape_html(&text) } else { text };
    let replaced = template_pattern().replace_all(value, |caps: &regex::Captures<'_>| {
        if let Some(result) = lookup(caps[1].trim(), scope) {
            escaped(stringify(&result))
        } else {
            tracing::warn!("Unresolved template: {}", &caps[0]);
            String::new()
        }
    });
    let mut resolved = Value::String(replaced.into_owned());
    if whole_template().is_match(value)
        && let Some(result) = lookup(value[2..value.len() - 2].trim(), scope)
    {
        resolved = match result {
            Value::String(text) => Value::String(escaped(text)),
            other => other,
        };
    }
    resolved
}

/// `resolveNestedInput(value, scope)`: objects and arrays inside a step's
/// inputs resolve without HTML escaping. An array nested in an array
/// resolves to an object keyed by index, as `Object.entries` reads it.
fn resolve_nested(value: &Value, scope: &Scope<'_>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::Object(map) => Value::Object(resolve_inputs(map, scope, &[])),
                    Value::Array(inner) => {
                        Value::Object(resolve_inputs(&entries(inner), scope, &[]))
                    }
                    other => other.clone(),
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(resolve_inputs(map, scope, &[])),
        other => other.clone(),
    }
}

/// An array as `Object.entries` sees it: keyed by index.
fn entries(items: &[Value]) -> Map<String, Value> {
    items
        .iter()
        .enumerate()
        .map(|(i, item)| (i.to_string(), item.clone()))
        .collect()
}

/// `resolveInputs(inputs, …, { escapeHtmlKeys, loop })`.
pub(crate) fn resolve_inputs(
    inputs: &Map<String, Value>,
    scope: &Scope<'_>,
    escape_html_keys: &[&str],
) -> Map<String, Value> {
    inputs
        .iter()
        .map(|(key, value)| {
            let resolved = match value {
                Value::String(text) => {
                    resolve_string(text, scope, escape_html_keys.contains(&key.as_str()))
                }
                other => resolve_nested(other, scope),
            };
            (key.clone(), resolved)
        })
        .collect()
}

/// `===` between JSON values (objects and arrays are never the same object).
pub(crate) fn strict_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `Array.prototype.includes` (`SameValueZero`).
fn includes(items: &[Value], value: Option<&Value>) -> bool {
    items.iter().any(|item| {
        strict_equals(Some(item), value)
            || matches!((item, value), (Value::Number(a), Some(Value::Number(b)))
                if a.as_f64().is_some_and(f64::is_nan) && b.as_f64().is_some_and(f64::is_nan))
    })
}

/// `evaluateCondition(condition, previousResults, triggerData, variables,
/// contactData)`: a step's own `condition`. A missing field or operator
/// fails closed.
pub(crate) fn evaluate_condition(condition: &Value, scope: &Scope<'_>) -> bool {
    let field = condition.get("field");
    let operator = condition.get("operator");
    if !crate::js::truthy(field.unwrap_or(&Value::Null))
        || !crate::js::truthy(operator.unwrap_or(&Value::Null))
    {
        tracing::warn!("Condition missing field or operator, failing closed");
        return false;
    }
    let field_text = js_string(field);
    let owned;
    let field_value: Option<&Value> = if let Some(rest) = field_text.strip_prefix("steps.") {
        let mut parts = rest.split('.');
        let step_id = parts.next().unwrap_or_default();
        let props: Vec<&str> = parts.collect();
        get_path(scope.previous_results.get(step_id), &props)
    } else if let Some(rest) = field_text.strip_prefix("trigger.") {
        let props: Vec<&str> = rest.split('.').collect();
        get_path(Some(scope.trigger_data), &props)
    } else if let Some(name) = field_text.strip_prefix("variables.") {
        scope.variables.get(name)
    } else if let Some(name) = field_text.strip_prefix("contact.") {
        scope.contact_data.get(name)
    } else {
        owned = field.cloned();
        owned.as_ref()
    };
    let value = condition.get("value");
    let number = |v: Option<&Value>| js_number(v);
    let text = |v: Option<&Value>| js_string(v);
    match operator.and_then(Value::as_str).unwrap_or_default() {
        "eq" | "equals" => strict_equals(field_value, value),
        "neq" | "not_equals" => !strict_equals(field_value, value),
        "gt" | "greater_than" => number(field_value) > number(value),
        "gte" | "greater_than_or_equals" => number(field_value) >= number(value),
        "lt" | "less_than" => number(field_value) < number(value),
        "lte" | "less_than_or_equals" => number(field_value) <= number(value),
        "contains" => text(field_value).contains(&text(value)),
        "starts_with" => text(field_value).starts_with(&text(value)),
        "ends_with" => text(field_value).ends_with(&text(value)),
        "exists" => !matches!(field_value, None | Some(Value::Null)),
        "not_exists" => matches!(field_value, None | Some(Value::Null)),
        "in" => matches!(value, Some(Value::Array(items)) if includes(items, field_value)),
        "not_in" => !matches!(value, Some(Value::Array(items)) if includes(items, field_value)),
        "matches" => {
            super::actions::js_regex(&text(value)).is_ok_and(|re| re.is_match(&text(field_value)))
        }
        other => {
            tracing::warn!("Unknown operator: {other}");
            false
        }
    }
}

// ── The step tree ───────────────────────────────────────────────────────────

pub(crate) fn if_branch_id(step_id: &str) -> String {
    format!("{step_id}_if")
}

pub(crate) fn if_not_branch_id(step_id: &str) -> String {
    format!("{step_id}_if_not")
}

pub(crate) fn value_branch_id(step_id: &str, value: &str) -> String {
    format!("{step_id}_branch_{value}")
}

pub(crate) fn loop_body_id(step_id: &str) -> String {
    format!("{step_id}_each")
}

/// `conditionBranches(step)`: a value-branching condition's branches.
pub(crate) fn condition_branches(step: &Value) -> Option<&Vec<Value>> {
    step.get("config")?.get("branches")?.as_array()
}

pub(crate) fn step_id(step: &Value) -> String {
    js_string(step.get("id"))
}

pub(crate) fn step_type(step: &Value) -> String {
    js_string(step.get("type"))
}

/// `branchIdsOf(step)`.
pub(crate) fn branch_ids_of(step: &Value) -> Vec<String> {
    let id = step_id(step);
    match step_type(step).as_str() {
        "loop" => vec![loop_body_id(&id)],
        "condition" => match condition_branches(step) {
            Some(branches) => branches
                .iter()
                .map(|b| value_branch_id(&id, &js_string(b.get("value"))))
                .collect(),
            None => vec![if_branch_id(&id), if_not_branch_id(&id)],
        },
        _ => Vec::new(),
    }
}

/// `buildStepTree(steps)`: the main sequence and each branch's steps, by
/// index, in order.
pub(crate) struct StepTree {
    pub(crate) main: Vec<usize>,
    pub(crate) branches: std::collections::HashMap<String, Vec<usize>>,
}

pub(crate) fn build_step_tree(steps: &[Value]) -> StepTree {
    let mut tree = StepTree {
        main: Vec::new(),
        branches: std::collections::HashMap::new(),
    };
    for (index, step) in steps.iter().enumerate() {
        match step.get("parentBranchId") {
            Some(parent) if crate::js::truthy(parent) => tree
                .branches
                .entry(js_string(Some(parent)))
                .or_default()
                .push(index),
            _ => tree.main.push(index),
        }
    }
    tree
}

/// `stepsUnderBranch(tree, steps, branchId)`: every step a branch holds,
/// nested branches included.
pub(crate) fn steps_under_branch(tree: &StepTree, steps: &[Value], branch_id: &str) -> Vec<usize> {
    let mut result = Vec::new();
    for &index in tree.branches.get(branch_id).map_or(&[][..], Vec::as_slice) {
        result.push(index);
        for child in branch_ids_of(&steps[index]) {
            result.extend(steps_under_branch(tree, steps, &child));
        }
    }
    result
}

// ── Trigger data ────────────────────────────────────────────────────────────

/// What `buildTriggerData` stamps on a run's trigger data.
pub(crate) struct TriggerMeta<'a> {
    pub(crate) user_id: &'a str,
    pub(crate) workspace_id: &'a str,
    pub(crate) workflow_id: &'a str,
    pub(crate) workflow_name: &'a str,
    pub(crate) execution_id: &'a str,
    /// Milliseconds since the epoch.
    pub(crate) started_at: i64,
}

const MINUTE_MS: i64 = 60_000;

/// `scheduledSlot(raw, fallback)`: the minute a scheduled run is for.
pub(crate) fn scheduled_slot(raw: Option<&Value>, fallback: i64) -> i64 {
    let parsed = match raw {
        Some(Value::String(text)) => crate::cron::parse_ms(text),
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).map(|f| {
            #[allow(clippy::cast_possible_truncation)]
            let ms = f.trunc() as i64;
            ms
        }),
        _ => None,
    };
    parsed.unwrap_or(fallback).div_euclid(MINUTE_MS) * MINUTE_MS
}

/// `formatLocalMinute(at, timeZone)`: `YYYY-MM-DD HH:mm` on the wall clock
/// of `timeZone` (UTC when it is missing or unknown).
pub(crate) fn format_local_minute(at_ms: i64, time_zone: Option<&Value>) -> String {
    let zone = time_zone
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|z| !z.is_empty())
        .unwrap_or("UTC");
    let tz = jiff::tz::TimeZone::get(zone).unwrap_or(jiff::tz::TimeZone::UTC);
    let Ok(timestamp) = jiff::Timestamp::from_millisecond(at_ms) else {
        return String::new();
    };
    timestamp
        .to_zoned(tz)
        .strftime("%Y-%m-%d %H:%M")
        .to_string()
}

/// `buildTriggerData(triggerType, raw, meta)`.
pub(crate) fn build_trigger_data(
    trigger_type: &str,
    raw: Option<&Value>,
    meta: &TriggerMeta<'_>,
) -> Value {
    let mut base = match raw {
        Some(Value::Object(map)) => map.clone(),
        other => {
            let mut map = Map::new();
            if let Some(value) = other {
                map.insert("data".into(), value.clone());
            }
            map
        }
    };
    let mut aliases = Map::new();
    match trigger_type {
        "entity_event" => {
            let record = base.get("data").and_then(Value::as_object).cloned();
            let changes = base.get("changes").and_then(Value::as_object).cloned();
            insert_defined(&mut aliases, "entity", base.get("entityType"));
            insert_defined(&mut aliases, "event", base.get("action"));
            insert_defined(&mut aliases, "recordId", base.get("entityId"));
            aliases.insert(
                "record".into(),
                Value::Object(record.clone().unwrap_or_default()),
            );
            if let (Some(record), Some(changes)) = (record, changes) {
                let mut previous = record;
                for (field, change) in changes {
                    match change.get("old") {
                        Some(old) => previous.insert(field, old.clone()),
                        None => previous.remove(&field),
                    };
                }
                aliases.insert("previousRecord".into(), Value::Object(previous));
            }
        }
        "schedule" => {
            let slot = scheduled_slot(base.get("scheduledTime"), meta.started_at);
            aliases.insert("scheduledTime".into(), json!(crate::cron::iso(slot)));
            aliases.insert(
                "scheduledTimeLocal".into(),
                json!(format_local_minute(slot, base.get("timezone"))),
            );
            aliases.insert("runId".into(), json!(meta.execution_id));
        }
        "manual" => {
            aliases.insert("timestamp".into(), json!(crate::cron::iso(meta.started_at)));
        }
        _ => {}
    }
    let mut out = aliases;
    out.append(&mut base);
    out.insert("userId".into(), json!(meta.user_id));
    out.insert("workspaceId".into(), json!(meta.workspace_id));
    out.insert("triggerType".into(), json!(trigger_type));
    out.insert("workflowId".into(), json!(meta.workflow_id));
    out.insert("workflowName".into(), json!(meta.workflow_name));
    out.insert("executionId".into(), json!(meta.execution_id));
    Value::Object(out)
}

/// `{ key: value }` unless `value` is `undefined` (JSON drops it).
fn insert_defined(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn scope<'a>(
        output: &'a Map<String, Value>,
        trigger: &'a Value,
        variables: &'a Map<String, Value>,
        contact: &'a Map<String, Value>,
    ) -> Scope<'a> {
        Scope {
            previous_results: output,
            trigger_data: trigger,
            variables,
            contact_data: contact,
            iteration: None,
        }
    }

    #[test]
    fn templates_resolve_whole_values_and_strings() {
        let output: Map<String, Value> =
            serde_json::from_value(json!({ "s1": { "count": 3, "list": [1, 2] } })).unwrap();
        let trigger = json!({ "data": { "name": "<Ann>" } });
        let variables: Map<String, Value> =
            serde_json::from_value(json!({ "a.b": "dotted" })).unwrap();
        let contact = Map::new();
        let s = scope(&output, &trigger, &variables, &contact);
        let inputs: Map<String, Value> = serde_json::from_value(json!({
            "n": "{{steps.s1.count}}",
            "t": "Hi {{trigger.data.name}} ({{steps.s1.list}}) {{missing.x}}",
            "body": "{{trigger.data.name}}",
            "v": "{{variables.a.b}}",
            "nested": { "x": "{{steps.s1.count}}" },
        }))
        .unwrap();
        let resolved = resolve_inputs(&inputs, &s, &["body"]);
        assert_eq!(resolved["n"], json!(3));
        assert_eq!(resolved["t"], json!("Hi <Ann> ([1,2]) "));
        assert_eq!(resolved["body"], json!("&lt;Ann&gt;"));
        assert_eq!(resolved["v"], json!("dotted"));
        assert_eq!(resolved["nested"], json!({ "x": 3 }));
    }

    #[test]
    fn conditions_compare_like_javascript() {
        let output: Map<String, Value> =
            serde_json::from_value(json!({ "s1": { "n": "5" } })).unwrap();
        let trigger = json!({ "status": "open" });
        let empty = Map::new();
        let s = scope(&output, &trigger, &empty, &empty);
        let check = |c: Value| evaluate_condition(&c, &s);
        assert!(check(
            json!({ "field": "trigger.status", "operator": "eq", "value": "open" })
        ));
        assert!(!check(
            json!({ "field": "steps.s1.n", "operator": "eq", "value": 5 })
        ));
        assert!(check(
            json!({ "field": "steps.s1.n", "operator": "gt", "value": 4 })
        ));
        assert!(check(
            json!({ "field": "trigger.none", "operator": "not_exists" })
        ));
        assert!(check(
            json!({ "field": "trigger.status", "operator": "in", "value": ["open", "x"] })
        ));
        assert!(!check(json!({ "field": "trigger.status" })));
    }

    #[test]
    fn trigger_data_aliases_entity_events() {
        let meta = TriggerMeta {
            user_id: "u",
            workspace_id: "w",
            workflow_id: "wf",
            workflow_name: "Flow",
            execution_id: "ex",
            started_at: 1_790_000_000_000,
        };
        let data = build_trigger_data(
            "entity_event",
            Some(&json!({
                "entityType": "company",
                "action": "updated",
                "entityId": "c1",
                "data": { "status": "won", "name": "Acme" },
                "changes": { "status": { "old": "open", "new": "won" } },
            })),
            &meta,
        );
        assert_eq!(data["record"]["status"], json!("won"));
        assert_eq!(data["previousRecord"]["status"], json!("open"));
        assert_eq!(data["recordId"], json!("c1"));
        assert_eq!(data["triggerType"], json!("entity_event"));
        assert_eq!(
            format_local_minute(1_790_000_000_000, Some(&json!("Europe/Amsterdam"))),
            "2026-09-21 16:13"
        );
    }
}
