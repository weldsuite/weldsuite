//! The catalogue: what is sellable on the channel, categories (manual and
//! automated), search, sorting and cursors, and what never leaves.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{env, fresh};

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("a list")
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn only_active_priced_products_are_listed_and_nothing_internal_leaves() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let tag = fresh("cat-");
    let name = |n: &str| format!("{tag} {n}");

    let active = env
        .product(&json!({ "name": name("active"), "price": "10.00", "vendor": &tag }))
        .await;
    let draft = env
        .product(&json!({ "name": name("draft"), "status": "draft", "vendor": &tag }))
        .await;
    let hidden = env
        .product(&json!({ "name": name("hidden"), "visibility": "hidden", "vendor": &tag }))
        .await;
    let usd = env
        .product(&json!({ "name": name("usd"), "currency": "USD", "vendor": &tag }))
        .await;
    let usd_with_row = env
        .product(
            &json!({ "name": name("usd2"), "currency": "USD", "price": "99.00", "vendor": &tag }),
        )
        .await;
    env.price_row(&usd_with_row, "EUR", "8.50").await;

    let list = app
        .get(&format!("/products?search={tag}&sort=price"), &key)
        .send()
        .await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    let listed = ids(&list.body["data"]);
    assert_eq!(listed, vec![usd_with_row.clone(), active.clone()]);
    for gone in [&draft, &hidden, &usd] {
        assert!(!listed.contains(gone));
    }
    assert_eq!(
        list.body["pagination"],
        json!({ "hasMore": false, "cursor": null })
    );

    let product = &list.body["data"][0];
    assert_eq!(product["price"], "8.50");
    assert_eq!(product["currency"], "EUR");
    assert_eq!(product["available"], true);
    assert_eq!(product["variants"], json!([]));
    let rendered = product.to_string();
    for private_field in [
        "costPrice",
        "cost_price",
        "inventoryQuantity",
        "7.77",
        "vendor",
        "vatCategory",
        "supplier",
    ] {
        assert!(
            !rendered.contains(private_field),
            "a field that must stay private leaked into the storefront product"
        );
    }

    // Detail by id and by slug; a draft is not found.
    let slug = product["slug"].as_str().expect("slug").to_owned();
    let by_slug = app
        .get(&format!("/products/{slug}"), &key)
        .ok(StatusCode::OK)
        .await;
    let by_id = app
        .get(&format!("/products/{active}"), &key)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(by_slug["id"], json!(usd_with_row));
    assert_eq!(by_id["price"], "10.00");
    for gone in [&draft, &hidden, &usd, &"nope".to_owned()] {
        let reply = app.get(&format!("/products/{gone}"), &key).send().await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        assert_eq!(reply.body["error"]["code"], "NOT_FOUND");
    }
}

#[tokio::test]
async fn variants_show_their_own_prices_and_availability() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let shirt = env
        .product(&json!({ "name": "Shirt", "hasVariants": true, "price": "20.00" }))
        .await;
    let small = env.variant(&shirt, "S", Some("18.00"), 5).await;
    // Inherits the product's 20.00; none in stock.
    let large = env.variant(&shirt, "L", None, 0).await;
    let shown = app
        .get(&format!("/products/{shirt}"), &key)
        .ok(StatusCode::OK)
        .await;
    // The headline price is the lowest variant price.
    assert_eq!(shown["price"], "18.00");
    let variants = shown["variants"].as_array().expect("variants");
    assert_eq!(variants.len(), 2);
    let find = |id: &str| {
        variants
            .iter()
            .find(|v| v["id"] == json!(id))
            .expect("variant")
    };
    assert_eq!(find(&small)["price"], "18.00");
    assert_eq!(find(&small)["available"], true);
    assert_eq!(find(&small)["optionValues"], json!({ "Size": "S" }));
    assert_eq!(find(&large)["price"], "20.00");
    assert_eq!(find(&large)["available"], false);
    assert_eq!(shown["available"], true);
    assert!(!shown.to_string().contains("inventory"));
}

#[tokio::test]
async fn categories_filter_products_manual_or_automated() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let vendor = fresh("vendor-");
    let inside = env
        .product(&json!({ "name": "Inside", "vendor": &vendor }))
        .await;
    let outside = env
        .product(&json!({ "name": "Outside", "vendor": "Other" }))
        .await;
    let manual_member = env.product(&json!({ "name": "Member" })).await;

    let manual_slug = fresh("manual-");
    let auto_slug = fresh("auto-");
    let off_slug = fresh("off-");
    let (manual, auto, off) = (fresh("catg_"), fresh("catg_"), fresh("catg_"));
    for (id, slug, kind, rules, active) in [
        (&manual, &manual_slug, "manual", json!([]), 1),
        (
            &auto,
            &auto_slug,
            "automated",
            json!([{ "column": "vendor", "relation": "equals", "condition": &vendor }]),
            1,
        ),
        (&off, &off_slug, "manual", json!([]), 0),
    ] {
        sqlx::query(
            "insert into categories (id, name, slug, type, rules, rules_match, is_active) \
             values ($1, $2, $3, $4, $5, 'all', $6)",
        )
        .bind(id)
        .bind(format!("Category {slug}"))
        .bind(slug)
        .bind(kind)
        .bind(rules)
        .bind(active)
        .execute(&env.tenant)
        .await
        .expect("category");
    }
    sqlx::query("insert into category_products (id, category_id, product_id) values ($1, $2, $3)")
        .bind(fresh("cp_"))
        .bind(&manual)
        .bind(&manual_member)
        .execute(&env.tenant)
        .await
        .expect("member");

    let by_slug = app
        .get(&format!("/products?category={auto_slug}"), &key)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(ids(&by_slug), vec![inside.clone()]);
    assert_eq!(by_slug[0]["categories"][0]["slug"], json!(auto_slug));
    let by_id = app
        .get(&format!("/products?category={manual}"), &key)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(ids(&by_id), vec![manual_member.clone()]);
    assert_eq!(by_id[0]["categories"][0]["id"], json!(manual));
    assert!(!ids(&by_slug).contains(&outside));

    // An inactive or unknown category is not found.
    for missing in [off_slug.as_str(), "nope"] {
        let reply = app
            .get(&format!("/products?category={missing}"), &key)
            .send()
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }
    // The tree lists active categories only; one is read by id or slug.
    let tree = app.get("/categories", &key).ok(StatusCode::OK).await;
    let all = ids(&tree);
    assert!(all.contains(&manual) && all.contains(&auto) && !all.contains(&off));
    let one = app
        .get(&format!("/categories/{manual_slug}"), &key)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(one["id"], json!(manual));
    assert_eq!(one["children"], json!([]));
    let reply = app.get(&format!("/categories/{off}"), &key).send().await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lists_sort_search_and_page_by_cursor() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let tag = fresh("page-");
    let mut made = Vec::new();
    for (n, price) in [("b", "30.00"), ("a", "10.00"), ("c", "20.00")] {
        made.push(
            env.product(&json!({ "name": format!("{tag}-{n}"), "price": price }))
                .await,
        );
        // Creation order decides `newest`.
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let (b, a, c) = (made[0].clone(), made[1].clone(), made[2].clone());
    let url = |sort: &str, extra: &str| format!("/products?search={tag}&sort={sort}{extra}");

    let list = |sort: &'static str| {
        let app = &app;
        let key = &key;
        let url = url(sort, "");
        async move { ids(&app.get(&url, key).ok(StatusCode::OK).await) }
    };
    assert_eq!(list("name").await, vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(list("-name").await, vec![c.clone(), b.clone(), a.clone()]);
    assert_eq!(list("price").await, vec![a.clone(), c.clone(), b.clone()]);
    assert_eq!(list("-price").await, vec![b.clone(), c.clone(), a.clone()]);
    assert_eq!(list("newest").await, vec![c.clone(), a.clone(), b.clone()]);

    // Pages of two, by cursor.
    let first = app.get(&url("price", "&limit=2"), &key).send().await;
    assert_eq!(ids(&first.body["data"]), vec![a.clone(), c.clone()]);
    assert_eq!(first.body["pagination"]["hasMore"], true);
    let cursor = first.body["pagination"]["cursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    let second = app
        .get(&url("price", &format!("&limit=2&cursor={cursor}")), &key)
        .send()
        .await;
    assert_eq!(ids(&second.body["data"]), vec![b.clone()]);
    assert_eq!(
        second.body["pagination"],
        json!({ "hasMore": false, "cursor": null })
    );

    // Bad parameters are a 400 with fields.
    let reply = app
        .get("/products?limit=500&sort=cheapest", &key)
        .send()
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.body["error"]["code"], "VALIDATION_ERROR");
    assert!(reply.body["error"]["details"]["fields"]["limit"].is_string());
    assert!(reply.body["error"]["details"]["fields"]["sort"].is_string());
}

#[tokio::test]
async fn a_cursor_is_a_keyset_that_survives_a_deleted_product() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let tag = fresh("keyset-");
    let mut made = Vec::new();
    for n in ["a", "b", "c", "d"] {
        made.push(
            env.product(&json!({ "name": format!("{tag}-{n}"), "price": "10.00" }))
                .await,
        );
    }
    let url = |extra: &str| format!("/products?search={tag}&sort=name&limit=2{extra}");
    let first = app.get(&url(""), &key).send().await;
    assert_eq!(
        ids(&first.body["data"]),
        vec![made[0].clone(), made[1].clone()]
    );
    let cursor = first.body["pagination"]["cursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    // The product the cursor ends on is deleted: paging goes on after where it was.
    sqlx::query("update products set deleted_at = now() where id = $1")
        .bind(&made[1])
        .execute(&env.tenant)
        .await
        .expect("delete");
    let second = app
        .get(&url(&format!("&cursor={cursor}")), &key)
        .send()
        .await;
    assert_eq!(second.status, StatusCode::OK, "{}", second.body);
    assert_eq!(
        ids(&second.body["data"]),
        vec![made[2].clone(), made[3].clone()]
    );
    // A cursor that is not one, or belongs to another sort, is refused.
    for bad in ["garbage".to_owned(), "eyJ4IjoxfQ".to_owned()] {
        let reply = app.get(&url(&format!("&cursor={bad}")), &key).send().await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(reply.body["error"]["code"], "INVALID_CURSOR");
    }
    let other_sort = app
        .get(
            &format!("/products?search={tag}&sort=price&limit=2&cursor={cursor}"),
            &key,
        )
        .send()
        .await;
    assert_eq!(other_sort.body["error"]["code"], "INVALID_CURSOR");
}
