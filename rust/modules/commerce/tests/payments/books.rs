//! What reaches WeldBooks: the invoice of a paid order, the credit note of a
//! refund, a failure that never undoes a payment, and the retry route.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, Ctx, Public, Staff, setup};

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

async fn connected(ctx: &Ctx) -> (Staff, Public, String) {
    let app = ctx.staff(ALL, true);
    let connection = app.connect_key().await["id"]
        .as_str()
        .expect("id")
        .to_owned();
    (app, Public(ctx.public(true)), connection)
}

/// An order of `total`, paid through Mollie; `(order id, provider payment id)`.
async fn paid_order(
    ctx: &Ctx,
    app: &Staff,
    public: &Public,
    connection: &str,
    total: &str,
) -> (String, String) {
    let order = ctx.order(total, "pending").await;
    let (status, body) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let provider = body["data"]["providerPaymentId"]
        .as_str()
        .expect("id")
        .to_owned();
    ctx.fake.set_status(&provider, "paid", Some("ideal"));
    assert_eq!(public.webhook(connection, &provider).await, StatusCode::OK);
    (order, provider)
}

#[tokio::test]
async fn a_paid_order_is_invoiced_with_its_payment_and_a_guest_gets_a_customer() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;
    let (order, _) = paid_order(&ctx, &app, &public, &connection, "25.00").await;
    assert_eq!(ctx.books.calls(), vec![format!("invoice:{order}")]);
    assert_eq!(
        *ctx.books.paid_amounts.lock().expect("lock"),
        vec![Some("25.00".to_owned())]
    );
    let row = ctx.order_row(&order).await;
    let person = row["personId"].as_str().expect("a person was made");
    assert!(row["counterpartyId"].is_string());
    let in_crm: bool = sqlx::query_scalar("select in_crm from people where id = $1")
        .bind(person)
        .fetch_one(&ctx.tenant)
        .await
        .expect("person");
    assert!(!in_crm, "web shoppers stay out of the CRM grid (COM-012)");
    assert_eq!(row["metadata"]["invoiceError"], Value::Null);
    // The same shopper on the next order is the same person.
    let (next, _) = paid_order(&ctx, &app, &public, &connection, "5.00").await;
    assert_eq!(ctx.order_row(&next).await["personId"], person);
    // An order that is not paid cannot be invoiced.
    let open = ctx.order("9.00", "pending").await;
    let (status, body) = app
        .post(&format!("/orders/{open}/invoice"), &json!({}))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "ORDER_NOT_INVOICEABLE")
    );
}

#[tokio::test]
async fn a_failed_invoice_never_undoes_the_payment_and_the_route_retries_it() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;
    ctx.books.fail(Some("The accounting period is locked"));
    let (order, _) = paid_order(&ctx, &app, &public, &connection, "25.00").await;
    let row = ctx.order_row(&order).await;
    assert_eq!(row["paymentStatus"], "paid", "the payment stands");
    assert_eq!(
        row["metadata"]["invoiceError"],
        "The accounting period is locked"
    );
    let (_, body) = app.get(&format!("/orders/{order}")).await;
    assert_eq!(
        body["data"]["metadata"]["invoiceError"],
        "The accounting period is locked"
    );
    assert_eq!(body["data"]["paymentStatus"], "paid");

    // Still failing: the route says so. Fixed: it makes the invoice.
    let path = format!("/orders/{order}/invoice");
    let (status, body) = app.post(&path, &json!({})).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_GATEWAY, "INVOICE_FAILED")
    );
    ctx.books.fail(None);
    let (status, body) = app.post(&path, &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["id"].is_string());
    assert!(body["data"]["number"].is_string());
    assert_eq!(body["data"]["status"], "finalized");
    let (_, body) = app.get(&format!("/orders/{order}")).await;
    assert!(body["data"]["metadata"].get("invoiceError").is_none());
}

#[tokio::test]
async fn automatic_invoicing_can_be_switched_off() {
    let Some(ctx) = setup().await else { return };
    sqlx::query("update commerce_settings set auto_invoice = false")
        .execute(&ctx.tenant)
        .await
        .expect("switch off");
    let (app, public, connection) = connected(&ctx).await;
    let (order, _) = paid_order(&ctx, &app, &public, &connection, "25.00").await;
    assert_eq!(ctx.books.calls(), Vec::<String>::new());
    assert_eq!(
        ctx.order_row(&order).await["metadata"]["invoiceError"],
        Value::Null
    );
    // The route still invoices when asked.
    let (status, _) = app
        .post(&format!("/orders/{order}/invoice"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctx.books.calls(), vec![format!("invoice:{order}")]);
}

#[tokio::test]
async fn a_refund_becomes_a_credit_note_and_a_failed_one_is_retried() {
    let Some(ctx) = setup().await else { return };
    let (app, public, connection) = connected(&ctx).await;
    let (order, provider) = paid_order(&ctx, &app, &public, &connection, "30.00").await;
    let (status, body) = app
        .post(
            &format!("/orders/{order}/refunds"),
            &json!({ "amount": "12.50", "reason": "Return" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    // Not refunded yet: no credit note yet.
    assert!(!ctx.books.calls().iter().any(|c| c.starts_with("credit:")));

    ctx.books.fail(Some("Credit notes are closed"));
    let refund = ctx.fake.refund_ids()[0].clone();
    ctx.fake.set_refund_status(&refund, "refunded");
    assert_eq!(public.webhook(&connection, &provider).await, StatusCode::OK);
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(body["data"]["refunds"][0]["status"], "refunded");
    assert_eq!(body["data"]["refunds"][0]["creditNoteId"], Value::Null);
    assert_eq!(
        ctx.order_row(&order).await["metadata"]["invoiceError"],
        "Credit notes are closed"
    );
    assert_eq!(
        ctx.order_row(&order).await["paymentStatus"],
        "partially_refunded"
    );

    ctx.books.fail(None);
    let (status, _) = app
        .post(&format!("/orders/{order}/invoice"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = app.get(&format!("/orders/{order}/payments")).await;
    assert!(body["data"]["refunds"][0]["creditNoteId"].is_string());
    assert_eq!(
        *ctx.books.credit_amounts.lock().expect("lock"),
        vec!["12.50".to_owned()]
    );
}
