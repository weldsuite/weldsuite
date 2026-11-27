//! What the native WeldChat apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/weldchat.yaml`): every
//! chat operation in it, sent as the file describes it through the routers
//! at the prefixes the server mounts them on, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! The file's team-member and notification operations are checked in
//! `modules/core-team/tests/openapi_contract_weldchat.rs` and
//! `modules/core-platform/tests/openapi_contract_weldchat.rs`.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test has its own members, channels and record, cleaned at its start.
//! Calls run on a fake video provider; the ring token is signed with the
//! test's own `CALL_RING_SECRET`.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use weldsuite_auth::AuthContext;
use weldsuite_chat::ChatState;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::{Contract, Endpoint};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::BoxFuture;
use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, RoomParticipant, VideoError,
};

/// `chat_*.workspace_id` and the session's org.
const ORG: &str = "org_openapi_contract_chat";
const WORKSPACE: &str = "ws_openapi_contract_chat";
/// The caller, and the person they talk to.
const USER: &str = "user_openapi_contract_chat";
const OTHER: &str = "user_openapi_contract_chat_b";
/// The record the record-chat operations follow (a domain: any live one is
/// visible with `domains:read`, and it has a detail).
const DOMAIN: &str = "dom_openapi_contract_chat";
const RING_SECRET: &str = "openapi-contract-ring-secret";

/// The caller with a name and an email, the other person with neither an
/// email nor a picture; the domain; the caller's chosen status.
const FIXTURES: &str = "
delete from workspace_members where id in ('wm_contract_chat_a', 'wm_contract_chat_b');
insert into workspace_members (id, user_id, email, name, role, status, member_type) values
    ('wm_contract_chat_a', 'user_openapi_contract_chat', 'ann@example.test', 'Ann Contract', 'OWNER', 'ACTIVE', 'INTERNAL'),
    ('wm_contract_chat_b', 'user_openapi_contract_chat_b', null, 'Bob Contract', 'MEMBER', 'ACTIVE', 'INTERNAL');
delete from domains where id = 'dom_openapi_contract_chat';
insert into domains (id, name, tld, full_domain) values
    ('dom_openapi_contract_chat', 'openapi-contract-chat', 'test', 'openapi-contract-chat.test');
delete from chat_user_status where user_id in ('user_openapi_contract_chat', 'user_openapi_contract_chat_b');
insert into chat_user_status (id, user_id, status, status_text, status_emoji, updated_at) values
    ('cus_contract_chat', 'user_openapi_contract_chat', 'busy', 'In a meeting', '📅', now());
delete from chat_sections where name like 'Contract chat %';
delete from chat_bookmarks where user_id in ('user_openapi_contract_chat', 'user_openapi_contract_chat_b');
delete from chat_drafts where user_id in ('user_openapi_contract_chat', 'user_openapi_contract_chat_b');
delete from notifications where user_id in ('user_openapi_contract_chat', 'user_openapi_contract_chat_b');
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

/// A video provider that hands out tokens and has nobody connected.
struct FakeRooms {
    next: AtomicU32,
}

impl FakeRooms {
    fn id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", self.next.fetch_add(1, Ordering::Relaxed))
    }
}

impl DynVideoRooms for FakeRooms {
    fn create_room<'a>(&'a self, _title: &'a str) -> BoxFuture<'a, Result<String, VideoError>> {
        let room = self.id("room_contract");
        Box::pin(async move { Ok(room) })
    }

    fn add_participant<'a>(
        &'a self,
        _room_id: &'a str,
        _participant: &'a NewParticipant,
    ) -> BoxFuture<'a, Result<JoinToken, VideoError>> {
        let token = JoinToken {
            participant_id: self.id("participant_contract"),
            token: "livekit-join-token".to_owned(),
        };
        Box::pin(async move { Ok(token) })
    }

    fn remove_participant<'a>(
        &'a self,
        _room_id: &'a str,
        _participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async { Ok(()) })
    }

    fn list_participants<'a>(
        &'a self,
        _room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RoomParticipant>, VideoError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn live_participant_count<'a>(
        &'a self,
        _room_id: &'a str,
    ) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async { Ok(0) })
    }

    fn kick_participants<'a>(
        &'a self,
        _room_id: &'a str,
        _participant_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async { Ok(()) })
    }

    fn kick_all<'a>(&'a self, _room_id: &'a str) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async { Ok(0) })
    }

    fn end_room<'a>(&'a self, _room_id: &'a str) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async { Ok(()) })
    }
}

fn state() -> ChatState {
    ChatState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        cache: None,
        files: None,
        jobs: None,
        unpin_jobs: false,
        http: None,
        presence: None,
        env: Arc::new(HashMap::from([(
            "CALL_RING_SECRET".to_owned(),
            RING_SECRET.to_owned(),
        )])),
        video: Some(Arc::new(FakeRooms {
            next: AtomicU32::new(1),
        })),
        leave_meetings: None,
        ring_jobs: false,
        tenants: None,
    }
}

/// The chat routers at their `/api` prefixes (and the ring decline at
/// `/public/chat-calls`) behind the session, tenant and permission layers,
/// for a workspace owner.
fn app(db: PgPool) -> Router {
    let state = state();
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: vec!["*".to_owned()],
        role: "OWNER".to_owned(),
        is_owner: true,
        ..ResolvedPermissions::default()
    };
    Router::new()
        .nest(
            "/api/channels",
            weldsuite_chat::channels(state.clone(), &gate),
        )
        .nest(
            "/api/channel-members",
            weldsuite_chat::channel_members(state.clone(), &gate),
        )
        .nest(
            "/api/chat-messages",
            weldsuite_chat::messages(state.clone(), &gate),
        )
        .nest("/api/chat-dm", weldsuite_chat::dm(state.clone(), &gate))
        .nest(
            "/api/chat-sections",
            weldsuite_chat::sections(state.clone(), &gate),
        )
        .nest(
            "/api/chat-search",
            weldsuite_chat::search(state.clone(), &gate),
        )
        .nest(
            "/api/chat-drafts",
            weldsuite_chat::drafts(state.clone(), &gate),
        )
        .nest(
            "/api/chat-bookmarks",
            weldsuite_chat::bookmarks(state.clone(), &gate),
        )
        .nest(
            "/api/chat-status",
            weldsuite_chat::status(state.clone(), &gate),
        )
        .nest(
            "/api/chat-entity-channels",
            weldsuite_chat::record_chats(state.clone(), &gate),
        )
        .nest(
            "/api/chat-calls",
            weldsuite_chat::calls(state.clone(), &gate),
        )
        // In the server the decline is ahead of the session and finds the
        // tenant by the token's workspace; here the test's tenant rides on
        // the request, as conformance builds do.
        .nest("/public/chat-calls", weldsuite_chat::public_calls(state))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_openapi_contract_chat".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: WORKSPACE.to_owned(),
                    clerk_org_id: Some(ORG.to_owned()),
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

/// Drop what an earlier run left: the channels the test's people made, their
/// DMs and the domain's record chat, with everything in them; then the
/// fixtures.
async fn clean(db: &PgPool) {
    let users = vec![USER.to_owned(), OTHER.to_owned()];
    let channels: Vec<String> = sqlx::query_scalar(
        "select id from chat_channels where created_by = any($1) or entity_id = $2 \
         or (type = 'dm' and id in (select channel_id from chat_channel_members where user_id = any($1)))",
    )
    .bind(&users)
    .bind(DOMAIN)
    .fetch_all(db)
    .await
    .expect("the test's channels");
    for table in [
        "chat_message_reads",
        "chat_reminders",
        "chat_channel_role_links",
        "chat_bookmarks",
        "chat_drafts",
        "chat_calls",
        "chat_messages",
        "chat_channel_members",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "delete from {table} where channel_id = any($1)"
        )))
        .bind(&channels)
        .execute(db)
        .await
        .unwrap_or_else(|error| panic!("clean {table}: {error}"));
    }
    sqlx::query("delete from chat_channels where id = any($1)")
        .bind(&channels)
        .execute(db)
        .await
        .expect("clean chat_channels");
    sqlx::raw_sql(FIXTURES).execute(db).await.expect("fixtures");
}

fn now_ms() -> i64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after 1970");
    i64::try_from(since.as_millis()).expect("milliseconds fit")
}

/// A ring token as the server signs it for the person rung
/// (`signCallRingToken`): `<base64url(claims)>.<base64url(HMAC-SHA256)>`.
fn ring_token(user: &str, call: &str) -> String {
    let claims = format!(
        "{{\"o\":{},\"u\":{},\"c\":{},\"e\":{}}}",
        json!(ORG),
        json!(user),
        json!(call),
        now_ms() + 120_000
    );
    let body = URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let mut mac = Hmac::<Sha256>::new_from_slice(RING_SECRET.as_bytes()).expect("a key");
    mac.update(body.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{body}.{signature}")
}

/// A DM call ringing for the caller, started by the other person.
async fn ringing_call(db: &PgPool, id: &str, channel: &str) {
    let participants = json!([{
        "userId": OTHER,
        "userName": "Bob Contract",
        "joinedAt": "2026-11-27T09:00:00.000Z",
        "cfSessionId": "participant_ringing",
        "hasAudio": false,
        "hasVideo": false,
        "hasScreenShare": false,
    }]);
    sqlx::query(
        "insert into chat_calls (id, channel_id, call_type, status, cf_app_id, initiator_id, \
         initiator_name, participants, max_participants, created_at, updated_at) \
         values ($1, $2, 'voice', 'ringing', 'room_contract_ringing', $3, 'Bob Contract', $4, 1, \
         (now() at time zone 'utc'), (now() at time zone 'utc'))",
    )
    .bind(id)
    .bind(channel)
    .bind(OTHER)
    .bind(participants)
    .execute(db)
    .await
    .expect("a ringing call");
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// Every chat operation of weldchat.yaml, with data that gives nullable
/// fields more than one value where it is cheap: a public and a private
/// channel, a DM, messages with an attachment, a reply, a thread reply and
/// reactions, a record chat, a channel call and DM calls.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn weldchat_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    clean(&db).await;
    let app = app(db.clone());
    let contract = Contract::load("weldchat");

    // Sections and channels.
    let section = id(&contract
        .success(
            &app,
            "createSection",
            &[],
            &[],
            Some(&json!({ "name": "Contract chat section" })),
        )
        .await);
    contract
        .success(&app, "listSections", &[], &[("limit", "100")], None)
        .await;

    let public = id(&contract
        .success(
            &app,
            "createChannel",
            &[],
            &[],
            Some(&json!({ "name": "contract-chat-general", "type": "public" })),
        )
        .await);
    let public = public.as_str();
    let private = id(&contract
        .success(
            &app,
            "createChannel",
            &[],
            &[],
            Some(&json!({
                "name": "contract-chat-private",
                "type": "private",
                "sectionId": section,
                "memberIds": [OTHER],
            })),
        )
        .await);
    let private = private.as_str();
    let doomed = id(&contract
        .success(
            &app,
            "createChannel",
            &[],
            &[],
            Some(&json!({ "name": "contract-chat-doomed", "type": "private" })),
        )
        .await);
    let duplicate = contract
        .failure(
            &app,
            "createChannel",
            &[],
            Some(&json!({ "name": "contract-chat-general", "type": "public" })),
        )
        .await;
    assert_eq!(duplicate.status, 409);

    contract
        .success(
            &app,
            "updateChannel",
            &[("channelId", private)],
            &[],
            Some(&json!({ "name": "contract-chat-renamed" })),
        )
        .await;
    contract
        .success(
            &app,
            "deleteChannel",
            &[("channelId", doomed.as_str())],
            &[],
            None,
        )
        .await;
    for types in ["public", "private"] {
        contract
            .success(
                &app,
                "listChannels",
                &[],
                &[("types", types), ("limit", "100")],
                None,
            )
            .await;
    }
    let first = contract
        .success(&app, "listChannels", &[], &[("limit", "1")], None)
        .await;
    if let Some(cursor) = first["pagination"]["cursor"].as_str() {
        contract
            .success(
                &app,
                "listChannels",
                &[],
                &[("limit", "1"), ("cursor", cursor)],
                None,
            )
            .await;
    }
    contract
        .success(&app, "getChannel", &[("channelId", public)], &[], None)
        .await;
    contract
        .success(
            &app,
            "listChannelMembers",
            &[("channelId", private)],
            &[],
            None,
        )
        .await;

    // A channel the caller is a plain member of, to leave.
    let leaving = id(&contract
        .success(
            &app,
            "createChannel",
            &[],
            &[],
            Some(&json!({ "name": "contract-chat-leaving", "type": "private" })),
        )
        .await);
    let leaving = leaving.as_str();
    let added = contract
        .success(
            &app,
            "addChannelMembers",
            &[("channelId", leaving)],
            &[],
            Some(&json!({ "userIds": [OTHER] })),
        )
        .await;
    assert_eq!(added["data"]["addedCount"], 1, "{added}");
    sqlx::query(
        "update chat_channel_members set role = case when user_id = $2 then 'owner' else 'member' end \
         where channel_id = $1",
    )
    .bind(leaving)
    .bind(OTHER)
    .execute(&db)
    .await
    .expect("hand the channel over");
    contract
        .success(&app, "leaveChannel", &[("channelId", leaving)], &[], None)
        .await;
    let owner = contract
        .failure(&app, "leaveChannel", &[("channelId", public)], None)
        .await;
    assert_eq!(owner.status, 400);

    // The caller's own membership row: mute and the notification level.
    let memberships = contract
        .success(
            &app,
            "listChannelMemberships",
            &[],
            &[("channelId", public), ("userId", USER)],
            None,
        )
        .await;
    let membership = memberships["data"][0]["id"]
        .as_str()
        .expect("the caller's row")
        .to_owned();
    contract
        .success(
            &app,
            "updateChannelMembership",
            &[("membershipId", membership.as_str())],
            &[],
            Some(&json!({ "isMuted": true, "notificationPreference": "mentions" })),
        )
        .await;
    contract
        .success(
            &app,
            "listChannelMemberships",
            &[],
            &[("channelId", public)],
            None,
        )
        .await;

    // Messages: plain, with a file, an inline reply, a thread reply.
    let hello = id(&contract
        .success(
            &app,
            "createMessage",
            &[],
            &[],
            Some(&json!({ "channelId": public, "body": "Hello contract" })),
        )
        .await);
    let hello = hello.as_str();
    let with_file = id(&contract
        .success(
            &app,
            "createMessage",
            &[],
            &[],
            Some(&json!({
                "channelId": public,
                "body": "",
                "attachments": [{
                    "id": "chatfile_contract",
                    "fileName": "voice.m4a",
                    "fileSize": 48213,
                    "mimeType": "audio/mp4",
                    "url": "https://files.example.test/chat/voice.m4a",
                }],
            })),
        )
        .await);
    contract
        .success(
            &app,
            "createMessage",
            &[],
            &[],
            Some(&json!({
                "channelId": public,
                "body": "A contract reply",
                "replyToId": hello,
                "replyMention": false,
            })),
        )
        .await;
    let thread_reply = id(&contract
        .success(
            &app,
            "createMessage",
            &[],
            &[],
            Some(&json!({ "channelId": public, "body": "In the thread", "parentId": hello })),
        )
        .await);
    contract
        .success(
            &app,
            "updateMessage",
            &[("messageId", hello)],
            &[],
            Some(&json!({ "content": "Hello again, contract" })),
        )
        .await;
    for emoji in ["👍", "thumbsup"] {
        contract
            .success(
                &app,
                "addReaction",
                &[("messageId", hello)],
                &[],
                Some(&json!({ "emoji": emoji })),
            )
            .await;
    }
    contract
        .success(
            &app,
            "removeReaction",
            &[("messageId", hello), ("emoji", "thumbsup")],
            &[],
            None,
        )
        .await;
    let invalid = contract
        .failure(
            &app,
            "addReaction",
            &[("messageId", hello)],
            Some(&json!({})),
        )
        .await;
    assert_eq!(invalid.status, 400);

    contract
        .success(
            &app,
            "pinMessage",
            &[("messageId", hello)],
            &[],
            Some(&json!({ "expiresAt": "2099-01-01T00:00:00.000Z", "notify": true })),
        )
        .await;
    contract
        .success(
            &app,
            "pinMessage",
            &[("messageId", with_file.as_str())],
            &[],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "unpinMessage",
            &[("messageId", with_file.as_str())],
            &[],
            None,
        )
        .await;

    let page = contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("channelId", public), ("limit", "2")],
            None,
        )
        .await;
    let cursor = page["pagination"]["cursor"]
        .as_str()
        .expect("more than one page")
        .to_owned();
    contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("channelId", public), ("cursor", cursor.as_str())],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "listMessages",
            &[],
            &[("channelId", public), ("parentId", hello)],
            None,
        )
        .await;
    contract
        .success(&app, "getMessage", &[("messageId", hello)], &[], None)
        .await;
    contract
        .success(
            &app,
            "getMessage",
            &[("messageId", with_file.as_str())],
            &[],
            None,
        )
        .await;
    let missing = contract
        .failure(
            &app,
            "getMessage",
            &[("messageId", "msg_missing_contract")],
            None,
        )
        .await;
    assert_eq!(missing.status, 404);
    assert!(
        missing
            .body
            .is_some_and(|body| body["error"]["code"].is_string())
    );
    contract
        .success(
            &app,
            "deleteMessage",
            &[("messageId", thread_reply.as_str())],
            &[],
            None,
        )
        .await;
    contract
        .success(&app, "markChannelRead", &[("channelId", public)], &[], None)
        .await;

    contract
        .success(
            &app,
            "searchMessages",
            &[],
            &[("q", "contract"), ("limit", "50")],
            None,
        )
        .await;

    // Drafts: an empty one removes the channel's, a full one is saved.
    contract
        .success(
            &app,
            "createDraft",
            &[],
            &[],
            Some(&json!({ "workspaceId": ORG, "channelId": public, "content": "" })),
        )
        .await;
    let draft = id(&contract
        .success(
            &app,
            "createDraft",
            &[],
            &[],
            Some(&json!({ "workspaceId": ORG, "channelId": public, "content": "Half a thought" })),
        )
        .await);
    contract
        .success(
            &app,
            "updateDraft",
            &[("draftId", draft.as_str())],
            &[],
            Some(&json!({ "content": "A whole thought" })),
        )
        .await;
    contract.success(&app, "listDrafts", &[], &[], None).await;
    contract
        .success(&app, "listDrafts", &[], &[("channelId", public)], None)
        .await;
    contract
        .success(
            &app,
            "deleteDraft",
            &[("draftId", draft.as_str())],
            &[],
            None,
        )
        .await;

    // Saved messages: saved once, the second save says so.
    let saved = json!({ "messageId": hello, "channelId": public });
    let bookmark = id(&contract
        .success(&app, "createBookmark", &[], &[], Some(&saved))
        .await);
    let again = contract
        .success(&app, "createBookmark", &[], &[], Some(&saved))
        .await;
    assert_eq!(again["data"]["alreadyExists"], true, "{again}");
    contract
        .success(&app, "listBookmarks", &[], &[("limit", "50")], None)
        .await;
    contract
        .success(
            &app,
            "deleteBookmark",
            &[("bookmarkId", bookmark.as_str())],
            &[],
            None,
        )
        .await;

    contract
        .success(&app, "listMemberStatuses", &[], &[], None)
        .await;

    // A DM: made, then found again.
    let dm = id(&contract
        .success(
            &app,
            "createDm",
            &[],
            &[],
            Some(&json!({ "userIds": [OTHER] })),
        )
        .await);
    let dm = dm.as_str();
    let found = contract
        .success(
            &app,
            "createDm",
            &[],
            &[],
            Some(&json!({ "userIds": [OTHER] })),
        )
        .await;
    assert_eq!(found["data"]["id"], dm, "{found}");
    contract
        .success(
            &app,
            "createMessage",
            &[],
            &[],
            Some(&json!({ "channelId": dm, "body": "Hi Bob, about the contract" })),
        )
        .await;
    contract
        .success(
            &app,
            "pinDm",
            &[("channelId", dm)],
            &[],
            Some(&json!({ "isPinned": true })),
        )
        .await;
    contract
        .success(&app, "archiveDm", &[("channelId", dm)], &[], None)
        .await;
    contract.success(&app, "listDms", &[], &[], None).await;
    contract
        .success(&app, "unarchiveDm", &[("channelId", dm)], &[], None)
        .await;
    contract.success(&app, "listDms", &[], &[], None).await;

    // A record chat: followed (and so made), listed, its record's detail.
    let followed = contract
        .success(
            &app,
            "followRecordChat",
            &[("entityType", "domain"), ("entityId", DOMAIN)],
            &[],
            None,
        )
        .await;
    assert_eq!(followed["data"]["following"], true, "{followed}");
    contract
        .success(&app, "listRecordChats", &[], &[], None)
        .await;
    for filter in ["unread", "mentions", "all"] {
        contract
            .success(
                &app,
                "listRecordChats",
                &[],
                &[("type", "domain"), ("filter", filter), ("limit", "25")],
                None,
            )
            .await;
    }
    contract
        .success(
            &app,
            "listRecordChats",
            &[],
            &[("filter", "all"), ("search", "contract")],
            None,
        )
        .await;
    contract
        .success(&app, "getRecordChatSummary", &[], &[], None)
        .await;
    contract
        .success(
            &app,
            "getRecordDetail",
            &[("entityType", "domain"), ("entityId", DOMAIN)],
            &[],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "unfollowRecordChat",
            &[("entityType", "domain"), ("entityId", DOMAIN)],
            &[],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "listRecordChats",
            &[],
            &[("type", "domain"), ("filter", "all")],
            None,
        )
        .await;

    // Calls: a channel call started, started again (joined), read, joined,
    // left; a DM call; a ring declined in the app and one from the phone's
    // call screen with its ring token.
    contract
        .success(
            &app,
            "getActiveCallInChannel",
            &[("channelId", private)],
            &[],
            None,
        )
        .await;
    let start = json!({ "channelId": public, "callType": "video" });
    let started = contract
        .success(&app, "startAndJoinCall", &[], &[], Some(&start))
        .await;
    let call = started["data"]["callId"]
        .as_str()
        .expect("a call id")
        .to_owned();
    let call = call.as_str();
    contract
        .success(&app, "startAndJoinCall", &[], &[], Some(&start))
        .await;
    contract
        .success(
            &app,
            "getActiveCallInChannel",
            &[("channelId", public)],
            &[],
            None,
        )
        .await;
    contract
        .success(&app, "getCall", &[("callId", call)], &[], None)
        .await;
    contract
        .success(&app, "joinCall", &[("callId", call)], &[], None)
        .await;
    contract
        .success(&app, "listActiveCalls", &[], &[], None)
        .await;
    contract
        .success(&app, "leaveCall", &[("callId", call)], &[], None)
        .await;

    let dm_call = contract
        .success(
            &app,
            "startAndJoinCall",
            &[],
            &[],
            Some(&json!({ "channelId": dm, "callType": "voice" })),
        )
        .await;
    let dm_call = dm_call["data"]["callId"]
        .as_str()
        .expect("a call id")
        .to_owned();
    contract
        .success(
            &app,
            "leaveCall",
            &[("callId", dm_call.as_str())],
            &[],
            None,
        )
        .await;

    ringing_call(&db, "call_contract_ring_app", dm).await;
    contract
        .success(
            &app,
            "declineCall",
            &[("callId", "call_contract_ring_app")],
            &[],
            None,
        )
        .await;
    let not_ringing = contract
        .failure(
            &app,
            "declineCall",
            &[("callId", "call_contract_ring_app")],
            None,
        )
        .await;
    assert_eq!(not_ringing.status, 400);

    ringing_call(&db, "call_contract_ring_phone", dm).await;
    let declined = contract
        .success(
            &app,
            "declineRing",
            &[],
            &[],
            Some(&json!({ "token": ring_token(USER, "call_contract_ring_phone") })),
        )
        .await;
    assert_eq!(declined["data"]["declined"], true, "{declined}");
    let forged = contract
        .failure(
            &app,
            "declineRing",
            &[],
            Some(&json!({ "token": "e30.bm90LWEtc2lnbmF0dXJl" })),
        )
        .await;
    assert_eq!(forged.status, 401);

    let history = contract
        .success(&app, "listCallHistory", &[], &[("limit", "2")], None)
        .await;
    if let Some(cursor) = history["pagination"]["cursor"].as_str() {
        contract
            .success(
                &app,
                "listCallHistory",
                &[],
                &[("limit", "30"), ("cursor", cursor)],
                None,
            )
            .await;
    }

    // Last: the caller leaves the DM.
    contract
        .success(&app, "leaveDm", &[("channelId", dm)], &[], None)
        .await;

    // A route the apps don't call, to see the leave: the DM is gone from the list.
    let dms = contract
        .send(
            &app,
            &Endpoint {
                method: "GET".to_owned(),
                uri: "/api/chat-dm".to_owned(),
            },
            None,
        )
        .await;
    assert!(
        dms.body
            .as_ref()
            .and_then(|body| body["data"].as_array())
            .is_some_and(|list| list.iter().all(|row| row["id"] != dm)),
        "{dms:?}"
    );

    // Leave nothing behind: other crates' tests clear these tables whole, and a
    // read receipt left here would block their delete of `chat_messages`.
    clean(&db).await;
    contract.finish_only(CHAT_OPERATIONS);
}

/// The operations of weldchat.yaml this file checks: all but the team
/// members' and the notifications'.
const CHAT_OPERATIONS: &[&str] = &[
    "listChannels",
    "createChannel",
    "getChannel",
    "updateChannel",
    "deleteChannel",
    "listChannelMembers",
    "addChannelMembers",
    "leaveChannel",
    "markChannelRead",
    "listChannelMemberships",
    "updateChannelMembership",
    "listMessages",
    "createMessage",
    "getMessage",
    "updateMessage",
    "deleteMessage",
    "addReaction",
    "removeReaction",
    "pinMessage",
    "unpinMessage",
    "listDms",
    "createDm",
    "leaveDm",
    "archiveDm",
    "unarchiveDm",
    "pinDm",
    "listSections",
    "createSection",
    "searchMessages",
    "listDrafts",
    "createDraft",
    "updateDraft",
    "deleteDraft",
    "listBookmarks",
    "createBookmark",
    "deleteBookmark",
    "listMemberStatuses",
    "listRecordChats",
    "getRecordChatSummary",
    "followRecordChat",
    "unfollowRecordChat",
    "getRecordDetail",
    "listActiveCalls",
    "getActiveCallInChannel",
    "listCallHistory",
    "startAndJoinCall",
    "getCall",
    "joinCall",
    "leaveCall",
    "declineCall",
    "declineRing",
];
