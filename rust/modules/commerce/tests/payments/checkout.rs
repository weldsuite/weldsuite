//! Mollie at storefront checkout, the return page's routes, and the invoice
//! of an order placed on invoice.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, Ctx, Reply, Storefront, events_of, setup};

async fn checkout(
    app: &Storefront,
    key: &str,
    token: &str,
    idempotency: Option<&str>,
    body: Value,
) -> Reply {
    let mut headers = vec![("x-cart-token", token)];
    if let Some(key) = idempotency {
        headers.push(("idempotency-key", key));
    }
    app.call("POST", "/cart/checkout", key, &headers, Some(body))
        .await
}

async fn connect(ctx: &Ctx) {
    let staff = ctx.staff(ALL, true);
    staff.connect_key().await;
}

fn mollie(redirect: &str) -> Value {
    json!({ "paymentMethod": "mollie", "redirectUrl": redirect })
}

#[tokio::test]
async fn checkout_with_mollie_places_a_pending_order_and_starts_the_payment() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("private", &[]).await;
    let token = app.cart(&key, &product).await;

    // A redirect is required, and https.
    let reply = checkout(
        &app,
        &key,
        &token,
        None,
        json!({ "paymentMethod": "mollie" }),
    )
    .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    let reply = checkout(
        &app,
        &key,
        &token,
        None,
        mollie("http://shop.example/thanks"),
    )
    .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    assert_eq!(ctx.fake.payment_count(), 0);

    let reply = checkout(
        &app,
        &key,
        &token,
        Some("idem-1"),
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order = reply.body["data"]["order"].clone();
    assert_eq!(order["status"], "pending");
    assert_eq!(order["paymentStatus"], "pending");
    let payment = reply.body["data"]["payment"].clone();
    assert_eq!(payment["status"], "open");
    assert!(payment["id"].as_str().expect("id").starts_with("cpay_"));
    assert!(
        payment["checkoutUrl"]
            .as_str()
            .expect("url")
            .starts_with("https://pay.mollie.test/")
    );
    let order_id = order["id"].as_str().expect("order id").to_owned();

    // What Mollie was asked for.
    let create = &ctx.fake.requests_to("POST", "/payments")[0];
    let sent: Value = serde_json::from_str(&create.body).expect("json");
    assert_eq!(sent["metadata"]["orderId"], order_id.as_str());
    // The return URL carries the order and the payment the return page reads.
    let redirect = sent["redirectUrl"].as_str().expect("redirect url");
    assert!(
        redirect.starts_with(&format!(
            "https://shop.example/thanks?order={order_id}&payment=cpay_"
        )),
        "{redirect}"
    );
    assert!(
        sent["webhookUrl"]
            .as_str()
            .expect("url")
            .starts_with("https://app.test/webhooks/commerce/mollie/")
    );
    assert_eq!(
        sent["description"],
        format!("Order {}", order["orderNumber"].as_str().expect("number"))
    );
    assert_eq!(sent["amount"]["value"], order["total"]);

    // The return page asks; the shopper's return never pays: Mollie does.
    let path = format!("/payments/{}", payment["id"].as_str().expect("id"));
    let reply = app.call("GET", &path, &key, &[], None).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["status"], "open");
    assert_eq!(reply.body["data"]["orderId"], order_id.as_str());
    assert_eq!(reply.body["data"]["orderNumber"], order["orderNumber"]);
    assert_eq!(ctx.order_row(&order_id).await["paymentStatus"], "pending");
    ctx.fake
        .set_status(&ctx.fake.last_payment(), "paid", Some("ideal"));
    let reply = app.call("GET", &path, &key, &[], None).await;
    assert_eq!(reply.body["data"]["status"], "paid");
    assert_eq!(reply.body["data"]["checkoutUrl"], Value::Null);
    let row = ctx.order_row(&order_id).await;
    assert_eq!(
        (row["paymentStatus"].as_str(), row["status"].as_str()),
        (Some("paid"), Some("confirmed"))
    );

    // A paid order takes no second payment; another shop cannot see this one.
    let reply = app
        .call("POST", &format!("{path}/retry"), &key, &[], None)
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::CONFLICT, "ALREADY_PAID")
    );
    let (other_key, _, _) = ctx.shop("private", &[]).await;
    let reply = app.call("GET", &path, &other_key, &[], None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .call("GET", "/payments/cpay_unknown", &key, &[], None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:created", &order_id), 1);
    assert_eq!(events_of(&events, "order:paid", &order_id), 1);
}

#[tokio::test]
async fn a_publishable_key_may_only_redirect_to_its_own_origins() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("publishable", &["https://shop.example"]).await;
    let token = app.cart(&key, &product).await;
    let reply = checkout(
        &app,
        &key,
        &token,
        None,
        mollie("https://evil.example/thanks"),
    )
    .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_REQUEST, "REDIRECT_NOT_ALLOWED")
    );
    // Nothing was placed.
    let orders: i64 = sqlx::query_scalar("select count(*) from orders where channel_id in (select channel_id from commerce_channel_keys where key_prefix = $1)")
        .bind(&key[..16])
        .fetch_one(&ctx.tenant)
        .await
        .expect("count");
    assert_eq!(orders, 0);
    let reply = checkout(
        &app,
        &key,
        &token,
        None,
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
}

#[tokio::test]
async fn a_disconnected_shop_cannot_take_mollie_payments() {
    let Some(ctx) = setup().await else { return };
    let staff = ctx.staff(ALL, true);
    staff.connect_key().await;
    staff.delete("/commerce-payments/connection").await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("private", &[]).await;
    let token = app.cart(&key, &product).await;
    let reply = checkout(
        &app,
        &key,
        &token,
        None,
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::CONFLICT, "PAYMENT_PROVIDER_NOT_CONNECTED")
    );
}

#[tokio::test]
async fn a_provider_failure_leaves_a_pending_order_and_a_retry_starts_the_payment() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("private", &[]).await;
    let token = app.cart(&key, &product).await;

    ctx.fake.fail_create(Some((422, "The amount is too low")));
    let reply = checkout(
        &app,
        &key,
        &token,
        Some("idem-fail"),
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_GATEWAY, "PROVIDER_ERROR")
    );
    let order_id = reply.body["error"]["details"]["orderId"]
        .as_str()
        .expect("order id")
        .to_owned();
    let row = ctx.order_row(&order_id).await;
    assert_eq!(
        (row["status"].as_str(), row["paymentStatus"].as_str()),
        (Some("pending"), Some("pending"))
    );
    let payments: i64 =
        sqlx::query_scalar("select count(*) from commerce_payments where order_id = $1")
            .bind(&order_id)
            .fetch_one(&ctx.tenant)
            .await
            .expect("count");
    assert_eq!(payments, 0);

    // The same Idempotency-Key: the same order, and now a payment.
    ctx.fake.fail_create(None);
    let reply = checkout(
        &app,
        &key,
        &token,
        Some("idem-fail"),
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body["data"]["order"]["id"], order_id.as_str());
    assert_eq!(reply.body["data"]["payment"]["status"], "open");
    assert_eq!(ctx.fake.payment_count(), 1);
    let again = checkout(
        &app,
        &key,
        &token,
        Some("idem-fail"),
        mollie("https://shop.example/thanks"),
    )
    .await;
    assert_eq!(
        again.body["data"]["payment"]["id"], reply.body["data"]["payment"]["id"],
        "an open payment is reused"
    );
    assert_eq!(ctx.fake.payment_count(), 1);

    // A payment that failed: the return page's retry makes a new one.
    let payment_id = reply.body["data"]["payment"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let staff = ctx.staff(ALL, true);
    let public = crate::harness::Public(ctx.public(true));
    ctx.fake
        .set_status(&ctx.fake.last_payment(), "expired", None);
    let connection: String = sqlx::query_scalar("select id from commerce_payment_connections")
        .fetch_one(&ctx.tenant)
        .await
        .expect("connection");
    assert_eq!(
        public.webhook(&connection, &ctx.fake.last_payment()).await,
        StatusCode::OK
    );
    let reply = app
        .call("GET", &format!("/payments/{payment_id}"), &key, &[], None)
        .await;
    assert_eq!(reply.body["data"]["status"], "expired");
    let reply = app
        .call(
            "POST",
            &format!("/payments/{payment_id}/retry"),
            &key,
            &[],
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_ne!(reply.body["data"]["id"], payment_id.as_str());
    assert_eq!(reply.body["data"]["status"], "open");
    let sent: Value = serde_json::from_str(
        &ctx.fake
            .requests_to("POST", "/payments")
            .last()
            .expect("create")
            .body,
    )
    .expect("json");
    // The return URL carries the order and the payment the return page reads.
    let redirect = sent["redirectUrl"].as_str().expect("redirect url");
    assert!(
        redirect.starts_with(&format!(
            "https://shop.example/thanks?order={order_id}&payment=cpay_"
        )),
        "{redirect}"
    );
    let (_, body) = staff.get(&format!("/orders/{order_id}/payments")).await;
    assert_eq!(body["data"]["payments"].as_array().expect("list").len(), 2);
}

async fn place_invoice(app: &Storefront, key: &str, cart: &str, session: &str) -> Reply {
    app.call(
        "POST",
        "/cart/checkout",
        key,
        &[("x-cart-token", cart), ("x-shopper-token", session)],
        Some(json!({ "paymentMethod": "invoice" })),
    )
    .await
}

#[tokio::test]
async fn an_order_placed_on_invoice_gets_an_unpaid_invoice() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop_with("private", &[], "b2b", &["invoice"]).await;
    // A B2B channel orders for a company: a buyer signed in, a party with terms.
    let (company, party) = ctx.company("Invoice BV", Some("30"), None).await;
    let email = format!("{}@example.com", crate::harness::fresh("buyer"));
    ctx.buyer(&company, &email, "buyer", "active", None).await;
    let session = app.sign_in(&ctx, &key, &email).await;
    let token = app.cart(&key, &product).await;
    let reply = place_invoice(&app, &key, &token, &session).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order_id = reply.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(reply.body["data"]["order"]["paymentStatus"], "on_invoice");
    assert_eq!(reply.body["data"]["payment"], Value::Null);
    assert_eq!(ctx.books.calls(), vec![format!("invoice:{order_id}")]);
    assert_eq!(*ctx.books.paid_amounts.lock().expect("lock"), vec![None]);
    // The company's party is the customer, the buyer the person.
    let row = ctx.order_row(&order_id).await;
    assert!(row["personId"].is_string());
    assert_eq!(row["counterpartyId"], party.as_str());
    // A replay of the checkout does not invoice again.
    let reply = place_invoice(&app, &key, &token, &session).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(ctx.books.calls().len(), 1);
}
