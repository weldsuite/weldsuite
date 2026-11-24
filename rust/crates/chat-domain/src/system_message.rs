//! `postSystemChatMessage` (`@weldsuite/chat-domain/post-system-message`): a
//! WeldChat message written by something that is not a member, a WeldConnect
//! workflow (`workflow:<id>`) or an app such as WeldMerge (`app:weldmerge`),
//! with `authorType: 'system'`. It replicates the parts of the human send
//! pipeline a channel relies on: the channel's last-message fields and
//! counter, the realtime broadcast, every human member's unread ping, and the
//! mention counters and notifications. No threads, replies, DM push or agent
//! dispatch.
//!
//! `metadata` is the message's own (WeldMerge's `{ weldmerge: { kind, … } }`,
//! which the chat UI renders as a card); left out, the message is marked
//! `postedByWorkflow`, as the workflow step's are. The caller publishes the
//! `chat_message` created event.

use std::sync::Arc;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_ports::DynRealtimePublisher;
use weldsuite_schema::tenant::{chat_channel_members as members, chat_channels, chat_messages};

use crate::json_error;
use crate::publish::Realtime;
use crate::text::{js_len, js_prefix, mention_bodies};

/// Who posts, where (`PostSystemChatMessageContext`).
#[derive(Clone)]
pub struct SystemMessageContext<'a> {
    pub db: &'a PgPool,
    /// The realtime publisher (`env.REALTIME`); `None` publishes nothing.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The workspace id the realtime topics and notifications are keyed by
    /// (the Clerk org id on Global).
    pub org_id: &'a str,
    pub channel_id: &'a str,
    /// `workflow:<workflowId>`, `app:weldmerge`.
    pub author_id: &'a str,
    /// The workflow's or the app's name, shown as the author.
    pub author_name: &'a str,
    /// Who caused the post: only the mention notifications name them.
    pub invoker_user_id: &'a str,
    /// Outbound HTTP for the mention notifications' push (Expo); `None`
    /// notifies in-app only. Conformance builds pass none.
    pub push_http: Option<weldsuite_ports::OutboundHttp>,
}

/// What is posted (`PostSystemChatMessageInput`).
#[derive(Debug, Clone, Default)]
pub struct SystemMessageInput<'a> {
    pub content: &'a str,
    /// Extra mentions beyond the content's `<@…>` tokens.
    pub mentions: &'a [String],
    /// The message's `metadata`; `None` is `{ postedByWorkflow: true }`.
    pub metadata: Option<Value>,
}

/// `SEARCH_ENTITY_TYPES`: entity references in `<@type:id>`.
const SEARCH_ENTITY_TYPES: [&str; 13] = [
    "contact",
    "customer",
    "lead",
    "opportunity",
    "ticket",
    "article",
    "product",
    "invoice",
    "bill",
    "project",
    "task",
    "sheet",
    "domain",
];

/// `extractChatMentions(content, extra)`.
pub fn extract_chat_mentions(content: &str, extra: &[String]) -> Vec<String> {
    let mut found: Vec<String> = extra.to_vec();
    for body in mention_bodies(content) {
        let (id, had_colon) = body
            .split_once(':')
            .map_or((body.as_str(), false), |(id, _)| (id, true));
        if !id.is_empty()
            && id != "everyone"
            && !id.starts_with("entity:")
            && (!had_colon || !SEARCH_ENTITY_TYPES.contains(&id))
            && !found.iter().any(|f| f == id)
        {
            found.push(id.to_owned());
        }
    }
    found
}

/// `isNotifiableMention`: a human user to notify.
fn is_notifiable_mention(id: &str) -> bool {
    id != "everyone" && id != "entity" && !id.starts_with("entity:") && !id.starts_with("agt_")
}

/// `postSystemChatMessage(ctx, input)`: the message row as Drizzle reads it.
#[allow(clippy::too_many_lines)] // the steps of one post, in TypeScript's order
pub async fn post_system_chat_message(
    ctx: &SystemMessageContext<'_>,
    input: &SystemMessageInput<'_>,
) -> Result<Value, DbErr> {
    let db = ctx.db;
    let orm_db = orm(db);
    let id = generate_id("msg");
    let now = utc_now();
    let all_mentions = extract_chat_mentions(input.content, input.mentions);
    let mentions_everyone = all_mentions.iter().any(|m| m == "everyone");
    let metadata = input
        .metadata
        .clone()
        .unwrap_or_else(|| json!({ "postedByWorkflow": true }));

    chat_messages::Entity::insert(chat_messages::ActiveModel {
        id: Set(id.clone()),
        channel_id: Set(ctx.channel_id.to_owned()),
        author_id: Set(ctx.author_id.to_owned()),
        author_name: Set(ctx.author_name.to_owned()),
        author_type: Set("system".to_owned()),
        content: Set(input.content.to_owned()),
        mentions: Set((!all_mentions.is_empty()).then(|| json!(all_mentions))),
        mentions_everyone: Set(mentions_everyone),
        metadata: Set(Some(metadata)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm_db)
    .await?;

    let preview = if js_len(input.content) > 100 {
        format!("{}...", js_prefix(input.content, 100))
    } else {
        input.content.to_owned()
    };
    chat_channels::Entity::update_many()
        .col_expr(chat_channels::Column::LastMessageAt, Expr::value(now))
        .col_expr(
            chat_channels::Column::LastMessagePreview,
            Expr::value(preview.clone()),
        )
        .col_expr(
            chat_channels::Column::MessageCount,
            sea_orm::ExprTrait::add(Expr::col(chat_channels::Column::MessageCount), 1),
        )
        .col_expr(chat_channels::Column::UpdatedAt, Expr::value(now))
        .filter(chat_channels::Column::Id.eq(ctx.channel_id))
        .exec(&orm_db)
        .await?;

    let message = chat_messages::Entity::find_by_id(id.as_str())
        .one(&orm_db)
        .await?
        .map(serde_json::to_value)
        .transpose()
        .map_err(json_error)?;

    let realtime = Realtime::new(ctx.realtime.clone());
    if realtime.is_on() {
        let mut payload = Map::new();
        payload.insert("id".into(), json!(id));
        payload.insert("content".into(), json!(input.content));
        payload.insert("senderId".into(), json!(ctx.author_id));
        payload.insert("senderName".into(), json!(ctx.author_name));
        payload.insert("authorType".into(), json!("system"));
        realtime.message(ctx.channel_id, payload).await;
        // `fanOutUnreadUpdates`: every human member.
        match members::Entity::find()
            .select_only()
            .columns([members::Column::UserId, members::Column::MemberType])
            .filter(members::Column::ChannelId.eq(ctx.channel_id))
            .into_tuple::<(String, String)>()
            .all(&orm_db)
            .await
        {
            Ok(members) => {
                for (user_id, member_type) in members {
                    if member_type == "agent" {
                        continue;
                    }
                    realtime
                        .unread_update(ctx.org_id, &user_id, ctx.channel_id, 1)
                        .await;
                }
            }
            Err(error) => {
                tracing::error!(%error, "[chat-domain] workflow message unread fan-out failed");
            }
        }
    }

    // `notifyMentionedUsers`.
    let notifier = weldsuite_notifications::Notifier {
        realtime: ctx.realtime.clone(),
        http: ctx.push_http.clone(),
        ..weldsuite_notifications::Notifier::default()
    };
    for mentioned in all_mentions.iter().filter(|m| is_notifiable_mention(m)) {
        if let Err(error) = members::Entity::update_many()
            .col_expr(
                members::Column::UnreadMentionCount,
                sea_orm::ExprTrait::add(Expr::col(members::Column::UnreadMentionCount), 1),
            )
            .filter(members::Column::ChannelId.eq(ctx.channel_id))
            .filter(members::Column::UserId.eq(mentioned))
            .exec(&orm_db)
            .await
        {
            tracing::error!(%error, "[chat-domain] workflow mention count increment failed");
        }
        if realtime.is_on() {
            realtime
                .chat_user(
                    ctx.org_id,
                    mentioned,
                    "mention",
                    json!({
                        "channelId": ctx.channel_id,
                        "messageId": id,
                        "authorName": ctx.author_name,
                        "preview": preview,
                    }),
                )
                .await;
        }
        let params = weldsuite_notifications::chat::mention(
            ctx.org_id,
            mentioned,
            ctx.invoker_user_id,
            ctx.author_name,
            ctx.channel_id,
            &id,
            &preview,
        );
        if let Err(error) =
            weldsuite_notifications::create_and_deliver(db, &notifier, &params).await
        {
            tracing::error!(%error, "[chat-domain] workflow mention notification failed");
        }
    }

    Ok(message.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_skip_entity_tags_and_repeats() {
        let found = extract_chat_mentions(
            "hi <@user_1> and <@ticket:t_1> and <@user_1> <@everyone>",
            &["user_2".to_owned()],
        );
        assert_eq!(found, ["user_2", "user_1"]);
        assert!(is_notifiable_mention("user_1"));
        assert!(!is_notifiable_mention("agt_1"));
    }
}
