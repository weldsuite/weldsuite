//! Telnyx is outside the EU (ADR OPS-026): on the EU edition a WeldCall
//! route that calls Telnyx answers 403 `OUTSIDE_EU_SERVICE_OFF`, and calls
//! nothing, until the workspace switches Telnyx on.
//!
//! Its own test binary: it installs the EU edition's enforcement, which is
//! process-wide. Runs on the real tenant and master schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`) when
//! `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set, and
//! returns early otherwise. It only ever switches `telnyx`, and leaves it
//! off.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_call::CallState;
use weldsuite_db::{MasterDb, PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::RequestEnv;
use weldsuite_outside_eu::store::SettingsSnapshot;
use weldsuite_outside_eu::{Change, Enforcement, OFF_CODE, ServiceId, Via, store};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

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

/// Telnyx, answering every request with an empty list and keeping the URLs.
#[derive(Default)]
struct FakeTelnyx {
    urls: Mutex<Vec<String>>,
}

impl FakeTelnyx {
    fn urls(&self) -> Vec<String> {
        self.urls.lock().expect("lock").clone()
    }
}

impl DynOutboundHttp for FakeTelnyx {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        self.urls.lock().expect("lock").push(request.url);
        Box::pin(std::future::ready(Ok(HttpResponse::new(
            200,
            br#"{"data":[]}"#.to_vec(),
        ))))
    }
}

/// The router as the server serves it, for a member with `telephony:manage`.
fn app(tenant: PgPool, master: PgPool, telnyx: &Arc<FakeTelnyx>) -> Router {
    let http = OutboundHttp(Arc::clone(telnyx) as Arc<dyn DynOutboundHttp>);
    let state = CallState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        master: Some(master.clone()),
        http: Some(http.clone()),
        storage: None,
        realtime: None,
        tenants: None,
        cache: None,
        assignment: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: vec!["telephony:read".to_owned(), "telephony:manage".to_owned()],
        ..ResolvedPermissions::default()
    };
    let env = RequestEnv(Arc::new(HashMap::from([(
        "TELNYX_API_KEY".to_owned(),
        "KEY_test".to_owned(),
    )])));
    weldsuite_call::router::<(), _>(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            let extensions = request.extensions_mut();
            extensions.insert(AuthContext {
                user_id: "user_admin".to_owned(),
                org_id: Some("org_outside_eu".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            });
            extensions.insert(Tenant {
                workspace_id: "ws_outside_eu".to_owned(),
                clerk_org_id: Some("org_outside_eu".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            });
            extensions.insert(Permissions::new(
                resolved.clone(),
                None,
                false,
                "user_admin".to_owned(),
            ));
            extensions.insert(env.clone());
            extensions.insert(MasterDb(master.clone()));
            extensions.insert(http.clone());
            next.run(request)
        },
    ))
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

async fn switch(tenant: &PgPool, enabled: bool) {
    store::set(
        tenant,
        &Change {
            service: ServiceId::Telnyx,
            enabled,
            actor: "user_admin",
            via: Via::Admin,
            acknowledged: true,
            reason: None,
            at: "2026-11-20T10:00:00.000Z",
        },
    )
    .await
    .expect("switch telnyx");
}

fn pools() -> Option<(PgPool, PgPool)> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let master = master_pool(&master_url, 2).expect("master pool");
    let tenant = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_lazy(&tenant_url)
        .expect("tenant pool");
    Some((master, tenant))
}

/// CI runs every crate's database tests on one database: `workspace_settings`
/// goes back as it was after the test, even when it panics, so no other
/// crate's test (billing reads the oldest settings row) sees its row.
#[tokio::test]
async fn telnyx_is_called_only_once_the_workspace_switched_it_on() {
    let Some((master, tenant)) = pools() else {
        return;
    };
    let snapshot = SettingsSnapshot::take(&tenant).await.expect("snapshot");
    let outcome = tokio::spawn(telnyx_follows_the_switch(master, tenant.clone())).await;
    snapshot.restore(&tenant).await.expect("restore");
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}

async fn telnyx_follows_the_switch(master: PgPool, tenant: PgPool) {
    Enforcement::Enforced.install();
    assert!(weldsuite_outside_eu::enforced());
    switch(&tenant, false).await;
    let telnyx = Arc::new(FakeTelnyx::default());
    let app = app(tenant.clone(), master, &telnyx);
    let search = json!({ "country": "NL" });

    // Off: refused before anything reaches Telnyx, and the platform is told why.
    let (status, body) = call(
        &app,
        "POST",
        "/telephony/phone-numbers/search",
        Some(search.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], OFF_CODE);
    assert_eq!(body["error"]["details"]["service"], "telnyx");
    let (status, body) = call(&app, "GET", "/telephony/configured", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["data"],
        json!({ "configured": false, "outsideEuOff": true })
    );
    // A route that only reads WeldSuite's own rows still answers.
    let (status, body) = call(&app, "GET", "/telephony/pricing", None).await;
    assert_ne!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(telnyx.urls().is_empty(), "{:?}", telnyx.urls());

    // On: the same request goes out to Telnyx.
    switch(&tenant, true).await;
    let (status, body) = call(
        &app,
        "POST",
        "/telephony/phone-numbers/search",
        Some(search.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["numbers"], json!([]));
    let urls = telnyx.urls();
    assert_eq!(urls.len(), 1, "{urls:?}");
    assert!(urls[0].starts_with("https://api.telnyx.com/v2/available_phone_numbers?"));
    let (_, body) = call(&app, "GET", "/telephony/configured", None).await;
    assert_eq!(body["data"], json!({ "configured": true }));

    // Off again: the calls stop.
    switch(&tenant, false).await;
    let (status, _) = call(
        &app,
        "POST",
        "/telephony/phone-numbers/search",
        Some(search),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(telnyx.urls().len(), 1);
}
