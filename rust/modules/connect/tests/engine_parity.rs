//! Parity with `workflow-worker`'s engine. Its
//! `src/testing/rust-fixtures.test.ts` ran whole `ExecuteWorkflowWorkflow`
//! runs on pglite and wrote what they did into `tests/fixtures/*.json`: the
//! run's result, the execution and step rows, error logs, workflow stats,
//! notifications, realtime publishes, chained runs, third-party calls and
//! the steps each run took. This test seeds the same rows into Postgres,
//! runs the Rust engine on the same input and compares.
//!
//! It needs `WELDSUITE_TEST_TENANT_URL` (a tenant database built by
//! `scripts/rust-test-db.ts`) and skips without it. Regenerate the fixtures
//! with `pnpm rust:connect-engine-fixtures`.

#![allow(
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::many_single_char_names
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_connect::engine::{EngineDeps, ExecuteWorkflowParams, RunEnd, run_workflow};
use weldsuite_connect::{TenantDatabases, WorkflowRuns};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, DynRealtimePublisher, HttpRequest, HttpResponse, JobContext,
    JobError, OutboundHttp, PortError, RecordingRealtime, StepFn, StepRetry,
};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

// ---------------------------------------------------------------------------
// Normalisation (the generator's `normalise`)
// ---------------------------------------------------------------------------

fn is_iso(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 19
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && (b[10] == b'T' || b[10] == b' ')
        && b[11..13].iter().all(u8::is_ascii_digit)
        && b[13] == b':'
        && b[14..16].iter().all(u8::is_ascii_digit)
        && b[16] == b':'
        && b[17..19].iter().all(u8::is_ascii_digit)
}

/// `^2026-10-0[1-3][T ]09:00:00`.
fn is_seeded(text: &str) -> bool {
    text.len() >= 19
        && text.starts_with("2026-10-0")
        && matches!(&text[9..10], "1" | "2" | "3")
        && &text[11..19] == "09:00:00"
}

fn generated_ids(text: &str) -> String {
    let pattern = regex_lite(r"(?-u:\b)(wex|wes|wel|notif|msg)_[0-9A-Za-z]{24}(?-u:\b)");
    let text = pattern.replace_all(text, "<id:$1>");
    // `generateId(prefix)`: the prefix, `_`, 16 base-36 characters.
    let short = regex_lite(r"(?-u:\b)([a-z]+)_[0-9a-z]{16}(?-u:\b)");
    short.replace_all(&text, "<id:$1>").into_owned()
}

fn regex_lite(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap()
}

fn normalise(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|i| normalise(i, "")).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v, k)))
                .collect(),
        ),
        Value::Number(_) if key == "duration" || key == "ts" => json!("<n>"),
        Value::String(text) => {
            if is_iso(text) && !is_seeded(text) {
                return json!("<ts>");
            }
            // A Message-ID a send made: `<hex32@domain>`.
            if regex_lite(r"^<[0-9a-f]{32}@[^>]+>$").is_match(text) {
                return json!("<message-id>");
            }
            let text = generated_ids(text);
            let completed = regex_lite(r"^Completed in [0-9]+ms");
            json!(completed.replace(&text, "Completed in <n>ms"))
        }
        other => other.clone(),
    }
}

/// The first place two values differ.
fn difference(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys()) {
                let (l, r) = (
                    x.get(key).unwrap_or(&Value::Null),
                    y.get(key).unwrap_or(&Value::Null),
                );
                if let Some(d) = difference(l, r, &format!("{at}.{key}")) {
                    return Some(d);
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!(
                    "{at}: {} items vs {}\n  ts:   {a}\n  rust: {b}",
                    x.len(),
                    y.len()
                ));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (l, r))| difference(l, r, &format!("{at}[{i}]")))
        }
        _ if a == b => None,
        _ => Some(format!("{at}: {a} (TypeScript) vs {b} (Rust)")),
    }
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/// Third parties by URL, as the fixture's `fetch` stub answered.
struct StubHttp {
    answers: Map<String, Value>,
    calls: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for StubHttp {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        // JSON bodies parsed; a form body (Twilio, a token refresh) as its text.
        let body = request.body.as_deref().map_or(Value::Null, |b| {
            serde_json::from_slice::<Value>(b)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(b).into_owned()))
        });
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "method": request.method.to_uppercase(), "url": request.url, "body": body }));
        let answer = self.answers.get(&request.url).cloned();
        Box::pin(async move {
            let Some(answer) = answer else {
                return Ok(HttpResponse::new(599, b"not stubbed".to_vec()));
            };
            let mut response = HttpResponse::new(
                u16::try_from(answer["status"].as_u64().unwrap()).unwrap(),
                answer["body"].to_string().into_bytes(),
            );
            response.headers = match answer.get("headers").and_then(Value::as_object) {
                Some(headers) => headers
                    .iter()
                    .map(|(k, v)| (k.to_lowercase(), v.as_str().unwrap().to_owned()))
                    .collect(),
                None => vec![("content-type".into(), "application/json".into())],
            };
            Ok(response)
        })
    }
}

/// `EXECUTE_WORKFLOW` for chains: records each start.
#[derive(Default)]
struct RecordingRuns {
    started: Mutex<Vec<Value>>,
}

impl WorkflowRuns for RecordingRuns {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>> {
        self.start(None, params)
    }

    fn start<'a>(
        &'a self,
        id: Option<&'a str>,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        let mut init = json!({ "params": params });
        if let Some(id) = id {
            init["id"] = json!(id);
        }
        self.started
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(init);
        Box::pin(async move { Ok(id.unwrap_or("inst_new").to_owned()) })
    }

    fn terminate<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn send_event<'a>(
        &'a self,
        _id: &'a str,
        _event_type: &'a str,
        _payload: &'a Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// The run's `step`: runs each step, records sleeps, and answers a wait
/// from the case. An approval's decision is written on the waiting step's
/// row first, as the approval route does before it signals.
struct TestCtx {
    key: String,
    db: PgPool,
    events: Map<String, Value>,
    log: Mutex<Vec<Value>>,
}

impl JobContext for TestCtx {
    fn key(&self) -> &str {
        &self.key
    }

    fn run_step<'s>(
        &'s self,
        name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "kind": "do", "name": name }));
        step()
    }

    fn sleep(&self, name: &str, duration: Duration) -> BoxFuture<'_, Result<(), JobError>> {
        let ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "kind": "sleep", "name": name, "ms": ms }));
        Box::pin(async { Ok(()) })
    }

    fn wait_for_signal(
        &self,
        name: &str,
        signal: &str,
        _timeout: Duration,
    ) -> BoxFuture<'_, Result<bool, JobError>> {
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "kind": "wait", "name": name, "type": signal }));
        let event = self.events.get(name).cloned();
        Box::pin(async move {
            let Some(event) = event.filter(|e| e != "timeout") else {
                return Ok(false);
            };
            sqlx::query(
                "update workflow_execution_steps
                 set output = coalesce(output, '{}'::jsonb) || jsonb_build_object('decision', $1::jsonb)
                 where status = 'waiting_for_input'",
            )
            .bind(&event["payload"])
            .execute(&self.db)
            .await
            .map_err(JobError::failed)?;
            Ok(true)
        })
    }
}

// ---------------------------------------------------------------------------
// The runs
// ---------------------------------------------------------------------------

fn bare(value: &str) -> String {
    value
        .split_once('<')
        .and_then(|(_, rest)| rest.split_once('>'))
        .map_or(value, |(inner, _)| inner)
        .trim()
        .to_lowercase()
}

async fn rows(db: &PgPool, query: &str) -> Value {
    sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from ({query}) q"
    )))
    .fetch_one(db)
    .await
    .unwrap()
}

/// Fixture rows are as Postgres answers them through `to_jsonb`, except the
/// generator's driver: pglite answers `numeric` as text and timestamps as
/// dates, which the queries avoid.
async fn run_case(db: &PgPool, clear: &[Value], case: &Value) -> Value {
    let input = &case["input"];
    for statement in clear.iter().chain(input["seed"].as_array().unwrap()) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.as_str().unwrap().to_owned()))
            .execute(db)
            .await
            .unwrap();
    }
    let realtime = Arc::new(RecordingRealtime::new());
    let http = Arc::new(StubHttp {
        answers: input["http"].as_object().cloned().unwrap_or_default(),
        calls: Mutex::default(),
    });
    let runs = Arc::new(RecordingRuns::default());
    let bus = Arc::new(weldsuite_ports::RecordingEventBus::default());
    let mail = Arc::new(weldsuite_ports::RecordingMailTransport::default());
    let pool = db.clone();
    let tenants: TenantDatabases = Arc::new(move |_| {
        let pool = pool.clone();
        Box::pin(async move { Ok(pool) })
    });
    let deps = EngineDeps {
        tenants,
        realtime: Some(Arc::clone(&realtime) as Arc<dyn DynRealtimePublisher>),
        http: Some(OutboundHttp(Arc::clone(&http) as Arc<dyn DynOutboundHttp>)),
        runs: Some(Arc::clone(&runs) as Arc<dyn WorkflowRuns>),
        env: Arc::new(HashMap::from([(
            "TELNYX_API_KEY".to_owned(),
            "telnyx-key".to_owned(),
        )])),
        events: weldsuite_events::EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn weldsuite_ports::DynEventBus>),
            weldsuite_events::TaskTracker::new(),
        ),
        master: None,
        outbound: weldsuite_mail_domain::outbound::OutboundBindings {
            transport: Some(Arc::clone(&mail) as Arc<dyn weldsuite_ports::MailTransport>),
            ..weldsuite_mail_domain::outbound::OutboundBindings::default()
        },
    };
    let ctx = TestCtx {
        key: input["instanceId"].as_str().unwrap().to_owned(),
        db: db.clone(),
        events: input["events"].as_object().cloned().unwrap_or_default(),
        log: Mutex::default(),
    };
    let params: ExecuteWorkflowParams = serde_json::from_value(input["params"].clone()).unwrap();
    let end = run_workflow(&deps, &ctx, &params).await.unwrap();
    let outcome = match end {
        RunEnd::Skipped(reason) => json!({ "skipped": reason }),
        RunEnd::Cancelled => json!({ "cancelled": true }),
        RunEnd::Finished { succeeded, .. } => json!({ "succeeded": succeeded }),
    };
    let log: Vec<Value> = ctx
        .log
        .into_inner()
        .unwrap()
        .into_iter()
        .filter(|entry| {
            !["meter-run", "run-started-at"].contains(&entry["name"].as_str().unwrap_or_default())
        })
        .collect();
    let publishes: Vec<Value> = realtime
        .messages()
        .into_iter()
        .map(|m| json!({ "channel": m.channel, "payload": m.payload }))
        .collect();
    let mut inspected = Vec::new();
    for query in input["inspect"].as_array().into_iter().flatten() {
        inspected.push(rows(db, query.as_str().unwrap()).await);
    }
    normalise(
        &json!({
            "outcome": outcome,
            "executions": rows(db, "select id, workflow_id, workflow_name, workflow_version, status, triggered_by, trigger_type, trigger_id,
                 trigger_data, total_steps, current_step_index, output, error, execution_context, cf_workflow_instance_id,
                 (started_at is not null) as started, (completed_at is not null) as completed, (duration is not null) as timed
               from workflow_executions order by workflow_id, status").await,
            "steps": rows(db, "select step_id, step_name, step_type, step_index, status, output, error, retry_count,
                 (select jsonb_agg(l -> 'message' order by n) from jsonb_array_elements(logs) with ordinality as x(l, n)) as logs,
                 (completed_at is not null) as completed
               from workflow_execution_steps order by step_index").await,
            "errorLogs": rows(db, "select workflow_id, execution_id, step_id, step_name, step_type, error_message, error_type, severity, input
               from workflow_error_logs order by step_id, error_message").await,
            "workflows": rows(db, "select id, execution_count, success_count, failure_count, (last_executed_at is not null) as ran,
                 (average_execution_time is not null) as averaged
               from workflows order by id").await,
            "notifications": rows(db, "select user_id, title, body, category, notification_type, entity_type, entity_id, action_url, icon, severity, data
               from notifications order by user_id, title").await,
            "publishes": publishes,
            "chained": runs.started.lock().unwrap().clone(),
            "calls": http.calls.lock().unwrap().clone(),
            "log": log,
            "events": bus
                .payloads()
                .into_iter()
                .map(|mut event| {
                    event.as_object_mut().unwrap().remove("id");
                    event
                })
                .collect::<Vec<_>>(),
            "inspected": inspected,
            // Bare addresses, lowercased, as the generator records them.
            "mail": mail
                .sent()
                .into_iter()
                .map(|sent| json!({ "from": bare(&sent.envelope.from), "to": bare(&sent.envelope.to) }))
                .collect::<Vec<_>>(),
        }),
        "",
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn engine_runs_match_typescript() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    let fixture = fixture("engine_runs");
    let clear = fixture["clear"].as_array().unwrap().clone();
    let mut failures = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let rust = run_case(&db, &clear, case).await;
        let expected = normalise(&case["output"], "");
        if let Some(diff) = difference(&expected, &rust, "$") {
            failures.push(format!("{}: {diff}", case["name"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
