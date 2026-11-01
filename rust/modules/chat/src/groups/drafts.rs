//! `/api/chat-drafts` (`routes/chat-drafts/index.ts`): the caller's unsent
//! messages, one per channel or thread. An empty draft is never stored: it
//! means "no draft here".

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::util::{list_limit, list_response, ms_timestamp, now, page, query_map};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    Router::new()
        .route("/", get(list).post(create_one).route_layer(read()))
        .route(
            "/{id}",
            get(detail)
                .patch(update_one)
                .delete(remove_one)
                .route_layer(read()),
        )
}

/// Text that isn't only whitespace, or a non-empty attachment list.
fn is_empty_draft(content: Option<&Value>, attachments: Option<&Value>) -> bool {
    let has_text = content
        .and_then(Value::as_str)
        .is_some_and(|text| !weldsuite_chat_domain::text::js_trim(text).is_empty());
    let has_attachments = attachments
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    !has_text && !has_attachments
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let channel = q.get("channelId").filter(|c| !c.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
                "select created_at::text, id from chat_drafts where id = $1 limit 1",
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from chat_drafts t
             where t.user_id = $1
               and (btrim(t.content) <> ''
                    or (jsonb_typeof(t.attachments) = 'array' and jsonb_array_length(t.attachments) > 0))
               and ($2::text is null or t.channel_id = $2)
               and ($3::text is null or (t.created_at < $3::timestamp
                    or (t.created_at = $3::timestamp and t.id < $4)))
             order by t.created_at desc, t.id desc limit $5",
        )
        .bind(&caller.user_id)
        .bind(&channel)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from chat_drafts t
             where t.user_id = $1
               and (btrim(t.content) <> ''
                    or (jsonb_typeof(t.attachments) = 'array' and jsonb_array_length(t.attachments) > 0))
               and ($2::text is null or t.channel_id = $2)",
        )
        .bind(&caller.user_id)
        .bind(&channel)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(weldsuite_db::js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list chat drafts")
}

async fn own_draft(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_drafts t where t.id = $1 and t.user_id = $2 limit 1",
    )
    .bind(id)
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match own_draft(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(ChatError::not_found("Chat draft", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch chat draft")
}

/// `createChatDraftSchema` (passthrough): the body as validated, every key kept.
fn read_draft(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let _ = issues.text(body, "channelId", Presence::Nullish, None, None);
    let _ = issues.text(body, "body", Presence::Optional, None, None);
    body.clone()
}

/// A body value as a text column parameter (`undefined` → not set).
#[allow(clippy::option_option)]
fn text_of(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(other) => Some(Some(other.to_string())),
    }
}

async fn create_one(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, read_draft) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let Some(org) = caller
        .clerk_org_id
        .clone()
        .filter(|o| !o.is_empty())
        .or_else(|| caller.org_id.clone().filter(|o| !o.is_empty()))
    else {
        return ApiError::org_required().into_response();
    };
    let result = async {
        let content = data
            .get("content")
            .filter(|v| !v.is_null())
            .or_else(|| data.get("body"));
        if is_empty_draft(content, data.get("attachments")) {
            let channel = data
                .get("channelId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let parent = data
                .get("threadParentMessageId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let removed: Vec<String> = sqlx::query_scalar(
                "delete from chat_drafts
                 where user_id = $1
                   and (case when $2::text is null then channel_id is null else channel_id = $2 end)
                   and (case when $3::text is null then thread_parent_message_id is null
                        else thread_parent_message_id = $3 end)
                 returning id",
            )
            .bind(&caller.user_id)
            .bind(&channel)
            .bind(&parent)
            .fetch_all(&caller.db)
            .await?;
            return Ok(Data(json!({
                "id": removed.first(),
                "deleted": !removed.is_empty(),
            }))
            .into_response());
        }
        let id = generate_id("cdft");
        let at = now();
        sqlx::query(
            "insert into chat_drafts
                (id, workspace_id, user_id, channel_id, thread_parent_message_id, content,
                 attachments, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(&org)
        .bind(&caller.user_id)
        .bind(text_of(data.get("channelId")).flatten())
        .bind(text_of(data.get("threadParentMessageId")).flatten())
        .bind(text_of(data.get("content")).flatten())
        .bind(data.get("attachments").filter(|a| !a.is_null()).cloned())
        .bind(&at)
        .execute(&caller.db)
        .await?;
        Ok(Created(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to create chat draft")
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_draft) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let Some(existing) = own_draft(&caller, &id).await? else {
            return Err(ChatError::not_found("Chat draft", Some(&id)));
        };
        let next_content = data.get("content").or_else(|| existing.get("content"));
        let next_attachments = data
            .get("attachments")
            .or_else(|| existing.get("attachments"));
        if is_empty_draft(next_content, next_attachments) {
            sqlx::query("delete from chat_drafts where id = $1 and user_id = $2")
                .bind(&id)
                .bind(&caller.user_id)
                .execute(&caller.db)
                .await?;
            return Ok(Data(json!({ "id": id, "deleted": true })).into_response());
        }
        let field = |key: &str| text_of(data.get(key));
        let (set_channel, channel) = field("channelId").map_or((false, None), |v| (true, v));
        let (set_parent, parent) =
            field("threadParentMessageId").map_or((false, None), |v| (true, v));
        let (set_content, content) = field("content").map_or((false, None), |v| (true, v));
        let attachments = data.get("attachments").cloned();
        sqlx::query(
            "update chat_drafts set updated_at = $3::timestamp,
                channel_id = case when $4 then $5 else channel_id end,
                thread_parent_message_id = case when $6 then $7 else thread_parent_message_id end,
                content = case when $8 then $9 else content end,
                attachments = case when $10 then $11 else attachments end
             where id = $1 and user_id = $2",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .bind(now())
        .bind(set_channel)
        .bind(&channel)
        .bind(set_parent)
        .bind(&parent)
        .bind(set_content)
        .bind(&content)
        .bind(attachments.is_some())
        .bind(attachments.filter(|a| !a.is_null()))
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update chat draft")
}

async fn remove_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if own_draft(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Chat draft", Some(&id)));
        }
        sqlx::query("delete from chat_drafts where id = $1 and user_id = $2")
            .bind(&id)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat draft")
}

#[allow(dead_code)]
fn unused(_: Field<String>) {}
