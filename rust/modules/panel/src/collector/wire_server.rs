//! `@weldsuite/panel-domain/wire`'s server API: the `POST /v1/track` and
//! `/v1/import` batch, read as `parseServerBatch` reads it (the envelope
//! strictly, then each event on its own), and the profile and group
//! operations (`wirePeopleOpSchema`, `wireGroupOpSchema`) it may carry.
//!
//! The operations are only checked here: applying them is the `PanelProject`
//! object's work, which these editions don't have yet.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};

use super::wire::{
    MAX_GROUP_OPS_PER_BATCH, MAX_PEOPLE_OPS_PER_BATCH, MAX_PROPERTIES, MAX_STRING, first_issue,
    is_user_id, length, name, properties,
};
use crate::js::Js;

/// `POST /v1/track` takes at most this many events.
pub(crate) const MAX_TRACK_EVENTS: usize = 100;
/// `POST /v1/import` takes at most this many events.
pub(crate) const MAX_IMPORT_EVENTS: usize = 1000;
const MAX_UNSET_KEYS: usize = 50;
const MAX_GROUP_KEY: usize = 255;

/// `PROFILE_PROPERTY_KEY`: identifiers, plus the reserved profile fields and
/// the first-touch keys the SDK sends with `people.set_once`.
static PROFILE_PROPERTY_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\$(?:email|name|avatar|created|",
        r"initial_(?:referrer|referring_domain|utm_source|utm_medium|utm_campaign|utm_content|utm_term|landing_path)))$",
    ))
    .expect("a pattern")
});
/// `GROUP_TYPE`: `company`, `account`, …
static GROUP_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_]{0,31}$").expect("a pattern"));

/// One event sent with a secret key (`serverEventSchema`'s output).
#[derive(Debug, Clone)]
pub(crate) struct ServerEvent {
    pub(crate) event_id: String,
    pub(crate) name: String,
    pub(crate) ts: String,
    pub(crate) distinct_id: String,
    pub(crate) user_id: Option<String>,
    pub(crate) anon_id: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    /// In the body's key order (`JSON.stringify` writes it so).
    pub(crate) props: Option<Vec<(String, Js)>>,
}

/// A server batch with its valid events (`ParsedServerBatch`).
#[derive(Debug, Clone)]
pub(crate) struct ServerBatch {
    pub(crate) lib_version: String,
    pub(crate) events: Vec<ServerEvent>,
    /// Events left out because they couldn't be read.
    pub(crate) dropped: usize,
    /// Valid profile operations (`people`) and group profile operations
    /// (`groups`): for the `PanelProject` object, which these editions don't
    /// have yet.
    pub(crate) people_ops: usize,
    pub(crate) group_ops: usize,
}

/// `propertyValue`: a string of at most 2048 characters, a finite number,
/// a boolean or null.
fn is_property_value(value: &Js) -> bool {
    match value {
        Js::String(text) => text.encode_utf16().count() <= MAX_STRING,
        Js::Number(number) => number.is_finite(),
        Js::Bool(_) | Js::Null => true,
        Js::Array(_) | Js::Object(_) => false,
    }
}

fn is_finite_number(value: &Js) -> bool {
    matches!(value, Js::Number(number) if number.is_finite())
}

/// `profileProps(value)`: an object of at most 50 profile keys, each value
/// one `accepts` takes.
fn is_profile_props(value: Option<&Js>, accepts: fn(&Js) -> bool) -> bool {
    let Some(Js::Object(entries)) = value else {
        return false;
    };
    entries.len() <= MAX_PROPERTIES
        && entries
            .iter()
            .all(|(key, value)| PROFILE_PROPERTY_KEY.is_match(key) && accepts(value))
}

/// `z.array(profileKey).max(50)`.
fn is_profile_keys(value: Option<&Js>) -> bool {
    let Some(Js::Array(keys)) = value else {
        return false;
    };
    keys.len() <= MAX_UNSET_KEYS
        && keys
            .iter()
            .all(|key| matches!(key, Js::String(key) if PROFILE_PROPERTY_KEY.is_match(key)))
}

fn text<'a>(op: &'a Js, key: &str) -> Option<&'a str> {
    match op.get(key) {
        Some(Js::String(text)) => Some(text),
        _ => None,
    }
}

/// `wirePeopleOpSchema.safeParse(op).success`.
pub(crate) fn is_people_op(op: &Js) -> bool {
    let user_id = text(op, "user_id").is_some_and(is_user_id);
    let ts = text(op, "ts").is_some_and(|ts| Format::DatetimeOffset.accepts(ts));
    let rest = match text(op, "op") {
        Some("set" | "set_once") => is_profile_props(op.get("props"), is_property_value),
        Some("unset") => is_profile_keys(op.get("keys")),
        Some("increment") => is_profile_props(op.get("props"), is_finite_number),
        _ => false,
    };
    user_id && ts && rest
}

/// `wireGroupOpSchema.safeParse(op).success`.
pub(crate) fn is_group_op(op: &Js) -> bool {
    let group_type = text(op, "type").is_some_and(|kind| GROUP_TYPE.is_match(kind));
    let key = text(op, "key")
        .is_some_and(|key| is_user_id(key) && key.encode_utf16().count() <= MAX_GROUP_KEY);
    let rest = match text(op, "op") {
        Some("set" | "set_once") => is_profile_props(op.get("props"), is_property_value),
        Some("unset") => is_profile_keys(op.get("keys")),
        _ => false,
    };
    group_type && key && rest
}

fn items<'a>(body: &'a Js, key: &str) -> &'a [Js] {
    match body.get(key) {
        Some(Js::Array(items)) => items,
        _ => &[],
    }
}

/// `serverEventSchema.safeParse(raw)`, the issues on failure.
fn parse_server_event(raw: &Js) -> Result<ServerEvent, Vec<Value>> {
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
    let distinct_id = issues.pattern(
        fields,
        "distinct_id",
        Presence::Required,
        None,
        None,
        is_user_id,
        "Invalid",
    );
    let user_id = issues.pattern(
        fields,
        "user_id",
        Presence::Optional,
        None,
        None,
        is_user_id,
        "Invalid",
    );
    let anon_id = issues.text_with(fields, "anon_id", Presence::Optional, length(64));
    let url = issues.text_with(
        fields,
        "url",
        Presence::Optional,
        Text {
            format: Some(Format::Url),
            max: Some(MAX_STRING),
            ..Text::default()
        },
    );
    let title = issues.text_with(fields, "title", Presence::Optional, length(512));
    let props = properties(&mut issues, fields, raw.get("props"));
    if !issues.is_empty() {
        return Err(issues.issues_since(0).to_vec());
    }
    Ok(ServerEvent {
        event_id: event_id.into_option().unwrap_or_default(),
        name: name.unwrap_or_default(),
        ts: ts.into_option().unwrap_or_default(),
        distinct_id: distinct_id.into_option().unwrap_or_default(),
        user_id: user_id.into_option(),
        anon_id: anon_id.into_option(),
        url: url.into_option(),
        title: title.into_option(),
        props,
    })
}

/// `parseServerBatch(body, maxEvents)`: the batch, or the route's message
/// for the first issue.
pub(crate) fn parse_server_batch(body: &Js, max_events: usize) -> Result<ServerBatch, String> {
    let value = body.to_value();
    let mut issues = Issues::default();
    let lib_version = issues.object(&value).and_then(|fields| {
        // `lib: z.literal('server')`.
        let lib = fields.get("lib");
        if lib.and_then(Value::as_str) != Some("server") {
            issues.issue_at(
                "lib",
                json!({
                    "received": lib.cloned().unwrap_or(Value::Null),
                    "code": "invalid_literal",
                    "expected": "server",
                    "message": "Invalid literal value, expected \"server\"",
                }),
            );
        }
        let lib_version = issues.text_with(fields, "lib_version", Presence::Required, length(32));
        // `events` defaults to `[]`; the items are read one by one below.
        issues.list(fields, "events", Presence::Optional, None, None, |_, _| {
            Some(())
        });
        issues.list(
            fields,
            "people",
            Presence::Optional,
            None,
            Some(MAX_PEOPLE_OPS_PER_BATCH),
            |_, _| Some(()),
        );
        issues.list(
            fields,
            "groups",
            Presence::Optional,
            None,
            Some(MAX_GROUP_OPS_PER_BATCH),
            |_, _| Some(()),
        );
        lib_version.into_option()
    });
    if !issues.is_empty() {
        return Err(first_issue(issues.issues_since(0)));
    }
    let Some(lib_version) = lib_version else {
        return Err("Invalid batch".to_owned());
    };
    let raw_events = items(body, "events");
    let raw_people = items(body, "people");
    let raw_groups = items(body, "groups");
    // A batch may carry only profile updates, but not nothing.
    if raw_events.is_empty() && raw_people.is_empty() && raw_groups.is_empty() {
        return Err("events: Send at least one event or people operation".to_owned());
    }
    if raw_events.len() > max_events {
        return Err(format!(
            "events: Array must contain at most {max_events} element(s)"
        ));
    }

    let mut events = Vec::new();
    let mut first_issues: Option<Vec<Value>> = None;
    for (index, raw) in raw_events.iter().enumerate() {
        match parse_server_event(raw) {
            Ok(event) => events.push(event),
            Err(found) => {
                if first_issues.is_none() {
                    first_issues = Some(
                        found
                            .into_iter()
                            .map(|mut issue| {
                                let mut path = vec![json!("events"), json!(index)];
                                if let Some(rest) = issue["path"].as_array() {
                                    path.extend(rest.iter().cloned());
                                }
                                issue["path"] = Value::Array(path);
                                issue
                            })
                            .collect(),
                    );
                }
            }
        }
    }
    let people_ops = raw_people.iter().filter(|op| is_people_op(op)).count();
    let group_ops = raw_groups.iter().filter(|op| is_group_op(op)).count();
    if events.is_empty() && (!raw_events.is_empty() || people_ops + group_ops == 0) {
        return Err(first_issues.map_or_else(
            || "people: No valid event or people operation".to_owned(),
            |issues| first_issue(&issues),
        ));
    }
    Ok(ServerBatch {
        lib_version,
        dropped: raw_events.len() - events.len(),
        events,
        people_ops,
        group_ops,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(value: &Value) -> Js {
        serde_json::from_value(value.clone()).expect("a body")
    }

    fn event(extra: &Value) -> Value {
        let mut event = json!({
            "event_id": "evt-00000001", "name": "Order placed",
            "ts": "2026-10-27T11:59:59.000Z", "distinct_id": "user-1",
        });
        event
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        event
    }

    fn batch(extra: &Value) -> Js {
        let mut body =
            json!({ "lib": "server", "lib_version": "0.1.0", "events": [event(&json!({}))] });
        body.as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        js(&body)
    }

    #[test]
    fn reads_the_events_and_counts_the_unreadable_ones() {
        let parsed = parse_server_batch(
            &batch(&json!({ "events": [
                event(&json!({ "props": { "total": 12.5, "coupon": null }, "url": "https://shop.example.com/" })),
                event(&json!({ "distinct_id": null })),
            ] })),
            MAX_TRACK_EVENTS,
        )
        .expect("a batch");
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.dropped, 1);
        assert_eq!(parsed.lib_version, "0.1.0");
        assert_eq!(
            parsed.events[0].url.as_deref(),
            Some("https://shop.example.com/")
        );
    }

    #[test]
    fn refuses_what_is_not_a_server_batch() {
        let refused = |body: &Js| parse_server_batch(body, MAX_TRACK_EVENTS).expect_err("refused");
        assert_eq!(
            refused(&batch(&json!({ "lib": "web" }))),
            "lib: Invalid literal value, expected \"server\""
        );
        assert_eq!(
            refused(&batch(&json!({ "events": [] }))),
            "events: Send at least one event or people operation"
        );
        assert_eq!(
            refused(&batch(&json!({ "events": [{ "nope": 1 }] }))),
            "events.0.event_id: Required"
        );
        assert_eq!(
            refused(&batch(
                &json!({ "events": [], "people": [{ "op": "bogus" }] })
            )),
            "people: No valid event or people operation"
        );
        assert_eq!(
            refused(&batch(&json!({ "events": vec![event(&json!({})); 101] }))),
            "events: Array must contain at most 100 element(s)"
        );
        assert_eq!(
            refused(&js(&json!([1, 2]))),
            "Expected object, received array"
        );
        assert_eq!(
            refused(&batch(&json!({ "events": null }))),
            "events: Expected array, received null"
        );
        assert!(
            parse_server_batch(
                &batch(&json!({ "events": vec![event(&json!({})); 101] })),
                MAX_IMPORT_EVENTS
            )
            .is_ok()
        );
    }

    #[test]
    fn takes_a_batch_of_profile_operations_only() {
        let parsed = parse_server_batch(
            &batch(&json!({
                "events": [],
                "people": [
                    { "op": "set", "user_id": "user-1", "ts": "2026-10-27T12:00:00.000Z", "props": { "$email": "a@b.com", "plan": "pro" } },
                    { "op": "increment", "user_id": "user-1", "ts": "2026-10-27T12:00:00.000Z", "props": { "orders": 1 } },
                    { "op": "bogus" },
                ],
                "groups": [{ "op": "unset", "type": "company", "key": "acme", "keys": ["legacy"] }],
            })),
            MAX_TRACK_EVENTS,
        )
        .expect("a batch");
        assert!(parsed.events.is_empty());
        assert_eq!((parsed.people_ops, parsed.group_ops), (2, 1));
    }

    #[test]
    fn checks_the_operations_as_the_schemas_do() {
        let ts = "2026-10-27T12:00:00.000Z";
        let ok = |op: Value| is_people_op(&js(&op));
        assert!(ok(
            json!({ "op": "set_once", "user_id": "u", "ts": ts, "props": { "$initial_referrer": "x" } })
        ));
        assert!(ok(
            json!({ "op": "unset", "user_id": "u", "ts": ts, "keys": ["plan"] })
        ));
        assert!(!ok(
            json!({ "op": "set", "user_id": "u", "ts": ts, "props": { "$action": "x" } })
        ));
        assert!(!ok(
            json!({ "op": "increment", "user_id": "u", "ts": ts, "props": { "n": "1" } })
        ));
        assert!(!ok(
            json!({ "op": "set", "user_id": "a\nb", "ts": ts, "props": {} })
        ));
        assert!(!ok(
            json!({ "op": "set", "user_id": "u", "ts": "yesterday", "props": {} })
        ));
        let group = |op: Value| is_group_op(&js(&op));
        assert!(group(
            json!({ "op": "set", "type": "company", "key": "acme", "props": { "$name": "Acme" } })
        ));
        assert!(!group(
            json!({ "op": "set", "type": "Bad Type", "key": "acme", "props": {} })
        ));
        assert!(!group(
            json!({ "op": "delete", "type": "company", "key": "acme" })
        ));
    }
}
