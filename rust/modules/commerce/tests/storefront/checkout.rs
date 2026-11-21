//! Checkout: the order a cart becomes, every refusal, and the retry.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{App, Env, address, cart, code, env, fresh};

/// A B2B channel that takes invoices, with a flat NL rate.
async fn b2b(env: &Env) -> (String, String, String) {
    let channel = env
        .channel(&json!({
            "audience": "b2b", "pricesIncludeTax": false,
            "paymentMethods": ["mollie", "invoice"],
        }))
        .await;
    let key = env.key(&channel, "private", &[]).await;
    let rate = env.rate(&channel, &["NL", "DE"], "5.00", None).await;
    env.buyer_for_key(&channel, &key).await;
    (channel, key, rate)
}

/// A cart that is ready: one line, email, addresses and a rate.
async fn ready_cart(app: &App, key: &str, rate: &str, product: &str, quantity: i64) -> String {
    let (token, _) = cart(
        app,
        key,
        json!([{ "productId": product, "quantity": quantity }]),
    )
    .await;
    app.patch("/cart", key, json!({ "shippingAddress": address("NL") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    let ready = app
        .put(
            "/cart/shipping-rate",
            key,
            json!({ "shippingRateId": rate }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(ready["ready"], true, "{ready}");
    token
}

fn invoice() -> Value {
    json!({ "paymentMethod": "invoice" })
}

#[tokio::test]
async fn an_invoice_checkout_places_the_order_and_completes_the_cart() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let (channel, key, rate) = b2b(&env).await;
    let code_text = fresh("B2B-");
    let discount = env.discount(&code_text, "10").await;
    let widget = env
        .product(&json!({ "name": "Widget", "price": "10.00" }))
        .await;
    let token = ready_cart(&app, &key, &rate, &widget, 2).await;
    app.patch(
        "/cart",
        &key,
        json!({ "customerReference": "PO-42", "note": "Call first", "billingAddress": address("NL") }),
    )
    .token(&token)
    .ok(StatusCode::OK)
    .await;
    let priced = app
        .post("/cart/discount", &key, json!({ "code": code_text }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    // 20.00 - 2.00 discount + 5.00 shipping = 23.00, plus 21% VAT.
    assert_eq!(priced["total"], "27.83");

    let result = app
        .post(
            "/cart/checkout",
            &key,
            json!({ "paymentMethod": "invoice", "expectedTotal": "27.83" }),
        )
        .token(&token)
        .ok(StatusCode::CREATED)
        .await;
    assert_eq!(result["payment"], json!(null));
    assert_eq!(result["orderToken"], json!(null));
    let order = &result["order"];
    assert_eq!(order["status"], "confirmed");
    assert_eq!(order["paymentStatus"], "on_invoice");
    assert_eq!(order["fulfillmentStatus"], "unfulfilled");
    assert_eq!(order["total"], "27.83");
    assert_eq!(order["taxTotal"], "4.83");
    assert_eq!(order["discountTotal"], "2.00");
    assert_eq!(order["shippingTotal"], "5.00");
    assert_eq!(order["vatTreatment"], "domestic");
    assert_eq!(order["pricesIncludeTax"], false);
    assert_eq!(order["items"][0]["name"], "Widget");
    assert_eq!(order["items"][0]["quantity"], 2);
    assert_eq!(order["items"][0]["unitPrice"], "10.00");
    assert_eq!(order["items"][0]["taxRate"], "21.00");
    assert_eq!(order["shippingAddress"]["country"], "NL");
    for internal in ["internalNote", "tags", "customerEmail", "personId"] {
        assert!(order.get(internal).is_none(), "{internal}");
    }

    // The stored order: source, channel, buyer, VAT number, redemption.
    let id = order["id"].as_str().expect("id");
    let row: (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "select source, channel_id, payment_status, customer_email, customer_reference, \
               payment_method from orders where id = $1",
    )
    .bind(id)
    .fetch_one(&env.tenant)
    .await
    .expect("order");
    assert_eq!(row.0, "storefront");
    assert_eq!(row.1.as_deref(), Some(channel.as_str()));
    assert_eq!(row.2, "on_invoice");
    assert_eq!(row.3.as_deref(), Some("shopper@example.com"));
    assert_eq!(row.4.as_deref(), Some("PO-42"));
    assert_eq!(row.5.as_deref(), Some("invoice"));
    let redeemed: (i64, i32) = sqlx::query_as(
        "select (select count(*) from discount_redemptions where order_id = $1 and discount_id = $2), \
                (select usage_count from discounts where id = $2)",
    )
    .bind(id)
    .bind(&discount)
    .fetch_one(&env.tenant)
    .await
    .expect("redemption");
    assert_eq!(redeemed, (1, 1));

    // The cart is done.
    let done = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(done["status"], "completed");
    assert_eq!(done["orderId"], json!(id));
    // Events: the order and the cart, no secrets.
    let events = app.events().await;
    let created: Vec<&Value> = events
        .iter()
        .filter(|e| e["eventType"] == "order:created" && e["entityId"] == json!(id))
        .collect();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["data"]["source"], "storefront");
    assert!(
        events
            .iter()
            .any(|e| e["eventType"] == "cart:updated" && e["data"]["orderId"] == json!(id))
    );
    assert!(!events.iter().any(|e| e.to_string().contains(&token)));
}

#[tokio::test]
async fn a_retry_with_the_same_key_returns_the_same_order() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let (_, key, rate) = b2b(&env).await;
    let widget = env.product(&json!({ "price": "10.00" })).await;
    let token = ready_cart(&app, &key, &rate, &widget, 1).await;
    let send = |idem: Option<&str>| {
        let mut call = app.post("/cart/checkout", &key, invoice()).token(&token);
        if let Some(idem) = idem {
            call = call.header("idempotency-key", idem);
        }
        call.send()
    };
    let first = send(Some("attempt-1")).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.body);
    let again = send(Some("attempt-1")).await;
    assert_eq!(again.status, StatusCode::CREATED, "{}", again.body);
    assert_eq!(
        again.body["data"]["order"]["id"],
        first.body["data"]["order"]["id"]
    );
    assert_eq!(
        again.body["data"]["order"]["orderNumber"],
        first.body["data"]["order"]["orderNumber"]
    );
    let orders: i64 = sqlx::query_scalar("select count(*) from orders where id = $1")
        .bind(first.body["data"]["order"]["id"].as_str().expect("id"))
        .fetch_one(&env.tenant)
        .await
        .expect("orders");
    assert_eq!(orders, 1);
    // Without the key, or with another, a finished cart is not checked out twice.
    for idem in [None, Some("attempt-2")] {
        let reply = send(idem).await;
        assert_eq!(
            (reply.status, code(&reply)),
            (StatusCode::CONFLICT, "CART_NOT_OPEN")
        );
    }
    // Only one order event for the pair.
    let events = app.events().await;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["eventType"] == "order:created"
                && e["entityId"] == first.body["data"]["order"]["id"])
            .count(),
        1
    );
}

#[tokio::test]
async fn the_payment_method_must_be_one_the_channel_offers_and_can_run() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let widget = env.product(&json!({})).await;

    // A B2C channel never takes invoices; Mollie is not connected until phase 5.
    let b2c = env
        .channel(&json!({ "paymentMethods": ["mollie", "invoice"] }))
        .await;
    let key = env.key(&b2c, "private", &[]).await;
    let (token, _) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;
    let reply = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "PAYMENT_METHOD_NOT_ENABLED")
    );
    let reply = app
        .post("/cart/checkout", &key, json!({ "paymentMethod": "mollie" }))
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "PAYMENT_PROVIDER_NOT_CONNECTED")
    );
    // A B2B channel without invoice does not offer it either.
    let ((), only_mollie, ()) = {
        let channel = env.channel(&json!({ "audience": "b2b" })).await;
        let key = env.key(&channel, "private", &[]).await;
        ((), key, ())
    };
    let (token, _) = cart(
        &app,
        &only_mollie,
        json!([{ "productId": widget, "quantity": 1 }]),
    )
    .await;
    let reply = app
        .post("/cart/checkout", &only_mollie, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(code(&reply), "PAYMENT_METHOD_NOT_ENABLED");
    // A payment method that is not one is a 400.
    let reply = app
        .post(
            "/cart/checkout",
            &only_mollie,
            json!({ "paymentMethod": "bitcoin" }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    // Without guest checkout nobody can check out until shopper sessions exist.
    let members = env
        .channel(
            &json!({ "audience": "b2b", "paymentMethods": ["invoice"], "guestCheckout": false }),
        )
        .await;
    let members_key = env.key(&members, "private", &[]).await;
    let (token, _) = cart(
        &app,
        &members_key,
        json!([{ "productId": widget, "quantity": 1 }]),
    )
    .await;
    let reply = app
        .post("/cart/checkout", &members_key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "GUEST_CHECKOUT_DISABLED")
    );
}

#[tokio::test]
async fn a_cart_that_is_not_ready_says_what_is_missing() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let (_, key, rate) = b2b(&env).await;
    let empty = app
        .post("/carts", &key, json!({}))
        .ok(StatusCode::CREATED)
        .await;
    let token = empty["cartToken"].as_str().expect("token").to_owned();
    // As a guest (an empty session header opts out of the planted buyer).
    let reply = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .header("x-shopper-token", " ")
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "CART_NOT_READY")
    );
    assert_eq!(
        reply.body["error"]["details"]["missing"],
        json!([
            "items",
            "email",
            "shippingAddress",
            "shippingRate",
            "billingAddress"
        ])
    );

    // A line whose product was withdrawn is not ready either.
    let widget = env.product(&json!({})).await;
    let (token, _) = cart(&app, &key, json!([{ "productId": widget, "quantity": 1 }])).await;
    app.patch("/cart", &key, json!({ "shippingAddress": address("NL") }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    app.put(
        "/cart/shipping-rate",
        &key,
        json!({ "shippingRateId": rate }),
    )
    .token(&token)
    .ok(StatusCode::OK)
    .await;
    sqlx::query("update products set status = 'draft' where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("draft");
    let reply = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(code(&reply), "CART_NOT_READY");
    assert_eq!(
        reply.body["error"]["details"]["lines"][0]["problem"],
        "INACTIVE"
    );
}

#[tokio::test]
async fn stock_is_checked_but_backorders_and_untracked_stock_pass() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let (_, key, rate) = b2b(&env).await;
    let scarce = env.product(&json!({ "track": true, "qty": 1 })).await;
    let token = ready_cart(&app, &key, &rate, &scarce, 1).await;
    // Two wanted, one on hand: out of stock (checked at checkout, not reserved).
    let line = app
        .post(
            "/cart/items",
            &key,
            json!({ "productId": scarce, "quantity": 1 }),
        )
        .token(&token)
        .ok(StatusCode::OK)
        .await["items"][0]["id"]
        .clone();
    let reply = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "OUT_OF_STOCK")
    );
    assert_eq!(
        reply.body["error"]["details"]["lines"],
        json!([{ "lineId": line, "available": 1 }])
    );
    // Backorders allowed: it goes through.
    sqlx::query("update products set allow_backorder = true where id = $1")
        .bind(&scarce)
        .execute(&env.tenant)
        .await
        .expect("backorder");
    let placed = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(placed.status, StatusCode::CREATED, "{}", placed.body);
    // Untracked stock is never short.
    let untracked = env.product(&json!({ "track": false, "qty": 0 })).await;
    let token = ready_cart(&app, &key, &rate, &untracked, 50).await;
    let placed = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(placed.status, StatusCode::CREATED, "{}", placed.body);
}

#[tokio::test]
async fn a_changed_price_or_a_dead_discount_stops_the_checkout() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let (_, key, rate) = b2b(&env).await;
    let widget = env.product(&json!({ "price": "10.00" })).await;
    let token = ready_cart(&app, &key, &rate, &widget, 1).await;
    let shown = app
        .get("/cart", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    assert_eq!(shown["total"], "18.15");

    sqlx::query("update products set price = 12.00 where id = $1")
        .bind(&widget)
        .execute(&env.tenant)
        .await
        .expect("price");
    let reply = app
        .post(
            "/cart/checkout",
            &key,
            json!({ "paymentMethod": "invoice", "expectedTotal": "18.15" }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "PRICE_CHANGED")
    );
    assert_eq!(reply.body["error"]["details"]["total"], "20.57");
    // Nothing was placed.
    let cart_status: String = sqlx::query_scalar("select status from carts where id = $1")
        .bind(shown["id"].as_str().expect("id"))
        .fetch_one(&env.tenant)
        .await
        .expect("status");
    assert_eq!(cart_status, "open");

    // A code that stopped applying after it was put on the cart.
    let code_text = fresh("GONE-");
    env.discount(&code_text, "10").await;
    app.post("/cart/discount", &key, json!({ "code": code_text }))
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    sqlx::query("update discounts set status = 'archived' where code = $1")
        .bind(&code_text)
        .execute(&env.tenant)
        .await
        .expect("archive");
    let reply = app
        .post("/cart/checkout", &key, invoice())
        .token(&token)
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "DISCOUNT_NOT_APPLICABLE")
    );
    // Taken off, it goes through at the current price.
    app.delete("/cart/discount", &key)
        .token(&token)
        .ok(StatusCode::OK)
        .await;
    let placed = app
        .post(
            "/cart/checkout",
            &key,
            json!({ "paymentMethod": "invoice", "expectedTotal": "20.57" }),
        )
        .token(&token)
        .send()
        .await;
    assert_eq!(placed.status, StatusCode::CREATED, "{}", placed.body);
}
