//! Carts: the token, lines, addresses, discount codes, VAT of the
//! destination, shipping rates and the problems a line can have.

use http::StatusCode;
use serde_json::json;

use crate::harness::{address, cart, code, env, fresh, german_vat};

#[tokio::test]
async fn a_cart_needs_its_own_token() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let other = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let other_key = env.key(&other, "private", &[]).await;
    let widget = env.product(&json!({ "price": "12.10" })).await;

    let (token, made) = cart(&app, &key, json!([{ "productId": widget, "quantity": 2 }])).await;
    assert!(token.starts_with("wct_"));
    assert_eq!(made["status"], "open");
    assert_eq!(made["currency"], "EUR");
    assert_eq!(made["itemCount"], 2);
    assert_eq!(made["items"][0]["quantity"], 2);
    assert_eq!(made["items"][0]["unitPrice"], "12.10");
    assert_eq!(made["items"][0]["total"], "24.20");
    assert_eq!(made["subtotal"], "24.20");
    assert_eq!(made["ready"], false);
    assert_eq!(made["viesUnavailable"], false);
    assert!(made["expiresAt"].is_string());
    // Only the hash is stored.
    let stored: (String,) = sqlx::query_as("select token_hash from carts where id = $1")
        .bind(made["id"].as_str().expect("id"))
        .fetch_one(&env.tenant)
        .await
        .expect("row");
    assert_ne!(stored.0, token);
    assert_eq!(stored.0.len(), 64);

    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["id"], made["id"]);
    // No token, a wrong token, another channel's key: all CART_NOT_FOUND.
    for reply in [
        app.get("/cart", &key).send().await,
        app.get("/cart", &key).token("wct_wrong").send().await,
        app.get("/cart", &other_key).token(&token).send().await,
    ] {
        assert_eq!(
            (reply.status, code(&reply)),
            (StatusCode::NOT_FOUND, "CART_NOT_FOUND")
        );
    }
    let events = app.events().await;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["eventType"] == "cart:created" && e["entityId"] == made["id"])
            .count(),
        1
    );
    assert!(!events.iter().any(|e| e.to_string().contains(&token)));
}

#[tokio::test]
async fn lines_merge_change_and_disappear() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let widget = env.product(&json!({ "price": "10.00" })).await;
    let gadget = env.product(&json!({ "price": "5.00" })).await;
    let shirt = env
        .product(&json!({ "hasVariants": true, "price": "20.00" }))
        .await;
    let medium = env.variant(&shirt, "M", Some("21.00"), 3).await;
    let draft = env.product(&json!({ "status": "draft" })).await;
    let usd = env.product(&json!({ "currency": "USD" })).await;

    let (token, _) = cart(&app, &key, json!([])).await;
    let added = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "quantity": 1 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(added["items"].as_array().expect("items").len(), 1);
    // Adding the same product raises its quantity.
    let merged = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "quantity": 2 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(merged["items"].as_array().expect("items").len(), 1);
    assert_eq!(merged["items"][0]["quantity"], 3);
    let line = merged["items"][0]["id"].as_str().expect("line").to_owned();

    let with_variant = app
        .post(
            "/cart/items",
            &key,
            json!({ "variantId": medium, "quantity": 1 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(with_variant["items"][1]["unitPrice"], "21.00");
    assert_eq!(with_variant["items"][1]["variantName"], "M");
    assert_eq!(with_variant["subtotal"], "51.00");

    // A product with variants needs one; the variant must belong to it.
    let reply = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": shirt, "quantity": 1 }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    assert!(reply.body["error"]["details"]["fields"]["variantId"].is_string());
    let reply = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "variantId": medium, "quantity": 1 }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    // Bad quantities.
    for quantity in [json!(0), json!(-1), json!("two"), json!(1_000_000)] {
        let reply = app
            .post(
                "/cart/items",
                &key,
                json!({ "productId": gadget, "quantity": quantity }),
            )
            .token(&token)
            .send()
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{quantity}");
    }
    // Not for sale: a draft, a product with no price in EUR, an unknown one.
    for product in [&draft, &usd, &"prod_missing".to_owned()] {
        let reply = app
            .post(
                "/cart/items",
                &key,
                json!({ "productId": product, "quantity": 1 }),
            )
            .token(&token)
            .send()
            .await;
        assert_eq!(
            (reply.status, code(&reply)),
            (StatusCode::CONFLICT, "NOT_SELLABLE"),
            "{product}"
        );
    }

    // Quantity changes; zero removes; a foreign line is a 400.
    let changed = app
        .patch(
            &format!("/cart/items/{line}"),
            &key,
            json!({ "quantity": 5 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(changed["items"][0]["quantity"], 5);
    let removed = app
        .patch(
            &format!("/cart/items/{line}"),
            &key,
            json!({ "quantity": 0 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(removed["items"].as_array().expect("items").len(), 1);
    let reply = app
        .patch("/cart/items/citm_nope", &key, json!({ "quantity": 1 }))
        .token(&token)
        .send()
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let last = removed["items"][0]["id"].as_str().expect("line").to_owned();
    let emptied = app
        .delete(&format!("/cart/items/{last}"), &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(emptied["items"], json!([]));
    assert_eq!(emptied["missing"][0], "items");
}

#[tokio::test]
async fn lines_report_what_is_wrong_with_them_as_the_catalogue_moves() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let widget = env.product(&json!({ "price": "10.00" })).await;
    let scarce = env
        .product(&json!({ "price": "4.00", "track": true, "qty": 2 }))
        .await;
    let (token, _) = cart(
        &app,
        &key,
        json!([{ "productId": widget, "quantity": 1 }, { "productId": scarce, "quantity": 3 }]),
    )
    .await;
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["items"][1]["problem"], "OUT_OF_STOCK");
    assert_eq!(read["items"][1]["available"], false);
    assert_eq!(read["ready"], false);

    // The price changes on the line; the product is withdrawn.
    sqlx::query("update products set price = 11.00 where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("price");
    sqlx::query("update products set inventory_quantity = 9 where id = $1")
        .bind(&scarce)
        .execute(&env.tenant)
        .await
        .expect("stock");
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["items"][0]["unitPrice"], "11.00");
    assert_eq!(read["items"][1]["problem"], json!(null));
    sqlx::query("update products set status = 'draft' where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("draft");
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["items"][0]["problem"], "INACTIVE");
    // A withdrawn line is not in the totals.
    assert_eq!(read["subtotal"], "12.00");
    sqlx::query("update products set status = 'active' where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("active");
    sqlx::query("delete from product_prices where product_id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("prices");
    sqlx::query("update products set currency = 'USD' where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("currency");
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["items"][0]["problem"], "NO_PRICE");
}

#[tokio::test]
async fn contact_details_are_validated_and_the_destination_must_be_sold_to() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({ "countries": ["NL", "DE"] })).await;
    let key = env.key(&channel, "private", &[]).await;
    let widget = env.product(&json!({})).await;
    let (token, _) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;

    let reply = app
        .patch(
            "/cart",
            &key,
            json!({ "email": "nope", "shippingAddress": { "country": "Nederland", "city": 5 } }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    let fields = &reply.body["error"]["details"]["fields"];
    assert!(fields["email"].is_string());
    assert!(fields["shippingAddress.country"].is_string());
    assert!(fields["shippingAddress.city"].is_string());
    assert!(reply.body["error"].get("issues").is_none());

    let reply = app
        .patch("/cart", &key, json!({ "shippingAddress": address("FR") }))
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "COUNTRY_NOT_SOLD")
    );
    assert_eq!(reply.body["error"]["details"]["country"], "FR");

    let patched = app
        .patch(
            "/cart",
            &key,
            json!({
                "email": "new@example.com",
                "shippingAddress": address("nl"),
                "customerReference": "PO-7",
                "note": "Leave at the door",
            }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(patched["email"], "new@example.com");
    assert_eq!(patched["shippingAddress"]["country"], "NL");
    assert_eq!(patched["customerReference"], "PO-7");
    assert_eq!(patched["note"], "Leave at the door");
    // A null clears.
    let cleared = app
        .patch("/cart", &key, json!({ "note": null }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(cleared["note"], json!(null));
    assert_eq!(cleared["customerReference"], "PO-7");
}

#[tokio::test]
async fn the_destination_decides_the_vat() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let b2c = env.channel(&json!({})).await;
    let key = env.key(&b2c, "private", &[]).await;
    let widget = env.product(&json!({ "price": "12.10" })).await;
    let (token, before) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;
    // No destination, no VAT yet.
    assert_eq!(before["taxTotal"], "0.00");
    assert_eq!(before["vatTreatment"], json!(null));
    assert_eq!(before["items"][0]["taxRate"], json!(null));

    // Domestic: the price includes 21%.
    let nl = app
        .patch("/cart", &key, json!({ "shippingAddress": address("NL") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(nl["vatTreatment"], "domestic");
    assert_eq!(nl["items"][0]["taxRate"], "21.00");
    assert_eq!(nl["taxTotal"], "2.10");
    assert_eq!(nl["total"], "12.10");
    assert_eq!(
        nl["taxLines"],
        json!([{ "rate": "21.00", "base": "10.00", "amount": "2.10" }])
    );

    // OSS: the destination's rate, the shown price still what is paid.
    let de = app
        .patch("/cart", &key, json!({ "shippingAddress": address("DE") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(de["vatTreatment"], "oss");
    assert_eq!(de["items"][0]["taxRate"], "19.00");
    assert_eq!(de["taxTotal"], "1.93");
    assert_eq!(de["total"], "12.10");

    // Reverse charge for a business with a valid VAT number.
    let number = german_vat();
    env.vies(&number, true).await;
    let reverse = app
        .patch("/cart", &key, json!({ "buyerVatNumber": number }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(reverse["vatTreatment"], "reverse_charge");
    assert_eq!(reverse["taxTotal"], "0.00");
    assert_eq!(reverse["total"], "10.00");

    // A net (B2B) channel adds the VAT on top.
    let b2b = env
        .channel(&json!({ "audience": "b2b", "pricesIncludeTax": false }))
        .await;
    let b2b_key = env.key(&b2b, "private", &[]).await;
    let (net_token, _) = cart(
        &app,
        &b2b_key,
        json!([{ "productId": widget, "quantity": 1 }]),
    )
    .await;
    let net = app
        .patch(
            "/cart",
            &b2b_key,
            json!({ "shippingAddress": address("NL") }),
        )
        .token(&net_token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(net["pricesIncludeTax"], false);
    assert_eq!(net["subtotal"], "12.10");
    assert_eq!(net["taxTotal"], "2.54");
    assert_eq!(net["total"], "14.64");
}

#[tokio::test]
async fn shipping_rates_follow_the_destination_and_go_free_at_the_threshold() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let nl_rate = env.rate(&channel, &["NL"], "4.95", Some("30.00")).await;
    let de_rate = env.rate(&channel, &["DE"], "9.95", None).await;
    let widget = env.product(&json!({ "price": "12.10" })).await;
    let (token, _) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;

    // No destination yet, no rates.
    let none = app
        .get("/cart/shipping-rates", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(none, json!([]));
    app.patch("/cart", &key, json!({ "shippingAddress": address("NL") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    let rates = app
        .get("/cart/shipping-rates", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(
        rates,
        json!([{ "id": nl_rate, "name": "Post", "price": "4.95", "free": false }])
    );

    // A rate of another zone is refused; the right one is charged (and
    // taxed: 21% of 4.95 is inside the gross total).
    let reply = app
        .put(
            "/cart/shipping-rate",
            &key,
            json!({ "shippingRateId": de_rate }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "RATE_NOT_AVAILABLE")
    );
    let chosen = app
        .put(
            "/cart/shipping-rate",
            &key,
            json!({ "shippingRateId": nl_rate }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(
        chosen["shippingRate"],
        json!({ "id": nl_rate, "name": "Post", "price": "4.95" })
    );
    assert_eq!(chosen["shippingTotal"], "4.95");
    assert_eq!(chosen["total"], "17.05");
    // Past the free-shipping threshold the rate costs nothing.
    let more = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "quantity": 2 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(more["subtotal"], "36.30");
    assert_eq!(more["shippingTotal"], "0.00");
    assert_eq!(more["shippingRate"]["price"], "0.00");
    assert_eq!(more["total"], "36.30");
    let free = app
        .get("/cart/shipping-rates", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(free[0]["free"], true);
    // Moving the destination drops a rate that no longer serves it.
    let moved = app
        .patch("/cart", &key, json!({ "shippingAddress": address("DE") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(moved["shippingRate"], json!(null));
    assert!(
        moved["missing"]
            .as_array()
            .expect("missing")
            .contains(&json!("shippingRate"))
    );
}

#[tokio::test]
async fn discount_codes_apply_and_come_off() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let code_text = fresh("SAVE-");
    env.discount(&code_text, "10").await;
    let widget = env.product(&json!({ "price": "20.00" })).await;
    let (token, _) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;

    let reply = app
        .post("/cart/discount", &key, json!({ "code": "NOPE-NOPE" }))
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "DISCOUNT_NOT_APPLICABLE")
    );
    assert_eq!(reply.body["error"]["details"]["reason"], "NOT_FOUND");
    let unchanged = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(unchanged["discount"], json!(null));

    // Matched without regard to case.
    let applied = app
        .post(
            "/cart/discount",
            &key,
            json!({ "code": code_text.to_lowercase() }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(applied["discount"]["code"], json!(code_text));
    assert_eq!(applied["discount"]["type"], "percentage");
    assert_eq!(applied["discountTotal"], "2.00");
    assert_eq!(applied["total"], "18.00");
    assert_eq!(applied["discountProblem"], json!(null));

    let removed = app
        .delete("/cart/discount", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(removed["discount"], json!(null));
    assert_eq!(removed["total"], "20.00");
}

#[tokio::test]
async fn a_completed_cart_can_no_longer_change() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let widget = env.product(&json!({})).await;
    let (token, made) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;
    sqlx::query("update carts set status = 'completed' where id = $1")
        .bind(made["id"].as_str().expect("id"))
        .execute(&env.tenant)
        .await
        .expect("complete");
    let reply = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "quantity": 1 }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "CART_NOT_OPEN")
    );
    // It can still be read; an expired one reads as expired.
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["status"], "completed");
    sqlx::query(
        "update carts set status = 'open', expires_at = now() - interval '1 day' where id = $1",
    )
    .bind(made["id"].as_str().expect("id"))
    .execute(&env.tenant)
    .await
    .expect("expire");
    let read = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(read["status"], "expired");
}

#[tokio::test]
async fn every_cart_change_is_an_event() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    let widget = env.product(&json!({ "price": "10.00" })).await;

    let (token, made) = cart(&app, &key, json!([])).await;
    let added = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": widget, "quantity": 2 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    let line = added["items"][0]["id"].as_str().expect("line").to_owned();
    app.patch("/cart", &key, json!({ "email": "shopper@example.com" }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    app.delete(&format!("/cart/items/{line}"), &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    // A read changes nothing and publishes nothing.
    app.get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;

    let counts: Vec<_> = app
        .events()
        .await
        .into_iter()
        .filter(|e| e["eventType"] == "cart:updated" && e["entityId"] == made["id"])
        .map(|e| e["data"]["itemCount"].clone())
        .collect();
    assert_eq!(counts, vec![json!(1), json!(1), json!(0)]);
}
