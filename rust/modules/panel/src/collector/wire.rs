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

const MAX_PEOPLE_OPS_PER_BATCH: usize = 50;
const MAX_GROUP_OPS_PER_BATCH: usize = 50;
const MAX_ERROR_MESSAGE: usize = 1000;

/// `LIBS`: the browser SDK, the server API, the React Native SDK.
const LIBS: &[&str] = &["web", "server", "mobile"];

const SYSTEM_EVENTS: &[&str] = &[
    "$pageview",
    "$pageleave",
    "$autocapture",
    "$identify",
    "$rageclick",
    "$deadclick",
    "$quickback",
    "$excessivescroll",
    "$exception",
    "$webvitals",
    "$screen",
    "$app_opened",
    "$app_backgrounded",
    "$app_installed",
    "$app_updated",
];

static CUSTOM_EVENT_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$").expect("a pattern")
});
/// `EVENT_PROPERTY_KEY`: identifiers, plus the reserved `$` keys the SDKs
/// set themselves: `$exception`'s source, line and column, `$quickback`'s
/// page left, the first touch (`$initial_*`), group membership
/// (`$group_<type>`), `$webvitals`' measures and the mobile SDK's device and
/// screen. Any other `$` key stays refused, so a client can't forge the
/// collector's own (`$action`).
static PROPERTY_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\$(?:source|line|col|from|",
        r"initial_(?:referrer|referring_domain|utm_source|utm_medium|utm_campaign|utm_content|utm_term|landing_path)|",
        r"group_[a-z][a-z0-9_]{0,31}|",
        r"lcp|inp|fcp|ttfb|cls|lcp_el|inp_el|cls_el|nav_type|",
        r"screen_name|os|os_version|device_type|device_model|app_id|app_version|app_build|",
        r"screen_width|screen_height|locale))$",
    ))
    .expect("a pattern")
});

/// `USER_ID`: 1 to 255 UTF-16 units, no control characters.
fn is_user_id(text: &str) -> bool {
    let units = text.encode_utf16().count();
    (1..=255).contains(&units)
        && !text
            .chars()
            .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
}

/// `z.number().min(0).max(1)`.
fn unit_interval() -> Number {
    Number {
        min: Some(0.0),
        max: Some(1.0),
        ..Number::default()
    }
}

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
    pub(crate) user_id: Option<String>,
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    pub(crate) referrer: Option<String>,
    pub(crate) viewport_w: Option<i64>,
    pub(crate) el: Option<WireElement>,
    pub(crate) x: Option<i64>,
    pub(crate) y: Option<i64>,
    pub(crate) rel_x: Option<f64>,
    pub(crate) rel_y: Option<f64>,
    pub(crate) scroll_depth: Option<i64>,
    pub(crate) error_message: Option<String>,
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
        let lib = issues.choice(fields, "lib", Presence::Required, LIBS);
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
        // Profile and group profile operations belong to the PanelProject
        // object, which the Kubernetes editions don't have: accepted (the
        // length is still checked) and ignored.
        issues.list(
            fields,
            "people",
            Presence::Optional,
            None,
            Some(MAX_PEOPLE_OPS_PER_BATCH),
            |_, item| Some(item.clone()),
        );
        issues.list(
            fields,
            "groups",
            Presence::Optional,
            None,
            Some(MAX_GROUP_OPS_PER_BATCH),
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
    let event_id = issues.text_with(
        fields,
        "event_id",
        Presence::Required,
        Text::length(Some(8), Some(64)),
    );
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
    let user_id = issues.pattern(
        fields,
        "user_id",
        Presence::Optional,
        None,
        None,
        is_user_id,
        "Invalid",
    );
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
    let viewport_w =
        issues.whole_number(fields, "viewport_w", Presence::Optional, int(0.0, 20000.0));
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
    let rel_x = issues.number(fields, "rel_x", Presence::Optional, unit_interval());
    let rel_y = issues.number(fields, "rel_y", Presence::Optional, unit_interval());
    let scroll_depth =
        issues.whole_number(fields, "scroll_depth", Presence::Optional, int(0.0, 100.0));
    let error_message = issues.text_with(
        fields,
        "error_message",
        Presence::Optional,
        length(MAX_ERROR_MESSAGE),
    );
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
        user_id: user_id.into_option(),
        url: url.into_option().unwrap_or_default(),
        title: title.into_option(),
        referrer: referrer.into_option(),
        viewport_w: viewport_w.into_option(),
        el: el.into_option(),
        x: x.into_option(),
        y: y.into_option(),
        rel_x: rel_x.into_option(),
        rel_y: rel_y.into_option(),
        scroll_depth: scroll_depth.into_option(),
        error_message: error_message.into_option(),
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
            issues.issue_at(
                "name",
                json!({ "code": "invalid_union", "message": "Invalid input" }),
            );
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
                issues.push_raw(
                    json!({ "code": "invalid_union", "message": "Invalid input", "path": at(key) }),
                );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn body(extra: &Value) -> Js {
        let mut batch = json!({
            "token": "wpk_0123456789abcdef0123456789abcdef",
            "sent_at": "2026-10-27T12:00:00.000Z",
            "lib": "web",
            "lib_version": "0.1.0",
            "consent": false,
            "events": [{
                "event_id": "evt-00000001", "name": "$pageview",
                "ts": "2026-10-27T12:00:00.000Z", "url": "https://shop.example.com/",
            }],
        });
        batch
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        serde_json::from_value(batch).expect("a body")
    }

    fn event_with(extra: &Value) -> Value {
        let mut event = json!({
            "event_id": "evt-00000001", "name": "$pageview",
            "ts": "2026-10-27T12:00:00.000Z", "url": "https://shop.example.com/",
        });
        event
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        event
    }

    #[test]
    fn accepts_the_three_libraries() {
        for lib in ["web", "server", "mobile"] {
            let batch = parse_event_batch(&body(&json!({ "lib": lib }))).expect("a batch");
            assert_eq!(batch.lib, lib);
        }
        assert_eq!(
            parse_event_batch(&body(&json!({ "lib": "ios" }))).expect_err("refused"),
            "lib: Invalid enum value. Expected 'web' | 'server' | 'mobile', received 'ios'"
        );
    }

    #[test]
    fn accepts_the_web_vitals_and_mobile_event_names() {
        for name in [
            "$webvitals",
            "$screen",
            "$app_opened",
            "$app_backgrounded",
            "$app_installed",
            "$app_updated",
        ] {
            let batch = parse_event_batch(&body(&json!({
                "events": [event_with(&json!({ "name": name }))],
            })))
            .expect("a batch");
            assert_eq!(batch.events[0].name, name);
        }
        assert_eq!(
            parse_event_batch(&body(&json!({
                "events": [event_with(&json!({ "name": "$app_crashed" }))],
            })))
            .expect_err("refused"),
            "events.0.name: Invalid"
        );
    }

    #[test]
    fn accepts_the_reserved_property_keys_the_sdks_set() {
        for key in [
            "$source",
            "$from",
            "$initial_referrer",
            "$initial_referring_domain",
            "$initial_utm_source",
            "$initial_utm_term",
            "$initial_landing_path",
            "$group_company",
            "$group_a1_b",
            "$lcp",
            "$inp",
            "$fcp",
            "$ttfb",
            "$cls",
            "$lcp_el",
            "$inp_el",
            "$cls_el",
            "$nav_type",
            "$screen_name",
            "$os",
            "$os_version",
            "$device_type",
            "$device_model",
            "$app_id",
            "$app_version",
            "$app_build",
            "$screen_width",
            "$screen_height",
            "$locale",
        ] {
            assert!(PROPERTY_KEY.is_match(key), "{key}");
        }
        for key in [
            "$action",
            "$initial_utm",
            "$group_",
            "$group_Company",
            "$group_1st",
            "$group_abcdefghijklmnopqrstuvwxyz0123456",
            "$lcp_x",
            "$screen",
            "$os\n",
        ] {
            assert!(!PROPERTY_KEY.is_match(key), "{key}");
        }
        let batch = parse_event_batch(&body(&json!({
            "events": [event_with(&json!({
                "name": "$webvitals",
                "props": { "$lcp": 1200, "$cls": 0.02, "$nav_type": "navigate", "$group_company": "acme" },
            }))],
        })))
        .expect("a batch");
        let keys: Vec<&str> = batch.events[0]
            .props
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|(key, _)| key.as_str())
            .collect();
        // `json!` sorted them before the body was read.
        assert_eq!(keys, ["$cls", "$group_company", "$lcp", "$nav_type"]);
    }

    #[test]
    fn accepts_and_ignores_up_to_fifty_group_operations() {
        // An operation this version doesn't understand costs only itself.
        let mut ops = vec![
            json!({ "op": "set", "type": "company", "key": "acme", "props": { "plan": "pro" } });
            49
        ];
        ops.push(json!({ "op": "nonsense" }));
        let batch = parse_event_batch(&body(&json!({ "groups": ops }))).expect("a batch");
        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            parse_event_batch(&body(&json!({ "groups": vec![json!({}); 51] })))
                .expect_err("refused"),
            "groups: Array must contain at most 50 element(s)"
        );
        assert_eq!(
            parse_event_batch(&body(&json!({ "groups": "acme" }))).expect_err("refused"),
            "groups: Expected array, received string"
        );
    }
}
