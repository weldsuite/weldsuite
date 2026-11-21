//! The payments of an order: the payment link, Mollie's webhook, failed
//! attempts, refunds, and the read-back on read.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, Ctx, Public, Staff, events_of, setup};

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

async fn link(app: &Staff, order: &str) -> Value {
    let (status, body) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["data"].clone()
}

/// A connected workspace and an order to pay; `(app, public, connection id)`.
async fn connected(ctx: &Ctx) -> (Staff, Public, String) {
    let app = ctx.staff(ALL, true);
    let connection = app.connect_key().await;
    let id = connection["id"].as_str().expect("id").to_owned();
    (app, Public(ctx.public(true)), id)
}

/// Mollie reports the order's payment paid and the webhook arrives.
async fn pay(ctx: &Ctx, public: &Public, connection: &str, payment: &Value) {
    let provider = payment["providerPaymentId"].as_str().expect("provider id");
    ctx.fake.set_status(provider, "paid", Some("ideal"));
    assert_eq!(public.webhook(connection, provider).await, StatusCode::OK);
}

#[tokio::test]
async fn a_payment_link_is_paid_once_when_mollie_says_so() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.staff(ALL, true);
    let order = ctx.order("25.00", "pending").await;

    // Not connected yet.
    let (status, body) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "PAYMENT_PROVIDER_NOT_CONNECTED")
    );
    let (status, _) = app.post("/orders/nope/payment-link", &json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (app, public, connection) = connected(&ctx).await;
    let payment = link(&app, &order).await;
    assert_eq!(payment["status"], "open");
    assert_eq!(payment["amount"], "25.00");
    assert!(
        payment["checkoutUrl"]
            .as_str()
            .expect("url")
            .starts_with("https://pay.mollie.test/")
    );
    // What Mollie was asked for.
    let create = &ctx.fake.requests_to("POST", "/payments")[0];
    let sent: Value = serde_json::from_str(&create.body).expect("json");
    assert_eq!(
        sent["amount"],
        json!({ "currency": "EUR", "value": "25.00" })
    );
    assert_eq!(sent["metadata"]["orderId"], order.as_str());
    assert_eq!(sent["metadata"]["workspace"], crate::harness::WORKSPACE);
    assert_eq!(
        sent["webhookUrl"],
        format!("https://app.test/webhooks/commerce/mollie/{connection}")
    );
    assert!(
        sent["description"]
            .as_str()
            .expect("text")
            .starts_with("Order PAY-")
    );
    assert!(
        sent["redirectUrl"]
            .as_str()
            .expect("url")
            .starts_with("https://app.test/")
    );
    // A second click shows the same open payment.
    assert_eq!(link(&app, &order).await["id"], payment["id"]);
    assert_eq!(ctx.fake.payment_count(), 1);

    // Nothing is paid until Mollie says so: not by a webhook that lies...
    assert_eq!(
        public.webhook(&connection, "tr_unknown").await,
        StatusCode::OK
    );
    assert_eq!(
        public.webhook("cpc_unknown", "tr_unknown").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        public.webhook_body(&connection, "nothing=1").await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        public.webhook_body(&connection, "id=../x").await,
        StatusCode::BAD_REQUEST
    );
    let provider = payment["providerPaymentId"]
        .as_str()
        .expect("provider id")
        .to_owned();
    assert_eq!(public.webhook(&connection, &provider).await, StatusCode::OK);
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "pending");

    // ...and then it is, once.
    pay(&ctx, &public, &connection, &payment).await;
    let row = ctx.order_row(&order).await;
    assert_eq!(row["paymentStatus"], "paid");
    assert_eq!(row["status"], "confirmed");
    assert_eq!(row["paymentMethod"], "ideal");
    assert!(!row["paidAt"].is_null());
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    let paid = &body["data"]["payments"][0];
    assert_eq!(paid["status"], "paid");
    assert_eq!(paid["method"], "ideal");
    assert_eq!(paid["checkoutUrl"], Value::Null);
    assert!(!paid["paidAt"].is_null());
    assert_eq!(paid["amountRefunded"], "0.00");
    let (_, body) = app.get(&format!("/orders/{order}")).await;
    assert_eq!(body["data"]["amountPaid"], "25.00");
    assert_eq!(body["data"]["amountRefunded"], "0.00");
    // The same webhook again changes nothing.
    assert_eq!(public.webhook(&connection, &provider).await, StatusCode::OK);
    let (status, body) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "ALREADY_PAID")
    );

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:paid", &order), 1);
    assert!(events_of(&events, "order:updated", &order) >= 1);
    assert_eq!(ctx.books.calls(), vec![format!("invoice:{order}")]);
}

#[tokio::test]
async fn a_cancelled_or_invoiced_order_takes_no_payment() {
    let Some(ctx) = setup().await else { return };
    let (app, _, _) = connected(&ctx).await;
    let on_invoice = ctx.order("10.00", "on_invoice").await;
    let (status, body) = app
        .post(&format!("/orders/{on_invoice}/payment-link"), &json!({}))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "ORDER_NOT_PAYABLE")
    );
    let cancelled = ctx.order("10.00", "pending").await;
    sqlx::query("update orders set status = 'cancelled' where id = $1")
        .bind(&cancelled)
        .execute(&ctx.tenant)
        .await
        .expect("cancel");
    let (status, body) = app
        .post(&format!("/orders/{cancelled}/payment-link"), &json!({}))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "ORDER_NOT_PAYABLE")
    );
}

#[tokio::test]
async fn failed_expired_and_cancelled_payments_leave_the_order_to_retry() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;
    let order = ctx.order("40.00", "pending").await;

    for (index, state) in ["expired", "canceled", "failed"].into_iter().enumerate() {
        let payment = link(&app, &order).await;
        let provider = payment["providerPaymentId"]
            .as_str()
            .expect("id")
            .to_owned();
        ctx.fake.set_status(&provider, state, None);
        assert_eq!(public.webhook(&connection, &provider).await, StatusCode::OK);
        let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
        let shown = &body["data"]["payments"][index];
        assert_eq!(shown["status"], state);
        assert_eq!(shown["checkoutUrl"], Value::Null);
        assert!(shown["failureReason"].is_string(), "{shown}");
        let row = ctx.order_row(&order).await;
        assert_eq!(row["paymentStatus"], "failed", "after {state}");
        assert_eq!(row["status"], "pending");
    }
    // Three attempts, three payments at Mollie, and a fourth that succeeds.
    assert_eq!(ctx.fake.payment_count(), 3);
    let payment = link(&app, &order).await;
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "pending");
    pay(&ctx, &public, &connection, &payment).await;
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "paid");
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["payments"].as_array().expect("list").len(), 4);
}

#[tokio::test]
async fn refunds_full_partial_too_large_and_refused() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;

    // Nothing paid, nothing to refund.
    let unpaid = ctx.order("10.00", "pending").await;
    let (status, body) = app
        .post(
            &format!("/orders/{unpaid}/refunds"),
            &json!({ "amount": "1.00" }),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "NOTHING_TO_REFUND")
    );

    let order = ctx.order("30.00", "pending").await;
    let payment = link(&app, &order).await;
    pay(&ctx, &public, &connection, &payment).await;
    let refunds = format!("/orders/{order}/refunds");

    // A bad amount; more than was paid.
    let (status, _) = app.post(&refunds, &json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.post(&refunds, &json!({ "amount": "0.00" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = app.post(&refunds, &json!({ "amount": "30.01" })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "REFUND_TOO_LARGE")
    );
    assert_eq!(body["error"]["details"]["refundable"], "30.00");

    // A partial refund starts queued; Mollie says when it is done.
    let (status, body) = app
        .post(&refunds, &json!({ "amount": "10.00", "reason": "Damaged" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first = body["data"].clone();
    assert_eq!(first["status"], "queued");
    assert_eq!(first["amount"], "10.00");
    assert_eq!(first["reason"], "Damaged");
    assert_eq!(first["creditNoteId"], Value::Null);
    assert!(first["providerRefundId"].is_string());
    // What is on its way is spent already.
    let (status, body) = app.post(&refunds, &json!({ "amount": "20.01" })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "REFUND_TOO_LARGE")
    );
    assert_eq!(body["error"]["details"]["refundable"], "20.00");
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["payments"][0]["amountRefunded"], "10.00");
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "paid");

    let refund_one = ctx.fake.refund_ids()[0].clone();
    ctx.fake.set_refund_status(&refund_one, "refunded");
    let provider = payment["providerPaymentId"].as_str().expect("id");
    assert_eq!(public.webhook(&connection, provider).await, StatusCode::OK);
    assert_eq!(public.webhook(&connection, provider).await, StatusCode::OK);
    assert_eq!(
        ctx.order_row(&order).await["paymentStatus"],
        "partially_refunded"
    );
    let (_, body) = app.get(&format!("/orders/{order}")).await;
    assert_eq!(body["data"]["amountRefunded"], "10.00");
    assert_eq!(body["data"]["amountPaid"], "30.00");
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    let shown = &body["data"]["refunds"][0];
    assert_eq!(shown["status"], "refunded");
    assert!(!shown["refundedAt"].is_null());
    assert!(
        shown["creditNoteId"]
            .as_str()
            .is_some_and(|id| id.starts_with("cn_fake_"))
    );
    assert_eq!(
        ctx.books.credit_amounts.lock().expect("lock").clone(),
        vec!["10.00".to_owned()]
    );

    // The rest, with no payment named: the default is the paid payment.
    let (status, body) = app.post(&refunds, &json!({ "amount": "20.00" })).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let refund_two = ctx.fake.refund_ids()[1].clone();
    ctx.fake.set_refund_status(&refund_two, "refunded");
    assert_eq!(public.webhook(&connection, provider).await, StatusCode::OK);
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "refunded");
    let (status, body) = app.post(&refunds, &json!({ "amount": "0.01" })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "NOTHING_TO_REFUND")
    );

    // A refund Mollie refuses is a 502 with its message, and frees the amount.
    let other = ctx.order("12.00", "pending").await;
    let payment = link(&app, &other).await;
    pay(&ctx, &public, &connection, &payment).await;
    ctx.fake
        .fail_refund(Some((422, "The amount is higher than the payment")));
    let path = format!("/orders/{other}/refunds");
    let (status, body) = app.post(&path, &json!({ "amount": "5.00" })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_GATEWAY, "PROVIDER_ERROR")
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("text")
            .contains("higher than the payment")
    );
    let (_, body) = app.get(&format!("/orders/{other}/payments")).await;
    assert_eq!(body["data"]["refunds"][0]["status"], "failed");
    assert_eq!(body["data"]["payments"][0]["amountRefunded"], "0.00");
    ctx.fake.fail_refund(None);
    let (status, _) = app.post(&path, &json!({ "amount": "12.00" })).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "the failed refund freed its amount"
    );

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:refunded", &order), 2);
    assert_eq!(events_of(&events, "order:paid", &order), 1);
}

#[tokio::test]
async fn a_refund_made_in_mollie_is_picked_up() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;
    let order = ctx.order("20.00", "pending").await;
    let payment = link(&app, &order).await;
    pay(&ctx, &public, &connection, &payment).await;
    // Mollie's dashboard refunds 5.00 without WeldSuite asking.
    let provider = payment["providerPaymentId"].as_str().expect("id");
    let dashboard = crate::harness::dashboard_refund(&ctx, provider, "5.00");
    ctx.fake.set_refund_status(&dashboard, "refunded");
    assert_eq!(public.webhook(&connection, provider).await, StatusCode::OK);
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["refunds"][0]["amount"], "5.00");
    assert_eq!(body["data"]["refunds"][0]["status"], "refunded");
    assert_eq!(
        ctx.order_row(&order).await["paymentStatus"],
        "partially_refunded"
    );
}

#[tokio::test]
async fn an_open_payment_is_read_back_when_the_order_is_read() {
    let Some(ctx) = setup().await else { return };
    let (app, _, _) = connected(&ctx).await;
    let order = ctx.order("15.00", "pending").await;
    let payment = link(&app, &order).await;
    let provider = payment["providerPaymentId"]
        .as_str()
        .expect("id")
        .to_owned();
    ctx.fake.set_status(&provider, "paid", Some("creditcard"));

    // Younger than a minute: no look at Mollie, nothing changes.
    let reads = || {
        ctx.fake
            .requests_to("GET", &format!("/payments/{provider}"))
            .len()
    };
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["payments"][0]["status"], "open");
    assert_eq!(reads(), 0);

    // Older: read back on read, the order follows.
    sqlx::query("update commerce_payments set updated_at = now() at time zone 'utc' - interval '2 minutes' where order_id = $1")
        .bind(&order)
        .execute(&ctx.tenant)
        .await
        .expect("age");
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["payments"][0]["status"], "paid");
    assert_eq!(body["data"]["payments"][0]["method"], "creditcard");
    assert_eq!(reads(), 1);
    assert_eq!(ctx.order_row(&order).await["paymentStatus"], "paid");
    let (_, again) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(again["data"]["payments"][0]["status"], "paid");
    assert_eq!(reads(), 1, "a paid payment is not read again");
}
