//! WeldStash purchasing through the stash router (phase 1 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`): the purchase order actions,
//! receive and its receipts, product suppliers, and the refusals for a
//! warehouse another system owns (ADR STASH-010). The router runs with the
//! permission gate, the session and tenant layers a request carries in the
//! server, and a recording event bus.
//!
//! The permission checks run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set and returns early
//! otherwise. The database is shared: every row is created with fresh ids
//! and nothing is truncated or assumed empty.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, RecordingEventBus};
use weldsuite_stash::StashState;

const USER: &str = "user_purch_test";

const ALL: &[&str] = &[
    "purchase_orders:read",
    "purchase_orders:create",
    "purchase_orders:update",
    "suppliers:read",
    "suppliers:create",
    "suppliers:update",
    "suppliers:delete",
    "inventory:read",
    "inventory:create",
    "inventory:update",
    "inventory:delete",
    "picklists:create",
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

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

/// An event as the bus got it: `(entityType, action, entityId, data)`.
type Event = (String, String, String, Value);

fn harness(db: PgPool, permissions: &[&str]) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let state = StashState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        http: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let app = weldsuite_stash::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_purch".to_owned()),
                session_id: "sess_purch".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: "ws_purch_test".to_owned(),
                clerk_org_id: Some("org_purch".to_owned()),
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

    /// The events published since the last call, in publishing order.
    async fn events(&self) -> Vec<Event> {
        self.tracker.close();
        self.tracker.wait().await;
        self.tracker.reopen();
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                let text = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
                (
                    text("entityType"),
                    text("action"),
                    text("entityId"),
                    payload["data"].clone(),
                )
            })
            .collect();
        self.bus.clear();
        events
    }

    /// The actions of the events since the last call, as `type:action`.
    async fn actions(&self) -> Vec<String> {
        self.events()
            .await
            .into_iter()
            .map(|(entity, action, _, _)| format!("{entity}:{action}"))
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

fn message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or_default()
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/// Rows with fresh ids: `<key>_<tag>`, within `varchar(30)`.
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

    async fn product(&self, key: &str, lots: bool) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into products (id, name, slug, sku, track_lots, track_expiry, cost_price) \
             values ($1, $2, $1, $3, $4, false, 1.75)",
        )
        .bind(&id)
        .bind(format!("Product {key}"))
        .bind(format!("SKU-{id}"))
        .bind(lots)
        .execute(&self.db)
        .await
        .expect("product");
        id
    }

    async fn variant(&self, key: &str, product: &str) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into product_variants (id, product_id, name, sku) values ($1, $2, $3, $1)",
        )
        .bind(&id)
        .bind(product)
        .bind(format!("Variant {key}"))
        .execute(&self.db)
        .await
        .expect("variant");
        id
    }

    async fn warehouse(&self, key: &str, managed: bool) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into warehouses (id, name, code, managed_by_connection_id) values ($1, $2, $1, $3)",
        )
        .bind(&id)
        .bind(format!("Warehouse {key}"))
        .bind(managed.then(|| self.id("conn")))
        .execute(&self.db)
        .await
        .expect("warehouse");
        id
    }

    async fn location(&self, key: &str, warehouse: &str) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into warehouse_locations (id, warehouse_id, name, code) values ($1, $2, $1, $1)",
        )
        .bind(&id)
        .bind(warehouse)
        .execute(&self.db)
        .await
        .expect("location");
        id
    }

    async fn supplier(&self, key: &str) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into suppliers (id, name, code, currency, default_lead_time_days) \
             values ($1, $2, $3, 'EUR', 12)",
        )
        .bind(&id)
        .bind(format!("Supplier {key}"))
        .bind(format!("S-{key}"))
        .execute(&self.db)
        .await
        .expect("supplier");
        id
    }

    async fn order(
        &self,
        key: &str,
        status: &str,
        warehouse: Option<&str>,
        metadata: Value,
    ) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into purchase_orders (id, po_number, status, warehouse_id, shipping_total, \
             discount_total, metadata) values ($1, $2, $3, $4, 5.00, 1.50, $5)",
        )
        .bind(&id)
        .bind(format!("PO-T-{id}"))
        .bind(status)
        .bind(warehouse)
        .bind(metadata)
        .execute(&self.db)
        .await
        .expect("purchase order");
        id
    }

    /// A line: `ordered` × `price`, `tax`, `total` already worked out.
    #[allow(clippy::too_many_arguments)]
    async fn line(
        &self,
        key: &str,
        order: &str,
        product: Option<&str>,
        ordered: i32,
        price: &str,
        tax: &str,
        total: &str,
    ) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into purchase_order_items (id, purchase_order_id, product_id, name, \
             quantity_ordered, quantity_received, quantity_rejected, quantity_pending, unit_price, \
             tax_amount, total) values ($1, $2, $3, $4, $5, 0, 0, $5, $6::numeric, $7::numeric, $8::numeric)",
        )
        .bind(&id)
        .bind(order)
        .bind(product)
        .bind(format!("Line {key}"))
        .bind(ordered)
        .bind(price)
        .bind(tax)
        .bind(total)
        .execute(&self.db)
        .await
        .expect("line");
        id
    }

    async fn on_hand(&self, product: &str, warehouse: &str) -> i64 {
        sqlx::query_scalar(
            "select coalesce(sum(quantity_on_hand), 0)::bigint from inventory \
             where product_id = $1 and warehouse_id = $2 and deleted_at is null",
        )
        .bind(product)
        .bind(warehouse)
        .fetch_one(&self.db)
        .await
        .expect("on hand")
    }

    async fn receipts(&self, order: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*) from purchase_order_receipts where purchase_order_id = $1",
        )
        .bind(order)
        .fetch_one(&self.db)
        .await
        .expect("receipts")
    }

    async fn adjustments(&self, product: &str) -> i64 {
        sqlx::query_scalar("select count(*) from stock_adjustments where product_id = $1")
            .bind(product)
            .fetch_one(&self.db)
            .await
            .expect("adjustments")
    }

    async fn bucket(&self, key: &str, product: &str, warehouse: &str, on_hand: i32) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into inventory (id, product_id, warehouse_id, quantity_on_hand, \
             quantity_allocated, quantity_available, status) values ($1, $2, $3, $4, 0, $4, 'available')",
        )
        .bind(&id)
        .bind(product)
        .bind(warehouse)
        .bind(on_hand)
        .execute(&self.db)
        .await
        .expect("bucket");
        id
    }
}

fn item<'a>(items: &'a Value, id: &str) -> &'a Value {
    items
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("item {id}"))
}

// ── Without a database ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_routes_check_their_permission_first() {
    let reader = harness(lazy_pool(), &["purchase_orders:read", "suppliers:read"]);
    for (method, path, body) in [
        ("POST", "/purchase-orders/po_x/approve", None),
        (
            "POST",
            "/purchase-orders/po_x/mark-ordered",
            Some(json!({})),
        ),
        ("POST", "/purchase-orders/po_x/cancel", None),
        ("POST", "/purchase-orders/po_x/close", None),
        (
            "POST",
            "/purchase-orders/po_x/receive",
            Some(json!({ "idempotencyKey": "k", "lines": [{ "itemId": "a", "quantity": 1 }] })),
        ),
        ("POST", "/product-suppliers", Some(json!({}))),
        ("PATCH", "/product-suppliers/psup_x", Some(json!({}))),
        ("DELETE", "/product-suppliers/psup_x", None),
    ] {
        let (status, _) = reader.call(method, path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    let nobody = harness(lazy_pool(), &[]);
    for path in ["/purchase-orders/po_x/receipts", "/product-suppliers"] {
        let (status, _) = nobody.call("GET", path, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "GET {path}");
    }
    assert_eq!(reader.actions().await, Vec::<String>::new());

    // A bad body is refused before any query.
    let writer = harness(lazy_pool(), ALL);
    for (path, body) in [
        (
            "/purchase-orders/po_x/receive",
            json!({ "lines": [{ "itemId": "a", "quantity": 1 }] }),
        ),
        (
            "/purchase-orders/po_x/receive",
            json!({ "idempotencyKey": "k", "lines": [] }),
        ),
        (
            "/purchase-orders/po_x/mark-ordered",
            json!({ "orderDate": "someday" }),
        ),
        (
            "/product-suppliers",
            json!({ "productId": "p", "supplierId": "s", "currency": "EURO" }),
        ),
    ] {
        let (status, _) = writer.call("POST", path, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "POST {path}");
    }
}

// ── Purchase orders ─────────────────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines)] // one purchase order through every step
async fn a_purchase_order_goes_from_draft_to_closed() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let product = fx.product("p", false).await;
    let warehouse = fx.warehouse("w", false).await;
    let po = fx.order("po", "draft", Some(&warehouse), json!({})).await;
    // 10 x 2.50 with 21% tax, and 2 x 10.00 without a product or tax.
    let l1 = fx
        .line("l1", &po, Some(&product), 10, "2.50", "5.25", "30.25")
        .await;
    let l2 = fx.line("l2", &po, None, 2, "10.00", "0", "20.00").await;
    let path = |action: &str| format!("/purchase-orders/{po}/{action}");

    let (status, body) = h.call("POST", &path("approve"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let order = &body["data"];
    assert_eq!(order["status"], "approved");
    assert_eq!(order["approvedBy"], USER);
    assert!(order["approvedAt"].is_string());
    assert_eq!(order["itemCount"], 2);
    assert_eq!(order["totalQuantityOrdered"], 12);
    assert_eq!(order["totalQuantityReceived"], 0);
    assert_eq!(order["subtotal"], "45.00");
    assert_eq!(order["taxTotal"], "5.25");
    assert_eq!(order["total"], "53.75");
    let events = h.events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (
            events[0].0.as_str(),
            events[0].1.as_str(),
            events[0].2.as_str()
        ),
        ("purchase_order", "approved", po.as_str())
    );
    assert_eq!(events[0].3["approvedBy"], USER);
    assert_eq!(events[0].3["status"], "approved");

    let (status, body) = h.call("POST", &path("approve"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "Only a draft or pending purchase order can be approved (this one is approved)"
    );
    let (status, _) = h.call("POST", &path("close"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = h
        .call("POST", &path("receive"), Some(json!({ "idempotencyKey": fx.id("k0"), "lines": [{ "itemId": l1, "quantity": 0 }] })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "nothing to receive");

    let (status, body) = h
        .call(
            "POST",
            &path("mark-ordered"),
            Some(json!({ "expectedDate": "2026-12-01" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "ordered");
    assert_eq!(body["data"]["expectedDate"], "2026-12-01T00:00:00.000Z");
    assert!(body["data"]["orderDate"].is_string());
    let (status, _) = h.call("POST", &path("mark-ordered"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(h.actions().await, ["purchase_order:ordered"]);

    // A partial receipt: 4 in, 1 rejected.
    let k1 = fx.id("k1");
    let receive_1 = json!({
        "idempotencyKey": k1,
        "lines": [{ "itemId": l1, "quantity": 4, "rejected": 1 }],
        "notes": "first pallet",
    });
    let (status, body) = h
        .call("POST", &path("receive"), Some(receive_1.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let data = &body["data"];
    assert_eq!(data["purchaseOrder"]["status"], "partial");
    assert_eq!(data["purchaseOrder"]["totalQuantityReceived"], 4);
    assert!(data["purchaseOrder"]["receivedDate"].is_null());
    let line = item(&data["items"], &l1);
    assert_eq!(line["quantityReceived"], 4);
    assert_eq!(line["quantityRejected"], 1);
    assert_eq!(line["quantityPending"], 6);
    assert!(line["lastReceivedDate"].is_string());
    let receipt = &data["receipt"];
    let receipt_id = receipt["id"].as_str().expect("receipt id").to_owned();
    assert_eq!(receipt["idempotencyKey"], k1);
    assert_eq!(receipt["purchaseOrderId"], po);
    assert_eq!(receipt["receivedBy"], USER);
    assert_eq!(receipt["notes"], "first pallet");
    let adjustment = receipt["lines"][0]["adjustmentIds"][0]
        .as_str()
        .expect("adjustment id")
        .to_owned();
    assert_eq!(receipt["lines"][0]["rejected"], 1);
    assert_eq!(fx.on_hand(&product, &warehouse).await, 4);
    let posted: (
        String,
        i32,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "select type, adjustment_quantity, source_type, source_id, source_number, performed_by \
         from stock_adjustments where id = $1",
    )
    .bind(&adjustment)
    .fetch_one(&db)
    .await
    .expect("adjustment");
    assert_eq!(posted.0, "received");
    assert_eq!(posted.1, 4);
    assert_eq!(posted.2.as_deref(), Some("purchase_order"));
    assert_eq!(posted.3.as_deref(), Some(po.as_str()));
    assert_eq!(posted.4, Some(format!("PO-T-{po}")));
    assert_eq!(posted.5.as_deref(), Some(USER));
    let cost: Option<String> = sqlx::query_scalar(
        "select unit_cost::text from inventory where product_id = $1 and warehouse_id = $2",
    )
    .bind(&product)
    .bind(&warehouse)
    .fetch_one(&db)
    .await
    .expect("cost");
    assert_eq!(cost.as_deref(), Some("2.50"));
    let events = h.events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (events[0].0.as_str(), events[0].1.as_str()),
        ("purchase_order", "received")
    );
    assert_eq!(events[0].3["receiptId"], receipt_id.as_str());
    assert_eq!(events[0].3["status"], "partial");
    assert_eq!(events[0].3["lines"][0]["quantity"], 4);

    // The same key again: the stored receipt, nothing posted.
    let (status, body) = h.call("POST", &path("receive"), Some(receive_1)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["receipt"]["id"], receipt_id.as_str());
    assert_eq!(fx.on_hand(&product, &warehouse).await, 4);
    assert_eq!(fx.receipts(&po).await, 1);
    assert_eq!(h.actions().await, Vec::<String>::new());

    // More than is left (10 - 4 - 1 = 5).
    let (status, body) = h
        .call("POST", &path("receive"), Some(json!({ "idempotencyKey": fx.id("k2x"), "lines": [{ "itemId": l1, "quantity": 6 }] })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "Cannot receive 6 of Line l1: only 5 left to receive"
    );
    assert_eq!(fx.on_hand(&product, &warehouse).await, 4);
    assert_eq!(fx.receipts(&po).await, 1);

    let (status, _) = h.call("POST", &path("cancel"), None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a partial order can't be cancelled"
    );

    // The rest: every line is in.
    let (status, body) = h
        .call(
            "POST",
            &path("receive"),
            Some(json!({ "idempotencyKey": fx.id("k2"), "lines": [
                { "itemId": l1, "quantity": 5 },
                { "itemId": l2, "quantity": 2 },
            ] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let order = &body["data"]["purchaseOrder"];
    assert_eq!(order["status"], "received");
    assert!(order["receivedDate"].is_string());
    assert_eq!(order["totalQuantityReceived"], 11);
    assert_eq!(order["total"], "53.75");
    assert_eq!(item(&body["data"]["items"], &l2)["quantityReceived"], 2);
    assert_eq!(
        body["data"]["receipt"]["lines"][1]["adjustmentIds"],
        json!([]),
        "a line without a product posts nothing"
    );
    assert_eq!(fx.on_hand(&product, &warehouse).await, 9);
    assert_eq!(h.actions().await, ["purchase_order:received"]);

    let (status, body) = h
        .call("POST", &path("receive"), Some(json!({ "idempotencyKey": fx.id("k3"), "lines": [{ "itemId": l1, "quantity": 0, "rejected": 0 }] })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "Only an approved, ordered or partially received purchase order can be received (this one is received)"
    );

    let (status, body) = h.call("GET", &path("receipts"), None).await;
    assert_eq!(status, StatusCode::OK);
    let list = body["data"].as_array().expect("receipts");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["idempotencyKey"], fx.id("k2"), "newest first");
    assert_eq!(list[1]["id"], receipt_id.as_str());
    assert_eq!(body["pagination"]["totalCount"], 2);
    assert_eq!(body["pagination"]["hasMore"], false);

    let (status, body) = h.call("POST", &path("close"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "closed");
    let (status, _) = h.call("POST", &path("close"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(h.actions().await, ["purchase_order:closed"]);
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one refusal after another
async fn cancelling_and_the_refusals() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);

    // Draft -> cancelled; then nothing else.
    let draft = fx.order("pod", "draft", None, json!({})).await;
    let (status, body) = h
        .call("POST", &format!("/purchase-orders/{draft}/cancel"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "cancelled");
    assert_eq!(h.actions().await, ["purchase_order:cancelled"]);
    let (status, _) = h
        .call("POST", &format!("/purchase-orders/{draft}/approve"), None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Units received by hand (the CRUD line route allows it) block a cancel.
    let ordered = fx.order("poo", "ordered", None, json!({})).await;
    let line = fx.line("lo", &ordered, None, 3, "1.00", "0", "3.00").await;
    sqlx::query("update purchase_order_items set quantity_received = 1 where id = $1")
        .bind(&line)
        .execute(&db)
        .await
        .expect("received by hand");
    let (status, body) = h
        .call("POST", &format!("/purchase-orders/{ordered}/cancel"), None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "A purchase order with received units cannot be cancelled"
    );

    // Sent to Odoo: every action refused.
    let odoo = fx
        .order(
            "poodoo",
            "approved",
            None,
            json!({ "odoo": { "id": 7, "name": "P00007" } }),
        )
        .await;
    let odoo_line = fx.line("lodoo", &odoo, None, 1, "1.00", "0", "1.00").await;
    for (action, body) in [
        ("approve", None),
        ("mark-ordered", None),
        ("cancel", None),
        ("close", None),
        (
            "receive",
            Some(
                json!({ "idempotencyKey": fx.id("kodoo"), "lines": [{ "itemId": odoo_line, "quantity": 1 }] }),
            ),
        ),
    ] {
        let (status, body) = h
            .call("POST", &format!("/purchase-orders/{odoo}/{action}"), body)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{action}");
        assert_eq!(
            message(&body),
            "This purchase order is managed in Odoo",
            "{action}"
        );
    }

    // Unknown purchase order.
    let missing = fx.id("pomissing");
    for (method, action, body) in [
        ("POST", "approve", None),
        ("POST", "cancel", None),
        ("GET", "receipts", None),
        (
            "POST",
            "receive",
            Some(
                json!({ "idempotencyKey": fx.id("kmissing"), "lines": [{ "itemId": "x", "quantity": 1 }] }),
            ),
        ),
    ] {
        let (status, _) = h
            .call(
                method,
                &format!("/purchase-orders/{missing}/{action}"),
                body,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{action}");
    }

    // No destination warehouse: a product line can't come in, a line
    // without a product can.
    let product = fx.product("p", false).await;
    let no_warehouse = fx.order("ponw", "approved", None, json!({})).await;
    let product_line = fx
        .line(
            "lnwp",
            &no_warehouse,
            Some(&product),
            2,
            "1.00",
            "0",
            "2.00",
        )
        .await;
    let plain_line = fx
        .line("lnwx", &no_warehouse, None, 2, "1.00", "0", "2.00")
        .await;
    let receive = |key: &str, lines: Value| json!({ "idempotencyKey": fx.id(key), "lines": lines });
    let path = |order: &str| format!("/purchase-orders/{order}/receive");
    let (status, body) = h
        .call(
            "POST",
            &path(&no_warehouse),
            Some(receive(
                "knw1",
                json!([{ "itemId": product_line, "quantity": 1 }]),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "Purchase order has no destination warehouse"
    );
    let shared_key = fx.id("knw2");
    let (status, body) = h
        .call("POST", &path(&no_warehouse), Some(json!({ "idempotencyKey": shared_key, "lines": [{ "itemId": plain_line, "quantity": 2 }] })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["purchaseOrder"]["status"], "partial");
    h.events().await;

    // A lot-tracked product needs its lot; the refusal writes nothing.
    let warehouse = fx.warehouse("w", false).await;
    let lots = fx.product("pl", true).await;
    let lot_order = fx
        .order("polot", "ordered", Some(&warehouse), json!({}))
        .await;
    let lot_line = fx
        .line("llot", &lot_order, Some(&lots), 5, "3.00", "0", "15.00")
        .await;
    let (status, body) = h
        .call(
            "POST",
            &path(&lot_order),
            Some(receive(
                "klot1",
                json!([{ "itemId": lot_line, "quantity": 2 }]),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        format!("Product SKU-{lots} is lot-tracked — lotNumber is required when receiving stock")
    );
    assert_eq!(body["error"]["details"]["code"], "LOT_REQUIRED");
    assert_eq!(fx.receipts(&lot_order).await, 0);
    assert_eq!(fx.on_hand(&lots, &warehouse).await, 0);
    let received: i32 =
        sqlx::query_scalar("select quantity_received from purchase_order_items where id = $1")
            .bind(&lot_line)
            .fetch_one(&db)
            .await
            .expect("line");
    assert_eq!(received, 0);
    let (status, body) = h
        .call(
            "POST",
            &path(&lot_order),
            Some(receive("klot2", json!([{ "itemId": lot_line, "quantity": 2, "lotNumber": "LOT-7", "expiryDate": "2027-06-30" }]))),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let lot: (i32, Option<String>) = sqlx::query_as(
        "select quantity_on_hand, to_char(expiry_date, 'YYYY-MM-DD') from inventory \
         where product_id = $1 and lot_number = 'LOT-7'",
    )
    .bind(&lots)
    .fetch_one(&db)
    .await
    .expect("lot bucket");
    assert_eq!(lot, (2, Some("2027-06-30".to_owned())));

    // A warehouse another system owns takes nothing.
    let managed = fx.warehouse("wm", true).await;
    let managed_order = fx.order("pom", "approved", Some(&managed), json!({})).await;
    let managed_line = fx
        .line("lm", &managed_order, Some(&product), 3, "1.00", "0", "3.00")
        .await;
    let (status, body) = h
        .call(
            "POST",
            &path(&managed_order),
            Some(receive(
                "km",
                json!([{ "itemId": managed_line, "quantity": 3 }]),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "This warehouse's stock is managed by another system"
    );
    assert_eq!(body["error"]["details"]["code"], "WAREHOUSE_MANAGED");
    assert_eq!(fx.receipts(&managed_order).await, 0);

    // Lines: unknown, repeated, a location elsewhere; then a location here.
    let other = fx.warehouse("wo", false).await;
    let elsewhere = fx.location("locx", &other).await;
    let here = fx.location("loch", &warehouse).await;
    let checked = fx
        .order("poc", "approved", Some(&warehouse), json!({}))
        .await;
    let checked_line = fx
        .line("lc", &checked, Some(&product), 4, "1.00", "0", "4.00")
        .await;
    for (key, lines, expected) in [
        (
            "kc1",
            json!([{ "itemId": "poi_nope", "quantity": 1 }]),
            "Line poi_nope is not on this purchase order".to_owned(),
        ),
        (
            "kc2",
            json!([{ "itemId": checked_line, "quantity": 1 }, { "itemId": checked_line, "quantity": 1 }]),
            format!("Line {checked_line} is listed more than once"),
        ),
        (
            "kc3",
            json!([{ "itemId": checked_line, "quantity": 1, "locationId": elsewhere }]),
            format!("Location {elsewhere} is not in the purchase order's warehouse"),
        ),
    ] {
        let (status, body) = h
            .call("POST", &path(&checked), Some(receive(key, lines)))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{key}");
        assert_eq!(message(&body), expected, "{key}");
    }
    let (status, body) = h
        .call(
            "POST",
            &path(&checked),
            Some(receive(
                "kc4",
                json!([{ "itemId": checked_line, "quantity": 4, "locationId": here }]),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["purchaseOrder"]["status"], "received");
    let at_location: i32 = sqlx::query_scalar(
        "select quantity_on_hand from inventory where product_id = $1 and location_id = $2",
    )
    .bind(&product)
    .bind(&here)
    .fetch_one(&db)
    .await
    .expect("bucket at the location");
    assert_eq!(at_location, 4);

    // A key already used on another purchase order.
    let (status, body) = h
        .call("POST", &path(&checked), Some(json!({ "idempotencyKey": shared_key, "lines": [{ "itemId": checked_line, "quantity": 0, "rejected": 0 }] })))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        message(&body),
        "This idempotency key was already used for another purchase order"
    );

    // Pending orders approve too; a pending order cancels.
    let pending = fx.order("pop", "pending", None, json!({})).await;
    let (status, body) = h
        .call("POST", &format!("/purchase-orders/{pending}/approve"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["itemCount"], 0);
    assert_eq!(
        body["data"]["total"], "3.50",
        "shipping 5.00 less discount 1.50"
    );
}

// ── Product suppliers ───────────────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines)] // the preferred-supplier rule end to end
async fn product_suppliers_keep_one_preferred_supplier() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let product = fx.product("p", false).await;
    let other_product = fx.product("p2", false).await;
    let variant = fx.variant("v", &product).await;
    let foreign_variant = fx.variant("v2", &other_product).await;
    let (s1, s2, s3) = (
        fx.supplier("s1").await,
        fx.supplier("s2").await,
        fx.supplier("s3").await,
    );
    let create = |body: Value| h.call("POST", "/product-suppliers", Some(body));

    // The first link is preferred, whatever the body says.
    let (status, body) = create(json!({
        "productId": product, "supplierId": s1, "isPreferred": false, "unitCost": 2.125,
        "currency": "EUR", "leadTimeDays": 10, "minOrderQty": 12, "orderMultiple": 6,
        "supplierSku": "AC-1", "supplierProductName": "Lamp, warm white",
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first = &body["data"];
    let link1 = first["id"].as_str().expect("id").to_owned();
    assert!(link1.starts_with("psup_"));
    assert_eq!(first["isPreferred"], true);
    assert_eq!(first["unitCost"], "2.1250");
    assert_eq!(first["orderMultiple"], 6);
    assert_eq!(first["minOrderQty"], 12);
    assert_eq!(first["leadTimeDays"], 10);
    assert_eq!(first["supplierName"], "Supplier s1");
    assert_eq!(first["supplierCode"], "S-s1");
    assert_eq!(first["supplierCurrency"], "EUR");
    assert_eq!(first["supplierLeadTimeDays"], 12);
    assert_eq!(first["productName"], "Product p");
    assert_eq!(first["productSku"], format!("SKU-{product}"));
    assert!(first["variantId"].is_null());
    assert!(
        first["createdAt"]
            .as_str()
            .is_some_and(|at| at.ends_with('Z'))
    );
    let events = h.events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (events[0].0.as_str(), events[0].1.as_str()),
        ("product_supplier", "created")
    );
    assert_eq!(
        events[0].3,
        json!({ "id": link1, "productId": product, "variantId": null, "supplierId": s1, "isPreferred": true })
    );

    let (status, body) = create(json!({ "productId": product, "supplierId": s1 })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        message(&body),
        "This supplier is already linked to this product"
    );
    for body in [
        json!({ "productId": fx.id("nope"), "supplierId": s1 }),
        json!({ "productId": product, "supplierId": fx.id("nope") }),
        json!({ "productId": product, "variantId": fx.id("nope"), "supplierId": s1 }),
        json!({ "productId": product, "variantId": foreign_variant, "supplierId": s1 }),
    ] {
        let (status, _) = create(body.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }
    assert_eq!(h.actions().await, Vec::<String>::new());

    // isPreferred takes the preference; the first link loses it (and says so).
    let (status, body) =
        create(json!({ "productId": product, "supplierId": s2, "isPreferred": true })).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let link2 = body["data"]["id"].as_str().expect("id").to_owned();
    assert_eq!(body["data"]["isPreferred"], true);
    assert_eq!(body["data"]["orderMultiple"], 1);
    assert!(body["data"]["unitCost"].is_null());
    let events = h.events().await;
    assert_eq!(events.len(), 2);
    assert_eq!(
        (events[0].1.as_str(), events[0].2.as_str()),
        ("created", link2.as_str())
    );
    assert_eq!(
        (events[1].1.as_str(), events[1].2.as_str()),
        ("updated", link1.as_str())
    );
    assert_eq!(events[1].3["isPreferred"], false);
    let (status, body) = create(json!({ "productId": product, "supplierId": s3 })).await;
    assert_eq!(status, StatusCode::CREATED);
    let link3 = body["data"]["id"].as_str().expect("id").to_owned();
    assert_eq!(body["data"]["isPreferred"], false);
    // A variant's links are their own: its first is preferred too.
    let (status, body) =
        create(json!({ "productId": product, "variantId": variant, "supplierId": s1 })).await;
    assert_eq!(status, StatusCode::CREATED);
    let link_v = body["data"]["id"].as_str().expect("id").to_owned();
    assert_eq!(body["data"]["isPreferred"], true);
    h.events().await;

    let ids = |body: &Value| -> Vec<String> {
        body["data"]
            .as_array()
            .expect("list")
            .iter()
            .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
            .collect()
    };
    let (status, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        ids(&body),
        [
            link2.as_str(),
            link_v.as_str(),
            link1.as_str(),
            link3.as_str()
        ],
        "preferred first, then oldest"
    );
    assert_eq!(
        body["pagination"],
        json!({ "totalCount": 4, "hasMore": false, "cursor": null })
    );
    let (_, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}&variantId=none"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [link2.as_str(), link1.as_str(), link3.as_str()]);
    let (_, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}&variantId={variant}"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [link_v.as_str()]);
    let (_, body) = h
        .call("GET", &format!("/product-suppliers?supplierId={s1}"), None)
        .await;
    assert_eq!(ids(&body), [link_v.as_str(), link1.as_str()]);

    // PATCH: terms, a cleared field, and the preference back.
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/product-suppliers/{link1}"),
            Some(json!({ "isPreferred": true, "leadTimeDays": null, "unitCost": 1.5, "productId": other_product })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["isPreferred"], true);
    assert!(body["data"]["leadTimeDays"].is_null());
    assert_eq!(body["data"]["unitCost"], "1.5000");
    assert_eq!(body["data"]["supplierSku"], "AC-1", "left out, kept");
    assert_eq!(body["data"]["productId"], product, "the item can't change");
    let events = h.events().await;
    assert_eq!(
        events
            .iter()
            .map(|e| (e.1.as_str(), e.2.as_str()))
            .collect::<Vec<_>>(),
        [("updated", link1.as_str()), ("updated", link2.as_str())]
    );
    let (_, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}&variantId=none"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [link1.as_str(), link2.as_str(), link3.as_str()]);
    let (_, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}&variantId={variant}"),
            None,
        )
        .await;
    assert_eq!(
        body["data"][0]["isPreferred"], true,
        "the variant's link is untouched"
    );
    let (status, _) = h
        .call(
            "PATCH",
            &format!("/product-suppliers/{}", fx.id("psupnope")),
            Some(json!({ "unitCost": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = h
        .call(
            "PATCH",
            &format!("/product-suppliers/{link1}"),
            Some(json!({ "orderMultiple": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Unlinking the preferred supplier passes the preference to the oldest
    // remaining link.
    let (status, _) = h
        .call("DELETE", &format!("/product-suppliers/{link1}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let events = h.events().await;
    assert_eq!(
        events
            .iter()
            .map(|e| (e.1.as_str(), e.2.as_str()))
            .collect::<Vec<_>>(),
        [("deleted", link1.as_str()), ("updated", link2.as_str())]
    );
    assert_eq!(
        events[0].3,
        json!({ "id": link1, "productId": product, "variantId": null, "supplierId": s1 })
    );
    assert_eq!(events[1].3["isPreferred"], true);
    let (_, body) = h
        .call(
            "GET",
            &format!("/product-suppliers?productId={product}&variantId=none"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [link2.as_str(), link3.as_str()]);
    assert_eq!(body["data"][0]["isPreferred"], true);
    let (status, _) = h
        .call("DELETE", &format!("/product-suppliers/{link1}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Unlinking a supplier that isn't preferred changes no other link.
    let (status, _) = h
        .call("DELETE", &format!("/product-suppliers/{link3}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(h.actions().await, ["product_supplier:deleted"]);
    // And a supplier can be linked again once unlinked.
    let (status, _) = create(json!({ "productId": product, "supplierId": s1 })).await;
    assert_eq!(status, StatusCode::CREATED);
}

/// Wait until a request is blocked on an item's product supplier lock
/// another transaction holds; `false` if it never is.
async fn blocked_on_item(db: &PgPool) -> bool {
    for _ in 0..5_000 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() \
             and wait_event_type = 'Lock' and wait_event = 'advisory' \
             and query like '%hashtext(''product_suppliers:''%'",
        )
        .fetch_one(db)
        .await
        .expect("pg_stat_activity");
        if waiting > 0 {
            return true;
        }
        tokio::task::yield_now().await;
    }
    false
}

#[tokio::test]
async fn a_delete_that_lost_the_race_answers_not_found() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let product = fx.product("p", false).await;
    let supplier = fx.supplier("s").await;
    let (status, body) = h
        .call(
            "POST",
            "/product-suppliers",
            Some(json!({ "productId": product, "supplierId": supplier })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let link = body["data"]["id"].as_str().expect("id").to_owned();
    h.events().await;

    // Another delete holds the item's lock and has unlinked the supplier,
    // not yet committed: this one still finds the link, then waits.
    let mut held = db.begin().await.expect("begin");
    sqlx::query("select pg_advisory_xact_lock(hashtext('product_suppliers:' || $1 || ':'))")
        .bind(&product)
        .execute(&mut *held)
        .await
        .expect("item lock");
    sqlx::query("update product_suppliers set deleted_at = now() where id = $1")
        .bind(&link)
        .execute(&mut *held)
        .await
        .expect("unlink");
    let release = async {
        let blocked = blocked_on_item(&db).await;
        held.commit().await.expect("commit");
        blocked
    };
    let path = format!("/product-suppliers/{link}");
    let ((status, body), blocked) = tokio::join!(h.call("DELETE", &path, None), release);
    assert!(blocked, "the delete waited for the other one");
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        h.actions().await,
        Vec::<String>::new(),
        "no second product_supplier.deleted"
    );
}

// ── Warehouses another system owns ──────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines)] // every stock write path
async fn a_managed_warehouse_refuses_every_stock_write() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let product = fx.product("p", false).await;
    let managed = fx.warehouse("wm", true).await;
    let open = fx.warehouse("wu", false).await;
    let managed_bucket = fx.bucket("invm", &product, &managed, 10).await;
    let open_bucket = fx.bucket("invu", &product, &open, 10).await;
    let refused = |status: StatusCode, body: &Value, what: &str| {
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert_eq!(
            message(body),
            "This warehouse's stock is managed by another system",
            "{what}"
        );
        assert_eq!(
            body["error"]["details"]["code"], "WAREHOUSE_MANAGED",
            "{what}"
        );
    };

    let adjust = |warehouse: &str| json!({ "productId": product, "warehouseId": warehouse, "delta": 5, "reason": "count" });
    let (status, body) = h
        .call("POST", "/inventory/adjust", Some(adjust(&managed)))
        .await;
    refused(status, &body, "adjust");
    let (status, body) = h
        .call("POST", "/inventory/adjust", Some(adjust(&open)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fx.on_hand(&product, &open).await, 15);
    assert_eq!(fx.on_hand(&product, &managed).await, 10);

    let before = fx.adjustments(&product).await;
    for (from, to) in [(&open, &managed), (&managed, &open)] {
        let (status, body) = h
            .call(
                "POST",
                "/inventory/transfer",
                Some(json!({ "productId": product, "quantity": 1, "from": { "warehouseId": from }, "to": { "warehouseId": to } })),
            )
            .await;
        refused(status, &body, "transfer");
    }
    assert_eq!(fx.adjustments(&product).await, before, "no leg posted");
    assert_eq!(fx.on_hand(&product, &open).await, 15);

    let (status, body) = h
        .call(
            "POST",
            "/inventory",
            Some(json!({ "productId": product, "warehouseId": managed, "lotNumber": "x" })),
        )
        .await;
    refused(status, &body, "create bucket");
    let (status, body) = h
        .call(
            "POST",
            "/inventory",
            Some(json!({ "productId": product, "warehouseId": open, "lotNumber": fx.id("lot") })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/inventory/{managed_bucket}"),
            Some(json!({ "batchNumber": "B1" })),
        )
        .await;
    refused(status, &body, "patch bucket");
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/inventory/{open_bucket}"),
            Some(json!({ "batchNumber": "B1" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = h
        .call("DELETE", &format!("/inventory/{managed_bucket}"), None)
        .await;
    refused(status, &body, "delete bucket");

    // Putaway into it.
    let task = fx.id("put");
    sqlx::query(
        "insert into inventory_movements (id, movement_number, movement_type, status, \
         dest_warehouse_id, product_id, quantity) values ($1, $1, 'putaway', 'pending', $2, $3, 3)",
    )
    .bind(&task)
    .bind(&managed)
    .bind(&product)
    .execute(&db)
    .await
    .expect("putaway task");
    let location = fx.location("loc", &managed).await;
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/putaway/{task}/complete"),
            Some(json!({ "locationId": location })),
        )
        .await;
    refused(status, &body, "putaway");
    assert_eq!(fx.on_hand(&product, &managed).await, 10);

    // A pick list from it.
    let order = fx.id("ord");
    sqlx::query("insert into orders (id, order_number) values ($1, $1)")
        .bind(&order)
        .execute(&db)
        .await
        .expect("order");
    let (status, body) = h
        .call(
            "POST",
            "/pick-lists/generate",
            Some(json!({ "orderId": order, "warehouseId": managed })),
        )
        .await;
    refused(status, &body, "pick list");
    let lists: i64 =
        sqlx::query_scalar("select count(*) from pick_lists where order_ids @> $1::jsonb")
            .bind(json!([order]))
            .fetch_one(&db)
            .await
            .expect("pick lists");
    assert_eq!(lists, 0);

    // Only the open warehouse's writes published anything.
    let actions = h.actions().await;
    assert_eq!(
        actions,
        [
            "inventory:updated",
            "inventory:created",
            "inventory:updated"
        ],
        "{actions:?}"
    );

    // Nor can a patch move an open bucket into it: not to one of its
    // locations, and not by naming it (the update schema drops `warehouseId`).
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/inventory/{open_bucket}"),
            Some(json!({ "locationId": location })),
        )
        .await;
    refused(status, &body, "patch to a managed location");
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/inventory/{open_bucket}"),
            Some(json!({ "warehouseId": managed, "batchNumber": "B2" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let open_location = fx.location("locu", &open).await;
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/inventory/{open_bucket}"),
            Some(json!({ "locationId": open_location })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let bucket: (String, Option<String>, Option<String>) = sqlx::query_as(
        "select warehouse_id, location_id, batch_number from inventory where id = $1",
    )
    .bind(&open_bucket)
    .fetch_one(&db)
    .await
    .expect("open bucket");
    assert_eq!(
        bucket,
        (open.clone(), Some(open_location), Some("B2".to_owned())),
        "still in the open warehouse"
    );
    assert_eq!(fx.on_hand(&product, &managed).await, 10);
    assert_eq!(
        h.actions().await,
        ["inventory:updated", "inventory:updated"]
    );
}

// ── Receive is one transaction ──────────────────────────────────────────────

/// A received line, as the database holds it: received, rejected.
async fn line_units(db: &PgPool, line: &str) -> (i32, i32) {
    sqlx::query_as(
        "select quantity_received, quantity_rejected from purchase_order_items where id = $1",
    )
    .bind(line)
    .fetch_one(db)
    .await
    .expect("line")
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // a failure, its rollback and the retry
async fn a_receive_that_fails_midway_leaves_nothing_and_the_retry_posts_once() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let warehouse = fx.warehouse("w", false).await;
    // Lines post by product id: `pa` first, then `pz`.
    let first = fx.product("pa", false).await;
    let second = fx.product("pz", false).await;
    let po = fx.order("po", "ordered", Some(&warehouse), json!({})).await;
    let l1 = fx
        .line("l1", &po, Some(&first), 4, "2.00", "0", "8.00")
        .await;
    let l2 = fx.line("l2", &po, None, 2, "1.00", "0", "2.00").await;
    // Its unit price passes every check, but 5 of them overflow the new
    // bucket's `total_value` (numeric(18,2)): the database refuses the
    // second post, after the first line is posted inside the transaction.
    let l3 = fx
        .line(
            "l3",
            &po,
            Some(&second),
            5,
            "9000000000000000.00",
            "0",
            "9000000000000000.00",
        )
        .await;
    let key = fx.id("k");
    let body = json!({ "idempotencyKey": key, "lines": [
        { "itemId": l1, "quantity": 4 },
        { "itemId": l2, "quantity": 1, "rejected": 1 },
        { "itemId": l3, "quantity": 5 },
    ] });
    let path = format!("/purchase-orders/{po}/receive");

    let (status, failed) = h.call("POST", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failed}");
    assert_eq!(message(&failed), "Failed to receive purchase order");
    // Nothing posted, nothing recorded, the key still free.
    assert_eq!(fx.on_hand(&first, &warehouse).await, 0);
    assert_eq!(fx.adjustments(&first).await, 0);
    assert_eq!(fx.adjustments(&second).await, 0);
    let buckets: i64 =
        sqlx::query_scalar("select count(*) from inventory where product_id = any($1)")
            .bind(vec![first.clone(), second.clone()])
            .fetch_one(&db)
            .await
            .expect("buckets");
    assert_eq!(buckets, 0);
    let rolled_up: Option<i32> =
        sqlx::query_scalar("select inventory_quantity from products where id = $1")
            .bind(&first)
            .fetch_one(&db)
            .await
            .expect("roll-up");
    assert_eq!(rolled_up.unwrap_or(0), 0);
    assert_eq!(fx.receipts(&po).await, 0);
    for line in [&l1, &l2, &l3] {
        assert_eq!(line_units(&db, line).await, (0, 0), "{line}");
    }
    let order: (String, Option<i32>) =
        sqlx::query_as("select status, total_quantity_received from purchase_orders where id = $1")
            .bind(&po)
            .fetch_one(&db)
            .await
            .expect("order");
    assert_eq!(order.0, "ordered");
    assert_eq!(h.actions().await, Vec::<String>::new());

    // Fixed, the same key goes through, and posts exactly once.
    sqlx::query("update purchase_order_items set unit_price = 3.00, total = 15.00 where id = $1")
        .bind(&l3)
        .execute(&db)
        .await
        .expect("price fixed");
    let (status, done) = h.call("POST", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{done}");
    assert_eq!(done["data"]["purchaseOrder"]["status"], "received");
    assert_eq!(fx.on_hand(&first, &warehouse).await, 4);
    assert_eq!(fx.on_hand(&second, &warehouse).await, 5);
    assert_eq!(fx.adjustments(&first).await, 1);
    assert_eq!(fx.adjustments(&second).await, 1);
    assert_eq!(fx.receipts(&po).await, 1);
    assert_eq!(line_units(&db, &l1).await, (4, 0));
    assert_eq!(line_units(&db, &l2).await, (1, 1));
    let lines = &done["data"]["receipt"]["lines"];
    assert_eq!(lines[0]["adjustmentIds"].as_array().map(Vec::len), Some(1));
    assert_eq!(lines[1]["adjustmentIds"], json!([]));
    assert_eq!(lines[2]["adjustmentIds"].as_array().map(Vec::len), Some(1));
    assert_eq!(h.actions().await, ["purchase_order:received"]);

    // And again: the stored receipt, nothing posted.
    let (status, again) = h.call("POST", &path, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(
        again["data"]["receipt"]["id"],
        done["data"]["receipt"]["id"]
    );
    assert_eq!(fx.on_hand(&first, &warehouse).await, 4);
    assert_eq!(fx.adjustments(&first).await, 1);
}

/// Wait until a receive is blocked on an idempotency key another
/// transaction holds; `false` if it never is.
async fn blocked_on_key(db: &PgPool) -> bool {
    for _ in 0..5_000 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() \
             and wait_event_type = 'Lock' and query like 'insert into purchase_order_receipts%'",
        )
        .fetch_one(db)
        .await
        .expect("pg_stat_activity");
        if waiting > 0 {
            return true;
        }
        tokio::task::yield_now().await;
    }
    false
}

/// Hold `key` in an open transaction, as a request still posting does.
async fn hold_key(
    db: &PgPool,
    order: &str,
    receipt: &str,
    key: &str,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut held = db.begin().await.expect("begin");
    sqlx::query(
        "insert into purchase_order_receipts (id, purchase_order_id, idempotency_key, lines) \
         values ($1, $2, $3, '[]'::jsonb)",
    )
    .bind(receipt)
    .bind(order)
    .bind(key)
    .execute(&mut *held)
    .await
    .expect("held key");
    held
}

#[tokio::test]
async fn a_receive_with_a_key_in_flight_waits_for_it() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let warehouse = fx.warehouse("w", false).await;
    let product = fx.product("p", false).await;
    let po = fx.order("po", "ordered", Some(&warehouse), json!({})).await;
    let line = fx
        .line("l", &po, Some(&product), 10, "1.00", "0", "10.00")
        .await;
    let path = format!("/purchase-orders/{po}/receive");
    let receive =
        |key: &str| json!({ "idempotencyKey": key, "lines": [{ "itemId": line, "quantity": 2 }] });

    // The holder rolls back: the waiting request receives itself.
    let key = fx.id("ka");
    let held = hold_key(&db, &po, &fx.id("porca"), &key).await;
    let release = async {
        let blocked = blocked_on_key(&db).await;
        held.rollback().await.expect("rollback");
        blocked
    };
    let ((status, body), blocked) =
        tokio::join!(h.call("POST", &path, Some(receive(&key))), release);
    assert!(blocked, "the request waited on the key");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(fx.on_hand(&product, &warehouse).await, 2);
    assert_eq!(
        body["data"]["receipt"]["lines"][0]["adjustmentIds"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    // The holder commits: the waiting request replays its receipt and posts
    // nothing.
    let key = fx.id("kb");
    let holder = fx.id("porcb");
    let held = hold_key(&db, &po, &holder, &key).await;
    let release = async {
        let blocked = blocked_on_key(&db).await;
        held.commit().await.expect("commit");
        blocked
    };
    let ((status, body), blocked) =
        tokio::join!(h.call("POST", &path, Some(receive(&key))), release);
    assert!(blocked, "the request waited on the key");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["receipt"]["id"], holder.as_str());
    assert_eq!(fx.on_hand(&product, &warehouse).await, 2);
    assert_eq!(line_units(&db, &line).await, (2, 0));
    assert_eq!(fx.adjustments(&product).await, 1);
}
