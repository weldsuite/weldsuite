//! The `JetStream` event bus against a real NATS server with `JetStream` on.
//!
//! Runs when `WELDSUITE_TEST_NATS_URL` points at one (`nats-server -js`), e.g.
//! `nats://127.0.0.1:4222`; otherwise each test returns early. Each run makes
//! its own stream and deletes it afterwards.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_nats::header::NATS_MESSAGE_ID;
use serde_json::json;
use weldsuite_adapters_oss::{JetStreamEventBus, NatsOptions, entity_events_stream_config};
use weldsuite_catalogs::entity_events::KNOWLEDGE_PAGE_CREATED;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, TaskTracker};
use weldsuite_ports::{BusMessage, EventBus};

#[tokio::test]
async fn entity_events_land_in_the_stream_once_per_id() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_NATS_URL") else {
        eprintln!("WELDSUITE_TEST_NATS_URL is not set; skipping");
        return;
    };
    let run = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let stream_name = format!("WELDSUITE_TEST_{run}");
    let prefix = format!("weldsuite-test-{run}");

    let bus = JetStreamEventBus::connect(&NatsOptions {
        url,
        name: Some("weldsuite-adapters-oss-test".to_owned()),
        ..NatsOptions::default()
    })
    .await
    .expect("connects");
    bus.ensure_stream(entity_events_stream_config(&stream_name, &prefix))
        .await
        .expect("stream");
    // A second call leaves the existing stream alone.
    bus.ensure_stream(entity_events_stream_config(&stream_name, &prefix))
        .await
        .expect("stream again");

    let bus = Arc::new(bus);
    let publisher = EntityEventPublisher::new(Some(bus.clone()), TaskTracker::new())
        .with_subject_prefix(&prefix);
    publisher
        .publish_and_wait(
            &EventContext::from_ids("ws_1", Some("org_1"), "user_1"),
            EntityEvent::new(KNOWLEDGE_PAGE_CREATED, "kp_1", json!({ "id": "kp_1" })),
        )
        .await;

    // The same id twice inside the duplicate window is stored once.
    let duplicate = BusMessage::json(format!("{prefix}.customer.updated"), "evt_dup", &json!({}))
        .expect("serialises");
    bus.publish(duplicate.clone()).await.expect("first");
    bus.publish(duplicate).await.expect("second is acked too");

    let mut stream = bus
        .context()
        .get_stream(&stream_name)
        .await
        .expect("stream exists");
    assert_eq!(stream.info().await.expect("info").state.messages, 2);

    let stored = stream.get_raw_message(1).await.expect("first message");
    assert_eq!(
        stored.subject.as_str(),
        format!("{prefix}.knowledge_page.created")
    );
    let payload: serde_json::Value = serde_json::from_slice(&stored.payload).expect("json");
    assert_eq!(payload["eventType"], "knowledge_page:created");
    assert_eq!(payload["metadata"]["workspaceId"], "org_1");
    assert_eq!(
        stored
            .headers
            .get(NATS_MESSAGE_ID)
            .map(|id| id.as_str().to_owned()),
        payload["id"].as_str().map(str::to_owned),
        "the event id is the dedupe id"
    );

    bus.context()
        .delete_stream(&stream_name)
        .await
        .expect("cleanup");
}
