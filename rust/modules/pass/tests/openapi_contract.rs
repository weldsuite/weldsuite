//! What the native WeldPass apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/weldpass.yaml`): every
//! operation in it, sent as the file describes it through the router as the
//! server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test has its own workspace, cleaned at its start.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_kit::openapi_contract::{Contract, Endpoint};
use weldsuite_pass::{PassState, ReqwestTransport, RootKeyring};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const ROOT: &str = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
/// `weldpass_*.workspace_id`: the organization id.
const WORKSPACE: &str = "org_openapi_contract";
const USER: &str = "user_openapi_contract";
const SEED: &str = "JBSWY3DPEHPK3PXP";

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

/// `/api/weldpass` behind the session, tenant and permission layers, for a
/// workspace admin (who may also switch offline copies on).
fn app(db: PgPool) -> Router {
    let state = PassState {
        root_keys: RootKeyring::from_values(Some(ROOT), None),
        http: Arc::new(ReqwestTransport::new()),
        sync: false,
        trusted_proxies: 1,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: ["passwords:use", "passwords:create", "passwords:manage"]
            .map(str::to_owned)
            .to_vec(),
        ..ResolvedPermissions::default()
    };
    Router::new()
        .nest("/api/weldpass", weldsuite_pass::router(state, &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(WORKSPACE.to_owned()),
                    session_id: "sess_openapi_contract".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract".to_owned(),
                    clerk_org_id: Some(WORKSPACE.to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                request.extensions_mut().insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    USER.to_owned(),
                ));
                next.run(request)
            },
        ))
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 2).expect("tenant pool"))
}

/// Drop what an earlier run left in the test's workspace.
async fn clean(db: &PgPool) {
    for statement in [
        "delete from weldpass_vault_events where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_item_versions where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_items where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vault_members where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vaults where workspace_id = $1",
        "delete from weldpass_devices where workspace_id = $1",
    ] {
        sqlx::query(statement)
            .bind(WORKSPACE)
            .execute(db)
            .await
            .expect("clean");
    }
}

/// A route the apps don't call (settings, creating a shared vault), for the
/// fixtures; expects `status`.
async fn setup(
    contract: &Contract,
    app: &Router,
    method: &str,
    path: &str,
    body: &Value,
    status: u16,
) -> Value {
    let endpoint = Endpoint {
        method: method.to_owned(),
        uri: format!("/api/weldpass{path}"),
    };
    let answer = contract.send(app, &endpoint, Some(body)).await;
    assert_eq!(answer.status, status, "{method} {path}: {:?}", answer.body);
    answer.body.unwrap_or(Value::Null)
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// The vault of `kind` in a `listVaults` answer.
fn vault(list: &Value, kind: &str) -> String {
    list["data"]
        .as_array()
        .and_then(|vaults| vaults.iter().find(|vault| vault["kind"] == kind))
        .and_then(|vault| vault["id"].as_str())
        .expect("the vault")
        .to_owned()
}

/// One vault of a `syncDevice` answer.
fn synced<'a>(sync: &'a Value, vault_id: &str) -> &'a Value {
    sync["data"]["vaults"]
        .as_array()
        .and_then(|vaults| {
            vaults
                .iter()
                .find(|synced| synced["vault"]["id"] == vault_id)
        })
        .expect("the vault was synced")
}

/// Every operation of weldpass.yaml, with data that gives each nullable and
/// enum field more than one value: a personal and a shared vault, a login
/// with a 2FA seed, one reusing its weak password, a note and a card; two
/// phones, one revoked.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn weldpass_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    clean(&db).await;
    let app = app(db);
    let contract = Contract::load("weldpass");

    setup(
        &contract,
        &app,
        "PATCH",
        "/settings",
        &json!({ "offlineCopies": true }),
        200,
    )
    .await;

    // Vaults: the first list creates the personal vault.
    let vaults = contract.success(&app, "listVaults", &[], &[], None).await;
    let personal = vault(&vaults, "personal");
    let personal = personal.as_str();
    let shared = id(&setup(
        &contract,
        &app,
        "POST",
        "/vaults",
        &json!({ "name": "Team" }),
        201,
    )
    .await);
    let shared = shared.as_str();
    contract.success(&app, "listVaults", &[], &[], None).await;

    // Items, one of each type.
    let login = json!({
        "type": "login",
        "title": "Example",
        "url": "https://example.com/sign-in",
        "fields": {
            "username": "ada@example.com",
            "password": "password",
            "totp": SEED,
            "notes": "",
            "apps": ["com.example.app"],
        },
    });
    let login_id = id(&contract
        .success(
            &app,
            "createItem",
            &[("vaultId", personal)],
            &[],
            Some(&login),
        )
        .await);
    let reused = json!({
        "type": "login",
        "title": "Reuses the password",
        "url": null,
        "fields": { "username": "", "password": "password" },
    });
    let reused_id = id(&contract
        .success(
            &app,
            "createItem",
            &[("vaultId", personal)],
            &[],
            Some(&reused),
        )
        .await);
    let note = json!({ "type": "note", "title": "Wi-Fi", "fields": { "content": "hunter2" } });
    let note_id = id(&contract
        .success(
            &app,
            "createItem",
            &[("vaultId", personal)],
            &[],
            Some(&note),
        )
        .await);
    let card = json!({
        "type": "card",
        "title": "Company card",
        "fields": {
            "cardholder": "Ada Lovelace",
            "number": "4242424242424242",
            "expiry": "12/30",
            "cvc": "123",
            "notes": "",
        },
    });
    let card_id = id(&contract
        .success(&app, "createItem", &[("vaultId", shared)], &[], Some(&card))
        .await);
    let shared_login = json!({
        "type": "login",
        "title": "Shared login",
        "url": "team.example.com",
        "fields": { "username": "team", "password": "a-long-and-unique-passphrase-9", "totp": SEED },
    });
    contract
        .success(
            &app,
            "createItem",
            &[("vaultId", shared)],
            &[],
            Some(&shared_login),
        )
        .await;

    contract.success(&app, "listItems", &[], &[], None).await;
    let logins = contract
        .success(
            &app,
            "listItems",
            &[],
            &[("vaultId", personal), ("type", "login")],
            None,
        )
        .await;
    assert_eq!(logins["data"].as_array().map(Vec::len), Some(2));

    // A whole item replaced.
    let renamed = json!({
        "type": "login",
        "title": "Reuses the password, renamed",
        "url": "https://example.org",
        "fields": { "username": "grace@example.com", "password": "password", "totp": "", "notes": "x" },
    });
    contract
        .success(
            &app,
            "updateItem",
            &[("vaultId", personal), ("itemId", reused_id.as_str())],
            &[],
            Some(&renamed),
        )
        .await;

    // Secrets: a login's and a card's fields, the 2FA code.
    for (vault_id, item_id) in [
        (personal, login_id.as_str()),
        (shared, card_id.as_str()),
        (personal, note_id.as_str()),
    ] {
        contract
            .success(
                &app,
                "revealItem",
                &[("vaultId", vault_id), ("itemId", item_id)],
                &[],
                None,
            )
            .await;
    }
    contract
        .success(
            &app,
            "generateTotp",
            &[("vaultId", personal), ("itemId", login_id.as_str())],
            &[],
            None,
        )
        .await;

    let health = contract
        .success(&app, "passwordHealth", &[], &[], None)
        .await;
    assert!(
        health["data"]["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty()),
        "the weak, reused password is reported: {health}"
    );

    // Phones and their offline copy.
    let phone = id(&contract
        .success(
            &app,
            "registerDevice",
            &[],
            &[],
            Some(&json!({ "name": "Ada's iPhone", "platform": "ios", "appVersion": "2.0.0" })),
        )
        .await);
    let tablet = id(&contract
        .success(
            &app,
            "registerDevice",
            &[],
            &[],
            Some(&json!({ "name": "Tablet", "platform": "android" })),
        )
        .await);
    let full = contract
        .success(
            &app,
            "syncDevice",
            &[("deviceId", phone.as_str())],
            &[],
            Some(&json!({ "cursors": {} })),
        )
        .await;
    let cursors: serde_json::Map<String, Value> = [personal, shared]
        .into_iter()
        .map(|vault_id| {
            (
                vault_id.to_owned(),
                synced(&full, vault_id)["cursor"].clone(),
            )
        })
        .collect();
    contract.success(&app, "listDevices", &[], &[], None).await;

    contract
        .success(
            &app,
            "deleteItem",
            &[("vaultId", personal), ("itemId", note_id.as_str())],
            &[],
            None,
        )
        .await;
    // From the cursors: the deletion comes as an id.
    contract
        .success(
            &app,
            "syncDevice",
            &[("deviceId", phone.as_str())],
            &[],
            Some(&json!({ "cursors": cursors })),
        )
        .await;

    let recorded = contract
        .success(
            &app,
            "uploadDeviceEvents",
            &[("deviceId", phone.as_str())],
            &[],
            Some(&json!({ "events": [
                { "vaultId": personal, "itemId": login_id, "action": "copied", "at": "2026-11-26T10:00:00.000Z" },
                { "vaultId": shared, "itemId": card_id, "action": "revealed", "at": "2026-11-26T10:01:00+01:00" },
            ] })),
        )
        .await;
    assert_eq!(recorded["data"]["recorded"], 2);

    contract
        .success(
            &app,
            "revokeDevice",
            &[("deviceId", tablet.as_str())],
            &[],
            None,
        )
        .await;
    let wiped = contract
        .success(
            &app,
            "syncDevice",
            &[("deviceId", tablet.as_str())],
            &[],
            Some(&json!({ "cursors": {} })),
        )
        .await;
    assert_eq!(wiped["data"]["wipe"], true);
    contract.success(&app, "listDevices", &[], &[], None).await;

    // Refusals decode as the file's error: a body that fails validation
    // (Zod's shape, without `code`), and a missing item.
    let invalid = contract
        .failure(
            &app,
            "createItem",
            &[("vaultId", personal)],
            Some(&json!({})),
        )
        .await;
    assert_eq!(invalid.status, 400);
    let invalid = contract
        .failure(
            &app,
            "registerDevice",
            &[],
            Some(&json!({ "name": "Phone", "platform": "windows" })),
        )
        .await;
    assert_eq!(invalid.status, 400);
    let missing = contract
        .failure(
            &app,
            "revealItem",
            &[("vaultId", personal), ("itemId", "wpi_missing")],
            None,
        )
        .await;
    assert_eq!(missing.status, 404);
    assert!(
        missing
            .body
            .is_some_and(|body| body["error"]["code"].is_string())
    );

    contract.finish();
}
