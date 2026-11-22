//! Who follows a record chat (`services/chat/entity-channels/followers.ts`):
//! membership in a record chat only means following, so rows come and go
//! with posting, mentions and the follow button, and `member_count` is
//! recounted after each change.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, QueryTrait, RelationDef,
};
use weldsuite_chat_domain::entity::{self, can_access_entity};
use weldsuite_chat_domain::{Can, Realtime};
use weldsuite_db::{PgPool, orm, orm_error, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{chat_channel_members as members, chat_channels};

/// `syncMemberCount`: one statement, the count taken as the row is updated:
/// `member_count = (select count(*)::int from chat_channel_members where channel_id = $1)`.
async fn sync_member_count(db: &PgPool, channel_id: &str) -> Result<(), DbErr> {
    let count = members::Entity::find()
        .select_only()
        .expr(sea_orm::ExprTrait::cast_as(
            Func::count(Expr::col(Asterisk)),
            "int",
        ))
        .filter(members::Column::ChannelId.eq(channel_id))
        .into_query();
    chat_channels::Entity::update_many()
        .col_expr(
            chat_channels::Column::MemberCount,
            Expr::SubQuery(None, Box::new(count.into())),
        )
        .filter(chat_channels::Column::Id.eq(channel_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `select user_id from chat_channel_members where channel_id = $1 and user_id = any($2)`
/// (`user_ids` not empty).
async fn members_among(
    db: &PgPool,
    channel_id: &str,
    user_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.is_in(user_ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `[...new Set(ids.filter(Boolean))]`.
fn unique_present(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids.iter().filter(|id| !id.is_empty()) {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// `addFollowers(db, channelId, userIds, { ownerId })`: the users added.
pub(crate) async fn add_followers(
    db: &PgPool,
    channel_id: &str,
    user_ids: &[String],
    owner_id: Option<&str>,
) -> Result<Vec<String>, DbErr> {
    let wanted = unique_present(user_ids);
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let existing = members_among(db, channel_id, &wanted).await?;
    let missing: Vec<String> = wanted
        .into_iter()
        .filter(|u| !existing.contains(u))
        .collect();
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let at = utc_now();
    // One insert, the rows in the order asked; a row a concurrent add wrote
    // first is skipped (`on conflict do nothing`).
    let rows = missing.iter().map(|user| members::ActiveModel {
        id: Set(generate_id("cmb")),
        channel_id: Set(channel_id.to_owned()),
        user_id: Set(user.clone()),
        role: Set(if Some(user.as_str()) == owner_id {
            "owner".to_owned()
        } else {
            "member".to_owned()
        }),
        joined_at: Set(at),
        created_at: Set(at),
        ..Default::default()
    });
    let inserted: Vec<String> = members::Entity::insert_many(rows)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .map(|member| member.user_id)
        .collect();
    if !inserted.is_empty() {
        sync_member_count(db, channel_id).await?;
    }
    Ok(inserted)
}

/// `removeFollower`: whether a row went.
pub(crate) async fn remove_follower(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<bool, DbErr> {
    let removed = members::Entity::delete_many()
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .exec(&orm(db))
        .await?;
    if removed.rows_affected == 0 {
        return Ok(false);
    }
    sync_member_count(db, channel_id).await?;
    Ok(true)
}

/// `setFollowedChannelsMuted`: the record chats of a type the user follows,
/// muted or unmuted; the channels that changed.
pub(crate) async fn set_followed_channels_muted(
    db: &PgPool,
    user_id: &str,
    entity_type: &str,
    is_muted: bool,
) -> Result<Vec<String>, DbErr> {
    let db = orm(db);
    let channel: RelationDef = members::Entity::belongs_to(chat_channels::Entity)
        .from(members::Column::ChannelId)
        .to(chat_channels::Column::Id)
        .into();
    let channel_ids: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::ChannelId)
        .join(JoinType::InnerJoin, channel)
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::IsMuted.eq(!is_muted))
        .filter(chat_channels::Column::Type.eq("entity"))
        .filter(chat_channels::Column::EntityType.eq(entity_type))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    members::Entity::update_many()
        .col_expr(members::Column::IsMuted, Expr::value(is_muted))
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::ChannelId.is_in(channel_ids.iter().map(String::as_str)))
        .exec(&db)
        .await?;
    Ok(channel_ids)
}

/// `defaultFollowersWhoMayOpen`: of the record's default followers (the
/// acting user left out), those who may open it.
pub(crate) async fn default_followers_who_may_open(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    acting_user_id: &str,
    user_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    let Some(provider) = entity::provider(entity_type) else {
        return Ok(Vec::new());
    };
    let mut candidates: Vec<String> = Vec::new();
    for id in user_ids {
        if !id.is_empty() && id != acting_user_id && !candidates.contains(id) {
            candidates.push(id.clone());
        }
    }
    let mut allowed = Vec::new();
    for user_id in candidates {
        let can = Can::user(db, &user_id);
        if can_access_entity(provider, db, &user_id, entity_id, &can)
            .await
            .map_err(orm_error)?
        {
            allowed.push(user_id);
        }
    }
    Ok(allowed)
}

/// `followRecordChatOnPost`: the author, and the mentioned users who may
/// open the record, follow its chat. The users added.
pub(crate) async fn follow_record_chat_on_post(
    db: &PgPool,
    channel_id: &str,
    entity_type: &str,
    entity_id: &str,
    author_user_id: &str,
    mentioned_user_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    let mut mentioned: Vec<String> = Vec::new();
    for id in mentioned_user_ids {
        if id != author_user_id && !mentioned.contains(id) {
            mentioned.push(id.clone());
        }
    }
    let mut asked = vec![author_user_id.to_owned()];
    asked.extend(mentioned.iter().cloned());
    let following = members_among(db, channel_id, &asked).await?;
    let mut followers: Vec<String> = if following.iter().any(|f| f == author_user_id) {
        Vec::new()
    } else {
        vec![author_user_id.to_owned()]
    };
    if let Some(provider) = entity::provider(entity_type) {
        for user_id in mentioned {
            if following.contains(&user_id) {
                continue;
            }
            let can = Can::user(db, &user_id);
            if can_access_entity(provider, db, &user_id, entity_id, &can)
                .await
                .map_err(orm_error)?
            {
                followers.push(user_id);
            }
        }
    }
    add_followers(db, channel_id, &followers, None).await
}

/// `announceNewFollowers`: `channel_new` to each new follower.
pub(crate) async fn announce_new_followers(
    realtime: &Realtime,
    workspace_id: &str,
    channel_id: &str,
    channel_name: &str,
    user_ids: &[String],
) {
    for user_id in user_ids {
        realtime
            .channel_new(workspace_id, user_id, channel_id, channel_name)
            .await;
    }
}
