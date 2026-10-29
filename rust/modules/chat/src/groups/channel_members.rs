//! `/api/channel-members` (`routes/channel-members/index.ts`): single-row
//! membership CRUD. Self-service actions sit on the baseline permissions;
//! moderation (adding or kicking someone else, granting a role) is checked
//! in the handler.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_chat_domain::agents::{agent_viewer_for, inaccessible_agent_ids};
use weldsuite_chat_domain::members::remove_channel_member_by_user_id;
use weldsuite_chat_domain::{can_access_channel, get_channel_role, is_channel_moderator};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, unhandled, validate};
use crate::util::{list_limit, list_response, ms_timestamp, now, page, query_map};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create_one).route_layer(gate.require(["channels:create"])),
        )
        .route(
            "/{id}",
            get(detail)
                .patch(update_one)
                .delete(remove_one)
                .route_layer(read()),
        )
}

const ROLES: [&str; 3] = ["owner", "admin", "member"];

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = query_map(raw.as_deref());
    let limit = list_limit(q.get("limit"));
    let Some(channel_id) = q.get("channelId").filter(|c| !c.is_empty()).cloned() else {
        return ApiError::bad_request("channelId query parameter is required").into_response();
    };
    match can_access_channel(&caller.db, &channel_id, &caller.user_id, None).await {
        Ok(true) => {}
        Ok(false) => {
            return ChatError::forbidden("You do not have access to this channel").respond("");
        }
        Err(error) => return unhandled(error.into()),
    }
    let user = q.get("userId").filter(|u| !u.is_empty()).cloned();
    let cursor = match q.get("cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
                "select created_at::text, id from chat_channel_members where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await;
            match row {
                Ok(row) => row.map(|(at, id)| (ms_timestamp(&at), id)),
                Err(error) => return unhandled(error.into()),
            }
        }
        None => None,
    };
    let result = async {
        let (cursor_at, cursor_id) = cursor.unzip();
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from chat_channel_members t
             where t.channel_id = $1 and ($2::text is null or t.user_id = $2)
               and ($3::text is null or (t.created_at < $3::timestamp
                    or (t.created_at = $3::timestamp and t.id < $4)))
             order by t.created_at desc, t.id desc limit $5",
        )
        .bind(&channel_id)
        .bind(&user)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from chat_channel_members t
             where t.channel_id = $1 and ($2::text is null or t.user_id = $2)",
        )
        .bind(&channel_id)
        .bind(&user)
        .fetch_one(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list channel members")
}

async fn member_row(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_channel_members t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = member_row(&caller, &id).await? else {
            return Err(ChatError::not_found("Channel member", Some(&id)));
        };
        let channel = row["channelId"].as_str().unwrap_or_default();
        if !can_access_channel(&caller.db, channel, &caller.user_id, None).await? {
            return Err(ChatError::not_found("Channel member", Some(&id)));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch channel member")
}

/// `checkAddMemberAccess`: the refusal, or `None`.
async fn add_member_denial(
    caller: &Caller,
    channel_id: &str,
    is_self_add: bool,
) -> Result<Option<&'static str>, sqlx::Error> {
    if !is_self_add {
        if is_channel_moderator(&caller.db, channel_id, &caller.user_id).await? {
            return Ok(None);
        }
        return Ok(Some("Only a channel admin can add members"));
    }
    if can_access_channel(&caller.db, channel_id, &caller.user_id, None).await? {
        return Ok(None);
    }
    let kind: Option<String> =
        sqlx::query_scalar("select type from chat_channels where id = $1 limit 1")
            .bind(channel_id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(if kind.as_deref() == Some("public") {
        None
    } else {
        Some("You cannot join this channel")
    })
}

/// `capGrantedRole`: a self-join is a plain member; only an owner grants owner.
async fn cap_granted_role(
    caller: &Caller,
    channel_id: &str,
    is_self_add: bool,
    requested: &str,
) -> Result<String, sqlx::Error> {
    if is_self_add {
        return Ok("member".to_owned());
    }
    if requested != "owner" {
        return Ok(requested.to_owned());
    }
    let role = get_channel_role(&caller.db, channel_id, &caller.user_id).await?;
    Ok(if role.as_deref() == Some("owner") {
        "owner".to_owned()
    } else {
        "admin".to_owned()
    })
}

async fn create_one(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let channel_id = issues.string(body, "channelId", true, Some(1), None);
        let user_id = issues.string(body, "userId", true, Some(1), None);
        let role = issues.choice(body, "role", Presence::Optional, &ROLES).into_option();
        let member_type = issues
            .choice(body, "memberType", Presence::Optional, &["user", "agent"])
            .into_option();
        (
            channel_id.unwrap_or_default(),
            user_id.unwrap_or_default(),
            role,
            member_type,
        )
    });
    let (channel_id, target, role, member_type) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let requested = role.unwrap_or_else(|| "member".to_owned());
    let member_type = member_type.unwrap_or_else(|| "user".to_owned());
    if member_type == "agent" && !target.starts_with("agt_") {
        return ApiError::bad_request(format!("Invalid agent id: {target}")).into_response();
    }
    let prepared: ChatResult<Option<String>> = async {
        if member_type == "agent" {
            let viewer =
                agent_viewer_for(&caller.user_id, caller.permissions.as_ref().map(|p| p.resolved()));
            if !inaccessible_agent_ids(&caller.db, std::slice::from_ref(&target), &viewer)
                .await?
                .is_empty()
            {
                return Err(ChatError::forbidden("You do not have access to this agent"));
            }
        }
        let is_self_add = target == caller.user_id;
        if let Some(denial) = add_member_denial(&caller, &channel_id, is_self_add).await? {
            return Err(ChatError::forbidden(denial));
        }
        let role = cap_granted_role(&caller, &channel_id, is_self_add, &requested).await?;
        let existing: Option<String> = sqlx::query_scalar(
            "select id from chat_channel_members where channel_id = $1 and user_id = $2 limit 1",
        )
        .bind(&channel_id)
        .bind(&target)
        .fetch_optional(&caller.db)
        .await?;
        if let Some(existing) = existing {
            return Err(ChatError::Response(Box::new(
                Data(json!({ "id": existing })).into_response(),
            )));
        }
        Ok(Some(role))
    }
    .await;
    let role = match prepared {
        Ok(Some(role)) => role,
        Ok(None) => return ApiError::internal().into_response(),
        Err(error) => return unhandled(error),
    };
    let result = async {
        let id = generate_id("chm");
        let at = now();
        sqlx::query(
            "insert into chat_channel_members
                (id, channel_id, user_id, role, member_type, created_at, joined_at)
             values ($1, $2, $3, $4, $5, $6::timestamp, $6::timestamp)",
        )
        .bind(&id)
        .bind(&channel_id)
        .bind(&target)
        .bind(&role)
        .bind(&member_type)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "update chat_channels set member_count = member_count + 1, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&channel_id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        let realtime = Caller::realtime(&state);
        realtime.member(&channel_id, &target, "joined").await;
        if member_type == "user" {
            match sqlx::query_scalar::<_, String>("select name from chat_channels where id = $1 limit 1")
                .bind(&channel_id)
                .fetch_optional(&caller.db)
                .await
            {
                Ok(name) => {
                    realtime
                        .channel_new(&org, &target, &channel_id, &name.unwrap_or_default())
                        .await;
                }
                Err(error) => tracing::error!(%error, "[app-api/channel-members] realtime publish failed"),
            }
        }
        Ok((StatusCode::CREATED, axum::Json(json!({ "data": { "id": id } }))).into_response())
    }
    .await;
    answer(result, "Failed to create channel member")
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let role = issues.choice(body, "role", Presence::Optional, &ROLES).into_option();
        let muted = issues.boolean(body, "isMuted", Presence::Optional).into_option();
        let preference = issues
            .choice(
                body,
                "notificationPreference",
                Presence::Optional,
                &["all", "mentions", "none"],
            )
            .into_option();
        let read_at = issues
            .coerce_date(body, "lastReadAt", Presence::Optional)
            .into_option();
        let read_message = issues.text(body, "lastReadMessageId", Presence::Nullish, None, None);
        (role, muted, preference, read_at, read_message)
    });
    let (role, muted, preference, read_at, read_message) = match input {
        Ok(input) => input,
        Err(error) => return error.respond("Failed to update channel member"),
    };
    let result = async {
        let Some(existing) = member_row(&caller, &id).await? else {
            return Err(ChatError::not_found("Channel member", Some(&id)));
        };
        let channel = existing["channelId"].as_str().unwrap_or_default().to_owned();
        let is_self = existing["userId"].as_str() == Some(caller.user_id.as_str());
        let is_mod = is_channel_moderator(&caller.db, &channel, &caller.user_id).await?;
        if !is_self && !is_mod {
            return Err(ChatError::forbidden("You cannot modify this membership"));
        }
        let mut set_role = None;
        if let Some(role) = role
            && is_mod
            && (role != "owner"
                || get_channel_role(&caller.db, &channel, &caller.user_id).await?.as_deref()
                    == Some("owner"))
        {
            set_role = Some(role);
        }
        let (set_read_message, read_message) = match read_message {
            Field::Set(id) => (true, Some(id)),
            Field::Null => (true, None),
            Field::Absent => (false, None),
        };
        let changes = set_role.is_some()
            || muted.is_some()
            || preference.is_some()
            || read_at.is_some()
            || set_read_message;
        if changes {
            sqlx::query(
                "update chat_channel_members set
                    role = coalesce($2, role),
                    is_muted = coalesce($3, is_muted),
                    notification_preference = coalesce($4, notification_preference),
                    last_read_at = coalesce($5::timestamp, last_read_at),
                    last_read_message_id = case when $6 then $7 else last_read_message_id end
                 where id = $1",
            )
            .bind(&id)
            .bind(&set_role)
            .bind(muted)
            .bind(&preference)
            .bind(&read_at)
            .bind(set_read_message)
            .bind(&read_message)
            .execute(&caller.db)
            .await?;
        }
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update channel member")
}

async fn remove_one(State(state): State<ChatState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = member_row(&caller, &id).await? else {
            return Err(ChatError::not_found("Channel member", Some(&id)));
        };
        let channel = existing["channelId"].as_str().unwrap_or_default().to_owned();
        let user = existing["userId"].as_str().unwrap_or_default().to_owned();
        let is_self = user == caller.user_id;
        if !is_self && !is_channel_moderator(&caller.db, &channel, &caller.user_id).await? {
            return Err(ChatError::forbidden("You cannot remove this member"));
        }
        remove_channel_member_by_user_id(&caller.db, &channel, &user, &now()).await?;
        Caller::realtime(&state).member(&channel, &user, "left").await;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete channel member")
}

#[allow(dead_code)]
fn created(id: &str) -> Response {
    Created(json!({ "id": id })).into_response()
}
