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
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, Time};
use weldsuite_catalogs::entity_events::{
    ANALYTICS_CHART_CREATED, ANALYTICS_CHART_DELETED, ANALYTICS_REPORT_CREATED,
    ANALYTICS_REPORT_DELETED, ANALYTICS_REPORT_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_flow_domain::js::{js_number_value, math_round, number_value, utf16_len};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::projects::normalize_project_status;
use crate::{Caller, FlowState, Query, Refusal, now, reply, validate, validate_value};

const PROJECT_DENIED: &str = "You are not a member of this project";
const REPORT_OWNER_ONLY: &str = "Only the report owner or a workspace admin can change this report";

/// The KPI queries' task scope on `t`: `$1` all projects (live ones), else
/// the ids in `$2`.
macro_rules! task_scope {
    () => {
        concat!(
            "(case when $1 then t.project_id is not null and not exists (",
            "select 1 from projects xp where xp.id = t.project_id and xp.deleted_at is not null)",
            " else t.project_id = any($2) end)"
        )
    };
}

/// A chart's copied columns, for `insert … select` (`$c` the source alias).
macro_rules! chart_columns {
    () => {
        "title, description, chart_type, entity, metric, color, smooth_curve, fill_area, \
         show_data_labels, show_legend, time_range, group_by, aggregation, sort_order, \"limit\", \
         compare_with"
    };
}

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        // Membership-scoped, not gated on `projects:read`.
        .route("/summary", get(summary))
        .route("/projects/{project_id}/summary", get(project_summary))
        .route("/reports", get(list_reports).route_layer(need("projects:read")))
        .route("/reports", post(create_report).route_layer(need("projects:create")))
        .route("/reports/{report_id}", get(report).route_layer(need("projects:read")))
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
        .route("/reports/{report_id}/charts", get(list_charts).route_layer(need("projects:read")))
        .route("/reports/{report_id}/charts", post(create_chart).route_layer(need("projects:create")))
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
fn read_summary_query(issues: &mut Issues, fields: &Map<String, Value>, with_project: bool) -> (String, Option<String>) {
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
    let (period, project_id) = match validate_value(&Value::Object(q.values().clone()), |issues, f| {
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

async fn project_summary(caller: Caller, Path(project_id): Path<String>, RawQuery(raw): RawQuery) -> Response {
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
            let summary =
                kpi_summary(&caller.db, &period, Some(vec![project_id.clone()]), Some(&project_id)).await?;
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
) -> Result<Value, sqlx::Error> {
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
        if scoped.as_ref().is_some_and(|ids| !ids.iter().any(|id| id == project)) {
            return Ok(empty());
        }
        scoped = Some(vec![project.to_owned()]);
    }
    if scoped.as_ref().is_some_and(Vec::is_empty) {
        return Ok(empty());
    }
    let all = scoped.is_none();
    let ids = scoped.unwrap_or_default();
    let (today_at, tomorrow_at, from_at) = (iso_timestamp(today), iso_timestamp(tomorrow), iso_timestamp(from));

    let projects: Vec<(Option<String>, Option<String>, Option<bool>)> = sqlx::query_as(
        "select status, health, is_active from projects
         where deleted_at is null and ($1 or id = any($2))",
    )
    .bind(all)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    // Unscoped: tasks and hours of deleted projects stay out.
    let tasks: Vec<(Option<String>, Option<String>)> = sqlx::query_as(concat!(
        "select t.status, t.priority from tasks t where t.deleted_at is null and ",
        task_scope!()
    ))
    .bind(all)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let due_today: i32 = sqlx::query_scalar(concat!(
        "select count(*)::int from tasks t where t.deleted_at is null and ",
        task_scope!(),
        " and t.due_date >= $3::timestamp and t.due_date < $4::timestamp",
        " and t.status not in ('done', 'cancelled')"
    ))
    .bind(all)
    .bind(&ids)
    .bind(&today_at)
    .bind(&tomorrow_at)
    .fetch_one(db)
    .await?;
    let overdue: i32 = sqlx::query_scalar(concat!(
        "select count(*)::int from tasks t where t.deleted_at is null and ",
        task_scope!(),
        " and t.due_date is not null and t.due_date < $3::timestamp",
        " and t.status not in ('done', 'cancelled')"
    ))
    .bind(all)
    .bind(&ids)
    .bind(&today_at)
    .fetch_one(db)
    .await?;
    let hours: (f64, f64) = sqlx::query_as(
        "select coalesce(sum(e.duration)::float, 0), coalesce(sum(case when e.billable then e.duration else 0 end)::float, 0)
         from time_entries e where e.deleted_at is null
           and (case when $1 then e.project_id is not null and not exists (
                     select 1 from projects xp where xp.id = e.project_id and xp.deleted_at is not null)
                else e.project_id = any($2) end)
           and e.date >= $3::date and e.date <= $4::date",
    )
    .bind(all)
    .bind(&ids)
    .bind(&from_iso)
    .bind(&to_iso)
    .fetch_one(db)
    .await?;
    let throughput: Vec<(Option<String>, i32)> = sqlx::query_as(concat!(
        "select to_char(date_trunc('day', t.completed_date), 'YYYY-MM-DD'), count(*)::int",
        " from tasks t where t.deleted_at is null and ",
        task_scope!(),
        " and t.status = 'done' and t.completed_date is not null",
        " and t.completed_date >= $3::timestamp and t.completed_date < $4::timestamp",
        " group by date_trunc('day', t.completed_date) order by date_trunc('day', t.completed_date)"
    ))
    .bind(all)
    .bind(&ids)
    .bind(&from_at)
    .bind(&tomorrow_at)
    .fetch_all(db)
    .await?;

    let closed = |status: &Option<String>| {
        status.as_deref().filter(|s| !s.is_empty()).is_some_and(|s| {
            matches!(normalize_project_status(s).as_str(), "Completed" | "Cancelled")
        })
    };
    let active = projects
        .iter()
        .filter(|(status, _, is_active)| is_active.unwrap_or(false) && !closed(status))
        .count();
    let total = tasks.len();
    let completed = tasks.iter().filter(|(status, _)| status.as_deref() == Some("done")).count();
    #[allow(clippy::cast_precision_loss)]
    let rate = if total > 0 {
        math_round(completed as f64 / total as f64 * 1000.0) / 10.0
    } else {
        0.0
    };
    let by_day: HashMap<String, i32> = throughput
        .into_iter()
        .filter_map(|(date, count)| date.map(|d| (d, count)))
        .collect();
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

// ── Reports ─────────────────────────────────────────────────────────────────

/// The live WeldFlow report (`loadReport`).
async fn load_report(db: &PgPool, report_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from analytics_reports r
         where r.id = $1 and r.app = 'projects' and r.deleted_at is null limit 1",
    )
    .bind(report_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
async fn report_charts(db: &PgPool, report_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from analytics_charts c
         where c.report_id = $1 and c.deleted_at is null order by c.sort_index asc",
    )
    .bind(report_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// How many live charts the report has.
async fn chart_count(db: &PgPool, report_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from analytics_charts where report_id = $1 and deleted_at is null",
    )
    .bind(report_id)
    .fetch_one(db)
    .await
}

async fn set_chart_count(db: &PgPool, report_id: &str, count: i64, at: &str) -> Result<(), sqlx::Error> {
    sqlx::query("update analytics_reports set chart_count = $2, updated_at = $3::timestamp where id = $1")
        .bind(report_id)
        .bind(i32::try_from(count).unwrap_or(i32::MAX))
        .bind(at)
        .execute(db)
        .await
        .map(|_| ())
}

async fn list_reports(caller: Caller) -> Response {
    reply(
        async {
            let rows: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(r) from analytics_reports r
                 where r.app = 'projects' and r.deleted_at is null order by r.updated_at desc",
            )
            .fetch_all(&caller.db)
            .await?;
            Ok(Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response())
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
fn read_report(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
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

async fn create_report(State(state): State<FlowState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_report(issues, fields, false)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            let id = generate_id("rpt");
            let title = text_of(&data, "title").unwrap_or_default();
            sqlx::query(
                "insert into analytics_reports (id, app, title, description, created_by_id, chart_count, created_at, updated_at)
                 values ($1, 'projects', $2, $3, $4, 0, $5::timestamp, $5::timestamp)",
            )
            .bind(&id)
            .bind(title)
            .bind(text_of(&data, "description").unwrap_or_default())
            .bind(&caller.user_id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, ANALYTICS_REPORT_CREATED, &id, &json!({ "id": id, "title": title }));
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
    let data = match validate(&headers, &body, |issues, fields| read_report(issues, fields, true)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            modifiable_report(&caller, &report_id).await?;
            sqlx::query(
                "update analytics_reports set
                     title = case when $2 then $3 else title end,
                     description = case when $4 then $5 else description end,
                     updated_at = $6::timestamp
                 where id = $1 and app = 'projects' and deleted_at is null",
            )
            .bind(&report_id)
            .bind(data.contains_key("title"))
            .bind(text_of(&data, "title"))
            .bind(data.contains_key("description"))
            .bind(text_of(&data, "description"))
            .bind(now())
            .execute(&caller.db)
            .await?;
            let mut event = data.clone();
            event.insert("id".to_owned(), Value::String(report_id.clone()));
            caller.publish(&state, ANALYTICS_REPORT_UPDATED, &report_id, &Value::Object(event));
            Ok(Data(json!({ "id": report_id })).into_response())
        }
        .await,
        "Failed to update report",
    )
}

async fn delete_report(State(state): State<FlowState>, caller: Caller, Path(report_id): Path<String>) -> Response {
    reply(
        async {
            modifiable_report(&caller, &report_id).await?;
            sqlx::query(
                "update analytics_reports set deleted_at = $2::timestamp, updated_at = $2::timestamp
                 where id = $1 and app = 'projects' and deleted_at is null",
            )
            .bind(&report_id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, ANALYTICS_REPORT_DELETED, &report_id, &json!({ "id": report_id }));
            Ok(axum::Json(json!({ "success": true })).into_response())
        }
        .await,
        "Failed to delete report",
    )
}

async fn duplicate_report(State(state): State<FlowState>, caller: Caller, Path(report_id): Path<String>) -> Response {
    reply(
        async {
            let db = &caller.db;
            if load_report(db, &report_id).await?.is_none() {
                return Err(Refusal::not_found("Report", &report_id));
            }
            let new_id = generate_id("rpt");
            let now = now();
            sqlx::query(
                "insert into analytics_reports (id, app, title, description, created_by_id, chart_count, created_at, updated_at)
                 select $1, 'projects', r.title || ' (Copy)', r.description, $3, r.chart_count, $4::timestamp, $4::timestamp
                 from analytics_reports r where r.id = $2",
            )
            .bind(&new_id)
            .bind(&report_id)
            .bind(&caller.user_id)
            .bind(&now)
            .execute(db)
            .await?;
            let charts: Vec<String> = sqlx::query_scalar(
                "select id from analytics_charts where report_id = $1 and deleted_at is null",
            )
            .bind(&report_id)
            .fetch_all(db)
            .await?;
            if !charts.is_empty() {
                let new_ids: Vec<String> = charts.iter().map(|_| generate_id("cht")).collect();
                sqlx::query(concat!(
                    "insert into analytics_charts (id, report_id, app, ",
                    chart_columns!(),
                    ", layout, sort_index, created_at, updated_at)",
                    " select n.new_id, $3, 'projects', c.title, c.description, c.chart_type, c.entity,",
                    " c.metric, c.color, c.smooth_curve, c.fill_area, c.show_data_labels, c.show_legend,",
                    " c.time_range, c.group_by, c.aggregation, c.sort_order, c.\"limit\", c.compare_with,",
                    " c.layout, c.sort_index, $4::timestamp, $4::timestamp",
                    " from unnest($1::varchar[], $2::varchar[]) with ordinality as n(new_id, old_id, ord)",
                    " join analytics_charts c on c.id = n.old_id order by n.ord"
                ))
                    .bind(&new_ids)
                    .bind(&charts)
                    .bind(&new_id)
                    .bind(&now)
                    .execute(db)
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
    let mut text = |issues: &mut Issues, key: &str, presence: Presence, min: Option<usize>, max: Option<usize>, default: Option<&str>| {
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
    text(issues, "title", Presence::Required, Some(1), Some(255), None);
    text(issues, "description", Presence::Optional, None, None, None);
    text(issues, "chartType", Presence::Required, Some(1), None, None);
    text(issues, "entity", Presence::Required, Some(1), None, None);
    text(issues, "metric", Presence::Required, Some(1), None, None);
    text(issues, "color", Presence::Optional, None, None, Some("#3b82f6"));
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
    if issues.number(f, "limit", Presence::Optional, Number::default()).as_set().is_some()
        && let Some(limit) = f.get("limit")
    {
        flags.insert("limit".to_owned(), limit.clone());
    }
    if let Some(compare) = issues.text(f, "compareWith", Presence::Optional, None, None).into_option() {
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
    text_of(data, key).filter(|v| !v.is_empty()).unwrap_or(fallback)
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
            let now = now();
            // `data.limit || null`: 0 is no limit.
            let limit = data
                .get("limit")
                .and_then(Value::as_f64)
                .filter(|l| *l != 0.0 && !l.is_nan());
            let layout = data
                .get("layout")
                .cloned()
                .unwrap_or_else(|| json!({ "x": 0, "y": 0, "w": 6, "h": 4 }));
            sqlx::query(
                "insert into analytics_charts (id, report_id, app, title, description, chart_type, entity, metric,
                     color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                     aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at)
                 values ($1, $2, 'projects', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                         $17::float8::integer, $18, $19, $20, $21::timestamp, $21::timestamp)",
            )
            .bind(&id)
            .bind(&report_id)
            .bind(text_of(&data, "title"))
            .bind(text_of(&data, "description").filter(|d| !d.is_empty()))
            .bind(text_of(&data, "chartType"))
            .bind(text_of(&data, "entity"))
            .bind(text_of(&data, "metric"))
            .bind(or_text(&data, "color", "#3b82f6"))
            .bind(data["smoothCurve"].as_bool())
            .bind(data["fillArea"].as_bool())
            .bind(data["showDataLabels"].as_bool())
            .bind(data["showLegend"].as_bool())
            .bind(or_text(&data, "timeRange", "last_30_days"))
            .bind(or_text(&data, "groupBy", "day"))
            .bind(or_text(&data, "aggregation", "sum"))
            .bind(or_text(&data, "sortOrder", "asc"))
            .bind(limit)
            .bind(text_of(&data, "compareWith").filter(|c| !c.is_empty()))
            .bind(&layout)
            .bind(i32::try_from(existing).unwrap_or(i32::MAX))
            .bind(&now)
            .execute(db)
            .await?;
            set_chart_count(db, &report_id, existing + 1, &now).await?;
            caller.publish(&state, ANALYTICS_CHART_CREATED, &id, &json!({ "id": id, "reportId": report_id }));
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
        "Failed to create chart",
    )
}

/// `updateChartLayoutsSchema`.
fn read_layouts(issues: &mut Issues, f: &Map<String, Value>) -> Vec<(String, Value)> {
    issues
        .list(f, "layouts", Presence::Required, None, None, |issues, item| {
            let fields = issues.object(item)?;
            let chart = issues.text(fields, "chartId", Presence::Required, None, None);
            let layout = issues.nested(fields, "layout", Presence::Required, read_layout);
            match (chart, layout) {
                (Field::Set(chart), Field::Set(layout)) => Some((chart, layout)),
                _ => None,
            }
        })
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
            let now = now();
            for (chart, layout) in &layouts {
                sqlx::query(
                    "update analytics_charts set layout = $3, updated_at = $4::timestamp
                     where id = $1 and report_id = $2 and deleted_at is null",
                )
                .bind(chart)
                .bind(&report_id)
                .bind(layout)
                .bind(&now)
                .execute(&caller.db)
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
            let now = now();
            sqlx::query(
                "update analytics_charts set deleted_at = $3::timestamp, updated_at = $3::timestamp
                 where id = $1 and report_id = $2 and deleted_at is null",
            )
            .bind(&chart_id)
            .bind(&report_id)
            .bind(&now)
            .execute(db)
            .await?;
            let remaining = chart_count(db, &report_id).await?;
            set_chart_count(db, &report_id, remaining, &now).await?;
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
            let original: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(c) from analytics_charts c
                 where c.id = $1 and c.report_id = $2 and c.deleted_at is null limit 1",
            )
            .bind(&chart_id)
            .bind(&report_id)
            .fetch_optional(db)
            .await?;
            let Some(original) = original else {
                return Err(Refusal::not_found("Chart", &chart_id));
            };
            let existing = chart_count(db, &report_id).await?;
            let new_id = generate_id("cht");
            let now = now();
            let layout = shifted_layout(original.get("layout"));
            sqlx::query(concat!(
                "insert into analytics_charts (id, report_id, app, ",
                chart_columns!(),
                ", layout, sort_index, created_at, updated_at)",
                " select $1, $2, 'projects', c.title || ' (Copy)', c.description, c.chart_type,",
                " c.entity, c.metric, c.color, c.smooth_curve, c.fill_area, c.show_data_labels,",
                " c.show_legend, c.time_range, c.group_by, c.aggregation, c.sort_order, c.\"limit\",",
                " c.compare_with, $4, $5, $6::timestamp, $6::timestamp",
                " from analytics_charts c where c.id = $3"
            ))
                .bind(&new_id)
                .bind(&report_id)
                .bind(&chart_id)
                .bind(&layout)
                .bind(i32::try_from(existing).unwrap_or(i32::MAX))
                .bind(&now)
                .execute(db)
                .await?;
            set_chart_count(db, &report_id, existing + 1, &now).await?;
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
fn read_chart_query(issues: &mut Issues, f: &Map<String, Value>) -> Option<(String, Option<String>)> {
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
        .list(f, "charts", Presence::Required, None, Some(50), |issues, item| {
            let fields = issues.object(item)?;
            read_chart_query(issues, fields)
        })
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
