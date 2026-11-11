//! Parity with the TypeScript consumers. `scripts/rust-subscriber-fixtures.ts`
//! ran each TypeScript consumer on pglite and wrote what it did into
//! `tests/fixtures/*.json`; these tests seed the same rows into Postgres, feed
//! the same events to the Rust subscribers and compare the acks and retries,
//! the rows written, the outbound requests and the realtime publishes; for
//! audit log streams the requests built, and what four flushes send and
//! leave behind.
//!
//! The database tests need `WELDSUITE_TEST_TENANT_URL` (a tenant database
//! built by `scripts/rust-test-db.ts`) and skip without it; the registry,
//! realtime and audit log stream request tests always run. Regenerate the
//! fixtures with `pnpm exec tsx scripts/rust-subscriber-fixtures.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use aws_lc_rs::digest;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, PgPool};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::Keyring;
use weldsuite_ports::{
    BatchHandler, BoxFuture, Delivery, Disposition, Embeddings, PortError, RealtimeMessage,
    RealtimePublisher,
};
use weldsuite_subscribers::audit_streams::{
    AuditStreamEvent, AuditStreamRow, StreamAnswer, StreamCall, StreamFailure, StreamTransport,
    build_audit_stream_event, build_audit_stream_request, build_test_audit_stream_event,
};
use weldsuite_subscribers::registry::matching_subscribers;
use weldsuite_subscribers::tenants::ResolvedTenant;
use weldsuite_subscribers::webhooks::{retry_failed_webhook_deliveries, sign_webhook_payload};
use weldsuite_subscribers::{
    AuditStreamDestination, AuditStreamSender, AuditSubscriber, FlushOptions, RealtimeSubscriber,
    SUBSCRIBERS, SearchSubscriber, StaticTenants, TenantError, Tenants, WebhookHttp,
    WebhooksSubscriber, flush_audit_log_streams, topic_matches,
};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

/// The fixture's events (JSON text, as a producer sent them) as deliveries.
fn deliveries(events: &Value) -> Vec<Delivery> {
    events
        .as_array()
        .expect("events")
        .iter()
        .map(|text| {
            let text = text.as_str().expect("event text");
            let event: Value = serde_json::from_str(text).expect("event JSON");
            Delivery {
                subject: format!(
                    "entity-events.{}.{}",
                    event["entityType"].as_str().unwrap_or_default(),
                    event["action"].as_str().unwrap_or_default()
                ),
                payload: text.as_bytes().to_vec(),
                attempt: 1,
                deferrals: 0,
            }
        })
        .collect()
}

fn outcome(disposition: &Disposition) -> Value {
    match disposition {
        Disposition::Ack => json!("ack"),
        Disposition::Retry { .. } => json!("retry"),
        Disposition::Defer { delay, .. } => json!({ "defer": delay.as_secs() }),
    }
}

fn is_iso(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 19
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && (bytes[10] == b'T' || bytes[10] == b' ')
        && bytes[13] == b':'
        && bytes[16] == b':'
}

/// The generator's `normalise`: placeholders for generated ids, timestamps,
/// durations and one-hot embeddings.
fn normalise(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| normalise(item, "")).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v, k)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) => {
            if key == "id" {
                if let Some((prefix, rest)) = text.split_once('_')
                    && (prefix == "aud" || prefix == "sidx")
                    && !rest.is_empty()
                    && rest
                        .chars()
                        .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
                {
                    return json!(format!("<id:{prefix}>"));
                }
                if text.len() == 20
                    && text.starts_with("whd_")
                    && text[4..].chars().all(|c| c.is_ascii_hexdigit())
                {
                    return json!("<id:whd>");
                }
            }
            if is_iso(text) {
                return json!("<ts>");
            }
            if key == "embedding" && text.starts_with('[') {
                let numbers: Vec<Value> = serde_json::from_str(text).expect("a vector");
                let hot: Vec<usize> = numbers
                    .iter()
                    .enumerate()
                    .filter(|(_, n)| n.as_i64() == Some(1))
                    .map(|(i, _)| i)
                    .collect();
                if hot.len() == 1 && numbers.iter().all(|n| matches!(n.as_i64(), Some(0 | 1))) {
                    return json!(format!("<one-hot:{}>", hot[0]));
                }
            }
            value.clone()
        }
        Value::Number(_) if key == "response_time_ms" => json!("<ms>"),
        _ => value.clone(),
    }
}

/// The generator's `networkPlaceholders`.
fn network_placeholders(mut row: Value) -> Value {
    for key in ["error_message", "last_failure_reason"] {
        if let Some(Value::String(text)) = row.get(key) {
            let http = text.len() == 8
                && text.starts_with("HTTP ")
                && text[5..].chars().all(|c| c.is_ascii_digit());
            if !http {
                row[key] = json!("<network error>");
            }
        }
    }
    row
}

async fn tenant_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .expect("the tenant test database answers"),
    )
}

/// The tenant test database with every transaction read-only, as a database
/// move leaves the source (`set default_transaction_read_only`).
async fn read_only_pool() -> PgPool {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").expect("the tenant test database URL");
    let options: sqlx::postgres::PgConnectOptions = url.parse().expect("a Postgres URL");
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options.options([("default_transaction_read_only", "on")]))
        .await
        .expect("the tenant test database answers")
}

async fn exec(pool: &PgPool, statements: &Value) {
    for statement in statements.as_array().expect("statements") {
        let sql = statement.as_str().expect("sql");
        sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
}

async fn rows(pool: &PgPool, sql: &str) -> Vec<Value> {
    let found: Vec<Value> = sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_all(pool)
        .await
        .expect("rows");
    found.iter().map(|row| normalise(row, "")).collect()
}

/// Lists compared as multisets.
fn sorted(values: &[Value]) -> Vec<Value> {
    let mut out = values.to_vec();
    out.sort_by_key(Value::to_string);
    out
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

#[test]
fn the_registry_matches_typescript() {
    let registry = fixture("registry");
    let expected: Vec<Value> = registry["subscribers"]
        .as_array()
        .expect("subscribers")
        .clone();
    let actual: Vec<Value> = SUBSCRIBERS
        .iter()
        .map(|sub| json!({ "id": sub.id, "topics": sub.topics }))
        .collect();
    assert_eq!(actual, expected);

    for case in registry["matches"].as_array().expect("matches") {
        let event_type = case["eventType"].as_str().expect("eventType");
        assert_eq!(
            json!(matching_subscribers(event_type)),
            case["subscribers"],
            "{event_type}"
        );
        for (pattern, matched) in case["patterns"].as_object().expect("patterns") {
            assert_eq!(
                topic_matches(&[pattern.as_str()], event_type),
                matched.as_bool().expect("bool"),
                "{pattern} / {event_type}"
            );
        }
    }

    for sub in SUBSCRIBERS {
        let Some(queue) = registry["queues"].get(sub.id).filter(|q| !q.is_null()) else {
            continue;
        };
        assert_eq!(queue["queue"], sub.queue, "{}", sub.id);
        assert_eq!(queue["maxRetries"], sub.max_retries, "{}", sub.id);
        assert_eq!(queue["maxBatchSize"], sub.batch_size, "{}", sub.id);
        assert_eq!(
            queue["maxBatchTimeout"], sub.batch_timeout_seconds,
            "{}",
            sub.id
        );
        if let Some(concurrency) = queue["maxConcurrency"].as_u64() {
            assert_eq!(concurrency, sub.concurrency as u64, "{}", sub.id);
        }
    }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/// `org_fx` is the test tenant; `ws_locked` fails as a database locked by a
/// move; anything else does not resolve.
/// `org_fx` is the tenant database, `ws_readonly` the same database read-only
/// (as a move leaves it: the write fails with 25006), `ws_locked` fails the
/// lookup with 28P01, anything else is not found.
struct AuditTenants {
    db: PgPool,
    read_only: PgPool,
}

impl Tenants for AuditTenants {
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<ResolvedTenant, TenantError>> {
        let result = match reference {
            "org_fx" => Ok(ResolvedTenant {
                workspace_id: "ws_fx".to_owned(),
                clerk_org_id: Some("org_fx".to_owned()),
                db: self.db.clone(),
            }),
            "ws_readonly" => Ok(ResolvedTenant {
                workspace_id: "ws_readonly".to_owned(),
                clerk_org_id: None,
                db: self.read_only.clone(),
            }),
            "ws_locked" => Err(TenantError::Other(
                "password authentication failed for user \"x\"".into(),
            )),
            _ => Err(TenantError::NotFound),
        };
        Box::pin(std::future::ready(result))
    }

    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, TenantError>> {
        Box::pin(std::future::ready(Ok(reference.to_owned())))
    }
}

#[tokio::test]
async fn audit_log_matches_typescript() {
    let Some(pool) = tenant_pool().await else {
        return;
    };
    let fixture = fixture("audit");
    exec(&pool, &fixture["seed"]).await;

    let read_only = read_only_pool().await;
    let subscriber = AuditSubscriber::new(Arc::new(AuditTenants {
        db: pool.clone(),
        read_only,
    }));
    let batch = deliveries(&fixture["events"]);
    let outcomes: Vec<Value> = subscriber
        .handle(&batch)
        .await
        .iter()
        .map(outcome)
        .collect();
    assert_eq!(Value::Array(outcomes), fixture["outcomes"]);

    let written = rows(
        &pool,
        "select to_jsonb(a) as row from audit_logs a where metadata->>'eventId' like 'evt_fx%' order by metadata->>'eventId'",
    )
    .await;
    assert_eq!(Value::Array(written), fixture["rows"]);
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/// Records publishes; the hub is down for topic `boom`.
#[derive(Default)]
struct Hub(Mutex<Vec<RealtimeMessage>>);

impl RealtimePublisher for Hub {
    fn publish(
        &self,
        message: &RealtimeMessage,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        let result = if message.payload["topic"] == "boom" {
            Err(PortError::backend("WorkspaceHub publish failed 500"))
        } else {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(message.clone());
            Ok(())
        };
        std::future::ready(result)
    }
}

#[tokio::test]
async fn realtime_matches_typescript() {
    let fixture = fixture("realtime");
    let hub = Arc::new(Hub::default());
    let subscriber = RealtimeSubscriber::new(Arc::new(StaticTenants::new()), hub.clone());
    let batch = deliveries(&fixture["events"]);
    let outcomes: Vec<Value> = subscriber
        .handle(&batch)
        .await
        .iter()
        .map(outcome)
        .collect();
    assert_eq!(Value::Array(outcomes), fixture["outcomes"]);

    let published: Vec<Value> = hub
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|message| {
            let hub_key = message
                .channel
                .strip_prefix("workspace:")
                .expect("a workspace channel");
            let mut body = message.payload.as_object().expect("payload").clone();
            assert_eq!(body.remove("workspaceId"), Some(json!(hub_key)));
            json!({ "hubKey": hub_key, "body": body })
        })
        .collect();
    assert_eq!(Value::Array(published), fixture["publishes"]);
}

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------

type Requests = Arc<Mutex<Vec<Value>>>;

async fn hook(
    State(requests): State<Requests>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, &'static str) {
    let path = uri.path().to_owned();
    let secret = match path.as_str() {
        "/ok" => "s1",
        "/fail" => "s2",
        "/ok3" => "s3",
        "/notfound" => "s6",
        _ => "s7",
    };
    let text = String::from_utf8(body.to_vec()).expect("a UTF-8 body");
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map_or(Value::Null, |value| json!(value))
    };
    requests
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(json!({
            "path": path,
            "method": "POST",
            "contentType": header("content-type"),
            "event": header("x-weldsuite-event"),
            "custom": header("x-custom"),
            "signatureValid": header("x-weldsuite-signature") == json!(sign_webhook_payload(secret, &text)),
            "body": normalise(&serde_json::from_str::<Value>(&text).expect("a JSON body"), ""),
        }));
    match path.as_str() {
        "/ok" | "/ok3" => (StatusCode::OK, "thanks"),
        "/fail" => (StatusCode::INTERNAL_SERVER_ERROR, "boom"),
        _ => (StatusCode::NOT_FOUND, "nope"),
    }
}

/// The seed with `hooks.test` pointed at a local server, and `/down` at a
/// port nobody listens on.
fn webhook_seed(seed: &Value, base: &str, closed: &str) -> Value {
    let statements: Vec<Value> = seed
        .as_array()
        .expect("seed")
        .iter()
        .map(|statement| {
            json!(
                statement
                    .as_str()
                    .expect("sql")
                    .replace("http://hooks.test/down", &format!("{closed}/down"))
                    .replace("http://hooks.test", base)
            )
        })
        .collect();
    Value::Array(statements)
}

async fn webhook_rows(pool: &PgPool) -> (Vec<Value>, Vec<Value>) {
    let deliveries = rows(
        pool,
        "select to_jsonb(d) as row from webhook_deliveries d where webhook_id like 'fxw_%' order by event_id, webhook_id, attempt_number",
    )
    .await;
    let webhooks = rows(
        pool,
        "select jsonb_build_object('id', id, 'status', status, 'consecutive_failures', consecutive_failures, 'total_deliveries', total_deliveries, 'total_failures', total_failures, 'last_failure_reason', last_failure_reason, 'last_delivered_at', last_delivered_at, 'last_failed_at', last_failed_at, 'updated_at', updated_at) as row from external_webhooks where id like 'fxw_%' order by id",
    )
    .await;
    (
        deliveries.into_iter().map(network_placeholders).collect(),
        webhooks.into_iter().map(network_placeholders).collect(),
    )
}

#[tokio::test]
async fn webhooks_match_typescript() {
    let Some(pool) = tenant_pool().await else {
        return;
    };
    let fixture = fixture("webhooks");

    let requests: Requests = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let app = axum::Router::new()
        .fallback(hook)
        .with_state(requests.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("address"))
    };
    exec(&pool, &webhook_seed(&fixture["seed"], &base, &closed)).await;

    let master = match std::env::var("WELDSUITE_TEST_MASTER_URL") {
        Ok(url) => {
            let master = PgPool::connect(&url)
                .await
                .expect("the master test database answers");
            sqlx::query("delete from workspace_due_index where kind = 'webhook_retry' and workspace_id = 'ws_fx'")
                .execute(&master)
                .await
                .expect("clean the due index");
            Some(master)
        }
        Err(_) => None,
    };
    let http = WebhookHttp::new(true).expect("client");
    let tenants = StaticTenants::new().with("ws_fx", Some("org_fx"), pool.clone());
    let subscriber = WebhooksSubscriber::new(Arc::new(tenants), master.clone(), http.clone());
    let batch = deliveries(&fixture["events"]);
    let outcomes: Vec<Value> = subscriber
        .handle(&batch)
        .await
        .iter()
        .map(outcome)
        .collect();
    assert_eq!(Value::Array(outcomes), fixture["outcomes"]);

    let sent = std::mem::take(&mut *requests.lock().unwrap_or_else(PoisonError::into_inner));
    assert_eq!(
        sorted(&sent),
        sorted(fixture["requests"].as_array().expect("requests"))
    );
    let (deliveries_written, webhooks) = webhook_rows(&pool).await;
    assert_eq!(Value::Array(deliveries_written), fixture["deliveries"]);
    assert_eq!(Value::Array(webhooks), fixture["webhooks"]);

    // The failed deliveries made the workspace due for the retry sweep.
    if let Some(master) = &master {
        let due: Option<bool> = sqlx::query_scalar(
            "select next_due_at > now() from workspace_due_index where kind = 'webhook_retry' and workspace_id = 'ws_fx'",
        )
        .fetch_optional(master)
        .await
        .expect("due index");
        assert_eq!(due, Some(true));
    }

    // The retry sweep, with every pending retry due now.
    let retry = &fixture["retry"];
    sqlx::raw_sql(AssertSqlSafe(
        retry["makeDue"].as_str().expect("sql").to_owned(),
    ))
    .execute(&pool)
    .await
    .expect("make due");
    let result = retry_failed_webhook_deliveries(&pool, &http)
        .await
        .expect("retry");
    assert_eq!(
        json!({ "attempted": result.attempted, "succeeded": result.succeeded }),
        retry["result"]
    );
    let sent = std::mem::take(&mut *requests.lock().unwrap_or_else(PoisonError::into_inner));
    assert_eq!(
        sorted(&sent),
        sorted(retry["requests"].as_array().expect("requests"))
    );
    let (deliveries_written, webhooks) = webhook_rows(&pool).await;
    assert_eq!(Value::Array(deliveries_written), retry["deliveries"]);
    assert_eq!(Value::Array(webhooks), retry["webhooks"]);
}

// ---------------------------------------------------------------------------
// Semantic search index
// ---------------------------------------------------------------------------

/// The generator's embedder: one-hot vectors from the text's SHA-256, and a
/// failure for any text with `FAIL_EMBED`.
struct OneHot {
    model: String,
    calls: Mutex<Vec<Vec<String>>>,
}

fn one_hot(text: &str) -> Vec<f32> {
    let hash = hex::encode(digest::digest(&digest::SHA256, text.as_bytes()).as_ref());
    let index = u32::from_str_radix(&hash[..8], 16).expect("hex") % 1024;
    let mut vector = vec![0.0; 1024];
    vector[index as usize] = 1.0;
    vector
}

impl Embeddings for OneHot {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(texts.to_vec());
        let result = if texts.iter().any(|text| text.contains("FAIL_EMBED")) {
            Err(PortError::backend("embedding service down"))
        } else {
            Ok(texts.iter().map(|text| one_hot(text)).collect())
        };
        Box::pin(std::future::ready(result))
    }
}

#[tokio::test]
async fn search_index_matches_typescript() {
    let Some(pool) = tenant_pool().await else {
        return;
    };
    let fixture = fixture("search");
    exec(&pool, &fixture["seed"]).await;

    let embeddings = Arc::new(OneHot {
        model: fixture["model"].as_str().expect("model").to_owned(),
        calls: Mutex::default(),
    });
    let tenants = StaticTenants::new().with("ws_fx", Some("org_fx"), pool.clone());
    let subscriber = SearchSubscriber::new(Arc::new(tenants), embeddings.clone());
    for (number, batch) in fixture["batches"]
        .as_array()
        .expect("batches")
        .iter()
        .enumerate()
    {
        exec(&pool, &batch["before"]).await;
        embeddings
            .calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let outcomes: Vec<Value> = subscriber
            .handle(&deliveries(&batch["events"]))
            .await
            .iter()
            .map(outcome)
            .collect();
        assert_eq!(Value::Array(outcomes), batch["outcomes"], "batch {number}");
        let calls = embeddings
            .calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        assert_eq!(json!(calls), batch["embedCalls"], "batch {number}");
        let indexed = rows(
            &pool,
            "select to_jsonb(s) as row from search_index s where entity_id like 'fx%' order by entity_type, entity_id, chunk_index",
        )
        .await;
        let expected: HashMap<String, &Value> = batch["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                (
                    format!(
                        "{}/{}/{}",
                        row["entity_type"], row["entity_id"], row["chunk_index"]
                    ),
                    row,
                )
            })
            .collect();
        assert_eq!(indexed.len(), expected.len(), "batch {number}");
        for row in &indexed {
            let key = format!(
                "{}/{}/{}",
                row["entity_type"], row["entity_id"], row["chunk_index"]
            );
            assert_eq!(Some(&row), expected.get(&key), "batch {number}: {key}");
        }
    }
}

// ---------------------------------------------------------------------------
// Audit log streams
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

/// A fixture row as delivery reads it from `audit_logs`.
fn stream_row(row: &Value) -> AuditStreamRow {
    AuditStreamRow {
        id: text(row, "id"),
        created_at: text(row, "createdAt"),
        entity_type: text(row, "entityType"),
        entity_id: text(row, "entityId"),
        action: text(row, "action"),
        description: text(row, "description"),
        changes: optional(row, "changes"),
        performed_by: optional(row, "performedBy"),
        performed_by_name: optional(row, "performedByName"),
        ip_address: optional(row, "ipAddress"),
        workspace_id: optional(row, "workspaceId"),
        source: optional(row, "source"),
    }
}

/// Headers as the generator lists them (`Object.entries`).
fn header_pairs(headers: &[(String, String)]) -> Value {
    Value::Array(
        headers
            .iter()
            .map(|(name, value)| json!([name, value]))
            .collect(),
    )
}

fn instant(value: &Value) -> OffsetDateTime {
    OffsetDateTime::parse(value.as_str().expect("a timestamp"), &Rfc3339).expect("an ISO timestamp")
}

/// The wire formats, byte for byte: both stream types, both HTTP formats,
/// with and without a token, and the test event.
#[test]
fn audit_stream_requests_match_typescript() {
    let fixture = fixture("audit_streams");
    for case in fixture["requests"].as_array().expect("requests") {
        let name = case["name"].as_str().expect("name");
        let workspace = case["workspaceId"].as_str();
        let events: Vec<AuditStreamEvent> = case["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| build_audit_stream_event(&stream_row(row), workspace))
            .collect();
        let stream = &case["stream"];
        let request = build_audit_stream_request(
            &AuditStreamDestination {
                kind: stream["type"].as_str().expect("type"),
                url: stream["url"].as_str().expect("url"),
                settings: stream["settings"].as_str(),
            },
            case["token"].as_str(),
            &events,
        );
        assert_eq!(request.body, case["body"].as_str().expect("body"), "{name}");
        assert_eq!(header_pairs(&request.headers), case["headers"], "{name}");
    }

    let test = &fixture["testEvent"];
    let now = instant(&test["now"]);
    assert_eq!(
        build_test_audit_stream_event(now, test["workspaceId"].as_str()).json(),
        test["event"].as_str().expect("event")
    );
    assert_eq!(
        build_test_audit_stream_event(now, None).json(),
        test["eventWithoutWorkspace"].as_str().expect("event")
    );
}

/// The ids of the events in a request body, whatever its format (the
/// generator's `streamEventIds`).
fn stream_event_ids(body: &str) -> Vec<String> {
    let id = |value: &Value| {
        value["event"]["id"]
            .as_str()
            .or_else(|| value["id"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    if let Ok(document) = serde_json::from_str::<Value>(body)
        && let Some(events) = document["events"].as_array()
    {
        return events.iter().map(id).collect();
    }
    body.split('\n')
        .map(|line| id(&serde_json::from_str::<Value>(line).expect("a JSON line")))
        .collect()
}

/// Answers a flush step's requests from its script and keeps what was sent,
/// as the generator's `streamFetch` does.
struct ScriptedStreams {
    db: PgPool,
    /// By URL, one answer per request in order (the last repeats); `200 ok`
    /// for a URL without any.
    answers: Value,
    seen: Mutex<HashMap<String, usize>>,
    requests: Mutex<Vec<Value>>,
}

impl StreamTransport for ScriptedStreams {
    fn post<'a>(
        &'a self,
        call: StreamCall<'a>,
    ) -> BoxFuture<'a, Result<StreamAnswer, StreamFailure>> {
        Box::pin(async move {
            let ids = stream_event_ids(call.body);
            let sha256 = digest::digest(&digest::SHA256, call.body.as_bytes());
            self.requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(json!({
                    "url": call.url,
                    "headers": header_pairs(call.headers),
                    "count": ids.len(),
                    "first": ids.first(),
                    "last": ids.last(),
                    "sha256": hex::encode(sha256.as_ref()),
                }));
            let index = {
                let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
                let count = seen.entry(call.url.to_owned()).or_insert(0);
                *count += 1;
                *count - 1
            };
            let answer = self.answers[call.url]
                .as_array()
                .and_then(|script| script.get(index.min(script.len().saturating_sub(1))));
            let Some(answer) = answer else {
                return Ok(StreamAnswer {
                    status: 200,
                    text: "ok".to_owned(),
                });
            };
            // Another flush moving the cursor under this one.
            if let Some(sql) = answer["exec"].as_str() {
                sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
                    .execute(&self.db)
                    .await
                    .expect("the statement of the step runs");
            }
            if let Some(message) = answer["error"].as_str() {
                return Err(StreamFailure::Failed(message.to_owned()));
            }
            if answer["timeout"] == true {
                return Err(StreamFailure::TimedOut);
            }
            Ok(StreamAnswer {
                status: answer["status"]
                    .as_u64()
                    .and_then(|status| u16::try_from(status).ok())
                    .expect("a status"),
                text: text(answer, "body"),
            })
        })
    }
}

/// Four flushes of one workspace: the cursor walk in batches of 200 (the
/// first batch ends inside a millisecond that six rows share), the cap of
/// five requests, failures with their backoff and recovery, the auto-disable
/// at twenty, an unreadable token, an unsafe URL, a redirect, a timeout, a
/// cursor another flush moved, the streams that are never asked, and the
/// settle window: rows younger than five seconds wait, the row exactly five
/// seconds old with them, and two rows that commit late in front of a row an
/// earlier flush already saw are still delivered, in order.
///
/// TypeScript's `now` is a `Date`, whole milliseconds. Here every flush runs
/// 999 microseconds later than the fixture says: the time of a flush is read
/// to the millisecond, so nothing may change, and the settle bound may not
/// cut a millisecond's rows in two.
#[tokio::test]
async fn audit_stream_flushes_match_typescript() {
    let Some(pool) = tenant_pool().await else {
        return;
    };
    let fixture = fixture("audit_streams");
    let flush = &fixture["flush"];
    exec(&pool, &flush["seed"]).await;
    let keyring = Keyring {
        v1: optional(&flush["keys"], "v1"),
        v2: optional(&flush["keys"], "v2"),
    };
    let state = flush["state"].as_str().expect("the state query");

    for step in flush["steps"].as_array().expect("steps") {
        let name = step["name"].as_str().expect("name");
        exec(&pool, &step["before"]).await;
        let transport = Arc::new(ScriptedStreams {
            db: pool.clone(),
            answers: step["answers"].clone(),
            seen: Mutex::default(),
            requests: Mutex::default(),
        });
        let sender = AuditStreamSender::with_transport(transport.clone(), false);
        let options = FlushOptions {
            keyring: &keyring,
            workspace_id: flush["workspaceId"].as_str(),
            now: instant(&step["now"]) + time::Duration::microseconds(999),
        };
        // Only the streams of the fixture: the test database may hold others.
        let mut results: Vec<Value> = flush_audit_log_streams(&pool, &sender, &options)
            .await
            .iter()
            .filter(|result| result.stream_id.starts_with("als_fx"))
            .map(|result| {
                json!({
                    "streamId": result.stream_id,
                    "outcome": result.outcome.as_str(),
                    "delivered": result.delivered,
                    "error": result.error,
                })
            })
            .collect();
        results.sort_by_key(|result| text(result, "streamId"));
        assert_eq!(Value::Array(results), step["results"], "{name}: results");

        let requests: Vec<Value> = transport
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|request| text(request, "url").contains(".fx.example.com"))
            .cloned()
            .collect();
        assert_eq!(
            sorted(&requests),
            sorted(step["requests"].as_array().expect("requests")),
            "{name}: requests"
        );

        let streams: Vec<Value> = sqlx::query_scalar(AssertSqlSafe(state.to_owned()))
            .fetch_all(&pool)
            .await
            .expect("the streams");
        assert_eq!(Value::Array(streams), step["streams"], "{name}: streams");
    }

    // Rows dated 2099 would be news to every stream another test adds.
    exec(
        &pool,
        &json!([
            "delete from audit_log_streams where id like 'als_fx%'",
            "delete from audit_logs where id like 'fxa_%' or id like 'fxb_%'",
        ]),
    )
    .await;
}
