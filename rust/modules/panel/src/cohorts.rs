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
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_COHORT_CREATED, PANEL_COHORT_DELETED, PANEL_COHORT_UPDATED,
};
use weldsuite_catalogs::permission_keys::PANEL_PROJECTS_MANAGE;
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::panel_cohorts as cohorts;
use weldsuite_zod::{Keys, Z};

use crate::saved::{PROJECT_ID, field, js_row, project_exists, text};
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

async fn get_cohort(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    cohorts::Entity::find_by_id(id)
        .filter(cohorts::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(js_row)
        .transpose()
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
    let mut find = cohorts::Entity::find().filter(cohorts::Column::DeletedAt.is_null());
    if let Some(project_id) = query.text("projectId") {
        find = find.filter(cohorts::Column::ProjectId.eq(project_id));
    }
    let found = find
        .order_by_asc(cohorts::Column::Name)
        .limit(500)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match found {
        Ok(found) => {
            let cohorts: Vec<Value> = found.iter().map(dto).collect();
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
    let created = cohorts::Entity::insert(cohorts::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnc")),
        project_id: Set(project_id.clone()),
        name: Set(input.text("name").unwrap_or_default().to_owned()),
        description: Set(input
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)),
        filter: Set(input.get("filter").cloned().unwrap_or(Value::Null)),
        owner_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    match created {
        Ok(cohort) => {
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
    let mut update = cohorts::Entity::update_many();
    if let Some(name) = input.get("name").and_then(Value::as_str) {
        update = update.col_expr(cohorts::Column::Name, Expr::value(name));
    }
    if let Some(description) = input.get("description") {
        update = update.col_expr(
            cohorts::Column::Description,
            Expr::value(description.as_str().map(str::to_owned)),
        );
    }
    if let Some(filter) = input.get("filter") {
        update = update.col_expr(cohorts::Column::Filter, Expr::value(filter.clone()));
    }
    let updated = update
        .col_expr(cohorts::Column::UpdatedAt, Expr::current_timestamp())
        .filter(cohorts::Column::Id.eq(&id))
        .filter(cohorts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    match updated {
        Ok(Some(cohort)) => {
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
    let deleted = cohorts::Entity::update_many()
        .col_expr(cohorts::Column::DeletedAt, Expr::current_timestamp())
        .col_expr(cohorts::Column::UpdatedAt, Expr::current_timestamp())
        .filter(cohorts::Column::Id.eq(&id))
        .filter(cohorts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    match deleted {
        Ok(Some(cohort)) => {
            publish(&caller, &state, &cohort, PANEL_COHORT_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Cohort", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "delete cohort"),
    }
}
