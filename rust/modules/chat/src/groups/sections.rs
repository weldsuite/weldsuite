//! `/api/chat-sections` (`routes/chat-sections/index.ts`): the sidebar's
//! channel groups.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
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
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create_one).route_layer(gate.require(["channels:create"])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            patch(update_one).route_layer(gate.require(["channels:update"])),
        )
        .route(
            "/{id}",
            delete(remove_one).route_layer(gate.require(["channels:delete"])),
        )
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let search = q
        .get("search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
                "select created_at::text, id from chat_sections where id = $1 limit 1",
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
            "select to_jsonb(t) from chat_sections t
             where ($1::text is null or t.name like $1)
               and ($2::text is null or (t.created_at < $2::timestamp
                    or (t.created_at = $2::timestamp and t.id < $3)))
             order by t.created_at desc, t.id desc limit $4",
        )
        .bind(&search)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from chat_sections t where ($1::text is null or t.name like $1)",
        )
        .bind(&search)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(weldsuite_db::js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list chat sections")
}

async fn section(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from chat_sections t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match section(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(ChatError::not_found("Chat section", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch chat section")
}

/// `createChatSectionSchema` (`.partial()` when `partial`): the columns it sets.
fn read_section(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> (Option<String>, Option<i64>) {
    let presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let name = issues
        .text(body, "name", presence, Some(1), Some(255))
        .into_option();
    // `userId` is validated and not stored (no such column).
    let _ = issues.text(body, "userId", Presence::Nullish, None, None);
    let position = match issues.integer(body, "position", Presence::Optional, None) {
        Field::Set(position) => Some(position),
        _ => None,
    };
    (name, position)
}

async fn create_one(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let (name, position) = match validate(&headers, &body, |issues, body| {
        read_section(issues, body, false)
    }) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let id = generate_id("csec");
        let at = now();
        sqlx::query(
            "insert into chat_sections (id, name, position, created_at, updated_at)
             values ($1, $2, coalesce($3, 0), $4::timestamp, $4::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(position.and_then(|p| i32::try_from(p).ok()))
        .bind(&at)
        .execute(&caller.db)
        .await?;
        Ok(Created(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to create chat section")
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, position) = match validate(&headers, &body, |issues, body| {
        read_section(issues, body, true)
    }) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if section(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Chat section", Some(&id)));
        }
        sqlx::query(
            "update chat_sections set updated_at = $2::timestamp, name = coalesce($3, name),
                position = coalesce($4, position)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(&name)
        .bind(position.and_then(|p| i32::try_from(p).ok()))
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update chat section")
}

async fn remove_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if section(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Chat section", Some(&id)));
        }
        let at = now();
        sqlx::query("update chat_channels set section_id = null, updated_at = $2::timestamp where section_id = $1")
            .bind(&id)
            .bind(&at)
            .execute(&caller.db)
            .await?;
        sqlx::query("delete from chat_sections where id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat section")
}
