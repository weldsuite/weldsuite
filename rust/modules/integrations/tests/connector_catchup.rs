//! The connector catch-up on a real tenant schema: which connections are
//! due, which the probe finds changes on (and are caught up through
//! WeldConnect's internal route), which back off, and when the workspace is
//! next due.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set (`scripts/rust-test-db.ts`),
//! on a copy of `connector_connections` in a throwaway schema.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_integrations::connectors::{CatchupCounts, catch_up_workspace, probe_env};
use weldsuite_integrations::{BindingResponse, ConnectCall, ConnectInternal};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

/// connect-api's internal routes: every catch-up runs.
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
                .push(format!("{} {} {workspace}", call.method, call.path));
            Ok(BindingResponse {
                status: 200,
                body: r#"{"data":{"watermarks":{}}}"#.to_owned(),
            })
        })
    }
}

/// Picqer, by shop: `busy` has a changed product, `quiet` none, `locked`
/// refuses the key.
#[derive(Default)]
struct Picqer {
    urls: Mutex<Vec<String>>,
}

impl DynOutboundHttp for Picqer {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            self.urls.lock().expect("urls").push(request.url.clone());
            let (status, body) = if request.url.contains("://busy.") {
                (200, r#"[{"idproduct":1,"name":"Mug"}]"#)
            } else if request.url.contains("://locked.") {
                (401, r#"{"error":true,"error_message":"Invalid API key"}"#)
            } else {
                (200, "[]")
            };
            Ok(HttpResponse::new(status, body.as_bytes().to_vec()))
        })
    }
}

const HOUR: i64 = 3_600_000;

#[tokio::test]
async fn the_catch_up_probes_what_is_due_and_says_when_next() {
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
        "p8_connect_{}",
        weldsuite_kit::random_string(10, "abcdefghijklmnopqrstuvwxyz")
    );
    sqlx::query(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .execute(&admin)
        .await
        .expect("schema");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "create table {schema}.connector_connections (like public.connector_connections including all)"
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
        "insert into connector_connections (id, provider, status, credentials, enabled_syncs, last_sync_at, last_error_at, connected_at) values
          ('conn_busy', 'picqer', 'active', '{\"subdomain\":\"busy\",\"apiKey\":\"k\"}', '[\"products\"]', '2026-10-10 05:00:00', null, '2026-10-01 09:00:00'),
          ('conn_quiet', 'picqer', 'active', '{\"subdomain\":\"quiet\",\"apiKey\":\"k\"}', '[\"products\"]', '2026-10-10 05:30:00', null, '2026-10-01 09:00:00'),
          ('conn_locked', 'picqer', 'sync_error', '{\"subdomain\":\"locked\",\"apiKey\":\"k\"}', '[\"products\"]', '2026-10-10 04:00:00', '2026-10-10 04:00:00', '2026-10-01 09:00:00'),
          ('conn_fresh', 'picqer', 'active', '{\"subdomain\":\"fresh\",\"apiKey\":\"k\"}', '[\"products\"]', '2026-10-10 10:00:00', null, '2026-10-01 09:00:00'),
          ('conn_paused', 'picqer', 'paused', '{\"subdomain\":\"busy\",\"apiKey\":\"k\"}', null, null, null, '2026-10-01 09:00:00'),
          ('conn_pending', 'shopify', 'pending', null, null, null, null, null),
          ('conn_gone', 'picqer', 'active', '{\"subdomain\":\"busy\",\"apiKey\":\"k\"}', null, null, null, '2026-10-01 09:00:00')",
    )
    .execute(&db)
    .await
    .expect("seed");
    sqlx::query("update connector_connections set deleted_at = now() where id = 'conn_gone'")
        .execute(&db)
        .await
        .expect("delete");

    let picqer = Arc::new(Picqer::default());
    let env = probe_env(
        weldsuite_db::Keyring { v1: None, v2: None },
        None,
        Some(OutboundHttp(Arc::clone(&picqer) as Arc<dyn DynOutboundHttp>)),
        weldsuite_events::EntityEventPublisher::new(None, weldsuite_events::TaskTracker::new()),
    );
    let connect = Connect::default();
    let mut counts = CatchupCounts::default();
    let next = catch_up_workspace(&db, &env, &connect, "org_shop", now, &mut counts)
        .await
        .expect("catch-up");

    // Only the busy shop is caught up.
    assert_eq!(
        connect.calls.lock().expect("calls").clone(),
        vec!["POST /api/integrations/connections/conn_busy/catch-up org_shop"]
    );
    assert_eq!(
        counts,
        CatchupCounts {
            probed: 1,
            ingested: 1,
            backed_off: 1,
        }
    );
    // Probed: busy, quiet and locked (its failed sync's back-off is over); the
    // fresh one is not due, the paused, pending and deleted never are.
    let urls = picqer.urls.lock().expect("urls").clone();
    assert_eq!(urls.len(), 3, "{urls:?}");
    assert!(
        urls.iter().all(|u| u.contains("/api/v1/products")),
        "{urls:?}"
    );
    // The fresh connection is next: six hours after its 10:00 sync.
    assert_eq!(next, Some(now + 4 * HOUR));
}
