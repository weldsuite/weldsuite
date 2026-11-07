//! One WeldMerge post in a WeldChat channel (`services/chat/post.ts`): a
//! system message authored by `app:weldmerge` whose `metadata.weldmerge` the
//! chat UI renders as a card. It goes through
//! `weldsuite_chat_domain::system_message` (channel counters, realtime,
//! unread counts) and then publishes the `chat_message` created event, as
//! WeldConnect's post-chat-message action does.

use serde_json::{Value, json};
use weldsuite_chat_domain::system_message::{
    SystemMessageContext, SystemMessageInput, post_system_chat_message,
};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};

use crate::MergeError;
use crate::db::text;
use crate::hooks::HookContext;

/// `MERGE_CHAT_AUTHOR`: the author id of every WeldMerge chat post.
pub(crate) const MERGE_CHAT_AUTHOR: &str = "app:weldmerge";
/// `MERGE_CHAT_AUTHOR_NAME`.
pub(crate) const MERGE_CHAT_AUTHOR_NAME: &str = "WeldMerge";

/// `postCard(ctx, channelId, content, card)`: `card` is the
/// `MergeChatCardMetadata` (`{ kind, pullRequestId?, issueId?, releaseId?, itemKey? }`).
pub(crate) async fn post_card(
    ctx: &HookContext,
    channel_id: &str,
    content: &str,
    card: Value,
) -> Result<(), MergeError> {
    // `ctx.clerkOrgId`: the stores still keyed by it (realtime topics, events).
    let org_id = ctx
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| ctx.workspace_id.clone());
    let message = post_system_chat_message(
        &SystemMessageContext {
            db: &ctx.db,
            realtime: ctx.state.realtime.clone(),
            org_id: &org_id,
            channel_id,
            author_id: MERGE_CHAT_AUTHOR,
            author_name: MERGE_CHAT_AUTHOR_NAME,
            invoker_user_id: &ctx.user_id,
        },
        &SystemMessageInput {
            content,
            mentions: &[],
            metadata: Some(json!({ "weldmerge": card })),
        },
    )
    .await?;
    let id = text(&message, "id").to_owned();
    // `publishEntityEventRaw` (source `system`), awaited.
    let kind = EventType::catalog("chat_message", "created")
        .map_err(|error| MergeError::Unexpected(format!("{error:?}")))?;
    let event = EntityEvent::new(
        kind,
        &id,
        json!({ "id": id, "channelId": channel_id, "authorId": MERGE_CHAT_AUTHOR, "authorType": "system" }),
    );
    let event_context = EventContext::new(org_id, ctx.user_id.clone(), EventSource::System);
    ctx.state
        .events
        .publish_and_wait(&event_context, event)
        .await;
    Ok(())
}

/// `postCardToChannels(ctx, channelIds, content, card)`: one channel failing
/// (archived, removed) does not stop the others.
pub(crate) async fn post_card_to_channels(
    ctx: &HookContext,
    channel_ids: &[String],
    content: &str,
    card: &Value,
) {
    for channel_id in channel_ids {
        if let Err(error) = post_card(ctx, channel_id, content, card.clone()).await {
            tracing::error!(channel_id, ?error, "[merge-api] chat post failed");
        }
    }
}
