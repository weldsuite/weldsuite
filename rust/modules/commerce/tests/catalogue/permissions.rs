//! Every catalogue route refuses a member without its permission, before it
//! touches the database.

use http::StatusCode;
use serde_json::json;
use weldsuite_permissions::{ResolvedPermissions, check_app_permission, role_row_permissions};

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

/// The built-in roles as the code defines them (`SYSTEM_ROLES`): an Admin
/// holds every permission these routes need, a Viewer every read. Members on
/// those roles take their keys from code, so without these only the owner
/// could open WeldCommerce (an admin once saw its settings fail to load).
#[test]
fn the_built_in_roles_cover_these_routes() {
    let role = |name| ResolvedPermissions {
        permissions: role_row_permissions(true, name, None),
        ..ResolvedPermissions::default()
    };
    let (admin, viewer) = (role("Admin"), role("Viewer"));
    for (method, path, needed) in ROUTES {
        assert!(
            check_app_permission(&admin, needed, Some("weldcommerce")).allowed,
            "Admin: {method} {path} needs {needed}"
        );
        if needed.ends_with(":read") {
            assert!(
                check_app_permission(&viewer, needed, Some("weldcommerce")).allowed,
                "Viewer: {method} {path} needs {needed}"
            );
        }
    }
}
