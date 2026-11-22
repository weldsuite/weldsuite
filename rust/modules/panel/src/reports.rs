//! `/api/panel/reports` (`routes/reports/index.ts`, `services/saved-objects.ts`,
//! `services/report-versions.ts`): saved reports and their versions.
//!
//!   GET    /                                → visible reports (?projectId, ?kind, ?scope)
//!   POST   /                                → new report
//!   GET    /:id                             → one report
//!   PATCH  /:id                             → name, description, visibility, spec (keeps the state before as a version)
//!   DELETE /:id                             → soft delete; the report leaves every dashboard
//!   GET    /:id/versions                    → earlier versions, newest first (without specs)
//!   GET    /:id/versions/:version           → one version with its spec
//!   POST   /:id/versions/:version/restore   → put it back (the current state becomes a version)
//!
//! Someone else's private report is a 404. Changing or deleting is for the
//! owner, or for `panel_projects:manage` on a shared one.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_REPORT_CREATED, PANEL_REPORT_DELETED, PANEL_REPORT_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::panel_reports::{self as reports, Column};
use weldsuite_schema::tenant::{panel_dashboard_tiles, panel_report_versions as versions};
use weldsuite_zod::{Keys, Z};

use crate::saved::{
    Actor, PROJECT_ID, REPORT_SPEC_KINDS, SCOPES, can_change, can_see, field, get_report, js_row,
    js_rows, project_exists, report_dto, report_event_data, report_spec, scope_filter, text,
};
use crate::schemas_gen::{CREATE_PANEL_REPORT, UPDATE_PANEL_REPORT};
use crate::{Caller, PanelState, unexpected};

/// Versions listed per report, newest first (`MAX_LISTED_VERSIONS`).
const MAX_LISTED_VERSIONS: u64 = 100;
/// Reports listed at most.
const MAX_LISTED: u64 = 500;

/// The list's query: `projectId`, `kind` and `scope`, each optional.
const LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", Z::Opt(&PROJECT_ID)),
        ("kind", Z::Opt(&Z::Enum(REPORT_SPEC_KINDS, None))),
        ("scope", Z::Opt(&Z::Enum(SCOPES, None))),
    ],
    Keys::Strip,
);

fn publish(caller: &Caller, state: &PanelState, report: &Value, event: EventName) {
    caller.publish(state, event, text(report, "id"), &report_event_data(report));
}

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let mut select = reports::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .filter(scope_filter(
            Column::OwnerUserId,
            Column::Visibility,
            &actor.user_id,
            query.text("scope").unwrap_or("all"),
        ));
    if let Some(project_id) = query.text("projectId") {
        select = select.filter(Column::ProjectId.eq(project_id));
    }
    if let Some(kind) = query.text("kind") {
        select = select.filter(Column::Kind.eq(kind));
    }
    let found = select
        .order_by_desc(Column::UpdatedAt)
        .limit(MAX_LISTED)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match found {
        Ok(found) => {
            let reports: Vec<Value> = found.iter().map(report_dto).collect();
            let count = reports.len() as u64;
            List::new(reports, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list reports"),
    }
}

/// `createReport(db, input, userId)`.
async fn insert_report(
    db: &PgPool,
    input: &Map<String, Value>,
    user_id: &str,
) -> Result<Value, DbErr> {
    let spec = input.get("spec").cloned().unwrap_or(Value::Null);
    let text_of = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let row = reports::Entity::insert(reports::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnr")),
        // The route checked these against the schema: never missing.
        project_id: Set(text_of(input.get("projectId")).unwrap_or_default()),
        kind: Set(text_of(spec.get("kind")).unwrap_or_default()),
        name: Set(text_of(input.get("name")).unwrap_or_default()),
        description: Set(text_of(input.get("description"))),
        spec: Set(spec),
        owner_user_id: Set(user_id.to_owned()),
        visibility: Set(text_of(input.get("visibility")).unwrap_or_else(|| "private".to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    js_row(row)
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_REPORT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    let spec_project = input
        .get("spec")
        .and_then(|spec| spec.get("projectId"))
        .and_then(Value::as_str);
    if spec_project != Some(project_id.as_str()) {
        return ApiError::bad_request("The spec is for a different project").into_response();
    }
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create report"),
    }
    match insert_report(&caller.db, &input.body, &caller.user_id).await {
        Ok(report) => {
            publish(&caller, &state, &report, PANEL_REPORT_CREATED);
            Created(report_dto(&report)).into_response()
        }
        Err(error) => unexpected(&error, "create report"),
    }
}

/// The report when the caller may see it (`visibleReport`), or the 404.
async fn visible_report(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    match get_report(&caller.db, id).await {
        Ok(Some(report)) if can_see(&report, actor) => Ok(report),
        Ok(_) => Err(Box::new(
            ApiError::not_found("Report", Some(id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get report"))),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    match visible_report(&caller, &actor, &id).await {
        Ok(report) => Data(report_dto(&report)).into_response(),
        Err(response) => *response,
    }
}

/// `stableJson(a) === stableJson(b)`: the same JSON whatever the key order.
fn same_json(a: &Value, b: &Value) -> bool {
    weldsuite_panel_domain::js::json_numbers(a.clone())
        == weldsuite_panel_domain::js::json_numbers(b.clone())
}

/// `changesContent(existing, input)`: the name, description or spec changes.
fn changes_content(existing: &Value, input: &Map<String, Value>) -> bool {
    if let Some(name) = input.get("name")
        && name != &field(existing, "name")
    {
        return true;
    }
    if let Some(description) = input.get("description")
        && description != &field(existing, "description")
    {
        return true;
    }
    input
        .get("spec")
        .is_some_and(|spec| !same_json(spec, &field(existing, "spec")))
}

/// `keepVersion(handle, report, userId)`: the report's current state as its
/// next version, numbered in the same statement (one more than the
/// report's highest).
async fn keep_version(
    db: &impl ConnectionTrait,
    report: &Value,
    user_id: &str,
) -> Result<(), DbErr> {
    let report_id = text(report, "id");
    let next_version = Query::select()
        .expr(sea_orm::ExprTrait::add(
            Func::coalesce([
                Func::max(Expr::col((versions::Entity, versions::Column::Version))).into(),
                Expr::value(0),
            ]),
            1,
        ))
        .from(versions::Entity)
        .and_where(sea_orm::ExprTrait::eq(
            Expr::col((versions::Entity, versions::Column::ReportId)),
            report_id,
        ))
        .to_owned();
    let insert = Query::insert()
        .into_table(versions::Entity)
        .columns([
            versions::Column::Id,
            versions::Column::ReportId,
            versions::Column::Version,
            versions::Column::Name,
            versions::Column::Description,
            versions::Column::Spec,
            versions::Column::CreatedByUserId,
        ])
        .values([
            Expr::value(weldsuite_kit::id::generate_id("pnrv")),
            Expr::value(report_id),
            next_version.into(),
            Expr::value(text(report, "name")),
            Expr::value(report.get("description").and_then(Value::as_str)),
            Expr::value(field(report, "spec")),
            Expr::value(user_id),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .to_owned();
    db.execute(&insert).await?;
    Ok(())
}

/// `reportChanges(input)` applied to a live report: the row after, or
/// `None` when it is gone.
async fn change_report(
    db: &impl ConnectionTrait,
    id: &str,
    input: &Map<String, Value>,
) -> Result<Option<Value>, DbErr> {
    let mut change = reports::Entity::update_many();
    if input.contains_key("name") {
        change = change.col_expr(
            Column::Name,
            Expr::value(input.get("name").and_then(Value::as_str)),
        );
    }
    if input.contains_key("description") {
        change = change.col_expr(
            Column::Description,
            Expr::value(input.get("description").and_then(Value::as_str)),
        );
    }
    if let Some(visibility) = input.get("visibility").and_then(Value::as_str) {
        change = change.col_expr(Column::Visibility, Expr::value(visibility));
    }
    if let Some(spec) = input.get("spec") {
        change = change.col_expr(Column::Spec, Expr::value(spec.clone()));
        if let Some(kind) = spec.get("kind").and_then(Value::as_str) {
            change = change.col_expr(Column::Kind, Expr::value(kind));
        }
    }
    change
        .col_expr(Column::UpdatedAt, Expr::current_timestamp())
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(db)
        .await?
        .into_iter()
        .next()
        .map(js_row)
        .transpose()
}

/// `updateReportWithHistory`: when the name, description or spec changes,
/// the state before is kept as a version, in one transaction with the change.
async fn update_with_history(
    db: &PgPool,
    existing: &Value,
    input: &Map<String, Value>,
    user_id: &str,
) -> Result<Option<Value>, DbErr> {
    let id = text(existing, "id");
    if !changes_content(existing, input) {
        return change_report(&orm(db), id, input).await;
    }
    let tx = orm(db).begin().await?;
    keep_version(&tx, existing, user_id).await?;
    let row = change_report(&tx, id, input).await?;
    tx.commit().await?;
    Ok(row)
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
    let input = match weldsuite_zod::json(&UPDATE_PANEL_REPORT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let existing = match visible_report(&caller, &actor, &id).await {
        Ok(existing) => existing,
        Err(response) => return *response,
    };
    if !can_change(&existing, &actor) {
        return ApiError::forbidden()
            .with_message("Only the owner can change this report")
            .into_response();
    }
    if let Some(spec) = input.get("spec")
        && spec.get("projectId").and_then(Value::as_str) != Some(text(&existing, "projectId"))
    {
        return ApiError::bad_request("The spec is for a different project").into_response();
    }
    match update_with_history(&caller.db, &existing, &input.body, &actor.user_id).await {
        Ok(Some(report)) => {
            publish(&caller, &state, &report, PANEL_REPORT_UPDATED);
            Data(report_dto(&report)).into_response()
        }
        Ok(None) => ApiError::not_found("Report", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "update report"),
    }
}

/// `DELETE /:id`: soft delete, and off every dashboard.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let existing = match visible_report(&caller, &actor, &id).await {
        Ok(existing) => existing,
        Err(response) => return *response,
    };
    if !can_change(&existing, &actor) {
        return ApiError::forbidden()
            .with_message("Only the owner can delete this report")
            .into_response();
    }
    let deleted = reports::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::current_timestamp())
        .col_expr(Column::UpdatedAt, Expr::current_timestamp())
        .filter(Column::Id.eq(&id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    let report = match deleted {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Report", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete report"),
    };
    if let Err(error) = panel_dashboard_tiles::Entity::delete_many()
        .filter(panel_dashboard_tiles::Column::ReportId.eq(&id))
        .exec(&orm(&caller.db))
        .await
    {
        return unexpected(&error, "delete report");
    }
    publish(&caller, &state, &report, PANEL_REPORT_DELETED);
    NoContent.into_response()
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// `toVersionDto(v)`: without the spec.
fn version_dto(row: &Value) -> Value {
    let kind = row
        .get("spec")
        .and_then(|spec| spec.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    json!({
        "id": field(row, "id"),
        "reportId": field(row, "reportId"),
        "version": field(row, "version"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "kind": kind,
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `toVersionDetailDto(v)`.
fn version_detail_dto(row: &Value) -> Value {
    let mut dto = version_dto(row);
    dto["spec"] = field(row, "spec");
    dto
}

/// `z.coerce.number().int().min(1).max(1_000_000)` of the path's version.
fn version_number(raw: &str) -> Option<i32> {
    let number = weldsuite_panel_domain::js::string_to_number(raw);
    (number.fract() == 0.0 && (1.0..=1_000_000.0).contains(&number)).then(|| {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number from 1 to 1,000,000"
        )]
        let whole = number as i32;
        whole
    })
}

async fn get_version(
    db: &PgPool,
    report_id: &str,
    version: i32,
) -> Result<Option<Value>, DbErr> {
    versions::Entity::find()
        .filter(versions::Column::ReportId.eq(report_id))
        .filter(versions::Column::Version.eq(version))
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// `GET /:id/versions`.
pub(crate) async fn versions(
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let report = match visible_report(&caller, &actor, &id).await {
        Ok(report) => report,
        Err(response) => return *response,
    };
    let found = versions::Entity::find()
        .filter(versions::Column::ReportId.eq(text(&report, "id")))
        .order_by_desc(versions::Column::Version)
        .limit(MAX_LISTED_VERSIONS)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match found {
        Ok(found) => {
            let versions: Vec<Value> = found.iter().map(version_dto).collect();
            let count = versions.len() as u64;
            List::new(versions, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list report versions"),
    }
}

/// `GET /:id/versions/:version`.
pub(crate) async fn version(
    caller: Caller,
    permissions: Permissions,
    Path((id, version)): Path<(String, String)>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let report = match visible_report(&caller, &actor, &id).await {
        Ok(report) => report,
        Err(response) => return *response,
    };
    let found = match version_number(&version) {
        Some(number) => get_version(&caller.db, text(&report, "id"), number).await,
        None => Ok(None),
    };
    match found {
        Ok(Some(row)) => Data(version_detail_dto(&row)).into_response(),
        Ok(None) => ApiError::not_found("Version", Some(&version)).into_response(),
        Err(error) => unexpected(&error, "get report version"),
    }
}

/// `POST /:id/versions/:version/restore`.
pub(crate) async fn restore(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path((id, version)): Path<(String, String)>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let report = match visible_report(&caller, &actor, &id).await {
        Ok(report) => report,
        Err(response) => return *response,
    };
    if !can_change(&report, &actor) {
        return ApiError::forbidden()
            .with_message("Only the owner can change this report")
            .into_response();
    }
    let found = match version_number(&version) {
        Some(number) => get_version(&caller.db, text(&report, "id"), number).await,
        None => Ok(None),
    };
    let row = match found {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Version", Some(&version)).into_response(),
        Err(error) => return unexpected(&error, "restore report version"),
    };
    // `restoreVersion`: a spec that no longer parses, or of another project, cannot come back.
    let spec = report_spec(&field(&row, "spec")).filter(|spec| {
        spec.get("projectId").and_then(Value::as_str) == Some(text(&report, "projectId"))
    });
    let Some(spec) = spec else {
        return ApiError::conflict(
            "This version can no longer be opened by the current report builder",
        )
        .into_response();
    };
    let mut changes = Map::new();
    changes.insert("name".to_owned(), field(&row, "name"));
    changes.insert("description".to_owned(), field(&row, "description"));
    changes.insert("spec".to_owned(), Value::Object(spec));
    let restored = async {
        let tx = orm(&caller.db).begin().await?;
        keep_version(&tx, &report, &actor.user_id).await?;
        let row = change_report(&tx, text(&report, "id"), &changes).await?;
        tx.commit().await?;
        Ok::<_, DbErr>(row)
    }
    .await;
    match restored {
        Ok(Some(restored)) => {
            publish(&caller, &state, &restored, PANEL_REPORT_UPDATED);
            Data(report_dto(&restored)).into_response()
        }
        Ok(None) => ApiError::not_found("Report", Some(text(&report, "id"))).into_response(),
        Err(error) => unexpected(&error, "restore report version"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_changes_ignore_key_order_and_visibility() {
        let existing = json!({
            "name": "Weekly", "description": null,
            "spec": { "kind": "trends", "projectId": "p", "series": [{ "event": "a" }] }
        });
        let same = json!({ "spec": { "series": [{ "event": "a" }], "projectId": "p", "kind": "trends" }, "visibility": "workspace" });
        assert!(!changes_content(
            &existing,
            same.as_object().expect("an object")
        ));
        let renamed = json!({ "name": "Daily" });
        assert!(changes_content(
            &existing,
            renamed.as_object().expect("an object")
        ));
        let described = json!({ "description": null });
        assert!(!changes_content(
            &existing,
            described.as_object().expect("an object")
        ));
    }

    #[test]
    fn version_numbers_coerce_like_zod() {
        assert_eq!(version_number("2"), Some(2));
        assert_eq!(version_number("abc"), None);
        assert_eq!(version_number("0"), None);
        assert_eq!(version_number("1.5"), None);
    }
}
