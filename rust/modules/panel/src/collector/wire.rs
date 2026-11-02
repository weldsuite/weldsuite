//! `@weldsuite/panel-domain/wire`: the `POST /e` batch the browser SDK
//! sends, read as `parseEventBatch` reads it: the envelope strictly, then
//! each event on its own, so an event this version doesn't understand costs
//! that event and not the batch.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};

use crate::js::Js;

pub(crate) const MAX_EVENTS_PER_BATCH: usize = 100;
/// `navigator.sendBeacon` refuses bodies over 64 KiB.
pub(crate) const MAX_BATCH_BYTES: usize = 64 * 1024;
const MAX_PROPERTIES: usize = 50;
const MAX_STRING: usize = 2048;
const MAX_ELEMENT_TEXT: usize = 255;

const SYSTEM_EVENTS: &[&str] = &["$pageview", "$pageleave", "$autocapture"];

static CUSTOM_EVENT_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$").expect("a pattern")
});
static PROPERTY_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$").expect("a pattern"));

/// The `$autocapture` element.
#[derive(Debug, Clone)]
pub(crate) struct WireElement {
    pub(crate) tag: String,
    pub(crate) selector: String,
    pub(crate) text: Option<String>,
    pub(crate) action: String,
}

/// One event (`wireEventSchema`'s output).
#[derive(Debug, Clone)]
pub(crate) struct WireEvent {
    pub(crate) event_id: String,
    pub(crate) name: String,
    pub(crate) ts: String,
    pub(crate) anon_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    pub(crate) referrer: Option<String>,
    pub(crate) viewport_w: Option<i64>,
    pub(crate) el: Option<WireElement>,
    pub(crate) x: Option<i64>,
    pub(crate) y: Option<i64>,
    pub(crate) scroll_depth: Option<i64>,
    /// In the body's key order (`JSON.stringify` writes it so).
    pub(crate) props: Option<Vec<(String, Js)>>,
}

/// A batch with its valid events (`EventBatch`).
#[derive(Debug, Clone)]
pub(crate) struct EventBatch {
    pub(crate) token: String,
    pub(crate) sent_at: String,
    pub(crate) lib: String,
    pub(crate) lib_version: String,
    pub(crate) consent: bool,
    pub(crate) events: Vec<WireEvent>,
}

const fn length(max: usize) -> Text {
    Text::length(None, Some(max))
}

fn int(min: f64, max: f64) -> Number {
    Number {
        int: true,
        min: Some(min),
        max: Some(max),
        ..Number::default()
    }
}

/// `events.2.url: Invalid url`: the first issue, as the route reports it.
fn first_issue(issues: &[Value]) -> String {
    let Some(issue) = issues.first() else {
        return "Invalid batch".to_owned();
    };
    let message = issue["message"].as_str().unwrap_or_default();
    let path: Vec<String> = issue["path"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|part| match part {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    if path.is_empty() {
        message.to_owned()
    } else {
        format!("{}: {message}", path.join("."))
    }
}

/// `parseEventBatch(body)`: the batch, or the route's message for the first
/// issue.
pub(crate) fn parse_event_batch(body: &Js) -> Result<EventBatch, String> {
    let value = body.to_value();
    let mut issues = Issues::default();
    let envelope = issues.object(&value).map(|fields| {
        let token = issues.text_with(fields, "token", Presence::Required, length(64));
        let sent_at = issues.text_with(
            fields,
            "sent_at",
            Presence::Required,
            Text {
                format: Some(Format::DatetimeOffset),
                ..Text::default()
            },
        );
        let lib = issues.choice(fields, "lib", Presence::Required, &["web", "server"]);
        let lib_version = issues.text_with(fields, "lib_version", Presence::Required, length(32));
        let consent = issues.boolean(fields, "consent", Presence::Required);
        let events = issues.list(
            fields,
            "events",
            Presence::Required,
            Some(1),
            Some(MAX_EVENTS_PER_BATCH),
            |_, item| Some(item.clone()),
        );
        (token, sent_at, lib, lib_version, consent, events)
    });
    if !issues.is_empty() {
        return Err(first_issue(issues.issues_since(0)));
    }
    let Some((
        Field::Set(token),
        Field::Set(sent_at),
        Field::Set(lib),
        Field::Set(lib_version),
        Field::Set(consent),
        Field::Set(_),
    )) = envelope
    else {
        return Err("Invalid batch".to_owned());
    };
    let raw_events: &[Js] = match body.get("events") {
        Some(Js::Array(items)) => items,
        _ => &[],
    };

    let mut events = Vec::new();
    let mut first_issues: Option<Vec<Value>> = None;
    for (index, raw) in raw_events.iter().enumerate() {
        match parse_event(raw) {
            Ok(event) => events.push(event),
            Err(found) => {
                if first_issues.is_none() {
                    let prefixed = found
                        .into_iter()
                        .map(|mut issue| {
                            let mut path = vec![json!("events"), json!(index)];
                            if let Some(rest) = issue["path"].as_array() {
                                path.extend(rest.iter().cloned());
                            }
                            issue["path"] = Value::Array(path);
                            issue
                        })
                        .collect();
                    first_issues = Some(prefixed);
                }
            }
        }
    }
    if events.is_empty() {
        return Err(first_issue(&first_issues.unwrap_or_default()));
    }
    Ok(EventBatch {
        token,
        sent_at,
        lib,
        lib_version,
        consent,
        events,
    })
}

/// `wireEventSchema.safeParse(raw)`, the issues on failure.
fn parse_event(raw: &Js) -> Result<WireEvent, Vec<Value>> {
    let value = raw.to_value();
    let mut issues = Issues::default();
    let Some(fields) = issues.object(&value) else {
        return Err(issues.issues_since(0).to_vec());
    };
    let event_id = issues.text_with(fields, "event_id", Presence::Required, Text::length(Some(8), Some(64)));
    let name = name(&mut issues, fields);
    let ts = issues.text_with(
        fields,
        "ts",
        Presence::Required,
        Text {
            format: Some(Format::DatetimeOffset),
            ..Text::default()
        },
    );
    let anon_id = issues.text_with(fields, "anon_id", Presence::Optional, length(64));
    let session_id = issues.text_with(fields, "session_id", Presence::Optional, length(64));
    let url = issues.text_with(
        fields,
        "url",
        Presence::Required,
        Text {
            format: Some(Format::Url),
            max: Some(MAX_STRING),
            ..Text::default()
        },
    );
    let title = issues.text_with(fields, "title", Presence::Optional, length(512));
    let referrer = issues.text_with(fields, "referrer", Presence::Optional, length(MAX_STRING));
    let viewport_w = issues.whole_number(fields, "viewport_w", Presence::Optional, int(0.0, 20000.0));
    let el = issues.nested(fields, "el", Presence::Optional, |issues, el| {
        let tag = issues.text_with(el, "tag", Presence::Required, length(32));
        let selector = issues.text_with(el, "selector", Presence::Required, length(512));
        let text = issues.text_with(el, "text", Presence::Optional, length(MAX_ELEMENT_TEXT));
        let action = issues.choice(el, "action", Presence::Required, &["click", "submit"]);
        WireElement {
            tag: tag.into_option().unwrap_or_default(),
            selector: selector.into_option().unwrap_or_default(),
            text: text.into_option(),
            action: action.into_option().unwrap_or_default(),
        }
    });
    let x = issues.whole_number(fields, "x", Presence::Optional, int(0.0, 100_000.0));
    let y = issues.whole_number(fields, "y", Presence::Optional, int(0.0, 1_000_000.0));
    let scroll_depth = issues.whole_number(fields, "scroll_depth", Presence::Optional, int(0.0, 100.0));
    let props = properties(&mut issues, fields, raw.get("props"));
    if !issues.is_empty() {
        return Err(issues.issues_since(0).to_vec());
    }
    Ok(WireEvent {
        event_id: event_id.into_option().unwrap_or_default(),
        name: name.unwrap_or_default(),
        ts: ts.into_option().unwrap_or_default(),
        anon_id: anon_id.into_option(),
        session_id: session_id.into_option(),
        url: url.into_option().unwrap_or_default(),
        title: title.into_option(),
        referrer: referrer.into_option(),
        viewport_w: viewport_w.into_option(),
        el: el.into_option(),
        x: x.into_option(),
        y: y.into_option(),
        scroll_depth: scroll_depth.into_option(),
        props,
    })
}

/// `z.union([z.enum(SYSTEM_EVENTS), z.string().regex(CUSTOM_EVENT_NAME)])`:
/// a string that is neither fails the regex ("Invalid"); anything else
/// fails both options' type checks, an `invalid_union`.
fn name(issues: &mut Issues, fields: &Map<String, Value>) -> Option<String> {
    match fields.get("name") {
        Some(Value::String(text))
            if SYSTEM_EVENTS.contains(&text.as_str()) || CUSTOM_EVENT_NAME.is_match(text) =>
        {
            Some(text.clone())
        }
        Some(Value::String(_)) => {
            issues.issue_at(
                "name",
                json!({ "validation": "regex", "code": "invalid_string", "message": "Invalid" }),
            );
            None
        }
        _ => {
            issues.issue_at("name", json!({ "code": "invalid_union", "message": "Invalid input" }));
            None
        }
    }
}

/// `z.record(z.string().regex(PROPERTY_KEY), string | number | boolean |
/// null).refine(at most 50 keys).optional()`, in the body's key order.
fn properties(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    raw: Option<&Js>,
) -> Option<Vec<(String, Js)>> {
    let value = fields.get("props")?;
    let Some(Js::Object(entries)) = raw else {
        let received = match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            Value::Object(_) => "object",
        };
        issues.issue_at(
            "props",
            json!({
                "code": "invalid_type",
                "expected": "object",
                "received": received,
                "message": format!("Expected object, received {received}"),
            }),
        );
        return None;
    };
    let before = issues.count();
    let mut aborted = false;
    let path = issues.path_of("props");
    let at = |key: &str| {
        let mut path = path.as_array().cloned().unwrap_or_default();
        path.push(json!(key));
        Value::Array(path)
    };
    for (key, item) in entries {
        if !PROPERTY_KEY.is_match(key) {
            issues.push_raw(json!({
                "validation": "regex", "code": "invalid_string", "message": "Invalid", "path": at(key),
            }));
        }
        match item {
            Js::String(text) if text.encode_utf16().count() > MAX_STRING => {
                issues.push_raw(json!({
                    "code": "too_big", "maximum": MAX_STRING, "type": "string", "inclusive": true,
                    "exact": false,
                    "message": format!("String must contain at most {MAX_STRING} character(s)"),
                    "path": at(key),
                }));
            }
            Js::String(_) | Js::Number(_) | Js::Bool(_) | Js::Null => {}
            Js::Array(_) | Js::Object(_) => {
                aborted = true;
                issues.push_raw(json!({ "code": "invalid_union", "message": "Invalid input", "path": at(key) }));
            }
        }
    }
    if !aborted && entries.len() > MAX_PROPERTIES {
        issues.push_raw(json!({
            "code": "custom", "message": format!("At most {MAX_PROPERTIES} properties"), "path": path,
        }));
    }
    (issues.count() == before).then(|| entries.clone())
}
