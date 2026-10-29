//! The Valkey cache and realtime adapters against a real Valkey.
//!
//! Runs when `WELDSUITE_TEST_VALKEY_URL` points at a throwaway Valkey (or
//! Redis), e.g. `redis://127.0.0.1:6379`; otherwise each test returns early.
//! Keys and channels get a per-run prefix, so a shared server is fine.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::json;
use weldsuite_adapters_oss::{ValkeyCache, ValkeyRealtime, connect_valkey};
use weldsuite_ports::{Cache, CacheExt, RealtimeMessage, RealtimePublisher};

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
async fn counters_increment_atomically_and_expire() {
    let Some(url) = url() else { return };
    let cache = ValkeyCache::new(connect_valkey(&url).await.expect("connects"), prefix());

    assert_eq!(cache.increment("n", 3, None).await.expect("incr"), 3);
    assert_eq!(cache.increment("n", -1, None).await.expect("incr"), 2);
    assert_eq!(cache.get("n").await.expect("get").as_deref(), Some("2"));
    cache.put("text", "x", None).await.expect("put");
    assert!(cache.increment("text", 1, None).await.is_err());

    cache
        .increment("short", 5, Some(Duration::from_millis(50)))
        .await
        .expect("incr with ttl");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(cache.increment("short", 1, None).await.expect("incr"), 1);
    for key in ["n", "text", "short"] {
        cache.delete(key).await.expect("delete");
    }
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
    let payload: serde_json::Value = serde_json::from_str(&payload).expect("json");
    assert_eq!(payload, message.payload);
}
