//! Order VAT (ADR COM-014): the WeldBooks engine's treatment of every sale,
//! the tax lock and the recalculation, the refusals that write nothing, and
//! the discount an edit keeps.
//!
//! The shared seller is a Dutch entity registered for the One-Stop Shop; the
//! test that changes the seller runs on a schema of its own.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{
    ALL, TestApp, app, discount, fresh, german_vat, isolated, priced, product, read, tenant, vies,
};

async fn order(app: &TestApp, body: Value) -> (String, Value) {
    let (status, created) = app.post("/orders", &body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["data"]["id"].as_str().expect("id").to_owned();
    let order = read(app, &format!("/orders/{id}")).await;
    (id, order)
}

/// One `quantity` of `product`, shipped to `country`, with extras.
fn body(product: &str, quantity: i64, country: &str, extra: &Value) -> Value {
    let mut body = json!({
        "currency": "EUR",
        "items": [{ "productId": product, "quantity": quantity }],
        "shippingAddress": { "line1": "Straat 1", "city": "Stad", "country": country },
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        body[key] = value;
    }
    body
}

#[tokio::test]
async fn a_domestic_sale_carries_the_sellers_rate_inside_the_price() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.10").await;

    let (id, order) = order(&app, body(&widget, 2, "NL", &json!({}))).await;
    assert_eq!(order["vatTreatment"], "domestic");
    assert_eq!(order["destinationCountry"], "NL");
    assert_eq!(order["pricesIncludeTax"], true);
    assert_eq!(order["viesUnavailable"], false);
    // Gross prices stay as shown: 24.20, with 4.20 of VAT inside.
    assert_eq!(order["total"], "24.20");
    assert_eq!(order["taxTotal"], "4.20");
    assert_eq!(order["vatRelief"], "0.00");
    assert_eq!(order["items"][0]["taxRate"], "21.00");
    assert_eq!(order["items"][0]["taxAmount"], "4.20");
    assert_eq!(order["items"][0]["vatCategory"], "standard");
    assert_eq!(order["items"][0]["total"], "24.20");
    assert_eq!(
        order["taxLines"],
        json!([{ "rate": "21.00", "base": "20.00", "amount": "4.20" }])
    );
    // What is stored.
    let stored: (Option<String>, Option<String>, bool) = sqlx::query_as(
        "select vat_treatment, destination_country, prices_include_tax from orders where id = $1",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .expect("row");
    assert_eq!(
        stored,
        (Some("domestic".into()), Some("NL".into()), true),
        "{stored:?}"
    );

    // An order with no address is a domestic sale.
    let (status, created) = app
        .post(
            "/orders",
            &json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 1 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["data"]["id"].as_str().expect("id");
    let plain = read(&app, &format!("/orders/{id}")).await;
    assert_eq!(plain["vatTreatment"], "domestic");
    assert_eq!(plain["destinationCountry"], "NL");
}

#[tokio::test]
async fn net_prices_get_the_vat_on_top_and_shipping_is_taxed_too() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "10.00").await;

    let (_, order) = order(
        &app,
        body(
            &widget,
            1,
            "NL",
            &json!({ "pricesIncludeTax": false, "shippingTotal": "5.00" }),
        ),
    )
    .await;
    assert_eq!(order["pricesIncludeTax"], false);
    assert_eq!(order["subtotal"], "10.00");
    assert_eq!(order["shippingTotal"], "5.00");
    // 2.10 on the goods and 1.05 on the shipping, on top of 15.00.
    assert_eq!(order["taxTotal"], "3.15");
    assert_eq!(order["total"], "18.15");
    assert_eq!(order["items"][0]["taxAmount"], "2.10");
    assert_eq!(order["items"][0]["total"], "12.10");
}

#[tokio::test]
async fn a_quote_shows_the_vat_and_writes_nothing() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.10").await;
    let who = fresh("quote-vat-");

    let mut request = body(&widget, 1, "DE", &json!({ "customerName": &who }));
    request["billingAddress"] = json!({ "country": "DE" });
    let (status, answer) = app.post("/orders/quote", &request).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let quote = &answer["data"];
    assert_eq!(quote["vatTreatment"], "oss");
    assert_eq!(quote["destinationCountry"], "DE");
    assert_eq!(quote["pricesIncludeTax"], true);
    assert_eq!(quote["viesUnavailable"], false);
    assert_eq!(quote["total"], "12.10");
    assert_eq!(quote["taxTotal"], "1.93");
    assert_eq!(quote["lines"][0]["taxRate"], "19.00");
    assert_eq!(quote["lines"][0]["taxAmount"], "1.93");
    assert_eq!(quote["lines"][0]["vatCategory"], "standard");
    assert_eq!(
        quote["taxLines"],
        json!([{ "rate": "19.00", "base": "10.17", "amount": "1.93" }])
    );
    let written: i64 = sqlx::query_scalar("select count(*) from orders where customer_name = $1")
        .bind(&who)
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(written, 0);
}

#[tokio::test]
async fn consumers_in_other_countries_pay_the_destination_rate_with_oss() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "11.90").await;

    // The shown price is the price in every country: 11.90, 19% of it VAT.
    let (_, de) = order(&app, body(&widget, 1, "DE", &json!({}))).await;
    assert_eq!(de["vatTreatment"], "oss");
    assert_eq!(de["total"], "11.90");
    assert_eq!(de["taxTotal"], "1.90");
    assert_eq!(de["items"][0]["taxRate"], "19.00");
    // The billing address counts when there is no shipping address.
    let (_, fr) = order(
        &app,
        json!({
            "currency": "EUR",
            "items": [{ "productId": widget, "quantity": 1 }],
            "billingAddress": { "country": "fr" },
        }),
    )
    .await;
    assert_eq!(fr["destinationCountry"], "FR");
    assert_eq!(fr["items"][0]["taxRate"], "20.00");
    // Monaco is French VAT territory.
    let (_, mc) = order(&app, body(&widget, 1, "MC", &json!({}))).await;
    assert_eq!(mc["vatTreatment"], "oss");
    assert_eq!(mc["items"][0]["taxRate"], "20.00");
    // A buyer outside the EU pays the net price.
    let (_, us) = order(&app, body(&widget, 1, "US", &json!({}))).await;
    assert_eq!(us["vatTreatment"], "outside_eu");
    assert_eq!(us["taxTotal"], "0.00");
    assert_eq!(us["total"], "9.83");
    assert_eq!(us["vatRelief"], "2.07");
}

#[tokio::test]
async fn northern_ireland_is_refused_and_nothing_is_written() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "10").await;
    let who = fresh("xi-");

    let (status, answer) = app
        .post(
            "/orders",
            &body(&widget, 1, "XI", &json!({ "customerName": &who })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(answer["error"]["code"], "DESTINATION_NOT_SUPPORTED");
    let (status, answer) = app
        .post("/orders/quote", &body(&widget, 1, "XI", &json!({})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    let written: i64 = sqlx::query_scalar("select count(*) from orders where customer_name = $1")
        .bind(&who)
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(written, 0);
    // A destination that is not a country code is a 400.
    let (status, _) = app
        .post("/orders", &body(&widget, 1, "Nederland", &json!({})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_business_with_a_valid_vat_number_is_reverse_charged_on_the_net_price() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.10").await;
    let number = german_vat();
    vies(&db, &number, true).await;

    let (_, order) = order(
        &app,
        body(
            &widget,
            1,
            "DE",
            &json!({ "buyerVatNumber": &number, "shippingTotal": "6.05" }),
        ),
    )
    .await;
    assert_eq!(order["vatTreatment"], "reverse_charge");
    assert_eq!(order["buyerVatNumber"], json!(number));
    assert_eq!(order["viesUnavailable"], false);
    assert_eq!(order["taxTotal"], "0.00");
    // The seller's 21% comes off the VAT-inclusive prices: 10.00 and 5.00.
    assert_eq!(order["items"][0]["total"], "10.00");
    assert_eq!(order["total"], "15.00");
    assert_eq!(order["vatRelief"], "3.15");
    assert_eq!(order["items"][0]["taxRate"], "0.00");
    // A number VIES rejects is a consumer.
    let rejected = german_vat();
    vies(&db, &rejected, false).await;
    let (_, order) = self::order(
        &app,
        body(&widget, 1, "DE", &json!({ "buyerVatNumber": &rejected })),
    )
    .await;
    assert_eq!(order["vatTreatment"], "oss");
    assert_eq!(order["viesUnavailable"], false);
}

#[tokio::test]
async fn vies_down_charges_as_a_consumer_flags_it_and_a_recalculation_settles_it() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.10").await;
    // Not in the cache, and the app has no HTTP: VIES cannot be asked.
    let number = german_vat();

    let (id, placed) = order(
        &app,
        body(&widget, 1, "DE", &json!({ "buyerVatNumber": &number })),
    )
    .await;
    assert_eq!(placed["viesUnavailable"], true);
    assert_eq!(placed["vatTreatment"], "oss");
    assert_eq!(placed["taxTotal"], "1.93");
    assert_eq!(placed["total"], "12.10");

    // VIES is back: the recalculation reverse charges, the flag clears.
    vies(&db, &number, true).await;
    let (status, answer) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let order = &answer["data"];
    assert_eq!(order["vatTreatment"], "reverse_charge");
    assert_eq!(order["viesUnavailable"], false);
    assert_eq!(order["total"], "10.00");
    assert_eq!(order["items"][0]["id"], placed["items"][0]["id"]);
    assert_eq!(app.events_of("order:updated", &id).await.len(), 1);
}

#[tokio::test]
async fn categories_come_from_the_product_and_a_variant_may_override_them() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let book = product(
        &app,
        &json!({
            "name": "Book", "slug": fresh("b-"), "sku": fresh("B-"), "price": "10.90",
            "currency": "EUR", "status": "active", "vatCategory": "reduced"
        }),
    )
    .await;
    // The category is on the product as it is read back.
    assert_eq!(
        read(&app, &format!("/products/{book}")).await["vatCategory"],
        "reduced"
    );
    let (status, bad) = app
        .post(
            "/products",
            &json!({ "name": "Bad", "slug": fresh("x-"), "vatCategory": "cheap" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");

    let (status, variant) = app
        .post(
            &format!("/products/{book}/variants"),
            &json!({ "optionValues": { "Format": "Audio" }, "vatCategory": "zero" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{variant}");
    let zero = variant["data"]["id"].as_str().expect("variant").to_owned();
    assert_eq!(variant_category(&app, &book, &zero).await, "zero");
    let (_, inherit) = app
        .post(
            &format!("/products/{book}/variants"),
            &json!({ "optionValues": { "Format": "Paper" } }),
        )
        .await;
    let paper = inherit["data"]["id"].as_str().expect("variant").to_owned();
    assert_eq!(variant_category(&app, &book, &paper).await, Value::Null);

    let (_, order) = order(
        &app,
        json!({
            "currency": "EUR",
            "items": [
                { "productId": book, "quantity": 1 },
                { "variantId": paper, "quantity": 1 },
                { "variantId": zero, "quantity": 1, "unitPrice": "10.90" },
            ],
            "shippingAddress": { "country": "NL" },
        }),
    )
    .await;
    let rates: Vec<&Value> = order["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| &i["taxRate"])
        .collect();
    // Reduced (9%), reduced inherited, zero.
    assert_eq!(rates, vec!["9.00", "9.00", "0.00"]);
    assert_eq!(order["items"][2]["vatCategory"], "zero");
    assert_eq!(order["items"][1]["vatCategory"], "reduced");
    // A variant's category can go back to inheriting.
    let (status, back) = app
        .patch(
            &format!("/products/{book}/variants/{zero}"),
            &json!({ "vatCategory": null }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["data"]["vatCategory"], Value::Null);
    let (status, _) = app
        .patch(
            &format!("/products/{book}/variants/{zero}"),
            &json!({ "vatCategory": "luxury" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn editing_recalculates_and_a_placed_order_keeps_its_tax() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.10").await;
    let (id, placed) = order(&app, body(&widget, 1, "NL", &json!({}))).await;
    assert_eq!(placed["vatTreatment"], "domestic");

    // A note, or an address in the same country, leaves the tax alone.
    let (status, noted) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "internalNote": "hi", "shippingAddress": { "city": "Ede", "country": "NL" } }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{noted}");
    assert_eq!(noted["data"]["vatTreatment"], "domestic");
    assert_eq!(noted["data"]["taxTotal"], "2.10");

    // Moving the destination to another country is an edit: the tax follows.
    let (status, moved) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "shippingAddress": { "country": "BE" } }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["data"]["vatTreatment"], "oss");
    assert_eq!(moved["data"]["destinationCountry"], "BE");
    assert_eq!(moved["data"]["total"], "12.10");
    // So are the price basis and the quantity.
    let (_, net) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "pricesIncludeTax": false, "items": [{ "id": placed["items"][0]["id"], "quantity": 2 }] }),
        )
        .await;
    assert_eq!(net["data"]["pricesIncludeTax"], false);
    assert_eq!(net["data"]["subtotal"], "24.20");
    assert_eq!(net["data"]["taxTotal"], "5.08");
    assert_eq!(net["data"]["total"], "29.28");

    // Paid: the tax is locked, however it is asked for.
    let (status, paid) = app
        .post(&format!("/orders/{id}/mark-paid"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{paid}");
    let (status, locked) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{locked}");
    assert_eq!(locked["error"]["code"], "ORDER_TAX_LOCKED");
    let (status, _) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "shippingAddress": { "country": "FR" } }),
        )
        .await;
    // The address changes (it is a record of where it went), the tax does not.
    assert_eq!(status, StatusCode::OK);
    let after = read(&app, &format!("/orders/{id}")).await;
    assert_eq!(after["destinationCountry"], "BE");
    assert_eq!(after["taxTotal"], "5.08");
    let (status, _) = app
        .post("/orders/ord_not_there/recalculate-tax", &json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_imported_order_keeps_the_stores_tax() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let id = fresh("ord_imp_");
    sqlx::query(
        "insert into orders (id, order_number, source, status, currency, subtotal, tax_total, total, \
           external_order_id) values ($1, $2, 'shopify', 'confirmed', 'EUR', 100, 21, 121, 'ext-1')",
    )
    .bind(&id)
    .bind(fresh("SH-"))
    .execute(&db)
    .await
    .expect("imported order");
    let order = read(&app, &format!("/orders/{id}")).await;
    assert_eq!(order["vatTreatment"], "imported");
    assert_eq!(order["taxTotal"], "21.00");
    assert_eq!(order["editable"], false);
    let (status, locked) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{locked}");
    assert_eq!(locked["error"]["code"], "ORDER_TAX_LOCKED");
    let (status, _) = app
        .patch(&format!("/orders/{id}"), &json!({ "internalNote": "x" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        read(&app, &format!("/orders/{id}")).await["taxTotal"],
        "21.00"
    );
}

#[tokio::test]
async fn an_edit_keeps_a_discount_that_has_since_expired_or_been_archived() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "20.00").await;
    let code = fresh("K").to_uppercase();
    let did = discount(
        &app,
        &json!({ "name": "Keep", "code": &code, "type": "percentage", "value": "50", "status": "active" }),
    )
    .await;
    let (id, placed) = order(
        &app,
        body(&widget, 1, "NL", &json!({ "discountCode": &code })),
    )
    .await;
    assert_eq!(placed["discountId"], json!(did));
    assert_eq!(placed["total"], "10.00");

    // The code expires, and is archived and reused by another discount.
    sqlx::query("update discounts set ends_at = now() - interval '1 day', status = 'archived' where id = $1")
        .bind(&did)
        .execute(&db)
        .await
        .expect("expire");
    let other = discount(
        &app,
        &json!({ "name": "Reused", "code": &code, "type": "percentage", "value": "10", "status": "active" }),
    )
    .await;

    // A note changes nothing about the discount.
    let (status, noted) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "internalNote": "still mine" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{noted}");
    assert_eq!(noted["data"]["discountId"], json!(did));
    // An items edit re-prices by the stored discount, not by its code text.
    let (status, more) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "items": [{ "id": placed["items"][0]["id"], "quantity": 2 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{more}");
    assert_eq!(more["data"]["discountId"], json!(did));
    assert_eq!(more["data"]["discountTotal"], "20.00");
    assert_eq!(more["data"]["total"], "20.00");
    // The recalculation too.
    let (status, again) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["data"]["discountId"], json!(did));
    let uses = |discount: &str| {
        let db = db.clone();
        let discount = discount.to_owned();
        async move {
            sqlx::query_scalar::<_, i64>(
                "select count(*) from discount_redemptions where discount_id = $1",
            )
            .bind(discount)
            .fetch_one(&db)
            .await
            .expect("count")
        }
    };
    assert_eq!(uses(&did).await, 1);
    assert_eq!(uses(&other).await, 0);

    // Sending a different code is checked in full: the expired one is out,
    // the reused code now means the other discount.
    let (status, switched) = app
        .patch(&format!("/orders/{id}"), &json!({ "discountCode": &code }))
        .await;
    assert_eq!(status, StatusCode::OK, "{switched}");
    assert_eq!(
        switched["data"]["discountId"],
        json!(did),
        "same code, kept"
    );
    let code_b = fresh("L").to_uppercase();
    discount(
        &app,
        &json!({ "name": "B", "code": &code_b, "type": "percentage", "value": "25", "status": "active", "endsAt": "2020-01-01T00:00:00.000Z" }),
    )
    .await;
    let (status, refused) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "discountCode": &code_b }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "DISCOUNT_NOT_APPLICABLE");
}

#[tokio::test]
async fn without_a_seller_or_an_engine_nothing_is_written_and_tax_is_never_zero() {
    let Some(iso) = isolated().await else { return };
    let app = app(iso.db.clone(), ALL);
    let widget = priced(&app, "10").await;
    let count = || async {
        sqlx::query_scalar::<_, i64>("select count(*) from orders")
            .fetch_one(&iso.db)
            .await
            .expect("count")
    };
    let number = |status: StatusCode, answer: &Value, code: &str| {
        assert_eq!(status, code_status(code), "{answer}");
        assert_eq!(answer["error"]["code"], code, "{answer}");
    };

    // No entity at all: 409 that says what to set up.
    let (status, answer) = app
        .post("/orders", &body(&widget, 1, "NL", &json!({})))
        .await;
    number(status, &answer, "SELLER_ENTITY_REQUIRED");
    assert!(
        answer["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("legal entity in WeldBooks")),
        "{answer}"
    );
    let (status, answer) = app
        .post("/orders/quote", &body(&widget, 1, "NL", &json!({})))
        .await;
    number(status, &answer, "SELLER_ENTITY_REQUIRED");
    assert_eq!(count().await, 0);

    // A seller outside the EU.
    let us = iso.seller("US", false).await;
    let (status, answer) = app
        .post("/orders", &body(&widget, 1, "NL", &json!({})))
        .await;
    number(status, &answer, "SELLER_ENTITY_NOT_EU");
    assert_eq!(count().await, 0);
    sqlx::query("update entities set deleted_at = now() where id = $1")
        .bind(&us)
        .execute(&iso.db)
        .await
        .expect("remove");

    // A Dutch seller without OSS charges its own rate across the border.
    let nl = iso.seller("NL", false).await;
    let (status, answer) = app
        .post("/orders", &body(&widget, 1, "DE", &json!({})))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{answer}");
    let id = answer["data"]["id"].as_str().expect("id");
    let placed = read(&app, &format!("/orders/{id}")).await;
    assert_eq!(placed["vatTreatment"], "seller_rate_cross_border");
    assert_eq!(placed["items"][0]["taxRate"], "21.00");
    // Registering for OSS and recalculating moves it to Germany's rate.
    sqlx::query(
        "insert into legal_entity_registrations (id, entity_id, type, number) values ($1, $2, 'oss', 'NL123456789B01')",
    )
    .bind(fresh("ler_"))
    .bind(&nl)
    .execute(&iso.db)
    .await
    .expect("oss");
    let (status, answer) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["data"]["vatTreatment"], "oss");
    assert_eq!(answer["data"]["items"][0]["taxRate"], "19.00");
    let before = count().await;

    // The engine cannot read what it needs: 503, and nothing is written.
    sqlx::query("drop table legal_entity_registrations")
        .execute(&iso.db)
        .await
        .expect("break the engine");
    let (status, answer) = app
        .post("/orders", &body(&widget, 1, "DE", &json!({})))
        .await;
    number(status, &answer, "TAX_ENGINE_UNAVAILABLE");
    let (status, answer) = app
        .post("/orders/quote", &body(&widget, 1, "DE", &json!({})))
        .await;
    number(status, &answer, "TAX_ENGINE_UNAVAILABLE");
    let (status, answer) = app
        .post(&format!("/orders/{id}/recalculate-tax"), &json!({}))
        .await;
    number(status, &answer, "TAX_ENGINE_UNAVAILABLE");
    assert_eq!(count().await, before);
    let unchanged = read(&app, &format!("/orders/{id}")).await;
    assert_eq!(unchanged["vatTreatment"], "oss");
    // The sequence was not spent on the refused orders either.
    iso.drop_schema().await;
}

fn code_status(code: &str) -> StatusCode {
    if code == "TAX_ENGINE_UNAVAILABLE" {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::CONFLICT
    }
}

/// A variant's `vatCategory`, from the product's variant list.
async fn variant_category(app: &TestApp, product: &str, variant: &str) -> Value {
    let list = read(app, &format!("/products/{product}/variants")).await;
    list.as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == variant))
        .map_or(Value::Null, |row| row["vatCategory"].clone())
}
