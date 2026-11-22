//! Every channel route refuses a member without its permission, before it
//! touches the database; a reader still reads.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, app_with, both, lazy_pool};

/// `(method, path, the permission it needs)`.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/commerce-channels", "commerce_channels:read"),
    ("POST", "/commerce-channels", "commerce_channels:create"),
    ("GET", "/commerce-channels/c1", "commerce_channels:read"),
    ("PATCH", "/commerce-channels/c1", "commerce_channels:update"),
    (
        "DELETE",
        "/commerce-channels/c1",
        "commerce_channels:delete",
    ),
    (
        "GET",
        "/commerce-channels/c1/keys",
        "commerce_channels:read",
    ),
    (
        "POST",
        "/commerce-channels/c1/keys",
        "commerce_channels:update",
    ),
    (
        "PATCH",
        "/commerce-channels/c1/keys/k1",
        "commerce_channels:update",
    ),
    (
        "POST",
        "/commerce-channels/c1/keys/k1/rotate",
        "commerce_channels:update",
    ),
    (
        "POST",
        "/commerce-channels/c1/keys/k1/revoke",
        "commerce_channels:update",
    ),
    (
        "GET",
        "/commerce-channels/c1/shipping-rates",
        "commerce_channels:read",
    ),
    (
        "POST",
        "/commerce-channels/c1/shipping-rates",
        "commerce_channels:create",
    ),
    (
        "PUT",
        "/commerce-channels/c1/shipping-rates/order",
        "commerce_channels:update",
    ),
    (
        "PATCH",
        "/commerce-channels/c1/shipping-rates/r1",
        "commerce_channels:update",
    ),
    (
        "DELETE",
        "/commerce-channels/c1/shipping-rates/r1",
        "commerce_channels:delete",
    ),
    ("GET", "/products/p1/prices", "products:read"),
    ("PUT", "/products/p1/prices", "products:update"),
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

/// Each method has its own permission: holding only the read permission gets
/// through to the database on every GET (the pool never connects, so a pass
/// is anything but 403).
#[tokio::test]
async fn a_reader_is_not_asked_for_more_than_read() {
    for (path, read) in [
        ("/commerce-channels", "commerce_channels:read"),
        ("/commerce-channels/c1", "commerce_channels:read"),
        ("/commerce-channels/c1/keys", "commerce_channels:read"),
        (
            "/commerce-channels/c1/shipping-rates",
            "commerce_channels:read",
        ),
        ("/products/p1/prices", "products:read"),
    ] {
        let member = app(lazy_pool(), &[read]);
        let (status, answer) = member.get(path).await;
        assert_ne!(status, StatusCode::FORBIDDEN, "GET {path}: {answer}");
    }
}

#[tokio::test]
async fn a_reader_reads_with_a_database() {
    let Some((db, master)) = both().await else {
        return;
    };
    let full = app_with(db.clone(), Some(master.clone()), ALL);
    let id = full.storefront().await;
    let (status, body) = full
        .post(
            &format!("/commerce-channels/{id}/keys"),
            &json!({ "kind": "private", "name": "Server" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let reader = app_with(db, Some(master), &["commerce_channels:read"]);
    for path in [
        "/commerce-channels".to_owned(),
        format!("/commerce-channels/{id}"),
        format!("/commerce-channels/{id}/keys"),
        format!("/commerce-channels/{id}/shipping-rates"),
    ] {
        let (status, body) = reader.get(&path).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
    }
    let (status, _) = reader
        .post(&format!("/commerce-channels/{id}/keys"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
