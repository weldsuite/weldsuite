//! Storefront keys: the secret is shown once, only hashes are stored (tenant
//! and master), rotation and revocation reach both stores, origins are exact.

use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_db::PgPool;

use weldsuite_kit::portal::tokens::sha256_hex;

use crate::harness::{ALL, TestApp, app, app_with, both, read};

/// `(hash, kind, prefix, workspace, channel, origins, revoked)` of the master row.
async fn registry_row(
    master: &PgPool,
    id: &str,
) -> Option<(String, String, String, String, String, Value, bool)> {
    sqlx::query_as(
        "select key_hash, kind, key_prefix, workspace_id, channel_id, allowed_origins, \
           revoked_at is not null from storefront_key_registry where id = $1",
    )
    .bind(id)
    .fetch_optional(master)
    .await
    .unwrap()
}

async fn tenant_row(db: &PgPool, id: &str) -> (String, Value, bool) {
    sqlx::query_as(
        "select key_hash, allowed_origins, revoked_at is not null from commerce_channel_keys where id = $1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn create_key(app: &TestApp, channel: &str, body: &Value) -> (String, Value) {
    let (status, created) = app
        .post(&format!("/commerce-channels/{channel}/keys"), body)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    (
        created["data"]["secret"].as_str().unwrap().to_owned(),
        created["data"]["key"].clone(),
    )
}

#[tokio::test]
async fn a_secret_is_shown_once_and_only_its_hash_is_stored() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db.clone(), Some(master.clone()), ALL);
    let channel = app.storefront().await;

    let (secret, key) = create_key(
        &app,
        &channel,
        &json!({ "kind": "publishable", "name": "Web", "allowedOrigins": ["https://Shop.Example.com", "http://localhost:3000"] }),
    )
    .await;
    assert!(
        secret.starts_with("wcp_"),
        "a publishable key starts with wcp_"
    );
    assert!(secret[4..].bytes().all(|b| b.is_ascii_alphanumeric()));
    let key_id = key["id"].as_str().unwrap();
    assert_eq!(key["kind"], "publishable");
    assert_eq!(key["name"], "Web");
    assert_eq!(key["channelId"], json!(channel));
    assert_eq!(key["keyPrefix"], json!(secret[..16]));
    assert_eq!(
        key["allowedOrigins"],
        json!(["https://shop.example.com", "http://localhost:3000"])
    );
    assert_eq!(key["revokedAt"], json!(null));
    assert_eq!(key["lastUsedAt"], json!(null));
    assert_eq!(key["rotatedFromId"], json!(null));
    assert!(key.get("secret").is_none() && key.get("keyHash").is_none());

    // The tenant row holds the hash, never the secret.
    let (hash, origins, revoked) = tenant_row(&db, key_id).await;
    assert_eq!(hash, sha256_hex(&secret));
    assert_eq!(origins, key["allowedOrigins"]);
    assert!(!revoked);
    // The master registry row: same id and hash, the workspace's ws_ id.
    let row = registry_row(&master, key_id).await.expect("registered");
    assert_eq!(row.0, sha256_hex(&secret));
    assert_eq!(row.1, "publishable");
    assert_eq!(row.2, secret[..16]);
    assert_eq!(row.3, app.workspace);
    assert!(row.3.starts_with("ws_"));
    assert_eq!(row.4, channel);
    assert_eq!(row.5, key["allowedOrigins"]);
    assert!(!row.6);
    // Nothing anywhere stores the secret.
    let leaked: i64 = sqlx::query_scalar(
        "select count(*) from commerce_channel_keys where key_hash = $1 or key_prefix = $1 or name = $1",
    )
    .bind(&secret)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(leaked, 0);

    // The list and the detail never show it again.
    let list = read(&app, &format!("/commerce-channels/{channel}/keys")).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert!(!list.to_string().contains(&secret));
    assert_eq!(
        read(&app, &format!("/commerce-channels/{channel}")).await["activeKeyCount"],
        1
    );

    // The event carries no secret either.
    let events = app.events_of("commerce_channel_key:created", key_id).await;
    assert_eq!(events.len(), 1);
    assert!(!events[0].to_string().contains(&secret));
    assert!(!events[0].to_string().contains(&hash));

    // A private key has the other prefix and no origins.
    let (private, key) = create_key(
        &app,
        &channel,
        &json!({ "kind": "private", "name": "Server" }),
    )
    .await;
    assert!(private.starts_with("wcs_"));
    assert_ne!(private, secret);
    assert_eq!(key["allowedOrigins"], json!([]));
    assert_eq!(
        read(&app, &format!("/commerce-channels/{channel}")).await["activeKeyCount"],
        2
    );
}

#[tokio::test]
async fn origins_and_kinds_are_validated() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db, Some(master), ALL);
    let channel = app.storefront().await;
    let path = format!("/commerce-channels/{channel}/keys");
    for body in [
        // A publishable key needs an origin.
        json!({ "kind": "publishable", "name": "W" }),
        json!({ "kind": "publishable", "name": "W", "allowedOrigins": [] }),
        // Exact origins only.
        json!({ "kind": "publishable", "name": "W", "allowedOrigins": ["https://*.example.com"] }),
        json!({ "kind": "publishable", "name": "W", "allowedOrigins": ["https://shop.example.com/"] }),
        json!({ "kind": "publishable", "name": "W", "allowedOrigins": ["http://shop.example.com"] }),
        json!({ "kind": "publishable", "name": "W", "allowedOrigins": ["shop.example.com"] }),
        // A private key has none.
        json!({ "kind": "private", "name": "S", "allowedOrigins": ["https://shop.example.com"] }),
        json!({ "kind": "secret", "name": "S" }),
        json!({ "kind": "private" }),
    ] {
        let (status, answer) = app.post(&path, &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }
    let (status, _) = app.get("/commerce-channels/missing/keys").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, answer) = app
        .post(
            "/commerce-channels/missing/keys",
            &json!({ "kind": "private", "name": "S" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{answer}");
}

#[tokio::test]
async fn rotation_revokes_the_old_key_at_once_in_both_stores() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db.clone(), Some(master.clone()), ALL);
    let channel = app.storefront().await;
    let (old_secret, old) = create_key(
        &app,
        &channel,
        &json!({ "kind": "publishable", "name": "Web", "allowedOrigins": ["https://shop.example.com"] }),
    )
    .await;
    let old_id = old["id"].as_str().unwrap();

    let (status, rotated) = app
        .post(
            &format!("/commerce-channels/{channel}/keys/{old_id}/rotate"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{rotated}");
    let new_secret = rotated["data"]["secret"].as_str().unwrap();
    let new = &rotated["data"]["key"];
    let new_id = new["id"].as_str().unwrap();
    assert!(new_secret.starts_with("wcp_"));
    assert_ne!(new_secret, old_secret);
    assert_eq!(new["rotatedFromId"], json!(old_id));
    assert_eq!(new["name"], "Web");
    assert_eq!(new["allowedOrigins"], json!(["https://shop.example.com"]));
    assert_eq!(new["revokedAt"], json!(null));

    // Tenant: old revoked, new live. Master: the same.
    assert!(tenant_row(&db, old_id).await.2);
    assert!(!tenant_row(&db, new_id).await.2);
    assert!(registry_row(&master, old_id).await.unwrap().6);
    let fresh = registry_row(&master, new_id).await.unwrap();
    assert!(!fresh.6);
    assert_eq!(fresh.0, sha256_hex(new_secret));
    assert_eq!(fresh.3, app.workspace);
    assert_eq!(
        read(&app, &format!("/commerce-channels/{channel}")).await["activeKeyCount"],
        1
    );
    let list = read(&app, &format!("/commerce-channels/{channel}/keys")).await;
    // Newest first, revoked included.
    assert_eq!(list[0]["id"], json!(new_id));
    assert_eq!(list[1]["id"], json!(old_id));
    assert!(list[1]["revokedAt"].is_string());
    assert_eq!(
        app.events_of("commerce_channel_key:rotated", new_id)
            .await
            .len(),
        1
    );

    // A revoked key cannot rotate, edit or be revoked into a new state.
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{channel}/keys/{old_id}/rotate"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "KEY_REVOKED");
    let (status, _) = app
        .patch(
            &format!("/commerce-channels/{channel}/keys/{old_id}"),
            &json!({ "name": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn revoking_and_editing_reach_the_registry() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db.clone(), Some(master.clone()), ALL);
    let channel = app.storefront().await;
    let (_, key) = create_key(
        &app,
        &channel,
        &json!({ "kind": "publishable", "name": "Web", "allowedOrigins": ["https://a.example.com"] }),
    )
    .await;
    let id = key["id"].as_str().unwrap();
    let path = format!("/commerce-channels/{channel}/keys/{id}");

    let (status, body) = app
        .patch(&path, &json!({ "name": "Renamed", "allowedOrigins": ["https://b.example.com", "http://localhost:5173"] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["name"], "Renamed");
    let origins = json!(["https://b.example.com", "http://localhost:5173"]);
    assert_eq!(body["data"]["allowedOrigins"], origins);
    assert_eq!(registry_row(&master, id).await.unwrap().5, origins);
    assert_eq!(tenant_row(&db, id).await.1, origins);
    // A publishable key keeps at least one origin; a bad origin is refused.
    for bad in [
        json!({ "allowedOrigins": [] }),
        json!({ "allowedOrigins": ["*"] }),
    ] {
        let (status, body) = app.patch(&path, &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(registry_row(&master, id).await.unwrap().5, origins);

    let (status, body) = app.post(&format!("{path}/revoke"), &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["revokedAt"].is_string());
    assert!(tenant_row(&db, id).await.2);
    assert!(registry_row(&master, id).await.unwrap().6);
    assert_eq!(
        read(&app, &format!("/commerce-channels/{channel}")).await["activeKeyCount"],
        0
    );
    assert_eq!(
        app.events_of("commerce_channel_key:revoked", id)
            .await
            .len(),
        1
    );
    // Revoking again changes nothing (and publishes nothing more).
    let (status, again) = app.post(&format!("{path}/revoke"), &json!({})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["data"]["revokedAt"], body["data"]["revokedAt"]);
    assert_eq!(
        app.events_of("commerce_channel_key:revoked", id)
            .await
            .len(),
        1
    );

    let (status, _) = app
        .post(
            &format!("/commerce-channels/{channel}/keys/nope/revoke"),
            &json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_failed_tenant_write_leaves_no_key_in_the_registry() {
    let Some((db, master)) = both().await else {
        return;
    };
    let app = app_with(db.clone(), Some(master.clone()), ALL);
    let channel = app.storefront().await;
    // The tenant insert fails (a name past its column); the key must not
    // stay registered.
    sqlx::query("alter table commerce_channel_keys add constraint wc_test_no_boom check (name <> 'boom') not valid")
        .execute(&db)
        .await
        .ok();
    let (status, _) = app
        .post(
            &format!("/commerce-channels/{channel}/keys"),
            &json!({ "kind": "private", "name": "boom" }),
        )
        .await;
    sqlx::query("alter table commerce_channel_keys drop constraint if exists wc_test_no_boom")
        .execute(&db)
        .await
        .ok();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let stray: i64 =
        sqlx::query_scalar("select count(*) from storefront_key_registry where workspace_id = $1")
            .bind(&app.workspace)
            .fetch_one(&master)
            .await
            .unwrap();
    assert_eq!(stray, 0);
}

#[tokio::test]
async fn without_a_registry_the_key_routes_say_so() {
    let Some(db) = crate::harness::tenant().await else {
        return;
    };
    let app = app(db, ALL);
    let channel = app.storefront().await;
    let (status, body) = app
        .post(
            &format!("/commerce-channels/{channel}/keys"),
            &json!({ "kind": "private", "name": "S" }),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "KEY_REGISTRY_UNAVAILABLE");
}
