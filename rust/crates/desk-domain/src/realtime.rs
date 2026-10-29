//! Helpdesk realtime payloads: what `RealtimePublisher.conversationMessage`,
//! `conversationSystem` and `conversationPublish` POST to the realtime
//! worker's `/publish/conversation/:id` (`packages/core/realtime/src/server/publisher.ts`),
//! built as [`weldsuite_ports::RealtimeMessage`]s for the realtime port.
//!
//! `JSON.stringify` leaves out `undefined` fields: an optional field the
//! caller has no value for is left out here too, not sent as `null`.

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_ports::{RealtimeMessage, Room};

/// `Date.now()`.
pub fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `conversationPublish(conversationId, payload)`.
pub fn conversation_publish(conversation_id: &str, payload: Value) -> RealtimeMessage {
    RealtimeMessage::room(Room::Conversation, conversation_id, payload)
}

/// `conversationSystem(conversationId, event, data)`:
/// `{ type: 'system', event, data, ts }`.
pub fn conversation_system(conversation_id: &str, event: &str, data: Value) -> RealtimeMessage {
    let mut payload = Map::new();
    payload.insert("type".to_owned(), json!("system"));
    payload.insert("event".to_owned(), json!(event));
    payload.insert("data".to_owned(), data);
    payload.insert("ts".to_owned(), json!(now_ms()));
    conversation_publish(conversation_id, Value::Object(payload))
}

/// One attachment of a realtime message (`RealtimeMessageAttachment`), as
/// `publishMessage` maps it.
#[derive(Debug, Clone, Default)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub url: String,
    pub kind: String,
    pub size: Value,
}

/// `conversationMessage(conversationId, message)`:
/// `{ type: 'message', id, content, senderId, senderName, senderType, attachments?, ts }`.
pub fn conversation_message(
    conversation_id: &str,
    id: &str,
    content: &str,
    sender_id: &str,
    sender_name: &str,
    sender_type: &str,
    attachments: Option<Vec<Attachment>>,
) -> RealtimeMessage {
    let mut payload = Map::new();
    payload.insert("type".to_owned(), json!("message"));
    payload.insert("id".to_owned(), json!(id));
    payload.insert("content".to_owned(), json!(content));
    payload.insert("senderId".to_owned(), json!(sender_id));
    payload.insert("senderName".to_owned(), json!(sender_name));
    payload.insert("senderType".to_owned(), json!(sender_type));
    if let Some(attachments) = attachments {
        let list: Vec<Value> = attachments
            .into_iter()
            .map(|a| {
                json!({ "id": a.id, "name": a.name, "url": a.url, "type": a.kind, "size": a.size })
            })
            .collect();
        payload.insert("attachments".to_owned(), Value::Array(list));
    }
    payload.insert("ts".to_owned(), json!(now_ms()));
    conversation_publish(conversation_id, Value::Object(payload))
}

/// An object with the `Some` fields only (`JSON.stringify` drops `undefined`).
pub fn defined(fields: &[(&str, Option<Value>)]) -> Value {
    let mut out = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}
