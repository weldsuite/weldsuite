//! `/api/commerce/overview` through the commerce router, with the
//! permission gate, the session and tenant layers a request carries in the
//! server.
//!
//! WeldCommerce has no TypeScript worker and so no conformance suite (ADR
//! COM-009): these tests are its only check. The permission checks run
//! without a database. The rest runs on the real tenant schema when
//! `WELDSUITE_TEST_TENANT_URL` is set and returns early otherwise. The
//! database is shared: rows are created with fresh ids and nothing is
//! truncated or assumed empty.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
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

const USER: &str = "user_commerce_test";

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

fn app(db: PgPool, permissions: &[&str]) -> Router {
    let state = CommerceState {
        events: EntityEventPublisher::new(
            Some(Arc::new(RecordingEventBus::new()) as Arc<dyn DynEventBus>),
            TaskTracker::new(),
        ),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: USER.to_owned(),
                org_id: Some("org_commerce".to_owned()),
                session_id: "sess_commerce".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: "ws_commerce_test".to_owned(),
                clerk_org_id: Some("org_commerce".to_owned()),
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
    ))
}

async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .body(Body::empty())
                .expect("request"),
        )
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

fn fresh(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("{prefix}_{nanos:x}")
}

#[tokio::test]
async fn the_overview_needs_a_products_or_orders_read() {
    let nobody = app(lazy_pool(), &["companies:read"]);
    let (status, _) = get(&nobody, "/commerce/overview").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_overview_counts_products_and_orders() {
    let Some(db) = tenant() else { return };
    let product = fresh("prod_ovw");
    let order = fresh("ord_ovw");
    sqlx::query(
        "insert into products (id, name, slug, status, price, currency) \
         values ($1, 'Overview test', $1, 'active', 10, 'EUR')",
    )
    .bind(&product)
    .execute(&db)
    .await
    .expect("product");
    sqlx::query(
        "insert into orders (id, order_number, status, payment_status, fulfillment_status, \
                             currency, total, customer_name) \
         values ($1, $1, 'processing', 'pending', 'unfulfilled', 'EUR', 25.50, 'Overview Buyer')",
    )
    .bind(&order)
    .execute(&db)
    .await
    .expect("order");

    let both = app(db.clone(), &["products:read", "orders:read"]);
    let (status, body) = get(&both, "/commerce/overview").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    for key in ["total", "active", "draft"] {
        assert!(data["products"][key].as_i64().is_some(), "products.{key}");
    }
    assert!(data["products"]["active"].as_i64().unwrap_or_default() >= 1);
    for key in ["total", "open", "awaitingFulfilment", "unpaid"] {
        assert!(
            data["orders"][key].as_i64().unwrap_or_default() >= 1,
            "orders.{key}"
        );
    }
    let eur = data["revenueLast30Days"]
        .as_array()
        .expect("revenue")
        .iter()
        .find(|row| row["currency"] == "EUR")
        .expect("an EUR row");
    assert!(eur["revenue"].is_string(), "revenue is a decimal string");
    let recent = data["recentOrders"].as_array().expect("recent orders");
    assert!(recent.len() <= 5);
    if let Some(row) = recent.iter().find(|row| row["id"] == order.as_str()) {
        assert_eq!(row["total"], "25.50");
        assert_eq!(row["customerName"], "Overview Buyer");
        assert!(
            row["createdAt"].as_str().unwrap_or_default().ends_with('Z'),
            "createdAt is ISO UTC"
        );
    }

    // One permission, one section.
    let products_only = app(db.clone(), &["products:read"]);
    let (status, body) = get(&products_only, "/commerce/overview").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["products"].is_object());
    for key in ["orders", "revenueLast30Days", "recentOrders"] {
        assert!(
            body["data"][key].is_null(),
            "{key} hidden without orders:read"
        );
    }
    let orders_only = app(db.clone(), &["orders:read"]);
    let (status, body) = get(&orders_only, "/commerce/overview").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["products"].is_null());
    assert!(body["data"]["orders"].is_object());

    sqlx::query("delete from orders where id = $1")
        .bind(&order)
        .execute(&db)
        .await
        .expect("cleanup order");
    sqlx::query("delete from products where id = $1")
        .bind(&product)
        .execute(&db)
        .await
        .expect("cleanup product");
}
