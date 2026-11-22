//! Pinning (`services/chat/pins.ts`, `pin-notice.ts`) and the pin auto-expiry
//! (`UnpinExpiredMessageWorkflow`), here the `chat.unpin-expired-message`
//! job, started with a delay to the pin's expiry.

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, Set};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_chat_domain::Realtime;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, Job, JobContext, JobError, StepRetry, step,
};
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_channels as channels, chat_messages as messages,
    workspace_members,
};

/// A workspace's tenant database for jobs, which run outside any request.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The job's name.
pub const UNPIN_EXPIRED_MESSAGE_JOB: &str = "chat.unpin-expired-message";

/// A `timestamp` as Drizzle hands it back (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `PinResult`, as the routes answer it.
pub(crate) fn pin_result(
    message_id: &str,
    channel_id: &str,
    pinned: Option<(&str, &str, Option<&str>)>,
) -> Value {
    match pinned {
        Some((at, by, expires)) => json!({
            "messageId": message_id,
            "channelId": channel_id,
            "isPinned": true,
            "pinnedAt": at,
            "pinnedBy": by,
            "pinExpiresAt": expires,
        }),
        None => json!({
            "messageId": message_id,
            "channelId": channel_id,
            "isPinned": false,
            "pinnedAt": null,
            "pinnedBy": null,
            "pinExpiresAt": null,
        }),
    }
}

/// The live message's channel.
pub(crate) async fn live_message_channel(
    db: &PgPool,
    message_id: &str,
) -> Result<Option<String>, DbErr> {
    messages::Entity::find()
        .select_only()
        .column(messages::Column::ChannelId)
        .filter(messages::Column::Id.eq(message_id))
        .filter(messages::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `new Date(expiresAt)` (a `toISOString()`) as `$n::timestamp` reads it.
fn expiry_timestamp(expires_at: Option<&str>) -> Result<Option<PrimitiveDateTime>, DbErr> {
    expires_at
        .map(|iso| {
            time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
                .map(utc_timestamp)
                .map_err(|error| DbErr::Custom(format!("invalid timestamp {iso:?}: {error}")))
        })
        .transpose()
}

/// `pinMessage`: the message pinned now by `user_id`, until `expires_at`.
pub(crate) async fn pin_message(
    db: &PgPool,
    message_id: &str,
    user_id: &str,
    expires_at: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    let Some(channel_id) = live_message_channel(db, message_id).await? else {
        return Ok(None);
    };
    let stamp = utc_now();
    let at = iso(stamp);
    messages::Entity::update_many()
        .col_expr(messages::Column::IsPinned, Expr::value(true))
        .col_expr(messages::Column::PinnedAt, Expr::value(stamp))
        .col_expr(messages::Column::PinnedBy, Expr::value(user_id))
        .col_expr(
            messages::Column::PinExpiresAt,
            Expr::value(expiry_timestamp(expires_at)?),
        )
        .col_expr(messages::Column::UpdatedAt, Expr::value(stamp))
        .filter(messages::Column::Id.eq(message_id))
        .filter(messages::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(Some(pin_result(
        message_id,
        &channel_id,
        Some((&at, user_id, expires_at)),
    )))
}

/// `unpinMessage`.
pub(crate) async fn unpin_message(
    db: &PgPool,
    message_id: &str,
) -> Result<Option<Value>, DbErr> {
    let Some(channel_id) = live_message_channel(db, message_id).await? else {
        return Ok(None);
    };
    clear_pin(messages::Entity::update_many())
        .filter(messages::Column::Id.eq(message_id))
        .filter(messages::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(Some(pin_result(message_id, &channel_id, None)))
}

/// `set is_pinned = false, pinned_at = null, pinned_by = null,
/// pin_expires_at = null, updated_at = now`.
fn clear_pin(update: sea_orm::UpdateMany<messages::Entity>) -> sea_orm::UpdateMany<messages::Entity> {
    update
        .col_expr(messages::Column::IsPinned, Expr::value(false))
        .col_expr(
            messages::Column::PinnedAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(messages::Column::PinnedBy, Expr::value(Option::<String>::None))
        .col_expr(
            messages::Column::PinExpiresAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(messages::Column::UpdatedAt, Expr::value(utc_now()))
}

/// `postPinNotice`: the server-authored `system` message "pinned a message";
/// its id.
pub(crate) async fn post_pin_notice(
    db: &PgPool,
    master: Option<&PgPool>,
    realtime: &Realtime,
    channel_id: &str,
    pinned_message_id: &str,
    user_id: &str,
) -> Result<String, DbErr> {
    let orm = orm(db);
    let name: Option<Option<String>> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm)
        .await?;
    let author_name = name.flatten().unwrap_or_else(|| "Unknown".to_owned());
    // The stamped avatar is the account picture, not the member row's copy.
    let picture = weldsuite_db::load_account_picture(master, user_id).await;
    let id = generate_id("msg");
    let at = utc_now();
    let content = format!("[system:{pinned_message_id}] pinned a message");
    messages::Entity::insert(messages::ActiveModel {
        id: Set(id.clone()),
        channel_id: Set(channel_id.to_owned()),
        author_id: Set(user_id.to_owned()),
        author_name: Set(author_name.clone()),
        author_avatar: Set(picture.clone()),
        content: Set(content.clone()),
        type_: Set("system".to_owned()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm)
    .await?;
    channels::Entity::update_many()
        .col_expr(channels::Column::LastMessageAt, Expr::value(at))
        .col_expr(
            channels::Column::LastMessagePreview,
            Expr::value(format!("{author_name} pinned a message")),
        )
        .col_expr(
            channels::Column::MessageCount,
            sea_orm::ExprTrait::add(Expr::col(channels::Column::MessageCount), 1),
        )
        .col_expr(channels::Column::UpdatedAt, Expr::value(at))
        .filter(channels::Column::Id.eq(channel_id))
        .exec(&orm)
        .await?;
    members::Entity::update_many()
        .col_expr(members::Column::LastReadAt, Expr::value(at))
        .col_expr(members::Column::LastReadMessageId, Expr::value(&id))
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .exec(&orm)
        .await?;
    if realtime.is_on() {
        let mut payload = json!({
            "type": "message",
            "id": id,
            "content": content,
            "senderId": user_id,
            "senderName": author_name,
            "authorType": "user",
            "messageType": "system",
            "ts": weldsuite_chat_domain::publish::now_ms(),
        });
        if let Some(picture) = picture {
            payload["senderAvatar"] = Value::from(picture);
        }
        realtime.chat(channel_id, payload).await;
    }
    Ok(id)
}

/// `UnpinExpiredMessageWorkflow`: at the pin's expiry, unpin the message if
/// it is still pinned with that expiry (a manual unpin, or a re-pin with
/// another expiry, makes the run a no-op), and tell the channel.
pub struct UnpinExpiredMessageJob {
    pub tenants: TenantDatabases,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
}

impl std::fmt::Debug for UnpinExpiredMessageJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UnpinExpiredMessageJob")
    }
}

impl Job for UnpinExpiredMessageJob {
    fn name(&self) -> &'static str {
        UNPIN_EXPIRED_MESSAGE_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let text = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
            let (workspace, channel, message, expires) = (
                text("workspaceId"),
                text("channelId"),
                text("messageId"),
                text("expiresAt"),
            );
            let retry = StepRetry::exponential(3, std::time::Duration::from_secs(5));
            let tenants = &self.tenants;
            let unpinned: bool = step(ctx, "unpin-message", retry, || {
                let (workspace, message, expires) =
                    (workspace.clone(), message.clone(), expires.clone());
                async move {
                    let db = (tenants)(workspace.clone())
                        .await
                        .map_err(JobError::failed)?;
                    let orm = orm(&db);
                    let row: Option<(bool, Option<PrimitiveDateTime>)> =
                        messages::Entity::find()
                            .select_only()
                            .column(messages::Column::IsPinned)
                            .column(messages::Column::PinExpiresAt)
                            .filter(messages::Column::Id.eq(&message))
                            .into_tuple()
                            .one(&orm)
                            .await
                            .map_err(JobError::failed)?;
                    let still_this_pin = row.is_some_and(|(pinned, at)| {
                        pinned
                            && at.map(iso).as_deref()
                                == weldsuite_kit::validation::js_date_iso(&expires).as_deref()
                    });
                    if !still_this_pin {
                        return Ok(false);
                    }
                    clear_pin(messages::Entity::update_many())
                        .filter(messages::Column::Id.eq(&message))
                        .exec(&orm)
                        .await
                        .map_err(JobError::failed)?;
                    Ok(true)
                }
            })
            .await?;
            if unpinned {
                Realtime::new(self.realtime.clone())
                    .pin(&channel, &message, "", "unpinned")
                    .await;
            }
            Ok(())
        })
    }
}
