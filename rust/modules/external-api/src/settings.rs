//! `/v1/settings` (`routes/v1/settings/index.ts`): the workspace's settings
//! row (`settings:read`) and its members (`members:read`).

use axum::Json;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use weldsuite_db::orm;
use weldsuite_db::record::JsonTable;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::Issues;
use weldsuite_schema::tenant::{workspace_members, workspace_settings};

use crate::list::{ListQuery, list_page};
use crate::session::{Key, database_error, not_found};

/// `workspace_members` as Drizzle reads it (`hours_per_week`, a `numeric`,
/// a string).
const MEMBERS: JsonTable = JsonTable::of::<workspace_members::Entity>();

/// A model as Drizzle's row.
fn to_json<T: serde::Serialize>(model: T) -> Result<Value, ApiError> {
    serde_json::to_value(model).map_err(|error| database_error(&DbErr::Json(error.to_string())))
}

/// `GET /workspace`: the settings row, or `null`.
pub(crate) async fn workspace(key: Key) -> Result<Response, ApiError> {
    let row = workspace_settings::Entity::find()
        .filter(workspace_settings::Column::DeletedAt.is_null())
        .one(&orm(&key.db))
        .await
        .map_err(|error| database_error(&error))?;
    let row = row.map(to_json).transpose()?;
    Ok(Json(json!({ "data": row })).into_response())
}

/// `GET /members`: the members, newest first, cursor-paged.
pub(crate) async fn members(key: Key, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let mut issues = Issues::default();
    let query = ListQuery::read(&mut issues, raw.as_deref());
    if let Err(invalid) = issues.finish() {
        return Ok(invalid.into_response());
    }
    let live = Condition::all().add(workspace_members::Column::DeletedAt.is_null());
    list_page(&key.db, &MEMBERS, live, &query).await
}

/// `GET /members/:id`: any member row, removed ones included.
pub(crate) async fn member(key: Key, Path(id): Path<String>) -> Result<Response, ApiError> {
    let row = workspace_members::Entity::find_by_id(id.clone())
        .one(&orm(&key.db))
        .await
        .map_err(|error| database_error(&error))?;
    let row = row.ok_or_else(|| not_found("Member", &id))?;
    Ok(Json(json!({ "data": to_json(row)? })).into_response())
}
