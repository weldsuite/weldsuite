//! The integration polls against what integration-webhook-worker's own cron
//! did (`tests/fixtures/poll_jobs.json`, written by
//! `apps/workers/integration-webhook-worker/src/test/poll-rust-fixtures.test.ts`,
//! `pnpm rust:integration-fixtures`): the same seed, Google and Airtable
//! answering what they answered TypeScript (matched by method and URL), and
//! the same calls, runs, index decision and rows.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set (`scripts/rust-test-db.ts`),
//! on copies of the tables in a throwaway schema.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_db::Keyring;
use weldsuite_integrations::workflow_events::ExecuteWorkflowRuns;
use weldsuite_integrations::workflow_polls::{PollDeps, poll_workspace};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

const TABLES: [&str; 3] = [
    "workflows",
    "workflow_trigger_index",
    "workflow_integrations",
];

/// Google's `timeMin` (now), as the fixture records it.
fn normalise_url(url: &str) -> String {
    match url.find("timeMin=") {
        Some(at) => {
            let rest = &url[at..];
            let end = rest.find('&').map_or(url.len(), |i| at + i);
            format!("{}timeMin=<ts>{}", &url[..at], &url[end..])
        }
        None => url.to_owned(),
    }
}

/// The providers as the fixture recorded them.
struct Replay {
    exchanges: Vec<Value>,
    used: Mutex<Vec<bool>>,
    calls: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for Replay {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let url = normalise_url(&request.url);
            self.calls
                .lock()
                .expect("calls")
                .push(json!({ "method": request.method, "url": url }));
            let mut used = self.used.lock().expect("used");
            for (i, exchange) in self.exchanges.iter().enumerate() {
                if !used[i] && exchange["method"] == request.method && exchange["url"] == url {
                    used[i] = true;
                    let status =
                        u16::try_from(exchange["status"].as_u64().unwrap_or(200)).unwrap_or(200);
                    let body = exchange["responseText"]
                        .as_str()
                        .map_or_else(|| exchange["response"].to_string(), str::to_owned);
                    return Ok(HttpResponse::new(status, body.into_bytes()));
                }
            }
            Ok(HttpResponse::new(
                599,
                b"{\"message\":\"no recorded answer\"}".to_vec(),
            ))
        })
    }
}

/// `EXECUTE_WORKFLOW`, recording the params.
#[derive(Default)]
struct Runs(Mutex<Vec<Value>>);

impl ExecuteWorkflowRuns for Runs {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        self.0.lock().expect("runs").push(params.clone());
        Box::pin(std::future::ready(Ok(())))
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

/// The fixture's `normalise`.
fn normalise(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(normalise).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v)))
                .collect::<Map<_, _>>(),
        ),
        Value::String(text) if is_iso(text) && !text.starts_with("2026-10-0") => json!("<ts>"),
        #[allow(clippy::cast_possible_truncation)]
        Value::Number(n) if n.is_f64() && n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
            json!(n.as_f64().unwrap_or_default() as i64)
        }
        other => other.clone(),
    }
}

/// Rows sorted as JavaScript sorts `JSON.stringify` of the fixture's
/// key-sorted objects (`serde_json` prints keys sorted too).
fn sort_rows(rows: &mut [Value]) {
    rows.sort_by_key(ToString::to_string);
}

async fn dump(db: &weldsuite_db::PgPool) -> Value {
    let mut out = Map::new();
    for table in TABLES {
        let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(t) from {table} t"
        )))
        .fetch_all(db)
        .await
        .expect("dump");
        let mut rows: Vec<Value> = rows.iter().map(normalise).collect();
        sort_rows(&mut rows);
        out.insert(table.to_owned(), Value::Array(rows));
    }
    Value::Object(out)
}

fn sorted(rows: &Value) -> Value {
    let Value::Object(tables) = rows else {
        return rows.clone();
    };
    Value::Object(
        tables
            .iter()
            .map(|(table, rows)| {
                let mut rows = rows.as_array().cloned().unwrap_or_default();
                sort_rows(&mut rows);
                (table.clone(), Value::Array(rows))
            })
            .collect(),
    )
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn the_polls_do_what_the_worker_did() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/poll_jobs.json")).expect("fixtures");
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
        let exchanges = scenario["exchanges"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let replay = Arc::new(Replay {
            used: Mutex::new(vec![false; exchanges.len()]),
            exchanges,
            calls: Mutex::default(),
        });
        let http = OutboundHttp(Arc::clone(&replay) as Arc<dyn DynOutboundHttp>);
        let runs = Runs::default();
        let env = &scenario["env"];
        let google_client = env["GOOGLE_CLIENT_ID"]
            .as_str()
            .map(str::to_owned)
            .zip(env["GOOGLE_CLIENT_SECRET"].as_str().map(str::to_owned));
        let keyring = Keyring::default();
        let deps = PollDeps {
            db: &db,
            http: Some(&http),
            runs: Some(&runs),
            keyring: &keyring,
            google_client,
            workspace: "org_poll",
        };
        let (_, kept) = poll_workspace(&deps).await.expect("poll");
        let expected_calls: Vec<Value> = scenario["exchanges"]
            .as_array()
            .map(|exchanges| {
                exchanges
                    .iter()
                    .map(|e| json!({ "method": e["method"], "url": e["url"] }))
                    .collect()
            })
            .unwrap_or_default();
        let calls = Value::Array(replay.calls.lock().expect("calls").clone());
        let recorded = normalise(&Value::Array(runs.0.lock().expect("runs").clone()));
        let rows = dump(&db).await;
        let checks = [
            ("calls", calls, Value::Array(expected_calls)),
            ("runs", recorded, scenario["runs"].clone()),
            ("kept", json!([kept]), scenario["kept"].clone()),
            ("rows", rows, sorted(&scenario["rows"])),
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
