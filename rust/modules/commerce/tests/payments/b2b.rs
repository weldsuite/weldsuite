//! B2B on the storefront and in staff's hands (phase 6, ADR COM-012): the
//! company a buyer orders for, pay on invoice against the party's terms and
//! credit limit, approvals (buyer limit and company threshold, approve and
//! reject, by the company's approvers and by staff), and the buyers of a
//! company. Mollie and WeldBooks are the faked ones of the harness.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, Ctx, Reply, Storefront, events_of, fresh, setup};

fn session(token: &str) -> Vec<(&str, &str)> {
    vec![("x-shopper-token", token)]
}

/// A B2B shop that takes invoice and Mollie: `(key, product, channel)`.
async fn shop(ctx: &Ctx) -> (String, String, String) {
    ctx.shop_with("private", &[], "b2b", &["mollie", "invoice"])
        .await
}

async fn place(
    app: &Storefront,
    key: &str,
    product: &str,
    token: Option<&str>,
    body: Value,
) -> Reply {
    let cart = app.cart(key, product).await;
    let mut headers = vec![("x-cart-token", cart.as_str())];
    if let Some(token) = token {
        headers.push(("x-shopper-token", token));
    }
    app.call("POST", "/cart/checkout", key, &headers, Some(body))
        .await
}

fn invoice() -> Value {
    json!({ "paymentMethod": "invoice" })
}

fn code(reply: &Reply) -> &str {
    reply.code()
}

#[tokio::test]
async fn a_b2b_checkout_needs_a_company_and_pay_on_invoice_needs_terms_and_credit() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, product, _) = shop(&ctx).await;

    // A guest and a shopper without a company cannot order here.
    let reply = place(&app, &key, &product, None, invoice()).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "COMPANY_REQUIRED")
    );
    let loner = app
        .sign_in(&ctx, &key, &format!("{}@example.com", fresh("loner")))
        .await;
    let reply = place(&app, &key, &product, Some(&loner), invoice()).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "COMPANY_REQUIRED")
    );

    // A company without payment terms.
    let (no_terms, _) = ctx.company("No Terms BV", None, None).await;
    let email = format!("{}@example.com", fresh("noterms"));
    ctx.buyer(&no_terms, &email, "buyer", "active", None).await;
    let token = app.sign_in(&ctx, &key, &email).await;
    let reply = place(&app, &key, &product, Some(&token), invoice()).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "NO_PAYMENT_TERMS")
    );
    // Nothing was placed: no order for this company's party.
    let placed: i64 = sqlx::query_scalar(
        "select count(*) from orders o join parties p on p.id = o.counterparty_id where p.company_id = $1",
    )
    .bind(&no_terms)
    .fetch_one(&ctx.tenant)
    .await
    .expect("count");
    assert_eq!(placed, 0);

    // A credit limit of 10 against an order of 12.10; and one with 90 owed already.
    let (small, small_party) = ctx.company("Small BV", Some("net 14"), Some(10)).await;
    let email = format!("{}@example.com", fresh("small"));
    ctx.buyer(&small, &email, "buyer", "active", None).await;
    let token = app.sign_in(&ctx, &key, &email).await;
    let reply = place(&app, &key, &product, Some(&token), invoice()).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "CREDIT_LIMIT_EXCEEDED")
    );
    assert_eq!(reply.body["error"]["details"]["available"], "10.00");
    sqlx::query("update parties set credit_limit = $2, outstanding_balance = 90 where id = $1")
        .bind(&small_party)
        .bind(json!({ "amount": 100, "currency": "EUR" }))
        .execute(&ctx.tenant)
        .await
        .expect("limit");
    let reply = place(&app, &key, &product, Some(&token), invoice()).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "CREDIT_LIMIT_EXCEEDED")
    );
    assert_eq!(reply.body["error"]["details"]["available"], "10.00");

    // Within the limit: the order is the company's, on invoice, invoiced with
    // the party's terms.
    sqlx::query("update parties set outstanding_balance = 80 where id = $1")
        .bind(&small_party)
        .execute(&ctx.tenant)
        .await
        .expect("balance");
    let reply = place(&app, &key, &product, Some(&token), invoice()).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order = reply.body["data"]["order"].clone();
    assert_eq!(order["paymentStatus"], "on_invoice");
    assert_eq!(order["status"], "confirmed");
    assert_eq!(order["approvalStatus"], "not_required");
    let id = order["id"].as_str().expect("id").to_owned();
    let (party, person): (Option<String>, Option<String>) =
        sqlx::query_as("select counterparty_id, person_id from orders where id = $1")
            .bind(&id)
            .fetch_one(&ctx.tenant)
            .await
            .expect("order");
    assert_eq!(
        party.as_deref(),
        Some(small_party.as_str()),
        "the company's party pays"
    );
    assert!(person.is_some(), "the buyer placed it");
    assert!(ctx.books.calls().contains(&format!("invoice:{id}")));
    // Another one now exceeds it: the open order on invoice counts once it
    // has no invoice (it has one here, so only the party's balance does).
    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:created", &id), 1);
}

#[tokio::test]
async fn an_order_above_the_buyers_limit_waits_for_an_approver() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, product, _) = shop(&ctx).await;
    let (company, party) = ctx.company("Limits BV", Some("30"), None).await;
    let buyer_email = format!("{}@example.com", fresh("buyer"));
    let approver_email = format!("{}@example.com", fresh("approver"));
    let plain_email = format!("{}@example.com", fresh("plain"));
    ctx.buyer(&company, &buyer_email, "buyer", "active", Some("10.00"))
        .await;
    ctx.buyer(&company, &approver_email, "approver", "active", None)
        .await;
    ctx.buyer(&company, &plain_email, "buyer", "active", None)
        .await;
    let buyer = app.sign_in(&ctx, &key, &buyer_email).await;

    let reply = place(&app, &key, &product, Some(&buyer), invoice()).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order = reply.body["data"]["order"].clone();
    let id = order["id"].as_str().expect("id").to_owned();
    assert_eq!(order["approvalStatus"], "pending");
    assert_eq!(
        order["status"], "pending",
        "not confirmed before an approver says so"
    );
    assert_eq!(order["paymentStatus"], "on_invoice");
    // No invoice, nothing released.
    assert!(!ctx.books.calls().contains(&format!("invoice:{id}")));
    let (reason, requester): (String, Option<String>) = sqlx::query_as(
        "select reason, requested_by_person_id from order_approvals where order_id = $1 and decision = 'pending'",
    )
    .bind(&id)
    .fetch_one(&ctx.tenant)
    .await
    .expect("approval");
    assert_eq!(reason, "buyer_limit");
    assert!(requester.is_some());
    // The approver was told; the buyer got the confirmation saying it waits.
    let asked = ctx.mails_to(&approver_email);
    assert!(
        asked.iter().any(
            |(_, text)| text.contains(&order["orderNumber"].as_str().unwrap_or("?").to_owned())
        ),
        "{asked:?}"
    );
    // The confirmation goes to the address on the order (the cart's).
    let confirmation = ctx
        .mails_to("shopper@example.com")
        .into_iter()
        .find(|(_, text)| text.contains(order["orderNumber"].as_str().unwrap_or("?")))
        .expect("the confirmation");
    assert!(
        confirmation.1.to_lowercase().contains("approval"),
        "{}",
        confirmation.1
    );

    // A pending order cannot be confirmed, paid, or sent a payment link.
    let staff = ctx.staff(ALL, true);
    let (status, body) = staff
        .patch(&format!("/orders/{id}"), &json!({ "status": "confirmed" }))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("APPROVAL_PENDING"))
    );
    let (status, body) = staff
        .patch(&format!("/orders/{id}"), &json!({ "status": "processing" }))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("APPROVAL_PENDING"))
    );
    let (status, body) = staff
        .post(&format!("/orders/{id}/mark-paid"), &json!({}))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("APPROVAL_PENDING"))
    );
    staff.connect_key().await;
    let (status, body) = staff
        .post(&format!("/orders/{id}/payment-link"), &json!({}))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("ORDER_NOT_PAYABLE"))
    );
    // The staff order shows the approval, the list filters on it.
    let (_, body) = staff.get(&format!("/orders/{id}")).await;
    assert_eq!(body["data"]["approvalStatus"], "pending");
    assert_eq!(body["data"]["approval"]["status"], "pending");
    assert_eq!(body["data"]["approval"]["reason"], "buyer_limit");
    assert_eq!(
        body["data"]["approval"]["requestedBy"]["name"],
        buyer_email.as_str()
    );
    assert_eq!(body["data"]["approval"]["decidedBy"], Value::Null);
    let (_, body) = staff.get("/orders?approvalStatus=pending&limit=100").await;
    assert!(
        body["data"]
            .as_array()
            .expect("list")
            .iter()
            .any(|o| o["id"] == id.as_str())
    );
    let (_, body) = staff.get("/orders?approvalStatus=rejected&limit=100").await;
    assert!(
        !body["data"]
            .as_array()
            .expect("list")
            .iter()
            .any(|o| o["id"] == id.as_str())
    );

    // Only an approver or admin of the company sees and decides.
    let plain = app.sign_in(&ctx, &key, &plain_email).await;
    let reply = app
        .call("GET", "/account/approvals", &key, &session(&plain), None)
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "NOT_AN_APPROVER")
    );
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/approve"),
            &key,
            &session(&plain),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "NOT_AN_APPROVER")
    );
    let reply = app.call("GET", "/account/approvals", &key, &[], None).await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::UNAUTHORIZED, "SESSION_REQUIRED")
    );
    // The buyer sees the order, but not as an approver.
    let approver = app.sign_in(&ctx, &key, &approver_email).await;
    let reply = app
        .call("GET", "/account/approvals", &key, &session(&approver), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let waiting = reply.body["data"].as_array().expect("approvals");
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0]["order"]["id"], id.as_str());
    assert_eq!(waiting[0]["reason"], "buyer_limit");
    assert_eq!(waiting[0]["requestedBy"]["name"], buyer_email.as_str());
    // The approver also sees the company's orders in their account.
    let reply = app
        .call(
            "GET",
            &format!("/account/orders/{id}"),
            &key,
            &session(&approver),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = app
        .call(
            "GET",
            &format!("/account/orders/{id}"),
            &key,
            &session(&plain),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // Approved: confirmed, invoiced with the party's terms, the buyer told.
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/approve"),
            &key,
            &session(&approver),
            Some(json!({ "comment": "Go ahead" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["approvalStatus"], "approved");
    assert_eq!(reply.body["data"]["status"], "confirmed");
    assert!(ctx.books.calls().contains(&format!("invoice:{id}")));
    let told = ctx.mails_to(&buyer_email);
    assert!(
        told.iter().any(|(_, text)| text.contains("Go ahead")),
        "{told:?}"
    );
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/approve"),
            &key,
            &session(&approver),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "NOT_PENDING")
    );
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/reject"),
            &key,
            &session(&approver),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "NOT_PENDING")
    );
    let reply = app
        .call(
            "POST",
            "/account/approvals/ord_nope/approve",
            &key,
            &session(&approver),
            Some(json!({})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let (_, body) = staff.get(&format!("/orders/{id}")).await;
    assert_eq!(body["data"]["approval"]["status"], "approved");
    assert_eq!(body["data"]["approval"]["comment"], "Go ahead");
    assert_eq!(
        body["data"]["approval"]["decidedBy"]["name"],
        approver_email.as_str()
    );
    let _ = party;

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:approved", &id), 1);
    assert!(events_of(&events, "order:updated", &id) >= 1);
}

#[tokio::test]
async fn an_order_above_the_companys_threshold_is_paid_after_its_approval() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    ctx.staff(ALL, true).connect_key().await;
    let (key, product, _) = shop(&ctx).await;
    let (company, _) = ctx.company("Threshold BV", Some("30"), None).await;
    ctx.threshold(&company, "12.00").await;
    let buyer_email = format!("{}@example.com", fresh("buyer"));
    let admin_email = format!("{}@example.com", fresh("admin"));
    ctx.buyer(&company, &buyer_email, "buyer", "active", Some("500.00"))
        .await;
    ctx.buyer(&company, &admin_email, "admin", "active", None)
        .await;
    let buyer = app.sign_in(&ctx, &key, &buyer_email).await;

    let reply = place(
        &app,
        &key,
        &product,
        Some(&buyer),
        json!({ "paymentMethod": "mollie", "redirectUrl": "https://shop.example/thanks" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let id = reply.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(reply.body["data"]["order"]["approvalStatus"], "pending");
    assert_eq!(
        reply.body["data"]["payment"],
        Value::Null,
        "no payment before the approval"
    );
    assert_eq!(ctx.fake.payment_count(), 0);
    let reason: String =
        sqlx::query_scalar("select reason from order_approvals where order_id = $1")
            .bind(&id)
            .fetch_one(&ctx.tenant)
            .await
            .expect("reason");
    assert_eq!(reason, "company_threshold");

    // The admin approves: the payment starts and its link goes to the buyer.
    let admin = app.sign_in(&ctx, &key, &admin_email).await;
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/approve"),
            &key,
            &session(&admin),
            Some(json!({})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let payment = reply.body["data"]["payment"].clone();
    assert_eq!(payment["status"], "open");
    let url = payment["checkoutUrl"]
        .as_str()
        .expect("checkout url")
        .to_owned();
    assert!(url.starts_with("https://pay.mollie.test/"));
    assert_eq!(ctx.fake.payment_count(), 1);
    assert_eq!(
        reply.body["data"]["status"], "pending",
        "pending until it is paid"
    );
    let told = ctx.mails_to(&buyer_email);
    assert!(told.iter().any(|(_, text)| text.contains(&url)), "{told:?}");
    // It returns to the shop the buyer asked for.
    let sent: Value =
        serde_json::from_str(&ctx.fake.requests_to("POST", "/payments")[0].body).expect("json");
    assert!(
        sent["redirectUrl"]
            .as_str()
            .expect("url")
            .starts_with("https://shop.example/thanks?order=")
    );
}

#[tokio::test]
async fn a_rejected_order_is_cancelled_and_gives_its_discount_back() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, product, _) = shop(&ctx).await;
    let (company, _) = ctx.company("Reject BV", Some("30"), None).await;
    let buyer_email = format!("{}@example.com", fresh("buyer"));
    let approver_email = format!("{}@example.com", fresh("approver"));
    ctx.buyer(&company, &buyer_email, "buyer", "active", Some("5.00"))
        .await;
    ctx.buyer(&company, &approver_email, "approver", "active", None)
        .await;
    let code = fresh("B2B");
    let discount = fresh("disc_");
    sqlx::query(
        "insert into discounts (id, name, code, type, value, currency, applies_to, status) \
         values ($1, 'Ten', $2, 'percentage', 10, 'EUR', 'all', 'active')",
    )
    .bind(&discount)
    .bind(&code)
    .execute(&ctx.tenant)
    .await
    .expect("discount");
    let buyer = app.sign_in(&ctx, &key, &buyer_email).await;
    let cart = app.cart(&key, &product).await;
    let reply = app
        .call(
            "POST",
            "/cart/discount",
            &key,
            &[("x-cart-token", &cart)],
            Some(json!({ "code": code })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let reply = app
        .call(
            "POST",
            "/cart/checkout",
            &key,
            &[("x-cart-token", &cart), ("x-shopper-token", &buyer)],
            Some(invoice()),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let id = reply.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let used: Option<i32> = sqlx::query_scalar("select usage_count from discounts where id = $1")
        .bind(&discount)
        .fetch_one(&ctx.tenant)
        .await
        .expect("usage");
    assert_eq!(used, Some(1));

    let approver = app.sign_in(&ctx, &key, &approver_email).await;
    let reply = app
        .call(
            "POST",
            &format!("/account/approvals/{id}/reject"),
            &key,
            &session(&approver),
            Some(json!({ "comment": "Not this month" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["approvalStatus"], "rejected");
    assert_eq!(reply.body["data"]["status"], "cancelled");
    let used: Option<i32> = sqlx::query_scalar("select usage_count from discounts where id = $1")
        .bind(&discount)
        .fetch_one(&ctx.tenant)
        .await
        .expect("usage");
    assert_eq!(used, Some(0), "the redemption is given back");
    let redemptions: i64 =
        sqlx::query_scalar("select count(*) from discount_redemptions where order_id = $1")
            .bind(&id)
            .fetch_one(&ctx.tenant)
            .await
            .expect("redemptions");
    assert_eq!(redemptions, 0);
    assert!(
        !ctx.books.calls().contains(&format!("invoice:{id}")),
        "a rejected order is never invoiced"
    );
    let told = ctx.mails_to(&buyer_email);
    assert!(
        told.iter().any(|(_, text)| text.contains("Not this month")),
        "{told:?}"
    );
    // Staff cannot decide it again.
    let staff = ctx.staff(ALL, false);
    let (status, body) = staff
        .post(&format!("/orders/{id}/approve"), &json!({}))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("NOT_PENDING"))
    );
    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:rejected", &id), 1);
    assert_eq!(events_of(&events, "order:cancelled", &id), 1);
}

#[tokio::test]
async fn staff_can_decide_a_pending_order_with_the_right_permission() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, product, _) = shop(&ctx).await;
    let (company, _) = ctx.company("Staff BV", Some("30"), None).await;
    let buyer_email = format!("{}@example.com", fresh("buyer"));
    ctx.buyer(&company, &buyer_email, "buyer", "active", Some("5.00"))
        .await;
    let buyer = app.sign_in(&ctx, &key, &buyer_email).await;
    let one = place(&app, &key, &product, Some(&buyer), invoice()).await;
    let one = one.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let two = place(&app, &key, &product, Some(&buyer), invoice()).await;
    let two = two.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();

    let reader = ctx.staff(&["orders:read"], false);
    let (status, _) = reader
        .post(&format!("/orders/{one}/approve"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = reader
        .post(&format!("/orders/{one}/reject"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let staff = ctx.staff(ALL, false);
    let (status, body) = staff.post("/orders/ord_nope/approve", &json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = staff
        .post(
            &format!("/orders/{one}/approve"),
            &json!({ "comment": "Checked by phone" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["approvalStatus"], "approved");
    assert_eq!(body["data"]["status"], "confirmed");
    assert_eq!(body["data"]["approval"]["comment"], "Checked by phone");
    assert_eq!(
        body["data"]["approval"]["decidedBy"]["userId"],
        crate::harness::USER
    );
    assert!(
        body["data"]["approval"]["decidedBy"]["name"]
            .as_str()
            .is_some()
    );
    assert!(ctx.books.calls().contains(&format!("invoice:{one}")));
    let (status, body) = staff
        .post(&format!("/orders/{one}/approve"), &json!({}))
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("NOT_PENDING"))
    );
    let (status, body) = staff
        .post(
            &format!("/orders/{two}/reject"),
            &json!({ "comment": "No" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "cancelled");
    assert_eq!(body["data"]["approval"]["status"], "rejected");
    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:approved", &one), 1);
    assert_eq!(events_of(&events, "order:rejected", &two), 1);
}

#[tokio::test]
async fn staff_manage_the_buyers_and_the_approval_threshold_of_a_company() {
    let Some(ctx) = setup().await else { return };
    let (company, _) = ctx.company("Buyers BV", Some("30"), None).await;
    let staff = ctx.staff(ALL, false);
    let reader = ctx.staff(&["companies:read"], false);
    let nobody = ctx.staff(&["orders:read"], false);
    let email = format!("{}@Example.com", fresh("new"));

    let body = json!({ "companyId": company, "email": email, "firstName": "Nina", "lastName": "Buyer",
        "role": "approver", "spendLimit": "250.00", "spendLimitCurrency": "eur" });
    let (status, _) = reader.post("/commerce-buyers", &body).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = nobody.get("/commerce-buyers").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for bad in [
        json!({ "companyId": company, "email": "nope", "role": "buyer" }),
        json!({ "companyId": company, "email": email, "role": "boss" }),
        json!({ "companyId": company, "email": email, "role": "buyer", "spendLimit": "10.00" }),
        json!({ "email": email, "role": "buyer" }),
    ] {
        let (status, _) = staff.post("/commerce-buyers", &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (status, body_) = staff
        .post(
            "/commerce-buyers",
            &json!({ "companyId": "comp_nope", "email": email, "role": "buyer" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body_}");

    let (status, made) = staff.post("/commerce-buyers", &body).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let buyer = made["data"].clone();
    let id = buyer["id"].as_str().expect("id").to_owned();
    assert_eq!(buyer["status"], "invited");
    assert_eq!(buyer["role"], "approver");
    assert_eq!(buyer["spendLimit"], "250.00");
    assert_eq!(buyer["spendLimitCurrency"], "EUR");
    assert_eq!(buyer["name"], "Nina Buyer");
    assert_eq!(buyer["email"], email.as_str());
    assert!(buyer["invitedAt"].as_str().is_some());
    assert_eq!(buyer["acceptedAt"], Value::Null);
    // The person is hidden from the CRM grid and linked to the company.
    let (in_crm, linked): (bool, i64) = sqlx::query_as(
        "select p.in_crm, (select count(*) from person_companies where person_id = p.id and company_id = $2) \
         from people p where p.id = $1",
    )
    .bind(buyer["personId"].as_str())
    .bind(&company)
    .fetch_one(&ctx.tenant)
    .await
    .expect("person");
    assert!(!in_crm);
    assert_eq!(linked, 1);
    // Invited by mail, with no code or token in it.
    let invitations = ctx.mails_to(&email);
    assert_eq!(invitations.len(), 1, "{invitations:?}");
    assert!(invitations[0].1.contains("Buyers BV"));
    let (status, _) = staff.post("/commerce-buyers", &body).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A silent invite sends nothing; the invite route sends it again.
    let quiet = format!("{}@example.com", fresh("quiet"));
    let (status, q) = staff
        .post(
            "/commerce-buyers",
            &json!({ "companyId": company, "email": quiet, "role": "buyer", "sendInvite": false }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{q}");
    assert_eq!(ctx.mails_to(&quiet).len(), 0);
    let (status, _) = staff
        .post(
            &format!(
                "/commerce-buyers/{}/invite",
                q["data"]["id"].as_str().expect("id")
            ),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(ctx.mails_to(&quiet).len(), 1);
    let (status, _) = staff
        .post("/commerce-buyers/cbuy_nope/invite", &json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // List, filter, change, clear the limit, disable, remove.
    let (_, listed) = reader
        .get(&format!("/commerce-buyers?companyId={company}"))
        .await;
    assert_eq!(listed["data"].as_array().map(Vec::len), Some(2));
    let (_, listed) = reader
        .get(&format!(
            "/commerce-buyers?personId={}",
            buyer["personId"].as_str().expect("person")
        ))
        .await;
    assert_eq!(listed["data"].as_array().map(Vec::len), Some(1));
    let (status, changed) = staff
        .patch(
            &format!("/commerce-buyers/{id}"),
            &json!({ "role": "admin", "spendLimit": null }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["data"]["role"], "admin");
    assert_eq!(changed["data"]["spendLimit"], Value::Null);
    assert_eq!(changed["data"]["spendLimitCurrency"], Value::Null);
    let (status, changed) = staff
        .patch(
            &format!("/commerce-buyers/{id}"),
            &json!({ "status": "disabled" }),
        )
        .await;
    assert_eq!(
        (status, changed["data"]["status"].as_str()),
        (StatusCode::OK, Some("disabled"))
    );
    let (status, _) = staff
        .patch(
            &format!("/commerce-buyers/{id}"),
            &json!({ "status": "gone" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = staff.patch("/commerce-buyers/cbuy_nope", &json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = staff.delete(&format!("/commerce-buyers/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = staff.delete(&format!("/commerce-buyers/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The same person can be added again after the removal.
    let (status, _) = staff.post("/commerce-buyers", &body).await;
    assert_eq!(status, StatusCode::CREATED);

    // The approval threshold.
    let (status, settings) = reader
        .get(&format!("/commerce-company-settings/{company}"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        settings["data"],
        json!({ "companyId": company, "approvalThreshold": null, "approvalThresholdCurrency": null })
    );
    let (status, _) = reader
        .call(
            "PUT",
            &format!("/commerce-company-settings/{company}"),
            Some(&json!({ "approvalThreshold": "1000.00", "approvalThresholdCurrency": "EUR" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, saved) = staff
        .call(
            "PUT",
            &format!("/commerce-company-settings/{company}"),
            Some(&json!({ "approvalThreshold": "1000.00", "approvalThresholdCurrency": "eur" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["data"]["approvalThreshold"], "1000.00");
    assert_eq!(saved["data"]["approvalThresholdCurrency"], "EUR");
    let (status, _) = staff
        .call(
            "PUT",
            &format!("/commerce-company-settings/{company}"),
            Some(&json!({ "approvalThreshold": "1000.00" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, cleared) = staff
        .call(
            "PUT",
            &format!("/commerce-company-settings/{company}"),
            Some(&json!({ "approvalThreshold": null })),
        )
        .await;
    assert_eq!(
        (status, cleared["data"]["approvalThreshold"].clone()),
        (StatusCode::OK, Value::Null)
    );
    let (status, _) = staff
        .call(
            "PUT",
            "/commerce-company-settings/comp_nope",
            Some(&json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "commerce_buyer:created", &id), 1);
    assert_eq!(events_of(&events, "commerce_buyer:invited", &id), 1);
    assert_eq!(events_of(&events, "commerce_buyer:updated", &id), 2);
    assert_eq!(events_of(&events, "commerce_buyer:deleted", &id), 1);
    assert_eq!(
        events_of(&events, "commerce_company_settings:updated", &company),
        2
    );
    // Nothing secret is in an event.
    let text = serde_json::to_string(&events).expect("events");
    assert!(!text.contains("wss_") && !text.contains("wot_"));
}

#[tokio::test]
async fn a_company_admin_manages_the_buyers_of_their_company_only() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, _, _) = shop(&ctx).await;
    let (company, _) = ctx.company("Admin BV", Some("30"), None).await;
    let (other, _) = ctx.company("Other BV", Some("30"), None).await;
    let admin_email = format!("{}@example.com", fresh("admin"));
    let plain_email = format!("{}@example.com", fresh("plain"));
    let foreign_email = format!("{}@example.com", fresh("foreign"));
    ctx.buyer(&company, &admin_email, "admin", "active", None)
        .await;
    ctx.buyer(&company, &plain_email, "buyer", "active", None)
        .await;
    ctx.buyer(&other, &foreign_email, "buyer", "active", None)
        .await;
    let admin = app.sign_in(&ctx, &key, &admin_email).await;
    let plain = app.sign_in(&ctx, &key, &plain_email).await;

    let reply = app
        .call("GET", "/account/buyers", &key, &session(&plain), None)
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "NOT_AN_ADMIN")
    );
    let reply = app
        .call(
            "POST",
            "/account/buyers",
            &key,
            &session(&plain),
            Some(json!({ "email": "x@example.com", "role": "buyer" })),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "NOT_AN_ADMIN")
    );
    let reply = app
        .call("GET", "/account/buyers", &key, &session(&admin), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"].as_array().map(Vec::len), Some(2));
    assert!(reply.body["data"][0]["email"].as_str().is_some());

    // Invite: found or made, linked, invited by email with the shop's name.
    let new_email = format!("{}@example.com", fresh("invited"));
    for bad in [
        json!({ "role": "buyer" }),
        json!({ "email": new_email, "role": "king" }),
        json!({ "email": new_email, "role": "buyer", "spendLimit": "abc" }),
    ] {
        let reply = app
            .call(
                "POST",
                "/account/buyers",
                &key,
                &session(&admin),
                Some(bad.clone()),
            )
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let reply = app
        .call(
            "POST",
            "/account/buyers",
            &key,
            &session(&admin),
            Some(json!({ "email": new_email, "firstName": "Ivo", "role": "buyer", "spendLimit": "75.00" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let invited = reply.body["data"].clone();
    assert_eq!(invited["status"], "invited");
    assert_eq!(invited["spendLimit"], "75.00");
    assert_eq!(invited["spendLimitCurrency"], "EUR");
    assert_eq!(ctx.mails_to(&new_email).len(), 1);
    let reply = app
        .call(
            "POST",
            "/account/buyers",
            &key,
            &session(&admin),
            Some(json!({ "email": new_email, "role": "buyer" })),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "BUYER_EXISTS")
    );
    // The invitation is accepted at the first sign-in.
    app.sign_in(&ctx, &key, &new_email).await;
    let status: String = sqlx::query_scalar("select status from commerce_buyers where id = $1")
        .bind(invited["id"].as_str())
        .fetch_one(&ctx.tenant)
        .await
        .expect("status");
    assert_eq!(status, "active");

    // Change one; not one of another company.
    let invited_id = invited["id"].as_str().expect("id").to_owned();
    let reply = app
        .call(
            "PATCH",
            &format!("/account/buyers/{invited_id}"),
            &key,
            &session(&admin),
            Some(json!({ "role": "approver", "spendLimit": null })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["role"], "approver");
    assert_eq!(reply.body["data"]["spendLimit"], Value::Null);
    let foreign: String =
        sqlx::query_scalar("select id from commerce_buyers where company_id = $1")
            .bind(&other)
            .fetch_one(&ctx.tenant)
            .await
            .expect("foreign");
    let reply = app
        .call(
            "PATCH",
            &format!("/account/buyers/{foreign}"),
            &key,
            &session(&admin),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .call(
            "DELETE",
            &format!("/account/buyers/{foreign}"),
            &key,
            &session(&admin),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // The last admin stays.
    let admin_buyer: String = sqlx::query_scalar(
        "select b.id from commerce_buyers b join people p on p.id = b.person_id where p.email = $1",
    )
    .bind(&admin_email)
    .fetch_one(&ctx.tenant)
    .await
    .expect("admin buyer");
    let reply = app
        .call(
            "PATCH",
            &format!("/account/buyers/{admin_buyer}"),
            &key,
            &session(&admin),
            Some(json!({ "role": "buyer" })),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "LAST_ADMIN")
    );
    let reply = app
        .call(
            "PATCH",
            &format!("/account/buyers/{admin_buyer}"),
            &key,
            &session(&admin),
            Some(json!({ "status": "disabled" })),
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "LAST_ADMIN")
    );
    let reply = app
        .call(
            "DELETE",
            &format!("/account/buyers/{admin_buyer}"),
            &key,
            &session(&admin),
            None,
        )
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::CONFLICT, "LAST_ADMIN")
    );
    // With a second admin the first may step down.
    let reply = app
        .call(
            "PATCH",
            &format!("/account/buyers/{invited_id}"),
            &key,
            &session(&admin),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = app
        .call(
            "DELETE",
            &format!("/account/buyers/{admin_buyer}"),
            &key,
            &session(&admin),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    // The admin who stepped down is no admin any more.
    let reply = app
        .call("GET", "/account/buyers", &key, &session(&admin), None)
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "NOT_AN_ADMIN")
    );

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "commerce_buyer:created", &invited_id), 1);
    assert_eq!(events_of(&events, "commerce_buyer:invited", &invited_id), 1);
}
