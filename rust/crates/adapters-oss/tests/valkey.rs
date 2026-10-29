//! The Valkey cache and realtime adapters against a real Valkey.
//!
//! Runs when `WELDSUITE_TEST_VALKEY_URL` points at a throwaway Valkey (or
//! Redis), e.g. `redis://127.0.0.1:6379`; otherwise each test returns early.
//! Keys and channels get a per-run prefix, so a shared server is fine.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::json;
use weldsuite_adapters_oss::realtime::{HubMessage, parse_hub_message};
use weldsuite_adapters_oss::{ValkeyCache, ValkeyRealtime, connect_valkey};
use weldsuite_ports::{Cache, CacheExt, RealtimeMessage, RealtimePublisher, Room};

fn url() -> Option<String> {
    let url = std::env::var("WELDSUITE_TEST_VALKEY_URL").ok();
    if url.is_none() {
        eprintln!("WELDSUITE_TEST_VALKEY_URL is not set; skipping");
    }
    url
}

fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("weldsuite-test:{nanos}:")
}

#[tokio::test]
async fn cache_round_trips_expires_and_deletes() {
    let Some(url) = url() else { return };
    let cache = ValkeyCache::new(connect_valkey(&url).await.expect("connects"), prefix());

    assert_eq!(cache.get("missing").await.expect("get"), None);
    cache.put("a", "1", None).await.expect("put");
    assert_eq!(cache.get("a").await.expect("get").as_deref(), Some("1"));

    cache
        .put_json("ws", &json!({ "id": "ws_1", "apps": ["crm"] }), None)
        .await
        .expect("put json");
    let value: Option<serde_json::Value> = cache.get_json("ws").await.expect("get json");
    assert_eq!(value, Some(json!({ "id": "ws_1", "apps": ["crm"] })));

    cache
        .put("short", "x", Some(Duration::from_millis(50)))
        .await
        .expect("put with ttl");
    cache
        .put("zero", "x", Some(Duration::ZERO))
        .await
        .expect("a zero ttl is accepted");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(cache.get("short").await.expect("get"), None);
    assert_eq!(cache.get("zero").await.expect("get"), None);

    cache.delete("a").await.expect("delete");
    cache.delete("ws").await.expect("delete");
    assert_eq!(cache.get("a").await.expect("get"), None);
}

#[tokio::test]
async fn realtime_publishes_the_payload_on_the_channel() {
    let Some(url) = url() else { return };
    let prefix = prefix();
    let realtime = ValkeyRealtime::new(connect_valkey(&url).await.expect("connects"), &prefix);
    let message = RealtimeMessage::workspace(
        "org_1",
        "knowledge_page",
        "created",
        json!({ "id": "kp_1" }),
        "user_1",
    );

    let client = redis::Client::open(url.as_str()).expect("url");
    let mut subscriber = client.get_async_pubsub().await.expect("pubsub");
    subscriber
        .subscribe(realtime.channel(&message))
        .await
        .expect("subscribe");
    assert_eq!(
        realtime.channel(&message),
        format!("{prefix}workspace:org_1")
    );

    realtime.publish(&message).await.expect("publish");

    let mut messages = subscriber.on_message();
    let received = tokio::time::timeout(Duration::from_secs(5), messages.next())
        .await
        .expect("a message within 5 s")
        .expect("the stream is open");
    let payload: String = received.get_payload().expect("text payload");
    let envelope: serde_json::Value = serde_json::from_str(&payload).expect("json");
    assert_eq!(envelope["body"], message.payload, "the body as published");
    let id = envelope["eventId"].as_str().expect("stamped");
    assert_eq!(id.len(), 16);
    assert!(envelope["ts"].as_u64().is_some());
    let Some(HubMessage::Event(event)) = parse_hub_message(payload.as_bytes()) else {
        panic!("a hub event");
    };
    assert_eq!(event.event_id, id);
    assert_eq!(event.topic, "knowledge_page");
    assert_eq!(event.access, None);

    // The next event continues the counter, and both are in the log.
    realtime.publish(&message).await.expect("publish");
    let second = tokio::time::timeout(Duration::from_secs(5), messages.next())
        .await
        .expect("a message within 5 s")
        .expect("the stream is open");
    let second: serde_json::Value =
        serde_json::from_str(&second.get_payload::<String>().expect("text")).expect("json");
    let first_seq: u64 = id.parse().expect("number");
    let second_seq: u64 = second["eventId"]
        .as_str()
        .expect("id")
        .parse()
        .expect("number");
    assert_eq!(second_seq, first_seq + 1);
}

#[tokio::test]
async fn access_lists_travel_beside_the_data_and_chat_messages_are_numbered() {
    let Some(url) = url() else { return };
    let prefix = prefix();
    let realtime = ValkeyRealtime::new(connect_valkey(&url).await.expect("connects"), &prefix);
    let client = redis::Client::open(url.as_str()).expect("url");
    let mut subscriber = client.get_async_pubsub().await.expect("pubsub");
    subscriber
        .subscribe(&[
            format!("{prefix}workspace:org_1"),
            format!("{prefix}chat:ch_1"),
            format!("{prefix}support:org_1"),
        ])
        .await
        .expect("subscribe");
    let mut messages = subscriber.on_message();
    let mut next = async || -> String {
        tokio::time::timeout(Duration::from_secs(5), messages.next())
            .await
            .expect("a message within 5 s")
            .expect("open")
            .get_payload()
            .expect("text")
    };

    let personal = RealtimeMessage::personal(
        "org_1",
        "notification.u1",
        "created",
        json!({ "id": "n1" }),
        "u1",
    );
    realtime.publish(&personal).await.expect("publish");
    let Some(HubMessage::Event(event)) = parse_hub_message(next().await.as_bytes()) else {
        panic!("a hub event");
    };
    assert_eq!(event.access, Some(vec!["u1".to_owned()]));
    assert_eq!(
        event.data.as_deref().map(serde_json::value::RawValue::get),
        Some(r#"{"id":"n1"}"#)
    );

    let chat = RealtimeMessage::room(Room::Chat, "ch_1", json!({ "type": "message", "id": "m1" }));
    realtime.publish(&chat).await.expect("publish");
    let first: serde_json::Value = serde_json::from_str(&next().await).expect("json");
    realtime.publish(&chat).await.expect("publish");
    let second: serde_json::Value = serde_json::from_str(&next().await).expect("json");
    assert_eq!(first["id"], "m1");
    assert_eq!(
        second["seq"].as_u64(),
        first["seq"].as_u64().map(|seq| seq + 1)
    );

    let support =
        RealtimeMessage::room(Room::Support, "org_1", json!({ "type": "reply", "ts": 1 }));
    realtime.publish(&support).await.expect("publish");
    let raw: serde_json::Value = serde_json::from_str(&next().await).expect("json");
    assert_eq!(
        raw,
        json!({ "type": "reply", "ts": 1 }),
        "other rooms get the body as it is"
    );

    let presence = realtime
        .presence("org_1", &[])
        .await
        .expect("presence reads");
    assert!(presence.is_empty(), "nobody connected");
}
