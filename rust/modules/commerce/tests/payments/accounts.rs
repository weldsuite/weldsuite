//! Shopper accounts on the storefront (phase 6, ADR COM-012): sign-in with a
//! code, sessions scoped to a channel, the account, the guest order link,
//! the order list, reorder and quick order, and the order confirmation
//! email. Mollie is the faked one of the payments harness; the system mail
//! is a recording double.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{ALL, Ctx, Reply, Storefront, events_of, fresh, setup};

fn session(token: &str) -> Vec<(&str, &str)> {
    vec![("x-shopper-token", token)]
}

async fn connect(ctx: &Ctx) {
    ctx.staff(ALL, true).connect_key().await;
}

async fn pay_checkout(
    app: &Storefront,
    key: &str,
    cart: &str,
    session_token: Option<&str>,
    extra: Value,
) -> Reply {
    let mut headers = vec![("x-cart-token", cart)];
    if let Some(token) = session_token {
        headers.push(("x-shopper-token", token));
    }
    let mut body =
        json!({ "paymentMethod": "mollie", "redirectUrl": "https://shop.example/thanks" });
    if let Some(extra) = extra.as_object() {
        for (name, value) in extra {
            body[name] = value.clone();
        }
    }
    app.call("POST", "/cart/checkout", key, &headers, Some(body))
        .await
}

#[tokio::test]
async fn a_code_is_mailed_checked_counted_and_limited() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, _, _) = ctx.shop("private", &[]).await;
    let email = format!("{}@example.com", fresh("code"));

    // Bad bodies.
    for body in [
        json!({}),
        json!({ "email": "nope" }),
        json!({ "email": email, "locale": "fr" }),
    ] {
        let reply = app.call("POST", "/auth/code", &key, &[], Some(body)).await;
        assert_eq!(
            (reply.status, reply.code()),
            (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
        );
    }
    // 202 whether or not the address is known; the mail carries the code and
    // comes from the shop.
    let reply = app
        .call(
            "POST",
            "/auth/code",
            &key,
            &[],
            Some(json!({ "email": email })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.body["data"]["sent"].clone()),
        (StatusCode::ACCEPTED, json!(true))
    );
    let mails = ctx.mails_to(&email);
    assert_eq!(mails.len(), 1);
    assert!(mails[0].1.contains(&ctx.code_for(&email)));
    let sent = ctx.mail.sent();
    assert_eq!(
        sent.last().and_then(|m| m.from.name.clone()).as_deref(),
        Some("Pay shop")
    );

    // A wrong code counts down; the right one opens a session.
    let right = ctx.code_for(&email);
    let wrong = if right == "000000" {
        "111111"
    } else {
        "000000"
    };
    let reply = app
        .call(
            "POST",
            "/auth/verify",
            &key,
            &[],
            Some(json!({ "email": email, "code": wrong })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "INVALID_CODE")
    );
    assert_eq!(reply.body["error"]["details"]["attemptsLeft"], 7);
    let reply = app
        .call(
            "POST",
            "/auth/verify",
            &key,
            &[],
            Some(json!({ "email": email, "code": "12ab56" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app
        .call(
            "POST",
            "/auth/verify",
            &key,
            &[],
            Some(json!({ "email": email, "code": right })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let token = reply.body["data"]["sessionToken"].as_str().expect("token");
    assert!(token.starts_with("wss_"));
    assert!(reply.body["data"]["expiresAt"].as_str().is_some());
    assert_eq!(reply.body["data"]["shopper"]["email"], email.as_str());
    assert_eq!(reply.body["data"]["shopper"]["companies"], json!([]));
    // The code is spent: expired for anyone who tries it again.
    let reply = app
        .call(
            "POST",
            "/auth/verify",
            &key,
            &[],
            Some(json!({ "email": email, "code": right })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::GONE, "CODE_EXPIRED")
    );

    // The shopper is a CRM person hidden from the grid, made once.
    let people: Vec<(String, bool)> =
        sqlx::query_as("select id, in_crm from people where lower(email) = $1")
            .bind(&email)
            .fetch_all(&ctx.tenant)
            .await
            .expect("people");
    assert_eq!(people.len(), 1);
    assert!(!people[0].1, "in_crm is false");

    // Eight wrong guesses throw the code away.
    app.call(
        "POST",
        "/auth/code",
        &key,
        &[],
        Some(json!({ "email": email })),
    )
    .await;
    let right = ctx.code_for(&email);
    let wrong = if right == "000000" {
        "111111"
    } else {
        "000000"
    };
    for left in (0..8).rev() {
        let reply = app
            .call(
                "POST",
                "/auth/verify",
                &key,
                &[],
                Some(json!({ "email": email, "code": wrong })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.body["error"]["details"]["attemptsLeft"], left);
    }
    let reply = app
        .call(
            "POST",
            "/auth/verify",
            &key,
            &[],
            Some(json!({ "email": email, "code": right })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::GONE, "CODE_EXPIRED")
    );

    // 5 code requests per address per window.
    let busy = format!("{}@example.com", fresh("busy"));
    for _ in 0..5 {
        let reply = app
            .call(
                "POST",
                "/auth/code",
                &key,
                &[],
                Some(json!({ "email": busy })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::ACCEPTED);
    }
    let reply = app
        .call(
            "POST",
            "/auth/code",
            &key,
            &[],
            Some(json!({ "email": busy })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED")
    );
    assert_eq!(ctx.mails_to(&busy).len(), 5);
}

#[tokio::test]
async fn a_session_belongs_to_one_channel_and_ends_on_sign_out() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, _, _) = ctx.shop("private", &[]).await;
    let (other_key, _, _) = ctx.shop("private", &[]).await;
    let email = format!("{}@example.com", fresh("sess"));
    let token = app.sign_in(&ctx, &key, &email).await;

    let reply = app.call("GET", "/account", &key, &[], None).await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_REQUIRED")
    );
    let reply = app
        .call("GET", "/account", &key, &session("wss_nope"), None)
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_EXPIRED")
    );
    let reply = app
        .call("GET", "/account", &key, &session(&token), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["email"], email.as_str());
    // Another channel does not know it.
    let reply = app
        .call("GET", "/account", &other_key, &session(&token), None)
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_EXPIRED")
    );

    // The account: names and phone, null clears, validated.
    let reply = app
        .call(
            "PATCH",
            "/account",
            &key,
            &session(&token),
            Some(json!({ "firstName": " Sam ", "lastName": "Shopper", "phone": "+31 6 1234" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["firstName"], "Sam");
    assert_eq!(reply.body["data"]["phone"], "+31 6 1234");
    let name: String =
        sqlx::query_scalar("select display_name from people where lower(email) = $1")
            .bind(&email)
            .fetch_one(&ctx.tenant)
            .await
            .expect("name");
    assert_eq!(name, "Sam Shopper");
    let reply = app
        .call(
            "PATCH",
            "/account",
            &key,
            &session(&token),
            Some(json!({ "phone": null, "lastName": 4 })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app
        .call(
            "PATCH",
            "/account",
            &key,
            &session(&token),
            Some(json!({ "phone": null })),
        )
        .await;
    assert_eq!(reply.body["data"]["phone"], Value::Null);

    // No company to choose.
    let reply = app
        .call(
            "PUT",
            "/account/company",
            &key,
            &session(&token),
            Some(json!({ "companyId": "comp_x" })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::FORBIDDEN, "NOT_A_BUYER")
    );

    let reply = app
        .call("POST", "/auth/sign-out", &key, &session(&token), None)
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = app
        .call("GET", "/account", &key, &session(&token), None)
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_EXPIRED")
    );
}

#[tokio::test]
async fn an_existing_crm_person_is_the_shopper_and_picks_a_company() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.storefront();
    let (key, _, _) = ctx
        .shop_with("private", &[], "b2b", &["mollie", "invoice"])
        .await;
    let (company_a, _) = ctx.company("Acme BV", None, None).await;
    let (company_b, _) = ctx.company("Beta BV", None, None).await;
    let email = format!("{}@example.com", fresh("crm"));
    let person = ctx
        .buyer(&company_a, &email, "approver", "invited", Some("250.00"))
        .await;
    ctx.buyer_for(&person, &company_b, "buyer", "active").await;
    // A CRM person, not hidden.
    sqlx::query("update people set in_crm = true where id = $1")
        .bind(&person)
        .execute(&ctx.tenant)
        .await
        .expect("crm");

    let token = app.sign_in(&ctx, &key, &email).await;
    let reply = app
        .call("GET", "/account", &key, &session(&token), None)
        .await;
    let shopper = &reply.body["data"];
    assert_eq!(shopper["personId"], person.as_str());
    // The first sign-in accepted the invitation; two companies, none chosen.
    assert_eq!(shopper["companies"].as_array().map(Vec::len), Some(2));
    assert_eq!(shopper["activeCompanyId"], Value::Null);
    let acme = shopper["companies"]
        .as_array()
        .expect("companies")
        .iter()
        .find(|c| c["id"] == company_a.as_str())
        .expect("acme");
    assert_eq!(acme["role"], "approver");
    assert_eq!(acme["spendLimit"], "250.00");
    assert_eq!(acme["currency"], "EUR");
    let count: i64 = sqlx::query_scalar("select count(*) from people where lower(email) = $1")
        .bind(&email)
        .fetch_one(&ctx.tenant)
        .await
        .expect("count");
    assert_eq!(count, 1);
    let status: String = sqlx::query_scalar(
        "select status from commerce_buyers where person_id = $1 and company_id = $2",
    )
    .bind(&person)
    .bind(&company_a)
    .fetch_one(&ctx.tenant)
    .await
    .expect("status");
    assert_eq!(status, "active");

    let reply = app
        .call(
            "PUT",
            "/account/company",
            &key,
            &session(&token),
            Some(json!({ "companyId": company_b })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["activeCompanyId"], company_b.as_str());
    let reply = app
        .call("GET", "/account", &key, &session(&token), None)
        .await;
    assert_eq!(reply.body["data"]["activeCompanyId"], company_b.as_str());
    let reply = app
        .call(
            "PUT",
            "/account/company",
            &key,
            &session(&token),
            Some(json!({ "companyId": null })),
        )
        .await;
    assert_eq!(reply.body["data"]["activeCompanyId"], Value::Null);

    // A disabled buyer cannot select the company.
    sqlx::query(
        "update commerce_buyers set status = 'disabled' where person_id = $1 and company_id = $2",
    )
    .bind(&person)
    .bind(&company_b)
    .execute(&ctx.tenant)
    .await
    .expect("disable");
    let reply = app
        .call(
            "PUT",
            "/account/company",
            &key,
            &session(&token),
            Some(json!({ "companyId": company_b })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::FORBIDDEN, "NOT_A_BUYER")
    );
    // With one company left it is the active one.
    let reply = app
        .call("GET", "/account", &key, &session(&token), None)
        .await;
    assert_eq!(reply.body["data"]["activeCompanyId"], company_a.as_str());
}

#[tokio::test]
async fn a_guest_gets_an_order_link_and_a_signed_in_shopper_sees_their_orders() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("private", &[]).await;

    // Guest: the token comes once, the link opens that order only.
    let cart = app.cart(&key, &product).await;
    let reply = pay_checkout(
        &app,
        &key,
        &cart,
        None,
        json!({ "orderUrl": "https://shop.example/orders/{orderId}?t={token}" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order_id = reply.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let order_token = reply.body["data"]["orderToken"]
        .as_str()
        .expect("order token")
        .to_owned();
    assert!(order_token.starts_with("wot_"));
    let hash: Option<String> =
        sqlx::query_scalar("select guest_access_token_hash from orders where id = $1")
            .bind(&order_id)
            .fetch_one(&ctx.tenant)
            .await
            .expect("hash");
    let hash = hash.expect("a hash");
    assert_eq!(hash.len(), 64);
    assert_ne!(hash, order_token, "only the hash is stored");
    assert_eq!(
        reply.body["data"]["order"]["approvalStatus"],
        "not_required"
    );
    assert_eq!(reply.body["data"]["order"]["placedBy"], Value::Null);

    let link = app
        .call(
            "GET",
            &format!("/orders/{order_id}?token={order_token}"),
            &key,
            &[],
            None,
        )
        .await;
    assert_eq!(link.status, StatusCode::OK, "{}", link.body);
    assert_eq!(link.body["data"]["id"], order_id.as_str());
    for path in [
        format!("/orders/{order_id}"),
        format!("/orders/{order_id}?token=wot_wrong"),
        "/orders/ord_nope?token=x".to_owned(),
    ] {
        let reply = app.call("GET", &path, &key, &[], None).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
    }
    // A link of another shop does not open it.
    let (other_key, _, _) = ctx.shop("private", &[]).await;
    let reply = app
        .call(
            "GET",
            &format!("/orders/{order_id}?token={order_token}"),
            &other_key,
            &[],
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // The confirmation went to the cart's address, with the filled-in link.
    let mails = ctx.mails_to("shopper@example.com");
    let confirmation = mails
        .iter()
        .rev()
        .find(|(_, text)| text.contains(&order_id))
        .expect("the confirmation");
    assert!(
        confirmation.1.contains(&format!(
            "https://shop.example/orders/{order_id}?t={order_token}"
        )),
        "{}",
        confirmation.1
    );

    // Signed in: no token, and the order is theirs.
    let email = format!("{}@example.com", fresh("buyer"));
    let token = app.sign_in(&ctx, &key, &email).await;
    let cart = app.cart(&key, &product).await;
    let reply = pay_checkout(
        &app,
        &key,
        &cart,
        Some(&token),
        json!({ "orderUrl": "https://shop.example/orders/{orderId}?t={token}" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body["data"]["orderToken"], Value::Null);
    let mine = reply.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(
        reply.body["data"]["order"]["placedBy"]["name"],
        email.as_str()
    );
    let hash: Option<String> =
        sqlx::query_scalar("select guest_access_token_hash from orders where id = $1")
            .bind(&mine)
            .fetch_one(&ctx.tenant)
            .await
            .expect("hash");
    assert!(hash.is_none());
    // The mail links with an empty token for a signed-in shopper.
    let confirmation = ctx
        .mails_to("shopper@example.com")
        .into_iter()
        .rev()
        .find(|(_, text)| text.contains(&mine))
        .expect("confirmation");
    assert!(
        confirmation
            .1
            .contains(&format!("https://shop.example/orders/{mine}?t="))
    );

    let reply = app
        .call("GET", "/account/orders", &key, &session(&token), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let listed: Vec<&str> = reply.body["data"]
        .as_array()
        .expect("orders")
        .iter()
        .filter_map(|o| o["id"].as_str())
        .collect();
    assert_eq!(listed, vec![mine.as_str()]);
    assert_eq!(reply.body["pagination"]["hasMore"], false);
    let reply = app
        .call(
            "GET",
            &format!("/account/orders/{mine}"),
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    // Not someone else's, not the guest's.
    for other in [&order_id, &"ord_nope".to_owned()] {
        let reply = app
            .call(
                "GET",
                &format!("/account/orders/{other}"),
                &key,
                &session(&token),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }
    let stranger = app
        .sign_in(&ctx, &key, &format!("{}@example.com", fresh("other")))
        .await;
    let reply = app
        .call(
            "GET",
            &format!("/account/orders/{mine}"),
            &key,
            &session(&stranger),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .call("GET", "/account/orders", &key, &session(&stranger), None)
        .await;
    assert_eq!(reply.body["data"], json!([]));
    let reply = app.call("GET", "/account/orders", &key, &[], None).await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_REQUIRED")
    );

    // Paging is a keyset: a cursor that is not one is refused.
    let reply = app
        .call(
            "GET",
            "/account/orders?cursor=garbage",
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_REQUEST, "INVALID_CURSOR")
    );
    let cart = app.cart(&key, &product).await;
    let second = pay_checkout(&app, &key, &cart, Some(&token), json!({})).await;
    let second_id = second.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let page = app
        .call(
            "GET",
            "/account/orders?limit=1",
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(page.body["data"][0]["id"], second_id.as_str());
    assert_eq!(page.body["pagination"]["hasMore"], true);
    let cursor = page.body["pagination"]["cursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    let next = app
        .call(
            "GET",
            &format!("/account/orders?limit=1&cursor={cursor}"),
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(next.body["data"][0]["id"], mine.as_str());
    assert_eq!(next.body["pagination"]["hasMore"], false);

    let events = ctx.events().await;
    assert_eq!(events_of(&events, "order:created", &mine), 1);
}

#[tokio::test]
async fn the_order_url_is_checked_like_the_redirect() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("publishable", &["https://shop.example"]).await;
    let cart = app.cart(&key, &product).await;
    for (url, status, code) in [
        (
            "http://shop.example/o/{orderId}",
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
        ),
        (
            "https://evil.example/o/{orderId}?t={token}",
            StatusCode::BAD_REQUEST,
            "ORDER_URL_NOT_ALLOWED",
        ),
        (
            "https://shop.example.evil.test/o/{orderId}",
            StatusCode::BAD_REQUEST,
            "ORDER_URL_NOT_ALLOWED",
        ),
        ("not a url", StatusCode::BAD_REQUEST, "VALIDATION_ERROR"),
    ] {
        let reply = pay_checkout(&app, &key, &cart, None, json!({ "orderUrl": url })).await;
        assert_eq!((reply.status, reply.code()), (status, code), "{url}");
    }
    assert_eq!(ctx.fake.payment_count(), 0);
    // Allowed origin: placed; no URL: placed, and the mail has no order link.
    let reply = pay_checkout(
        &app,
        &key,
        &cart,
        None,
        json!({ "orderUrl": "https://shop.example/o/{orderId}?t={token}" }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let cart = app.cart(&key, &product).await;
    let reply = pay_checkout(&app, &key, &cart, None, json!({})).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let number = reply.body["data"]["order"]["orderNumber"]
        .as_str()
        .expect("number")
        .to_owned();
    let mail = ctx
        .mails_to("shopper@example.com")
        .into_iter()
        .rev()
        .find(|(_, text)| text.contains(&number))
        .expect("confirmation");
    assert!(!mail.1.contains("shop.example/o/"), "{}", mail.1);
}

#[tokio::test]
async fn a_signed_in_shopper_passes_the_guest_rule_and_carts_attach() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, channel) = ctx.shop("private", &[]).await;
    sqlx::query("update commerce_channels set guest_checkout = false where id = $1")
        .bind(&channel)
        .execute(&ctx.tenant)
        .await
        .expect("no guests");
    let cart = app.cart(&key, &product).await;
    let reply = pay_checkout(&app, &key, &cart, None, json!({})).await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::CONFLICT, "GUEST_CHECKOUT_DISABLED")
    );

    let email = format!("{}@example.com", fresh("member"));
    let token = app.sign_in(&ctx, &key, &email).await;
    // The cart read with both tokens belongs to the shopper now.
    let reply = app
        .call(
            "GET",
            "/cart",
            &key,
            &[("x-cart-token", &cart), ("x-shopper-token", &token)],
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let person: Option<String> = sqlx::query_scalar("select person_id from carts where id = $1")
        .bind(reply.body["data"]["id"].as_str())
        .fetch_one(&ctx.tenant)
        .await
        .expect("cart");
    assert!(person.is_some());
    // An unknown session on a cart is refused, not ignored.
    let reply = app
        .call(
            "GET",
            "/cart",
            &key,
            &[("x-cart-token", &cart), ("x-shopper-token", "wss_nope")],
            None,
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_EXPIRED")
    );

    let reply = pay_checkout(&app, &key, &cart, Some(&token), json!({})).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let order = reply.body["data"]["order"]["id"].as_str().expect("id");
    let (person, party): (Option<String>, Option<String>) =
        sqlx::query_as("select person_id, counterparty_id from orders where id = $1")
            .bind(order)
            .fetch_one(&ctx.tenant)
            .await
            .expect("order");
    assert!(
        person.is_some() && party.is_some(),
        "the order is the shopper's"
    );
}

#[tokio::test]
async fn reorder_and_quick_order_report_what_they_cannot_add() {
    let Some(ctx) = setup().await else { return };
    connect(&ctx).await;
    let app = ctx.storefront();
    let (key, product, _) = ctx.shop("private", &[]).await;
    let email = format!("{}@example.com", fresh("again"));
    let token = app.sign_in(&ctx, &key, &email).await;
    let cart = app.cart(&key, &product).await;
    let placed = pay_checkout(&app, &key, &cart, Some(&token), json!({})).await;
    let order = placed.body["data"]["order"]["id"]
        .as_str()
        .expect("id")
        .to_owned();

    // Reorder into a new cart.
    let reply = app
        .call(
            "POST",
            &format!("/account/orders/{order}/reorder"),
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let new_cart = reply.body["data"]["cartToken"]
        .as_str()
        .expect("a new cart")
        .to_owned();
    assert_eq!(reply.body["data"]["cart"]["itemCount"], 1);
    assert_eq!(reply.body["data"]["problems"], json!([]));
    // ...and into the cart that exists (raising the quantity), with no new token.
    let reply = app
        .call(
            "POST",
            &format!("/account/orders/{order}/reorder"),
            &key,
            &[("x-shopper-token", &token), ("x-cart-token", &new_cart)],
            None,
        )
        .await;
    assert_eq!(reply.body["data"]["cartToken"], Value::Null);
    assert_eq!(reply.body["data"]["cart"]["itemCount"], 2);
    // Someone else's order, and a missing session.
    let stranger = app
        .sign_in(&ctx, &key, &format!("{}@example.com", fresh("stranger")))
        .await;
    let reply = app
        .call(
            "POST",
            &format!("/account/orders/{order}/reorder"),
            &key,
            &session(&stranger),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .call(
            "POST",
            &format!("/account/orders/{order}/reorder"),
            &key,
            &[],
            None,
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::UNAUTHORIZED, "SESSION_REQUIRED")
    );
    // A product that went off sale is reported, not dropped.
    sqlx::query("update products set status = 'archived' where id = $1")
        .bind(&product)
        .execute(&ctx.tenant)
        .await
        .expect("archive");
    let reply = app
        .call(
            "POST",
            &format!("/account/orders/{order}/reorder"),
            &key,
            &session(&token),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["problems"][0]["problem"], "NOT_SELLABLE");
    assert_eq!(reply.body["data"]["cart"]["itemCount"], 0);
    sqlx::query("update products set status = 'active' where id = $1")
        .bind(&product)
        .execute(&ctx.tenant)
        .await
        .expect("restore");

    // Quick order: lines and a CSV, with every kind of problem.
    let sku: String = sqlx::query_scalar("select sku from products where id = $1")
        .bind(&product)
        .fetch_one(&ctx.tenant)
        .await
        .expect("sku");
    let nameless = fresh("NOPRICE-");
    let unpriced = fresh("p_");
    sqlx::query(
        "insert into products (id, name, slug, sku, price, currency, status, visibility, requires_shipping) \
         values ($1, 'Free thing', $2, $3, 5, 'USD', 'active', 'visible', false)",
    )
    .bind(&unpriced)
    .bind(fresh("s-"))
    .bind(&nameless)
    .execute(&ctx.tenant)
    .await
    .expect("unpriced");
    let csv = format!("sku,quantity\n{sku},2\nNO-SUCH-SKU,1\n{nameless},1\n{sku},0\n{sku},x");
    let reply = app
        .call(
            "POST",
            "/cart/quick-order",
            &key,
            &session(&token),
            Some(json!({ "lines": [{ "sku": sku.to_lowercase(), "quantity": 3 }, { "sku": "GHOST", "quantity": 1 }], "csv": csv })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let data = &reply.body["data"];
    assert!(data["cartToken"].as_str().is_some(), "a new cart");
    assert_eq!(data["cart"]["itemCount"], 5, "3 + 2 of the good SKU");
    let problems: Vec<(Option<i64>, String)> = data["problems"]
        .as_array()
        .expect("problems")
        .iter()
        .map(|p| {
            (
                p["row"].as_i64(),
                p["problem"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    // Rows of the lines list are their position; those of the CSV are line numbers.
    for expected in [
        (Some(2), "UNKNOWN_SKU"),
        (Some(3), "UNKNOWN_SKU"),
        (Some(4), "NO_PRICE"),
        (Some(5), "INVALID_QUANTITY"),
        (Some(6), "INVALID_QUANTITY"),
    ] {
        assert!(
            problems.contains(&(expected.0, expected.1.to_owned())),
            "{expected:?} in {problems:?}"
        );
    }
    assert_eq!(problems.len(), 5, "{problems:?}");
    // The shopper's cart carries the person.
    let cart_token = data["cartToken"].as_str().expect("token");
    let attached: Option<String> = sqlx::query_scalar("select person_id from carts where id = $1")
        .bind(data["cart"]["id"].as_str())
        .fetch_one(&ctx.tenant)
        .await
        .expect("cart");
    assert!(attached.is_some());
    // Into the same cart again: no new token.
    let reply = app
        .call(
            "POST",
            "/cart/quick-order",
            &key,
            &[("x-cart-token", cart_token)],
            Some(json!({ "lines": [{ "sku": sku, "quantity": 1 }] })),
        )
        .await;
    assert_eq!(reply.body["data"]["cartToken"], Value::Null);
    assert_eq!(reply.body["data"]["cart"]["itemCount"], 6);

    // Shapes and the 500 row cap.
    for body in [
        json!({}),
        json!({ "lines": [] }),
        json!({ "lines": "x" }),
        json!({ "lines": [{ "quantity": 1 }] }),
        json!({ "csv": 4 }),
    ] {
        let reply = app
            .call("POST", "/cart/quick-order", &key, &[], Some(body.clone()))
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let many = vec![
        "S1,1
";
        501
    ]
    .concat();
    let reply = app
        .call(
            "POST",
            "/cart/quick-order",
            &key,
            &[],
            Some(json!({ "csv": many })),
        )
        .await;
    assert_eq!(
        (reply.status, reply.code()),
        (StatusCode::BAD_REQUEST, "VALIDATION_ERROR")
    );
    let many = vec![
        "S1,1
";
        500
    ]
    .concat();
    let reply = app
        .call(
            "POST",
            "/cart/quick-order",
            &key,
            &[],
            Some(json!({ "csv": many })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(
        reply.body["data"]["problems"].as_array().map(Vec::len),
        Some(500)
    );
}
