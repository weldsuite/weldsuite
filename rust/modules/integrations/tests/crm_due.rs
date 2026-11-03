//! The CRM due sweep on a real tenant schema: which connections it syncs
//! (and which Google watches it renews first) through WeldConnect's internal
//! routes, and when the workspace is next due.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set (`scripts/rust-test-db.ts`),
//! on a copy of `integration_connections` in a throwaway schema.

use std::str::FromStr;
use std::sync::Mutex;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_integrations::crm::due::{CrmDueCounts, sweep_workspace};
use weldsuite_integrations::{BindingResponse, ConnectCall, ConnectInternal};
use weldsuite_ports::BoxFuture;

/// connect-api's internal routes: refuses one connection's sync.
#[derive(Default)]
struct Connect {
    calls: Mutex<Vec<String>>,
}

impl ConnectInternal for Connect {
    fn fetch(&self, call: ConnectCall) -> BoxFuture<'_, Result<BindingResponse, String>> {
        Box::pin(async move {
            let workspace = call
                .headers
                .iter()
                .find(|(name, _)| name == "X-Workspace-Id")
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            self.calls
                .lock()
                .expect("calls")
                .push(format!("{} {workspace}", call.path));
            let status = if call.path.contains("conn_refused") {
                409
            } else {
                200
            };
            Ok(BindingResponse {
                status,
                body: "{}".to_owned(),
            })
        })
    }
}

const HOUR: i64 = 3_600_000;

#[tokio::test]
async fn the_sweep_syncs_what_is_due_and_says_when_next() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
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
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "create table {schema}.integration_connections (like public.integration_connections including all)"
    )))
    .execute(&admin)
    .await
    .expect("table");
    let options = PgConnectOptions::from_str(&url)
        .expect("url")
        .options([("search_path", format!("{schema},public"))]);
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("scoped pool");

    // now = 2026-10-10T12:00:00Z
    let now: i64 = 1_791_633_600_000;
    sqlx::raw_sql(
        "insert into integration_connections (id, provider, status, sync_settings, webhook_secret, last_sync_at, created_at, updated_at) values
          ('conn_due', 'attio', 'active', null, null, '2026-10-10 05:00:00', '2026-10-01 09:00:00', '2026-10-01 09:00:00'),
          ('conn_later', 'hubspot', 'active', '{\"syncIntervalHours\": 2}', null, '2026-10-10 11:00:00', '2026-10-01 09:00:00', '2026-10-01 09:00:00'),
          ('conn_refused', 'hubspot', 'syncing', null, null, null, '2026-10-01 09:00:00', '2026-10-01 09:00:00'),
          ('conn_watch', 'google_calendar', 'active', null, '{\"token\":\"t\",\"expiration\":\"1791680400000\"}', '2026-10-10 11:30:00', '2026-10-01 09:00:00', '2026-10-01 09:00:00'),
          ('conn_shop', 'shopify', 'active', null, null, null, '2026-10-01 09:00:00', '2026-10-01 09:00:00'),
          ('conn_gone', 'attio', 'active', null, null, null, '2026-10-01 09:00:00', '2026-10-01 09:00:00')",
    )
    .execute(&db)
    .await
    .expect("seed");
    sqlx::query("update integration_connections set deleted_at = now() where id = 'conn_gone'")
        .execute(&db)
        .await
        .expect("delete");

    let connect = Connect::default();
    let mut counts = CrmDueCounts::default();
    let next = sweep_workspace(&db, &connect, "org_due", now, &mut counts)
        .await
        .expect("sweep");

    assert_eq!(
        connect.calls.lock().expect("calls").clone(),
        vec![
            "/api/integrations/connections/conn_due/sync org_due",
            "/api/integrations/connections/conn_refused/sync org_due",
        ]
    );
    assert_eq!(
        counts,
        CrmDueCounts {
            triggered: 1,
            renewed: 0,
            failed: 1,
        }
    );
    // conn_later's two-hour interval, an hour after its last sync.
    assert_eq!(next, Some(now + HOUR));

    // Thirteen hours on, the watch (expiring at 2026-10-11T01:00Z) renews first.
    let later = now + 13 * HOUR;
    connect.calls.lock().expect("calls").clear();
    let mut counts = CrmDueCounts::default();
    sweep_workspace(&db, &connect, "org_due", later, &mut counts)
        .await
        .expect("sweep");
    let calls = connect.calls.lock().expect("calls").clone();
    assert!(
        calls.contains(&"/api/integrations/connections/conn_watch/renew-watch org_due".to_owned())
    );
    assert!(calls.contains(&"/api/integrations/connections/conn_watch/sync org_due".to_owned()));
    assert_eq!(counts.renewed, 1);

    sqlx::query(sqlx::AssertSqlSafe(format!("drop schema {schema} cascade")))
        .execute(&admin)
        .await
        .expect("drop schema");
}
