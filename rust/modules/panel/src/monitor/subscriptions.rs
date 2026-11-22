//! Scheduled reports: `/api/panel/subscriptions`
//! (`routes/subscriptions/index.ts`, `services/subscriptions.ts`). A saved
//! report or dashboard sent daily, weekly or monthly at an hour in a time
//! zone, by email, in-app, Slack or WeldChat; `weldsuite cron
//! panel-schedule` sends it.
//!
//!   GET    /                → subscriptions (?projectId, ?targetType, ?targetId, ?scope)
//!   POST   /                → new subscription
//!   GET    /:id             → one subscription
//!   PATCH  /:id             → name, schedule, channels, enabled
//!   DELETE /:id             → soft delete
//!   POST   /:id/send-now    → deliver now, outside the schedule
//!
//! What goes out: a report's headline numbers (with the change against the
//! period before for web and trends, run with `compare`) and top rows; a
//! dashboard's report tiles, at most 12, in grid order, with the dashboard's
//! date range and filters. A report that fails is a "could not be run"
//! block, never a failed send.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_SUBSCRIPTION_CREATED, PANEL_SUBSCRIPTION_DELETED, PANEL_SUBSCRIPTION_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_emails::EmailLocale;
use weldsuite_emails::panel_monitor::{
    DigestBlock, DigestFigure, DigestProps, DigestRow, NumberFormat,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::panel_subscriptions::{self as subscriptions, Column};
use weldsuite_schema::tenant::{panel_dashboard_tiles, panel_projects, panel_reports};

use super::alerts::CheckPorts;
use super::delivery::{self, Delivered, Message, Stored, Target, channels_dto, delivery_error};
use super::schedule::{
    SubscriptionSchedule, delete_schedule, next_subscription_run, upsert_schedule,
};
use super::schemas::{CREATE_SUBSCRIPTION, SCHEDULE, SUBSCRIPTION_LIST_QUERY, UPDATE_SUBSCRIPTION};
use super::{MonitorState, channels_for, master_of, now_of};
use crate::saved::{
    Actor, can_change, can_see, field, get_dashboard, get_report, instant, js_row, js_rows,
    project_exists, text,
};
use crate::schemas_gen::{PANEL_DATE_RANGE, PANEL_FILTER, PANEL_QUERY_SPEC};
use crate::{Caller, unexpected};

/// Most report tiles of a dashboard one message carries.
pub(crate) const MAX_DIGEST_TILES: usize = 12;
const MAX_ROWS: usize = 10;
/// Subscriptions listed at most.
const MAX_LISTED: u64 = 500;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

/// `scheduleOf(s)`: the parsed schedule, `None` when it does not parse.
fn schedule_value(row: &Value) -> Option<Value> {
    weldsuite_zod::parse_issues(&SCHEDULE, &field(row, "schedule"))
        .ok()
        .map(|parsed| Value::Object(parsed.body))
}

/// `toSubscriptionDto(s)`.
pub(crate) fn dto(row: &Value) -> Value {
    let enabled = row.get("enabled").and_then(Value::as_bool) == Some(true);
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "schedule": schedule_value(row).unwrap_or_else(|| json!({ "frequency": "daily", "hour": 9, "timezone": "UTC" })),
        "channels": channels_dto(&field(row, "channels"), row.get("slackWebhookCiphertext").and_then(Value::as_str)),
        "enabled": enabled,
        "nextRunAt": if enabled { field(row, "nextRunAt") } else { Value::Null },
        "lastRunAt": field(row, "lastRunAt"),
        "lastError": field(row, "lastError"),
        "ownerUserId": field(row, "ownerUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `subscriptionEventData(s)`: never the channels.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "schedule": field(row, "schedule"),
        "enabled": field(row, "enabled"),
    })
}

/// `nextRunOf(s, now)`: `None` when it is off.
pub(crate) fn next_run_of(row: &Value, now: i64) -> Option<i64> {
    let enabled = row.get("enabled").and_then(Value::as_bool) == Some(true);
    if !enabled || row.get("deletedAt").is_some_and(|d| !d.is_null()) {
        return None;
    }
    let schedule = SubscriptionSchedule::parse(&field(row, "schedule"))?;
    Some(next_subscription_run(&schedule, now))
}

/// `getSubscription(db, id)`.
pub(crate) async fn get_subscription(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    subscriptions::Entity::find_by_id(id)
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

// ---------------------------------------------------------------------------
// Targets and blocks
// ---------------------------------------------------------------------------

/// `reportPath(report)`: its builder, `?report=`.
pub(crate) fn report_path(report: &Value) -> String {
    let base = match text(report, "kind") {
        "web" => "/weldpanel",
        "funnel" => "/weldpanel/funnels",
        "retention" => "/weldpanel/retention",
        "flows" => "/weldpanel/flows",
        _ => "/weldpanel/insights",
    };
    format!(
        "{base}?report={}",
        weldsuite_kit::cursor::encode_uri_component(text(report, "id"))
    )
}

fn dashboard_path(id: &str) -> String {
    format!(
        "/weldpanel/dashboards/{}",
        weldsuite_kit::cursor::encode_uri_component(id)
    )
}

/// `z.array(panelFilterSchema).max(20)`, under `f` (a parse answers an object).
const FILTER_LIST: weldsuite_zod::Z = weldsuite_zod::Z::Obj(
    &[(
        "f",
        weldsuite_zod::Z::Arr(&PANEL_FILTER, None, Some((20, None))),
    )],
    weldsuite_zod::Keys::Strip,
);

/// `digestSpec(rawSpec, dashboardFilters)`: `compare` on for web and trends,
/// the dashboard's date range and filters on top; `None` when the spec no
/// longer parses.
pub(crate) fn digest_spec(raw: &Value, filters: Option<&Value>) -> Option<Value> {
    let parsed = weldsuite_zod::parse_issues(&PANEL_QUERY_SPEC, raw).ok()?;
    let mut spec: Map<String, Value> = parsed.body;
    let kind = spec
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if kind == "web" || kind == "trends" {
        spec.insert("compare".to_owned(), Value::Bool(true));
    }
    if let Some(filters) = filters.filter(|f| !f.is_null()) {
        if let Ok(range) =
            weldsuite_zod::parse_issues(&PANEL_DATE_RANGE, &field(filters, "dateRange"))
        {
            spec.insert("dateRange".to_owned(), Value::Object(range.body));
        }
        let extra = filters.get("filters").cloned().unwrap_or_else(|| json!([]));
        let extra = weldsuite_zod::parse_issues(&FILTER_LIST, &json!({ "f": extra }))
            .ok()
            .and_then(|parsed| parsed.body.get("f").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        if !extra.is_empty()
            && let Some(Value::Array(current)) = spec.get("filters")
        {
            let mut all = current.clone();
            all.extend(extra);
            all.truncate(20);
            spec.insert("filters".to_owned(), Value::Array(all));
        }
    }
    weldsuite_zod::parse_issues(&PANEL_QUERY_SPEC, &Value::Object(spec))
        .ok()
        .map(|parsed| Value::Object(parsed.body))
}

/// The labels of the digest in a locale (`reportDigest.labels`).
fn label(locale: EmailLocale, key: &str) -> String {
    delivery::email_strings(locale)["reportDigest"]["labels"][key]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// `BlockShape`: the headline figures and top rows of one result.
struct Shape {
    headline: Vec<DigestFigure>,
    rows: Vec<DigestRow>,
    rows_title: String,
    open_only: bool,
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn figure(
    label: String,
    value: &Value,
    previous: Option<&Value>,
    format: NumberFormat,
) -> DigestFigure {
    DigestFigure {
        label,
        value: number(value),
        previous: previous.and_then(number),
        format,
    }
}

fn digest_row(label: String, value: &Value, format: NumberFormat) -> DigestRow {
    DigestRow {
        label,
        value: number(value).unwrap_or(f64::NAN),
        format,
    }
}

/// `resultShape(result, labels)`. Pure.
#[allow(clippy::too_many_lines)] // one arm per report kind, as the worker's switch
fn result_shape(result: &Value, locale: EmailLocale) -> Shape {
    let r = &result["result"];
    let items = |value: &Value| value.as_array().cloned().unwrap_or_default();
    match result["kind"].as_str().unwrap_or_default() {
        "web" => {
            let totals = &r["totals"];
            let prev = r.get("previousTotals").filter(|p| !p.is_null());
            let previous = |key: &str| prev.map(|p| &p[key]);
            Shape {
                rows_title: label(locale, "topPages"),
                headline: vec![
                    figure(
                        label(locale, "visitors"),
                        &totals["visitors"],
                        previous("visitors"),
                        NumberFormat::Number,
                    ),
                    figure(
                        label(locale, "visits"),
                        &totals["visits"],
                        previous("visits"),
                        NumberFormat::Number,
                    ),
                    figure(
                        label(locale, "pageviews"),
                        &totals["pageviews"],
                        previous("pageviews"),
                        NumberFormat::Number,
                    ),
                    figure(
                        label(locale, "bounceRate"),
                        &totals["bounceRate"],
                        previous("bounceRate"),
                        NumberFormat::Percent,
                    ),
                ],
                rows: items(&r["topPages"])
                    .iter()
                    .take(MAX_ROWS)
                    .map(|row| {
                        digest_row(
                            js::value_text(&row["value"]),
                            &row["visitors"],
                            NumberFormat::Number,
                        )
                    })
                    .collect(),
                open_only: false,
            }
        }
        "trends" => {
            let lines = items(&r["series"]);
            let mut broken: Vec<&Value> = lines
                .iter()
                .filter(|l| !l["breakdownValue"].is_null() && l["seriesIndex"].as_i64() == Some(0))
                .collect();
            // Stable, by total, highest first.
            broken.sort_by(|a, b| {
                let (a, b) = (
                    a["total"].as_f64().unwrap_or(0.0),
                    b["total"].as_f64().unwrap_or(0.0),
                );
                b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
            });
            Shape {
                rows_title: label(locale, "breakdown"),
                headline: lines
                    .iter()
                    .filter(|l| l["breakdownValue"].is_null())
                    .map(|l| {
                        figure(
                            js::value_text(&l["label"]),
                            &l["total"],
                            l.get("previous")
                                .filter(|p| !p.is_null())
                                .map(|p| &p["total"]),
                            NumberFormat::Number,
                        )
                    })
                    .collect(),
                rows: broken
                    .iter()
                    .take(MAX_ROWS)
                    .map(|l| {
                        digest_row(
                            l["breakdownValue"].as_str().map_or_else(
                                || js::value_text(&l["breakdownValue"]),
                                str::to_owned,
                            ),
                            &l["total"],
                            NumberFormat::Number,
                        )
                    })
                    .collect(),
                open_only: false,
            }
        }
        "funnel" => Shape {
            rows_title: label(locale, "steps"),
            headline: vec![figure(
                label(locale, "conversion"),
                &r["overallConversion"],
                None,
                NumberFormat::Percent,
            )],
            rows: items(&r["steps"])
                .iter()
                .take(MAX_ROWS)
                .map(|step| {
                    let name = step["label"]
                        .as_str()
                        .filter(|l| !l.is_empty())
                        .map_or_else(|| js::value_text(&step["event"]), str::to_owned);
                    digest_row(name, &step["count"], NumberFormat::Number)
                })
                .collect(),
            open_only: false,
        },
        "retention" => {
            let average = items(&r["averageRetention"]);
            let size: f64 = items(&r["cohorts"])
                .iter()
                .map(|c| c["size"].as_f64().unwrap_or(0.0))
                .sum();
            let mut headline = vec![figure(
                label(locale, "cohortSize"),
                &json!(size),
                None,
                NumberFormat::Number,
            )];
            if average.len() > 1 {
                let retained = average.get(1).cloned().unwrap_or(json!(0));
                let retained = if retained.is_null() {
                    json!(0)
                } else {
                    retained
                };
                headline.push(figure(
                    label(locale, "retained"),
                    &retained,
                    None,
                    NumberFormat::Percent,
                ));
            }
            Shape {
                rows_title: label(locale, "periods"),
                headline,
                rows: average
                    .iter()
                    .skip(1)
                    .take(MAX_ROWS.min(6))
                    .enumerate()
                    .map(|(i, share)| {
                        let n = (i + 1).to_string();
                        let name = label(locale, "period").replace("{n}", &n);
                        digest_row(name, share, NumberFormat::Percent)
                    })
                    .collect(),
                open_only: false,
            }
        }
        "flows" => {
            let anchor = js::value_text(&r["anchor"]);
            Shape {
                rows_title: anchor.clone(),
                headline: vec![figure(
                    anchor,
                    &r["anchorCount"],
                    None,
                    NumberFormat::Number,
                )],
                rows: items(&r["paths"])
                    .iter()
                    .take(MAX_ROWS)
                    .map(|path| {
                        let steps: Vec<String> = items(&path["steps"])
                            .iter()
                            .map(|s| {
                                if s.is_null() {
                                    "–".to_owned()
                                } else {
                                    js::value_text(s)
                                }
                            })
                            .collect();
                        digest_row(steps.join(" → "), &path["count"], NumberFormat::Number)
                    })
                    .collect(),
                open_only: false,
            }
        }
        _ => Shape {
            rows_title: String::new(),
            headline: Vec::new(),
            rows: Vec::new(),
            open_only: true,
        },
    }
}

/// One report's part of a digest before it is written in a locale (`ComputedBlock`).
#[derive(Debug, Clone)]
pub(crate) struct ComputedBlock {
    title: String,
    path: String,
    result: Option<Value>,
}

/// `blockDraft(block, locale, standalone)`: the block, its link still a path.
fn block_draft(block: &ComputedBlock, locale: EmailLocale, standalone: bool) -> DigestBlock {
    let Some(result) = &block.result else {
        return DigestBlock {
            title: block.title.clone(),
            failed: true,
            url: Some(block.path.clone()),
            ..DigestBlock::default()
        };
    };
    let shape = result_shape(result, locale);
    let title = if standalone && !shape.rows_title.is_empty() {
        shape.rows_title.clone()
    } else {
        block.title.clone()
    };
    DigestBlock {
        title,
        headline: shape.headline,
        rows: shape.rows,
        failed: false,
        open_only: shape.open_only,
        url: Some(block.path.clone()),
    }
}

/// `computeBlock(deps, report, filters)`.
async fn compute_block(
    ports: &dyn CheckPorts,
    report: &Value,
    filters: Option<&Value>,
) -> ComputedBlock {
    let title = text(report, "name").to_owned();
    let path = report_path(report);
    let spec = digest_spec(&field(report, "spec"), filters)
        .filter(|spec| text(spec, "projectId") == text(report, "projectId"));
    let Some(spec) = spec else {
        return ComputedBlock {
            title,
            path,
            result: None,
        };
    };
    match ports.run(spec).await {
        Ok(result) => ComputedBlock {
            title,
            path,
            result: Some(result),
        },
        Err(error) => {
            tracing::warn!(report = text(report, "id"), %error, "[panel-api] scheduled report failed");
            ComputedBlock {
                title,
                path,
                result: None,
            }
        }
    }
}

/// `buildDigest(deps, sub)`: the message, or why there is none.
#[allow(clippy::too_many_lines)] // a report or a dashboard's tiles, as the worker's
pub(crate) async fn build_digest(
    db: &PgPool,
    ports: &dyn CheckPorts,
    sub: &Value,
) -> Result<Result<Message, String>, DbErr> {
    let project_id = text(sub, "projectId").to_owned();
    let project: Option<String> = panel_projects::Entity::find_by_id(&project_id)
        .select_only()
        .column(panel_projects::Column::Name)
        .filter(panel_projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some(project_name) = project else {
        return Ok(Err("The project was deleted".to_owned()));
    };
    let target_id = text(sub, "targetId");
    let report_target = text(sub, "targetType") == "report";
    let (target_name, path, blocks, more_count) = if report_target {
        let report = get_report(db, target_id).await?;
        let Some(report) = report.filter(|r| text(r, "projectId") == project_id) else {
            return Ok(Err("The report was deleted".to_owned()));
        };
        let block = compute_block(ports, &report, None).await;
        (
            text(&report, "name").to_owned(),
            report_path(&report),
            vec![block],
            0,
        )
    } else {
        let dashboard = get_dashboard(db, target_id).await?;
        let Some(dashboard) = dashboard.filter(|d| text(d, "projectId") == project_id) else {
            return Ok(Err("The dashboard was deleted".to_owned()));
        };
        let tiles = panel_dashboard_tiles::Entity::find()
            .filter(panel_dashboard_tiles::Column::DashboardId.eq(text(&dashboard, "id")))
            .all(&orm(db))
            .await?;
        let mut tiles: Vec<Value> = js_rows(tiles)?
            .into_iter()
            .filter(|t| text(t, "kind") != "text" && !text(t, "reportId").is_empty())
            .collect();
        let at = |t: &Value, key: &str| t["layout"][key].as_f64().unwrap_or(0.0);
        tiles.sort_by(|a, b| {
            (at(a, "y") - at(b, "y"))
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    (at(a, "x") - at(b, "x"))
                        .partial_cmp(&0.0)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        let ids: Vec<String> = tiles
            .iter()
            .map(|t| text(t, "reportId").to_owned())
            .collect();
        let reports: Vec<Value> = if ids.is_empty() {
            Vec::new()
        } else {
            let found = panel_reports::Entity::find()
                .filter(panel_reports::Column::Id.is_in(ids.iter().map(String::as_str)))
                .filter(panel_reports::Column::ProjectId.eq(&project_id))
                .filter(panel_reports::Column::DeletedAt.is_null())
                .all(&orm(db))
                .await?;
            js_rows(found)?
        };
        let ordered: Vec<&Value> = ids
            .iter()
            .filter_map(|id| reports.iter().find(|r| text(r, "id") == id))
            .collect();
        let more = ordered.len().saturating_sub(MAX_DIGEST_TILES);
        let filters = dashboard.get("filters").cloned();
        let mut blocks = Vec::new();
        for report in ordered.iter().take(MAX_DIGEST_TILES) {
            blocks.push(compute_block(ports, report, filters.as_ref()).await);
        }
        (
            text(&dashboard, "name").to_owned(),
            dashboard_path(text(&dashboard, "id")),
            blocks,
            more,
        )
    };
    let subscription_name = text(sub, "name").to_owned();
    let target_type = text(sub, "targetType").to_owned();
    Ok(Ok(Message::Report {
        entity_id: text(sub, "id").to_owned(),
        path,
        digest: Box::new(move |locale| DigestProps {
            subscription_name: subscription_name.clone(),
            project_name: project_name.clone(),
            target_type: target_type.clone(),
            target_name: target_name.clone(),
            blocks: blocks
                .iter()
                .map(|b| block_draft(b, locale, report_target))
                .collect(),
            more_count: (more_count > 0).then_some(more_count as u64),
            url: String::new(),
        }),
    }))
}

/// `sendSubscription(deps, sub, { schedule })`: builds and sends it now and
/// records the run; with `schedule` (the cron) also moves `nextRunAt` on.
pub(crate) async fn send_subscription(
    db: &PgPool,
    now: i64,
    ports: &dyn CheckPorts,
    sub: &Value,
    schedule: bool,
) -> Result<(Vec<Delivered>, Option<String>, Value), DbErr> {
    let digest = build_digest(db, ports, sub).await?;
    let (delivered, error) = match &digest {
        Ok(message) => {
            let delivered = ports.deliver(&Target::of(sub), message).await;
            let error = delivery_error(&delivered);
            (delivered, error)
        }
        Err(reason) => (Vec::new(), Some(reason.clone())),
    };
    let next = if schedule {
        next_run_of(sub, now)
    } else {
        None
    };
    let mut run = subscriptions::Entity::update_many()
        .col_expr(Column::LastRunAt, Expr::value(instant(now)))
        .col_expr(Column::LastError, Expr::value(error.clone()));
    if schedule {
        run = run.col_expr(Column::NextRunAt, Expr::value(next.map(instant)));
    }
    let row = run
        .col_expr(Column::UpdatedAt, Expr::value(instant(now)))
        .filter(Column::Id.eq(text(sub, "id")))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    let row = match row {
        Some(row) => js_row(row)?,
        None => sub.clone(),
    };
    Ok((delivered, error, row))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fn may_change(sub: &Value, actor: &Actor) -> bool {
    can_change(
        &json!({ "ownerUserId": field(sub, "ownerUserId"), "visibility": "workspace" }),
        actor,
    )
}

fn publish(caller: &Caller, state: &MonitorState, sub: &Value, event: EventName) {
    caller.publish(&state.panel, event, text(sub, "id"), &event_data(sub));
}

/// `reschedule(c, sub)`: the registry row follows `nextRunAt`.
async fn reschedule(caller: &Caller, state: &MonitorState, sub: &Value) -> Result<(), DbErr> {
    let Some(master) = master_of(caller, state) else {
        return Ok(());
    };
    let next = sub
        .get("nextRunAt")
        .and_then(Value::as_str)
        .and_then(js::parse_iso);
    upsert_schedule(
        &master,
        &caller.workspace_id,
        "subscription",
        text(sub, "id"),
        next,
    )
    .await
}

async fn found(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_subscription(&caller.db, id).await {
        Ok(Some(sub)) => Ok(sub),
        Ok(None) => Err(ApiError::not_found("Subscription", Some(id)).into_response()),
        Err(error) => Err(unexpected(&error, "get subscription")),
    }
}

/// `GET /`.
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match weldsuite_zod::query(&SUBSCRIPTION_LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let owner = (query.text("scope") == Some("mine")).then(|| caller.user_id.clone());
    let mut select = subscriptions::Entity::find().filter(Column::DeletedAt.is_null());
    for (column, value) in [
        (Column::ProjectId, query.text("projectId")),
        (Column::TargetType, query.text("targetType")),
        (Column::TargetId, query.text("targetId")),
        (Column::OwnerUserId, owner.as_deref()),
    ] {
        if let Some(value) = value {
            select = select.filter(column.eq(value));
        }
    }
    let found = select
        .order_by_desc(Column::UpdatedAt)
        .limit(MAX_LISTED)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match found {
        Ok(found) => {
            let data: Vec<Value> = found.iter().map(dto).collect();
            let count = data.len() as u64;
            List::new(data, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list subscriptions"),
    }
}

/// `visibleTarget(c, actor, projectId, targetType, targetId)`.
async fn visible_target(
    caller: &Caller,
    actor: &Actor,
    project_id: &str,
    target_type: &str,
    target_id: &str,
) -> Result<bool, DbErr> {
    let target = if target_type == "report" {
        get_report(&caller.db, target_id).await?
    } else {
        get_dashboard(&caller.db, target_id).await?
    };
    Ok(target.is_some_and(|t| text(&t, "projectId") == project_id && can_see(&t, actor)))
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let input = match weldsuite_zod::json(&CREATE_SUBSCRIPTION, &headers, &body) {
        Ok(parsed) => Value::Object(parsed.body),
        Err(response) => return response,
    };
    let project_id = text(&input, "projectId").to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create subscription"),
    }
    let target_type = text(&input, "targetType");
    let target_id = text(&input, "targetId");
    match visible_target(
        &caller,
        &Actor::of(&caller, &permissions),
        &project_id,
        target_type,
        target_id,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => {
            let what = if target_type == "report" {
                "Report"
            } else {
                "Dashboard"
            };
            return ApiError::not_found(what, Some(target_id)).into_response();
        }
        Err(error) => return unexpected(&error, "create subscription"),
    }
    let stored = match channels_for(&caller, &field(&input, "channels"), None).await {
        Ok(stored) => stored,
        Err(response) => return *response,
    };
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let schedule = field(&input, "schedule");
    let next = enabled
        .then(|| SubscriptionSchedule::parse(&schedule))
        .flatten()
        .map(|s| next_subscription_run(&s, js::now_millis()));
    let row = subscriptions::Entity::insert(subscriptions::ActiveModel {
        id: Set(weldsuite_kit::generate_id("pnsb")),
        project_id: Set(project_id.clone()),
        name: Set(text(&input, "name").to_owned()),
        target_type: Set(target_type.to_owned()),
        target_id: Set(target_id.to_owned()),
        schedule: Set(schedule),
        channels: Set(stored.channels),
        slack_webhook_ciphertext: Set(stored.slack_ciphertext),
        enabled: Set(enabled),
        next_run_at: Set(next.map(instant)),
        owner_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    let sub = match row {
        Ok(row) => row,
        Err(error) => return unexpected(&error, "create subscription"),
    };
    if let Err(error) = reschedule(&caller, &state, &sub).await {
        return unexpected(&error, "create subscription");
    }
    publish(&caller, &state, &sub, PANEL_SUBSCRIPTION_CREATED);
    Created(dto(&sub)).into_response()
}

/// `GET /:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match found(&caller, &id).await {
        Ok(sub) => Data(dto(&sub)).into_response(),
        Err(response) => response,
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_SUBSCRIPTION, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    let existing = match found(&caller, &id).await {
        Ok(sub) => sub,
        Err(response) => return response,
    };
    if !may_change(&existing, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can change this scheduled report")
            .into_response();
    }
    let stored: Option<Stored> = match input.get("channels") {
        Some(channels) => match channels_for(&caller, channels, Some(&Stored::of(&existing))).await
        {
            Ok(stored) => Some(stored),
            Err(response) => return *response,
        },
        None => None,
    };
    // `updateSubscription`: the next run of the subscription as changed.
    let now = js::now_millis();
    let mut next_row = existing.clone();
    if let (Some(obj), Some(schedule)) = (next_row.as_object_mut(), input.get("schedule")) {
        obj.insert("schedule".to_owned(), schedule.clone());
    }
    if let (Some(obj), Some(enabled)) = (next_row.as_object_mut(), input.get("enabled")) {
        obj.insert("enabled".to_owned(), enabled.clone());
    }
    let next = next_run_of(&next_row, now);
    let mut change = subscriptions::Entity::update_many();
    if input.contains_key("name") {
        change = change.col_expr(
            Column::Name,
            Expr::value(input.get("name").and_then(Value::as_str)),
        );
    }
    if let Some(schedule) = input.get("schedule") {
        change = change.col_expr(Column::Schedule, Expr::value(schedule.clone()));
    }
    if input.contains_key("enabled") {
        change = change.col_expr(
            Column::Enabled,
            Expr::value(input.get("enabled").and_then(Value::as_bool)),
        );
    }
    if let Some(stored) = stored {
        change = change
            .col_expr(Column::Channels, Expr::value(stored.channels))
            .col_expr(
                Column::SlackWebhookCiphertext,
                Expr::value(stored.slack_ciphertext),
            );
    }
    let row = change
        .col_expr(Column::NextRunAt, Expr::value(next.map(instant)))
        .col_expr(Column::UpdatedAt, Expr::value(instant(now)))
        .filter(Column::Id.eq(&id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    let sub = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Subscription", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "update subscription"),
    };
    if let Err(error) = reschedule(&caller, &state, &sub).await {
        return unexpected(&error, "update subscription");
    }
    publish(&caller, &state, &sub, PANEL_SUBSCRIPTION_UPDATED);
    Data(dto(&sub)).into_response()
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let existing = match found(&caller, &id).await {
        Ok(sub) => sub,
        Err(response) => return response,
    };
    if !may_change(&existing, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can delete this scheduled report")
            .into_response();
    }
    let now = instant(js::now_millis());
    let row = subscriptions::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::Enabled, Expr::value(false))
        .col_expr(Column::NextRunAt, Expr::value(None::<time::OffsetDateTime>))
        .filter(Column::Id.eq(&id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose());
    let sub = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Subscription", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete subscription"),
    };
    if let Some(master) = master_of(&caller, &state)
        && let Err(error) = delete_schedule(&master, "subscription", &id).await
    {
        return unexpected(&error, "delete subscription");
    }
    publish(&caller, &state, &sub, PANEL_SUBSCRIPTION_DELETED);
    NoContent.into_response()
}

/// `POST /:id/send-now`.
pub(crate) async fn send_now(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let sub = match found(&caller, &id).await {
        Ok(sub) => sub,
        Err(response) => return response,
    };
    if !may_change(&sub, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can send this scheduled report")
            .into_response();
    }
    let ports = super::RequestPorts {
        caller: &caller,
        state: &state,
        delivery: super::delivery_for(&caller, &state, &caller.user_id),
    };
    let sent = send_subscription(&caller.db, now_of(&caller), &ports, &sub, false).await;
    let (delivered, error) = match sent {
        Ok((delivered, error, _)) => (delivered, error),
        Err(error) => return unexpected(&error, "send subscription"),
    };
    if let Some(error) = error.filter(|_| delivered.is_empty()) {
        return ApiError::bad_request(error).into_response();
    }
    Data(delivery::report_json(&delivered)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trends_result_becomes_its_headline_and_top_values() {
        let result = json!({ "kind": "trends", "result": { "series": [
            { "seriesIndex": 0, "label": "Signups", "breakdownValue": null, "total": 42, "previous": { "total": 21 } },
            { "seriesIndex": 0, "label": "Signups", "breakdownValue": "nl", "total": 10 },
            { "seriesIndex": 0, "label": "Signups", "breakdownValue": "de", "total": 30 }
        ] } });
        let block = block_draft(
            &ComputedBlock {
                title: "Signups".to_owned(),
                path: "/weldpanel/insights?report=pnr_1".to_owned(),
                result: Some(result),
            },
            EmailLocale::En,
            true,
        );
        assert_eq!(block.title, "Top values");
        assert_eq!(block.headline[0].value, Some(42.0));
        assert_eq!(block.headline[0].previous, Some(21.0));
        assert_eq!(
            block
                .rows
                .iter()
                .map(|r| r.label.as_str())
                .collect::<Vec<_>>(),
            ["de", "nl"]
        );
    }

    #[test]
    fn digest_specs_compare_and_take_the_dashboard_range() {
        let spec = digest_spec(
            &json!({ "kind": "trends", "projectId": "pnp_a", "series": [{ "event": "Signed up", "label": "Signups" }] }),
            Some(&json!({ "dateRange": { "preset": "7d" } })),
        )
        .expect("spec");
        assert_eq!(spec["compare"], json!(true));
        assert_eq!(spec["dateRange"]["preset"], json!("7d"));
        assert!(digest_spec(&json!({ "kind": "nope" }), None).is_none());
    }

    #[test]
    fn paths_name_the_builder() {
        assert_eq!(
            report_path(&json!({ "id": "pnr_1", "kind": "funnel" })),
            "/weldpanel/funnels?report=pnr_1"
        );
        assert_eq!(
            report_path(&json!({ "id": "pnr_1", "kind": "stickiness" })),
            "/weldpanel/insights?report=pnr_1"
        );
        assert_eq!(dashboard_path("pnd_1"), "/weldpanel/dashboards/pnd_1");
    }
}
