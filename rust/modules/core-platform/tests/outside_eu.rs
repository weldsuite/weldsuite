//! `/api/outside-eu-services` through its router, with the permission gate
//! and the session and tenant layers a request carries in the server, and a
//! recording event bus; and the switch the backend's call paths read
//! (`weldsuite_outside_eu::require`), on the EU edition's enforcement.
//!
//! Its own test binary: it installs `Enforcement::Enforced` for the process.
//! A member is refused before any query. The rest runs on the real tenant
//! schema (built from the journaled migrations by `scripts/rust-test-db.ts`)
//! when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set,
//! and returns early otherwise. It only ever switches `discord` and
//! `gitlab`, and puts `workspace_settings` back as it found it
//! (`SettingsSnapshot`), so tests of other crates on the same database never
//! see its rows.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_core_platform::{AuditStreamGateway, AuditStreamTest, CorePlatformState};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_outside_eu::store::SettingsSnapshot;
use weldsuite_outside_eu::{Enforcement, ServiceId};
use weldsuite_permissions::ResolvedPermissions;
use weldsuite_permissions::{MemberRow, PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{BoxFuture, DynEventBus, RecordingEventBus};

const WORKSPACE: &str = "ws_outside_eu_test";

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

struct NoAudit;

impl AuditStreamGateway for NoAudit {
    fn check_url(&self, raw: &str) -> Result<String, String> {
        Ok(raw.to_owned())
    }

    fn send_test<'a>(
        &'a self,
        _test: AuditStreamTest<'a>,
    ) -> BoxFuture<'a, weldsuite_core_platform::AuditStreamTestResult> {
        unreachable!("not used here")
    }
}

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

/// The router as the server serves it for a caller with `permissions`.
fn harness(tenant: PgPool, master: PgPool, user: &str, permissions: &[&str]) -> Harness {
    Enforcement::Enforced.install();
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let state = CorePlatformState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        realtime: None,
        cache: None,
        master: master.clone(),
        identity: None,
        audit_streams: Arc::new(NoAudit),
        top_up: None,
        ai: None,
        mail: None,
        sso: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let user_id = user.to_owned();
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let app = weldsuite_core_platform::outside_eu(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            let auth = AuthContext {
                user_id: user_id.clone(),
                org_id: Some("org_test".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            };
            let tenant = Tenant {
                workspace_id: WORKSPACE.to_owned(),
                clerk_org_id: Some("org_test".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            };
            let permissions = Permissions::new(resolved.clone(), None, false, user_id.clone());
            request.extensions_mut().insert(auth);
            request.extensions_mut().insert(tenant);
            request.extensions_mut().insert(permissions);
            request
                .extensions_mut()
                .insert(weldsuite_db::MasterDb(master.clone()));
            next.run(request)
        },
    ));
    Harness { app, bus, tracker }
}

async fn call(app: &Router, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

fn pools() -> Option<(PgPool, PgPool)> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some((
        master_pool(&master_url, 2).expect("master pool"),
        master_pool(&tenant_url, 4).expect("tenant pool"),
    ))
}

fn service<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["data"]["services"]
        .as_array()
        .and_then(|services| services.iter().find(|s| s["id"] == id))
        .unwrap_or(&Value::Null)
}

#[tokio::test]
async fn a_member_cannot_switch_and_never_reaches_the_database() {
    let member = harness(lazy_pool(), lazy_pool(), "user_member", &["settings:read"]);
    for body in [
        json!({ "enabled": true, "acknowledgedOutsideEu": true }),
        json!({ "enabled": false }),
    ] {
        let (status, _) = call(&member.app, "PUT", "/discord", Some(body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    member.tracker.close();
    member.tracker.wait().await;
    assert_eq!(member.bus.messages().len(), 0);

    // An admin's bad body, or an unknown service, is refused before any query.
    let admin = harness(lazy_pool(), lazy_pool(), "user_admin", &["settings:manage"]);
    let (status, body) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "OUTSIDE_EU_NOT_ACKNOWLEDGED");
    let (status, _) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": "on" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &admin.app,
        "PUT",
        "/mistral",
        Some(json!({ "enabled": true, "acknowledgedOutsideEu": true })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[allow(
    clippy::too_many_lines,
    reason = "one switch's whole life, step by step"
)]
async fn an_admin_switches_a_service_on_and_off_and_the_backend_follows(
    master: PgPool,
    tenant: PgPool,
) {
    let admin = harness(
        tenant.clone(),
        master.clone(),
        "user_admin",
        &["settings:manage"],
    );
    let member = harness(
        tenant.clone(),
        master.clone(),
        "user_member",
        &["settings:read"],
    );
    // Start from off, whatever an earlier run left.
    let (status, _) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Every member reads the list; only an admin may manage.
    let (status, list) = call(&member.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["data"]["enforced"], true);
    assert_eq!(list["data"]["canManage"], false);
    assert_eq!(list["data"]["integrations"]["gmail"], "google");
    let discord = service(&list, "discord");
    assert_eq!(discord["enabled"], false);
    assert_eq!(discord["company"], "Discord Inc.");
    assert_eq!(discord["country"], "US");
    let (_, list) = call(&admin.app, "GET", "/", None).await;
    assert_eq!(list["data"]["canManage"], true);

    // Off: the backend refuses the service, and lets an EU one through.
    let refused = weldsuite_outside_eu::require(&tenant, ServiceId::Discord)
        .await
        .expect_err("off");
    assert_eq!(refused.service(), Some(ServiceId::Discord));
    assert!(
        weldsuite_outside_eu::require_integration(&tenant, "moneybird")
            .await
            .is_ok()
    );
    assert!(!weldsuite_outside_eu::allowed(&tenant, ServiceId::Discord, "test").await);

    // On, with the acknowledgement: recorded with who and when.
    let (status, on) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": true, "acknowledgedOutsideEu": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(on["data"]["enabled"], true);
    assert_eq!(on["data"]["enabledBy"], "user_admin");
    assert_eq!(on["data"]["via"], "admin");
    assert!(on["data"]["acknowledgedAt"].is_string());
    assert!(
        weldsuite_outside_eu::require(&tenant, ServiceId::Discord)
            .await
            .is_ok()
    );
    // Another service stays off.
    assert!(
        weldsuite_outside_eu::require(&tenant, ServiceId::GitLab)
            .await
            .is_err()
    );

    // On again changes nothing and records nothing new.
    let (status, again) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": true, "acknowledgedOutsideEu": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["data"]["enabledAt"], on["data"]["enabledAt"]);

    // Off: the calls stop at once.
    let (status, off) = call(
        &admin.app,
        "PUT",
        "/discord",
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(off["data"]["enabled"], false);
    assert_eq!(off["data"]["disabledBy"], "user_admin");
    assert!(
        weldsuite_outside_eu::require(&tenant, ServiceId::Discord)
            .await
            .is_err()
    );

    // The changes are in the audit trail as workspace_settings.updated.
    admin.tracker.close();
    admin.tracker.wait().await;
    let changes: Vec<String> = admin
        .bus
        .payloads()
        .iter()
        .map(Value::to_string)
        .filter(|m| m.contains("\"outsideEu\"") && m.contains("\"discord\""))
        .collect();
    assert!(
        changes.iter().any(|m| m.contains("\"change\":\"enabled\"")),
        "{changes:?}"
    );
    assert!(
        changes
            .iter()
            .any(|m| m.contains("\"change\":\"disabled\"")),
        "{changes:?}"
    );
}

async fn the_move_from_global_records_an_opt_in(tenant: PgPool) {
    let rows = || async {
        sqlx::query_scalar::<_, i64>(
            "select count(*) from workspace_settings where deleted_at is null",
        )
        .fetch_one(&tenant)
        .await
        .expect("count")
    };
    let rows_before = rows().await;
    let at = "2026-11-20T10:00:00.000Z";
    let change = |enabled| weldsuite_outside_eu::Change {
        service: ServiceId::GitLab,
        enabled,
        actor: "staff@weldsuite.org",
        via: weldsuite_outside_eu::Via::Move,
        acknowledged: false,
        reason: Some("connected on Global"),
        at,
    };
    weldsuite_outside_eu::store::set(&tenant, &change(true))
        .await
        .expect("set");
    // The one settings row: created when there was none, kept when there was.
    assert_eq!(rows().await, rows_before.max(1));
    let opt_ins = weldsuite_outside_eu::store::read(&tenant)
        .await
        .expect("read");
    let gitlab = &opt_ins[&ServiceId::GitLab];
    assert!(gitlab.enabled);
    assert_eq!(gitlab.via, Some(weldsuite_outside_eu::Via::Move));
    assert_eq!(gitlab.reason.as_deref(), Some("connected on Global"));
    assert_eq!(gitlab.acknowledged_at, None);
    assert!(
        weldsuite_outside_eu::require(&tenant, ServiceId::GitLab)
            .await
            .is_ok()
    );
    // Other keys of `features` survive a switch.
    sqlx::query(
        "update workspace_settings
         set features = coalesce(features, '{}'::jsonb) || '{\"multiCurrency\": true}'::jsonb
         where id = (select id from workspace_settings where deleted_at is null
                     order by created_at limit 1)",
    )
    .execute(&tenant)
    .await
    .expect("other feature");
    weldsuite_outside_eu::store::set(&tenant, &change(false))
        .await
        .expect("off");
    let multi: Option<bool> = sqlx::query_scalar(
        "select (features ->> 'multiCurrency')::boolean from workspace_settings
         where deleted_at is null order by created_at limit 1",
    )
    .fetch_one(&tenant)
    .await
    .expect("read back");
    assert_eq!(multi, Some(true));
    assert!(
        weldsuite_outside_eu::require(&tenant, ServiceId::GitLab)
            .await
            .is_err()
    );
}

/// Runs `body` on the shared test database, then puts `workspace_settings`
/// back as it was, even when `body` panics: CI runs every crate's database
/// tests on one database, and billing's reads the oldest settings row.
async fn on_shared_settings<F>(tenant: &PgPool, body: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let snapshot = SettingsSnapshot::take(tenant).await.expect("snapshot");
    let outcome = tokio::spawn(body).await;
    snapshot.restore(tenant).await.expect("restore");
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}

#[tokio::test]
async fn switches_on_the_tenant_database() {
    let Some((master, tenant)) = pools() else {
        return;
    };
    let (m, t) = (master.clone(), tenant.clone());
    on_shared_settings(&tenant, async move {
        an_admin_switches_a_service_on_and_off_and_the_backend_follows(m, t.clone()).await;
        the_move_from_global_records_an_opt_in(t).await;
    })
    .await;
}
