//! `/api/chat-messages` (`routes/chat-messages/index.ts`): a channel's
//! messages and threads, posting, editing and deleting, reactions, pins and
//! attachment uploads.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CHAT_MESSAGE_CREATED, CHAT_MESSAGE_DELETED, CHAT_MESSAGE_UPDATED,
};
use weldsuite_chat_domain::{can_access_channel, can_access_message, is_channel_moderator};
use weldsuite_kit::validation::{Presence, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{JobRequest, PutOptions};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::groups::channels::feature_error;
use crate::pins::{UNPIN_EXPIRED_MESSAGE_JOB, pin_message, post_pin_notice, unpin_message};
use crate::post::{PostInput, channel_feature_flags, post_chat_message};
use crate::util::{consume_rate_limit, list_limit, list_response, ms_timestamp, now, page, query_map};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    let update = || gate.require(["messages:update"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_one).route_layer(gate.require(["channels:create"])))
        .route("/pinned", get(pinned).route_layer(gate.require(["messages:read"])))
        .route("/upload", post(upload).route_layer(gate.require(["messages:create"])))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_one).route_layer(update()))
        .route("/{id}", delete(remove_one).route_layer(gate.require(["messages:delete"])))
        .route(
            "/{id}/reactions",
            post(add_reaction).route_layer(gate.require(["messages:create"])),
        )
        .route("/{id}/reactions/{emoji}", delete(remove_reaction).route_layer(update()))
        .route("/{id}/pin", post(pin).delete(unpin).route_layer(update()))
}

fn forbidden_channel() -> ChatError {
    ChatError::forbidden("You do not have access to this channel")
}

/// `GET /?channelId=`: one channel's top-level messages (or a thread's
/// replies with `parentId`), newest first.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let Some(channel) = q.get("channelId").filter(|c| !c.is_empty()).cloned() else {
        return ApiError::bad_request("channelId query parameter is required").into_response();
    };
    match can_access_channel(&caller.db, &channel, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let author = q.get("authorId").filter(|a| !a.is_empty()).cloned();
    let parent = q.get("parentId").filter(|p| !p.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(String, String)>, sqlx::Error> =
                sqlx::query_as("select created_at::text, id from chat_messages where id = $1 limit 1")
                    .bind(cursor)
                    .fetch_optional(&caller.db)
                    .await;
            match row {
                Ok(row) => row.map(|(at, id)| (ms_timestamp(&at), id)),
                Err(error) => return unhandled(error.into()),
            }
        }
        None => None,
    };
    let result = async {
        let (cursor_at, cursor_id) = cursor.unzip();
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from chat_messages t
             where t.deleted_at is null and t.channel_id = $1
               and ($2::text is null or t.author_id = $2)
               and (case when $3::text is null then t.parent_id is null else t.parent_id = $3 end)
               and ($4::text is null or (t.created_at < $4::timestamp
                    or (t.created_at = $4::timestamp and t.id < $5)))
             order by t.created_at desc, t.id desc limit $6",
        )
        .bind(&channel)
        .bind(&author)
        .bind(&parent)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from chat_messages t
             where t.deleted_at is null and t.channel_id = $1
               and ($2::text is null or t.author_id = $2)
               and (case when $3::text is null then t.parent_id is null else t.parent_id = $3 end)",
        )
        .bind(&channel)
        .bind(&author)
        .bind(&parent)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(weldsuite_db::js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list chat messages")
}

/// `GET /pinned?channelId=`: pinned messages, newest pin first.
async fn pinned(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let Some(channel) = q.get("channelId").filter(|c| !c.is_empty()).cloned() else {
        return ApiError::bad_request("channelId query parameter is required").into_response();
    };
    match can_access_channel(&caller.db, &channel, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from chat_messages t
             where t.channel_id = $1 and t.is_pinned = true and t.deleted_at is null
             order by t.pinned_at desc",
        )
        .bind(&channel)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to list pinned messages")
}

async fn live_message(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_messages t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = live_message(&caller, &id).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        let channel = row["channelId"].as_str().unwrap_or_default();
        if !can_access_channel(&caller.db, channel, &caller.user_id, None).await? {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch chat message")
}

/// `createChatMessageSchema` (passthrough): the body as validated.
fn read_message_body(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let _ = partial;
    for key in ["channelId", "authorId"] {
        let _ = issues.text(body, key, Presence::Nullish, None, None);
    }
    let _ = issues.text(body, "body", Presence::Optional, None, None);
    for key in ["parentId", "replyToId"] {
        let _ = issues.text(body, key, Presence::Nullish, None, None);
    }
    let _ = issues.boolean(body, "replyMention", Presence::Optional);
    body.clone()
}

/// `messageInputFromBody`: `body` (mobile) or `content` (platform) is the text.
fn message_input(data: &Map<String, Value>) -> PostInput {
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    PostInput {
        content: text("body").or_else(|| text("content")).unwrap_or_default(),
        html_content: text("htmlContent"),
        parent_id: text("parentId"),
        attachments: data.get("attachments").and_then(Value::as_array).cloned(),
        mentions: data.get("mentions").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                .collect()
        }),
        metadata: data.get("metadata").cloned().filter(|m| !m.is_null()),
        reply_to_id: text("replyToId"),
        reply_mention: data.get("replyMention").and_then(Value::as_bool),
    }
}

/// `POST /`: send through the shared pipeline.
async fn create_one(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_message_body(issues, body, false)) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let channel = data
        .get("channelId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if channel.is_empty() {
        return ApiError::bad_request("channelId is required").into_response();
    }
    match can_access_channel(&caller.db, &channel, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    if !consume_rate_limit(&caller, &state, &format!("msg:{org}:{}", caller.user_id), 60).await {
        return ApiError::bad_request("Too many messages — slow down and try again").into_response();
    }
    match post_chat_message(&caller, &state, &org, &channel, message_input(&data)).await {
        Ok(message) => {
            let id = message["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(
                &state,
                CHAT_MESSAGE_CREATED,
                &id,
                &json!({ "id": id, "channelId": channel, "authorId": caller.user_id }),
            );
            Created(json!({ "id": id })).into_response()
        }
        Err(error) => feature_error(error, &channel).respond("Failed to create chat message"),
    }
}

/// `PATCH /:id`: the author edits the text of their own message.
async fn update_one(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_message_body(issues, body, true)) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let Some(existing) = live_message(&caller, &id).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        let channel = existing["channelId"].as_str().unwrap_or_default().to_owned();
        if !can_access_channel(&caller.db, &channel, &caller.user_id, None).await? {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        }
        if existing["authorId"].as_str() != Some(caller.user_id.as_str()) {
            return Err(ChatError::forbidden("You can only edit your own messages"));
        }
        if existing["type"] == "system" {
            return Err(ChatError::bad_request("System messages cannot be edited"));
        }
        let text_param = |key: &str| -> (bool, Option<String>) {
            match data.get(key) {
                None => (false, None),
                Some(Value::Null) => (true, None),
                Some(Value::String(text)) => (true, Some(text.clone())),
                Some(other) => (true, Some(other.to_string())),
            }
        };
        let (set_content, content) = text_param("content");
        let (set_html, html) = text_param("htmlContent");
        let at = now();
        sqlx::query(
            "update chat_messages set updated_at = $2::timestamp, is_edited = true,
                edited_at = $2::timestamp,
                content = case when $3 then $4 else content end,
                html_content = case when $5 then $6 else html_content end
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&at)
        .bind(set_content)
        .bind(&content)
        .bind(set_html)
        .bind(&html)
        .execute(&caller.db)
        .await?;
        let updated: Option<Value> =
            sqlx::query_scalar("select to_jsonb(t) from chat_messages t where t.id = $1 limit 1")
                .bind(&id)
                .fetch_optional(&caller.db)
                .await?;
        let updated = updated.map(weldsuite_db::js_row);
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &id,
            &json!({ "id": id, "channelId": channel }),
        );
        let content = updated
            .as_ref()
            .map_or_else(|| existing["content"].clone(), |u| u["content"].clone());
        let updated_at = updated
            .as_ref()
            .and_then(|u| u["updatedAt"].as_str().map(str::to_owned))
            .unwrap_or_else(now);
        Caller::realtime(&state)
            .message_updated(
                &channel,
                &id,
                json!({ "id": id, "content": content, "isEdited": true, "updatedAt": updated_at }),
            )
            .await;
        Ok(Data(updated.unwrap_or_else(|| json!({ "id": id }))).into_response())
    }
    .await;
    answer(result, "Failed to update chat message")
}

/// `DELETE /:id`: the author or a channel moderator soft-deletes it.
async fn remove_one(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = live_message(&caller, &id).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        let channel = existing["channelId"].as_str().unwrap_or_default().to_owned();
        if !can_access_channel(&caller.db, &channel, &caller.user_id, None).await? {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        }
        if existing["authorId"].as_str() != Some(caller.user_id.as_str())
            && !is_channel_moderator(&caller.db, &channel, &caller.user_id).await?
        {
            return Err(ChatError::forbidden("You can only delete your own messages"));
        }
        let at = now();
        sqlx::query("update chat_messages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&at)
            .execute(&caller.db)
            .await?;
        if let Some(parent) = existing["parentId"].as_str().filter(|p| !p.is_empty()) {
            sqlx::query(
                "update chat_messages set thread_reply_count = greatest(thread_reply_count - 1, 0),
                    updated_at = $2::timestamp where id = $1",
            )
            .bind(parent)
            .bind(now())
            .execute(&caller.db)
            .await?;
        }
        caller.publish(
            &state,
            CHAT_MESSAGE_DELETED,
            &id,
            &json!({ "id": id, "channelId": channel }),
        );
        Caller::realtime(&state).message_deleted(&channel, &id).await;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat message")
}

/// The reactions map after adding (or removing) the user under `emoji`.
async fn toggle_reaction(
    caller: &Caller,
    id: &str,
    emoji: &str,
    add: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<(Option<Value>, String)> = sqlx::query_as(
        "select reactions, channel_id from chat_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((reactions, channel)) = row else {
        return Ok(None);
    };
    let mut reactions = match reactions {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if add {
        let users = reactions
            .entry(emoji.to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(list) = users
            && !list.iter().any(|u| u.as_str() == Some(caller.user_id.as_str()))
        {
            list.push(Value::from(caller.user_id.as_str()));
        }
    } else if let Some(Value::Array(list)) = reactions.get_mut(emoji) {
        list.retain(|u| u.as_str() != Some(caller.user_id.as_str()));
        if list.is_empty() {
            reactions.remove(emoji);
        }
    }
    let reactions = Value::Object(reactions);
    sqlx::query(
        "update chat_messages set reactions = $2, updated_at = $3::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&reactions)
    .bind(now())
    .execute(&caller.db)
    .await?;
    Ok(Some(json!({ "messageId": id, "channelId": channel, "reactions": reactions })))
}

/// `POST /:id/reactions`.
async fn add_reaction(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let emoji = validate(&headers, &body, |issues, body| {
        issues.string(body, "emoji", true, Some(1), Some(50)).unwrap_or_default()
    });
    let emoji = match emoji {
        Ok(emoji) => emoji,
        Err(error) => return error.respond(""),
    };
    match can_access_message(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return ChatError::not_found("Chat message", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let org = caller.org_id.clone().unwrap_or_else(|| "x".to_owned());
    if !consume_rate_limit(&caller, &state, &format!("react:{org}:{}", caller.user_id), 120).await {
        return ApiError::bad_request("Too many reactions — slow down and try again").into_response();
    }
    let result = async {
        let Some(channel) = crate::pins::live_message_channel(&caller.db, &id).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        if let Some((_, _, reactions_on, _)) = channel_feature_flags(&caller.db, &channel).await?
            && !reactions_on
        {
            return Err(ChatError::bad_request("Reactions are disabled in this channel"));
        }
        let Some(result) = toggle_reaction(&caller, &id, &emoji, true).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &id,
            &json!({ "id": id, "channelId": result["channelId"] }),
        );
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to add reaction")
}

/// `decodeURIComponent`: `None` where JavaScript throws (a malformed escape).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let byte = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `DELETE /:id/reactions/:emoji`.
async fn remove_reaction(
    State(state): State<ChatState>,
    caller: Caller,
    Path((id, emoji)): Path<(String, String)>,
) -> Response {
    let Some(emoji) = decode_uri_component(&emoji) else {
        return ApiError::internal().into_response();
    };
    match can_access_message(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return ChatError::not_found("Chat message", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let Some(result) = toggle_reaction(&caller, &id, &emoji, false).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &id,
            &json!({ "id": id, "channelId": result["channelId"] }),
        );
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to remove reaction")
}

/// `POST /:id/pin`: optional `{ expiresAt, notify }`.
async fn pin(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>, body: Bytes) -> Response {
    match can_access_message(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return ChatError::not_found("Chat message", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let fields = parsed.as_ref().and_then(Value::as_object);
    let expires_at = fields
        .and_then(|f| f.get("expiresAt"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let notify = fields.and_then(|f| f.get("notify")) == Some(&Value::Bool(true));
    let result = async {
        // `new Date(expiresAt)` must be a date, or the write fails.
        let expires_iso = match expires_at.as_deref().filter(|e| !e.is_empty()) {
            Some(text) => match js_date_iso(text) {
                Some(iso) => Some(iso),
                None => return Err(ChatError::api(ApiError::internal().with_message("Failed to pin message"))),
            },
            None => None,
        };
        let Some(result) = pin_message(&caller.db, &id, &caller.user_id, expires_iso.as_deref()).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        let channel = result["channelId"].as_str().unwrap_or_default().to_owned();
        if let (Some(expires), Some(jobs), true) = (&expires_iso, &state.jobs, state.unpin_jobs) {
            let at = time::OffsetDateTime::parse(expires, &time::format_description::well_known::Rfc3339).ok();
            let delay = at
                .map(|at| (at - time::OffsetDateTime::now_utc()).whole_milliseconds())
                .and_then(|ms| u64::try_from(ms).ok())
                .map_or(Duration::ZERO, Duration::from_millis);
            let request = JobRequest {
                name: UNPIN_EXPIRED_MESSAGE_JOB.to_owned(),
                key: format!("{id}-{expires}"),
                payload: json!({
                    "workspaceId": caller.workspace_id,
                    "channelId": channel,
                    "messageId": id,
                    "expiresAt": expires,
                }),
                delay: None,
            }
            .with_delay(delay);
            if let Err(error) = jobs.start_boxed(request).await {
                tracing::error!(%error, "[app-api/chat-messages] failed to create unpin workflow");
            }
        }
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &id,
            &json!({ "id": id, "channelId": channel }),
        );
        if notify {
            match post_pin_notice(&caller.db, &Caller::realtime(&state), &channel, &id, &caller.user_id).await {
                Ok(notice) => caller.publish(
                    &state,
                    CHAT_MESSAGE_CREATED,
                    &notice,
                    &json!({ "id": notice, "channelId": channel, "authorId": caller.user_id }),
                ),
                Err(error) => tracing::error!(%error, "[app-api/chat-messages] pin notice failed"),
            }
        }
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to pin message")
}

/// `DELETE /:id/pin`. A pending expiry job finds the pin gone and does nothing.
async fn unpin(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>) -> Response {
    match can_access_message(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return ChatError::not_found("Chat message", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let Some(result) = unpin_message(&caller.db, &id).await? else {
            return Err(ChatError::not_found("Chat message", Some(&id)));
        };
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &id,
            &json!({ "id": id, "channelId": result["channelId"] }),
        );
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to unpin message")
}

const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
const DANGEROUS_TYPES: [&str; 9] = [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
    "application/javascript",
    "text/javascript",
    "application/x-msdownload",
    "application/x-sh",
];

/// `isDangerousUploadType`.
fn is_dangerous_type(mime: &str) -> bool {
    let base = mime.to_lowercase();
    let base = base.split(';').next().unwrap_or_default().trim().to_owned();
    DANGEROUS_TYPES.contains(&base.as_str())
}

/// `looksLikeDangerousBytes`: HTML, SVG or XML-with-markup, or a PE executable.
fn looks_dangerous(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    if head.is_empty() {
        return false;
    }
    let decoded = String::from_utf8_lossy(head);
    let text = decoded.trim_start().to_lowercase();
    if text.starts_with("<!doctype html") || text.starts_with("<html") || text.starts_with("<svg") {
        return true;
    }
    if text.starts_with("<?xml") && (text.contains("<svg") || text.contains("<html")) {
        return true;
    }
    head.len() >= 2 && head[0] == 0x4d && head[1] == 0x5a
}

/// `sanitizeFileName`: per UTF-16 unit, as the JavaScript regex replaces
/// (a non-BMP character becomes two `_`), leading dots dropped, the last 200 kept.
fn sanitize_file_name(name: &str) -> String {
    let replaced: String = name
        .encode_utf16()
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .map(char::from)
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                .unwrap_or('_')
        })
        .collect();
    let trimmed = replaced.trim_start_matches('.');
    let kept = &trimmed[trimmed.len().saturating_sub(200)..];
    if kept.is_empty() { "file".to_owned() } else { kept.to_owned() }
}

/// A 32-character hex key segment.
fn random_segment() -> String {
    weldsuite_kit::random_string(32, "0123456789abcdef")
}

/// The multipart `file` (first) and `channelId` fields; `None` when the body
/// is not multipart.
async fn upload_fields(request: Request) -> Option<(Option<(String, String, Vec<u8>)>, Option<String>)> {
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut file = None;
    let mut channel = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        match field.name() {
            Some("file") if file.is_none() => {
                let name = field.file_name().map(str::to_owned);
                let kind = field.content_type().map(str::to_owned).unwrap_or_default();
                let bytes = field.bytes().await.ok()?;
                if let Some(name) = name {
                    file = Some((name, kind, bytes.to_vec()));
                }
            }
            Some("channelId") if channel.is_none() => {
                channel = field.text().await.ok();
            }
            _ => {}
        }
    }
    Some((file, channel))
}

/// `POST /upload`: a chat attachment into the `STORAGE` bucket.
async fn upload(State(state): State<ChatState>, caller: Caller, request: Request) -> Response {
    let Some(org) = caller
        .clerk_org_id
        .clone()
        .filter(|o| !o.is_empty())
        .or_else(|| caller.org_id.clone().filter(|o| !o.is_empty()))
    else {
        return ApiError::org_required().into_response();
    };
    let Some(store) = caller.public_store(&state) else {
        return ApiError::internal().with_message("Storage is not configured").into_response();
    };
    let internal = || ApiError::internal().with_message("Failed to upload file").into_response();
    let Some((file, channel)) = upload_fields(request).await else {
        return internal();
    };
    let Some((name, kind, bytes)) = file else {
        return ApiError::bad_request("No file provided").into_response();
    };
    let channel = channel.filter(|c| !c.is_empty());
    if bytes.len() > MAX_UPLOAD_BYTES {
        return ApiError::bad_request("File exceeds the 50MB limit").into_response();
    }
    let Some(public_url) = caller.env(&state, "R2_PUBLIC_URL").filter(|u| !u.is_empty()).map(str::to_owned) else {
        return ApiError::internal()
            .with_message("File storage is not configured for this environment")
            .into_response();
    };
    if is_dangerous_type(&kind) || looks_dangerous(&bytes) {
        return ApiError::bad_request("This file type is not allowed").into_response();
    }
    let result = async {
        if let Some(channel) = &channel {
            if !can_access_channel(&caller.db, channel, &caller.user_id, None).await? {
                return Err(forbidden_channel());
            }
            if let Some((_, attachments_on, _, _)) = channel_feature_flags(&caller.db, channel).await?
                && !attachments_on
            {
                return Err(ChatError::bad_request("Attachments are disabled in this channel"));
            }
        }
        if !consume_rate_limit(&caller, &state, &format!("upload:{org}:{}", caller.user_id), 30).await {
            return Err(ChatError::bad_request("Too many uploads — slow down and try again"));
        }
        let safe_channel: String = channel
            .as_deref()
            .unwrap_or("general")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            .collect();
        let safe_channel = if safe_channel.is_empty() { "general".to_owned() } else { safe_channel };
        let key = format!(
            "workspaces/{org}/chat/{safe_channel}/files/{}/{}",
            random_segment(),
            sanitize_file_name(&name)
        );
        let mime = if kind.is_empty() { "application/octet-stream".to_owned() } else { kind.clone() };
        let size = bytes.len();
        store
            .put_boxed(&key, bytes.into(), &PutOptions::content_type(mime.clone()))
            .await
            .map_err(|error| {
                tracing::error!(%error, "[app-api/chat-messages] upload failed");
                ChatError::api(ApiError::internal().with_message("Failed to upload file"))
            })?;
        let url = format!("{}/{key}", public_url.trim_end_matches('/'));
        Ok(Created(json!({
            "id": generate_id("chatfile"),
            "fileName": name,
            "fileSize": size,
            "mimeType": mime,
            "url": url,
            "fileKey": key,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to upload file")
}
