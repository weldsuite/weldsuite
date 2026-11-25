//! The commerce router as the server mounts it, with the permission gate and
//! the session, tenant and permission layers a request carries there, and an
//! event bus that records what the routes publish.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::Value;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_commerce::CommerceState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

pub(crate) const USER: &str = "user_orders_test";

/// Every order-book permission (and the products to sell).
pub(crate) const ALL: &[&str] = &[
    "products:read",
    "products:create",
    "products:update",
    "orders:read",
    "orders:create",
    "orders:update",
    "discounts:read",
    "discounts:create",
    "discounts:update",
    "discounts:delete",
    "commerce_settings:read",
    "commerce_settings:update",
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
}

/// The router over `db`, for a member holding `permissions`.
pub(crate) fn app(db: PgPool, permissions: &[&str]) -> TestApp {
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
        online_store: weldsuite_commerce::online_store::OnlineStoreConfig::default(),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let router = weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_orders".to_owned()),
                session_id: "sess_orders".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: "ws_orders_test".to_owned(),
                clerk_org_id: Some("org_catalogue".to_owned()),
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
            next.run(request)
        },
    ));
    TestApp {
        router,
        bus,
        tracker,
    }
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

    pub(crate) async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.call("DELETE", path, None).await
    }

    /// The entity events published so far (`{ eventType, entityId, data, … }`),
    /// once every publish has run.
    pub(crate) async fn events(&self) -> Vec<Value> {
        self.tracker.close();
        self.tracker.wait().await;
        self.bus.payloads()
    }

    /// The events of `event_type` (`product:updated`) about `entity_id`.
    pub(crate) async fn events_of(&self, event_type: &str, entity_id: &str) -> Vec<Value> {
        self.events()
            .await
            .into_iter()
            .filter(|e| e["eventType"] == event_type && e["entityId"] == entity_id)
            .collect()
    }
}

/// A pool that never connects: the permission checks run before any query.
pub(crate) fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

/// The real tenant schema (`WELDSUITE_TEST_TENANT_URL`), or `None` to skip.
/// The database is shared: tests create rows with fresh ids, names and
/// codes, and assume nothing about what else is there.
///
/// Orders need a seller for VAT: the shared database gets one Dutch entity
/// registered for the One-Stop Shop, made `commerce_settings.default_entity_id`
/// (idempotent, so tests in parallel agree). A test that needs another
/// seller (none, outside the EU, no OSS) uses [`isolated`].
pub(crate) async fn tenant() -> Option<PgPool> {
    let url = tenant_url()?;
    let db = master_pool(&url, 1).expect("tenant pool");
    seller(&db).await;
    Some(db)
}

fn tenant_url() -> Option<String> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok();
    if url.is_none() {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
    }
    url
}

/// The shared seller of the tests.
pub(crate) const SELLER: &str = "ent_wc_test_nl";

async fn seller(db: &PgPool) {
    let mut tx = db.begin().await.expect("tx");
    sqlx::query("select pg_advisory_xact_lock(hashtext('weldcommerce:settings'))")
        .execute(&mut *tx)
        .await
        .expect("lock");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active)          values ($1, 'WeldCommerce test seller', 'NL', 'EUR', true)          on conflict (id) do update set deleted_at = null, is_active = true, jurisdiction_code = 'NL'",
    )
    .bind(SELLER)
    .execute(&mut *tx)
    .await
    .expect("entity");
    sqlx::query(
        "insert into legal_entity_registrations (id, entity_id, type, number)          values ('ler_wc_test_oss', $1, 'oss', 'NL123456789B01')          on conflict (id) do update set deleted_at = null, valid_from = null, valid_to = null",
    )
    .bind(SELLER)
    .execute(&mut *tx)
    .await
    .expect("oss");
    sqlx::query(
        "insert into commerce_settings (id) select 'cset_wc_test'          where not exists (select 1 from commerce_settings)",
    )
    .execute(&mut *tx)
    .await
    .expect("settings row");
    sqlx::query("update commerce_settings set default_entity_id = $1")
        .bind(SELLER)
        .execute(&mut *tx)
        .await
        .expect("default entity");
    tx.commit().await.expect("commit");
}

/// A tenant database of its own: a schema with an empty copy of every table,
/// for the tests that change the seller. Its pool uses only that schema, so
/// nothing of the shared database leaks in (a default entity of another
/// test, say). Dropped with [`Isolated::drop_schema`].
pub(crate) struct Isolated {
    pub(crate) db: PgPool,
    admin: PgPool,
    schema: String,
}

pub(crate) async fn isolated() -> Option<Isolated> {
    let url = tenant_url()?;
    let admin = master_pool(&url, 2).expect("admin pool");
    let schema = fresh("iso_");
    sqlx::query(sqlx::AssertSqlSafe(format!("create schema {schema}")))
        .execute(&admin)
        .await
        .expect("schema");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "do $$ declare t text; begin            for t in select tablename from pg_tables where schemaname = 'public' loop              execute format('create table {schema}.%I (like public.%I including all)', t, t);            end loop; end $$"
    )))
    .execute(&admin)
    .await
    .expect("copy tables");
    let path = format!("set search_path to {schema}");
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .after_connect(move |conn, _| {
            let path = path.clone();
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(path)).execute(conn).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .expect("isolated pool");
    Some(Isolated { db, admin, schema })
}

impl Isolated {
    /// An entity in `country`, made the workspace's default entity; its id.
    pub(crate) async fn seller(&self, country: &str, oss: bool) -> String {
        let id = fresh("ent_iso_");
        sqlx::query(
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active, is_default)              values ($1, 'Isolated seller', $2, 'EUR', true, true)",
        )
        .bind(&id)
        .bind(country)
        .execute(&self.db)
        .await
        .expect("entity");
        if oss {
            sqlx::query(
                "insert into legal_entity_registrations (id, entity_id, type, number)                  values ($1, $2, 'oss', 'NL123456789B01')",
            )
            .bind(fresh("ler_"))
            .bind(&id)
            .execute(&self.db)
            .await
            .expect("oss");
        }
        id
    }

    pub(crate) async fn drop_schema(self) {
        self.db.close().await;
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "drop schema {} cascade",
            self.schema
        )))
        .execute(&self.admin)
        .await;
    }
}

/// A VIES answer for `number`, as the cache holds it (fresh): the engine
/// reads it instead of asking VIES.
pub(crate) async fn vies(db: &PgPool, number: &str, valid: bool) {
    sqlx::query(
        "insert into vies_checks (id, vat_number, country_code, valid, checked_at)          values ($1, $2, left($2, 2), $3, now() at time zone 'utc')          on conflict (vat_number) do update set valid = excluded.valid,            checked_at = excluded.checked_at",
    )
    .bind(fresh("vies_"))
    .bind(number)
    .bind(valid)
    .execute(db)
    .await
    .expect("vies");
}

/// A German VAT number no other test uses.
pub(crate) fn german_vat() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("DE{:09}", n % 1_000_000_000)
}

/// A value no other test (or run) uses.
pub(crate) fn fresh(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{nanos:x}{n}")
}

/// A product through the API; its id.
pub(crate) async fn product(app: &TestApp, body: &Value) -> String {
    let (status, created) = app.post("/products", body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    created["data"]["id"].as_str().expect("id").to_owned()
}

/// The `data` of a 200.
pub(crate) async fn read(app: &TestApp, path: &str) -> Value {
    let (status, body) = app.get(path).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body["data"].clone()
}

/// The ids of a list.
pub(crate) fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("a list")
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// A CRM company straight in the tenant database; its id.
pub(crate) async fn company(db: &PgPool, name: &str) -> String {
    let id = fresh("comp_");
    sqlx::query("insert into companies (id, name, display_name, email) values ($1, $2, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(format!("{id}@corp.example"))
        .execute(db)
        .await
        .expect("company");
    id
}

/// A CRM person straight in the tenant database; its id.
pub(crate) async fn person(db: &PgPool, name: &str, email: &str) -> String {
    let id = fresh("pers_");
    sqlx::query("insert into people (id, display_name, email) values ($1, $2, $3)")
        .bind(&id)
        .bind(name)
        .bind(email)
        .execute(db)
        .await
        .expect("person");
    id
}

/// An active product priced `price`; its id.
pub(crate) async fn priced(app: &TestApp, price: &str) -> String {
    product(
        app,
        &serde_json::json!({
            "name": "Widget", "slug": fresh("w-"), "sku": fresh("W-"),
            "price": price, "currency": "EUR", "status": "active"
        }),
    )
    .await
}

/// A discount through the API; its id.
pub(crate) async fn discount(app: &TestApp, body: &Value) -> String {
    let (status, created) = app.post("/discounts", body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    created["data"]["id"].as_str().expect("id").to_owned()
}
