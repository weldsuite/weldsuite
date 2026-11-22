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
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::chat_drafts::{self, Column};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::groups::channels::{before_cursor, js, millis, sql_limit};
use crate::util::{list_limit, list_response, page, query_map};

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

/// A stored draft that isn't empty: `btrim(content) <> '' or
/// (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) > 0)`.
fn not_empty() -> Condition {
    let attachments = || Expr::col((chat_drafts::Entity, Column::Attachments));
    Condition::any()
        .add(sea_orm::ExprTrait::ne(
            Func::cust("btrim").arg(Expr::col((chat_drafts::Entity, Column::Content))),
            "",
        ))
        .add(
            Condition::all()
                .add(sea_orm::ExprTrait::eq(
                    Func::cust("jsonb_typeof").arg(attachments()),
                    "array",
                ))
                .add(sea_orm::ExprTrait::gt(
                    Func::cust("jsonb_array_length").arg(attachments()),
                    0,
                )),
        )
}

/// `column = $n`, or `column is null` for no value.
fn same_or_null(column: Column, value: Option<&str>) -> Expr {
    match value {
        Some(value) => column.eq(value),
        None => column.is_null(),
    }
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let channel = q.get("channelId").filter(|c| !c.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(PrimitiveDateTime, String)>, DbErr> =
                chat_drafts::Entity::find()
                    .select_only()
                    .columns([Column::CreatedAt, Column::Id])
                    .filter(Column::Id.eq(cursor))
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await;
            match row {
                Ok(row) => row.map(|(at, id)| (millis(at), id)),
                Err(error) => return unhandled(error.into()),
            }
        }
        None => None,
    };
    let result = async {
        let mut filters = Condition::all()
            .add(Column::UserId.eq(&caller.user_id))
            .add(not_empty());
        if let Some(channel) = &channel {
            filters = filters.add(Column::ChannelId.eq(channel));
        }
        let db = orm(&caller.db);
        let mut rows = chat_drafts::Entity::find().filter(filters.clone());
        if let Some(cursor) = &cursor {
            rows = rows.filter(before_cursor(Column::CreatedAt, Column::Id, cursor));
        }
        let rows = rows
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(sql_limit(limit + 1)?)
            .all(&db)
            .await?;
        let total = chat_drafts::Entity::find()
            .filter(filters)
            .count(&db)
            .await?;
        let rows = rows.into_iter().map(js).collect::<Result<_, _>>()?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, "Failed to list chat drafts")
}

async fn own_draft(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    chat_drafts::Entity::find_by_id(id.to_owned())
        .filter(Column::UserId.eq(&caller.user_id))
        .one(&orm(&caller.db))
        .await?
        .map(js)
        .transpose()
}

/// Delete the caller's draft `id`.
async fn delete_own(caller: &Caller, id: &str) -> Result<(), DbErr> {
    chat_drafts::Entity::delete_many()
        .filter(Column::Id.eq(id))
        .filter(Column::UserId.eq(&caller.user_id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
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
/// The route narrows `channelId` to `.min(1)`: an empty id is no channel, and
/// every composer that failed to resolve its channel would share that draft.
fn read_draft(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let _ = issues.text(body, "channelId", Presence::Nullish, Some(1), None);
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
            let removed: Vec<String> = chat_drafts::Entity::delete_many()
                .filter(Column::UserId.eq(&caller.user_id))
                .filter(same_or_null(Column::ChannelId, channel.as_deref()))
                .filter(same_or_null(
                    Column::ThreadParentMessageId,
                    parent.as_deref(),
                ))
                .exec_with_returning(&orm(&caller.db))
                .await?
                .into_iter()
                .map(|draft| draft.id)
                .collect();
            return Ok(Data(json!({
                "id": removed.first(),
                "deleted": !removed.is_empty(),
            }))
            .into_response());
        }
        let id = generate_id("cdft");
        let at = utc_now();
        // A plain insert rather than an `ActiveModel`: a draft of attachments
        // alone sends no `content`, and its `null` is refused by the column as
        // the worker's insert is.
        let insert = Query::insert()
            .into_table(chat_drafts::Entity)
            .columns([
                Column::Id,
                Column::WorkspaceId,
                Column::UserId,
                Column::ChannelId,
                Column::ThreadParentMessageId,
                Column::Content,
                Column::Attachments,
                Column::CreatedAt,
                Column::UpdatedAt,
            ])
            .values_panic([
                Expr::value(id.clone()),
                Expr::value(org.clone()),
                Expr::value(caller.user_id.clone()),
                Expr::value(text_of(data.get("channelId")).flatten()),
                Expr::value(text_of(data.get("threadParentMessageId")).flatten()),
                Expr::value(text_of(data.get("content")).flatten()),
                Expr::value(data.get("attachments").filter(|a| !a.is_null()).cloned()),
                Expr::value(at),
                Expr::value(at),
            ])
            .to_owned();
        orm(&caller.db).execute(&insert).await?;
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
            delete_own(&caller, &id).await?;
            return Ok(Data(json!({ "id": id, "deleted": true })).into_response());
        }
        // `case when $set then $value else column end`: the fields the body sent.
        let mut update =
            chat_drafts::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        for (key, column) in [
            ("channelId", Column::ChannelId),
            ("threadParentMessageId", Column::ThreadParentMessageId),
            ("content", Column::Content),
        ] {
            if let Some(value) = text_of(data.get(key)) {
                update = update.col_expr(column, Expr::value(value));
            }
        }
        if let Some(attachments) = data.get("attachments") {
            update = update.col_expr(
                Column::Attachments,
                Expr::value(Some(attachments.clone()).filter(|a| !a.is_null())),
            );
        }
        update
            .filter(Column::Id.eq(&id))
            .filter(Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
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
        delete_own(&caller, &id).await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat draft")
}

#[allow(dead_code)]
fn unused(_: Field<String>) {}
