//! Alerts: `/api/panel/alerts` (`routes/alerts/index.ts`,
//! `services/alerts.ts`). An alert watches one series of a trends query (a
//! saved trends report or a spec of its own) and messages its channels when
//! it fires and when it resolves; `weldsuite cron panel-schedule` checks it.
//!
//!   GET    /             → the project's alerts (?projectId, ?scope=all|mine)
//!   POST   /             → new alert
//!   GET    /:id          → one alert
//!   PATCH  /:id          → name, target, series, condition, interval, channels, enabled
//!   DELETE /:id          → soft delete
//!   GET    /:id/events   → history (?cursor, ?limit)
//!   POST   /:id/test     → a test message on every channel
//!   POST   /:id/snooze   → { until } (at most 90 days ahead; null ends it)
//!
//! State: `pending` until the first check, then `ok` or `firing`, or `error`
//! when the check could not run. `fired` is recorded once on the move into
//! `firing`, `resolved` once on the move out; a snoozed alert is still
//! checked and recorded, only its messages wait.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_ALERT_CREATED, PANEL_ALERT_DELETED, PANEL_ALERT_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_emails::panel_monitor::{AlertCondition, AlertEvent, AlertInterval, AlertProps};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_permissions::Permissions;
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::{
    panel_alert_events as alert_events, panel_alerts as alerts, panel_projects, panel_reports,
};

use super::anomaly::{anomaly_band, outside_band};
use super::delivery::{self, Delivered, Message, Stored, Target, channels_dto, delivery_error};
use super::schedule::{
    HOUR, LocalDate, LocalParts, add_days, delete_schedule, format_local_date, local_parts,
    next_alert_check, next_runs_of, upsert_schedule, weekday_of,
};
use super::schemas::{
    ALERT_LIST_QUERY, ALERT_PAGE_QUERY, CONDITION, CREATE_ALERT, SNOOZE_ALERT, UPDATE_ALERT,
};
use super::{MonitorState, channels_for, master_of, now_of};
use crate::saved::{
    Actor, can_change, can_see, field, get_report, instant, js_row, project_exists, text,
};
use crate::schemas_gen::TRENDS_SPEC;
use crate::{Caller, unexpected};

/// Longest snooze (`PANEL_MAX_SNOOZE_DAYS`).
const MAX_SNOOZE_DAYS: i64 = 90;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

/// `toAlertDto(a, nextCheckAt)`.
pub(crate) fn dto(row: &Value, next_check_at: Option<&str>) -> Value {
    let condition = weldsuite_zod::parse_issues(&CONDITION, &field(row, "condition")).map_or_else(
        |_| json!({ "type": "threshold", "operator": "above", "value": 0 }),
        |parsed| Value::Object(parsed.body),
    );
    let enabled = row.get("enabled").and_then(Value::as_bool) == Some(true);
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "reportId": field(row, "reportId"),
        "spec": field(row, "spec"),
        "seriesIndex": field(row, "seriesIndex"),
        "condition": condition,
        "checkInterval": field(row, "checkInterval"),
        "channels": channels_dto(&field(row, "channels"), row.get("slackWebhookCiphertext").and_then(Value::as_str)),
        "enabled": enabled,
        "state": field(row, "state"),
        "lastValue": field(row, "lastValue"),
        "lastCheckedAt": field(row, "lastCheckedAt"),
        "lastFiredAt": field(row, "lastFiredAt"),
        "lastError": field(row, "lastError"),
        "snoozedUntil": field(row, "snoozedUntil"),
        "nextCheckAt": if enabled { next_check_at.map_or(Value::Null, |at| json!(at)) } else { Value::Null },
        "ownerUserId": field(row, "ownerUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `toAlertEventDto(e)`.
fn event_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "alertId": field(row, "alertId"),
        "kind": field(row, "kind"),
        "value": field(row, "value"),
        "bound": field(row, "bound"),
        "message": field(row, "message"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `alertEventData(a)`: never the channels or the spec.
pub(crate) fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "state": field(row, "state"),
        "value": field(row, "lastValue"),
        "enabled": field(row, "enabled"),
    })
}

/// `alertPath(id)`.
fn alert_path(id: &str) -> String {
    format!(
        "/weldpanel/alerts?alert={}",
        weldsuite_kit::cursor::encode_uri_component(id)
    )
}

/// The first row a `returning` statement gave, as Drizzle returns it.
fn first_row(rows: Vec<alerts::Model>) -> Result<Option<Value>, DbErr> {
    rows.into_iter().next().map(js_row).transpose()
}

/// `getAlert(db, id)`.
pub(crate) async fn get_alert(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    alerts::Entity::find_by_id(id)
        .filter(alerts::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose()
}

/// `projectName(db, projectId)`.
pub(crate) async fn project_name(db: &PgPool, project_id: &str) -> Result<String, DbErr> {
    let name: Option<String> = panel_projects::Entity::find_by_id(project_id)
        .select_only()
        .column(panel_projects::Column::Name)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(name.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// The spec an alert runs
// ---------------------------------------------------------------------------

/// `parseTrendsSpec(raw, projectId)`: the parsed trends spec, or the reason.
pub(crate) fn parse_trends_spec(raw: &Value, project_id: &str) -> Result<Value, String> {
    let Ok(parsed) = weldsuite_zod::parse_issues(&TRENDS_SPEC, raw) else {
        return Err("The alert watches a query that is not a valid trends query".to_owned());
    };
    let spec = Value::Object(parsed.body);
    if text(&spec, "projectId") != project_id {
        return Err("The query is for a different project".to_owned());
    }
    Ok(spec)
}

/// `resolveAlertSpec(db, alert)`: its own spec, or its report's.
pub(crate) async fn resolve_alert_spec(
    db: &PgPool,
    alert: &Value,
) -> Result<Result<Value, String>, DbErr> {
    let project_id = text(alert, "projectId");
    let Some(report_id) = alert
        .get("reportId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(parse_trends_spec(&field(alert, "spec"), project_id));
    };
    let report: Option<(Value, String)> = panel_reports::Entity::find_by_id(report_id)
        .select_only()
        .columns([
            panel_reports::Column::Spec,
            panel_reports::Column::ProjectId,
        ])
        .filter(panel_reports::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(match report {
        None => Err("The report this alert watches was deleted".to_owned()),
        Some((_, project)) if project != project_id => {
            Err("The report is in a different project".to_owned())
        }
        Some((spec, _)) => parse_trends_spec(&spec, project_id),
    })
}

/// `seriesLabel(spec, index)`: the series' name as its report shows it.
pub(crate) fn series_label(spec: &Value, index: usize) -> String {
    let series = spec["series"].get(index);
    let label = series
        .and_then(|s| s.get("label"))
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|l| !l.is_empty());
    if let Some(label) = label {
        return label.to_owned();
    }
    series
        .and_then(|s| s.get("event"))
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
        .map_or_else(|| format!("#{}", index + 1), str::to_owned)
}

fn time_zone_of(spec: &Value) -> String {
    spec.get("timezone")
        .and_then(Value::as_str)
        .unwrap_or("UTC")
        .to_owned()
}

/// `nextCheckOf(alert, timezone, now)`: `None` when it is off.
pub(crate) fn next_check_of(alert: &Value, time_zone: &str, now: i64) -> Option<i64> {
    let enabled = alert.get("enabled").and_then(Value::as_bool) == Some(true);
    if !enabled || alert.get("deletedAt").is_some_and(|d| !d.is_null()) {
        return None;
    }
    Some(next_alert_check(
        alert
            .get("checkInterval")
            .and_then(Value::as_str)
            .unwrap_or("daily"),
        time_zone,
        now,
    ))
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/// `CheckWindow`: the period judged and what it is compared with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckWindow {
    pub(crate) interval: &'static str,
    pub(crate) target: String,
    pub(crate) previous: String,
    pub(crate) baseline: Vec<String>,
    pub(crate) from: String,
    pub(crate) to: String,
}

/// `LOOKBACK`: how far back each check reads (hours hourly, days otherwise).
fn lookback(interval: &str, condition: &str) -> i64 {
    match (interval, condition) {
        ("hourly" | "daily", "change") => 1,
        ("hourly", "anomaly") => 14 * 24,
        ("daily", "anomaly") => 28,
        ("weekly", "change") => 7,
        ("weekly", "anomaly") => 28 * 7,
        _ => 0,
    }
}

/// `hourLabel(wallMs)`.
fn hour_label(wall: i64) -> String {
    let iso = js::iso_string(wall);
    format!("{}:00", &iso[..13])
}

fn wall_date(wall: i64) -> LocalDate {
    let p = js::date_parts(wall);
    LocalDate {
        year: p.year,
        month: p.month,
        day: p.day,
    }
}

/// `checkWindow(interval, condition, timezone, now)`.
pub(crate) fn check_window(
    interval: &str,
    condition: &str,
    time_zone: &str,
    now: i64,
) -> CheckWindow {
    let p = local_parts(now, time_zone);
    match interval {
        "hourly" => hourly_window(condition, p),
        "daily" => daily_window(condition, p.date()),
        _ => weekly_window(condition, p.date()),
    }
}

fn hourly_window(condition: &str, p: LocalParts) -> CheckWindow {
    let target = js::date_utc(p.year, p.month - 1, p.day) + p.hour * HOUR - HOUR;
    let back = lookback("hourly", condition) * HOUR;
    CheckWindow {
        interval: "hour",
        target: hour_label(target),
        previous: hour_label(target - HOUR),
        baseline: (0..14)
            .map(|i| hour_label(target - (i + 1) * 24 * HOUR))
            .collect(),
        from: format_local_date(wall_date(target - back)),
        to: format_local_date(wall_date(target)),
    }
}

fn daily_window(condition: &str, today: LocalDate) -> CheckWindow {
    let target = add_days(today, -1);
    CheckWindow {
        interval: "day",
        target: format_local_date(target),
        previous: format_local_date(add_days(target, -1)),
        baseline: (0..28)
            .map(|i| format_local_date(add_days(target, -(i + 1))))
            .collect(),
        from: format_local_date(add_days(target, -lookback("daily", condition))),
        to: format_local_date(target),
    }
}

fn weekly_window(condition: &str, today: LocalDate) -> CheckWindow {
    let monday = add_days(today, -((weekday_of(today) + 6) % 7));
    let target = add_days(monday, -7);
    CheckWindow {
        interval: "week",
        target: format_local_date(target),
        previous: format_local_date(add_days(target, -7)),
        baseline: (0..28)
            .map(|i| format_local_date(add_days(target, -7 * (i + 1))))
            .collect(),
        from: format_local_date(add_days(target, -lookback("weekly", condition))),
        to: format_local_date(add_days(target, 6)),
    }
}

/// `checkSpec(spec, window)`: one plain series over the window's days.
pub(crate) fn check_spec(spec: &Value, window: &CheckWindow) -> Result<Value, String> {
    let mut raw: Map<String, Value> = spec.as_object().cloned().unwrap_or_default();
    raw.insert(
        "dateRange".to_owned(),
        json!({ "from": window.from, "to": window.to }),
    );
    raw.insert("interval".to_owned(), json!(window.interval));
    raw.insert("compare".to_owned(), json!(false));
    for key in ["breakdown", "breakdowns", "formulas", "formulaOnly"] {
        raw.remove(key);
    }
    weldsuite_zod::parse_issues(&TRENDS_SPEC, &Value::Object(raw))
        .map(|parsed| Value::Object(parsed.body))
        .map_err(|issues| format!("{issues:?}"))
}

/// `Evaluation`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Evaluation {
    Judged {
        firing: bool,
        value: f64,
        bound: Option<f64>,
    },
    Skipped {
        value: Option<f64>,
        reason: &'static str,
    },
}

fn percent_change(value: f64, previous: f64) -> f64 {
    if previous != 0.0 {
        return (value - previous) / previous.abs() * 100.0;
    }
    if value == 0.0 {
        return 0.0;
    }
    value.signum() * f64::INFINITY
}

fn evaluate_change(direction: &str, percent: f64, value: f64, previous: f64) -> Evaluation {
    let change = percent_change(value, previous);
    let up = previous + previous.abs() * (percent / 100.0);
    let down = previous - previous.abs() * (percent / 100.0);
    let (firing, bound) = match direction {
        "increase" => (change >= percent, up),
        "decrease" => (change <= -percent, down),
        _ => (
            change.abs() >= percent,
            if value >= previous { up } else { down },
        ),
    };
    Evaluation::Judged {
        firing,
        value,
        bound: Some(bound),
    }
}

/// `evaluateCondition(condition, points, window)`. Pure.
pub(crate) fn evaluate_condition(
    condition: &Value,
    points: &[(String, f64)],
    window: &CheckWindow,
) -> Evaluation {
    let at = |label: &str| {
        points
            .iter()
            .rev()
            .find(|(b, _)| b == label)
            .map(|(_, v)| *v)
    };
    let Some(value) = at(&window.target) else {
        return Evaluation::Skipped {
            value: None,
            reason: "No data for the period (outside the plan’s retention?)",
        };
    };
    let kind = text(condition, "type");
    let number = |key: &str| condition.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    match kind {
        "threshold" => {
            let limit = number("value");
            let firing = if text(condition, "operator") == "above" {
                value > limit
            } else {
                value < limit
            };
            Evaluation::Judged {
                firing,
                value,
                bound: Some(limit),
            }
        }
        "change" => match at(&window.previous) {
            None => Evaluation::Skipped {
                value: Some(value),
                reason: "No data for the period before",
            },
            Some(previous) => evaluate_change(
                text(condition, "direction"),
                number("percent"),
                value,
                previous,
            ),
        },
        _ => {
            let baseline: Vec<f64> = window
                .baseline
                .iter()
                .filter_map(|label| at(label))
                .collect();
            match anomaly_band(&baseline, text(condition, "sensitivity")) {
                None => Evaluation::Skipped {
                    value: Some(value),
                    reason: "Not enough history for an anomaly band yet (7 periods)",
                },
                Some(band) => {
                    let (outside, bound) = outside_band(value, &band);
                    Evaluation::Judged {
                        firing: outside,
                        value,
                        bound: Some(bound),
                    }
                }
            }
        }
    }
}

/// `seriesPoints(result, seriesIndex)`: the series' points by bucket label.
pub(crate) fn series_points(result: &Value, series_index: i64) -> Option<Vec<(String, f64)>> {
    if result["kind"] != "trends" {
        return None;
    }
    let lines: Vec<&Value> = result["result"]["series"]
        .as_array()?
        .iter()
        .filter(|s| s["seriesIndex"].as_i64() == Some(series_index))
        .collect();
    let line = lines
        .iter()
        .find(|s| s["breakdownValue"].is_null())
        .or_else(|| lines.first())?;
    Some(
        line["points"]
            .as_array()
            .map(|points| {
                points
                    .iter()
                    .filter_map(|p| Some((p["bucket"].as_str()?.to_owned(), p["value"].as_f64()?)))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// What a check runs with (`AlertCheckDeps`), besides the database and the
/// clock: the query, delivery and the `fired` / `resolved` events.
pub(crate) trait CheckPorts: Send + Sync {
    /// Runs a parsed spec (`runCachedQuery`): `{ kind, result }`.
    fn run(&self, spec: Value) -> BoxFuture<'_, Result<Value, String>>;
    fn deliver<'a>(
        &'a self,
        target: &'a Target,
        message: &'a Message,
    ) -> BoxFuture<'a, Vec<Delivered>>;
    /// Publishes `panel_alert` `fired` / `resolved`.
    fn publish<'a>(&'a self, alert: &'a Value, action: &'static str) -> BoxFuture<'a, ()>;
}

/// `CheckOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Fired,
    Resolved,
    Firing,
    Ok,
    Skipped,
    Error,
}

/// `AlertCheckResult`.
#[derive(Debug, Clone)]
pub(crate) struct CheckResult {
    pub(crate) alert: Value,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) outcome: Outcome,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) delivered: Vec<Delivered>,
    /// The spec's time zone, for the next check.
    pub(crate) time_zone: String,
}

/// `wasFiring(db, alert)`: in `firing`, or in `error` after an unresolved `fired`.
async fn was_firing(db: &PgPool, alert: &Value) -> Result<bool, DbErr> {
    let state = text(alert, "state");
    if state == "firing" {
        return Ok(true);
    }
    if state != "error" || alert.get("lastFiredAt").is_none_or(Value::is_null) {
        return Ok(false);
    }
    let last: Option<String> = alert_events::Entity::find()
        .select_only()
        .column(alert_events::Column::Kind)
        .filter(alert_events::Column::AlertId.eq(text(alert, "id")))
        .filter(alert_events::Column::Kind.is_in(["fired", "resolved"]))
        .order_by_desc(alert_events::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(last.as_deref() == Some("fired"))
}

async fn record_event(
    db: &PgPool,
    alert: &Value,
    kind: &str,
    value: Option<f64>,
    bound: Option<f64>,
    message: Option<&str>,
) -> Result<(), DbErr> {
    alert_events::Entity::insert(alert_events::ActiveModel {
        id: Set(weldsuite_kit::generate_id("pnae")),
        alert_id: Set(text(alert, "id").to_owned()),
        project_id: Set(text(alert, "projectId").to_owned()),
        kind: Set(kind.to_owned()),
        value: Set(value),
        bound: Set(bound),
        message: Set(message.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

fn condition_of(alert: &Value) -> Option<AlertCondition> {
    let parsed = weldsuite_zod::parse_issues(&CONDITION, &field(alert, "condition")).ok()?;
    serde_json::from_value(Value::Object(parsed.body)).ok()
}

fn interval_of(alert: &Value) -> AlertInterval {
    match text(alert, "checkInterval") {
        "hourly" => AlertInterval::Hourly,
        "weekly" => AlertInterval::Weekly,
        _ => AlertInterval::Daily,
    }
}

/// `alertMessage(alert, input)`: the message of a state change or a test;
/// `None` when the stored condition does not parse (`.parse()` throws).
pub(crate) fn alert_message(
    alert: &Value,
    event: AlertEvent,
    metric: String,
    value: Option<f64>,
    bound: Option<f64>,
    period: Option<String>,
    project_name: String,
) -> Option<Message> {
    let id = text(alert, "id").to_owned();
    Some(Message::Alert {
        path: alert_path(&id),
        entity_id: id,
        alert: AlertProps {
            alert_name: text(alert, "name").to_owned(),
            project_name,
            event,
            metric,
            value,
            bound,
            condition: condition_of(alert)?,
            interval: interval_of(alert),
            period,
            url: String::new(),
        },
    })
}

/// `save(db, id, set)` of the check's fields: `None` leaves a column, `Some(None)` clears it.
#[derive(Default)]
#[allow(clippy::option_option)]
struct Save<'a> {
    state: Option<&'a str>,
    last_value: Option<Option<f64>>,
    last_error: Option<Option<String>>,
    last_checked: bool,
    last_fired: bool,
}

async fn save(db: &PgPool, id: &str, now: i64, set: Save<'_>) -> Result<Option<Value>, DbErr> {
    let now = instant(now);
    let mut update = alerts::Entity::update_many();
    if let Some(state) = set.state {
        update = update.col_expr(alerts::Column::State, Expr::value(state));
    }
    if let Some(last_value) = set.last_value {
        update = update.col_expr(alerts::Column::LastValue, Expr::value(last_value));
    }
    if let Some(last_error) = set.last_error {
        update = update.col_expr(alerts::Column::LastError, Expr::value(last_error));
    }
    if set.last_checked {
        update = update.col_expr(alerts::Column::LastCheckedAt, Expr::value(now));
    }
    if set.last_fired {
        update = update.col_expr(alerts::Column::LastFiredAt, Expr::value(now));
    }
    update
        .col_expr(alerts::Column::UpdatedAt, Expr::value(now))
        .filter(alerts::Column::Id.eq(id))
        .filter(alerts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await
        .and_then(first_row)
}

/// `runAlertCheck(deps, alert)`: runs the query for the window, judges it,
/// moves the state, writes the history and sends the messages. A failed
/// query is not an error here: the alert goes to `error` with the reason.
#[allow(clippy::too_many_lines)] // one state machine, step by step as the worker's
pub(crate) async fn run_alert_check(
    db: &PgPool,
    now: i64,
    ports: &dyn CheckPorts,
    alert: &Value,
) -> Result<CheckResult, DbErr> {
    let id = text(alert, "id").to_owned();
    let measured = measure(db, now, ports, alert).await?;
    let (spec, window, evaluation) = match measured {
        Err((reason, time_zone)) => {
            let reason = js::slice_utf16(&reason, 0, 1000);
            if text(alert, "state") != "error" {
                record_event(db, alert, "error", None, None, Some(&reason)).await?;
            }
            let row = save(
                db,
                &id,
                now,
                Save {
                    state: Some("error"),
                    last_error: Some(Some(reason)),
                    last_checked: true,
                    ..Save::default()
                },
            )
            .await?;
            return Ok(CheckResult {
                alert: row.unwrap_or_else(|| alert.clone()),
                outcome: Outcome::Error,
                delivered: Vec::new(),
                time_zone,
            });
        }
        Ok(measured) => measured,
    };
    let time_zone = time_zone_of(&spec);
    let firing_before = was_firing(db, alert).await?;

    let (firing, value, bound) = match evaluation {
        Evaluation::Skipped { value, .. } => {
            let mut state = text(alert, "state").to_owned();
            if state == "error" {
                if firing_before { "firing" } else { "pending" }.clone_into(&mut state);
            }
            let row = save(
                db,
                &id,
                now,
                Save {
                    state: Some(&state),
                    last_value: Some(value),
                    last_error: Some(None),
                    last_checked: true,
                    ..Save::default()
                },
            )
            .await?;
            return Ok(CheckResult {
                alert: row.unwrap_or_else(|| alert.clone()),
                outcome: Outcome::Skipped,
                delivered: Vec::new(),
                time_zone,
            });
        }
        Evaluation::Judged {
            firing,
            value,
            bound,
        } => (firing, value, bound),
    };

    let steady = if firing { "firing" } else { "ok" };
    let change = match (firing, firing_before) {
        (true, false) => Some("fired"),
        (false, true) => Some("resolved"),
        _ => None,
    };
    let row = save(
        db,
        &id,
        now,
        Save {
            state: Some(steady),
            last_value: Some(Some(value)),
            last_error: Some(None),
            last_checked: true,
            last_fired: change == Some("fired"),
        },
    )
    .await?;
    let steady_outcome = if firing { Outcome::Firing } else { Outcome::Ok };
    let (Some(row), Some(change)) = (row.clone(), change) else {
        return Ok(CheckResult {
            alert: row.unwrap_or_else(|| alert.clone()),
            outcome: steady_outcome,
            delivered: Vec::new(),
            time_zone,
        });
    };

    record_event(db, &row, change, Some(value), bound, None).await?;
    ports.publish(&row, change).await;
    let (row, delivered) =
        announce(db, now, ports, row, change, &spec, &window, value, bound).await?;
    Ok(CheckResult {
        alert: row,
        outcome: if change == "fired" {
            Outcome::Fired
        } else {
            Outcome::Resolved
        },
        delivered,
        time_zone,
    })
}

type Measured = Result<(Value, CheckWindow, Evaluation), (String, String)>;

/// `measure(deps, alert)`: resolves the query, runs it and judges the value.
async fn measure(
    db: &PgPool,
    now: i64,
    ports: &dyn CheckPorts,
    alert: &Value,
) -> Result<Measured, DbErr> {
    let spec = match resolve_alert_spec(db, alert).await? {
        Ok(spec) => spec,
        Err(reason) => return Ok(Err((reason, "UTC".to_owned()))),
    };
    let time_zone = time_zone_of(&spec);
    let Ok(condition) = weldsuite_zod::parse_issues(&CONDITION, &field(alert, "condition")) else {
        return Ok(Err((
            "The alert’s condition is not valid".to_owned(),
            time_zone,
        )));
    };
    let condition = Value::Object(condition.body);
    let window = check_window(
        text(alert, "checkInterval"),
        text(&condition, "type"),
        &time_zone,
        now,
    );
    let points = match check_spec(&spec, &window) {
        Err(error) => return Ok(Err((error, time_zone))),
        Ok(query) => match ports.run(query).await {
            Err(error) => return Ok(Err((error, time_zone))),
            Ok(result) => series_points(
                &result,
                alert
                    .get("seriesIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            ),
        },
    };
    let Some(points) = points else {
        return Ok(Err(("The query has no such series".to_owned(), time_zone)));
    };
    let evaluation = evaluate_condition(&condition, &points, &window);
    Ok(Ok((spec, window, evaluation)))
}

fn snoozed(alert: &Value, now: i64) -> bool {
    alert
        .get("snoozedUntil")
        .and_then(Value::as_str)
        .and_then(js::parse_iso)
        .is_some_and(|until| until > now)
}

/// `announce(deps, row, change, judged)`: messages the channels (unless
/// snoozed) and records a delivery failure on the alert.
#[allow(clippy::too_many_arguments)]
async fn announce(
    db: &PgPool,
    now: i64,
    ports: &dyn CheckPorts,
    row: Value,
    change: &str,
    spec: &Value,
    window: &CheckWindow,
    value: f64,
    bound: Option<f64>,
) -> Result<(Value, Vec<Delivered>), DbErr> {
    if snoozed(&row, now) {
        return Ok((row, Vec::new()));
    }
    let index = row.get("seriesIndex").and_then(Value::as_u64).unwrap_or(0);
    let event = if change == "fired" {
        AlertEvent::Fired
    } else {
        AlertEvent::Resolved
    };
    let Some(message) = alert_message(
        &row,
        event,
        series_label(spec, usize::try_from(index).unwrap_or(0)),
        Some(value),
        bound,
        Some(window.target.clone()),
        project_name(db, text(&row, "projectId")).await?,
    ) else {
        return Ok((row, Vec::new()));
    };
    let delivered = ports.deliver(&Target::of(&row), &message).await;
    let Some(failure) = delivery_error(&delivered) else {
        return Ok((row, delivered));
    };
    let saved = save(
        db,
        text(&row, "id"),
        now,
        Save {
            last_error: Some(Some(failure)),
            ..Save::default()
        },
    )
    .await?;
    Ok((saved.unwrap_or(row), delivered))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// Alerts have no private/shared switch: the owner (or a manager) changes them.
fn may_change(alert: &Value, actor: &Actor) -> bool {
    can_change(
        &json!({ "ownerUserId": field(alert, "ownerUserId"), "visibility": "workspace" }),
        actor,
    )
}

fn publish(caller: &Caller, state: &MonitorState, alert: &Value, event: EventName) {
    caller.publish(&state.panel, event, text(alert, "id"), &event_data(alert));
}

/// `dto(c, alert)`: with its next check from the registry.
async fn alert_dto(caller: &Caller, state: &MonitorState, alert: &Value) -> Result<Value, DbErr> {
    let master = master_of(caller, state);
    let next = match &master {
        Some(master) => next_runs_of(master, "alert", &[text(alert, "id").to_owned()]).await?,
        None => Vec::new(),
    };
    Ok(dto(alert, next.first().map(|(_, at)| at.as_str())))
}

/// `reschedule(c, alert, timezone)`.
async fn reschedule(
    caller: &Caller,
    state: &MonitorState,
    alert: &Value,
    time_zone: &str,
) -> Result<(), DbErr> {
    let Some(master) = master_of(caller, state) else {
        return Ok(());
    };
    upsert_schedule(
        &master,
        &caller.workspace_id,
        "alert",
        text(alert, "id"),
        next_check_of(alert, time_zone, now_of(caller)),
    )
    .await
}

/// `checkTarget(c, actor, projectId, target, seriesIndex)`: the trends spec
/// the alert watches, or the refusal.
async fn check_target(
    caller: &Caller,
    actor: &Actor,
    project_id: &str,
    report_id: Option<&str>,
    spec: &Value,
    series_index: i64,
) -> Result<Value, Response> {
    let parsed = if let Some(report_id) = report_id.filter(|id| !id.is_empty()) {
        let report = match get_report(&caller.db, report_id).await {
            Ok(report) => report,
            Err(error) => return Err(unexpected(&error, "get report")),
        };
        let Some(report) = report.filter(|r| can_see(r, actor)) else {
            return Err(ApiError::not_found("Report", Some(report_id)).into_response());
        };
        if text(&report, "projectId") != project_id {
            return Err(
                ApiError::bad_request("The report is in a different project").into_response(),
            );
        }
        if text(&report, "kind") != "trends" {
            return Err(ApiError::bad_request("An alert watches a trends report").into_response());
        }
        parse_trends_spec(&field(&report, "spec"), project_id)
    } else {
        parse_trends_spec(spec, project_id)
    };
    let spec = parsed.map_err(|reason| ApiError::bad_request(reason).into_response())?;
    let count = spec["series"].as_array().map_or(0, Vec::len);
    if usize::try_from(series_index).unwrap_or(usize::MAX) >= count {
        return Err(ApiError::bad_request("The query has no such series").into_response());
    }
    Ok(spec)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `GET /`.
pub(crate) async fn list(
    State(state): State<MonitorState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&ALERT_LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let owner = (query.text("scope") == Some("mine")).then(|| caller.user_id.clone());
    let mut find = alerts::Entity::find().filter(alerts::Column::DeletedAt.is_null());
    if let Some(project_id) = query.text("projectId") {
        find = find.filter(alerts::Column::ProjectId.eq(project_id));
    }
    if let Some(owner) = owner {
        find = find.filter(alerts::Column::OwnerUserId.eq(owner));
    }
    let found = find
        .order_by_desc(alerts::Column::UpdatedAt)
        .limit(500)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    let alerts: Vec<Value> = match found {
        Ok(found) => found,
        Err(error) => return unexpected(&error, "list alerts"),
    };
    let ids: Vec<String> = alerts.iter().map(|a| text(a, "id").to_owned()).collect();
    let next = match master_of(&caller, &state) {
        Some(master) => match next_runs_of(&master, "alert", &ids).await {
            Ok(next) => next,
            Err(error) => return unexpected(&error, "list alerts"),
        },
        None => Vec::new(),
    };
    let data: Vec<Value> = alerts
        .iter()
        .map(|a| {
            let at = next
                .iter()
                .find(|(id, _)| id == text(a, "id"))
                .map(|(_, at)| at.as_str());
            dto(a, at)
        })
        .collect();
    let count = data.len() as u64;
    List::new(data, Pagination::new(count, false, None)).into_response()
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
    let input = match weldsuite_zod::json(&CREATE_ALERT, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    let project_id = input
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create alert"),
    }
    let actor = Actor::of(&caller, &permissions);
    let series_index = input
        .get("seriesIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let spec = match check_target(
        &caller,
        &actor,
        &project_id,
        input.get("reportId").and_then(Value::as_str),
        &field(&Value::Object(input.clone()), "spec"),
        series_index,
    )
    .await
    {
        Ok(spec) => spec,
        Err(response) => return response,
    };
    let channels = field(&Value::Object(input.clone()), "channels");
    let stored = match channels_for(&caller, &channels, None).await {
        Ok(stored) => stored,
        Err(response) => return *response,
    };
    // The schema requires the name and the condition and defaults the interval.
    let row = alerts::Entity::insert(alerts::ActiveModel {
        id: Set(weldsuite_kit::generate_id("pnal")),
        project_id: Set(project_id.clone()),
        name: Set(input
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()),
        report_id: Set(input
            .get("reportId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)),
        spec: Set(input.get("spec").filter(|s| !s.is_null()).cloned()),
        series_index: Set(i32::try_from(series_index).unwrap_or(0)),
        condition: Set(input.get("condition").cloned().unwrap_or(Value::Null)),
        check_interval: Set(input
            .get("checkInterval")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()),
        channels: Set(stored.channels.clone()),
        slack_webhook_ciphertext: Set(stored.slack_ciphertext.clone()),
        enabled: Set(input
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)),
        owner_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    let alert = match row {
        Ok(row) => row,
        Err(error) => return unexpected(&error, "create alert"),
    };
    if let Err(error) = reschedule(&caller, &state, &alert, &time_zone_of(&spec)).await {
        return unexpected(&error, "create alert");
    }
    publish(&caller, &state, &alert, PANEL_ALERT_CREATED);
    match alert_dto(&caller, &state, &alert).await {
        Ok(dto) => Created(dto).into_response(),
        Err(error) => unexpected(&error, "create alert"),
    }
}

/// The alert or its 404.
async fn found(caller: &Caller, id: &str) -> Result<Value, Response> {
    match get_alert(&caller.db, id).await {
        Ok(Some(alert)) => Ok(alert),
        Ok(None) => Err(ApiError::not_found("Alert", Some(id)).into_response()),
        Err(error) => Err(unexpected(&error, "get alert")),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let alert = match found(&caller, &id).await {
        Ok(alert) => alert,
        Err(response) => return response,
    };
    match alert_dto(&caller, &state, &alert).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "get alert"),
    }
}

/// `updateAlert(db, id, input, stored)`: a new condition, series, interval
/// or target starts the alert over (`pending`).
async fn update_alert(
    db: &PgPool,
    id: &str,
    input: &Map<String, Value>,
    stored: Option<&Stored>,
    now: i64,
) -> Result<Option<Value>, DbErr> {
    let retarget = input.contains_key("reportId") || input.contains_key("spec");
    let restart = retarget
        || input.contains_key("condition")
        || input.contains_key("seriesIndex")
        || input.contains_key("checkInterval");
    let text_of = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut update = alerts::Entity::update_many();
    if input.contains_key("name") {
        update = update.col_expr(alerts::Column::Name, Expr::value(text_of("name")));
    }
    if retarget {
        let report_id = text_of("reportId").filter(|r| !r.is_empty());
        let spec = input.get("spec").filter(|s| truthy(Some(*s))).cloned();
        update = update
            .col_expr(alerts::Column::ReportId, Expr::value(report_id))
            .col_expr(alerts::Column::Spec, Expr::value(spec));
    }
    if input.contains_key("seriesIndex") {
        let index = input
            .get("seriesIndex")
            .and_then(Value::as_i64)
            .and_then(|i| i32::try_from(i).ok());
        update = update.col_expr(alerts::Column::SeriesIndex, Expr::value(index));
    }
    if input.contains_key("condition") {
        let condition = input.get("condition").cloned();
        update = update.col_expr(alerts::Column::Condition, Expr::value(condition));
    }
    if input.contains_key("checkInterval") {
        update = update.col_expr(
            alerts::Column::CheckInterval,
            Expr::value(text_of("checkInterval")),
        );
    }
    if input.contains_key("enabled") {
        let enabled = input.get("enabled").and_then(Value::as_bool);
        update = update.col_expr(alerts::Column::Enabled, Expr::value(enabled));
    }
    if let Some(stored) = stored {
        update = update
            .col_expr(
                alerts::Column::Channels,
                Expr::value(stored.channels.clone()),
            )
            .col_expr(
                alerts::Column::SlackWebhookCiphertext,
                Expr::value(stored.slack_ciphertext.clone()),
            );
    }
    if restart {
        update = update
            .col_expr(alerts::Column::State, Expr::value("pending"))
            .col_expr(alerts::Column::LastValue, Expr::value(Option::<f64>::None))
            .col_expr(
                alerts::Column::LastError,
                Expr::value(Option::<String>::None),
            );
    }
    update
        .col_expr(alerts::Column::UpdatedAt, Expr::value(instant(now)))
        .filter(alerts::Column::Id.eq(id))
        .filter(alerts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await
        .and_then(first_row)
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
    let input = match weldsuite_zod::json(&UPDATE_ALERT, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let existing = match found(&caller, &id).await {
        Ok(alert) => alert,
        Err(response) => return response,
    };
    if !may_change(&existing, &actor) {
        return ApiError::forbidden()
            .with_message("Only the owner can change this alert")
            .into_response();
    }
    // `patchedTarget`: checked when the target or the series changes.
    let retarget = input.contains_key("reportId") || input.contains_key("spec");
    let target = if retarget || input.contains_key("seriesIndex") {
        let (report_id, spec) = if retarget {
            (
                input
                    .get("reportId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input.get("spec").cloned().unwrap_or(Value::Null),
            )
        } else {
            (
                existing
                    .get("reportId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                field(&existing, "spec"),
            )
        };
        if report_id.as_deref().is_none_or(str::is_empty) && !truthy(Some(&spec)) {
            return ApiError::bad_request("Give either a report or a spec").into_response();
        }
        let series = input
            .get("seriesIndex")
            .and_then(Value::as_i64)
            .or_else(|| existing.get("seriesIndex").and_then(Value::as_i64))
            .unwrap_or(0);
        match check_target(
            &caller,
            &actor,
            text(&existing, "projectId"),
            report_id.as_deref(),
            &spec,
            series,
        )
        .await
        {
            Ok(spec) => Some(spec),
            Err(response) => return response,
        }
    } else {
        None
    };
    let stored = match input.get("channels") {
        Some(channels) => match channels_for(&caller, channels, Some(&Stored::of(&existing))).await
        {
            Ok(stored) => Some(stored),
            Err(response) => return *response,
        },
        None => None,
    };
    let alert = match update_alert(&caller.db, &id, &input, stored.as_ref(), js::now_millis()).await
    {
        Ok(Some(alert)) => alert,
        Ok(None) => return ApiError::not_found("Alert", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "update alert"),
    };
    let time_zone = match target {
        Some(spec) => time_zone_of(&spec),
        None => match resolve_alert_spec(&caller.db, &alert).await {
            Ok(Ok(spec)) => time_zone_of(&spec),
            Ok(Err(_)) => "UTC".to_owned(),
            Err(error) => return unexpected(&error, "update alert"),
        },
    };
    if let Err(error) = reschedule(&caller, &state, &alert, &time_zone).await {
        return unexpected(&error, "update alert");
    }
    publish(&caller, &state, &alert, PANEL_ALERT_UPDATED);
    match alert_dto(&caller, &state, &alert).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "update alert"),
    }
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let existing = match found(&caller, &id).await {
        Ok(alert) => alert,
        Err(response) => return response,
    };
    if !may_change(&existing, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can delete this alert")
            .into_response();
    }
    let now = instant(js::now_millis());
    let row = alerts::Entity::update_many()
        .col_expr(alerts::Column::DeletedAt, Expr::value(now))
        .col_expr(alerts::Column::UpdatedAt, Expr::value(now))
        .col_expr(alerts::Column::Enabled, Expr::value(false))
        .filter(alerts::Column::Id.eq(&id))
        .filter(alerts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    let alert = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Alert", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete alert"),
    };
    if let Some(master) = master_of(&caller, &state)
        && let Err(error) = delete_schedule(&master, "alert", &id).await
    {
        return unexpected(&error, "delete alert");
    }
    publish(&caller, &state, &alert, PANEL_ALERT_DELETED);
    NoContent.into_response()
}

/// `GET /:id/events`.
pub(crate) async fn events(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&ALERT_PAGE_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    if let Err(response) = found(&caller, &id).await {
        return response;
    }
    let limit = query.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let mut find = alert_events::Entity::find().filter(alert_events::Column::AlertId.eq(&id));
    if let Some(cursor) = query.text("cursor").and_then(js::parse_iso) {
        find = find.filter(alert_events::Column::CreatedAt.lt(instant(cursor)));
    }
    let rows = find
        .order_by_desc(alert_events::Column::CreatedAt)
        .limit(u64::try_from(limit + 1).unwrap_or_default())
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    let rows: Vec<Value> = match rows {
        Ok(rows) => rows,
        Err(error) => return unexpected(&error, "alert events"),
    };
    page(rows, limit, "createdAt", event_dto)
}

/// A history page: `limit` rows, the cursor the last one's `key`.
pub(crate) fn page(
    mut rows: Vec<Value>,
    limit: i64,
    key: &str,
    dto: fn(&Value) -> Value,
) -> Response {
    let limit = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    let data: Vec<Value> = rows.iter().map(dto).collect();
    let count = data.len() as u64;
    List::new(data, Pagination::new(count, has_more, cursor)).into_response()
}

/// `POST /:id/test`.
pub(crate) async fn test(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let alert = match found(&caller, &id).await {
        Ok(alert) => alert,
        Err(response) => return response,
    };
    if !may_change(&alert, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can test this alert")
            .into_response();
    }
    let metric = match resolve_alert_spec(&caller.db, &alert).await {
        Ok(Ok(spec)) => series_label(
            &spec,
            alert
                .get("seriesIndex")
                .and_then(Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
                .unwrap_or(0),
        ),
        Ok(Err(_)) => text(&alert, "name").to_owned(),
        Err(error) => return unexpected(&error, "test alert"),
    };
    let project = match project_name(&caller.db, text(&alert, "projectId")).await {
        Ok(name) => name,
        Err(error) => return unexpected(&error, "test alert"),
    };
    let Some(message) = alert_message(&alert, AlertEvent::Test, metric, None, None, None, project)
    else {
        return unexpected(&"the alert's condition is not valid", "test alert");
    };
    let ctx = super::delivery_for(&caller, &state, &caller.user_id);
    let delivered = delivery::deliver(&ctx, &Target::of(&alert), &message).await;
    Data(delivery::report_json(&delivered)).into_response()
}

/// `POST /:id/snooze`.
pub(crate) async fn snooze(
    State(state): State<MonitorState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&SNOOZE_ALERT, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    let existing = match found(&caller, &id).await {
        Ok(alert) => alert,
        Err(response) => return response,
    };
    if !may_change(&existing, &Actor::of(&caller, &permissions)) {
        return ApiError::forbidden()
            .with_message("Only the owner can snooze this alert")
            .into_response();
    }
    let at = input
        .get("until")
        .and_then(Value::as_str)
        .and_then(js::parse_iso);
    let now = js::now_millis();
    if let Some(at) = at
        && (at <= now || at > now + MAX_SNOOZE_DAYS * 86_400_000)
    {
        return ApiError::bad_request(format!(
            "Snooze until a time in the next {MAX_SNOOZE_DAYS} days"
        ))
        .into_response();
    }
    let row = alerts::Entity::update_many()
        .col_expr(alerts::Column::SnoozedUntil, Expr::value(at.map(instant)))
        .col_expr(alerts::Column::UpdatedAt, Expr::value(instant(now)))
        .filter(alerts::Column::Id.eq(&id))
        .filter(alerts::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    let alert = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Alert", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "snooze alert"),
    };
    publish(&caller, &state, &alert, PANEL_ALERT_UPDATED);
    match alert_dto(&caller, &state, &alert).await {
        Ok(dto) => Data(dto).into_response(),
        Err(error) => unexpected(&error, "snooze alert"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        js::parse_iso(iso).expect("iso")
    }

    // `alerts.test.ts`: checkWindow.
    #[test]
    fn hourly_the_last_full_local_hour_the_hour_before_the_same_hour_on_14_days() {
        let now = at("2026-11-18T10:20:00Z");
        let w = check_window("hourly", "anomaly", "Europe/Amsterdam", now);
        assert_eq!(w.interval, "hour");
        assert_eq!(w.target, "2026-11-18T10:00");
        assert_eq!(w.previous, "2026-11-18T09:00");
        assert_eq!(w.baseline.len(), 14);
        assert_eq!(w.baseline[0], "2026-11-17T10:00");
        assert_eq!(w.baseline[13], "2026-11-04T10:00");
        assert_eq!(
            (w.from.as_str(), w.to.as_str()),
            ("2026-11-04", "2026-11-18")
        );
        let t = check_window("hourly", "threshold", "UTC", now);
        assert_eq!(
            (t.from.as_str(), t.to.as_str()),
            ("2026-11-18", "2026-11-18")
        );
    }

    #[test]
    fn daily_yesterday_in_the_timezone_the_28_days_before_for_an_anomaly() {
        let w = check_window(
            "daily",
            "change",
            "America/New_York",
            at("2026-11-18T03:00:00Z"),
        );
        assert_eq!(w.target, "2026-11-16");
        assert_eq!(w.previous, "2026-11-15");
        assert_eq!(
            (w.from.as_str(), w.to.as_str()),
            ("2026-11-15", "2026-11-16")
        );
        let a = check_window("daily", "anomaly", "UTC", at("2026-11-18T10:20:00Z"));
        assert_eq!(a.baseline.len(), 28);
        assert_eq!(
            (a.from.as_str(), a.to.as_str()),
            ("2026-10-20", "2026-11-17")
        );
    }

    #[test]
    fn weekly_last_monday_to_sunday_week() {
        let w = check_window("weekly", "threshold", "UTC", at("2026-11-18T10:20:00Z"));
        assert_eq!(w.interval, "week");
        assert_eq!(w.target, "2026-11-09");
        assert_eq!(w.previous, "2026-11-02");
        assert_eq!(
            (w.from.as_str(), w.to.as_str()),
            ("2026-11-09", "2026-11-15")
        );
    }

    // checkSpec.
    #[test]
    fn runs_one_plain_series_over_the_window() {
        let spec = check_spec(
            &json!({
                "kind": "trends", "projectId": "pnp_a", "dateRange": { "preset": "30d" }, "timezone": "UTC",
                "filters": [], "interval": "month", "compare": true,
                "series": [{ "event": "Signed up", "math": "total", "filters": [] }],
                "breakdown": { "source": "column", "field": "country", "limit": 10 }
            }),
            &check_window("daily", "threshold", "UTC", at("2026-11-18T10:00:00Z")),
        )
        .expect("spec");
        assert_eq!(
            spec["dateRange"],
            json!({ "from": "2026-11-17", "to": "2026-11-17" })
        );
        assert_eq!(spec["interval"], json!("day"));
        assert_eq!(spec["compare"], json!(false));
        assert!(spec.get("breakdown").is_none());
    }

    // evaluateCondition.
    fn window() -> CheckWindow {
        check_window("daily", "anomaly", "UTC", at("2026-11-18T10:00:00Z"))
    }

    fn points(target: f64, previous: Option<f64>, baseline: &[f64]) -> Vec<(String, f64)> {
        let w = window();
        let mut out = vec![(w.target.clone(), target)];
        if let Some(previous) = previous {
            out.push((w.previous.clone(), previous));
        }
        for (i, v) in baseline.iter().enumerate() {
            out.push((w.baseline[i].clone(), *v));
        }
        out
    }

    fn status(e: &Evaluation) -> &'static str {
        match e {
            Evaluation::Judged { firing: true, .. } => "firing",
            Evaluation::Judged { firing: false, .. } => "ok",
            Evaluation::Skipped { .. } => "skipped",
        }
    }

    #[test]
    fn threshold_above_and_below() {
        let above = json!({ "type": "threshold", "operator": "above", "value": 100 });
        assert_eq!(
            evaluate_condition(&above, &points(101.0, None, &[]), &window()),
            Evaluation::Judged {
                firing: true,
                value: 101.0,
                bound: Some(100.0)
            }
        );
        assert_eq!(
            status(&evaluate_condition(
                &above,
                &points(100.0, None, &[]),
                &window()
            )),
            "ok"
        );
        let below = json!({ "type": "threshold", "operator": "below", "value": 10 });
        assert_eq!(
            status(&evaluate_condition(
                &below,
                &points(3.0, None, &[]),
                &window()
            )),
            "firing"
        );
    }

    #[test]
    fn change_against_the_period_before() {
        let up = json!({ "type": "change", "direction": "increase", "percent": 20 });
        assert_eq!(
            evaluate_condition(&up, &points(120.0, Some(100.0), &[]), &window()),
            Evaluation::Judged {
                firing: true,
                value: 120.0,
                bound: Some(120.0)
            }
        );
        assert_eq!(
            status(&evaluate_condition(
                &up,
                &points(119.0, Some(100.0), &[]),
                &window()
            )),
            "ok"
        );
        let down = json!({ "type": "change", "direction": "decrease", "percent": 50 });
        assert_eq!(
            evaluate_condition(&down, &points(40.0, Some(100.0), &[]), &window()),
            Evaluation::Judged {
                firing: true,
                value: 40.0,
                bound: Some(50.0)
            }
        );
        let any = json!({ "type": "change", "direction": "any", "percent": 50 });
        assert_eq!(
            status(&evaluate_condition(
                &any,
                &points(40.0, Some(100.0), &[]),
                &window()
            )),
            "firing"
        );
        assert_eq!(
            status(&evaluate_condition(
                &any,
                &points(160.0, Some(100.0), &[]),
                &window()
            )),
            "firing"
        );
        assert_eq!(
            status(&evaluate_condition(
                &up,
                &points(5.0, Some(0.0), &[]),
                &window()
            )),
            "firing"
        );
        assert_eq!(
            status(&evaluate_condition(
                &up,
                &points(0.0, Some(0.0), &[]),
                &window()
            )),
            "ok"
        );
        assert_eq!(
            status(&evaluate_condition(&up, &points(5.0, None, &[]), &window())),
            "skipped"
        );
    }

    #[test]
    fn anomaly_outside_the_band_skipped_with_fewer_than_7_points() {
        let baseline = [
            100.0, 102.0, 98.0, 101.0, 99.0, 103.0, 97.0, 100.0, 100.0, 101.0,
        ];
        let medium = json!({ "type": "anomaly", "sensitivity": "medium" });
        assert_eq!(
            status(&evaluate_condition(
                &medium,
                &points(160.0, None, &baseline),
                &window()
            )),
            "firing"
        );
        assert_eq!(
            status(&evaluate_condition(
                &medium,
                &points(101.0, None, &baseline),
                &window()
            )),
            "ok"
        );
        assert_eq!(
            status(&evaluate_condition(
                &medium,
                &points(160.0, None, &baseline[..6]),
                &window()
            )),
            "skipped"
        );
    }

    #[test]
    fn skips_a_period_the_result_does_not_have() {
        let above = json!({ "type": "threshold", "operator": "above", "value": 1 });
        assert_eq!(
            status(&evaluate_condition(&above, &[], &window())),
            "skipped"
        );
    }

    #[test]
    fn series_points_prefer_the_line_without_a_breakdown() {
        let result = json!({ "kind": "trends", "result": { "series": [
            { "seriesIndex": 0, "breakdownValue": "nl", "points": [{ "bucket": "a", "value": 1 }] },
            { "seriesIndex": 0, "breakdownValue": null, "points": [{ "bucket": "a", "value": 5 }] }
        ] } });
        assert_eq!(series_points(&result, 0), Some(vec![("a".to_owned(), 5.0)]));
        assert_eq!(series_points(&json!({ "kind": "funnel" }), 0), None);
    }
}
