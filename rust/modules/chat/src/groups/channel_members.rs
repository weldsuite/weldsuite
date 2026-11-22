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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_chat_domain::agents::{agent_viewer_for, inaccessible_agent_ids};
use weldsuite_chat_domain::members::remove_channel_member_by_user_id;
use weldsuite_chat_domain::{can_access_channel, get_channel_role, is_channel_moderator};
use weldsuite_db::{orm, orm_error, utc_now};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{chat_channel_members as members, chat_channels};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, unhandled, validate};
use crate::groups::channels::{before_cursor, js, millis, sql_limit, timestamp_of};
use crate::util::{list_limit, list_response, now, page, query_map};

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
            let row: Result<Option<(PrimitiveDateTime, String)>, DbErr> = members::Entity::find()
                .select_only()
                .columns([members::Column::CreatedAt, members::Column::Id])
                .filter(members::Column::Id.eq(cursor))
                .into_tuple()
                .one(&orm(&caller.db))
                .await;
            match row {
                Ok(row) => row.map(|(at, id)| (millis(at), id)),
                Err(error) => return unhandled(error.into()),
            }
        }
        None => None,
    };
    let result = async {
        let mut filters = Condition::all().add(members::Column::ChannelId.eq(&channel_id));
        if let Some(user) = &user {
            filters = filters.add(members::Column::UserId.eq(user));
        }
        let db = orm(&caller.db);
        let mut rows = members::Entity::find().filter(filters.clone());
        if let Some(cursor) = &cursor {
            rows = rows.filter(before_cursor(
                members::Column::CreatedAt,
                members::Column::Id,
                cursor,
            ));
        }
        let rows = rows
            .order_by_desc(members::Column::CreatedAt)
            .order_by_desc(members::Column::Id)
            .limit(sql_limit(limit + 1)?)
            .all(&db)
            .await?;
        let total = members::Entity::find().filter(filters).count(&db).await?;
        let rows: Vec<Value> = rows.into_iter().map(js).collect::<Result<_, _>>()?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, "Failed to list channel members")
}

async fn member_row(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    members::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .map(js)
        .transpose()
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
) -> Result<Option<&'static str>, DbErr> {
    if !is_self_add {
        if is_channel_moderator(&caller.db, channel_id, &caller.user_id)
            .await
            .map_err(orm_error)?
        {
            return Ok(None);
        }
        return Ok(Some("Only a channel admin can add members"));
    }
    if can_access_channel(&caller.db, channel_id, &caller.user_id, None)
        .await
        .map_err(orm_error)?
    {
        return Ok(None);
    }
    let kind: Option<String> = chat_channels::Entity::find()
        .select_only()
        .column(chat_channels::Column::Type)
        .filter(chat_channels::Column::Id.eq(channel_id))
        .into_tuple()
        .one(&orm(&caller.db))
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
) -> Result<String, DbErr> {
    if is_self_add {
        return Ok("member".to_owned());
    }
    if requested != "owner" {
        return Ok(requested.to_owned());
    }
    let role = get_channel_role(&caller.db, channel_id, &caller.user_id)
        .await
        .map_err(orm_error)?;
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
        let role = issues
            .choice(body, "role", Presence::Optional, &ROLES)
            .into_option();
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
            let viewer = agent_viewer_for(
                &caller.user_id,
                caller
                    .permissions
                    .as_ref()
                    .map(weldsuite_permissions::Permissions::resolved),
            );
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
        let existing: Option<String> = members::Entity::find()
            .select_only()
            .column(members::Column::Id)
            .filter(members::Column::ChannelId.eq(&channel_id))
            .filter(members::Column::UserId.eq(&target))
            .into_tuple()
            .one(&orm(&caller.db))
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
        let at = utc_now();
        let db = orm(&caller.db);
        members::Entity::insert(members::ActiveModel {
            id: Set(id.clone()),
            channel_id: Set(channel_id.clone()),
            user_id: Set(target.clone()),
            role: Set(role.clone()),
            member_type: Set(member_type.clone()),
            created_at: Set(at),
            joined_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        // One statement, so concurrent joins all count.
        chat_channels::Entity::update_many()
            .col_expr(
                chat_channels::Column::MemberCount,
                sea_orm::ExprTrait::add(Expr::col(chat_channels::Column::MemberCount), 1),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(at))
            .filter(chat_channels::Column::Id.eq(&channel_id))
            .exec(&db)
            .await?;
        let realtime = Caller::realtime(&state);
        realtime.member(&channel_id, &target, "joined").await;
        if member_type == "user" {
            match chat_channels::Entity::find()
                .select_only()
                .column(chat_channels::Column::Name)
                .filter(chat_channels::Column::Id.eq(&channel_id))
                .into_tuple::<String>()
                .one(&db)
                .await
            {
                Ok(name) => {
                    realtime
                        .channel_new(&org, &target, &channel_id, &name.unwrap_or_default())
                        .await;
                }
                Err(error) => {
                    tracing::error!(%error, "[app-api/channel-members] realtime publish failed");
                }
            }
        }
        Ok((
            StatusCode::CREATED,
            axum::Json(json!({ "data": { "id": id } })),
        )
            .into_response())
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
        let role = issues
            .choice(body, "role", Presence::Optional, &ROLES)
            .into_option();
        let muted = issues
            .boolean(body, "isMuted", Presence::Optional)
            .into_option();
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
        let channel = existing["channelId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let is_self = existing["userId"].as_str() == Some(caller.user_id.as_str());
        let is_mod = is_channel_moderator(&caller.db, &channel, &caller.user_id).await?;
        if !is_self && !is_mod {
            return Err(ChatError::forbidden("You cannot modify this membership"));
        }
        let mut set_role = None;
        if let Some(role) = role
            && is_mod
            && (role != "owner"
                || get_channel_role(&caller.db, &channel, &caller.user_id)
                    .await?
                    .as_deref()
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
            // `coalesce($n, column)`: only what the body set (and may set).
            let mut update = members::Entity::update_many();
            if let Some(role) = set_role {
                update = update.col_expr(members::Column::Role, Expr::value(role));
            }
            if let Some(muted) = muted {
                update = update.col_expr(members::Column::IsMuted, Expr::value(muted));
            }
            if let Some(preference) = preference {
                update = update.col_expr(
                    members::Column::NotificationPreference,
                    Expr::value(preference),
                );
            }
            if let Some(read_at) = read_at.as_deref() {
                update = update.col_expr(
                    members::Column::LastReadAt,
                    Expr::value(timestamp_of(read_at)?),
                );
            }
            if set_read_message {
                update = update.col_expr(
                    members::Column::LastReadMessageId,
                    Expr::value(read_message),
                );
            }
            update
                .filter(members::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
                .await?;
        }
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to update channel member")
}

async fn remove_one(
    State(state): State<ChatState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = member_row(&caller, &id).await? else {
            return Err(ChatError::not_found("Channel member", Some(&id)));
        };
        let channel = existing["channelId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let user = existing["userId"].as_str().unwrap_or_default().to_owned();
        let is_self = user == caller.user_id;
        if !is_self && !is_channel_moderator(&caller.db, &channel, &caller.user_id).await? {
            return Err(ChatError::forbidden("You cannot remove this member"));
        }
        remove_channel_member_by_user_id(&caller.db, &channel, &user, &now()).await?;
        Caller::realtime(&state)
            .member(&channel, &user, "left")
            .await;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete channel member")
}

#[allow(dead_code)]
fn created(id: &str) -> Response {
    Created(json!({ "id": id })).into_response()
}
