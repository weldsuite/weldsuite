//! `/api/project-messages` (`routes/project-messages/index.ts`): project
//! chat. Only the sender edits a message (while they may still write to the
//! project); the sender or a project admin deletes it; reactions toggle.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_MESSAGE_CREATED, PROJECT_MESSAGE_DELETED, PROJECT_MESSAGE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, now, outside, reply,
    validate, validate_value,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("projects:create")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("projects:read")),
        )
        .route(
            "/{id}/reactions",
            axum::routing::post(react).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── GET / ───────────────────────────────────────────────────────────────────

struct Filters {
    project_id: Option<String>,
    sender_id: Option<String>,
    page: i64,
    limit: i64,
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let filters = match validate_value(&Value::Object(q.values().clone()), |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Optional, None, None);
        let sender_id = issues.text(fields, "senderId", Presence::Optional, None, None);
        let number = |min: f64, max: Option<f64>| Number {
            coerce: true,
            int: true,
            min: Some(min),
            max,
        };
        let page = issues.whole_number(fields, "page", Presence::Optional, number(1.0, None));
        let limit = issues.whole_number(fields, "limit", Presence::Optional, number(1.0, Some(500.0)));
        Filters {
            project_id: project_id.into_option(),
            sender_id: sender_id.into_option(),
            page: page.into_option().unwrap_or(1),
            limit: limit.into_option().unwrap_or(50),
        }
    }) {
        Ok(filters) => filters,
        Err(refused) => return refused.respond("Invalid query"),
    };
    outside(list_messages(&caller, &filters).await)
}

async fn list_messages(caller: &Caller, f: &Filters) -> Reply {
    let project_id = f.project_id.as_deref().filter(|p| !p.is_empty());
    let (scoped, all, ids) = if let Some(project_id) = project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (false, true, Vec::new())
    } else {
        let (all, ids) = access_scope(caller).await?;
        (true, all, ids)
    };
    let sender = f.sender_id.as_deref().filter(|s| !s.is_empty());
    let offset = (f.page - 1) * f.limit;
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(m) from project_messages m where m.deleted_at is null",
            " and ($1::text is null or m.project_id = $1)",
            " and ($2::bool is not true or ",
            in_accessible!("m.project_id", "$3", "$4"),
            ")",
            " and ($5::text is null or m.sender_id = $5)",
            " order by m.created_at asc limit $6 offset $7"
        ))
        .bind(project_id)
        .bind(scoped)
        .bind(all)
        .bind(&ids)
        .bind(sender)
        .bind(f.limit)
        .bind(offset)
        .fetch_all(&caller.db)
        .await?;
        let total: i32 = sqlx::query_scalar(concat!(
            "select count(*)::int from project_messages m where m.deleted_at is null",
            " and ($1::text is null or m.project_id = $1)",
            " and ($2::bool is not true or ",
            in_accessible!("m.project_id", "$3", "$4"),
            ")",
            " and ($5::text is null or m.sender_id = $5)"
        ))
        .bind(project_id)
        .bind(scoped)
        .bind(all)
        .bind(&ids)
        .bind(sender)
        .fetch_one(&caller.db)
        .await?;
        let has_more = offset + i64::try_from(rows.len()).unwrap_or(0) < i64::from(total);
        Ok(crate::paged(
            rows.into_iter().map(js_row).collect(),
            i64::from(total),
            has_more,
            None,
        ))
    }
    .await;
    Ok(reply(result, "Failed to list project messages"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let row: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(m) from project_messages m where m.id = $1 and m.deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(row) = row.map(js_row) else {
                return Err(Refusal::not_found("Project message", &id));
            };
            if let Some(project) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch project message",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct NewMessage {
    project_id: String,
    message: String,
    message_type: String,
    reply_to_id: Option<String>,
    attachments: Option<Value>,
    metadata: Option<Value>,
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| NewMessage {
        project_id: issues
            .text(fields, "projectId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        message: issues
            .text(fields, "message", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        message_type: issues
            .text(fields, "messageType", Presence::Optional, None, None)
            .into_option()
            .unwrap_or_else(|| "text".to_owned()),
        reply_to_id: issues
            .text(fields, "replyToId", Presence::Optional, None, None)
            .into_option(),
        attachments: fields.get("attachments").cloned(),
        metadata: issues
            .nested(fields, "metadata", Presence::Optional, |_, map| Value::Object(map.clone()))
            .into_option(),
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    match caller.can_write(&input.project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let id = generate_id("pmsg");
            sqlx::query(
                "insert into project_messages
                     (id, project_id, conversation_id, sender_id, message, message_type,
                      reply_to_id, attachments, metadata, is_read, created_at, updated_at)
                 values ($1, $2, $2, $3, $4, $5, $6, $7, $8, false, $9::timestamp, $9::timestamp)",
            )
            .bind(&id)
            .bind(&input.project_id)
            .bind(&user)
            .bind(&input.message)
            .bind(&input.message_type)
            .bind(input.reply_to_id.as_deref())
            .bind(input.attachments.clone().filter(|v| !v.is_null()))
            .bind(input.metadata.clone())
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(
                &state,
                PROJECT_MESSAGE_CREATED,
                &id,
                &json!({ "id": id, "projectId": input.project_id, "senderId": user }),
            );
            Ok(Created(json!({
                "id": id,
                "projectId": input.project_id,
                "senderId": user,
                "message": input.message,
            }))
            .into_response())
        }
        .await,
        "Failed to create project message",
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        let mut data = Map::new();
        if let Field::Set(message) = issues.text(fields, "message", Presence::Optional, Some(1), None) {
            data.insert("message".to_owned(), json!(message));
        }
        if let Field::Set(pinned) = issues.boolean(fields, "isPinned", Presence::Optional) {
            data.insert("isPinned".to_owned(), json!(pinned));
        }
        data
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let existing: Option<(String, Option<String>)> = sqlx::query_as(
                "select sender_id, project_id from project_messages where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some((sender, project)) = existing else {
                return Err(Refusal::not_found("Project message", &id));
            };
            if sender != caller.user_id {
                return Err(Refusal::forbidden("You can only edit your own messages"));
            }
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            // `is_pinned` is not a column: Drizzle drops unknown keys from a set.
            sqlx::query(
                "update project_messages set
                     message = coalesce($2, message),
                     edited_at = case when $2::text is not null then $3::timestamp else edited_at end,
                     updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(data.get("message").and_then(Value::as_str))
            .bind(now())
            .execute(&caller.db)
            .await?;
            let mut out = data.clone();
            out.insert("id".to_owned(), json!(id));
            let out = Value::Object(out);
            caller.publish(&state, PROJECT_MESSAGE_UPDATED, &id, &out);
            Ok(Data(out).into_response())
        }
        .await,
        "Failed to update project message",
    )
}

// ── POST /:id/reactions ─────────────────────────────────────────────────────

async fn react(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let emoji = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "emoji", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(emoji) => emoji,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(
        async {
            let existing: Option<(Option<Value>, Option<String>)> = sqlx::query_as(
                "select reactions, project_id from project_messages where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some((reactions, project)) = existing else {
                return Err(Refusal::not_found("Project message", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            let mut reactions = match reactions {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };
            let mut users: Vec<Value> = reactions
                .get(&emoji)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(at) = users.iter().position(|u| u.as_str() == Some(user.as_str())) {
                users.remove(at);
            } else {
                users.push(json!(user));
            }
            if users.is_empty() {
                reactions.remove(&emoji);
            } else {
                reactions.insert(emoji.clone(), Value::Array(users));
            }
            let reactions = Value::Object(reactions);
            sqlx::query(
                "update project_messages set reactions = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(&reactions)
            .bind(now())
            .execute(&caller.db)
            .await?;
            let out = json!({ "id": id, "reactions": reactions });
            caller.publish(&state, PROJECT_MESSAGE_UPDATED, &id, &out);
            Ok(Data(out).into_response())
        }
        .await,
        "Failed to toggle reaction",
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let existing: Option<(String, Option<String>)> = sqlx::query_as(
                "select sender_id, project_id from project_messages where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some((sender, project)) = existing else {
                return Err(Refusal::not_found("Project message", &id));
            };
            let is_author = sender == caller.user_id;
            let mut can_moderate = false;
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty()) {
                let access = caller.access(project).await?;
                if !access.may_access() {
                    return Err(Refusal::forbidden(PROJECT_DENIED));
                }
                can_moderate = access.is_admin;
            }
            if !is_author && !can_moderate {
                return Err(Refusal::forbidden("You can only delete your own messages"));
            }
            sqlx::query(
                "update project_messages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_MESSAGE_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete project message",
    )
}
