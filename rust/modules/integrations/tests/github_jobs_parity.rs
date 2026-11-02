//! The GitHub jobs against what integration-webhook-worker's own Workflows
//! did (`tests/fixtures/github_jobs.json`, written by
//! `apps/workers/integration-webhook-worker/src/test/rust-fixtures.test.ts`,
//! `pnpm rust:integration-fixtures`): the same seed, GitHub answering what it
//! answered TypeScript (matched by method, URL and body), and the same steps,
//! error, calls and rows.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set (`scripts/rust-test-db.ts`),
//! on copies of the tables in a throwaway schema.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{Map, Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_integrations::github::outbound::GithubProjectOutboundJob;
use weldsuite_integrations::github::project_sync::GithubProjectSyncJob;
use weldsuite_integrations::github::{AppCredentials, GithubDeps};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, Job, JobContext, JobError, OutboundHttp,
    PortError, StepFn, StepRetry,
};

const TABLES: [&str; 5] = [
    "tasks",
    "github_connections",
    "github_project_links",
    "github_issue_sync_map",
    "project_pipeline_stages",
];

/// GitHub as the fixture recorded it.
struct Replay {
    exchanges: Vec<Value>,
    used: Mutex<Vec<bool>>,
    calls: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for Replay {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let body = request
                .body
                .as_deref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok())
                .unwrap_or(Value::Null);
            let call = json!({ "method": request.method, "url": request.url, "body": body });
            self.calls.lock().expect("calls").push(call.clone());
            let mut used = self.used.lock().expect("used");
            for (i, exchange) in self.exchanges.iter().enumerate() {
                if !used[i]
                    && exchange["method"] == call["method"]
                    && exchange["url"] == call["url"]
                    && exchange["body"] == call["body"]
                {
                    used[i] = true;
                    let status =
                        u16::try_from(exchange["status"].as_u64().unwrap_or(200)).unwrap_or(200);
                    return Ok(HttpResponse::new(
                        status,
                        exchange["response"].to_string().into_bytes(),
                    ));
                }
            }
            Ok(HttpResponse::new(
                599,
                b"{\"message\":\"no recorded answer\"}".to_vec(),
            ))
        })
    }
}

/// Runs each step once and remembers its name.
struct OnceSteps {
    steps: Mutex<Vec<String>>,
}

impl JobContext for OnceSteps {
    fn key(&self) -> &str {
        "fixture"
    }

    fn run_step<'s>(
        &'s self,
        name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        self.steps.lock().expect("steps").push(name.to_owned());
        Box::pin(async move {
            step().await.map_err(|error| match error {
                JobError::Failed(message) => JobError::StepFailed {
                    step: name.to_owned(),
                    message,
                },
                other => other,
            })
        })
    }
}

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

fn is_generated(text: &str) -> bool {
    ["tsk_", "ghsm_"].iter().any(|prefix| {
        text.strip_prefix(prefix).is_some_and(|rest| {
            rest.len() >= 14
                && rest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        })
    })
}

/// The fixture's `normalise`.
fn normalise(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(normalise).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) if is_generated(text) => {
            json!(format!(
                "<id:{}>",
                text.split('_').next().unwrap_or_default()
            ))
        }
        Value::String(text) if is_iso(text) && !text.starts_with("2026-10-0") => json!("<ts>"),
        // JSON from JavaScript prints 0.00 as 0.
        #[allow(clippy::cast_possible_truncation)]
        Value::Number(n) if n.is_f64() && n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
            json!(n.as_f64().unwrap_or_default() as i64)
        }
        other => other.clone(),
    }
}

async fn dump(db: &PgPool) -> Value {
    let mut out = Map::new();
    for (table, filter) in [
        ("tasks", "project_id like 'prj_%'"),
        ("github_issue_sync_map", "true"),
        ("github_project_links", "true"),
        ("github_connections", "true"),
    ] {
        let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(t) from {table} t where {filter}"
        )))
        .fetch_all(db)
        .await
        .expect("dump");
        let mut rows: Vec<Value> = rows.iter().map(normalise).collect();
        rows.sort_by_key(|row| row.to_string());
        out.insert(table.to_owned(), Value::Array(rows));
    }
    Value::Object(out)
}

/// The fixture's rows sorted the way [`dump`] sorts them.
fn sorted(rows: &Value) -> Value {
    let Value::Object(tables) = rows else {
        return rows.clone();
    };
    Value::Object(
        tables
            .iter()
            .map(|(table, rows)| {
                let mut rows = rows.as_array().cloned().unwrap_or_default();
                rows.sort_by_key(|row| row.to_string());
                (table.clone(), Value::Array(rows))
            })
            .collect(),
    )
}

fn test_key() -> String {
    use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
    let key = aws_lc_rs::rsa::KeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).expect("rsa");
    let der: Pkcs8V1Der<'static> = key.as_der().expect("pkcs8");
    let body = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
    format!("-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----\n")
}

#[tokio::test]
async fn the_github_jobs_do_what_the_workflows_did() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/github_jobs.json")).expect("fixtures");
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("tenant database");
    let schema = format!(
        "p8_integ_{}",
        weldsuite_kit::random_string(10, "abcdefghijklmnopqrstuvwxyz")
    );
    sqlx::query(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .execute(&admin)
        .await
        .expect("schema");
    for table in TABLES {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "create table {schema}.{table} (like public.{table} including all)"
        )))
        .execute(&admin)
        .await
        .expect("table");
    }
    let options = PgConnectOptions::from_str(&url)
        .expect("url")
        .options([("search_path", format!("{schema},public"))]);
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("scoped pool");
    let credentials = AppCredentials {
        app_id: "424242".to_owned(),
        private_key: test_key(),
    };

    let mut failures = Vec::new();
    for scenario in &fixtures {
        let name = scenario["name"].as_str().unwrap_or_default();
        for table in TABLES {
            sqlx::query(sqlx::AssertSqlSafe(format!("delete from {table}")))
                .execute(&db)
                .await
                .expect("clear");
        }
        for statement in scenario["seed"].as_array().expect("seed") {
            sqlx::raw_sql(sqlx::AssertSqlSafe(
                statement.as_str().unwrap_or_default().to_owned(),
            ))
            .execute(&db)
            .await
            .unwrap_or_else(|error| panic!("{name}: seed failed: {error}"));
        }
        let replay = Arc::new(Replay {
            exchanges: scenario["exchanges"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            used: Mutex::new(vec![
                false;
                scenario["exchanges"].as_array().map_or(0, Vec::len)
            ]),
            calls: Mutex::default(),
        });
        let tenant_db = db.clone();
        let deps = GithubDeps {
            tenants: Arc::new(move |reference: String| {
                let db = tenant_db.clone();
                Box::pin(async move {
                    Ok(Tenant {
                        workspace_id: reference.clone(),
                        clerk_org_id: Some(reference),
                        db,
                        suspended: false,
                        restrictions: WorkspaceRestrictions::default(),
                    })
                })
            }),
            http: Some(OutboundHttp(Arc::clone(&replay) as Arc<dyn DynOutboundHttp>)),
            credentials: Some(credentials.clone()),
        };
        let ctx = OnceSteps {
            steps: Mutex::default(),
        };
        let payload = scenario["payload"].clone();
        let result = if scenario["job"] == "sync" {
            GithubProjectSyncJob { deps }.run(&ctx, payload).await
        } else {
            GithubProjectOutboundJob { deps }.run(&ctx, payload).await
        };
        let error = match result {
            Ok(()) => Value::Null,
            Err(JobError::StepFailed { message, .. } | JobError::Failed(message)) => json!(message),
            Err(other) => json!(other.to_string()),
        };
        let expected_calls: Vec<Value> = scenario["exchanges"]
            .as_array()
            .map(|exchanges| {
                exchanges
                    .iter()
                    .map(|e| json!({ "method": e["method"], "url": e["url"], "body": e["body"] }))
                    .collect()
            })
            .unwrap_or_default();
        let checks = [
            (
                "steps",
                json!(ctx.steps.lock().expect("steps").clone()),
                scenario["steps"].clone(),
            ),
            ("error", error, scenario["error"].clone()),
            (
                "calls",
                Value::Array(replay.calls.lock().expect("calls").clone()),
                Value::Array(expected_calls),
            ),
            ("rows", dump(&db).await, sorted(&scenario["rows"])),
        ];
        for (what, rust, typescript) in checks {
            if rust != typescript {
                failures.push(format!(
                    "{name}: {what}\n  rust:       {rust}\n  typescript: {typescript}"
                ));
            }
        }
    }
    sqlx::query(sqlx::AssertSqlSafe(format!("drop schema {schema} cascade")))
        .execute(&admin)
        .await
        .expect("drop schema");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
