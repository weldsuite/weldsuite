//! The WeldChat read boundary (`@weldsuite/chat-domain/channel-access`): a
//! user may see a channel and its messages when it is public, when they have
//! a membership row, or, for a record chat (`type = 'entity'`), when they may
//! see the record (ADR CHAT-003).

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, TenantPermissionQueries, orm};
use weldsuite_permissions::{
    Permissions, ResolvedPermissions, has_app_permission, resolve_effective_permissions,
};

use weldsuite_schema::tenant::{
    chat_channel_members, chat_channels, chat_messages, workspace_members,
};

use crate::entity;

/// "Does the acting user hold this workspace permission?" (`PermissionCheck`).
pub enum Can<'a> {
    /// `hasContextPermission(c, key)`: the request's resolved permissions,
    /// app- and deny-aware.
    Context(&'a Permissions),
    /// `userPermissionCheck(db, userId)`: the user's permissions resolved
    /// from the tenant database on first use, evaluated across all apps.
    User(UserPermissions),
    /// No permissions resolved: every check fails.
    Denied,
}

/// `userPermissionCheck`: resolved lazily, once.
pub struct UserPermissions {
    db: PgPool,
    user_id: String,
    resolved: Mutex<Option<ResolvedPermissions>>,
}

impl Can<'_> {
    /// `userPermissionCheck(db, userId)`.
    pub fn user(db: &PgPool, user_id: &str) -> Can<'static> {
        Can::User(UserPermissions {
            db: db.clone(),
            user_id: user_id.to_owned(),
            resolved: Mutex::new(None),
        })
    }

    /// Whether the user holds `permission`.
    pub async fn can(&self, permission: &str) -> Result<bool, DbErr> {
        match self {
            Self::Context(permissions) => Ok(permissions.has_any(&[permission])),
            Self::Denied => Ok(false),
            Self::User(user) => {
                let cached = user
                    .resolved
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let resolved = if let Some(resolved) = cached {
                    resolved
                } else {
                    let queries = TenantPermissionQueries::new(user.db.clone());
                    let resolved = resolve_effective_permissions(&queries, &user.user_id).await?;
                    *user
                        .resolved
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(resolved.clone());
                    resolved
                };
                Ok(has_app_permission(&resolved, permission, None))
            }
        }
    }
}

/// A channel's access-relevant columns.
struct ChannelRef {
    kind: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
}

async fn live_channel(db: &PgPool, channel_id: &str) -> Result<Option<ChannelRef>, DbErr> {
    let row: Option<(String, Option<String>, Option<String>)> = chat_channels::Entity::find()
        .select_only()
        .columns([
            chat_channels::Column::Type,
            chat_channels::Column::EntityType,
            chat_channels::Column::EntityId,
        ])
        .filter(chat_channels::Column::Id.eq(channel_id))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(kind, entity_type, entity_id)| ChannelRef {
        kind,
        entity_type,
        entity_id,
    }))
}

/// `canAccessChannel(db, channelId, userId, { can })`: a live public
/// channel, a membership row, or for a record chat the record's own check.
/// `can` of `None` is the default, the user's permissions from the database.
pub async fn can_access_channel(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
    can: Option<&Can<'_>>,
) -> Result<bool, DbErr> {
    let Some(channel) = live_channel(db, channel_id).await? else {
        return Ok(false);
    };
    if channel.kind == "public" {
        return Ok(true);
    }
    if channel.kind == "entity" {
        let (Some(entity_type), Some(entity_id)) = (
            channel.entity_type.filter(|t| !t.is_empty()),
            channel.entity_id.filter(|i| !i.is_empty()),
        ) else {
            return Ok(false);
        };
        let Some(provider) = entity::provider(&entity_type) else {
            return Ok(false);
        };
        let fallback;
        let can = if let Some(can) = can {
            can
        } else {
            fallback = Can::user(db, user_id);
            &fallback
        };
        return entity::can_access_entity(provider, db, user_id, &entity_id, can).await;
    }
    is_member(db, channel_id, user_id).await
}

/// Whether the user has a membership row for the channel.
pub async fn is_member(db: &PgPool, channel_id: &str, user_id: &str) -> Result<bool, DbErr> {
    let row: Option<String> = chat_channel_members::Entity::find()
        .select_only()
        .column(chat_channel_members::Column::Id)
        .filter(chat_channel_members::Column::ChannelId.eq(channel_id))
        .filter(chat_channel_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

/// `unreadableRecordChatIds`: of `channel_ids`, the record chats the user may
/// not read; every other channel is left out of the answer.
pub async fn unreadable_record_chat_ids(
    db: &PgPool,
    user_id: &str,
    channel_ids: &[String],
    can: Option<&Can<'_>>,
) -> Result<HashSet<String>, DbErr> {
    let mut unreadable = HashSet::new();
    if channel_ids.is_empty() {
        return Ok(unreadable);
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = chat_channels::Entity::find()
        .select_only()
        .columns([
            chat_channels::Column::Id,
            chat_channels::Column::EntityType,
            chat_channels::Column::EntityId,
        ])
        .filter(chat_channels::Column::Id.is_in(channel_ids.iter().map(String::as_str)))
        .filter(chat_channels::Column::Type.eq("entity"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let fallback;
    let can = if let Some(can) = can {
        can
    } else {
        fallback = Can::user(db, user_id);
        &fallback
    };
    // Grouped by type, in first-seen order (a JavaScript `Map`).
    let mut order: Vec<String> = Vec::new();
    let mut by_type: BTreeMap<String, Vec<(String, Option<String>)>> = BTreeMap::new();
    for (id, entity_type, entity_id) in rows {
        let key = entity_type.unwrap_or_default();
        if !by_type.contains_key(&key) {
            order.push(key.clone());
        }
        by_type.entry(key).or_default().push((id, entity_id));
    }
    for entity_type in order {
        let type_rows = by_type.remove(&entity_type).unwrap_or_default();
        let entity_ids: Vec<String> = type_rows
            .iter()
            .filter_map(|(_, entity_id)| entity_id.clone().filter(|e| !e.is_empty()))
            .collect();
        let visible = visible_entity_ids(db, user_id, can, &entity_type, &entity_ids).await?;
        for (id, entity_id) in type_rows {
            let readable = entity_id
                .filter(|e| !e.is_empty())
                .is_some_and(|e| visible.contains(&e));
            if !readable {
                unreadable.insert(id);
            }
        }
    }
    Ok(unreadable)
}

/// The records of one type, of `entity_ids`, the user may see. None for a
/// type without a provider.
async fn visible_entity_ids(
    db: &PgPool,
    user_id: &str,
    can: &Can<'_>,
    entity_type: &str,
    entity_ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    let Some(provider) = entity::provider(entity_type) else {
        return Ok(HashSet::new());
    };
    if !can.can(provider.required_permission()).await? {
        return Ok(HashSet::new());
    }
    let unique = unique_ids(entity_ids);
    provider.filter_visible(db, user_id, can, &unique).await
}

/// `[...new Set(ids)]`.
pub fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect()
}

/// `canAccessMessage`: the message's channel, by [`can_access_channel`];
/// false for an unknown or deleted message.
pub async fn can_access_message(
    db: &PgPool,
    message_id: &str,
    user_id: &str,
    can: Option<&Can<'_>>,
) -> Result<bool, DbErr> {
    let channel: Option<String> = chat_messages::Entity::find()
        .select_only()
        .column(chat_messages::Column::ChannelId)
        .filter(chat_messages::Column::Id.eq(message_id))
        .filter(chat_messages::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    match channel.filter(|c| !c.is_empty()) {
        Some(channel_id) => can_access_channel(db, &channel_id, user_id, can).await,
        None => Ok(false),
    }
}

/// `getChannelRole`: the caller's role in the channel, or `None` without a
/// membership row.
pub async fn get_channel_role(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<Option<String>, DbErr> {
    chat_channel_members::Entity::find()
        .select_only()
        .column(chat_channel_members::Column::Role)
        .filter(chat_channel_members::Column::ChannelId.eq(channel_id))
        .filter(chat_channel_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `isWorkspaceAdmin`: the built-in `workspace_members.role` is OWNER or ADMIN.
async fn is_workspace_admin(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    let role: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Role)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let role = role.map(|r| r.to_uppercase());
    Ok(matches!(role.as_deref(), Some("OWNER" | "ADMIN")))
}

/// `isChannelModerator`: a channel admin or owner, or a workspace admin.
pub async fn is_channel_moderator(
    db: &PgPool,
    channel_id: &str,
    user_id: &str,
) -> Result<bool, DbErr> {
    let role = get_channel_role(db, channel_id, user_id).await?;
    if matches!(role.as_deref(), Some("admin" | "owner")) {
        return Ok(true);
    }
    is_workspace_admin(db, user_id).await
}

/// A `jsonb` string array (`string[] | null`) as a list.
pub fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
