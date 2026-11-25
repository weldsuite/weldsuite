//! Read state (`services/chat/channel-reads.ts`): per-message read rows for
//! the "seen by" avatars, and the member's read cursor.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set};
use serde_json::{Value, json};
use time::{Duration, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_message_reads as reads, chat_messages as messages,
};

/// A `timestamp` as Drizzle hands it back (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `markChannelRead`: every live message read, the cursor on the newest.
pub(crate) async fn mark_read(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<Value, DbErr> {
    let orm = orm(db);
    let all: Vec<String> = messages::Entity::find()
        .select_only()
        .column(messages::Column::Id)
        .filter(messages::Column::ChannelId.eq(channel_id))
        .filter(messages::Column::DeletedAt.is_null())
        .order_by_desc(messages::Column::CreatedAt)
        .into_tuple()
        .all(&orm)
        .await?;
    let existing: Vec<String> = reads::Entity::find()
        .select_only()
        .column(reads::Column::MessageId)
        .filter(reads::Column::ChannelId.eq(channel_id))
        .filter(reads::Column::UserId.eq(user_id))
        .into_tuple()
        .all(&orm)
        .await?;
    let unread: Vec<String> = all
        .iter()
        .filter(|id| !existing.contains(id))
        .cloned()
        .collect();
    let at = utc_now();
    let latest = all.first().cloned();
    let previous: Option<Option<PrimitiveDateTime>> = members::Entity::find()
        .select_only()
        .column(members::Column::LastReadAt)
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm)
        .await?;
    for batch in unread.chunks(100) {
        let rows: Vec<reads::ActiveModel> = batch
            .iter()
            .map(|message_id| reads::ActiveModel {
                id: Set(generate_id("cmr")),
                message_id: Set(message_id.clone()),
                channel_id: Set(channel_id.to_owned()),
                user_id: Set(user_id.to_owned()),
                read_at: Set(at),
                ..Default::default()
            })
            .collect();
        reads::Entity::insert_many(rows)
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(&orm)
            .await?;
    }
    members::Entity::update_many()
        .col_expr(members::Column::LastReadAt, Expr::value(at))
        .col_expr(
            members::Column::LastReadMessageId,
            Expr::value(latest.clone()),
        )
        .col_expr(members::Column::UnreadMentionCount, Expr::value(0))
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .exec(&orm)
        .await?;
    Ok(json!({
        "channelId": channel_id,
        "lastReadAt": iso(at),
        "lastReadMessageId": latest,
        "previousLastReadAt": previous.flatten().map(iso),
    }))
}

/// `markChannelUnreadFrom`: unread from `before` onwards; `None` when the
/// message is not in the channel.
pub(crate) async fn mark_unread_from(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    before: &str,
) -> Result<Option<Value>, DbErr> {
    let orm = orm(db);
    let anchor: Option<PrimitiveDateTime> = messages::Entity::find()
        .select_only()
        .column(messages::Column::CreatedAt)
        .filter(messages::Column::Id.eq(before))
        .filter(messages::Column::ChannelId.eq(channel_id))
        .into_tuple()
        .one(&orm)
        .await?;
    // The anchor's `Date`, to the millisecond, as the TypeScript route binds it.
    let Some(anchor) = anchor.map(|at| utc_timestamp(at.assume_utc())) else {
        return Ok(None);
    };
    let to_unread: Vec<String> = messages::Entity::find()
        .select_only()
        .column(messages::Column::Id)
        .filter(messages::Column::ChannelId.eq(channel_id))
        .filter(messages::Column::CreatedAt.gte(anchor))
        .into_tuple()
        .all(&orm)
        .await?;
    for batch in to_unread.chunks(100) {
        reads::Entity::delete_many()
            .filter(reads::Column::ChannelId.eq(channel_id))
            .filter(reads::Column::UserId.eq(user_id))
            .filter(reads::Column::MessageId.is_in(batch))
            .exec(&orm)
            .await?;
    }
    let previous: Option<(String, PrimitiveDateTime)> = messages::Entity::find()
        .select_only()
        .column(messages::Column::Id)
        .column(messages::Column::CreatedAt)
        .filter(messages::Column::ChannelId.eq(channel_id))
        .filter(messages::Column::DeletedAt.is_null())
        .filter(messages::Column::CreatedAt.lt(anchor))
        .order_by_desc(messages::Column::CreatedAt)
        .into_tuple()
        .one(&orm)
        .await?;
    // `new Date(anchor.getTime() - 1)` without an earlier message.
    let (previous_id, last_read_at) = match previous {
        Some((id, at)) => (Some(id), utc_timestamp(at.assume_utc())),
        None => (None, anchor.saturating_sub(Duration::milliseconds(1))),
    };
    members::Entity::update_many()
        .col_expr(members::Column::LastReadAt, Expr::value(last_read_at))
        .col_expr(
            members::Column::LastReadMessageId,
            Expr::value(previous_id.clone()),
        )
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .exec(&orm)
        .await?;
    Ok(Some(json!({
        "channelId": channel_id,
        "lastReadAt": iso(last_read_at),
        "lastReadMessageId": previous_id,
    })))
}
