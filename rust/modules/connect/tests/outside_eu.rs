//! ADR OPS-026 on WeldConnect's workflow integrations: with the EU
//! edition's enforcement on, an integration whose company is outside the EU
//! (Asana here) can't be created until the workspace switched it on, while
//! EU and custom ones always can.
//!
//! Its own test binary, because the enforcement is process-wide
//! (`Enforcement::install`). It runs on the real tenant schema (built from
//! the journaled migrations by `scripts/rust-test-db.ts`) when
//! `WELDSUITE_TEST_TENANT_URL` is set, and returns early otherwise. It only
//! switches `asana`, and leaves it off.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_connect::ConnectState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_outside_eu::store::SettingsSnapshot;
use weldsuite_outside_eu::{Change, Enforcement, ServiceId, Via, store};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const WORKSPACE: &str = "ws_outside_eu_connect_test";
const USER: &str = "user_outside_eu_admin";

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// connect's routes as the server serves them, for an admin of `tenant`.
fn app(tenant: PgPool) -> Router {
    let state = ConnectState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        cache: None,
        master: None,
        http: None,
        jobs: None,
        tenants: None,
        env: Arc::new(HashMap::new()),
        webhooks: None,
        trusted_proxies: 0,
        storage: None,
        ai: None,
        connector_edition: "kubernetes",
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [
            "integrations:create",
            "integrations:read",
            "integrations:update",
        ]
        .iter()
        .map(|p| (*p).to_owned())
        .collect(),
        ..ResolvedPermissions::default()
    };
    weldsuite_connect::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            let auth = AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_outside_eu".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            };
            let tenant = Tenant {
                workspace_id: WORKSPACE.to_owned(),
                clerk_org_id: Some("org_outside_eu".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            };
            let permissions = Permissions::new(resolved.clone(), None, false, USER.to_owned());
            request.extensions_mut().insert(auth);
            request.extensions_mut().insert(tenant);
            request.extensions_mut().insert(permissions);
            next.run(request)
        },
    ))
}

async fn create(app: &Router, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/workflow-integrations")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn switch(db: &PgPool, enabled: bool) {
    store::set(
        db,
        &Change {
            service: ServiceId::Asana,
            enabled,
            actor: USER,
            via: Via::Admin,
            acknowledged: true,
            reason: None,
            at: "2026-11-20T10:00:00.000Z",
        },
    )
    .await
    .expect("switch asana");
}

async fn forget(db: &PgPool, body: &Value) {
    if let Some(id) = body["data"]["id"].as_str() {
        sqlx::query("delete from workflow_integrations where id = $1")
            .bind(id)
            .execute(db)
            .await
            .expect("clean up");
    }
}

/// CI runs every crate's database tests on one database: `workspace_settings`
/// goes back as it was after the test, even when it panics, so no other
/// crate's test (billing reads the oldest settings row) sees its row.
#[tokio::test]
async fn a_service_outside_the_eu_is_created_only_once_switched_on() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("tenant database");
    let snapshot = SettingsSnapshot::take(&db).await.expect("snapshot");
    let outcome = tokio::spawn(asana_follows_the_switch(db.clone())).await;
    snapshot.restore(&db).await.expect("restore");
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}

async fn asana_follows_the_switch(db: PgPool) {
    Enforcement::Enforced.install();
    assert!(weldsuite_outside_eu::enforced());
    let app = app(db.clone());
    switch(&db, false).await;

    // Off: refused before anything is written.
    let before: i64 = sqlx::query_scalar(
        "select count(*) from workflow_integrations where type = 'asana' and deleted_at is null",
    )
    .fetch_one(&db)
    .await
    .expect("count");
    let (status, body) = create(&app, json!({ "name": "Asana", "type": "asana" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "OUTSIDE_EU_SERVICE_OFF");
    assert_eq!(body["error"]["details"]["service"], "asana");
    let after: i64 = sqlx::query_scalar(
        "select count(*) from workflow_integrations where type = 'asana' and deleted_at is null",
    )
    .fetch_one(&db)
    .await
    .expect("count");
    assert_eq!(after, before, "nothing written");

    // A custom integration has no company behind it: always created.
    let (status, custom) = create(&app, json!({ "name": "Our own API" })).await;
    assert_eq!(status, StatusCode::CREATED, "{custom}");
    forget(&db, &custom).await;

    // On: created.
    switch(&db, true).await;
    let (status, created) = create(&app, json!({ "name": "Asana", "type": "asana" })).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    forget(&db, &created).await;

    // Off again: refused again.
    switch(&db, false).await;
    let (status, _) = create(&app, json!({ "name": "Asana", "type": "asana" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
