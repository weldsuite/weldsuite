//! `/api/products/:id/variants`: the option matrix, codes unique among live
//! products and variants, the counts on the product, and the events.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, TestApp, app, fresh, ids, product, read, tenant};

async fn variants(app: &TestApp, product: &str) -> Vec<Value> {
    read(app, &format!("/products/{product}/variants"))
        .await
        .as_array()
        .expect("variants")
        .clone()
}

fn find<'a>(variants: &'a [Value], size: &str, colour: &str) -> &'a Value {
    variants
        .iter()
        .find(|v| v["optionValues"]["Size"] == size && v["optionValues"]["Colour"] == colour)
        .unwrap_or_else(|| panic!("{size} / {colour} in {variants:?}"))
}

#[tokio::test]
async fn generate_fills_the_matrix_and_keeps_what_exists() {
    let Some(db) = tenant() else { return };
    let app = app(db.clone(), ALL);
    let tee = product(
        &app,
        &json!({ "name": "Tee", "slug": fresh("tee-"), "sku": fresh("TEE-"), "price": "20.00", "currency": "EUR" }),
    )
    .await;

    let (status, body) = app
        .post(
            &format!("/products/{tee}/variants/generate"),
            &json!({ "options": [
                { "name": "Size", "values": ["S", "M"] },
                { "name": "Colour", "values": ["Red", "Blue"] },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["created"], 4);
    assert_eq!(body["data"]["kept"], 0);
    assert_eq!(body["data"]["variants"].as_array().map(Vec::len), Some(4));

    let row = read(&app, &format!("/products/{tee}")).await;
    assert_eq!(row["hasVariants"], true);
    assert_eq!(row["variantCount"], 4);
    assert_eq!(
        row["options"],
        json!([{ "name": "Size", "values": ["S", "M"] }, { "name": "Colour", "values": ["Red", "Blue"] }])
    );

    // The stock ledger's column is never written here: set it as the ledger
    // would and check the next generate leaves it.
    let first = variants(&app, &tee).await;
    let small_red = find(&first, "S", "Red")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    sqlx::query("update product_variants set inventory_quantity = 7 where id = $1")
        .bind(&small_red)
        .execute(&db)
        .await
        .expect("stock");

    let (status, body) = app
        .post(
            &format!("/products/{tee}/variants/generate"),
            &json!({ "options": [
                { "name": "size", "values": ["s", "M", "L"] },
                { "name": "Colour", "values": ["Red", "Blue"] },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["created"], 2, "only L is new");
    assert_eq!(body["data"]["kept"], 4);

    let all = variants(&app, &tee).await;
    assert_eq!(all.len(), 6);
    let positions: Vec<i64> = all.iter().filter_map(|v| v["position"].as_i64()).collect();
    assert_eq!(positions, [0, 1, 2, 3, 4, 5], "by position");
    let kept = find(&all, "S", "Red");
    assert_eq!(kept["id"], small_red.as_str());
    assert_eq!(kept["inventoryQuantity"], 7);
    assert_eq!(kept["name"], "S / Red");
    assert_eq!(kept["price"], Value::Null, "the product's price");
    assert_eq!(kept["currency"], "EUR");
    assert_eq!(kept["status"], "active");
    assert_eq!(find(&all, "L", "Blue")["inventoryQuantity"], 0);
    assert_eq!(
        read(&app, &format!("/products/{tee}")).await["variantCount"],
        6
    );

    // Limits.
    for options in [
        json!([{ "name": "A", "values": ["1"] }, { "name": "B", "values": ["1"] },
               { "name": "C", "values": ["1"] }, { "name": "D", "values": ["1"] }]),
        json!([{ "name": "A", "values": (0..11).map(|n| n.to_string()).collect::<Vec<_>>() },
               { "name": "B", "values": (0..10).map(|n| n.to_string()).collect::<Vec<_>>() }]),
    ] {
        let (status, body) = app
            .post(
                &format!("/products/{tee}/variants/generate"),
                &json!({ "options": options }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let (status, _) = app
        .post(
            "/products/prod_missing/variants/generate",
            &json!({ "options": [{ "name": "Size", "values": ["S"] }] }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let events = app.events_of("product:updated", &tee).await;
    assert_eq!(events.len(), 2, "one per generate");
    assert_eq!(events[1]["data"]["id"], tee.as_str());
}

#[tokio::test]
async fn variant_writes_keep_codes_and_options_unique() {
    let Some(db) = tenant() else { return };
    let app = app(db, ALL);
    let product_sku = fresh("HOODIE-");
    let hoodie = product(
        &app,
        &json!({ "name": "Hoodie", "slug": fresh("hoodie-"), "sku": product_sku, "price": "40.00",
                 "options": [{ "name": "Size", "values": ["M"] }] }),
    )
    .await;
    let other = product(
        &app,
        &json!({ "name": "Other", "slug": fresh("other-"), "barcode": fresh("871") }),
    )
    .await;
    let other_barcode = read(&app, &format!("/products/{other}")).await["barcode"]
        .as_str()
        .expect("barcode")
        .to_owned();
    let path = format!("/products/{hoodie}/variants");

    let sku = fresh("HOODIE-M-");
    let (status, body) = app
        .post(
            &path,
            &json!({ "optionValues": { "size": "m" }, "sku": sku, "price": 42.5 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let medium = body["data"]["id"].as_str().expect("id").to_owned();

    // Same options, whatever the case.
    let (status, body) = app
        .post(&path, &json!({ "optionValues": { "Size": "M" } }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["field"], "optionValues");

    // A SKU another variant, or a product, has; a barcode a product has.
    for (body, field) in [
        (
            json!({ "optionValues": { "Size": "L" }, "sku": sku }),
            "sku",
        ),
        (
            json!({ "optionValues": { "Size": "L" }, "sku": product_sku }),
            "sku",
        ),
        (
            json!({ "optionValues": { "Size": "L" }, "barcode": other_barcode }),
            "barcode",
        ),
    ] {
        let (status, answer) = app.post(&path, &body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}: {answer}");
        assert_eq!(answer["error"]["code"], "CONFLICT");
        assert_eq!(answer["error"]["details"]["field"], field);
    }

    let (status, body) = app
        .post(
            &path,
            &json!({ "optionValues": { "Size": "L" }, "sku": fresh("HOODIE-L-"), "price": "44.00", "status": "draft" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let large = body["data"]["id"].as_str().expect("id").to_owned();

    let all = read(&app, &path).await;
    assert_eq!(ids(&all), [medium.clone(), large.clone()]);
    assert_eq!(
        all[0]["optionValues"],
        json!({ "Size": "M" }),
        "the product's spelling"
    );
    assert_eq!(all[0]["price"], "42.50");
    assert_eq!(all[1]["status"], "draft");
    let row = read(&app, &format!("/products/{hoodie}")).await;
    assert_eq!(row["variantCount"], 2);
    assert_eq!(
        row["options"],
        json!([{ "name": "Size", "values": ["M", "L"] }])
    );

    // PATCH: its own SKU again is fine, another's is not; options must stay
    // unique; a null price falls back to the product's.
    let variant = |id: &str| format!("{path}/{id}");
    let (status, body) = app
        .patch(
            &variant(&medium),
            &json!({ "sku": sku, "price": null, "position": 5 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "data": { "id": medium } }));
    let (status, body) = app.patch(&variant(&large), &json!({ "sku": sku })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, body) = app
        .patch(
            &variant(&large),
            &json!({ "optionValues": { "Size": "M" } }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, body) = app
        .patch(
            &variant(&large),
            &json!({ "optionValues": { "Size": "XL" }, "barcode": "" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let all = read(&app, &path).await;
    assert_eq!(ids(&all), [large.clone(), medium.clone()], "by position");
    assert_eq!(all[0]["name"], "XL");
    assert_eq!(all[1]["price"], Value::Null);
    let (status, _) = app
        .patch(&variant("pvr_missing"), &json!({ "status": "active" }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .patch(
            &format!("/products/{other}/variants/{large}"),
            &json!({ "status": "active" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "another product's variant");

    // DELETE: soft, and the counts follow; a deleted variant's SKU is free.
    let (status, _) = app.delete(&variant(&medium)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app.delete(&variant(&medium)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(ids(&read(&app, &path).await), std::slice::from_ref(&large));
    assert_eq!(
        read(&app, &format!("/products/{hoodie}")).await["variantCount"],
        1
    );
    let (status, body) = app.patch(&variant(&large), &json!({ "sku": sku })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = app.delete(&variant(&large)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let row = read(&app, &format!("/products/{hoodie}")).await;
    assert_eq!(row["variantCount"], 0);
    assert_eq!(row["hasVariants"], false);

    // Bad bodies, a missing product.
    for body in [
        json!({}),
        json!({ "optionValues": {} }),
        json!({ "optionValues": { "Size": "S" }, "price": "-1" }),
    ] {
        let (status, answer) = app.post(&path, &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }
    let (status, _) = app.get("/products/prod_missing/variants").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Every successful write: product:updated for the hoodie.
    assert_eq!(app.events_of("product:updated", &hoodie).await.len(), 7);
}
