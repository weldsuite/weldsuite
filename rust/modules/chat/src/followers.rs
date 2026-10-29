//! Who follows a record chat (`services/chat/entity-channels/followers.ts`):
//! membership in a record chat only means following, so rows come and go
//! with posting, mentions and the follow button, and `member_count` is
//! recounted after each change.

use sqlx::PgPool;
use weldsuite_chat_domain::entity::{self, can_access_entity};
use weldsuite_chat_domain::{Can, Realtime};
use weldsuite_kit::generate_id;

use crate::util::now;

/// `syncMemberCount`.
async fn sync_member_count(db: &PgPool, channel_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update chat_channels set member_count =
            (select count(*)::int from chat_channel_members where channel_id = $1)
         where id = $1",
    )
    .bind(channel_id)
    .execute(db)
    .await?;
    Ok(())
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
) -> Result<Vec<String>, sqlx::Error> {
    let wanted = unique_present(user_ids);
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let existing: Vec<String> = sqlx::query_scalar(
        "select user_id from chat_channel_members where channel_id = $1 and user_id = any($2)",
    )
    .bind(channel_id)
    .bind(&wanted)
    .fetch_all(db)
    .await?;
    let missing: Vec<String> = wanted
        .into_iter()
        .filter(|u| !existing.contains(u))
        .collect();
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = missing.iter().map(|_| generate_id("cmb")).collect();
    let roles: Vec<String> = missing
        .iter()
        .map(|u| {
            if Some(u.as_str()) == owner_id {
                "owner".to_owned()
            } else {
                "member".to_owned()
            }
        })
        .collect();
    let at = now();
    let inserted: Vec<String> = sqlx::query_scalar(
        "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
         select m.id, $2, m.user_id, m.role, $5::timestamp, $5::timestamp
         from unnest($1::varchar[], $3::varchar[], $4::varchar[]) with ordinality as m(id, user_id, role, n)
         order by m.n
         on conflict do nothing
         returning user_id",
    )
    .bind(&ids)
    .bind(channel_id)
    .bind(&missing)
    .bind(&roles)
    .bind(&at)
    .fetch_all(db)
    .await?;
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
) -> Result<bool, sqlx::Error> {
    let removed: Vec<String> = sqlx::query_scalar(
        "delete from chat_channel_members where channel_id = $1 and user_id = $2 returning id",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_all(db)
    .await?;
    if removed.is_empty() {
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
) -> Result<Vec<String>, sqlx::Error> {
    let channel_ids: Vec<String> = sqlx::query_scalar(
        "select m.channel_id from chat_channel_members m
         inner join chat_channels c on c.id = m.channel_id
         where m.user_id = $1 and m.is_muted = $2 and c.type = 'entity' and c.entity_type = $3
           and c.deleted_at is null",
    )
    .bind(user_id)
    .bind(!is_muted)
    .bind(entity_type)
    .fetch_all(db)
    .await?;
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query(
        "update chat_channel_members set is_muted = $3 where user_id = $1 and channel_id = any($2)",
    )
    .bind(user_id)
    .bind(&channel_ids)
    .bind(is_muted)
    .execute(db)
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
) -> Result<Vec<String>, sqlx::Error> {
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
        if can_access_entity(provider, db, &user_id, entity_id, &can).await? {
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
) -> Result<Vec<String>, sqlx::Error> {
    let mut mentioned: Vec<String> = Vec::new();
    for id in mentioned_user_ids {
        if id != author_user_id && !mentioned.contains(id) {
            mentioned.push(id.clone());
        }
    }
    let mut asked = vec![author_user_id.to_owned()];
    asked.extend(mentioned.iter().cloned());
    let following: Vec<String> = sqlx::query_scalar(
        "select user_id from chat_channel_members where channel_id = $1 and user_id = any($2)",
    )
    .bind(channel_id)
    .bind(&asked)
    .fetch_all(db)
    .await?;
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
            if can_access_entity(provider, db, &user_id, entity_id, &can).await? {
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
