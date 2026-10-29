//! `/api/support` (`app-api/src/routes/support`): the Enterprise plan's
//! Contact Support channel. One active channel per workspace, created on
//! first access with the caller as its owner; its messages and members live
//! in the tenant database. Every route needs `general:read` (any member may
//! contact support), an organisation, and a workspace on the `enterprise`
//! plan (the master database). There is no `support_*` entity type, so no
//! entity events: a new message and a member change are published on the
//! realtime port instead, as the worker's `rt.supportEvent(orgId, event,
//! data)` does: to the workspace hub's `support` topic, then to the
//! workspace's `SupportRoom` with a `{ type, data, ts }` payload.
//!
//! The bodies are read with `c.req.json()` and no validator, so a body that
//! isn't JSON, or a field of the wrong type, ends in the routes' catch: a 500.
//! Where the worker would fail in the database (a missing author name, a
//! member added twice in one call), the port answers that 500 without the
//! failing query.
//!
//! # Realtime tokens on Kubernetes
//!
//! app-api has no `/api/realtime/token` route. The platform opens its
//! WebSocket connections on the `realtime-worker` with the session token it holds
//! (`/ws` for the workspace hub, `/ws/support/:orgId` for this channel's room;
//! `?token=`, a bearer header or the `authorization` subprotocol), and the
//! worker verifies it against the Clerk keys itself. The only token-minting
//! route is helpdesk-widget-api's `POST /api/realtime/token`, an HS256 token
//! for an anonymous widget visitor, outside app-api.
//!
//! On Kubernetes the publishing half is this backend's realtime port
//! (`ValkeyRealtime`: Valkey `PUBLISH` on `workspace:<orgId>`,
//! `support:<orgId>`, `conversation:<id>` and `chat:<id>`, with the body the
//! worker's `/publish/*` route would receive). The WebSocket gateway in front
//! of it is expected to verify the same session token this backend accepts
//! (`weldsuite-auth`: Clerk, or the edition's OIDC provider), derive the user
//! and org from it, and `SUBSCRIBE` to the channels of that org (the
//! `support:<orgId>` room only for the token's own org, as the worker checks);
//! so no separate token route is needed for the platform. The widget's token
//! route ports with helpdesk-widget-api. The worker's support-staff side
//! (tokens from the admin Clerk instance, joining any workspace's room as
//! `support`) has no Kubernetes counterpart yet.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::js_row;
use weldsuite_kit::validation::{js_number, js_trim};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage, Room};

use crate::{Caller, CorePlatformState, now};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let general = || gate.require(["general:read"]);
    Router::new()
        .route("/channel", get(channel).route_layer(general()))
        .route(
            "/messages",
            get(list_messages).post(send_message).route_layer(general()),
        )
        .route(
            "/members",
            get(list_members).post(add_members).route_layer(general()),
        )
        .route(
            "/members/{user_id}",
            delete(remove_member).route_layer(general()),
        )
}

const PLAN_REQUIRED: &str = "Contact Support is available on the Enterprise plan.";

/// How a support route fails; [`Failure::respond`] answers as the worker.
enum Failure {
    /// A refusal the route writes itself.
    Api(ApiError),
    /// The catch: `error.internal(c)`.
    Internal(String),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl Failure {
    fn respond(self, what: &'static str) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Internal(cause) => {
                tracing::error!(cause, "support: {what} error");
                ApiError::internal().into_response()
            }
        }
    }
}

type Outcome = Result<Response, Failure>;

fn answer(outcome: Outcome, what: &'static str) -> Response {
    outcome.unwrap_or_else(|failure| failure.respond(what))
}

/// The organisation, then the plan: what every route checks first.
async fn enterprise_org(caller: &Caller, state: &CorePlatformState) -> Result<String, Failure> {
    let Some(org_id) = caller.org_id.clone() else {
        return Err(ApiError::org_required().into());
    };
    if !is_enterprise_plan(caller, state, &org_id).await? {
        return Err(ApiError::forbidden().with_message(PLAN_REQUIRED).into());
    }
    Ok(org_id)
}

/// `isEnterprisePlan`: the workspace of the org is on the `enterprise` plan.
async fn is_enterprise_plan(
    caller: &Caller,
    state: &CorePlatformState,
    org_id: &str,
) -> Result<bool, sqlx::Error> {
    let master = caller.master(state);
    let plan_id: Option<Option<String>> =
        sqlx::query_scalar("select plan_id from workspaces where clerk_org_id = $1 limit 1")
            .bind(org_id)
            .fetch_optional(&master)
            .await?;
    let Some(plan_id) = plan_id.flatten().filter(|id| !id.is_empty()) else {
        return Ok(false);
    };
    let slug: Option<String> = sqlx::query_scalar("select slug from plans where id = $1 limit 1")
        .bind(&plan_id)
        .fetch_optional(&master)
        .await?;
    Ok(slug.as_deref() == Some("enterprise"))
}

/// The active channel, as Drizzle returns the row.
async fn active_channel(caller: &Caller) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from support_channels c where status = 'active' limit 1",
    )
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

async fn members_of(caller: &Caller, channel_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from support_channel_members m where channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

fn text_of<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn count_of(row: &Value, key: &str) -> i64 {
    row[key].as_i64().unwrap_or_default()
}

fn support_channel_not_found() -> Failure {
    ApiError::not_found("Support channel", None).into()
}

/// `await c.req.json()`: the body as JSON whatever its content type.
fn request_json(body: &[u8]) -> Result<Value, Failure> {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    serde_json::from_slice(body).map_err(|error| Failure::Internal(error.to_string()))
}

/// `Date.now()`.
fn now_millis() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `rt.supportEvent(orgId, event, data)`: the workspace hub's `support`
/// topic, then the `SupportRoom`. A failed hub publish skips the room (the
/// worker's `publish` throws); neither fails the request.
async fn support_event(state: &CorePlatformState, org_id: &str, event: &str, data: Value) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    let hub = RealtimeMessage::workspace(org_id, "support", event, data.clone(), "system");
    if let Err(error) = DynRealtimePublisher::publish_boxed(&*realtime, &hub).await {
        tracing::warn!(%error, "support: realtime publish failed");
        return;
    }
    let room = RealtimeMessage::room(
        Room::Support,
        org_id,
        json!({ "type": event, "data": data, "ts": now_millis() }),
    );
    if let Err(error) = DynRealtimePublisher::publish_boxed(&*realtime, &room).await {
        tracing::warn!(%error, "support: support room publish failed");
    }
}

/// A value as Drizzle binds it to a text column: strings as they are,
/// numbers and booleans as JavaScript prints them. `None` for what the
/// database would refuse (`null`, objects, arrays).
fn js_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => {
            let number = number.as_f64()?;
            #[allow(clippy::cast_possible_truncation)]
            let text = if number.fract() == 0.0 && number.abs() < 9.0e15 {
                (number as i64).to_string()
            } else {
                number.to_string()
            };
            Some(text)
        }
        _ => None,
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value || null` for a text column. `Err` for a value the database would
/// refuse.
fn optional_text(value: Option<&Value>) -> Result<Option<String>, Failure> {
    match value {
        Some(value) if truthy(value) => js_text(value)
            .map(Some)
            .ok_or_else(|| Failure::Internal("not a text value".to_owned())),
        _ => Ok(None),
    }
}

/// `text.substring(0, 200)`, in UTF-16 code units.
fn preview_of(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(200).collect();
    String::from_utf16_lossy(&units)
}

// ── GET /channel ────────────────────────────────────────────────────────────

async fn channel(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(channel_inner(&state, &caller).await, "Get channel")
}

async fn channel_inner(state: &CorePlatformState, caller: &Caller) -> Outcome {
    enterprise_org(caller, state).await?;
    if let Some(existing) = active_channel(caller).await? {
        let members = members_of(caller, text_of(&existing, "id")).await?;
        return Ok(Data(json!({ "channel": existing, "members": members })).into_response());
    }

    // Created on first access, the caller as its owner.
    let channel_id = generate_id("sup");
    let member_id = generate_id("scm");
    sqlx::query("insert into support_channels (id, status, member_count) values ($1, 'active', 1)")
        .bind(&channel_id)
        .execute(&caller.db)
        .await?;
    sqlx::query(
        "insert into support_channel_members (id, channel_id, user_id, role)
         values ($1, $2, $3, 'owner')",
    )
    .bind(&member_id)
    .bind(&channel_id)
    .bind(&caller.user_id)
    .execute(&caller.db)
    .await?;
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(c) from support_channels c where id = $1")
            .bind(&channel_id)
            .fetch_optional(&caller.db)
            .await?;
    let members = members_of(caller, &channel_id).await?;
    let channel = row.map_or(Value::Null, js_row);
    Ok(Created(json!({ "channel": channel, "members": members })).into_response())
}

// ── GET /messages ───────────────────────────────────────────────────────────

/// The first value of a query parameter, as `c.req.query(name)` reads it.
fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded_first(query.unwrap_or_default(), name)
}

fn form_urlencoded_first(query: &str, name: &str) -> Option<String> {
    weldsuite_kit::validation::query_values(Some(query))
        .get(name)
        .and_then(|value| match value {
            Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
            Value::String(text) => Some(text.clone()),
            _ => None,
        })
}

/// `Math.min(100, Math.max(1, Number(limit || '50')))`, as the page size
/// Drizzle sends: `Ok(None)` for NaN (Drizzle leaves the limit out), `Err`
/// for a fraction (Postgres refuses it as a `bigint`).
fn page_size(raw: Option<&str>) -> Result<Option<i64>, ()> {
    let raw = raw.filter(|raw| !raw.is_empty()).unwrap_or("50");
    let number = js_number(raw);
    if number.is_nan() {
        return Ok(None);
    }
    let number = number.clamp(1.0, 100.0);
    if number.fract() != 0.0 {
        return Err(());
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(Some(number as i64))
}

async fn list_messages(
    State(state): State<CorePlatformState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        list_messages_inner(&state, &caller, query.as_deref()).await,
        "List messages",
    )
}

async fn list_messages_inner(
    state: &CorePlatformState,
    caller: &Caller,
    query: Option<&str>,
) -> Outcome {
    enterprise_org(caller, state).await?;
    let before = query_param(query, "before").filter(|before| !before.is_empty());
    let limit = page_size(query_param(query, "limit").as_deref());

    let Some(channel) = active_channel(caller).await? else {
        return Ok(
            Data(json!({ "messages": [], "hasMore": false, "nextCursor": null })).into_response(),
        );
    };

    // Older than the cursor message, at the millisecond the worker reads
    // its `createdAt` with (a `Date`).
    let cursor: Option<String> = match &before {
        Some(before) => {
            sqlx::query_scalar(
                "select date_trunc('milliseconds', created_at)::text
             from support_messages where id = $1 limit 1",
            )
            .bind(before)
            .fetch_optional(&caller.db)
            .await?
        }
        None => None,
    };

    let limit =
        limit.map_err(|()| Failure::Internal("the page size is not an integer".to_owned()))?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from support_messages m
         where channel_id = $1 and deleted_at is null
           and ($2::timestamp is null or created_at < $2::timestamp)
         order by created_at desc
         limit $3",
    )
    .bind(text_of(&channel, "id"))
    .bind(&cursor)
    .bind(limit.map(|limit| limit + 1))
    .fetch_all(&caller.db)
    .await?;
    let mut messages: Vec<Value> = rows.into_iter().map(js_row).collect();
    let has_more = limit.is_some_and(|limit| messages.len() > usize::try_from(limit).unwrap_or(0));
    if has_more {
        messages.pop();
    }
    let next_cursor = if has_more {
        messages.last().map(|message| message["id"].clone())
    } else {
        None
    };
    Ok(Data(json!({
        "messages": messages,
        "hasMore": has_more,
        "nextCursor": next_cursor.unwrap_or(Value::Null),
    }))
    .into_response())
}

// ── POST /messages ──────────────────────────────────────────────────────────

async fn send_message(
    State(state): State<CorePlatformState>,
    caller: Caller,
    body: Bytes,
) -> Response {
    answer(
        send_message_inner(&state, &caller, &body).await,
        "Send message",
    )
}

async fn send_message_inner(state: &CorePlatformState, caller: &Caller, body: &[u8]) -> Outcome {
    let org_id = enterprise_org(caller, state).await?;
    let body = request_json(body)?;
    if body.is_null() {
        return Err(Failure::Internal("the body is null".to_owned()));
    }
    // `body.content?.trim()`: only a string has `trim`.
    let content = match body.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(content)) => Some(content.clone()),
        Some(_) => {
            return Err(Failure::Internal(
                "content.trim is not a function".to_owned(),
            ));
        }
    };
    let Some(content) = content.filter(|content| !js_trim(content).is_empty()) else {
        return Err(ApiError::bad_request("Message content is required.").into());
    };

    let Some(channel) = active_channel(caller).await? else {
        return Err(support_channel_not_found());
    };
    let channel_id = text_of(&channel, "id").to_owned();

    // The values the insert binds; `author_name` is `not null`.
    let author_name = body
        .get("authorName")
        .and_then(js_text)
        .ok_or_else(|| Failure::Internal("authorName is required by the table".to_owned()))?;
    let author_avatar = optional_text(body.get("authorAvatar"))?;
    let html_content = optional_text(body.get("htmlContent"))?;
    let attachments = body
        .get("attachments")
        .filter(|value| truthy(value))
        .cloned();

    let message_id = generate_id("smsg");
    sqlx::query(
        "insert into support_messages
             (id, channel_id, author_id, author_name, author_avatar, author_type,
              content, html_content, attachments)
         values ($1, $2, $3, $4, $5, 'customer', $6, $7, $8::jsonb)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&caller.user_id)
    .bind(&author_name)
    .bind(&author_avatar)
    .bind(&content)
    .bind(&html_content)
    .bind(&attachments)
    .execute(&caller.db)
    .await?;

    let stamp = now();
    sqlx::query(
        "update support_channels
         set last_message_at = $2::timestamp, last_message_preview = $3,
             message_count = $4, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&channel_id)
    .bind(&stamp)
    .bind(preview_of(&content))
    .bind(count_of(&channel, "messageCount") + 1)
    .execute(&caller.db)
    .await?;

    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(m) from support_messages m where id = $1")
            .bind(&message_id)
            .fetch_optional(&caller.db)
            .await?;
    let message = row.map_or(Value::Null, js_row);
    support_event(state, &org_id, "message", message.clone()).await;
    Ok(Created(message).into_response())
}

// ── GET /members ────────────────────────────────────────────────────────────

async fn list_members(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(list_members_inner(&state, &caller).await, "List members")
}

async fn list_members_inner(state: &CorePlatformState, caller: &Caller) -> Outcome {
    enterprise_org(caller, state).await?;
    let Some(channel) = active_channel(caller).await? else {
        return Ok(Data(Vec::<Value>::new()).into_response());
    };
    let members = members_of(caller, text_of(&channel, "id")).await?;
    Ok(Data(members).into_response())
}

// ── POST /members ───────────────────────────────────────────────────────────

/// What passes `if (!userIds?.length)`.
#[derive(Debug, PartialEq)]
enum Requested {
    /// A non-empty array.
    List(Vec<Value>),
    /// Something else with a truthy `length` (a string), which has no
    /// `filter`.
    NotAList,
}

/// `const { userIds } = await c.req.json()` and `if (!userIds?.length)`;
/// `None` is the 400.
fn requested_user_ids(body: &Value) -> Option<Requested> {
    match body.get("userIds") {
        Some(Value::Array(items)) if !items.is_empty() => Some(Requested::List(items.clone())),
        Some(Value::String(text)) if !text.is_empty() => Some(Requested::NotAList),
        Some(Value::Object(fields)) if fields.get("length").is_some_and(truthy) => {
            Some(Requested::NotAList)
        }
        _ => None,
    }
}

async fn add_members(
    State(state): State<CorePlatformState>,
    caller: Caller,
    body: Bytes,
) -> Response {
    answer(
        add_members_inner(&state, &caller, &body).await,
        "Add members",
    )
}

async fn add_members_inner(state: &CorePlatformState, caller: &Caller, body: &[u8]) -> Outcome {
    let org_id = enterprise_org(caller, state).await?;
    let body = request_json(body)?;
    if body.is_null() {
        return Err(Failure::Internal("the body is null".to_owned()));
    }
    let Some(requested) = requested_user_ids(&body) else {
        return Err(ApiError::bad_request("At least one userId is required.").into());
    };

    let Some(channel) = active_channel(caller).await? else {
        return Err(support_channel_not_found());
    };
    let channel_id = text_of(&channel, "id").to_owned();
    let existing: Vec<String> =
        sqlx::query_scalar("select user_id from support_channel_members where channel_id = $1")
            .bind(&channel_id)
            .fetch_all(&caller.db)
            .await?;
    let Requested::List(requested) = requested else {
        return Err(Failure::Internal(
            "userIds.filter is not a function".to_owned(),
        ));
    };

    // `userIds.filter((id) => !existingSet.has(id))`: only a string can be
    // in the set of user ids.
    let existing: HashSet<String> = existing.into_iter().collect();
    let new_ids: Vec<Value> = requested
        .into_iter()
        .filter(|id| id.as_str().is_none_or(|id| !existing.contains(id)))
        .collect();

    if !new_ids.is_empty() {
        // What the insert would bind; one the table refuses (no text, or a
        // user id twice) fails the whole statement in the worker.
        let mut user_ids = Vec::with_capacity(new_ids.len());
        for id in &new_ids {
            let text =
                js_text(id).ok_or_else(|| Failure::Internal("userId is not text".to_owned()))?;
            if existing.contains(&text) || user_ids.contains(&text) {
                return Err(Failure::Internal(
                    "duplicate support channel member".to_owned(),
                ));
            }
            user_ids.push(text);
        }
        let member_ids: Vec<String> = user_ids.iter().map(|_| generate_id("scm")).collect();
        sqlx::query(
            "insert into support_channel_members (id, channel_id, user_id, role)
             select id, $2, user_id, 'member'
             from unnest($1::varchar[], $3::varchar[]) as t(id, user_id)",
        )
        .bind(&member_ids)
        .bind(&channel_id)
        .bind(&user_ids)
        .execute(&caller.db)
        .await?;
        let added = i64::try_from(user_ids.len()).unwrap_or_default();
        sqlx::query(
            "update support_channels set member_count = $2, updated_at = $3::timestamp
             where id = $1",
        )
        .bind(&channel_id)
        .bind(count_of(&channel, "memberCount") + added)
        .bind(now())
        .execute(&caller.db)
        .await?;
    }

    let members = members_of(caller, &channel_id).await?;
    if !new_ids.is_empty() {
        support_event(
            state,
            &org_id,
            "members_changed",
            json!({ "added": new_ids }),
        )
        .await;
    }
    Ok(Data(members).into_response())
}

// ── DELETE /members/:userId ─────────────────────────────────────────────────

async fn remove_member(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(user_id): Path<String>,
) -> Response {
    answer(
        remove_member_inner(&state, &caller, &user_id).await,
        "Remove member",
    )
}

async fn remove_member_inner(state: &CorePlatformState, caller: &Caller, target: &str) -> Outcome {
    let org_id = enterprise_org(caller, state).await?;
    let Some(channel) = active_channel(caller).await? else {
        return Err(support_channel_not_found());
    };
    let channel_id = text_of(&channel, "id").to_owned();
    let member: Option<(String, String)> = sqlx::query_as(
        "select id, role from support_channel_members
         where channel_id = $1 and user_id = $2 limit 1",
    )
    .bind(&channel_id)
    .bind(target)
    .fetch_optional(&caller.db)
    .await?;
    let Some((member_id, role)) = member else {
        return Err(ApiError::not_found("Member", Some(target)).into());
    };
    if role == "owner" {
        return Err(ApiError::bad_request("Cannot remove the channel owner.").into());
    }

    sqlx::query("delete from support_channel_members where id = $1")
        .bind(&member_id)
        .execute(&caller.db)
        .await?;
    sqlx::query(
        "update support_channels set member_count = $2, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(&channel_id)
    .bind((count_of(&channel, "memberCount") - 1).max(0))
    .bind(now())
    .execute(&caller.db)
    .await?;

    support_event(
        state,
        &org_id,
        "members_changed",
        json!({ "removed": [target] }),
    )
    .await;
    Ok(Data(json!({ "removed": target })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_sizes_follow_the_worker() {
        assert_eq!(page_size(None), Ok(Some(50)));
        assert_eq!(page_size(Some("")), Ok(Some(50)));
        assert_eq!(page_size(Some("0")), Ok(Some(1)));
        assert_eq!(page_size(Some("-4")), Ok(Some(1)));
        assert_eq!(page_size(Some("500")), Ok(Some(100)));
        assert_eq!(page_size(Some("Infinity")), Ok(Some(100)));
        assert_eq!(page_size(Some(" 7 ")), Ok(Some(7)));
        assert_eq!(page_size(Some("abc")), Ok(None));
        assert_eq!(page_size(Some("2.5")), Err(()));
    }

    #[test]
    fn previews_count_utf16_units() {
        assert_eq!(preview_of("hello"), "hello");
        assert_eq!(
            preview_of(&"\u{1F600}".repeat(150)),
            "\u{1F600}".repeat(100)
        );
        assert_eq!(preview_of(&"a".repeat(250)).len(), 200);
    }

    #[test]
    fn user_id_lists_like_the_worker() {
        assert_eq!(
            requested_user_ids(&json!({ "userIds": ["u1"] })),
            Some(Requested::List(vec![json!("u1")]))
        );
        assert_eq!(requested_user_ids(&json!({ "userIds": [] })), None);
        assert_eq!(requested_user_ids(&json!({})), None);
        assert_eq!(requested_user_ids(&json!({ "userIds": 3 })), None);
        assert_eq!(
            requested_user_ids(&json!({ "userIds": "u1" })),
            Some(Requested::NotAList)
        );
    }

    #[test]
    fn text_values_bind_like_drizzle() {
        assert_eq!(js_text(&json!("a")), Some("a".to_owned()));
        assert_eq!(js_text(&json!(5)), Some("5".to_owned()));
        assert_eq!(js_text(&json!(2.5)), Some("2.5".to_owned()));
        assert_eq!(js_text(&json!(true)), Some("true".to_owned()));
        assert_eq!(js_text(&json!(null)), None);
        assert_eq!(js_text(&json!({})), None);
    }
}
