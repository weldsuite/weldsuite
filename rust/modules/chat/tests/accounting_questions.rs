//! `/api/accounting-questions` as the server mounts it (the chat router, with
//! the gate and the session, tenant and permission layers of a request) against
//! the real tenant schema (`WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; each test returns early without it): asking,
//! the thread's replies, resolving and re-opening, the list's scope and the
//! bulk ask. Ids are fresh, so runs share the database.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::similar_names,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_chat::ChatState;
use weldsuite_db::{Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::generate_id;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

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

/// The permissions a member of the tests holds in the request (and, by their
/// `workspace_members` row, wherever the chat checks them for another member).
const BOOKS: &[&str] = &[
    "messages:create",
    "channels:read",
    "invoices:read",
    "bills:read",
    "banking:read",
    "reports:read",
];

struct World {
    db: PgPool,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
    state: ChatState,
}

impl World {
    fn new() -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        let db = master_pool(&url, 4).unwrap();
        let bus = Arc::new(RecordingEventBus::new());
        let tracker = TaskTracker::new();
        let state = ChatState {
            events: EntityEventPublisher::new(
                Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
                tracker.clone(),
            ),
            realtime: None,
            cache: None,
            files: None,
            jobs: None,
            unpin_jobs: false,
            http: None,
            presence: None,
            env: Arc::new(HashMap::new()),
            video: None,
            leave_meetings: None,
            ring_jobs: false,
            tenants: None,
        };
        Some(Self {
            db,
            bus,
            tracker,
            state,
        })
    }

    /// The questions router and the record chats' router, for `user`
    /// holding `permissions` in the request.
    fn app(&self, user: &str, permissions: &[&str]) -> Router {
        let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
        let resolved = ResolvedPermissions {
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            is_owner: permissions.contains(&"*"),
            ..ResolvedPermissions::default()
        };
        let db = self.db.clone();
        let user = user.to_owned();
        Router::new()
            .nest(
                "/api/accounting-questions",
                weldsuite_chat::accounting_questions(self.state.clone(), &gate),
            )
            .nest(
                "/api/chat-entity-channels",
                weldsuite_chat::record_chats(self.state.clone(), &gate),
            )
            .layer(axum::middleware::from_fn(
                move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                    request.extensions_mut().insert(AuthContext {
                        user_id: user.clone(),
                        org_id: Some("org_questions".to_owned()),
                        session_id: "sess_questions".to_owned(),
                        factor_verification_age: None,
                    });
                    request.extensions_mut().insert(Tenant {
                        workspace_id: "ws_questions_test".to_owned(),
                        clerk_org_id: Some("org_questions".to_owned()),
                        db: db.clone(),
                        suspended: false,
                        restrictions: WorkspaceRestrictions::default(),
                    });
                    request.extensions_mut().insert(Permissions::new(
                        resolved.clone(),
                        None,
                        false,
                        user.clone(),
                    ));
                    next.run(request)
                },
            ))
    }

    /// The `entityType.action` of what was published since the last call, with its data.
    async fn events(&self) -> Vec<(String, Value)> {
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                (
                    format!(
                        "{}.{}",
                        payload["entityType"].as_str().unwrap_or_default(),
                        payload["action"].as_str().unwrap_or_default()
                    ),
                    payload["data"].clone(),
                )
            })
            .collect();
        self.bus.clear();
        let _ = &self.tracker;
        events
    }
}

async fn call(app: &Router, method: &str, path: &str, body: Option<&Value>) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A GET in the legal entity `entity` names, by the header the platform sends.
async fn get_in(app: &Router, header: &str, entity: &str, path: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("GET")
        .uri(path)
        .header(header, entity)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn fresh(prefix: &str) -> String {
    generate_id(prefix)
}

async fn member(db: &PgPool, role: &str, permissions: &[&str]) -> String {
    let user = format!("aq_{}", fresh("u"));
    sqlx::query(
        "insert into workspace_members (id, user_id, name, role, permissions, status) \
         values ($1, $2, $3, $4, $5::text::jsonb, 'ACTIVE')",
    )
    .bind(fresh("wm"))
    .bind(&user)
    .bind(format!("Name of {user}"))
    .bind(role)
    .bind(json!(permissions).to_string())
    .execute(db)
    .await
    .unwrap();
    user
}

struct Books {
    entity: String,
    lines: Vec<String>,
    invoice: String,
}

async fn books(db: &PgPool, restricted: bool) -> Books {
    let entity = fresh("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active, access_restricted) \
         values ($1, 'Questions', 'NL', 'EUR', true, $2)",
    )
    .bind(&entity)
    .bind(restricted)
    .execute(db)
    .await
    .unwrap();
    // WeldBooks is enabled for it (its extension row): the list resolves only such entities.
    sqlx::query("insert into accounting_entity_settings (entity_id) values ($1)")
        .bind(&entity)
        .execute(db)
        .await
        .unwrap();
    let bank = fresh("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')",
    )
    .bind(&bank)
    .bind(&entity)
    .execute(db)
    .await
    .unwrap();
    let mut lines = Vec::new();
    for description in ["COFFEE", "TAXI", "LUNCH"] {
        let id = fresh("btx");
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
               counterparty_name, status) \
             values ($1, $2, $3, now(), '-12.00', $4, $4, 'unreconciled')",
        )
        .bind(&id)
        .bind(&entity)
        .bind(&bank)
        .bind(description)
        .execute(db)
        .await
        .unwrap();
        lines.push(id);
    }
    let invoice = fresh("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
           issue_date, due_date, currency, total, amount_paid, balance_due) \
         values ($1, $2, 'INV-Q-1', 'standard', 'sent', 'pty_none', 'Acme', now(), now(), 'EUR', 121, 0, 121)",
    )
    .bind(&invoice)
    .bind(&entity)
    .execute(db)
    .await
    .unwrap();
    Books {
        entity,
        lines,
        invoice,
    }
}

fn names(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(name, _)| name.as_str()).collect()
}

async fn followers(db: &PgPool, channel: &str) -> Vec<String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "select user_id from chat_channel_members where channel_id = $1 order by user_id",
    )
    .bind(channel)
    .fetch_all(db)
    .await
    .unwrap();
    rows.into_iter().map(|(user,)| user).collect()
}

#[tokio::test]
async fn asking_creates_the_chat_posts_the_question_and_makes_those_asked_follow_it() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let b = books(&world.db, false).await;
    let app = world.app(&owner, BOOKS);

    let (status, out) = call(
        &app,
        "POST",
        "/api/accounting-questions",
        Some(&json!({
            "recordType": "bank_transaction", "recordId": b.lines[0],
            "text": "What was this payment?", "askedTo": [accountant],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{out}");
    let q = &out["data"];
    assert_eq!(q["recordType"], "bank_transaction");
    assert_eq!(q["recordId"], json!(b.lines[0]));
    assert_eq!(q["recordTitle"], "COFFEE");
    assert_eq!(q["text"], "What was this payment?");
    assert_eq!(q["status"], "open");
    assert_eq!(q["askedBy"]["id"], json!(owner));
    assert_eq!(q["askedTo"][0]["id"], json!(accountant));
    assert_eq!(
        q["askedTo"][0]["name"],
        json!(format!("Name of {accountant}"))
    );
    assert_eq!(q["entityId"], json!(b.entity));
    assert_eq!(q["replyCount"], 0);
    assert_eq!(q["createdChannel"], true);
    assert!(q["id"].as_str().is_some_and(|id| id.starts_with("msg_")));
    assert_eq!(
        q["link"],
        json!(format!(
            "/weldbooks/banking/transactions?stack=bank_transaction:{}",
            b.lines[0]
        ))
    );

    // The chat is the record's, the question its first message with the state.
    let channel = q["channelId"].as_str().unwrap().to_owned();
    let (kind, entity_type, entity_id): (String, String, String) =
        sqlx::query_as("select type, entity_type, entity_id from chat_channels where id = $1")
            .bind(&channel)
            .fetch_one(&world.db)
            .await
            .unwrap();
    assert_eq!(
        (kind.as_str(), entity_type.as_str(), entity_id.as_str()),
        ("entity", "bank_transaction", b.lines[0].as_str())
    );
    let (metadata,): (Value,) = sqlx::query_as("select metadata from chat_messages where id = $1")
        .bind(q["id"].as_str().unwrap())
        .fetch_one(&world.db)
        .await
        .unwrap();
    assert_eq!(
        metadata,
        json!({ "question": { "status": "open", "askedTo": [accountant] } })
    );
    // Whoever asked and whoever is asked follow the chat (the owner is a manager too).
    let members = followers(&world.db, &channel).await;
    assert!(
        members.contains(&owner) && members.contains(&accountant),
        "{members:?}"
    );

    let events = world.events().await;
    let published = names(&events);
    for expected in [
        "chat_channel.created",
        "chat_message.created",
        "accounting_question.created",
    ] {
        assert!(published.contains(&expected), "{published:?}");
    }
    let created = &events
        .iter()
        .find(|(name, _)| name == "accounting_question.created")
        .unwrap()
        .1;
    assert_eq!(created["recordType"], "bank_transaction");
    assert_eq!(created["askedTo"], json!([accountant]));

    // A second question on the same record is another thread of the same chat.
    let (status, second) = call(
        &app,
        "POST",
        "/api/accounting-questions",
        Some(&json!({
            "recordType": "bank_transaction", "recordId": b.lines[0], "text": "And the VAT?",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(second["data"]["channelId"], json!(channel));
    assert_eq!(second["data"]["createdChannel"], false);
    assert_eq!(second["data"]["askedTo"], json!([]));
    let (count,): (i64,) = sqlx::query_as(
        "select count(*) from chat_channels where entity_type = 'bank_transaction' and entity_id = $1",
    )
    .bind(&b.lines[0])
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let events = world.events().await;
    assert!(!names(&events).contains(&"chat_channel.created"));
}

#[tokio::test]
async fn asking_is_refused_for_what_the_caller_may_not_open_or_cannot_ask() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let invoicer = member(&world.db, "LIMITED", &["invoices:read", "messages:create"]).await;
    let b = books(&world.db, false).await;
    let hidden = books(&world.db, true).await;
    let app = world.app(&owner, BOOKS);
    let ask = |body: Value| {
        let app = app.clone();
        async move { call(&app, "POST", "/api/accounting-questions", Some(&body)).await }
    };

    // Not a WeldBooks record, no text, an unknown member, a member who may not open the line.
    for (body, wanted) in [
        (
            json!({ "recordType": "company", "recordId": "c_1", "text": "x" }),
            400,
        ),
        (
            json!({ "recordType": "invoice", "recordId": b.invoice }),
            400,
        ),
        (
            json!({ "recordType": "invoice", "recordId": b.invoice, "text": "   " }),
            400,
        ),
        (
            json!({ "recordType": "invoice", "recordId": b.invoice, "text": "x", "askedTo": ["u_nobody"] }),
            400,
        ),
        (
            json!({ "recordType": "bank_transaction", "recordId": b.lines[0], "text": "x", "askedTo": [invoicer] }),
            400,
        ),
        // A record that is not there is not one the caller may open.
        (
            json!({ "recordType": "bill", "recordId": "bil_gone", "text": "x" }),
            403,
        ),
    ] {
        let (status, out) = ask(body.clone()).await;
        assert_eq!(status.as_u16(), wanted, "{body}: {out}");
    }
    // Nothing was created by the refusals.
    let (channels,): (i64,) =
        sqlx::query_as("select count(*) from chat_channels where entity_id = any($1)")
            .bind(vec![b.invoice.clone(), b.lines[0].clone()])
            .fetch_one(&world.db)
            .await
            .unwrap();
    assert_eq!(channels, 0);

    // The restricted entity's invoice is closed to a member who may not see the entity.
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let limited = world.app(&accountant, BOOKS);
    let (status, _) = call(
        &limited,
        "POST",
        "/api/accounting-questions",
        Some(&json!({ "recordType": "invoice", "recordId": hidden.invoice, "text": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // And a member without the type's permission cannot ask about its records.
    let reader = world.app(&invoicer, &["invoices:read", "messages:create"]);
    let (status, _) = call(
        &reader,
        "POST",
        "/api/accounting-questions",
        Some(&json!({ "recordType": "bank_transaction", "recordId": b.lines[0], "text": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &reader,
        "POST",
        "/api/accounting-questions",
        Some(&json!({ "recordType": "invoice", "recordId": b.invoice, "text": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn a_reply_by_someone_else_answers_and_resolving_and_reopening_are_a_patch() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let b = books(&world.db, false).await;
    let asker = world.app(&accountant, BOOKS);
    let answerer = world.app(&owner, BOOKS);

    // The accountant asks the owner.
    let (_, out) = call(
        &asker,
        "POST",
        "/api/accounting-questions",
        Some(&json!({
            "recordType": "invoice", "recordId": b.invoice, "text": "Is this billable?", "askedTo": [owner],
        })),
    )
    .await;
    let id = out["data"]["id"].as_str().unwrap().to_owned();
    world.events().await;

    // The asker replying in the thread is not an answer.
    let reply_path = format!("/api/chat-entity-channels/invoice/{}/messages", b.invoice);
    let (status, _) = call(
        &asker,
        "POST",
        &reply_path,
        Some(&json!({ "content": "More detail", "parentId": id })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    // The list holds the request's entity (the shared database may hold a default one).
    let list_path = format!("/api/accounting-questions?entityId={}", b.entity);
    let (_, list) = call(&asker, "GET", &list_path, None).await;
    let mine = list["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == json!(id))
        .unwrap()
        .clone();
    assert_eq!(mine["status"], "open");
    assert_eq!(mine["replyCount"], 1);
    assert!(!names(&world.events().await).contains(&"accounting_question.updated"));

    // The owner's reply is.
    let (status, _) = call(
        &answerer,
        "POST",
        &reply_path,
        Some(&json!({ "content": "Yes, to Acme", "parentId": id })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let events = world.events().await;
    let updated = events
        .iter()
        .find(|(name, _)| name == "accounting_question.updated")
        .unwrap_or_else(|| panic!("{events:?}"));
    assert_eq!(updated.1["id"], json!(id));
    assert_eq!(updated.1["from"], "open");
    assert_eq!(updated.1["status"], "answered");
    let (_, list) = call(
        &asker,
        "GET",
        &format!(
            "/api/accounting-questions?status=answered&entityId={}",
            b.entity
        ),
        None,
    )
    .await;
    let answered = list["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == json!(id))
        .unwrap()
        .clone();
    assert_eq!(answered["status"], "answered");
    assert_eq!(answered["replyCount"], 2);
    assert!(answered["lastReplyAt"].is_string());

    // Resolve it, re-open it.
    let (status, out) = call(
        &asker,
        "PATCH",
        &format!("/api/accounting-questions/{id}"),
        Some(&json!({ "status": "resolved" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["data"]["status"], "resolved");
    let events = world.events().await;
    let updated = events
        .iter()
        .find(|(name, _)| name == "accounting_question.updated")
        .unwrap();
    assert_eq!(
        (updated.1["from"].as_str(), updated.1["status"].as_str()),
        (Some("answered"), Some("resolved"))
    );
    // Resolving what is resolved changes nothing.
    let (status, _) = call(
        &asker,
        "PATCH",
        &format!("/api/accounting-questions/{id}"),
        Some(&json!({ "status": "resolved" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(world.events().await.is_empty());
    let (status, out) = call(
        &answerer,
        "PATCH",
        &format!("/api/accounting-questions/{id}"),
        Some(&json!({ "status": "open" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(out["data"]["status"], "open");

    // A status that is none, a message that is no question, a member who may not see the record.
    for (path, body, wanted) in [
        (
            format!("/api/accounting-questions/{id}"),
            json!({ "status": "done" }),
            400,
        ),
        (format!("/api/accounting-questions/{id}"), json!({}), 400),
        (
            "/api/accounting-questions/msg_missing".to_owned(),
            json!({ "status": "open" }),
            404,
        ),
    ] {
        let (status, out) = call(&asker, "PATCH", &path, Some(&body)).await;
        assert_eq!(status.as_u16(), wanted, "{path} {body}: {out}");
    }
    let outsider = member(&world.db, "LIMITED", &["messages:create", "channels:read"]).await;
    let (status, _) = call(
        &world.app(&outsider, &["messages:create", "channels:read"]),
        "PATCH",
        &format!("/api/accounting-questions/{id}"),
        Some(&json!({ "status": "resolved" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_list_holds_what_the_caller_may_see_and_filters_on_status_person_and_type() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let invoicer = member(
        &world.db,
        "LIMITED",
        &["invoices:read", "messages:create", "channels:read"],
    )
    .await;
    let open = books(&world.db, false).await;
    let hidden = books(&world.db, true).await;
    let by_owner = world.app(&owner, &["*"]);
    let ask = |recipient: Option<&String>, kind: &str, record: &String| {
        let app = by_owner.clone();
        let mut body =
            json!({ "recordType": kind, "recordId": record, "text": format!("About {record}") });
        if let Some(recipient) = recipient {
            body["askedTo"] = json!([recipient]);
        }
        async move {
            let (status, out) = call(&app, "POST", "/api/accounting-questions", Some(&body)).await;
            assert_eq!(status, StatusCode::CREATED, "{out}");
            out["data"]["id"].as_str().unwrap().to_owned()
        }
    };
    let q_line = ask(Some(&accountant), "bank_transaction", &open.lines[0]).await;
    let q_invoice = ask(None, "invoice", &open.invoice).await;
    let q_hidden = ask(None, "invoice", &hidden.invoice).await;

    let as_accountant = world.app(&accountant, BOOKS);
    let (status, list) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let ids = |list: &Value| -> Vec<String> {
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q["id"].as_str().unwrap().to_owned())
            .collect()
    };
    // The restricted entity's question is not the accountant's to see (nor counted).
    assert!(ids(&list).contains(&q_line) && ids(&list).contains(&q_invoice));
    assert!(!ids(&list).contains(&q_hidden));
    assert!(list["pagination"]["totalCount"].as_u64().unwrap() >= 2);
    assert_eq!(list["pagination"]["hasMore"], false);
    let item = list["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == json!(q_line))
        .unwrap();
    for key in [
        "id",
        "recordType",
        "recordId",
        "recordTitle",
        "text",
        "status",
        "askedBy",
        "askedTo",
        "createdAt",
        "lastReplyAt",
        "replyCount",
        "entityId",
    ] {
        assert!(item.get(key).is_some(), "{key} in {item}");
    }

    let (_, mine) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?askedTo=me&limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert!(ids(&mine).contains(&q_line));
    assert!(!ids(&mine).contains(&q_invoice) && !ids(&mine).contains(&q_hidden));
    let (_, any) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?askedTo=any&limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert!(ids(&any).contains(&q_invoice));
    let (_, lines) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?recordType=bank_transaction&limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert!(ids(&lines).contains(&q_line) && !ids(&lines).contains(&q_invoice));
    let (_, none) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?status=resolved&limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert!(!ids(&none).contains(&q_line));

    // Paging: one at a time, the cursor is the last id.
    let (_, first) = call(
        &as_accountant,
        "GET",
        &format!("/api/accounting-questions?limit=1&entityId={}", open.entity),
        None,
    )
    .await;
    assert_eq!(first["data"].as_array().unwrap().len(), 1);
    assert_eq!(first["pagination"]["hasMore"], true);
    let cursor = first["pagination"]["cursor"].as_str().unwrap().to_owned();
    assert_eq!(cursor, first["data"][0]["id"].as_str().unwrap());
    let (_, next) = call(
        &as_accountant,
        "GET",
        &format!(
            "/api/accounting-questions?limit=1&cursor={cursor}&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert_ne!(next["data"][0]["id"], first["data"][0]["id"]);

    // A member with only the invoice permission sees the invoice's question, not the line's.
    let (_, narrow) = call(
        &world.app(
            &invoicer,
            &["invoices:read", "messages:create", "channels:read"],
        ),
        "GET",
        &format!(
            "/api/accounting-questions?limit=100&entityId={}",
            open.entity
        ),
        None,
    )
    .await;
    assert!(ids(&narrow).contains(&q_invoice));
    assert!(!ids(&narrow).contains(&q_line));

    // Bad filters.
    for query in [
        "status=done",
        "askedTo=you",
        "recordType=company",
        "limit=0",
    ] {
        let (status, out) = call(
            &as_accountant,
            "GET",
            &format!("/api/accounting-questions?{query}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {out}");
    }
    // Without the permission to read chats there is no list.
    let (status, _) = call(
        &world.app(&accountant, &["invoices:read"]),
        "GET",
        "/api/accounting-questions",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_list_holds_the_request_entity_and_contacts_show_in_every_entity() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let first = books(&world.db, false).await;
    let second = books(&world.db, false).await;
    let restricted = books(&world.db, true).await;
    let party = fresh("pty");
    sqlx::query(
        "insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme Trading', 'both')",
    )
    .bind(&party)
    .execute(&world.db)
    .await
    .unwrap();
    let by_owner = world.app(&owner, &["*"]);
    let ask = |kind: &str, record: &String| {
        let app = by_owner.clone();
        let body =
            json!({ "recordType": kind, "recordId": record, "text": format!("About {record}") });
        async move {
            let (status, out) = call(&app, "POST", "/api/accounting-questions", Some(&body)).await;
            assert_eq!(status, StatusCode::CREATED, "{out}");
            out["data"]["id"].as_str().unwrap().to_owned()
        }
    };
    let q_first = ask("invoice", &first.invoice).await;
    let q_first_line = ask("bank_transaction", &first.lines[0]).await;
    let q_second = ask("invoice", &second.invoice).await;
    let q_restricted = ask("invoice", &restricted.invoice).await;
    let q_contact = ask("accounting_contact", &party).await;

    let ids = |list: &Value| -> Vec<String> {
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let as_accountant = world.app(&accountant, BOOKS);
    let path = "/api/accounting-questions?status=open&askedTo=any&limit=100";

    // In the first entity: its questions and the contact's, not the second entity's.
    let (status, list) = get_in(&as_accountant, "x-legal-entity-id", &first.entity, path).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let got = ids(&list);
    assert!(
        got.contains(&q_first) && got.contains(&q_first_line),
        "{list}"
    );
    assert!(got.contains(&q_contact), "{list}");
    assert!(
        !got.contains(&q_second) && !got.contains(&q_restricted),
        "{list}"
    );
    // The count is of the same set, as To process counts it.
    assert_eq!(list["pagination"]["hasMore"], false);
    assert_eq!(
        list["pagination"]["totalCount"].as_u64().unwrap(),
        u64::try_from(got.len()).unwrap()
    );
    for item in list["data"].as_array().unwrap() {
        assert!(
            item["entityId"] == json!(first.entity) || item["recordType"] == "accounting_contact",
            "{item}"
        );
    }

    // The second entity, named by the older header and by the query.
    let (_, list) = get_in(
        &as_accountant,
        "x-accounting-entity-id",
        &second.entity,
        path,
    )
    .await;
    let got = ids(&list);
    assert!(
        got.contains(&q_second) && got.contains(&q_contact),
        "{list}"
    );
    assert!(
        !got.contains(&q_first) && !got.contains(&q_first_line),
        "{list}"
    );
    let (_, list) = call(
        &as_accountant,
        "GET",
        &format!("{path}&entityId={}", second.entity),
        None,
    )
    .await;
    let got = ids(&list);
    assert!(got.contains(&q_second) && !got.contains(&q_first), "{list}");

    // A restricted entity the accountant may not see lists none of its
    // questions and none of the others either; only the contacts'.
    let (status, list) = get_in(
        &as_accountant,
        "x-legal-entity-id",
        &restricted.entity,
        path,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let got = ids(&list);
    assert!(got.contains(&q_contact), "{list}");
    for hidden in [&q_restricted, &q_first, &q_first_line, &q_second] {
        assert!(!got.contains(hidden), "{list}");
    }
    // An entity that does not exist is the same.
    let (_, list) = get_in(&as_accountant, "x-legal-entity-id", "ent_missing", path).await;
    let got = ids(&list);
    assert!(
        got.contains(&q_contact) && !got.contains(&q_first),
        "{list}"
    );

    // The owner sees the restricted entity, and only it there.
    let (_, list) = get_in(
        &world.app(&owner, &["*"]),
        "x-legal-entity-id",
        &restricted.entity,
        path,
    )
    .await;
    let got = ids(&list);
    assert!(
        got.contains(&q_restricted) && got.contains(&q_contact),
        "{list}"
    );
    assert!(
        !got.contains(&q_first) && !got.contains(&q_second),
        "{list}"
    );
}

#[tokio::test]
async fn a_bulk_ask_makes_one_question_per_line_and_reports_the_lines_it_could_not() {
    let Some(world) = World::new() else { return };
    let owner = member(&world.db, "OWNER", &[]).await;
    let accountant = member(&world.db, "LIMITED", BOOKS).await;
    let open = books(&world.db, false).await;
    let hidden = books(&world.db, true).await;
    let app = world.app(&accountant, BOOKS);

    let (status, out) = call(
        &app,
        "POST",
        "/api/accounting-questions/bulk",
        Some(&json!({
            "recordType": "bank_transaction",
            "recordIds": [open.lines[0], open.lines[1], hidden.lines[0], "btx_gone", open.lines[0]],
            "text": "Please upload the receipt", "askedTo": [owner],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{out}");
    let created = out["data"]["created"].as_array().unwrap();
    assert_eq!(created.len(), 2, "{out}");
    let records: Vec<&str> = created
        .iter()
        .map(|q| q["recordId"].as_str().unwrap())
        .collect();
    assert_eq!(records, [open.lines[0].as_str(), open.lines[1].as_str()]);
    assert!(
        created
            .iter()
            .all(|q| q["text"] == "Please upload the receipt" && q["status"] == "open")
    );
    assert!(
        created
            .iter()
            .all(|q| q["askedTo"][0]["id"] == json!(owner))
    );
    let failed = out["data"]["failed"].as_array().unwrap();
    let failed_ids: Vec<&str> = failed
        .iter()
        .map(|f| f["recordId"].as_str().unwrap())
        .collect();
    assert_eq!(failed_ids, [hidden.lines[0].as_str(), "btx_gone"]);
    assert!(
        failed
            .iter()
            .all(|f| f["status"] == 403 && f["error"].is_string())
    );
    // One chat per line, and none for the lines that failed.
    let (chats,): (i64,) = sqlx::query_as(
        "select count(*) from chat_channels where entity_type = 'bank_transaction' and entity_id = any($1)",
    )
    .bind(vec![open.lines[0].clone(), open.lines[1].clone(), hidden.lines[0].clone()])
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(chats, 2);
    let events = world.events().await;
    assert_eq!(
        events
            .iter()
            .filter(|(name, _)| name == "accounting_question.created")
            .count(),
        2
    );

    // Too many, none, and a bad type are the body's 400.
    for body in [
        json!({ "recordType": "bank_transaction", "recordIds": [], "text": "x" }),
        json!({ "recordType": "bank_transaction", "text": "x" }),
        json!({ "recordType": "company", "recordIds": ["c_1"], "text": "x" }),
        json!({ "recordType": "bank_transaction", "recordIds": (0..101).map(|i| format!("btx_{i}")).collect::<Vec<_>>(), "text": "x" }),
    ] {
        let (status, out) = call(&app, "POST", "/api/accounting-questions/bulk", Some(&body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
    }
}
