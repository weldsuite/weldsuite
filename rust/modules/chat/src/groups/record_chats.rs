//! `/api/chat-entity-channels` (`routes/chat-entity-channels/index.ts`):
//! record chats (ADR CHAT-003): one chat per record, created on its first
//! message or follow, readable by whoever may see the record. CRM's
//! `/api/companies/:id/chat/*` and `/api/people/:id/chat/*` reach these
//! routes at the same paths (ADR API-012, CHAT-006).

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_CREATED, CHAT_CHANNEL_JOINED, CHAT_CHANNEL_LEFT, CHAT_CHANNEL_UPDATED,
};
use weldsuite_chat_domain::Can;
use weldsuite_chat_domain::agents::{agent_viewer_for, inaccessible_agent_ids};
use weldsuite_chat_domain::entity::{self, Provider, can_access_entity, can_post_in_record_chat};
use weldsuite_chat_domain::members::{AddMembers, add_channel_members, channel_row};
use weldsuite_chat_domain::text::{mention_bodies, slugify_channel_name};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, validate, validate_query};
use crate::followers::{
    add_followers, announce_new_followers, default_followers_who_may_open, remove_follower,
    set_followed_channels_muted,
};
use crate::post::{PostError, PostInput, post_chat_message};
use crate::util::{list_response, now};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/summary", get(summary).route_layer(read()))
        .route(
            "/{entity_type}/mute",
            patch(mute).route_layer(gate.require(["channels:update"])),
        )
        .route(
            "/{entity_type}/{entity_id}/channel",
            get(channel).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/comments",
            get(comments).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/messages",
            post(send).route_layer(gate.require(["messages:create"])),
        )
        .route(
            "/{entity_type}/{entity_id}/follow",
            post(follow).delete(unfollow).route_layer(read()),
        )
        .route(
            "/{entity_type}/{entity_id}/detail",
            get(detail).route_layer(read()),
        )
}

fn unknown_type(entity_type: &str) -> ChatError {
    ChatError::bad_request(format!("Unknown entity type: {entity_type}"))
}

/// `resolveAccess`: the provider, when the caller may see the record.
async fn resolve_access(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> ChatResult<Provider> {
    let Some(provider) = entity::provider(entity_type) else {
        return Err(unknown_type(entity_type));
    };
    let can = caller.context_can();
    if !can_access_entity(provider, &caller.db, &caller.user_id, entity_id, &can).await? {
        return Err(ChatError::forbidden(
            "You do not have access to this entity",
        ));
    }
    Ok(provider)
}

/// `findEntityChannel`: the live chat of a record.
async fn find_entity_channel(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from chat_channels c
         where c.entity_type = $1 and c.entity_id = $2 and c.deleted_at is null limit 1",
    )
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// A soft-deleted chat still holding the record's slot, latest first.
async fn find_deleted_channel(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from chat_channels
         where entity_type = $1 and entity_id = $2 and deleted_at is not null
         order by deleted_at desc limit 1",
    )
    .bind(entity_type)
    .bind(entity_id)
    .fetch_optional(&caller.db)
    .await
}

/// `slugify` of the record chat (`<name>-<id>`).
fn record_slug(name: &str, suffix: &str) -> String {
    let base = slugify_channel_name(name);
    let base: String = base.chars().take(200).collect();
    let base = if base.is_empty() {
        "entity".to_owned()
    } else {
        base
    };
    format!("{base}-{suffix}").chars().take(255).collect()
}

/// `initialFollowerIds`: the default members who may open the record, then the acting user.
async fn initial_followers(
    caller: &Caller,
    entity_type: &str,
    entity_id: &str,
    defaults: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let mut ids = default_followers_who_may_open(
        &caller.db,
        entity_type,
        entity_id,
        &caller.user_id,
        defaults,
    )
    .await?;
    ids.push(caller.user_id.clone());
    Ok(ids)
}

struct GetOrCreate {
    channel: Value,
    created: bool,
    new_followers: Vec<String>,
}

/// `getOrCreateEntityChannel`.
async fn get_or_create(
    caller: &Caller,
    provider: Provider,
    entity_id: &str,
) -> ChatResult<GetOrCreate> {
    let entity_type = provider.type_name();
    if let Some(channel) = find_entity_channel(caller, entity_type, entity_id).await? {
        return Ok(GetOrCreate {
            channel,
            created: false,
            new_followers: Vec::new(),
        });
    }
    // `throw new Error(`Entity … not found`)`: the route's 500.
    let Some(resolved) = provider
        .resolve(&caller.db, &caller.user_id, entity_id)
        .await?
    else {
        return Err(ChatError::Database(sqlx::Error::RowNotFound));
    };
    if let Some(deleted) = find_deleted_channel(caller, entity_type, entity_id).await? {
        let followers = add_followers(
            &caller.db,
            &deleted,
            &initial_followers(caller, entity_type, entity_id, &resolved.default_member_ids)
                .await?,
            Some(&caller.user_id),
        )
        .await?;
        sqlx::query(
            "update chat_channels set deleted_at = null, name = $2, entity_display_name = $2,
                icon = null, updated_at = $3::timestamp where id = $1",
        )
        .bind(&deleted)
        .bind(&resolved.display_name)
        .bind(now())
        .execute(&caller.db)
        .await?;
        return Ok(GetOrCreate {
            channel: channel_row(&caller.db, &deleted)
                .await?
                .unwrap_or(Value::Null),
            created: false,
            new_followers: followers,
        });
    }
    let id = generate_id("ch");
    let at = now();
    sqlx::query(
        "insert into chat_channels
            (id, name, slug, type, entity_type, entity_id, entity_display_name, icon, created_by,
             created_at, updated_at)
         values ($1, $2, $3, 'entity', $4, $5, $2, null, $6, $7::timestamp, $7::timestamp)",
    )
    .bind(&id)
    .bind(&resolved.display_name)
    .bind(record_slug(&resolved.display_name, &id))
    .bind(entity_type)
    .bind(entity_id)
    .bind(&caller.user_id)
    .bind(&at)
    .execute(&caller.db)
    .await?;
    let followers = add_followers(
        &caller.db,
        &id,
        &initial_followers(caller, entity_type, entity_id, &resolved.default_member_ids).await?,
        Some(&caller.user_id),
    )
    .await?;
    Ok(GetOrCreate {
        channel: channel_row(&caller.db, &id).await?.unwrap_or(Value::Null),
        created: true,
        new_followers: followers,
    })
}

/// `publishEntityEvent(chat_channel, action, { id, name, type })`.
fn publish_channel_event(
    state: &ChatState,
    caller: &Caller,
    event: weldsuite_catalogs::entity_events::EventName,
    channel: &Value,
) {
    let id = channel["id"].as_str().unwrap_or_default();
    caller.publish(
        state,
        event,
        id,
        &json!({ "id": id, "name": channel["name"], "type": channel["type"] }),
    );
}

/// The providers whose permission the caller holds.
async fn permitted(providers: Vec<Provider>, can: &Can<'_>) -> Result<Vec<Provider>, sqlx::Error> {
    let mut allowed = Vec::new();
    for provider in providers {
        if can.can(provider.required_permission()).await? {
            allowed.push(provider);
        }
    }
    Ok(allowed)
}

/// `keepVisible`: the rows whose record the caller may see.
async fn keep_visible(
    caller: &Caller,
    can: &Can<'_>,
    rows: Vec<Value>,
    providers: &[Provider],
) -> Result<Vec<Value>, sqlx::Error> {
    let mut by_type: Vec<(String, Vec<String>)> = Vec::new();
    for row in &rows {
        let (Some(kind), Some(id)) = (row["entityType"].as_str(), row["entityId"].as_str()) else {
            continue;
        };
        if kind.is_empty() || id.is_empty() {
            continue;
        }
        match by_type.iter_mut().find(|(k, _)| k == kind) {
            Some((_, ids)) => ids.push(id.to_owned()),
            None => by_type.push((kind.to_owned(), vec![id.to_owned()])),
        }
    }
    let mut visible: Vec<(String, HashSet<String>)> = Vec::new();
    for (kind, ids) in by_type {
        let set = match providers.iter().find(|p| p.type_name() == kind) {
            Some(provider) => {
                let unique = weldsuite_chat_domain::access::unique_ids(&ids);
                provider
                    .filter_visible(&caller.db, &caller.user_id, can, &unique)
                    .await?
            }
            None => HashSet::new(),
        };
        visible.push((kind, set));
    }
    Ok(rows
        .into_iter()
        .filter(|row| {
            let (Some(kind), Some(id)) = (row["entityType"].as_str(), row["entityId"].as_str())
            else {
                return false;
            };
            visible
                .iter()
                .find(|(k, _)| k == kind)
                .is_some_and(|(_, set)| set.contains(id))
        })
        .collect())
}

const FILTERS: [&str; 4] = ["following", "unread", "mentions", "all"];

struct ListQuery {
    kind: Option<String>,
    filter: String,
    search: Option<String>,
    cursor: Option<String>,
    limit: i64,
}

fn read_list(issues: &mut Issues, values: &Map<String, Value>) -> ListQuery {
    let kind = issues.string(values, "type", false, Some(1), Some(50));
    let filter = issues
        .choice(values, "filter", Presence::Optional, &FILTERS)
        .into_option()
        .unwrap_or_else(|| "following".to_owned());
    let search = issues
        .text_with(
            values,
            "search",
            Presence::Optional,
            Text::trimmed(None, Some(200)),
        )
        .into_option();
    let cursor = issues.string(values, "cursor", false, None, Some(30));
    let limit = issues
        .whole_number(
            values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or(25);
    ListQuery {
        kind,
        filter,
        search,
        cursor,
        limit,
    }
}

/// `escapeLike`.
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `GET /`: record chats, most recent activity first.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_list) {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let mut providers: Vec<Provider> = entity::record_chat_providers().collect();
    if let Some(kind) = query.kind.as_deref().filter(|k| !k.is_empty()) {
        match entity::provider(kind) {
            Some(provider) if !provider.legacy() => providers = vec![provider],
            _ => return unknown_type(kind).respond(""),
        }
    }
    let result = async {
        let can = caller.context_can();
        let providers = permitted(providers, &can).await?;
        if providers.is_empty() {
            return Ok(list_response(Vec::new(), 0, false, None));
        }
        let types: Vec<String> = providers.iter().map(|p| p.type_name().to_owned()).collect();
        let filter = query.filter.as_str();
        let search = query
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", escape_like(s)));
        let limit = query.limit;
        let mut page: Vec<Value> = Vec::new();
        let mut after = query.cursor.clone().filter(|c| !c.is_empty());
        let mut exhausted = false;
        for _ in 0..5 {
            if i64::try_from(page.len()).unwrap_or(i64::MAX) > limit {
                break;
            }
            let batch: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(t) from chat_channels t
                 where t.type = 'entity' and t.deleted_at is null and t.entity_type = any($1)
                   and ($2 = 'all' or exists (select 1 from chat_channel_members m
                        where m.channel_id = t.id and m.user_id = $3
                          and ($2 <> 'unread' or (m.is_muted = false and t.last_message_at is not null
                               and (m.last_read_at is null or t.last_message_at > m.last_read_at)))
                          and ($2 <> 'mentions' or m.unread_mention_count > 0)))
                   and ($4::text is null or coalesce(t.entity_display_name, t.name) ilike $4)
                   and ($5::text is null or (coalesce(t.last_message_at, t.created_at), t.id) <
                        (select coalesce(c2.last_message_at, c2.created_at), c2.id
                         from chat_channels c2 where c2.id = $5))
                 order by coalesce(t.last_message_at, t.created_at) desc, t.id desc
                 limit $6",
            )
            .bind(&types)
            .bind(filter)
            .bind(&caller.user_id)
            .bind(&search)
            .bind(&after)
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
            let batch: Vec<Value> = batch.into_iter().map(weldsuite_db::js_row).collect();
            let full = i64::try_from(batch.len()).unwrap_or(i64::MAX) > limit;
            let last = batch.last().and_then(|r| r["id"].as_str().map(str::to_owned));
            page.extend(keep_visible(&caller, &can, batch, &providers).await?);
            if !full {
                exhausted = true;
                break;
            }
            after = last;
        }
        let limit_len = usize::try_from(limit.max(0)).unwrap_or(0);
        let (items, has_more, cursor) = if page.len() > limit_len {
            page.truncate(limit_len);
            let cursor = page.last().and_then(|r| r["id"].as_str().map(str::to_owned));
            (page, true, cursor)
        } else if exhausted {
            (page, false, None)
        } else {
            (page, true, after)
        };
        let total: i32 = sqlx::query_scalar(
            "select count(*)::int from chat_channels t
             where t.type = 'entity' and t.deleted_at is null and t.entity_type = any($1)
               and ($2 = 'all' or exists (select 1 from chat_channel_members m
                    where m.channel_id = t.id and m.user_id = $3
                      and ($2 <> 'unread' or (m.is_muted = false and t.last_message_at is not null
                           and (m.last_read_at is null or t.last_message_at > m.last_read_at)))
                      and ($2 <> 'mentions' or m.unread_mention_count > 0)))
               and ($4::text is null or coalesce(t.entity_display_name, t.name) ilike $4)",
        )
        .bind(&types)
        .bind(filter)
        .bind(&caller.user_id)
        .bind(&search)
        .fetch_one(&caller.db)
        .await?;
        let ids: Vec<String> = items
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect();
        let states = caller_state(&caller, &ids).await?;
        let items: Vec<Value> = items
            .into_iter()
            .map(|row| {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                let mut fields = match row {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                let state = states.iter().find(|(c, _)| *c == id).map_or_else(
                    || {
                        json!({ "isFollowing": false, "isMuted": false, "lastReadAt": null,
                                "lastReadMessageId": null, "unreadMentionCount": 0 })
                    },
                    |(_, s)| s.clone(),
                );
                if let Value::Object(extra) = state {
                    fields.extend(extra);
                }
                Value::Object(fields)
            })
            .collect();
        Ok(list_response(items, i64::from(total), has_more, cursor))
    }
    .await;
    answer(result, "Failed to list entity channels")
}

/// `callerState`: following, mute, read cursor and mentions per channel.
async fn caller_state(
    caller: &Caller,
    ids: &[String],
) -> Result<Vec<(String, Value)>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, bool, Option<String>, Option<String>, i32)> = sqlx::query_as(
        "select channel_id, is_muted, to_jsonb(last_read_at) #>> '{}', last_read_message_id,
                unread_mention_count
         from chat_channel_members where user_id = $1 and channel_id = any($2)",
    )
    .bind(&caller.user_id)
    .bind(ids)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(channel, muted, read_at, read_id, mentions)| {
            (
                channel,
                json!({
                    "isFollowing": true,
                    "isMuted": muted,
                    "lastReadAt": read_at.map(|at| crate::util::ms_timestamp(&at)),
                    "lastReadMessageId": read_id,
                    "unreadMentionCount": mentions,
                }),
            )
        })
        .collect())
}

/// `GET /summary`: per type, followed chats, unread and mentions.
async fn summary(caller: Caller) -> Response {
    let result = async {
        let can = caller.context_can();
        let providers = permitted(entity::record_chat_providers().collect(), &can).await?;
        if providers.is_empty() {
            return Ok(Data(Vec::<Value>::new()).into_response());
        }
        let types: Vec<String> = providers.iter().map(|p| p.type_name().to_owned()).collect();
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('entityType', t.entity_type, 'entityId', t.entity_id,
                    'unread', (not m.is_muted and t.last_message_at is not null
                        and (m.last_read_at is null
                             or date_trunc('milliseconds', t.last_message_at)
                                > date_trunc('milliseconds', m.last_read_at))),
                    'unreadMentionCount', m.unread_mention_count)
             from chat_channels t
             inner join chat_channel_members m on m.channel_id = t.id and m.user_id = $1
             where t.type = 'entity' and t.deleted_at is null and t.entity_type = any($2)",
        )
        .bind(&caller.user_id)
        .bind(&types)
        .fetch_all(&caller.db)
        .await?;
        let visible = keep_visible(&caller, &can, rows, &providers).await?;
        let summary: Vec<Value> = providers
            .iter()
            .map(|provider| {
                let of_type: Vec<&Value> = visible
                    .iter()
                    .filter(|row| row["entityType"].as_str() == Some(provider.type_name()))
                    .collect();
                let unread = of_type.iter().filter(|row| row["unread"] == true).count();
                let mentions: i64 = of_type
                    .iter()
                    .map(|row| row["unreadMentionCount"].as_i64().unwrap_or(0))
                    .sum();
                json!({
                    "type": provider.type_name(),
                    "label": provider.label(),
                    "followed": of_type.len(),
                    "unread": unread,
                    "mentions": mentions,
                })
            })
            .collect();
        Ok(Data(summary).into_response())
    }
    .await;
    answer(result, "Failed to summarise entity channels")
}

/// `PATCH /:entityType/mute`: mute or unmute every followed chat of a type.
async fn mute(
    State(state): State<ChatState>,
    caller: Caller,
    Path(entity_type): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(provider) = entity::provider(&entity_type).filter(|p| !p.legacy()) else {
        return unknown_type(&entity_type).respond("");
    };
    if !caller.can(provider.required_permission()) {
        return ChatError::forbidden("You do not have access to this record type").respond("");
    }
    let muted = validate(&headers, &body, |issues, body| {
        issues
            .boolean(body, "isMuted", Presence::Required)
            .into_option()
            .unwrap_or_default()
    });
    let muted = match muted {
        Ok(muted) => muted,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let ids =
            set_followed_channels_muted(&caller.db, &caller.user_id, provider.type_name(), muted)
                .await?;
        for id in &ids {
            caller.publish(&state, CHAT_CHANNEL_UPDATED, id, &json!({ "id": id }));
        }
        Ok(Data(json!({ "updated": ids.len() })).into_response())
    }
    .await;
    answer(result, "Failed to update record chats")
}

/// `GET /:entityType/:entityId/channel`: the chat, or `null` before its first message.
async fn channel(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let channel = find_entity_channel(&caller, provider.type_name(), &entity_id).await?;
        Ok(Data(channel.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to fetch entity channel")
}

/// `GET /:entityType/:entityId/comments`: the comment threads (messages with
/// `metadata.anchor`), oldest first, then their replies.
async fn comments(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let channel = find_entity_channel(&caller, provider.type_name(), &entity_id).await?;
        let mut messages: Vec<Value> = Vec::new();
        if let Some(channel_id) = channel.as_ref().and_then(|c| c["id"].as_str()) {
            let mut threads: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(m) from chat_messages m
                 where m.channel_id = $1 and m.deleted_at is null and m.parent_id is null
                   and (m.metadata -> 'anchor') is not null
                 order by m.created_at desc limit 500",
            )
            .bind(channel_id)
            .fetch_all(&caller.db)
            .await?;
            if !threads.is_empty() {
                threads.reverse();
                let ids: Vec<String> = threads
                    .iter()
                    .filter_map(|t| t["id"].as_str().map(str::to_owned))
                    .collect();
                let mut replies: Vec<Value> = sqlx::query_scalar(
                    "select to_jsonb(m) from chat_messages m
                     where m.channel_id = $1 and m.deleted_at is null and m.parent_id = any($2)
                     order by m.created_at desc limit 2000",
                )
                .bind(channel_id)
                .bind(&ids)
                .fetch_all(&caller.db)
                .await?;
                replies.reverse();
                messages = threads
                    .into_iter()
                    .chain(replies)
                    .map(weldsuite_db::js_row)
                    .collect();
            }
        }
        Ok(Data(json!({ "channel": channel, "messages": messages })).into_response())
    }
    .await;
    answer(result, "Failed to fetch comments")
}

fn read_send(issues: &mut Issues, body: &Map<String, Value>) -> PostInput {
    let content = issues
        .string(body, "content", true, Some(1), None)
        .unwrap_or_default();
    let html_content = issues.string(body, "htmlContent", false, None, None);
    let parent_id = issues
        .text(body, "parentId", Presence::Nullish, None, None)
        .into_option();
    let mentions = issues
        .list(
            body,
            "mentions",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option();
    let _ = issues.boolean(body, "mentionsEveryone", Presence::Optional);
    let attachments = issues
        .records(body, "attachments", Presence::Optional)
        .into_option();
    let metadata = match issues.nested(body, "metadata", Presence::Optional, |_, fields| {
        fields.clone()
    }) {
        Field::Set(fields) => Some(Value::Object(fields)),
        _ => None,
    };
    PostInput {
        content,
        html_content,
        parent_id,
        attachments,
        mentions,
        metadata,
        reply_to_id: None,
        reply_mention: None,
    }
}

/// `extractChatMentions(content, extra)`: user and agent ids.
fn extract_chat_mentions(content: &str, extra: &[String]) -> Vec<String> {
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
    let mut found: Vec<String> = extra.to_vec();
    for body in mention_bodies(content) {
        let (id, had_colon) = body
            .split_once(':')
            .map_or((body.as_str(), false), |(id, _)| (id, true));
        if !id.is_empty()
            && id != "everyone"
            && !id.starts_with("entity:")
            && (!had_colon || !SEARCH_ENTITY_TYPES.contains(&id))
            && !found.iter().any(|f| f == id)
        {
            found.push(id.to_owned());
        }
    }
    found
}

/// `addMentionedAgents`: agents tagged in a record chat join it.
async fn add_mentioned_agents(
    caller: &Caller,
    state: &ChatState,
    channel_id: &str,
    input: &PostInput,
) -> ChatResult<()> {
    if !caller.can("weldagent:use") {
        return Ok(());
    }
    let mentioned: Vec<String> = extract_chat_mentions(
        &input.content,
        input.mentions.as_deref().unwrap_or_default(),
    )
    .into_iter()
    .filter(|id| id.starts_with("agt_"))
    .collect();
    if mentioned.is_empty() {
        return Ok(());
    }
    let existing: Vec<String> = sqlx::query_scalar(
        "select user_id from chat_channel_members where channel_id = $1 and member_type = 'agent'",
    )
    .bind(channel_id)
    .fetch_all(&caller.db)
    .await?;
    let candidates: Vec<String> = mentioned
        .into_iter()
        .filter(|id| !existing.contains(id))
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let viewer = agent_viewer_for(
        &caller.user_id,
        caller
            .permissions
            .as_ref()
            .map(weldsuite_permissions::Permissions::resolved),
    );
    let blocked = inaccessible_agent_ids(&caller.db, &candidates, &viewer).await?;
    let allowed: Vec<String> = candidates
        .into_iter()
        .filter(|id| !blocked.contains(id))
        .collect();
    if allowed.is_empty() {
        return Ok(());
    }
    if let AddMembers::Added { added_user_ids } =
        add_channel_members(&caller.db, channel_id, &allowed, "agent", &now()).await?
    {
        let realtime = Caller::realtime(state);
        for agent in added_user_ids {
            realtime.member(channel_id, &agent, "joined").await;
        }
    }
    Ok(())
}

/// `POST /:entityType/:entityId/messages`: post in the record's chat,
/// creating it on the first message.
async fn send(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_send) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let mut channel_id: Option<String> = None;
    let result: ChatResult<Response> = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let can = caller.context_can();
        if !can_post_in_record_chat(provider, &caller.db, &caller.user_id, &entity_id, &can).await?
        {
            return Err(ChatError::forbidden(
                "You may read this chat but not write in it",
            ));
        }
        let got = get_or_create(&caller, provider, &entity_id).await?;
        let id = got.channel["id"].as_str().unwrap_or_default().to_owned();
        channel_id = Some(id.clone());
        add_mentioned_agents(&caller, &state, &id, &input).await?;
        let message = match post_chat_message(&caller, &state, &org, &id, input).await {
            Ok(message) => message,
            Err(PostError::Feature(404, _)) => {
                return Err(ChatError::not_found("Channel", channel_id.as_deref()));
            }
            Err(PostError::Feature(403, message)) => return Err(ChatError::forbidden(message)),
            Err(PostError::Feature(_, message)) => return Err(ChatError::bad_request(message)),
            Err(PostError::Database(error)) => return Err(ChatError::Database(error)),
        };
        let name = got.channel["name"].as_str().unwrap_or_default().to_owned();
        announce_new_followers(
            &Caller::realtime(&state),
            &org,
            &id,
            &name,
            &got.new_followers,
        )
        .await;
        if got.created {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_CREATED, &got.channel);
        }
        Ok(Created(
            json!({ "channel": got.channel, "message": message, "createdChannel": got.created }),
        )
        .into_response())
    }
    .await;
    answer(result, "Failed to post entity message")
}

/// `POST /:entityType/:entityId/follow`.
async fn follow(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let got = get_or_create(&caller, provider, &entity_id).await?;
        let id = got.channel["id"].as_str().unwrap_or_default().to_owned();
        let added =
            add_followers(&caller.db, &id, std::slice::from_ref(&caller.user_id), None).await?;
        let mut announced: Vec<String> = Vec::new();
        for user in got.new_followers.iter().chain(added.iter()) {
            if !announced.contains(user) {
                announced.push(user.clone());
            }
        }
        let name = got.channel["name"].as_str().unwrap_or_default().to_owned();
        announce_new_followers(&Caller::realtime(&state), &org, &id, &name, &announced).await;
        if got.created {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_CREATED, &got.channel);
        }
        if got.created || !added.is_empty() {
            publish_channel_event(&state, &caller, CHAT_CHANNEL_JOINED, &got.channel);
        }
        Ok(Data(
            json!({ "channel": got.channel, "following": true, "createdChannel": got.created }),
        )
        .into_response())
    }
    .await;
    answer(result, "Failed to follow entity channel")
}

/// `DELETE /:entityType/:entityId/follow`.
async fn unfollow(
    State(state): State<ChatState>,
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    if entity::provider(&entity_type).is_none() {
        return unknown_type(&entity_type).respond("");
    }
    let result = async {
        if let Some(channel) = find_entity_channel(&caller, &entity_type, &entity_id).await? {
            let id = channel["id"].as_str().unwrap_or_default().to_owned();
            if remove_follower(&caller.db, &id, &caller.user_id).await? {
                Caller::realtime(&state)
                    .member(&id, &caller.user_id, "left")
                    .await;
                publish_channel_event(&state, &caller, CHAT_CHANNEL_LEFT, &channel);
            }
        }
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to unfollow entity channel")
}

/// `GET /:entityType/:entityId/detail`: the record panel.
async fn detail(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    if let Some(provider) = entity::provider(&entity_type)
        && matches!(provider, Provider::Company | Provider::Person)
    {
        return ChatError::bad_request(format!(
            "Provider {} does not expose detail data",
            provider.type_name()
        ))
        .respond("");
    }
    let result = async {
        let provider = resolve_access(&caller, &entity_type, &entity_id).await?;
        let detail = provider.resolve_detail(&caller.db, &entity_id).await?;
        Ok(Data(detail.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to fetch entity detail")
}
