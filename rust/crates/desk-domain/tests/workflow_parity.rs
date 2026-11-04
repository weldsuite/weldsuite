//! Parity with `helpdesk-workflow-worker`. Its `src/testing/rust-fixtures.test.ts`
//! ran the TypeScript engine on pglite and wrote what it did into
//! `tests/fixtures/*.json`: the pure helpers, the `AssignmentRouter`, every
//! registered step handler, and whole runs through `/event`, the
//! `ConversationWorkflow` and `/respond`. These tests seed the same rows into
//! Postgres, run the Rust port on the same input and compare results, rows,
//! realtime publishes, Discord and Slack calls and the steps a run took.
//!
//! The database tests need `WELDSUITE_TEST_TENANT_URL` (a tenant database
//! built by `scripts/rust-test-db.ts`) and skip without it. Regenerate the
//! fixtures with `pnpm rust:desk-workflow-fixtures`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use tokio::sync::{oneshot, watch};
use weldsuite_desk_domain::assignment_router::{
    AssignmentRouter, PickCandidate, PickMode, PickRequest, PickerState, pick_desk_assignee,
};
use weldsuite_desk_domain::http::{DeskHttp, DynDeskHttp, HttpRequest, HttpResponse};
use weldsuite_desk_domain::workflow::handlers::{StepDeps, StepInput, execute_step_handler};
use weldsuite_desk_domain::workflow::job::workflow_matches;
use weldsuite_desk_domain::workflow::shared::{
    Scope, evaluate_condition, resolve_conversation_id, resolve_inputs,
};
use weldsuite_desk_domain::workflow::{
    CONVERSATION_WORKFLOW_JOB, ConversationWorkflowJob, ConversationWorkflowParams, EngineDeps,
    InProcessEngine, TenantDatabases,
};
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, JobContext, JobError, JobRequest, Jobs, MemoryLedgerStore,
    PortError, RecordingRealtime, StepFn, StepRetry,
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
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b' ')
        && b[13] == b':'
        && b[16] == b':'
}

/// `^2026-10-0[1-3][T ]09:00:00`: a time the seed wrote.
fn is_seeded(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 19
        && text.starts_with("2026-10-0")
        && matches!(b[9], b'1'..=b'3')
        && matches!(b[10], b'T' | b' ')
        && &text[11..19] == "09:00:00"
}

fn generated(text: &str) -> Option<&str> {
    let (prefix, rest) = text.split_once('_')?;
    let tail_ok = !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
    tail_ok.then_some(prefix)
}

fn normalise(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| normalise(item, "")).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v, k)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) => {
            match generated(text) {
                Some(prefix @ ("wex" | "msg" | "csat")) => return json!(format!("<id:{prefix}>")),
                Some("wfi") => return json!("<instance>"),
                _ => {}
            }
            if is_iso(text) && !is_seeded(text) {
                return json!("<ts>");
            }
            value.clone()
        }
        Value::Number(_) if key == "ts" => json!("<ms>"),
        _ => value.clone(),
    }
}

fn sorted(mut rows: Vec<Value>) -> Vec<Value> {
    rows.sort_by_key(ToString::to_string);
    rows
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

fn map(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[test]
fn shared_helpers_match_typescript() {
    let fx = fixture("workflow_shared");
    let step_results = map(&fx["scope"]["stepResults"]);
    let variables = map(&fx["scope"]["variables"]);
    let empty = Map::new();
    let scope = Scope {
        previous_results: &step_results,
        trigger_data: &fx["scope"]["triggerData"],
        variables: &variables,
        contact_data: &empty,
    };
    for case in fx["resolve"].as_array().expect("cases") {
        let out = Value::Object(resolve_inputs(&map(&case["inputs"]), &scope));
        assert_eq!(
            normalise(&out, ""),
            case["out"],
            "resolve {}",
            case["inputs"]
        );
    }
    for case in fx["conditions"].as_array().expect("cases") {
        let met = evaluate_condition(&map(&case["condition"]), &scope).expect("a valid pattern");
        assert_eq!(json!(met), case["met"], "condition {}", case["condition"]);
    }
    for case in fx["conversationIds"].as_array().expect("cases") {
        let out = resolve_conversation_id(&map(&case["inputs"]), &case["triggerData"]);
        assert_eq!(json!(out), case["out"], "conversation id {case}");
    }
    for case in fx["triggers"].as_array().expect("cases") {
        let params = &case["params"];
        let ids: Option<Vec<String>> = params
            .get("workflowIds")
            .and_then(|ids| serde_json::from_value(ids.clone()).ok());
        let matches = workflow_matches(
            "hwfl_a",
            &case["triggers"],
            params.get("eventType").unwrap_or(&Value::Null),
            params["channel"].as_str().unwrap_or_default(),
            ids.as_deref(),
        );
        assert_eq!(json!(matches), case["matches"], "trigger {case}");
    }
}

// ---------------------------------------------------------------------------
// 2. AssignmentRouter
// ---------------------------------------------------------------------------

fn pick_request(value: &Value) -> PickRequest {
    PickRequest {
        mode: PickMode::parse(value["mode"].as_str().unwrap_or_default()).expect("a mode"),
        candidates: serde_json::from_value::<Vec<PickCandidate>>(value["candidates"].clone())
            .expect("candidates"),
        max_open: value["maxOpen"].as_i64(),
    }
}

#[test]
fn desk_picks_match_typescript() {
    let fx = fixture("assignment_router");
    for sequence in fx["desk"].as_array().expect("sequences") {
        let mut state = PickerState::default();
        for pick in sequence["picks"].as_array().expect("picks") {
            let now = pick["now"].as_i64().expect("now");
            let (user_id, next) = pick_desk_assignee(&state, &pick_request(&pick["request"]), now);
            assert_eq!(
                json!(user_id),
                pick["userId"],
                "{} at {now}",
                sequence["name"]
            );
            assert_eq!(
                serde_json::to_value(&next).expect("state JSON"),
                pick["state"],
                "{} at {now}",
                sequence["name"]
            );
            state = next;
        }
    }
}

#[tokio::test]
async fn department_router_matches_typescript() {
    let fx = fixture("assignment_router");
    let router = AssignmentRouter::new(Arc::new(MemoryLedgerStore::new()));
    for step in fx["department"].as_array().expect("ops") {
        let op = &step["op"];
        let department = op["departmentId"].as_str().expect("department");
        let body = match op["op"].as_str() {
            Some("assign") => router
                .assign_conversation(department, op["mode"].as_str().unwrap_or_default())
                .await
                .expect("assign")
                .unwrap_or_else(|| json!({ "error": "no_agents_available" })),
            Some("release") => {
                router
                    .release_conversation(department, op["agentId"].as_str().unwrap_or_default())
                    .await
                    .expect("release");
                json!({ "ok": true })
            }
            _ => {
                router
                    .sync_agents(department, op["agents"].as_array().expect("agents"))
                    .await
                    .expect("sync");
                json!({ "ok": true })
            }
        };
        assert_eq!(body, step["body"], "{op}");
        let state = router.department_state(department).await.expect("state");
        assert_eq!(
            normalise(&state.unwrap_or(Value::Null), ""),
            step["state"],
            "{op}"
        );
    }
}

// ---------------------------------------------------------------------------
// The database, Discord/Slack and realtime doubles
// ---------------------------------------------------------------------------

/// The database tests share one database: one at a time.
static DATABASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn tenant() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(PgPool::connect(&url).await.expect("the tenant database"))
}

async fn run_sql(db: &PgPool, statements: &Value) {
    for statement in statements.as_array().expect("statements") {
        let sql = statement.as_str().expect("SQL").to_owned();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(db)
            .await
            .unwrap_or_else(|error| panic!("{statement}: {error}"));
    }
}

const DUMPED: [&str; 5] = [
    "helpdesk_conversations",
    "helpdesk_conversation_messages",
    "helpdesk_workflow_executions",
    "helpdesk_satisfaction_surveys",
    "helpdesk_agents",
];

async fn dump(db: &PgPool) -> HashMap<&'static str, Vec<Value>> {
    let mut out = HashMap::new();
    for table in DUMPED {
        let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(t) from {table} t"
        )))
        .fetch_all(db)
        .await
        .expect("rows");
        out.insert(table, rows.iter().map(|row| normalise(row, "")).collect());
    }
    out
}

/// The generator's `changes(before, after)`, rows sorted.
fn changes(before: &HashMap<&str, Vec<Value>>, after: &HashMap<&str, Vec<Value>>) -> Value {
    let mut out = Map::new();
    for table in DUMPED {
        let added: Vec<Value> = after[table]
            .iter()
            .filter(|r| !before[table].contains(r))
            .cloned()
            .collect();
        let removed: Vec<Value> = before[table]
            .iter()
            .filter(|r| !after[table].contains(r))
            .cloned()
            .collect();
        if !added.is_empty() || !removed.is_empty() {
            out.insert(
                table.to_owned(),
                json!({ "added": sorted(added), "removed": sorted(removed) }),
            );
        }
    }
    Value::Object(out)
}

/// A fixture's `changes`, rows sorted the same way.
fn sorted_changes(value: &Value) -> Value {
    let mut out = Map::new();
    for (table, change) in value.as_object().expect("changes") {
        let rows = |key: &str| sorted(change[key].as_array().cloned().unwrap_or_default());
        out.insert(
            table.clone(),
            json!({ "added": rows("added"), "removed": rows("removed") }),
        );
    }
    Value::Object(out)
}

fn publishes(realtime: &RecordingRealtime) -> Value {
    Value::Array(
        realtime
            .messages()
            .into_iter()
            .map(|m| normalise(&json!({ "channel": m.channel, "payload": m.payload }), ""))
            .collect(),
    )
}

/// Discord's and Slack's APIs: records each request, answers 200.
#[derive(Default)]
struct RecordingHttp {
    calls: Mutex<Vec<Value>>,
}

impl DeskHttp for RecordingHttp {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>> {
        let body = request.body.as_deref().map_or(Value::Null, |b| {
            serde_json::from_str(b).expect("a JSON body")
        });
        let headers: Vec<Value> = request.headers.iter().map(|(k, v)| json!([k, v])).collect();
        let answer = if request.url.starts_with("https://slack.com/") {
            r#"{"ok":true}"#
        } else {
            "{}"
        };
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(json!({ "method": request.method, "url": request.url, "headers": headers, "body": body }));
        Box::pin(async move {
            Ok(HttpResponse {
                status: 200,
                body: answer.to_owned(),
            })
        })
    }
}

// ---------------------------------------------------------------------------
// 3. Step handlers
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn handlers_match_typescript() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set: skipped");
        return;
    };
    let _one_at_a_time = DATABASE.lock().await;
    let fx = fixture("workflow_handlers");
    for case in fx["cases"].as_array().expect("cases") {
        let name = &case["name"];
        let input = &case["input"];
        run_sql(&db, &fx["seed"]).await;
        run_sql(&db, &input["seed"]).await;
        let before = dump(&db).await;
        let realtime = Arc::new(RecordingRealtime::new());
        let deps = StepDeps {
            db: db.clone(),
            realtime: input["realtime"]
                .as_bool()
                .unwrap_or(false)
                .then(|| Arc::clone(&realtime) as Arc<dyn DynRealtimePublisher>),
        };
        let step_results = map(&input["stepResults"]);
        let variables = map(&input["variables"]);
        let outcome = execute_step_handler(
            &deps,
            &input["step"],
            StepInput {
                conversation_id: input["conversationId"].as_str().expect("conversation"),
                workspace_id: "org_1",
                execution_id: "wex_fixture",
                trigger_data: &input["triggerData"],
                step_results: &step_results,
                variables: &variables,
            },
        )
        .await
        .expect("the step ran");
        let outcome = serde_json::to_value(&outcome).expect("outcome JSON");
        assert_eq!(normalise(&outcome, ""), case["outcome"], "{name}: outcome");
        assert_eq!(
            changes(&before, &dump(&db).await),
            sorted_changes(&case["changes"]),
            "{name}: rows"
        );
        assert_eq!(publishes(&realtime), case["publishes"], "{name}: realtime");
    }
}

// ---------------------------------------------------------------------------
// 4. Whole runs
// ---------------------------------------------------------------------------

/// One run's step log and its parked wait.
#[derive(Default)]
struct RunState {
    log: Vec<Value>,
    parked: Option<(String, oneshot::Sender<bool>)>,
    pending: Vec<String>,
    outcome: Option<Value>,
}

/// One run, as the test drives it: the job's context too.
struct TestRun {
    key: String,
    state: Mutex<RunState>,
    changed: watch::Sender<u64>,
}

impl TestRun {
    fn state(&self) -> std::sync::MutexGuard<'_, RunState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    /// `true` once the run parks in a wait, `false` once it is over.
    async fn parked_or_done(&self) -> bool {
        let mut rx = self.changed.subscribe();
        loop {
            {
                let state = self.state();
                if state.parked.is_some() {
                    return true;
                }
                if state.outcome.is_some() {
                    return false;
                }
            }
            rx.changed().await.expect("the run's channel");
        }
    }

    async fn outcome(&self) -> Value {
        let mut rx = self.changed.subscribe();
        loop {
            if let Some(outcome) = self.state().outcome.clone() {
                return outcome;
            }
            rx.changed().await.expect("the run's channel");
        }
    }

    fn time_out(&self) {
        let parked = self.state().parked.take();
        if let Some((_, wake)) = parked {
            let _ = wake.send(false);
        }
    }
}

impl JobContext for TestRun {
    fn key(&self) -> &str {
        &self.key
    }

    fn run_step<'s>(
        &'s self,
        name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        self.state().log.push(json!({ "kind": "do", "name": name }));
        step()
    }

    fn sleep(&self, name: &str, duration: Duration) -> BoxFuture<'_, Result<(), JobError>> {
        let ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        self.state()
            .log
            .push(json!({ "kind": "sleep", "name": name, "ms": ms }));
        Box::pin(async { Ok(()) })
    }

    fn wait_for_signal(
        &self,
        name: &str,
        signal: &str,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<bool, JobError>> {
        let minutes = timeout.as_secs() / 60;
        let receiver = {
            let mut state = self.state();
            state.log.push(json!({
                "kind": "wait", "name": name, "type": signal, "timeout": format!("{minutes} minutes"),
            }));
            if let Some(at) = state.pending.iter().position(|s| s == signal) {
                state.pending.remove(at);
                None
            } else {
                let (wake, receiver) = oneshot::channel();
                state.parked = Some((signal.to_owned(), wake));
                Some(receiver)
            }
        };
        self.bump();
        Box::pin(async move {
            match receiver {
                None => Ok(true),
                Some(receiver) => Ok(receiver.await.unwrap_or(false)),
            }
        })
    }
}

/// [`Jobs`] for the runs: each start runs the job on a task with a
/// [`TestRun`] as its context; signals wake its parked wait.
struct TestJobs {
    job: ConversationWorkflowJob,
    runs: Mutex<Vec<Arc<TestRun>>>,
}

impl TestJobs {
    fn last(&self) -> Option<Arc<TestRun>> {
        self.runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last()
            .cloned()
    }
}

impl Jobs for TestJobs {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        assert_eq!(request.name, CONVERSATION_WORKFLOW_JOB);
        let run = Arc::new(TestRun {
            key: request.key.clone(),
            state: Mutex::new(RunState::default()),
            changed: watch::channel(0).0,
        });
        self.runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Arc::clone(&run));
        let job = self.job.clone();
        tokio::spawn(async move {
            let params: ConversationWorkflowParams =
                serde_json::from_value(request.payload).expect("params");
            let outcome = match job.execute(run.as_ref(), &params).await {
                Ok(value) => json!({ "ok": normalise(&value, "") }),
                Err(error) => {
                    let message = error.to_string();
                    let message = match message.find("waiting for ") {
                        Some(at) => format!("{}waiting", &message[..at]),
                        None => message,
                    };
                    json!({ "error": message })
                }
            };
            run.state().outcome = Some(outcome);
            run.bump();
        });
        std::future::ready(Ok(()))
    }

    fn signal<'a>(
        &'a self,
        _name: &'a str,
        key: &'a str,
        signal: &'a str,
    ) -> impl Future<Output = Result<bool, PortError>> + Send + 'a {
        let run = self
            .runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|run| run.key == key)
            .cloned();
        let woke = run.is_some_and(|run| {
            let mut state = run.state();
            match state.parked.take() {
                Some((parked, wake)) if parked == signal => {
                    let _ = wake.send(true);
                    true
                }
                other => {
                    state.parked = other;
                    state.pending.push(signal.to_owned());
                    false
                }
            }
        });
        std::future::ready(Ok(woke))
    }
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn runs_match_typescript() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set: skipped");
        return;
    };
    let _one_at_a_time = DATABASE.lock().await;
    let fx = fixture("workflow_runs");
    for case in fx["cases"].as_array().expect("cases") {
        let name = &case["name"];
        let input = &case["input"];
        run_sql(&db, &fx["clear"]).await;
        run_sql(&db, &input["seed"]).await;
        let before = dump(&db).await;

        let realtime = Arc::new(RecordingRealtime::new());
        let http = Arc::new(RecordingHttp::default());
        let pool = db.clone();
        let tenants: TenantDatabases = Arc::new(move |_| {
            let pool = pool.clone();
            Box::pin(async move { Ok(pool) })
        });
        let jobs = Arc::new(TestJobs {
            job: ConversationWorkflowJob {
                deps: EngineDeps {
                    tenants: Arc::clone(&tenants),
                    realtime: Some(Arc::clone(&realtime) as Arc<dyn DynRealtimePublisher>),
                    http: Some(Arc::clone(&http) as DynDeskHttp),
                    discord_bot_token: input["discordToken"]
                        .as_bool()
                        .unwrap_or(false)
                        .then(|| "bot-token".to_owned()),
                },
            },
            runs: Mutex::new(Vec::new()),
        });
        let engine = InProcessEngine::new(
            tenants,
            Arc::clone(&jobs) as Arc<dyn weldsuite_ports::DynJobs>,
        );

        let mut calls: Vec<Value> = Vec::new();
        let conversation = input["event"]["conversationId"].clone();
        let started = engine.handle_event(&input["event"]).await;
        calls.push(json!({ "path": "/event", "body": input["event"], "status": started.status, "response": started.body }));
        let mut steps = json!([]);
        let mut outcome = Value::Null;
        if started.body["action"] == "workflow_started" {
            let run = jobs.last().expect("a run started");
            for action in input["actions"].as_array().expect("actions") {
                if !run.parked_or_done().await {
                    break;
                }
                if action.get("timeout").is_some() {
                    run.time_out();
                } else if let Some(event) = action.get("event") {
                    let answer = engine.handle_event(event).await;
                    calls.push(json!({ "path": "/event", "body": event, "status": answer.status, "response": answer.body }));
                } else {
                    let waiting: Option<String> = sqlx::query_scalar(
                        "select id from helpdesk_workflow_executions where status = 'waiting_for_input'",
                    )
                    .fetch_optional(&db)
                    .await
                    .expect("the waiting execution");
                    let mut body = map(&action["respond"]);
                    body.insert("conversationId".to_owned(), conversation.clone());
                    body.insert("workspaceId".to_owned(), json!("org_1"));
                    body.insert("executionId".to_owned(), json!(waiting));
                    let body = Value::Object(body);
                    let answer = engine.handle_respond(&body).await;
                    calls.push(json!({ "path": "/respond", "body": body, "status": answer.status, "response": answer.body }));
                }
            }
            outcome = run.outcome().await;
            steps = Value::Array(run.state().log.clone());
            if outcome.get("error").is_none() {
                let body = json!({ "conversationId": conversation, "workspaceId": "org_1", "executionId": "none", "stepId": "late" });
                let answer = engine.handle_respond(&body).await;
                calls.push(json!({ "path": "/respond", "body": body, "status": answer.status, "response": answer.body }));
            }
        }

        assert_eq!(
            normalise(&Value::Array(calls), ""),
            case["calls"],
            "{name}: calls"
        );
        assert_eq!(steps, case["steps"], "{name}: steps");
        assert_eq!(outcome, case["outcome"], "{name}: outcome");
        assert_eq!(
            changes(&before, &dump(&db).await),
            sorted_changes(&case["changes"]),
            "{name}: rows"
        );
        assert_eq!(publishes(&realtime), case["publishes"], "{name}: realtime");
        let http_calls = Value::Array(
            http.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        );
        assert_eq!(normalise(&http_calls, ""), case["http"], "{name}: http");
    }
}
