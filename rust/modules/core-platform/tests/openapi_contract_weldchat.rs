//! The notifications as the native WeldChat apps read them (the Activity
//! tab and its badge, `apps/mobile-shared/openapi/weldchat.yaml`), through
//! `/api/notifications` as the server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). The file's chat operations are
//! checked in `modules/chat/tests/openapi_contract.rs`, its team members in
//! `modules/core-team/tests/openapi_contract_weldchat.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early.
//! The test's notifications belong to a user of its own, replaced at its
//! start.

use std::sync::Arc;

use axum::Router;
use weldsuite_auth::AuthContext;
use weldsuite_core_platform::{
    AuditStreamGateway, AuditStreamTest, AuditStreamTestResult, CorePlatformState,
};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::BoxFuture;

const USER: &str = "user_openapi_contract_chat_notify";

/// A mention from a teammate (unread, with an actor whose name the list
/// adds), a DM notification already read without a body, and a system
/// notification without an action.
const FIXTURES: &str = "
delete from notifications where user_id = 'user_openapi_contract_chat_notify';
delete from workspace_members where id = 'wm_contract_chat_notify_b';
insert into workspace_members (id, user_id, email, name, role, status, member_type) values
    ('wm_contract_chat_notify_b', 'user_openapi_contract_chat_notify_b', null, 'Bob Notify', 'MEMBER', 'ACTIVE', 'INTERNAL');
insert into notifications (id, user_id, title, body, category, notification_type, action_url, entity_type, entity_id, actor_type, actor_id, is_read, created_at) values
    ('ntf_contract_chat_a', 'user_openapi_contract_chat_notify', 'Bob mentioned you', 'Hey <@user_openapi_contract_chat_notify>, a look?', 'weldchat', 'chat_mention', '/weldchat/ch_contract?messageId=msg_contract', 'chat_message', 'msg_contract', 'user', 'user_openapi_contract_chat_notify_b', false, now() - interval '1 minute'),
    ('ntf_contract_chat_b', 'user_openapi_contract_chat_notify', 'New message from Bob', null, 'weldchat', 'chat_dm', '/weldchat/dm/ch_contract_dm', 'chat_channel', 'ch_contract_dm', null, null, true, now() - interval '2 days'),
    ('ntf_contract_chat_c', 'user_openapi_contract_chat_notify', 'Your export is ready', 'Download it from Settings.', 'system', 'custom', null, null, null, 'system', null, false, now() - interval '40 days');
";

/// The operations of weldchat.yaml this file checks.
const NOTIFICATION_OPERATIONS: &[&str] = &[
    "listNotifications",
    "getUnreadNotificationCount",
    "markNotificationRead",
    "markAllNotificationsRead",
];

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

struct NoAudit;

impl AuditStreamGateway for NoAudit {
    fn check_url(&self, raw: &str) -> Result<String, String> {
        Ok(raw.to_owned())
    }

    fn send_test<'a>(&'a self, _test: AuditStreamTest<'a>) -> BoxFuture<'a, AuditStreamTestResult> {
        unreachable!("not used by notifications")
    }
}

/// `/api/notifications` behind the session, tenant and permission layers,
/// for a workspace member (`general:read` and `general:update`).
fn app(tenant: &PgPool) -> Router {
    let state = CorePlatformState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        cache: None,
        master: tenant.clone(),
        identity: None,
        audit_streams: Arc::new(NoAudit),
        top_up: None,
        ai: None,
        mail: None,
        sso: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: vec!["general:read".to_owned(), "general:update".to_owned()],
        ..ResolvedPermissions::default()
    };
    let db = tenant.clone();
    Router::new()
        .nest(
            "/api/notifications",
            weldsuite_core_platform::notifications(state, &gate),
        )
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_openapi_contract_chat_notify".to_owned()),
                    session_id: "sess_openapi_contract_chat_notify".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract_chat_notify".to_owned(),
                    clerk_org_id: Some("org_openapi_contract_chat_notify".to_owned()),
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

/// Every notification operation of weldchat.yaml: the list (read and unread,
/// with and without an actor, a body, an action), the unread count, one
/// marked read, then all of them.
#[tokio::test]
async fn notifications_are_what_the_weldchat_apps_read() {
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
        .success(&app, "listNotifications", &[], &[("limit", "50")], None)
        .await;
    assert_eq!(
        list["data"].as_array().map(Vec::len),
        Some(3),
        "the test's own: {list}"
    );
    let page = contract
        .success(&app, "listNotifications", &[], &[("limit", "1")], None)
        .await;
    assert_eq!(page["pagination"]["hasMore"], true, "{page}");

    let unread = contract
        .success(&app, "getUnreadNotificationCount", &[], &[], None)
        .await;
    assert_eq!(unread["data"]["count"], 2, "{unread}");

    contract
        .success(
            &app,
            "markNotificationRead",
            &[("notificationId", "ntf_contract_chat_a")],
            &[],
            None,
        )
        .await;
    let missing = contract
        .failure(
            &app,
            "markNotificationRead",
            &[("notificationId", "ntf_contract_chat_missing")],
            None,
        )
        .await;
    assert_eq!(missing.status, 404);

    let all = contract
        .success(&app, "markAllNotificationsRead", &[], &[], None)
        .await;
    assert_eq!(all["data"]["updated"], 1, "{all}");
    let none = contract
        .success(&app, "getUnreadNotificationCount", &[], &[], None)
        .await;
    assert_eq!(none["data"]["count"], 0, "{none}");

    contract.finish_only(NOTIFICATION_OPERATIONS);
}
