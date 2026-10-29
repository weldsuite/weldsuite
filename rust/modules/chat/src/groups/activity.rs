//! `/api/chat-activity` (`routes/chat-activity/index.ts`): the caller's
//! WeldChat notifications (mentions, replies, DMs, missed calls) as a feed.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, answer, validate, validate_query};
use crate::util::{list_response, ms_timestamp, now};

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

fn filter_types(filter: &str) -> Vec<String> {
    let types: &[&str] = match filter {
        "mentions" => &["chat_mention"],
        "replies" => &["chat_thread_reply"],
        "dms" => &["chat_dm"],
        _ => &["chat_mention", "chat_dm", "chat_thread_reply", "chat_missed_call"],
    };
    types.iter().map(|t| (*t).to_owned()).collect()
}

/// The cursor: base64 JSON `{ createdAt, id }`; a malformed one is ignored.
fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let bytes = STANDARD
        .decode(cursor.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(cursor.trim_end_matches('=')))
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
        type Row = (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = sqlx::query_as(
            "select t.id, t.notification_type, t.title, t.body, t.entity_type, t.entity_id,
                    t.actor_id, t.action_url, to_jsonb(t.read_at) #>> '{}',
                    to_jsonb(t.created_at) #>> '{}', (t.data->>'channelId'), c.name
             from notifications t
             left join chat_channels c on c.id = (t.data->>'channelId')
             where t.user_id = $1 and t.category = 'weldchat' and t.deleted_at is null
               and t.notification_type = any($2)
               and ($3::text is null or (t.created_at < $3::timestamptz
                    or (t.created_at = $3::timestamptz and t.id < $4)))
             order by t.created_at desc, t.id desc limit $5",
        )
        .bind(&caller.user_id)
        .bind(&types)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from notifications t
             where t.user_id = $1 and t.category = 'weldchat' and t.deleted_at is null
               and t.notification_type = any($2)",
        )
        .bind(&caller.user_id)
        .bind(&types)
        .fetch_one(&caller.db)
        .await?;
        let limit_len = usize::try_from(limit.max(0)).unwrap_or(0);
        let has_more = rows.len() > limit_len;
        let rows: Vec<Row> = rows.into_iter().take(limit_len).collect();
        let next = if has_more {
            rows.last().map(|row| {
                let text = json!({ "createdAt": ms_timestamp(&row.9), "id": row.0 }).to_string();
                STANDARD.encode(text)
            })
        } else {
            None
        };
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(id, kind, title, body, entity_type, entity_id, actor, action, read_at, created_at, channel_id, channel_name)| {
                let message_id = if entity_type.as_deref() == Some("message") { entity_id } else { None };
                json!({
                    "id": id,
                    "type": kind,
                    "title": title,
                    "body": body,
                    "channelId": channel_id,
                    "channelName": channel_name,
                    "messageId": message_id,
                    "actorId": actor,
                    "actorName": null,
                    "actorAvatarUrl": null,
                    "actionUrl": action,
                    "readAt": read_at.map(|at| ms_timestamp(&at)),
                    "createdAt": ms_timestamp(&created_at),
                })
            })
            .collect();
        Ok(list_response(items, total, has_more, next))
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
        sqlx::query(
            "update notifications set read_at = $3::timestamptz, is_read = true
             where user_id = $1 and category = 'weldchat' and read_at is null and deleted_at is null
               and ($2::text is null or id = $2)",
        )
        .bind(&caller.user_id)
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to mark activity as read")
}

async fn unread_count(caller: Caller) -> Response {
    let result = async {
        let count: i64 = sqlx::query_scalar(
            "select count(*) from notifications
             where user_id = $1 and category = 'weldchat' and read_at is null and deleted_at is null",
        )
        .bind(&caller.user_id)
        .fetch_one(&caller.db)
        .await?;
        Ok(Data(json!({ "count": count })).into_response())
    }
    .await;
    answer(result, "Failed to get unread count")
}
