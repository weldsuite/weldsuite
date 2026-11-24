//! `/api/panel/annotations` (`routes/annotations/index.ts`,
//! `services/annotations.ts`): a label pinned to a moment, on every time
//! chart of a project (`reportId` null) or on one report.
//!
//!   GET    /       → ?projectId&from&to(&reportId): the project-wide ones, plus that report's
//!   POST   /       → new annotation (project-wide, or on a report the caller may see)
//!   GET    /:id    → one annotation
//!   PATCH  /:id    → date, label, description, report
//!   DELETE /:id    → soft delete
//!
//! One on a report the caller may not see is a 404. Changing or deleting is
//! for its author, or for `panel_projects:manage`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_ANNOTATION_CREATED, PANEL_ANNOTATION_DELETED, PANEL_ANNOTATION_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::panel_annotations as annotations;

use crate::saved::{Actor, can_change, can_see, field, get_report, js_row, project_exists, text};
use crate::schemas_gen::{
    CREATE_PANEL_ANNOTATION, PANEL_ANNOTATION_LIST_QUERY, UPDATE_PANEL_ANNOTATION,
};
use crate::{Caller, PanelState, unexpected};

/// Annotations listed per request (`MAX_LISTED_ANNOTATIONS`).
const MAX_LISTED: u64 = 1000;

/// `toAnnotationDto(a)`.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "reportId": field(row, "reportId"),
        "occurredAt": field(row, "occurredAt"),
        "label": field(row, "label"),
        "description": field(row, "description"),
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `annotationEventData(a)`: never the description.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "reportId": field(row, "reportId"),
        "occurredAt": field(row, "occurredAt"),
        "label": field(row, "label"),
    })
}

fn publish(caller: &Caller, state: &PanelState, annotation: &Value, event: EventName) {
    caller.publish(
        state,
        event,
        text(annotation, "id"),
        &event_data(annotation),
    );
}

/// `new Date(value).toISOString()`.
fn moment(value: &str) -> Option<String> {
    js::parse_iso(value).map(js::iso_string)
}

/// `new Date(value)`, as the `timestamptz` it is stored as.
fn instant(value: &str) -> Option<OffsetDateTime> {
    let millis = js::parse_iso(value)?;
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
}

/// `boundary(value, edge)`: a day (`YYYY-MM-DD`, UTC) from its start or to
/// its end, else the moment.
fn boundary(value: &str, to: bool) -> Option<String> {
    let is_day = value.len() == 10
        && value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if is_day {
        let time = if to { "23:59:59.999" } else { "00:00:00.000" };
        return moment(&format!("{value}T{time}Z"));
    }
    moment(value)
}

/// `reportVisible(c, reportId, projectId)`.
async fn report_visible(
    caller: &Caller,
    actor: &Actor,
    report_id: &str,
    project_id: &str,
) -> Result<bool, DbErr> {
    Ok(get_report(&caller.db, report_id)
        .await?
        .is_some_and(|report| text(&report, "projectId") == project_id && can_see(&report, actor)))
}

/// `visible(c)`: the annotation when the caller may see it, or the 404.
async fn visible(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    let row = annotations::Entity::find_by_id(id)
        .filter(annotations::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js_row).transpose());
    let annotation = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Err(Box::new(
                ApiError::not_found("Annotation", Some(id)).into_response(),
            ));
        }
        Err(error) => return Err(Box::new(unexpected(&error, "get annotation"))),
    };
    if let Some(report_id) = annotation.get("reportId").and_then(Value::as_str) {
        match report_visible(caller, actor, report_id, text(&annotation, "projectId")).await {
            Ok(true) => {}
            Ok(false) => {
                return Err(Box::new(
                    ApiError::not_found("Annotation", Some(id)).into_response(),
                ));
            }
            Err(error) => return Err(Box::new(unexpected(&error, "get annotation"))),
        }
    }
    Ok(annotation)
}

/// `editable(c)`: the annotation when the caller may change it.
async fn editable(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    let found = visible(caller, actor, id).await?;
    let owned =
        json!({ "ownerUserId": field(&found, "createdByUserId"), "visibility": "workspace" });
    if !can_change(&owned, actor) {
        return Err(Box::new(
            ApiError::forbidden()
                .with_message("Only the author can change this annotation")
                .into_response(),
        ));
    }
    Ok(found)
}

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&PANEL_ANNOTATION_LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let project_id = query.text("projectId").unwrap_or_default().to_owned();
    let report_id = query.text("reportId").map(str::to_owned);
    if let Some(report_id) = &report_id {
        match report_visible(&caller, &actor, report_id, &project_id).await {
            Ok(true) => {}
            Ok(false) => return ApiError::not_found("Report", Some(report_id)).into_response(),
            Err(error) => return unexpected(&error, "list annotations"),
        }
    }
    let mut find = annotations::Entity::find()
        .filter(annotations::Column::ProjectId.eq(&project_id))
        .filter(annotations::Column::DeletedAt.is_null());
    // The project-wide ones, plus that report's.
    find = find.filter(match &report_id {
        Some(report_id) => Condition::any()
            .add(annotations::Column::ReportId.is_null())
            .add(annotations::Column::ReportId.eq(report_id)),
        None => Condition::all().add(annotations::Column::ReportId.is_null()),
    });
    let from = query.text("from").and_then(|from| boundary(from, false));
    if let Some(from) = from.as_deref().and_then(instant) {
        find = find.filter(annotations::Column::OccurredAt.gte(from));
    }
    let to = query.text("to").and_then(|to| boundary(to, true));
    if let Some(to) = to.as_deref().and_then(instant) {
        find = find.filter(annotations::Column::OccurredAt.lte(to));
    }
    let found = find
        .order_by_asc(annotations::Column::OccurredAt)
        .order_by_asc(annotations::Column::Id)
        .limit(MAX_LISTED)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match found {
        Ok(found) => {
            let annotations: Vec<Value> = found.iter().map(dto).collect();
            let count = annotations.len() as u64;
            List::new(annotations, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list annotations"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_ANNOTATION, &headers, &body) {
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
        Err(error) => return unexpected(&error, "create annotation"),
    }
    let actor = Actor::of(&caller, &permissions);
    let report_id = input.text("reportId").map(str::to_owned);
    if let Some(report_id) = &report_id {
        match report_visible(&caller, &actor, report_id, &project_id).await {
            Ok(true) => {}
            Ok(false) => return ApiError::not_found("Report", Some(report_id)).into_response(),
            Err(error) => return unexpected(&error, "create annotation"),
        }
    }
    // The schema checked `occurredAt`; a moment Postgres would not take
    // fails as the insert did.
    let Some(occurred_at) = input.text("occurredAt").and_then(instant) else {
        return unexpected(&"occurredAt is not a moment", "create annotation");
    };
    let created = annotations::Entity::insert(annotations::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnan")),
        project_id: Set(project_id.clone()),
        report_id: Set(report_id.clone()),
        occurred_at: Set(occurred_at),
        label: Set(input.text("label").unwrap_or_default().to_owned()),
        description: Set(input
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)),
        created_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    match created {
        Ok(annotation) => {
            publish(&caller, &state, &annotation, PANEL_ANNOTATION_CREATED);
            Created(dto(&annotation)).into_response()
        }
        Err(error) => unexpected(&error, "create annotation"),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    match visible(&caller, &actor, &id).await {
        Ok(annotation) => Data(dto(&annotation)).into_response(),
        Err(response) => *response,
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
    let input = match weldsuite_zod::json(&UPDATE_PANEL_ANNOTATION, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    if let Some(report_id) = input.text("reportId") {
        match report_visible(&caller, &actor, report_id, text(&found, "projectId")).await {
            Ok(true) => {}
            Ok(false) => return ApiError::not_found("Report", Some(report_id)).into_response(),
            Err(error) => return unexpected(&error, "update annotation"),
        }
    }
    let mut update = annotations::Entity::update_many();
    if let Some(report_id) = input.get("reportId") {
        update = update.col_expr(
            annotations::Column::ReportId,
            Expr::value(report_id.as_str().map(str::to_owned)),
        );
    }
    if let Some(occurred_at) = input.text("occurredAt").and_then(instant) {
        update = update.col_expr(annotations::Column::OccurredAt, Expr::value(occurred_at));
    }
    if let Some(label) = input.get("label").and_then(Value::as_str) {
        update = update.col_expr(annotations::Column::Label, Expr::value(label));
    }
    if let Some(description) = input.get("description") {
        update = update.col_expr(
            annotations::Column::Description,
            Expr::value(description.as_str().map(str::to_owned)),
        );
    }
    let updated = update
        .col_expr(annotations::Column::UpdatedAt, Expr::current_timestamp())
        .filter(annotations::Column::Id.eq(text(&found, "id")))
        .filter(annotations::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    match updated {
        Ok(Some(annotation)) => {
            publish(&caller, &state, &annotation, PANEL_ANNOTATION_UPDATED);
            Data(dto(&annotation)).into_response()
        }
        Ok(None) => ApiError::not_found("Annotation", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "update annotation"),
    }
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let deleted = annotations::Entity::update_many()
        .col_expr(annotations::Column::DeletedAt, Expr::current_timestamp())
        .col_expr(annotations::Column::UpdatedAt, Expr::current_timestamp())
        .filter(annotations::Column::Id.eq(text(&found, "id")))
        .filter(annotations::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    match deleted {
        Ok(Some(annotation)) => {
            publish(&caller, &state, &annotation, PANEL_ANNOTATION_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Annotation", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "delete annotation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_run_from_start_to_end() {
        assert_eq!(
            boundary("2026-10-15", false).as_deref(),
            Some("2026-10-15T00:00:00.000Z")
        );
        assert_eq!(
            boundary("2026-11-30", true).as_deref(),
            Some("2026-11-30T23:59:59.999Z")
        );
        assert_eq!(
            boundary("2026-11-01T09:00:00+01:00", false).as_deref(),
            Some("2026-11-01T08:00:00.000Z")
        );
    }
}
