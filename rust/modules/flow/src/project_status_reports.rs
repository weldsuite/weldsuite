//! `/api/project-status-reports` (`routes/project-status-reports/index.ts`):
//! status reports, drafted from project data, edited by the project manager
//! and frozen when published (ADR FLOW-018).
//!
//! ```text
//! GET    /                    list of a project's reports (projectId required, cursor)
//! GET    /settings/:projectId the schedule (`statusReport`) and the risk appetite
//! PUT    /settings/:projectId merge-write them into `projects.settings`
//! GET    /:id                 report, with who it goes to
//! POST   /                    draft a report for a period
//! PATCH  /:id                 edit a draft
//! POST   /:id/refresh         recompute the data of a draft
//! POST   /:id/publish         freeze, set the project's health, send
//! DELETE /:id                 discard a draft
//! ```
//!
//! The checks run in TypeScript's order: permission, the report (404), project
//! access (403), the body (400), then the business rules.

#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::similar_names,
    clippy::single_match_else
)]

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_STATUS_REPORT_CREATED, PROJECT_STATUS_REPORT_DELETED,
    PROJECT_STATUS_REPORT_PUBLISHED, PROJECT_STATUS_REPORT_UPDATED, PROJECT_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_flow_domain::js::parse_int;
use weldsuite_flow_domain::status_report::{
    OVERALL_REQUIRED, PERIOD_DRAFT_EXISTS, PUBLISHED_IMMUTABLE, SUMMARY_REQUIRED, default_period,
    event_data, health_for_colour, merge_areas, merge_items, merge_overall, next_slot_after,
    present_report, present_summary, stored_item, window_days,
};
use weldsuite_kit::{Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{project_status_reports as reports, projects};

use crate::raid_body::parse_body;
use crate::reporting_body::{
    read_create_report, read_put_settings, read_update_report, report_list_query,
};
use crate::reporting_notify::{NotifyContext, send_published_report};
use crate::reporting_store::{
    ReportProject, compute_report, find_report, insert_draft, instant, load_report_project,
    present_target, reports_of_period, risk_appetite_of, schedule_of, stakeholders_of_project,
    superseded_by_map, targets_of,
};
use crate::{
    Caller, FlowState, Refusal, Reply, fetch_limit, json_rows, keyset_before, keyset_cursor_tz,
    outside, page, paged, reply, row_json,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_MANAGE_DENIED: &str = "You do not have manage access to this project";
const REPORT_LABEL: &str = "Status report";
const RECIPIENT_NOT_FOUND: &str = "Recipient not found in this project";
const ALREADY_PUBLISHED: &str = "This report is already published";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:update")))
        .route(
            "/settings/{projectId}",
            get(get_settings).route_layer(need("projects:read")),
        )
        .route(
            "/settings/{projectId}",
            put(put_settings).route_layer(need("projects:update")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:update")))
        .route(
            "/{id}/refresh",
            post(refresh).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/publish",
            post(publish).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn iso(ms: i64) -> String {
    weldsuite_flow_domain::js::iso_from_millis(ms).unwrap_or_default()
}

fn publish_report(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        text(row, "id").unwrap_or_default(),
        &event_data(row),
    );
}

/// `parseLimit(raw, fallback, max)`.
fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

/// The report as every route answers it.
async fn present_one(
    caller: &Caller,
    row: &Value,
    project: Option<&ReportProject>,
) -> Result<Value, DbErr> {
    let id = text(row, "id").unwrap_or_default().to_owned();
    let superseding = superseded_by_map(&caller.db, std::slice::from_ref(&id)).await?;
    let recipients: Vec<Value> = if text(row, "status") == Some("published") {
        let frozen = row["snapshot"]["recipients"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        frozen
            .iter()
            .map(|entry| {
                json!({
                    "stakeholderId": entry.get("stakeholderId").cloned().unwrap_or(Value::Null),
                    "userId": entry.get("userId").cloned().unwrap_or(Value::Null),
                    "name": entry.get("name").cloned().unwrap_or(Value::Null),
                    "email": null,
                    "kind": entry.get("kind").cloned().unwrap_or(Value::Null),
                })
            })
            .collect()
    } else if let Some(project) = project {
        targets_of(&caller.db, project, row.get("recipients"))
            .await?
            .iter()
            .map(present_target)
            .collect()
    } else {
        Vec::new()
    };
    Ok(present_report(
        row,
        superseding.get(&id).map(String::as_str),
        recipients,
    ))
}

/// Whether `ids` names someone who is not on the project's register.
async fn unknown_recipients(
    caller: &Caller,
    project_id: &str,
    ids: &[Value],
) -> Result<bool, DbErr> {
    if ids.is_empty() {
        return Ok(false);
    }
    let register = stakeholders_of_project(&caller.db, project_id).await?;
    Ok(ids
        .iter()
        .any(|id| !register.iter().any(|row| row.get("id") == Some(id))))
}

fn settings_response(project: &ReportProject, now: i64) -> Value {
    let schedule = schedule_of(project);
    json!({
        "projectId": project.id,
        "statusReport": schedule.as_ref().map(|s| json!({
            "cadence": s.cadence, "weekday": s.weekday, "hour": s.hour, "recipients": s.recipients_json,
        })),
        "riskAppetite": risk_appetite_of(project),
        "nextDraftAt": schedule.as_ref().map(|s| iso(next_slot_after(&s.cadence, s.weekday, now))),
    })
}

/// A project as `projectAnalyticsPayload` reads it.
async fn project_payload(db: &PgPool, project_id: &str) -> Result<Option<Value>, DbErr> {
    projects::Entity::find_by_id(project_id)
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

pub(crate) async fn publish_project_updated(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    name: &str,
) -> Result<(), DbErr> {
    let full = project_payload(&caller.db, project_id).await?;
    let payload = match full {
        Some(Value::Object(map)) => crate::projects::analytics_payload(&map),
        _ => {
            let mut map = Map::new();
            map.insert("id".to_owned(), json!(project_id));
            map.insert("name".to_owned(), json!(name));
            crate::projects::analytics_payload(&map)
        }
    };
    caller.publish(state, PROJECT_UPDATED, project_id, &payload);
    Ok(())
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller, Path(project_id): Path<String>) -> Response {
    let result: Reply = async {
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        Ok(Data(settings_response(&project, caller.now_ms())).into_response())
    }
    .await;
    reply(result, "Failed to load the status report settings")
}

async fn put_settings(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let input = parse_body(&body, read_put_settings)?;
        if let Some(ids) = input
            .get("statusReport")
            .and_then(|s| s["recipients"]["stakeholderIds"].as_array())
            && unknown_recipients(&caller, &project_id, ids).await?
        {
            return Err(Refusal::bad_request(RECIPIENT_NOT_FOUND));
        }
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_settings(&state, &caller, &project, &input).await,
        "Failed to update the status report settings",
    )
}

async fn write_settings(
    state: &FlowState,
    caller: &Caller,
    project: &ReportProject,
    input: &Map<String, Value>,
) -> Reply {
    // A merge write of only the keys sent: `settings` carries other features' keys.
    let mut patch = Map::new();
    let status_report = input.get("statusReport");
    if let Some(report) = status_report.filter(|v| !v.is_null()) {
        patch.insert("statusReport".to_owned(), report.clone());
    }
    if let Some(appetite) = input.get("riskAppetite") {
        patch.insert("riskAppetite".to_owned(), appetite.clone());
    }
    // `coalesce(settings, '{}'::jsonb)`, without `statusReport` when it is
    // cleared, with the patch over it.
    let mut merged = Expr::from(Func::coalesce([
        Expr::col(projects::Column::Settings),
        sea_orm::ExprTrait::cast_as(Expr::val(json!({})), "jsonb"),
    ]));
    if status_report.is_some_and(Value::is_null) {
        merged = sea_orm::ExprTrait::sub(merged, "statusReport");
    }
    if !patch.is_empty() {
        merged = sea_orm::sea_query::extension::postgres::PgExpr::concat(
            merged,
            sea_orm::ExprTrait::cast_as(Expr::val(Value::Object(patch)), "jsonb"),
        );
    }
    let touched = status_report.is_some() || input.contains_key("riskAppetite");
    let now = caller.now_ms();
    if touched {
        projects::Entity::update_many()
            .col_expr(projects::Column::Settings, merged)
            .col_expr(
                projects::Column::UpdatedAt,
                Expr::value(utc_timestamp(instant(now))),
            )
            .filter(projects::Column::Id.eq(&project.id))
            .filter(projects::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
    }
    let Some(row) = load_report_project(&caller.db, &project.id).await? else {
        return Err(Refusal::not_found("Project", &project.id));
    };
    if touched {
        publish_project_updated(state, caller, &project.id, &project.name).await?;
        if status_report.is_some_and(|v| !v.is_null())
            && let Some(master) = caller.master(state)
        {
            weldsuite_db::due_index::mark_due(
                &master,
                "status_report_due",
                &caller.workspace_id,
                OffsetDateTime::from_unix_timestamp_nanos(i128::from(now) * 1_000_000)
                    .unwrap_or_else(|_| OffsetDateTime::now_utc()),
            )
            .await;
        }
    }
    Ok(Data(settings_response(&row, now)).into_response())
}

// ── Reads ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match report_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 25, 100);
    let checked: Result<Option<(OffsetDateTime, String)>, Refusal> = async {
        if !caller.can_access(&q.project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        Ok(match &q.cursor {
            Some(cursor) => {
                keyset_cursor_tz(
                    &caller.db,
                    reports::Column::Id,
                    reports::Column::CreatedAt,
                    cursor,
                )
                .await?
            }
            None => None,
        })
    }
    .await;
    let cursor = match checked {
        Ok(cursor) => cursor,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        list_reports(&caller, &q.project_id, q.status.as_deref(), limit, cursor).await,
        "Failed to list status reports",
    )
}

async fn list_reports(
    caller: &Caller,
    project_id: &str,
    status: Option<&str>,
    limit: i64,
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    use reports::Column;
    let db = &caller.db;
    let live = || {
        let mut find = reports::Entity::find()
            .filter(Column::DeletedAt.is_null())
            .filter(Column::ProjectId.eq(project_id));
        if let Some(status) = status {
            find = find.filter(Column::Status.eq(status));
        }
        find
    };
    let mut rows = live();
    if let Some(cursor) = &cursor {
        rows = rows.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
    }
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let total = i64::try_from(live().count(&orm(db)).await?).unwrap_or(i64::MAX);
    let (rows, has_more, next) = page(json_rows(rows)?, limit);
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let superseding = superseded_by_map(db, &ids).await?;
    let items = rows
        .iter()
        .map(|row| {
            present_summary(
                row,
                text(row, "id")
                    .and_then(|id| superseding.get(id))
                    .map(String::as_str),
            )
        })
        .collect();
    Ok(paged(items, total, has_more, next))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let Some(row) = find_report(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REPORT_LABEL, &id));
        };
        let project_id = text(&row, "projectId").unwrap_or_default().to_owned();
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let project = load_report_project(&caller.db, &project_id).await?;
        Ok(Data(present_one(&caller, &row, project.as_ref()).await?).into_response())
    }
    .await;
    reply(result, "Failed to fetch status report")
}

// ── Create ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_report)?;
        let project_id = input
            .get("projectId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_report(&state, &caller, &project, &input).await,
        "Failed to create status report",
    )
}

async fn create_report(
    state: &FlowState,
    caller: &Caller,
    project: &ReportProject,
    input: &Map<String, Value>,
) -> Reply {
    let now = caller.now_ms();
    let schedule = schedule_of(project);
    let period = match input.get("period").and_then(Value::as_str) {
        Some(period) => period.to_owned(),
        None => default_period(
            schedule.as_ref().map(|s| (s.cadence.as_str(), s.weekday)),
            now,
        ),
    };
    let existing = reports_of_period(&caller.db, &project.id, &period).await?;
    if existing
        .iter()
        .any(|row| text(row, "status") == Some("draft"))
    {
        return Err(Refusal::conflict(PERIOD_DRAFT_EXISTS));
    }
    // A new report for a period that has a published one corrects it.
    let superseded = existing
        .iter()
        .find(|row| text(row, "status") == Some("published"));
    let Some(row) = insert_draft(
        &caller.db,
        project,
        &period,
        now,
        &caller.user_id,
        superseded,
    )
    .await?
    else {
        return Err(Refusal::Internal("the new report is missing".to_owned()));
    };
    publish_report(state, caller, PROJECT_STATUS_REPORT_CREATED, &row);
    Ok(Created(present_one(caller, &row, Some(project)).await?).into_response())
}

// ── Edit a draft ────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_report(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REPORT_LABEL, &id));
        };
        let project_id = text(&existing, "projectId").unwrap_or_default().to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let input = parse_body(&body, read_update_report)?;
        if text(&existing, "status") == Some("published") {
            return Err(Refusal::conflict(PUBLISHED_IMMUTABLE));
        }
        if let Some(ids) = input
            .get("recipients")
            .and_then(|r| r["stakeholderIds"].as_array())
            && unknown_recipients(&caller, &project_id, ids).await?
        {
            return Err(Refusal::bad_request(RECIPIENT_NOT_FOUND));
        }
        Ok((existing, input))
    }
    .await;
    let (existing, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_report(&state, &caller, &id, &existing, &input).await,
        "Failed to update status report",
    )
}

/// The areas after the edits: an override, or back to the computed colour.
fn edited_areas(existing: &Value, edits: &[Value]) -> Vec<Value> {
    let computed = &existing["snapshot"]["computed"]["areas"];
    let mut areas: Vec<Value> = existing["areas"].as_array().cloned().unwrap_or_default();
    for edit in edits {
        let key = text(edit, "key").unwrap_or_default();
        let Some(index) = areas.iter().position(|a| text(a, "key") == Some(key)) else {
            continue;
        };
        areas[index] = match edit.get("override").filter(|o| !o.is_null()) {
            Some(over) => {
                json!({ "key": key, "colour": over["colour"], "reason": over["reason"], "auto": false })
            }
            None => {
                let colour = computed
                    .get(key)
                    .and_then(|c| c.get("colour"))
                    .cloned()
                    .unwrap_or_else(|| areas[index]["colour"].clone());
                json!({ "key": key, "colour": colour, "reason": null, "auto": true })
            }
        };
    }
    areas
}

async fn update_report(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Map<String, Value>,
) -> Reply {
    use reports::Column;
    let mut update = reports::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(instant(caller.now_ms())));
    if let Some(summary) = input.get("summary") {
        let summary = summary
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        update = update.col_expr(Column::Summary, Expr::value(summary));
    }
    if let Some(overall) = input.get("overall").and_then(Value::as_str) {
        update = update.col_expr(Column::Overall, Expr::value(overall));
    }
    if let Some(edits) = input.get("areas").and_then(Value::as_array) {
        let areas = Value::Array(edited_areas(existing, edits));
        update = update.col_expr(Column::Areas, Expr::value(areas));
    }
    for (key, column) in [("done", Column::Done), ("next", Column::Next)] {
        if let Some(items) = input.get(key).and_then(Value::as_array) {
            let stored = items
                .iter()
                .filter_map(Value::as_object)
                .map(stored_item)
                .collect();
            update = update.col_expr(column, Expr::value(Value::Array(stored)));
        }
    }
    if let Some(flag) = input.get("clientVisible").and_then(Value::as_bool) {
        update = update.col_expr(Column::ClientVisible, Expr::value(flag));
    }
    if let Some(recipients) = input.get("recipients") {
        // A JSON `null` here, as the jsonb parameter carried it.
        let stored = match recipients {
            Value::Object(map) => match map.get("stakeholderIds") {
                Some(ids) if !ids.is_null() => json!({ "stakeholderIds": ids }),
                _ => json!({}),
            },
            _ => Value::Null,
        };
        update = update.col_expr(Column::Recipients, Expr::value(stored));
    }
    update
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.eq("draft"))
        .exec(&orm(&caller.db))
        .await?;
    let Some(row) = find_report(&caller.db, id).await? else {
        return Err(Refusal::not_found(REPORT_LABEL, id));
    };
    publish_report(state, caller, PROJECT_STATUS_REPORT_UPDATED, &row);
    let project =
        load_report_project(&caller.db, text(&row, "projectId").unwrap_or_default()).await?;
    Ok(Data(present_one(caller, &row, project.as_ref()).await?).into_response())
}

// ── Refresh ─────────────────────────────────────────────────────────────────

async fn refresh(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let Some(existing) = find_report(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REPORT_LABEL, &id));
        };
        let project_id = text(&existing, "projectId").unwrap_or_default().to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        if text(&existing, "status") == Some("published") {
            return Err(Refusal::conflict(PUBLISHED_IMMUTABLE));
        }
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        Ok((existing, project))
    }
    .await;
    let (existing, project) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        refresh_report(&state, &caller, &id, &existing, &project).await,
        "Failed to refresh status report",
    )
}

async fn refresh_report(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    project: &ReportProject,
) -> Reply {
    let now = caller.now_ms();
    let period = text(existing, "period").unwrap_or_default();
    let cadence = schedule_of(project).map(|s| s.cadence);
    let computed = compute_report(
        &caller.db,
        project,
        now,
        window_days(period, cadence.as_deref()),
    )
    .await?;
    let previous = existing["snapshot"]["computed"]["overall"].as_str();
    let overall = merge_overall(text(existing, "overall"), previous, computed.overall);
    let areas = merge_areas(
        existing["areas"].as_array().map(Vec::as_slice),
        &computed.areas,
    );
    let list = |key: &str| existing[key].as_array().cloned().unwrap_or_default();
    {
        use reports::Column;
        reports::Entity::update_many()
            .col_expr(Column::Areas, Expr::value(Value::Array(areas)))
            .col_expr(Column::Overall, Expr::value(overall))
            .col_expr(
                Column::Done,
                Expr::value(Value::Array(merge_items(&list("done"), &computed.done))),
            )
            .col_expr(
                Column::Next,
                Expr::value(Value::Array(merge_items(&list("next"), &computed.next))),
            )
            .col_expr(Column::Snapshot, Expr::value(computed.snapshot))
            .col_expr(Column::UpdatedAt, Expr::value(instant(now)))
            .filter(Column::Id.eq(id))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.eq("draft"))
            .exec(&orm(&caller.db))
            .await?;
    }
    let Some(row) = find_report(&caller.db, id).await? else {
        return Err(Refusal::not_found(REPORT_LABEL, id));
    };
    publish_report(state, caller, PROJECT_STATUS_REPORT_UPDATED, &row);
    Ok(Data(present_one(caller, &row, Some(project)).await?).into_response())
}

// ── Publish ─────────────────────────────────────────────────────────────────

async fn publish(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let Some(existing) = find_report(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REPORT_LABEL, &id));
        };
        let project_id = text(&existing, "projectId").unwrap_or_default().to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        if text(&existing, "status") == Some("published") {
            return Err(Refusal::conflict(ALREADY_PUBLISHED));
        }
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if text(&existing, "summary")
            .is_none_or(|s| weldsuite_kit::validation::js_trim(s).is_empty())
        {
            return Err(Refusal::bad_request(SUMMARY_REQUIRED));
        }
        if text(&existing, "overall").is_none_or(|o| o == "grey") {
            return Err(Refusal::bad_request(OVERALL_REQUIRED));
        }
        Ok((existing, project))
    }
    .await;
    let (existing, project) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        publish_report_now(&state, &caller, &id, &existing, &project).await,
        "Failed to publish status report",
    )
}

/// The snapshot a published report freezes: what the draft held, with everything the report shows.
fn frozen_snapshot(
    existing: &Value,
    targets: &[weldsuite_flow_domain::status_report::RecipientCandidate],
) -> Value {
    let mut frozen = match existing.get("snapshot") {
        Some(Value::Object(map)) => map.clone(),
        _ => {
            let mut map = Map::new();
            map.insert("version".to_owned(), json!(1));
            map
        }
    };
    for key in [
        "overall",
        "areas",
        "summary",
        "done",
        "next",
        "clientVisible",
    ] {
        frozen.insert(key.to_owned(), existing[key].clone());
    }
    frozen.insert(
        "recipients".to_owned(),
        Value::Array(
            targets
                .iter()
                .map(|t| json!({ "stakeholderId": t.stakeholder_id, "userId": t.user_id, "name": t.name, "kind": t.kind }))
                .collect(),
        ),
    );
    Value::Object(frozen)
}

/// The report published and the project's health set from it, in one
/// transaction.
async fn mark_published(
    caller: &Caller,
    id: &str,
    project_id: &str,
    health: Option<&str>,
    snapshot: Value,
) -> Result<(), DbErr> {
    let now = instant(caller.now_ms());
    let tx = orm(&caller.db).begin().await?;
    reports::Entity::update_many()
        .col_expr(reports::Column::Status, Expr::value("published"))
        .col_expr(
            reports::Column::PublishedBy,
            Expr::value(caller.user_id.clone()),
        )
        .col_expr(reports::Column::PublishedAt, Expr::value(Some(now)))
        .col_expr(reports::Column::Snapshot, Expr::value(snapshot))
        .col_expr(reports::Column::UpdatedAt, Expr::value(now))
        .filter(reports::Column::Id.eq(id))
        .filter(reports::Column::DeletedAt.is_null())
        .filter(reports::Column::Status.eq("draft"))
        .exec(&tx)
        .await?;
    if let Some(health) = health {
        projects::Entity::update_many()
            .col_expr(projects::Column::Health, Expr::value(health))
            .col_expr(projects::Column::UpdatedAt, Expr::value(utc_timestamp(now)))
            .filter(projects::Column::Id.eq(project_id))
            .filter(projects::Column::DeletedAt.is_null())
            .exec(&tx)
            .await?;
    }
    tx.commit().await
}

async fn publish_report_now(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    project: &ReportProject,
) -> Reply {
    let db = &caller.db;
    let targets = targets_of(db, project, existing.get("recipients")).await?;
    let overall = text(existing, "overall").unwrap_or_default().to_owned();
    let health = health_for_colour(&overall);
    mark_published(
        caller,
        id,
        &project.id,
        health,
        frozen_snapshot(existing, &targets),
    )
    .await?;
    let Some(row) = find_report(db, id).await? else {
        return Err(Refusal::not_found(REPORT_LABEL, id));
    };
    publish_report(state, caller, PROJECT_STATUS_REPORT_PUBLISHED, &row);
    if health.is_some() {
        publish_project_updated(state, caller, &project.id, &project.name).await?;
    }

    // Send after the response: members get the in-app notification, client contacts the email.
    let register = stakeholders_of_project(db, &project.id).await?;
    let contact_ids: std::collections::HashMap<String, String> = register
        .iter()
        .filter_map(|r| {
            Some((
                text(r, "id")?.to_owned(),
                text(r, "crmContactId")?.to_owned(),
            ))
        })
        .collect();
    let context = NotifyContext::of(state, caller);
    let sent_row = row.clone();
    let sent_project = project.clone();
    state.events.tracker().spawn(async move {
        send_published_report(&context, &sent_row, &sent_project, &targets, &contact_ids).await;
    });
    Ok(Data(present_one(caller, &row, Some(project)).await?).into_response())
}

// ── Delete a draft ──────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let Some(existing) = find_report(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REPORT_LABEL, &id));
        };
        if !caller
            .can_manage(text(&existing, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        if text(&existing, "status") == Some("published") {
            return Err(Refusal::conflict(PUBLISHED_IMMUTABLE));
        }
        let now = instant(caller.now_ms());
        reports::Entity::update_many()
            .col_expr(reports::Column::DeletedAt, Expr::value(Some(now)))
            .col_expr(reports::Column::UpdatedAt, Expr::value(now))
            .filter(reports::Column::Id.eq(&id))
            .filter(reports::Column::DeletedAt.is_null())
            .filter(reports::Column::Status.eq("draft"))
            .exec(&orm(&caller.db))
            .await?;
        publish_report(&state, &caller, PROJECT_STATUS_REPORT_DELETED, &existing);
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to delete status report")
}
