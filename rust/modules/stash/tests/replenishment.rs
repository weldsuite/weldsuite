//! WeldStash replenishment through the stash router
//! (`weldsuite-documentation/plans/weldstash-replenishment.md`, phases 2 to
//! 4): settings, plans, rules, runs, draft purchase orders from plans,
//! incoming stock and the CSV sales history import. The router runs with
//! the permission gate, the session and tenant layers a request carries in
//! the server, the replenishment services (in-process jobs; the master
//! database when `WELDSUITE_TEST_MASTER_URL` is set) and a recording event
//! bus.
//!
//! The permission checks run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set and returns early
//! otherwise. The database is shared: every row is created with fresh ids
//! and nothing is truncated. The settings row is the workspace's one and a
//! run plans (and prunes) every plan, so the database tests take [`ONE`]
//! and assert only on their own rows.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_notifications::Notifier;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, DynJobs, InProcessJobs, JobRegistry, RecordingEventBus};
use weldsuite_stash::StashState;
use weldsuite_stash::replenishment::{ReplenishmentRunJob, SWEEP_KIND, Services, next_run_at};

const USER: &str = "user_repl_test";

const ALL: &[&str] = &[
    "inventory:read",
    "inventory:update",
    "inventory:manage",
    "purchase_orders:read",
    "purchase_orders:create",
];

/// One database test at a time: they share the settings row and the plans.
static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

fn harness(db: PgPool, permissions: &[&str]) -> Harness {
    harness_in(db, permissions, None, "ws_repl_test")
}

/// The router for `workspace` (its `workspaces.id`), with the master
/// database when given.
fn harness_in(
    db: PgPool,
    permissions: &[&str],
    master: Option<PgPool>,
    workspace: &str,
) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let events = EntityEventPublisher::new(
        Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
        tracker.clone(),
    );
    let state = StashState {
        events: events.clone(),
        http: None,
    };
    let registry = JobRegistry::new();
    let pool = db.clone();
    registry.register(ReplenishmentRunJob {
        tenants: Arc::new(move |_| {
            let pool = pool.clone();
            Box::pin(async move { Ok(pool) })
        }),
        events,
        notifier: Notifier::default(),
    });
    let jobs: Arc<dyn DynJobs> = Arc::new(InProcessJobs::new(registry, tracker.clone()));
    let services = Services {
        master,
        jobs: Some(jobs),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let workspace = workspace.to_owned();
    let app = weldsuite_stash::router(state, &gate)
        .layer(axum::Extension(services))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_repl".to_owned()),
                    session_id: "sess_repl".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: workspace.clone(),
                    clerk_org_id: Some("org_repl".to_owned()),
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
    Harness { app, bus, tracker }
}

impl Harness {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        let body = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// The events published (and jobs run) since the last call, as
    /// `(type:action, data)`, in publishing order.
    async fn events(&self) -> Vec<(String, Value)> {
        self.tracker.close();
        self.tracker.wait().await;
        self.tracker.reopen();
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                (
                    format!(
                        "{}:{}",
                        payload["entityType"].as_str().unwrap_or_default(),
                        payload["action"].as_str().unwrap_or_default()
                    ),
                    payload["data"].clone(),
                )
            })
            .collect();
        self.bus.clear();
        events
    }

    async fn actions(&self) -> Vec<String> {
        self.events()
            .await
            .into_iter()
            .map(|(action, _)| action)
            .collect()
    }
}

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 4).expect("tenant pool"))
}

fn master() -> Option<PgPool> {
    std::env::var("WELDSUITE_TEST_MASTER_URL")
        .ok()
        .map(|url| master_pool(&url, 2).expect("master pool"))
}

fn message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or_default()
}

fn day(offset: i64) -> String {
    let date = OffsetDateTime::now_utc().date() + Duration::days(offset);
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// Whether the master due index has this workspace's row.
async fn is_due(master: &PgPool, workspace: &str) -> bool {
    sqlx::query_scalar(
        "select exists(select 1 from workspace_due_index where kind = $1 and workspace_id = $2)",
    )
    .bind(SWEEP_KIND)
    .bind(workspace)
    .fetch_one(master)
    .await
    .expect("due index")
}

/// When the master due index has this workspace due.
async fn due_at(master: &PgPool, workspace: &str) -> Option<OffsetDateTime> {
    let at: Option<String> = sqlx::query_scalar(
        "select to_char(next_due_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') \
         from workspace_due_index where kind = $1 and workspace_id = $2",
    )
    .bind(SWEEP_KIND)
    .bind(workspace)
    .fetch_optional(master)
    .await
    .expect("due index");
    at.and_then(|at| OffsetDateTime::parse(&at, &Rfc3339).ok())
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/// Rows with fresh ids: `<key>_<tag>`.
struct Fx {
    db: PgPool,
    tag: String,
}

impl Fx {
    fn new(db: &PgPool) -> Self {
        Self {
            db: db.clone(),
            tag: weldsuite_kit::generate_id(""),
        }
    }

    fn id(&self, key: &str) -> String {
        format!("{key}_{}", self.tag)
    }

    /// `sql` with one JSON parameter, `$1`.
    async fn exec(&self, sql: &'static str, values: Value) {
        sqlx::query(sql)
            .bind(values)
            .execute(&self.db)
            .await
            .expect(sql);
    }

    async fn product(&self, key: &str, name: &str) -> String {
        let id = self.id(key);
        self.exec(
            "insert into products (id, name, slug, sku, cost_price, created_at) \
             values ($1->>0, $1->>1, $1->>0, $1->>0, 1.25, now() - interval '200 days')",
            json!([id, name]),
        )
        .await;
        id
    }

    async fn variant(&self, key: &str, product: &str) -> String {
        let id = self.id(key);
        self.exec(
            "insert into product_variants (id, product_id, name, sku) values ($1->>0, $1->>1, 'Red', $1->>0)",
            json!([id, product]),
        )
        .await;
        id
    }

    async fn warehouse(&self, key: &str) -> String {
        let id = self.id(key);
        self.exec(
            "insert into warehouses (id, name, code) values ($1->>0, $1->>1, $1->>2)",
            json!([id, format!("Warehouse {key}"), format!("C-{id}")]),
        )
        .await;
        id
    }

    async fn supplier(&self, key: &str, currency: &str, lead: i64) -> String {
        let id = self.id(key);
        self.exec(
            "insert into suppliers (id, name, currency, default_lead_time_days) \
             values ($1->>0, $1->>1, $1->>2, ($1->>3)::int)",
            json!([id, format!("Supplier {key}"), currency, lead]),
        )
        .await;
        id
    }

    /// A preferred link at 2.50 a unit.
    async fn link(
        &self,
        key: &str,
        product: &str,
        supplier: &str,
        moq: Option<i64>,
        pack: i64,
    ) -> String {
        let id = self.id(key);
        self.exec(
            "insert into product_suppliers (id, product_id, supplier_id, supplier_sku, \
             supplier_product_name, unit_cost, currency, min_order_qty, order_multiple, is_preferred) \
             values ($1->>0, $1->>1, $1->>2, $1->>3, $1->>4, 2.50, null, ($1->>5)::int, ($1->>6)::int, true)",
            json!([id, product, supplier, format!("SUP-{key}"), format!("Supplier {key}"), moq, pack]),
        )
        .await;
        id
    }

    /// A plan row as a run writes it.
    async fn plan(&self, key: &str, product: &str, warehouse: &str, values: Value) -> String {
        let id = self.id(key);
        let row = json!({
            "id": id,
            "item_key": format!("{product}||{warehouse}"),
            "product_id": product,
            "warehouse_id": warehouse,
            "run_id": "prun_test",
            "method": "level",
        });
        let mut row = row.as_object().cloned().unwrap_or_default();
        if let Value::Object(more) = values {
            row.extend(more);
        }
        self.exec(
            "insert into stash_item_plans (id, item_key, product_id, warehouse_id, run_id, method, \
             confidence, suggested_qty, review_status, stockout_date, on_hand, allocated, \
             lead_time_days, review_period_days, supplier_id, product_supplier_id, purchase_order_id) \
             select r.id, r.item_key, r.product_id, r.warehouse_id, r.run_id, r.method, \
             coalesce(r.confidence, 'ok'), coalesce(r.suggested_qty, 0), coalesce(r.review_status, 'none'), \
             r.stockout_date, coalesce(r.on_hand, 0), coalesce(r.allocated, 0), r.lead_time_days, \
             r.review_period_days, r.supplier_id, r.product_supplier_id, r.purchase_order_id \
             from jsonb_populate_record(null::stash_item_plans, $1) r",
            Value::Object(row),
        )
        .await;
        id
    }
}

// ── Without a database ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_routes_check_their_permission_first() {
    let reader = harness(lazy_pool(), &["inventory:read"]);
    for (method, path, body) in [
        ("PATCH", "/replenishment/settings", Some(json!({}))),
        ("PUT", "/replenishment/rules", Some(json!({}))),
        ("DELETE", "/replenishment/rules/rrule_x", None),
        ("POST", "/replenishment/runs", None),
        ("POST", "/replenishment/plans/iplan_x/dismiss", None),
        ("POST", "/replenishment/plans/iplan_x/restore", None),
        ("POST", "/replenishment/purchase-orders", Some(json!({}))),
        ("POST", "/replenishment/imports", Some(json!({}))),
        (
            "POST",
            "/replenishment/imports/shimp_x/rows",
            Some(json!({})),
        ),
        ("POST", "/replenishment/imports/shimp_x/complete", None),
        ("DELETE", "/replenishment/imports/shimp_x", None),
    ] {
        let (status, _) = reader.call(method, path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    let nobody = harness(lazy_pool(), &[]);
    for path in [
        "/replenishment/settings",
        "/replenishment/plans",
        "/replenishment/plans/iplan_x",
        "/replenishment/plans/iplan_x/demand",
        "/replenishment/rules",
        "/replenishment/runs",
        "/replenishment/incoming",
        "/replenishment/imports",
        "/replenishment/imports/shimp_x",
    ] {
        let (status, _) = nobody.call("GET", path, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "GET {path}");
    }
    assert_eq!(reader.actions().await, Vec::<String>::new());

    // A bad body is refused before any query.
    let writer = harness(lazy_pool(), ALL);
    for (method, path, body) in [
        (
            "PATCH",
            "/replenishment/settings",
            json!({ "defaultServiceLevel": 2 }),
        ),
        (
            "PATCH",
            "/replenishment/settings",
            json!({ "historyCutoverDate": "2026-02-30" }),
        ),
        (
            "PATCH",
            "/replenishment/settings",
            json!({ "runHourUtc": 24 }),
        ),
        (
            "PUT",
            "/replenishment/rules",
            json!({ "productId": "p", "warehouseId": "w", "method": "min_max", "minQty": 9, "maxQty": 3 }),
        ),
        (
            "PUT",
            "/replenishment/rules",
            json!({ "productId": "p", "warehouseId": "w", "method": "sometimes" }),
        ),
        (
            "POST",
            "/replenishment/purchase-orders",
            json!({ "planIds": [] }),
        ),
        (
            "POST",
            "/replenishment/purchase-orders",
            json!({ "planIds": ["a"], "quantities": { "a": 0 } }),
        ),
        ("POST", "/replenishment/imports", json!({ "fileName": "" })),
        (
            "POST",
            "/replenishment/imports/shimp_x/rows",
            json!({ "rows": [] }),
        ),
        (
            "POST",
            "/replenishment/imports/shimp_x/rows",
            json!({ "rows": [{ "date": "5 January", "sku": "A", "quantity": 1 }] }),
        ),
        (
            "POST",
            "/replenishment/plans/iplan_x/dismiss",
            json!({ "until": "someday" }),
        ),
    ] {
        let (status, body) = writer.call(method, path, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}: {body}");
    }
    let (status, body) = writer
        .call("GET", "/replenishment/plans?urgency=soon", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

// ── Settings ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn settings_are_saved_validated_and_mark_the_workspace_due() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let workspace = fx.id("ws");
    let master = master();
    let app = harness_in(db.clone(), ALL, master.clone(), &workspace);
    let warehouse = fx.warehouse("w").await;

    let (status, body) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({
                "replenishmentEnabled": false,
                "defaultServiceLevel": 0.975,
                "lookbackDays": 120,
                "runHourUtc": 4,
                "demandWarehouseId": warehouse,
                "historyCutoverDate": "2026-03-01",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let settings = &body["data"];
    assert_eq!(settings["id"], "default");
    assert_eq!(settings["replenishmentEnabled"], false);
    assert_eq!(settings["defaultServiceLevel"], "0.975");
    assert_eq!(settings["lookbackDays"], 120);
    assert_eq!(settings["runHourUtc"], 4);
    assert_eq!(settings["demandWarehouseId"], json!(warehouse));
    assert_eq!(settings["historyCutoverDate"], "2026-03-01");
    let events = app.events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "replenishment_settings:updated");
    assert_eq!(
        events[0].1["changes"],
        json!([
            "replenishmentEnabled",
            "defaultServiceLevel",
            "lookbackDays",
            "demandWarehouseId",
            "historyCutoverDate",
            "runHourUtc"
        ])
    );
    if let Some(master) = &master {
        assert!(!is_due(master, &workspace).await, "off: not due");
    }

    // A partial change keeps the rest; null clears.
    let (status, body) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({ "replenishmentEnabled": true, "historyCutoverDate": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["replenishmentEnabled"], true);
    assert_eq!(body["data"]["historyCutoverDate"], Value::Null);
    assert_eq!(body["data"]["lookbackDays"], 120);
    if let Some(master) = &master {
        assert!(is_due(master, &workspace).await, "turned on: due");
    }
    let (status, body) = app.call("GET", "/replenishment/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["replenishmentEnabled"], true);
    assert_eq!(body["data"]["demandWarehouseId"], json!(warehouse));

    let (status, body) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({ "demandWarehouseId": "wh_missing" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // Back to the defaults the other tests expect.
    let (status, _) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({
                "demandWarehouseId": null,
                "lookbackDays": 365,
                "defaultServiceLevel": 0.95,
                "runHourUtc": 2,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    app.events().await;
}

#[tokio::test]
async fn moving_the_run_hour_moves_the_due_time() {
    let Some(db) = tenant() else { return };
    let Some(master) = master() else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let workspace = fx.id("ws");
    let app = harness_in(db.clone(), ALL, Some(master.clone()), &workspace);
    let now = OffsetDateTime::now_utc();
    let (old_hour, new_hour) = (
        (i64::from(now.hour()) + 2) % 24,
        (i64::from(now.hour()) + 4) % 24,
    );
    let (status, _) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({ "replenishmentEnabled": true, "runHourUtc": old_hour })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // As the sweep leaves it after a run: due at the next run hour.
    sqlx::query(
        "insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version) \
         values ($1, $2, $3::timestamptz, now(), 1) \
         on conflict (kind, workspace_id) do update set next_due_at = excluded.next_due_at",
    )
    .bind(SWEEP_KIND)
    .bind(&workspace)
    .bind(next_run_at(now, old_hour).format(&Rfc3339).expect("time"))
    .execute(&master)
    .await
    .expect("due at the old hour");
    let hour = |hour: i64| {
        app.call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({ "runHourUtc": hour })),
        )
    };

    // Later: the old, earlier time kept, the sweep would run at both hours
    // that day.
    let (status, _) = hour(new_hour).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        due_at(&master, &workspace).await,
        Some(next_run_at(now, new_hour)),
        "a later hour replaces the earlier time"
    );
    // And earlier.
    let (status, _) = hour(old_hour).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        due_at(&master, &workspace).await,
        Some(next_run_at(now, old_hour))
    );

    // Back to the default the other tests expect.
    let (status, _) = hour(2).await;
    assert_eq!(status, StatusCode::OK);
    app.events().await;
    sqlx::query("delete from workspace_due_index where kind = $1 and workspace_id = $2")
        .bind(SWEEP_KIND)
        .bind(&workspace)
        .execute(&master)
        .await
        .expect("cleanup");
}

// ── Rules ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rules_are_upserted_listed_and_deleted() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    let product = fx.product("p", "Rule product").await;
    let variant = fx.variant("v", &product).await;
    let warehouse = fx.warehouse("w").await;
    let supplier = fx.supplier("s", "EUR", 5).await;
    let link = fx.link("ps", &product, &supplier, None, 1).await;

    let rule = json!({
        "productId": product,
        "variantId": variant,
        "warehouseId": warehouse,
        "method": "min_max",
        "minQty": 5,
        "maxQty": 20,
        "serviceLevel": 0.9,
        "productSupplierId": link,
    });
    let (status, body) = app
        .call("PUT", "/replenishment/rules", Some(rule.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created = body["data"].clone();
    assert_eq!(
        created["itemKey"],
        json!(format!("{product}|{variant}|{warehouse}"))
    );
    assert_eq!(created["method"], "min_max");
    assert_eq!(created["serviceLevel"], "0.900");
    assert_eq!(created["productSupplierId"], json!(link));
    let id = created["id"].as_str().expect("id").to_owned();

    let mut changed = rule.clone();
    changed["method"] = json!("off");
    changed["minQty"] = Value::Null;
    changed["maxQty"] = Value::Null;
    let (status, body) = app.call("PUT", "/replenishment/rules", Some(changed)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["id"], json!(id), "the same rule");
    assert_eq!(body["data"]["method"], "off");
    assert_eq!(body["data"]["minQty"], Value::Null);
    assert_eq!(
        app.actions().await,
        vec!["reorder_rule:created", "reorder_rule:updated"]
    );

    for (missing, resource) in [
        (json!({ "productId": "prod_missing" }), "Product"),
        (json!({ "variantId": "var_missing" }), "Product variant"),
        (json!({ "warehouseId": "wh_missing" }), "Warehouse"),
        (
            json!({ "productSupplierId": "psup_missing" }),
            "Product supplier",
        ),
    ] {
        let mut body = rule.clone();
        if let (Some(body), Value::Object(missing)) = (body.as_object_mut(), missing) {
            body.extend(missing);
        }
        let (status, answer) = app.call("PUT", "/replenishment/rules", Some(body)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{answer}");
        assert!(
            message(&answer).starts_with(&format!("{resource} with ID")),
            "{answer}"
        );
    }

    let path = format!("/replenishment/rules?productId={product}&variantId={variant}");
    let (status, body) = app.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().map(Vec::len), Some(1));
    let path = format!("/replenishment/rules?productId={product}&variantId=none");
    let (_, body) = app.call("GET", &path, None).await;
    assert_eq!(body["data"], json!([]));

    let (status, _) = app
        .call("DELETE", &format!("/replenishment/rules/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app
        .call("DELETE", &format!("/replenishment/rules/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let events = app.events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "reorder_rule:deleted");
    assert_eq!(events[0].1["id"], json!(id));
}

// ── Plans ───────────────────────────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines)] // the list, its filters, a plan, review
async fn plans_are_listed_filtered_paged_and_reviewed() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    let warehouse = fx.warehouse("w").await;
    let alpha = fx.product("a", &format!("Alpha {}", fx.tag)).await;
    let beta = fx.product("b", &format!("Beta {}", fx.tag)).await;
    let gamma = fx.product("c", &format!("Gamma {}", fx.tag)).await;
    let supplier = fx.supplier("s", "EUR", 14).await;
    let link = fx.link("ps", &alpha, &supplier, Some(10), 5).await;
    let a = fx
        .plan(
            "pa",
            &alpha,
            &warehouse,
            json!({ "suggested_qty": 10, "review_status": "open", "stockout_date": day(3),
                    "lead_time_days": 14, "review_period_days": 7, "supplier_id": supplier,
                    "product_supplier_id": link }),
        )
        .await;
    let b = fx
        .plan(
            "pb",
            &beta,
            &warehouse,
            json!({ "suggested_qty": 5, "review_status": "open", "stockout_date": day(20),
                    "lead_time_days": 14, "review_period_days": 7, "on_hand": 8,
                    "confidence": "low" }),
        )
        .await;
    let c = fx
        .plan(
            "pc",
            &gamma,
            &warehouse,
            json!({ "on_hand": 30, "confidence": "none" }),
        )
        .await;
    sqlx::query(
        "insert into stash_reorder_rules (id, item_key, product_id, warehouse_id, method) \
         values ($1, $2, $3, $4, 'auto')",
    )
    .bind(fx.id("rule"))
    .bind(format!("{alpha}||{warehouse}"))
    .bind(&alpha)
    .bind(&warehouse)
    .execute(&db)
    .await
    .expect("rule");

    let ids = |body: &Value| -> Vec<String> {
        body["data"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let list = |query: &str| format!("/replenishment/plans?warehouseId={warehouse}&{query}");

    let (status, body) = app.call("GET", &list(""), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(ids(&body), vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(body["pagination"]["totalCount"], 3);
    let first = &body["data"][0];
    assert_eq!(first["productName"], json!(format!("Alpha {}", fx.tag)));
    assert_eq!(first["warehouseName"], "Warehouse w");
    assert_eq!(first["supplierName"], "Supplier s");
    assert_eq!(
        first["currency"], "EUR",
        "the supplier's, the link has none"
    );
    assert_eq!(first["unitCost"], "2.5000");
    assert_eq!(first["minOrderQty"], 10);
    assert_eq!(first["orderMultiple"], 5);
    assert_eq!(first["stockoutDate"], json!(day(3)));
    assert_eq!(
        body["data"][1]["unitCost"], "1.25",
        "the product's cost price"
    );

    for (query, expected) in [
        ("needsReorder=true", vec![&a, &b]),
        ("urgency=out_of_stock", vec![&a]),
        ("urgency=lead_time", vec![&a]),
        ("urgency=review", vec![&a, &b]),
        ("confidence=low", vec![&b]),
        ("status=none", vec![&c]),
        ("search=ALPHA", vec![&a]),
        (&format!("supplierId={supplier}"), vec![&a]),
    ] {
        let (status, body) = app.call("GET", &list(query), None).await;
        assert_eq!(status, StatusCode::OK, "{query}: {body}");
        let expected: Vec<String> = expected.into_iter().cloned().collect();
        assert_eq!(ids(&body), expected, "{query}");
    }

    // One a page, following the cursor.
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..3 {
        let query = match &cursor {
            Some(cursor) => format!("limit=1&cursor={cursor}"),
            None => "limit=1".to_owned(),
        };
        let (_, body) = app.call("GET", &list(&query), None).await;
        seen.extend(ids(&body));
        cursor = body["pagination"]["cursor"].as_str().map(str::to_owned);
        assert_eq!(body["pagination"]["hasMore"], json!(cursor.is_some()));
    }
    assert_eq!(seen, vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(cursor, None);

    let (status, body) = app
        .call("GET", &format!("/replenishment/plans/{a}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["plan"]["id"], json!(a));
    assert_eq!(body["data"]["rule"]["method"], "auto");
    assert_eq!(body["data"]["productSupplier"]["id"], json!(link));
    assert_eq!(
        body["data"]["productSupplier"]["supplierName"],
        "Supplier s"
    );
    let (_, body) = app
        .call("GET", &format!("/replenishment/plans/{b}"), None)
        .await;
    assert_eq!(body["data"]["rule"], Value::Null);
    assert_eq!(body["data"]["productSupplier"], Value::Null);
    let (status, _) = app
        .call("GET", "/replenishment/plans/iplan_missing", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The demand chart: a year of weeks back, thirteen ahead.
    for days_ago in 1..=60 {
        sqlx::query(
            "insert into stash_sales_history (id, date, product_id, warehouse_id, quantity, source) \
             values ($1, current_date - $2::int, $3, $4, 2, 'odoo')",
        )
        .bind(fx.id(&format!("h{days_ago}")))
        .bind(days_ago)
        .bind(&alpha)
        .bind(&warehouse)
        .execute(&db)
        .await
        .expect("history");
    }
    let (status, body) = app
        .call("GET", &format!("/replenishment/plans/{a}/demand"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let history = body["data"]["history"].as_array().expect("history");
    assert_eq!(history.len(), 52);
    let sold: i64 = history
        .iter()
        .map(|week| week["quantity"].as_i64().unwrap_or(0))
        .sum();
    assert_eq!(sold, 120);
    let forecast = body["data"]["forecast"].as_array().expect("forecast");
    assert_eq!(forecast.len(), 13);
    assert!(
        forecast[1]["quantity"].as_f64().unwrap_or(0.0) > 0.0,
        "{body}"
    );
    let (status, _) = app
        .call("GET", "/replenishment/plans/iplan_missing/demand", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Dismiss and restore.
    let (status, body) = app
        .call(
            "POST",
            &format!("/replenishment/plans/{a}/dismiss"),
            Some(json!({ "until": "2030-01-01T00:00:00.000Z" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["reviewStatus"], "dismissed");
    assert_eq!(body["data"]["dismissedUntil"], "2030-01-01T00:00:00.000Z");
    assert_eq!(body["data"]["dismissedBy"], USER);
    assert_eq!(body["data"]["dismissedQty"], 10);
    let (_, body) = app
        .call("POST", &format!("/replenishment/plans/{b}/dismiss"), None)
        .await;
    assert_eq!(
        body["data"]["reviewStatus"], "dismissed",
        "a week by default"
    );
    let (status, body) = app
        .call("POST", &format!("/replenishment/plans/{a}/restore"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["reviewStatus"], "open");
    assert_eq!(body["data"]["dismissedUntil"], Value::Null);
    let (_, body) = app
        .call("POST", &format!("/replenishment/plans/{c}/restore"), None)
        .await;
    assert_eq!(body["data"]["reviewStatus"], "none", "nothing to order");
    sqlx::query("update stash_item_plans set review_status = 'ordered' where id = $1")
        .bind(&b)
        .execute(&db)
        .await
        .expect("ordered");
    for action in ["dismiss", "restore"] {
        let (status, body) = app
            .call("POST", &format!("/replenishment/plans/{b}/{action}"), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(message(&body), "This plan is already on a purchase order");
    }
    let (status, _) = app
        .call("POST", "/replenishment/plans/iplan_missing/dismiss", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.actions().await,
        Vec::<String>::new(),
        "review publishes nothing"
    );
}

// ── Purchase orders from plans ──────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines, clippy::many_single_char_names)] // grouping, lines, totals, skips; plans a to g
async fn purchase_orders_are_drafted_per_supplier_and_warehouse() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    let w1 = fx.warehouse("w1").await;
    let w2 = fx.warehouse("w2").await;
    let s1 = fx.supplier("s1", "EUR", 10).await;
    let s2 = fx.supplier("s2", "USD", 3).await;
    let p1 = fx.product("p1", "Lamp").await;
    let p2 = fx.product("p2", "Shade").await;
    let p3 = fx.product("p3", "Bulb").await;
    let p4 = fx.product("p4", "Cable").await;
    let p5 = fx.product("p5", "Hook").await;
    let link1 = fx.link("l1", &p1, &s1, Some(10), 6).await;
    fx.link("l2", &p2, &s1, None, 1).await;
    fx.link("l3", &p3, &s2, None, 1).await;
    fx.link("l5", &p5, &s1, None, 1).await;
    let open = |qty: i64| json!({ "suggested_qty": qty, "review_status": "open" });
    let mut with_link = open(12);
    with_link["product_supplier_id"] = json!(link1);
    let a = fx.plan("a", &p1, &w1, with_link).await;
    let b = fx.plan("b", &p2, &w1, open(4)).await;
    let c = fx.plan("c", &p3, &w1, open(3)).await;
    let d = fx.plan("d", &p1, &w2, open(6)).await;
    let e = fx.plan("e", &p4, &w1, open(5)).await;
    let f = fx.plan("f", &p5, &w1, open(0)).await;
    let g = fx
        .plan(
            "g",
            &p2,
            &w2,
            json!({ "suggested_qty": 4, "review_status": "ordered" }),
        )
        .await;

    let mut quantities = serde_json::Map::new();
    quantities.insert(a.clone(), json!(7));
    let (status, body) = app
        .call(
            "POST",
            "/replenishment/purchase-orders",
            Some(json!({
                "planIds": [a, b, c, d, e, f, g, "iplan_missing", a],
                "quantities": quantities,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let orders = body["data"]["purchaseOrders"].as_array().expect("orders");
    assert_eq!(orders.len(), 3, "{body}");
    let groups: Vec<(Value, Value, Value)> = orders
        .iter()
        .map(|o| {
            (
                o["supplierId"].clone(),
                o["warehouseId"].clone(),
                o["lineCount"].clone(),
            )
        })
        .collect();
    assert_eq!(
        groups,
        vec![
            (json!(s1), json!(w1), json!(2)),
            (json!(s2), json!(w1), json!(1)),
            (json!(s1), json!(w2), json!(1)),
        ]
    );
    assert_eq!(orders[0]["supplierName"], "Supplier s1");
    assert_eq!(orders[0]["total"], "40.00", "12 + 4 at 2.50");
    assert!(
        orders[0]["poNumber"]
            .as_str()
            .is_some_and(|n| n.starts_with(&format!("PO-{}-", day(0).replace('-', "")))),
        "{}",
        orders[0]
    );
    assert_eq!(
        body["data"]["skipped"],
        json!([
            { "planId": e, "reason": "no_supplier" },
            { "planId": f, "reason": "zero_quantity" },
            { "planId": g, "reason": "already_ordered" },
            { "planId": "iplan_missing", "reason": "not_found" },
        ])
    );

    let first = orders[0]["id"].as_str().expect("id");
    let header: Value = sqlx::query_scalar(
        "select jsonb_build_object('status', status, 'currency', currency, 'itemCount', item_count, \
         'expected', to_char(expected_date, 'YYYY-MM-DD'), 'createdBy', created_by, \
         'warehouseName', warehouse_name) from purchase_orders where id = $1",
    )
    .bind(first)
    .fetch_one(&db)
    .await
    .expect("header");
    assert_eq!(
        header,
        json!({
            "status": "draft", "currency": "EUR", "itemCount": 2, "expected": day(10),
            "createdBy": USER, "warehouseName": "Warehouse w1",
        })
    );
    let lines: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('product', product_id, 'name', name, 'sku', sku, \
         'quantity', quantity_ordered, 'pending', quantity_pending, 'price', unit_price::text, \
         'total', total::text) from purchase_order_items where purchase_order_id = $1 order by name",
    )
    .bind(first)
    .fetch_all(&db)
    .await
    .expect("lines");
    assert_eq!(
        lines,
        vec![
            json!({ "product": p1, "name": "Supplier l1", "sku": "SUP-l1", "quantity": 12,
                    "pending": 12, "price": "2.50", "total": "30.00" }),
            json!({ "product": p2, "name": "Supplier l2", "sku": "SUP-l2", "quantity": 4,
                    "pending": 4, "price": "2.50", "total": "10.00" }),
        ],
        "7 rounded up to the MOQ of 10, then to packs of 6"
    );
    let ordered: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, review_status, purchase_order_id from stash_item_plans where id = any($1) order by id",
    )
    .bind(vec![a.clone(), b.clone(), c.clone(), d.clone(), e.clone()])
    .fetch_all(&db)
    .await
    .expect("plans");
    for (id, status, order) in &ordered {
        if *id == e {
            assert_eq!(status, "open");
            assert_eq!(*order, None);
        } else {
            assert_eq!(status, "ordered", "{id}");
            assert!(order.is_some(), "{id}");
        }
    }
    let events = app.events().await;
    assert_eq!(
        events.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(),
        vec!["purchase_order:created"; 3]
    );
    assert_eq!(events[0].1["status"], "draft");
    assert_eq!(events[0].1["supplierId"], json!(s1));

    // Ordered plans are not ordered twice.
    let (status, body) = app
        .call(
            "POST",
            "/replenishment/purchase-orders",
            Some(json!({ "planIds": [a] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["data"]["purchaseOrders"], json!([]));
    assert_eq!(
        body["data"]["skipped"],
        json!([{ "planId": a, "reason": "already_ordered" }])
    );
    assert_eq!(app.actions().await, Vec::<String>::new());
}

// ── Runs ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_manual_run_starts_once_and_finishes() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    sqlx::query(
        "update stash_planning_runs set status = 'failed', error = 'left running by a test' \
         where status = 'running'",
    )
    .execute(&db)
    .await
    .expect("clear running runs");

    let (status, _) = app
        .call(
            "PATCH",
            "/replenishment/settings",
            Some(json!({ "replenishmentEnabled": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = app.call("POST", "/replenishment/runs", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        message(&body),
        "Replenishment is turned off for this workspace"
    );
    app.call(
        "PATCH",
        "/replenishment/settings",
        Some(json!({ "replenishmentEnabled": true })),
    )
    .await;

    // A run already running is the answer.
    let running = fx.id("prun");
    sqlx::query(
        "insert into stash_planning_runs (id, trigger, status) values ($1, 'schedule', 'running')",
    )
    .bind(&running)
    .execute(&db)
    .await
    .expect("running run");
    let (status, body) = app.call("POST", "/replenishment/runs", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["id"], json!(running));
    sqlx::query("update stash_planning_runs set status = 'done' where id = $1")
        .bind(&running)
        .execute(&db)
        .await
        .expect("done");
    app.events().await;

    let (status, body) = app.call("POST", "/replenishment/runs", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let run = body["data"].clone();
    assert_eq!(run["status"], "running");
    assert_eq!(run["trigger"], "manual");
    assert_eq!(run["startedBy"], USER);
    let actions = app.actions().await;
    assert_eq!(
        actions,
        vec!["replenishment_run:created", "replenishment_run:completed"]
    );
    let (status, body) = app.call("GET", "/replenishment/runs?limit=5", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["id"], run["id"]);
    assert_eq!(body["data"][0]["status"], "done", "{body}");
    assert!(body["data"].as_array().map_or(0, Vec::len) <= 5);
}

// ── Incoming ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn incoming_lists_open_purchase_order_lines() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    let product = fx.product("p", "Incoming").await;
    let warehouse = fx.warehouse("w").await;
    let order = fx.id("po");
    sqlx::query(
        "insert into purchase_orders (id, po_number, status, warehouse_id, expected_date) \
         values ($1, $1, 'ordered', $2, '2030-05-01')",
    )
    .bind(&order)
    .bind(&warehouse)
    .execute(&db)
    .await
    .expect("order");
    sqlx::query(
        "insert into purchase_order_items (id, purchase_order_id, product_id, name, \
         quantity_ordered, quantity_received, quantity_rejected, unit_price, total) \
         values ($1, $2, $3, 'line', 9, 2, 0, 1, 9)",
    )
    .bind(fx.id("poi"))
    .bind(&order)
    .bind(&product)
    .execute(&db)
    .await
    .expect("line");
    let (status, body) = app
        .call(
            "GET",
            &format!("/replenishment/incoming?productId={product}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"],
        json!([{
            "productId": product, "variantId": null, "warehouseId": warehouse,
            "quantity": 7, "nextExpectedDate": "2030-05-01T00:00:00.000Z",
        }])
    );
}

// ── CSV imports ─────────────────────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines)] // one import from start to delete
async fn an_import_takes_rows_completes_and_is_deleted() {
    let Some(db) = tenant() else { return };
    let _one = ONE.lock().await;
    let fx = Fx::new(&db);
    let workspace = fx.id("ws");
    let master = master();
    let app = harness_in(db.clone(), ALL, master.clone(), &workspace);
    let product = fx.product("p", "Imported").await;
    let variant = fx.variant("v", &product).await;
    let warehouse = fx.warehouse("w").await;
    let code = format!("C-{warehouse}");
    // An order, so a cut-over date can be suggested.
    sqlx::query(
        "insert into orders (id, order_number, status, created_at) \
         values ($1, $1, 'delivered', now() - interval '30 days')",
    )
    .bind(fx.id("ord"))
    .execute(&db)
    .await
    .expect("order");
    app.call(
        "PATCH",
        "/replenishment/settings",
        Some(json!({ "historyCutoverDate": null })),
    )
    .await;
    app.events().await;

    let (status, body) = app
        .call(
            "POST",
            "/replenishment/imports",
            Some(json!({ "fileName": "sales.csv" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["status"], "processing");
    assert_eq!(body["data"]["createdBy"], USER);
    let id = body["data"]["id"].as_str().expect("id").to_owned();

    let nope = fx.id("NOPE");
    let (status, body) = app
        .call(
            "POST",
            &format!("/replenishment/imports/{id}/rows"),
            Some(json!({ "rows": [
                { "date": "2025-01-05", "sku": product, "quantity": 3 },
                { "date": "2025-01-06", "sku": variant, "quantity": 2, "warehouseCode": code,
                  "reference": "INV-1" },
                { "date": "2025-01-07", "sku": nope, "quantity": 1 },
                { "date": "2025-01-08", "sku": product, "quantity": 1, "warehouseCode": "none-such" },
            ] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"],
        json!({ "imported": 2, "skipped": 2, "unmatchedSkus": [nope] })
    );
    let stored: Vec<(String, Option<String>, Option<String>, i32)> = sqlx::query_as(
        "select to_char(date, 'YYYY-MM-DD'), variant_id, warehouse_id, quantity \
         from stash_sales_history where import_id = $1 order by date",
    )
    .bind(&id)
    .fetch_all(&db)
    .await
    .expect("rows");
    assert_eq!(
        stored,
        vec![
            ("2025-01-05".to_owned(), None, None, 3),
            (
                "2025-01-06".to_owned(),
                Some(variant.clone()),
                Some(warehouse.clone()),
                2
            ),
        ]
    );
    let (_, body) = app
        .call("GET", &format!("/replenishment/imports/{id}"), None)
        .await;
    let import = &body["data"];
    assert_eq!(import["rowsTotal"], 4);
    assert_eq!(import["rowsImported"], 2);
    assert_eq!(import["rowsSkipped"], 2);
    assert_eq!(import["unmatchedSkus"], json!([nope]));
    assert_eq!(import["dateFrom"], "2025-01-05");
    assert_eq!(import["dateTo"], "2025-01-06");

    let (status, body) = app
        .call(
            "POST",
            &format!("/replenishment/imports/{id}/complete"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["import"]["status"], "done");
    let suggested = body["data"]["suggestedCutoverDate"]
        .as_str()
        .expect("a suggested cut-over date");
    assert!(suggested <= day(-30).as_str(), "{suggested}");
    if let Some(master) = &master {
        assert!(
            is_due(master, &workspace).await,
            "completing marks the workspace due"
        );
    }
    let (status, body) = app
        .call(
            "POST",
            &format!("/replenishment/imports/{id}/complete"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "again: {body}");
    let (status, body) = app
        .call(
            "POST",
            &format!("/replenishment/imports/{id}/rows"),
            Some(json!({ "rows": [{ "date": "2025-01-05", "sku": product, "quantity": 3 }] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) = app
        .call("GET", "/replenishment/imports?limit=200", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["data"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == json!(id))),
        "listed"
    );

    let (status, _) = app
        .call("DELETE", &format!("/replenishment/imports/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("select count(*) from stash_sales_history where import_id = $1")
            .bind(&id)
            .fetch_one(&db)
            .await
            .expect("count");
    assert_eq!(left, 0, "the rows go with it");
    let (status, _) = app
        .call("GET", &format!("/replenishment/imports/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .call("DELETE", &format!("/replenishment/imports/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.actions().await,
        vec![
            "sales_history_import:created",
            "sales_history_import:completed",
            "sales_history_import:deleted",
        ]
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // two chunks, their retries
async fn a_retried_chunk_replaces_its_rows() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let app = harness(db.clone(), ALL);
    let product = fx.product("p", "Retried").await;
    let (status, body) = app
        .call(
            "POST",
            "/replenishment/imports",
            Some(json!({ "fileName": "retry.csv" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["data"]["id"].as_str().expect("id").to_owned();
    let rows_path = format!("/replenishment/imports/{id}/rows");
    let nope = fx.id("NOPE");
    let first = |quantity: i64| {
        json!({ "startRow": 0, "rows": [
            { "date": "2025-02-01", "sku": product, "quantity": quantity, "reference": "INV-9" },
            { "date": "2025-02-02", "sku": product, "quantity": 2 },
            { "date": "2025-02-03", "sku": nope, "quantity": 1 },
        ] })
    };
    let stored = || async {
        let rows: Vec<(String, i32)> = sqlx::query_as(
            "select external_ref, quantity from stash_sales_history where import_id = $1 \
             order by external_ref",
        )
        .bind(&id)
        .fetch_all(&db)
        .await
        .expect("rows");
        rows
    };
    let counts = || async {
        let (_, body) = app
            .call("GET", &format!("/replenishment/imports/{id}"), None)
            .await;
        let import = &body["data"];
        (
            import["rowsTotal"].clone(),
            import["rowsImported"].clone(),
            import["rowsSkipped"].clone(),
        )
    };

    // The chunk, then the same chunk again (a retry): nothing doubles.
    for _ in 0..2 {
        let (status, body) = app.call("POST", &rows_path, Some(first(5))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["data"],
            json!({ "imported": 2, "skipped": 1, "unmatchedSkus": [nope] })
        );
        assert_eq!(
            stored().await,
            vec![("row:0".to_owned(), 5), ("row:1".to_owned(), 2)]
        );
        assert_eq!(counts().await, (json!(3), json!(2), json!(1)));
    }

    // The next chunk adds to it; a retry of it doesn't.
    let second = json!({ "startRow": 3, "rows": [
        { "date": "2025-02-04", "sku": product, "quantity": 4 },
        { "date": "2025-02-05", "sku": nope, "quantity": 4 },
    ] });
    for _ in 0..2 {
        let (status, body) = app.call("POST", &rows_path, Some(second.clone())).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(counts().await, (json!(5), json!(3), json!(2)));
    }

    // A retry with other numbers replaces the first attempt's.
    app.call("POST", &rows_path, Some(first(9))).await;
    assert_eq!(
        stored().await,
        vec![
            ("row:0".to_owned(), 9),
            ("row:1".to_owned(), 2),
            ("row:3".to_owned(), 4),
        ]
    );
    assert_eq!(counts().await, (json!(5), json!(3), json!(2)));
    let (_, body) = app
        .call("GET", &format!("/replenishment/imports/{id}"), None)
        .await;
    assert_eq!(body["data"]["unmatchedSkus"], json!([nope]));

    let (status, _) = app
        .call("DELETE", &format!("/replenishment/imports/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}
