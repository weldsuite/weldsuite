//! Every online store route checks its permission before touching a
//! database.

use http::StatusCode;
use serde_json::json;
use weldsuite_commerce::CommerceState;
use weldsuite_commerce::online_store::OnlineStoreConfig;
use weldsuite_events::{EntityEventPublisher, TaskTracker};

use crate::harness::{send, staff_router};

fn router(permissions: &[&str]) -> axum::Router {
    let state = CommerceState {
        mail: None,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        http: None,
        payments: weldsuite_commerce::PaymentsConfig::default(),
        online_store: OnlineStoreConfig::default(),
    };
    staff_router(state, None, None, permissions)
}

async fn status(permissions: &[&str], method: &str, path: &str) -> StatusCode {
    let request = http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({}).to_string()))
        .expect("request");
    send(&router(permissions), request).await.status
}

#[tokio::test]
async fn reading_needs_websites_read() {
    for path in [
        "/online-store/sites",
        "/online-store/sites/sfs_1",
        "/online-store/sites/sfs_1/versions",
        "/online-store/sites/sfs_1/pages",
        "/online-store/sites/sfs_1/menus",
        "/online-store/sites/sfs_1/redirects",
        "/online-store/sites/sfs_1/deployments",
        "/storefront-hosts",
        "/storefront-hosts/config",
    ] {
        assert_eq!(
            status(&[], "GET", path).await,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
}

#[tokio::test]
async fn publishing_domains_and_visibility_need_manage() {
    let editor = [
        "websites:read",
        "websites:create",
        "websites:update",
        "websites:delete",
    ];
    for (method, path) in [
        ("POST", "/online-store/sites/sfs_1/publish"),
        ("POST", "/online-store/sites/sfs_1/versions/sfv_1/restore"),
        (
            "POST",
            "/online-store/sites/sfs_1/deployments/sfd_1/promote",
        ),
        ("POST", "/storefront-hosts"),
        ("POST", "/storefront-hosts/sfh_1/refresh"),
        ("POST", "/storefront-hosts/sfh_1/primary"),
        ("DELETE", "/storefront-hosts/sfh_1"),
    ] {
        assert_eq!(
            status(&editor, method, path).await,
            StatusCode::FORBIDDEN,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn editing_needs_update_and_creating_needs_create() {
    let reader = ["websites:read"];
    for (method, path) in [
        ("POST", "/online-store/sites"),
        ("PUT", "/online-store/sites/sfs_1/draft"),
        ("PATCH", "/online-store/sites/sfs_1"),
        ("POST", "/online-store/sites/sfs_1/pages"),
        ("PUT", "/online-store/sites/sfs_1/menus/main"),
        ("POST", "/online-store/sites/sfs_1/redirects"),
        ("DELETE", "/online-store/sites/sfs_1/pages/sfp_1"),
    ] {
        assert_eq!(
            status(&reader, method, path).await,
            StatusCode::FORBIDDEN,
            "{method} {path}"
        );
    }
}
