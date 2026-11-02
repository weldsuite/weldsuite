//! Entity events in the order the code publishes them.
//!
//! `publishEntityEvent` hands each event to the queue as it is called, so a
//! route that publishes several (`contact_link:deleted`, then
//! `person:updated`, `company:updated`) sends them in that order. The Rust
//! publisher sends each on its own task; [`OrderedEvents`] sends one
//! request's events from one task, in order, still without holding up the
//! response.

use std::sync::Mutex;

use serde_json::{Map, Value};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext};

/// One request's (or job step's) events, sent in publish order.
pub struct OrderedEvents {
    publisher: EntityEventPublisher,
    context: EventContext,
    sender: Mutex<Option<UnboundedSender<EntityEvent>>>,
}

impl OrderedEvents {
    pub fn new(publisher: EntityEventPublisher, context: EventContext) -> Self {
        Self {
            publisher,
            context,
            sender: Mutex::new(None),
        }
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub fn publish(&self, event: EventName, entity_id: &str, data: Value) {
        self.send(EntityEvent::new(event, entity_id, data));
    }

    /// `publishEntityEvent({ ..., changes })`.
    pub fn publish_with_changes(
        &self,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        let mut entity_event = EntityEvent::new(event, entity_id, data);
        if let Some(changes) = changes {
            entity_event = entity_event.with_changes(changes);
        }
        self.send(entity_event);
    }

    /// Queue an event; the first one starts the task that sends them.
    pub fn send(&self, event: EntityEvent) {
        let Ok(mut slot) = self.sender.lock() else {
            return;
        };
        if slot.is_none() {
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                tracing::error!("entity events: publish outside a Tokio runtime; dropping");
                return;
            };
            let (sender, mut receiver) = unbounded_channel::<EntityEvent>();
            let publisher = self.publisher.clone();
            let context = self.context.clone();
            self.publisher.tracker().spawn_on(
                async move {
                    while let Some(event) = receiver.recv().await {
                        publisher.publish_and_wait(&context, event).await;
                    }
                },
                &runtime,
            );
            *slot = Some(sender);
        }
        if let Some(sender) = slot.as_ref() {
            let _ = sender.send(event);
        }
    }
}
