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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ANALYTICS_REPORT_CREATED, ANALYTICS_REPORT_DELETED, ANALYTICS_REPORT_UPDATED,
};
use weldsuite_crm_domain::drizzle_row;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};

use crate::schema::{self, Kind, OPT, REQ, Spec, number_value, partial, s};
use crate::{Answer, Caller, CrmState, answer, now, validate};

const LOG: &str = "crm-analytics";
const APP: &str = "crm";

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
async fn find_report(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from analytics_reports t
         where id = $1 and app = $2 and deleted_at is null limit 1",
    )
    .bind(id)
    .bind(APP)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
}

/// The report's live charts (`select().from(analyticsCharts)`), unordered.
async fn live_chart_count(caller: &Caller, report_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from analytics_charts where report_id = $1 and deleted_at is null",
    )
    .bind(report_id)
    .fetch_one(&caller.db)
    .await
}

/// `chartCount` and `updatedAt` of a report (any app).
async fn set_chart_count(
    caller: &Caller,
    report_id: &str,
    count: i64,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update analytics_reports set chart_count = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(report_id)
    .bind(i32::try_from(count).unwrap_or(i32::MAX))
    .bind(now)
    .execute(&caller.db)
    .await?;
    Ok(())
}

// ── Reports ─────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from analytics_reports t where app = $1 and deleted_at is null
             order by updated_at desc",
        )
        .bind(APP)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(rows.into_iter().map(drizzle_row).collect::<Vec<_>>()).into_response())
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
        sqlx::query(
            "insert into analytics_reports (id, app, title, description, created_by_id, chart_count, created_at, updated_at)
             values ($1, $2, $3, $4, $5, 0, $6::timestamp, $6::timestamp)",
        )
        .bind(&id)
        .bind(APP)
        .bind(title)
        .bind(data.get("description").and_then(Value::as_str).unwrap_or_default())
        .bind(&caller.user_id)
        .bind(now())
        .execute(&caller.db)
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
        let text = |key: &str| data.get(key).and_then(Value::as_str);
        sqlx::query(
            "update analytics_reports
             set title = case when $3 then $4 else title end,
                 description = case when $5 then $6 else description end,
                 updated_at = $7::timestamp
             where id = $1 and app = $2",
        )
        .bind(&id)
        .bind(APP)
        .bind(data.contains_key("title"))
        .bind(text("title"))
        .bind(data.contains_key("description"))
        .bind(text("description"))
        .bind(now())
        .execute(&caller.db)
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
        let now = now();
        sqlx::query(
            "update analytics_charts set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where report_id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "update analytics_reports set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = $1 and app = $2",
        )
        .bind(&id)
        .bind(APP)
        .bind(&now)
        .execute(&caller.db)
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
        let now = now();
        let title = original
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        sqlx::query(
            "insert into analytics_reports (id, app, title, description, created_by_id, chart_count, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)",
        )
        .bind(&new_id)
        .bind(APP)
        .bind(format!("{title} (Copy)"))
        .bind(original.get("description").and_then(Value::as_str))
        .bind(&caller.user_id)
        .bind(
            original
                .get("chartCount")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
                .unwrap_or(0),
        )
        .bind(&now)
        .execute(&caller.db)
        .await?;
        let originals: Vec<String> = sqlx::query_scalar(
            "select id from analytics_charts where report_id = $1 and deleted_at is null",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        if !originals.is_empty() {
            let new_ids: Vec<String> = originals.iter().map(|_| generate_id("cht")).collect();
            sqlx::query(
                "insert into analytics_charts (id, report_id, app, title, description, chart_type, entity, metric,
                     color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                     aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at)
                 select n.new_id, $3, $4, c.title, c.description, c.chart_type, c.entity, c.metric,
                     c.color, c.smooth_curve, c.fill_area, c.show_data_labels, c.show_legend, c.time_range, c.group_by,
                     c.aggregation, c.sort_order, c.\"limit\", c.compare_with, c.layout, c.sort_index,
                     $5::timestamp, $5::timestamp
                 from unnest($1::text[], $2::text[]) with ordinality as n(new_id, old_id, ord)
                 join analytics_charts c on c.id = n.old_id
                 order by n.ord",
            )
            .bind(&new_ids)
            .bind(&originals)
            .bind(&new_id)
            .bind(APP)
            .bind(&now)
            .execute(&caller.db)
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from analytics_charts t where report_id = $1 and deleted_at is null
             order by sort_index asc",
        )
        .bind(&report_id)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(rows.into_iter().map(drizzle_row).collect::<Vec<_>>()).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch charts")
}

/// The chart's values by column, for `jsonb_populate_record`.
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
        let now = now();
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
        sqlx::query(
            "insert into analytics_charts (id, report_id, app, title, description, chart_type, entity, metric,
                 color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                 aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at)
             select id, report_id, app, title, description, chart_type, entity, metric,
                 color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                 aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at
             from jsonb_populate_record(null::analytics_charts, $1::jsonb)",
        )
        .bind(Value::Object(columns))
        .execute(&caller.db)
        .await?;
        set_chart_count(&caller, &report_id, existing + 1, &now).await?;
        Ok(Created(id_body(&id)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create chart")
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
        let mut columns = chart_columns(&data);
        columns.insert("updated_at".into(), json!(now()));
        sqlx::query(
            "update analytics_charts t set (title, description, chart_type, entity, metric, color, smooth_curve,
                 fill_area, show_data_labels, show_legend, time_range, group_by, aggregation, sort_order,
                 \"limit\", compare_with, layout, updated_at)
               = (select r.title, r.description, r.chart_type, r.entity, r.metric, r.color, r.smooth_curve,
                 r.fill_area, r.show_data_labels, r.show_legend, r.time_range, r.group_by, r.aggregation,
                 r.sort_order, r.\"limit\", r.compare_with, r.layout, r.updated_at
                 from jsonb_populate_record(t, $3::jsonb) r)
             where t.id = $1 and t.report_id = $2 and t.deleted_at is null",
        )
        .bind(&chart_id)
        .bind(&report_id)
        .bind(Value::Object(columns))
        .execute(&caller.db)
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
        let now = now();
        for (chart_id, layout) in &layouts {
            sqlx::query(
                "update analytics_charts set layout = $3::jsonb, updated_at = $4::timestamp
                 where id = $1 and report_id = $2 and deleted_at is null",
            )
            .bind(chart_id)
            .bind(&report_id)
            .bind(layout)
            .bind(&now)
            .execute(&caller.db)
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
        let now = now();
        sqlx::query(
            "update analytics_charts set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = $1 and report_id = $2 and deleted_at is null",
        )
        .bind(&chart_id)
        .bind(&report_id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        let remaining = live_chart_count(&caller, &report_id).await?;
        set_chart_count(&caller, &report_id, remaining, &now).await?;
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
        let original: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from analytics_charts t
             where id = $1 and report_id = $2 and deleted_at is null limit 1",
        )
        .bind(&chart_id)
        .bind(&report_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(original) = original else {
            return Ok(ApiError::not_found("Chart", Some(&chart_id)).into_response());
        };
        let existing = live_chart_count(&caller, &report_id).await?;
        let new_id = generate_id("cht");
        let now = now();
        let mut layout = match original.get("layout") {
            Some(Value::Object(layout)) => layout.clone(),
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
        let mut columns = original.as_object().cloned().unwrap_or_default();
        columns.insert("id".into(), json!(new_id));
        columns.insert("app".into(), json!(APP));
        columns.insert(
            "title".into(),
            json!(format!(
                "{} (Copy)",
                original
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )),
        );
        columns.insert("layout".into(), Value::Object(layout));
        columns.insert("sort_index".into(), json!(existing));
        columns.insert("created_at".into(), json!(now));
        columns.insert("updated_at".into(), json!(now));
        columns.insert("deleted_at".into(), Value::Null);
        sqlx::query(
            "insert into analytics_charts (id, report_id, app, title, description, chart_type, entity, metric,
                 color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                 aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at)
             select id, report_id, app, title, description, chart_type, entity, metric,
                 color, smooth_curve, fill_area, show_data_labels, show_legend, time_range, group_by,
                 aggregation, sort_order, \"limit\", compare_with, layout, sort_index, created_at, updated_at
             from jsonb_populate_record(null::analytics_charts, $1::jsonb)",
        )
        .bind(Value::Object(columns))
        .execute(&caller.db)
        .await?;
        set_chart_count(&caller, &report_id, existing + 1, &now).await?;
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
