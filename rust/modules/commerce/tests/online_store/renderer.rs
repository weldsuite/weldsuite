//! The renderer's `/public/storefront/site` and the storefront API's hosted
//! principal.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::{Value, json};
use weldsuite_commerce::online_store::renderer::{RendererState, router};
use weldsuite_commerce::storefront::{StorefrontState, storefront_router};
use weldsuite_events::{EntityEventPublisher, TaskTracker};

use crate::harness::{ALL, Env, SECRET, env, send};

fn renderer(env: &Env) -> axum::Router {
    router(RendererState {
        master: env.master.clone(),
        workspaces: Arc::clone(&env.workspaces),
        config: env.config(),
    })
}

async fn site(env: &Env, host: &str, secret: &str, preview: Option<&str>) -> (StatusCode, Value) {
    let uri = match preview {
        Some(token) => format!("/site?host={host}&preview={token}"),
        None => format!("/site?host={host}"),
    };
    let request = Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {secret}"))
        .body(Body::empty())
        .unwrap();
    let reply = send(&renderer(env), request).await;
    (reply.status, reply.body)
}

#[tokio::test]
async fn the_renderer_reads_the_live_version_or_with_a_preview_token_the_draft() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site_id, channel) = staff.site().await;
    let host = staff.free_address(&site_id).await;

    let (status, _) = site(&env, &host, "wrong", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, unknown) = site(&env, "nobody.example.com", SECRET, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}");
    let (status, unpublished) = site(&env, &host, SECRET, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{unpublished}");
    assert_eq!(unpublished["error"]["code"], "NOT_PUBLISHED");

    // A preview link from the editor shows the draft.
    let (status, preview) = staff
        .post(
            &format!("/online-store/sites/{site_id}/preview"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let url = preview["data"]["url"].as_str().unwrap();
    assert!(
        url.starts_with(&format!("https://{host}/__preview?token=")),
        "{url}"
    );
    let token = url.split("token=").nth(1).unwrap();
    let (status, draft) = site(&env, &host, SECRET, Some(token)).await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    assert_eq!(draft["data"]["preview"], true);
    assert_eq!(draft["data"]["version"]["id"], "draft");
    assert_eq!(draft["data"]["locale"], "nl");
    assert_eq!(draft["data"]["channel"]["id"], channel.as_str());

    let (status, _) = staff
        .post(
            &format!("/online-store/sites/{site_id}/publish"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, live) = site(&env, &host, SECRET, None).await;
    assert_eq!(status, StatusCode::OK, "{live}");
    assert_eq!(live["data"]["version"]["number"], 1);
    assert_eq!(live["data"]["primaryOrigin"], format!("https://{host}"));
    assert!(live["data"]["version"]["document"]["menus"]["main"].is_object());
}

#[tokio::test]
async fn the_hosted_principal_shops_as_the_hosts_channel() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site_id, channel) = staff.site().await;
    let host = staff.free_address(&site_id).await;
    let api = storefront_router(StorefrontState {
        mail: None,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        http: None,
        master: env.master.clone(),
        workspaces: Arc::clone(&env.workspaces),
        cache: None,
        trusted_proxies: 1,
        payments: weldsuite_commerce::PaymentsConfig::default(),
        hosting: env.config(),
    });
    let call = |secret: &str, shop: &str| {
        Request::builder()
            .uri("/storefront/v1/channel")
            .header("authorization", format!("Hosted {secret}"))
            .header("x-storefront-host", shop)
            .body(Body::empty())
            .unwrap()
    };
    let reply = send(&api, call(SECRET, &host)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["id"], channel.as_str());
    let refused = send(&api, call("not-the-secret", &host)).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    let unknown = send(&api, call(SECRET, "nobody.example.com")).await;
    assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_publishable_key_works_from_the_channels_own_hosted_address() {
    let Some(env) = env().await else { return };
    let staff = env.staff(ALL);
    let (site_id, channel) = staff.site().await;
    let host = staff.free_address(&site_id).await;
    let (other_site, _) = staff.site().await;
    let other_host = staff.free_address(&other_site).await;
    let (status, key) = staff
        .post(
            &format!("/commerce-channels/{channel}/keys"),
            &json!({ "kind": "publishable", "name": "Hosted shop", "allowedOrigins": ["https://example.org"] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let secret = key["data"]["secret"].as_str().unwrap().to_owned();
    let api = storefront_router(StorefrontState {
        mail: None,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        http: None,
        master: env.master.clone(),
        workspaces: Arc::clone(&env.workspaces),
        cache: None,
        trusted_proxies: 1,
        payments: weldsuite_commerce::PaymentsConfig::default(),
        hosting: env.config(),
    });
    let from = |origin: &str| {
        Request::builder()
            .uri("/storefront/v1/channel")
            .header("authorization", format!("Bearer {secret}"))
            .header("origin", origin)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        send(&api, from("https://example.org")).await.status,
        StatusCode::OK
    );
    let hosted = send(&api, from(&format!("https://{host}"))).await;
    assert_eq!(hosted.status, StatusCode::OK, "{}", hosted.body);
    assert_eq!(
        hosted.headers["access-control-allow-origin"],
        format!("https://{host}").as_str()
    );
    // Another channel's shop can't use this channel's key.
    assert_eq!(
        send(&api, from(&format!("https://{other_host}")))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}
