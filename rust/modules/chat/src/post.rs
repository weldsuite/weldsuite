//! The send pipeline every way of posting shares (`services/chat/post-message.ts`):
//! the channel's feature checks, the row, the channel's denormalised preview
//! and counters, record chat following, thread counters, the realtime
//! fan-out, mention / thread / DM notifications, and agent room dispatch.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_chat_domain::entity::{self, can_post_in_record_chat};
use weldsuite_chat_domain::policy::parse_agent_room_policy;
use weldsuite_chat_domain::publish::object;
use weldsuite_chat_domain::text::{
    build_message_preview, build_reply_reference, js_len, js_prefix, js_trim, mention_bodies,
    read_reply_reference,
};
use weldsuite_chat_domain::{Can, Realtime};
use weldsuite_kit::generate_id;
use weldsuite_notifications::{chat as notify, create_and_deliver};
use weldsuite_ports::JobRequest;

use crate::ChatState;
use crate::access::Caller;
use crate::followers::{announce_new_followers, follow_record_chat_on_post};
use crate::util::now;

/// Most files one message may carry.
pub(crate) const MAX_MESSAGE_ATTACHMENTS: usize = 10;

/// `SEARCH_ENTITY_TYPES`: the prefixes of entity references in `<@…>`.
const SEARCH_ENTITY_TYPES: [&str; 14] = [
    "contact",
    "customer",
    "lead",
    "opportunity",
    "ticket",
    "article",
    "product",
    "order",
    "invoice",
    "bill",
    "project",
    "task",
    "sheet",
    "domain",
];

/// `PostChatMessageInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct PostInput {
    pub content: String,
    pub html_content: Option<String>,
    pub parent_id: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub mentions: Option<Vec<String>>,
    pub metadata: Option<Value>,
    pub reply_to_id: Option<String>,
    pub reply_mention: Option<bool>,
}

/// `ChatFeatureError` (status and message), or a database failure.
#[derive(Debug)]
pub(crate) enum PostError {
    Feature(u16, String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for PostError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `getChannelFeatureFlags`: threads, attachments, reactions, slow mode;
/// `None` for a missing or deleted channel.
pub(crate) async fn channel_feature_flags(
    db: &PgPool,
    channel_id: &str,
) -> Result<Option<(bool, bool, bool, i32)>, sqlx::Error> {
    sqlx::query_as(
        "select threads_enabled, attachments_enabled, reactions_enabled, slow_mode_seconds
         from chat_channels where id = $1 and deleted_at is null limit 1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await
}

async fn assert_channel_allows_send(
    db: &PgPool,
    channel_id: &str,
    author: &str,
    input: &PostInput,
) -> Result<(), PostError> {
    let Some((threads, attachments_on, _, slow_mode)) =
        channel_feature_flags(db, channel_id).await?
    else {
        return Err(PostError::Feature(404, "Channel not found".to_owned()));
    };
    let attachment_count = input.attachments.as_ref().map_or(0, Vec::len);
    if input.parent_id.as_deref().is_some_and(|p| !p.is_empty()) && !threads {
        return Err(PostError::Feature(
            400,
            "Threads are disabled in this channel".to_owned(),
        ));
    }
    if attachment_count > 0 && !attachments_on {
        return Err(PostError::Feature(
            400,
            "Attachments are disabled in this channel".to_owned(),
        ));
    }
    if attachment_count > MAX_MESSAGE_ATTACHMENTS {
        return Err(PostError::Feature(
            400,
            format!("A message can have at most {MAX_MESSAGE_ATTACHMENTS} attachments"),
        ));
    }
    if let Some(parent) = input.parent_id.as_deref().filter(|p| !p.is_empty()) {
        let parent_channel: Option<String> = sqlx::query_scalar(
            "select channel_id from chat_messages where id = $1 and deleted_at is null limit 1",
        )
        .bind(parent)
        .fetch_optional(db)
        .await?;
        if parent_channel.as_deref() != Some(channel_id) {
            return Err(PostError::Feature(
                400,
                "Thread parent message not found in this channel".to_owned(),
            ));
        }
    }
    assert_may_write_in_record_chat(db, channel_id, author).await?;
    if slow_mode > 0 {
        let cutoff = weldsuite_events::iso_timestamp(
            time::OffsetDateTime::now_utc() - time::Duration::seconds(i64::from(slow_mode)),
        );
        let recent: Option<String> = sqlx::query_scalar(
            "select id from chat_messages
             where channel_id = $1 and author_id = $2 and deleted_at is null
               and created_at > $3::timestamp limit 1",
        )
        .bind(channel_id)
        .bind(author)
        .bind(&cutoff)
        .fetch_optional(db)
        .await?;
        if recent.is_some() {
            return Err(PostError::Feature(
                400,
                format!("Slow mode is enabled — wait {slow_mode}s between messages"),
            ));
        }
    }
    Ok(())
}

/// A record chat may take more than reading it to write in (ADR CHAT-007).
async fn assert_may_write_in_record_chat(
    db: &PgPool,
    channel_id: &str,
    author: &str,
) -> Result<(), PostError> {
    let channel: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select type, entity_type, entity_id from chat_channels where id = $1 limit 1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    let Some((kind, Some(entity_type), Some(entity_id))) = channel else {
        return Ok(());
    };
    if kind != "entity" || entity_type.is_empty() || entity_id.is_empty() {
        return Ok(());
    }
    let Some(provider) = entity::provider(&entity_type).filter(|p| p.has_post_check()) else {
        return Ok(());
    };
    let can = Can::user(db, author);
    if !can_post_in_record_chat(provider, db, author, &entity_id, &can).await? {
        return Err(PostError::Feature(
            403,
            "You may read this chat but not write in it".to_owned(),
        ));
    }
    Ok(())
}

/// `classifyMentionToken`: a user id, or `entity:<type>:<id>`.
fn classify_mention_token(body: &str) -> String {
    let Some((prefix, rest)) = body.split_once(':') else {
        return body.to_owned();
    };
    if !SEARCH_ENTITY_TYPES.contains(&prefix) {
        return prefix.to_owned();
    }
    let entity_id = rest.split_once('|').map_or(rest, |(id, _)| id);
    if entity_id.is_empty() {
        prefix.to_owned()
    } else {
        format!("entity:{prefix}:{entity_id}")
    }
}

/// `extractContentMentions`.
pub(crate) fn extract_content_mentions(content: &str) -> Vec<String> {
    let mut mentions: Vec<String> = Vec::new();
    for body in mention_bodies(content) {
        if body.starts_with("file:") {
            continue;
        }
        let id = classify_mention_token(&body);
        if !mentions.contains(&id) {
            mentions.push(id);
        }
    }
    mentions
}

/// `toRealtimeAttachments`: `{ id, name, url, type, size }`.
fn realtime_attachments(attachments: Option<&Vec<Value>>) -> Option<Value> {
    let attachments = attachments.filter(|a| !a.is_empty())?;
    let text = |values: &[&Value]| -> Value {
        values
            .iter()
            .find_map(|v| v.as_str())
            .map_or_else(|| Value::from(""), Value::from)
    };
    Some(Value::Array(
        attachments
            .iter()
            .map(|a| {
                let size = [&a["fileSize"], &a["size"]]
                    .into_iter()
                    .find(|v| v.is_number())
                    .cloned()
                    .unwrap_or_else(|| Value::from(0));
                json!({
                    "id": text(&[&a["id"]]),
                    "name": text(&[&a["fileName"], &a["name"]]),
                    "url": text(&[&a["url"]]),
                    "type": text(&[&a["mimeType"], &a["type"]]),
                    "size": size,
                })
            })
            .collect(),
    ))
}

/// Whether a mention token is a person to notify.
fn is_notifiable_mention(mention: &str, author: &str) -> bool {
    mention != author
        && mention != "everyone"
        && !mention.starts_with("entity:")
        && !mention.starts_with("agt_")
}

/// `toSubject`: whitespace folded, at most 255 characters.
fn activity_subject(content: &str) -> String {
    let flat: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = js_trim(&flat).to_owned();
    if js_len(&flat) <= 255 {
        flat
    } else {
        format!("{}…", js_prefix(&flat, 254))
    }
}

/// `logEntityChannelMessageActivity`: a company or person chat message is
/// also a `comment` activity on the record.
async fn log_entity_activity(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    display_name: Option<&str>,
    author: &str,
    content: &str,
    created_at: &str,
) -> Result<(), sqlx::Error> {
    let subject = activity_subject(content);
    if subject.is_empty() {
        return Ok(());
    }
    let is_company = entity_type == "company";
    sqlx::query(
        "insert into crm_activities
            (id, type, subject, description, related_to, related_to_id, related_to_name,
             customer_id, person_id, assigned_to_id, status, created_at, updated_at)
         values ($1, 'comment', $2, $3, $4, $5, $6, $7, $8, $9, 'completed',
                 $10::timestamp, $10::timestamp)",
    )
    .bind(generate_id("act"))
    .bind(&subject)
    .bind(content)
    .bind(if is_company { "customer" } else { "contact" })
    .bind(entity_id)
    .bind(display_name)
    .bind(is_company.then_some(entity_id))
    .bind((!is_company).then_some(entity_id))
    .bind(author)
    .bind(created_at)
    .execute(db)
    .await?;
    Ok(())
}

/// The channel columns the send reads back after bumping its counters.
struct ChannelRef {
    kind: String,
    name: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
    entity_display_name: Option<String>,
}

/// `postChatMessage(ctx, input)`: the new message's row.
#[allow(clippy::too_many_lines)]
pub(crate) async fn post_chat_message(
    caller: &Caller,
    state: &ChatState,
    org_id: &str,
    channel_id: &str,
    input: PostInput,
) -> Result<Value, PostError> {
    let db = &caller.db;
    let author_id = caller.user_id.as_str();
    let realtime = Caller::realtime(state);
    assert_channel_allows_send(db, channel_id, author_id, &input).await?;

    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(author_id)
            .fetch_optional(db)
            .await?;
    let (author_name, author_picture) = author.unwrap_or((None, None));
    let author_name = author_name.unwrap_or_else(|| "Unknown".to_owned());

    // Inline reply: the quoted message's snapshot; a forged one is dropped.
    let mut metadata = input.metadata.clone();
    if let Some(Value::Object(fields)) = metadata.as_mut() {
        fields.remove("replyTo");
    }
    let mut reply_mentions: Vec<String> = Vec::new();
    if let Some(reply_to) = input.reply_to_id.as_deref().filter(|r| !r.is_empty()) {
        type Target = (
            String,
            String,
            String,
            Option<String>,
            String,
            bool,
            Option<Value>,
        );
        let target: Option<Target> = sqlx::query_as(
            "select id, author_id, author_name, author_avatar, content, has_attachments, metadata
             from chat_messages where id = $1 and channel_id = $2 and deleted_at is null limit 1",
        )
        .bind(reply_to)
        .bind(channel_id)
        .fetch_optional(db)
        .await?;
        if let Some((id, target_author, name, avatar, content, has_attachments, target_meta)) =
            target
        {
            let reference = build_reply_reference(
                &id,
                &target_author,
                &name,
                avatar.as_deref(),
                &content,
                Some(has_attachments),
                &target_meta.unwrap_or(Value::Null),
            );
            let mut fields = match metadata.take() {
                Some(Value::Object(fields)) => fields,
                _ => Map::new(),
            };
            fields.insert("replyTo".to_owned(), reference);
            metadata = Some(Value::Object(fields));
            if input.reply_mention != Some(false) && target_author != author_id {
                reply_mentions.push(target_author);
            }
        }
    }

    let id = generate_id("msg");
    let at = now();
    let has_attachments = input.attachments.as_ref().is_some_and(|a| !a.is_empty());
    let mut all_mentions: Vec<String> = Vec::new();
    for mention in input
        .mentions
        .clone()
        .unwrap_or_default()
        .into_iter()
        .chain(extract_content_mentions(&input.content))
        .chain(reply_mentions)
    {
        if !all_mentions.contains(&mention) {
            all_mentions.push(mention);
        }
    }
    let mentions_everyone = all_mentions.iter().any(|m| m == "everyone");
    let attachments_json = input.attachments.clone().map(Value::Array);
    let mentions_json = (!all_mentions.is_empty()).then(|| Value::from(all_mentions.clone()));
    sqlx::query(
        "insert into chat_messages
            (id, channel_id, author_id, author_name, author_avatar, content, html_content,
             parent_id, attachments, has_attachments, mentions, mentions_everyone, metadata,
             created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamp, $14::timestamp)",
    )
    .bind(&id)
    .bind(channel_id)
    .bind(author_id)
    .bind(&author_name)
    .bind(&author_picture)
    .bind(&input.content)
    .bind(&input.html_content)
    .bind(&input.parent_id)
    .bind(&attachments_json)
    .bind(has_attachments)
    .bind(&mentions_json)
    .bind(mentions_everyone)
    .bind(&metadata)
    .bind(&at)
    .execute(db)
    .await?;

    let preview = build_message_preview(db, &input.content).await;
    let channel: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "update chat_channels set last_message_at = $2::timestamp, last_message_preview = $3,
                message_count = message_count + 1, updated_at = $2::timestamp
             where id = $1
             returning type, name, entity_type, entity_id, entity_display_name",
    )
    .bind(channel_id)
    .bind(&at)
    .bind(&preview)
    .fetch_optional(db)
    .await?;
    let channel = channel.map(
        |(kind, name, entity_type, entity_id, entity_display_name)| ChannelRef {
            kind,
            name,
            entity_type,
            entity_id,
            entity_display_name,
        },
    );

    if let Some(channel) = &channel
        && let (Some(entity_type), Some(entity_id)) =
            (channel.entity_type.as_deref(), channel.entity_id.as_deref())
        && (entity_type == "company" || entity_type == "person")
        && !entity_id.is_empty()
        && let Err(error) = log_entity_activity(
            db,
            entity_type,
            entity_id,
            channel.entity_display_name.as_deref(),
            author_id,
            &input.content,
            &at,
        )
        .await
    {
        tracing::error!(%error, "[app-api/chat] entity activity log failed");
    }

    let mut new_followers: Vec<String> = Vec::new();
    if let Some(channel) = &channel
        && channel.kind == "entity"
        && let (Some(entity_type), Some(entity_id)) = (
            channel.entity_type.as_deref().filter(|t| !t.is_empty()),
            channel.entity_id.as_deref().filter(|i| !i.is_empty()),
        )
    {
        let mentioned: Vec<String> = all_mentions
            .iter()
            .filter(|m| is_notifiable_mention(m, author_id))
            .cloned()
            .collect();
        match follow_record_chat_on_post(
            db,
            channel_id,
            entity_type,
            entity_id,
            author_id,
            &mentioned,
        )
        .await
        {
            Ok(added) => new_followers = added,
            Err(error) => tracing::error!(%error, "[app-api/chat] record chat follow failed"),
        }
    }

    sqlx::query(
        "update chat_channel_members set last_read_at = $3::timestamp, last_read_message_id = $4
         where channel_id = $1 and user_id = $2",
    )
    .bind(channel_id)
    .bind(author_id)
    .bind(&at)
    .bind(&id)
    .execute(db)
    .await?;

    let notifier = caller.notifier(state);
    if let Some(parent) = input.parent_id.as_deref().filter(|p| !p.is_empty()) {
        notify_thread_reply(
            db,
            &realtime,
            &notifier,
            org_id,
            channel_id,
            author_id,
            &author_name,
            &id,
            &preview,
            parent,
            &at,
        )
        .await?;
    }

    let message: Value =
        sqlx::query_scalar("select to_jsonb(m) from chat_messages m where m.id = $1 limit 1")
            .bind(&id)
            .fetch_optional(db)
            .await?
            .map_or(Value::Null, weldsuite_db::js_row);

    if realtime.is_on() {
        let reply = metadata.as_ref().and_then(read_reply_reference).cloned();
        realtime
            .message(
                channel_id,
                object([
                    ("id", Some(Value::from(id.as_str()))),
                    ("content", Some(Value::from(input.content.as_str()))),
                    ("htmlContent", input.html_content.clone().map(Value::from)),
                    ("senderId", Some(Value::from(author_id))),
                    ("senderName", Some(Value::from(author_name.as_str()))),
                    ("senderAvatar", author_picture.clone().map(Value::from)),
                    ("authorType", Some(Value::from("user"))),
                    (
                        "threadId",
                        input
                            .parent_id
                            .clone()
                            .filter(|p| !p.is_empty())
                            .map(Value::from),
                    ),
                    (
                        "attachments",
                        realtime_attachments(input.attachments.as_ref()),
                    ),
                    ("replyTo", reply),
                ]),
            )
            .await;
    }

    if !new_followers.is_empty()
        && let Some(channel) = &channel
    {
        announce_new_followers(&realtime, org_id, channel_id, &channel.name, &new_followers).await;
    }

    if input.parent_id.as_deref().is_none_or(str::is_empty) {
        notify_dm_recipients(
            db,
            &notifier,
            org_id,
            channel_id,
            author_id,
            &author_name,
            &preview,
            &all_mentions,
        )
        .await;
    }

    notify_mentioned_users(
        db,
        &realtime,
        &notifier,
        org_id,
        channel_id,
        author_id,
        &author_name,
        &id,
        &preview,
        &all_mentions,
    )
    .await;

    if realtime.is_on() {
        fan_out_unread_updates(db, &realtime, org_id, channel_id, author_id).await;
    }

    dispatch_agent_room_replies(
        caller,
        state,
        org_id,
        channel_id,
        &id,
        &input.content,
        &all_mentions,
    )
    .await?;

    Ok(message)
}

/// The parent's thread counters, then every other participant is told.
#[allow(clippy::too_many_arguments)]
async fn notify_thread_reply(
    db: &PgPool,
    realtime: &Realtime,
    notifier: &weldsuite_notifications::Notifier,
    org_id: &str,
    channel_id: &str,
    author_id: &str,
    author_name: &str,
    message_id: &str,
    preview: &str,
    parent_id: &str,
    at: &str,
) -> Result<(), sqlx::Error> {
    let parent: Option<(Option<Value>, String)> = sqlx::query_as(
        "select thread_participant_ids, author_id from chat_messages where id = $1 limit 1",
    )
    .bind(parent_id)
    .fetch_optional(db)
    .await?;
    let mut participants: Vec<String> = parent
        .as_ref()
        .and_then(|(ids, _)| ids.as_ref())
        .map(weldsuite_chat_domain::access::string_list)
        .unwrap_or_default();
    if !participants.iter().any(|p| p == author_id) {
        participants.push(author_id.to_owned());
    }
    if let Some((_, parent_author)) = &parent
        && !parent_author.is_empty()
        && !participants.contains(parent_author)
    {
        participants.push(parent_author.clone());
    }
    sqlx::query(
        "update chat_messages set thread_reply_count = thread_reply_count + 1,
            thread_last_reply_at = $2::timestamp, thread_participant_ids = $3,
            updated_at = $2::timestamp
         where id = $1",
    )
    .bind(parent_id)
    .bind(at)
    .bind(Value::from(participants.clone()))
    .execute(db)
    .await?;

    let others: Vec<&String> = participants.iter().filter(|p| *p != author_id).collect();
    for participant in &others {
        realtime
            .chat_user(
                org_id,
                participant,
                "thread_reply",
                json!({
                    "channelId": channel_id,
                    "parentMessageId": parent_id,
                    "replyMessageId": message_id,
                    "authorName": author_name,
                    "preview": preview,
                }),
            )
            .await;
    }
    for participant in others {
        let params = notify::thread_reply(
            org_id,
            participant,
            author_id,
            author_name,
            channel_id,
            parent_id,
            message_id,
            preview,
        );
        if let Err(error) = create_and_deliver(db, notifier, &params).await {
            tracing::error!(%error, "[app-api/chat] thread reply notification failed");
        }
    }
    Ok(())
}

/// A DM always notifies its other members (top-level messages only).
#[allow(clippy::too_many_arguments)]
async fn notify_dm_recipients(
    db: &PgPool,
    notifier: &weldsuite_notifications::Notifier,
    org_id: &str,
    channel_id: &str,
    author_id: &str,
    author_name: &str,
    preview: &str,
    all_mentions: &[String],
) {
    let run = async {
        let kind: Option<String> =
            sqlx::query_scalar("select type from chat_channels where id = $1 limit 1")
                .bind(channel_id)
                .fetch_optional(db)
                .await?;
        if kind.as_deref() != Some("dm") {
            return Ok::<(), sqlx::Error>(());
        }
        let members: Vec<String> =
            sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
                .bind(channel_id)
                .fetch_all(db)
                .await?;
        for member in members
            .iter()
            .filter(|m| *m != author_id && !all_mentions.contains(m) && !m.starts_with("agt_"))
        {
            let params = notify::dm(org_id, member, author_id, author_name, channel_id, preview);
            if let Err(error) = create_and_deliver(db, notifier, &params).await {
                tracing::error!(%error, "[app-api/chat] DM notification failed");
            }
        }
        Ok(())
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[app-api/chat] DM notification lookup failed");
    }
}

/// Unread-mention counter, realtime ping and notification per mentioned user.
#[allow(clippy::too_many_arguments)]
async fn notify_mentioned_users(
    db: &PgPool,
    realtime: &Realtime,
    notifier: &weldsuite_notifications::Notifier,
    org_id: &str,
    channel_id: &str,
    author_id: &str,
    author_name: &str,
    message_id: &str,
    preview: &str,
    all_mentions: &[String],
) {
    let notifiable: Vec<&String> = all_mentions
        .iter()
        .filter(|m| is_notifiable_mention(m, author_id))
        .collect();
    for mentioned in &notifiable {
        if let Err(error) = sqlx::query(
            "update chat_channel_members set unread_mention_count = unread_mention_count + 1
             where channel_id = $1 and user_id = $2",
        )
        .bind(channel_id)
        .bind(mentioned)
        .execute(db)
        .await
        {
            tracing::error!(%error, "[app-api/chat] mention count increment failed");
        }
    }
    for mentioned in &notifiable {
        realtime
            .chat_user(
                org_id,
                mentioned,
                "mention",
                json!({
                    "channelId": channel_id,
                    "messageId": message_id,
                    "authorName": author_name,
                    "preview": preview,
                }),
            )
            .await;
    }
    for mentioned in notifiable {
        let params = notify::mention(
            org_id,
            mentioned,
            author_id,
            author_name,
            channel_id,
            message_id,
            preview,
        );
        if let Err(error) = create_and_deliver(db, notifier, &params).await {
            tracing::error!(%error, "[app-api/chat] mention notification failed");
        }
    }
}

/// `unread_update` to every other human member.
async fn fan_out_unread_updates(
    db: &PgPool,
    realtime: &Realtime,
    org_id: &str,
    channel_id: &str,
    author_id: &str,
) {
    let members: Result<Vec<(String, String)>, sqlx::Error> = sqlx::query_as(
        "select user_id, member_type from chat_channel_members where channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(db)
    .await;
    match members {
        Ok(members) => {
            for (user_id, member_type) in members {
                if user_id == author_id || member_type == "agent" {
                    continue;
                }
                realtime
                    .unread_update(org_id, &user_id, channel_id, 1)
                    .await;
            }
        }
        Err(error) => tracing::error!(%error, "[app-api/chat] unread fan-out failed"),
    }
}

/// Multi-agent room replies: @mentioned agents, or every agent with the
/// `always` policy, run as a WeldAgent job (`chat-room`).
async fn dispatch_agent_room_replies(
    caller: &Caller,
    state: &ChatState,
    org_id: &str,
    channel_id: &str,
    message_id: &str,
    content: &str,
    all_mentions: &[String],
) -> Result<(), sqlx::Error> {
    let agent_mentions: Vec<String> = all_mentions
        .iter()
        .filter(|m| m.starts_with("agt_"))
        .cloned()
        .collect();
    let metadata: Option<Option<Value>> =
        sqlx::query_scalar("select metadata from chat_channels where id = $1 limit 1")
            .bind(channel_id)
            .fetch_optional(&caller.db)
            .await?;
    let policy = parse_agent_room_policy(metadata.flatten().as_ref());
    let dispatch = policy.agent_reply_policy != "none"
        && (!agent_mentions.is_empty() || policy.agent_reply_policy == "always");
    if !dispatch {
        return Ok(());
    }
    let Some(jobs) = &state.jobs else {
        return Ok(());
    };
    let payload = json!({
        "kind": "chat-room",
        "workspaceId": org_id,
        "invokerUserId": caller.user_id,
        "agentMentionIds": agent_mentions,
        "channelId": channel_id,
        "messageId": message_id,
        "messageContent": content,
    });
    let request = JobRequest {
        name: "weldagent.job".to_owned(),
        key: format!("chat-room-{message_id}"),
        payload,
        delay: None,
    };
    if let Err(error) = jobs.start_boxed(request).await {
        tracing::error!(%error, "[app-api/chat] agent mention dispatch failed");
    }
    Ok(())
}
