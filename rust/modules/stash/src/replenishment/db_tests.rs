//! The planner's reads and the planning run on the real tenant schema:
//! the demand series (pick-list warehouses, the cut-over date, orders that
//! are no demand), the position and supplier of an item, and whole runs
//! (plans written, review states kept across runs, plans dropped, the
//! notification). Skipped without `WELDSUITE_TEST_TENANT_URL`.
//!
//! The database is shared: fresh ids, nothing truncated or assumed empty.
//! A run plans every item in the database and the settings row is the
//! workspace's one, so the run tests hold [`RUNS`] and assert only on
//! their own items; they deactivate their warehouses and delete their
//! products afterwards, so later runs stay small.

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use time::{Date, Duration, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_notifications::Notifier;
use weldsuite_ports::{
    BoxFuture, DynEventBus, DynJobs, Job, JobContext, JobError, JobRequest, Jobs, PortError,
    RecordingEventBus, StepFn, StepRetry,
};

use super::demand::{Item, Planning, demand_days, plan_items};
use super::run::{
    ReplenishmentRunJob, RunStart, SWEEP_KIND, Started, SweepTenants, finish_run, next_run_at,
    notify_reorder, run_replenishment_sweep, start_run, write_plans,
};
use super::settings::Settings;

/// One run (or settings change) at a time in this test binary.
static RUNS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(weldsuite_db::master_pool(&url, 4).expect("tenant pool"))
}

fn today() -> Date {
    OffsetDateTime::now_utc().date()
}

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

    async fn exec(&self, sql: &'static str, binds: &[Value]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(bind.clone());
        }
        query.execute(&self.db).await.expect(sql);
    }

    /// A product created `age` days ago.
    async fn product(&self, key: &str, age: i64) -> String {
        let id = self.id(key);
        self.exec(
            "insert into products (id, name, slug, sku, cost_price, created_at) \
             values ($1->>0, $1->>1, $1->>0, $1->>0, 2.00, now() - make_interval(days => ($1->>2)::int))",
            &[json!([id, format!("Repl {key}"), age])],
        )
        .await;
        id
    }

    async fn variant(&self, key: &str, product: &str) -> String {
        let id = self.id(key);
        self.exec(
            "insert into product_variants (id, product_id, name, sku, created_at) \
             values ($1->>0, $1->>1, $1->>0, $1->>0, now() - interval '400 days')",
            &[json!([id, product])],
        )
        .await;
        id
    }

    async fn warehouse(&self, key: &str) -> String {
        let id = self.id(key);
        self.exec(
            "insert into warehouses (id, name, code) values ($1->>0, $1->>0, $1->>0)",
            &[json!([id])],
        )
        .await;
        id
    }

    /// An order `days_ago` days ago with one line of `product` (and
    /// `variant`): `status`, `cancelled`/`deleted` set those columns.
    #[allow(clippy::too_many_arguments)]
    async fn order(
        &self,
        key: &str,
        days_ago: i64,
        status: &str,
        product: &str,
        variant: Option<&str>,
        quantity: i64,
        flags: (bool, bool),
    ) -> String {
        let id = self.id(key);
        self.exec(
            "insert into orders (id, order_number, status, created_at, cancelled_at, deleted_at) \
             values ($1->>0, $1->>0, $1->>1, now() - make_interval(days => ($1->>2)::int), \
             case when ($1->>3)::boolean then now() end, case when ($1->>4)::boolean then now() end)",
            &[json!([id, status, days_ago, flags.0, flags.1])],
        )
        .await;
        self.exec(
            "insert into order_items (id, order_id, product_id, variant_id, name, quantity, \
             unit_price, total) values ($1->>0, $1->>1, $1->>2, $1->>3, 'line', ($1->>4)::int, 1, 1)",
            &[json!([format!("{id}_i"), id, product, variant, quantity])],
        )
        .await;
        id
    }

    async fn pick_list(&self, key: &str, warehouse: &str, orders: &[&str], status: &str) {
        let id = self.id(key);
        self.exec(
            "insert into pick_lists (id, pick_list_number, warehouse_id, status, order_ids) \
             values ($1->>0, $1->>0, $1->>1, $1->>2, $1->3)",
            &[json!([id, warehouse, status, orders])],
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn history(
        &self,
        key: &str,
        days_ago: i64,
        product: &str,
        warehouse: Option<&str>,
        quantity: i64,
        source: &str,
    ) {
        self.exec(
            "insert into stash_sales_history (id, date, product_id, warehouse_id, quantity, source) \
             values ($1->>0, current_date - ($1->>1)::int, $1->>2, $1->>3, ($1->>4)::int, $1->>5)",
            &[json!([self.id(key), days_ago, product, warehouse, quantity, source])],
        )
        .await;
    }

    async fn bucket(&self, key: &str, product: &str, warehouse: &str, on_hand: i64, status: &str) {
        self.exec(
            "insert into inventory (id, product_id, warehouse_id, quantity_on_hand, \
             quantity_allocated, status, lot_number) \
             values ($1->>0, $1->>1, $1->>2, ($1->>3)::int, 1, $1->>4, $1->>0)",
            &[json!([self.id(key), product, warehouse, on_hand, status])],
        )
        .await;
    }

    async fn supplier(&self, key: &str, lead: i64) -> String {
        let id = self.id(key);
        self.exec(
            "insert into suppliers (id, name, currency, default_lead_time_days) \
             values ($1->>0, $1->>0, 'EUR', ($1->>1)::int)",
            &[json!([id, lead])],
        )
        .await;
        id
    }

    async fn link(
        &self,
        key: &str,
        product: &str,
        supplier: &str,
        moq: i64,
        multiple: i64,
    ) -> String {
        let id = self.id(key);
        self.exec(
            "insert into product_suppliers (id, product_id, supplier_id, unit_cost, currency, \
             min_order_qty, order_multiple, is_preferred) \
             values ($1->>0, $1->>1, $1->>2, 2.50, 'EUR', ($1->>3)::int, ($1->>4)::int, true)",
            &[json!([id, product, supplier, moq, multiple])],
        )
        .await;
        id
    }

    /// An approved purchase order of `quantity` units of `product` into
    /// `warehouse`, expected in `days` days.
    async fn incoming(&self, key: &str, product: &str, warehouse: &str, quantity: i64, days: i64) {
        let id = self.id(key);
        self.exec(
            "insert into purchase_orders (id, po_number, status, warehouse_id, expected_date) \
             values ($1->>0, $1->>0, 'approved', $1->>1, now() + make_interval(days => ($1->>2)::int))",
            &[json!([id, warehouse, days])],
        )
        .await;
        self.exec(
            "insert into purchase_order_items (id, purchase_order_id, product_id, name, \
             quantity_ordered, quantity_received, quantity_rejected, unit_price, total) \
             values ($1->>0, $1->>1, $1->>2, 'line', ($1->>3)::int, 0, 0, 1, 1)",
            &[json!([format!("{id}_i"), id, product, quantity])],
        )
        .await;
    }

    /// Deactivate the warehouses and delete the products the test made.
    async fn retire(&self) {
        let like = format!("%_{}", self.tag);
        self.exec(
            "update warehouses set is_active = false where id like $1->>0",
            &[json!([like])],
        )
        .await;
        self.exec(
            "update products set deleted_at = now() where id like $1->>0",
            &[json!([like])],
        )
        .await;
        self.exec(
            "update workspace_members set deleted_at = now() where id like $1->>0",
            &[json!([like])],
        )
        .await;
    }
}

// ── The demand series ───────────────────────────────────────────────────────

#[tokio::test]
async fn demand_counts_pick_list_warehouses_and_the_cutover() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let product = fx.product("p", 500).await;
    let variant = fx.variant("v", &product).await;
    let demand_wh = fx.warehouse("wa").await;
    let pick_wh = fx.warehouse("wb").await;

    let picked = fx
        .order("o1", 10, "processing", &product, None, 3, (false, false))
        .await;
    fx.order("o2", 10, "pending", &product, None, 2, (false, false))
        .await;
    fx.order("o3", 10, "cancelled", &product, None, 7, (false, false))
        .await;
    fx.order("o4", 10, "processing", &product, None, 5, (true, false))
        .await;
    fx.order("o5", 10, "processing", &product, None, 11, (false, true))
        .await;
    fx.order("o6", 10, "failed", &product, None, 13, (false, false))
        .await;
    let unpicked = fx
        .order("o7", 10, "pending", &product, None, 4, (false, false))
        .await;
    fx.order(
        "o8",
        12,
        "delivered",
        &product,
        Some(&variant),
        1,
        (false, false),
    )
    .await;
    fx.order("o9", 800, "delivered", &product, None, 50, (false, false))
        .await;
    fx.pick_list("pl1", &pick_wh, &[&picked], "completed").await;
    fx.pick_list("pl2", &pick_wh, &[&unpicked], "cancelled")
        .await;

    // Before the cut-over (20 days ago), an import counts; after it, only
    // a synced source does.
    fx.history("h1", 40, &product, None, 6, "import").await;
    fx.history("h2", 5, &product, None, 9, "import").await;
    fx.history("h3", 5, &product, Some(&pick_wh), 4, "odoo")
        .await;

    let today = today();
    let days = demand_days(
        &db,
        std::slice::from_ref(&product),
        today - Duration::days(730),
        today,
        Some(&demand_wh),
        Some(today - Duration::days(20)),
    )
    .await
    .expect("demand");
    let at = |n: i64| today - Duration::days(n);
    let key = |variant: Option<&str>, warehouse: &str| {
        super::demand::item_key(&product, variant, warehouse)
    };
    assert_eq!(
        days.get(&key(None, &demand_wh)),
        Some(&vec![(at(40), 6), (at(10), 6)]),
        "the unpicked orders and the import before the cut-over"
    );
    assert_eq!(
        days.get(&key(None, &pick_wh)),
        Some(&vec![(at(10), 3), (at(5), 4)]),
        "the picked order and the synced sale"
    );
    assert_eq!(
        days.get(&key(Some(&variant), &demand_wh)),
        Some(&vec![(at(12), 1)])
    );
    assert_eq!(days.len(), 3, "{days:?}");
    fx.retire().await;
}

#[tokio::test]
async fn an_item_reads_its_position_supplier_and_lead_time() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let product = fx.product("p", 100).await;
    let warehouse = fx.warehouse("w").await;
    for day in 1..=40 {
        fx.history(
            &format!("h{day}"),
            day,
            &product,
            Some(&warehouse),
            3,
            "odoo",
        )
        .await;
    }
    fx.bucket("b1", &product, &warehouse, 20, "available").await;
    fx.bucket("b2", &product, &warehouse, 50, "quarantine")
        .await;
    fx.incoming("po", &product, &warehouse, 12, 5).await;
    let supplier = fx.supplier("s", 21).await;
    let link = fx.link("ps", &product, &supplier, 10, 6).await;
    // An open order on no pick list, in the demand warehouse; one on a
    // pick list is allocated there instead.
    fx.order("o", 2, "pending", &product, None, 4, (false, false))
        .await;
    let picked = fx
        .order("o2", 2, "processing", &product, None, 6, (false, false))
        .await;
    fx.pick_list("pl", &warehouse, &[&picked], "pending").await;

    let planning = Planning {
        today: today(),
        settings: Settings::default(),
        demand_warehouse: Some(warehouse.clone()),
    };
    let item = Item {
        product_id: product.clone(),
        variant_id: None,
        warehouse_id: warehouse.clone(),
    };
    let plans = plan_items(&db, &planning, vec![item]).await.expect("plan");
    let plan = &plans[0];
    assert!(plan.active);
    assert_eq!(
        plan.input.position.on_hand, 20,
        "quarantined stock is left out"
    );
    assert_eq!(plan.input.position.allocated, 1);
    assert_eq!(plan.input.position.incoming, 12);
    assert_eq!(plan.input.position.open_demand, 4);
    assert_eq!(plan.input.receipts.len(), 1);
    assert_eq!(plan.input.receipts[0].date, today() + Duration::days(5));
    assert_eq!(plan.input.lead_time_days, 21, "the supplier's default");
    assert_eq!(plan.product_supplier_id.as_deref(), Some(link.as_str()));
    assert_eq!(plan.supplier_id.as_deref(), Some(supplier.as_str()));
    // 40 days of 3 a day plus the two orders.
    assert_eq!(plan.series.iter().sum::<i64>(), 130);
    assert_eq!(plan.output.method.as_str(), "level");
    if plan.output.suggested_qty > 0 {
        assert!(plan.output.suggested_qty >= 10);
        assert_eq!(plan.output.suggested_qty % 6, 0, "whole packs");
    }
    fx.retire().await;
}

// ── Whole runs ──────────────────────────────────────────────────────────────

/// Steps run once, in line.
struct Inline;

impl JobContext for Inline {
    fn key(&self) -> &'static str {
        "test"
    }

    fn run_step<'s>(
        &'s self,
        _name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        step()
    }
}

/// A jobs port that keeps what it was asked to start.
#[derive(Default)]
struct Recorded(Mutex<Vec<JobRequest>>);

impl Jobs for Recorded {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request);
        std::future::ready(Ok(()))
    }
}

struct Runner {
    db: PgPool,
    job: ReplenishmentRunJob,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
    jobs: Recorded,
}

impl Runner {
    fn new(db: &PgPool) -> Self {
        let bus = Arc::new(RecordingEventBus::new());
        let tracker = TaskTracker::new();
        let events = EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        );
        let pool = db.clone();
        let job = ReplenishmentRunJob {
            tenants: Arc::new(move |_| {
                let pool = pool.clone();
                Box::pin(async move { Ok(pool) })
            }),
            events,
            notifier: Notifier::default(),
        };
        Self {
            db: db.clone(),
            job,
            bus,
            tracker,
            jobs: Recorded::default(),
        }
    }

    /// Start a run and run its job here; the run row.
    async fn run(&self) -> Value {
        let start = RunStart {
            workspace_id: "ws_repl_test".to_owned(),
            clerk_org_id: None,
            trigger: "manual",
            started_by: Some("user_repl".to_owned()),
        };
        let started = start_run(&self.db, &self.jobs, &self.job.events, &start)
            .await
            .expect("start");
        let Started::New(row) = started else {
            panic!("a run is already running: {started:?}");
        };
        let request = self
            .jobs
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop()
            .expect("job started");
        self.job
            .run(&Inline, request.payload)
            .await
            .expect("the run");
        let id = row["id"].as_str().expect("id").to_owned();
        let row: Value =
            sqlx::query_scalar("select to_jsonb(t) from stash_planning_runs t where id = $1")
                .bind(&id)
                .fetch_one(&self.db)
                .await
                .expect("run row");
        weldsuite_db::js_row(row)
    }

    /// The events published so far, as `type:action`, then cleared.
    async fn actions(&self) -> Vec<String> {
        self.tracker.close();
        self.tracker.wait().await;
        self.tracker.reopen();
        let actions = self
            .bus
            .payloads()
            .iter()
            .map(|payload| {
                format!(
                    "{}:{}",
                    payload["entityType"].as_str().unwrap_or_default(),
                    payload["action"].as_str().unwrap_or_default()
                )
            })
            .collect();
        self.bus.clear();
        actions
    }
}

/// The plan of an item, as columns.
async fn plan_of(db: &PgPool, key: &str) -> Option<Value> {
    sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'status', review_status, 'suggested', suggested_qty, \
         'method', method, 'supplier', supplier_id, 'link', product_supplier_id, \
         'order', purchase_order_id, 'dismissedQty', dismissed_qty, 'run', run_id) \
         from stash_item_plans where item_key = $1",
    )
    .bind(key)
    .fetch_optional(db)
    .await
    .expect("plan")
}

/// Fail runs a crashed test left running, so a start isn't answered with
/// one.
async fn clear_running(db: &PgPool) {
    sqlx::query(
        "update stash_planning_runs set status = 'failed', error = 'left running by a test' \
         where status = 'running'",
    )
    .execute(db)
    .await
    .expect("clear running runs");
}

/// Settings pointing at `warehouse`, on.
async fn use_settings(db: &PgPool, warehouse: &str) {
    sqlx::query(
        "insert into stash_settings (id, replenishment_enabled, demand_warehouse_id, \
         history_cutover_date, default_lead_time_days, lookback_days) \
         values ('default', true, $1, null, 14, 365) \
         on conflict (id) do update set replenishment_enabled = true, demand_warehouse_id = $1, \
         history_cutover_date = null, default_lead_time_days = 14, lookback_days = 365",
    )
    .bind(warehouse)
    .execute(db)
    .await
    .expect("settings");
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one story: four runs
async fn runs_write_plans_and_keep_their_review_state() {
    let Some(db) = tenant() else { return };
    let _one = RUNS.lock().await;
    clear_running(&db).await;
    let fx = Fx::new(&db);
    let warehouse = fx.warehouse("w").await;
    use_settings(&db, &warehouse).await;
    // Sells 5 a day for 60 days, nothing in stock: needs reordering.
    let seller = fx.product("sell", 200).await;
    for day in 1..=60 {
        fx.history(&format!("h{day}"), day, &seller, None, 5, "odoo")
            .await;
    }
    let supplier = fx.supplier("s", 10).await;
    let link = fx.link("ps", &seller, &supplier, 40, 25).await;
    // No demand, stock or rule: no plan; its stale plan is dropped.
    let quiet = fx.product("quiet", 200).await;
    let quiet_key = super::demand::item_key(&quiet, None, &warehouse);
    sqlx::query(
        "insert into stash_item_plans (id, item_key, product_id, warehouse_id, run_id) \
         values ($1, $2, $3, $4, 'prun_old')",
    )
    .bind(fx.id("stale"))
    .bind(&quiet_key)
    .bind(&quiet)
    .bind(&warehouse)
    .execute(&db)
    .await
    .expect("stale plan");
    // Stock but its rule is off: no plan.
    let off = fx.product("off", 200).await;
    fx.bucket("b", &off, &warehouse, 7, "available").await;
    sqlx::query(
        "insert into stash_reorder_rules (id, item_key, product_id, warehouse_id, method) \
         values ($1, $2, $3, $4, 'off')",
    )
    .bind(fx.id("rule"))
    .bind(super::demand::item_key(&off, None, &warehouse))
    .bind(&off)
    .bind(&warehouse)
    .execute(&db)
    .await
    .expect("rule");
    // A manager to notify.
    let manager = fx.id("user");
    sqlx::query(
        "insert into workspace_members (id, user_id, role, status) values ($1, $2, 'OWNER', 'ACTIVE')",
    )
    .bind(fx.id("member"))
    .bind(&manager)
    .execute(&db)
    .await
    .expect("member");

    let runner = Runner::new(&db);
    let seller_key = super::demand::item_key(&seller, None, &warehouse);

    // Run 1: the seller opens.
    let run = runner.run().await;
    assert_eq!(run["status"], "done", "{run}");
    assert!(run["itemsToReorder"].as_i64().unwrap_or(0) >= 1, "{run}");
    let plan = plan_of(&db, &seller_key).await.expect("seller plan");
    assert_eq!(plan["status"], "open", "{plan}");
    assert_eq!(plan["supplier"], json!(supplier));
    assert_eq!(plan["link"], json!(link));
    let suggested = plan["suggested"].as_i64().expect("suggested");
    assert!(suggested >= 40 && suggested % 25 == 0, "{plan}");
    assert_eq!(plan["run"], run["id"]);
    assert!(
        plan_of(&db, &quiet_key).await.is_none(),
        "no plan, stale one dropped"
    );
    assert!(
        plan_of(&db, &super::demand::item_key(&off, None, &warehouse))
            .await
            .is_none(),
        "an off rule plans nothing"
    );
    assert_eq!(
        runner.actions().await,
        vec!["replenishment_run:created", "replenishment_run:completed"]
    );
    let notified: i64 = sqlx::query_scalar(
        "select count(*) from notifications where user_id = $1 and entity_type = 'replenishment_run'",
    )
    .bind(&manager)
    .fetch_one(&db)
    .await
    .expect("notifications");
    assert_eq!(notified, 1, "the manager hears about it");
    // At most once a day.
    let again = notify_reorder(&db, &Notifier::default(), "ws", None, "prun_x", 3)
        .await
        .expect("notify");
    let notified_again: i64 = sqlx::query_scalar(
        "select count(*) from notifications where user_id = $1 and entity_type = 'replenishment_run'",
    )
    .bind(&manager)
    .fetch_one(&db)
    .await
    .expect("notifications");
    assert_eq!(
        notified_again, 1,
        "not twice a day ({again} others notified)"
    );

    // Run 2: a dismissal holds.
    sqlx::query(
        "update stash_item_plans set review_status = 'dismissed', dismissed_by = 'user_repl', \
         dismissed_until = now() + interval '7 days', dismissed_qty = suggested_qty where item_key = $1",
    )
    .bind(&seller_key)
    .execute(&db)
    .await
    .expect("dismiss");
    runner.run().await;
    let plan = plan_of(&db, &seller_key).await.expect("seller plan");
    assert_eq!(plan["status"], "dismissed", "{plan}");
    assert_eq!(plan["dismissedQty"], json!(suggested));

    // Run 3: once the suggestion has grown by more than half, it reopens.
    sqlx::query("update stash_item_plans set dismissed_qty = 1 where item_key = $1")
        .bind(&seller_key)
        .execute(&db)
        .await
        .expect("shrink the dismissal");
    runner.run().await;
    let plan = plan_of(&db, &seller_key).await.expect("seller plan");
    assert_eq!(plan["status"], "open", "{plan}");
    assert_eq!(plan["dismissedQty"], Value::Null);

    // Run 4: an order holds while its purchase order is open, and clears
    // once it is received.
    let order = fx.id("po");
    sqlx::query("insert into purchase_orders (id, po_number, status) values ($1, $1, 'draft')")
        .bind(&order)
        .execute(&db)
        .await
        .expect("order");
    sqlx::query(
        "update stash_item_plans set review_status = 'ordered', purchase_order_id = $2 where item_key = $1",
    )
    .bind(&seller_key)
    .bind(&order)
    .execute(&db)
    .await
    .expect("ordered");
    runner.run().await;
    assert_eq!(
        plan_of(&db, &seller_key).await.expect("plan")["status"],
        "ordered"
    );
    sqlx::query("update purchase_orders set status = 'received' where id = $1")
        .bind(&order)
        .execute(&db)
        .await
        .expect("received");
    runner.run().await;
    let plan = plan_of(&db, &seller_key).await.expect("seller plan");
    assert_eq!(plan["status"], "open", "{plan}");
    assert_eq!(plan["order"], Value::Null);
    runner.actions().await;

    fx.retire().await;
}

#[tokio::test]
async fn a_second_start_answers_the_running_run() {
    let Some(db) = tenant() else { return };
    let _one = RUNS.lock().await;
    clear_running(&db).await;
    let runner = Runner::new(&db);
    let start = RunStart {
        workspace_id: "ws_repl_test".to_owned(),
        clerk_org_id: Some("org_repl".to_owned()),
        trigger: "schedule",
        started_by: None,
    };
    let first = start_run(&db, &runner.jobs, &runner.job.events, &start)
        .await
        .expect("start");
    let Started::New(first) = first else {
        panic!("a run was already running: {first:?}");
    };
    let second = start_run(&db, &runner.jobs, &runner.job.events, &start)
        .await
        .expect("start again");
    let Started::Running(second) = second else {
        panic!("expected the running run: {second:?}");
    };
    assert_eq!(first["id"], second["id"]);
    let requests = runner
        .jobs
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert_eq!(requests.len(), 1, "one job");
    assert_eq!(requests[0].name, super::run::REPLENISHMENT_RUN_JOB);
    assert_eq!(
        requests[0].payload["clerkOrgId"],
        json!("org_repl"),
        "{:?}",
        requests[0]
    );
    // Close it so later starts are free.
    sqlx::query("update stash_planning_runs set status = 'done' where id = $1")
        .bind(first["id"].as_str())
        .execute(&db)
        .await
        .expect("close");
    assert_eq!(runner.actions().await, vec!["replenishment_run:created"]);
}

/// A `running` run row started `minutes_ago`.
async fn running_run(db: &PgPool, id: &str, minutes_ago: i32) {
    sqlx::query(
        "insert into stash_planning_runs (id, trigger, status, started_at) \
         values ($1, 'manual', 'running', now() - make_interval(mins => $2))",
    )
    .bind(id)
    .bind(minutes_ago)
    .execute(db)
    .await
    .expect("running run");
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // the old run's write, the new run's, both finishes
async fn a_superseded_run_writes_and_deletes_nothing() {
    let Some(db) = tenant() else { return };
    let _one = RUNS.lock().await;
    clear_running(&db).await;
    let fx = Fx::new(&db);
    let warehouse = fx.warehouse("w").await;
    let product = fx.product("p", 100).await;
    fx.bucket("b", &product, &warehouse, 5, "available").await;
    let key = super::demand::item_key(&product, None, &warehouse);
    // A plan under review the newer run must keep.
    let other = fx.product("o", 100).await;
    fx.bucket("b2", &other, &warehouse, 3, "available").await;
    let other_key = super::demand::item_key(&other, None, &warehouse);
    let order = fx.id("po");
    sqlx::query("insert into purchase_orders (id, po_number, status) values ($1, $1, 'draft')")
        .bind(&order)
        .execute(&db)
        .await
        .expect("order");

    let planning = Planning {
        today: today(),
        settings: Settings::default(),
        demand_warehouse: Some(warehouse.clone()),
    };
    let item = |product: &str| Item {
        product_id: product.to_owned(),
        variant_id: None,
        warehouse_id: warehouse.clone(),
    };
    let old_run = fx.id("old");
    let new_run = fx.id("new");
    // The old run was taken for lost (failed); the newer one runs.
    running_run(&db, &old_run, 400).await;
    running_run(&db, &new_run, 1).await;
    sqlx::query("update stash_planning_runs set status = 'failed' where id = $1")
        .bind(&old_run)
        .execute(&db)
        .await
        .expect("fail the old run");

    let new_plans = plan_items(&db, &planning, vec![item(&other)])
        .await
        .expect("plan");
    let written = write_plans(&db, new_plans, &new_run).await.expect("write");
    assert_eq!(
        written.map(|counts| counts.planned),
        Some(1),
        "the current run writes"
    );
    sqlx::query(
        "update stash_item_plans set review_status = 'ordered', purchase_order_id = $2 \
         where item_key = $1",
    )
    .bind(&other_key)
    .bind(&order)
    .execute(&db)
    .await
    .expect("ordered");

    // The old run's chunk, worked out before it was failed, writes nothing.
    let old_plans = plan_items(&db, &planning, vec![item(&product), item(&other)])
        .await
        .expect("plan");
    let refused = write_plans(&db, old_plans, &old_run).await.expect("write");
    assert_eq!(refused, None);
    assert!(plan_of(&db, &key).await.is_none(), "nothing written");
    let kept = plan_of(&db, &other_key).await.expect("plan");
    assert_eq!(kept["run"], json!(new_run));
    assert_eq!(kept["status"], "ordered");
    assert_eq!(kept["order"], json!(order));
    // Nor does it finish (and delete) anything.
    assert_eq!(
        finish_run(&db, &old_run, 1).await.expect("finish"),
        Value::Null
    );
    assert!(plan_of(&db, &other_key).await.is_some());

    // Two runs marked running (no start makes that, but a stray row can):
    // only the latest is current.
    let stray = fx.id("stray");
    running_run(&db, &stray, 30).await;
    let stray_plans = plan_items(&db, &planning, vec![item(&product)])
        .await
        .expect("plan");
    assert_eq!(
        write_plans(&db, stray_plans, &stray).await.expect("write"),
        None,
        "an older running run is not current"
    );
    assert_eq!(
        finish_run(&db, &stray, 0).await.expect("finish"),
        Value::Null
    );
    assert!(plan_of(&db, &other_key).await.is_some());

    sqlx::query("update stash_planning_runs set status = 'done' where id = any($1)")
        .bind(vec![new_run.clone(), stray.clone()])
        .execute(&db)
        .await
        .expect("close");
    fx.retire().await;
}

// ── The nightly sweep ───────────────────────────────────────────────────────

/// The due time of `workspace`'s row, if it has one.
async fn due_at(master: &PgPool, workspace: &str) -> Option<OffsetDateTime> {
    let at: Option<String> = sqlx::query_scalar(
        "select to_char(next_due_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') \
         from workspace_due_index where kind = $1 and workspace_id = $2",
    )
    .bind(SWEEP_KIND)
    .bind(workspace)
    .fetch_optional(master)
    .await
    .expect("due row");
    at.and_then(|at| {
        OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339).ok()
    })
}

#[tokio::test]
async fn the_sweep_starts_due_runs_and_reschedules_them() {
    let Some(db) = tenant() else { return };
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
    let master = weldsuite_db::master_pool(&url, 2).expect("master pool");
    let _one = RUNS.lock().await;
    clear_running(&db).await;
    let fx = Fx::new(&db);
    let warehouse = fx.warehouse("w").await;
    use_settings(&db, &warehouse).await;
    sqlx::query("update stash_settings set run_hour_utc = 3 where id = 'default'")
        .execute(&db)
        .await
        .expect("run hour");
    let workspace = fx.id("ws");
    let now = OffsetDateTime::now_utc();
    // Long overdue, so it is swept first.
    weldsuite_db::due_index::mark_due(&master, SWEEP_KIND, &workspace, now - Duration::days(3650))
        .await;

    let runner = Runner::new(&db);
    let recorded = Arc::new(Recorded::default());
    let jobs: Arc<dyn DynJobs> = Arc::clone(&recorded) as Arc<dyn DynJobs>;
    let pool = db.clone();
    let tenants: SweepTenants = Arc::new(move |_| {
        let pool = pool.clone();
        Box::pin(async move { Ok((pool, Some("org_sweep".to_owned()))) })
    });
    let swept = run_replenishment_sweep(&master, &tenants, &jobs, &runner.job.events, now).await;
    assert!(swept.processed >= 1, "{swept:?}");
    assert_eq!(swept.failed, 0, "{swept:?}");
    let requests = recorded
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert_eq!(requests.len(), 1, "one run for the database");
    assert_eq!(requests[0].payload["workspaceId"], json!(workspace));
    assert_eq!(requests[0].payload["clerkOrgId"], "org_sweep");
    assert_eq!(due_at(&master, &workspace).await, Some(next_run_at(now, 3)));
    let run_id = requests[0].payload["runId"]
        .as_str()
        .expect("run")
        .to_owned();
    let trigger: String =
        sqlx::query_scalar("select trigger from stash_planning_runs where id = $1")
            .bind(&run_id)
            .fetch_one(&db)
            .await
            .expect("run");
    assert_eq!(trigger, "schedule");
    sqlx::query("update stash_planning_runs set status = 'done' where id = $1")
        .bind(&run_id)
        .execute(&db)
        .await
        .expect("close");

    // Off: the row goes, until turning it on marks the workspace again.
    sqlx::query("update stash_settings set replenishment_enabled = false where id = 'default'")
        .execute(&db)
        .await
        .expect("off");
    weldsuite_db::due_index::mark_due(&master, SWEEP_KIND, &workspace, now - Duration::days(3650))
        .await;
    run_replenishment_sweep(&master, &tenants, &jobs, &runner.job.events, now).await;
    assert_eq!(due_at(&master, &workspace).await, None);
    assert_eq!(
        recorded
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len(),
        1,
        "no run while off"
    );
    sqlx::query(
        "update stash_settings set replenishment_enabled = true, run_hour_utc = 2 where id = 'default'",
    )
    .execute(&db)
    .await
    .expect("back on");
    runner.actions().await;
    fx.retire().await;
}
