//! The hub message as a subscriber reads it: `EntityEventMessage`
//! (`packages/core/entity-events/src/types.ts`), with every field optional,
//! as the TypeScript consumers read `message.body` without validating it.
//!
//! `data` stays the publisher's raw JSON, so what goes out again (a webhook
//! body) carries its keys in the publisher's order; `changes` keeps its
//! order too, since the audit description lists the changed fields in it.

use std::fmt;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;

/// One entity event off the hub.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubEvent {
    /// `evt_` + 16 hex characters.
    pub id: String,
    /// `customer:created`.
    pub event_type: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    /// The entity, as published. `None` when absent or `null`.
    pub data: Option<Box<RawValue>>,
    /// Only on updates: field → `{ old, new }`. Read it with
    /// [`HubEvent::changes`].
    #[serde(rename = "changes")]
    pub changes_raw: Option<Box<RawValue>>,
    pub access_user_ids: Option<Vec<String>>,
    pub metadata: EventMetadata,
}

/// `metadata` of the hub message.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventMetadata {
    /// The workspace: its Clerk (or identity provider) organization id from
    /// most producers, `workspaces.id` from some.
    pub workspace_id: String,
    /// `None` when absent: the audit row's `performed_by` is then null.
    pub user_id: Option<String>,
    pub timestamp: String,
    pub source: Option<String>,
    pub workflow_depth: Option<u32>,
}

impl HubEvent {
    /// Parses a hub payload.
    pub fn parse(payload: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(payload)
    }

    /// `event.data` as a value (`null` when absent).
    pub fn data_value(&self) -> Value {
        self.data
            .as_ref()
            .and_then(|raw| serde_json::from_str(raw.get()).ok())
            .unwrap_or(Value::Null)
    }

    /// `JSON.stringify(event.data ?? {})`, keys as published.
    pub fn data_json_or_empty_object(&self) -> &str {
        self.data.as_ref().map_or("{}", |raw| raw.get())
    }

    /// `event.changes` when it is truthy, keys in the publisher's order. An
    /// object gives its entries; another truthy value none
    /// (`Object.keys(5)` is empty).
    pub fn changes(&self) -> Option<OrderedObject> {
        let raw = self.changes_raw.as_ref()?;
        let value: Value = serde_json::from_str(raw.get()).ok()?;
        let truthy = match &value {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
            Value::String(text) => !text.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        };
        if !truthy {
            return None;
        }
        Some(serde_json::from_str::<OrderedObject>(raw.get()).unwrap_or_default())
    }
}

/// A JSON object with its keys in JavaScript's order (`Object.keys`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderedObject(pub Vec<(String, Value)>);

impl OrderedObject {
    pub fn keys(&self) -> Vec<String> {
        self.0.iter().map(|(key, _)| key.clone()).collect()
    }
}

impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor;

        impl<'de> Visitor<'de> for OrderedVisitor {
            type Value = OrderedObject;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries: Vec<(String, Value)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    // A repeated key keeps its first position and the last value.
                    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
                        slot.1 = value;
                    } else {
                        entries.push((key, value));
                    }
                }
                Ok(OrderedObject(js_key_order(entries)))
            }
        }

        deserializer.deserialize_map(OrderedVisitor)
    }
}

/// JavaScript object key order: array-index keys (`"0"`, `"17"`) first in
/// numeric order, then the rest as inserted.
fn js_key_order(entries: Vec<(String, Value)>) -> Vec<(String, Value)> {
    let (mut indices, rest): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indices.sort_by_key(|(key, _)| array_index(key));
    indices.extend(rest);
    indices
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_hub_message() {
        let event = HubEvent::parse(
            br#"{"id":"evt_1","eventType":"customer:updated","entityType":"customer","entityId":"c1","action":"updated","data":{"z":1,"a":2},"changes":{"status":{"old":"a","new":"b"},"priority":{"old":1,"new":2},"1":{}},"metadata":{"workspaceId":"org_1","userId":"u1","timestamp":"t","source":"web"}}"#,
        )
        .expect("parses");
        assert_eq!(event.data_json_or_empty_object(), r#"{"z":1,"a":2}"#);
        assert_eq!(
            event.changes().expect("changes").keys(),
            vec!["1", "status", "priority"]
        );
        assert_eq!(event.metadata.workspace_id, "org_1");
    }

    #[test]
    fn missing_and_odd_fields_are_tolerated() {
        let event = HubEvent::parse(br#"{"id":"evt_2","data":null,"changes":5}"#).expect("parses");
        assert!(event.data.is_none());
        assert_eq!(event.changes(), Some(OrderedObject::default()));
        assert_eq!(event.data_value(), Value::Null);
        assert_eq!(event.data_json_or_empty_object(), "{}");
        let falsy = HubEvent::parse(br#"{"changes":0}"#).expect("parses");
        assert_eq!(falsy.changes(), None);
    }
}
