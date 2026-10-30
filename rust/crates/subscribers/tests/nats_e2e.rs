//! End to end through a real NATS: an entity event published with
//! `weldsuite-events` (as `serve` publishes it) is consumed by the audit
//! subscriber on a durable `JetStream` consumer and lands as an `audit_logs`
//! row, once, though it was published twice; and a subscriber that keeps
//! failing ends in the dead-letter stream.
//!
//! Needs `WELDSUITE_TEST_NATS_URL` (`nats-server -js`) and
//! `WELDSUITE_TEST_TENANT_URL`; skips without them. Each run makes its own
//! streams and deletes them afterwards.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::watch;
use weldsuite_adapters_oss::{
    ConsumerSpec, JetStreamEventBus, NatsOptions, dead_letter_stream_config, ensure_consumer,
    entity_events_stream_config, run_consumer,
};
use weldsuite_catalogs::entity_events::CUSTOMER_CREATED;
use weldsuite_events::{
    EntityEvent, EntityEventMessage, EntityEventPublisher, EventContext, EventSource, TaskTracker,
    new_event_id,
};
use weldsuite_ports::{BatchHandler, BoxFuture, BusMessage, Delivery, Disposition, EventBus};
use weldsuite_subscribers::{AuditSubscriber, StaticTenants};

fn spec(stream: &str, prefix: &str, durable: &str, max_retries: u32) -> ConsumerSpec {
    ConsumerSpec {
        stream: stream.to_owned(),
        durable: durable.to_owned(),
        description: format!("e2e {durable}"),
        filter_subject: format!("{prefix}.>"),
        deliver_new_only: false,
        max_retries,
        max_deferrals: 0,
        retry_backoff: vec![Duration::from_millis(100)],
        ack_wait: Duration::from_secs(30),
        batch_size: 10,
        batch_wait: Duration::from_millis(500),
        workers: 1,
        dead_letter_subject: format!("{prefix}-dlq.{durable}"),
        dedupe_capacity: 100,
    }
}

/// A subscriber whose sink is always down.
struct AlwaysFails;

impl BatchHandler for AlwaysFails {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(std::future::ready(
            batch
                .iter()
                .map(|_| Disposition::retry("sink down"))
                .collect(),
        ))
    }
}

async fn wait_for<F, Fut>(mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    for _ in 0..100 {
        if check().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one scenario, start to finish")]
async fn an_event_published_by_serve_becomes_one_audit_row() {
    let (Ok(nats_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_NATS_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_NATS_URL or WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let run = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let stream = format!("CONSUME_E2E_{run}");
    let dead_letters = format!("CONSUME_E2E_DLQ_{run}");
    let prefix = format!("consume-e2e-{run}");
    let pool = PgPool::connect(&tenant_url).await.expect("tenant database");
    let org = format!("org_e2e_{run}");

    let bus = JetStreamEventBus::connect(&NatsOptions {
        url: nats_url,
        name: Some("weldsuite-consume-e2e".to_owned()),
        ..NatsOptions::default()
    })
    .await
    .expect("connects");
    bus.ensure_stream(entity_events_stream_config(&stream, &prefix))
        .await
        .expect("hub stream");
    bus.ensure_stream(dead_letter_stream_config(
        &dead_letters,
        &format!("{prefix}-dlq"),
        1,
    ))
    .await
    .expect("dead-letter stream");

    // Published as `serve` does, then the same message again (a retried
    // publish): the stream keeps one.
    let publisher = EntityEventPublisher::new(Some(Arc::new(bus.clone())), TaskTracker::new())
        .with_subject_prefix(&prefix);
    let context = EventContext::new(&org, "fx_user_e2e", EventSource::Web);
    publisher
        .publish_and_wait(
            &context,
            EntityEvent::new(CUSTOMER_CREATED, "cus_e2e", json!({ "name": "E2E Corp" })),
        )
        .await;
    let id = new_event_id();
    let message = EntityEventMessage::build(
        &org,
        "fx_user_e2e",
        EventSource::Api,
        EntityEvent::new(
            CUSTOMER_CREATED,
            "cus_e2e_2",
            json!({ "name": "Twice Ltd" }),
        ),
        id.clone(),
        time::OffsetDateTime::now_utc(),
    );
    for _ in 0..2 {
        bus.publish(
            BusMessage::json(format!("{prefix}.customer.created"), id.clone(), &message)
                .expect("serialises"),
        )
        .await
        .expect("stored");
    }

    let (stop, stopping) = watch::channel(false);
    let audit_spec = spec(&stream, &prefix, "audit", 3);
    let audit = ensure_consumer(bus.context(), &audit_spec)
        .await
        .expect("audit consumer");
    let tenants = StaticTenants::new().with(&format!("ws_e2e_{run}"), Some(&org), pool.clone());
    let audit_task = tokio::spawn(run_consumer(
        bus.context().clone(),
        audit,
        Arc::new(audit_spec),
        Arc::new(AuditSubscriber::new(Arc::new(tenants))),
        stopping.clone(),
    ));
    let failing_spec = spec(&stream, &prefix, "failing", 1);
    let failing = ensure_consumer(bus.context(), &failing_spec)
        .await
        .expect("failing consumer");
    let failing_task = tokio::spawn(run_consumer(
        bus.context().clone(),
        failing,
        Arc::new(failing_spec),
        Arc::new(AlwaysFails),
        stopping,
    ));

    let rows = || async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(a) from audit_logs a where metadata->>'workspaceId' = $1 order by entity_id",
        )
        .bind(&org)
        .fetch_all(&pool)
        .await
        .expect("audit rows");
        rows
    };
    assert!(
        wait_for(|| async { rows().await.len() >= 2 }).await,
        "the audit rows arrive"
    );

    // Both events failed twice on `failing` (max_retries 1): dead letters.
    let dlq = bus
        .context()
        .get_stream(&dead_letters)
        .await
        .expect("dead-letter stream");
    let dlq_name = dead_letters.clone();
    let context = bus.context().clone();
    assert!(
        wait_for(|| {
            let context = context.clone();
            let name = dlq_name.clone();
            async move {
                let mut stream = context.get_stream(&name).await.expect("stream");
                stream.info().await.map_or(0, |info| info.state.messages) >= 2
            }
        })
        .await,
        "the failing subscriber's events are dead-lettered"
    );

    let _ = stop.send(true);
    tokio::time::timeout(Duration::from_secs(10), async {
        let _ = audit_task.await;
        let _ = failing_task.await;
    })
    .await
    .expect("consumers drain and stop");

    // One row per event, the duplicate publish included.
    let written = rows().await;
    assert_eq!(written.len(), 2, "{written:#?}");
    assert_eq!(written[0]["entity_id"], "cus_e2e");
    assert_eq!(
        written[0]["description"],
        "'E2E Corp' was created by System"
    );
    assert_eq!(written[0]["metadata"]["source"], "web");
    assert_eq!(written[1]["metadata"]["eventId"], json!(id));

    // The dead letter keeps the event and says where it came from.
    let consumer = dlq
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: None,
            ..Default::default()
        })
        .await
        .expect("dead-letter reader");
    let mut letters = consumer
        .fetch()
        .max_messages(2)
        .expires(Duration::from_secs(2))
        .messages()
        .await
        .expect("fetch");
    let letter = letters
        .next()
        .await
        .expect("a dead letter")
        .expect("a message");
    assert_eq!(
        letter.message.subject.as_str(),
        format!("{prefix}-dlq.failing.customer.created")
    );
    let headers = letter.message.headers.clone().expect("headers");
    assert_eq!(
        headers
            .get("Weldsuite-Subscriber")
            .map(async_nats::HeaderValue::as_str),
        Some("failing")
    );
    assert_eq!(
        headers
            .get("Weldsuite-Deliveries")
            .map(async_nats::HeaderValue::as_str),
        Some("2")
    );
    let event: Value = serde_json::from_slice(&letter.message.payload).expect("the event");
    assert_eq!(event["eventType"], "customer:created");

    sqlx::query("delete from audit_logs where metadata->>'workspaceId' = $1")
        .bind(&org)
        .execute(&pool)
        .await
        .expect("clean up");
    let _ = bus.context().delete_stream(&stream).await;
    let _ = bus.context().delete_stream(&dead_letters).await;
}
