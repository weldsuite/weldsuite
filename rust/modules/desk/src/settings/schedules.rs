//! Scheduled report emails: `/api/helpdesk-analytics/schedules`
//! (`routes/helpdesk-analytics/schedules.ts`, TASK-1228).
//!
//! A schedule sends the overview (`reportId` null) or a saved report by email
//! every day, week or month, optionally with the numbers as a CSV. The sweep
//! ([`crate::report_sweep`]) sends them; this file is the CRUD and the "send
//! now" button, on `helpdesk_report_schedules`.
//!
//! Permissions: `settings:read` (list), `settings:create`, `settings:update`
//! (also send now), `settings:delete`. Every write marks the workspace in the
//! due index (kind `desk_report`) at the schedule's next run and publishes a
//! `helpdesk_report_schedule` event.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::PgPool;
use weldsuite_desk_domain::report_schedule::{
    DUE_KIND, Frequency, ReportTiming, is_time_zone, next_report_run,
};
use weldsuite_desk_domain::sla::instant;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::report_mail::{Mailer, SendOutcome, send_scheduled_report};
use super::reports::{self, iso_of, range_of};
use crate::table::js_date;
use crate::{Caller, DeskState, Refusal, validate};

/// `HELPDESK_REPORT_RANGES`.
const RANGES: [&str; 13] = [
    "today",
    "yesterday",
    "last_7_days",
    "last_14_days",
    "last_30_days",
    "last_90_days",
    "last_180_days",
    "last_365_days",
    "this_month",
    "this_quarter",
    "this_year",
    "last_year",
    "all_time",
];
const FREQUENCIES: [&str; 3] = ["daily", "weekly", "monthly"];
const LOCALES: [&str; 2] = ["en", "nl"];
/// `HELPDESK_REPORT_MAX_RECIPIENTS`.
const MAX_RECIPIENTS: usize = 20;

const REPORT_GONE_NOW: &str = "The saved report no longer exists.";

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("settings:read")))
        .route("/", post(create).route_layer(need("settings:create")))
        .route("/{id}", patch(update).route_layer(need("settings:update")))
        .route("/{id}", delete(remove).route_layer(need("settings:delete")))
        .route(
            "/{id}/send",
            post(send_now).route_layer(need("settings:update")),
        )
}

// ── the stored row ──────────────────────────────────────────────────────────

/// A `helpdesk_report_schedules` row (`ReportScheduleRow`).
#[derive(Debug, Clone)]
pub(crate) struct ScheduleRow {
    pub(crate) id: String,
    /// The row as `to_jsonb` returns it, for the API shape.
    raw: Value,
    pub(crate) name: String,
    pub(crate) report_id: Option<String>,
    pub(crate) range: String,
    pub(crate) frequency: String,
    pub(crate) day_of_week: Option<i64>,
    pub(crate) day_of_month: Option<i64>,
    pub(crate) hour: i64,
    pub(crate) timezone: String,
    pub(crate) attach_csv: bool,
    pub(crate) locale: String,
    pub(crate) enabled: bool,
    pub(crate) created_by_id: Option<String>,
    /// `next_run_at` as Postgres writes it, to the microsecond: what the
    /// sweep's claim compares.
    pub(crate) next_run_at: Option<String>,
}

impl ScheduleRow {
    /// A row selected as `to_jsonb(t)`.
    pub(crate) fn from_json(raw: Value) -> Self {
        let text = |key: &str| raw[key].as_str().map(str::to_owned);
        Self {
            id: text("id").unwrap_or_default(),
            name: text("name").unwrap_or_default(),
            report_id: text("report_id"),
            range: text("range").unwrap_or_default(),
            frequency: text("frequency").unwrap_or_default(),
            day_of_week: raw["day_of_week"].as_i64(),
            day_of_month: raw["day_of_month"].as_i64(),
            hour: raw["hour"].as_i64().unwrap_or_default(),
            timezone: text("timezone").unwrap_or_default(),
            attach_csv: raw["attach_csv"].as_bool().unwrap_or(false),
            locale: text("locale").unwrap_or_default(),
            enabled: raw["enabled"].as_bool().unwrap_or(false),
            created_by_id: text("created_by_id"),
            next_run_at: text("next_run_at"),
            raw,
        }
    }

    /// The addresses the report goes to.
    pub(crate) fn recipient_list(&self) -> Vec<String> {
        self.raw["recipients"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `timingOf(row)`; `None` for a frequency the worker does not know.
    pub(crate) fn timing(&self) -> Option<ReportTiming> {
        Some(ReportTiming {
            frequency: Frequency::parse(&self.frequency)?,
            day_of_week: self.day_of_week,
            day_of_month: self.day_of_month,
            hour: self.hour,
            timezone: self.timezone.clone(),
        })
    }

    /// `scheduleDto(row, reportTitle)`: the row as the API returns it.
    fn dto(&self, report_title: Option<&str>) -> Value {
        let stamp = |key: &str| {
            self.raw[key]
                .as_str()
                .map_or(Value::Null, |text| json!(js_date(text)))
        };
        json!({
            "id": self.id,
            "createdAt": stamp("created_at"),
            "updatedAt": stamp("updated_at"),
            "name": self.name,
            "reportId": self.report_id,
            "reportTitle": report_title,
            "range": range_of(Some(&self.range)),
            "frequency": self.frequency,
            "dayOfWeek": self.day_of_week,
            "dayOfMonth": self.day_of_month,
            "hour": self.hour,
            "timezone": self.timezone,
            "recipients": self.raw["recipients"],
            "attachCsv": self.attach_csv,
            "locale": if self.locale == "nl" { "nl" } else { "en" },
            "enabled": self.enabled,
            "createdById": self.created_by_id,
            "nextRunAt": stamp("next_run_at"),
            "lastRunAt": stamp("last_run_at"),
            "lastStatus": self.raw["last_status"],
            "lastError": self.raw["last_error"],
        })
    }
}

/// Whether a live (not deleted) saved report has this id.
async fn report_exists(db: &PgPool, report_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from helpdesk_analytics_reports where id = $1 and deleted_at is null limit 1",
    )
    .bind(report_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `reportTitles(db, reportIds)`: the titles of the saved reports the
/// schedules point at (deleted ones are absent).
async fn report_titles(
    db: &PgPool,
    rows: &[ScheduleRow],
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for id in rows.iter().filter_map(|row| row.report_id.as_deref()) {
        if !id.is_empty() && !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as(
        "select id, title from helpdesk_analytics_reports where id = any($1) and deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await
}

fn title_of<'a>(titles: &'a [(String, String)], row: &ScheduleRow) -> Option<&'a str> {
    let id = row.report_id.as_deref()?;
    titles
        .iter()
        .find(|(known, _)| known == id)
        .map(|(_, title)| title.as_str())
}

/// `dtoOf(db, row)`.
async fn dto_of(db: &PgPool, row: &ScheduleRow) -> Result<Value, sqlx::Error> {
    let titles = report_titles(db, std::slice::from_ref(row)).await?;
    Ok(row.dto(title_of(&titles, row)))
}

/// `findSchedule(db, id)`.
pub(crate) async fn find_schedule(
    db: &PgPool,
    id: &str,
) -> Result<Option<ScheduleRow>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_report_schedules t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(ScheduleRow::from_json))
}

/// `markDeskReportDue(c, nextRunAt)` (`lib/report-due.ts`): tell the report
/// sweep when the workspace's scheduled reports next come due, in the due
/// index (kind `desk_report`, keyed by `workspaces.id`). Best effort and
/// after the response; it can only pull the workspace's due time earlier.
fn mark_report_due(state: &DeskState, caller: &Caller, next_run_at: Option<i64>) {
    let Some(at) = next_run_at.and_then(instant) else {
        return;
    };
    let Some(master) = super::master(caller, state) else {
        return;
    };
    let workspace_id = caller.workspace_id.clone();
    state.events.tracker().spawn(async move {
        weldsuite_db::due_index::mark_due(&master, DUE_KIND, &workspace_id, at).await;
    });
}

// ── schemas ─────────────────────────────────────────────────────────────────

/// What `createHelpdeskReportScheduleSchema` / its `.partial()` let through.
#[derive(Debug, Default)]
struct ScheduleInput {
    name: Option<String>,
    /// Absent: not in the body; null: the overview.
    report_id: Field<String>,
    range: Option<String>,
    frequency: Option<String>,
    day_of_week: Field<i64>,
    day_of_month: Field<i64>,
    hour: Option<i64>,
    timezone: Option<String>,
    recipients: Option<Vec<String>>,
    attach_csv: Option<bool>,
    locale: Option<String>,
    enabled: Option<bool>,
}

/// Whether an issue makes Zod give up on the object (a wrong type, an
/// unknown enum value): the object-level refinement then does not run. A
/// failed check (`.min()`, `.int()`, a format) does not stop it.
fn aborts(issue: &Value) -> bool {
    match issue["code"].as_str() {
        Some("invalid_type") => issue["expected"] != "integer",
        Some("invalid_enum_value") => true,
        _ => false,
    }
}

/// `helpdeskReportScheduleFields` (`partial`: its `.partial()`, where the
/// body may leave any field out and the timing is checked by the route).
fn read_schedule(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> ScheduleInput {
    let from = issues.count();
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let day = |min: f64, max: f64| Number {
        int: true,
        min: Some(min),
        max: Some(max),
        ..Number::default()
    };
    let input = ScheduleInput {
        name: issues
            .text_with(body, "name", required, Text::trimmed(Some(1), Some(255)))
            .into_option(),
        report_id: issues.text(body, "reportId", Presence::Nullish, Some(1), Some(30)),
        range: issues
            .choice(body, "range", Presence::Optional, &RANGES)
            .into_option(),
        frequency: issues
            .choice(body, "frequency", required, &FREQUENCIES)
            .into_option(),
        day_of_week: issues.whole_number(body, "dayOfWeek", Presence::Nullish, day(0.0, 6.0)),
        day_of_month: issues.whole_number(body, "dayOfMonth", Presence::Nullish, day(1.0, 28.0)),
        hour: issues
            .whole_number(body, "hour", required, day(0.0, 23.0))
            .into_option(),
        timezone: issues
            .text(body, "timezone", required, Some(1), Some(64))
            .into_option(),
        // Trimmed and lower-cased, then deduplicated in the order given.
        recipients: issues
            .list(
                body,
                "recipients",
                required,
                Some(1),
                Some(MAX_RECIPIENTS),
                |issues, item| {
                    issues.item_text(
                        item,
                        Text {
                            trim: true,
                            lowercase: true,
                            format: Some(Format::Email),
                            min: None,
                            max: Some(254),
                        },
                    )
                },
            )
            .into_option()
            .map(|emails| {
                let mut unique: Vec<String> = Vec::with_capacity(emails.len());
                for email in emails {
                    if !unique.contains(&email) {
                        unique.push(email);
                    }
                }
                unique
            }),
        attach_csv: issues
            .boolean(body, "attachCsv", Presence::Optional)
            .into_option(),
        locale: issues
            .choice(body, "locale", Presence::Optional, &LOCALES)
            .into_option(),
        enabled: issues
            .boolean(body, "enabled", Presence::Optional)
            .into_option(),
    };
    // `.refine(isTimeZone, …)` runs on any string, also one that failed a
    // length check, and settles after the body's other checks.
    if let Some(Value::String(zone)) = body.get("timezone")
        && !is_time_zone(zone)
    {
        issues.custom("timezone", "Not a valid IANA time zone");
    }
    // The object's own refinement (`timingIsComplete`), on a create only:
    // weekly needs `dayOfWeek`, monthly needs `dayOfMonth`.
    if !partial && !issues.issues_since(from).iter().any(aborts) {
        let has = |key: &str| body.get(key).is_some_and(|value| !value.is_null());
        let complete = match body.get("frequency").and_then(Value::as_str) {
            Some("weekly") => has("dayOfWeek"),
            Some("monthly") => has("dayOfMonth"),
            _ => true,
        };
        if !complete {
            issues.custom_root(
                "dayOfWeek is required for a weekly schedule and dayOfMonth for a monthly one",
            );
        }
    }
    input
}

/// `normalizeTiming(timing)`: a schedule only keeps the day field its
/// frequency uses.
fn normalize(timing: ReportTiming) -> ReportTiming {
    ReportTiming {
        day_of_week: timing
            .day_of_week
            .filter(|_| timing.frequency == Frequency::Weekly),
        day_of_month: timing
            .day_of_month
            .filter(|_| timing.frequency == Frequency::Monthly),
        ..timing
    }
}

/// A day number as its `integer` column takes it.
fn day_column(day: Option<i64>) -> Option<i32> {
    day.and_then(|day| i32::try_from(day).ok())
}

// ── routes ──────────────────────────────────────────────────────────────────

/// `GET /`: newest first. The list is small (a team has a handful of
/// schedules), so it is not paginated.
async fn list(caller: Caller) -> Response {
    let listed = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from helpdesk_report_schedules t order by t.created_at desc, t.id desc",
        )
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<ScheduleRow> = rows.into_iter().map(ScheduleRow::from_json).collect();
        let titles = report_titles(&caller.db, &rows).await?;
        Ok::<_, sqlx::Error>(
            rows.iter()
                .map(|row| row.dto(title_of(&titles, row)))
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match listed {
        Ok(schedules) => Data(Value::Array(schedules)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch report schedules"),
    }
}

/// Why a write did not go through, besides the database.
enum WriteFailure {
    Refusal(Refusal),
    /// `nextReportRun` threw: the route's 500.
    Timing(String),
}

impl From<sqlx::Error> for WriteFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl WriteFailure {
    fn respond(self, message: &str) -> Response {
        match self {
            Self::Refusal(refusal) => refusal.respond(message),
            Self::Timing(error) => {
                tracing::error!(%error, "[desk-api/helpdesk-analytics] {message}");
                weldsuite_kit::ApiError::internal()
                    .with_message(message)
                    .into_response()
            }
        }
    }
}

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to create report schedule";
    let data = match validate(&headers, &body, |issues, fields| {
        read_schedule(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    match insert(&state, &caller, data).await {
        Ok(dto) => Created(dto).into_response(),
        Err(failure) => failure.respond(message),
    }
}

async fn insert(
    state: &DeskState,
    caller: &Caller,
    data: ScheduleInput,
) -> Result<Value, WriteFailure> {
    let db = &caller.db;
    let refused = |message: &str| WriteFailure::Refusal(Refusal::bad_request(message));
    let report_id = data.report_id.into_option().filter(|id| !id.is_empty());
    if let Some(report_id) = &report_id
        && !report_exists(db, report_id).await?
    {
        return Err(refused("The saved report does not exist"));
    }
    let now = reports::clock_ms(caller);
    // The schema requires these four; without them the validator answered.
    let (Some(frequency), Some(hour), Some(timezone)) = (
        data.frequency.as_deref().and_then(Frequency::parse),
        data.hour,
        data.timezone,
    ) else {
        return Err(WriteFailure::Timing("an incomplete schedule".to_owned()));
    };
    let timing = normalize(ReportTiming {
        frequency,
        day_of_week: data.day_of_week.into_option(),
        day_of_month: data.day_of_month.into_option(),
        hour,
        timezone,
    });
    let enabled = data.enabled.unwrap_or(true);
    let next_run_at = if enabled {
        Some(next_report_run(&timing, now).map_err(WriteFailure::Timing)?)
    } else {
        None
    };
    let created: Value = sqlx::query_scalar(
        "insert into helpdesk_report_schedules as t
           (id, created_at, updated_at, name, report_id, range, frequency, day_of_week, day_of_month,
            hour, timezone, recipients, attach_csv, locale, enabled, created_by_id, next_run_at)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16::timestamp)
         returning to_jsonb(t)",
    )
    .bind(generate_id("rsch"))
    .bind(iso_of(now))
    .bind(data.name.unwrap_or_default())
    .bind(&report_id)
    .bind(data.range.as_deref().unwrap_or("last_7_days"))
    .bind(timing.frequency.as_str())
    .bind(day_column(timing.day_of_week))
    .bind(day_column(timing.day_of_month))
    .bind(i32::try_from(timing.hour).unwrap_or_default())
    .bind(&timing.timezone)
    .bind(json!(data.recipients.unwrap_or_default()))
    .bind(data.attach_csv.unwrap_or(true))
    .bind(data.locale.as_deref().unwrap_or("en"))
    .bind(enabled)
    .bind(&caller.user_id)
    .bind(next_run_at.map(iso_of))
    .fetch_one(db)
    .await?;
    let created = ScheduleRow::from_json(created);
    let dto = dto_of(db, &created).await?;
    mark_report_due(state, caller, next_run_at);
    caller.publish(
        state,
        ev::HELPDESK_REPORT_SCHEDULE_CREATED,
        &created.id,
        &dto,
    );
    Ok(dto)
}

async fn update(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update report schedule";
    let data = match validate(&headers, &body, |issues, fields| {
        read_schedule(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    match apply(&state, &caller, &id, data).await {
        Ok(dto) => Data(dto).into_response(),
        Err(failure) => failure.respond(message),
    }
}

#[allow(clippy::too_many_lines)] // the route, step by step
async fn apply(
    state: &DeskState,
    caller: &Caller,
    id: &str,
    data: ScheduleInput,
) -> Result<Value, WriteFailure> {
    let db = &caller.db;
    let refused = |message: &str| WriteFailure::Refusal(Refusal::bad_request(message));
    let not_found = || WriteFailure::Refusal(Refusal::not_found("Report schedule", id));
    let existing = find_schedule(db, id).await?.ok_or_else(not_found)?;
    let stored = existing
        .timing()
        .ok_or_else(|| WriteFailure::Timing(format!("unknown frequency {}", existing.frequency)))?;

    // `mergedTiming(existing, data)`: the stored fields, replaced by those in the body.
    let timing = normalize(ReportTiming {
        frequency: data
            .frequency
            .as_deref()
            .and_then(Frequency::parse)
            .unwrap_or(stored.frequency),
        day_of_week: match data.day_of_week {
            Field::Absent => stored.day_of_week,
            Field::Null => None,
            Field::Set(day) => Some(day),
        },
        day_of_month: match data.day_of_month {
            Field::Absent => stored.day_of_month,
            Field::Null => None,
            Field::Set(day) => Some(day),
        },
        hour: data.hour.unwrap_or(stored.hour),
        timezone: data
            .timezone
            .clone()
            .unwrap_or_else(|| stored.timezone.clone()),
    });
    if timing.frequency == Frequency::Weekly && timing.day_of_week.is_none() {
        return Err(refused("dayOfWeek is required for a weekly schedule"));
    }
    if timing.frequency == Frequency::Monthly && timing.day_of_month.is_none() {
        return Err(refused("dayOfMonth is required for a monthly schedule"));
    }
    if let Field::Set(report_id) = &data.report_id
        && !report_id.is_empty()
        && !report_exists(db, report_id).await?
    {
        return Err(refused("The saved report does not exist"));
    }

    let now = reports::clock_ms(caller);
    let enabled = data.enabled.unwrap_or(existing.enabled);
    // Moves only when the timing changed or the schedule is switched on again.
    let retime = timing != stored
        || (enabled && !existing.enabled)
        || (enabled && existing.next_run_at.is_none());
    let moved = if enabled && retime {
        Some(next_report_run(&timing, now).map_err(WriteFailure::Timing)?)
    } else {
        None
    };
    // The next run as the statement takes it: none while disabled, the new
    // one, or the stored one as it is.
    let next_run_at = if enabled {
        moved.map(iso_of).or_else(|| existing.next_run_at.clone())
    } else {
        None
    };
    let report_id = match &data.report_id {
        Field::Set(report_id) => Some(report_id.as_str()),
        _ => None,
    };
    let updated: Option<Value> = sqlx::query_scalar(
        "update helpdesk_report_schedules as t set
           updated_at = $2::timestamp,
           name = case when $3::boolean then $4 else t.name end,
           report_id = case when $5::boolean then $6 else t.report_id end,
           range = case when $7::boolean then $8 else t.range end,
           frequency = $9, day_of_week = $10, day_of_month = $11, hour = $12, timezone = $13,
           recipients = case when $14::boolean then $15 else t.recipients end,
           attach_csv = case when $16::boolean then $17 else t.attach_csv end,
           locale = case when $18::boolean then $19 else t.locale end,
           enabled = $20,
           next_run_at = $21::timestamp
         where t.id = $1
         returning to_jsonb(t)",
    )
    .bind(id)
    .bind(iso_of(now))
    .bind(data.name.is_some())
    .bind(data.name.as_deref())
    .bind(!data.report_id.is_absent())
    .bind(report_id)
    .bind(data.range.is_some())
    .bind(data.range.as_deref())
    .bind(timing.frequency.as_str())
    .bind(day_column(timing.day_of_week))
    .bind(day_column(timing.day_of_month))
    .bind(i32::try_from(timing.hour).unwrap_or_default())
    .bind(&timing.timezone)
    .bind(data.recipients.is_some())
    .bind(json!(data.recipients.as_deref().unwrap_or_default()))
    .bind(data.attach_csv.is_some())
    .bind(data.attach_csv)
    .bind(data.locale.is_some())
    .bind(data.locale.as_deref())
    .bind(enabled)
    .bind(&next_run_at)
    .fetch_optional(db)
    .await?;
    let updated = updated.map(ScheduleRow::from_json).ok_or_else(not_found)?;
    let dto = dto_of(db, &updated).await?;
    // The run the due index should know about: a new one, or the one kept.
    let due = if enabled {
        moved.or_else(|| {
            dto["nextRunAt"]
                .as_str()
                .and_then(weldsuite_kit::validation::js_date_parse)
                .map(js_millis)
        })
    } else {
        None
    };
    mark_report_due(state, caller, due);
    caller.publish(state, ev::HELPDESK_REPORT_SCHEDULE_UPDATED, id, &dto);
    Ok(dto)
}

/// A JavaScript time value as whole milliseconds.
fn js_millis(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let millis = value as i64;
    millis
}

async fn remove(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = "Failed to delete report schedule";
    let deleted: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("delete from helpdesk_report_schedules where id = $1 returning id")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await;
    match deleted {
        Ok(Some(_)) => {
            caller.publish(
                &state,
                ev::HELPDESK_REPORT_SCHEDULE_DELETED,
                &id,
                &json!({ "id": id }),
            );
            NoContent.into_response()
        }
        Ok(None) => Refusal::not_found("Report schedule", &id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

/// `POST /:id/send`: send now, to the schedule's recipients, whatever its
/// timing. Records how it went (`lastRunAt`, `lastStatus`, `lastError`) and
/// leaves `nextRunAt` alone.
async fn send_now(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = "Failed to send the report";
    let sent = async {
        let Some(existing) = find_schedule(&caller.db, &id).await? else {
            return Ok(None);
        };
        let now = reports::clock_ms(&caller);
        let mailer = Mailer {
            db: caller.db.clone(),
            clerk_org_id: caller.clerk_org_id.clone(),
            outbound: caller.outbound(&state),
            environment: caller.env("ENVIRONMENT"),
            public_app_url: caller.env("PUBLIC_APP_URL"),
            from_override: caller.env("SYSTEM_EMAIL_FROM"),
        };
        let error = match send_scheduled_report(&mailer, &existing, now).await {
            SendOutcome::Sent => None,
            SendOutcome::Failed(error) => Some(error),
            SendOutcome::Gone => Some(REPORT_GONE_NOW.to_owned()),
        };
        let status = if error.is_some() { "failed" } else { "sent" };
        let updated = record_run(&caller.db, &id, now, status, error.as_deref()).await?;
        if let Some(updated) = updated {
            let dto = dto_of(&caller.db, &updated).await?;
            caller.publish(&state, ev::HELPDESK_REPORT_SCHEDULE_UPDATED, &id, &dto);
        }
        let mut result = Map::new();
        result.insert("status".to_owned(), json!(status));
        if let Some(error) = error {
            result.insert("error".to_owned(), json!(error));
        }
        Ok::<_, sqlx::Error>(Some(Value::Object(result)))
    }
    .await;
    match sent {
        Ok(Some(result)) => Data(result).into_response(),
        Ok(None) => Refusal::not_found("Report schedule", &id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

/// Store how a run went; the row afterwards, if it is still there.
pub(crate) async fn record_run(
    db: &PgPool,
    id: &str,
    now: i64,
    status: &str,
    error: Option<&str>,
) -> Result<Option<ScheduleRow>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update helpdesk_report_schedules as t
         set last_run_at = $2::timestamp, last_status = $3, last_error = $4
         where t.id = $1
         returning to_jsonb(t)",
    )
    .bind(id)
    .bind(iso_of(now))
    .bind(status)
    .bind(error)
    .fetch_optional(db)
    .await?;
    Ok(row.map(ScheduleRow::from_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No issues.
    const NONE: [Value; 0] = [];

    fn issues_of(body: &Value, partial: bool) -> Vec<Value> {
        let mut issues = Issues::default();
        let fields = body.as_object().expect("an object");
        read_schedule(&mut issues, fields, partial);
        match issues.finish() {
            Ok(()) => Vec::new(),
            Err(invalid) => invalid.issues().to_vec(),
        }
    }

    fn valid() -> Value {
        json!({
            "name": "Weekly team report",
            "frequency": "weekly",
            "dayOfWeek": 1,
            "hour": 9,
            "timezone": "Europe/Amsterdam",
            "recipients": ["Lead@Example.com", "lead@example.com", " ops@example.com "],
        })
    }

    fn with(patch: &Value) -> Value {
        let mut body = valid();
        for (key, value) in patch.as_object().expect("an object") {
            body[key] = value.clone();
        }
        body
    }

    fn without(key: &str) -> Value {
        let mut body = valid();
        body.as_object_mut().expect("an object").remove(key);
        body
    }

    #[test]
    fn a_valid_body_passes_and_recipients_come_out_clean() {
        let mut issues = Issues::default();
        let body = valid();
        let input = read_schedule(&mut issues, body.as_object().expect("an object"), false);
        assert!(issues.is_empty());
        assert_eq!(
            input.recipients,
            Some(vec![
                "lead@example.com".to_owned(),
                "ops@example.com".to_owned()
            ])
        );
        assert!(input.report_id.is_absent());
    }

    #[test]
    fn issues_are_zods() {
        // An unknown time zone is the field's refinement.
        assert_eq!(
            issues_of(&with(&json!({ "timezone": "Mars/Olympus" })), false),
            vec![
                json!({ "code": "custom", "message": "Not a valid IANA time zone", "path": ["timezone"] })
            ]
        );
        // A weekly schedule without its weekday is the object's.
        assert_eq!(
            issues_of(&without("dayOfWeek"), false),
            vec![json!({
                "code": "custom",
                "message": "dayOfWeek is required for a weekly schedule and dayOfMonth for a monthly one",
                "path": [],
            })]
        );
        assert_eq!(
            issues_of(&with(&json!({ "frequency": "monthly" })), false).len(),
            1
        );
        // A failed check does not stop the object's refinement; a wrong type does.
        let both = issues_of(&with(&json!({ "hour": 24, "dayOfWeek": null })), false);
        assert_eq!(both.len(), 2);
        assert_eq!(both[0]["code"], "too_big");
        assert_eq!(both[1]["path"], json!([]));
        let aborted = issues_of(&with(&json!({ "hour": "nine", "dayOfWeek": null })), false);
        assert_eq!(aborted.len(), 1);
        assert_eq!(aborted[0]["code"], "invalid_type");
        // An empty zone fails its length and the refinement, in that order.
        let empty = issues_of(&with(&json!({ "timezone": "" })), false);
        assert_eq!(empty.len(), 2);
        assert_eq!(empty[0]["code"], "too_small");
        assert_eq!(empty[1]["code"], "custom");
    }

    #[test]
    fn every_refused_body_of_the_route_test_is_refused() {
        for patch in [
            json!({ "name": "" }),
            json!({ "name": "x".repeat(256) }),
            json!({ "frequency": "hourly" }),
            json!({ "dayOfWeek": 7 }),
            json!({ "frequency": "monthly", "dayOfMonth": 29 }),
            json!({ "hour": 24 }),
            json!({ "recipients": [] }),
            json!({ "recipients": ["not-an-email"] }),
            json!({ "recipients": (0..21).map(|i| format!("r{i}@example.com")).collect::<Vec<_>>() }),
            json!({ "range": "forever" }),
            json!({ "locale": "fr" }),
        ] {
            assert!(!issues_of(&with(&patch), false).is_empty(), "{patch}");
        }
        let twenty: Vec<String> = (0..20).map(|i| format!("r{i}@example.com")).collect();
        assert_eq!(
            issues_of(&with(&json!({ "recipients": twenty })), false),
            NONE
        );
    }

    #[test]
    fn a_patch_takes_any_subset() {
        assert_eq!(issues_of(&json!({}), true), NONE);
        assert_eq!(issues_of(&json!({ "name": "Renamed" }), true), NONE);
        assert_eq!(issues_of(&json!({ "frequency": "monthly" }), true), NONE);
        assert_eq!(issues_of(&json!({ "reportId": null }), true), NONE);
        assert_eq!(issues_of(&json!({ "hour": 99 }), true).len(), 1);
        assert_eq!(issues_of(&json!({ "recipients": [] }), true).len(), 1);
        assert_eq!(
            issues_of(&json!({ "timezone": "Nowhere/Land" }), true).len(),
            1
        );
    }

    #[test]
    fn timings_keep_only_their_own_day() {
        let timing = |frequency| ReportTiming {
            frequency,
            day_of_week: Some(3),
            day_of_month: Some(28),
            hour: 7,
            timezone: "UTC".to_owned(),
        };
        let monthly = normalize(timing(Frequency::Monthly));
        assert_eq!(
            (monthly.day_of_week, monthly.day_of_month),
            (None, Some(28))
        );
        let weekly = normalize(timing(Frequency::Weekly));
        assert_eq!((weekly.day_of_week, weekly.day_of_month), (Some(3), None));
        let daily = normalize(timing(Frequency::Daily));
        assert_eq!((daily.day_of_week, daily.day_of_month), (None, None));
    }

    #[test]
    fn rows_answer_as_the_api_does() {
        let row = ScheduleRow::from_json(json!({
            "id": "rsch_1",
            "created_at": "2026-03-15T12:00:00",
            "updated_at": "2026-03-15T12:00:00.5",
            "name": "Weekly",
            "report_id": null,
            "range": "forever",
            "frequency": "weekly",
            "day_of_week": 1,
            "day_of_month": null,
            "hour": 9,
            "timezone": "Europe/Amsterdam",
            "recipients": ["lead@example.com"],
            "attach_csv": true,
            "locale": "fr",
            "enabled": true,
            "created_by_id": "user_1",
            "next_run_at": "2026-03-16T08:00:00",
            "last_run_at": null,
            "last_status": null,
            "last_error": null,
        }));
        let dto = row.dto(None);
        assert_eq!(dto["createdAt"], "2026-03-15T12:00:00.000Z");
        assert_eq!(dto["updatedAt"], "2026-03-15T12:00:00.500Z");
        assert_eq!(dto["nextRunAt"], "2026-03-16T08:00:00.000Z");
        assert_eq!(dto["lastRunAt"], Value::Null);
        // A range or language the report does not know reads as the default.
        assert_eq!(dto["range"], "last_30_days");
        assert_eq!(dto["locale"], "en");
        assert_eq!(dto["reportTitle"], Value::Null);
        assert_eq!(row.recipient_list(), ["lead@example.com"]);
        assert_eq!(
            row.timing().map(|timing| timing.frequency),
            Some(Frequency::Weekly)
        );
    }
}
