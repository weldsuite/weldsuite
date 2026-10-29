//! `publishEntityEvent` / `publishEntityEventRaw`
//! (`packages/core/entity-events/src/publisher.ts`): build the hub message and
//! hand it to the event bus. The request version never blocks or fails the
//! response; the send runs as a task on a [`TaskTracker`] (the workers'
//! `executionCtx.waitUntil`), which graceful shutdown closes and waits on.

use std::sync::Arc;

use serde::Serialize;
use time::OffsetDateTime;
use tokio_util::task::TaskTracker;
use weldsuite_ports::{BusMessage, DynEventBus, EventBus};

use crate::context::EventContext;
use crate::envelope::{EntityEvent, EntityEventMessage, EventType, new_event_id};

/// The subject prefix of entity events on the bus: a message goes to
/// `entity-events.<entity_type>.<action>`.
pub const DEFAULT_SUBJECT_PREFIX: &str = "entity-events";

/// Publishes entity events. Cheap to clone; one per process, in the app
/// state.
#[derive(Clone)]
pub struct EntityEventPublisher {
    bus: Option<Arc<dyn DynEventBus>>,
    tracker: TaskTracker,
    subject_prefix: Arc<str>,
}

impl std::fmt::Debug for EntityEventPublisher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EntityEventPublisher")
            .field("bus", &self.bus.is_some())
            .field("subject_prefix", &self.subject_prefix)
            .finish_non_exhaustive()
    }
}

impl EntityEventPublisher {
    /// `bus` of `None` is a worker without the `ENTITY_EVENTS` binding: every
    /// publish logs a warning and does nothing. Fire-and-forget publishes run
    /// on `tracker`; on shutdown, `tracker.close()` then `tracker.wait()`.
    pub fn new(bus: Option<Arc<dyn DynEventBus>>, tracker: TaskTracker) -> Self {
        Self {
            bus,
            tracker,
            subject_prefix: Arc::from(DEFAULT_SUBJECT_PREFIX),
        }
    }

    #[must_use]
    pub fn with_subject_prefix(mut self, prefix: &str) -> Self {
        self.subject_prefix = Arc::from(prefix);
        self
    }

    /// Where in-flight publishes are tracked.
    pub fn tracker(&self) -> &TaskTracker {
        &self.tracker
    }

    /// `entity-events.customer.created`.
    pub fn subject(&self, event: &EventType) -> String {
        format!(
            "{}.{}.{}",
            self.subject_prefix,
            event.entity_type(),
            event.action()
        )
    }

    /// The bus message for `event` now, with a fresh id, and its event type
    /// for the logs.
    fn message(&self, context: &EventContext, event: EntityEvent) -> (BusMessage, String) {
        let subject = self.subject(&event.event);
        let message = EntityEventMessage::build(
            &context.workspace_id,
            &context.user_id,
            context.source,
            event,
            new_event_id(),
            OffsetDateTime::now_utc(),
        );
        let event_type = message.event_type.clone();
        let bus_message = BusMessage {
            subject,
            // Strings and JSON values only: serialising cannot fail.
            payload: serde_json::to_vec(&message).expect("an entity event message serialises"),
            id: message.id,
        };
        (bus_message, event_type)
    }

    /// Fire and forget (`publishEntityEvent`): returns at once; the send runs
    /// on the tracker and its failure is only logged. Outside a Tokio runtime
    /// the event is dropped with an error log rather than a panic.
    pub fn publish(&self, context: &EventContext, event: EntityEvent) {
        let Some(bus) = self.bus.clone() else {
            tracing::warn!(
                "entity events: no event bus configured; skipping {}",
                event.event.wire()
            );
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(
                "entity events: publish outside a Tokio runtime; dropping {}",
                event.event.wire()
            );
            return;
        };
        let (message, event_type) = self.message(context, event);
        self.tracker
            .spawn_on(send(bus, message, event_type), &runtime);
    }

    /// Publish and wait for the bus (`publishEntityEventRaw`), for jobs and
    /// consumers without a response to protect. Still never fails: a refused
    /// send is logged.
    pub async fn publish_and_wait(&self, context: &EventContext, event: EntityEvent) {
        let Some(bus) = self.bus.clone() else {
            tracing::warn!(
                "entity events: no event bus configured; skipping {}",
                event.event.wire()
            );
            return;
        };
        let (message, event_type) = self.message(context, event);
        send(bus, message, event_type).await;
    }
}

async fn send(bus: Arc<dyn DynEventBus>, message: BusMessage, event_type: String) {
    let id = message.id.clone();
    match bus.publish(message).await {
        Ok(()) => tracing::debug!(event_type, event_id = id, "entity events: published"),
        Err(error) => {
            tracing::error!(event_type, event_id = id, %error, "entity events: publish failed");
        }
    }
}

/// `publishEntityEvent({ c, entityType, action, entityId, data })`: the event
/// is a catalog constant (`weldsuite_catalogs::entity_events::CUSTOMER_CREATED`)
/// or an [`EventType`]. `data` that cannot be serialised is logged and the
/// event dropped; the caller's response is never affected.
pub fn publish_entity_event(
    publisher: &EntityEventPublisher,
    context: &EventContext,
    event: impl Into<EventType>,
    entity_id: impl Into<String>,
    data: &impl Serialize,
) {
    let event = event.into();
    match serde_json::to_value(data) {
        Ok(data) => publisher.publish(context, EntityEvent::new(event, entity_id, data)),
        Err(error) => tracing::error!(
            %error,
            "entity events: data for {} does not serialise; dropping the event",
            event.wire()
        ),
    }
}
