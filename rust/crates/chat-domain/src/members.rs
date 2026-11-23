//! Channel creation and membership (`@weldsuite/chat-domain/create-channel`,
//! `/channel-members`): the creator joins as owner, a public channel fans out
//! to every active internal member, and `chat_channels.member_count` follows
//! the roster. Realtime and entity events stay with the routes.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_channels, weldagent_agents, workspace_members,
};

use crate::text::{js_len, js_prefix, slugify_channel_name};
use crate::{json_error, timestamp_of};

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
) -> Result<String, DbErr> {
    let base = slugify_channel_name(name);
    if base.is_empty() {
        return Ok(channel_id.to_owned());
    }
    let clash: Option<String> = chat_channels::Entity::find()
        .select_only()
        .column(chat_channels::Column::Id)
        .filter(chat_channels::Column::Slug.eq(&base))
        .filter(chat_channels::Column::Id.ne(channel_id))
        .into_tuple()
        .one(&orm(db))
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

/// Membership rows for `user_ids` in one statement (`onConflictDoNothing`),
/// in their order.
async fn insert_members(
    db: &PgPool,
    channel_id: &str,
    user_ids: &[String],
    member_type: Option<&str>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    if user_ids.is_empty() {
        return Ok(());
    }
    let rows = user_ids.iter().map(|user_id| members::ActiveModel {
        id: Set(generate_id("cmb")),
        channel_id: Set(channel_id.to_owned()),
        user_id: Set(user_id.clone()),
        member_type: Set(member_type.unwrap_or("user").to_owned()),
        role: Set("member".to_owned()),
        joined_at: Set(now),
        created_at: Set(now),
        ..Default::default()
    });
    members::Entity::insert_many(rows)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// `createChannel(db, creatorUserId, input)`.
pub async fn create_channel(
    db: &PgPool,
    creator_user_id: &str,
    input: &NewChannel,
    now: &str,
) -> Result<CreatedChannel, DbErr> {
    let id = generate_id("ch");
    let slug = resolve_channel_slug(db, &input.name, &id).await?;
    let now = timestamp_of(now)?;
    chat_channels::Entity::insert(chat_channels::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name.clone()),
        slug: Set(slug),
        description: Set(input.description.clone()),
        topic: Set(input.topic.clone()),
        type_: Set(input.kind.clone()),
        icon: Set(input.icon.clone()),
        section_id: Set(input.section_id.clone()),
        created_by: Set(Some(creator_user_id.to_owned())),
        member_count: Set(1),
        metadata: Set(input.metadata.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;

    // 1. The creator is the owner.
    members::Entity::insert(members::ActiveModel {
        id: Set(generate_id("cmb")),
        channel_id: Set(id.clone()),
        user_id: Set(creator_user_id.to_owned()),
        role: Set("owner".to_owned()),
        joined_at: Set(now),
        created_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
        let valid = live_agent_ids(db, &agent_ids).await?;
        if !valid.is_empty() {
            insert_members(db, &id, &valid, Some("agent"), now).await?;
            for agent in &valid {
                add_unique(&mut added, agent);
            }
        }
    }

    // 4. The denormalised roster size.
    if added.len() > 1 {
        chat_channels::Entity::update_many()
            .col_expr(
                chat_channels::Column::MemberCount,
                Expr::value(i32::try_from(added.len()).unwrap_or(i32::MAX)),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(now))
            .filter(chat_channels::Column::Id.eq(&id))
            .exec(&orm(db))
            .await?;
    }

    let channel = channel_row(db, &id).await?.unwrap_or(Value::Null);
    Ok(CreatedChannel {
        channel,
        member_user_ids: added,
    })
}

/// `select * from chat_channels where id = $1` as Drizzle returns it.
pub async fn channel_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = chat_channels::Entity::find_by_id(id).one(&orm(db)).await?;
    row.map(serde_json::to_value).transpose().map_err(json_error)
}

/// ACTIVE, live INTERNAL members of the workspace.
async fn list_internal_member_ids(db: &PgPool) -> Result<Vec<String>, DbErr> {
    workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::MemberType.eq("INTERNAL"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Of `user_ids` (not empty), the ACTIVE, live workspace members.
async fn active_member_ids(db: &PgPool, user_ids: &[String]) -> Result<Vec<String>, DbErr> {
    workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.is_in(user_ids.iter().map(String::as_str)))
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Of `agent_ids` (not empty), the agents not deleted.
async fn live_agent_ids(db: &PgPool, agent_ids: &[String]) -> Result<Vec<String>, DbErr> {
    weldagent_agents::Entity::find()
        .select_only()
        .column(weldagent_agents::Column::Id)
        .filter(weldagent_agents::Column::Id.is_in(agent_ids.iter().map(String::as_str)))
        .filter(weldagent_agents::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `filterToWorkspaceMembers`: the ids that are active workspace members,
/// in the given order.
async fn filter_to_workspace_members(
    db: &PgPool,
    user_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let valid = active_member_ids(db, user_ids).await?;
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
) -> Result<AddMembers, DbErr> {
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
    let existing: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.is_in(unique.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
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
    let now = timestamp_of(now)?;
    insert_members(db, channel_id, &to_add, Some(member_type), now).await?;
    chat_channels::Entity::update_many()
        .col_expr(
            chat_channels::Column::MemberCount,
            sea_orm::ExprTrait::add(
                Expr::col(chat_channels::Column::MemberCount),
                i32::try_from(to_add.len()).unwrap_or(i32::MAX),
            ),
        )
        .col_expr(chat_channels::Column::UpdatedAt, Expr::value(now))
        .filter(chat_channels::Column::Id.eq(channel_id))
        .exec(&orm(db))
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
) -> Result<Option<String>, DbErr> {
    if member_type == "agent" {
        let invalid: Vec<&str> = user_ids
            .iter()
            .filter(|id| !id.starts_with("agt_"))
            .map(String::as_str)
            .collect();
        if !invalid.is_empty() {
            return Ok(Some(format!("Invalid agent id(s): {}", invalid.join(", "))));
        }
        let found = live_agent_ids(db, user_ids).await?;
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
    let found = active_member_ids(db, user_ids).await?;
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
) -> Result<Option<String>, DbErr> {
    let Some((id, role)) = get_membership(db, channel_id, user_id).await? else {
        return Ok(None);
    };
    members::Entity::delete_by_id(id).exec(&orm(db)).await?;
    let now = timestamp_of(now)?;
    chat_channels::Entity::update_many()
        .col_expr(
            chat_channels::Column::MemberCount,
            Func::greatest([
                sea_orm::ExprTrait::sub(Expr::col(chat_channels::Column::MemberCount), 1),
                Expr::val(0),
            ])
            .into(),
        )
        .col_expr(chat_channels::Column::UpdatedAt, Expr::value(now))
        .filter(chat_channels::Column::Id.eq(channel_id))
        .exec(&orm(db))
        .await?;
    Ok(Some(role))
}

/// `getMembership`: the caller's membership id and role.
pub async fn get_membership(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<Option<(String, String)>, DbErr> {
    members::Entity::find()
        .select_only()
        .columns([members::Column::Id, members::Column::Role])
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `joinPublicChannel`: `Err(message)` when the channel is missing or not
/// public; `Ok(already_member)` otherwise.
pub async fn join_public_channel(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    now: &str,
) -> Result<Result<bool, &'static str>, DbErr> {
    let kind: Option<String> = chat_channels::Entity::find()
        .select_only()
        .column(chat_channels::Column::Type)
        .filter(chat_channels::Column::Id.eq(channel_id))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if kind.as_deref() != Some("public") {
        return Ok(Err("Channel not found or is not public"));
    }
    if get_membership(db, channel_id, user_id).await?.is_some() {
        return Ok(Ok(true));
    }
    let now = timestamp_of(now)?;
    members::Entity::insert(members::ActiveModel {
        id: Set(generate_id("cmb")),
        channel_id: Set(channel_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        role: Set("member".to_owned()),
        joined_at: Set(now),
        created_at: Set(now),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(db))
    .await?;
    chat_channels::Entity::update_many()
        .col_expr(
            chat_channels::Column::MemberCount,
            sea_orm::ExprTrait::add(Expr::col(chat_channels::Column::MemberCount), 1),
        )
        .col_expr(chat_channels::Column::UpdatedAt, Expr::value(now))
        .filter(chat_channels::Column::Id.eq(channel_id))
        .exec(&orm(db))
        .await?;
    Ok(Ok(false))
}
