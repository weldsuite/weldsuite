//! Keys, origins, CORS, the channel's status and the rate limits.

use http::StatusCode;
use serde_json::json;

use crate::harness::{code, env};

#[tokio::test]
async fn keys_are_checked_before_anything_is_served() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;

    // Missing, malformed and unknown keys.
    let reply = app.get("/channel", "wsk_notastorefrontkey").send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::UNAUTHORIZED, "INVALID_KEY")
    );
    let reply = app.get("/channel", "wcs_unknown").send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::UNAUTHORIZED, "INVALID_KEY")
    );
    let bare = app.options("/channel").send().await; // no key needed
    assert_eq!(bare.status, StatusCode::NO_CONTENT);

    // A good key reads the channel.
    let channel_json = app.get("/channel", &key).ok(StatusCode::OK).await;
    assert_eq!(channel_json["id"], json!(channel));
    assert_eq!(channel_json["currency"], "EUR");
    assert_eq!(channel_json["paymentMethods"], json!(["mollie"]));
    assert!(channel_json.get("status").is_none());

    // last_used_at is kept, in both databases.
    app.settle().await;
    let used: (bool,) = sqlx::query_as(
        "select last_used_at is not null from commerce_channel_keys where channel_id = $1",
    )
    .bind(&channel)
    .fetch_one(&env.tenant)
    .await
    .expect("tenant key");
    assert!(used.0);
    let used: (bool,) = sqlx::query_as(
        "select last_used_at is not null from storefront_key_registry where channel_id = $1",
    )
    .bind(&channel)
    .fetch_one(&env.master)
    .await
    .expect("registry key");
    assert!(used.0);

    // A revoked key is refused (a fresh app: nothing cached).
    env.revoke(&key).await;
    let reply = env.app().get("/channel", &key).send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::UNAUTHORIZED, "INVALID_KEY")
    );
}

#[tokio::test]
async fn an_inactive_channel_serves_nothing() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let draft = env.channel(&json!({ "status": "draft" })).await;
    let key = env.key(&draft, "private", &[]).await;
    let reply = app.get("/channel", &key).send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "CHANNEL_INACTIVE")
    );

    let gone = env.channel(&json!({})).await;
    let key = env.key(&gone, "private", &[]).await;
    sqlx::query("update commerce_channels set deleted_at = now() where id = $1")
        .bind(&gone)
        .execute(&env.tenant)
        .await
        .expect("delete");
    let reply = app.get("/channel", &key).send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::FORBIDDEN, "CHANNEL_INACTIVE")
    );
}

#[tokio::test]
async fn a_publishable_key_works_only_from_its_origins_and_gets_cors_for_them() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env
        .key(&channel, "publishable", &["https://shop.example.com"])
        .await;

    let reply = app
        .get("/channel", &key)
        .origin("https://shop.example.com")
        .send()
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.headers["access-control-allow-origin"],
        "https://shop.example.com"
    );

    for origin in [Some("https://evil.example.com"), None] {
        let mut call = app.get("/channel", &key);
        if let Some(origin) = origin {
            call = call.origin(origin);
        }
        let reply = call.send().await;
        assert_eq!(
            (reply.status, code(&reply)),
            (StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED")
        );
        assert!(reply.headers.get("access-control-allow-origin").is_none());
    }

    // The preflight needs no key and names what is allowed.
    let preflight = app
        .options("/cart/items")
        .origin("https://shop.example.com")
        .header("access-control-request-method", "POST")
        .send()
        .await;
    assert_eq!(preflight.status, StatusCode::NO_CONTENT);
    assert_eq!(
        preflight.headers["access-control-allow-origin"],
        "https://shop.example.com"
    );
    let allowed = preflight.headers["access-control-allow-headers"]
        .to_str()
        .expect("text");
    assert!(allowed.contains("x-cart-token") && allowed.contains("idempotency-key"));
}

#[tokio::test]
async fn a_private_key_has_no_origin_check_and_no_cors() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;
    for origin in [None, Some("https://anything.example.org")] {
        let mut call = app.get("/channel", &key);
        if let Some(origin) = origin {
            call = call.origin(origin);
        }
        let reply = call.send().await;
        assert_eq!(reply.status, StatusCode::OK);
        assert!(reply.headers.get("access-control-allow-origin").is_none());
    }
}

#[tokio::test]
async fn requests_past_the_limit_get_429_with_retry_after() {
    let Some(env) = env().await else { return };
    let app = env.app();
    let channel = env.channel(&json!({})).await;
    let key = env.key(&channel, "private", &[]).await;

    // Checkout: 10 a minute, counted per key and shopper address.
    for _ in 0..10 {
        let reply = app
            .post(
                "/cart/checkout",
                &key,
                json!({ "paymentMethod": "invoice" }),
            )
            .header("x-shopper-ip", "10.0.0.1")
            .send()
            .await;
        assert_eq!(code(&reply), "CART_NOT_FOUND");
    }
    let reply = app
        .post(
            "/cart/checkout",
            &key,
            json!({ "paymentMethod": "invoice" }),
        )
        .header("x-shopper-ip", "10.0.0.1")
        .send()
        .await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED")
    );
    let wait: u32 = reply.headers["retry-after"]
        .to_str()
        .expect("text")
        .parse()
        .expect("seconds");
    assert!((1..=60).contains(&wait));
    // Another shopper is counted apart, and reads have their own counter.
    let other = app
        .post(
            "/cart/checkout",
            &key,
            json!({ "paymentMethod": "invoice" }),
        )
        .header("x-shopper-ip", "10.0.0.2")
        .send()
        .await;
    assert_eq!(code(&other), "CART_NOT_FOUND");
    let read = app
        .get("/channel", &key)
        .header("x-shopper-ip", "10.0.0.1")
        .send()
        .await;
    assert_eq!(read.status, StatusCode::OK);
}
