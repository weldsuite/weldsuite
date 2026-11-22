//! Forwarding (`services/chat/forward-message.ts`): copy a message into one
//! or more channels with a `forwardedFrom` snapshot of the original.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_chat_domain::text::build_message_preview;
use weldsuite_chat_domain::{can_access_channel, unreadable_record_chat_ids};
use weldsuite_db::{orm, orm_error, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_channels, chat_messages, workspace_members,
};

use crate::access::Caller;
use crate::groups::channels::js;

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
) -> Result<Vec<String>, DbErr> {
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let memberships: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::ChannelId)
        .filter(members::Column::UserId.eq(&caller.user_id))
        .filter(members::Column::ChannelId.is_in(channel_ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(&caller.db))
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
) -> Result<Outcome, DbErr> {
    let db = &caller.db;
    let orm_db = orm(db);
    let user_id = caller.user_id.as_str();
    let member: Option<String> = members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::ChannelId.eq(source_channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm_db)
        .await?;
    if member.is_none()
        || !can_access_channel(db, source_channel_id, user_id, None)
            .await
            .map_err(orm_error)?
    {
        return Ok(Err((
            403,
            "You do not have access to this message".to_owned(),
        )));
    }
    let source = chat_messages::Entity::find()
        .filter(chat_messages::Column::Id.eq(source_message_id))
        .filter(chat_messages::Column::ChannelId.eq(source_channel_id))
        .filter(chat_messages::Column::DeletedAt.is_null())
        .one(&orm_db)
        .await?;
    let Some(source) = source else {
        return Ok(Err((404, "Message not found".to_owned())));
    };
    // The row as Drizzle returns it (`createdAt` to the millisecond).
    let source = js(source)?;
    let source_channel: Option<(String, String)> = chat_channels::Entity::find()
        .select_only()
        .columns([chat_channels::Column::Name, chat_channels::Column::Type])
        .filter(chat_channels::Column::Id.eq(source_channel_id))
        .into_tuple()
        .one(&orm_db)
        .await?;
    // The forwarder's account picture, and the original author's when this
    // forward snapshots a person's message (an agent's avatar is its icon, kept).
    let snapshots_person = source["forwardedFrom"].is_null() && source["authorType"] != "agent";
    let source_author = source["authorId"].as_str().filter(|_| snapshots_person);
    let pictures = weldsuite_db::AccountPictures::load(
        caller.master(),
        std::iter::once(user_id).chain(source_author),
    )
    .await;
    let forwarded_from = if source["forwardedFrom"].is_null() {
        let mut snapshot = Map::new();
        let text = |key: &str| source[key].clone();
        snapshot.insert("messageId".to_owned(), text("id"));
        snapshot.insert("channelId".to_owned(), text("channelId"));
        snapshot.insert(
            "channelName".to_owned(),
            Value::from(source_channel.as_ref().map_or("channel", |c| c.0.as_str())),
        );
        snapshot.insert(
            "channelType".to_owned(),
            Value::from(source_channel.as_ref().map_or("public", |c| c.1.as_str())),
        );
        snapshot.insert("authorId".to_owned(), text("authorId"));
        snapshot.insert("authorName".to_owned(), text("authorName"));
        // A person's account picture; the message's stored avatar when the
        // lookup finds none (failed, or an account that is gone) and for an
        // agent's icon.
        match source_author.and_then(|author| pictures.get(author)) {
            Some(picture) => {
                snapshot.insert("authorAvatar".to_owned(), Value::from(picture));
            }
            None if !source["authorAvatar"].is_null() => {
                snapshot.insert("authorAvatar".to_owned(), text("authorAvatar"));
            }
            None => {}
        }
        snapshot.insert("content".to_owned(), text("content"));
        if !source["htmlContent"].is_null() {
            snapshot.insert("htmlContent".to_owned(), text("htmlContent"));
        }
        snapshot.insert("createdAt".to_owned(), text("createdAt"));
        if !source["attachments"].is_null() {
            snapshot.insert("attachments".to_owned(), text("attachments"));
        }
        Value::Object(snapshot)
    } else {
        source["forwardedFrom"].clone()
    };

    let author_name: Option<Option<String>> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm_db)
        .await?;
    let author_name = author_name
        .flatten()
        .unwrap_or_else(|| "Unknown".to_owned());
    // The stamped avatar is the account picture, not the member row's copy.
    let author_avatar = pictures.get(user_id).map(str::to_owned);

    let mut unique: Vec<String> = Vec::new();
    for target in targets {
        if !unique.contains(target) {
            unique.push(target.clone());
        }
    }
    if unique.is_empty() {
        return Ok(Ok((Vec::new(), author_name, author_avatar)));
    }
    let channels: Vec<(String, String)> = chat_channels::Entity::find()
        .select_only()
        .columns([chat_channels::Column::Id, chat_channels::Column::Type])
        .filter(chat_channels::Column::Id.is_in(unique.iter().map(String::as_str)))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm_db)
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
        return Ok(Err((
            404,
            format!("Channel(s) not found: {}", missing.join(", ")),
        )));
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
            format!(
                "You are not a member of {} target channel(s)",
                inaccessible.len()
            ),
        )));
    }
    let record_targets: Vec<String> = unique
        .iter()
        .filter(|id| kind_of(id) == Some("entity"))
        .cloned()
        .collect();
    let unreadable = unreadable_record_chat_ids(db, user_id, &record_targets, None)
        .await
        .map_err(orm_error)?;
    if !unreadable.is_empty() {
        return Ok(Err((
            403,
            format!(
                "You do not have access to {} target channel(s)",
                unreadable.len()
            ),
        )));
    }

    // Auto-join the public targets.
    let public: Vec<String> = unique
        .iter()
        .filter(|id| kind_of(id) == Some("public"))
        .cloned()
        .collect();
    let to_join = non_member_channels(caller, &public).await?;
    let joined_at = utc_now();
    for channel_id in &to_join {
        members::Entity::insert(members::ActiveModel {
            id: Set(generate_id("cmb")),
            channel_id: Set(channel_id.clone()),
            user_id: Set(user_id.to_owned()),
            role: Set("member".to_owned()),
            joined_at: Set(joined_at),
            created_at: Set(joined_at),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm_db)
        .await?;
        chat_channels::Entity::update_many()
            .col_expr(
                chat_channels::Column::MemberCount,
                sea_orm::ExprTrait::add(Expr::col(chat_channels::Column::MemberCount), 1),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(joined_at))
            .filter(chat_channels::Column::Id.eq(channel_id))
            .exec(&orm_db)
            .await?;
    }

    let content = comment
        .as_deref()
        .map(|c| weldsuite_chat_domain::text::js_trim(c).to_owned())
        .unwrap_or_default();
    let at = utc_now();
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
        chat_messages::Entity::insert(chat_messages::ActiveModel {
            id: Set(id.clone()),
            channel_id: Set(target.clone()),
            author_id: Set(user_id.to_owned()),
            author_name: Set(author_name.clone()),
            author_avatar: Set(author_avatar.clone()),
            content: Set(content.clone()),
            html_content: Set(html_comment.clone()),
            forwarded_from: Set(Some(forwarded_from.clone())),
            has_attachments: Set(false),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm_db)
        .await?;
        // One statement, so concurrent posts all count.
        chat_channels::Entity::update_many()
            .col_expr(chat_channels::Column::LastMessageAt, Expr::value(at))
            .col_expr(
                chat_channels::Column::LastMessagePreview,
                Expr::value(preview.clone()),
            )
            .col_expr(
                chat_channels::Column::MessageCount,
                sea_orm::ExprTrait::add(Expr::col(chat_channels::Column::MessageCount), 1),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(at))
            .filter(chat_channels::Column::Id.eq(&target))
            .exec(&orm_db)
            .await?;
        let members: Vec<String> = members::Entity::find()
            .select_only()
            .column(members::Column::UserId)
            .filter(members::Column::ChannelId.eq(&target))
            .into_tuple()
            .all(&orm_db)
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
