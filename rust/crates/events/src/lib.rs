//! Entity events, as `@weldsuite/entity-events` publishes them
//! (`packages/core/entity-events/src/`): every mutation route publishes one
//! so audit logging, workflows, analytics, search, realtime and agents stay
//! wired.
//!
//! ```ignore
//! use weldsuite_catalogs::entity_events::KNOWLEDGE_PAGE_CREATED;
//!
//! // after the insert succeeds, before returning:
//! publish_entity_event(&state.events, &event_context, KNOWLEDGE_PAGE_CREATED, &page.id, &page);
//! ```
//!
//! The event name is a catalog constant, so a typo fails to compile as it
//! does in TypeScript; names known only at runtime go through
//! [`EventType::catalog`] or [`EventType::custom_object`]. The message on the
//! bus is the TypeScript `EntityEventMessage`, byte for byte (golden test in
//! `tests/envelope.rs`).

mod context;
mod envelope;
mod publisher;
mod scrub;

pub use context::EventContext;
pub use envelope::{
    CUSTOM_OBJECT_ACTIONS, EntityEvent, EntityEventMessage, EventMetadata, EventSource, EventType,
    UnknownEvent, event_id_from_bytes, is_custom_object_entity_key, iso_timestamp, new_event_id,
};
pub use publisher::{DEFAULT_SUBJECT_PREFIX, EntityEventPublisher, publish_entity_event};
pub use scrub::{SENSITIVE_KEYS, scrub_sensitive_keys};
pub use tokio_util::task::TaskTracker;
