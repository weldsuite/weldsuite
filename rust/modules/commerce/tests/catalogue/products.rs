//! `/api/products` after its move from WeldStash: the same answers.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, fresh, ids, product, read, tenant};

#[tokio::test]
async fn products_read_write_and_delete_as_before() {
    let Some(db) = tenant() else { return };
    let app = app(db, ALL);
    let name = fresh("Moved product ");
    let sku = fresh("MOVED-");
    let id = product(
        &app,
        &json!({
            "name": name, "slug": fresh("moved-"), "sku": sku, "price": "10.00",
            "currency": "EUR", "status": "active", "taxClass": " saas ",
        }),
    )
    .await;

    let row = read(&app, &format!("/products/{id}")).await;
    assert_eq!(row["price"], "10.00", "numeric columns are strings");
    assert_eq!(row["taxClass"], "saas", "trimmed");
    assert_eq!(row["hasVariants"], false);
    assert!(row["createdAt"].as_str().unwrap_or_default().ends_with('Z'));

    let (status, list) = app
        .get(&format!("/products?search={}", sku.replace(' ', "%20")))
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(ids(&list["data"]), std::slice::from_ref(&id));
    assert_eq!(list["pagination"]["totalCount"], 1);
    assert_eq!(list["pagination"]["hasMore"], false);

    let (status, body) = app
        .patch(&format!("/products/{id}"), &json!({ "name": "Renamed" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "data": { "id": id } }));
    assert_eq!(
        read(&app, &format!("/products/{id}")).await["name"],
        "Renamed"
    );

    // The schema refuses what stash-api's does.
    let (status, body) = app.post("/products", &json!({ "slug": "x" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = app
        .patch(&format!("/products/{id}"), &json!({ "taxClass": "luxury" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, _) = app.delete(&format!("/products/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = app.get(&format!("/products/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "NOT_FOUND");

    for (event, data) in [
        (
            "product:created",
            json!({ "id": id, "name": name, "sku": sku, "status": "active", "price": "10.00", "currency": "EUR" }),
        ),
        (
            "product:updated",
            json!({ "id": id, "name": "Renamed", "sku": sku, "status": "active", "price": "10.00", "currency": "EUR" }),
        ),
        ("product:deleted", json!({ "id": id, "name": "Renamed" })),
    ] {
        let events = app.events_of(event, &id).await;
        assert_eq!(events.len(), 1, "{event}");
        assert_eq!(events[0]["data"], data, "{event}");
    }
}

#[tokio::test]
async fn the_product_list_pages_newest_first() {
    let Some(db) = tenant() else { return };
    let app = app(db, ALL);
    let tag = fresh("pagetest");
    let mut created = Vec::new();
    for n in 0..3 {
        created.push(
            product(
                &app,
                &json!({ "name": format!("{tag} {n}"), "slug": fresh("page-"), "status": "draft" }),
            )
            .await,
        );
    }
    let (status, first) = app.get(&format!("/products?search={tag}&limit=2")).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["pagination"]["totalCount"], 3);
    assert_eq!(first["pagination"]["hasMore"], true);
    let cursor = first["pagination"]["cursor"].as_str().expect("cursor");
    let (_, second) = app
        .get(&format!("/products?search={tag}&limit=2&cursor={cursor}"))
        .await;
    let mut seen = ids(&first["data"]);
    seen.extend(ids(&second["data"]));
    // Each once across the pages (rows written in the same millisecond tie
    // on `createdAt` and then go by id).
    seen.sort();
    created.sort();
    assert_eq!(seen, created);
    let (_, filtered) = app
        .get(&format!("/products?search={tag}&status=active"))
        .await;
    assert_eq!(filtered["pagination"]["totalCount"], 0);
}
