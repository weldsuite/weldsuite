//! `/v1/settings` (`routes/v1/settings/index.ts`): the workspace's settings
//! row (`settings:read`) and its members (`members:read`).

use axum::Json;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use weldsuite_db::js_row;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::Issues;

use crate::list::{ListQuery, list_page, list_sql};
use crate::session::{Key, database_error, not_found};

/// A `workspace_members` row; `hours_per_week` is `numeric`, a string in
/// Drizzle's rows.
macro_rules! member_json {
    () => {
        "to_jsonb(t) || jsonb_build_object('hours_per_week', t.hours_per_week::text)"
    };
}

const MEMBERS: (&str, &str) = list_sql!(
    "workspace_members",
    "to_jsonb(t) || jsonb_build_object('hours_per_week', t.hours_per_week::text)",
    "t.deleted_at is null"
);

/// `GET /workspace`: the settings row, or `null`.
pub(crate) async fn workspace(key: Key) -> Result<Response, ApiError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from workspace_settings s where s.deleted_at is null limit 1",
    )
    .fetch_optional(&key.db)
    .await
    .map_err(|error| database_error(&error))?;
    Ok(Json(json!({ "data": row.map(js_row) })).into_response())
}

/// `GET /members`: the members, newest first, cursor-paged.
pub(crate) async fn members(key: Key, RawQuery(raw): RawQuery) -> Result<Response, ApiError> {
    let mut issues = Issues::default();
    let query = ListQuery::read(&mut issues, raw.as_deref());
    if let Err(invalid) = issues.finish() {
        return Ok(invalid.into_response());
    }
    list_page(&key.db, MEMBERS, &query, &json!({})).await
}

/// `GET /members/:id`: any member row, removed ones included.
pub(crate) async fn member(key: Key, Path(id): Path<String>) -> Result<Response, ApiError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        member_json!(),
        " from workspace_members t where t.id = $1 limit 1"
    ))
    .bind(&id)
    .fetch_optional(&key.db)
    .await
    .map_err(|error| database_error(&error))?;
    let row = row.ok_or_else(|| not_found("Member", &id))?;
    Ok(Json(json!({ "data": js_row(row) })).into_response())
}
