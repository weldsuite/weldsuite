//! `/api/chat-bookmarks` (`routes/chat-bookmarks/index.ts`): the caller's
//! own saved messages, with the message and channel they point at.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::util::{list_limit, list_response, ms_timestamp, now, page, query_map};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["messages:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            axum::routing::post(create_one).route_layer(gate.require(["messages:create"])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            patch(update_one).route_layer(gate.require(["messages:update"])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove_one).route_layer(gate.require(["messages:delete"])),
        )
}

/// The bookmark with its message and channel (`bookmarkListSelection`).
macro_rules! selection {
    () => {
        "jsonb_build_object(
        'id', t.id, 'userId', t.user_id, 'messageId', t.message_id, 'channelId', t.channel_id,
        'note', t.note, 'createdAt', t.created_at,
        'messageContent', m.content, 'messageAuthorId', m.author_id,
        'messageAuthorName', m.author_name, 'messageAuthorAvatar', m.author_avatar,
        'messageCreatedAt', m.created_at, 'messageAttachments', m.attachments,
        'channelName', c.name, 'channelSlug', c.slug, 'channelType', c.type)"
    };
}

/// `js_row` for the two timestamps of the selection (top level only).
fn bookmark_row(row: Value) -> Value {
    weldsuite_db::js_row(row)
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let channel = q.get("channelId").filter(|c| !c.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
                "select created_at::text, id from chat_bookmarks where id = $1 limit 1",
            )
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
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            selection!(),
            " from chat_bookmarks t
             left join chat_messages m on t.message_id = m.id
             left join chat_channels c on t.channel_id = c.id
             where t.user_id = $1 and ($2::text is null or t.channel_id = $2)
               and ($3::text is null or (t.created_at < $3::timestamp
                    or (t.created_at = $3::timestamp and t.id < $4)))
             order by t.created_at desc, t.id desc limit $5"
        ))
        .bind(&caller.user_id)
        .bind(&channel)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from chat_bookmarks t
             where t.user_id = $1 and ($2::text is null or t.channel_id = $2)",
        )
        .bind(&caller.user_id)
        .bind(&channel)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(bookmark_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list chat bookmarks")
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            selection!(),
            " from chat_bookmarks t
             left join chat_messages m on t.message_id = m.id
             left join chat_channels c on t.channel_id = c.id
             where t.id = $1 and t.user_id = $2 limit 1"
        ))
        .bind(&id)
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(row) = row else {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        };
        Ok(Data(bookmark_row(row)).into_response())
    }
    .await;
    answer(result, "Failed to fetch chat bookmark")
}

async fn create_one(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let message_id = issues.string(body, "messageId", true, Some(1), None);
        let channel_id = issues.string(body, "channelId", true, Some(1), None);
        let note = issues.string(body, "note", false, None, None);
        (
            message_id.unwrap_or_default(),
            channel_id.unwrap_or_default(),
            note,
        )
    });
    let (message_id, channel_id, note) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let at = now();
        let existing: Option<String> = sqlx::query_scalar(
            "select id from chat_bookmarks where user_id = $1 and message_id = $2 limit 1",
        )
        .bind(&caller.user_id)
        .bind(&message_id)
        .fetch_optional(&caller.db)
        .await?;
        if let Some(existing) = existing {
            return Ok(Data(json!({ "id": existing, "alreadyExists": true })).into_response());
        }
        let id = generate_id("cbk");
        sqlx::query(
            "insert into chat_bookmarks (id, user_id, message_id, channel_id, note, created_at)
             values ($1, $2, $3, $4, $5, $6::timestamp)",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .bind(&message_id)
        .bind(&channel_id)
        .bind(&note)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        let mut data = json!({
            "id": id,
            "userId": caller.user_id,
            "messageId": message_id,
            "channelId": channel_id,
            "createdAt": at,
        });
        if let Some(note) = note {
            data["note"] = Value::from(note);
        }
        Ok(Created(data).into_response())
    }
    .await;
    answer(result, "Failed to create chat bookmark")
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let note = validate(&headers, &body, |issues, body| {
        issues.text(body, "note", Presence::Nullish, None, None)
    });
    let note = match note {
        Ok(note) => note,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from chat_bookmarks where id = $1 and user_id = $2 limit 1",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        if existing.is_none() {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        }
        let value = match &note {
            Field::Set(text) => Some(Some(text.clone())),
            Field::Null => Some(None),
            Field::Absent => None,
        };
        if let Some(value) = value {
            sqlx::query("update chat_bookmarks set note = $3 where id = $1 and user_id = $2")
                .bind(&id)
                .bind(&caller.user_id)
                .bind(value)
                .execute(&caller.db)
                .await?;
        }
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update chat bookmark")
}

async fn remove_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from chat_bookmarks where id = $1 and user_id = $2 limit 1",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        if existing.is_none() {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        }
        sqlx::query("delete from chat_bookmarks where id = $1 and user_id = $2")
            .bind(&id)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat bookmark")
}
