//! The core endpoints as the native apps read them
//! (`apps/mobile-shared/openapi/core.yaml`), through the routers as the
//! server mounts them (`weldsuite_kit::openapi_contract`):
//!
//! - `listWorkspaces`: the membership-mode list a WeldID sign-in reads
//!   before it picks a workspace, on the real master schema. Runs when
//!   `WELDSUITE_TEST_MASTER_URL` is set.
//! - `registerPushToken` and `unregisterPushToken`: a native app's push and
//!   call tokens, on the real tenant schema. Runs when
//!   `WELDSUITE_TEST_TENANT_URL` is set.
//!
//! Each returns early without its database. `/config.json`, the file's
//! other operation, is checked in `bins/weldsuite/src/server.rs`. The
//! tests' rows have their own ids or user, replaced at their start.

use std::sync::Arc;

use axum::Router;
use serde_json::json;
use weldsuite_auth::AuthContext;
use weldsuite_core_team::CoreTeamState;
use weldsuite_db::{
    Keyring, PgPool, Tenant, TenantPermissionQueries, WorkspaceConfig, WorkspaceRestrictions,
    Workspaces, master_pool,
};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::ApiError;
use weldsuite_kit::openapi_contract::{Contract, Endpoint};
use weldsuite_permissions::PermissionGate;

const USER: &str = "user_openapi_contract";

/// Two memberships: one with an organization id and no picture, one
/// without an organization and with a picture.
const FIXTURES: &str = "
delete from user_workspaces where user_id = 'user_openapi_contract';
delete from workspaces where id in ('ws_openapi_contract_a', 'ws_openapi_contract_b');
delete from users where id = 'user_openapi_contract';
insert into users (id, email) values ('user_openapi_contract', 'openapi-contract@example.test');
insert into workspaces (id, clerk_org_id, name, slug, image_url) values
    ('ws_openapi_contract_a', 'org_openapi_contract_a', 'Contract A', 'openapi-contract-a', null),
    ('ws_openapi_contract_b', null, 'Contract B', 'openapi-contract-b', 'https://example.test/b.png');
insert into user_workspaces (id, user_id, workspace_id, role, status) values
    ('uw_openapi_contract_a', 'user_openapi_contract', 'ws_openapi_contract_a', 'org:admin', 'ACTIVE'),
    ('uw_openapi_contract_b', 'user_openapi_contract', 'ws_openapi_contract_b', 'org:member', 'ACTIVE');
";

fn state(master: &PgPool) -> CoreTeamState {
    CoreTeamState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        cache: None,
        files: None,
        master: master.clone(),
        workspaces: Arc::new(Workspaces::new(
            master.clone(),
            Keyring::default(),
            WorkspaceConfig::default(),
        )),
        identity: None,
        plan_seat_limits: false,
    }
}

/// `/api/workspaces` behind the session only, as membership mode mounts it.
fn app(master: &PgPool) -> Router {
    let state = state(master);
    Router::new()
        .nest(
            "/api/workspaces",
            weldsuite_core_team::workspace_directory(state),
        )
        .layer(axum::middleware::from_fn(
            |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: None,
                    session_id: "sess_openapi_contract".to_owned(),
                    factor_verification_age: None,
                });
                next.run(request)
            },
        ))
}

#[tokio::test]
async fn the_workspace_list_is_what_the_native_apps_read() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
    let master = master_pool(&url, 2).expect("master pool");
    sqlx::raw_sql(FIXTURES)
        .execute(&master)
        .await
        .expect("fixtures");

    let contract = Contract::load("core");
    let list = contract
        .success(&app(&master), "listWorkspaces", &[], &[], None)
        .await;
    assert_eq!(list["data"].as_array().map(Vec::len), Some(2), "{list}");
    contract.finish_only(&["listWorkspaces"]);
}

/// `/api/push-tokens` behind the session and tenant layers, as the server
/// mounts it (no permission: every signed-in member's device plumbing).
fn push_tokens_app(tenant: &PgPool) -> Router {
    // The routes check no permission, so the gate never asks.
    let gate = Arc::new(PermissionGate::new(|_| {
        Err::<TenantPermissionQueries, _>(ApiError::internal())
    }));
    let db = tenant.clone();
    Router::new()
        .nest(
            "/api/push-tokens",
            weldsuite_core_team::push_tokens(state(tenant), &gate),
        )
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_openapi_contract".to_owned()),
                    session_id: "sess_openapi_contract".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract".to_owned(),
                    clerk_org_id: Some("org_openapi_contract".to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                next.run(request)
            },
        ))
}

#[tokio::test]
async fn push_tokens_register_and_unregister_as_the_native_apps_call_them() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let tenant = master_pool(&url, 2).expect("tenant pool");
    sqlx::raw_sql("delete from device_tokens where user_id = 'user_openapi_contract';")
        .execute(&tenant)
        .await
        .expect("clean");
    let app = push_tokens_app(&tenant);
    let contract = Contract::load("core");

    // An iPhone's APNs token (hex) with its details, and an Android phone's
    // call token: the types only the native apps register.
    let apns = "a1".repeat(32);
    let registered = contract
        .success(
            &app,
            "registerPushToken",
            &[],
            &[],
            Some(&json!({
                "token": apns,
                "platform": "ios",
                "deviceId": "openapi-contract-iphone",
                "tokenType": "apns",
                "appCode": "weldchat",
                "deviceModel": "iPhone17,1",
                "osVersion": "26.1",
                "appVersion": "3.0.0",
            })),
        )
        .await;
    assert_eq!(registered["data"]["deviceId"], "openapi-contract-iphone");
    assert_eq!(registered["data"]["registered"], true);
    for (token, device, kind) in [
        ("fcm-openapi-contract", "openapi-contract-pixel", "fcm"),
        (
            "fcm-call-openapi-contract",
            "openapi-contract-pixel:call",
            "fcm_call",
        ),
    ] {
        contract
            .success(
                &app,
                "registerPushToken",
                &[],
                &[],
                Some(&json!({
                    "token": token,
                    "platform": "android",
                    "deviceId": device,
                    "tokenType": kind,
                    "appCode": "weldchat",
                })),
            )
            .await;
    }

    // Signing out of the Android phone stops its pushes and its ring.
    let unregistered = contract
        .success(
            &app,
            "unregisterPushToken",
            &[],
            &[("deviceId", "openapi-contract-pixel")],
            None,
        )
        .await;
    assert_eq!(unregistered["data"]["deviceId"], "openapi-contract-pixel");
    assert_eq!(unregistered["data"]["unregistered"], true);
    let listed = contract
        .send(
            &app,
            &Endpoint {
                method: "GET".to_owned(),
                uri: "/api/push-tokens".to_owned(),
            },
            None,
        )
        .await;
    assert_eq!(listed.status, 200);
    let devices: Vec<&str> = listed
        .body
        .as_ref()
        .and_then(|body| body["data"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|token| token["deviceId"].as_str())
        .collect();
    assert_eq!(devices, ["openapi-contract-iphone"], "{listed:?}");

    contract.finish_only(&["registerPushToken", "unregisterPushToken"]);
}
