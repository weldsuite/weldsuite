//! The request bodies of `@weldsuite/app-api-client/schemas/weldconnect`
//! (`createWorkflowSchema`, `createTemplateSchema`, …), read as Zod reads
//! them: known keys only, defaults filled in, issues in the schema's order.
//!
//! `triggers` and `steps` are `z.array(z.union([tight, z.record(z.unknown())]))`:
//! an item the tight schema accepts comes out as Zod parses it (unknown keys
//! dropped, defaults filled in), any other object as it came.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

type Object = Map<String, Value>;

fn object(value: Option<&Value>) -> Option<&Object> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// A field a tight schema reads: `Ok(None)` when absent and allowed to be.
type Read = Result<Option<Value>, ()>;

fn string(map: &Object, key: &str, optional: bool, min: usize) -> Read {
    match map.get(key) {
        None if optional => Ok(None),
        Some(Value::String(text)) if text.encode_utf16().count() >= min => {
            Ok(Some(Value::String(text.clone())))
        }
        _ => Err(()),
    }
}

fn number(map: &Object, key: &str, optional: bool) -> Read {
    match map.get(key) {
        None if optional => Ok(None),
        Some(n @ Value::Number(_)) => Ok(Some(n.clone())),
        _ => Err(()),
    }
}

fn boolean(map: &Object, key: &str, default: Option<bool>) -> Read {
    match (map.get(key), default) {
        (None, Some(default)) => Ok(Some(Value::Bool(default))),
        (None, None) => Ok(None),
        (Some(b @ Value::Bool(_)), _) => Ok(Some(b.clone())),
        _ => Err(()),
    }
}

fn choice(
    map: &Object,
    key: &str,
    options: &[&str],
    default: Option<&str>,
    optional: bool,
) -> Read {
    match map.get(key) {
        None => match default {
            Some(default) => Ok(Some(json!(default))),
            None if optional => Ok(None),
            None => Err(()),
        },
        Some(Value::String(text)) if options.contains(&text.as_str()) => Ok(Some(json!(text))),
        _ => Err(()),
    }
}

fn literal(map: &Object, key: &str, expected: &str) -> Read {
    match map.get(key) {
        Some(Value::String(text)) if text == expected => Ok(Some(json!(text))),
        _ => Err(()),
    }
}

/// `z.record(z.unknown())`, `.default({})` when `default`.
fn record(map: &Object, key: &str, default: bool) -> Read {
    match map.get(key) {
        None if default => Ok(Some(json!({}))),
        None => Ok(None),
        Some(o @ Value::Object(_)) => Ok(Some(o.clone())),
        _ => Err(()),
    }
}

/// `z.unknown()`.
fn unknown(map: &Object, key: &str) -> Read {
    Ok(map.get(key).cloned())
}

fn filter(item: &Value) -> Option<Value> {
    let map = object(Some(item))?;
    let mut out = Object::new();
    put(&mut out, "field", string(map, "field", false, 0)).ok()?;
    put(&mut out, "operator", string(map, "operator", false, 0)).ok()?;
    put(&mut out, "value", unknown(map, "value")).ok()?;
    Some(Value::Object(out))
}

fn array_of(map: &Object, key: &str, read: impl Fn(&Value) -> Option<Value>) -> Read {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(&read)
            .collect::<Option<Vec<_>>>()
            .map(|items| Some(Value::Array(items)))
            .ok_or(()),
        _ => Err(()),
    }
}

fn put(out: &mut Object, key: &str, read: Read) -> Result<(), ()> {
    if let Some(value) = read? {
        out.insert(key.to_owned(), value);
    }
    Ok(())
}

/// One trigger config option, as `(key, reader)` pairs.
fn parse_object(map: &Object, fields: &[(&str, &dyn Fn(&Object, &str) -> Read)]) -> Option<Value> {
    let mut out = Object::new();
    for (key, read) in fields {
        put(&mut out, key, read(map, key)).ok()?;
    }
    Some(Value::Object(out))
}

const EVENT_TYPES: &[&str] = &[
    "created",
    "updated",
    "deleted",
    "status_changed",
    "assigned",
    "tagged",
    "priority_changed",
    "sla_breached",
];

/// The trigger `config` union; `None` when no option (the record included)
/// accepts it.
fn trigger_config(value: Option<&Value>) -> Option<Value> {
    let map = object(value)?;
    let options: [&[(&str, &dyn Fn(&Object, &str) -> Read)]; 6] = [
        &[
            ("type", &|m, k| literal(m, k, "schedule")),
            ("scheduleType", &|m, k| {
                choice(m, k, &["recurring", "one_time"], Some("recurring"), false)
            }),
            ("cronExpression", &|m, k| string(m, k, true, 1)),
            ("executeAt", &|m, k| string(m, k, true, 0)),
            ("timezone", &|m, k| match m.get(k) {
                None => Ok(Some(json!("UTC"))),
                _ => string(m, k, false, 0),
            }),
            ("startDate", &|m, k| string(m, k, true, 0)),
            ("endDate", &|m, k| string(m, k, true, 0)),
        ],
        &[
            ("type", &|m, k| literal(m, k, "entity_event")),
            ("entityType", &|m, k| string(m, k, false, 1)),
            ("eventType", &|m, k| choice(m, k, EVENT_TYPES, None, false)),
            ("filters", &|m, k| array_of(m, k, filter)),
            ("channels", &|m, k| {
                array_of(m, k, |v| v.is_string().then(|| v.clone()))
            }),
            ("audience", &|m, k| string(m, k, true, 0)),
        ],
        &[
            ("type", &|m, k| literal(m, k, "integration_event")),
            ("provider", &|m, k| string(m, k, false, 1)),
            ("event", &|m, k| string(m, k, false, 1)),
            ("integrationId", &|m, k| string(m, k, true, 0)),
            ("filters", &|m, k| array_of(m, k, filter)),
        ],
        &[
            ("type", &|m, k| literal(m, k, "webhook")),
            ("method", &|m, k| {
                choice(m, k, &["GET", "POST", "PUT", "DELETE"], Some("POST"), false)
            }),
            ("headers", &|m, k| match m.get(k) {
                None => Ok(None),
                Some(Value::Object(h)) if h.values().all(Value::is_string) => {
                    Ok(Some(Value::Object(h.clone())))
                }
                _ => Err(()),
            }),
            ("validateSignature", &|m, k| boolean(m, k, None)),
            ("signatureHeader", &|m, k| string(m, k, true, 0)),
        ],
        &[
            ("type", &|m, k| literal(m, k, "manual")),
            ("inputSchema", &|m, k| record(m, k, false)),
        ],
        &[
            ("type", &|m, k| literal(m, k, "workflow_complete")),
            ("sourceWorkflowId", &|m, k| string(m, k, false, 1)),
            ("triggerOn", &|m, k| {
                choice(
                    m,
                    k,
                    &["success", "failure", "both"],
                    Some("success"),
                    false,
                )
            }),
            ("passOutput", &|m, k| boolean(m, k, None)),
        ],
    ];
    options
        .iter()
        .find_map(|fields| parse_object(map, fields))
        .or_else(|| Some(Value::Object(map.clone())))
}

const TRIGGER_CATEGORIES: &[&str] = &[
    "schedule",
    "entity_event",
    "integration_event",
    "webhook",
    "manual",
    "api",
    "workflow_complete",
];

/// `triggerConfigSchema.safeParse(item)`.
fn tight_trigger(map: &Object) -> Option<Value> {
    let mut out = Object::new();
    put(&mut out, "id", string(map, "id", false, 1)).ok()?;
    put(
        &mut out,
        "type",
        choice(map, "type", TRIGGER_CATEGORIES, None, false),
    )
    .ok()?;
    put(&mut out, "name", string(map, "name", false, 1)).ok()?;
    put(&mut out, "isEnabled", boolean(map, "isEnabled", Some(true))).ok()?;
    out.insert("config".into(), trigger_config(map.get("config"))?);
    Some(Value::Object(out))
}

fn nested(map: &Object, key: &str, read: impl Fn(&Object) -> Option<Value>) -> Read {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Object(inner)) => read(inner).map(Some).ok_or(()),
        _ => Err(()),
    }
}

/// `workflowStepSchema.safeParse(item)`.
fn tight_step(map: &Object) -> Option<Value> {
    let mut out = Object::new();
    put(&mut out, "id", string(map, "id", false, 1)).ok()?;
    put(&mut out, "type", string(map, "type", false, 1)).ok()?;
    put(&mut out, "name", string(map, "name", false, 1)).ok()?;
    put(&mut out, "description", string(map, "description", true, 0)).ok()?;
    put(&mut out, "order", number(map, "order", true)).ok()?;
    put(&mut out, "config", record(map, "config", true)).ok()?;
    put(&mut out, "inputs", record(map, "inputs", true)).ok()?;
    put(&mut out, "outputs", record(map, "outputs", false)).ok()?;
    put(
        &mut out,
        "condition",
        nested(map, "condition", |c| {
            let mut o = Object::new();
            put(&mut o, "field", string(c, "field", false, 0)).ok()?;
            put(&mut o, "operator", string(c, "operator", false, 0)).ok()?;
            put(&mut o, "value", unknown(c, "value")).ok()?;
            Some(Value::Object(o))
        }),
    )
    .ok()?;
    put(
        &mut out,
        "onError",
        nested(map, "onError", |c| {
            let mut o = Object::new();
            put(
                &mut o,
                "action",
                choice(
                    c,
                    "action",
                    &["stop", "continue", "retry", "goto"],
                    None,
                    false,
                ),
            )
            .ok()?;
            put(&mut o, "retryCount", number(c, "retryCount", true)).ok()?;
            put(&mut o, "gotoStep", string(c, "gotoStep", true, 0)).ok()?;
            Some(Value::Object(o))
        }),
    )
    .ok()?;
    put(
        &mut out,
        "position",
        nested(map, "position", |c| {
            let mut o = Object::new();
            put(&mut o, "x", number(c, "x", false)).ok()?;
            put(&mut o, "y", number(c, "y", false)).ok()?;
            Some(Value::Object(o))
        }),
    )
    .ok()?;
    put(&mut out, "timeout", number(map, "timeout", true)).ok()?;
    put(
        &mut out,
        "retryPolicy",
        nested(map, "retryPolicy", |c| {
            let mut o = Object::new();
            put(&mut o, "maxAttempts", number(c, "maxAttempts", false)).ok()?;
            put(&mut o, "delayMs", number(c, "delayMs", false)).ok()?;
            put(
                &mut o,
                "backoffMultiplier",
                number(c, "backoffMultiplier", true),
            )
            .ok()?;
            Some(Value::Object(o))
        }),
    )
    .ok()?;
    put(
        &mut out,
        "continueOnError",
        boolean(map, "continueOnError", None),
    )
    .ok()?;
    put(
        &mut out,
        "parentBranchId",
        string(map, "parentBranchId", true, 0),
    )
    .ok()?;
    Some(Value::Object(out))
}

/// Zod's `invalid_union` for an item neither option accepts (not an object).
fn union_issue(issues: &mut Issues, item: &Value) {
    let received = match item {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    // The item's own path: `path_of` appends a key to it.
    let path = match issues.path_of("") {
        Value::Array(mut path) => {
            path.pop();
            Value::Array(path)
        }
        other => other,
    };
    let option = json!({ "issues": [{
        "code": "invalid_type",
        "expected": "object",
        "received": received,
        "path": path,
        "message": format!("Expected object, received {received}"),
    }], "name": "ZodError" });
    issues.issue_here(json!({
        "code": "invalid_union",
        "unionErrors": [option.clone(), option],
        "message": "Invalid input",
    }));
}

/// `z.array(z.union([tight, z.record(z.unknown())])).optional()`.
fn loose_list(
    issues: &mut Issues,
    body: &Object,
    key: &str,
    tight: fn(&Object) -> Option<Value>,
) -> Field<Vec<Value>> {
    issues.list(
        body,
        key,
        Presence::Optional,
        None,
        None,
        |issues, item| match item {
            Value::Object(map) => Some(tight(map).unwrap_or_else(|| item.clone())),
            other => {
                union_issue(issues, other);
                None
            }
        },
    )
}

/// `workflowSettingsSchema.passthrough().optional()`: the settings as sent,
/// once the known keys check out.
fn settings(issues: &mut Issues, body: &Object) -> Field<Value> {
    let read = issues.nested(body, "settings", Presence::Optional, |issues, s| {
        let num = Number::default();
        issues.number(s, "timeout", Presence::Optional, num);
        issues.number(s, "maxRetries", Presence::Optional, num);
        issues.number(s, "retryDelay", Presence::Optional, num);
        issues.choice(
            s,
            "logLevel",
            Presence::Optional,
            &["debug", "info", "warn", "error"],
        );
        issues.boolean(s, "notifyOnComplete", Presence::Optional);
        issues.boolean(s, "notifyOnError", Presence::Optional);
        issues.list(
            s,
            "notifyEmails",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        );
        issues.text(s, "timezone", Presence::Optional, None, None);
        for (key, max) in [
            ("maxCreditsPerRun", 100_000.0),
            ("maxConcurrentRuns", 10_000.0),
        ] {
            issues.number(
                s,
                key,
                Presence::Nullish,
                Number {
                    coerce: false,
                    int: true,
                    min: Some(1.0),
                    max: Some(max),
                },
            );
        }
    });
    match read {
        Field::Set(()) => body
            .get("settings")
            .cloned()
            .map_or(Field::Absent, Field::Set),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

fn tags(issues: &mut Issues, body: &Object) -> Field<Vec<String>> {
    issues.list(
        body,
        "tags",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    )
}

/// `createWorkflowSchema` (`partial` for the update: no defaults).
#[derive(Debug, Default)]
pub(crate) struct WorkflowBody {
    pub(crate) name: Field<String>,
    pub(crate) description: Field<String>,
    pub(crate) status: Field<String>,
    pub(crate) triggers: Field<Vec<Value>>,
    pub(crate) steps: Field<Vec<Value>>,
    pub(crate) settings: Field<Value>,
    pub(crate) tags: Field<Vec<String>>,
    pub(crate) folder_id: Field<String>,
}

/// `createWorkflowSchema` (`partial` false) or `updateWorkflowSchema`.
pub(crate) fn workflow_body(issues: &mut Issues, body: &Object, partial: bool) -> WorkflowBody {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let name = issues.text(body, "name", required, Some(1), Some(255));
    let description = issues.text(body, "description", Presence::Nullish, None, None);
    let mut status = issues.choice(
        body,
        "status",
        Presence::Optional,
        &["draft", "active", "paused"],
    );
    if !partial && status.is_absent() && !body.contains_key("status") {
        status = Field::Set("draft".into());
    }
    let triggers = loose_list(issues, body, "triggers", tight_trigger);
    let steps = loose_list(issues, body, "steps", tight_step);
    let settings = settings(issues, body);
    let tags = tags(issues, body);
    let folder_id = issues.text(body, "folderId", Presence::Nullish, None, None);
    WorkflowBody {
        name,
        description,
        status,
        triggers,
        steps,
        settings,
        tags,
        folder_id,
    }
}

/// `createTemplateSchema` (`partial` for the update).
#[derive(Debug, Default)]
pub(crate) struct TemplateBody {
    pub(crate) name: Field<String>,
    pub(crate) description: Field<String>,
    pub(crate) category: Field<String>,
    pub(crate) difficulty: Field<String>,
    pub(crate) triggers: Field<Vec<Value>>,
    pub(crate) steps: Field<Vec<Value>>,
    pub(crate) settings: Field<Value>,
    pub(crate) tags: Field<Vec<String>>,
    pub(crate) icon: Field<String>,
}

pub(crate) fn template_body(issues: &mut Issues, body: &Object, partial: bool) -> TemplateBody {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let name = issues.text(body, "name", required, Some(1), Some(255));
    let description = issues.text(body, "description", Presence::Optional, None, None);
    let category = issues.text(body, "category", Presence::Optional, None, None);
    let mut difficulty = issues.choice(
        body,
        "difficulty",
        Presence::Optional,
        &["beginner", "intermediate", "advanced"],
    );
    if !partial && !body.contains_key("difficulty") {
        difficulty = Field::Set("beginner".into());
    }
    let triggers = loose_list(issues, body, "triggers", tight_trigger);
    let steps = loose_list(issues, body, "steps", tight_step);
    let settings = settings(issues, body);
    let tags = tags(issues, body);
    let icon = issues.text(body, "icon", Presence::Optional, None, None);
    issues.boolean(body, "isPremium", Presence::Optional);
    TemplateBody {
        name,
        description,
        category,
        difficulty,
        triggers,
        steps,
        settings,
        tags,
        icon,
    }
}

/// A body field as the JSON Drizzle writes: `Set` as given, else `None`.
pub(crate) fn json_list(field: &Field<Vec<Value>>) -> Option<Value> {
    field.as_set().map(|items| Value::Array(items.clone()))
}

/// `Field<Vec<String>>` as JSON.
pub(crate) fn json_tags(field: &Field<Vec<String>>) -> Option<Value> {
    field.as_set().map(|tags| json!(tags))
}
