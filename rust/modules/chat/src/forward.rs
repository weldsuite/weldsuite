//! Forwarding (`services/chat/forward-message.ts`): copy a message into one
//! or more channels with a `forwardedFrom` snapshot of the original.

use serde_json::{Map, Value, json};
use weldsuite_chat_domain::text::build_message_preview;
use weldsuite_chat_domain::{can_access_channel, unreadable_record_chat_ids};
use weldsuite_kit::generate_id;

use crate::access::Caller;
use crate::util::{ms_timestamp, now};

/// One copy (`ForwardedMessage`).
pub(crate) struct Forwarded {
    pub channel_id: String,
    pub message_id: String,
    pub recipient_user_ids: Vec<String>,
    pub content: String,
}

type Outcome = Result<(Vec<Forwarded>, String, Option<String>), (u16, String)>;

/// Of `channel_ids`, those the user has no membership in.
async fn non_member_channels(
    caller: &Caller,
    channel_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let memberships: Vec<String> = sqlx::query_scalar(
        "select channel_id from chat_channel_members where user_id = $1 and channel_id = any($2)",
    )
    .bind(&caller.user_id)
    .bind(channel_ids)
    .fetch_all(&caller.db)
    .await?;
    Ok(channel_ids
        .iter()
        .filter(|id| !memberships.contains(id))
        .cloned()
        .collect())
}

/// `forwardMessage(db, { sourceChannelId, sourceMessageId, userId }, input)`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn forward_message(
    caller: &Caller,
    source_channel_id: &str,
    source_message_id: &str,
    targets: &[String],
    comment: Option<String>,
    html_comment: Option<String>,
) -> Result<Outcome, sqlx::Error> {
    let db = &caller.db;
    let user_id = caller.user_id.as_str();
    let member: Option<String> = sqlx::query_scalar(
        "select user_id from chat_channel_members where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(source_channel_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if member.is_none() || !can_access_channel(db, source_channel_id, user_id, None).await? {
        return Ok(Err((403, "You do not have access to this message".to_owned())));
    }
    let source: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from chat_messages m
         where m.id = $1 and m.channel_id = $2 and m.deleted_at is null limit 1",
    )
    .bind(source_message_id)
    .bind(source_channel_id)
    .fetch_optional(db)
    .await?;
    let Some(source) = source else {
        return Ok(Err((404, "Message not found".to_owned())));
    };
    let source_channel: Option<(String, String)> =
        sqlx::query_as("select name, type from chat_channels where id = $1 limit 1")
            .bind(source_channel_id)
            .fetch_optional(db)
            .await?;
    let forwarded_from = if source["forwarded_from"].is_null() {
        let mut snapshot = Map::new();
        let text = |key: &str| source[key].clone();
        snapshot.insert("messageId".to_owned(), text("id"));
        snapshot.insert("channelId".to_owned(), text("channel_id"));
        snapshot.insert(
            "channelName".to_owned(),
            Value::from(source_channel.as_ref().map_or("channel", |c| c.0.as_str())),
        );
        snapshot.insert(
            "channelType".to_owned(),
            Value::from(source_channel.as_ref().map_or("public", |c| c.1.as_str())),
        );
        snapshot.insert("authorId".to_owned(), text("author_id"));
        snapshot.insert("authorName".to_owned(), text("author_name"));
        if !source["author_avatar"].is_null() {
            snapshot.insert("authorAvatar".to_owned(), text("author_avatar"));
        }
        snapshot.insert("content".to_owned(), text("content"));
        if !source["html_content"].is_null() {
            snapshot.insert("htmlContent".to_owned(), text("html_content"));
        }
        snapshot.insert(
            "createdAt".to_owned(),
            Value::from(ms_timestamp(source["created_at"].as_str().unwrap_or_default())),
        );
        if !source["attachments"].is_null() {
            snapshot.insert("attachments".to_owned(), text("attachments"));
        }
        Value::Object(snapshot)
    } else {
        source["forwarded_from"].clone()
    };

    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    let (author_name, author_avatar) = author.unwrap_or((None, None));
    let author_name = author_name.unwrap_or_else(|| "Unknown".to_owned());

    let mut unique: Vec<String> = Vec::new();
    for target in targets {
        if !unique.contains(target) {
            unique.push(target.clone());
        }
    }
    if unique.is_empty() {
        return Ok(Ok((Vec::new(), author_name, author_avatar)));
    }
    let channels: Vec<(String, String)> = sqlx::query_as(
        "select id, type from chat_channels where id = any($1) and deleted_at is null",
    )
    .bind(&unique)
    .fetch_all(db)
    .await?;
    let kind_of = |id: &str| {
        channels
            .iter()
            .find(|(cid, _)| cid == id)
            .map(|(_, kind)| kind.as_str())
    };
    let missing: Vec<&str> = unique
        .iter()
        .filter(|id| kind_of(id).is_none())
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Ok(Err((404, format!("Channel(s) not found: {}", missing.join(", ")))));
    }
    let non_public: Vec<String> = unique
        .iter()
        .filter(|id| kind_of(id) != Some("public"))
        .cloned()
        .collect();
    let inaccessible = non_member_channels(caller, &non_public).await?;
    if !inaccessible.is_empty() {
        return Ok(Err((
            403,
            format!("You are not a member of {} target channel(s)", inaccessible.len()),
        )));
    }
    let record_targets: Vec<String> = unique
        .iter()
        .filter(|id| kind_of(id) == Some("entity"))
        .cloned()
        .collect();
    let unreadable = unreadable_record_chat_ids(db, user_id, &record_targets, None).await?;
    if !unreadable.is_empty() {
        return Ok(Err((
            403,
            format!("You do not have access to {} target channel(s)", unreadable.len()),
        )));
    }

    // Auto-join the public targets.
    let public: Vec<String> = unique
        .iter()
        .filter(|id| kind_of(id) == Some("public"))
        .cloned()
        .collect();
    let to_join = non_member_channels(caller, &public).await?;
    let joined_at = now();
    for channel_id in &to_join {
        sqlx::query(
            "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
             values ($1, $2, $3, 'member', $4::timestamp, $4::timestamp) on conflict do nothing",
        )
        .bind(generate_id("cmb"))
        .bind(channel_id)
        .bind(user_id)
        .bind(&joined_at)
        .execute(db)
        .await?;
        sqlx::query(
            "update chat_channels set member_count = member_count + 1, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(channel_id)
        .bind(&joined_at)
        .execute(db)
        .await?;
    }

    let content = comment
        .as_deref()
        .map(|c| weldsuite_chat_domain::text::js_trim(c).to_owned())
        .unwrap_or_default();
    let at = now();
    let preview_source = if content.is_empty() {
        format!(
            "Forwarded: {}",
            forwarded_from["content"].as_str().unwrap_or_default()
        )
    } else {
        content.clone()
    };
    let preview = build_message_preview(db, &preview_source).await;
    let mut forwarded = Vec::new();
    for target in unique {
        let id = generate_id("msg");
        sqlx::query(
            "insert into chat_messages
                (id, channel_id, author_id, author_name, author_avatar, content, html_content,
                 forwarded_from, has_attachments, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9::timestamp, $9::timestamp)",
        )
        .bind(&id)
        .bind(&target)
        .bind(user_id)
        .bind(&author_name)
        .bind(&author_avatar)
        .bind(&content)
        .bind(&html_comment)
        .bind(&forwarded_from)
        .bind(&at)
        .execute(db)
        .await?;
        sqlx::query(
            "update chat_channels set last_message_at = $2::timestamp, last_message_preview = $3,
                message_count = message_count + 1, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&target)
        .bind(&at)
        .bind(&preview)
        .execute(db)
        .await?;
        let members: Vec<String> =
            sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
                .bind(&target)
                .fetch_all(db)
                .await?;
        forwarded.push(Forwarded {
            channel_id: target,
            message_id: id,
            recipient_user_ids: members.into_iter().filter(|m| m != user_id).collect(),
            content: content.clone(),
        });
    }
    let _ = json!(null);
    Ok(Ok((forwarded, author_name, author_avatar)))
}
