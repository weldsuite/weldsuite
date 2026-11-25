//! `/api/chat-sections` (`routes/chat-sections/index.ts`): the sidebar's
//! channel groups.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{chat_channels as channels, chat_sections as sections};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::util::{list_limit, list_response, page, query_map};

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

/// `like(t.name, %search%)`, when the query has one.
fn matching(search: Option<&str>) -> Condition {
    let mut condition = Condition::all();
    if let Some(search) = search {
        condition = condition.add(sections::Column::Name.like(search));
    }
    condition
}

/// A row as Drizzle returns it.
fn js(model: sections::Model) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
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
            let row: Result<Option<(PrimitiveDateTime, String)>, DbErr> =
                sections::Entity::find_by_id(cursor.clone())
                    .select_only()
                    .column(sections::Column::CreatedAt)
                    .column(sections::Column::Id)
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await;
            match row {
                // The cursor row's `Date`, to the millisecond, as the
                // TypeScript route binds it.
                Ok(row) => row.map(|(at, id)| (utc_timestamp(at.assume_utc()), id)),
                Err(error) => return unhandled(error.into()),
            }
        }
        None => None,
    };
    let result = async {
        let db = orm(&caller.db);
        let mut rows = sections::Entity::find().filter(matching(search.as_deref()));
        if let Some((at, id)) = &cursor {
            rows = rows.filter(
                Condition::any()
                    .add(sections::Column::CreatedAt.lt(*at))
                    .add(
                        Condition::all()
                            .add(sections::Column::CreatedAt.eq(*at))
                            .add(sections::Column::Id.lt(id.as_str())),
                    ),
            );
        }
        // `limit $n` with a negative `n` is the statement's error.
        let probe = u64::try_from(limit + 1)
            .map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))?;
        let rows = rows
            .order_by_desc(sections::Column::CreatedAt)
            .order_by_desc(sections::Column::Id)
            .limit(probe)
            .all(&db)
            .await?;
        let total = sections::Entity::find()
            .filter(matching(search.as_deref()))
            .count(&db)
            .await?;
        let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, "Failed to list chat sections")
}

async fn section(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    sections::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .map(js)
        .transpose()
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
        let at = utc_now();
        sections::Entity::insert(sections::ActiveModel {
            id: Set(id.clone()),
            // Required by the schema: always there once validated.
            name: Set(name.unwrap_or_default()),
            // `coalesce($3, 0)`: a position out of `integer` range binds null.
            position: Set(position.and_then(|p| i32::try_from(p).ok()).unwrap_or(0)),
            created_at: Set(at),
            updated_at: Set(at),
        })
        .exec_without_returning(&orm(&caller.db))
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
        // `coalesce($n, col)`: only the fields the body sent.
        let mut update = sections::Entity::update_many()
            .col_expr(sections::Column::UpdatedAt, Expr::value(utc_now()));
        if let Some(name) = &name {
            update = update.col_expr(sections::Column::Name, Expr::value(name));
        }
        if let Some(position) = position.and_then(|p| i32::try_from(p).ok()) {
            update = update.col_expr(sections::Column::Position, Expr::value(position));
        }
        update
            .filter(sections::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        let db = orm(&caller.db);
        channels::Entity::update_many()
            .col_expr(
                channels::Column::SectionId,
                Expr::value(Option::<String>::None),
            )
            .col_expr(channels::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(channels::Column::SectionId.eq(&id))
            .exec(&db)
            .await?;
        sections::Entity::delete_many()
            .filter(sections::Column::Id.eq(&id))
            .exec(&db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat section")
}
