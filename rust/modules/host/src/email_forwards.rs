//! `/api/email-forwards` (`routes/email-forwards`,
//! `services/email-forwards.ts`): stored forwarding rules. Permissions
//! `email:read|create|update|delete`; events `email_forward:*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::{ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EMAIL_FORWARD_CREATED, EMAIL_FORWARD_DELETED, EMAIL_FORWARD_UPDATED,
};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::email_forwards;
use weldsuite_schema::tenant::enums::HostEmailForwardStatus;

use crate::dns_zones::limit_param;
use crate::listing::list;
use crate::rows::js_option;
use crate::{Caller, HostState, internal, validate, validate_query};

const STATUSES: [&str; 4] = ["active", "pending", "disabled", "error"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list_forwards).route_layer(need("email:read")))
        .route("/", post(create).route_layer(need("email:create")))
        .route("/{id}", get(detail).route_layer(need("email:read")))
        .route("/{id}", patch(update).route_layer(need("email:update")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("email:delete")),
        )
}

/// A live forward.
async fn live(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = email_forwards::Entity::find_by_id(id.to_owned())
        .filter(email_forwards::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A forward, deleted or not.
async fn any(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = email_forwards::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A validated `status` as the column's enum.
fn forward_status(status: &str) -> Result<HostEmailForwardStatus, DbErr> {
    HostEmailForwardStatus::try_from_value(&status.to_owned())
}

async fn list_forwards(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let domain_id = issues
            .text(q, "domainId", Presence::Optional, None, None)
            .into_option();
        // `z.coerce.boolean()`: `Boolean(value)`.
        let enabled = q.get("enabled").map(|value| match value {
            Value::String(text) => !text.is_empty(),
            _ => true,
        });
        let status = issues
            .choice(q, "status", Presence::Optional, &STATUSES)
            .into_option();
        let cursor = issues
            .text(q, "cursor", Presence::Optional, None, None)
            .into_option();
        let limit = limit_param(issues, q, 100.0);
        (domain_id, enabled, status, cursor, limit)
    }) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (domain_id, enabled, status, cursor, limit) = query;
    let page = async {
        let status = status
            .filter(|v| !v.is_empty())
            .map(|status| forward_status(&status))
            .transpose()?;
        let conditions = vec![
            Some(Condition::all().add(email_forwards::Column::DeletedAt.is_null())),
            domain_id
                .filter(|v| !v.is_empty())
                .map(|id| Condition::all().add(email_forwards::Column::DomainId.eq(id))),
            enabled.map(|flag| Condition::all().add(email_forwards::Column::Enabled.eq(flag))),
            status.map(|status| Condition::all().add(email_forwards::Column::Status.eq(status))),
        ];
        list::<email_forwards::Entity>(
            &caller.db,
            (
                email_forwards::Column::CreatedAt,
                email_forwards::Column::Id,
            ),
            conditions,
            cursor.as_deref().filter(|c| !c.is_empty()),
            limit.unwrap_or(25).min(100),
        )
        .await
    }
    .await;
    match page {
        Ok(page) => List::new(
            page.rows,
            Pagination::new(page.total, page.has_more, page.cursor),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to list email forwards"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Email forward", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch email forward"),
    }
}

/// `createEmailForwardSchema` (`partial`: its `.omit({ domainId }).partial()`).
fn forward_fields(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let mut out = Map::new();
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    if !partial
        && let Field::Set(domain_id) =
            issues.text(body, "domainId", Presence::Required, Some(1), None)
    {
        out.insert("domainId".to_owned(), json!(domain_id));
    }
    if let Field::Set(source) = issues.text(body, "source", required, Some(1), Some(255)) {
        out.insert("source".to_owned(), json!(source));
    }
    let email = Text {
        format: Some(Format::Email),
        ..Text::default()
    };
    if let Field::Set(destination) = issues.text_with(
        body,
        "destination",
        required,
        Text {
            max: Some(500),
            ..email
        },
    ) {
        out.insert("destination".to_owned(), json!(destination));
    }
    if let Field::Set(extra) = issues.list(
        body,
        "additionalDestinations",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, email),
    ) {
        out.insert("additionalDestinations".to_owned(), json!(extra));
    }
    for (key, default) in [("enabled", true), ("catchAll", false), ("wildcard", false)] {
        match issues.boolean(body, key, Presence::Optional) {
            Field::Set(flag) => {
                out.insert(key.to_owned(), json!(flag));
            }
            _ if !partial => {
                out.insert(key.to_owned(), json!(default));
            }
            _ => {}
        }
    }
    match issues.choice(body, "status", Presence::Optional, &STATUSES) {
        Field::Set(status) => {
            out.insert("status".to_owned(), json!(status));
        }
        _ if !partial => {
            out.insert("status".to_owned(), json!("active"));
        }
        _ => {}
    }
    out
}

fn event_data(id: &str, row: &Value) -> Value {
    json!({
        "id": id,
        "domainId": row["domainId"],
        "source": row["source"],
        "destination": row["destination"],
        "enabled": row["enabled"],
        "status": row["status"],
    })
}

async fn create(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        forward_fields(issues, body, false)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let id = generate_id("efwd");
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| input.get(key).and_then(Value::as_bool);
    let result: Result<Response, DbErr> = async {
        let forward = email_forwards::ActiveModel {
            id: Set(id.clone()),
            domain_id: Set(text("domainId").unwrap_or_default()),
            source: Set(text("source").unwrap_or_default()),
            destination: Set(text("destination").unwrap_or_default()),
            additional_destinations: Set(input.get("additionalDestinations").cloned()),
            enabled: Set(flag("enabled").unwrap_or(true)),
            catch_all: Set(flag("catchAll")),
            wildcard: Set(flag("wildcard")),
            status: Set(forward_status(&text("status").unwrap_or_default())?),
            ..Default::default()
        };
        email_forwards::Entity::insert(forward)
            .exec_without_returning(&orm(&caller.db))
            .await?;
        let row = any(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(&state, EMAIL_FORWARD_CREATED, &id, &event_data(&id, &row));
        Ok(Created(row).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create email forward"))
}

async fn update(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, |issues, body| {
        forward_fields(issues, body, true)
    }) {
        Ok(patch) => patch,
        Err(response) => return *response,
    };
    let result: Result<Response, DbErr> = async {
        if live(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Email forward", Some(&id)).into_response());
        }
        let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| patch.get(key).and_then(Value::as_bool);
        let mut forward = email_forwards::ActiveModel::default();
        if patch.contains_key("source") {
            forward.source = Set(text("source").unwrap_or_default());
        }
        if patch.contains_key("destination") {
            forward.destination = Set(text("destination").unwrap_or_default());
        }
        if let Some(extra) = patch.get("additionalDestinations") {
            forward.additional_destinations = Set(Some(extra.clone()));
        }
        if let Some(enabled) = flag("enabled") {
            forward.enabled = Set(enabled);
        }
        if patch.contains_key("catchAll") {
            forward.catch_all = Set(flag("catchAll"));
        }
        if patch.contains_key("wildcard") {
            forward.wildcard = Set(flag("wildcard"));
        }
        if patch.contains_key("status") {
            forward.status = Set(forward_status(&text("status").unwrap_or_default())?);
        }
        forward.updated_at = Set(utc_now());
        email_forwards::Entity::update_many()
            .set(forward)
            .filter(email_forwards::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let row = any(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(&state, EMAIL_FORWARD_UPDATED, &id, &event_data(&id, &row));
        Ok(Data(row).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update email forward"))
}

async fn remove(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, DbErr> = async {
        let Some(existing) = live(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Email forward", Some(&id)).into_response());
        };
        let at = utc_now();
        email_forwards::Entity::update_many()
            .set(email_forwards::ActiveModel {
                deleted_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            })
            .filter(email_forwards::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, EMAIL_FORWARD_DELETED, &id, &event_data(&id, &existing));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete email forward"))
}
