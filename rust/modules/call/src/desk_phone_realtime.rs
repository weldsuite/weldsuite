//! Realtime for the WeldDesk phone queue (`lib/desk-phone-realtime.ts`).
//! The workspace is its Clerk org id throughout (what the realtime hub keys
//! on). Without a realtime publisher (`REALTIME`) every publish is a no-op
//! and presence reads "everyone".
//!
//! Browser contract:
//!   topic `inbox.<userId>`   events `phone.incoming` | `phone.answered` | `phone.ended`
//!   topic `desk_phone_queue` event `updated` `{ waiting: number }`

use serde_json::{Value, json};
use weldsuite_ports::RealtimeMessage;

use crate::desk_phone_ring::Phone;

/// `waitingCallsCondition()` on `voip_calls c`: callers waiting for an
/// agent, i.e. queued, no agent yet, not ended, no outcome.
macro_rules! waiting_calls {
    () => {
        "c.queue_entered_at is not null and c.agent_answered_at is null \
         and c.ended_at is null and c.outcome is null"
    };
}
pub(crate) use waiting_calls;

/// `sendPhoneInboxEvent(env, workspaceId, userId, event, data)`: one member's
/// inbox event (`phone.incoming`, `phone.answered`, `phone.ended`). Never
/// fails.
pub(crate) async fn send_inbox_event(phone: &Phone<'_>, user_id: &str, event: &str, data: Value) {
    let Some(realtime) = &phone.state.realtime else {
        return;
    };
    let message = RealtimeMessage::personal(
        phone.workspace,
        &format!("inbox.{user_id}"),
        event,
        data,
        user_id,
    );
    if let Err(error) = realtime.publish_boxed(&message).await {
        tracing::error!(%error, event, "[desk-phone] realtime inbox event failed");
    }
}

/// `publishPhoneQueueChange(env, db, workspaceId)`: tell every client the
/// waiting set changed. Never fails.
pub(crate) async fn publish_queue_change(phone: &Phone<'_>) {
    let Some(realtime) = &phone.state.realtime else {
        return;
    };
    let published = async {
        let waiting: i64 = sqlx::query_scalar(concat!(
            "select count(*) from voip_calls c where ",
            waiting_calls!()
        ))
        .fetch_one(phone.db)
        .await
        .map_err(|error| error.to_string())?;
        let message = RealtimeMessage::workspace(
            phone.workspace,
            "desk_phone_queue",
            "updated",
            json!({ "waiting": waiting }),
            "system",
        );
        realtime
            .publish_boxed(&message)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    if let Err(error) = published {
        tracing::error!(%error, "[desk-phone] realtime queue update failed");
    }
}

/// `onlineUserIds(env, workspaceId, userIds)`: which of `user_ids` have a
/// realtime connection open and read `online`. Without realtime, or when
/// presence cannot be read, everyone counts as online.
pub(crate) async fn online_user_ids(phone: &Phone<'_>, user_ids: &[String]) -> Vec<String> {
    let Some(realtime) = &phone.state.realtime else {
        return user_ids.to_vec();
    };
    if user_ids.is_empty() {
        return Vec::new();
    }
    // The request's presence source (conformance: the test's `REALTIME`
    // binding), else the gateway's own state.
    let read = match phone.presence {
        Some(reader) => reader.0.presence(phone.workspace, user_ids).await,
        None => realtime
            .presence_boxed(phone.workspace, user_ids)
            .await
            .map(|live| live.into_iter().collect()),
    };
    match read {
        Ok(live) => user_ids
            .iter()
            .filter(|id| {
                live.iter()
                    .any(|(user, presence)| user == *id && presence == "online")
            })
            .cloned()
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "[desk-phone] presence unavailable, treating everyone as online");
            user_ids.to_vec()
        }
    }
}
