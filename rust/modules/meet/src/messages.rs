//! `/api/meeting-messages` (`routes/meeting-messages/index.ts`): the
//! in-meeting chat (list, pinned, send, pin, unpin, delete own) and the
//! generic read and patch.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    MEETING_MESSAGE_CREATED, MEETING_MESSAGE_DELETED, MEETING_MESSAGE_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::meeting_messages::{self, Column as Message};
use weldsuite_schema::tenant::{meetings, workspace_members};

use crate::js::{js_limit, query_param, text};
use crate::sessions::{before, limit_of, page_and_count, page_of};
use crate::table::{js_instant, now_both, row_json};
use crate::tables::MEETING_MESSAGES;
use crate::{Caller, MeetState, internal, now, publish, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("meetings:read")))
        .route("/pinned", get(pinned).route_layer(need("meetings:read")))
        .route("/", post(send).route_layer(need("sessions:create")))
        .route("/{id}/pin", post(pin).route_layer(need("sessions:create")))
        .route(
            "/{id}/pin",
            delete(unpin).route_layer(need("sessions:create")),
        )
        .route("/{id}", delete(remove).route_layer(need("sessions:create")))
        .route("/{id}", get(detail).route_layer(need("meetings:read")))
        .route("/{id}", patch(update).route_layer(need("meetings:update")))
        .route(
            "/{id}/_generic",
            delete(remove_generic).route_layer(need("meetings:delete")),
        )
}

/// Messages as Drizzle's `select()` returned them.
fn js_rows(rows: Vec<meeting_messages::Model>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter().map(row_json).collect()
}

/// The `createdAt` of message `id` as JavaScript read it, and its id.
async fn created_at(db: &PgPool, id: &str) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = meeting_messages::Entity::find()
        .select_only()
        .columns([Message::CreatedAt, Message::Id])
        .filter(Message::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(at, id)| (js_instant(at), id)))
}

/// `and(eq(id, $id), [eq(meetingId, $meeting) when given])`.
fn message_in(id: &str, meeting: &str) -> sea_orm::Condition {
    let condition = sea_orm::Condition::all().add(Message::Id.eq(id));
    if meeting.is_empty() {
        condition
    } else {
        condition.add(Message::MeetingId.eq(meeting))
    }
}

// ── GET / ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let meeting = query_param(query, "meetingId").filter(|m| !m.is_empty());
    let Some(meeting) = meeting else {
        return list_all(&caller, query).await;
    };
    let before = query_param(query, "before").filter(|b| !b.is_empty());
    let limit = js_limit(query_param(query, "limit").as_deref(), 50.0, 100.0);
    match meeting_chat(&caller.db, &meeting, before.as_deref(), limit).await {
        Ok(answer) => Data(answer).into_response(),
        Err(error) => internal(&error, "Failed to fetch meeting messages"),
    }
}

/// `listMeetingChat(c, meetingId, before, limit)`.
async fn meeting_chat(
    db: &PgPool,
    meeting: &str,
    before: Option<&str>,
    limit: f64,
) -> Result<Value, DbErr> {
    let cursor = match before {
        Some(before) => created_at(db, before).await?.map(|(at, _)| at),
        None => None,
    };
    let mut page = meeting_messages::Entity::find()
        .filter(Message::MeetingId.eq(meeting))
        .filter(Message::DeletedAt.is_null());
    if let Some(at) = cursor {
        page = page.filter(Message::CreatedAt.lt(at));
    }
    let rows = page
        .order_by_desc(Message::CreatedAt)
        .limit(limit_of(limit + 1.0))
        .all(&orm(db))
        .await?;
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let rows = js_rows(rows)?;
    let data = if has_more {
        #[allow(clippy::cast_possible_truncation)]
        crate::js::js_slice(rows, limit as i64)
    } else {
        rows
    };
    let next = if has_more {
        data.last().and_then(|r| text(r, "id")).map(str::to_owned)
    } else {
        None
    };
    let messages: Vec<Value> = data
        .into_iter()
        .map(|mut m| {
            let html = m
                .get("metadata")
                .and_then(|meta| meta.get("htmlContent"))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null);
            m["htmlContent"] = html;
            m
        })
        .collect();
    Ok(json!({ "messages": messages, "hasMore": has_more, "nextCursor": next }))
}

/// `listAllMessages(c, q)`: newest first, an optional author, a keyset cursor.
async fn list_all(caller: &Caller, query: Option<&str>) -> Response {
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let author = query_param(query, "authorId").filter(|a| !a.is_empty());
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row = match &cursor {
        Some(cursor) => match created_at(db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "meet: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    // Conditions: live, author, cursor; a `?cursor=` makes the count drop the last.
    let (page, count) = page_and_count(
        vec![
            Some(sea_orm::Condition::all().add(Message::DeletedAt.is_null())),
            author.map(|author| sea_orm::Condition::all().add(Message::AuthorId.eq(author))),
            cursor_row
                .as_ref()
                .map(|row| before(Message::CreatedAt, Message::Id, row)),
        ],
        cursor.is_some(),
    );
    let db = &orm(db);
    let rows = meeting_messages::Entity::find()
        .filter(page)
        .order_by_desc(Message::CreatedAt)
        .order_by_desc(Message::Id)
        .limit(limit_of(limit + 1.0))
        .all(db)
        .await
        .and_then(js_rows);
    let total = meeting_messages::Entity::find().filter(count).count(db).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_of(rows, limit, i64::try_from(total).unwrap_or(i64::MAX)),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list meeting messages"),
    }
}

// ── GET /pinned ────────────────────────────────────────────────────────────

async fn pinned(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let Some(meeting) = query_param(query.as_deref(), "meetingId").filter(|m| !m.is_empty()) else {
        return ApiError::bad_request("meetingId query parameter is required").into_response();
    };
    let rows = meeting_messages::Entity::find()
        .filter(Message::MeetingId.eq(&meeting))
        .filter(Message::DeletedAt.is_null())
        .filter(Message::PinnedAt.is_not_null())
        .order_by_desc(Message::PinnedAt)
        .limit(50)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match rows {
        Ok(messages) => Data(json!({ "messages": messages })).into_response(),
        Err(error) => internal(&error, "Failed to fetch pinned messages"),
    }
}

// ── POST / ─────────────────────────────────────────────────────────────────

/// The send body, as the schema let it through.
struct SendBody {
    meeting_id: String,
    content: String,
    html: Option<String>,
    attachments: Option<Vec<Value>>,
}

fn read_attachment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let id = issues
        .text(fields, "id", Presence::Required, None, None)
        .into_option();
    let name = issues
        .text(fields, "fileName", Presence::Required, None, None)
        .into_option();
    let size = issues
        .number(fields, "fileSize", Presence::Required, Number::default())
        .into_option();
    let mime = issues
        .text(fields, "mimeType", Presence::Required, None, None)
        .into_option();
    let url = issues
        .text(fields, "url", Presence::Required, None, None)
        .into_option();
    let thumbnail = issues
        .text(fields, "thumbnailUrl", Presence::Optional, None, None)
        .into_option();
    if issues.count() > before {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("fileName".into(), json!(name));
    out.insert(
        "fileSize".into(),
        fields.get("fileSize").cloned().unwrap_or(json!(size)),
    );
    out.insert("mimeType".into(), json!(mime));
    out.insert("url".into(), json!(url));
    if let Some(thumbnail) = thumbnail {
        out.insert("thumbnailUrl".into(), json!(thumbnail));
    }
    Some(Value::Object(out))
}

async fn send(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = validate(&headers, &body, |issues, fields| {
        let meeting = issues
            .text_with(
                fields,
                "meetingId",
                Presence::Required,
                Text::length(Some(1), None),
            )
            .into_option();
        let content = issues
            .text(fields, "content", Presence::Required, None, None)
            .into_option();
        let html = issues
            .text(
                fields,
                "htmlContent",
                Presence::Optional,
                None,
                Some(20_000),
            )
            .into_option();
        let attachments = issues
            .list(
                fields,
                "attachments",
                Presence::Optional,
                None,
                None,
                read_attachment,
            )
            .into_option();
        // `.refine(...)` runs once the object itself parsed.
        if issues.is_empty() {
            let has_content = content.as_deref().is_some_and(|c| !c.is_empty());
            let has_attachments = attachments.as_ref().is_some_and(|a| !a.is_empty());
            if !has_content && !has_attachments {
                issues.custom_root("Message must have content or attachments");
            }
        }
        SendBody {
            meeting_id: meeting.unwrap_or_default(),
            content: content.unwrap_or_default(),
            html,
            attachments,
        }
    });
    let body = match body {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some(_org) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    send_message(&state, &caller, body)
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to send message"))
}

async fn send_message(
    state: &MeetState,
    caller: &Caller,
    body: SendBody,
) -> Result<Response, DbErr> {
    let db = &orm(&caller.db);
    let meeting: Option<String> = meetings::Entity::find()
        .select_only()
        .column(meetings::Column::Id)
        .filter(meetings::Column::Id.eq(&body.meeting_id))
        .into_tuple()
        .one(db)
        .await?;
    if meeting.is_none() {
        return Ok(ApiError::not_found("Meeting", Some(&body.meeting_id)).into_response());
    }
    let name: Option<Option<String>> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.eq(&caller.user_id))
        .into_tuple()
        .one(db)
        .await?;
    let name = name.flatten();
    // The avatar is the account picture, not the member row's copy.
    let picture =
        weldsuite_db::load_account_picture(caller.request_master(), &caller.user_id).await;
    let author_name = name.unwrap_or_else(|| "Unknown".to_owned());
    let id = generate_id("mmsg");
    let (now, stamp) = now_both();
    let has_attachments = body.attachments.as_ref().is_some_and(|a| !a.is_empty());
    let metadata = body
        .html
        .as_ref()
        .filter(|h| !h.is_empty())
        .map(|html| json!({ "htmlContent": html }));
    let message = meeting_messages::ActiveModel {
        id: Set(id.clone()),
        meeting_id: Set(body.meeting_id.clone()),
        author_id: Set(caller.user_id.clone()),
        author_name: Set(author_name.clone()),
        author_avatar: Set(picture.clone()),
        content: Set(body.content.clone()),
        attachments: Set(body.attachments.clone().map(Value::Array)),
        has_attachments: Set(has_attachments),
        metadata: Set(metadata.clone()),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    };
    meeting_messages::Entity::insert(message)
        .exec_without_returning(db)
        .await?;
    let message = json!({
        "id": id,
        "meetingId": body.meeting_id,
        "authorId": caller.user_id,
        "authorName": author_name,
        "authorAvatar": picture,
        "content": body.content,
        "htmlContent": body.html,
        "type": "message",
        "attachments": body.attachments,
        "hasAttachments": has_attachments,
        "createdAt": now,
        "updatedAt": now,
        "deletedAt": null,
        "metadata": metadata,
    });
    let mut realtime = Map::new();
    realtime.insert("id".into(), json!(id));
    realtime.insert("content".into(), json!(body.content));
    if let Some(html) = &body.html {
        realtime.insert("htmlContent".into(), json!(html));
    }
    realtime.insert("senderId".into(), json!(caller.user_id));
    realtime.insert("senderName".into(), json!(author_name));
    if let Some(picture) = &picture {
        realtime.insert("senderAvatar".into(), json!(picture));
    }
    if let Some(attachments) = &body.attachments {
        let mapped: Vec<Value> = attachments
            .iter()
            .map(|a| {
                json!({
                    "id": a["id"],
                    "name": a["fileName"],
                    "url": a["url"],
                    "type": a["mimeType"],
                    "size": a["fileSize"],
                })
            })
            .collect();
        realtime.insert("attachments".into(), Value::Array(mapped));
    }
    publish::chat_message(state, &body.meeting_id, realtime).await;
    caller.publish(
        state,
        MEETING_MESSAGE_CREATED,
        &id,
        &json!({ "id": id, "meetingId": body.meeting_id, "authorId": caller.user_id, "type": "message" }),
    );
    Ok(Created(message).into_response())
}

// ── pin / unpin / delete ───────────────────────────────────────────────────

async fn pin(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let meeting = query_param(query.as_deref(), "meetingId").unwrap_or_default();
    let result: Result<Response, DbErr> = async {
        let db = &orm(&caller.db);
        let found: Option<String> = meeting_messages::Entity::find()
            .select_only()
            .column(Message::Id)
            .filter(message_in(&id, &meeting))
            .filter(Message::DeletedAt.is_null())
            .into_tuple()
            .one(db)
            .await?;
        if found.is_none() {
            return Ok(ApiError::not_found("Message", Some(&id)).into_response());
        }
        let now = weldsuite_db::utc_now();
        meeting_messages::Entity::update_many()
            .col_expr(Message::PinnedAt, Expr::value(now))
            .col_expr(Message::PinnedBy, Expr::value(caller.user_id.clone()))
            .col_expr(Message::UpdatedAt, Expr::value(now))
            .filter(Message::Id.eq(&id))
            .exec(db)
            .await?;
        Ok(Data(json!({ "pinned": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to pin message"))
}

async fn unpin(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let meeting = query_param(query.as_deref(), "meetingId").unwrap_or_default();
    let result = meeting_messages::Entity::update_many()
        .col_expr(Message::PinnedAt, Expr::value(Option::<PrimitiveDateTime>::None))
        .col_expr(Message::PinnedBy, Expr::value(Option::<String>::None))
        .col_expr(Message::UpdatedAt, Expr::value(weldsuite_db::utc_now()))
        .filter(message_in(&id, &meeting))
        .exec(&orm(&caller.db))
        .await;
    match result {
        Ok(_) => Data(json!({ "pinned": false })).into_response(),
        Err(error) => internal(&error, "Failed to unpin message"),
    }
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    let meeting = query_param(query.as_deref(), "meetingId").unwrap_or_default();
    let result: Result<Response, DbErr> = async {
        let found: Option<(String, String)> = meeting_messages::Entity::find()
            .select_only()
            .columns([Message::AuthorId, Message::MeetingId])
            .filter(message_in(&id, &meeting))
            .filter(Message::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        let Some((author, meeting_id)) = found else {
            return Ok(ApiError::not_found("Message", Some(&id)).into_response());
        };
        if author != caller.user_id {
            return Ok(ApiError::forbidden()
                .with_message("You can only delete your own messages")
                .into_response());
        }
        soft_delete(&caller.db, &id).await?;
        publish::chat_message_deleted(&state, &meeting_id, &id).await;
        caller.publish(&state, MEETING_MESSAGE_DELETED, &id, &json!({ "id": id }));
        Ok(StatusCode::NO_CONTENT.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete message"))
}

/// `deletedAt` and `updatedAt` now on message `id`.
async fn soft_delete(db: &PgPool, id: &str) -> Result<(), DbErr> {
    let now = weldsuite_db::utc_now();
    meeting_messages::Entity::update_many()
        .col_expr(Message::DeletedAt, Expr::value(now))
        .col_expr(Message::UpdatedAt, Expr::value(now))
        .filter(Message::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

// ── generic ────────────────────────────────────────────────────────────────

async fn live_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    meeting_messages::Entity::find_by_id(id.to_owned())
        .filter(Message::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Meeting message", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch meeting message"),
    }
}

async fn update(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `createMeetingMessageSchema.partial()` (passthrough).
    let data = match validate(&headers, &body, |issues, fields| {
        let _ = issues.text(fields, "sessionId", Presence::Nullish, None, None);
        let _ = issues.text(fields, "meetingId", Presence::Nullish, None, None);
        let _ = issues.text(fields, "authorId", Presence::Nullish, None, None);
        let _ = issues.text(fields, "body", Presence::Optional, None, None);
        fields.clone()
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let existing = match live_row(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Meeting message", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to update meeting message"),
    };
    let table = &MEETING_MESSAGES;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(&data));
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    if let Err(error) = table.patch(&caller.db, &id, values, true, trusted).await {
        return internal(&error, "Failed to update meeting message");
    }
    let pick = |key: &str| {
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| existing.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    caller.publish(
        &state,
        MEETING_MESSAGE_UPDATED,
        &id,
        &json!({ "id": id, "meetingId": pick("meetingId"), "authorId": pick("authorId"), "type": pick("type") }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove_generic(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, DbErr> = async {
        if live_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Meeting message", Some(&id)).into_response());
        }
        soft_delete(&caller.db, &id).await?;
        caller.publish(&state, MEETING_MESSAGE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete meeting message"))
}
