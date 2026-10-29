//! The event bus: where entity events go. Replaces the `ENTITY_EVENTS` hub
//! queue that `publishEntityEvent` sends to
//! (`packages/core/entity-events/src/publisher.ts`); fan-out to audit,
//! search, webhooks, workflows, agents and realtime happens behind it.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;

use crate::{BoxFuture, PortError};

/// One message for the bus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusMessage {
    /// Where it goes, `entity-events.customer.created`. Subjects are
    /// dot-separated tokens, as in NATS.
    pub subject: String,
    /// Unique id; the bus drops a second message with the same id inside its
    /// dedupe window (the `evt_…` id for entity events, EVT-002).
    pub id: String,
    /// The serialised message.
    pub payload: Vec<u8>,
}

impl BusMessage {
    /// A message whose payload is `value` as JSON.
    pub fn json<T: Serialize + ?Sized>(
        subject: impl Into<String>,
        id: impl Into<String>,
        value: &T,
    ) -> Result<Self, PortError> {
        Ok(Self {
            subject: subject.into(),
            id: id.into(),
            payload: serde_json::to_vec(value)?,
        })
    }

    /// The payload parsed as JSON.
    pub fn payload_json(&self) -> Result<serde_json::Value, PortError> {
        Ok(serde_json::from_slice(&self.payload)?)
    }
}

/// A durable, at-least-once bus. `publish` returns once the bus has stored
/// the message.
pub trait EventBus: Send + Sync {
    fn publish(&self, message: BusMessage) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// Object-safe [`EventBus`], for `Arc<dyn DynEventBus>`.
pub trait DynEventBus: Send + Sync {
    fn publish_boxed(&self, message: BusMessage) -> BoxFuture<'_, Result<(), PortError>>;
}

impl<B: EventBus> DynEventBus for B {
    fn publish_boxed(&self, message: BusMessage) -> BoxFuture<'_, Result<(), PortError>> {
        Box::pin(self.publish(message))
    }
}

impl EventBus for dyn DynEventBus {
    fn publish(&self, message: BusMessage) -> impl Future<Output = Result<(), PortError>> + Send {
        self.publish_boxed(message)
    }
}

impl<B: EventBus + ?Sized> EventBus for Arc<B> {
    fn publish(&self, message: BusMessage) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).publish(message)
    }
}

/// [`EventBus`] double: keeps every message, in order. `failing()` makes it
/// refuse every publish (and still record the attempt), to prove a failed
/// publish never reaches the response.
#[derive(Debug, Default)]
pub struct RecordingEventBus {
    messages: Mutex<Vec<BusMessage>>,
    fail: bool,
}

impl RecordingEventBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// A bus that records each message and then reports a failure.
    pub fn failing() -> Self {
        Self {
            messages: Mutex::default(),
            fail: true,
        }
    }

    /// Every message published so far.
    pub fn messages(&self) -> Vec<BusMessage> {
        self.lock().clone()
    }

    /// Every payload, parsed. Panics on a payload that is not JSON, which in
    /// a test is the failure you want.
    ///
    /// # Panics
    ///
    /// When a recorded payload is not JSON.
    pub fn payloads(&self) -> Vec<serde_json::Value> {
        self.lock()
            .iter()
            .map(|message| message.payload_json().expect("recorded payloads are JSON"))
            .collect()
    }

    /// Forgets what was recorded.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> MutexGuard<'_, Vec<BusMessage>> {
        self.messages.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl EventBus for RecordingEventBus {
    fn publish(&self, message: BusMessage) -> impl Future<Output = Result<(), PortError>> + Send {
        self.lock().push(message);
        std::future::ready(if self.fail {
            Err(PortError::backend("RecordingEventBus is set to fail"))
        } else {
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn records_through_a_dyn_bus() {
        let recording = Arc::new(RecordingEventBus::new());
        let bus: Arc<dyn DynEventBus> = recording.clone();
        let message =
            BusMessage::json("a.b", "evt_1", &serde_json::json!({ "x": 1 })).expect("serialises");
        bus.publish(message.clone()).await.expect("publish");
        assert_eq!(recording.messages(), vec![message]);
        assert_eq!(recording.payloads(), vec![serde_json::json!({ "x": 1 })]);
    }

    #[tokio::test]
    async fn a_failing_bus_still_records() {
        let bus = RecordingEventBus::failing();
        let message = BusMessage::json("a", "1", &1).expect("serialises");
        assert!(bus.publish(message).await.is_err());
        assert_eq!(bus.messages().len(), 1);
    }
}
