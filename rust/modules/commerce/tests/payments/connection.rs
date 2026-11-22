//! `/api/commerce-payments/connection`: an API key, Mollie Connect (OAuth),
//! token refresh, `needs_reauth`, disconnecting.

use http::StatusCode;
use serde_json::json;

use crate::harness::{ALL, Ctx, Public, Staff, events_of, setup};

const KEY_PATH: &str = "/commerce-payments/connection/mollie/api-key";
const SECRET: &str = "test_abcdefghijklmnopqrstuvwxyz123456";

fn code(body: &serde_json::Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn an_api_key_connects_replaces_and_disconnects() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.staff(ALL, true);

    let (status, body) = app.get("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "data": null, "meta": { "oauthAvailable": true } })
    );

    // A key that is not one, and one Mollie refuses.
    let (status, body) = app.post(KEY_PATH, &json!({ "apiKey": "nope" })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "MOLLIE_KEY_INVALID")
    );
    ctx.fake.reject_keys(true);
    let (status, body) = app.post(KEY_PATH, &json!({ "apiKey": SECRET })).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::BAD_REQUEST, "MOLLIE_KEY_INVALID")
    );
    ctx.fake.reject_keys(false);
    let (status, _) = app.post(KEY_PATH, &json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A valid key: the profile comes from Mollie, test mode from the prefix.
    let connection = app.connect_key().await;
    assert_eq!(connection["authMethod"], "api_key");
    assert_eq!(connection["status"], "connected");
    assert_eq!(connection["testmode"], true);
    assert_eq!(connection["profileId"], "pfl_key");
    assert_eq!(connection["profileName"], "Key shop");
    assert_eq!(connection["oauthAvailable"], true);
    assert!(
        !connection.to_string().contains(SECRET),
        "the key is never shown back"
    );
    let id = connection["id"].as_str().expect("id").to_owned();

    // Stored encrypted, registered in the master.
    let stored: String = sqlx::query_scalar(
        "select api_key_encrypted from commerce_payment_connections where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.tenant)
    .await
    .expect("stored key");
    assert!(!stored.contains(SECRET) && stored != SECRET);
    let registered: Option<bool> = sqlx::query_scalar(
        "select deleted_at is null from commerce_connection_registry where id = $1 and workspace_id = $2",
    )
    .bind(&id)
    .bind(crate::harness::WORKSPACE)
    .fetch_optional(&ctx.master)
    .await
    .expect("registry");
    assert_eq!(registered, Some(true));

    let (_, body) = app.get("/commerce-payments/connection").await;
    assert_eq!(body["data"]["id"], id.as_str());

    // Connecting again replaces the connection and keeps its id (the webhook
    // URL Mollie was given keeps working).
    let again = app.connect_key().await;
    assert_eq!(again["id"], id.as_str());

    // The key fixes the test mode; the profiles are for OAuth.
    let (status, body) = app
        .patch(
            "/commerce-payments/connection",
            &json!({ "testmode": false }),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "TESTMODE_FIXED")
    );
    let (status, _) = app
        .patch(
            "/commerce-payments/connection",
            &json!({ "testmode": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = app.get("/commerce-payments/connection/profiles").await;
    assert_eq!((status, code(&body)), (StatusCode::CONFLICT, "NOT_OAUTH"));

    // Disconnecting: no credentials left, the registry no longer answers.
    let (status, _) = app.delete("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = app.get("/commerce-payments/connection").await;
    assert_eq!(body["data"]["status"], "disconnected");
    let key_left: Option<String> = sqlx::query_scalar(
        "select api_key_encrypted from commerce_payment_connections where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.tenant)
    .await
    .expect("row");
    assert_eq!(key_left, None);
    let removed: bool = sqlx::query_scalar(
        "select deleted_at is not null from commerce_connection_registry where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.master)
    .await
    .expect("registry");
    assert!(removed);
    let public = Public(ctx.public(true));
    assert_eq!(
        public.webhook(&id, "tr_whatever").await,
        StatusCode::NOT_FOUND
    );
    let (status, _) = app.delete("/commerce-payments/connection").await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "disconnecting twice is fine"
    );

    // Reconnecting brings the same id back.
    let back = app.connect_key().await;
    assert_eq!(back["id"], id.as_str());

    let events = ctx.events().await;
    assert_eq!(
        events_of(&events, "commerce_payment_connection:connected", &id),
        2 + 1
    );
    assert_eq!(
        events_of(&events, "commerce_payment_connection:updated", &id),
        1
    );
    assert_eq!(
        events_of(&events, "commerce_payment_connection:disconnected", &id),
        2
    );
    assert!(
        !serde_json::to_string(&events)
            .expect("json")
            .contains(SECRET)
    );
}

fn state_of(url: &str) -> String {
    url::Url::parse(url)
        .expect("url")
        .query_pairs()
        .find(|(n, _)| n == "state")
        .map(|(_, v)| v.into_owned())
        .expect("state")
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn authorize(app: &Staff, body: &serde_json::Value) -> (StatusCode, serde_json::Value) {
    app.post("/commerce-payments/connection/mollie/authorize", body)
        .await
}

/// Connects through the OAuth flow; the connection.
pub(crate) async fn connect_oauth(ctx: &Ctx, app: &Staff) -> serde_json::Value {
    let public = Public(ctx.public(true));
    let (status, body) = authorize(app, &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let url = body["data"]["url"].as_str().expect("url").to_owned();
    let (status, location) = public
        .callback(&format!("code=code_1&state={}", encode(&state_of(&url))))
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(location.contains("mollie=connected"), "{location}");
    app.get("/commerce-payments/connection").await.1["data"].clone()
}

#[tokio::test]
async fn mollie_connect_authorizes_calls_back_and_picks_a_profile() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.staff(ALL, true);
    let public = Public(ctx.public(true));

    // The authorize URL names the app, the callback and a signed state.
    let (status, body) = authorize(&app, &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let url = body["data"]["url"].as_str().expect("url").to_owned();
    let parsed = url::Url::parse(&url).expect("url");
    assert_eq!(parsed.host_str(), Some("my.mollie.com"));
    let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "app_test");
    assert_eq!(
        query["redirect_uri"],
        "https://app.test/api/commerce-payments/connection/mollie/callback"
    );
    assert!(query["scope"].contains("payments.write"));
    let state = state_of(&url);

    // A redirect that leaves the site is refused.
    for bad in ["//evil.example", "https://evil.example/x", "settings"] {
        let (status, _) = authorize(&app, &json!({ "redirectTo": bad })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }

    // The callback: a forged state, a denial, a code Mollie refuses.
    let (status, location) = public.callback("code=code_1&state=forged").await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        location,
        "https://app.test/settings/apps/weldcommerce?tab=payments&mollie=error&reason=invalid_state"
    );
    let (_, location) = public
        .callback(&format!("error=access_denied&state={}", encode(&state)))
        .await;
    assert!(
        location.ends_with("mollie=error&reason=access_denied"),
        "{location}"
    );
    let (_, location) = public
        .callback(&format!("code=bad_code&state={}", encode(&state)))
        .await;
    assert!(
        location.ends_with("mollie=error&reason=token_exchange_failed"),
        "{location}"
    );
    assert!(app.get("/commerce-payments/connection").await.1["data"].is_null());

    // The real thing.
    let (status, location) = public
        .callback(&format!("code=code_1&state={}", encode(&state)))
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        location,
        "https://app.test/settings/apps/weldcommerce?tab=payments&mollie=connected"
    );
    let connection = app.get("/commerce-payments/connection").await.1["data"].clone();
    assert_eq!(connection["authMethod"], "oauth");
    assert_eq!(connection["status"], "connected");
    assert_eq!(connection["organizationName"], "Shop BV");
    assert_eq!(connection["profileId"], "pfl_1", "a live profile first");
    assert_eq!(connection["testmode"], false);
    let id = connection["id"].as_str().expect("id").to_owned();
    let (access, refresh): (String, String) = sqlx::query_as(
        "select access_token_encrypted, refresh_token_encrypted from commerce_payment_connections where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.tenant)
    .await
    .expect("tokens");
    assert!(!access.contains("access_1") && !refresh.contains("refresh_1"));
    let registered: bool = sqlx::query_scalar(
        "select deleted_at is null from commerce_connection_registry where id = $1",
    )
    .bind(&id)
    .fetch_one(&ctx.master)
    .await
    .expect("registry");
    assert!(registered);

    // Profiles, the profile and the test mode.
    let (status, body) = app.get("/commerce-payments/connection/profiles").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().expect("list").len(), 2);
    assert_eq!(body["data"][0]["website"], "https://shop.test");
    let (status, body) = app
        .patch(
            "/commerce-payments/connection",
            &json!({ "profileId": "pfl_2", "testmode": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["profileName"], "Shop test");
    assert_eq!(body["data"]["testmode"], true);
    let (status, _) = app
        .patch(
            "/commerce-payments/connection",
            &json!({ "profileId": "pfl_other" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A payment created now carries the profile and the test mode.
    let order = ctx.order("10.00", "pending").await;
    let (status, body) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let create = &ctx.fake.requests_to("POST", "/payments")[0];
    let sent: serde_json::Value = serde_json::from_str(&create.body).expect("json");
    assert_eq!(sent["profileId"], "pfl_2");
    assert_eq!(sent["testmode"], true);

    // A return path of the app's own.
    let (_, body) = authorize(
        &app,
        &json!({ "redirectTo": "/settings/apps/weldcommerce?tab=channels" }),
    )
    .await;
    let state = state_of(body["data"]["url"].as_str().expect("url"));
    let (_, location) = public
        .callback(&format!("code=code_1&state={}", encode(&state)))
        .await;
    assert_eq!(
        location,
        "https://app.test/settings/apps/weldcommerce?tab=channels&mollie=connected"
    );

    // Disconnecting revokes the grant at Mollie.
    let (status, _) = app.delete("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(ctx.fake.requests_to("DELETE", "/oauth2/tokens").len(), 2);
}

#[tokio::test]
async fn an_install_without_a_connect_app_says_so() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.staff(ALL, false);
    let (status, body) = authorize(&app, &json!({})).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "MOLLIE_CONNECT_NOT_CONFIGURED")
    );
    let (_, body) = app.get("/commerce-payments/connection").await;
    assert_eq!(body["meta"]["oauthAvailable"], false);
    // An API key still works.
    let connection = app.connect_key().await;
    assert_eq!(connection["oauthAvailable"], false);
}

#[tokio::test]
async fn tokens_refresh_before_expiry_and_on_a_401() {
    let Some(ctx) = setup().await else { return };
    let app = ctx.staff(ALL, true);
    let connection = connect_oauth(&ctx, &app).await;
    let id = connection["id"].as_str().expect("id").to_owned();
    let refreshes = || {
        ctx.fake
            .requests_to("POST", "/oauth2/tokens")
            .iter()
            .filter(|r| r.body.contains("grant_type=refresh_token"))
            .count()
    };

    // A fresh token is used as it is.
    let order = ctx.order("10.00", "pending").await;
    let link = format!("/orders/{order}/payment-link");
    let (status, _) = app.post(&link, &json!({})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(refreshes(), 0);
    let create = ctx.fake.requests_to("POST", "/payments");
    assert_eq!(create[0].bearer.as_deref(), Some("access_1"));

    // About to expire: refreshed first, the new token used and kept.
    sqlx::query("update commerce_payment_connections set token_expires_at = now() at time zone 'utc' - interval '1 minute'")
        .execute(&ctx.tenant)
        .await
        .expect("expire");
    let order = ctx.order("11.00", "pending").await;
    let (status, _) = app
        .post(&format!("/orders/{order}/payment-link"), &json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(refreshes(), 1);
    assert_eq!(
        ctx.fake.requests_to("POST", "/payments")[1]
            .bearer
            .as_deref(),
        Some("access_2")
    );
    let (status, _) = app
        .post(
            &format!(
                "/orders/{}/payment-link",
                ctx.order("12.00", "pending").await
            ),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(refreshes(), 1, "the refreshed token was kept");

    // Mollie answers 401 for the token we hold: one refresh, then the call.
    ctx.fake.reject_token(Some("access_2"));
    let (status, body) = app
        .post(
            &format!(
                "/orders/{}/payment-link",
                ctx.order("13.00", "pending").await
            ),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(refreshes(), 2);
    assert_eq!(
        ctx.fake
            .requests_to("POST", "/payments")
            .last()
            .expect("last")
            .bearer
            .as_deref(),
        Some("access_3")
    );
    ctx.fake.reject_token(None);

    // A refresh Mollie refuses: the merchant has to connect again.
    sqlx::query("update commerce_payment_connections set token_expires_at = now() at time zone 'utc' - interval '1 minute'")
        .execute(&ctx.tenant)
        .await
        .expect("expire");
    ctx.fake.fail_refresh(true);
    let (status, body) = app
        .post(
            &format!(
                "/orders/{}/payment-link",
                ctx.order("14.00", "pending").await
            ),
            &json!({}),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "PAYMENT_PROVIDER_NOT_CONNECTED")
    );
    let (_, body) = app.get("/commerce-payments/connection").await;
    assert_eq!(body["data"]["status"], "needs_reauth");
    assert!(
        body["data"]["lastError"]
            .as_str()
            .is_some_and(|e| e.contains("invalid_grant"))
    );
    assert_eq!(body["data"]["id"], id.as_str());
    // Connecting again heals it.
    ctx.fake.fail_refresh(false);
    let healed = connect_oauth(&ctx, &app).await;
    assert_eq!(healed["status"], "connected");
    assert_eq!(healed["lastError"], serde_json::Value::Null);
}

#[tokio::test]
async fn the_connection_routes_check_permissions() {
    let Some(ctx) = setup().await else { return };
    let none = ctx.staff(&["orders:read"], true);
    let (status, _) = none.get("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let reader = ctx.staff(&["commerce_settings:read", "orders:read"], true);
    let (status, _) = reader.get("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = reader.post(KEY_PATH, &json!({ "apiKey": SECRET })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = reader.delete("/commerce-payments/connection").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let order = ctx.order("10.00", "pending").await;
    for path in ["payment-link", "refunds", "invoice"] {
        let (status, _) = reader
            .post(&format!("/orders/{order}/{path}"), &json!({}))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
    }
    let nothing = ctx.staff(&[], true);
    let (status, _) = nothing.get(&format!("/orders/{order}/payments")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
