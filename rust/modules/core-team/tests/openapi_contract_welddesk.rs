//! The team members the native WeldDesk apps assign conversations to
//! (`listTeamMembers` in `apps/mobile-shared/openapi/welddesk.yaml`),
//! through `/api/team-members` as the server mounts it, on the real tenant
//! schema (`weldsuite_kit::openapi_contract`). The file's inbox operations
//! are checked in `modules/desk/tests/openapi_contract.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early.
//! The test's members have their own ids, replaced at its start.

use std::sync::Arc;

use axum::Router;
use weldsuite_auth::AuthContext;
use weldsuite_core_team::CoreTeamState;
use weldsuite_db::{
    Keyring, PgPool, Tenant, TenantPermissionQueries, WorkspaceConfig, WorkspaceRestrictions,
    Workspaces, master_pool,
};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::ApiError;
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{PermissionGate, Permissions, ResolvedPermissions};

const USER: &str = "user_openapi_contract_desk";

/// The agent, with a name and an email, and a teammate without either: the
/// list's nullable fields both ways.
const FIXTURES: &str = "
delete from workspace_members where id in ('wm_contract_desk_a', 'wm_contract_desk_b');
insert into workspace_members (id, user_id, email, name, role, status, member_type) values
    ('wm_contract_desk_a', 'user_openapi_contract_desk', 'agent@example.test', 'Ann Agent', 'ADMIN', 'ACTIVE', 'INTERNAL'),
    ('wm_contract_desk_b', 'user_openapi_contract_desk_b', null, null, 'MEMBER', 'ACTIVE', 'INTERNAL');
";

fn state(tenant: &PgPool) -> CoreTeamState {
    CoreTeamState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        cache: None,
        files: None,
        master: tenant.clone(),
        workspaces: Arc::new(Workspaces::new(
            tenant.clone(),
            Keyring::default(),
            WorkspaceConfig::default(),
        )),
        identity: None,
        plan_seat_limits: false,
    }
}

/// `/api/team-members` behind the session, tenant and permission layers,
/// for an agent without `team:read` (who sees teammates without their email).
fn app(tenant: &PgPool) -> Router {
    // The permissions are in the request, so the gate never asks.
    let gate = Arc::new(PermissionGate::new(|_| {
        Err::<TenantPermissionQueries, _>(ApiError::internal())
    }));
    let resolved = ResolvedPermissions {
        permissions: vec!["conversations:read".to_owned()],
        ..ResolvedPermissions::default()
    };
    let db = tenant.clone();
    Router::new()
        .nest(
            "/api/team-members",
            weldsuite_core_team::team_members(state(tenant), &gate),
        )
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_openapi_contract_desk".to_owned()),
                    session_id: "sess_openapi_contract_desk".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract_desk".to_owned(),
                    clerk_org_id: Some("org_openapi_contract_desk".to_owned()),
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

#[tokio::test]
async fn team_members_are_what_the_welddesk_apps_read() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let tenant = master_pool(&url, 2).expect("tenant pool");
    sqlx::raw_sql(FIXTURES)
        .execute(&tenant)
        .await
        .expect("fixtures");

    let contract = Contract::load("welddesk");
    let list = contract
        .success(
            &app(&tenant),
            "listTeamMembers",
            &[],
            &[
                ("memberType", "INTERNAL"),
                ("status", "ACTIVE"),
                ("limit", "100"),
            ],
            None,
        )
        .await;
    let users: Vec<&str> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|member| member["userId"].as_str())
        .collect();
    assert!(users.contains(&USER), "{list}");
    contract.finish_only(&["listTeamMembers"]);
}
