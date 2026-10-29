//! The hub message against the TypeScript publisher's
//! (`fixtures/envelopes.json`, written by `fixtures/generate-envelopes.mts`):
//! same inputs, same pinned id and clock, the same JSON byte for byte.

use std::sync::LazyLock;

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_events::{
    EntityEvent, EntityEventMessage, EventContext, EventSource, EventType, SENSITIVE_KEYS,
    event_id_from_bytes,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("fixtures/envelopes.json")).expect("fixture parses")
});

fn source(name: &str) -> EventSource {
    match name {
        "web" => EventSource::Web,
        "mobile" => EventSource::Mobile,
        "api" => EventSource::Api,
        "system" => EventSource::System,
        other => panic!("unknown source {other}"),
    }
}

fn rust_json(case: &Value) -> String {
    let input = &case["input"];
    let text = |key: &str| input[key].as_str();

    let (context, event_type) = match case["kind"].as_str().expect("kind") {
        "raw" => (
            EventContext::new(
                text("workspaceId").expect("workspaceId"),
                text("userId").expect("userId"),
                text("source").map_or(EventSource::System, source),
            ),
            EventType::catalog(
                text("entityType").expect("type"),
                text("action").expect("action"),
            ),
        ),
        kind => {
            let context = EventContext::from_ids(
                text("workspaceId").expect("workspaceId"),
                text("clerkOrgId"),
                text("userId").expect("userId"),
            );
            let context = match text("source") {
                Some(name) => context.with_source(source(name)),
                None => context,
            };
            let entity_type = text("entityType").expect("type");
            let action = text("action").expect("action");
            let event_type = if kind == "customObject" {
                EventType::custom_object(entity_type, action)
            } else {
                EventType::catalog(entity_type, action)
            };
            (context, event_type)
        }
    };

    let mut event = EntityEvent::new(
        event_type.expect("the case's event is valid"),
        text("entityId").expect("entityId"),
        input["data"].clone(),
    );
    if let Some(changes) = input["changes"].as_object() {
        event = event.with_changes(changes.clone());
    }
    if let Some(ids) = input["accessUserIds"].as_array() {
        event = event.with_access_user_ids(
            ids.iter()
                .map(|id| id.as_str().expect("user id").to_owned())
                .collect(),
        );
    }
    if let Some(depth) = input["workflowDepth"].as_u64() {
        event = event.with_workflow_depth(u32::try_from(depth).expect("small depth"));
    }

    let bytes: Vec<u8> = case["idBytes"]
        .as_array()
        .expect("idBytes")
        .iter()
        .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("byte"))
        .collect();
    let now_ms = i128::from(case["nowMs"].as_i64().expect("nowMs"));
    let now = OffsetDateTime::from_unix_timestamp_nanos(now_ms * 1_000_000).expect("in range");

    let message = EntityEventMessage::build(
        &context.workspace_id,
        &context.user_id,
        context.source,
        event,
        event_id_from_bytes(bytes.try_into().expect("8 bytes")),
        now,
    );
    serde_json::to_string(&message).expect("serialises")
}

#[test]
fn messages_match_the_typescript_publisher() {
    let cases = FIXTURE["cases"].as_array().expect("cases");
    assert!(cases.len() >= 8);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let expected = case["json"].as_str().expect("json");
        assert_eq!(rust_json(case), expected, "{name}");
    }
}

#[test]
fn sensitive_keys_match_the_typescript_set() {
    let expected: Vec<&str> = FIXTURE["sensitiveKeys"]
        .as_array()
        .expect("sensitiveKeys")
        .iter()
        .map(|k| k.as_str().expect("key"))
        .collect();
    assert_eq!(SENSITIVE_KEYS, expected.as_slice());
}
