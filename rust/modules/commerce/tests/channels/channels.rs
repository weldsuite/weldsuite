//! `/api/commerce-channels`: create, read, validation, the rules a channel
//! keeps, the connector channel, soft delete and events.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, app, app_with, both, fresh, ids, read, tenant};

#[tokio::test]
async fn create_read_update_list_and_events() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let name = fresh("Webshop ");
    let id = app
        .channel(&json!({
            "name": name, "audience": "b2b", "currency": "eur",
            "sellingCountries": ["nl", "EL", "NL"], "paymentMethods": ["mollie", "invoice"],
            "status": "active",
        }))
        .await;

    let channel = read(&app, &format!("/commerce-channels/{id}")).await;
    assert_eq!(channel["name"], json!(name));
    assert_eq!(channel["type"], "storefront");
    assert_eq!(channel["audience"], "b2b");
    assert_eq!(channel["currency"], "EUR");
    // A B2B channel enters prices excluding VAT, by default.
    assert_eq!(channel["pricesIncludeTax"], false);
    assert_eq!(channel["sellingCountries"], json!(["NL", "GR"]));
    assert_eq!(channel["guestCheckout"], true);
    assert_eq!(channel["activeKeyCount"], 0);
    assert_eq!(channel["connectionId"], json!(null));
    assert!(channel["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        app.events_of("commerce_channel:created", &id).await.len(),
        1
    );

    let b2c = app.storefront().await;
    assert_eq!(
        read(&app, &format!("/commerce-channels/{b2c}")).await["pricesIncludeTax"],
        true
    );

    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "name": "Renamed", "guestCheckout": false, "sellingCountries": ["NL"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["name"], "Renamed");
    assert_eq!(body["data"]["guestCheckout"], false);
    assert_eq!(body["data"]["sellingCountries"], json!(["NL"]));
    assert_eq!(
        app.events_of("commerce_channel:updated", &id).await.len(),
        1
    );

    let list = read(&app, "/commerce-channels?search=Renamed").await;
    assert!(ids(&list).contains(&id));
    let (status, body) = app
        .get("/commerce-channels?type=shopify&status=archived")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["pagination"]["totalCount"].is_number(), "{body}");

    let (status, body) = app.get("/commerce-channels/missing").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn validation() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let post = |body: serde_json::Value| {
        let app = &app;
        async move { app.post("/commerce-channels", &body).await }
    };
    // A name is required; the issues are Zod-shaped.
    let (status, body) = post(json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"]["issues"].is_array(), "{body}");
    // Selling countries are EU member states.
    let (status, body) = post(json!({ "name": "X", "sellingCountries": ["US"] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // `invoice` only on b2b.
    let (status, body) = post(json!({ "name": "X", "paymentMethods": ["invoice"] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post(json!({ "name": "X", "currency": "EURO" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Only a connected store has a connection, and it needs one.
    let (status, body) = post(json!({ "name": "X", "connectionId": "conn_1" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post(json!({ "name": "X", "type": "shopify" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = post(json!({ "name": "X", "type": "ebay" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn a_storefront_goes_live_only_when_complete() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let (status, body) = app
        .post(
            "/commerce-channels",
            &json!({ "name": "Empty", "status": "active" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CHANNEL_INCOMPLETE");
    assert_eq!(
        body["error"]["details"]["missing"],
        json!(["sellingCountries"])
    );
    let (status, body) = app
        .post(
            "/commerce-channels",
            &json!({ "name": "Empty", "status": "active", "sellingCountries": ["NL"], "paymentMethods": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["details"]["missing"],
        json!(["paymentMethods"])
    );

    // A draft may be incomplete; activating it is checked.
    let id = app.channel(&json!({ "name": "Draft" })).await;
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "status": "active" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CHANNEL_INCOMPLETE");
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "status": "active", "sellingCountries": ["FR"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "active");
    // Switching to b2c while paying by invoice is refused.
    let b2b = app
        .channel(&json!({ "name": "B2B", "audience": "b2b", "paymentMethods": ["invoice"] }))
        .await;
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{b2b}"),
            &json!({ "audience": "b2c" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // The type is fixed.
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{b2b}"),
            &json!({ "type": "manual" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "TYPE_LOCKED");
}

#[tokio::test]
async fn the_currency_locks_with_the_first_order() {
    let Some(db) = tenant().await else { return };
    let app = app(db.clone(), ALL);
    let id = app.storefront().await;
    // No orders yet: the currency may change, and the rates follow it.
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{id}/shipping-rates"),
            &json!({ "zoneName": "Benelux", "countries": ["NL"], "name": "Standard", "price": "4.95" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "currency": "SEK" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rates = read(&app, &format!("/commerce-channels/{id}/shipping-rates")).await;
    assert_eq!(rates[0]["currency"], "SEK");
    // The same currency again is no change.
    let (status, _) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "currency": "SEK" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    sqlx::query(
        "insert into orders (id, order_number, source, status, subtotal, total, channel_id) \
         values ($1, $2, 'storefront', 'pending', 1, 1, $3)",
    )
    .bind(fresh("ord_"))
    .bind(fresh("CH-"))
    .bind(&id)
    .execute(&db)
    .await
    .unwrap();
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "currency": "EUR" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CURRENCY_LOCKED");
    // Everything else still changes.
    let (status, _) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "name": "Still editable" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn shrinking_the_selling_countries_prunes_the_rates() {
    let Some(db) = tenant().await else { return };
    let app = app(db, ALL);
    let id = app.storefront().await;
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{id}/shipping-rates"),
            &json!({ "zoneName": "DACH", "countries": ["NL", "DE"], "name": "Std", "price": "5" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = app
        .patch(
            &format!("/commerce-channels/{id}"),
            &json!({ "sellingCountries": ["DE"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rates = read(&app, &format!("/commerce-channels/{id}/shipping-rates")).await;
    assert_eq!(rates[0]["countries"], json!(["DE"]));
}

#[tokio::test]
async fn a_store_connection_has_one_channel_and_no_keys() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db, Some(master), ALL);
    let connection = fresh("conn_");
    let id = app
        .channel(&json!({ "name": "My Shopify", "type": "shopify", "connectionId": connection }))
        .await;
    let channel = read(&app, &format!("/commerce-channels/{id}")).await;
    assert_eq!(channel["status"], "active");
    assert_eq!(channel["connectionId"], json!(connection));
    assert_eq!(channel["paymentMethods"], json!([]));
    let (status, body) = app
        .post(
            "/commerce-channels",
            &json!({ "name": "Twice", "type": "shopify", "connectionId": connection }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "CONNECTION_IN_USE");
    // No keys, no rates.
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{id}/keys"),
            &json!({ "kind": "private", "name": "Nope" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "KEYS_NOT_SUPPORTED");
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{id}/shipping-rates"),
            &json!({ "zoneName": "Z", "countries": ["NL"], "name": "N", "price": "1" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "SHIPPING_NOT_SUPPORTED");
}

#[tokio::test]
async fn delete_is_soft_and_revokes_the_keys_in_both_stores() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db.clone(), Some(master.clone()), ALL);
    let id = app.storefront().await;
    let (status, key) = app
        .post(
            &format!("/commerce-channels/{id}/keys"),
            &json!({ "kind": "publishable", "name": "Web", "allowedOrigins": ["https://shop.example.com"] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let key_id = key["data"]["key"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        read(&app, &format!("/commerce-channels/{id}")).await["activeKeyCount"],
        1
    );
    let (status, _) = app
        .post(
            &format!("/commerce-channels/{id}/shipping-rates"),
            &json!({ "zoneName": "Z", "countries": ["NL"], "name": "N", "price": "1" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = app.delete(&format!("/commerce-channels/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = app.get(&format!("/commerce-channels/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Soft: the row stays, deleted, with its key revoked on both sides.
    let (deleted, revoked): (bool, bool) = sqlx::query_as(
        "select c.deleted_at is not null, k.revoked_at is not null \
         from commerce_channels c join commerce_channel_keys k on k.channel_id = c.id where c.id = $1",
    )
    .bind(&id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(deleted && revoked);
    let registry_revoked: bool = sqlx::query_scalar(
        "select revoked_at is not null from storefront_key_registry where id = $1",
    )
    .bind(&key_id)
    .fetch_one(&master)
    .await
    .unwrap();
    assert!(registry_revoked);
    assert_eq!(
        app.events_of("commerce_channel:deleted", &id).await.len(),
        1
    );
    assert_eq!(
        app.events_of("commerce_channel_key:revoked", &key_id)
            .await
            .len(),
        1
    );
    let (status, _) = app.delete(&format!("/commerce-channels/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
