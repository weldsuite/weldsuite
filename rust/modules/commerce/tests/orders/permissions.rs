//! Every order-book route refuses a member without its permission, before it
//! touches the database.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, lazy_pool};

/// `(method, path, the permission it needs)`.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/orders", "orders:read"),
    ("POST", "/orders", "orders:create"),
    ("POST", "/orders/quote", "orders:create"),
    ("GET", "/orders/ord_1", "orders:read"),
    ("PATCH", "/orders/ord_1", "orders:update"),
    ("POST", "/orders/ord_1/cancel", "orders:update"),
    ("POST", "/orders/ord_1/mark-paid", "orders:update"),
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

#[tokio::test]
async fn the_other_object_is_not_enough() {
    let member = app(lazy_pool(), &["discounts:read", "commerce_settings:read"]);
    let (status, _) = member.get("/orders").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
