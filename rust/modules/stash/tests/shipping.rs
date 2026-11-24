//! WeldStash carrier shipping through the stash router (ADR STASH-011,
//! `weldsuite-documentation/plans/weldstash-carriers.md`): a carrier
//! account, labels for a packed pick list against a fake DHL Parcel
//! (two pieces and a return label), the label file, the refusal of a second
//! label request, voiding, shipping every piece, and a tracking refresh to
//! delivered. The router runs with the permission gate, the session and
//! tenant layers a request carries in the server, an in-memory file store
//! and a recording event bus.
//!
//! The permission checks run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set and returns early
//! otherwise. The database is shared: every row is created with fresh ids.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::{Arc, Mutex};

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
use weldsuite_ports::{
    BoxFuture, DynEventBus, DynFileStore, DynOutboundHttp, HttpRequest, HttpResponse,
    MemoryFileStore, OutboundHttp, PortError, RecordingEventBus,
};
use weldsuite_stash::StashState;
use weldsuite_stash::shipping::Services;

const USER: &str = "user_ship_test";
const DHL: &str = "https://api-gw.dhlparcel.nl";

const ALL: &[&str] = &[
    "carriers:read",
    "carriers:create",
    "carriers:update",
    "carriers:delete",
    "parcels:read",
    "parcels:create",
    "parcels:update",
    "picklists:read",
    "picklists:update",
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

/// A fake DHL Parcel: answers by `METHOD URL` prefix, the longest first.
#[derive(Default)]
struct FakeDhl {
    answers: Mutex<Vec<(String, u16, Vec<u8>)>>,
    calls: Mutex<Vec<String>>,
}

impl FakeDhl {
    fn answer(&self, prefix: &str, status: u16, body: Vec<u8>) {
        if let Ok(mut answers) = self.answers.lock() {
            answers.retain(|(p, _, _)| p != prefix);
            answers.push((prefix.to_owned(), status, body));
        }
    }

    fn json(&self, prefix: &str, status: u16, body: &Value) {
        self.answer(prefix, status, body.to_string().into_bytes());
    }

    fn calls(&self, prefix: &str) -> usize {
        self.calls.lock().map_or(0, |calls| {
            calls.iter().filter(|c| c.starts_with(prefix)).count()
        })
    }
}

impl DynOutboundHttp for FakeDhl {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let key = format!("{} {}", request.method, request.url);
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(key.clone());
        }
        let answer = self.answers.lock().ok().and_then(|answers| {
            answers
                .iter()
                .filter(|(prefix, _, _)| key.starts_with(prefix.as_str()))
                .max_by_key(|(prefix, _, _)| prefix.len())
                .map(|(_, status, body)| HttpResponse::new(*status, body.clone()))
        });
        let response =
            answer.unwrap_or_else(|| HttpResponse::new(599, format!("no answer: {key}").into()));
        Box::pin(std::future::ready(Ok(response)))
    }
}

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
    dhl: Arc<FakeDhl>,
}

/// An event as the bus got it: `(entityType, action, entityId, data)`.
type Event = (String, String, String, Value);

fn harness(db: PgPool, permissions: &[&str]) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let dhl = Arc::new(FakeDhl::default());
    let state = StashState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        http: Some(OutboundHttp(Arc::clone(&dhl) as Arc<dyn DynOutboundHttp>)),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let services = Services {
        master: None,
        files: Some(Arc::new(MemoryFileStore::default()) as Arc<dyn DynFileStore>),
    };
    let app = weldsuite_stash::router(state, &gate)
        .layer(axum::Extension(services))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_ship".to_owned()),
                    session_id: "sess_ship".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_ship_test".to_owned(),
                    clerk_org_id: Some("org_ship".to_owned()),
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
    Harness {
        app,
        bus,
        tracker,
        dhl,
    }
}

impl Harness {
    async fn raw(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Vec<u8>) {
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
        (status, bytes.to_vec())
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (status, bytes) = self.raw(method, path, body).await;
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

#[tokio::test]
async fn every_route_checks_its_permission() {
    let h = harness(lazy_pool(), &["carriers:read", "parcels:read"]);
    for (method, path) in [
        ("POST", "/carriers"),
        ("PATCH", "/carriers/car_x"),
        ("DELETE", "/carriers/car_x"),
        ("POST", "/pick-lists/pl_x/labels"),
        ("DELETE", "/pick-lists/pl_x/labels"),
        ("POST", "/parcels/par_x/refresh-tracking"),
        ("POST", "/parcels/par_x/return-label"),
    ] {
        let (status, _) = h.call(method, path, Some(json!({}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    let h = harness(lazy_pool(), &[]);
    for path in [
        "/carriers",
        "/carriers/catalog",
        "/parcels",
        "/pick-lists/pl_x/shipping",
    ] {
        let (status, _) = h.call("GET", path, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "GET {path}");
    }
}

#[tokio::test]
async fn the_catalog_lists_both_carriers() {
    let h = harness(lazy_pool(), ALL);
    let (status, body) = h.call("GET", "/carriers/catalog", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let codes: Vec<&str> = body["data"]
        .as_array()
        .expect("carriers")
        .iter()
        .filter_map(|c| c["code"].as_str())
        .collect();
    assert_eq!(codes, ["postnl", "dhl_parcel_nl"]);
    // No install credentials, no master database: no WeldSuite contract.
    assert_eq!(body["data"][0]["weldsuiteContract"], false);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

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

    async fn exec(&self, sql: &'static str, binds: &[&str]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&self.db).await.expect(sql);
    }

    /// A packed pick list for an order to a consumer in Amsterdam, with
    /// its draft parcel: `(pick list, draft parcel, order)`.
    async fn packed_pick_list(&self) -> (String, String, String) {
        let (warehouse, product, order, line, list, item, parcel) = (
            self.id("wh"),
            self.id("prod"),
            self.id("ord"),
            self.id("oi"),
            self.id("pl"),
            self.id("pli"),
            self.id("par"),
        );
        self.exec(
            "insert into warehouses (id, name, code, address_line_1, postal_code, city, country) \
             values ($1, 'Main warehouse', $1, 'Keizersgracht 100', '1015 AA', 'Amsterdam', 'NL')",
            &[&warehouse],
        )
        .await;
        self.exec(
            "insert into products (id, name, slug, sku, weight, weight_unit) \
             values ($1, 'Mug', $1, $1, 0.4, 'kg')",
            &[&product],
        )
        .await;
        self.exec(
            "insert into orders (id, order_number, subtotal, total, currency, customer_name, customer_email, shipping_address) \
             values ($1, $1, 20, 20, 'EUR', 'Anna de Vries', 'anna@example.com', \
             '{\"line1\": \"Damrak 1A\", \"city\": \"Amsterdam\", \"postalCode\": \"1012 LG\", \"country\": \"NL\"}'::jsonb)",
            &[&order],
        )
        .await;
        self.exec(
            "insert into order_items (id, order_id, product_id, name, quantity, unit_price, total) \
             values ($1, $2, $3, 'Mug', 2, 10, 20)",
            &[&line, &order, &product],
        )
        .await;
        self.exec(
            "insert into parcels (id, status, order_id, order_number, recipient_name) \
             values ($1, 'draft', $2, $2, 'Anna de Vries')",
            &[&parcel, &order],
        )
        .await;
        self.exec(
            "insert into pick_lists (id, pick_list_number, warehouse_id, status, order_ids, parcel_id) \
             values ($1, $1, $2, 'packed', jsonb_build_array($3::text), $4)",
            &[&list, &warehouse, &order, &parcel],
        )
        .await;
        self.exec(
            "insert into pick_list_items (id, pick_list_id, order_id, order_item_id, product_id, name, quantity_required, quantity_picked, status) \
             values ($1, $2, $3, $4, $5, 'Mug', 2, 2, 'picked')",
            &[&item, &list, &order, &line, &product],
        )
        .await;
        (list, parcel, order)
    }
}

fn capabilities() -> Value {
    json!([{
        "rank": 1,
        "product": { "key": "EPL", "label": "Europlus", "monoColloProduct": false },
        "parcelType": { "key": "SMALL", "minWeightKg": 0, "maxWeightKg": 20 },
        "options": [{ "key": "DOOR" }, { "key": "HANDT" }, { "key": "ADD_RETURN_LABEL" }]
    }])
}

fn dhl_ready(dhl: &FakeDhl) {
    dhl.json(
        &format!("GET {DHL}/capabilities/business?"),
        200,
        &capabilities(),
    );
    dhl.json(
        &format!("POST {DHL}/authenticate/api-key"),
        200,
        &json!({ "accessToken": "tok", "accessTokenExpiration": 4_102_444_800_i64, "accountNumbers": ["01234567"] }),
    );
    dhl.answer(
        &format!("GET {DHL}/labels/"),
        200,
        b"%PDF-1.7 label".to_vec(),
    );
}

fn shipment_answer(tag: &str) -> Value {
    json!({
        "product": "EPL",
        "pieces": [
            { "labelId": format!("lab1-{tag}"), "trackerCode": format!("JVGL1{tag}"), "pieceNumber": 1 },
            { "labelId": format!("lab2-{tag}"), "trackerCode": format!("JVGL2{tag}"), "pieceNumber": 2 }
        ],
        "returnShipment": { "pieces": [{ "labelId": format!("labr-{tag}"), "trackerCode": format!("JVGLR{tag}"), "pieceNumber": 1 }] }
    })
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one flow, step by step")]
async fn a_packed_pick_list_gets_labels_ships_and_is_tracked() {
    let Some(db) = tenant() else { return };
    let h = harness(db.clone(), ALL);
    let fx = Fx::new(&db);
    let (list, draft, order) = fx.packed_pick_list().await;

    // An account on the workspace's own contract (not tested at DHL here).
    let (status, body) = h
        .call(
            "POST",
            "/carriers",
            Some(json!({
                "code": "dhl_parcel_nl",
                "contract": "own",
                "name": format!("DHL {}", fx.tag),
                "credentials": { "userId": "user-1", "apiKey": "secret-key-1234", "accountId": "01234567" },
                "settings": { "labelFormat": "pdf_a6" },
                "isDefault": false,
                "skipTest": true
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let carrier = body["data"]["id"].as_str().expect("carrier id").to_owned();
    assert_eq!(body["data"]["credentials"]["apiKey"], "••••1234");
    assert_eq!(body["data"]["credentials"]["userId"], "user-1");
    assert_eq!(body["data"]["accountNumber"], "01234567");
    assert_eq!(h.actions().await, ["parcel_carrier:created"]);

    // What the dialog starts from.
    let (status, body) = h
        .call("GET", &format!("/pick-lists/{list}/shipping"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["recipient"]["street"], "Damrak");
    assert_eq!(body["data"]["recipient"]["houseNumber"], "1");
    assert_eq!(body["data"]["suggestedWeightGrams"], 800);
    assert_eq!(body["data"]["customsRequired"], false);

    // Two pieces and a return label.
    dhl_ready(&h.dhl);
    h.dhl.json(
        &format!("POST {DHL}/shipments"),
        201,
        &shipment_answer(&fx.tag),
    );
    let request = json!({
        "carrierId": carrier,
        "pieces": [{ "weightGrams": 500 }, { "weightGrams": 300 }],
        "options": { "signature": true },
        "returnLabel": true
    });
    let (status, body) = h
        .call(
            "POST",
            &format!("/pick-lists/{list}/labels"),
            Some(request.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let parcels = body["data"]["parcels"].as_array().expect("parcels").clone();
    assert_eq!(parcels.len(), 2);
    assert_eq!(parcels[0]["id"], draft.as_str());
    assert_eq!(parcels[0]["status"], "label_created");
    assert_eq!(parcels[0]["trackingNumber"], format!("JVGL1{}", fx.tag));
    assert_eq!(parcels[0]["carrierCode"], "dhl_parcel_nl");
    assert_eq!(parcels[0]["pickListId"], list.as_str());
    assert_eq!(parcels[1]["colloNumber"], 2);
    assert_eq!(
        parcels[0]["labelUrl"],
        format!("/api/parcels/{draft}/label")
    );
    let returned = &body["data"]["returnParcel"];
    assert_eq!(returned["isReturn"], true);
    assert_eq!(returned["returnForParcelId"], draft.as_str());
    assert_eq!(
        h.actions().await,
        ["parcel:updated", "parcel:created", "parcel:created"]
    );
    let (tracking,): (Option<String>,) =
        sqlx::query_as("select tracking_number from orders where id = $1")
            .bind(&order)
            .fetch_one(&db)
            .await
            .expect("order");
    assert_eq!(tracking, Some(format!("JVGL1{}", fx.tag)));

    // The label file.
    let (status, bytes) = h.raw("GET", &format!("/parcels/{draft}/label"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"%PDF-1.7 label");

    // A second request is refused, and DHL is not called again.
    let posts = h.dhl.calls(&format!("POST {DHL}/shipments"));
    let (status, _) = h
        .call(
            "POST",
            &format!("/pick-lists/{list}/labels"),
            Some(request.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(h.dhl.calls(&format!("POST {DHL}/shipments")), posts);

    // Void: three labels cancelled, a fresh draft.
    let (status, body) = h
        .call("DELETE", &format!("/pick-lists/{list}/labels"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["voided"], 3);
    let new_draft = body["data"]["parcelId"].as_str().expect("draft").to_owned();
    assert_ne!(new_draft, draft);
    h.events().await;

    // Label again and ship: both pieces ship.
    let again = format!("{}b", fx.tag);
    h.dhl.json(
        &format!("POST {DHL}/shipments"),
        201,
        &shipment_answer(&again),
    );
    let (status, body) = h
        .call("POST", &format!("/pick-lists/{list}/labels"), Some(request))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first = body["data"]["parcels"][0]["id"]
        .as_str()
        .expect("first")
        .to_owned();
    assert_eq!(first, new_draft);
    h.events().await;
    let (status, body) = h
        .call("POST", &format!("/pick-lists/{list}/ship"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        h.actions().await,
        [
            "picklist:updated",
            "shipment:shipped",
            "parcel:updated",
            "parcel:shipped",
            "parcel:shipped"
        ]
    );
    let (count,): (i64,) = sqlx::query_as(
        "select count(*) from parcels where pick_list_id = $1 and status = 'shipped'",
    )
    .bind(&list)
    .fetch_one(&db)
    .await
    .expect("count");
    assert_eq!(count, 2);

    // DHL says the first piece is delivered.
    h.dhl.json(
        &format!("GET {DHL}/track-trace?"),
        200,
        &json!([{
            "barcode": format!("JVGL1{again}"),
            "deliveredAt": "2026-11-25T14:02:00+01:00",
            "events": [
                { "category": "UNDERWAY", "status": "SORTED", "timestamp": "2026-11-25T06:00:00+01:00" },
                { "category": "DELIVERED", "status": "DELIVERED", "timestamp": "2026-11-25T14:02:00+01:00" }
            ]
        }]),
    );
    let (status, body) = h
        .call("POST", &format!("/parcels/{first}/refresh-tracking"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "delivered");
    assert_eq!(
        body["data"]["statusHistory"].as_array().map(Vec::len),
        Some(2)
    );
    assert_eq!(body["data"]["trackingNextCheckAt"], Value::Null);
    assert_eq!(h.actions().await, ["parcel:updated", "parcel:delivered"]);

    // The parcels list finds it by tracking number.
    let (status, body) = h
        .call(
            "GET",
            &format!("/parcels?labelled=true&search=JVGL1{again}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn labels_need_a_packed_pick_list() {
    let Some(db) = tenant() else { return };
    let h = harness(db.clone(), ALL);
    let fx = Fx::new(&db);
    let (list, _, _) = fx.packed_pick_list().await;
    fx.exec(
        "update pick_lists set status = 'completed' where id = $1",
        &[&list],
    )
    .await;
    let (status, body) = h
        .call(
            "POST",
            &format!("/pick-lists/{list}/labels"),
            Some(json!({ "pieces": [{ "weightGrams": 500 }] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "INVALID_STATUS");
}
