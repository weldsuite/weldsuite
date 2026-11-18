//! `/api/panel/cohorts` (`routes/cohorts/index.ts`): saved filters on
//! tracked people, evaluated at query time. Cohorts are shared by the whole
//! workspace; changing or deleting is for the owner, or for
//! `panel_projects:manage`.
//!
//!   GET    /           → cohorts (?projectId)
//!   POST   /           → new cohort
//!   GET    /:id        → one cohort
//!   PATCH  /:id        → name, description, filter
//!   DELETE /:id        → soft delete

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_COHORT_CREATED, PANEL_COHORT_DELETED, PANEL_COHORT_UPDATED,
};
use weldsuite_catalogs::permission_keys::PANEL_PROJECTS_MANAGE;
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::Permissions;
use weldsuite_zod::{Keys, Z};

use crate::saved::{PROJECT_ID, field, project_exists, rows, text};
use crate::schemas_gen::{CREATE_PANEL_COHORT, UPDATE_PANEL_COHORT};
use crate::{Caller, PanelState, unexpected};

const LIST_QUERY: Z = Z::Obj(&[("projectId", Z::Opt(&PROJECT_ID))], Keys::Strip);

/// `toCohortDto(c)`.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "filter": field(row, "filter"),
        "ownerUserId": field(row, "ownerUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `cohortEventData(c)`: never the filter.
fn event_data(row: &Value) -> Value {
    json!({ "id": field(row, "id"), "projectId": field(row, "projectId"), "name": field(row, "name") })
}

fn publish(caller: &Caller, state: &PanelState, cohort: &Value, event: EventName) {
    caller.publish(state, event, text(cohort, "id"), &event_data(cohort));
}

async fn get_cohort(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from panel_cohorts c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `mayChange(c, cohort)`: its owner, or a manager.
fn may_change(caller: &Caller, permissions: &Permissions, cohort: &Value) -> bool {
    text(cohort, "ownerUserId") == caller.user_id || permissions.has_any(&[PANEL_PROJECTS_MANAGE])
}

/// `GET /`.
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from panel_cohorts c
         where c.deleted_at is null and ($1::text is null or c.project_id = $1)
         order by c.name asc limit 500",
    )
    .bind(query.text("projectId"))
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => {
            let cohorts: Vec<Value> = rows(found).iter().map(dto).collect();
            let count = cohorts.len() as u64;
            List::new(cohorts, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list cohorts"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_COHORT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create cohort"),
    }
    let created: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into panel_cohorts as c (id, project_id, name, description, filter, owner_user_id)
         values ($1, $2, $3, $4, $5, $6)
         returning to_jsonb(c)",
    )
    .bind(weldsuite_kit::id::generate_id("pnc"))
    .bind(&project_id)
    .bind(input.text("name"))
    .bind(input.get("description").and_then(Value::as_str))
    .bind(input.get("filter"))
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await;
    match created {
        Ok(row) => {
            let cohort = weldsuite_db::js_row(row);
            publish(&caller, &state, &cohort, PANEL_COHORT_CREATED);
            Created(dto(&cohort)).into_response()
        }
        Err(error) => unexpected(&error, "create cohort"),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match get_cohort(&caller, &id).await {
        Ok(Some(cohort)) => Data(dto(&cohort)).into_response(),
        Ok(None) => ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "get cohort"),
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_COHORT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let existing = match get_cohort(&caller, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "update cohort"),
    };
    if !may_change(&caller, &permissions, &existing) {
        return ApiError::forbidden()
            .with_message("Only the owner can change this cohort")
            .into_response();
    }
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_cohorts as c set
           name = coalesce($2, c.name),
           description = case when $3 then $4 else c.description end,
           filter = coalesce($5, c.filter),
           updated_at = now()
         where c.id = $1 and c.deleted_at is null
         returning to_jsonb(c)",
    )
    .bind(&id)
    .bind(input.get("name").and_then(Value::as_str))
    .bind(input.get("description").is_some())
    .bind(input.get("description").and_then(Value::as_str))
    .bind(input.get("filter"))
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => {
            let cohort = weldsuite_db::js_row(row);
            publish(&caller, &state, &cohort, PANEL_COHORT_UPDATED);
            Data(dto(&cohort)).into_response()
        }
        Ok(None) => ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "update cohort"),
    }
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let existing = match get_cohort(&caller, &id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete cohort"),
    };
    if !may_change(&caller, &permissions, &existing) {
        return ApiError::forbidden()
            .with_message("Only the owner can delete this cohort")
            .into_response();
    }
    let deleted: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_cohorts as c set deleted_at = now(), updated_at = now()
         where c.id = $1 and c.deleted_at is null
         returning to_jsonb(c)",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match deleted {
        Ok(Some(row)) => {
            let cohort = weldsuite_db::js_row(row);
            publish(&caller, &state, &cohort, PANEL_COHORT_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "delete cohort"),
    }
}
