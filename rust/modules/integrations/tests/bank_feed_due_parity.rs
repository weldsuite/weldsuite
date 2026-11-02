//! The bank feed due sweep against what integration-sync-worker's own code
//! did (`tests/fixtures/bank_feed_due.json`, written by
//! `apps/workers/integration-sync-worker/src/rust-fixtures.test.ts`,
//! `pnpm rust:integration-fixtures`): the same rows, the same answers from
//! `BOOKS_INTERNAL`, the same result, calls and rows left.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set (`scripts/rust-test-db.ts`),
//! each scenario on its own copy of `bank_feed_connection_index` in a
//! throwaway schema, so other tests' rows never meet the sweep.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_integrations::bank_feed_due::run_bank_feed_due_sweep;
use weldsuite_integrations::{BindingRequest, BindingResponse, ServiceBinding};
use weldsuite_ports::BoxFuture;

struct Stub {
    answers: Value,
    calls: Mutex<Vec<Value>>,
}

impl ServiceBinding for Stub {
    fn fetch(&self, request: BindingRequest) -> BoxFuture<'_, Result<BindingResponse, String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").push(json!({
                "method": request.method,
                "path": request.path,
                "workspace": request.workspace_key,
                "body": request.body,
            }));
            let id = request.path.split('/').nth(3).unwrap_or_default().to_owned();
            match self.answers.get(&id) {
                Some(answer) if answer.get("throws").is_some() => Err(answer["throws"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()),
                Some(answer) => Ok(BindingResponse {
                    status: u16::try_from(answer["status"].as_u64().unwrap_or(200)).unwrap_or(200),
                    body: answer.get("body").cloned().unwrap_or(json!({})).to_string(),
                }),
                None => Ok(BindingResponse {
                    status: 200,
                    body: json!({ "data": { "connectionId": id, "status": "active", "added": 2 } })
                        .to_string(),
                }),
            }
        })
    }
}

#[tokio::test]
async fn the_sweep_does_what_the_worker_did() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/bank_feed_due.json")).expect("fixtures");
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("master database");
    let schema = format!(
        "p8_integ_{}",
        weldsuite_kit::random_string(10, "abcdefghijklmnopqrstuvwxyz")
    );
    sqlx::query(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .execute(&admin)
        .await
        .expect("schema");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "create table {schema}.bank_feed_connection_index (like public.bank_feed_connection_index including all)"
    )))
    .execute(&admin)
    .await
    .expect("table");
    let options = PgConnectOptions::from_str(&url)
        .expect("url")
        .options([("search_path", schema.as_str())]);
    let master = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("scoped pool");

    let mut failures = Vec::new();
    for scenario in &fixtures {
        let name = scenario["name"].as_str().unwrap_or_default();
        sqlx::query("delete from bank_feed_connection_index")
            .execute(&master)
            .await
            .expect("clear");
        for row in scenario["rows"].as_array().expect("rows") {
            sqlx::query(
                "insert into bank_feed_connection_index (id, provider, provider_connection_id, clerk_org_id, \
                 connection_id, entity_id, is_active, sync_interval_hours, next_sync_at) \
                 values ($1, $2, $3, $4, $5, 'ent_1', $6, $7, $8::timestamptz)",
            )
            .bind(row["id"].as_str())
            .bind(row["provider"].as_str())
            .bind(row["provider_connection_id"].as_str())
            .bind(row["clerk_org_id"].as_str())
            .bind(row["connection_id"].as_str())
            .bind(row["is_active"].as_bool())
            .bind(row["sync_interval_hours"].as_i64().and_then(|n| i32::try_from(n).ok()))
            .bind(row["next_sync_at"].as_str())
            .execute(&master)
            .await
            .expect("seed");
        }
        let stub = Arc::new(Stub {
            answers: scenario["answers"].clone(),
            calls: Mutex::default(),
        });
        let now = time::OffsetDateTime::parse(
            scenario["now"].as_str().expect("now"),
            &time::format_description::well_known::Rfc3339,
        )
        .expect("now");
        let binding: Option<&dyn ServiceBinding> = scenario["binding"]
            .as_bool()
            .unwrap_or(true)
            .then_some(stub.as_ref() as &dyn ServiceBinding);
        let limit = usize::try_from(scenario["limit"].as_u64().unwrap_or(25)).unwrap_or(25);
        let result = run_bank_feed_due_sweep(&master, binding, now, limit)
            .await
            .expect("sweep");
        let rows: Vec<(String, bool, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                r#"select id, is_active,
                     to_char(next_sync_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     to_char(last_triggered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     last_error
                   from bank_feed_connection_index order by id"#,
            )
        .fetch_all(&master)
        .await
        .expect("rows");
        let after: Vec<Value> = rows
            .into_iter()
            .map(|(id, active, next, triggered, error)| {
                json!({
                    "id": id,
                    "is_active": active,
                    "next_sync_at": next,
                    "last_triggered_at": triggered,
                    "last_error": error,
                })
            })
            .collect();
        let calls = Value::Array(stub.calls.lock().expect("calls").clone());
        for (what, rust, typescript) in [
            ("result", result.to_json(), scenario["result"].clone()),
            ("calls", calls, scenario["calls"].clone()),
            ("rows", Value::Array(after), scenario["after"].clone()),
        ] {
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
