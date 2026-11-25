//! `/api/chat-dm` (`routes/chat-dm/index.ts`): direct messages. A DM is a
//! `type = 'dm'` channel whose members are exactly its participants; asking
//! for one with the same people answers the existing channel. Someone invited
//! to the workspace but not yet accepted can't be in one (409,
//! `details.reason = "invitation_pending"`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_ARCHIVED, CHAT_CHANNEL_LEFT, CHAT_CHANNEL_UPDATED,
};
use weldsuite_chat_domain::members::channel_row;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_notifications::{chat as notify, create_and_deliver};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{chat_channel_members as members, chat_channels, workspace_members};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, validate};
use crate::groups::channels::{js, member_profile, with_null_picture};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["messages:read"]);
    let update = || gate.require(["messages:update"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            axum::routing::post(create_dm).route_layer(gate.require(["messages:create"])),
        )
        .route("/{id}", get(resolve_dm).route_layer(read()))
        .route(
            "/{id}",
            delete(leave_dm).route_layer(gate.require(["messages:delete"])),
        )
        .route("/{id}/archive", patch(archive).route_layer(update()))
        .route("/{id}/unarchive", patch(unarchive).route_layer(update()))
        .route("/{id}/pin", patch(pin).route_layer(update()))
}

/// The members of a DM with their names and account pictures (`fullMembers`);
/// `with_reads` adds role and read cursor.
async fn full_members(
    caller: &Caller,
    channel_id: &str,
    with_reads: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut members = member_rows(caller, channel_id, with_reads).await?;
    weldsuite_db::overlay_account_pictures(caller.master(), &mut members, "userId", "picture")
        .await;
    Ok(members)
}

/// A DM member with their name and email (`picture` added null).
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct DmMember {
    user_id: String,
    name: Option<String>,
    email: Option<String>,
}

/// [`DmMember`] with their role and read cursor.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct DmMemberWithReads {
    user_id: String,
    role: String,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    last_read_at: Option<PrimitiveDateTime>,
    last_read_message_id: Option<String>,
    name: Option<String>,
    email: Option<String>,
}

/// [`full_members`] with `picture` still null: avatars are account pictures,
/// resolved by the caller (one lookup for a whole list).
async fn member_rows(
    caller: &Caller,
    channel_id: &str,
    with_reads: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut query = members::Entity::find()
        .select_only()
        .column(members::Column::UserId);
    if with_reads {
        query = query.columns([
            members::Column::Role,
            members::Column::LastReadAt,
            members::Column::LastReadMessageId,
        ]);
    }
    let query = query
        .column_as(workspace_members::Column::Name, "name")
        .column_as(workspace_members::Column::Email, "email")
        .join(JoinType::LeftJoin, member_profile())
        .filter(members::Column::ChannelId.eq(channel_id));
    let db = orm(&caller.db);
    if with_reads {
        query
            .into_model::<DmMemberWithReads>()
            .all(&db)
            .await?
            .into_iter()
            .map(with_null_picture)
            .collect()
    } else {
        query
            .into_model::<DmMember>()
            .all(&db)
            .await?
            .into_iter()
            .map(with_null_picture)
            .collect()
    }
}

/// `select … from workspace_members where user_id = any($1)`, the columns
/// still to pick (`ids` not empty).
fn workspace_members_among(ids: &[String]) -> sea_orm::Select<workspace_members::Entity> {
    workspace_members::Entity::find()
        .select_only()
        .filter(workspace_members::Column::UserId.is_in(ids.iter().map(String::as_str)))
}

/// The member's `workspace_members.name` row: `None` without a row, `Some(None)`
/// for a row without a name.
async fn member_row_name(caller: &Caller, user_id: &str) -> Result<Option<Option<String>>, DbErr> {
    workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

fn with_fields(row: Option<Value>, fields: Vec<(&str, Value)>) -> Value {
    let mut map = match row {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in fields {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// `GET /`: the caller's DMs, latest activity first.
async fn list(caller: Caller) -> Response {
    let result = async {
        let db = orm(&caller.db);
        let memberships: Vec<(String, bool)> = members::Entity::find()
            .select_only()
            .columns([members::Column::ChannelId, members::Column::IsMuted])
            .filter(members::Column::UserId.eq(&caller.user_id))
            .into_tuple()
            .all(&db)
            .await?;
        if memberships.is_empty() {
            return Ok(Data(Vec::<Value>::new()).into_response());
        }
        let channels = chat_channels::Entity::find()
            .filter(chat_channels::Column::Id.is_in(memberships.iter().map(|(id, _)| id.as_str())))
            .filter(chat_channels::Column::Type.eq("dm"))
            .filter(chat_channels::Column::DeletedAt.is_null())
            .order_by_desc(chat_channels::Column::LastMessageAt)
            .all(&db)
            .await?;
        let mut rosters = Vec::with_capacity(channels.len());
        for channel in channels {
            let channel = js(channel)?;
            let id = channel["id"].as_str().unwrap_or_default().to_owned();
            let members = member_rows(&caller, &id, true).await?;
            rosters.push((channel, id, members));
        }
        // One account-picture lookup for every DM's members.
        let pictures = weldsuite_db::AccountPictures::load(
            caller.master(),
            rosters.iter().flat_map(|(_, _, members)| {
                weldsuite_db::account_pictures::user_ids(members, "userId")
            }),
        )
        .await;
        let mut result = Vec::with_capacity(rosters.len());
        for (channel, id, mut members) in rosters {
            pictures.apply_all(members.iter_mut(), "userId", "picture");
            let current = members
                .iter()
                .find(|m| m["userId"].as_str() == Some(caller.user_id.as_str()));
            let last_read_at = current.map_or(Value::Null, |m| m["lastReadAt"].clone());
            let last_read_message = current.map_or(Value::Null, |m| m["lastReadMessageId"].clone());
            let others: Vec<Value> = members
                .iter()
                .filter(|m| m["userId"].as_str() != Some(caller.user_id.as_str()))
                .cloned()
                .collect();
            let muted = memberships
                .iter()
                .find(|(c, _)| *c == id)
                .is_some_and(|(_, m)| *m);
            result.push(with_fields(
                Some(channel),
                vec![
                    ("members", Value::Array(members)),
                    ("otherMembers", Value::Array(others)),
                    ("isMuted", Value::Bool(muted)),
                    ("lastReadAt", last_read_at),
                    ("lastReadMessageId", last_read_message),
                ],
            ));
        }
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to fetch DM channels")
}

/// JavaScript's default string sort (by UTF-16 code unit).
fn sort_code_units(ids: &mut [String]) {
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// The existing DM with exactly `participants` (sorted), if any.
async fn existing_dm(caller: &Caller, participants: &[String]) -> Result<Option<String>, DbErr> {
    let db = orm(&caller.db);
    let mine: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::ChannelId)
        .filter(members::Column::UserId.eq(&caller.user_id))
        .into_tuple()
        .all(&db)
        .await?;
    if mine.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<String> = chat_channels::Entity::find()
        .select_only()
        .column(chat_channels::Column::Id)
        .filter(chat_channels::Column::Id.is_in(mine.iter().map(String::as_str)))
        .filter(chat_channels::Column::Type.eq("dm"))
        .filter(
            chat_channels::Column::MemberCount
                .eq(i32::try_from(participants.len()).unwrap_or(i32::MAX)),
        )
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    for candidate in candidates {
        let mut members: Vec<String> = members::Entity::find()
            .select_only()
            .column(members::Column::UserId)
            .filter(members::Column::ChannelId.eq(&candidate))
            .into_tuple()
            .all(&db)
            .await?;
        sort_code_units(&mut members);
        if members == participants {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// A new DM channel with `participants` as members.
async fn insert_dm(caller: &Caller, name: &str, participants: &[String]) -> Result<String, DbErr> {
    let id = generate_id("ch");
    let at = utc_now();
    let db = orm(&caller.db);
    chat_channels::Entity::insert(chat_channels::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.to_owned()),
        slug: Set(format!("dm-{id}")),
        type_: Set("dm".to_owned()),
        member_count: Set(i32::try_from(participants.len()).unwrap_or(i32::MAX)),
        created_by: Set(Some(caller.user_id.clone())),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    // One insert, the members in order.
    let rows = participants.iter().map(|user| members::ActiveModel {
        id: Set(generate_id("cmb")),
        channel_id: Set(id.clone()),
        user_id: Set(user.clone()),
        role: Set("member".to_owned()),
        joined_at: Set(at),
        created_at: Set(at),
        ..Default::default()
    });
    members::Entity::insert_many(rows)
        .exec_without_returning(&db)
        .await?;
    Ok(id)
}

/// `dm_new` to each recipient, then their notifications.
async fn notify_new_dm(
    caller: &Caller,
    state: &ChatState,
    org: &str,
    recipients: &[String],
    sender_name: &str,
    channel_id: &str,
) {
    let realtime = Caller::realtime(state);
    for recipient in recipients {
        realtime
            .chat_user(
                org,
                recipient,
                "dm_new",
                json!({ "channelId": channel_id, "senderName": sender_name, "preview": "" }),
            )
            .await;
    }
    let notifier = caller.notifier(state);
    for recipient in recipients {
        let params = notify::dm(org, recipient, &caller.user_id, sender_name, channel_id, "");
        if let Err(error) = create_and_deliver(&caller.db, &notifier, &params).await {
            tracing::error!(%error, "[app-api/chat-dm] DM notification failed");
        }
    }
}

/// User-id prefixes of an invitation's member row. The row is written before
/// the person has an account; accepting the invitation swaps the placeholder
/// for their real user id. Same list as `INVITE_PLACEHOLDER_USER_ID_PREFIXES`
/// in `@weldsuite/app-api-client/schemas/chat-dm`.
const INVITE_PLACEHOLDER_PREFIXES: [&str; 2] = ["invited_", "pending_clerk_"];

/// The ones in `user_ids` invited to the workspace but not accepted yet.
/// Nobody is messaged before they join: the invitee can't read the DM, and
/// accepting moves their member row to a new user id, which would leave the
/// DM with a placeholder nobody signs in as.
async fn pending_invitees(caller: &Caller, user_ids: &[String]) -> Result<Vec<String>, DbErr> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let pending: Vec<String> = workspace_members_among(user_ids)
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::Status.eq("PENDING"))
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    Ok(user_ids
        .iter()
        .filter(|id| {
            pending.contains(id)
                || INVITE_PLACEHOLDER_PREFIXES
                    .iter()
                    .any(|prefix| id.starts_with(prefix))
        })
        .cloned()
        .collect())
}

/// 409 for a DM with someone who hasn't accepted their invitation; clients
/// branch on `details.reason`.
fn invitation_pending(user_ids: &[String]) -> ChatError {
    ChatError::api(
        ApiError::conflict("Some people have not accepted their workspace invitation yet")
            .with_details(json!({ "reason": "invitation_pending", "userIds": user_ids })),
    )
}

async fn member_name(caller: &Caller, user_id: &str) -> Result<Option<String>, DbErr> {
    Ok(member_row_name(caller, user_id).await?.flatten())
}

/// `POST /`: the DM with these people, created when there is none.
async fn create_dm(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_ids = validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "userIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default()
    });
    let user_ids = match user_ids {
        Ok(ids) => ids,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let mut all: Vec<String> = vec![caller.user_id.clone()];
        for id in user_ids {
            if !all.contains(&id) {
                all.push(id);
            }
        }
        let others: Vec<String> = all
            .iter()
            .filter(|id| **id != caller.user_id)
            .cloned()
            .collect();
        if !others.is_empty() {
            let known: Vec<String> = workspace_members_among(&others)
                .column(workspace_members::Column::UserId)
                .into_tuple()
                .all(&orm(&caller.db))
                .await?;
            let unknown: Vec<&String> = others.iter().filter(|id| !known.contains(id)).collect();
            if !unknown.is_empty() {
                return Err(ChatError::api(
                    ApiError::bad_request("Some users are not members of this workspace")
                        .with_details(json!({ "userIds": unknown })),
                ));
            }
        }
        // Checked before the existing-DM lookup, so a DM made with an invitee
        // before this guard existed doesn't keep taking messages either.
        let pending = pending_invitees(&caller, &others).await?;
        if !pending.is_empty() {
            return Err(invitation_pending(&pending));
        }
        let mut sorted = all.clone();
        sort_code_units(&mut sorted);
        if let Some(existing) = existing_dm(&caller, &sorted).await? {
            let members = full_members(&caller, &existing, false).await?;
            let channel = channel_row(&caller.db, &existing).await?;
            return Ok(Data(with_fields(
                channel,
                vec![("members", Value::Array(members))],
            ))
            .into_response());
        }
        let names: Vec<Option<String>> = if others.is_empty() {
            Vec::new()
        } else {
            workspace_members_among(&others)
                .column(workspace_members::Column::Name)
                .into_tuple()
                .all(&orm(&caller.db))
                .await?
        };
        let joined = names
            .into_iter()
            .map(|n| n.unwrap_or_else(|| "Unknown".to_owned()))
            .collect::<Vec<_>>()
            .join(", ");
        let name = if joined.is_empty() {
            "Direct Message".to_owned()
        } else {
            joined
        };
        let id = insert_dm(&caller, &name, &all).await?;
        let channel = channel_row(&caller.db, &id).await?;
        let members = full_members(&caller, &id, false).await?;
        let sender = member_name(&caller, &caller.user_id)
            .await?
            .unwrap_or_else(|| "Someone".to_owned());
        notify_new_dm(&caller, &state, &org, &others, &sender, &id).await;
        Ok(Created(with_fields(
            channel,
            vec![("members", Value::Array(members))],
        ))
        .into_response())
    }
    .await;
    answer(result, "Failed to create DM")
}

/// `GET /:targetUserId`: the caller's 1:1 DM with someone, created on first use.
async fn resolve_dm(
    State(state): State<ChatState>,
    caller: Caller,
    Path(target): Path<String>,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let mut all: Vec<String> = vec![caller.user_id.clone()];
        if target != caller.user_id {
            // Before the existing-DM lookup, as in `POST /`.
            let pending = pending_invitees(&caller, std::slice::from_ref(&target)).await?;
            if !pending.is_empty() {
                return Err(invitation_pending(&pending));
            }
            all.push(target.clone());
        }
        sort_code_units(&mut all);
        let answer_for = |channel: Option<Value>, members: Vec<Value>, reads: bool| {
            let current = members
                .iter()
                .find(|m| m["userId"].as_str() == Some(caller.user_id.as_str()))
                .cloned();
            let others: Vec<Value> = members
                .iter()
                .filter(|m| m["userId"].as_str() != Some(caller.user_id.as_str()))
                .cloned()
                .collect();
            let mut fields = vec![
                ("members", Value::Array(members)),
                ("otherMembers", Value::Array(others)),
            ];
            if reads {
                fields.push((
                    "lastReadAt",
                    current
                        .as_ref()
                        .map_or(Value::Null, |m| m["lastReadAt"].clone()),
                ));
                fields.push((
                    "lastReadMessageId",
                    current
                        .as_ref()
                        .map_or(Value::Null, |m| m["lastReadMessageId"].clone()),
                ));
            }
            with_fields(channel, fields)
        };
        if let Some(existing) = existing_dm(&caller, &all).await? {
            let channel = channel_row(&caller.db, &existing).await?;
            let members = full_members(&caller, &existing, true).await?;
            return Ok(Data(answer_for(channel, members, true)).into_response());
        }
        let target_member = member_row_name(&caller, &target).await?;
        if target_member.is_none() && target != caller.user_id {
            return Err(ChatError::not_found("User", Some(&target)));
        }
        let name = target_member
            .flatten()
            .unwrap_or_else(|| "Direct Message".to_owned());
        let id = insert_dm(&caller, &name, &all).await?;
        let channel = channel_row(&caller.db, &id).await?;
        let members = full_members(&caller, &id, true).await?;
        if target != caller.user_id {
            let initiator = member_name(&caller, &caller.user_id)
                .await?
                .unwrap_or_else(|| "Someone".to_owned());
            notify_new_dm(
                &caller,
                &state,
                &org,
                std::slice::from_ref(&target),
                &initiator,
                &id,
            )
            .await;
        }
        Ok(Created(answer_for(channel, members, false)).into_response())
    }
    .await;
    answer(result, "Failed to resolve DM")
}

async fn has_membership(caller: &Caller, channel_id: &str) -> Result<bool, DbErr> {
    let row: Option<String> = members::Entity::find()
        .select_only()
        .column(members::Column::Id)
        .filter(members::Column::ChannelId.eq(channel_id))
        .filter(members::Column::UserId.eq(&caller.user_id))
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(row.is_some())
}

/// `setDmArchived`: the channel-level flag, for a member.
async fn set_archived(state: &ChatState, caller: &Caller, id: &str, archived: bool) -> Response {
    let fallback = if archived {
        "Failed to archive DM"
    } else {
        "Failed to unarchive DM"
    };
    let result = async {
        if !has_membership(caller, id).await? {
            return Err(ChatError::not_found("Channel", Some(id)));
        }
        chat_channels::Entity::update_many()
            .col_expr(chat_channels::Column::IsArchived, Expr::value(archived))
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(chat_channels::Column::Id.eq(id))
            .filter(chat_channels::Column::Type.eq("dm"))
            .exec(&orm(&caller.db))
            .await?;
        let event = if archived {
            CHAT_CHANNEL_ARCHIVED
        } else {
            CHAT_CHANNEL_UPDATED
        };
        caller.publish(state, event, id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id, "isArchived": archived })).into_response())
    }
    .await;
    answer(result, fallback)
}

async fn archive(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_archived(&state, &caller, &id, true).await
}

async fn unarchive(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_archived(&state, &caller, &id, false).await
}

/// `PATCH /:channelId/pin`: the caller's pin, in `metadata.pinnedBy`.
async fn pin(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let pinned = validate(&headers, &body, |issues, body| {
        issues
            .boolean(body, "isPinned", Presence::Required)
            .into_option()
            .unwrap_or_default()
    });
    let pinned = match pinned {
        Ok(pinned) => pinned,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let db = orm(&caller.db);
        let metadata: Option<Option<Value>> = chat_channels::Entity::find()
            .select_only()
            .column(chat_channels::Column::Metadata)
            .filter(chat_channels::Column::Id.eq(&id))
            .filter(chat_channels::Column::Type.eq("dm"))
            .into_tuple()
            .one(&db)
            .await?;
        let Some(metadata) = metadata else {
            return Err(ChatError::not_found("Channel", Some(&id)));
        };
        let mut meta = match metadata {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let mut pinned_by: Vec<String> = meta
            .get("pinnedBy")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if pinned {
            let mut unique: Vec<String> = Vec::new();
            for user in pinned_by
                .into_iter()
                .chain(std::iter::once(caller.user_id.clone()))
            {
                if !unique.contains(&user) {
                    unique.push(user);
                }
            }
            pinned_by = unique;
        } else {
            pinned_by.retain(|user| *user != caller.user_id);
        }
        meta.insert("pinnedBy".to_owned(), Value::from(pinned_by));
        chat_channels::Entity::update_many()
            .col_expr(
                chat_channels::Column::Metadata,
                Expr::value(Value::Object(meta)),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(chat_channels::Column::Id.eq(&id))
            .exec(&db)
            .await?;
        caller.publish(&state, CHAT_CHANNEL_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id, "isPinned": pinned })).into_response())
    }
    .await;
    answer(result, "Failed to pin DM")
}

/// `DELETE /:channelId`: the caller leaves the DM.
async fn leave_dm(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if !has_membership(&caller, &id).await? {
            return Err(ChatError::not_found("Channel", Some(&id)));
        }
        members::Entity::delete_many()
            .filter(members::Column::ChannelId.eq(&id))
            .filter(members::Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, CHAT_CHANNEL_LEFT, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete DM")
}
