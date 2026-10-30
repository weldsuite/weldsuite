//! Pinning (`services/chat/pins.ts`, `pin-notice.ts`) and the pin auto-expiry
//! (`UnpinExpiredMessageWorkflow`), here the `chat.unpin-expired-message`
//! job, started with a delay to the pin's expiry.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_chat_domain::Realtime;
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, Job, JobContext, JobError, StepRetry, step,
};

use crate::util::now;

/// A workspace's tenant database for jobs, which run outside any request.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The job's name.
pub const UNPIN_EXPIRED_MESSAGE_JOB: &str = "chat.unpin-expired-message";

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
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select channel_id from chat_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await
}

/// `pinMessage`: the message pinned now by `user_id`, until `expires_at`.
pub(crate) async fn pin_message(
    db: &PgPool,
    message_id: &str,
    user_id: &str,
    expires_at: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(channel_id) = live_message_channel(db, message_id).await? else {
        return Ok(None);
    };
    let at = now();
    sqlx::query(
        "update chat_messages set is_pinned = true, pinned_at = $2::timestamp, pinned_by = $3,
            pin_expires_at = $4::timestamp, updated_at = $2::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(message_id)
    .bind(&at)
    .bind(user_id)
    .bind(expires_at)
    .execute(db)
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
) -> Result<Option<Value>, sqlx::Error> {
    let Some(channel_id) = live_message_channel(db, message_id).await? else {
        return Ok(None);
    };
    sqlx::query(
        "update chat_messages set is_pinned = false, pinned_at = null, pinned_by = null,
            pin_expires_at = null, updated_at = $2::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(message_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(Some(pin_result(message_id, &channel_id, None)))
}

/// `postPinNotice`: the server-authored `system` message "pinned a message";
/// its id.
pub(crate) async fn post_pin_notice(
    db: &PgPool,
    realtime: &Realtime,
    channel_id: &str,
    pinned_message_id: &str,
    user_id: &str,
) -> Result<String, sqlx::Error> {
    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    let (name, picture) = author.unwrap_or((None, None));
    let author_name = name.unwrap_or_else(|| "Unknown".to_owned());
    let id = generate_id("msg");
    let at = now();
    let content = format!("[system:{pinned_message_id}] pinned a message");
    sqlx::query(
        "insert into chat_messages
            (id, channel_id, author_id, author_name, author_avatar, content, type, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'system', $7::timestamp, $7::timestamp)",
    )
    .bind(&id)
    .bind(channel_id)
    .bind(user_id)
    .bind(&author_name)
    .bind(&picture)
    .bind(&content)
    .bind(&at)
    .execute(db)
    .await?;
    sqlx::query(
        "update chat_channels set last_message_at = $2::timestamp, last_message_preview = $3,
            message_count = message_count + 1, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(channel_id)
    .bind(&at)
    .bind(format!("{author_name} pinned a message"))
    .execute(db)
    .await?;
    sqlx::query(
        "update chat_channel_members set last_read_at = $3::timestamp, last_read_message_id = $4
         where channel_id = $1 and user_id = $2",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(&at)
    .bind(&id)
    .execute(db)
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
                    let row: Option<(bool, Option<String>)> = sqlx::query_as(
                        "select is_pinned, to_jsonb(pin_expires_at) #>> '{}' from chat_messages
                     where id = $1 limit 1",
                    )
                    .bind(&message)
                    .fetch_optional(&db)
                    .await
                    .map_err(JobError::failed)?;
                    let still_this_pin = row.is_some_and(|(pinned, at)| {
                        pinned
                            && at.as_deref().map(crate::util::ms_timestamp).as_deref()
                                == weldsuite_kit::validation::js_date_iso(&expires).as_deref()
                    });
                    if !still_this_pin {
                        return Ok(false);
                    }
                    sqlx::query(
                    "update chat_messages set is_pinned = false, pinned_at = null, pinned_by = null,
                        pin_expires_at = null, updated_at = $2::timestamp
                     where id = $1",
                )
                .bind(&message)
                .bind(now())
                .execute(&db)
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
