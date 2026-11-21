//! The commerce router as the server mounts it, with the permission gate and
//! the session, tenant, registry and permission layers a request carries
//! there, and an event bus that records what the routes publish.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_commerce::{CommerceState, StorefrontRegistry};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

pub(crate) const USER: &str = "user_channels_test";

pub(crate) const ALL: &[&str] = &[
    "products:read",
    "products:create",
    "products:update",
    "commerce_channels:read",
    "commerce_channels:create",
    "commerce_channels:update",
    "commerce_channels:delete",
];

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

pub(crate) struct TestApp {
    router: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
    /// The workspace the requests carry (`workspaces.id`).
    pub(crate) workspace: String,
}

/// The router over `db` for a member holding `permissions`, with the master
/// registry when given.
pub(crate) fn app_with(db: PgPool, master: Option<PgPool>, permissions: &[&str]) -> TestApp {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let state = CommerceState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        http: None,
        payments: weldsuite_commerce::PaymentsConfig::default(),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let workspace = fresh("ws_chan_");
    let workspace_id = workspace.clone();
    let router = weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_channels".to_owned()),
                session_id: "sess_channels".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: workspace_id.clone(),
                clerk_org_id: Some("org_channels".to_owned()),
                db: db.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            });
            request.extensions_mut().insert(Permissions::new(
                resolved.clone(),
                None,
                false,
                USER.to_owned(),
            ));
            if let Some(master) = &master {
                request
                    .extensions_mut()
                    .insert(StorefrontRegistry(master.clone()));
            }
            next.run(request)
        },
    ));
    TestApp {
        router,
        bus,
        tracker,
        workspace,
    }
}

pub(crate) fn app(db: PgPool, permissions: &[&str]) -> TestApp {
    app_with(db, None, permissions)
}

impl TestApp {
    pub(crate) async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        (status, json)
    }

    pub(crate) async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.call("GET", path, None).await
    }

    pub(crate) async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.call("POST", path, Some(body)).await
    }

    pub(crate) async fn patch(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.call("PATCH", path, Some(body)).await
    }

    pub(crate) async fn put(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.call("PUT", path, Some(body)).await
    }

    pub(crate) async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.call("DELETE", path, None).await
    }

    pub(crate) async fn events(&self) -> Vec<Value> {
        self.tracker.close();
        self.tracker.wait().await;
        self.bus.payloads()
    }

    pub(crate) async fn events_of(&self, event_type: &str, entity_id: &str) -> Vec<Value> {
        self.events()
            .await
            .into_iter()
            .filter(|e| e["eventType"] == event_type && e["entityId"] == entity_id)
            .collect()
    }

    /// A channel through the API; its id.
    pub(crate) async fn channel(&self, body: &Value) -> String {
        let (status, created) = self.post("/commerce-channels", body).await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        created["data"]["id"].as_str().expect("id").to_owned()
    }

    /// A live storefront channel selling to NL and DE, paying with Mollie.
    pub(crate) async fn storefront(&self) -> String {
        self.channel(&json!({
            "name": fresh("Shop "), "status": "active",
            "sellingCountries": ["NL", "DE"], "paymentMethods": ["mollie"],
        }))
        .await
    }
}

pub(crate) fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

/// The real tenant schema (`WELDSUITE_TEST_TENANT_URL`), or `None` to skip.
pub(crate) async fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    // One connection, as in production: a request never needs a second.
    Some(master_pool(&url, 1).expect("tenant pool"))
}

/// A pool of its own on the tenant database for a test's direct queries, so
/// holding one of its connections never takes the router's only one.
pub(crate) fn side() -> PgPool {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").expect("WELDSUITE_TEST_TENANT_URL");
    master_pool(&url, 2).expect("side pool")
}

/// The tenant database and the master one (`WELDSUITE_TEST_MASTER_URL`).
pub(crate) async fn both() -> Option<(PgPool, PgPool)> {
    let db = tenant().await?;
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return None;
    };
    Some((db, master_pool(&url, 4).expect("master pool")))
}

pub(crate) fn fresh(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{nanos:x}{n}")
}

/// The `data` of a 200.
pub(crate) async fn read(app: &TestApp, path: &str) -> Value {
    let (status, body) = app.get(path).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body["data"].clone()
}

pub(crate) fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("a list")
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// An active product priced `price` EUR; its id.
pub(crate) async fn product(app: &TestApp, price: &str) -> String {
    let (status, created) = app
        .post(
            "/products",
            &json!({
                "name": "Widget", "slug": fresh("w-"), "sku": fresh("W-"),
                "price": price, "currency": "EUR", "status": "active"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    created["data"]["id"].as_str().expect("id").to_owned()
}
