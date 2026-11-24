//! The commerce router as the server mounts it, with the session, tenant,
//! registry and permission layers, over the real master and tenant schemas;
//! the renderer's routes, the edge and the storefront API over the same
//! databases and one shared cache.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{HeaderMap, Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_commerce::online_store::OnlineStoreConfig;
use weldsuite_commerce::{CommerceState, StorefrontRegistry};
use weldsuite_db::{
    Keyring, PgPool, Tenant, WorkspaceConfig, WorkspaceRestrictions, Workspaces, master_pool,
};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynCache, DynEventBus, MemoryCache, RecordingEventBus};

pub(crate) const WORKSPACE: &str = "ws_online_store_test";
pub(crate) const USER: &str = "user_online_store_test";
pub(crate) const SECRET: &str = "renderer-secret-for-tests";

pub(crate) const ALL: &[&str] = &[
    "commerce_channels:read",
    "commerce_channels:create",
    "commerce_channels:update",
    "websites:read",
    "websites:create",
    "websites:update",
    "websites:delete",
    "websites:manage",
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

pub(crate) fn fresh(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{nanos:x}{n}")
}

/// The databases, the workspace row pointing at the tenant, and one cache.
pub(crate) struct Env {
    pub(crate) master: PgPool,
    pub(crate) tenant: PgPool,
    pub(crate) workspaces: Arc<Workspaces>,
    pub(crate) cache: Arc<dyn DynCache>,
    /// The free-address domain of this run (host names are unique across
    /// runs in the shared master database).
    pub(crate) base: String,
}

pub(crate) async fn env() -> Option<Env> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let master = master_pool(&master_url, 4).expect("master pool");
    let tenant = master_pool(&tenant_url, 2).expect("tenant pool");
    // The tests start together: on a fresh database several insert this row
    // at once. `on conflict do nothing` without a target covers every unique
    // index (the id and the org id) and waits out a concurrent insert; a
    // targeted `on conflict (id)` let the org id's index fail the loser.
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id, database_url) \
         values ($1, 'Online store tests', 'online-store-tests', 'org_os_test', $2) \
         on conflict do nothing",
    )
    .bind(WORKSPACE)
    .bind(&tenant_url)
    .execute(&master)
    .await
    .expect("workspace");
    sqlx::query("update workspaces set database_url = $2 where id = $1")
        .bind(WORKSPACE)
        .bind(&tenant_url)
        .execute(&master)
        .await
        .expect("workspace database");
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig {
            tenant_max_connections: 2,
            ..WorkspaceConfig::default()
        },
    ));
    Some(Env {
        master,
        tenant,
        workspaces,
        cache: Arc::new(MemoryCache::default()),
        base: format!("{}.shop.test", fresh("r")),
    })
}

impl Env {
    pub(crate) fn config(&self) -> OnlineStoreConfig {
        OnlineStoreConfig {
            base_domain: Some(self.base.clone()),
            scheme: "https".to_owned(),
            secret: Some(SECRET.to_owned()),
            cache: Some(Arc::clone(&self.cache)),
            ..OnlineStoreConfig::default()
        }
    }

    /// The staff routes for a member holding `permissions`.
    pub(crate) fn staff(&self, permissions: &[&str]) -> Staff {
        let bus = Arc::new(RecordingEventBus::new());
        let tracker = TaskTracker::new();
        let state = CommerceState {
            mail: None,
            events: EntityEventPublisher::new(
                Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
                tracker.clone(),
            ),
            http: None,
            payments: weldsuite_commerce::PaymentsConfig::default(),
            online_store: self.config(),
        };
        Staff {
            router: staff_router(
                state,
                Some(self.tenant.clone()),
                Some(self.master.clone()),
                permissions,
            ),
            bus,
            tracker,
        }
    }
}

/// The commerce router with the layers a request carries in the server.
pub(crate) fn staff_router(
    state: CommerceState,
    db: Option<PgPool>,
    master: Option<PgPool>,
    permissions: &[&str],
) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let db = db.unwrap_or_else(|| {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .expect("lazy pool")
    });
    weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_os_test".to_owned()),
                session_id: "sess_os".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: WORKSPACE.to_owned(),
                clerk_org_id: Some("org_os_test".to_owned()),
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
    ))
}

pub(crate) struct Staff {
    router: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

/// A response: status, headers, and the body as JSON (or a string).
pub(crate) struct Reply {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Value,
}

pub(crate) async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    Reply {
        status,
        headers,
        body,
    }
}

impl Staff {
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
        let reply = send(&self.router, request.body(body).expect("request")).await;
        (reply.status, reply.body)
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

    /// A live native storefront channel; its id.
    pub(crate) async fn channel(&self) -> String {
        let (status, created) = self
            .post(
                "/commerce-channels",
                &json!({ "name": fresh("Shop "), "status": "active", "sellingCountries": ["NL"], "paymentMethods": ["mollie"] }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        created["data"]["id"].as_str().expect("id").to_owned()
    }

    /// An online store on a new channel; (site id, channel id).
    pub(crate) async fn site(&self) -> (String, String) {
        let channel = self.channel().await;
        let (status, site) = self
            .post(
                "/online-store/sites",
                &json!({ "channelId": channel, "locale": "nl" }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{site}");
        (site["data"]["id"].as_str().expect("id").to_owned(), channel)
    }

    /// The site's free address; its host name.
    pub(crate) async fn free_address(&self, site: &str) -> String {
        let label = fresh("s");
        let (status, host) = self
            .post(
                "/storefront-hosts",
                &json!({ "siteId": site, "subdomain": label }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{host}");
        host["data"]["hostname"]
            .as_str()
            .expect("hostname")
            .to_owned()
    }
}
