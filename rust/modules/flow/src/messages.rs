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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_MESSAGE_CREATED, PROJECT_MESSAGE_DELETED, PROJECT_MESSAGE_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_messages;

use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, in_accessible, row_json,
    json_rows, outside, reply, validate, validate_value,
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
        let limit = issues.whole_number(
            fields,
            "limit",
            Presence::Optional,
            number(1.0, Some(500.0)),
        );
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

/// The live message's sender and project, `None` when there is no such
/// message.
async fn message_author(
    db: &PgPool,
    id: &str,
) -> Result<Option<(String, Option<String>)>, DbErr> {
    use project_messages::Column;
    project_messages::Entity::find_by_id(id)
        .select_only()
        .columns([Column::SenderId, Column::ProjectId])
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// The list's `where`: live messages of the project (or of the caller's
/// projects), from the sender when one is given.
fn message_filters(
    project_id: Option<&str>,
    scope: Option<&(bool, Vec<String>)>,
    sender: Option<&str>,
) -> Condition {
    use project_messages::Column;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(project_id) = project_id {
        filters = filters.add(Column::ProjectId.eq(project_id));
    }
    if let Some(scope) = scope {
        filters = filters.add(in_accessible(Column::ProjectId, scope));
    }
    if let Some(sender) = sender {
        filters = filters.add(Column::SenderId.eq(sender));
    }
    filters
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
        let scope = (all, ids);
        let filters = message_filters(project_id, scoped.then_some(&scope), sender);
        let rows = project_messages::Entity::find()
            .filter(filters.clone())
            .order_by_asc(project_messages::Column::CreatedAt)
            .limit(u64::try_from(f.limit).unwrap_or(0))
            .offset(u64::try_from(offset).unwrap_or(0))
            .all(&orm(&caller.db))
            .await?;
        let total = project_messages::Entity::find()
            .filter(filters)
            .count(&orm(&caller.db))
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let has_more = offset + i64::try_from(rows.len()).unwrap_or(0) < total;
        Ok(crate::paged(json_rows(rows)?, total, has_more, None))
    }
    .await;
    Ok(reply(result, "Failed to list project messages"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let row = project_messages::Entity::find_by_id(id.as_str())
                .filter(project_messages::Column::DeletedAt.is_null())
                .one(&orm(&caller.db))
                .await?;
            let Some(row) = row.map(row_json).transpose()? else {
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
            .nested(fields, "metadata", Presence::Optional, |_, map| {
                Value::Object(map.clone())
            })
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
            let now = utc_now();
            project_messages::Entity::insert(project_messages::ActiveModel {
                id: Set(id.clone()),
                project_id: Set(Some(input.project_id.clone())),
                conversation_id: Set(input.project_id.clone()),
                sender_id: Set(user.clone()),
                message: Set(input.message.clone()),
                message_type: Set(input.message_type.clone()),
                reply_to_id: Set(input.reply_to_id.clone()),
                attachments: Set(input.attachments.clone().filter(|v| !v.is_null())),
                metadata: Set(input.metadata.clone()),
                is_read: Set(false),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&orm(&caller.db))
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
        if let Field::Set(message) =
            issues.text(fields, "message", Presence::Optional, Some(1), None)
        {
            data.insert("message".to_owned(), json!(message));
        }
        if let Field::Set(pinned) = issues.boolean(fields, "isPinned", Presence::Optional) {
            data.insert("isPinned".to_owned(), json!(pinned));
        }
        if let Field::Set(visible) = issues.boolean(fields, "clientVisible", Presence::Optional) {
            data.insert("clientVisible".to_owned(), json!(visible));
        }
        data
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let Some((sender, project)) = message_author(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Project message", &id));
            };
            // Sharing with the client is the one change a project admin may make
            // on someone else's message; anything else still needs the sender.
            let only_client_visible = data.len() == 1 && data.contains_key("clientVisible");
            let mut admin_share = false;
            if sender != caller.user_id
                && only_client_visible
                && let Some(project) = project.as_deref().filter(|p| !p.is_empty())
            {
                admin_share = caller.access(project).await?.is_admin;
            }
            if sender != caller.user_id && !admin_share {
                return Err(Refusal::forbidden("You can only edit your own messages"));
            }
            if !admin_share
                && let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            // `is_pinned` is not a column: Drizzle drops unknown keys from a set.
            {
                use project_messages::Column;
                let now = utc_now();
                let mut update = project_messages::Entity::update_many();
                if let Some(message) = data.get("message").and_then(Value::as_str) {
                    update = update
                        .col_expr(Column::Message, Expr::value(message))
                        .col_expr(Column::EditedAt, Expr::value(now));
                }
                if let Some(visible) = data.get("clientVisible").and_then(Value::as_bool) {
                    update = update.col_expr(Column::ClientVisible, Expr::value(visible));
                }
                update
                    .col_expr(Column::UpdatedAt, Expr::value(now))
                    .filter(Column::Id.eq(id.as_str()))
                    .exec(&orm(&caller.db))
                    .await?;
            }
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
            let existing: Option<(Option<Value>, Option<String>)> = {
                use project_messages::Column;
                project_messages::Entity::find_by_id(id.as_str())
                    .select_only()
                    .columns([Column::Reactions, Column::ProjectId])
                    .filter(Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await?
            };
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
            project_messages::Entity::update_many()
                .col_expr(
                    project_messages::Column::Reactions,
                    Expr::value(reactions.clone()),
                )
                .col_expr(project_messages::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(project_messages::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
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

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some((sender, project)) = message_author(&caller.db, &id).await? else {
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
            let now = utc_now();
            project_messages::Entity::update_many()
                .col_expr(project_messages::Column::DeletedAt, Expr::value(now))
                .col_expr(project_messages::Column::UpdatedAt, Expr::value(now))
                .filter(project_messages::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(&state, PROJECT_MESSAGE_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete project message",
    )
}
