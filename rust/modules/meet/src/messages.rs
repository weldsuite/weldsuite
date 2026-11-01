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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MEETING_MESSAGE_CREATED, MEETING_MESSAGE_DELETED, MEETING_MESSAGE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, query_param, sql_limit, text};
use crate::sessions::page_of;
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

fn js_row(row: Value) -> Value {
    MEETING_MESSAGES.js(row)
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
) -> Result<Value, sqlx::Error> {
    let cursor: Option<String> = match before {
        Some(before) => {
            let row: Option<Option<String>> = sqlx::query_scalar(
                "select to_jsonb(t.created_at)#>>'{}' from meeting_messages t where t.id = $1 limit 1",
            )
            .bind(before)
            .fetch_optional(db)
            .await?;
            row.map(|stamp| {
                stamp
                    .and_then(|s| weldsuite_db::js_timestamp(&s))
                    .unwrap_or_default()
            })
        }
        None => None,
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_messages t
         where t.meeting_id = $1 and t.deleted_at is null
           and ($2::text is null or t.created_at < $2::timestamp)
         order by t.created_at desc limit $3",
    )
    .bind(meeting)
    .bind(cursor)
    .bind(sql_limit(limit + 1.0))
    .fetch_all(db)
    .await?;
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
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

const LIST_SQL: &str = "select to_jsonb(t) from meeting_messages t
     where ($1::boolean or t.deleted_at is null) and ($2::boolean or t.author_id = $3)
       and ($4::boolean or t.created_at < $5::timestamp or (t.created_at = $5::timestamp and t.id < $6))
     order by t.created_at desc, t.id desc limit $7";
const COUNT_SQL: &str = "select count(*) from meeting_messages t
     where ($1::boolean or t.deleted_at is null) and ($2::boolean or t.author_id = $3)
       and ($4::boolean or t.created_at < $5::timestamp or (t.created_at = $5::timestamp and t.id < $6))";

/// `listAllMessages(c, q)`: newest first, an optional author, a keyset cursor.
async fn list_all(caller: &Caller, query: Option<&str>) -> Response {
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let author = query_param(query, "authorId").filter(|a| !a.is_empty());
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row: Option<(String, String)> = match &cursor {
        Some(cursor) => {
            let row: Result<Option<(Option<String>, String)>, sqlx::Error> = sqlx::query_as(
                "select to_jsonb(t.created_at)#>>'{}', t.id from meeting_messages t where t.id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(db)
            .await;
            match row {
                Ok(row) => row.and_then(|(at, id)| {
                    at.and_then(|s| weldsuite_db::js_timestamp(&s))
                        .map(|at| (at, id))
                }),
                Err(error) => {
                    tracing::error!(%error, "meet: cursor lookup failed");
                    return ApiError::internal().into_response();
                }
            }
        }
        None => None,
    };
    // Conditions: live, author, cursor; a `?cursor=` makes the count drop the last.
    let active = [true, author.is_some(), cursor_row.is_some()];
    let page: Vec<bool> = active.iter().map(|a| !a).collect();
    let mut count = page.clone();
    if cursor.is_some()
        && let Some(last) = count.iter().rposition(|skip| !skip)
    {
        count[last] = true;
    }
    let at = cursor_row.as_ref().map(|(at, _)| at.clone());
    let id = cursor_row.as_ref().map(|(_, id)| id.clone());
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(LIST_SQL)
        .bind(page[0])
        .bind(page[1])
        .bind(author.clone())
        .bind(page[2])
        .bind(at.clone())
        .bind(id.clone())
        .bind(sql_limit(limit + 1.0))
        .fetch_all(db)
        .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(COUNT_SQL)
        .bind(count[0])
        .bind(count[1])
        .bind(author)
        .bind(count[2])
        .bind(at)
        .bind(id)
        .fetch_one(db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_of(rows.into_iter().map(js_row).collect(), limit, total),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list meeting messages"),
    }
}

// ── GET /pinned ────────────────────────────────────────────────────────────

async fn pinned(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let Some(meeting) = query_param(query.as_deref(), "meetingId").filter(|m| !m.is_empty()) else {
        return ApiError::bad_request("meetingId query parameter is required").into_response();
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_messages t
         where t.meeting_id = $1 and t.deleted_at is null and t.pinned_at is not null
         order by t.pinned_at desc limit 50",
    )
    .bind(&meeting)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => {
            let messages: Vec<Value> = rows.into_iter().map(js_row).collect();
            Data(json!({ "messages": messages })).into_response()
        }
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
) -> Result<Response, sqlx::Error> {
    let db = &caller.db;
    let meeting: Option<String> =
        sqlx::query_scalar("select id from meetings where id = $1 limit 1")
            .bind(&body.meeting_id)
            .fetch_optional(db)
            .await?;
    if meeting.is_none() {
        return Ok(ApiError::not_found("Meeting", Some(&body.meeting_id)).into_response());
    }
    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(&caller.user_id)
            .fetch_optional(db)
            .await?;
    let (name, picture) = author.unwrap_or((None, None));
    let author_name = name.unwrap_or_else(|| "Unknown".to_owned());
    let id = generate_id("mmsg");
    let now = now();
    let has_attachments = body.attachments.as_ref().is_some_and(|a| !a.is_empty());
    let metadata = body
        .html
        .as_ref()
        .filter(|h| !h.is_empty())
        .map(|html| json!({ "htmlContent": html }));
    sqlx::query(
        "insert into meeting_messages (id, meeting_id, author_id, author_name, author_avatar, content,
             attachments, has_attachments, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(&body.meeting_id)
    .bind(&caller.user_id)
    .bind(&author_name)
    .bind(&picture)
    .bind(&body.content)
    .bind(body.attachments.clone().map(Value::Array))
    .bind(has_attachments)
    .bind(&metadata)
    .bind(&now)
    .execute(db)
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
    let result: Result<Response, sqlx::Error> = async {
        let found: Option<String> = sqlx::query_scalar(
            "select id from meeting_messages where id = $1 and deleted_at is null
               and ($2 = '' or meeting_id = $2) limit 1",
        )
        .bind(&id)
        .bind(&meeting)
        .fetch_optional(&caller.db)
        .await?;
        if found.is_none() {
            return Ok(ApiError::not_found("Message", Some(&id)).into_response());
        }
        let now = now();
        sqlx::query(
            "update meeting_messages set pinned_at = $2::timestamp, pinned_by = $3, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .bind(&caller.user_id)
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "pinned": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to pin message"))
}

async fn unpin(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let meeting = query_param(query.as_deref(), "meetingId").unwrap_or_default();
    let result = sqlx::query(
        "update meeting_messages set pinned_at = null, pinned_by = null, updated_at = $3::timestamp
         where id = $1 and ($2 = '' or meeting_id = $2)",
    )
    .bind(&id)
    .bind(&meeting)
    .bind(now())
    .execute(&caller.db)
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
    let result: Result<Response, sqlx::Error> = async {
        let found: Option<(String, String)> = sqlx::query_as(
            "select author_id, meeting_id from meeting_messages where id = $1 and deleted_at is null
               and ($2 = '' or meeting_id = $2) limit 1",
        )
        .bind(&id)
        .bind(&meeting)
        .fetch_optional(&caller.db)
        .await?;
        let Some((author, meeting_id)) = found else {
            return Ok(ApiError::not_found("Message", Some(&id)).into_response());
        };
        if author != caller.user_id {
            return Ok(ApiError::forbidden()
                .with_message("You can only delete your own messages")
                .into_response());
        }
        let now = now();
        sqlx::query("update meeting_messages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        publish::chat_message_deleted(&state, &meeting_id, &id).await;
        caller.publish(&state, MEETING_MESSAGE_DELETED, &id, &json!({ "id": id }));
        Ok(StatusCode::NO_CONTENT.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete message"))
}

// ── generic ────────────────────────────────────────────────────────────────

async fn live_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_messages t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
    let result: Result<Response, sqlx::Error> = async {
        if live_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Meeting message", Some(&id)).into_response());
        }
        let now = now();
        sqlx::query("update meeting_messages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, MEETING_MESSAGE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete meeting message"))
}
