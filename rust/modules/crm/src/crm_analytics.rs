//! `/api/crm-analytics` (`routes/crm-analytics/index.ts`): the CRM's
//! analytics reports and their charts (`app = 'crm'`), and the charts' data.
//!
//! Chart data comes from Cloudflare's analytics store (R2 SQL over the
//! Iceberg catalog), which the Kubernetes editions don't have: every series
//! is empty, as TypeScript answers when `R2_SQL_API_TOKEN`, `CF_ACCOUNT_ID`
//! or `R2_ANALYTICS_BUCKET` is unset (`queryAnalytics`). The platform hides
//! analytics there (`UNAVAILABLE_FEATURES`' `analytics`).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    ANALYTICS_REPORT_CREATED, ANALYTICS_REPORT_DELETED, ANALYTICS_REPORT_UPDATED,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_schema::tenant::{analytics_charts as charts, analytics_reports as reports};

use crate::orm_rows::json;
use crate::schema::{self, Kind, OPT, REQ, Spec, number_value, partial, s};
use crate::{Answer, Caller, CrmState, answer, validate};

const LOG: &str = "crm-analytics";
const APP: &str = "crm";

/// `analytics_charts`, written from a body as Drizzle wrote it.
const CHARTS: JsonTable = JsonTable::of::<charts::Entity>();

/// `createReportSchema`.
const REPORT: [Spec; 2] = [
    Spec::new("title", s(Some(1), Some(255)), REQ),
    Spec::new("description", s(None, None), OPT),
];

const NUMBER: Kind = Kind::Num(Number {
    coerce: false,
    int: false,
    min: None,
    max: None,
});

/// `createChartSchema` up to `compareWith` (`layout` is read on its own).
const CHART: [Spec; 16] = [
    Spec::new("title", s(Some(1), Some(255)), REQ),
    Spec::new("description", s(None, None), OPT),
    Spec::new("chartType", s(Some(1), None), REQ),
    Spec::new("entity", s(Some(1), None), REQ),
    Spec::new("metric", s(Some(1), None), REQ),
    Spec::new("color", s(None, None), OPT).with_default("\"#3b82f6\""),
    Spec::new("smoothCurve", Kind::Bool, OPT).with_default("true"),
    Spec::new("fillArea", Kind::Bool, OPT).with_default("true"),
    Spec::new("showDataLabels", Kind::Bool, OPT).with_default("false"),
    Spec::new("showLegend", Kind::Bool, OPT).with_default("true"),
    Spec::new("timeRange", s(None, None), OPT).with_default("\"last_30_days\""),
    Spec::new("groupBy", s(None, None), OPT).with_default("\"day\""),
    Spec::new("aggregation", s(None, None), OPT).with_default("\"sum\""),
    Spec::new("sortOrder", s(None, None), OPT).with_default("\"asc\""),
    Spec::new("limit", NUMBER, OPT),
    Spec::new("compareWith", s(None, None), OPT),
];

/// The chart's columns by Drizzle key.
const CHART_COLUMNS: [(&str, &str); 17] = [
    ("title", "title"),
    ("description", "description"),
    ("chartType", "chart_type"),
    ("entity", "entity"),
    ("metric", "metric"),
    ("color", "color"),
    ("smoothCurve", "smooth_curve"),
    ("fillArea", "fill_area"),
    ("showDataLabels", "show_data_labels"),
    ("showLegend", "show_legend"),
    ("timeRange", "time_range"),
    ("groupBy", "group_by"),
    ("aggregation", "aggregation"),
    ("sortOrder", "sort_order"),
    ("limit", "limit"),
    ("compareWith", "compare_with"),
    ("layout", "layout"),
];

/// The layout object (`{ x, y, w, h, minW?, minH? }`).
fn layout_fields(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let specs = [
        Spec::new("x", NUMBER, REQ),
        Spec::new("y", NUMBER, REQ),
        Spec::new("w", NUMBER, REQ),
        Spec::new("h", NUMBER, REQ),
        Spec::new("minW", NUMBER, OPT),
        Spec::new("minH", NUMBER, OPT),
    ];
    Value::Object(schema::read(issues, fields, &specs))
}

/// `createChartSchema`, or `updateChartSchema` (partial, no defaults).
fn chart_body(issues: &mut Issues, body: &Map<String, Value>, update: bool) -> Map<String, Value> {
    let specs = if update {
        partial(&CHART)
    } else {
        CHART.to_vec()
    };
    let mut out = schema::read(issues, body, &specs);
    if let Field::Set(layout) = issues.nested(body, "layout", Presence::Optional, layout_fields) {
        out.insert("layout".into(), layout);
    }
    out
}

/// `updateChartLayoutsSchema`: `(chartId, layout)` pairs.
fn layouts_body(issues: &mut Issues, body: &Map<String, Value>) -> Vec<(String, Value)> {
    issues
        .list(
            body,
            "layouts",
            Presence::Required,
            None,
            None,
            |issues, item| {
                let fields = issues.object(item)?.clone();
                let chart_id =
                    schema::read(issues, &fields, &[Spec::new("chartId", s(None, None), REQ)]);
                let layout = issues.nested(&fields, "layout", Presence::Required, layout_fields);
                match (chart_id.get("chartId"), layout) {
                    (Some(Value::String(id)), Field::Set(layout)) => Some((id.clone(), layout)),
                    _ => None,
                }
            },
        )
        .into_option()
        .unwrap_or_default()
}

fn id_body(id: &str) -> Value {
    json!({ "id": id })
}

/// The live CRM report.
async fn find_report(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = reports::Entity::find_by_id(id.to_owned())
        .filter(reports::Column::App.eq(APP))
        .filter(reports::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// The report's live charts (`select().from(analyticsCharts)`), unordered.
async fn live_chart_count(caller: &Caller, report_id: &str) -> Result<i64, DbErr> {
    let count = charts::Entity::find()
        .filter(charts::Column::ReportId.eq(report_id))
        .filter(charts::Column::DeletedAt.is_null())
        .count(&orm(&caller.db))
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// `chartCount` and `updatedAt` of a report (any app).
async fn set_chart_count(
    caller: &Caller,
    report_id: &str,
    count: i64,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    reports::Entity::update_many()
        .col_expr(
            reports::Column::ChartCount,
            Expr::value(i32::try_from(count).unwrap_or(i32::MAX)),
        )
        .col_expr(reports::Column::UpdatedAt, Expr::value(now))
        .filter(reports::Column::Id.eq(report_id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// A chart's `sortIndex` (an `integer`): one past the range is the failed
/// cast.
fn sort_index(count: i64) -> Result<i32, DbErr> {
    i32::try_from(count).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

// ── Reports ─────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let rows = reports::Entity::find()
            .filter(reports::Column::App.eq(APP))
            .filter(reports::Column::DeletedAt.is_null())
            .order_by_desc(reports::Column::UpdatedAt)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(|row| json(serde_json::to_value(row)))
            .collect::<Result<Vec<_>, DbErr>>()?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch reports")
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        Ok(match find_report(&caller, &id).await? {
            Some(report) => Data(report).into_response(),
            None => ApiError::not_found("Report", Some(&id)).into_response(),
        })
    }
    .await;
    answer(result, LOG, "Failed to fetch report")
}

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        schema::read(issues, fields, &REPORT)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let id = generate_id("rpt");
        let title = data.get("title").and_then(Value::as_str).unwrap_or_default();
        let now = utc_now();
        reports::Entity::insert(reports::ActiveModel {
            id: Set(id.clone()),
            app: Set(APP.to_owned()),
            title: Set(title.to_owned()),
            description: Set(Some(
                data.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
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
            &json!({ "id": id, "app": APP, "title": title }),
        );
        Ok(Created(id_body(&id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create report")
}

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        schema::read(issues, fields, &partial(&REPORT))
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        if find_report(&caller, &id).await?.is_none() {
            return Ok(ApiError::not_found("Report", Some(&id)).into_response());
        }
        let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
        // Only the fields the body sent change.
        let mut update = reports::Entity::update_many();
        if data.contains_key("title") {
            update = update.col_expr(reports::Column::Title, Expr::value(text("title")));
        }
        if data.contains_key("description") {
            update = update.col_expr(
                reports::Column::Description,
                Expr::value(text("description")),
            );
        }
        update
            .col_expr(reports::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(reports::Column::Id.eq(id.as_str()))
            .filter(reports::Column::App.eq(APP))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, ANALYTICS_REPORT_UPDATED, &id, &id_body(&id));
        Ok(Data(id_body(&id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update report")
}

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if find_report(&caller, &id).await?.is_none() {
            return Ok(ApiError::not_found("Report", Some(&id)).into_response());
        }
        let now = utc_now();
        let db = orm(&caller.db);
        charts::Entity::update_many()
            .col_expr(charts::Column::DeletedAt, Expr::value(now))
            .col_expr(charts::Column::UpdatedAt, Expr::value(now))
            .filter(charts::Column::ReportId.eq(id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .exec(&db)
            .await?;
        reports::Entity::update_many()
            .col_expr(reports::Column::DeletedAt, Expr::value(now))
            .col_expr(reports::Column::UpdatedAt, Expr::value(now))
            .filter(reports::Column::Id.eq(id.as_str()))
            .filter(reports::Column::App.eq(APP))
            .exec(&db)
            .await?;
        caller.publish(&state, ANALYTICS_REPORT_DELETED, &id, &id_body(&id));
        Ok(Data(id_body(&id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete report")
}

pub(crate) async fn duplicate(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(original) = find_report(&caller, &id).await? else {
            return Ok(ApiError::not_found("Report", Some(&id)).into_response());
        };
        let new_id = generate_id("rpt");
        let now = utc_now();
        let db = orm(&caller.db);
        let title = original
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        reports::Entity::insert(reports::ActiveModel {
            id: Set(new_id.clone()),
            app: Set(APP.to_owned()),
            title: Set(format!("{title} (Copy)")),
            description: Set(original
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)),
            created_by_id: Set(Some(caller.user_id.clone())),
            chart_count: Set(original
                .get("chartCount")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
                .unwrap_or(0)),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        // The live charts, copied in the order they are read, each under a
        // new id.
        let originals = charts::Entity::find()
            .filter(charts::Column::ReportId.eq(id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .all(&db)
            .await?;
        if !originals.is_empty() {
            let copies = originals.into_iter().map(|chart| charts::ActiveModel {
                id: Set(generate_id("cht")),
                report_id: Set(new_id.clone()),
                app: Set(APP.to_owned()),
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
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            });
            charts::Entity::insert_many(copies)
                .exec_without_returning(&db)
                .await?;
        }
        Ok(Created(id_body(&new_id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to duplicate report")
}

// ── Charts ──────────────────────────────────────────────────────────────────

pub(crate) async fn charts(caller: Caller, Path(report_id): Path<String>) -> Response {
    let result = async {
        let rows = charts::Entity::find()
            .filter(charts::Column::ReportId.eq(report_id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .order_by_asc(charts::Column::SortIndex)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(|row| json(serde_json::to_value(row)))
            .collect::<Result<Vec<_>, DbErr>>()?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch charts")
}

/// The chart's values by column, for `jsonb_populate_record`
/// ([`JsonTable::insert`]).
fn chart_columns(data: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, column) in CHART_COLUMNS {
        if let Some(value) = data.get(key) {
            out.insert(column.to_owned(), value.clone());
        }
    }
    out
}

pub(crate) async fn create_chart(
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        chart_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let existing = live_chart_count(&caller, &report_id).await?;
        let id = generate_id("cht");
        // One instant: the row's text and the report's `timestamp`.
        let at = time::OffsetDateTime::now_utc();
        let now = weldsuite_events::iso_timestamp(at);
        let mut columns = chart_columns(&data);
        for (column, fallback) in [
            ("description", Value::Null),
            ("limit", Value::Null),
            ("compare_with", Value::Null),
            ("layout", json!({ "x": 0, "y": 0, "w": 6, "h": 4 })),
        ] {
            columns.entry(column).or_insert(fallback);
        }
        columns.insert("id".into(), json!(id));
        columns.insert("report_id".into(), json!(report_id));
        columns.insert("app".into(), json!(APP));
        columns.insert("sort_index".into(), json!(existing));
        columns.insert("created_at".into(), json!(now));
        columns.insert("updated_at".into(), json!(now));
        CHARTS.insert(&orm(&caller.db), columns).await?;
        set_chart_count(&caller, &report_id, existing + 1, utc_timestamp(at)).await?;
        Ok(Created(id_body(&id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create chart")
}

/// `set({ ...data })` of a chart: a value for each field the body sent,
/// as Postgres reads it into the column (a `limit` that isn't a whole
/// `integer` is the failed cast).
fn chart_update(data: &Map<String, Value>) -> Result<sea_orm::UpdateMany<charts::Entity>, DbErr> {
    use charts::Column;
    let mut update = charts::Entity::update_many();
    let text = |value: &Value| value.as_str().map(str::to_owned);
    for (key, value) in data {
        let (column, value) = match key.as_str() {
            "title" => (Column::Title, Expr::value(text(value))),
            "description" => (Column::Description, Expr::value(text(value))),
            "chartType" => (Column::ChartType, Expr::value(text(value))),
            "entity" => (Column::Entity, Expr::value(text(value))),
            "metric" => (Column::Metric, Expr::value(text(value))),
            "color" => (Column::Color, Expr::value(text(value))),
            "smoothCurve" => (Column::SmoothCurve, Expr::value(value.as_bool())),
            "fillArea" => (Column::FillArea, Expr::value(value.as_bool())),
            "showDataLabels" => (Column::ShowDataLabels, Expr::value(value.as_bool())),
            "showLegend" => (Column::ShowLegend, Expr::value(value.as_bool())),
            "timeRange" => (Column::TimeRange, Expr::value(text(value))),
            "groupBy" => (Column::GroupBy, Expr::value(text(value))),
            "aggregation" => (Column::Aggregation, Expr::value(text(value))),
            "sortOrder" => (Column::SortOrder, Expr::value(text(value))),
            "limit" => {
                let limit = value.as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| {
                    DbErr::Type(format!("invalid input syntax for type integer: \"{value}\""))
                })?;
                (Column::Limit, Expr::value(limit))
            }
            "compareWith" => (Column::CompareWith, Expr::value(text(value))),
            "layout" => (Column::Layout, Expr::value(value.clone())),
            _ => continue,
        };
        update = update.col_expr(column, value);
    }
    Ok(update)
}

pub(crate) async fn update_chart(
    caller: Caller,
    Path((report_id, chart_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        chart_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        chart_update(&data)?
            .col_expr(charts::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(charts::Column::Id.eq(chart_id.as_str()))
            .filter(charts::Column::ReportId.eq(report_id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        Ok(Data(id_body(&chart_id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update chart")
}

pub(crate) async fn update_layouts(
    caller: Caller,
    Path(report_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let layouts = match validate(&headers, &body, layouts_body) {
        Ok(layouts) => layouts,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let now = utc_now();
        let db = orm(&caller.db);
        for (chart_id, layout) in &layouts {
            charts::Entity::update_many()
                .col_expr(charts::Column::Layout, Expr::value(layout.clone()))
                .col_expr(charts::Column::UpdatedAt, Expr::value(now))
                .filter(charts::Column::Id.eq(chart_id.as_str()))
                .filter(charts::Column::ReportId.eq(report_id.as_str()))
                .filter(charts::Column::DeletedAt.is_null())
                .exec(&db)
                .await?;
        }
        Ok(Data(json!({ "updated": layouts.len() })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update chart layouts")
}

pub(crate) async fn remove_chart(
    caller: Caller,
    Path((report_id, chart_id)): Path<(String, String)>,
) -> Response {
    let result: Answer = async {
        let now = utc_now();
        charts::Entity::update_many()
            .col_expr(charts::Column::DeletedAt, Expr::value(now))
            .col_expr(charts::Column::UpdatedAt, Expr::value(now))
            .filter(charts::Column::Id.eq(chart_id.as_str()))
            .filter(charts::Column::ReportId.eq(report_id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        let remaining = live_chart_count(&caller, &report_id).await?;
        set_chart_count(&caller, &report_id, remaining, now).await?;
        Ok(Data(id_body(&chart_id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete chart")
}

/// `a + b` of two layout values as JavaScript adds them.
fn js_add(a: &Value, b: &Value) -> Value {
    if let (Value::Number(a), Value::Number(b)) = (a, b) {
        return number_value(a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0));
    }
    let text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    Value::String(format!("{}{}", text(a), text(b)))
}

pub(crate) async fn duplicate_chart(
    caller: Caller,
    Path((report_id, chart_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let original = charts::Entity::find_by_id(chart_id.clone())
            .filter(charts::Column::ReportId.eq(report_id.as_str()))
            .filter(charts::Column::DeletedAt.is_null())
            .one(&orm(&caller.db))
            .await?;
        let Some(original) = original else {
            return Ok(ApiError::not_found("Chart", Some(&chart_id)).into_response());
        };
        let existing = live_chart_count(&caller, &report_id).await?;
        let new_id = generate_id("cht");
        let now = utc_now();
        let mut layout = match &original.layout {
            Value::Object(layout) => layout.clone(),
            _ => json!({ "x": 0, "y": 0, "w": 6, "h": 4 })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        };
        // `{ ...layout, y: (layout.y ?? 0) + (layout.h ?? 4) }`
        let pick = |key: &str, fallback: i64| {
            layout
                .get(key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!(fallback))
        };
        let y = js_add(&pick("y", 0), &pick("h", 4));
        layout.insert("y".into(), y);
        charts::Entity::insert(charts::ActiveModel {
            id: Set(new_id.clone()),
            report_id: Set(original.report_id),
            app: Set(APP.to_owned()),
            title: Set(format!("{} (Copy)", original.title)),
            description: Set(original.description),
            chart_type: Set(original.chart_type),
            entity_: Set(original.entity_),
            metric: Set(original.metric),
            color: Set(original.color),
            smooth_curve: Set(original.smooth_curve),
            fill_area: Set(original.fill_area),
            show_data_labels: Set(original.show_data_labels),
            show_legend: Set(original.show_legend),
            time_range: Set(original.time_range),
            group_by: Set(original.group_by),
            aggregation: Set(original.aggregation),
            sort_order: Set(original.sort_order),
            limit: Set(original.limit),
            compare_with: Set(original.compare_with),
            layout: Set(Value::Object(layout)),
            sort_index: Set(sort_index(existing)?),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        set_chart_count(&caller, &report_id, existing + 1, now).await?;
        Ok(Created(id_body(&new_id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to duplicate chart")
}

// ── POST /chart-data ────────────────────────────────────────────────────────

/// `String(value)` for a chart id.
fn js_key(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => {
            weldsuite_crm_domain::js::number_text(number.as_f64().unwrap_or(0.0))
        }
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_key(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

pub(crate) async fn chart_data(body: Bytes) -> Response {
    // `await c.req.json().catch(() => ({}))`, then `body?.charts ?? []`.
    let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let charts = match parsed.get("charts") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(charts)) => charts.clone(),
        // `.map` of a non-array throws inside the route's try.
        Some(_) => return failed(),
    };
    let mut data = Map::new();
    for config in &charts {
        // `config.chartId` of null or undefined throws.
        if config.is_null() {
            return failed();
        }
        data.insert(js_key(config.get("chartId")), json!([]));
    }
    Data(Value::Object(data)).into_response()
}

fn failed() -> Response {
    answer(
        Err(crate::Refusal::Failed(
            "chart-data: not an array of charts".to_owned(),
        )),
        LOG,
        "Failed to get charts data",
    )
}
