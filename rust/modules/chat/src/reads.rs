//! Read state (`services/chat/channel-reads.ts`): per-message read rows for
//! the "seen by" avatars, and the member's read cursor.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::util::{ms_timestamp, now};

/// `markChannelRead`: every live message read, the cursor on the newest.
pub(crate) async fn mark_read(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<Value, sqlx::Error> {
    let all: Vec<String> = sqlx::query_scalar(
        "select id from chat_messages where channel_id = $1 and deleted_at is null
         order by created_at desc",
    )
    .bind(channel_id)
    .fetch_all(db)
    .await?;
    let existing: Vec<String> = sqlx::query_scalar(
        "select message_id from chat_message_reads where channel_id = $1 and user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let unread: Vec<String> = all
        .iter()
        .filter(|id| !existing.contains(id))
        .cloned()
        .collect();
    let at = now();
    let latest = all.first().cloned();
    let previous: Option<Option<String>> = sqlx::query_scalar(
        "select last_read_at::text from chat_channel_members
         where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    for batch in unread.chunks(100) {
        let ids: Vec<String> = batch.iter().map(|_| generate_id("cmr")).collect();
        sqlx::query(
            "insert into chat_message_reads (id, message_id, channel_id, user_id, read_at)
             select r.id, r.message_id, $3, $4, $5::timestamp
             from unnest($1::varchar[], $2::varchar[]) with ordinality as r(id, message_id, n)
             order by r.n
             on conflict do nothing",
        )
        .bind(&ids)
        .bind(batch)
        .bind(channel_id)
        .bind(user_id)
        .bind(&at)
        .execute(db)
        .await?;
    }
    sqlx::query(
        "update chat_channel_members set last_read_at = $3::timestamp, last_read_message_id = $4,
            unread_mention_count = 0
         where channel_id = $1 and user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(&at)
    .bind(&latest)
    .execute(db)
    .await?;
    Ok(json!({
        "channelId": channel_id,
        "lastReadAt": at,
        "lastReadMessageId": latest,
        "previousLastReadAt": previous.flatten().map(|p| ms_timestamp(&p)),
    }))
}

/// `markChannelUnreadFrom`: unread from `before` onwards; `None` when the
/// message is not in the channel.
pub(crate) async fn mark_unread_from(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    before: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let anchor: Option<String> = sqlx::query_scalar(
        "select created_at::text from chat_messages where id = $1 and channel_id = $2 limit 1",
    )
    .bind(before)
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    let Some(anchor) = anchor.map(|a| ms_timestamp(&a)) else {
        return Ok(None);
    };
    let to_unread: Vec<String> = sqlx::query_scalar(
        "select id from chat_messages where channel_id = $1 and created_at >= $2::timestamp",
    )
    .bind(channel_id)
    .bind(&anchor)
    .fetch_all(db)
    .await?;
    for batch in to_unread.chunks(100) {
        sqlx::query(
            "delete from chat_message_reads
             where channel_id = $1 and user_id = $2 and message_id = any($3)",
        )
        .bind(channel_id)
        .bind(user_id)
        .bind(batch)
        .execute(db)
        .await?;
    }
    let previous: Option<(String, String)> = sqlx::query_as(
        "select id, created_at::text from chat_messages
         where channel_id = $1 and deleted_at is null and created_at < $2::timestamp
         order by created_at desc limit 1",
    )
    .bind(channel_id)
    .bind(&anchor)
    .fetch_optional(db)
    .await?;
    let (previous_id, last_read_at) = match previous {
        Some((id, at)) => (Some(id), ms_timestamp(&at)),
        None => (None, one_ms_before(&anchor)),
    };
    sqlx::query(
        "update chat_channel_members set last_read_at = $3::timestamp, last_read_message_id = $4
         where channel_id = $1 and user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(&last_read_at)
    .bind(&previous_id)
    .execute(db)
    .await?;
    Ok(Some(json!({
        "channelId": channel_id,
        "lastReadAt": last_read_at,
        "lastReadMessageId": previous_id,
    })))
}

/// `new Date(at.getTime() - 1).toISOString()`.
fn one_ms_before(at: &str) -> String {
    let parsed =
        time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok();
    parsed.map_or_else(
        || at.to_owned(),
        |at| weldsuite_events::iso_timestamp(at - time::Duration::milliseconds(1)),
    )
}
