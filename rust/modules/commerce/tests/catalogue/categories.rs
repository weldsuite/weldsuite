//! `/api/categories`: the tree (slugs per parent, paths, moves, cycles,
//! depth), manual members, automated members evaluated on read, the preview
//! and a product's categories.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, TestApp, app, fresh, ids, product, read, tenant};

/// A category through the API: `(id, slug)`.
async fn category(app: &TestApp, body: &Value) -> (String, String) {
    let (status, created) = app.post("/categories", body).await;
    assert_eq!(status, StatusCode::CREATED, "{body}: {created}");
    (
        created["data"]["id"].as_str().expect("id").to_owned(),
        created["data"]["slug"].as_str().expect("slug").to_owned(),
    )
}

#[tokio::test]
async fn the_tree_keeps_slugs_paths_and_depth() {
    let Some(db) = tenant() else { return };
    let app = app(db, ALL);
    let word = fresh("apparel");
    let (apparel, slug) = category(&app, &json!({ "name": format!("{word} & Co") })).await;
    assert_eq!(slug, format!("{word}-co"), "derived from the name");
    let shirts_name = fresh("Shirts ");
    let (shirts, shirts_slug) =
        category(&app, &json!({ "name": shirts_name, "parentId": apparel })).await;
    assert_eq!(shirts_slug, shirts_name.to_lowercase().replace(' ', "-"));
    // Unique among siblings only.
    let (shirts_two, slug) =
        category(&app, &json!({ "name": shirts_name, "parentId": apparel })).await;
    assert_eq!(slug, format!("{shirts_slug}-2"));
    let (polos, _) = category(
        &app,
        &json!({ "name": "Polos", "parentId": shirts, "position": 3 }),
    )
    .await;

    let row = read(&app, &format!("/categories/{polos}")).await;
    assert_eq!(row["path"], format!("/{apparel}/{shirts}/{polos}"));
    assert_eq!(row["depth"], 2);
    assert_eq!(row["isActive"], true);
    assert_eq!(row["type"], "manual");
    assert!(row.get("productCount").is_none());

    let tree = read(&app, &format!("/categories/tree?rootId={apparel}")).await;
    assert_eq!(tree.as_array().map(Vec::len), Some(1));
    let mut children = ids(&tree[0]["children"]);
    children.sort();
    let mut siblings = vec![shirts.clone(), shirts_two.clone()];
    siblings.sort();
    assert_eq!(children, siblings);
    let shirts_node = tree[0]["children"]
        .as_array()
        .and_then(|c| c.iter().find(|n| n["id"] == shirts.as_str()))
        .expect("shirts in the tree");
    assert_eq!(ids(&shirts_node["children"]), std::slice::from_ref(&polos));
    assert_eq!(shirts_node["children"][0]["depth"], 2);
    // Nodes are whole categories: the back office edits from them.
    assert_eq!(tree[0]["rulesMatch"], "all");
    assert!(tree[0].get("description").is_some());
    assert!(tree[0]["createdAt"].is_string());

    // List: children of a parent, roots by search, cursor pages.
    let (_, children) = app
        .get(&format!("/categories?parentId={apparel}&limit=1"))
        .await;
    assert_eq!(children["pagination"]["totalCount"], 2);
    assert_eq!(children["pagination"]["hasMore"], true);
    let cursor = children["pagination"]["cursor"].as_str().expect("cursor");
    let (_, next) = app
        .get(&format!(
            "/categories?parentId={apparel}&limit=1&cursor={cursor}"
        ))
        .await;
    let mut both = ids(&children["data"]);
    both.extend(ids(&next["data"]));
    both.sort();
    let mut expected = vec![shirts.clone(), shirts_two.clone()];
    expected.sort();
    assert_eq!(both, expected);
    let (_, roots) = app
        .get(&format!("/categories?parentId=null&search={word}"))
        .await;
    assert_eq!(ids(&roots["data"]), std::slice::from_ref(&apparel));

    // Moving Shirts to the root re-paths its subtree; its slug stays free
    // among the roots.
    let (status, body) = app
        .patch(
            &format!("/categories/{shirts}"),
            &json!({ "parentId": null }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = read(&app, &format!("/categories/{polos}")).await;
    assert_eq!(row["path"], format!("/{shirts}/{polos}"));
    assert_eq!(row["depth"], 1);
    // Back under Apparel, where its slug is still free (the other has `-2`).
    let (status, body) = app
        .patch(
            &format!("/categories/{shirts}"),
            &json!({ "parentId": apparel }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["slug"], shirts_slug.as_str());
    // Asking for a sibling's slug gets a suffix.
    let (status, body) = app
        .patch(
            &format!("/categories/{shirts_two}"),
            &json!({ "slug": shirts_slug }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["slug"], format!("{shirts_slug}-2"));

    // Rings and missing parents.
    for (target, parent, status, code) in [
        (&shirts, &polos, StatusCode::BAD_REQUEST, "CYCLE"),
        (&shirts, &shirts, StatusCode::BAD_REQUEST, "CYCLE"),
        (
            &shirts,
            &"cat_missing".to_owned(),
            StatusCode::NOT_FOUND,
            "PARENT_NOT_FOUND",
        ),
    ] {
        let (answer, body) = app
            .patch(
                &format!("/categories/{target}"),
                &json!({ "parentId": parent }),
            )
            .await;
        assert_eq!(answer, status, "{body}");
        assert_eq!(body["error"]["details"]["code"], code);
    }

    // Ten levels at most, the moved subtree included.
    let mut parent = apparel.clone();
    let mut chain = Vec::new();
    for level in 1..10 {
        let (id, _) = category(
            &app,
            &json!({ "name": format!("Level {level}"), "parentId": parent }),
        )
        .await;
        chain.push(id.clone());
        parent = id;
    }
    let (status, body) = app
        .post(
            "/categories",
            &json!({ "name": "Too deep", "parentId": parent }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["code"], "TOO_DEEP");
    let (status, body) = app
        .patch(
            &format!("/categories/{shirts}"),
            &json!({ "parentId": chain[7] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Shirts carries Polos: {body}"
    );
    assert_eq!(body["error"]["details"]["code"], "TOO_DEEP");

    // No delete while it has children.
    let (status, body) = app.delete(&format!("/categories/{shirts}")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["code"], "HAS_CHILDREN");
    assert_eq!(body["error"]["details"]["childCount"], 1);
    let (status, _) = app.delete(&format!("/categories/{polos}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app.get(&format!("/categories/{polos}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    assert_eq!(app.events_of("category:created", &polos).await.len(), 1);
    assert_eq!(app.events_of("category:updated", &shirts).await.len(), 2);
    let deleted = app.events_of("category:deleted", &polos).await;
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0]["data"]["parentId"], shirts.as_str());
}

#[tokio::test]
async fn manual_categories_hold_curated_members() {
    let Some(db) = tenant() else { return };
    let app = app(db.clone(), ALL);
    let (shelf, _) = category(&app, &json!({ "name": fresh("Shelf ") })).await;
    let b = product(&app, &json!({ "name": "B product", "slug": fresh("b-") })).await;
    let a = product(&app, &json!({ "name": "A product", "slug": fresh("a-") })).await;
    let path = format!("/categories/{shelf}/products");

    let (status, body) = app.post(&path, &json!({ "productIds": [b, a, b] })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"], json!({ "added": 2, "skipped": 0 }));
    let (_, body) = app.post(&path, &json!({ "productIds": [a] })).await;
    assert_eq!(body["data"], json!({ "added": 0, "skipped": 1 }));
    let (status, body) = app
        .post(&path, &json!({ "productIds": ["prod_missing"] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["code"], "PRODUCTS_NOT_FOUND");

    // Curated order (the order they were added), paged; or by a sort.
    let (_, first) = app.get(&format!("{path}?limit=1")).await;
    assert_eq!(ids(&first["data"]), std::slice::from_ref(&b));
    assert_eq!(first["pagination"]["totalCount"], 2);
    let cursor = first["pagination"]["cursor"].as_str().expect("cursor");
    let (_, second) = app.get(&format!("{path}?limit=1&cursor={cursor}")).await;
    assert_eq!(ids(&second["data"]), std::slice::from_ref(&a));
    assert_eq!(second["pagination"]["hasMore"], false);
    let (_, sorted) = app.get(&format!("{path}?sortOrder=alpha-asc")).await;
    assert_eq!(ids(&sorted["data"]), [a.clone(), b.clone()]);
    let (_, first) = app
        .get(&format!("{path}?sortOrder=alpha-asc&limit=1"))
        .await;
    let cursor = first["pagination"]["cursor"].as_str().expect("cursor");
    let (_, second) = app
        .get(&format!(
            "{path}?sortOrder=alpha-asc&limit=1&cursor={cursor}"
        ))
        .await;
    assert_eq!(ids(&second["data"]), std::slice::from_ref(&b));
    let (status, _) = app.get(&format!("{path}?limit=0")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let in_shelf = read(&app, &format!("/products/{a}/categories")).await;
    assert_eq!(ids(&in_shelf), std::slice::from_ref(&shelf));
    let (status, _) = app.get("/products/prod_missing/categories").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A deleted product drops out of the members and the count.
    let (status, _) = app.delete(&format!("/products/{b}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, members) = app.get(&path).await;
    assert_eq!(ids(&members["data"]), std::slice::from_ref(&a));
    assert_eq!(members["pagination"]["totalCount"], 1);

    let (status, _) = app.delete(&format!("{path}/{a}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app.delete(&format!("{path}/{a}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        read(&app, &format!("/products/{a}/categories")).await,
        json!([])
    );

    // Deleting the category drops its junction rows.
    let (status, _) = app.delete(&format!("/categories/{shelf}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("select count(*) from category_products where category_id = $1")
            .bind(&shelf)
            .fetch_one(&db)
            .await
            .expect("count");
    assert_eq!(left, 0);
    assert_eq!(app.events_of("category:updated", &shelf).await.len(), 3);
}

#[tokio::test]
async fn automated_categories_follow_their_rules() {
    let Some(db) = tenant() else { return };
    let app = app(db.clone(), ALL);
    let vendor = fresh("Acme");
    let summer = fresh("summer");
    let cheap = product(
        &app,
        &json!({ "name": "Cheap", "slug": fresh("cheap-"), "vendor": vendor, "price": "5.00", "tags": [summer, "sale"] }),
    )
    .await;
    let dear = product(
        &app,
        &json!({ "name": "Dear", "slug": fresh("dear-"), "vendor": vendor, "price": "50.00", "tags": ["winter"] }),
    )
    .await;
    let rule = |column: &str, relation: &str, condition: &str| json!({ "column": column, "relation": relation, "condition": condition });

    let (status, body) = app
        .post(
            "/categories",
            &json!({ "name": "Smart", "type": "automated" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "rules required: {body}");
    let (status, body) = app
        .post(
            "/categories",
            &json!({ "name": "Smart", "type": "automated", "rules": [rule("vendor", "greater_than", "1")] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a relation text has not: {body}"
    );

    let (smart, _) = category(
        &app,
        &json!({ "name": fresh("Smart "), "type": "automated", "sortOrder": "price-asc",
                 "rules": [rule("vendor", "equals", &vendor), rule("price", "greater_than", "10")] }),
    )
    .await;
    let path = format!("/categories/{smart}/products");
    let (_, members) = app.get(&path).await;
    assert_eq!(ids(&members["data"]), std::slice::from_ref(&dear));

    // A new product joins on the next read; `any` widens, by price.
    let fresh_one = product(
        &app,
        &json!({ "name": "New", "slug": fresh("new-"), "vendor": vendor, "price": "20.00" }),
    )
    .await;
    let (_, members) = app.get(&path).await;
    assert_eq!(
        ids(&members["data"]),
        [fresh_one.clone(), dear.clone()],
        "price-asc"
    );
    let (status, body) = app
        .patch(
            &format!("/categories/{smart}"),
            &json!({ "rulesMatch": "any", "rules": [rule("tag", "contains", &summer[1..]), rule("vendor", "contains", "%")] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, members) = app.get(&path).await;
    assert_eq!(
        ids(&members["data"]),
        std::slice::from_ref(&cheap),
        "tags, and % is literal"
    );

    // An automated category's members are not curated.
    let (status, body) = app.post(&path, &json!({ "productIds": [cheap] })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["code"], "NOT_MANUAL");
    let (status, _) = app.delete(&format!("{path}/{cheap}")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, body) = app
        .patch(&format!("/categories/{smart}"), &json!({ "rules": [] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["code"], "RULES_REQUIRED");

    // A stale rule (a column off the whitelist) matches nothing.
    sqlx::query("update categories set rules = $2::jsonb, rules_match = 'all' where id = $1")
        .bind(&smart)
        .bind(json!([{ "column": "cost_price", "relation": "equals", "condition": "1" }]))
        .execute(&db)
        .await
        .expect("stale rule");
    let (status, members) = app.get(&path).await;
    assert_eq!(status, StatusCode::OK, "{members}");
    assert_eq!(members["data"], json!([]));
    assert_eq!(members["pagination"]["totalCount"], 0);

    // The preview runs unsaved rules.
    let (status, body) = app
        .post(
            "/categories/preview-members",
            &json!({ "rules": [rule("vendor", "equals", &vendor), rule("tag", "not_contains", "sale")] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["totalCount"], 2);
    let mut previewed = ids(&body["data"]["products"]);
    previewed.sort();
    let mut expected = vec![dear.clone(), fresh_one.clone()];
    expected.sort();
    assert_eq!(previewed, expected);
    let (status, body) = app
        .post(
            "/categories/preview-members",
            &json!({ "rules": [rule("inventoryQuantity", "less_than", "1"), rule("vendor", "equals", &vendor)], "limit": 1 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["totalCount"], 3);
    assert_eq!(body["data"]["products"].as_array().map(Vec::len), Some(1));
    let (status, _) = app
        .post("/categories/preview-members", &json!({ "rules": [] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Automated categories are not among a product's (manual) categories.
    assert_eq!(
        read(&app, &format!("/products/{cheap}/categories")).await,
        json!([])
    );
}
