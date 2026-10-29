//! Channel creation and membership (`@weldsuite/chat-domain/create-channel`,
//! `/channel-members`): the creator joins as owner, a public channel fans out
//! to every active internal member, and `chat_channels.member_count` follows
//! the roster. Realtime and entity events stay with the routes.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::text::{js_len, js_prefix, slugify_channel_name};

/// What a new channel is made of (`CreateChannelInput`).
#[derive(Debug, Clone, Default)]
pub struct NewChannel {
    pub name: String,
    pub description: Option<String>,
    pub topic: Option<String>,
    /// `public` or `private`.
    pub kind: String,
    pub icon: Option<String>,
    pub section_id: Option<String>,
    pub member_ids: Vec<String>,
    pub agent_ids: Vec<String>,
    pub metadata: Option<Value>,
}

/// `CreateChannelResult`: the channel row as Drizzle returns it, and every
/// member now in it, the creator first.
#[derive(Debug, Clone)]
pub struct CreatedChannel {
    pub channel: Value,
    pub member_user_ids: Vec<String>,
}

/// `resolveChannelSlug(db, name, channelId)`: the name's slug, or with the
/// channel id appended when another row holds it.
pub async fn resolve_channel_slug(
    db: &PgPool,
    name: &str,
    channel_id: &str,
) -> Result<String, sqlx::Error> {
    let base = slugify_channel_name(name);
    if base.is_empty() {
        return Ok(channel_id.to_owned());
    }
    let clash: Option<String> =
        sqlx::query_scalar("select id from chat_channels where slug = $1 and id <> $2 limit 1")
            .bind(&base)
            .bind(channel_id)
            .fetch_optional(db)
            .await?;
    if clash.is_none() {
        return Ok(base);
    }
    let keep = 255usize.saturating_sub(js_len(channel_id) + 1);
    Ok(format!("{}-{channel_id}", js_prefix(&base, keep)))
}

/// Push `id` unless present (a JavaScript `Set` in insertion order).
fn add_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|existing| existing == id) {
        list.push(id.to_owned());
    }
}

/// Membership rows for `user_ids` in one statement (`onConflictDoNothing`).
async fn insert_members(
    db: &PgPool,
    channel_id: &str,
    user_ids: &[String],
    member_type: Option<&str>,
    now: &str,
) -> Result<(), sqlx::Error> {
    if user_ids.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = user_ids.iter().map(|_| generate_id("cmb")).collect();
    sqlx::query(
        "insert into chat_channel_members
            (id, channel_id, user_id, member_type, role, joined_at, created_at)
         select m.id, $2, m.user_id, coalesce($4, 'user'), 'member', $5::timestamp, $5::timestamp
         from unnest($1::varchar[], $3::varchar[]) with ordinality as m(id, user_id, n)
         order by m.n
         on conflict do nothing",
    )
    .bind(&ids)
    .bind(channel_id)
    .bind(user_ids)
    .bind(member_type)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// `createChannel(db, creatorUserId, input)`.
pub async fn create_channel(
    db: &PgPool,
    creator_user_id: &str,
    input: &NewChannel,
    now: &str,
) -> Result<CreatedChannel, sqlx::Error> {
    let id = generate_id("ch");
    let slug = resolve_channel_slug(db, &input.name, &id).await?;
    sqlx::query(
        "insert into chat_channels
            (id, name, slug, description, topic, type, icon, section_id, created_by,
             member_count, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11::timestamp, $11::timestamp)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&slug)
    .bind(&input.description)
    .bind(&input.topic)
    .bind(&input.kind)
    .bind(&input.icon)
    .bind(&input.section_id)
    .bind(creator_user_id)
    .bind(&input.metadata)
    .bind(now)
    .execute(db)
    .await?;

    // 1. The creator is the owner.
    sqlx::query(
        "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
         values ($1, $2, $3, 'owner', $4::timestamp, $4::timestamp)",
    )
    .bind(generate_id("cmb"))
    .bind(&id)
    .bind(creator_user_id)
    .bind(now)
    .execute(db)
    .await?;
    let mut added: Vec<String> = vec![creator_user_id.to_owned()];

    // 2. Invited members that are active workspace members (duplicates kept,
    //    as the filter keeps them; the insert skips them).
    let invited: Vec<String> = input
        .member_ids
        .iter()
        .filter(|m| *m != creator_user_id)
        .cloned()
        .collect();
    let explicit = filter_to_workspace_members(db, &invited).await?;
    if !explicit.is_empty() {
        insert_members(db, &id, &explicit, None, now).await?;
        for member in &explicit {
            add_unique(&mut added, member);
        }
    }

    // 3. A public channel is workspace-wide.
    if input.kind == "public" {
        let remaining: Vec<String> = list_internal_member_ids(db)
            .await?
            .into_iter()
            .filter(|uid| !added.contains(uid))
            .collect();
        if !remaining.is_empty() {
            insert_members(db, &id, &remaining, None, now).await?;
            for uid in &remaining {
                add_unique(&mut added, uid);
            }
        }
    }

    // 3b. Agents (any agent not deleted).
    let mut agent_ids: Vec<String> = Vec::new();
    for agent in &input.agent_ids {
        if agent.starts_with("agt_") && !added.contains(agent) {
            add_unique(&mut agent_ids, agent);
        }
    }
    if !agent_ids.is_empty() {
        let valid: Vec<String> = sqlx::query_scalar(
            "select id from weldagent_agents where id = any($1) and deleted_at is null",
        )
        .bind(&agent_ids)
        .fetch_all(db)
        .await?;
        if !valid.is_empty() {
            insert_members(db, &id, &valid, Some("agent"), now).await?;
            for agent in &valid {
                add_unique(&mut added, agent);
            }
        }
    }

    // 4. The denormalised roster size.
    if added.len() > 1 {
        sqlx::query(
            "update chat_channels set member_count = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(i32::try_from(added.len()).unwrap_or(i32::MAX))
        .bind(now)
        .execute(db)
        .await?;
    }

    let channel = channel_row(db, &id).await?.unwrap_or(Value::Null);
    Ok(CreatedChannel {
        channel,
        member_user_ids: added,
    })
}

/// `select * from chat_channels where id = $1` as Drizzle returns it.
pub async fn channel_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(c) from chat_channels c where c.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// ACTIVE, live INTERNAL members of the workspace.
async fn list_internal_member_ids(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from workspace_members
         where status = 'ACTIVE' and member_type = 'INTERNAL' and deleted_at is null",
    )
    .fetch_all(db)
    .await
}

/// `filterToWorkspaceMembers`: the ids that are active workspace members,
/// in the given order.
async fn filter_to_workspace_members(
    db: &PgPool,
    user_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let valid: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where user_id = any($1) and status = 'ACTIVE' and deleted_at is null",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    Ok(user_ids
        .iter()
        .filter(|id| valid.contains(id))
        .cloned()
        .collect())
}

/// `AddChannelMembersResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddMembers {
    Added { added_user_ids: Vec<String> },
    Refused(String),
}

/// `addChannelMembers(db, { channelId, userIds, memberType })`.
pub async fn add_channel_members(
    db: &PgPool,
    channel_id: &str,
    user_ids: &[String],
    member_type: &str,
    now: &str,
) -> Result<AddMembers, sqlx::Error> {
    let mut unique: Vec<String> = Vec::new();
    for id in user_ids {
        add_unique(&mut unique, id);
    }
    if unique.is_empty() {
        return Ok(AddMembers::Added {
            added_user_ids: Vec::new(),
        });
    }
    if let Some(message) = validate_member_ids(db, &unique, member_type).await? {
        return Ok(AddMembers::Refused(message));
    }
    let existing: Vec<String> = sqlx::query_scalar(
        "select user_id from chat_channel_members where channel_id = $1 and user_id = any($2)",
    )
    .bind(channel_id)
    .bind(&unique)
    .fetch_all(db)
    .await?;
    let to_add: Vec<String> = unique
        .into_iter()
        .filter(|uid| !existing.contains(uid))
        .collect();
    if to_add.is_empty() {
        return Ok(AddMembers::Added {
            added_user_ids: Vec::new(),
        });
    }
    insert_members(db, channel_id, &to_add, Some(member_type), now).await?;
    sqlx::query(
        "update chat_channels set member_count = member_count + $2, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(channel_id)
    .bind(i32::try_from(to_add.len()).unwrap_or(i32::MAX))
    .bind(now)
    .execute(db)
    .await?;
    Ok(AddMembers::Added {
        added_user_ids: to_add,
    })
}

/// `validateMemberIds`: the refusal message, or `None` when all are valid.
async fn validate_member_ids(
    db: &PgPool,
    user_ids: &[String],
    member_type: &str,
) -> Result<Option<String>, sqlx::Error> {
    if member_type == "agent" {
        let invalid: Vec<&str> = user_ids
            .iter()
            .filter(|id| !id.starts_with("agt_"))
            .map(String::as_str)
            .collect();
        if !invalid.is_empty() {
            return Ok(Some(format!("Invalid agent id(s): {}", invalid.join(", "))));
        }
        let found: Vec<String> = sqlx::query_scalar(
            "select id from weldagent_agents where id = any($1) and deleted_at is null",
        )
        .bind(user_ids)
        .fetch_all(db)
        .await?;
        let missing: Vec<&str> = user_ids
            .iter()
            .filter(|id| !found.contains(id))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            return Ok(Some(format!("Agent(s) not found: {}", missing.join(", "))));
        }
        return Ok(None);
    }
    let found: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where user_id = any($1) and status = 'ACTIVE' and deleted_at is null",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    let missing: Vec<&str> = user_ids
        .iter()
        .filter(|id| !found.contains(id))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Ok(Some(format!(
            "User(s) not in this workspace: {}",
            missing.join(", ")
        )));
    }
    Ok(None)
}

/// `removeChannelMemberByUserId`: whether a row was removed, and its role.
pub async fn remove_channel_member_by_user_id(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    now: &str,
) -> Result<Option<String>, sqlx::Error> {
    let membership: Option<(String, String)> = sqlx::query_as(
        "select id, role from chat_channel_members where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some((id, role)) = membership else {
        return Ok(None);
    };
    sqlx::query("delete from chat_channel_members where id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    sqlx::query(
        "update chat_channels set member_count = greatest(member_count - 1, 0),
            updated_at = $2::timestamp where id = $1",
    )
    .bind(channel_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(Some(role))
}

/// `getMembership`: the caller's membership id and role.
pub async fn get_membership(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as(
        "select id, role from chat_channel_members where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// `joinPublicChannel`: `Err(message)` when the channel is missing or not
/// public; `Ok(already_member)` otherwise.
pub async fn join_public_channel(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    now: &str,
) -> Result<Result<bool, &'static str>, sqlx::Error> {
    let kind: Option<String> = sqlx::query_scalar(
        "select type from chat_channels where id = $1 and deleted_at is null limit 1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    if kind.as_deref() != Some("public") {
        return Ok(Err("Channel not found or is not public"));
    }
    if get_membership(db, channel_id, user_id).await?.is_some() {
        return Ok(Ok(true));
    }
    sqlx::query(
        "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
         values ($1, $2, $3, 'member', $4::timestamp, $4::timestamp) on conflict do nothing",
    )
    .bind(generate_id("cmb"))
    .bind(channel_id)
    .bind(user_id)
    .bind(now)
    .execute(db)
    .await?;
    sqlx::query(
        "update chat_channels set member_count = member_count + 1, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(channel_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(Ok(false))
}
