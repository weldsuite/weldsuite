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
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
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
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    chat_channel_members as members, chat_channels, chat_message_reads, chat_messages,
    weldagent_agents, workspace_members,
};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, unhandled, validate, validate_query};
use crate::post::{PostError, PostInput, post_chat_message};
use crate::util::{consume_rate_limit, list_limit, list_response, now, page, query_map};

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

// ── Rows through the entities (shared by the chat routes) ──────────────────

/// A row as Drizzle returns it: the entity's own serialization.
pub(crate) fn js<M: Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// A `timestamp` as JavaScript reads it (milliseconds): a keyset cursor's
/// `createdAt` as the TypeScript routes bind it back.
pub(crate) fn millis(at: PrimitiveDateTime) -> PrimitiveDateTime {
    utc_timestamp(at.assume_utc())
}

/// A `timestamp` as `toISOString()` writes it.
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `new Date()` once: the ISO text the route answers or publishes, and the
/// `timestamp` it stores (UTC, milliseconds, as Drizzle wrote it).
pub(crate) fn now_stamped() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (weldsuite_events::iso_timestamp(at), utc_timestamp(at))
}

/// `$n::timestamp` of a `toISOString()` text the route holds: Postgres
/// keeps its wall clock and drops the `Z`. `Err` is the failed cast (the
/// route's 500).
pub(crate) fn timestamp_of(text: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(text, &Rfc3339)
        .map(utc_timestamp)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{text}\""
            ))
        })
}

/// `limit $n` of a page's `limit + 1` probe: Postgres refuses a negative one
/// (the route's 500), as it did when the number was bound.
pub(crate) fn sql_limit(probe: i64) -> Result<u64, DbErr> {
    u64::try_from(probe).map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))
}

/// `exists (select 1 from chat_channel_members m where m.channel_id =
/// chat_channels.id and m.user_id = $user)`.
pub(crate) fn member_exists(user_id: &str) -> Expr {
    Expr::exists(
        Query::select()
            .expr(Expr::val(1))
            .from(members::Entity)
            .and_where(sea_orm::ExprTrait::equals(
                Expr::col((members::Entity, members::Column::ChannelId)),
                (chat_channels::Entity, chat_channels::Column::Id),
            ))
            .and_where(members::Column::UserId.eq(user_id))
            .to_owned(),
    )
}

/// `chat_channel_members left join workspace_members on user_id`.
pub(crate) fn member_profile() -> RelationDef {
    members::Entity::belongs_to(workspace_members::Entity)
        .from(members::Column::UserId)
        .to(workspace_members::Column::UserId)
        .into()
}

/// A roster row with `picture: null`, for `overlay_account_pictures`.
pub(crate) fn with_null_picture<M: Serialize>(row: M) -> Result<Value, DbErr> {
    let mut row = js(row)?;
    if let Value::Object(fields) = &mut row {
        fields.insert("picture".to_owned(), Value::Null);
    }
    Ok(row)
}

fn forbidden_channel() -> ChatError {
    ChatError::forbidden("You do not have access to this channel")
}

/// `channelNameTaken`: a live public channel, or a live private one the
/// caller is in, already named `name` (case-insensitive, trimmed).
async fn channel_name_taken(
    caller: &Caller,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<bool, DbErr> {
    // `lower(btrim(t.name)) = lower($1)`.
    let same_name = sea_orm::ExprTrait::eq(
        Func::lower(Func::cust("btrim").arg(Expr::col((
            chat_channels::Entity,
            chat_channels::Column::Name,
        )))),
        Func::lower(Expr::val(name)),
    );
    let mut query = chat_channels::Entity::find()
        .select_only()
        .column(chat_channels::Column::Id)
        .filter(chat_channels::Column::DeletedAt.is_null())
        .filter(same_name)
        .filter(
            Condition::any()
                .add(chat_channels::Column::Type.eq("public"))
                .add(
                    Condition::all()
                        .add(chat_channels::Column::Type.eq("private"))
                        .add(member_exists(&caller.user_id)),
                ),
        );
    if let Some(exclude_id) = exclude_id {
        query = query.filter(chat_channels::Column::Id.ne(exclude_id));
    }
    let clash: Option<String> = query.into_tuple().one(&orm(&caller.db)).await?;
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

/// The cursor row's `createdAt` (as JavaScript read it) and id.
async fn channel_cursor(
    caller: &Caller,
    id: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = chat_channels::Entity::find()
        .select_only()
        .columns([chat_channels::Column::CreatedAt, chat_channels::Column::Id])
        .filter(chat_channels::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(row.map(|(at, id)| (millis(at), id)))
}

/// `created_at < $at or (created_at = $at and id < $id)`, newest first.
pub(crate) fn before_cursor<C: ColumnTrait>(
    created_at: C,
    id: C,
    (at, cursor_id): &(PrimitiveDateTime, String),
) -> Condition {
    Condition::any().add(created_at.lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(id.lt(cursor_id.as_str())),
    )
}

async fn list_inner(
    caller: &Caller,
    q: &HashMap<String, String>,
    limit: i64,
    types: Option<Vec<String>>,
    cursor: Option<(PrimitiveDateTime, String)>,
) -> ChatResult<Response> {
    let kind = q.get("type").filter(|t| !t.is_empty());
    let search = q
        .get("search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let mut filters = Condition::all()
        .add(chat_channels::Column::DeletedAt.is_null())
        .add(
            Condition::any()
                .add(chat_channels::Column::Type.eq("public"))
                .add(member_exists(&caller.user_id)),
        );
    if let Some(kind) = kind {
        filters = filters.add(chat_channels::Column::Type.eq(kind.as_str()));
    }
    if let Some(types) = &types {
        filters = filters.add(chat_channels::Column::Type.is_in(types.iter().map(String::as_str)));
    }
    if let Some(search) = &search {
        filters = filters.add(chat_channels::Column::Name.like(search.as_str()));
    }
    let db = orm(&caller.db);
    let mut rows = chat_channels::Entity::find().filter(filters.clone());
    if let Some(cursor) = &cursor {
        rows = rows.filter(before_cursor(
            chat_channels::Column::CreatedAt,
            chat_channels::Column::Id,
            cursor,
        ));
    }
    let rows = rows
        .order_by_desc(chat_channels::Column::CreatedAt)
        .order_by_desc(chat_channels::Column::Id)
        .limit(sql_limit(limit + 1)?)
        .all(&db)
        .await?;
    let total = chat_channels::Entity::find()
        .filter(filters)
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows: Vec<Value> = rows.into_iter().map(js).collect::<Result<_, _>>()?;
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
) -> Result<HashMap<String, Value>, DbErr> {
    if channel_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, bool, Option<PrimitiveDateTime>, Option<String>, i32)> =
        members::Entity::find()
            .select_only()
            .columns([
                members::Column::ChannelId,
                members::Column::IsMuted,
                members::Column::LastReadAt,
                members::Column::LastReadMessageId,
                members::Column::UnreadMentionCount,
            ])
            .filter(members::Column::UserId.eq(&caller.user_id))
            .filter(members::Column::ChannelId.is_in(channel_ids.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
    Ok(rows
        .into_iter()
        .map(|(channel_id, muted, read_at, read_id, mentions)| {
            (
                channel_id,
                json!({
                    "isMuted": muted,
                    "lastReadAt": read_at.map(iso),
                    "lastReadMessageId": read_id,
                    "unreadMentionCount": mentions,
                }),
            )
        })
        .collect())
}

/// A live channel row.
async fn live_channel(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    chat_channels::Entity::find_by_id(id.to_owned())
        .filter(chat_channels::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(js)
        .transpose()
}

/// A member of the channel's roster (`GET /:id`), `picture` added null.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct RosterMember {
    id: String,
    user_id: String,
    role: String,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    joined_at: PrimitiveDateTime,
    is_muted: bool,
    notification_preference: String,
    name: Option<String>,
    email: Option<String>,
}

/// A member as `GET /:id/members` lists it, `picture` added null.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedMember {
    id: String,
    user_id: String,
    member_type: String,
    role: String,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    joined_at: PrimitiveDateTime,
    is_muted: bool,
    notification_preference: String,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    last_read_at: Option<PrimitiveDateTime>,
    last_read_message_id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    workspace_member_type: Option<String>,
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
    let members = members::Entity::find()
        .select_only()
        .columns([
            members::Column::Id,
            members::Column::UserId,
            members::Column::Role,
            members::Column::JoinedAt,
            members::Column::IsMuted,
            members::Column::NotificationPreference,
        ])
        .column_as(workspace_members::Column::Name, "name")
        .column_as(workspace_members::Column::Email, "email")
        .join(JoinType::LeftJoin, member_profile())
        .filter(members::Column::ChannelId.eq(id))
        .into_model::<RosterMember>()
        .all(&orm(&caller.db))
        .await?;
    let mut members: Vec<Value> = members
        .into_iter()
        .map(with_null_picture)
        .collect::<Result<_, _>>()?;
    // Avatars are account pictures, not the member row's copy.
    weldsuite_db::overlay_account_pictures(caller.master(), &mut members, "userId", "picture")
        .await;
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
    // `null` clears the field, as an empty string does.
    for key in ["description", "topic"] {
        match issues.text(body, key, Presence::Nullish, None, None) {
            Field::Set(text) => set.push((key, Value::from(text))),
            Field::Null => set.push((key, Value::Null)),
            Field::Absent => {}
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
    let (at, stamp) = now_stamped();
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
    channel_update(&update, stamp)
        .filter(chat_channels::Column::Id.eq(id))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    let updated = channel_row(&caller.db, id).await?;
    Caller::realtime(state)
        .channel_updated(id, Value::Object(update))
        .await;
    Ok(Data(updated.unwrap_or_else(|| json!({ "id": id }))).into_response())
}

/// The `update chat_channels set …` of a `PATCH /:id`: the fields the body
/// set (`null` clears description, topic and section), `updatedAt` always.
fn channel_update(
    update: &Map<String, Value>,
    stamp: PrimitiveDateTime,
) -> sea_orm::UpdateMany<chat_channels::Entity> {
    use chat_channels::Column;
    let field = |key: &str| update.get(key);
    let text = |key: &str| field(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| field(key).and_then(Value::as_bool);
    let mut query =
        chat_channels::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(stamp));
    // `coalesce($n, column)`: written when the body sent it.
    for (key, column) in [("name", Column::Name), ("icon", Column::Icon), ("slug", Column::Slug)] {
        if let Some(text) = text(key) {
            query = query.col_expr(column, Expr::value(text));
        }
    }
    // `case when $set then $n else column end`: `null` clears it.
    for (key, column) in [
        ("description", Column::Description),
        ("topic", Column::Topic),
        ("sectionId", Column::SectionId),
    ] {
        if update.contains_key(key) {
            query = query.col_expr(column, Expr::value(text(key)));
        }
    }
    for (key, column) in [
        ("voiceCallsEnabled", Column::VoiceCallsEnabled),
        ("videoCallsEnabled", Column::VideoCallsEnabled),
        ("threadsEnabled", Column::ThreadsEnabled),
        ("attachmentsEnabled", Column::AttachmentsEnabled),
        ("reactionsEnabled", Column::ReactionsEnabled),
        ("isArchived", Column::IsArchived),
    ] {
        if let Some(flag) = flag(key) {
            query = query.col_expr(column, Expr::value(flag));
        }
    }
    if let Some(seconds) = field("slowModeSeconds")
        .and_then(Value::as_i64)
        .and_then(|s| i32::try_from(s).ok())
    {
        query = query.col_expr(Column::SlowModeSeconds, Expr::value(seconds));
    }
    if update.contains_key("metadata") {
        query = query.col_expr(Column::Metadata, Expr::value(field("metadata").cloned()));
    }
    query
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
        let at = weldsuite_db::utc_now();
        chat_channels::Entity::update_many()
            .col_expr(chat_channels::Column::DeletedAt, Expr::value(at))
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(at))
            .filter(chat_channels::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        use chat_messages::Column;
        let db = orm(&caller.db);
        // The message's `createdAt` as JavaScript read it.
        let cursor_of = async |message: &str| -> Result<Option<PrimitiveDateTime>, DbErr> {
            let at: Option<PrimitiveDateTime> = chat_messages::Entity::find()
                .select_only()
                .column(Column::CreatedAt)
                .filter(Column::Id.eq(message))
                .into_tuple()
                .one(&db)
                .await?;
            Ok(at.map(millis))
        };
        let top_level = chat_messages::Entity::find()
            .filter(Column::ChannelId.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::ParentId.is_null());
        let page_query = if let Some(after) = after.as_deref() {
            let mut rows = top_level;
            if let Some(at) = cursor_of(after).await? {
                rows = rows.filter(Column::CreatedAt.gt(at));
            }
            rows.order_by_asc(Column::CreatedAt)
        } else {
            let mut rows = top_level;
            if let Some(before) = before.as_deref()
                && let Some(at) = cursor_of(before).await?
            {
                rows = rows.filter(Column::CreatedAt.lt(at));
            }
            rows.order_by_desc(Column::CreatedAt)
        };
        let rows = page_query
            .limit(sql_limit(limit + 1)?)
            .all(&db)
            .await?;
        let rows: Vec<Value> = rows.into_iter().map(js).collect::<Result<_, _>>()?;
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
        PostError::Database(error) => ChatError::from(error),
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
        let db = orm(&caller.db);
        let rows = members::Entity::find()
            .select_only()
            .columns([
                members::Column::Id,
                members::Column::UserId,
                members::Column::MemberType,
                members::Column::Role,
                members::Column::JoinedAt,
                members::Column::IsMuted,
                members::Column::NotificationPreference,
                members::Column::LastReadAt,
                members::Column::LastReadMessageId,
            ])
            .column_as(workspace_members::Column::Name, "name")
            .column_as(workspace_members::Column::Email, "email")
            .column_as(
                workspace_members::Column::MemberType,
                "workspace_member_type",
            )
            .join(JoinType::LeftJoin, member_profile())
            .filter(members::Column::ChannelId.eq(&id))
            .into_model::<ListedMember>()
            .all(&db)
            .await?;
        let mut rows: Vec<Value> = rows
            .into_iter()
            .map(with_null_picture)
            .collect::<Result<_, _>>()?;
        // Avatars are account pictures, not the member row's copy.
        weldsuite_db::overlay_account_pictures(caller.master(), &mut rows, "userId", "picture")
            .await;
        let agent_ids: Vec<String> = rows
            .iter()
            .filter(|r| r["memberType"] == "agent")
            .filter_map(|r| r["userId"].as_str().map(str::to_owned))
            .collect();
        let mut agents: HashMap<String, (String, Option<String>, Option<String>)> = HashMap::new();
        if !agent_ids.is_empty() {
            let found: Vec<(String, String, Option<String>, Option<String>)> =
                weldagent_agents::Entity::find()
                    .select_only()
                    .columns([
                        weldagent_agents::Column::Id,
                        weldagent_agents::Column::Name,
                        weldagent_agents::Column::Icon,
                        weldagent_agents::Column::Description,
                    ])
                    .filter(weldagent_agents::Column::Id.is_in(agent_ids.iter().map(String::as_str)))
                    .filter(weldagent_agents::Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(&db)
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
        let name: Option<String> = chat_channels::Entity::find()
            .select_only()
            .column(chat_channels::Column::Name)
            .filter(chat_channels::Column::Id.eq(&id))
            .filter(chat_channels::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
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
    let channel: Option<(String, String, Option<String>, Option<String>)> =
        chat_channels::Entity::find()
            .select_only()
            .columns([
                chat_channels::Column::Name,
                chat_channels::Column::Type,
                chat_channels::Column::EntityType,
                chat_channels::Column::EntityId,
            ])
            .filter(chat_channels::Column::Id.eq(channel_id))
            .filter(chat_channels::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
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
    let live: Result<Option<String>, DbErr> = weldagent_agents::Entity::find()
        .select_only()
        .column(weldagent_agents::Column::Id)
        .filter(weldagent_agents::Column::Id.eq(&agent_id))
        .filter(weldagent_agents::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
        let reader: RelationDef = chat_message_reads::Entity::belongs_to(workspace_members::Entity)
            .from(chat_message_reads::Column::UserId)
            .to(workspace_members::Column::UserId)
            .into();
        let rows: Vec<(String, String, Option<PrimitiveDateTime>, Option<String>)> =
            chat_message_reads::Entity::find()
                .select_only()
                .columns([
                    chat_message_reads::Column::MessageId,
                    chat_message_reads::Column::UserId,
                    chat_message_reads::Column::ReadAt,
                ])
                .column(workspace_members::Column::Name)
                .join(JoinType::LeftJoin, reader)
                .filter(chat_message_reads::Column::ChannelId.eq(&id))
                .order_by_desc(chat_message_reads::Column::ReadAt)
                .into_tuple()
                .all(&orm(&caller.db))
                .await?;
        let pictures = weldsuite_db::AccountPictures::load(
            caller.master(),
            rows.iter().map(|(_, user_id, _, _)| user_id.as_str()),
        )
        .await;
        let mut grouped = Map::new();
        for (message_id, user_id, read_at, name) in rows {
            let picture = pictures.value(Some(&user_id));
            let entry = grouped
                .entry(message_id)
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(list) = entry {
                list.push(json!({
                    "userId": user_id,
                    "userName": name,
                    "userAvatar": picture,
                    "readAt": read_at.map(iso),
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
            let name: Option<Option<String>> = workspace_members::Entity::find()
                .select_only()
                .column(workspace_members::Column::Name)
                .filter(workspace_members::Column::UserId.eq(&caller.user_id))
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
            let name = name.flatten();
            let avatar = weldsuite_db::load_account_picture(caller.master(), &caller.user_id).await;
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
        let updated = members::Entity::update_many()
            .col_expr(members::Column::IsMuted, Expr::value(muted))
            .filter(members::Column::ChannelId.eq(&id))
            .filter(members::Column::UserId.eq(&caller.user_id))
            .exec_with_returning(&orm(&caller.db))
            .await?;
        let Some(updated) = updated.into_iter().next() else {
            return Err(ChatError::not_found("Membership", None));
        };
        caller.publish(&state, CHAT_CHANNEL_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(js(updated)?).into_response())
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
