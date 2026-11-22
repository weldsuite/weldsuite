//! `/api/conversations` (`routes/conversations/index.ts`): the helpdesk
//! inbox over `helpdesk_conversations` and `helpdesk_conversation_messages`:
//! list and folder counts, the message thread and agent replies, block
//! responses, events, review and audit log, CRUD, and the sub-actions
//! (status, close, read, star, archive, priority, assign, assign-team,
//! convert-to-ticket, snooze, tags, contact, auto-link-contact).
//! Permissions `conversations:read|create|update|delete`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_desk_domain::notify::EntityKind;
use weldsuite_desk_domain::realtime::{
    Attachment, conversation_message, conversation_system, defined,
};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::RealtimeMessage;
use weldsuite_schema::tenant;
use weldsuite_schema::tenant::{
    helpdesk_conversation_messages as conv_messages, helpdesk_conversations as convs, people,
};

use crate::crud::{page_of, soft_delete, write_failed};
use crate::js::{js_date_iso, js_limit, query_param, sql_limit, text};
use crate::link::{Link, link_conversation_to_ticket};
use crate::notify::{Assigned, assigned};
use crate::tables::{
    HELPDESK_CONVERSATION_MESSAGES, HELPDESK_CONVERSATIONS, HELPDESK_TICKETS, PEOPLE,
};
use crate::tickets::base36_now;
use crate::{Caller, DeskState, Refusal, now, validate};

const CONV: &crate::table::Table = &HELPDESK_CONVERSATIONS;

/// The routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::CONVERSATIONS_CREATE.to_owned()])),
        )
        .route("/folder-counts", get(folder_counts).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_conversation).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(remove)
                .route_layer(gate.require([perm::CONVERSATIONS_DELETE.to_owned()])),
        )
        .route("/{id}/messages", get(messages).route_layer(read()))
        .route("/{id}/messages", post(send_message).route_layer(update()))
        .route(
            "/{id}/messages/{message_id}/respond",
            patch(respond).route_layer(update()),
        )
        .route("/{id}/events", get(events).route_layer(read()))
        .route("/{id}/review", get(review).route_layer(read()))
        .route("/{id}/audit-logs", get(audit_logs).route_layer(read()))
        .route("/{id}/status", patch(set_status).route_layer(update()))
        .route("/{id}/close", post(close).route_layer(update()))
        .route("/{id}/read", patch(set_read).route_layer(update()))
        .route("/{id}/star", patch(set_star).route_layer(update()))
        .route("/{id}/archive", patch(set_archive).route_layer(update()))
        .route("/{id}/priority", patch(set_priority).route_layer(update()))
        .route("/{id}/assign", patch(assign).route_layer(update()))
        .route(
            "/{id}/assign-team",
            patch(assign_team).route_layer(update()),
        )
        .route(
            "/{id}/convert-to-ticket",
            post(convert_to_ticket).route_layer(update()),
        )
        .route("/{id}/snooze", patch(snooze).route_layer(update()))
        .route("/{id}/tags", patch(set_tags).route_layer(update()))
        .route("/{id}/contact", patch(set_contact).route_layer(update()))
        .route(
            "/{id}/auto-link-contact",
            post(auto_link_contact).route_layer(update()),
        )
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// `withContact(conv, contact)`: the linked contact is the source of truth
/// for name, email and avatar.
fn with_contact(
    conv: Value,
    name: Option<&str>,
    email: Option<&str>,
    avatar: Option<&str>,
) -> Value {
    let Value::Object(mut row) = conv else {
        return conv;
    };
    let pick = |contact: Option<&str>, own: &Value| -> Value {
        contact
            .filter(|c| !c.is_empty())
            .map_or_else(|| own.clone(), |c| json!(c))
    };
    let customer_email = pick(email, &row["customerEmail"]);
    let customer_name = pick(name, &row["customerName"]);
    row.insert("customerEmail".to_owned(), customer_email);
    row.insert("customerName".to_owned(), customer_name);
    // `contact?.avatarUrl || conv.customerAvatar || undefined`.
    let avatar = avatar
        .filter(|a| !a.is_empty())
        .or_else(|| row["customerAvatar"].as_str().filter(|a| !a.is_empty()))
        .map(str::to_owned);
    match avatar {
        Some(avatar) => {
            row.insert("customerAvatarUrl".to_owned(), json!(avatar));
        }
        None => {
            row.remove("customerAvatarUrl");
        }
    }
    for key in ["tags", "labels"] {
        if !js_truthy(&row[key]) {
            row.insert(key.to_owned(), json!([]));
        }
    }
    Value::Object(row)
}

/// JavaScript truthiness.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `statusDerivedFields(status)`.
fn status_derived(values: &mut Map<String, Value>, status: &str) {
    if status != "snoozed" {
        CONV.set(values, "snoozedUntil", Value::Null);
    }
    if status == "archived" {
        CONV.set(values, "isArchived", json!(true));
    } else if status == "active" || status == "pending" {
        CONV.set(values, "isArchived", json!(false));
    }
}

/// `loadConversation`: the live row.
async fn load(db: &PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    CONV.find_live(db, id).await
}

/// A row as Drizzle returns it.
fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `new Date()` once: as the route's JSON writes it, and as the `timestamp`
/// it stores.
fn now_and_stamp() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (weldsuite_events::iso_timestamp(at), utc_timestamp(at))
}

/// `leftJoin(people, eq(conv.contactId, people.id))`.
fn contact() -> RelationDef {
    convs::Entity::belongs_to(people::Entity)
        .from(convs::Column::ContactId)
        .to(people::Column::Id)
        .into()
}

/// A conversation with its linked contact's name, email and avatar.
#[derive(Debug, FromQueryResult)]
struct WithContact {
    #[sea_orm(nested)]
    conversation: convs::Model,
    contact_full_name: Option<String>,
    contact_email: Option<String>,
    contact_avatar_url: Option<String>,
}

impl WithContact {
    /// `select({ conv, contact: people })` with the left join, to filter
    /// and order before `into_model`.
    fn query() -> sea_orm::Select<convs::Entity> {
        convs::Entity::find()
            .column_as(people::Column::FullName, "contact_full_name")
            .column_as(people::Column::Email, "contact_email")
            .column_as(people::Column::AvatarUrl, "contact_avatar_url")
            .join(JoinType::LeftJoin, contact())
    }

    /// `withContact(conv, contact)`.
    fn into_json(self) -> Result<Value, DbErr> {
        Ok(with_contact(
            js(self.conversation)?,
            self.contact_full_name.as_deref(),
            self.contact_email.as_deref(),
            self.contact_avatar_url.as_deref(),
        ))
    }
}

/// Fire-and-forget work (`c.executionCtx.waitUntil`).
fn background(state: &DeskState, work: impl Future<Output = ()> + Send + 'static) {
    state.events.tracker().spawn(work);
}

/// Publish realtime messages one after another, logging failures.
fn publish_realtime(state: &DeskState, messages: Vec<RealtimeMessage>) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    background(state, async move {
        for message in messages {
            if let Err(error) = realtime.publish_boxed(&message).await {
                tracing::error!(%error, "[app-api/conversations] realtime publish failed");
            }
        }
    });
}

/// `publishConversationClosed(env, id, { conversationId, closedBy, closedByType, closedAt })`.
fn closed_message(id: &str, user_id: &str, at: &str) -> RealtimeMessage {
    conversation_system(
        id,
        "conversation_closed",
        json!({ "closedBy": user_id, "closedByType": "agent", "closedAt": at }),
    )
}

/// `archiveDiscordThreadIfTicket`: the Discord ticket thread behind a
/// conversation, archived in the background.
fn archive_discord_thread(state: &DeskState, caller: &Caller, conv: &Value) {
    if conv["channel"] != "discord" {
        return;
    }
    let Some(token) = caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty()) else {
        return;
    };
    let metadata = &conv["metadata"];
    if !js_truthy(&metadata["isTicket"]) || !js_truthy(&metadata["discordChannelId"]) {
        return;
    }
    let thread = metadata["discordChannelId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let http = caller.http(state);
    background(state, async move {
        if let Err(error) =
            crate::discord::close_ticket_thread(http.as_ref(), &token, &thread).await
        {
            tracing::error!(%error, "[app-api/conversations] Failed to archive Discord thread");
        }
    });
}

/// A route's sub-action body: `zValidator('json', schema)`.
fn read_body<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    validate(headers, body, read)
}

/// Update the live conversation with `values`; the changed row.
async fn patch_live(
    db: &PgPool,
    id: &str,
    values: Map<String, Value>,
) -> Result<Option<Value>, crate::table::WriteError> {
    let trusted: Vec<&str> = CONV.columns.iter().map(|c| c.prop).collect();
    CONV.patch(db, id, values, true, &trusted).await
}

#[allow(clippy::needless_pass_by_value)] // every call site builds the data in place
fn publish(state: &DeskState, caller: &Caller, event: EventName, id: &str, data: Value) {
    caller.publish(state, event, id, &data);
}

// ── list and counts ─────────────────────────────────────────────────────────

/// The list's filters from the query string.
fn list_filters(query: Option<&str>, user_id: &str) -> Condition {
    let q = |key: &str| query_param(query, key).filter(|v| !v.is_empty());
    let assignment = if query_param(query, "unassigned").as_deref() == Some("true") {
        Some("unassigned")
    } else if query_param(query, "myConversations").as_deref() == Some("true") {
        Some("mine")
    } else if q("assigneeId").is_some() {
        Some("assignee")
    } else {
        None
    };
    let flag = |key: &str| match query_param(query, key).as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let search = q("search").map(|s| format!("%{s}%"));
    let mut filters = Condition::all()
        .add(convs::Column::DeletedAt.is_null())
        .add(
            Condition::any()
                .add(convs::Column::Channel.ne("chat"))
                .add(convs::Column::LastCustomerMessageAt.is_not_null()),
        )
        .add(convs::Column::HasActiveWorkflow.eq(false));
    if let Some(status) = q("status") {
        filters = filters.add(convs::Column::Status.eq(status));
    }
    if let Some(status) = q("excludeStatus") {
        filters = filters.add(convs::Column::Status.ne(status));
    }
    for (key, column) in [
        ("priority", convs::Column::Priority),
        ("channel", convs::Column::Channel),
        ("departmentId", convs::Column::DepartmentId),
        ("contactId", convs::Column::ContactId),
        ("customerEmail", convs::Column::CustomerEmail),
    ] {
        if let Some(value) = q(key) {
            filters = filters.add(column.eq(value));
        }
    }
    match assignment {
        Some("unassigned") => filters = filters.add(convs::Column::AssigneeId.is_null()),
        Some("mine") => {
            filters = filters.add(
                Condition::any()
                    .add(convs::Column::AssigneeId.is_null())
                    .add(convs::Column::AssigneeId.eq(user_id)),
            );
        }
        // `$10` is `q("assigneeId")`, there whenever this branch is taken.
        Some(_) => filters = filters.add(convs::Column::AssigneeId.eq(q("assigneeId"))),
        None => {}
    }
    for (key, column) in [
        ("isRead", convs::Column::IsRead),
        ("isStarred", convs::Column::IsStarred),
        ("isArchived", convs::Column::IsArchived),
    ] {
        if let Some(flag) = flag(key) {
            filters = filters.add(column.eq(flag));
        }
    }
    if let Some(search) = &search {
        filters = filters.add(
            Condition::any()
                .add(convs::Column::Subject.like(search))
                .add(convs::Column::CustomerEmail.like(search))
                .add(convs::Column::CustomerName.like(search))
                .add(convs::Column::ConversationNumber.like(search))
                .add(people::Column::FullName.like(search))
                .add(people::Column::Email.like(search)),
        );
    }
    filters
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const MESSAGE: &str = "Failed to list conversations";
    let query = query.as_deref();
    let q = |key: &str| query_param(query, key).filter(|v| !v.is_empty());
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    // The cursor lookup runs before the route's `try`.
    let cursor = match q("cursor") {
        Some(cursor) => match crate::crud::cursor_row(&caller.db, CONV, &cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "desk: cursor lookup failed");
                return weldsuite_kit::ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let filters = list_filters(query, &caller.user_id);
    let mut page = WithContact::query().filter(filters.clone());
    if let Some((at, cursor_id)) = &cursor {
        page = page.filter(
            Condition::any().add(convs::Column::CreatedAt.lt(*at)).add(
                Condition::all()
                    .add(convs::Column::CreatedAt.eq(*at))
                    .add(convs::Column::Id.lt(cursor_id)),
            ),
        );
    }
    page = page
        .order_by_desc(convs::Column::CreatedAt)
        .order_by_desc(convs::Column::Id);
    if let Some(limit) = sql_limit(limit) {
        page = page.limit(u64::try_from(limit).unwrap_or(0));
    }
    let db = orm(&caller.db);
    let rows = page.into_model::<WithContact>().all(&db).await;
    let total = convs::Entity::find()
        .join(JoinType::LeftJoin, contact())
        .filter(filters)
        .count(&db)
        .await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => return Refusal::from(error).respond(MESSAGE),
    };
    let rows: Vec<Value> = match rows.into_iter().map(WithContact::into_json).collect() {
        Ok(rows) => rows,
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let (data, has_more, cursor) = page_of(rows, limit, |row| text(row, "id"));
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(total, has_more, cursor),
    )
    .into_response()
}

/// The inbox folders' counts.
#[derive(Debug, FromQueryResult)]
struct FolderCounts {
    all: i64,
    chat: i64,
    unassigned: i64,
    mine: i64,
    active: i64,
    pending: i64,
    resolved: i64,
    closed: i64,
}

async fn folder_counts(caller: Caller) -> Response {
    // `count(*) filter (where …)`: the rows the case keeps (it is null otherwise).
    let count = |condition: Condition| Expr::from(Func::count(Expr::case(condition, 1)));
    let unread = || Condition::all().add(convs::Column::IsRead.eq(false));
    let unassigned_or_mine = || {
        Condition::any()
            .add(convs::Column::AssigneeId.is_null())
            .add(convs::Column::AssigneeId.eq(&caller.user_id))
    };
    let status = |status: &str| Condition::all().add(convs::Column::Status.eq(status));
    let counts = convs::Entity::find()
        .select_only()
        .column_as(count(unread().add(unassigned_or_mine())), "all")
        .column_as(
            count(
                unread()
                    .add(convs::Column::Channel.eq("chat"))
                    .add(unassigned_or_mine()),
            ),
            "chat",
        )
        .column_as(
            count(unread().add(convs::Column::AssigneeId.is_null())),
            "unassigned",
        )
        .column_as(
            count(unread().add(convs::Column::AssigneeId.eq(&caller.user_id))),
            "mine",
        )
        .column_as(count(status("active")), "active")
        .column_as(count(status("pending")), "pending")
        .column_as(count(status("resolved")), "resolved")
        .column_as(count(status("closed")), "closed")
        .filter(convs::Column::DeletedAt.is_null())
        .filter(convs::Column::IsArchived.eq(false))
        .into_model::<FolderCounts>()
        .one(&orm(&caller.db))
        .await;
    match counts {
        Ok(counts) => {
            let counts = counts.unwrap_or(FolderCounts {
                all: 0,
                chat: 0,
                unassigned: 0,
                mine: 0,
                active: 0,
                pending: 0,
                resolved: 0,
                closed: 0,
            });
            Data(json!({
                "active": counts.active,
                "all": counts.all,
                "chat": counts.chat,
                "closed": counts.closed,
                "mine": counts.mine,
                "pending": counts.pending,
                "resolved": counts.resolved,
                "unassigned": counts.unassigned,
            }))
            .into_response()
        }
        Err(error) => Refusal::from(error).respond("Failed to fetch folder counts"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch conversation";
    let row = WithContact::query()
        .filter(convs::Column::Id.eq(&id))
        .filter(convs::Column::DeletedAt.is_null())
        .limit(1)
        .into_model::<WithContact>()
        .one(&orm(&caller.db))
        .await;
    match row.and_then(|row| row.map(WithContact::into_json).transpose()) {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => Refusal::from(error).respond(MESSAGE),
    }
}

// ── messages ────────────────────────────────────────────────────────────────

/// `toDto(msg)`: the legacy wire shape of a conversation message.
fn message_dto(msg: &Value) -> Value {
    let mut out = Map::new();
    for key in [
        "id",
        "conversationId",
        "authorId",
        "authorName",
        "authorEmail",
        "authorType",
        "authorAvatar",
        "content",
        "htmlContent",
        "plainContent",
        "type",
        "isPublic",
        "isInternal",
        "status",
        "isRead",
        "hasAttachments",
        "createdAt",
        "updatedAt",
    ] {
        out.insert(key.to_owned(), msg[key].clone());
    }
    out.insert(
        "readAt".to_owned(),
        if js_truthy(&msg["readAt"]) {
            msg["readAt"].clone()
        } else {
            Value::Null
        },
    );
    out.insert(
        "attachments".to_owned(),
        if js_truthy(&msg["attachments"]) {
            msg["attachments"].clone()
        } else {
            json!([])
        },
    );
    out.insert("blocks".to_owned(), msg["blocks"].clone());
    out.insert("blockResponses".to_owned(), msg["blockResponses"].clone());
    // `msg.metadata || undefined`.
    if js_truthy(&msg["metadata"]) {
        out.insert("metadata".to_owned(), msg["metadata"].clone());
    }
    Value::Object(out)
}

async fn exists(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = convs::Entity::find()
        .select_only()
        .column(convs::Column::Id)
        .filter(convs::Column::Id.eq(id))
        .filter(convs::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

async fn messages(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch messages";
    match exists(&caller.db, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    }
    let rows = conv_messages::Entity::find()
        .filter(conv_messages::Column::ConversationId.eq(&id))
        .filter(conv_messages::Column::DeletedAt.is_null())
        .order_by_asc(conv_messages::Column::CreatedAt)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().map(js).collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(rows) => Data(rows.iter().map(message_dto).collect::<Vec<_>>()).into_response(),
        Err(error) => Refusal::from(error).respond(MESSAGE),
    }
}

/// `createMessageSchema`.
struct NewMessage {
    content: String,
    content_html: Option<String>,
    is_internal: bool,
    author_name: Option<String>,
    attachments: Option<Vec<Value>>,
    blocks: Option<Vec<Value>>,
}

fn new_message_schema(issues: &mut Issues, body: &Map<String, Value>) -> NewMessage {
    let opt = Presence::Optional;
    let content = issues.text(body, "content", Presence::Required, None, None);
    let content_html = issues.text(body, "contentHtml", opt, None, None);
    let is_internal = issues.boolean(body, "isInternal", opt);
    let author_name = issues.text(body, "authorName", opt, None, None);
    let attachments = issues.list(body, "attachments", opt, None, None, |issues, item| {
        let fields = issues.object(item)?;
        let before = issues.count();
        let required = Presence::Required;
        let id = issues.text(fields, "id", required, None, None);
        let file_name = issues.text(fields, "fileName", required, None, None);
        let size = issues.number(fields, "fileSize", required, Number::default());
        let mime = issues.text(fields, "mimeType", required, None, None);
        let url = issues.text(fields, "url", required, None, None);
        if issues.count() > before || size.as_set().is_none() {
            return None;
        }
        // Zod strips the keys the item schema doesn't name.
        Some(json!({
            "id": id.into_option(),
            "fileName": file_name.into_option(),
            "fileSize": fields["fileSize"].clone(),
            "mimeType": mime.into_option(),
            "url": url.into_option(),
        }))
    });
    let blocks = issues.records(body, "blocks", opt);
    NewMessage {
        content: content.into_option().unwrap_or_default(),
        content_html: content_html.into_option(),
        is_internal: is_internal.into_option().unwrap_or(false),
        author_name: author_name.into_option(),
        attachments: attachments.into_option(),
        blocks: blocks.into_option(),
    }
}

/// `String#substring(0, max)` in UTF-16 units.
fn substring(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

#[allow(clippy::too_many_lines)] // the route is one long handler in TypeScript too
async fn send_message(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to send message";
    let input = match read_body(&headers, &body, new_message_schema) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let conversation = match load(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let author_name = input
        .author_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Agent".to_owned());
    let internal = input.is_internal;
    // `autoAssignOnAgentReply`: unassigned, or still parked on the AI agent.
    let current = text(&conversation, "assigneeId").filter(|a| !a.is_empty());
    let auto_assign = !internal && (current.is_none() || current == Some("ai-agent"));
    if auto_assign {
        let assigned = convs::Entity::update_many()
            .col_expr(convs::Column::AssigneeId, Expr::value(&caller.user_id))
            .col_expr(convs::Column::AssigneeName, Expr::value(&author_name))
            .col_expr(convs::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(convs::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await;
        if let Err(error) = assigned {
            return Refusal::from(error).respond(MESSAGE);
        }
        publish(
            &state,
            &caller,
            ev::HELPDESK_CONVERSATION_ASSIGNED,
            &id,
            json!({ "id": id, "assigneeId": caller.user_id }),
        );
        publish_realtime(
            &state,
            vec![conversation_system(
                &id,
                "agent_assigned",
                json!({ "agentId": caller.user_id, "agentName": author_name, "assignedAt": now() }),
            )],
        );
    }
    // `createAgentMessage`.
    let message_id = generate_id("msg");
    let (now, stamp) = now_and_stamp();
    let has_attachments = input.attachments.as_ref().is_some_and(|a| !a.is_empty());
    let table = &HELPDESK_CONVERSATION_MESSAGES;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(message_id));
    table.set(&mut values, "conversationId", json!(id));
    table.set(&mut values, "authorId", json!(caller.user_id));
    table.set(&mut values, "authorName", json!(author_name));
    table.set(&mut values, "authorType", json!("agent"));
    table.set(&mut values, "content", json!(input.content));
    if let Some(html) = &input.content_html {
        table.set(&mut values, "htmlContent", json!(html));
    }
    table.set(
        &mut values,
        "type",
        json!(if internal { "note" } else { "message" }),
    );
    table.set(&mut values, "isPublic", json!(!internal));
    table.set(&mut values, "isInternal", json!(internal));
    table.set(&mut values, "status", json!("sent"));
    table.set(&mut values, "isRead", json!(false));
    table.set(
        &mut values,
        "attachments",
        if has_attachments {
            json!(input.attachments)
        } else {
            Value::Null
        },
    );
    table.set(&mut values, "hasAttachments", json!(has_attachments));
    table.set(
        &mut values,
        "blocks",
        input.blocks.clone().map_or(Value::Null, Value::Array),
    );
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let row = match table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, MESSAGE),
    };
    let last = if input.content.is_empty() {
        if has_attachments {
            "Sent an attachment"
        } else {
            ""
        }
        .to_owned()
    } else {
        input.content.clone()
    };
    let mut roll = convs::Entity::update_many()
        .col_expr(
            convs::Column::LastMessage,
            Expr::value(substring(&last, 500)),
        )
        .col_expr(convs::Column::LastMessageAt, Expr::value(stamp))
        .col_expr(convs::Column::LastAgentMessageAt, Expr::value(stamp))
        .col_expr(
            convs::Column::MessageCount,
            sea_orm::ExprTrait::add(Expr::col(convs::Column::MessageCount), 1),
        );
    if has_attachments {
        roll = roll.col_expr(convs::Column::HasAttachments, Expr::value(true));
    }
    let rolled = roll
        .col_expr(convs::Column::UpdatedAt, Expr::value(stamp))
        .filter(convs::Column::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = rolled {
        return Refusal::from(error).respond(MESSAGE);
    }
    let message = message_dto(&row);
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_MESSAGE_CREATED,
        &message_id,
        json!({
            "id": message_id,
            "conversationId": id,
            "authorId": caller.user_id,
            "authorType": "agent",
            "content": input.content,
            "isInternal": internal,
        }),
    );
    if !internal {
        let attachments = input.attachments.as_ref().map(|list| {
            list.iter()
                .map(|a| Attachment {
                    id: a["id"].as_str().unwrap_or(&message_id).to_owned(),
                    name: a["fileName"].as_str().unwrap_or_default().to_owned(),
                    url: a["url"].as_str().unwrap_or_default().to_owned(),
                    kind: a["mimeType"].as_str().unwrap_or_default().to_owned(),
                    size: a["fileSize"].clone(),
                })
                .collect()
        });
        publish_realtime(
            &state,
            vec![conversation_message(
                &id,
                &message_id,
                &input.content,
                &caller.user_id,
                &author_name,
                "agent",
                attachments,
            )],
        );
    }
    crate::dispatch::dispatch_outbound(
        &state,
        &caller,
        &conversation,
        crate::dispatch::Outgoing {
            id: message_id.clone(),
            content: input.content.clone(),
            content_html: input.content_html.clone(),
            author_name: input.author_name.clone(),
            internal,
        },
    );
    Created(message).into_response()
}

async fn respond(
    State(state): State<DeskState>,
    caller: Caller,
    Path((id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to process block response";
    let (action_id, value) = match read_body(&headers, &body, |issues, fields| {
        let action = issues.text(fields, "actionId", Presence::Required, None, None);
        (
            action.into_option().unwrap_or_default(),
            fields.get("value").cloned(),
        )
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let found = conv_messages::Entity::find()
        .filter(conv_messages::Column::Id.eq(&message_id))
        .filter(conv_messages::Column::ConversationId.eq(&id))
        .limit(1)
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js).transpose());
    let message = match found {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Message", &message_id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let blocks = message["blocks"].as_array().cloned().unwrap_or_default();
    let Some(block) = blocks
        .iter()
        .find(|b| b["actionId"].as_str() == Some(action_id.as_str()))
    else {
        return Refusal::bad_request(format!(
            "No interactive block with actionId \"{action_id}\""
        ))
        .respond(MESSAGE);
    };
    let mut responses = message["blockResponses"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if responses.get(&action_id).is_some_and(js_truthy) {
        return Refusal::bad_request("This interaction has already been responded to")
            .respond(MESSAGE);
    }
    let kind = match block["type"].as_str() {
        Some("input_form") => "form",
        Some("rating") => "rating",
        Some("file_request") => "file",
        _ => "button",
    };
    let mut entry = Map::new();
    entry.insert("actionId".to_owned(), json!(action_id));
    entry.insert("type".to_owned(), json!(kind));
    if let Some(value) = value {
        entry.insert("value".to_owned(), value);
    }
    entry.insert("respondedAt".to_owned(), json!(now()));
    responses.insert(action_id.clone(), Value::Object(entry));
    let stored = conv_messages::Entity::update_many()
        .col_expr(
            conv_messages::Column::BlockResponses,
            Expr::value(Value::Object(responses.clone())),
        )
        .col_expr(conv_messages::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conv_messages::Column::Id.eq(&message_id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = stored {
        return Refusal::from(error).respond(MESSAGE);
    }
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_MESSAGE_UPDATED,
        &message_id,
        json!({ "id": message_id, "conversationId": id }),
    );
    publish_realtime(
        &state,
        vec![conversation_system(
            &id,
            "message_updated",
            json!({ "messageId": message_id, "blockResponses": responses }),
        )],
    );
    Data(json!({ "messageId": message_id, "blockResponses": responses })).into_response()
}

// ── events, review, audit log ───────────────────────────────────────────────

async fn events(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let kind = query_param(query, "type").filter(|t| !t.is_empty());
    let public = query_param(query, "isPublic").map(|p| p == "true");
    let rows = tenant::helpdesk_conversation_events::Entity::find()
        .filter(tenant::helpdesk_conversation_events::Column::ConversationId.eq(&id))
        .order_by_asc(tenant::helpdesk_conversation_events::Column::CreatedAt)
        .limit(200)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().map(js).collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .filter(|event| {
                    let event_type = event["eventType"].as_str().unwrap_or_default();
                    kind.as_ref()
                        .is_none_or(|k| event_type == k || event_type.starts_with(k.as_str()))
                        && public.is_none_or(|p| event["isPublic"] == Value::Bool(p))
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch conversation events"),
    }
}

async fn review(caller: Caller, Path(id): Path<String>) -> Response {
    let row = tenant::helpdesk_reviews::Entity::find()
        .filter(tenant::helpdesk_reviews::Column::ConversationId.eq(&id))
        .filter(tenant::helpdesk_reviews::Column::DeletedAt.is_null())
        .limit(1)
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js).transpose());
    match row {
        Ok(None) => Data(Value::Null).into_response(),
        Ok(Some(review)) => Data(json!({
            "id": review["id"],
            "rating": review["rating"],
            "content": review["content"],
            "reviewerName": review["reviewerName"],
            "reviewerEmail": review["reviewerEmail"],
            "createdAt": review["createdAt"],
        }))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch review"),
    }
}

async fn audit_logs(caller: Caller, Path(id): Path<String>) -> Response {
    let rows = tenant::audit_logs::Entity::find()
        .filter(tenant::audit_logs::Column::EntityType.eq("helpdesk_conversation"))
        .filter(tenant::audit_logs::Column::EntityId.eq(&id))
        .order_by_desc(tenant::audit_logs::Column::CreatedAt)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().map(js).collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch audit logs"),
    }
}

// ── create, update, delete ──────────────────────────────────────────────────

/// `createConversationSchema` (`.passthrough()`); `.partial()` for updates.
fn conversation_schema(issues: &mut Issues, body: &Map<String, Value>, partial: bool) {
    let opt = Presence::Optional;
    let nullish = Presence::Nullish;
    let required = if partial { opt } else { Presence::Required };
    issues.text(body, "subject", required, Some(1), Some(500));
    issues.text(body, "customerId", nullish, None, None);
    issues.text(body, "customerName", opt, None, Some(255));
    issues.text_with(
        body,
        "customerEmail",
        opt,
        Text {
            format: Some(Format::Email),
            max: Some(255),
            ..Text::default()
        },
    );
    issues.text(body, "channel", opt, None, Some(30));
    issues.text(body, "status", opt, None, Some(30));
    issues.text(body, "assigneeId", nullish, None, None);
    issues.text(body, "departmentId", nullish, None, None);
    issues.list(body, "tags", opt, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
}

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create conversation";
    let data = match read_body(&headers, &body, |issues, fields| {
        conversation_schema(issues, fields, false);
        fields.clone()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let id = generate_id("conv");
    let now = now();
    let mut values = Map::new();
    CONV.set(&mut values, "id", json!(id));
    values.extend(CONV.values(&data));
    CONV.set(&mut values, "createdAt", json!(now));
    CONV.set(&mut values, "updatedAt", json!(now));
    let mut trusted = vec!["createdAt", "updatedAt"];
    if !data.contains_key("id") {
        trusted.push("id");
    }
    if let Err(error) = CONV.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, MESSAGE);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for key in [
        "conversationNumber",
        "subject",
        "status",
        "priority",
        "assigneeId",
        "contactId",
        "departmentId",
    ] {
        if let Some(value) = data.get(key) {
            event.insert(key.to_owned(), value.clone());
        }
    }
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_CREATED,
        &id,
        Value::Object(event),
    );
    let as_value = Value::Object(data.clone());
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: text(&as_value, "assigneeId").map(str::to_owned),
            previous: None,
            kind: EntityKind::Conversation,
            entity_id: id.clone(),
            subject: text(&as_value, "subject").map(str::to_owned),
            reference: text(&as_value, "conversationNumber").map(str::to_owned),
            by: Some(caller.user_id.clone()),
        },
    );
    Created(json!({ "id": id })).into_response()
}

/// `(update.f as T | null | undefined) ?? existing.f`.
fn or_existing(update: &Map<String, Value>, existing: &Value, prop: &str, column: &str) -> Value {
    update
        .get(column)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| existing[prop].clone())
}

async fn update_conversation(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update conversation";
    let data = match read_body(&headers, &body, |issues, fields| {
        conversation_schema(issues, fields, true);
        fields.clone()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let existing = match load(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let mut values = Map::new();
    CONV.set(&mut values, "updatedAt", json!(now()));
    values.extend(CONV.values(&data));
    let mut trusted = vec![];
    if !data.contains_key("updatedAt") {
        trusted.push("updatedAt");
    }
    if let Some(Value::String(status)) = data.get("status") {
        status_derived(&mut values, status);
        trusted.push("snoozedUntil");
        if let Some(archived) = data.get("isArchived") {
            CONV.set(&mut values, "isArchived", archived.clone());
        }
    }
    if let Err(error) = CONV
        .patch(&caller.db, &id, values.clone(), true, &trusted)
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let event = json!({
        "id": id,
        "conversationNumber": existing["conversationNumber"],
        "subject": or_existing(&values, &existing, "subject", "subject"),
        "status": or_existing(&values, &existing, "status", "status"),
        "priority": or_existing(&values, &existing, "priority", "priority"),
        "assigneeId": or_existing(&values, &existing, "assigneeId", "assignee_id"),
        "contactId": existing["contactId"],
        "departmentId": or_existing(&values, &existing, "departmentId", "department_id"),
    });
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        event,
    );
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: values
                .get("assignee_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            previous: text(&existing, "assigneeId").map(str::to_owned),
            kind: EntityKind::Conversation,
            entity_id: id.clone(),
            subject: or_existing(&values, &existing, "subject", "subject")
                .as_str()
                .map(str::to_owned),
            reference: text(&existing, "conversationNumber").map(str::to_owned),
            by: Some(caller.user_id.clone()),
        },
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const MESSAGE: &str = "Failed to delete conversation";
    let existing = match load(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    if let Err(error) = soft_delete(&caller.db, CONV, &id).await {
        return write_failed(&error, MESSAGE);
    }
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_DELETED,
        &id,
        json!({
            "id": id,
            "conversationNumber": existing["conversationNumber"],
            "subject": existing["subject"],
            "status": existing["status"],
        }),
    );
    NoContent.into_response()
}

// ── sub-actions ─────────────────────────────────────────────────────────────

/// Load the live conversation, or answer the route's 404 / 500.
#[allow(clippy::result_large_err)] // the response is the route's answer
async fn existing(caller: &Caller, id: &str, message: &str) -> Result<Value, Response> {
    match load(&caller.db, id).await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(Refusal::not_found("Conversation", id).respond(message)),
        Err(error) => Err(Refusal::from(error).respond(message)),
    }
}

/// Run the update, answering the route's 500 on failure.
#[allow(clippy::result_large_err)] // the response is the route's answer
async fn changed(
    caller: &Caller,
    id: &str,
    values: Map<String, Value>,
    message: &str,
) -> Result<Value, Response> {
    match patch_live(&caller.db, id, values).await {
        Ok(Some(row)) => Ok(row),
        // The row vanished between the read and the write: Drizzle's
        // `[conv]` is undefined, and reading it throws (the route's 500).
        Ok(None) => Err(weldsuite_kit::ApiError::internal()
            .with_message(message)
            .into_response()),
        Err(error) => Err(write_failed(&error, message)),
    }
}

async fn set_status(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update status";
    let status = match read_body(&headers, &body, |issues, fields| {
        issues
            .text(fields, "status", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(status) => status,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let now = now();
    let mut values = Map::new();
    CONV.set(&mut values, "status", json!(status));
    CONV.set(&mut values, "updatedAt", json!(now));
    status_derived(&mut values, &status);
    if status == "resolved" {
        CONV.set(&mut values, "resolvedAt", json!(now));
    }
    if status == "closed" {
        CONV.set(&mut values, "closedAt", json!(now));
    }
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    let event = match status.as_str() {
        "closed" => ev::HELPDESK_CONVERSATION_CLOSED,
        "resolved" => ev::HELPDESK_CONVERSATION_RESOLVED,
        _ => ev::HELPDESK_CONVERSATION_UPDATED,
    };
    publish(
        &state,
        &caller,
        event,
        &id,
        json!({ "id": id, "status": status }),
    );
    if status == "closed" || status == "resolved" {
        publish_realtime(&state, vec![closed_message(&id, &caller.user_id, &now)]);
        archive_discord_thread(&state, &caller, &conv);
    }
    Data(json!({
        "id": conv["id"],
        "status": conv["status"],
        "isArchived": conv["isArchived"],
        "snoozedUntil": conv["snoozedUntil"],
        "updatedAt": conv["updatedAt"],
    }))
    .into_response()
}

async fn close(State(state): State<DeskState>, caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to close conversation";
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let now = now();
    let mut values = Map::new();
    CONV.set(&mut values, "status", json!("closed"));
    CONV.set(&mut values, "closedAt", json!(now));
    CONV.set(&mut values, "updatedAt", json!(now));
    status_derived(&mut values, "closed");
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_CLOSED,
        &id,
        json!({ "id": id, "status": "closed" }),
    );
    publish_realtime(&state, vec![closed_message(&id, &caller.user_id, &now)]);
    archive_discord_thread(&state, &caller, &conv);
    Data(json!({ "id": conv["id"], "status": conv["status"], "updatedAt": conv["updatedAt"] }))
        .into_response()
}

/// A `{ <key>: boolean }` sub-action body.
fn flag_body(headers: &HeaderMap, body: &Bytes, key: &str) -> Result<bool, Refusal> {
    read_body(headers, body, |issues, fields| {
        issues
            .boolean(fields, key, Presence::Required)
            .into_option()
            .unwrap_or(false)
    })
}

async fn set_read(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update read status";
    let is_read = match flag_body(&headers, &body, "isRead") {
        Ok(flag) => flag,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let mut values = Map::new();
    CONV.set(&mut values, "isRead", json!(is_read));
    if is_read {
        CONV.set(&mut values, "unreadCount", json!(0));
    }
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id }),
    );
    Data(json!({
        "id": conv["id"],
        "isRead": conv["isRead"],
        "unreadCount": conv["unreadCount"],
        "updatedAt": conv["updatedAt"],
    }))
    .into_response()
}

async fn set_star(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update star";
    let starred = match flag_body(&headers, &body, "isStarred") {
        Ok(flag) => flag,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let mut values = Map::new();
    CONV.set(&mut values, "isStarred", json!(starred));
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id }),
    );
    Data(
        json!({ "id": conv["id"], "isStarred": conv["isStarred"], "updatedAt": conv["updatedAt"] }),
    )
    .into_response()
}

async fn set_archive(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to archive conversation";
    let archived = match flag_body(&headers, &body, "isArchived") {
        Ok(flag) => flag,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let mut values = Map::new();
    CONV.set(&mut values, "isArchived", json!(archived));
    CONV.set(
        &mut values,
        "status",
        json!(if archived { "archived" } else { "active" }),
    );
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "status": conv["status"] }),
    );
    Data(json!({
        "id": conv["id"],
        "isArchived": conv["isArchived"],
        "status": conv["status"],
        "updatedAt": conv["updatedAt"],
    }))
    .into_response()
}

async fn set_priority(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update priority";
    let priority = match read_body(&headers, &body, |issues, fields| {
        issues
            .text(fields, "priority", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(priority) => priority,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let mut values = Map::new();
    CONV.set(&mut values, "priority", json!(priority));
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "priority": priority }),
    );
    Data(json!({ "id": conv["id"], "priority": conv["priority"], "updatedAt": conv["updatedAt"] }))
        .into_response()
}

/// `{ id, assigneeId, assigneeName, updatedAt }` of a row (fields of a
/// missing row are left out).
fn assignment_answer(id: &str, row: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(id));
    if let Some(row) = row {
        for key in ["assigneeId", "assigneeName", "updatedAt"] {
            out.insert(key.to_owned(), row[key].clone());
        }
    }
    Value::Object(out)
}

#[allow(clippy::too_many_lines)] // the route is one long handler in TypeScript too
async fn assign(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to assign conversation";
    let (assignee, name, avatar) = match read_body(&headers, &body, |issues, fields| {
        let assignee = issues.text(fields, "assigneeId", Presence::Required, None, None);
        let name = issues.text(fields, "assigneeName", Presence::Optional, None, None);
        let avatar = issues.text(fields, "assigneeAvatar", Presence::Optional, None, None);
        (
            assignee.into_option().unwrap_or_default(),
            name.into_option(),
            avatar.into_option(),
        )
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let current = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if current["assigneeId"].as_str() == Some(assignee.as_str()) {
        return Data(assignment_answer(&id, Some(&current))).into_response();
    }
    let name = name.filter(|n| !n.is_empty());
    let avatar = avatar.filter(|a| !a.is_empty());
    let mut update =
        convs::Entity::update_many().col_expr(convs::Column::AssigneeId, Expr::value(&assignee));
    if let Some(name) = &name {
        update = update.col_expr(convs::Column::AssigneeName, Expr::value(name));
    }
    if let Some(avatar) = &avatar {
        update = update.col_expr(convs::Column::AssigneeAvatar, Expr::value(avatar));
    }
    let updated = update
        .col_expr(convs::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(convs::Column::Id.eq(&id))
        .filter(convs::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(convs::Column::AssigneeId.is_null())
                .add(convs::Column::AssigneeId.ne(&assignee)),
        )
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js).transpose());
    let conv = match updated {
        Ok(Some(row)) => row,
        Ok(None) => {
            return match load(&caller.db, &id).await {
                Ok(row) => Data(assignment_answer(&id, row.as_ref())).into_response(),
                Err(error) => Refusal::from(error).respond(MESSAGE),
            };
        }
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let agent_name = name.clone().unwrap_or_else(|| "Agent".to_owned());
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: Some(assignee.clone()),
            previous: text(&current, "assigneeId").map(str::to_owned),
            kind: EntityKind::Conversation,
            entity_id: id.clone(),
            subject: text(&conv, "subject").map(str::to_owned),
            reference: text(&conv, "conversationNumber").map(str::to_owned),
            by: Some(caller.user_id.clone()),
        },
    );
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_ASSIGNED,
        &id,
        json!({ "id": id, "assigneeId": assignee }),
    );
    // `createAgentJoinedMessage`: persisted so it survives a refresh.
    let message_id = generate_id("msg");
    let joined_at = now();
    let content = format!("{agent_name} has joined the conversation");
    let table = &HELPDESK_CONVERSATION_MESSAGES;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(message_id));
    table.set(&mut values, "conversationId", json!(id));
    table.set(&mut values, "authorId", json!(assignee));
    table.set(&mut values, "authorName", json!(agent_name));
    table.set(&mut values, "authorType", json!("system"));
    table.set(&mut values, "content", json!(content));
    table.set(&mut values, "type", json!("system"));
    table.set(&mut values, "isPublic", json!(true));
    table.set(&mut values, "isInternal", json!(false));
    table.set(&mut values, "status", json!("sent"));
    table.set(&mut values, "isRead", json!(true));
    table.set(&mut values, "metadata", json!({ "systemEvent": true }));
    table.set(&mut values, "createdAt", json!(joined_at));
    table.set(&mut values, "updatedAt", json!(joined_at));
    if let Err(error) = table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let assigned_data = defined(&[
        ("agentId", Some(json!(assignee))),
        ("agentName", Some(json!(agent_name))),
        ("agentAvatar", avatar.map(|a| json!(a))),
        ("assignedAt", Some(json!(joined_at))),
    ]);
    publish_realtime(
        &state,
        vec![
            conversation_system(&id, "agent_assigned", assigned_data),
            conversation_message(
                &id,
                &message_id,
                &content,
                &assignee,
                &agent_name,
                "system",
                None,
            ),
        ],
    );
    Data(assignment_answer(&id, Some(&conv))).into_response()
}

#[allow(clippy::too_many_lines)] // the route is one long handler in TypeScript too
async fn assign_team(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to assign conversation to team";
    let (department, assignee, name) = match read_body(&headers, &body, |issues, fields| {
        let department = issues.text(fields, "departmentId", Presence::Required, None, None);
        let assignee = issues.text(fields, "assigneeId", Presence::Nullish, None, None);
        let name = issues.text(fields, "assigneeName", Presence::Nullish, None, None);
        (
            department.into_option().unwrap_or_default(),
            assignee.into_option(),
            name.into_option(),
        )
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let current = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let explicit = assignee.clone().filter(|a| !a.is_empty());
    let mut values = Map::new();
    CONV.set(&mut values, "departmentId", json!(department));
    CONV.set(&mut values, "updatedAt", json!(now()));
    if let Some(explicit) = &explicit {
        CONV.set(&mut values, "assigneeId", json!(explicit));
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            CONV.set(&mut values, "assigneeName", json!(name));
        }
    } else {
        CONV.set(&mut values, "assigneeId", Value::Null);
        CONV.set(&mut values, "assigneeName", Value::Null);
    }
    if let Err(error) = patch_live(&caller.db, &id, values).await {
        return write_failed(&error, MESSAGE);
    }
    let auto = if explicit.is_none() {
        match crate::assignment::auto_assign(&caller.db, &department, &id).await {
            Ok(auto) => auto,
            Err(error) => return Refusal::from(error).respond(MESSAGE),
        }
    } else {
        None
    };
    let conv = match load(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "departmentId": department, "assigneeId": conv["assigneeId"] }),
    );
    // `body.assigneeId ?? autoAssigned?.assigneeId`.
    let notify_to = assignee
        .clone()
        .or_else(|| auto.as_ref().map(|a| a.0.clone()));
    let by = if explicit.is_some() || auto.as_ref().is_some_and(|a| a.0 == caller.user_id) {
        Some(caller.user_id.clone())
    } else {
        None
    };
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: notify_to,
            previous: text(&current, "assigneeId").map(str::to_owned),
            kind: EntityKind::Conversation,
            entity_id: id.clone(),
            subject: text(&conv, "subject").map(str::to_owned),
            reference: text(&conv, "conversationNumber").map(str::to_owned),
            by,
        },
    );
    Data(json!({
        "id": conv["id"],
        "departmentId": conv["departmentId"],
        "assigneeId": conv["assigneeId"],
        "assigneeName": conv["assigneeName"],
        "autoAssigned": auto.is_some(),
        "updatedAt": conv["updatedAt"],
    }))
    .into_response()
}

#[allow(clippy::too_many_lines)] // the route is one long handler in TypeScript too
async fn convert_to_ticket(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to convert to ticket";
    let (subject_in, priority_in, assignee_in) =
        match read_body(&headers, &body, |issues, fields| {
            let opt = Presence::Optional;
            let subject = issues.text(fields, "subject", opt, None, None);
            let priority = issues.text(fields, "priority", opt, None, None);
            let assignee = issues.text(fields, "assigneeId", opt, None, None);
            (
                subject.into_option(),
                priority.into_option(),
                assignee.into_option(),
            )
        }) {
            Ok(read) => read,
            Err(refusal) => return refusal.respond(MESSAGE),
        };
    let row = WithContact::query()
        .filter(convs::Column::Id.eq(&id))
        .filter(convs::Column::DeletedAt.is_null())
        .limit(1)
        .into_model::<WithContact>()
        .one(&orm(&caller.db))
        .await
        .and_then(|row| {
            row.map(|row| {
                Ok((
                    js(row.conversation)?,
                    row.contact_full_name,
                    row.contact_email,
                ))
            })
            .transpose()
        });
    let (conv, contact_name, contact_email) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let ticket_id = generate_id("tkt");
    let ticket_number = format!("TKT-{}", base36_now());
    let now = now();
    let first = |a: Option<&str>, b: Option<&str>| {
        a.filter(|v| !v.is_empty())
            .or(b.filter(|v| !v.is_empty()))
            .map(str::to_owned)
    };
    let subject = first(subject_in.as_deref(), text(&conv, "subject"))
        .unwrap_or_else(|| conv["subject"].as_str().unwrap_or_default().to_owned());
    let priority = first(priority_in.as_deref(), text(&conv, "priority"))
        .unwrap_or_else(|| "normal".to_owned());
    // `contactName || conv.customerName`.
    let customer_name = first(contact_name.as_deref(), text(&conv, "customerName"))
        .map_or_else(|| conv["customerName"].clone(), |n| json!(n));
    let customer_email =
        first(contact_email.as_deref(), text(&conv, "customerEmail")).unwrap_or_default();
    let assignee = first(assignee_in.as_deref(), text(&conv, "assigneeId"))
        .map_or_else(|| conv["assigneeId"].clone(), |a| json!(a));
    let table = &HELPDESK_TICKETS;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(ticket_id));
    table.set(&mut values, "ticketNumber", json!(ticket_number));
    table.set(&mut values, "subject", json!(subject));
    table.set(
        &mut values,
        "description",
        json!(
            text(&conv, "lastMessage")
                .filter(|m| !m.is_empty())
                .unwrap_or_default()
        ),
    );
    table.set(&mut values, "priority", json!(priority));
    table.set(&mut values, "status", json!("open"));
    table.set(&mut values, "category", json!("general_inquiry"));
    table.set(&mut values, "channel", conv["channel"].clone());
    table.set(&mut values, "customerEmail", json!(customer_email));
    table.set(&mut values, "customerName", customer_name.clone());
    table.set(&mut values, "contactId", conv["contactId"].clone());
    table.set(&mut values, "assigneeId", assignee);
    table.set(&mut values, "departmentId", conv["departmentId"].clone());
    table.set(
        &mut values,
        "tags",
        if js_truthy(&conv["tags"]) {
            conv["tags"].clone()
        } else {
            json!([])
        },
    );
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let name_text = customer_name.as_str().unwrap_or_default().to_owned();
    let link = Link {
        conversation_id: &id,
        ticket_id: &ticket_id,
        ticket_number: &ticket_number,
        subject: &subject,
        priority: Some(&priority),
        customer_name: &name_text,
        customer_email: &customer_email,
        contact_id: text(&conv, "contactId"),
        now: &now,
    };
    link_conversation_to_ticket(&state, &caller.db, &link).await;
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: assignee_in.clone(),
            previous: text(&conv, "assigneeId").map(str::to_owned),
            kind: EntityKind::Ticket,
            entity_id: ticket_id.clone(),
            subject: Some(subject.clone()),
            reference: Some(ticket_number.clone()),
            by: Some(caller.user_id.clone()),
        },
    );
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({
            "id": id,
            "conversationNumber": conv["conversationNumber"],
            "subject": conv["subject"],
            "status": conv["status"],
        }),
    );
    publish(
        &state,
        &caller,
        ev::TICKET_CREATED,
        &ticket_id,
        json!({
            "id": ticket_id,
            "ticketNumber": ticket_number,
            "subject": subject,
            "status": "open",
            "priority": priority,
            "departmentId": conv["departmentId"],
        }),
    );
    Created(json!({
        "id": ticket_id,
        "ticketNumber": ticket_number,
        "subject": subject,
        "status": "open",
        "priority": priority,
        "conversationId": id,
        "createdAt": now,
    }))
    .into_response()
}

async fn snooze(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to snooze conversation";
    let (until, status) = match read_body(&headers, &body, |issues, fields| {
        let until = issues.text(fields, "snoozedUntil", Presence::Nullable, None, None);
        let status = issues.text(fields, "status", Presence::Optional, None, None);
        (until.into_option(), status.into_option())
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let status = status
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "snoozed".to_owned());
    // `new Date(snoozedUntil)`: an Invalid Date makes Drizzle's toISOString throw.
    let until = match until.filter(|u| !u.is_empty()) {
        Some(text) => match js_date_iso(&text) {
            Some(iso) => json!(iso),
            None => {
                return weldsuite_kit::ApiError::internal()
                    .with_message(MESSAGE)
                    .into_response();
            }
        },
        None => Value::Null,
    };
    let mut values = Map::new();
    CONV.set(&mut values, "snoozedUntil", until);
    CONV.set(&mut values, "status", json!(status));
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "status": status }),
    );
    Data(json!({
        "id": conv["id"],
        "snoozedUntil": conv["snoozedUntil"],
        "status": conv["status"],
        "updatedAt": conv["updatedAt"],
    }))
    .into_response()
}

async fn set_tags(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update tags";
    let (tags, tag, action) = match read_body(&headers, &body, |issues, fields| {
        let opt = Presence::Optional;
        let tags = issues.list(fields, "tags", opt, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        });
        let tag = issues.text(fields, "tag", opt, None, None);
        let action = issues.choice(fields, "action", opt, &["add", "remove"]);
        (tags.into_option(), tag.into_option(), action.into_option())
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let current = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let existing_tags: Vec<Value> = current["tags"].as_array().cloned().unwrap_or_default();
    let next: Vec<Value> = match (action.as_deref(), tag.filter(|t| !t.is_empty()), tags) {
        (Some("remove"), Some(tag), _) => existing_tags
            .into_iter()
            .filter(|t| t != &json!(tag))
            .collect(),
        (Some("add"), _, Some(tags)) => {
            let mut merged = existing_tags;
            for tag in tags {
                let tag = json!(tag);
                if !merged.contains(&tag) {
                    merged.push(tag);
                }
            }
            merged
        }
        (_, _, Some(tags)) => tags.into_iter().map(Value::String).collect(),
        _ => existing_tags,
    };
    let mut values = Map::new();
    CONV.set(&mut values, "tags", Value::Array(next));
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id }),
    );
    let tags = if js_truthy(&conv["tags"]) {
        conv["tags"].clone()
    } else {
        json!([])
    };
    Data(json!({ "id": conv["id"], "tags": tags, "updatedAt": conv["updatedAt"] })).into_response()
}

async fn set_contact(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update contact";
    let contact = match read_body(&headers, &body, |issues, fields| {
        issues
            .text(fields, "contactId", Presence::Nullable, None, None)
            .into_option()
    }) {
        Ok(contact) => contact,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let mut values = Map::new();
    CONV.set(&mut values, "contactId", json!(contact));
    CONV.set(&mut values, "updatedAt", json!(now()));
    let conv = match changed(&caller, &id, values, MESSAGE).await {
        Ok(conv) => conv,
        Err(response) => return response,
    };
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "contactId": contact }),
    );
    Data(
        json!({ "id": conv["id"], "contactId": conv["contactId"], "updatedAt": conv["updatedAt"] }),
    )
    .into_response()
}

async fn auto_link_contact(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to auto-link contact";
    let (email, name, phone) = match read_body(&headers, &body, |issues, fields| {
        let email = issues.text_with(
            fields,
            "email",
            Presence::Required,
            Text {
                format: Some(Format::Email),
                ..Text::default()
            },
        );
        let name = issues.text(fields, "name", Presence::Optional, None, None);
        let phone = issues.text(fields, "phone", Presence::Optional, None, None);
        (
            email.into_option().unwrap_or_default(),
            name.into_option(),
            phone.into_option(),
        )
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    match exists(&caller.db, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Conversation", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    }
    let found: Result<Option<String>, DbErr> = people::Entity::find()
        .select_only()
        .column(people::Column::Id)
        .filter(people::Column::Email.eq(&email))
        .filter(people::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let contact_id = match found {
        Ok(Some(found)) => found,
        Ok(None) => {
            let contact_id = generate_id("cont");
            let full_name = name
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| email.split('@').next().unwrap_or_default().to_owned());
            let parts: Vec<&str> = full_name.split(' ').collect();
            let first = parts
                .first()
                .copied()
                .filter(|p| !p.is_empty())
                .unwrap_or(&full_name);
            let last = if parts.len() > 1 {
                parts[1..].join(" ")
            } else {
                String::new()
            };
            let now = now();
            let mut values = Map::new();
            PEOPLE.set(&mut values, "id", json!(contact_id));
            PEOPLE.set(&mut values, "firstName", json!(first));
            PEOPLE.set(&mut values, "lastName", json!(last));
            PEOPLE.set(&mut values, "fullName", json!(full_name));
            PEOPLE.set(&mut values, "displayName", json!(full_name));
            PEOPLE.set(&mut values, "email", json!(email));
            PEOPLE.set(
                &mut values,
                "directPhone",
                json!(phone.filter(|p| !p.is_empty())),
            );
            PEOPLE.set(&mut values, "status", json!("active"));
            PEOPLE.set(&mut values, "inCrm", json!(false));
            PEOPLE.set(&mut values, "createdAt", json!(now));
            PEOPLE.set(&mut values, "updatedAt", json!(now));
            if let Err(error) = PEOPLE
                .insert(&caller.db, values, &["createdAt", "updatedAt"])
                .await
            {
                return write_failed(&error, MESSAGE);
            }
            contact_id
        }
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let linked = convs::Entity::update_many()
        .col_expr(convs::Column::ContactId, Expr::value(&contact_id))
        .col_expr(convs::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(convs::Column::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = linked {
        return Refusal::from(error).respond(MESSAGE);
    }
    publish(
        &state,
        &caller,
        ev::HELPDESK_CONVERSATION_UPDATED,
        &id,
        json!({ "id": id, "contactId": contact_id }),
    );
    Data(json!({ "contactId": contact_id })).into_response()
}

#[cfg(test)]
mod scratch_sql {
    use super::*;
    use sea_orm::{DbBackend, QueryTrait};

    #[test]
    fn print_sql() {
        let filters = list_filters(Some("search=ab&myConversations=true&isRead=false"), "u1");
        let page = WithContact::query().filter(filters.clone()).order_by_desc(convs::Column::CreatedAt).limit(26);
        println!("{}", page.build(DbBackend::Postgres).to_string());
        let count = |condition: Condition| Expr::from(Func::count(Expr::case(condition, 1)));
        let q = convs::Entity::find().select_only().column_as(count(Condition::all().add(convs::Column::IsRead.eq(false)).add(Condition::any().add(convs::Column::AssigneeId.is_null()).add(convs::Column::AssigneeId.eq("u1")))), "all").filter(convs::Column::DeletedAt.is_null());
        println!("{}", q.build(DbBackend::Postgres).to_string());
        let u = convs::Entity::update_many().col_expr(convs::Column::MessageCount, sea_orm::ExprTrait::add(Expr::col(convs::Column::MessageCount), 1)).filter(convs::Column::Id.eq("x"));
        println!("{}", u.build(DbBackend::Postgres).to_string());
    }
}
