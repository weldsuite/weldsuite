//! The WeldAds metrics sweep on a real master schema: the enabled
//! `ad_sync_index` rows that are due, synced through WeldConnect's internal
//! route as the workspace's Clerk org.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set (`scripts/rust-test-db.ts`),
//! on a copy of `ad_sync_index` in a throwaway schema.

use std::str::FromStr;
use std::sync::Mutex;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_integrations::meta_ads::run_ad_sync_sweep;
use weldsuite_integrations::{BindingResponse, ConnectCall, ConnectInternal};
use weldsuite_ports::BoxFuture;

#[derive(Default)]
struct Connect {
    calls: Mutex<Vec<String>>,
}

impl ConnectInternal for Connect {
    fn fetch(&self, call: ConnectCall) -> BoxFuture<'_, Result<BindingResponse, String>> {
        Box::pin(async move {
            let org = call
                .headers
                .iter()
                .find(|(name, _)| name == "X-Workspace-Id")
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            let status = if call.path.contains("adc_fail") {
                500
            } else {
                200
            };
            self.calls
                .lock()
                .expect("calls")
                .push(format!("{} {org}", call.path));
            Ok(BindingResponse {
                status,
                body: "{}".to_owned(),
            })
        })
    }
}

#[tokio::test]
async fn the_ad_sweep_syncs_the_due_connections() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
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
        "create table {schema}.ad_sync_index (like public.ad_sync_index including all)"
    )))
    .execute(&admin)
    .await
    .expect("table");
    let options = PgConnectOptions::from_str(&url)
        .expect("url")
        .options([("search_path", format!("{schema},public"))]);
    let master = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("scoped pool");
    sqlx::raw_sql(
        "insert into ad_sync_index (id, workspace_id, connection_id, clerk_org_id, is_enabled, next_metrics_sync_at) values
          ('asi_1', 'ws_1', 'adc_due', 'org_1', true, '2026-10-10 11:00:00+00'),
          ('asi_2', 'ws_1', 'adc_fail', 'org_1', true, '2026-10-10 11:30:00+00'),
          ('asi_3', 'ws_2', 'adc_later', 'org_2', true, '2026-10-10 13:00:00+00'),
          ('asi_4', 'ws_2', 'adc_off', 'org_2', false, '2026-10-10 10:00:00+00'),
          ('asi_5', 'ws_3', 'adc_never', 'org_3', true, null),
          ('asi_6', 'ws_4', 'adc_noorg', '', true, '2026-10-10 10:00:00+00')",
    )
    .execute(&master)
    .await
    .expect("seed");

    let connect = Connect::default();
    // 2026-10-10T12:00:00Z
    let now = time::OffsetDateTime::from_unix_timestamp(1_791_633_600).expect("time");
    let result = run_ad_sync_sweep(&master, &connect, now)
        .await
        .expect("sweep");
    assert_eq!((result.due, result.triggered), (3, 1));
    let mut calls = connect.calls.lock().expect("calls").clone();
    calls.sort();
    assert_eq!(
        calls,
        vec![
            "/api/integrations/ad-connections/adc_due/sync?scope=full org_1",
            "/api/integrations/ad-connections/adc_fail/sync?scope=full org_1",
        ]
    );

    sqlx::query(sqlx::AssertSqlSafe(format!("drop schema {schema} cascade")))
        .execute(&admin)
        .await
        .expect("drop schema");
}
