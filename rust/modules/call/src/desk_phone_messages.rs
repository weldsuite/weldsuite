//! Timeline messages the phone flows write on a call's desk conversation
//! (`lib/desk-phone-messages.ts`): system lines ("Call answered by Anna",
//! "Missed call"), the voicemail. Each is fanned out like the other phone
//! messages (`lib/desk-phone-fanout.ts`): the hub events as the system, then
//! the conversation room.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DESK_CONVERSATION_UPDATED, DESK_MESSAGE_CREATED};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_desk_domain::webchat::{Append, append_desk_message};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::validation::js_trim;

use crate::CallState;
use crate::desk_phone_ring::Phone;

/// `appendDeskMessage(db, …)`: `(conversation, message)`.
pub(crate) async fn append(
    db: &PgPool,
    conversation_id: &str,
    kind: &str,
    author_type: &str,
    author_id: Option<&str>,
    body: String,
    metadata: Map<String, Value>,
) -> Result<(Value, Value), String> {
    append_desk_message(
        db,
        Append {
            conversation_id,
            kind,
            author_type,
            author_id,
            body: Some(body),
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|error| error.to_string())
}

/// A message's `metadata` from a JSON object.
pub(crate) fn meta(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `fanoutDeskPhoneMessage({ … })`: the hub events (as the system; a
/// `desk_message created` first when the message is new), then the
/// conversation room. `org` is the Clerk org id.
pub(crate) async fn fanout(
    state: &CallState,
    org: &str,
    conversation: &Value,
    message: &Value,
    created: bool,
) {
    let context = EventContext::new(org, "system", EventSource::System);
    let conversation_id = conversation["id"].as_str().unwrap_or_default().to_owned();
    if created {
        let mut data = message.clone();
        data["conversationId"] = json!(conversation_id);
        state
            .events
            .publish_and_wait(
                &context,
                EntityEvent::new(
                    DESK_MESSAGE_CREATED,
                    message["id"].as_str().unwrap_or_default(),
                    data,
                ),
            )
            .await;
    }
    state
        .events
        .publish_and_wait(
            &context,
            EntityEvent::new(
                DESK_CONVERSATION_UPDATED,
                &conversation_id,
                conversation.clone(),
            ),
        )
        .await;
    let Some(realtime) = &state.realtime else {
        return;
    };
    let payload = json!({
        "type": "message",
        "id": message["id"],
        "content": message["body"].as_str().unwrap_or_default(),
        "senderId": message["authorId"].as_str().unwrap_or("system"),
        "senderType": message["authorType"],
        "kind": message["kind"],
        "ts": now_ms(),
    });
    if let Err(error) = realtime
        .publish_boxed(&conversation_publish(&conversation_id, payload))
        .await
    {
        tracing::error!(%error, "[desk-phone] realtime publish failed");
    }
}

/// `postPhoneMessage(env, db, workspaceId, conversationId, { body, metadata })`:
/// a system line on the conversation, fanned out. Best effort: a failure is
/// logged and never fails the webhook or the route.
pub(crate) async fn post_phone_message(
    phone: &Phone<'_>,
    conversation_id: Option<&str>,
    body: String,
    metadata: Value,
) {
    let Some(conversation_id) = conversation_id.filter(|id| !id.is_empty()) else {
        return;
    };
    match append(
        phone.db,
        conversation_id,
        "message",
        "system",
        None,
        body,
        meta(metadata),
    )
    .await
    {
        Ok((conversation, message)) => {
            fanout(phone.state, phone.workspace, &conversation, &message, true).await;
        }
        Err(error) => tracing::error!(%error, "[desk-phone] failed to post phone message"),
    }
}

/// `memberDisplayName(db, userId)`: a member's name for timeline lines, else
/// their email, else nothing.
pub(crate) async fn member_display_name(
    db: &PgPool,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, email from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    let Some((name, email)) = row else {
        return Ok(None);
    };
    let shown = |value: Option<String>| {
        value
            .map(|text| js_trim(&text).to_owned())
            .filter(|text| !text.is_empty())
    };
    Ok(shown(name).or_else(|| shown(email)))
}
