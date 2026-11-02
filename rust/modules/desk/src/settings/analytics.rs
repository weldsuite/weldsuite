//! `/api/helpdesk-analytics` (`routes/helpdesk-analytics/index.ts`):
//! helpdesk reports (`helpdesk_analytics_reports`), their charts
//! (`helpdesk_analytics_charts`) and chart data.
//! Permissions `settings:read|create|update|delete`.
//!
//! Chart data: the worker reads it from Cloudflare's R2 SQL API
//! (`@weldsuite/core-domain/analytics-query`), which answers an empty series
//! whenever `R2_SQL_API_TOKEN`, `CF_ACCOUNT_ID` or `R2_ANALYTICS_BUCKET` is
//! missing. A Kubernetes deployment has no R2 Data Catalog, so these routes
//! answer what the worker answers without them: an empty series per chart.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::lenient_json;
use crate::crud::write_failed;
use crate::tables::{HELPDESK_ANALYTICS_CHARTS as CHARTS, HELPDESK_ANALYTICS_REPORTS as REPORTS};
use crate::{Caller, DeskState, Refusal, now, validate};

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

async fn live_report(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    REPORTS.find_live(db, id).await
}

async fn list_reports(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_analytics_reports t where t.deleted_at is null
         order by t.updated_at desc",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter().map(|row| REPORTS.js(row)).collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch analytics reports"),
    }
}

async fn report_detail(caller: Caller, Path(report_id): Path<String>) -> Response {
    let message = "Failed to fetch analytics report";
    match live_report(&caller.db, &report_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Report", &report_id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
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
        Err(error) => return Refusal::Database(error).respond(message),
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
    let now = now();
    match live_report(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Report", &id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    }
    // Every chart of the report, those deleted before included.
    let charts = sqlx::query(
        "update helpdesk_analytics_charts set deleted_at = $2::timestamp where report_id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = charts {
        return Refusal::Database(error).respond(message);
    }
    let report = sqlx::query(
        "update helpdesk_analytics_reports set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = report {
        return Refusal::Database(error).respond(message);
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
        Err(error) => return Refusal::Database(error).respond(message),
    };
    match duplicate(&caller, &report_id, &original).await {
        Ok(id) => Created(json!({ "id": id })).into_response(),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

async fn duplicate(
    caller: &Caller,
    report_id: &str,
    original: &Value,
) -> Result<String, sqlx::Error> {
    let new_id = generate_id("rpt");
    let now = now();
    let title = format!("{} (Copy)", original["title"].as_str().unwrap_or_default());
    sqlx::query(
        "insert into helpdesk_analytics_reports (id, title, description, chart_count, created_by_id, created_at, updated_at)
         values ($1, $2, $3, 0, $4, $5::timestamp, $5::timestamp)",
    )
    .bind(&new_id)
    .bind(&title)
    .bind(original["description"].as_str())
    .bind(&caller.user_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    // The live charts, in the order the select returns them (no ORDER BY).
    let charts: Vec<String> = sqlx::query_scalar(
        "select id from helpdesk_analytics_charts where report_id = $1 and deleted_at is null",
    )
    .bind(report_id)
    .fetch_all(&caller.db)
    .await?;
    if charts.is_empty() {
        return Ok(new_id);
    }
    let copies: Vec<String> = charts.iter().map(|_| generate_id("cht")).collect();
    sqlx::query(
        "insert into helpdesk_analytics_charts
           (id, report_id, title, description, chart_type, entity, metric, color, smooth_curve, fill_area,
            show_data_labels, show_legend, time_range, group_by, aggregation, sort_order, \"limit\",
            compare_with, layout, sort_index, created_at, updated_at)
         select u.new_id, $3, c.title, c.description, c.chart_type, c.entity, c.metric, c.color, c.smooth_curve,
                c.fill_area, c.show_data_labels, c.show_legend, c.time_range, c.group_by, c.aggregation,
                c.sort_order, c.\"limit\", c.compare_with, c.layout, c.sort_index, $4::timestamp, $4::timestamp
         from unnest($1::varchar[], $2::varchar[]) with ordinality as u(new_id, old_id, ord)
         join helpdesk_analytics_charts c on c.id = u.old_id
         order by u.ord",
    )
    .bind(&copies)
    .bind(&charts)
    .bind(&new_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    sqlx::query(
        "update helpdesk_analytics_reports set chart_count = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&new_id)
    .bind(i32::try_from(charts.len()).unwrap_or(i32::MAX))
    .bind(&now)
    .execute(&caller.db)
    .await?;
    Ok(new_id)
}

// ── charts ──────────────────────────────────────────────────────────────────

async fn list_charts(caller: Caller, Path(report_id): Path<String>) -> Response {
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_analytics_charts t
         where t.report_id = $1 and t.deleted_at is null order by t.sort_index asc",
    )
    .bind(&report_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter().map(|row| CHARTS.js(row)).collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch charts"),
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
    let max: Result<i32, _> = sqlx::query_scalar(
        "select coalesce(max(sort_index), -1)::int from helpdesk_analytics_charts
         where report_id = $1 and deleted_at is null",
    )
    .bind(&report_id)
    .fetch_one(&caller.db)
    .await;
    let next = match max {
        Ok(max) => max + 1,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let id = generate_id("cht");
    let now = now();
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
    let counted = sqlx::query(
        "update helpdesk_analytics_reports set chart_count = chart_count + 1, updated_at = $2::timestamp where id = $1",
    )
    .bind(&report_id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = counted {
        return Refusal::Database(error).respond(message);
    }
    Created(json!({ "id": id })).into_response()
}

async fn chart_detail(caller: Caller, Path(chart_id): Path<String>) -> Response {
    let message = "Failed to fetch chart";
    match CHARTS.find_live(&caller.db, &chart_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Chart", &chart_id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
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
    let now = now();
    for item in &layouts {
        let Value::Object(item) = item else {
            return ApiError::internal().with_message(message).into_response();
        };
        let changed = sqlx::query(
            "update helpdesk_analytics_charts
             set layout = case when $3::boolean then $4::jsonb else layout end, updated_at = $5::timestamp
             where id = $1 and report_id = $2",
        )
        .bind(item.get("chartId").and_then(Value::as_str))
        .bind(&report_id)
        .bind(item.contains_key("layout"))
        .bind(item.get("layout"))
        .bind(&now)
        .execute(&caller.db)
        .await;
        if let Err(error) = changed {
            return Refusal::Database(error).respond(message);
        }
    }
    Data(json!({ "updated": layouts.len() })).into_response()
}

async fn delete_chart(caller: Caller, Path(chart_id): Path<String>) -> Response {
    let message = "Failed to delete chart";
    let chart = match CHARTS.find_live(&caller.db, &chart_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Chart", &chart_id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let now = now();
    let deleted = sqlx::query(
        "update helpdesk_analytics_charts set deleted_at = $2::timestamp where id = $1",
    )
    .bind(&chart_id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = deleted {
        return Refusal::Database(error).respond(message);
    }
    let counted = sqlx::query(
        "update helpdesk_analytics_reports set chart_count = greatest(chart_count - 1, 0), updated_at = $2::timestamp
         where id = $1",
    )
    .bind(chart["reportId"].as_str())
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = counted {
        return Refusal::Database(error).respond(message);
    }
    Data(json!({ "id": chart_id })).into_response()
}

// ── chart data ──────────────────────────────────────────────────────────────

async fn chart_data(headers: HeaderMap, body: Bytes) -> Response {
    let message = "Failed to fetch chart data";
    let read = validate(&headers, &body, |issues, fields| {
        for key in ["entity", "metric", "timeRange", "groupBy", "aggregation"] {
            issues.text(fields, key, Presence::Required, Some(1), None);
        }
        issues.text(fields, "sortOrder", Presence::Optional, None, None);
        issues.number(fields, "limit", Presence::Optional, Number::default());
    });
    if let Err(refusal) = read {
        return refusal.respond(message);
    }
    // No R2 SQL credentials: `queryAnalytics` answers an empty series.
    Data(json!([])).into_response()
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

async fn batch_data(body: Bytes) -> Response {
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
    let mut data = Map::new();
    for chart in &charts {
        // `chart.chartId` throws only on null; other values have no such key.
        let chart_id = match chart {
            Value::Null => return ApiError::internal().with_message(message).into_response(),
            Value::Object(chart) => chart.get("chartId"),
            _ => None,
        };
        // No R2 SQL credentials: every series is empty.
        data.insert(js_key(chart_id), json!([]));
    }
    Data(Value::Object(data)).into_response()
}
