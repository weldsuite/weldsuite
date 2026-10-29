//! `/api/channels` (`routes/channels/index.ts`): channels the caller can
//! see, their messages, members and agents, read state and forwarding.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_CREATED, CHAT_CHANNEL_JOINED, CHAT_CHANNEL_LEFT, CHAT_CHANNEL_UPDATED,
    CHAT_MESSAGE_CREATED,
};
use weldsuite_chat_domain::agents::{agent_viewer_for, inaccessible_agent_ids};
use weldsuite_chat_domain::entity::{self, can_post_in_record_chat};
use weldsuite_chat_domain::members::{
    AddMembers, NewChannel, add_channel_members, channel_row, create_channel, get_membership,
    join_public_channel, remove_channel_member_by_user_id, resolve_channel_slug,
};
use weldsuite_chat_domain::policy::merge_agent_room_policy;
use weldsuite_chat_domain::publish::object;
use weldsuite_chat_domain::text::build_message_preview;
use weldsuite_chat_domain::{can_access_channel, is_channel_moderator, unreadable_record_chat_ids};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, unhandled, validate, validate_query};
use crate::post::{PostError, PostInput, post_chat_message};
use crate::util::{
    consume_rate_limit, list_limit, list_response, ms_timestamp, now, page, query_map,
};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    let create = || gate.require(["channels:create"]);
    let update = || gate.require(["channels:update"]);
    let remove = || gate.require(["channels:delete"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_one).route_layer(create()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_one).route_layer(update()))
        .route("/{id}", delete(remove_one).route_layer(remove()))
        .route("/{id}/messages", get(list_messages).route_layer(read()))
        .route("/{id}/messages", post(send_message).route_layer(create()))
        .route("/{id}/members", get(members).route_layer(read()))
        .route("/{id}/members", post(add_members).route_layer(update()))
        .route(
            "/{id}/agents",
            post(invite_agents).route_layer(gate.require(["weldagent:use"])),
        )
        .route(
            "/{id}/agents/{agent_id}",
            delete(remove_agent).route_layer(gate.require(["weldagent:use"])),
        )
        .route("/{id}/members/join", post(join).route_layer(read()))
        .route("/{id}/members/leave", post(leave).route_layer(read()))
        .route(
            "/{id}/members/{user_id}",
            delete(remove_member).route_layer(update()),
        )
        .route(
            "/{id}/read-receipts",
            get(read_receipts).route_layer(read()),
        )
        .route(
            "/{id}/messages/{message_id}/forward",
            post(forward).route_layer(gate.require(["messages:create"])),
        )
        .route("/{id}/read", post(mark_read).route_layer(read()))
        .route("/{id}/me", patch(update_me).route_layer(update()))
}

const CHANNEL_TYPES: [&str; 4] = ["public", "private", "dm", "entity"];

fn forbidden_channel() -> ChatError {
    ChatError::forbidden("You do not have access to this channel")
}

/// `channelNameTaken`: a live public channel, or a live private one the
/// caller is in, already named `name` (case-insensitive, trimmed).
async fn channel_name_taken(
    caller: &Caller,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let clash: Option<String> = sqlx::query_scalar(
        "select id from chat_channels t
         where t.deleted_at is null and lower(btrim(t.name)) = lower($1)
           and (t.type = 'public' or (t.type = 'private' and exists (
                select 1 from chat_channel_members m where m.channel_id = t.id and m.user_id = $2)))
           and ($3::text is null or t.id <> $3)
         limit 1",
    )
    .bind(name)
    .bind(&caller.user_id)
    .bind(exclude_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(clash.is_some())
}

/// `parseTypesFilter`: the distinct names in `?types=`, or `None`.
fn parse_types_filter(raw: Option<&String>) -> Option<Vec<String>> {
    let mut types: Vec<String> = Vec::new();
    for part in raw.map(String::as_str).unwrap_or_default().split(',') {
        let part = weldsuite_chat_domain::text::js_trim(part);
        if !part.is_empty() && !types.iter().any(|t| t == part) {
            types.push(part.to_owned());
        }
    }
    (!types.is_empty()).then_some(types)
}

/// `GET /`: channels the caller can see, newest first.
async fn list(State(state): State<ChatState>, caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let types = parse_types_filter(q.get("types"));
    if let Some(unknown) = types
        .iter()
        .flatten()
        .find(|t| !CHANNEL_TYPES.contains(&t.as_str()))
    {
        return ApiError::bad_request(format!("Unknown channel type: {unknown}")).into_response();
    }
    let _ = &state;
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => match channel_cursor(&caller, cursor).await {
            Ok(cursor) => cursor,
            Err(error) => return unhandled(error.into()),
        },
        None => None,
    };
    answer(
        list_inner(&caller, &q, limit, types, cursor).await,
        "Failed to list channels",
    )
}

async fn channel_cursor(
    caller: &Caller,
    id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, String)> =
        sqlx::query_as("select created_at::text, id from chat_channels where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(|(at, id)| (ms_timestamp(&at), id)))
}

async fn list_inner(
    caller: &Caller,
    q: &HashMap<String, String>,
    limit: i64,
    types: Option<Vec<String>>,
    cursor: Option<(String, String)>,
) -> ChatResult<Response> {
    let kind = q.get("type").filter(|t| !t.is_empty());
    let search = q
        .get("search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_channels t
         where t.deleted_at is null
           and (t.type = 'public' or exists (
                select 1 from chat_channel_members m where m.channel_id = t.id and m.user_id = $1))
           and ($2::text is null or t.type = $2)
           and ($3::text[] is null or t.type = any($3))
           and ($4::text is null or t.name like $4)
           and ($5::text is null or (t.created_at < $5::timestamp
                or (t.created_at = $5::timestamp and t.id < $6)))
         order by t.created_at desc, t.id desc
         limit $7",
    )
    .bind(&caller.user_id)
    .bind(kind)
    .bind(&types)
    .bind(&search)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from chat_channels t
         where t.deleted_at is null
           and (t.type = 'public' or exists (
                select 1 from chat_channel_members m where m.channel_id = t.id and m.user_id = $1))
           and ($2::text is null or t.type = $2)
           and ($3::text[] is null or t.type = any($3))
           and ($4::text is null or t.name like $4)",
    )
    .bind(&caller.user_id)
    .bind(kind)
    .bind(&types)
    .bind(&search)
    .fetch_one(&caller.db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    let (data, has_more, next) = page(rows, limit);
    let entity_ids: Vec<String> = data
        .iter()
        .filter(|r| r["type"] == "entity")
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let can = caller.context_can();
    let unreadable =
        unreadable_record_chat_ids(&caller.db, &caller.user_id, &entity_ids, Some(&can)).await?;
    let visible: Vec<Value> = data
        .into_iter()
        .filter(|r| !r["id"].as_str().is_some_and(|id| unreadable.contains(id)))
        .collect();
    let ids: Vec<String> = visible
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let state = caller_channel_state(caller, &ids).await?;
    let items: Vec<Value> = visible
        .into_iter()
        .map(|row| {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let mut fields = match row {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            let membership = state.get(&id).cloned().unwrap_or_else(|| {
                json!({ "isMuted": false, "lastReadAt": null, "lastReadMessageId": null, "unreadMentionCount": 0 })
            });
            if let Value::Object(extra) = membership {
                fields.extend(extra);
            }
            Value::Object(fields)
        })
        .collect();
    Ok(list_response(items, total, has_more, next))
}

/// `callerChannelState`: the caller's mute flag and read cursor per channel.
async fn caller_channel_state(
    caller: &Caller,
    channel_ids: &[String],
) -> Result<HashMap<String, Value>, sqlx::Error> {
    if channel_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, bool, Option<String>, Option<String>, i32)> = sqlx::query_as(
        "select channel_id, is_muted, last_read_at::text, last_read_message_id, unread_mention_count
         from chat_channel_members where user_id = $1 and channel_id = any($2)",
    )
    .bind(&caller.user_id)
    .bind(channel_ids)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(channel_id, muted, read_at, read_id, mentions)| {
            (
                channel_id,
                json!({
                    "isMuted": muted,
                    "lastReadAt": read_at.map(|at| ms_timestamp(&at)),
                    "lastReadMessageId": read_id,
                    "unreadMentionCount": mentions,
                }),
            )
        })
        .collect())
}

/// A live channel row.
async fn live_channel(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_channels t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `GET /:id`: the channel with its hydrated roster.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(detail_inner(&caller, &id).await, "Failed to fetch channel")
}

async fn detail_inner(caller: &Caller, id: &str) -> ChatResult<Response> {
    let Some(row) = live_channel(caller, id).await? else {
        return Err(ChatError::not_found("Channel", Some(id)));
    };
    if !can_access_channel(&caller.db, id, &caller.user_id, None).await? {
        return Err(ChatError::not_found("Channel", Some(id)));
    }
    let members: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', chat_channel_members.id,
                'userId', chat_channel_members.user_id, 'role', chat_channel_members.role,
                'joinedAt', chat_channel_members.joined_at, 'isMuted', chat_channel_members.is_muted,
                'notificationPreference', chat_channel_members.notification_preference,
                'name', workspace_members.name, 'email', workspace_members.email,
                'picture', workspace_members.picture)
         from chat_channel_members
         left join workspace_members on chat_channel_members.user_id = workspace_members.user_id
         where chat_channel_members.channel_id = $1",
    )
    .bind(id)
    .fetch_all(&caller.db)
    .await?;
    let members: Vec<Value> = members.into_iter().map(weldsuite_db::js_row).collect();
    let is_muted = members
        .iter()
        .find(|m| m["userId"].as_str() == Some(caller.user_id.as_str()))
        .is_some_and(|m| m["isMuted"] == true);
    let mut fields = match row {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    fields.insert("isMuted".to_owned(), Value::Bool(is_muted));
    fields.insert("members".to_owned(), Value::Array(members));
    Ok(Data(Value::Object(fields)).into_response())
}

const POLICIES: [&str; 3] = ["mentions", "always", "none"];

struct CreateBody {
    channel: NewChannel,
    reply_policy: Option<String>,
    max_hops: Option<i64>,
}

fn string_list(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    issues
        .list(body, key, Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        })
        .into_option()
}

fn hops(issues: &mut Issues, body: &Map<String, Value>) -> Option<i64> {
    issues
        .whole_number(
            body,
            "agentMaxHops",
            Presence::Optional,
            Number {
                min: Some(1.0),
                max: Some(5.0),
                ..Number::default()
            },
        )
        .into_option()
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> CreateBody {
    let name = issues
        .text_with(
            body,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option()
        .unwrap_or_default();
    let description = issues.string(body, "description", false, None, None);
    let topic = issues.string(body, "topic", false, None, None);
    let kind = issues
        .choice(body, "type", Presence::Optional, &["public", "private"])
        .into_option()
        .unwrap_or_else(|| "public".to_owned());
    let icon = issues.string(body, "icon", false, None, Some(50));
    let section_id = issues.string(body, "sectionId", false, None, None);
    let member_ids = string_list(issues, body, "memberIds");
    let agent_ids = string_list(issues, body, "agentIds");
    let reply_policy = issues
        .choice(body, "agentReplyPolicy", Presence::Optional, &POLICIES)
        .into_option();
    let max_hops = hops(issues, body);
    CreateBody {
        channel: NewChannel {
            name,
            description,
            topic,
            kind,
            icon,
            section_id,
            member_ids: member_ids.unwrap_or_default(),
            agent_ids: agent_ids.unwrap_or_default(),
            metadata: None,
        },
        reply_policy,
        max_hops,
    }
}

/// `POST /`: create a channel.
async fn create_one(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut input = match validate(&headers, &body, read_create) {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to create channel"),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond("Failed to create channel"),
    };
    let result = async {
        if channel_name_taken(&caller, &input.channel.name, None).await? {
            return Err(ChatError::conflict(format!(
                "A channel named \"{}\" already exists",
                input.channel.name
            )));
        }
        if input.reply_policy.is_some() || input.max_hops.is_some() {
            input.channel.metadata = Some(merge_agent_room_policy(
                None,
                input.reply_policy.as_deref(),
                input.max_hops,
            ));
        } else if !input.channel.agent_ids.is_empty() {
            input.channel.metadata = Some(merge_agent_room_policy(None, Some("mentions"), None));
        }
        let created = create_channel(&caller.db, &caller.user_id, &input.channel, &now()).await?;
        let realtime = Caller::realtime(&state);
        let channel_id = created.channel["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let channel_name = created.channel["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        for uid in created
            .member_user_ids
            .iter()
            .filter(|u| !u.starts_with("agt_"))
        {
            realtime
                .channel_new(&org, uid, &channel_id, &channel_name)
                .await;
        }
        caller.publish(
            &state,
            CHAT_CHANNEL_CREATED,
            &channel_id,
            &json!({ "id": channel_id, "name": channel_name, "type": created.channel["type"] }),
        );
        Ok(Created(created.channel).into_response())
    }
    .await;
    answer(result, "Failed to create channel")
}

struct UpdateBody {
    /// The fields set, in the schema's order, by column.
    set: Vec<(&'static str, Value)>,
    name: Option<String>,
    reply_policy: Option<String>,
    max_hops: Option<i64>,
}

fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> UpdateBody {
    let mut set: Vec<(&'static str, Value)> = Vec::new();
    let name = issues
        .text_with(
            body,
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    if let Some(name) = &name {
        set.push(("name", Value::from(name.as_str())));
    }
    for key in ["description", "topic"] {
        if let Some(text) = issues.string(body, key, false, None, None) {
            set.push((key, Value::from(text)));
        }
    }
    if let Some(icon) = issues.string(body, "icon", false, None, Some(50)) {
        set.push(("icon", Value::from(icon)));
    }
    for key in [
        "voiceCallsEnabled",
        "videoCallsEnabled",
        "threadsEnabled",
        "attachmentsEnabled",
        "reactionsEnabled",
    ] {
        if let Field::Set(flag) = issues.boolean(body, key, Presence::Optional) {
            set.push((key, Value::Bool(flag)));
        }
    }
    if let Field::Set(seconds) = issues.whole_number(
        body,
        "slowModeSeconds",
        Presence::Optional,
        Number {
            min: Some(0.0),
            max: Some(21600.0),
            ..Number::default()
        },
    ) {
        set.push(("slowModeSeconds", Value::from(seconds)));
    }
    if let Field::Set(flag) = issues.boolean(body, "isArchived", Presence::Optional) {
        set.push(("isArchived", Value::Bool(flag)));
    }
    match issues.text(body, "sectionId", Presence::Nullish, None, None) {
        Field::Set(section) => set.push(("sectionId", Value::from(section))),
        Field::Null => set.push(("sectionId", Value::Null)),
        Field::Absent => {}
    }
    let reply_policy = issues
        .choice(body, "agentReplyPolicy", Presence::Optional, &POLICIES)
        .into_option();
    let max_hops = hops(issues, body);
    UpdateBody {
        set,
        name,
        reply_policy,
        max_hops,
    }
}

/// `PATCH /:id`: owners and admins reconfigure a channel.
async fn update_one(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_update) {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to update channel"),
    };
    answer(
        update_inner(&state, &caller, &id, input).await,
        "Failed to update channel",
    )
}

async fn update_inner(
    state: &ChatState,
    caller: &Caller,
    id: &str,
    input: UpdateBody,
) -> ChatResult<Response> {
    let Some(existing) = live_channel(caller, id).await? else {
        return Err(ChatError::not_found("Channel", Some(id)));
    };
    if !can_access_channel(&caller.db, id, &caller.user_id, None).await? {
        return Err(ChatError::not_found("Channel", Some(id)));
    }
    if !is_channel_moderator(&caller.db, id, &caller.user_id).await? {
        return Err(ChatError::forbidden(
            "Only channel owners and admins can update this channel",
        ));
    }
    let kind = existing["type"].as_str().unwrap_or_default();
    if let Some(name) = &input.name
        && (kind == "public" || kind == "private")
        && channel_name_taken(caller, name, Some(id)).await?
    {
        return Err(ChatError::conflict(format!(
            "A channel named \"{name}\" already exists"
        )));
    }
    let at = now();
    let mut update = Map::new();
    update.insert("updatedAt".to_owned(), Value::from(at.as_str()));
    for (key, value) in &input.set {
        update.insert((*key).to_owned(), value.clone());
    }
    if input.reply_policy.is_some() || input.max_hops.is_some() {
        let metadata = existing.get("metadata").filter(|m| !m.is_null());
        update.insert(
            "metadata".to_owned(),
            merge_agent_room_policy(metadata, input.reply_policy.as_deref(), input.max_hops),
        );
    }
    if let Some(name) = &input.name {
        update.insert(
            "slug".to_owned(),
            Value::from(resolve_channel_slug(&caller.db, name, id).await?),
        );
    }
    let field = |key: &str| update.get(key);
    let text = |key: &str| field(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| field(key).and_then(Value::as_bool);
    sqlx::query(
        "update chat_channels set
            updated_at = $2::timestamp,
            name = coalesce($3, name),
            description = coalesce($4, description),
            topic = coalesce($5, topic),
            icon = coalesce($6, icon),
            voice_calls_enabled = coalesce($7, voice_calls_enabled),
            video_calls_enabled = coalesce($8, video_calls_enabled),
            threads_enabled = coalesce($9, threads_enabled),
            attachments_enabled = coalesce($10, attachments_enabled),
            reactions_enabled = coalesce($11, reactions_enabled),
            slow_mode_seconds = coalesce($12, slow_mode_seconds),
            is_archived = coalesce($13, is_archived),
            section_id = case when $14 then $15 else section_id end,
            metadata = case when $16 then $17 else metadata end,
            slug = coalesce($18, slug)
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&at)
    .bind(text("name"))
    .bind(text("description"))
    .bind(text("topic"))
    .bind(text("icon"))
    .bind(flag("voiceCallsEnabled"))
    .bind(flag("videoCallsEnabled"))
    .bind(flag("threadsEnabled"))
    .bind(flag("attachmentsEnabled"))
    .bind(flag("reactionsEnabled"))
    .bind(
        field("slowModeSeconds")
            .and_then(Value::as_i64)
            .and_then(|s| i32::try_from(s).ok()),
    )
    .bind(flag("isArchived"))
    .bind(update.contains_key("sectionId"))
    .bind(text("sectionId"))
    .bind(update.contains_key("metadata"))
    .bind(field("metadata").cloned())
    .bind(text("slug"))
    .execute(&caller.db)
    .await?;
    let updated = channel_row(&caller.db, id).await?;
    Caller::realtime(state)
        .channel_updated(id, Value::Object(update))
        .await;
    Ok(Data(updated.unwrap_or_else(|| json!({ "id": id }))).into_response())
}

/// `DELETE /:id`: owners and admins soft-delete a channel.
async fn remove_one(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if live_channel(&caller, &id).await?.is_none() {
            return Err(ChatError::not_found("Channel", Some(&id)));
        }
        if !can_access_channel(&caller.db, &id, &caller.user_id, None).await? {
            return Err(ChatError::not_found("Channel", Some(&id)));
        }
        if !is_channel_moderator(&caller.db, &id, &caller.user_id).await? {
            return Err(ChatError::forbidden(
                "Only channel owners and admins can delete this channel",
            ));
        }
        let at = now();
        sqlx::query(
            "update chat_channels set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        Caller::realtime(&state)
            .channel_updated(&id, json!({ "deleted": true }))
            .await;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete channel")
}

/// `GET /:channelId/messages`: top-level messages, `before` older, `after` newer.
async fn list_messages(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = validate_query(raw.as_deref(), |issues, values| {
        let before = issues.string(values, "before", false, None, None);
        let after = issues.string(values, "after", false, None, None);
        let limit = issues
            .number(
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
            .unwrap_or(50.0);
        (before, after, limit)
    });
    let (before, after, limit) = match query {
        Ok(query) => query,
        Err(error) => return error.respond("Failed to fetch messages"),
    };
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.ceil() as i64;
    let result = async {
        let cursor_of = |message: &str| {
            let message = message.to_owned();
            let db = caller.db.clone();
            async move {
                let at: Option<String> = sqlx::query_scalar(
                    "select created_at::text from chat_messages where id = $1 limit 1",
                )
                .bind(&message)
                .fetch_optional(&db)
                .await?;
                Ok::<_, sqlx::Error>(at.map(|at| ms_timestamp(&at)))
            }
        };
        let rows: Vec<Value> = if let Some(after) = after.as_deref() {
            let after_at = cursor_of(after).await?;
            sqlx::query_scalar(
                "select to_jsonb(m) from chat_messages m
                 where m.channel_id = $1 and m.deleted_at is null and m.parent_id is null
                   and ($2::text is null or m.created_at > $2::timestamp)
                 order by m.created_at asc limit $3",
            )
            .bind(&id)
            .bind(&after_at)
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?
        } else {
            let before_at = match before.as_deref() {
                Some(before) => cursor_of(before).await?,
                None => None,
            };
            sqlx::query_scalar(
                "select to_jsonb(m) from chat_messages m
                 where m.channel_id = $1 and m.deleted_at is null and m.parent_id is null
                   and ($2::text is null or m.created_at < $2::timestamp)
                 order by m.created_at desc limit $3",
            )
            .bind(&id)
            .bind(&before_at)
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?
        };
        let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        let (messages, has_more, next) = page(rows, limit);
        Ok(
            Data(json!({ "messages": messages, "hasMore": has_more, "nextCursor": next }))
                .into_response(),
        )
    }
    .await;
    answer(result, "Failed to fetch messages")
}

/// One attachment as `messageAttachmentSchema` keeps it (unknown keys stripped).
pub(crate) fn read_attachment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut out = Map::new();
    for key in ["id", "fileName"] {
        if let Some(text) = issues.string(fields, key, true, None, None) {
            out.insert(key.to_owned(), Value::from(text));
        }
    }
    if let Field::Set(size) =
        issues.number(fields, "fileSize", Presence::Required, Number::default())
    {
        out.insert(
            "fileSize".to_owned(),
            weldsuite_chat_domain::text::js_number(size),
        );
    }
    for key in ["mimeType", "url"] {
        if let Some(text) = issues.string(fields, key, true, None, None) {
            out.insert(key.to_owned(), Value::from(text));
        }
    }
    if let Some(text) = issues.string(fields, "thumbnailUrl", false, None, None) {
        out.insert("thumbnailUrl".to_owned(), Value::from(text));
    }
    if let Some(kind) = issues
        .choice(
            fields,
            "clipType",
            Presence::Optional,
            &["audio", "video", "screen"],
        )
        .into_option()
    {
        out.insert("clipType".to_owned(), Value::from(kind));
    }
    if let Field::Set(duration) = issues.number(
        fields,
        "durationSeconds",
        Presence::Optional,
        Number::default(),
    ) {
        out.insert(
            "durationSeconds".to_owned(),
            weldsuite_chat_domain::text::js_number(duration),
        );
    }
    if let Field::Set(transcript) =
        issues.nested(fields, "transcript", Presence::Optional, read_transcript)
    {
        out.insert("transcript".to_owned(), transcript);
    }
    Some(Value::Object(out))
}

/// `clipTranscriptSchema`.
pub(crate) fn read_transcript(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(status) = issues
        .choice(
            fields,
            "status",
            Presence::Required,
            &["pending", "processing", "completed", "failed"],
        )
        .into_option()
    {
        out.insert("status".to_owned(), Value::from(status));
    }
    if let Some(text) = issues.string(fields, "fullText", false, None, None) {
        out.insert("fullText".to_owned(), Value::from(text));
    }
    if let Field::Set(segments) = issues.list(
        fields,
        "segments",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let segment = issues.object(item)?;
            let mut out = Map::new();
            if let Some(text) = issues.string(segment, "text", true, None, None) {
                out.insert("text".to_owned(), Value::from(text));
            }
            for key in ["startTime", "endTime"] {
                if let Field::Set(n) =
                    issues.number(segment, key, Presence::Required, Number::default())
                {
                    out.insert(key.to_owned(), weldsuite_chat_domain::text::js_number(n));
                }
            }
            if let Some(stamp) = issues.string(segment, "timestamp", true, None, None) {
                out.insert("timestamp".to_owned(), Value::from(stamp));
            }
            Some(Value::Object(out))
        },
    ) {
        out.insert("segments".to_owned(), Value::Array(segments));
    }
    if let Some(text) = issues.string(fields, "errorMessage", false, None, None) {
        out.insert("errorMessage".to_owned(), Value::from(text));
    }
    Value::Object(out)
}

fn read_send(issues: &mut Issues, body: &Map<String, Value>) -> PostInput {
    let content = issues.string(body, "content", true, None, None);
    let html_content = issues.string(body, "htmlContent", false, None, None);
    let parent_id = issues.string(body, "parentId", false, None, None);
    let attachments = issues
        .list(
            body,
            "attachments",
            Presence::Optional,
            None,
            None,
            read_attachment,
        )
        .into_option();
    let mentions = string_list(issues, body, "mentions");
    let reply_to_id = issues.string(body, "replyToId", false, None, None);
    let reply_mention = issues
        .boolean(body, "replyMention", Presence::Optional)
        .into_option();
    if issues.is_empty()
        && content.as_deref().is_some_and(str::is_empty)
        && attachments.as_ref().is_none_or(Vec::is_empty)
    {
        issues.custom_root("Message must have content or attachments");
    }
    PostInput {
        content: content.unwrap_or_default(),
        html_content,
        parent_id,
        attachments,
        mentions,
        metadata: None,
        reply_to_id,
        reply_mention,
    }
}

/// The send pipeline's refusal as the route answers it.
pub(crate) fn feature_error(error: PostError, channel_id: &str) -> ChatError {
    match error {
        PostError::Feature(404, _) => ChatError::not_found("Channel", Some(channel_id)),
        PostError::Feature(403, message) => ChatError::forbidden(message),
        PostError::Feature(_, message) => ChatError::bad_request(message),
        PostError::Database(error) => ChatError::Database(error),
    }
}

/// `POST /:channelId/messages`.
async fn send_message(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_send) {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to send message"),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond("Failed to send message"),
    };
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    if !consume_rate_limit(
        &caller,
        &state,
        &format!("msg:{org}:{}", caller.user_id),
        60,
    )
    .await
    {
        return ApiError::bad_request("Too many messages — slow down and try again")
            .into_response();
    }
    match post_chat_message(&caller, &state, &org, &id, input).await {
        Ok(message) => Created(message).into_response(),
        Err(error) => feature_error(error, &id).respond("Failed to send message"),
    }
}

/// `GET /:channelId/members`: the roster with names and agent details.
async fn members(caller: Caller, Path(id): Path<String>) -> Response {
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', chat_channel_members.id,
                    'userId', chat_channel_members.user_id,
                    'memberType', chat_channel_members.member_type,
                    'role', chat_channel_members.role, 'joinedAt', chat_channel_members.joined_at,
                    'isMuted', chat_channel_members.is_muted,
                    'notificationPreference', chat_channel_members.notification_preference,
                    'lastReadAt', chat_channel_members.last_read_at,
                    'lastReadMessageId', chat_channel_members.last_read_message_id,
                    'name', workspace_members.name, 'email', workspace_members.email,
                    'picture', workspace_members.picture,
                    'workspaceMemberType', workspace_members.member_type)
             from chat_channel_members
             left join workspace_members on chat_channel_members.user_id = workspace_members.user_id
             where chat_channel_members.channel_id = $1",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        let agent_ids: Vec<String> = rows
            .iter()
            .filter(|r| r["memberType"] == "agent")
            .filter_map(|r| r["userId"].as_str().map(str::to_owned))
            .collect();
        let mut agents: HashMap<String, (String, Option<String>, Option<String>)> = HashMap::new();
        if !agent_ids.is_empty() {
            let found: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
                "select id, name, icon, description from weldagent_agents
                 where id = any($1) and deleted_at is null",
            )
            .bind(&agent_ids)
            .fetch_all(&caller.db)
            .await?;
            for (id, name, icon, description) in found {
                agents.insert(id, (name, icon, description));
            }
        }
        let members: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                if row["memberType"] == "agent" {
                    let agent = row["userId"].as_str().and_then(|id| agents.get(id));
                    row["name"] = Value::from(agent.map_or("Agent", |a| a.0.as_str()));
                    row["email"] = Value::Null;
                    row["picture"] = Value::Null;
                    row["agentIcon"] = agent
                        .and_then(|a| a.1.clone())
                        .map_or(Value::Null, Value::from);
                    row["agentDescription"] = agent
                        .and_then(|a| a.2.clone())
                        .map_or(Value::Null, Value::from);
                }
                row
            })
            .collect();
        Ok(Data(members).into_response())
    }
    .await;
    answer(result, "Failed to fetch members")
}

/// `POST /:channelId/members`: add people (or agents) in one batch.
async fn add_members(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let user_ids = issues
            .list(
                body,
                "userIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default();
        let member_type = issues
            .choice(body, "memberType", Presence::Optional, &["user", "agent"])
            .into_option()
            .unwrap_or_else(|| "user".to_owned());
        (user_ids, member_type)
    });
    let (user_ids, member_type) = match input {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to add members"),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond("Failed to add members"),
    };
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    if member_type == "agent" {
        let viewer = agent_viewer_for(
            &caller.user_id,
            caller
                .permissions
                .as_ref()
                .map(weldsuite_permissions::Permissions::resolved),
        );
        match inaccessible_agent_ids(&caller.db, &user_ids, &viewer).await {
            Ok(blocked) if !blocked.is_empty() => {
                return ChatError::forbidden("You do not have access to one of these agents")
                    .respond("");
            }
            Ok(_) => {}
            Err(error) => return unhandled(error.into()),
        }
    }
    let result = async {
        let name: Option<String> = sqlx::query_scalar(
            "select name from chat_channels where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(name) = name else {
            return Err(ChatError::not_found("Channel", Some(&id)));
        };
        let added =
            match add_channel_members(&caller.db, &id, &user_ids, &member_type, &now()).await? {
                AddMembers::Refused(message) => return Err(ChatError::bad_request(message)),
                AddMembers::Added { added_user_ids } => added_user_ids,
            };
        let realtime = Caller::realtime(&state);
        for uid in &added {
            realtime.member(&id, uid, "joined").await;
        }
        if member_type == "user" {
            for uid in &added {
                realtime.channel_new(&org, uid, &id, &name).await;
            }
        }
        for _ in &added {
            caller.publish(
                &state,
                CHAT_CHANNEL_JOINED,
                &id,
                &json!({ "id": id, "name": name }),
            );
        }
        Ok(Created(json!({ "channelId": id, "addedCount": added.len() })).into_response())
    }
    .await;
    answer(result, "Failed to add members")
}

/// `resolveAgentRoom`: a channel or record chat the caller may write in.
async fn resolve_agent_room(caller: &Caller, channel_id: &str) -> ChatResult<String> {
    let channel: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, type, entity_type, entity_id from chat_channels
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(channel_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((name, kind, entity_type, entity_id)) = channel else {
        return Err(ChatError::not_found("Channel", Some(channel_id)));
    };
    let can = caller.context_can();
    if !can_access_channel(&caller.db, channel_id, &caller.user_id, Some(&can)).await? {
        return Err(forbidden_channel());
    }
    if !["public", "private", "entity"].contains(&kind.as_str()) {
        return Err(ChatError::bad_request(
            "Agents can only join channels and record chats",
        ));
    }
    if kind == "entity" {
        let provider = entity_type.as_deref().and_then(entity::provider);
        let writable = match (provider, entity_id.as_deref().filter(|e| !e.is_empty())) {
            (Some(provider), Some(entity_id)) => {
                can_post_in_record_chat(provider, &caller.db, &caller.user_id, entity_id, &can)
                    .await?
            }
            _ => false,
        };
        if !writable {
            return Err(ChatError::forbidden(
                "You may read this chat but not write in it",
            ));
        }
    }
    Ok(name)
}

/// `POST /:channelId/agents`: invite workspace agents.
async fn invite_agents(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "agentIds",
                Presence::Required,
                Some(1),
                Some(10),
                |issues, item| issues.item_starts_with(item, "agt_"),
            )
            .into_option()
            .unwrap_or_default()
    });
    let agent_ids = match input {
        Ok(ids) => {
            let mut unique: Vec<String> = Vec::new();
            for id in ids {
                if !unique.contains(&id) {
                    unique.push(id);
                }
            }
            unique
        }
        Err(error) => return error.respond("Failed to add agents"),
    };
    if let Err(error) = caller.org() {
        return error.respond("");
    }
    let name = match resolve_agent_room(&caller, &id).await {
        Ok(name) => name,
        Err(error) => return unhandled(error),
    };
    let viewer = agent_viewer_for(
        &caller.user_id,
        caller
            .permissions
            .as_ref()
            .map(weldsuite_permissions::Permissions::resolved),
    );
    match inaccessible_agent_ids(&caller.db, &agent_ids, &viewer).await {
        Ok(blocked) if !blocked.is_empty() => {
            return ChatError::forbidden("You do not have access to one of these agents")
                .respond("");
        }
        Ok(_) => {}
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let added = match add_channel_members(&caller.db, &id, &agent_ids, "agent", &now()).await? {
            AddMembers::Refused(message) => return Err(ChatError::bad_request(message)),
            AddMembers::Added { added_user_ids } => added_user_ids,
        };
        let realtime = Caller::realtime(&state);
        for agent in &added {
            realtime.member(&id, agent, "joined").await;
        }
        if !added.is_empty() {
            caller.publish(
                &state,
                CHAT_CHANNEL_JOINED,
                &id,
                &json!({ "id": id, "name": name }),
            );
        }
        Ok(Created(json!({ "channelId": id, "addedAgentIds": added })).into_response())
    }
    .await;
    answer(result, "Failed to add agents")
}

/// `DELETE /:channelId/agents/:agentId`.
async fn remove_agent(
    State(state): State<ChatState>,
    caller: Caller,
    Path((id, agent_id)): Path<(String, String)>,
) -> Response {
    if !agent_id.starts_with("agt_") {
        return ApiError::bad_request(format!("Invalid agent id: {agent_id}")).into_response();
    }
    let name = match resolve_agent_room(&caller, &id).await {
        Ok(name) => name,
        Err(error) => return unhandled(error),
    };
    let live: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from weldagent_agents where id = $1 and deleted_at is null limit 1",
    )
    .bind(&agent_id)
    .fetch_optional(&caller.db)
    .await;
    let live = match live {
        Ok(live) => live,
        Err(error) => return unhandled(error.into()),
    };
    let viewer = agent_viewer_for(
        &caller.user_id,
        caller
            .permissions
            .as_ref()
            .map(weldsuite_permissions::Permissions::resolved),
    );
    if live.is_some() {
        match inaccessible_agent_ids(&caller.db, std::slice::from_ref(&agent_id), &viewer).await {
            Ok(blocked) if !blocked.is_empty() => {
                return ChatError::forbidden("You do not have access to this agent").respond("");
            }
            Ok(_) => {}
            Err(error) => return unhandled(error.into()),
        }
    }
    let result = async {
        if remove_channel_member_by_user_id(&caller.db, &id, &agent_id, &now())
            .await?
            .is_none()
        {
            return Err(ChatError::not_found("Agent", Some(&agent_id)));
        }
        Caller::realtime(&state)
            .member(&id, &agent_id, "left")
            .await;
        caller.publish(
            &state,
            CHAT_CHANNEL_LEFT,
            &id,
            &json!({ "id": id, "name": name }),
        );
        Ok(Data(json!({ "channelId": id, "agentId": agent_id, "removed": true })).into_response())
    }
    .await;
    answer(result, "Failed to remove agent")
}

/// `POST /:channelId/members/join`: self-join a public channel.
async fn join(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(error) = caller.org() {
        return error.respond("");
    }
    let result = async {
        match join_public_channel(&caller.db, &id, &caller.user_id, &now()).await? {
            Err(message) => Err(ChatError::bad_request(message)),
            Ok(true) => Ok(Data(json!({ "channelId": id, "alreadyMember": true })).into_response()),
            Ok(false) => {
                Caller::realtime(&state)
                    .member(&id, &caller.user_id, "joined")
                    .await;
                caller.publish(&state, CHAT_CHANNEL_JOINED, &id, &json!({ "id": id }));
                Ok(Created(json!({ "channelId": id, "joined": true })).into_response())
            }
        }
    }
    .await;
    answer(result, "Failed to join channel")
}

/// `POST /:channelId/members/leave`: the caller leaves (owners hand over first).
async fn leave(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some((_, role)) = get_membership(&caller.db, &id, &caller.user_id).await? else {
            return Err(ChatError::bad_request(
                "You are not a member of this channel",
            ));
        };
        if role == "owner" {
            return Err(ChatError::bad_request(
                "Channel owner cannot leave. Transfer ownership first.",
            ));
        }
        remove_channel_member_by_user_id(&caller.db, &id, &caller.user_id, &now()).await?;
        Caller::realtime(&state)
            .member(&id, &caller.user_id, "left")
            .await;
        caller.publish(&state, CHAT_CHANNEL_LEFT, &id, &json!({ "id": id }));
        Ok(Data(json!({ "channelId": id, "left": true })).into_response())
    }
    .await;
    answer(result, "Failed to leave channel")
}

/// `DELETE /:channelId/members/:userId`: remove a member by user id.
async fn remove_member(
    State(state): State<ChatState>,
    caller: Caller,
    Path((id, user_id)): Path<(String, String)>,
) -> Response {
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        if remove_channel_member_by_user_id(&caller.db, &id, &user_id, &now())
            .await?
            .is_none()
        {
            return Err(ChatError::not_found("Member", Some(&user_id)));
        }
        Caller::realtime(&state).member(&id, &user_id, "left").await;
        caller.publish(&state, CHAT_CHANNEL_LEFT, &id, &json!({ "id": id }));
        Ok(Data(json!({ "channelId": id, "userId": user_id, "removed": true })).into_response())
    }
    .await;
    answer(result, "Failed to remove member")
}

/// `GET /:channelId/read-receipts`: who read what, by message, newest read first.
async fn read_receipts(caller: Caller, Path(id): Path<String>) -> Response {
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "select chat_message_reads.message_id, chat_message_reads.user_id,
                        chat_message_reads.read_at::text, workspace_members.name,
                        workspace_members.picture
                 from chat_message_reads
                 left join workspace_members on chat_message_reads.user_id = workspace_members.user_id
                 where chat_message_reads.channel_id = $1
                 order by chat_message_reads.read_at desc",
            )
            .bind(&id)
            .fetch_all(&caller.db)
            .await?;
        let mut grouped = Map::new();
        for (message_id, user_id, read_at, name, picture) in rows {
            let entry = grouped
                .entry(message_id)
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(list) = entry {
                list.push(json!({
                    "userId": user_id,
                    "userName": name,
                    "userAvatar": picture,
                    "readAt": read_at.map(|at| ms_timestamp(&at)),
                }));
            }
        }
        Ok(Data(Value::Object(grouped)).into_response())
    }
    .await;
    answer(result, "Failed to fetch read receipts")
}

/// `POST /:channelId/messages/:messageId/forward`.
async fn forward(
    State(state): State<ChatState>,
    caller: Caller,
    Path((id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let targets = issues
            .list(
                body,
                "targetChannelIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default();
        let comment = issues.string(body, "comment", false, None, None);
        let html_comment = issues.string(body, "htmlComment", false, None, None);
        (targets, comment, html_comment)
    });
    let (targets, comment, html_comment) = match input {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to forward message"),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let forwarded =
            crate::forward::forward_message(&caller, &id, &message_id, &targets, comment, html_comment)
                .await?;
        let (forwarded, author_name, author_avatar) = match forwarded {
            Err((403, message)) => return Err(ChatError::forbidden(message)),
            Err((_, message)) => return Err(ChatError::not_found("Message", Some(&message))),
            Ok(done) => done,
        };
        let realtime = Caller::realtime(&state);
        for fwd in &forwarded {
            if realtime.is_on() {
                realtime
                    .message(
                        &fwd.channel_id,
                        object([
                            ("id", Some(Value::from(fwd.message_id.as_str()))),
                            ("content", Some(Value::from(fwd.content.as_str()))),
                            ("senderId", Some(Value::from(caller.user_id.as_str()))),
                            ("senderName", Some(Value::from(author_name.as_str()))),
                            ("senderAvatar", author_avatar.clone().map(Value::from)),
                            ("authorType", Some(Value::from("user"))),
                        ]),
                    )
                    .await;
            }
            for recipient in &fwd.recipient_user_ids {
                realtime.unread_update(&org, recipient, &fwd.channel_id, 1).await;
            }
            caller.publish(
                &state,
                CHAT_MESSAGE_CREATED,
                &fwd.message_id,
                &json!({ "id": fwd.message_id, "channelId": fwd.channel_id, "authorId": caller.user_id }),
            );
        }
        let list: Vec<Value> = forwarded
            .iter()
            .map(|f| json!({ "channelId": f.channel_id, "messageId": f.message_id }))
            .collect();
        Ok(Created(json!({ "forwarded": list })).into_response())
    }
    .await;
    answer(result, "Failed to forward message")
}

/// `POST /:channelId/read`: mark read, or with `beforeMessageId` unread from there.
async fn mark_read(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    // The body is optional; whatever arrives is validated.
    let raw: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let raw = if raw.is_null() { json!({}) } else { raw };
    let before = match &raw {
        Value::Object(fields) => match fields.get("beforeMessageId") {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => return ApiError::bad_request("Invalid request body").into_response(),
        },
        _ => return ApiError::bad_request("Invalid request body").into_response(),
    };
    match can_access_channel(&caller.db, &id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => return forbidden_channel().respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        if let Some(before) = before.as_deref().filter(|b| !b.is_empty()) {
            return match crate::reads::mark_unread_from(&caller.db, &id, &caller.user_id, before)
                .await?
            {
                Some(result) => Ok(Data(result).into_response()),
                None => Err(ChatError::not_found("Message", Some(before))),
            };
        }
        let result = crate::reads::mark_read(&caller.db, &id, &caller.user_id).await?;
        let realtime = Caller::realtime(&state);
        realtime.unread_update(&org, &caller.user_id, &id, 0).await;
        if let Some(last_read) = result["lastReadMessageId"].as_str() {
            let reader: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "select name, picture from workspace_members where user_id = $1 limit 1",
            )
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await?;
            let (name, avatar) = reader.unwrap_or((None, None));
            realtime
                .read_updated(
                    &id,
                    object([
                        ("channelId", Some(Value::from(id.as_str()))),
                        ("userId", Some(Value::from(caller.user_id.as_str()))),
                        ("userName", Some(Value::from(name.unwrap_or_default()))),
                        ("userAvatar", avatar.map(Value::from)),
                        ("lastReadMessageId", Some(Value::from(last_read))),
                        ("lastReadAt", Some(result["lastReadAt"].clone())),
                    ]),
                )
                .await;
        }
        Ok(Data(result).into_response())
    }
    .await;
    answer(result, "Failed to mark channel read")
}

/// `PATCH /:channelId/me`: the caller mutes or unmutes the channel.
async fn update_me(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let muted = validate(&headers, &body, |issues, body| {
        issues
            .boolean(body, "isMuted", Presence::Required)
            .into_option()
            .unwrap_or_default()
    });
    let muted = match muted {
        Ok(muted) => muted,
        Err(error) => return error.respond("Failed to update membership"),
    };
    let result = async {
        let updated: Option<Value> = sqlx::query_scalar(
            "update chat_channel_members m set is_muted = $3
             where m.channel_id = $1 and m.user_id = $2 returning to_jsonb(m)",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .bind(muted)
        .fetch_optional(&caller.db)
        .await?;
        let Some(updated) = updated else {
            return Err(ChatError::not_found("Membership", None));
        };
        caller.publish(&state, CHAT_CHANNEL_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(weldsuite_db::js_row(updated)).into_response())
    }
    .await;
    answer(result, "Failed to update membership")
}

#[allow(dead_code)]
fn unused(_: &str) -> String {
    generate_id("x")
}

#[allow(dead_code)]
async fn preview(db: &sqlx::PgPool, content: &str) -> String {
    build_message_preview(db, content).await
}
