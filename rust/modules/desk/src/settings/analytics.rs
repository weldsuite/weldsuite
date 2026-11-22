//! `/api/helpdesk-analytics` (`routes/helpdesk-analytics/index.ts`):
//! helpdesk reports (`helpdesk_analytics_reports`), their charts
//! (`helpdesk_analytics_charts`) and chart data.
//! Permissions `settings:read|create|update|delete`.
//!
//! Mounted here too, as the worker mounts them: the CSV exports
//! ([`super::export`]), the scheduled report emails at `/schedules`
//! ([`super::schedules`]) and the live reports ([`super::live`]: the
//! wallboard, which takes `conversations:read`, and the phone report).
//!
//! The overview (`GET /overview`) and the chart data are aggregated from the
//! live inbox in the tenant database (`services/desk-reports.ts`, ADR
//! DESK-011), by [`reports`], which runs the worker's statements. An unknown
//! metric answers an empty series. "Now" is the request's clock
//! (`CONFORMANCE_NOW` in conformance builds only).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    helpdesk_analytics_charts as charts, helpdesk_analytics_reports as reports_table,
};

use super::reports::{self, ChartQuery};
use super::{export, lenient_json, live, schedules, stamp};
use crate::crud::write_failed;
use crate::js::query_param;
use crate::tables::{HELPDESK_ANALYTICS_CHARTS as CHARTS, HELPDESK_ANALYTICS_REPORTS as REPORTS};
use crate::{Caller, DeskState, Refusal, now, validate};

/// `update(helpdeskAnalyticsReports).set({ chartCount: count, updatedAt })`
/// of the report `id`.
async fn set_chart_count(
    db: &PgPool,
    id: &str,
    count: Expr,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    reports_table::Entity::update_many()
        .col_expr(reports_table::Column::ChartCount, count)
        .col_expr(reports_table::Column::UpdatedAt, Expr::value(at))
        .filter(reports_table::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list_reports).route_layer(need("settings:read")))
        .route(
            "/",
            post(create_report).route_layer(need("settings:create")),
        )
        .route(
            "/reports/{report_id}",
            get(report_detail).route_layer(need("settings:read")),
        )
        .route(
            "/{id}",
            patch(update_report).route_layer(need("settings:update")),
        )
        .route(
            "/{id}",
            delete(delete_report).route_layer(need("settings:delete")),
        )
        .route(
            "/reports/{report_id}/duplicate",
            post(duplicate_report).route_layer(need("settings:create")),
        )
        .route(
            "/reports/{report_id}/charts",
            get(list_charts).route_layer(need("settings:read")),
        )
        .route(
            "/charts",
            post(create_chart).route_layer(need("settings:create")),
        )
        .route(
            "/charts/{chart_id}",
            get(chart_detail).route_layer(need("settings:read")),
        )
        .route(
            "/charts/{chart_id}",
            put(update_chart).route_layer(need("settings:update")),
        )
        .route(
            "/reports/{report_id}/layouts",
            patch(update_layouts).route_layer(need("settings:update")),
        )
        .route(
            "/charts/{chart_id}",
            delete(delete_chart).route_layer(need("settings:delete")),
        )
        .route(
            "/overview",
            get(overview).route_layer(need("settings:read")),
        )
        .route(
            "/overview/export",
            get(export::overview_export).route_layer(need("settings:read")),
        )
        .route(
            "/reports/{report_id}/export",
            get(export::report_export).route_layer(need("settings:read")),
        )
        .route(
            "/wallboard",
            get(live::wallboard_route).route_layer(need("conversations:read")),
        )
        .route(
            "/phone",
            get(live::phone_route).route_layer(need("settings:read")),
        )
        .nest("/schedules", schedules::routes(gate))
        .route(
            "/charts/data",
            post(chart_data).route_layer(need("settings:read")),
        )
        .route(
            "/charts/batch-data",
            post(batch_data).route_layer(need("settings:read")),
        )
}

// ── schemas ─────────────────────────────────────────────────────────────────

fn put_text(
    issues: &mut Issues,
    body: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) {
    if let Some(text) = issues.text(body, key, presence, min, max).into_option() {
        out.insert(key.to_owned(), Value::String(text));
    }
}

/// `createReportSchema` (`partial`: its `.partial()`).
fn read_report(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    put_text(
        issues,
        body,
        &mut out,
        "title",
        required,
        Some(1),
        Some(255),
    );
    put_text(
        issues,
        body,
        &mut out,
        "description",
        Presence::Optional,
        None,
        None,
    );
    out
}

/// The chart layout object: `x`, `y`, `w`, `h` and the optional minimums.
fn read_layout(issues: &mut Issues, body: &Map<String, Value>) -> Option<Value> {
    issues
        .nested(body, "layout", Presence::Optional, |issues, layout| {
            let mut out = Map::new();
            for (key, presence) in [
                ("x", Presence::Required),
                ("y", Presence::Required),
                ("w", Presence::Required),
                ("h", Presence::Required),
                ("minW", Presence::Optional),
                ("minH", Presence::Optional),
            ] {
                if issues
                    .number(layout, key, presence, Number::default())
                    .into_option()
                    .is_some()
                    && let Some(value) = layout.get(key)
                {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(out)
        })
        .into_option()
}

/// `createChartSchema`; `update` is `.partial().omit({ reportId })`, where
/// the defaults no longer apply.
fn read_chart(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> Map<String, Value> {
    let required = if update {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    if !update {
        put_text(issues, body, &mut out, "reportId", required, Some(1), None);
    }
    put_text(
        issues,
        body,
        &mut out,
        "title",
        required,
        Some(1),
        Some(255),
    );
    put_text(
        issues,
        body,
        &mut out,
        "description",
        Presence::Optional,
        None,
        None,
    );
    put_text(issues, body, &mut out, "chartType", required, Some(1), None);
    put_text(issues, body, &mut out, "entity", required, Some(1), None);
    put_text(issues, body, &mut out, "metric", required, Some(1), None);
    let defaults: [(&str, Value); 9] = [
        ("color", json!("#3b82f6")),
        ("smoothCurve", json!(true)),
        ("fillArea", json!(true)),
        ("showDataLabels", json!(false)),
        ("showLegend", json!(true)),
        ("timeRange", json!("last_30_days")),
        ("groupBy", json!("day")),
        ("aggregation", json!("sum")),
        ("sortOrder", json!("asc")),
    ];
    for (key, default) in defaults {
        let read = if default.is_boolean() {
            issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::Bool)
        } else {
            issues
                .text(body, key, Presence::Optional, None, None)
                .into_option()
                .map(Value::String)
        };
        match read {
            Some(value) => {
                out.insert(key.to_owned(), value);
            }
            // `.default(…)` fills an absent field; under `.partial()` it doesn't.
            None if !update && !body.contains_key(key) => {
                out.insert(key.to_owned(), default);
            }
            None => {}
        }
    }
    if issues
        .number(body, "limit", Presence::Optional, Number::default())
        .into_option()
        .is_some()
        && let Some(limit) = body.get("limit")
    {
        out.insert("limit".to_owned(), limit.clone());
    }
    put_text(
        issues,
        body,
        &mut out,
        "compareWith",
        Presence::Optional,
        None,
        None,
    );
    if let Some(layout) = read_layout(issues, body) {
        out.insert("layout".to_owned(), layout);
    }
    out
}

// ── reports ─────────────────────────────────────────────────────────────────

async fn live_report(db: &PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    REPORTS.find_live(db, id).await
}

async fn list_reports(caller: Caller) -> Response {
    let rows = reports_table::Entity::find()
        .filter(reports_table::Column::DeletedAt.is_null())
        .order_by_desc(reports_table::Column::UpdatedAt)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(json!(rows)).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch analytics reports"),
    }
}

async fn report_detail(caller: Caller, Path(report_id): Path<String>) -> Response {
    let message = "Failed to fetch analytics report";
    match live_report(&caller.db, &report_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Report", &report_id).respond(message),
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn create_report(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to create analytics report";
    let data = match validate(&headers, &body, |issues, fields| {
        read_report(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let id = generate_id("rpt");
    let now = now();
    let mut values = Map::new();
    REPORTS.set(&mut values, "id", json!(id));
    REPORTS.set(&mut values, "title", data["title"].clone());
    REPORTS.set(
        &mut values,
        "description",
        data.get("description").cloned().unwrap_or(Value::Null),
    );
    REPORTS.set(&mut values, "chartCount", json!(0));
    REPORTS.set(&mut values, "createdById", json!(caller.user_id));
    REPORTS.set(&mut values, "createdAt", json!(now));
    REPORTS.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = REPORTS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ANALYTICS_REPORT_CREATED,
        &id,
        &json!({ "id": id, "title": data["title"] }),
    );
    Created(json!({ "id": id })).into_response()
}

async fn update_report(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update analytics report";
    let data = match validate(&headers, &body, |issues, fields| {
        read_report(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    match live_report(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Report", &id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    }
    let mut values = Map::new();
    REPORTS.set(&mut values, "updatedAt", json!(now()));
    values.extend(REPORTS.values(&data));
    if let Err(error) = REPORTS
        .patch(&caller.db, &id, values, true, &["updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ANALYTICS_REPORT_UPDATED,
        &id,
        &json!({ "id": id }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn delete_report(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = "Failed to delete analytics report";
    let now = utc_now();
    match live_report(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Report", &id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    }
    let db = orm(&caller.db);
    // Every chart of the report, those deleted before included.
    let deleted = charts::Entity::update_many()
        .col_expr(charts::Column::DeletedAt, Expr::value(now))
        .filter(charts::Column::ReportId.eq(&id))
        .exec(&db)
        .await;
    if let Err(error) = deleted {
        return Refusal::from(error).respond(message);
    }
    let report = reports_table::Entity::update_many()
        .col_expr(reports_table::Column::DeletedAt, Expr::value(now))
        .col_expr(reports_table::Column::UpdatedAt, Expr::value(now))
        .filter(reports_table::Column::Id.eq(&id))
        .exec(&db)
        .await;
    if let Err(error) = report {
        return Refusal::from(error).respond(message);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ANALYTICS_REPORT_DELETED,
        &id,
        &json!({ "id": id }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn duplicate_report(caller: Caller, Path(report_id): Path<String>) -> Response {
    let message = "Failed to duplicate analytics report";
    let original = match live_report(&caller.db, &report_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Report", &report_id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    };
    match duplicate(&caller, &report_id, &original).await {
        Ok(id) => Created(json!({ "id": id })).into_response(),
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn duplicate(caller: &Caller, report_id: &str, original: &Value) -> Result<String, DbErr> {
    let new_id = generate_id("rpt");
    let now = utc_now();
    let title = format!("{} (Copy)", original["title"].as_str().unwrap_or_default());
    let db = orm(&caller.db);
    reports_table::Entity::insert(reports_table::ActiveModel {
        id: Set(new_id.clone()),
        title: Set(title),
        description: Set(original["description"].as_str().map(str::to_owned)),
        chart_count: Set(0),
        created_by_id: Set(Some(caller.user_id.clone())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    // The live charts, in the order the select returns them (no ORDER BY).
    let originals = charts::Entity::find()
        .filter(charts::Column::ReportId.eq(report_id))
        .filter(charts::Column::DeletedAt.is_null())
        .all(&db)
        .await?;
    if originals.is_empty() {
        return Ok(new_id);
    }
    let count = i32::try_from(originals.len()).unwrap_or(i32::MAX);
    let copies = originals.into_iter().map(|chart| charts::ActiveModel {
        id: Set(generate_id("cht")),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
        report_id: Set(new_id.clone()),
        title: Set(chart.title),
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
        layout: Set(chart.layout),
        sort_index: Set(chart.sort_index),
    });
    charts::Entity::insert_many(copies)
        .exec_without_returning(&db)
        .await?;
    set_chart_count(&caller.db, &new_id, Expr::value(count), now).await?;
    Ok(new_id)
}

// ── charts ──────────────────────────────────────────────────────────────────

async fn list_charts(caller: Caller, Path(report_id): Path<String>) -> Response {
    let rows = charts::Entity::find()
        .filter(charts::Column::ReportId.eq(&report_id))
        .filter(charts::Column::DeletedAt.is_null())
        .order_by_asc(charts::Column::SortIndex)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(json!(rows)).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch charts"),
    }
}

async fn create_chart(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let message = "Failed to create chart";
    let data = match validate(&headers, &body, |issues, fields| {
        read_chart(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let report_id = data["reportId"].as_str().unwrap_or_default().to_owned();
    let max: Result<Option<Option<i32>>, _> = charts::Entity::find()
        .select_only()
        .column_as(charts::Column::SortIndex.max(), "max")
        .filter(charts::Column::ReportId.eq(&report_id))
        .filter(charts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let next = match max {
        Ok(max) => max.flatten().unwrap_or(-1) + 1,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let id = generate_id("cht");
    let (now, at) = stamp();
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| CHARTS.set(&mut values, prop, value);
    set("id", json!(id));
    for prop in [
        "reportId",
        "title",
        "chartType",
        "entity",
        "metric",
        "color",
        "smoothCurve",
        "fillArea",
        "showDataLabels",
        "showLegend",
        "timeRange",
        "groupBy",
        "aggregation",
        "sortOrder",
    ] {
        set(prop, data.get(prop).cloned().unwrap_or(Value::Null));
    }
    for prop in ["description", "limit", "compareWith"] {
        set(prop, data.get(prop).cloned().unwrap_or(Value::Null));
    }
    set(
        "layout",
        data.get("layout")
            .cloned()
            .unwrap_or_else(|| json!({ "x": 0, "y": next * 4, "w": 6, "h": 4 })),
    );
    set("sortIndex", json!(next));
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    if let Err(error) = CHARTS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    let count = sea_orm::ExprTrait::add(Expr::col(reports_table::Column::ChartCount), 1);
    if let Err(error) = set_chart_count(&caller.db, &report_id, count, at).await {
        return Refusal::from(error).respond(message);
    }
    Created(json!({ "id": id })).into_response()
}

async fn chart_detail(caller: Caller, Path(chart_id): Path<String>) -> Response {
    let message = "Failed to fetch chart";
    match CHARTS.find_live(&caller.db, &chart_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Chart", &chart_id).respond(message),
        Err(error) => Refusal::from(error).respond(message),
    }
}

/// Answers `{ id }` whether or not a live chart had that id.
async fn update_chart(
    caller: Caller,
    Path(chart_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update chart";
    let data = match validate(&headers, &body, |issues, fields| {
        read_chart(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let mut values = CHARTS.values(&data);
    CHARTS.set(&mut values, "updatedAt", json!(now()));
    if let Err(error) = CHARTS
        .patch(&caller.db, &chart_id, values, true, &["updatedAt"])
        .await
    {
        return write_failed(&error, message);
    }
    Data(json!({ "id": chart_id })).into_response()
}

async fn update_layouts(caller: Caller, Path(report_id): Path<String>, body: Bytes) -> Response {
    let message = "Failed to update chart layouts";
    // `c.req.json().catch(() => ({ layouts: [] }))`, then `body.layouts.map`:
    // anything but an array there throws inside the route's `try`.
    let layouts = match lenient_json(&body) {
        None => Vec::new(),
        Some(Value::Object(mut fields)) => match fields.remove("layouts") {
            Some(Value::Array(items)) => items,
            _ => return ApiError::internal().with_message(message).into_response(),
        },
        Some(_) => return ApiError::internal().with_message(message).into_response(),
    };
    let now = utc_now();
    let db = orm(&caller.db);
    for item in &layouts {
        let Value::Object(item) = item else {
            return ApiError::internal().with_message(message).into_response();
        };
        // `eq(id, item.chartId)`: anything but a string matches no chart.
        let Some(chart_id) = item.get("chartId").and_then(Value::as_str) else {
            continue;
        };
        let mut update = charts::Entity::update_many();
        if let Some(layout) = item.get("layout") {
            update = update.col_expr(charts::Column::Layout, Expr::value(layout.clone()));
        }
        let changed = update
            .col_expr(charts::Column::UpdatedAt, Expr::value(now))
            .filter(charts::Column::Id.eq(chart_id))
            .filter(charts::Column::ReportId.eq(&report_id))
            .exec(&db)
            .await;
        if let Err(error) = changed {
            return Refusal::from(error).respond(message);
        }
    }
    Data(json!({ "updated": layouts.len() })).into_response()
}

async fn delete_chart(caller: Caller, Path(chart_id): Path<String>) -> Response {
    let message = "Failed to delete chart";
    let chart = match CHARTS.find_live(&caller.db, &chart_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Chart", &chart_id).respond(message),
        Err(error) => return Refusal::from(error).respond(message),
    };
    let now = utc_now();
    let deleted = charts::Entity::update_many()
        .col_expr(charts::Column::DeletedAt, Expr::value(now))
        .filter(charts::Column::Id.eq(&chart_id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = deleted {
        return Refusal::from(error).respond(message);
    }
    // `reportId` is never null on a stored chart.
    if let Some(report_id) = chart["reportId"].as_str() {
        let count = Expr::from(Func::greatest([
            sea_orm::ExprTrait::sub(Expr::col(reports_table::Column::ChartCount), 1),
            Expr::value(0),
        ]));
        if let Err(error) = set_chart_count(&caller.db, report_id, count, now).await {
            return Refusal::from(error).respond(message);
        }
    }
    Data(json!({ "id": chart_id })).into_response()
}

// ── chart data ──────────────────────────────────────────────────────────────

/// `GET /overview?range=`: anything but a known range is the last 30 days.
async fn overview(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let range = query_param(query.as_deref(), "range");
    match reports::overview(&caller.db, range.as_deref(), reports::clock_ms(&caller)).await {
        Ok(data) => Data(data).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch the reports overview"),
    }
}

async fn chart_data(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let message = "Failed to fetch chart data";
    let read = validate(&headers, &body, |issues, fields| {
        for key in ["entity", "metric", "timeRange", "groupBy", "aggregation"] {
            issues.text(fields, key, Presence::Required, Some(1), None);
        }
        issues.text(fields, "sortOrder", Presence::Optional, None, None);
        issues.number(fields, "limit", Presence::Optional, Number::default());
        ChartQuery::from_fields(fields)
    });
    let query = match read {
        Ok(query) => query,
        Err(refusal) => return refusal.respond(message),
    };
    match reports::chart_data(&caller.db, &query, reports::clock_ms(&caller)).await {
        Ok(points) => Data(Value::Array(points)).into_response(),
        Err(error) => Refusal::from(error).respond(message),
    }
}

/// `String(value)` of a chart id used as an object key.
fn js_key(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(other) => other.to_string(),
    }
}

async fn batch_data(caller: Caller, body: Bytes) -> Response {
    let message = "Failed to fetch batch chart data";
    // `c.req.json().catch(() => ({ charts: [] }))`, then `body.charts.map`.
    let charts = match lenient_json(&body) {
        None => Vec::new(),
        Some(Value::Object(mut fields)) => match fields.remove("charts") {
            Some(Value::Array(items)) => items,
            _ => return ApiError::internal().with_message(message).into_response(),
        },
        Some(_) => return ApiError::internal().with_message(message).into_response(),
    };
    let now = reports::clock_ms(&caller);
    let mut data = Map::new();
    for chart in &charts {
        // `chart.chartId` throws only on null; other values have no such key.
        let chart_id = match chart {
            Value::Null => return ApiError::internal().with_message(message).into_response(),
            Value::Object(chart) => chart.get("chartId"),
            _ => None,
        };
        // Anything but an object reads as a chart with no metric: empty.
        let query = match chart {
            Value::Object(fields) => ChartQuery::from_fields(fields),
            _ => ChartQuery::default(),
        };
        match reports::chart_data(&caller.db, &query, now).await {
            Ok(points) => {
                data.insert(js_key(chart_id), Value::Array(points));
            }
            Err(error) => return Refusal::from(error).respond(message),
        }
    }
    Data(Value::Object(data)).into_response()
}
