//! `/api/chat-dm` (`routes/chat-dm/index.ts`): direct messages. A DM is a
//! `type = 'dm'` channel whose members are exactly its participants; asking
//! for one with the same people answers the existing channel.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_ARCHIVED, CHAT_CHANNEL_LEFT, CHAT_CHANNEL_UPDATED,
};
use weldsuite_chat_domain::members::channel_row;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_notifications::{chat as notify, create_and_deliver};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, answer, validate};
use crate::util::now;

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

/// The members of a DM with their names (`fullMembers`); `with_reads` adds
/// role and read cursor.
async fn full_members(
    caller: &Caller,
    channel_id: &str,
    with_reads: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = if with_reads {
        sqlx::query_scalar(
            "select jsonb_build_object('userId', chat_channel_members.user_id,
                    'role', chat_channel_members.role,
                    'lastReadAt', chat_channel_members.last_read_at,
                    'lastReadMessageId', chat_channel_members.last_read_message_id,
                    'name', workspace_members.name, 'email', workspace_members.email,
                    'picture', workspace_members.picture)
             from chat_channel_members
             left join workspace_members on chat_channel_members.user_id = workspace_members.user_id
             where chat_channel_members.channel_id = $1",
        )
        .bind(channel_id)
        .fetch_all(&caller.db)
        .await?
    } else {
        sqlx::query_scalar(
            "select jsonb_build_object('userId', chat_channel_members.user_id,
                    'name', workspace_members.name, 'email', workspace_members.email,
                    'picture', workspace_members.picture)
             from chat_channel_members
             left join workspace_members on chat_channel_members.user_id = workspace_members.user_id
             where chat_channel_members.channel_id = $1",
        )
        .bind(channel_id)
        .fetch_all(&caller.db)
        .await?
    };
    Ok(rows.into_iter().map(weldsuite_db::js_row).collect())
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
        let memberships: Vec<(String, bool)> = sqlx::query_as(
            "select channel_id, is_muted from chat_channel_members where user_id = $1",
        )
        .bind(&caller.user_id)
        .fetch_all(&caller.db)
        .await?;
        if memberships.is_empty() {
            return Ok(Data(Vec::<Value>::new()).into_response());
        }
        let ids: Vec<String> = memberships.iter().map(|(id, _)| id.clone()).collect();
        let channels: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(c) from chat_channels c
             where c.id = any($1) and c.type = 'dm' and c.deleted_at is null
             order by c.last_message_at desc",
        )
        .bind(&ids)
        .fetch_all(&caller.db)
        .await?;
        let mut result = Vec::with_capacity(channels.len());
        for channel in channels.into_iter().map(weldsuite_db::js_row) {
            let id = channel["id"].as_str().unwrap_or_default().to_owned();
            let members = full_members(&caller, &id, true).await?;
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
async fn existing_dm(
    caller: &Caller,
    participants: &[String],
) -> Result<Option<String>, sqlx::Error> {
    let mine: Vec<String> =
        sqlx::query_scalar("select channel_id from chat_channel_members where user_id = $1")
            .bind(&caller.user_id)
            .fetch_all(&caller.db)
            .await?;
    if mine.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<String> = sqlx::query_scalar(
        "select id from chat_channels
         where id = any($1) and type = 'dm' and member_count = $2 and deleted_at is null",
    )
    .bind(&mine)
    .bind(i32::try_from(participants.len()).unwrap_or(i32::MAX))
    .fetch_all(&caller.db)
    .await?;
    for candidate in candidates {
        let mut members: Vec<String> =
            sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
                .bind(&candidate)
                .fetch_all(&caller.db)
                .await?;
        sort_code_units(&mut members);
        if members == participants {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// A new DM channel with `participants` as members.
async fn insert_dm(
    caller: &Caller,
    name: &str,
    participants: &[String],
) -> Result<String, sqlx::Error> {
    let id = generate_id("ch");
    let at = now();
    sqlx::query(
        "insert into chat_channels (id, name, slug, type, member_count, created_by, created_at, updated_at)
         values ($1, $2, $3, 'dm', $4, $5, $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(name)
    .bind(format!("dm-{id}"))
    .bind(i32::try_from(participants.len()).unwrap_or(i32::MAX))
    .bind(&caller.user_id)
    .bind(&at)
    .execute(&caller.db)
    .await?;
    let ids: Vec<String> = participants.iter().map(|_| generate_id("cmb")).collect();
    sqlx::query(
        "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
         select m.id, $2, m.user_id, 'member', $4::timestamp, $4::timestamp
         from unnest($1::varchar[], $3::varchar[]) with ordinality as m(id, user_id, n)
         order by m.n",
    )
    .bind(&ids)
    .bind(&id)
    .bind(participants)
    .bind(&at)
    .execute(&caller.db)
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

async fn member_name(caller: &Caller, user_id: &str) -> Result<Option<String>, sqlx::Error> {
    let name: Option<Option<String>> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(name.flatten())
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
            let known: Vec<String> =
                sqlx::query_scalar("select user_id from workspace_members where user_id = any($1)")
                    .bind(&others)
                    .fetch_all(&caller.db)
                    .await?;
            let unknown: Vec<&String> = others.iter().filter(|id| !known.contains(id)).collect();
            if !unknown.is_empty() {
                return Err(ChatError::api(
                    ApiError::bad_request("Some users are not members of this workspace")
                        .with_details(json!({ "userIds": unknown })),
                ));
            }
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
            sqlx::query_scalar("select name from workspace_members where user_id = any($1)")
                .bind(&others)
                .fetch_all(&caller.db)
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
        let target_member: Option<Option<String>> =
            sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
                .bind(&target)
                .fetch_optional(&caller.db)
                .await?;
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

async fn has_membership(caller: &Caller, channel_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<String> = sqlx::query_scalar(
        "select id from chat_channel_members where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(channel_id)
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
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
        sqlx::query(
            "update chat_channels set is_archived = $2, updated_at = $3::timestamp where id = $1 and type = 'dm'",
        )
        .bind(id)
        .bind(archived)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let event = if archived { CHAT_CHANNEL_ARCHIVED } else { CHAT_CHANNEL_UPDATED };
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
        let metadata: Option<Option<Value>> = sqlx::query_scalar(
            "select metadata from chat_channels where id = $1 and type = 'dm' limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
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
        sqlx::query(
            "update chat_channels set metadata = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(Value::Object(meta))
        .bind(now())
        .execute(&caller.db)
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
        sqlx::query("delete from chat_channel_members where channel_id = $1 and user_id = $2")
            .bind(&id)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, CHAT_CHANNEL_LEFT, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete DM")
}
