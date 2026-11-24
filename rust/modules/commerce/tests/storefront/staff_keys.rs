//! A key made in the back office opens the storefront: the staff routes
//! register it in the master registry the storefront reads, and a rotation
//! there stops the old key on the storefront.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_commerce::{CommerceState, StorefrontRegistry};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

use crate::harness::{WORKSPACE, code, env, fresh};

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// The staff commerce router for the storefront tests' workspace, as a member
/// who may manage channels.
fn staff(tenant: PgPool, master: PgPool) -> Router {
    let state = CommerceState {
        mail: None,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        http: None,
        payments: weldsuite_commerce::PaymentsConfig::default(),
        online_store: weldsuite_commerce::online_store::OnlineStoreConfig::default(),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [
            "commerce_channels:read",
            "commerce_channels:create",
            "commerce_channels:update",
        ]
        .iter()
        .map(|p| (*p).to_owned())
        .collect(),
        ..ResolvedPermissions::default()
    };
    weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: "user_sf_staff".to_owned(),
                org_id: Some("org_sf_test".to_owned()),
                session_id: "sess_sf_staff".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: WORKSPACE.to_owned(),
                clerk_org_id: Some("org_sf_test".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            });
            request.extensions_mut().insert(Permissions::new(
                resolved.clone(),
                None,
                false,
                "user_sf_staff".to_owned(),
            ));
            request
                .extensions_mut()
                .insert(StorefrontRegistry(master.clone()));
            next.run(request)
        },
    ))
}

async fn post(router: &Router, path: &str, body: &Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request");
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a_key_made_in_the_back_office_opens_the_storefront_until_it_is_rotated() {
    let Some(env) = env().await else { return };
    let staff = staff(env.tenant.clone(), env.master.clone());

    let (status, created) = post(
        &staff,
        "/commerce-channels",
        &json!({
            "name": fresh("Back office shop "),
            "type": "storefront",
            "audience": "b2c",
            "status": "active",
            "currency": "EUR",
            "pricesIncludeTax": true,
            "sellingCountries": ["NL"],
            "guestCheckout": true,
            "paymentMethods": ["mollie"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let channel = created["data"]["id"]
        .as_str()
        .expect("channel id")
        .to_owned();

    let keys = format!("/commerce-channels/{channel}/keys");
    let (status, key) = post(
        &staff,
        &keys,
        &json!({ "kind": "private", "name": "Server" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let old_secret = key["data"]["secret"].as_str().expect("secret").to_owned();
    let old_id = key["data"]["key"]["id"]
        .as_str()
        .expect("key id")
        .to_owned();

    // The storefront resolves the new key to this workspace and channel.
    let reply = env.app().get("/channel", &old_secret).send().await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["id"], json!(channel));

    // Rotating revokes the old key at once; the new one works. (A fresh app,
    // so no cached key lookup is involved.)
    let (status, rotated) = post(&staff, &format!("{keys}/{old_id}/rotate"), &json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "{rotated}");
    let new_secret = rotated["data"]["secret"]
        .as_str()
        .expect("secret")
        .to_owned();
    let app = env.app();
    let reply = app.get("/channel", &old_secret).send().await;
    assert_eq!(
        (reply.status, code(&reply)),
        (StatusCode::UNAUTHORIZED, "INVALID_KEY")
    );
    let reply = app.get("/channel", &new_secret).send().await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["data"]["id"], json!(channel));
}
