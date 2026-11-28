//! The team members and their profiles as the native WeldChat apps read them
//! (`apps/mobile-shared/openapi/weldchat.yaml`: the mention picker, the
//! people lists and the member screen), through `/api/team-members` as the
//! server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's chat operations are
//! checked in `modules/chat/tests/openapi_contract.rs`, its notifications in
//! `modules/core-platform/tests/openapi_contract_weldchat.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early.
//! The test's members, their activity and notes have their own ids,
//! replaced at its start.

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
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{PermissionGate, Permissions, ResolvedPermissions};

/// The caller, and a teammate whose profile they look at.
const USER: &str = "user_openapi_contract_chat_team";
const OTHER: &str = "user_openapi_contract_chat_team_b";

/// The caller with a name and an email, the teammate with neither; one thing
/// the teammate did; no notes yet.
const FIXTURES: &str = "
delete from workspace_members where id in ('wm_contract_chat_team_a', 'wm_contract_chat_team_b');
insert into workspace_members (id, user_id, email, name, role, status, member_type) values
    ('wm_contract_chat_team_a', 'user_openapi_contract_chat_team', 'ann.team@example.test', 'Ann Team', 'OWNER', 'ACTIVE', 'INTERNAL'),
    ('wm_contract_chat_team_b', 'user_openapi_contract_chat_team_b', null, null, 'MEMBER', 'ACTIVE', 'EXTERNAL_GUEST');
delete from audit_logs where id = 'al_contract_chat_team';
insert into audit_logs (id, entity_type, entity_id, action, description, performed_by) values
    ('al_contract_chat_team', 'project_task', 'tsk_contract_chat', 'created', 'Created task ''Ship the app''', 'user_openapi_contract_chat_team_b');
delete from member_notes where author_user_id = 'user_openapi_contract_chat_team';
";

/// The operations of weldchat.yaml this file checks.
const TEAM_OPERATIONS: &[&str] = &[
    "listTeamMembers",
    "getMemberProfile",
    "updateMemberProfile",
    "getMemberCommon",
    "listMemberActivity",
    "getMemberNote",
    "saveMemberNote",
];

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
/// for a workspace owner.
fn app(tenant: &PgPool) -> Router {
    // The permissions are in the request, so the gate never asks.
    let gate = Arc::new(PermissionGate::new(|_| {
        Err::<TenantPermissionQueries, _>(ApiError::internal())
    }));
    let resolved = ResolvedPermissions {
        permissions: vec!["*".to_owned()],
        role: "OWNER".to_owned(),
        is_owner: true,
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
                    org_id: Some("org_openapi_contract_chat_team".to_owned()),
                    session_id: "sess_openapi_contract_chat_team".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract_chat_team".to_owned(),
                    clerk_org_id: Some("org_openapi_contract_chat_team".to_owned()),
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

/// Every team-member operation of weldchat.yaml: the roster with guests, a
/// profile with every field set and one with none, what two people share,
/// a teammate's activity, and the caller's note about them before and after
/// it was written.
#[tokio::test]
async fn team_members_are_what_the_weldchat_apps_read() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let tenant = master_pool(&url, 2).expect("tenant pool");
    sqlx::raw_sql(FIXTURES)
        .execute(&tenant)
        .await
        .expect("fixtures");
    let app = app(&tenant);
    let contract = Contract::load("weldchat");

    let list = contract
        .success(
            &app,
            "listTeamMembers",
            &[],
            &[("memberType", "all"), ("limit", "100")],
            None,
        )
        .await;
    let users: Vec<&str> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|member| member["userId"].as_str())
        .collect();
    assert!(users.contains(&OTHER), "guests are listed: {list}");
    contract
        .success(&app, "listTeamMembers", &[], &[], None)
        .await;

    check_profiles(&contract, &app).await;
    check_activity_and_notes(&contract, &app).await;

    contract.finish_only(TEAM_OPERATIONS);
}

/// A profile with every field set, one cleared, a teammate's with none, and
/// one that isn't there.
async fn check_profiles(contract: &Contract, app: &Router) {
    // The caller's profile, with every field the member screen shows.
    contract
        .success(
            app,
            "updateMemberProfile",
            &[("userId", USER)],
            &[],
            Some(&json!({
                "title": "Engineer",
                "bio": "Writes the apps.",
                "phone": "+31 20 123 4567",
                "location": "Amsterdam",
                "pronouns": "she/her",
                "hoursPerWeek": 32.5,
                "links": [{ "label": "Site", "url": "https://example.test" }],
                "workingHours": {
                    "monday": {
                        "isOpen": true,
                        "openTime": "09:00",
                        "closeTime": "17:00",
                        "breaks": [{ "start": "12:00", "end": "12:30" }],
                    },
                    "sunday": { "isOpen": false },
                },
                "timezone": "Europe/Amsterdam",
            })),
        )
        .await;
    let own = contract
        .success(app, "getMemberProfile", &[("userId", USER)], &[], None)
        .await;
    assert_eq!(own["data"]["canEdit"], true, "{own}");
    // A text field cleared the way the apps clear it: an empty string.
    contract
        .success(
            app,
            "updateMemberProfile",
            &[("userId", USER)],
            &[],
            Some(&json!({ "pronouns": "" })),
        )
        .await;
    contract
        .success(app, "getMemberProfile", &[("userId", OTHER)], &[], None)
        .await;
    let gone = contract
        .failure(
            app,
            "getMemberProfile",
            &[("userId", "user_openapi_contract_chat_gone")],
            None,
        )
        .await;
    assert_eq!(gone.status, 404);
}

/// What two people share, a teammate's activity, and the caller's note about
/// them before and after it was written.
async fn check_activity_and_notes(contract: &Contract, app: &Router) {
    contract
        .success(app, "getMemberCommon", &[("userId", OTHER)], &[], None)
        .await;
    let activity = contract
        .success(
            app,
            "listMemberActivity",
            &[("userId", OTHER)],
            &[("limit", "50")],
            None,
        )
        .await;
    assert!(
        activity["data"]
            .as_array()
            .is_some_and(|items| !items.is_empty()),
        "{activity}"
    );

    let missing = contract
        .success(app, "getMemberNote", &[("userId", OTHER)], &[], None)
        .await;
    assert!(missing["data"].is_null(), "no note yet: {missing}");
    contract
        .success(
            app,
            "saveMemberNote",
            &[("userId", OTHER)],
            &[],
            Some(&json!({ "body": "Met at the offsite." })),
        )
        .await;
    let saved = contract
        .success(app, "getMemberNote", &[("userId", OTHER)], &[], None)
        .await;
    assert_eq!(saved["data"]["body"], "Met at the offsite.", "{saved}");
}
