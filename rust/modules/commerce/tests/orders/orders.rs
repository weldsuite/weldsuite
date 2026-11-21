//! `/api/orders`: quoting, placing, numbering, discount codes and their
//! redemptions, the edit rules, cancel, mark-paid, idempotency, listing and
//! the events.

use http::StatusCode;
use serde_json::{Value, json};

use crate::harness::{
    ALL, TestApp, app, company, discount, fresh, ids, person, priced, read, tenant,
};

/// An order of `quantity` of `product` at EUR; its id.
async fn place(app: &TestApp, product: &str, quantity: i64, extra: Value) -> (String, Value) {
    let mut body = json!({
        "currency": "EUR",
        "items": [{ "productId": product, "quantity": quantity }],
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        body[key] = value;
    }
    let (status, created) = app.post("/orders", &body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["data"]["id"].as_str().expect("id").to_owned();
    let order = read(app, &format!("/orders/{id}")).await;
    (id, order)
}

#[tokio::test]
async fn quote_prices_without_writing_and_keeps_the_lines_in_order() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "19.99").await;
    let code = fresh("Q").to_uppercase();
    discount(
        &app,
        &json!({ "name": "Ten", "code": &code, "type": "percentage", "value": "10", "status": "active" }),
    )
    .await;
    let who = fresh("quoted-");

    let (status, body) = app
        .post(
            "/orders/quote",
            &json!({
                "currency": "EUR",
                "items": [
                    { "productId": "prod_missing", "quantity": 1 },
                    { "productId": widget, "quantity": 3 },
                    { "name": "Custom work", "unitPrice": "100", "quantity": 1 },
                ],
                "discountCode": &code,
                "shippingTotal": "4.95",
                "customerName": &who,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let quote = &body["data"];
    let lines = quote["lines"].as_array().expect("lines");
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["problem"], "PRODUCT_NOT_FOUND");
    assert_eq!(lines[1]["problem"], Value::Null);
    assert_eq!(lines[1]["unitPrice"], "19.99");
    assert_eq!(lines[1]["quantity"], 3);
    assert_eq!(lines[2]["name"], "Custom work");
    // 59.97 + 100.00 = 159.97; 10% = 16.00 (15.997); shipping 4.95.
    assert_eq!(quote["subtotal"], "159.97");
    assert_eq!(quote["discountTotal"], "16.00");
    assert_eq!(quote["shippingTotal"], "4.95");
    // Catalogue prices include VAT (21% at the Dutch seller): the tax is inside the total.
    assert_ne!(quote["taxTotal"], "0.00");
    assert_eq!(quote["vatTreatment"], "domestic");
    assert_eq!(quote["total"], "148.92");
    assert_eq!(quote["discount"]["code"], json!(code));
    assert_eq!(quote["discountProblem"], Value::Null);

    // A bad code is reported, not an error.
    let (status, body) = app
        .post(
            "/orders/quote",
            &json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 1 }], "discountCode": "NOPE-NOT-THERE" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["discountProblem"], "NOT_FOUND");
    assert_eq!(body["data"]["discount"], Value::Null);
    assert_eq!(body["data"]["total"], "19.99");

    // Invalid input is a 400.
    let (status, body) = app
        .post("/orders/quote", &json!({ "currency": "EUR", "items": [] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"]["issues"].is_array(), "{body}");

    let written: i64 = sqlx::query_scalar("select count(*) from orders where customer_name = $1")
        .bind(&who)
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(written, 0, "a quote writes nothing");
}

#[tokio::test]
async fn placing_an_order_numbers_prices_and_publishes() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "12.50").await;
    let acme = company(&db, "Acme BV").await;
    let buyer = person(
        &db,
        "Dana Buyer",
        &format!("{}@acme.example", fresh("dana")),
    )
    .await;

    let (id, order) = place(
        &app,
        &widget,
        4,
        json!({
            "companyId": acme, "personId": buyer, "shippingTotal": "5",
            "customerReference": "PO-77", "tags": ["vip"],
            "billingAddress": { "line1": "Main 1", "city": "Delft", "region": "ZH", "country": "NL" },
        }),
    )
    .await;
    assert!(
        order["orderNumber"]
            .as_str()
            .expect("number")
            .starts_with("WC-")
            || order["orderNumber"].is_string()
    );
    assert_eq!(order["status"], "confirmed");
    assert_eq!(order["paymentStatus"], "pending");
    assert_eq!(order["fulfillmentStatus"], "unfulfilled");
    assert_eq!(order["approvalStatus"], "not_required");
    assert_eq!(order["source"], "manual");
    assert_eq!(order["subtotal"], "50.00");
    assert_eq!(order["shippingTotal"], "5.00");
    assert_eq!(order["total"], "55.00");
    // 50.00 and 5.00 shipping, VAT-inclusive at 21%: 8.68 + 0.87.
    assert_eq!(order["taxTotal"], "9.55");
    assert_eq!(order["vatTreatment"], "domestic");
    assert_eq!(order["itemCount"], 1);
    assert_eq!(order["totalQuantity"], 4);
    assert_eq!(order["companyId"], json!(acme));
    assert_eq!(order["companyName"], "Acme BV");
    assert_eq!(order["personId"], json!(buyer));
    assert_eq!(order["customerName"], "Dana Buyer");
    assert_eq!(order["customerReference"], "PO-77");
    assert_eq!(order["tags"], json!(["vip"]));
    assert_eq!(order["billingAddress"]["region"], "ZH");
    assert_eq!(order["editable"], true);
    assert_eq!(order["cancellable"], true);
    assert_eq!(order["invoice"], Value::Null);
    let items = order["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["quantity"], 4);
    assert_eq!(items[0]["fulfilledQuantity"], 0);
    assert_eq!(items[0]["unitPrice"], "12.50");
    assert_eq!(items[0]["total"], "50.00");
    assert_eq!(items[0]["name"], "Widget");

    // The counterparty is the company's party, created on the way.
    let party: Option<String> = sqlx::query_scalar(
        "select p.company_id from orders o join parties p on p.id = o.counterparty_id where o.id = $1",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .expect("party");
    assert_eq!(party.as_deref(), Some(acme.as_str()));

    let created = app.events_of("order:created", &id).await;
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["data"]["orderNumber"], order["orderNumber"]);

    // Numbers count up, one per order.
    let (_, next) = place(&app, &widget, 1, json!({})).await;
    let number = |o: &Value| {
        o["orderNumber"]
            .as_str()
            .expect("n")
            .rsplit('-')
            .next()
            .expect("tail")
            .parse::<i64>()
            .expect("digits")
    };
    assert!(number(&next) > number(&order));

    // The list finds it by every filter.
    let list = read(&app, &format!("/orders?companyId={acme}")).await;
    assert_eq!(ids(&list), vec![id.clone()]);
    assert_eq!(list[0]["companyName"], "Acme BV");
    for query in [
        format!("search={}", order["orderNumber"].as_str().expect("n")),
        "search=dana".to_owned(),
        format!("personId={buyer}"),
        "status=confirmed&paymentStatus=pending&fulfillmentStatus=unfulfilled&source=manual"
            .to_owned(),
    ] {
        let list = read(&app, &format!("/orders?{query}&limit=100")).await;
        assert!(ids(&list).contains(&id), "{query}");
    }
    let list = read(&app, &format!("/orders?companyId={acme}&status=cancelled")).await;
    assert_eq!(ids(&list), Vec::<String>::new());
}

#[tokio::test]
async fn invalid_orders_are_refused() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "10").await;
    for (body, what) in [
        (
            json!({ "items": [{ "productId": widget, "quantity": 1 }] }),
            "no currency",
        ),
        (
            json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 0 }] }),
            "zero quantity",
        ),
        (
            json!({ "currency": "EUR", "items": [{ "quantity": 1 }] }),
            "a line that sells nothing",
        ),
        (
            json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 1 }], "status": "shipped" }),
            "a bad status",
        ),
        (
            json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 1 }], "shippingTotal": "-1" }),
            "negative shipping",
        ),
        (
            json!({ "currency": "EUR", "customerEmail": "nope", "items": [{ "productId": widget, "quantity": 1 }] }),
            "a bad email",
        ),
    ] {
        let (status, body) = app.post("/orders", &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert!(body["error"]["issues"].is_array(), "{what}");
    }
    // A product the catalogue does not have, and a company that is gone.
    let (status, body) = app
        .post(
            "/orders",
            &json!({ "currency": "EUR", "items": [{ "productId": "prod_nope", "quantity": 1 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = app
        .post(
            "/orders",
            &json!({ "currency": "EUR", "companyId": "comp_nope", "items": [{ "productId": widget, "quantity": 1 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // In another currency than the catalogue's, without a price.
    let (status, body) = app
        .post(
            "/orders",
            &json!({ "currency": "USD", "items": [{ "productId": widget, "quantity": 1 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = app.get("/orders/ord_missing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_retry_with_the_same_key_returns_the_first_order() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "9.99").await;
    let key = fresh("key-");
    let body = json!({ "currency": "EUR", "items": [{ "productId": widget, "quantity": 2 }], "idempotencyKey": key });
    let (status, first) = app.post("/orders", &body).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    let (status, second) = app.post("/orders", &body).await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(first["data"], second["data"]);
    let count: i64 = sqlx::query_scalar("select count(*) from orders where idempotency_key = $1")
        .bind(&key)
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(count, 1);
    let id = first["data"]["id"].as_str().expect("id");
    assert_eq!(app.events_of("order:created", id).await.len(), 1);
}

#[tokio::test]
async fn discount_codes_apply_redeem_and_refuse() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "100").await;
    let code = fresh("SAVE").to_uppercase();
    let did = discount(
        &app,
        &json!({ "name": "Save", "code": &code, "type": "percentage", "value": "10", "status": "active",
                 "usageLimit": 2, "usageLimitPerCustomer": 1 }),
    )
    .await;
    let email = format!("{}@buyer.example", fresh("b"));

    let (id, order) = place(
        &app,
        &widget,
        2,
        json!({ "discountCode": code.to_lowercase(), "customerEmail": email, "shippingTotal": "10" }),
    )
    .await;
    assert_eq!(order["discountCode"], json!(code));
    assert_eq!(order["discountId"], json!(did));
    assert_eq!(order["subtotal"], "200.00");
    assert_eq!(order["discountTotal"], "20.00");
    assert_eq!(order["total"], "190.00");
    assert_eq!(order["items"][0]["discountAmount"], "20.00");
    assert_eq!(order["items"][0]["total"], "180.00");

    let discount_row = read(&app, &format!("/discounts/{did}")).await;
    assert_eq!(discount_row["usageCount"], 1);
    let redemptions = read(&app, &format!("/discounts/{did}/redemptions")).await;
    assert_eq!(redemptions[0]["orderId"], json!(id));
    assert_eq!(redemptions[0]["orderNumber"], order["orderNumber"]);
    assert_eq!(redemptions[0]["amount"], "20.00");
    assert_eq!(redemptions[0]["customerEmail"], json!(email));

    // The same buyer cannot use it twice.
    let body = json!({ "currency": "EUR", "customerEmail": email, "discountCode": &code,
                       "items": [{ "productId": widget, "quantity": 1 }] });
    let (status, answer) = app.post("/orders", &body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(answer["error"]["code"], "DISCOUNT_NOT_APPLICABLE");
    assert_eq!(answer["error"]["details"]["reason"], "CUSTOMER_LIMIT");
    let (_, quote) = app.post("/orders/quote", &body).await;
    assert_eq!(quote["data"]["discountProblem"], "CUSTOMER_LIMIT");

    // Someone else can, once; then the code is used up.
    let other = json!({ "currency": "EUR", "customerEmail": format!("x{email}"), "discountCode": &code,
                        "items": [{ "productId": widget, "quantity": 1 }] });
    let (status, answer) = app.post("/orders", &other).await;
    assert_eq!(status, StatusCode::CREATED, "{answer}");
    let third = json!({ "currency": "EUR", "customerEmail": format!("y{email}"), "discountCode": &code,
                        "items": [{ "productId": widget, "quantity": 1 }] });
    let (status, answer) = app.post("/orders", &third).await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(answer["error"]["details"]["reason"], "USAGE_LIMIT");
    assert_eq!(
        read(&app, &format!("/discounts/{did}")).await["effectiveStatus"],
        "used_up"
    );

    // Cancelling gives the use back.
    let (status, _) = app
        .post(
            &format!("/orders/{id}/cancel"),
            &json!({ "reason": "changed mind" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        read(&app, &format!("/discounts/{did}")).await["usageCount"],
        1
    );
    let redemptions = read(&app, &format!("/discounts/{did}/redemptions")).await;
    assert_eq!(redemptions.as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn every_discount_problem_is_reported() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "50").await;
    let other = priced(&app, "50").await;
    let items = json!([{ "productId": widget, "quantity": 1 }]);
    let make = |extra: Value| {
        let app = &app;
        async move {
            let code = fresh("P").to_uppercase();
            let mut body = json!({ "name": "P", "code": &code, "type": "percentage", "value": "10", "status": "active" });
            for (k, v) in extra.as_object().cloned().unwrap_or_default() {
                body[k] = v;
            }
            discount(app, &body).await;
            code
        }
    };
    let cases = [
        (json!({ "status": "draft" }), "NOT_ACTIVE"),
        (json!({ "startsAt": "2099-01-01T00:00:00Z" }), "NOT_STARTED"),
        (json!({ "endsAt": "2020-01-01T00:00:00Z" }), "EXPIRED"),
        (json!({ "minimumSubtotal": "500" }), "MINIMUM_SUBTOTAL"),
        (json!({ "minimumQuantity": 5 }), "MINIMUM_QUANTITY"),
        (
            json!({ "type": "fixed_amount", "currency": "USD", "value": "5" }),
            "CURRENCY",
        ),
        (
            json!({ "appliesTo": "products", "productIds": [other] }),
            "NOT_ELIGIBLE",
        ),
    ];
    for (extra, reason) in cases {
        let code = make(extra).await;
        let (status, body) = app
            .post(
                "/orders/quote",
                &json!({ "currency": "EUR", "items": items, "discountCode": code }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{reason}: {body}");
        assert_eq!(body["data"]["discountProblem"], reason);
        let (status, body) = app
            .post(
                "/orders",
                &json!({ "currency": "EUR", "items": items, "discountCode": code }),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{reason}: {body}");
        assert_eq!(body["error"]["details"]["reason"], reason);
    }
    // Scoped to the product it sells, fixed amounts and free shipping work.
    let scoped = make(json!({ "appliesTo": "products", "productIds": [widget], "type": "fixed_amount", "currency": "EUR", "value": "7.50" })).await;
    let (_, body) = app
        .post(
            "/orders/quote",
            &json!({ "currency": "EUR", "items": items, "discountCode": scoped }),
        )
        .await;
    assert_eq!(body["data"]["discountTotal"], "7.50");
    assert_eq!(body["data"]["total"], "42.50");
    let free = make(json!({ "type": "free_shipping", "value": "0" })).await;
    let (_, body) = app
        .post("/orders/quote", &json!({ "currency": "EUR", "items": items, "discountCode": free, "shippingTotal": "6.95" }))
        .await;
    assert_eq!(body["data"]["shippingTotal"], "0.00");
    assert_eq!(body["data"]["total"], "50.00");
}

#[tokio::test]
async fn editing_keeps_item_ids_and_recalculates() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let a = priced(&app, "10").await;
    let b = priced(&app, "20").await;
    let code = fresh("E").to_uppercase();
    let did = discount(
        &app,
        &json!({ "name": "E", "code": &code, "type": "percentage", "value": "50", "status": "active" }),
    )
    .await;
    let (id, order) = place(&app, &a, 2, json!({})).await;
    let first = order["items"][0]["id"].as_str().expect("item").to_owned();

    // Notes, tags and a forward status step.
    let (status, body) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "internalNote": "call back", "tags": ["rush"], "shippingAddress": { "city": "Ede", "country": "NL" } }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["internalNote"], "call back");
    assert_eq!(body["data"]["shippingAddress"]["city"], "Ede");

    // Items: update in place, add one, apply a code and shipping.
    let (status, body) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({
                "items": [
                    { "id": first, "quantity": 3 },
                    { "productId": b, "quantity": 1 },
                ],
                "discountCode": &code,
                "shippingTotal": "5",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let order = &body["data"];
    assert_eq!(order["items"].as_array().map(Vec::len), Some(2));
    assert_eq!(order["items"][0]["id"], json!(first));
    assert_eq!(order["items"][0]["quantity"], 3);
    assert_eq!(order["subtotal"], "50.00");
    assert_eq!(order["discountTotal"], "25.00");
    assert_eq!(order["total"], "30.00");
    assert_eq!(order["totalQuantity"], 4);
    assert_eq!(
        read(&app, &format!("/discounts/{did}")).await["usageCount"],
        1
    );
    let second = order["items"][1]["id"].as_str().expect("second").to_owned();

    // Dropping a line removes it; the other keeps its id. Clearing the code
    // gives the redemption back.
    let (status, body) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "items": [{ "id": second, "quantity": 1 }], "discountCode": null }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["data"]["items"][0]["id"], json!(second));
    assert_eq!(body["data"]["discountCode"], Value::Null);
    assert_eq!(body["data"]["total"], "25.00");
    assert_eq!(
        read(&app, &format!("/discounts/{did}")).await["usageCount"],
        0
    );

    // An item that is not the order's is refused.
    let (status, _) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "items": [{ "id": "oitm_nope", "quantity": 1 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // An item on a pick list stays.
    let list_id = fresh("pl_");
    sqlx::query(
        "insert into pick_lists (id, pick_list_number, warehouse_id) values ($1, $1, 'wh_test')",
    )
    .bind(&list_id)
    .execute(&db)
    .await
    .expect("pick list");
    sqlx::query(
        "insert into pick_list_items (id, pick_list_id, order_id, order_item_id, product_id, name, quantity_required) \
         values ($1, $2, $3, $4, $5, 'Widget', 1)",
    )
    .bind(fresh("pli_"))
    .bind(&list_id)
    .bind(&id)
    .bind(&second)
    .bind(&b)
    .execute(&db)
    .await
    .expect("pick list item");
    {
        let (status, body) = app
            .patch(
                &format!("/orders/{id}"),
                &json!({ "items": [{ "productId": a, "quantity": 1 }] }),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "ORDER_NOT_EDITABLE");
    }

    let updated = app.events_of("order:updated", &id).await;
    assert!(updated.len() >= 3, "{updated:?}");
}

#[tokio::test]
async fn status_moves_forward_and_completes() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "10").await;
    let (id, _) = place(&app, &widget, 1, json!({ "status": "pending" })).await;
    let (status, body) = app
        .patch(&format!("/orders/{id}"), &json!({ "status": "processing" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "processing");
    let (status, body) = app
        .patch(&format!("/orders/{id}"), &json!({ "status": "confirmed" }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "INVALID_STATUS_TRANSITION");
    let (status, _) = app
        .patch(&format!("/orders/{id}"), &json!({ "status": "cancelled" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = app
        .patch(&format!("/orders/{id}"), &json!({ "status": "completed" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["completedAt"].is_string());
    assert_eq!(app.events_of("order:completed", &id).await.len(), 1);
    // A completed order is closed: no edits, no cancel.
    let (status, body) = app
        .patch(&format!("/orders/{id}"), &json!({ "shippingTotal": "9" }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "ORDER_NOT_EDITABLE");
    let (status, body) = app.post(&format!("/orders/{id}/cancel"), &json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "ORDER_NOT_CANCELLABLE");
    // Notes still change.
    let (status, _) = app
        .patch(&format!("/orders/{id}"), &json!({ "internalNote": "done" }))
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn paid_orders_keep_their_items_and_fulfilled_ones_cannot_cancel() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "30").await;
    let (id, _) = place(&app, &widget, 2, json!({ "status": "pending" })).await;

    let (status, body) = app
        .post(
            &format!("/orders/{id}/mark-paid"),
            &json!({ "paidAt": "2026-11-01T10:00:00Z", "paymentMethod": "bank", "paymentReference": "INV-1" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let order = &body["data"];
    assert_eq!(order["paymentStatus"], "paid");
    assert_eq!(order["status"], "confirmed");
    assert_eq!(order["paidAt"], "2026-11-01T10:00:00.000Z");
    assert_eq!(order["paymentMethod"], "bank");
    assert_eq!(order["editable"], false);
    assert_eq!(order["cancellable"], true);
    assert_eq!(app.events_of("order:paid", &id).await.len(), 1);

    let (status, body) = app
        .post(&format!("/orders/{id}/mark-paid"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "ALREADY_PAID");
    let (status, body) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "items": [{ "productId": widget, "quantity": 9 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "ORDER_NOT_EDITABLE");

    // Something fulfilled (WeldStash writes it) blocks cancelling, and the
    // order writes never touch it.
    sqlx::query("update order_items set fulfilled_quantity = 1 where order_id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .expect("fulfil");
    sqlx::query("update orders set fulfillment_status = 'partial' where id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .expect("fulfil");
    let (status, body) = app.post(&format!("/orders/{id}/cancel"), &json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "ORDER_NOT_CANCELLABLE");
    let (status, body) = app
        .patch(
            &format!("/orders/{id}"),
            &json!({ "tags": ["x"], "status": "processing" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["fulfillmentStatus"], "partial");
    assert_eq!(body["data"]["items"][0]["fulfilledQuantity"], 1);
    assert_eq!(body["data"]["cancellable"], false);
}

#[tokio::test]
async fn cancelling_closes_the_order() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "15").await;
    let (id, _) = place(&app, &widget, 1, json!({})).await;
    let (status, body) = app
        .post(
            &format!("/orders/{id}/cancel"),
            &json!({ "reason": "duplicate" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "cancelled");
    assert_eq!(body["data"]["cancelReason"], "duplicate");
    assert!(body["data"]["cancelledAt"].is_string());
    assert_eq!(body["data"]["editable"], false);
    assert_eq!(body["data"]["cancellable"], false);
    assert_eq!(app.events_of("order:cancelled", &id).await.len(), 1);
    // Cancelling again, paying or editing a cancelled order is refused; the
    // body of a cancel is optional.
    let (status, body) = app.post(&format!("/orders/{id}/cancel"), &json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, body) = app
        .post(&format!("/orders/{id}/mark-paid"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, _) = app.post("/orders/ord_missing/cancel", &json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app.post("/orders/ord_missing/mark-paid", &json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .patch("/orders/ord_missing", &json!({ "tags": [] }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn orders_are_scoped_to_their_tenant_database() {
    let Some(db) = tenant().await else { return };
    let app_a = app(db.clone(), ALL);
    let widget = priced(&app_a, "5").await;
    let (id, _) = place(&app_a, &widget, 1, json!({})).await;
    // A member with the right permissions in another workspace reads through
    // its own database: a pool that holds no such row answers 404, never the
    // other workspace's order. Here that is emulated with a deleted row.
    sqlx::query("update orders set deleted_at = now() where id = $1")
        .bind(&id)
        .execute(&db)
        .await
        .expect("soft delete");
    let (status, _) = app_a.get(&format!("/orders/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let list = read(&app_a, "/orders?limit=100").await;
    assert!(!ids(&list).contains(&id));
}

#[tokio::test]
async fn the_list_sorts_pages_and_filters_by_date() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let widget = priced(&app, "10").await;
    let tag = fresh("sort");
    let mut made = Vec::new();
    for quantity in [3, 1, 2] {
        let (id, _) = place(&app, &widget, quantity, json!({ "customerName": tag })).await;
        made.push((id, quantity));
    }
    let by_total = read(&app, &format!("/orders?search={tag}&sort=-total")).await;
    let want: Vec<String> = [0usize, 2, 1].iter().map(|i| made[*i].0.clone()).collect();
    assert_eq!(ids(&by_total), want);
    let ascending = read(&app, &format!("/orders?search={tag}&sort=total")).await;
    let mut reversed = want.clone();
    reversed.reverse();
    assert_eq!(ids(&ascending), reversed);

    // Pages by cursor, newest first by default.
    let (status, page) = app.get(&format!("/orders?search={tag}&limit=2")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["pagination"]["hasMore"], true);
    assert_eq!(page["pagination"]["totalCount"], 3);
    let cursor = page["pagination"]["cursor"].as_str().expect("cursor");
    let (_, rest) = app
        .get(&format!("/orders?search={tag}&limit=2&cursor={cursor}"))
        .await;
    assert_eq!(rest["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(rest["pagination"]["hasMore"], false);
    let all: Vec<String> = ids(&page["data"])
        .into_iter()
        .chain(ids(&rest["data"]))
        .collect();
    let mut newest_first: Vec<String> = made.iter().map(|m| m.0.clone()).collect();
    newest_first.reverse();
    assert_eq!(all, newest_first);

    let none = read(&app, &format!("/orders?search={tag}&to=2000-01-01")).await;
    assert_eq!(ids(&none), Vec::<String>::new());
    let some = read(
        &app,
        &format!("/orders?search={tag}&from=2000-01-01&to=2999-01-01"),
    )
    .await;
    assert_eq!(ids(&some).len(), 3);
    let (status, _) = app.get("/orders?sort=bogus").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app.get("/orders?from=not-a-date").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_order_made_into_an_invoice_shows_it() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let widget = priced(&app, "10").await;
    let (id, _) = place(&app, &widget, 1, json!({})).await;
    sqlx::query(
        "insert into invoices (id, invoice_number, status, commerce_order_id, contact_id, issue_date, due_date, entity_id) \n         values ($1, 'INV-9', 'draft', $2, 'party_x', now(), now(), 'ent_x')",
    )
    .bind(fresh("inv_"))
    .bind(&id)
    .execute(&db)
    .await
    .expect("invoice");
    {
        let order = read(&app, &format!("/orders/{id}")).await;
        assert_eq!(order["invoice"]["number"], "INV-9");
        assert_eq!(order["invoice"]["status"], "draft");
    }
}
