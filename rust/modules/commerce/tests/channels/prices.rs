//! `/api/products/:id/prices` and the price resolution it feeds.

use http::StatusCode;
use serde_json::json;
use weldsuite_commerce_domain::prices::{Target, resolve, resolve_many};

use crate::harness::{ALL, app, fresh, product, read, side, tenant};

#[tokio::test]
async fn replace_the_whole_set_and_resolve() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let id = product(&app, "10.00").await;
    let path = format!("/products/{id}/prices");
    assert_eq!(read(&app, &path).await, json!([]));

    let (status, body) = app
        .put(
            &path,
            &json!({ "prices": [
                { "currency": "usd", "price": "11.50", "compareAtPrice": 14 },
                { "currency": "SEK", "price": "119" },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["data"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["currency"], "SEK");
    assert_eq!(rows[0]["price"], "119.00");
    assert_eq!(rows[0]["compareAtPrice"], json!(null));
    assert_eq!(rows[0]["variantId"], json!(null));
    assert_eq!(rows[0]["productId"], json!(id));
    assert_eq!(rows[1]["currency"], "USD");
    assert_eq!(rows[1]["compareAtPrice"], "14.00");
    assert_eq!(app.events_of("product:updated", &id).await.len(), 1);
    let usd = rows[1]["id"].as_str().unwrap().to_owned();

    // Replace: USD stays (same row, new price), SEK is dropped, GBP is new.
    let (status, body) = app
        .put(
            &path,
            &json!({ "prices": [
                { "currency": "USD", "price": "12" },
                { "currency": "GBP", "price": "8.99", "compareAtPrice": null },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = read(&app, &path).await;
    let currencies: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["currency"].as_str().unwrap())
        .collect();
    assert_eq!(currencies, ["GBP", "USD"]);
    let kept = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["currency"] == "USD")
        .unwrap();
    assert_eq!(kept["id"], json!(usd));
    assert_eq!(kept["price"], "12.00");
    assert_eq!(kept["compareAtPrice"], json!(null));
    // Soft deleted, not gone.
    let dropped: i64 = sqlx::query_scalar(
        "select count(*) from product_prices where product_id = $1 and currency = 'SEK' and deleted_at is not null",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(dropped, 1);

    // Resolution: base currency from the product, others from the rows.
    let mut conn = side().acquire().await.unwrap();
    let price = resolve(&mut conn, &id, None, "EUR").await.unwrap().unwrap();
    assert_eq!(price.price, 1000);
    let price = resolve(&mut conn, &id, None, "usd").await.unwrap().unwrap();
    assert_eq!((price.price, price.compare_at), (1200, None));
    // No price in a currency nobody listed.
    assert!(
        resolve(&mut conn, &id, None, "SEK")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        resolve(&mut conn, "prd_missing", None, "EUR")
            .await
            .unwrap()
            .is_none()
    );

    // Emptying the set removes them all.
    let (status, _) = app.put(&path, &json!({ "prices": [] })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read(&app, &path).await, json!([]));
    assert!(
        resolve(&mut conn, &id, None, "USD")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_variant_overrides_the_product() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let id = product(&app, "10.00").await;
    // Two variants through the option matrix.
    let (status, body) = app
        .post(
            &format!("/products/{id}/variants/generate"),
            &json!({ "options": [{ "name": "Size", "values": ["S", "M"] }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let variants: Vec<String> = sqlx::query_scalar(
        "select id from product_variants where product_id = $1 and deleted_at is null order by name",
    )
    .bind(&id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(variants.len(), 2, "{body}");
    let (small, medium) = (&variants[0], &variants[1]);
    sqlx::query("update product_variants set price = '12.00' where id = $1")
        .bind(small)
        .execute(&db)
        .await
        .unwrap();

    let path = format!("/products/{id}/prices");
    let (status, body) = app
        .put(
            &path,
            &json!({ "prices": [
                { "currency": "USD", "price": "20" },
                { "variantId": small, "currency": "USD", "price": "25", "compareAtPrice": "30" },
                { "variantId": small, "currency": "EUR", "price": "11" },
            ] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["data"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    // Product rows first within a currency.
    assert_eq!(rows[0]["currency"], "EUR");
    assert_eq!(rows[0]["variantId"], json!(small));

    let mut conn = side().acquire().await.unwrap();
    // Variant row beats the variant's own base price (EUR 11, not 12).
    let p = resolve(&mut conn, &id, Some(small), "EUR")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(p.price, 1100);
    // Variant row in another currency, with its compare-at.
    let p = resolve(&mut conn, &id, Some(small), "USD")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((p.price, p.compare_at), (2500, Some(3000)));
    // The other variant has no row and no price: the product's serve it.
    let p = resolve(&mut conn, &id, Some(medium), "USD")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(p.price, 2000);
    let p = resolve(&mut conn, &id, Some(medium), "EUR")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(p.price, 1000);
    // No price in a currency nothing lists.
    assert!(
        resolve(&mut conn, &id, Some(small), "SEK")
            .await
            .unwrap()
            .is_none()
    );
    // A variant of another product has none.
    let other = product(&app, "3").await;
    assert!(
        resolve(&mut conn, &other, Some(small), "EUR")
            .await
            .unwrap()
            .is_none()
    );

    // The batch form agrees.
    let targets = vec![
        Target {
            product_id: id.clone(),
            variant_id: Some(small.clone()),
        },
        Target {
            product_id: id.clone(),
            variant_id: Some(medium.clone()),
        },
        Target {
            product_id: id.clone(),
            variant_id: None,
        },
        Target {
            product_id: other.clone(),
            variant_id: None,
        },
    ];
    let found = resolve_many(&mut conn, &targets, "USD").await.unwrap();
    assert_eq!(found[&targets[0]].price, 2500);
    assert_eq!(found[&targets[1]].price, 2000);
    assert_eq!(found[&targets[2]].price, 2000);
    assert!(!found.contains_key(&targets[3]));

    // A price row of a variant must belong to the product.
    let (status, body) = app
        .put(
            &path,
            &json!({ "prices": [{ "variantId": "pvr_nope", "currency": "USD", "price": "1" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // The set is untouched by a refused replace.
    assert_eq!(read(&app, &path).await.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn validation_and_unknown_products() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let id = product(&app, "10").await;
    let path = format!("/products/{id}/prices");
    for body in [
        json!({}),
        json!({ "prices": [{ "currency": "EURO", "price": "1" }] }),
        json!({ "prices": [{ "currency": "USD" }] }),
        json!({ "prices": [{ "currency": "USD", "price": "-1" }] }),
        json!({ "prices": [{ "currency": "USD", "price": "abc" }] }),
        // The same currency twice for the product.
        json!({ "prices": [{ "currency": "USD", "price": "1" }, { "currency": "usd", "price": "2" }] }),
    ] {
        let (status, answer) = app.put(&path, &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }
    let (status, _) = app
        .get(&format!("/products/{}/prices", fresh("prd_")))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .put(
            &format!("/products/{}/prices", fresh("prd_")),
            &json!({ "prices": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// A manual order in a currency other than the product's base one is priced
/// from `product_prices` (`orders::lines::resolve` is what the quote and the
/// order write price their lines with).
#[tokio::test]
async fn an_order_line_in_another_currency_gets_its_price_row() {
    use weldsuite_commerce_domain::orders::lines::{LineInput, resolve as price_lines};

    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let id = product(&app, "10.00").await;
    let line = || LineInput {
        product_id: Some(id.clone()),
        quantity: 2,
        ..LineInput::default()
    };
    let mut conn = side().acquire().await.unwrap();

    // No USD price yet: the base price is in EUR, so the line has a problem.
    let lines = price_lines(&mut conn, "USD", &[line()], &[]).await.unwrap();
    assert_eq!(lines[0].problem, Some("CURRENCY_MISMATCH"));
    // The base currency is unchanged.
    let lines = price_lines(&mut conn, "EUR", &[line()], &[]).await.unwrap();
    assert_eq!((lines[0].problem, lines[0].unit_price), (None, 1000));

    let (status, body) = app
        .put(
            &format!("/products/{id}/prices"),
            &json!({ "prices": [{ "currency": "USD", "price": "11.50" }, { "currency": "EUR", "price": "9.00" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let lines = price_lines(&mut conn, "USD", &[line()], &[]).await.unwrap();
    assert_eq!((lines[0].problem, lines[0].unit_price), (None, 1150));
    // A price row for the base currency overrides the base price too.
    let lines = price_lines(&mut conn, "EUR", &[line()], &[]).await.unwrap();
    assert_eq!(lines[0].unit_price, 900);
    // An explicit price on the line is the staff member's and stays.
    let explicit = LineInput {
        unit_price: Some(777),
        ..line()
    };
    let lines = price_lines(&mut conn, "USD", &[explicit], &[])
        .await
        .unwrap();
    assert_eq!(lines[0].unit_price, 777);
}
