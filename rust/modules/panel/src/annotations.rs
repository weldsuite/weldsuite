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
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_ANNOTATION_CREATED, PANEL_ANNOTATION_DELETED, PANEL_ANNOTATION_UPDATED,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;

use crate::saved::{Actor, can_change, can_see, field, get_report, project_exists, rows, text};
use crate::schemas_gen::{
    CREATE_PANEL_ANNOTATION, PANEL_ANNOTATION_LIST_QUERY, UPDATE_PANEL_ANNOTATION,
};
use crate::{Caller, PanelState, unexpected};

/// Annotations listed per request (`MAX_LISTED_ANNOTATIONS`).
const MAX_LISTED: i64 = 1000;

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
) -> Result<bool, sqlx::Error> {
    Ok(get_report(&caller.db, report_id)
        .await?
        .is_some_and(|report| text(&report, "projectId") == project_id && can_see(&report, actor)))
}

/// `visible(c)`: the annotation when the caller may see it, or the 404.
async fn visible(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(a) from panel_annotations a
         where a.id = $1 and a.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await;
    let annotation = match row {
        Ok(Some(row)) => weldsuite_db::js_row(row),
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
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(a) from panel_annotations a
         where a.project_id = $1 and a.deleted_at is null
           and (a.report_id is null or ($2::text is not null and a.report_id = $2))
           and ($3::timestamptz is null or a.occurred_at >= $3::timestamptz)
           and ($4::timestamptz is null or a.occurred_at <= $4::timestamptz)
         order by a.occurred_at asc, a.id asc limit $5",
    )
    .bind(&project_id)
    .bind(report_id.as_deref())
    .bind(query.text("from").and_then(|from| boundary(from, false)))
    .bind(query.text("to").and_then(|to| boundary(to, true)))
    .bind(MAX_LISTED)
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => {
            let annotations: Vec<Value> = rows(found).iter().map(dto).collect();
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
    let created: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into panel_annotations as a
           (id, project_id, report_id, occurred_at, label, description, created_by_user_id)
         values ($1, $2, $3, $4::timestamptz, $5, $6, $7)
         returning to_jsonb(a)",
    )
    .bind(weldsuite_kit::id::generate_id("pnan"))
    .bind(&project_id)
    .bind(report_id.as_deref())
    .bind(input.text("occurredAt").and_then(moment))
    .bind(input.text("label"))
    .bind(input.get("description").and_then(Value::as_str))
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await;
    match created {
        Ok(row) => {
            let annotation = weldsuite_db::js_row(row);
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
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_annotations as a set
           report_id = case when $2 then $3 else a.report_id end,
           occurred_at = coalesce($4::timestamptz, a.occurred_at),
           label = coalesce($5, a.label),
           description = case when $6 then $7 else a.description end,
           updated_at = now()
         where a.id = $1 and a.deleted_at is null
         returning to_jsonb(a)",
    )
    .bind(text(&found, "id"))
    .bind(input.get("reportId").is_some())
    .bind(input.get("reportId").and_then(Value::as_str))
    .bind(input.text("occurredAt").and_then(moment))
    .bind(input.get("label").and_then(Value::as_str))
    .bind(input.get("description").is_some())
    .bind(input.get("description").and_then(Value::as_str))
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => {
            let annotation = weldsuite_db::js_row(row);
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
    let deleted: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_annotations as a set deleted_at = now(), updated_at = now()
         where a.id = $1 and a.deleted_at is null
         returning to_jsonb(a)",
    )
    .bind(text(&found, "id"))
    .fetch_optional(&caller.db)
    .await;
    match deleted {
        Ok(Some(row)) => {
            let annotation = weldsuite_db::js_row(row);
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
