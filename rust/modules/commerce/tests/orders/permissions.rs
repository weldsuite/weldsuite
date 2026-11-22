//! Every order-book route refuses a member without its permission, before it
//! touches the database.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, discount, fresh, lazy_pool, priced, tenant};

/// `(method, path, the permission it needs)`.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/orders", "orders:read"),
    ("POST", "/orders", "orders:create"),
    ("POST", "/orders/quote", "orders:create"),
    ("GET", "/orders/ord_1", "orders:read"),
    ("PATCH", "/orders/ord_1", "orders:update"),
    ("POST", "/orders/ord_1/cancel", "orders:update"),
    ("POST", "/orders/ord_1/mark-paid", "orders:update"),
    ("POST", "/orders/ord_1/recalculate-tax", "orders:update"),
    ("GET", "/discounts", "discounts:read"),
    ("POST", "/discounts", "discounts:create"),
    ("GET", "/discounts/disc_1", "discounts:read"),
    ("PATCH", "/discounts/disc_1", "discounts:update"),
    ("DELETE", "/discounts/disc_1", "discounts:delete"),
    ("GET", "/discounts/disc_1/redemptions", "discounts:read"),
    ("GET", "/commerce-settings", "commerce_settings:read"),
    ("PATCH", "/commerce-settings", "commerce_settings:update"),
];

#[tokio::test]
async fn every_route_needs_its_permission() {
    for (method, path, needed) in ROUTES {
        let held: Vec<&str> = ALL.iter().copied().filter(|p| p != needed).collect();
        let member = app(lazy_pool(), &held);
        let body = json!({});
        let (status, answer) = member
            .call(
                method,
                path,
                (*method != "GET" && *method != "DELETE").then_some(&body),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} {path} without {needed}: {answer}"
        );
    }
}

/// Each method has its own permission: a member holding only the read
/// permission gets through to the database on every GET (`route_layer` wraps
/// every method chained before it, which once made a GET need update and
/// delete as well). The pool never connects, so a pass is anything but 403.
#[tokio::test]
async fn a_reader_is_not_asked_for_more_than_read() {
    for (path, read) in [
        ("/orders", "orders:read"),
        ("/orders/ord_1", "orders:read"),
        ("/discounts", "discounts:read"),
        ("/discounts/disc_1", "discounts:read"),
        ("/discounts/disc_1/redemptions", "discounts:read"),
        ("/commerce-settings", "commerce_settings:read"),
    ] {
        let member = app(lazy_pool(), &[read]);
        let (status, answer) = member.get(path).await;
        assert_ne!(
            status,
            StatusCode::FORBIDDEN,
            "GET {path} with {read}: {answer}"
        );
    }
}

/// The same with a database: a reader reads an order, a discount and the
/// settings (200), and still cannot write them.
#[tokio::test]
async fn a_reader_reads_with_a_database() {
    let Some(db) = tenant().await else { return };
    let full = app(db.clone(), ALL);
    let widget = priced(&full, "5").await;
    let (_, created) = full
        .post(
            "/orders",
            &json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 1 }] }),
        )
        .await;
    let order = created["data"]["id"].as_str().expect("order").to_owned();
    let discount_id = discount(
        &full,
        &json!({ "name": "R", "code": fresh("R").to_uppercase(), "type": "percentage", "value": "5", "status": "active" }),
    )
    .await;
    for (path, read) in [
        ("/orders".to_owned(), "orders:read"),
        (format!("/orders/{order}"), "orders:read"),
        ("/discounts".to_owned(), "discounts:read"),
        (format!("/discounts/{discount_id}"), "discounts:read"),
        (
            format!("/discounts/{discount_id}/redemptions"),
            "discounts:read",
        ),
        ("/commerce-settings".to_owned(), "commerce_settings:read"),
    ] {
        let member = app(db.clone(), &[read]);
        let (status, answer) = member.get(&path).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "GET {path} with only {read}: {answer}"
        );
    }
    let reader = app(
        db,
        &["orders:read", "discounts:read", "commerce_settings:read"],
    );
    for (method, path) in [
        ("PATCH", format!("/orders/{order}")),
        ("PATCH", format!("/discounts/{discount_id}")),
        ("DELETE", format!("/discounts/{discount_id}")),
        ("PATCH", "/commerce-settings".to_owned()),
    ] {
        let (status, _) = reader.call(method, &path, Some(&json!({}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
}

#[tokio::test]
async fn the_other_object_is_not_enough() {
    let member = app(lazy_pool(), &["discounts:read", "commerce_settings:read"]);
    let (status, _) = member.get("/orders").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
