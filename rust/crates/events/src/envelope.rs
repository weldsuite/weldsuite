//! The hub message, `EntityEventMessage` in
//! `packages/core/entity-events/src/types.ts`, and how `enqueueHubEntityEvent`
//! in `publisher.ts` builds it.

use std::borrow::Cow;
use std::fmt;

use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use time::macros::format_description;
use weldsuite_catalogs::entity_events::{self, EventName};

use crate::scrub::scrub_sensitive_keys;

/// Who caused the event (`EventSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Web,
    Mobile,
    Api,
    System,
}

/// An entity type and action that may go on the wire: a catalog pair, or a
/// custom object's `co_<slug>` with a CRUD action (`custom-objects.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EventType {
    entity_type: Cow<'static, str>,
    action: Cow<'static, str>,
}

/// An entity type and action that are not in the catalog, or a malformed
/// custom object key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownEvent {
    pub entity_type: String,
    pub action: String,
}

impl fmt::Display for UnknownEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "`{}:{}` is not an entity event in the catalog",
            self.entity_type, self.action
        )
    }
}

impl std::error::Error for UnknownEvent {}

/// The actions a custom object record emits (`CUSTOM_OBJECT_ACTIONS`).
pub const CUSTOM_OBJECT_ACTIONS: [&str; 3] = ["created", "updated", "deleted"];

impl EventType {
    /// A catalog pair named at runtime, checked against the catalog
    /// (`isKnownAction`). Code that knows the event at compile time passes the
    /// [`EventName`] constant instead.
    pub fn catalog(entity_type: &str, action: &str) -> Result<Self, UnknownEvent> {
        entity_events::ALL
            .iter()
            .find(|(known, _)| *known == entity_type)
            .and_then(|(known, actions)| {
                actions.iter().find(|a| **a == action).map(|a| {
                    Self::from(EventName {
                        entity_type: known,
                        action: a,
                    })
                })
            })
            .ok_or_else(|| UnknownEvent {
                entity_type: entity_type.to_owned(),
                action: action.to_owned(),
            })
    }

    /// A custom object record event: `entity_key` is `co_<slug>` (resolved
    /// from the tenant's `custom_objects` table by the caller; this checks the
    /// shape only), `action` one of [`CUSTOM_OBJECT_ACTIONS`].
    pub fn custom_object(entity_key: &str, action: &str) -> Result<Self, UnknownEvent> {
        match CUSTOM_OBJECT_ACTIONS.iter().find(|a| **a == action) {
            Some(known) if is_custom_object_entity_key(entity_key) => Ok(Self {
                entity_type: Cow::Owned(entity_key.to_owned()),
                action: Cow::Borrowed(known),
            }),
            _ => Err(UnknownEvent {
                entity_type: entity_key.to_owned(),
                action: action.to_owned(),
            }),
        }
    }

    pub fn entity_type(&self) -> &str {
        &self.entity_type
    }

    pub fn action(&self) -> &str {
        &self.action
    }

    /// `customer:created`.
    pub fn wire(&self) -> String {
        format!("{}:{}", self.entity_type, self.action)
    }
}

impl From<EventName> for EventType {
    fn from(name: EventName) -> Self {
        Self {
            entity_type: Cow::Borrowed(name.entity_type),
            action: Cow::Borrowed(name.action),
        }
    }
}

/// `co_` + a slug of a lowercase letter then up to 23 of `[a-z0-9_]`
/// (`isCustomObjectEntityKey`).
pub fn is_custom_object_entity_key(key: &str) -> bool {
    let Some(slug) = key.strip_prefix("co_") else {
        return false;
    };
    let mut chars = slug.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && slug.len() <= 24
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// One mutation to publish: what a route passes to `publishEntityEvent`
/// besides the context.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityEvent {
    pub event: EventType,
    pub entity_id: String,
    /// The entity after the mutation.
    pub data: Value,
    /// Only on updates: field → `{ "old": …, "new": … }`. `None` leaves it
    /// off the wire; an empty map is sent, as in TypeScript.
    pub changes: Option<serde_json::Map<String, Value>>,
    /// When non-empty, only these users get the realtime event.
    pub access_user_ids: Vec<String>,
    /// Chain depth of the WeldConnect run that caused the mutation.
    pub workflow_depth: Option<u32>,
}

impl EntityEvent {
    pub fn new(event: impl Into<EventType>, entity_id: impl Into<String>, data: Value) -> Self {
        Self {
            event: event.into(),
            entity_id: entity_id.into(),
            data,
            changes: None,
            access_user_ids: Vec::new(),
            workflow_depth: None,
        }
    }

    #[must_use]
    pub fn with_changes(mut self, changes: serde_json::Map<String, Value>) -> Self {
        self.changes = Some(changes);
        self
    }

    #[must_use]
    pub fn with_access_user_ids(mut self, user_ids: Vec<String>) -> Self {
        self.access_user_ids = user_ids;
        self
    }

    #[must_use]
    pub fn with_workflow_depth(mut self, depth: u32) -> Self {
        self.workflow_depth = Some(depth);
        self
    }
}

/// `metadata` of the hub message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMetadata {
    pub workspace_id: String,
    pub user_id: String,
    /// `Date.prototype.toISOString()`: UTC, milliseconds, `Z`.
    pub timestamp: String,
    pub source: EventSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_depth: Option<u32>,
}

/// The hub message (`EntityEventMessage`). Field order is the TypeScript
/// object's, so the JSON matches it byte for byte.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityEventMessage {
    /// `evt_` + 16 hex characters.
    pub id: String,
    /// `customer:created`.
    pub event_type: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_user_ids: Option<Vec<String>>,
    pub metadata: EventMetadata,
}

impl EntityEventMessage {
    /// Builds the message as `enqueueHubEntityEvent` does: sensitive columns
    /// scrubbed from `data` and `changes`, `changes` and `accessUserIds` only
    /// when there are some. `id` and `now` are parameters so tests can pin
    /// them; [`new_event_id`] and `OffsetDateTime::now_utc()` in production.
    pub fn build(
        workspace_id: &str,
        user_id: &str,
        source: EventSource,
        event: EntityEvent,
        id: String,
        now: OffsetDateTime,
    ) -> Self {
        let changes = event
            .changes
            .map(|changes| scrub_sensitive_keys(Value::Object(changes)));
        Self {
            id,
            event_type: event.event.wire(),
            entity_type: event.event.entity_type.into_owned(),
            entity_id: event.entity_id,
            action: event.event.action.into_owned(),
            data: scrub_sensitive_keys(event.data),
            changes,
            access_user_ids: (!event.access_user_ids.is_empty()).then_some(event.access_user_ids),
            metadata: EventMetadata {
                workspace_id: workspace_id.to_owned(),
                user_id: user_id.to_owned(),
                timestamp: iso_timestamp(now),
                source,
                workflow_depth: event.workflow_depth,
            },
        }
    }
}

/// A fresh event id: `evt_` + 8 random bytes in hex (`generateEventId`).
///
/// # Panics
///
/// When the operating system has no random source.
pub fn new_event_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    event_id_from_bytes(bytes)
}

/// The event id for these 8 bytes.
pub fn event_id_from_bytes(bytes: [u8; 8]) -> String {
    format!("evt_{}", hex::encode(bytes))
}

/// `new Date(…).toISOString()`: `2027-01-15T08:00:00.123Z`.
pub fn iso_timestamp(at: OffsetDateTime) -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    at.to_offset(time::UtcOffset::UTC)
        .format(&format)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use weldsuite_catalogs::entity_events::KNOWLEDGE_PAGE_MOVED;

    use super::*;

    #[test]
    fn timestamps_match_to_iso_string() {
        let at =
            OffsetDateTime::from_unix_timestamp_nanos(1_800_000_000_123_999_999).expect("in range");
        assert_eq!(iso_timestamp(at), "2027-01-15T08:00:00.123Z");
        let epoch = OffsetDateTime::UNIX_EPOCH;
        assert_eq!(iso_timestamp(epoch), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn event_ids_are_evt_and_sixteen_hex_characters() {
        let id = new_event_id();
        assert_eq!(id.len(), 20);
        assert!(id.starts_with("evt_"));
        assert!(id[4..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, new_event_id());
    }

    #[test]
    fn runtime_names_are_checked_against_the_catalog() {
        assert_eq!(
            EventType::catalog("knowledge_page", "moved").expect("known"),
            EventType::from(KNOWLEDGE_PAGE_MOVED)
        );
        assert!(EventType::catalog("knowledge_page", "signed").is_err());
        assert!(EventType::catalog("co_machine", "created").is_err());
    }

    #[test]
    fn custom_object_keys_are_shape_checked() {
        let event = EventType::custom_object("co_machine", "created").expect("valid");
        assert_eq!(event.wire(), "co_machine:created");
        assert!(EventType::custom_object("co_machine", "archived").is_err());
        assert!(EventType::custom_object("machine", "created").is_err());
        assert!(EventType::custom_object("co_Machine", "created").is_err());
        assert!(EventType::custom_object("co_1machine", "created").is_err());
        assert!(EventType::custom_object(&format!("co_{}", "a".repeat(24)), "created").is_ok());
        assert!(EventType::custom_object(&format!("co_{}", "a".repeat(25)), "created").is_err());
    }
}
