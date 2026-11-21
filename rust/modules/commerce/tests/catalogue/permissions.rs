//! Every catalogue route refuses a member without its permission, before it
//! touches the database.

use http::StatusCode;
use serde_json::json;

use crate::harness::{app, lazy_pool};

/// `(method, path, the permission it needs)`.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/products", "products:read"),
    ("POST", "/products", "products:create"),
    ("GET", "/products/prod_1", "products:read"),
    ("PATCH", "/products/prod_1", "products:update"),
    ("DELETE", "/products/prod_1", "products:delete"),
    ("GET", "/products/prod_1/variants", "products:read"),
    ("POST", "/products/prod_1/variants", "products:update"),
    (
        "POST",
        "/products/prod_1/variants/generate",
        "products:update",
    ),
    (
        "PATCH",
        "/products/prod_1/variants/pvr_1",
        "products:update",
    ),
    (
        "DELETE",
        "/products/prod_1/variants/pvr_1",
        "products:update",
    ),
    ("GET", "/products/prod_1/categories", "categories:read"),
    ("GET", "/categories", "categories:read"),
    ("POST", "/categories", "categories:create"),
    ("GET", "/categories/tree", "categories:read"),
    ("POST", "/categories/preview-members", "categories:read"),
    ("GET", "/categories/cat_1", "categories:read"),
    ("PATCH", "/categories/cat_1", "categories:update"),
    ("DELETE", "/categories/cat_1", "categories:delete"),
    ("GET", "/categories/cat_1/products", "categories:read"),
    ("POST", "/categories/cat_1/products", "categories:update"),
    (
        "DELETE",
        "/categories/cat_1/products/prod_1",
        "categories:update",
    ),
];

#[tokio::test]
async fn every_route_needs_its_permission() {
    let others = [
        "products:read",
        "products:create",
        "products:update",
        "products:delete",
        "categories:read",
        "categories:create",
        "categories:update",
        "categories:delete",
        "orders:read",
    ];
    for (method, path, needed) in ROUTES {
        // Everything but the one it needs.
        let held: Vec<&str> = others.iter().copied().filter(|p| p != needed).collect();
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
