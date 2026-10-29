//! Fire-and-forget publishing through the recording bus double.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use weldsuite_catalogs::entity_events::{CUSTOMER_UPDATED, KNOWLEDGE_PAGE_CREATED};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventSource, TaskTracker, publish_entity_event,
};
use weldsuite_ports::{BusMessage, EventBus, PortError, RecordingEventBus};

fn context() -> EventContext {
    EventContext::from_ids("ws_1", Some("org_1"), "user_1")
}

#[tokio::test]
async fn publishes_the_envelope_on_the_entity_subject() {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let publisher = EntityEventPublisher::new(Some(bus.clone()), tracker.clone());

    publish_entity_event(
        &publisher,
        &context(),
        KNOWLEDGE_PAGE_CREATED,
        "kp_1",
        &json!({ "id": "kp_1", "sensitiveEncrypted": "x" }),
    );
    tracker.close();
    tracker.wait().await;

    let messages = bus.messages();
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message.subject, "entity-events.knowledge_page.created");
    let payload = message.payload_json().expect("json");
    assert_eq!(payload["id"], message.id.as_str());
    assert_eq!(payload["eventType"], "knowledge_page:created");
    assert_eq!(payload["data"], json!({ "id": "kp_1" }));
    assert_eq!(payload["metadata"]["workspaceId"], "org_1");
    assert_eq!(payload["metadata"]["source"], "api");
}

/// A bus that takes its time, to show `publish` does not wait for it.
struct SlowBus(Arc<RecordingEventBus>);

impl EventBus for SlowBus {
    async fn publish(&self, message: BusMessage) -> Result<(), PortError> {
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.0.publish(message).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn publish_returns_before_the_bus_and_shutdown_waits_for_it() {
    let recording = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let publisher =
        EntityEventPublisher::new(Some(Arc::new(SlowBus(recording.clone()))), tracker.clone());

    let started = Instant::now();
    publisher.publish(
        &context(),
        EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({ "id": "cus_1" })),
    );
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(recording.messages(), Vec::new());

    tracker.close();
    tracker.wait().await;
    assert_eq!(recording.messages().len(), 1);
}

#[tokio::test]
async fn failures_and_a_missing_bus_never_reach_the_caller() {
    let failing = Arc::new(RecordingEventBus::failing());
    let tracker = TaskTracker::new();
    let publisher = EntityEventPublisher::new(Some(failing.clone()), tracker.clone());
    publisher.publish(
        &context(),
        EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
    );
    publisher
        .publish_and_wait(
            &context().with_source(EventSource::System),
            EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
        )
        .await;
    tracker.close();
    tracker.wait().await;
    assert_eq!(failing.messages().len(), 2);

    let none = EntityEventPublisher::new(None, TaskTracker::new());
    none.publish(
        &context(),
        EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
    );
    none.publish_and_wait(
        &context(),
        EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
    )
    .await;
    assert!(none.tracker().is_empty());
}

#[test]
fn publishing_outside_a_runtime_drops_the_event_without_panicking() {
    let bus = Arc::new(RecordingEventBus::new());
    let publisher = EntityEventPublisher::new(Some(bus.clone()), TaskTracker::new());
    publisher.publish(
        &context(),
        EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
    );
    assert_eq!(bus.messages(), Vec::new());
}

#[tokio::test]
async fn the_subject_prefix_is_configurable() {
    let bus = Arc::new(RecordingEventBus::new());
    let publisher = EntityEventPublisher::new(Some(bus.clone()), TaskTracker::new())
        .with_subject_prefix("eu.entity-events");
    publisher
        .publish_and_wait(
            &context(),
            EntityEvent::new(CUSTOMER_UPDATED, "cus_1", json!({})),
        )
        .await;
    assert_eq!(
        bus.messages()[0].subject,
        "eu.entity-events.customer.updated"
    );
}
