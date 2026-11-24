//! `/api/chat-bookmarks` (`routes/chat-bookmarks/index.ts`): the caller's
//! own saved messages, with the message and channel they point at. A deleted
//! channel (soft-deleted, `deleted_at` set) hides the bookmarks into it.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{chat_bookmarks, chat_channels, chat_messages};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, unhandled, validate};
use crate::groups::channels::{before_cursor, js, millis, now_stamped, sql_limit};
use crate::util::{list_limit, list_response, page, query_map};

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
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    id: String,
    user_id: String,
    message_id: String,
    channel_id: String,
    note: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    message_content: Option<String>,
    message_author_id: Option<String>,
    message_author_name: Option<String>,
    message_author_avatar: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    message_created_at: Option<PrimitiveDateTime>,
    message_attachments: Option<Value>,
    channel_name: Option<String>,
    channel_slug: Option<String>,
    channel_type: Option<String>,
}

/// `chat_bookmarks left join chat_channels on channel_id`.
fn bookmark_channel() -> RelationDef {
    chat_bookmarks::Entity::belongs_to(chat_channels::Entity)
        .from(chat_bookmarks::Column::ChannelId)
        .to(chat_channels::Column::Id)
        .into()
}

/// The selection with both joins (`left join chat_messages`, `left join
/// chat_channels`), the caller's bookmarks into live channels.
fn selection(user_id: &str) -> sea_orm::Select<chat_bookmarks::Entity> {
    let message: RelationDef = chat_bookmarks::Entity::belongs_to(chat_messages::Entity)
        .from(chat_bookmarks::Column::MessageId)
        .to(chat_messages::Column::Id)
        .into();
    chat_bookmarks::Entity::find()
        .select_only()
        .columns([
            chat_bookmarks::Column::Id,
            chat_bookmarks::Column::UserId,
            chat_bookmarks::Column::MessageId,
            chat_bookmarks::Column::ChannelId,
            chat_bookmarks::Column::Note,
            chat_bookmarks::Column::CreatedAt,
        ])
        .column_as(chat_messages::Column::Content, "message_content")
        .column_as(chat_messages::Column::AuthorId, "message_author_id")
        .column_as(chat_messages::Column::AuthorName, "message_author_name")
        .column_as(chat_messages::Column::AuthorAvatar, "message_author_avatar")
        .column_as(chat_messages::Column::CreatedAt, "message_created_at")
        .column_as(chat_messages::Column::Attachments, "message_attachments")
        .column_as(chat_channels::Column::Name, "channel_name")
        .column_as(chat_channels::Column::Slug, "channel_slug")
        .column_as(chat_channels::Column::Type, "channel_type")
        .join(JoinType::LeftJoin, message)
        .join(JoinType::LeftJoin, bookmark_channel())
        .filter(chat_bookmarks::Column::UserId.eq(user_id))
        .filter(chat_channels::Column::DeletedAt.is_null())
}

/// The caller's bookmark `id`, if any.
async fn own_bookmark(caller: &Caller, id: &str) -> Result<Option<String>, DbErr> {
    chat_bookmarks::Entity::find()
        .select_only()
        .column(chat_bookmarks::Column::Id)
        .filter(chat_bookmarks::Column::Id.eq(id))
        .filter(chat_bookmarks::Column::UserId.eq(&caller.user_id))
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let channel = q.get("channelId").filter(|c| !c.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(PrimitiveDateTime, String)>, DbErr> =
                chat_bookmarks::Entity::find()
                    .select_only()
                    .columns([
                        chat_bookmarks::Column::CreatedAt,
                        chat_bookmarks::Column::Id,
                    ])
                    .filter(chat_bookmarks::Column::Id.eq(cursor))
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
        let in_channel = || {
            let mut filter = Condition::all();
            if let Some(channel) = &channel {
                filter = filter.add(chat_bookmarks::Column::ChannelId.eq(channel));
            }
            filter
        };
        let db = orm(&caller.db);
        let mut rows = selection(&caller.user_id).filter(in_channel());
        if let Some(cursor) = &cursor {
            rows = rows.filter(before_cursor(
                chat_bookmarks::Column::CreatedAt,
                chat_bookmarks::Column::Id,
                cursor,
            ));
        }
        let rows = rows
            .order_by_desc(chat_bookmarks::Column::CreatedAt)
            .order_by_desc(chat_bookmarks::Column::Id)
            .limit(sql_limit(limit + 1)?)
            .into_model::<Bookmark>()
            .all(&db)
            .await?;
        let total = chat_bookmarks::Entity::find()
            .join(JoinType::LeftJoin, bookmark_channel())
            .filter(chat_bookmarks::Column::UserId.eq(&caller.user_id))
            .filter(chat_channels::Column::DeletedAt.is_null())
            .filter(in_channel())
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
    answer(result, "Failed to list chat bookmarks")
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let row = selection(&caller.user_id)
            .filter(chat_bookmarks::Column::Id.eq(&id))
            .into_model::<Bookmark>()
            .one(&orm(&caller.db))
            .await?;
        let Some(row) = row else {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        };
        Ok(Data(js(row)?).into_response())
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
        let (at, stamp) = now_stamped();
        let db = orm(&caller.db);
        let existing: Option<String> = chat_bookmarks::Entity::find()
            .select_only()
            .column(chat_bookmarks::Column::Id)
            .filter(chat_bookmarks::Column::UserId.eq(&caller.user_id))
            .filter(chat_bookmarks::Column::MessageId.eq(&message_id))
            .into_tuple()
            .one(&db)
            .await?;
        if let Some(existing) = existing {
            return Ok(Data(json!({ "id": existing, "alreadyExists": true })).into_response());
        }
        let id = generate_id("cbk");
        chat_bookmarks::Entity::insert(chat_bookmarks::ActiveModel {
            id: Set(id.clone()),
            user_id: Set(caller.user_id.clone()),
            message_id: Set(message_id.clone()),
            channel_id: Set(channel_id.clone()),
            note: Set(note.clone()),
            created_at: Set(stamp),
        })
        .exec_without_returning(&db)
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
        if own_bookmark(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        }
        let value = match &note {
            Field::Set(text) => Some(Some(text.clone())),
            Field::Null => Some(None),
            Field::Absent => None,
        };
        if let Some(value) = value {
            chat_bookmarks::Entity::update_many()
                .col_expr(chat_bookmarks::Column::Note, Expr::value(value))
                .filter(chat_bookmarks::Column::Id.eq(&id))
                .filter(chat_bookmarks::Column::UserId.eq(&caller.user_id))
                .exec(&orm(&caller.db))
                .await?;
        }
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update chat bookmark")
}

async fn remove_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if own_bookmark(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Chat bookmark", Some(&id)));
        }
        chat_bookmarks::Entity::delete_many()
            .filter(chat_bookmarks::Column::Id.eq(&id))
            .filter(chat_bookmarks::Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete chat bookmark")
}
