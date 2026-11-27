//! What the native WeldDesk apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/welddesk.yaml`): the inbox
//! operations, sent as the file describes them through the router as the
//! server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! `listTeamMembers`, the file's other operation, is checked in
//! `modules/core-team/tests/openapi_contract_welddesk.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test has its own conversations, replaced at its start.

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_desk::DeskState;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const WORKSPACE: &str = "org_openapi_contract_desk";
const USER: &str = "user_openapi_contract_desk";

/// An open chat waiting for an answer, with every kind of timeline entry.
const OPEN: &str = "dconv_contract_open";
/// A closed support email, assigned.
const CLOSED: &str = "dconv_contract_closed";

/// Two conversations, numbered far above anything else in the test
/// database, and a timeline that gives each nullable field of a message
/// more than one value: a visitor's message with an image, an agent's
/// reply without attachments, a note, and closed / assigned / rated events.
const FIXTURES: &str = "
delete from desk_messages where conversation_id in ('dconv_contract_open', 'dconv_contract_closed');
delete from desk_conversations where id in ('dconv_contract_open', 'dconv_contract_closed');
insert into desk_conversations
    (id, conversation_number, title, state, channel, visitor_id, name, email, assignee_id,
     waiting_since, last_message_at, last_message_preview)
values
    ('dconv_contract_open', 990001, 'Order question', 'open', 'messenger', 'vis_contract',
     'Ann Visitor', null, null, now(), now(), 'Where is my order?'),
    ('dconv_contract_closed', 990002, null, 'closed', 'email', null,
     null, 'customer@example.test', 'user_openapi_contract_desk', null, null, null);
insert into desk_messages (id, created_at, conversation_id, kind, body, author_type, author_id, attachments, metadata)
values
    ('dmsg_contract_1', now() - interval '5 minutes', 'dconv_contract_open', 'message',
     'Where is my order?', 'visitor', 'vis_contract',
     '[{\"name\": \"photo.png\", \"url\": \"https://files.example.test/photo.png\", \"contentType\": \"image/png\", \"filesize\": 2048, \"width\": 640, \"height\": 480}]'::jsonb,
     null),
    ('dmsg_contract_2', now() - interval '4 minutes', 'dconv_contract_open', 'message',
     'Let me check.', 'agent', 'user_openapi_contract_desk', null, null),
    ('dmsg_contract_3', now() - interval '3 minutes', 'dconv_contract_open', 'note',
     'VIP customer', 'agent', 'user_openapi_contract_desk', null, null),
    ('dmsg_contract_4', now() - interval '2 minutes', 'dconv_contract_open', 'event',
     null, 'agent', 'user_openapi_contract_desk', null,
     '{\"eventType\": \"assigned\", \"assigneeId\": \"user_openapi_contract_desk\"}'::jsonb),
    ('dmsg_contract_5', now() - interval '1 minute', 'dconv_contract_open', 'event',
     null, 'system', null, null,
     '{\"eventType\": \"rated\", \"rating\": 4, \"ratingComment\": null}'::jsonb),
    ('dmsg_contract_6', now() - interval '1 minute', 'dconv_contract_closed', 'event',
     null, 'agent', 'user_openapi_contract_desk', null,
     '{\"eventType\": \"closed\", \"assigneeId\": null}'::jsonb);
";

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

/// What the desk routes share, without the outside services: no realtime,
/// buckets, mail, workflow engine or push.
fn state() -> DeskState {
    DeskState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        files: None,
        cache: None,
        mail: None,
        workflow: Arc::new(weldsuite_desk_domain::workflow::Unavailable),
        http: None,
        push_http: None,
        outbound: OutboundBindings::default(),
        master: None,
        assignment: None,
        ai: None,
    }
}

/// `/api` with desk-api's routes behind the session, tenant and permission
/// layers, for an agent who may read and update conversations.
fn app(db: PgPool) -> Router {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [perm::CONVERSATIONS_READ, perm::CONVERSATIONS_UPDATE]
            .map(str::to_owned)
            .to_vec(),
        ..ResolvedPermissions::default()
    };
    Router::new()
        .nest("/api", weldsuite_desk::router(state(), &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(WORKSPACE.to_owned()),
                    session_id: "sess_openapi_contract_desk".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_contract_desk".to_owned(),
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

fn ids(list: &Value) -> Vec<&str> {
    list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|conversation| conversation["id"].as_str())
        .collect()
}

/// Every inbox operation of welddesk.yaml, as the apps call them: the list
/// with each filter the inbox offers and a second page, the thread, a reply
/// and a note, and every way an agent manages a conversation.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn the_inbox_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    sqlx::raw_sql(FIXTURES)
        .execute(&db)
        .await
        .expect("fixtures");
    let app = app(db);
    let contract = Contract::load("welddesk");

    // The inbox: everything, open by waiting time (one per page, so there is
    // a cursor), closed and mine, unassigned, a search, and the next page.
    let all = contract
        .success(&app, "listDeskConversations", &[], &[], None)
        .await;
    assert!(ids(&all).contains(&OPEN), "{all}");
    let first = contract
        .success(
            &app,
            "listDeskConversations",
            &[],
            &[("state", "open"), ("sort", "waiting_longest"), ("limit", "1")],
            None,
        )
        .await;
    assert_eq!(first["pagination"]["hasMore"], true, "{first}");
    let cursor = first["pagination"]["cursor"]
        .as_str()
        .expect("a cursor")
        .to_owned();
    contract
        .success(
            &app,
            "listDeskConversations",
            &[],
            &[("state", "open"), ("sort", "waiting_longest"), ("limit", "1"), ("cursor", &cursor)],
            None,
        )
        .await;
    let mine = contract
        .success(
            &app,
            "listDeskConversations",
            &[],
            &[("state", "closed"), ("assigneeId", USER), ("sort", "oldest")],
            None,
        )
        .await;
    assert_eq!(ids(&mine), vec![CLOSED], "{mine}");
    let unassigned = contract
        .success(
            &app,
            "listDeskConversations",
            &[],
            &[("state", "open"), ("unassigned", "true"), ("q", "990001"), ("sort", "newest")],
            None,
        )
        .await;
    assert_eq!(ids(&unassigned), vec![OPEN], "{unassigned}");

    // The thread.
    let thread = contract
        .success(
            &app,
            "getDeskConversation",
            &[("id", OPEN)],
            &[("include", "messages")],
            None,
        )
        .await;
    assert_eq!(
        thread["data"]["messages"].as_array().map(Vec::len),
        Some(5),
        "{thread}"
    );
    contract
        .success(
            &app,
            "getDeskConversation",
            &[("id", CLOSED)],
            &[("include", "messages")],
            None,
        )
        .await;

    // A reply and a note.
    let reply = contract
        .success(
            &app,
            "replyToDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "kind": "message", "body": "It ships today." })),
        )
        .await;
    assert_eq!(reply["data"]["message"]["kind"], "message", "{reply}");
    contract
        .success(
            &app,
            "replyToDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "kind": "note", "body": "Told them it ships today." })),
        )
        .await;
    // Neither a body nor an attachment: refused, as an error the apps decode.
    contract
        .failure(
            &app,
            "replyToDeskConversation",
            &[("id", OPEN)],
            Some(&json!({ "kind": "message", "body": "  " })),
        )
        .await;

    // Assign to me, unassign, close and reopen.
    let assigned = contract
        .success(
            &app,
            "manageDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "action": "assign", "assigneeId": USER })),
        )
        .await;
    assert_eq!(assigned["data"]["conversation"]["assigneeId"], USER, "{assigned}");
    let unassigned = contract
        .success(
            &app,
            "manageDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "action": "assign" })),
        )
        .await;
    assert_eq!(
        unassigned["data"]["conversation"]["assigneeId"],
        Value::Null,
        "{unassigned}"
    );
    let closed = contract
        .success(
            &app,
            "manageDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "action": "close" })),
        )
        .await;
    assert_eq!(closed["data"]["conversation"]["state"], "closed", "{closed}");
    contract
        .success(
            &app,
            "manageDeskConversation",
            &[("id", OPEN)],
            &[],
            Some(&json!({ "action": "open" })),
        )
        .await;
    contract
        .failure(
            &app,
            "manageDeskConversation",
            &[("id", "dconv_contract_missing")],
            Some(&json!({ "action": "close" })),
        )
        .await;

    contract.finish_only(&[
        "listDeskConversations",
        "getDeskConversation",
        "replyToDeskConversation",
        "manageDeskConversation",
    ]);
}
