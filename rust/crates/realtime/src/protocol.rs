//! The server's messages, as the realtime-worker writes them
//! (`WorkspaceServerMessage` and the room messages in
//! `@weldsuite/realtime/types`).

use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use weldsuite_adapters_oss::realtime::HubEvent;

/// Close code for a socket the gateway found silent (`STALE_CLOSE_CODE`).
pub(crate) const STALE: u16 = 4000;
/// Close code when the pod shuts down; the client reconnects elsewhere.
pub(crate) const RESTART: u16 = 1012;
/// Close code when the gateway cannot serve the socket.
pub(crate) const INTERNAL: u16 = 1011;

/// `Date.now()`.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn string(value: &str) -> String {
    Value::from(value).to_string()
}

/// `{ type: 'event', topic, event, data, ts, userId, eventId }`, with `data`
/// exactly as published and the keys a JavaScript publisher left out absent.
pub(crate) fn event(event: &HubEvent) -> String {
    let mut text = format!(
        r#"{{"type":"event","topic":{},"event":{}"#,
        string(&event.topic),
        string(&event.event)
    );
    if let Some(data) = &event.data {
        text.push_str(r#","data":"#);
        text.push_str(data.get());
    }
    let _ = write!(text, r#","ts":{}"#, event.ts);
    if let Some(user_id) = &event.user_id {
        let _ = write!(text, r#","userId":{}"#, string(user_id));
    }
    let _ = write!(text, r#","eventId":{}}}"#, string(&event.event_id));
    text
}

/// An event on the `presence` topic (`presenceMessage`).
pub(crate) fn presence_event(name: &str, data: &Value, user_id: &str, ts: u64) -> String {
    json!({
        "type": "event",
        "topic": "presence",
        "event": name,
        "data": data,
        "ts": ts,
        "userId": user_id,
    })
    .to_string()
}

pub(crate) fn connected(connection_id: &str) -> String {
    json!({ "type": "connected", "connectionId": connection_id }).to_string()
}

pub(crate) fn subscribed(topics: &[String]) -> String {
    json!({ "type": "subscribed", "topics": topics }).to_string()
}

pub(crate) fn unsubscribed(topics: &Value) -> String {
    json!({ "type": "unsubscribed", "topics": topics }).to_string()
}

pub(crate) fn resync_required(topics: &[String]) -> String {
    json!({ "type": "resync_required", "topics": topics }).to_string()
}

pub(crate) fn error(code: &str, message: &str) -> String {
    json!({ "type": "error", "code": code, "message": message }).to_string()
}

pub(crate) const PONG: &str = r#"{"type":"pong"}"#;

/// `String(value)` for the `Unknown message type: …` error.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::value::RawValue;

    use super::*;

    #[test]
    fn events_keep_data_as_published() {
        let data = RawValue::from_string(r#"{"z":1,"a":2}"#.to_owned()).expect("raw");
        let mut hub_event = HubEvent {
            seq: 7,
            event_id: "0000000000000007".to_owned(),
            ts: 1700,
            access: None,
            topic: "task".to_owned(),
            event: "created".to_owned(),
            data: Some(data),
            user_id: Some("u\"1".to_owned()),
        };
        let text = event(&hub_event);
        assert_eq!(
            text,
            r#"{"type":"event","topic":"task","event":"created","data":{"z":1,"a":2},"ts":1700,"userId":"u\"1","eventId":"0000000000000007"}"#
        );
        let parsed: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(parsed["data"]["a"], 2);
        hub_event.data = None;
        hub_event.user_id = None;
        assert_eq!(
            event(&hub_event),
            r#"{"type":"event","topic":"task","event":"created","ts":1700,"eventId":"0000000000000007"}"#
        );
    }

    #[test]
    fn unknown_types_read_as_in_javascript() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!("x"))), "x");
        assert_eq!(js_string(Some(&json!(5))), "5");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!({}))), "[object Object]");
        assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
    }
}
