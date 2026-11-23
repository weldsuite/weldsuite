//! `/api/chat-activity` (`routes/chat-activity/index.ts`): the caller's
//! WeldChat notifications that ask for their attention (mentions, replies in
//! their threads, missed calls) as a feed. A DM's messages are not activity:
//! they show in the DM itself.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::{orm, utc_now};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::notifications::{self, Column};
use weldsuite_schema::tenant::chat_channels;

use crate::ChatState;
use crate::access::{Caller, answer, validate, validate_query};
use crate::util::list_response;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["messages:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/read", post(mark_read).route_layer(read()))
        .route("/unread-count", get(unread_count).route_layer(read()))
}

const FILTERS: [&str; 4] = ["all", "mentions", "replies", "dms"];

/// What the feed lists, counts and marks read.
const FEED_TYPES: [&str; 3] = ["chat_mention", "chat_thread_reply", "chat_missed_call"];

fn filter_types(filter: &str) -> Vec<String> {
    let types: &[&str] = match filter {
        "mentions" => &["chat_mention"],
        "replies" => &["chat_thread_reply"],
        // Kept for clients one version behind, which still offer a DMs filter.
        "dms" => &["chat_dm"],
        _ => &FEED_TYPES,
    };
    types.iter().map(|t| (*t).to_owned()).collect()
}

fn feed_types() -> Vec<String> {
    FEED_TYPES.iter().map(|t| (*t).to_owned()).collect()
}

/// The caller's live WeldChat notifications of `types` (`types` not empty).
fn feed(user_id: &str, types: &[String]) -> Condition {
    Condition::all()
        .add(Column::UserId.eq(user_id))
        .add(Column::Category.eq("weldchat"))
        .add(Column::DeletedAt.is_null())
        .add(Column::NotificationType.is_in(types.iter().map(String::as_str)))
}

/// `$n::timestamptz` of the cursor's `toISOString()`; `Err` is the failed
/// cast (the route's 500).
fn instant_of(text: &str) -> Result<OffsetDateTime, DbErr> {
    OffsetDateTime::parse(text, &Rfc3339).map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp with time zone: \"{text}\""
        ))
    })
}

/// A feed row: the notification and its channel's name.
#[derive(Debug, FromQueryResult)]
struct FeedRow {
    id: String,
    notification_type: String,
    title: String,
    body: Option<String>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    actor_id: Option<String>,
    action_url: Option<String>,
    read_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    channel_id: Option<String>,
    channel_name: Option<String>,
}

/// The cursor: base64 JSON `{ createdAt, id }`; a malformed one is ignored.
fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let bytes = STANDARD
        .decode(cursor.trim_end_matches('='))
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(cursor.trim_end_matches('='))
        })
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let created = value["createdAt"].as_str()?;
    let id = value["id"].as_str()?;
    let created = weldsuite_kit::validation::js_date_iso(created)?;
    Some((created, id.to_owned()))
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, values| {
        let cursor = issues.string(values, "cursor", false, None, None);
        let limit = issues
            .number(
                values,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    min: Some(1.0),
                    max: Some(100.0),
                    ..Number::default()
                },
            )
            .into_option()
            .unwrap_or(25.0);
        let filter = issues
            .choice(values, "filter", Presence::Optional, &FILTERS)
            .into_option()
            .unwrap_or_else(|| "all".to_owned());
        (cursor, limit, filter)
    });
    let (cursor, limit, filter) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.ceil() as i64;
    let types = filter_types(&filter);
    let (cursor_at, cursor_id) = cursor.as_deref().and_then(decode_cursor).unzip();
    let result = async {
        // `t.data->>'channelId'`.
        let channel_id = || {
            pg::PgExpr::cast_json_field(
                Expr::col((notifications::Entity, Column::Data)),
                "channelId",
            )
        };
        let mut rows = notifications::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::NotificationType,
                Column::Title,
                Column::Body,
                Column::EntityType,
                Column::EntityId,
                Column::ActorId,
                Column::ActionUrl,
                Column::ReadAt,
                Column::CreatedAt,
            ])
            .column_as(channel_id(), "channel_id")
            .column_as(chat_channels::Column::Name, "channel_name")
            .filter(feed(&caller.user_id, &types));
        // `left join chat_channels c on c.id = (t.data->>'channelId')`.
        QueryTrait::query(&mut rows).join(
            JoinType::LeftJoin,
            chat_channels::Entity,
            sea_orm::ExprTrait::eq(
                Expr::col((chat_channels::Entity, chat_channels::Column::Id)),
                channel_id(),
            ),
        );
        if let (Some(at), Some(cursor_id)) = (&cursor_at, &cursor_id) {
            let at = instant_of(at)?;
            rows = rows.filter(
                Condition::any().add(Column::CreatedAt.lt(at)).add(
                    Condition::all()
                        .add(Column::CreatedAt.eq(at))
                        .add(Column::Id.lt(cursor_id.as_str())),
                ),
            );
        }
        let db = orm(&caller.db);
        let rows = rows
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(u64::try_from(limit + 1).unwrap_or(0))
            .into_model::<FeedRow>()
            .all(&db)
            .await?;
        let total = notifications::Entity::find()
            .filter(feed(&caller.user_id, &types))
            .count(&db)
            .await?;
        let limit_len = usize::try_from(limit.max(0)).unwrap_or(0);
        let has_more = rows.len() > limit_len;
        let rows: Vec<FeedRow> = rows.into_iter().take(limit_len).collect();
        let next = if has_more {
            rows.last().map(|row| {
                let text =
                    json!({ "createdAt": iso_timestamp(row.created_at), "id": row.id }).to_string();
                STANDARD.encode(text)
            })
        } else {
            None
        };
        let items: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let message_id = if row.entity_type.as_deref() == Some("message") {
                    row.entity_id
                } else {
                    None
                };
                json!({
                    "id": row.id,
                    "type": row.notification_type,
                    "title": row.title,
                    "body": row.body,
                    "channelId": row.channel_id,
                    "channelName": row.channel_name,
                    "messageId": message_id,
                    "actorId": row.actor_id,
                    "actorName": null,
                    "actorAvatarUrl": null,
                    "actionUrl": row.action_url,
                    "readAt": row.read_at.map(iso_timestamp),
                    "createdAt": iso_timestamp(row.created_at),
                })
            })
            .collect();
        Ok(list_response(
            items,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, "Failed to fetch activity")
}

async fn mark_read(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let id = validate(&headers, &body, |issues, body| {
        issues.string(body, "notificationId", false, None, None)
    });
    let id = match id {
        Ok(id) => id.filter(|i| !i.is_empty()),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let which = match &id {
            Some(id) => Column::Id.eq(id),
            // "Mark all read" clears the feed, not the notifications it leaves out.
            None => Column::NotificationType.is_in(FEED_TYPES),
        };
        notifications::Entity::update_many()
            // `new Date()`, to the millisecond.
            .col_expr(Column::ReadAt, Expr::value(utc_now().assume_utc()))
            .col_expr(Column::IsRead, Expr::value(true))
            .filter(Column::UserId.eq(&caller.user_id))
            .filter(Column::Category.eq("weldchat"))
            .filter(Column::ReadAt.is_null())
            .filter(Column::DeletedAt.is_null())
            .filter(which)
            .exec(&orm(&caller.db))
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to mark activity as read")
}

async fn unread_count(caller: Caller) -> Response {
    let result = async {
        let count = notifications::Entity::find()
            .filter(feed(&caller.user_id, &feed_types()))
            .filter(Column::ReadAt.is_null())
            .count(&orm(&caller.db))
            .await?;
        Ok(Data(json!({ "count": count })).into_response())
    }
    .await;
    answer(result, "Failed to get unread count")
}
