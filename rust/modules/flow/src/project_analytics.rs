//! `/api/project-analytics` (`routes/project-analytics/index.ts`): the
//! WeldFlow KPI summaries (live Postgres counts,
//! `services/project-kpi-summary.ts`) and the analytics reports and charts
//! of the `projects` app.
//!
//! Chart data (`POST /reports/:id/charts-data`) is read from Cloudflare's
//! analytics store (R2 SQL over the R2 Data Catalog) on Global. The
//! Kubernetes editions have no such store, so every chart answers no points,
//! as the TypeScript worker does without `R2_SQL_API_TOKEN`; the access
//! checks and validation are the same.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, Query as SubQuery};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime, Time};
use weldsuite_catalogs::entity_events::{
    ANALYTICS_CHART_CREATED, ANALYTICS_CHART_DELETED, ANALYTICS_REPORT_CREATED,
    ANALYTICS_REPORT_DELETED, ANALYTICS_REPORT_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_flow_domain::js::{js_number_value, math_round, number_value, utf16_len};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use weldsuite_schema::tenant::{
    analytics_charts, analytics_reports, projects, tasks, time_entries,
};

use crate::projects::normalize_project_status;
use crate::{
    Caller, FlowState, Query, Refusal, json_rows, reply, row_json, validate, validate_value,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const REPORT_OWNER_ONLY: &str = "Only the report owner or a workspace admin can change this report";

/// The KPI queries' project scope on `col`: all projects (a project, and a
/// live one), else the ids given.
fn project_scope<C: ColumnTrait + Copy>(col: C, all: bool, ids: &[String]) -> Condition {
    if all {
        // `not exists (select 1 from projects where id = col and deleted_at is
        // not null)`, as `col not in` the deleted projects' ids (never null).
        let deleted = SubQuery::select()
            .column(projects::Column::Id)
            .from(projects::Entity)
            .and_where(projects::Column::DeletedAt.is_not_null())
            .to_owned();
        Condition::all()
            .add(col.is_not_null())
            .add(col.not_in_subquery(deleted))
    } else {
        Condition::all().add(col.is_in(ids.iter().map(String::as_str)))
    }
}

/// Live tasks in the KPI scope that are still open (not done, not cancelled).
fn open_tasks(all: bool, ids: &[String]) -> Condition {
    Condition::all()
        .add(tasks::Column::DeletedAt.is_null())
        .add(project_scope(tasks::Column::ProjectId, all, ids))
        .add(tasks::Column::Status.is_not_in(["done", "cancelled"]))
}

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        // Membership-scoped, not gated on `projects:read`; the permissions are
        // still resolved, since the flow `Caller` needs them.
        .route("/summary", get(summary).route_layer(gate.resolve()))
        .route(
            "/projects/{project_id}/summary",
            get(project_summary).route_layer(gate.resolve()),
        )
        .route(
            "/reports",
            get(list_reports).route_layer(need("projects:read")),
        )
        .route(
            "/reports",
            post(create_report).route_layer(need("projects:create")),
        )
        .route(
            "/reports/{report_id}",
            get(report).route_layer(need("projects:read")),
        )
        .route(
            "/reports/{report_id}",
            axum::routing::put(update_report).route_layer(need("projects:update")),
        )
        .route(
            "/reports/{report_id}",
            axum::routing::delete(delete_report).route_layer(need("projects:delete")),
        )
        .route(
            "/reports/{report_id}/duplicate",
            post(duplicate_report).route_layer(need("projects:create")),
        )
        .route(
            "/reports/{report_id}/charts",
            get(list_charts).route_layer(need("projects:read")),
        )
        .route(
            "/reports/{report_id}/charts",
            post(create_chart).route_layer(need("projects:create")),
        )
        .route(
            "/reports/{report_id}/charts/layouts",
            patch(update_layouts).route_layer(need("projects:update")),
        )
        .route(
            "/reports/{report_id}/charts/{chart_id}",
            axum::routing::delete(delete_chart).route_layer(need("projects:delete")),
        )
        .route(
            "/reports/{report_id}/charts/{chart_id}/duplicate",
            post(duplicate_chart).route_layer(need("projects:create")),
        )
        .route(
            "/reports/{report_id}/charts-data",
            post(charts_data).route_layer(need("projects:read")),
        )
        .with_state(state)
}

// ── KPI summaries ───────────────────────────────────────────────────────────

/// `projectKpiSummaryQuerySchema` (without `projectId` for one project).
fn read_summary_query(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    with_project: bool,
) -> (String, Option<String>) {
    let period = issues
        .choice(fields, "period", Presence::Optional, &["7d", "30d", "90d"])
        .into_option()
        .unwrap_or_else(|| "30d".to_owned());
    let project = if with_project {
        issues
            .text(fields, "projectId", Presence::Optional, Some(1), None)
            .into_option()
    } else {
        None
    };
    (period, project)
}

async fn summary(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let (period, project_id) =
        match validate_value(&Value::Object(q.values().clone()), |issues, f| {
            read_summary_query(issues, f, true)
        }) {
            Ok(query) => query,
            Err(refused) => return refused.respond("Invalid query"),
        };
    if caller.user().is_none() {
        return ApiError::unauthorized().into_response();
    }
    reply(
        async {
            if let Some(project) = &project_id
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let scope = caller.accessible_project_ids().await?;
            let summary = kpi_summary(&caller.db, &period, scope, project_id.as_deref()).await?;
            Ok(Data(summary).into_response())
        }
        .await,
        "Failed to load analytics summary",
    )
}

async fn project_summary(
    caller: Caller,
    Path(project_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    let (period, _) = match validate_value(&Value::Object(q.values().clone()), |issues, f| {
        read_summary_query(issues, f, false)
    }) {
        Ok(query) => query,
        Err(refused) => return refused.respond("Invalid query"),
    };
    if caller.user().is_none() {
        return ApiError::unauthorized().into_response();
    }
    reply(
        async {
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let summary = kpi_summary(
                &caller.db,
                &period,
                Some(vec![project_id.clone()]),
                Some(&project_id),
            )
            .await?;
            Ok(Data(summary).into_response())
        }
        .await,
        "Failed to load project analytics summary",
    )
}

fn iso_date(at: OffsetDateTime) -> String {
    iso_timestamp(at)[..10].to_owned()
}

/// `countByKey`: `key || 'unknown'`.
fn count_by_key<'a>(keys: impl Iterator<Item = Option<&'a str>>) -> Value {
    let mut out = Map::new();
    for key in keys {
        let key = key.filter(|k| !k.is_empty()).unwrap_or("unknown");
        let count = out.get(key).and_then(Value::as_i64).unwrap_or(0);
        out.insert(key.to_owned(), json!(count + 1));
    }
    Value::Object(out)
}

/// `getProjectKpiSummary(db, { period, projectIds, projectId })`.
#[allow(clippy::too_many_lines)] // the TypeScript function, query by query
async fn kpi_summary(
    db: &PgPool,
    period: &str,
    project_ids: Option<Vec<String>>,
    project_id: Option<&str>,
) -> Result<Value, DbErr> {
    let now = OffsetDateTime::now_utc();
    let today = now.replace_time(Time::MIDNIGHT);
    let tomorrow = today + Duration::days(1);
    let days: i64 = match period {
        "7d" => 7,
        "90d" => 90,
        _ => 30,
    };
    let from = today - Duration::days(days - 1);
    let (from_iso, to_iso) = (iso_date(from), iso_date(today));
    let empty = || {
        json!({
            "activeProjects": 0, "tasksDueToday": 0, "overdueTasks": 0, "totalTasks": 0,
            "completedTasks": 0, "completionRate": 0, "hoursLoggedMinutes": 0,
            "billableHoursMinutes": 0, "projectsByStatus": {}, "projectsByHealth": {},
            "tasksByPriority": {}, "throughputByDay": [], "period": period,
            "from": from_iso, "to": to_iso,
        })
    };
    let mut scoped = project_ids;
    if let Some(project) = project_id.filter(|p| !p.is_empty()) {
        if scoped
            .as_ref()
            .is_some_and(|ids| !ids.iter().any(|id| id == project))
        {
            return Ok(empty());
        }
        scoped = Some(vec![project.to_owned()]);
    }
    if scoped.as_ref().is_some_and(Vec::is_empty) {
        return Ok(empty());
    }
    let all = scoped.is_none();
    let ids = scoped.unwrap_or_default();
    let (today_at, tomorrow_at, from_at) = (
        utc_timestamp(today),
        utc_timestamp(tomorrow),
        utc_timestamp(from),
    );
    let db = &orm(db);

    let mut projects = projects::Entity::find()
        .select_only()
        .columns([
            projects::Column::Status,
            projects::Column::Health,
            projects::Column::IsActive,
        ])
        .filter(projects::Column::DeletedAt.is_null());
    if !all {
        projects = projects.filter(projects::Column::Id.is_in(ids.iter().map(String::as_str)));
    }
    let projects: Vec<(Option<String>, Option<String>, Option<bool>)> =
        projects.into_tuple().all(db).await?;
    // Unscoped: tasks and hours of deleted projects stay out.
    let tasks: Vec<(Option<String>, Option<String>)> = tasks::Entity::find()
        .select_only()
        .columns([tasks::Column::Status, tasks::Column::Priority])
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(project_scope(tasks::Column::ProjectId, all, &ids))
        .into_tuple()
        .all(db)
        .await?;
    let due_today = tasks::Entity::find()
        .filter(open_tasks(all, &ids))
        .filter(tasks::Column::DueDate.gte(today_at))
        .filter(tasks::Column::DueDate.lt(tomorrow_at))
        .count(db)
        .await?;
    let overdue = tasks::Entity::find()
        .filter(open_tasks(all, &ids))
        .filter(tasks::Column::DueDate.is_not_null())
        .filter(tasks::Column::DueDate.lt(today_at))
        .count(db)
        .await?;
    let hours = logged_minutes(db, all, &ids, (from.date(), today.date())).await?;
    let throughput = completed_by_day(db, all, &ids, (from_at, tomorrow_at)).await?;

    let closed = |status: &Option<String>| {
        status
            .as_deref()
            .filter(|s| !s.is_empty())
            .is_some_and(|s| {
                matches!(
                    normalize_project_status(s).as_str(),
                    "Completed" | "Cancelled"
                )
            })
    };
    let active = projects
        .iter()
        .filter(|(status, _, is_active)| is_active.unwrap_or(false) && !closed(status))
        .count();
    let total = tasks.len();
    let completed = tasks
        .iter()
        .filter(|(status, _)| status.as_deref() == Some("done"))
        .count();
    #[allow(clippy::cast_precision_loss)]
    let rate = if total > 0 {
        math_round(completed as f64 / total as f64 * 1000.0) / 10.0
    } else {
        0.0
    };
    let by_day = throughput;
    let throughput_by_day: Vec<Value> = (0..days)
        .map(|i| {
            let date = iso_date(from + Duration::days(i));
            let completed = by_day.get(&date).copied().unwrap_or(0);
            json!({ "date": date, "completed": completed })
        })
        .collect();
    let statuses: Vec<Option<String>> = projects
        .iter()
        .map(|(status, ..)| {
            status
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(normalize_project_status)
                .or_else(|| status.clone())
        })
        .collect();
    Ok(json!({
        "activeProjects": active,
        "tasksDueToday": due_today,
        "overdueTasks": overdue,
        "totalTasks": total,
        "completedTasks": completed,
        "completionRate": number_value(rate),
        "hoursLoggedMinutes": number_value(math_round(hours.0)),
        "billableHoursMinutes": number_value(math_round(hours.1)),
        "projectsByStatus": count_by_key(statuses.iter().map(Option::as_deref)),
        "projectsByHealth": count_by_key(
            projects
                .iter()
                .filter_map(|(_, health, _)| health.as_deref().filter(|h| !h.is_empty()))
                .map(Some),
        ),
        "tasksByPriority": count_by_key(tasks.iter().map(|(_, priority)| priority.as_deref())),
        "throughputByDay": throughput_by_day,
        "period": period,
        "from": from_iso,
        "to": to_iso,
    }))
}

/// The minutes logged and the billable ones in the scope over the days from
/// `from` to `to` (inclusive): `coalesce(sum(duration)::float, 0)` and
/// `coalesce(sum(case when billable then duration else 0 end)::float, 0)`.
async fn logged_minutes(
    db: &sea_orm::DatabaseConnection,
    all: bool,
    ids: &[String],
    (from, to): (time::Date, time::Date),
) -> Result<(f64, f64), DbErr> {
    use time_entries::Column;
    let total = |amount: Expr| -> Expr {
        let sum = sea_orm::ExprTrait::cast_as(Expr::from(Func::sum(amount)), "float");
        Func::coalesce([sum, Expr::val(0.0_f64)]).into()
    };
    let duration = Expr::col((time_entries::Entity, Column::Duration));
    let billable: Expr = Expr::case(Column::Billable.eq(true), duration.clone())
        .finally(0)
        .into();
    let hours: Option<(f64, f64)> = time_entries::Entity::find()
        .select_only()
        .column_as(total(duration), "logged")
        .column_as(total(billable), "billable")
        .filter(Column::DeletedAt.is_null())
        .filter(project_scope(Column::ProjectId, all, ids))
        .filter(Column::Date.gte(from))
        .filter(Column::Date.lte(to))
        .into_tuple()
        .one(db)
        .await?;
    Ok(hours.unwrap_or((0.0, 0.0)))
}

/// The tasks in the scope completed in `[from, to)`, by day (`YYYY-MM-DD` of
/// `date_trunc('day', completed_date)`).
async fn completed_by_day(
    db: &sea_orm::DatabaseConnection,
    all: bool,
    ids: &[String],
    (from, to): (PrimitiveDateTime, PrimitiveDateTime),
) -> Result<HashMap<String, i32>, DbErr> {
    use tasks::Column;
    let completed: Vec<PrimitiveDateTime> = tasks::Entity::find()
        .select_only()
        .column(Column::CompletedDate)
        .filter(Column::DeletedAt.is_null())
        .filter(project_scope(Column::ProjectId, all, ids))
        .filter(Column::Status.eq("done"))
        .filter(Column::CompletedDate.is_not_null())
        .filter(Column::CompletedDate.gte(from))
        .filter(Column::CompletedDate.lt(to))
        .into_tuple()
        .all(db)
        .await?;
    let mut by_day: HashMap<String, i32> = HashMap::new();
    for at in completed {
        *by_day.entry(iso_date(at.assume_utc())).or_insert(0) += 1;
    }
    Ok(by_day)
}

// ── Reports ─────────────────────────────────────────────────────────────────

/// The live WeldFlow report (`loadReport`).
async fn load_report(db: &PgPool, report_id: &str) -> Result<Option<Value>, DbErr> {
    use analytics_reports::Column;
    analytics_reports::Entity::find_by_id(report_id)
        .filter(Column::App.eq("projects"))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `loadModifiableReport`: the report, once the caller may change it (its
/// creator, a `projects:scope:all` holder, or anyone for a report without
/// an owner).
async fn modifiable_report(caller: &Caller, report_id: &str) -> Result<Value, Refusal> {
    let Some(report) = load_report(&caller.db, report_id).await? else {
        return Err(Refusal::not_found("Report", report_id));
    };
    let owner = report["createdById"].as_str().filter(|o| !o.is_empty());
    if owner.is_some_and(|owner| owner != caller.user_id) && !caller.scope_all() {
        return Err(Refusal::forbidden(REPORT_OWNER_ONLY));
    }
    Ok(report)
}

/// The report's live charts, in `sort_index` order.
async fn report_charts(db: &PgPool, report_id: &str) -> Result<Vec<Value>, DbErr> {
    let rows = live_charts(report_id)
        .order_by_asc(analytics_charts::Column::SortIndex)
        .all(&orm(db))
        .await?;
    json_rows(rows)
}

/// The report's live charts.
fn live_charts(report_id: &str) -> sea_orm::Select<analytics_charts::Entity> {
    analytics_charts::Entity::find()
        .filter(analytics_charts::Column::ReportId.eq(report_id))
        .filter(analytics_charts::Column::DeletedAt.is_null())
}

/// How many live charts the report has.
async fn chart_count(db: &PgPool, report_id: &str) -> Result<i64, DbErr> {
    let count = live_charts(report_id).count(&orm(db)).await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

async fn set_chart_count(
    db: &PgPool,
    report_id: &str,
    count: i64,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use analytics_reports::Column;
    analytics_reports::Entity::update_many()
        .col_expr(
            Column::ChartCount,
            Expr::value(i32::try_from(count).unwrap_or(i32::MAX)),
        )
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(report_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `where id = $id and app = 'projects' and deleted_at is null`: the live
/// WeldFlow report.
fn live_report(report_id: &str) -> Condition {
    use analytics_reports::Column;
    Condition::all()
        .add(Column::Id.eq(report_id))
        .add(Column::App.eq("projects"))
        .add(Column::DeletedAt.is_null())
}

/// Postgres's `float8::integer`: rounded half to even, and an error out of
/// range.
fn pg_integer(value: f64) -> Result<i32, DbErr> {
    let rounded = value.round_ties_even();
    if rounded.is_nan() || !(-2_147_483_648.0..2_147_483_648.0).contains(&rounded) {
        return Err(DbErr::Custom("integer out of range".to_owned()));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "in the range of i32, checked above"
    )]
    let value = rounded as i32;
    Ok(value)
}

/// A copy of a chart into `report_id`, with its title and layout as given.
fn chart_copy(
    chart: analytics_charts::Model,
    id: String,
    report_id: &str,
    title: String,
    layout: Value,
    sort_index: i32,
    now: PrimitiveDateTime,
) -> analytics_charts::ActiveModel {
    analytics_charts::ActiveModel {
        id: Set(id),
        report_id: Set(report_id.to_owned()),
        app: Set("projects".to_owned()),
        title: Set(title),
        description: Set(chart.description),
        chart_type: Set(chart.chart_type),
        entity_: Set(chart.entity_),
        metric: Set(chart.metric),
        color: Set(chart.color),
        smooth_curve: Set(chart.smooth_curve),
        fill_area: Set(chart.fill_area),
        show_data_labels: Set(chart.show_data_labels),
        show_legend: Set(chart.show_legend),
        time_range: Set(chart.time_range),
        group_by: Set(chart.group_by),
        aggregation: Set(chart.aggregation),
        sort_order: Set(chart.sort_order),
        limit: Set(chart.limit),
        compare_with: Set(chart.compare_with),
        layout: Set(layout),
        sort_index: Set(sort_index),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
}

async fn list_reports(caller: Caller) -> Response {
    reply(
        async {
            use analytics_reports::Column;
            let rows = analytics_reports::Entity::find()
                .filter(Column::App.eq("projects"))
                .filter(Column::DeletedAt.is_null())
                .order_by_desc(Column::UpdatedAt)
                .all(&orm(&caller.db))
                .await?;
            Ok(Data(json_rows(rows)?).into_response())
        }
        .await,
        "Failed to fetch reports",
    )
}

async fn report(caller: Caller, Path(report_id): Path<String>) -> Response {
    reply(
        async {
            let Some(report) = load_report(&caller.db, &report_id).await? else {
                return Err(Refusal::not_found("Report", &report_id));
            };
            let charts = report_charts(&caller.db, &report_id).await?;
            Ok(Data(json!({ "report": report, "charts": charts })).into_response())
        }
        .await,
        "Failed to fetch report",
    )
}

/// `createReportSchema` (`.partial()` for an update): the fields given.
fn read_report(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let title_presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    if let Some(title) = issues
        .text(fields, "title", title_presence, Some(1), Some(255))
        .into_option()
    {
        out.insert("title".to_owned(), Value::String(title));
    }
    if let Some(description) = issues
        .text(fields, "description", Presence::Optional, None, None)
        .into_option()
    {
        out.insert("description".to_owned(), Value::String(description));
    }
    out
}

fn text_of<'a>(fields: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    fields.get(key).and_then(Value::as_str)
}

async fn create_report(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_report(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            let id = generate_id("rpt");
            let title = text_of(&data, "title").unwrap_or_default();
            let now = utc_now();
            analytics_reports::Entity::insert(analytics_reports::ActiveModel {
                id: Set(id.clone()),
                app: Set("projects".to_owned()),
                title: Set(title.to_owned()),
                description: Set(Some(
                    text_of(&data, "description").unwrap_or_default().to_owned(),
                )),
                created_by_id: Set(Some(caller.user_id.clone())),
                chart_count: Set(0),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&orm(&caller.db))
            .await?;
            caller.publish(
                &state,
                ANALYTICS_REPORT_CREATED,
                &id,
                &json!({ "id": id, "title": title }),
            );
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
        "Failed to create report",
    )
}

async fn update_report(
    State(state): State<FlowState>,
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_report(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            modifiable_report(&caller, &report_id).await?;
            {
                use analytics_reports::Column;
                let mut update = analytics_reports::Entity::update_many();
                for (key, column) in [
                    ("title", Column::Title),
                    ("description", Column::Description),
                ] {
                    if data.contains_key(key) {
                        let text = text_of(&data, key).map(str::to_owned);
                        update = update.col_expr(column, Expr::value(text));
                    }
                }
                update
                    .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                    .filter(live_report(&report_id))
                    .exec(&orm(&caller.db))
                    .await?;
            }
            let mut event = data.clone();
            event.insert("id".to_owned(), Value::String(report_id.clone()));
            caller.publish(
                &state,
                ANALYTICS_REPORT_UPDATED,
                &report_id,
                &Value::Object(event),
            );
            Ok(Data(json!({ "id": report_id })).into_response())
        }
        .await,
        "Failed to update report",
    )
}

async fn delete_report(
    State(state): State<FlowState>,
    caller: Caller,
    Path(report_id): Path<String>,
) -> Response {
    reply(
        async {
            modifiable_report(&caller, &report_id).await?;
            let now = utc_now();
            analytics_reports::Entity::update_many()
                .col_expr(analytics_reports::Column::DeletedAt, Expr::value(now))
                .col_expr(analytics_reports::Column::UpdatedAt, Expr::value(now))
                .filter(live_report(&report_id))
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(
                &state,
                ANALYTICS_REPORT_DELETED,
                &report_id,
                &json!({ "id": report_id }),
            );
            Ok(axum::Json(json!({ "success": true })).into_response())
        }
        .await,
        "Failed to delete report",
    )
}

async fn duplicate_report(
    State(state): State<FlowState>,
    caller: Caller,
    Path(report_id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            if load_report(db, &report_id).await?.is_none() {
                return Err(Refusal::not_found("Report", &report_id));
            }
            let new_id = generate_id("rpt");
            let now = utc_now();
            // The copy of the report (`insert … select … from analytics_reports r
            // where r.id = $2`), then of its live charts.
            if let Some(source) = analytics_reports::Entity::find_by_id(report_id.as_str())
                .one(&orm(db))
                .await?
            {
                analytics_reports::Entity::insert(analytics_reports::ActiveModel {
                    id: Set(new_id.clone()),
                    app: Set("projects".to_owned()),
                    title: Set(format!("{} (Copy)", source.title)),
                    description: Set(source.description),
                    created_by_id: Set(Some(caller.user_id.clone())),
                    chart_count: Set(source.chart_count),
                    created_at: Set(now),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec_without_returning(&orm(db))
                .await?;
            }
            let charts = live_charts(&report_id).all(&orm(db)).await?;
            if !charts.is_empty() {
                let copies = charts.into_iter().map(|chart| {
                    let (title, layout, sort_index) =
                        (chart.title.clone(), chart.layout.clone(), chart.sort_index);
                    chart_copy(
                        chart,
                        generate_id("cht"),
                        &new_id,
                        title,
                        layout,
                        sort_index,
                        now,
                    )
                });
                analytics_charts::Entity::insert_many(copies)
                    .exec_without_returning(&orm(db))
                    .await?;
            }
            caller.publish(
                &state,
                ANALYTICS_REPORT_CREATED,
                &new_id,
                &json!({ "id": new_id, "duplicatedFrom": report_id }),
            );
            Ok(Created(json!({ "id": new_id })).into_response())
        }
        .await,
        "Failed to duplicate report",
    )
}

// ── Charts ──────────────────────────────────────────────────────────────────

async fn list_charts(caller: Caller, Path(report_id): Path<String>) -> Response {
    reply(
        async {
            if load_report(&caller.db, &report_id).await?.is_none() {
                return Err(Refusal::not_found("Report", &report_id));
            }
            Ok(Data(report_charts(&caller.db, &report_id).await?).into_response())
        }
        .await,
        "Failed to fetch charts",
    )
}

/// `chartLayoutSchema`: `{ x, y, w, h, minW?, minH? }`, unknown keys dropped.
fn read_layout(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut layout = Map::new();
    for (key, presence) in [
        ("x", Presence::Required),
        ("y", Presence::Required),
        ("w", Presence::Required),
        ("h", Presence::Required),
        ("minW", Presence::Optional),
        ("minH", Presence::Optional),
    ] {
        if let Field::Set(_) = issues.number(fields, key, presence, Number::default())
            && let Some(value) = fields.get(key)
        {
            layout.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(layout)
}

/// `createChartSchema.omit({ reportId })`, defaults applied.
fn read_chart(issues: &mut Issues, f: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut text = |issues: &mut Issues,
                    key: &str,
                    presence: Presence,
                    min: Option<usize>,
                    max: Option<usize>,
                    default: Option<&str>| {
        match issues.text(f, key, presence, min, max) {
            Field::Set(value) => {
                out.insert(key.to_owned(), Value::String(value));
            }
            _ => {
                if let Some(default) = default {
                    out.insert(key.to_owned(), Value::String(default.to_owned()));
                }
            }
        }
    };
    text(
        issues,
        "title",
        Presence::Required,
        Some(1),
        Some(255),
        None,
    );
    text(issues, "description", Presence::Optional, None, None, None);
    text(issues, "chartType", Presence::Required, Some(1), None, None);
    text(issues, "entity", Presence::Required, Some(1), None, None);
    text(issues, "metric", Presence::Required, Some(1), None, None);
    text(
        issues,
        "color",
        Presence::Optional,
        None,
        None,
        Some("#3b82f6"),
    );
    let mut flags = Map::new();
    for (key, default) in [
        ("smoothCurve", true),
        ("fillArea", true),
        ("showDataLabels", false),
        ("showLegend", true),
    ] {
        let value = issues
            .boolean(f, key, Presence::Optional)
            .into_option()
            .unwrap_or(default);
        flags.insert(key.to_owned(), Value::Bool(value));
    }
    let mut more = |issues: &mut Issues, key: &str, default: &str| {
        let value = issues
            .text(f, key, Presence::Optional, None, None)
            .into_option()
            .unwrap_or_else(|| default.to_owned());
        flags.insert(key.to_owned(), Value::String(value));
    };
    more(issues, "timeRange", "last_30_days");
    more(issues, "groupBy", "day");
    more(issues, "aggregation", "sum");
    more(issues, "sortOrder", "asc");
    if issues
        .number(f, "limit", Presence::Optional, Number::default())
        .as_set()
        .is_some()
        && let Some(limit) = f.get("limit")
    {
        flags.insert("limit".to_owned(), limit.clone());
    }
    if let Some(compare) = issues
        .text(f, "compareWith", Presence::Optional, None, None)
        .into_option()
    {
        flags.insert("compareWith".to_owned(), Value::String(compare));
    }
    if let Field::Set(layout) = issues.nested(f, "layout", Presence::Optional, read_layout) {
        flags.insert("layout".to_owned(), layout);
    }
    out.extend(flags);
    out
}

/// `data.x || fallback` for a string.
fn or_text<'a>(data: &'a Map<String, Value>, key: &str, fallback: &'a str) -> &'a str {
    text_of(data, key)
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
}

async fn create_chart(
    State(state): State<FlowState>,
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_chart) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            let db = &caller.db;
            modifiable_report(&caller, &report_id).await?;
            let existing = chart_count(db, &report_id).await?;
            let id = generate_id("cht");
            let now = utc_now();
            // `data.limit || null`: 0 is no limit.
            let limit = data
                .get("limit")
                .and_then(Value::as_f64)
                .filter(|l| *l != 0.0 && !l.is_nan())
                .map(pg_integer)
                .transpose()?;
            let layout = data
                .get("layout")
                .cloned()
                .unwrap_or_else(|| json!({ "x": 0, "y": 0, "w": 6, "h": 4 }));
            let text = |key: &str| text_of(&data, key).unwrap_or_default().to_owned();
            let flag = |key: &str| data[key].as_bool().unwrap_or_default();
            analytics_charts::Entity::insert(analytics_charts::ActiveModel {
                id: Set(id.clone()),
                report_id: Set(report_id.clone()),
                app: Set("projects".to_owned()),
                title: Set(text("title")),
                description: Set(text_of(&data, "description")
                    .filter(|d| !d.is_empty())
                    .map(str::to_owned)),
                chart_type: Set(text("chartType")),
                entity_: Set(text("entity")),
                metric: Set(text("metric")),
                color: Set(or_text(&data, "color", "#3b82f6").to_owned()),
                smooth_curve: Set(flag("smoothCurve")),
                fill_area: Set(flag("fillArea")),
                show_data_labels: Set(flag("showDataLabels")),
                show_legend: Set(flag("showLegend")),
                time_range: Set(Some(or_text(&data, "timeRange", "last_30_days").to_owned())),
                group_by: Set(Some(or_text(&data, "groupBy", "day").to_owned())),
                aggregation: Set(Some(or_text(&data, "aggregation", "sum").to_owned())),
                sort_order: Set(Some(or_text(&data, "sortOrder", "asc").to_owned())),
                limit: Set(limit),
                compare_with: Set(text_of(&data, "compareWith")
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)),
                layout: Set(layout),
                sort_index: Set(i32::try_from(existing).unwrap_or(i32::MAX)),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&orm(db))
            .await?;
            set_chart_count(db, &report_id, existing + 1, now).await?;
            caller.publish(
                &state,
                ANALYTICS_CHART_CREATED,
                &id,
                &json!({ "id": id, "reportId": report_id }),
            );
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
        "Failed to create chart",
    )
}

/// `updateChartLayoutsSchema`.
fn read_layouts(issues: &mut Issues, f: &Map<String, Value>) -> Vec<(String, Value)> {
    issues
        .list(
            f,
            "layouts",
            Presence::Required,
            None,
            None,
            |issues, item| {
                let fields = issues.object(item)?;
                let chart = issues.text(fields, "chartId", Presence::Required, None, None);
                let layout = issues.nested(fields, "layout", Presence::Required, read_layout);
                match (chart, layout) {
                    (Field::Set(chart), Field::Set(layout)) => Some((chart, layout)),
                    _ => None,
                }
            },
        )
        .into_option()
        .unwrap_or_default()
}

async fn update_layouts(
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let layouts = match validate(&headers, &body, read_layouts) {
        Ok(layouts) => layouts,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            modifiable_report(&caller, &report_id).await?;
            let now = utc_now();
            for (chart, layout) in &layouts {
                use analytics_charts::Column;
                analytics_charts::Entity::update_many()
                    .col_expr(Column::Layout, Expr::value(layout.clone()))
                    .col_expr(Column::UpdatedAt, Expr::value(now))
                    .filter(Column::Id.eq(chart.as_str()))
                    .filter(Column::ReportId.eq(report_id.as_str()))
                    .filter(Column::DeletedAt.is_null())
                    .exec(&orm(&caller.db))
                    .await?;
            }
            Ok(Data(json!({ "updated": layouts.len() })).into_response())
        }
        .await,
        "Failed to update chart layouts",
    )
}

async fn delete_chart(
    State(state): State<FlowState>,
    caller: Caller,
    Path((report_id, chart_id)): Path<(String, String)>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            modifiable_report(&caller, &report_id).await?;
            let now = utc_now();
            {
                use analytics_charts::Column;
                analytics_charts::Entity::update_many()
                    .col_expr(Column::DeletedAt, Expr::value(now))
                    .col_expr(Column::UpdatedAt, Expr::value(now))
                    .filter(Column::Id.eq(chart_id.as_str()))
                    .filter(Column::ReportId.eq(report_id.as_str()))
                    .filter(Column::DeletedAt.is_null())
                    .exec(&orm(db))
                    .await?;
            }
            let remaining = chart_count(db, &report_id).await?;
            set_chart_count(db, &report_id, remaining, now).await?;
            caller.publish(
                &state,
                ANALYTICS_CHART_DELETED,
                &chart_id,
                &json!({ "id": chart_id, "reportId": report_id }),
            );
            Ok(axum::Json(json!({ "success": true })).into_response())
        }
        .await,
        "Failed to delete chart",
    )
}

/// `layout.y + (layout.h || 4)` as JavaScript adds them.
fn shifted_layout(layout: Option<&Value>) -> Value {
    let mut layout = match layout {
        Some(Value::Object(fields)) => fields.clone(),
        _ => json!({ "x": 0, "y": 0, "w": 6, "h": 4 })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    };
    let h = js_number_value(layout.get("h"));
    let h = if h == 0.0 || h.is_nan() { 4.0 } else { h };
    let y = js_number_value(layout.get("y"));
    layout.insert("y".to_owned(), number_value(y + h));
    Value::Object(layout)
}

async fn duplicate_chart(
    State(state): State<FlowState>,
    caller: Caller,
    Path((report_id, chart_id)): Path<(String, String)>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            modifiable_report(&caller, &report_id).await?;
            let original = live_charts(&report_id)
                .filter(analytics_charts::Column::Id.eq(chart_id.as_str()))
                .one(&orm(db))
                .await?;
            let Some(original) = original else {
                return Err(Refusal::not_found("Chart", &chart_id));
            };
            let existing = chart_count(db, &report_id).await?;
            let new_id = generate_id("cht");
            let now = utc_now();
            let layout = shifted_layout(Some(&original.layout));
            let title = format!("{} (Copy)", original.title);
            let sort_index = i32::try_from(existing).unwrap_or(i32::MAX);
            analytics_charts::Entity::insert(chart_copy(
                original,
                new_id.clone(),
                &report_id,
                title,
                layout,
                sort_index,
                now,
            ))
            .exec_without_returning(&orm(db))
            .await?;
            set_chart_count(db, &report_id, existing + 1, now).await?;
            caller.publish(
                &state,
                ANALYTICS_CHART_CREATED,
                &new_id,
                &json!({ "id": new_id, "reportId": report_id, "duplicatedFrom": chart_id }),
            );
            Ok(Created(json!({ "id": new_id })).into_response())
        }
        .await,
        "Failed to duplicate chart",
    )
}

// ── Chart data ──────────────────────────────────────────────────────────────

const CHART_ENTITIES: [&str; 8] = [
    "project",
    "projects",
    "task",
    "tasks",
    "time_entry",
    "time_entries",
    "milestone",
    "milestones",
];

/// `chartDataQuerySchema`: the chart id and its project, if any.
fn read_chart_query(
    issues: &mut Issues,
    f: &Map<String, Value>,
) -> Option<(String, Option<String>)> {
    let chart = issues.text(f, "chartId", Presence::Required, Some(1), Some(64));
    issues.choice(f, "entity", Presence::Required, &CHART_ENTITIES);
    // `.regex(/^[a-z_]+$/).max(64)`: in that order.
    issues.text(f, "metric", Presence::Required, None, None);
    if let Some(Value::String(metric)) = f.get("metric") {
        if metric.is_empty() || !metric.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            issues.issue_at(
                "metric",
                json!({ "validation": "regex", "code": "invalid_string", "message": "Invalid" }),
            );
        }
        if utf16_len(metric) > 64 {
            issues.string_too_big("metric", 64, "String must contain at most 64 character(s)");
        }
    }
    issues.text(f, "timeRange", Presence::Optional, None, Some(32));
    issues.text(f, "groupBy", Presence::Optional, None, Some(32));
    issues.text(f, "aggregation", Presence::Optional, None, Some(16));
    issues.text(f, "sortOrder", Presence::Optional, None, Some(8));
    issues.whole_number(
        f,
        "limit",
        Presence::Nullish,
        Number {
            coerce: false,
            int: true,
            min: Some(1.0),
            max: Some(1000.0),
        },
    );
    let project = issues
        .text(f, "projectId", Presence::Nullish, Some(1), Some(64))
        .into_option();
    chart.into_option().map(|chart| (chart, project))
}

fn read_charts_data(issues: &mut Issues, f: &Map<String, Value>) -> Vec<(String, Option<String>)> {
    issues
        .list(
            f,
            "charts",
            Presence::Required,
            None,
            Some(50),
            |issues, item| {
                let fields = issues.object(item)?;
                read_chart_query(issues, fields)
            },
        )
        .into_option()
        .unwrap_or_default()
}

async fn charts_data(
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let charts = match validate(&headers, &body, read_charts_data) {
        Ok(charts) => charts,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            if load_report(&caller.db, &report_id).await?.is_none() {
                return Err(Refusal::not_found("Report", &report_id));
            }
            // A project the caller cannot see is refused, not emptied.
            let mut requested: Vec<&str> = Vec::new();
            for (_, project) in &charts {
                if let Some(project) = project.as_deref()
                    && !requested.contains(&project)
                {
                    requested.push(project);
                }
            }
            for project in requested {
                if !caller.can_access(project).await? {
                    return Err(Refusal::forbidden(PROJECT_DENIED));
                }
            }
            if !charts.is_empty() {
                tracing::warn!(
                    "[Analytics] No analytics store on this deployment: returning empty data"
                );
            }
            let data: Map<String, Value> = charts
                .into_iter()
                .map(|(chart, _)| (chart, Value::Array(Vec::new())))
                .collect();
            Ok(Data(Value::Object(data)).into_response())
        }
        .await,
        "Failed to get charts data",
    )
}
