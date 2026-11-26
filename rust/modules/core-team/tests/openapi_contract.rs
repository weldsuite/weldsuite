//! `GET /api/workspaces` as the native apps read it
//! (`apps/mobile-shared/openapi/core.yaml`, `listWorkspaces`): the
//! membership-mode list a WeldID sign-in reads before it picks a workspace,
//! through the router as the server mounts it, on the real master schema
//! (`weldsuite_kit::openapi_contract`). `/config.json`, the file's other
//! operation, is checked in `bins/weldsuite/src/server.rs`.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set; otherwise returns early. The
//! test's rows have their own ids, replaced at its start.

use std::sync::Arc;

use axum::Router;
use weldsuite_auth::AuthContext;
use weldsuite_core_team::CoreTeamState;
use weldsuite_db::{Keyring, PgPool, WorkspaceConfig, Workspaces, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;

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

/// `/api/workspaces` behind the session only, as membership mode mounts it.
fn app(master: &PgPool) -> Router {
    let state = CoreTeamState {
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
    };
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
