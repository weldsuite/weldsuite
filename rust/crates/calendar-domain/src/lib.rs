//! `@weldsuite/db/lib/calendar-sync`: tasks on the calendar. A task gets a
//! timed event in a free slot of its assignee's working hours, a
//! higher-priority task may bump a lower-priority auto-scheduled one (up to
//! five deep), and the nightly re-plan moves auto-scheduled events whose
//! start slipped into the past while their task is still open.
//!
//! Shared by WeldCalendar (unpin, the re-plan cron), WeldFlow (task writes)
//! and WeldConnect (the create-task action); one Rust function per exported
//! TypeScript one, named after it.
//!
//! The TypeScript scheduler works in the runtime's local time (`setHours`,
//! `getDay`), which is UTC on Cloudflare Workers: days, working hours and
//! breaks here are UTC too. Times are JavaScript time values (milliseconds,
//! `f64`) so an unparseable working-hours string behaves as an Invalid Date
//! does: the window it touches yields no slot.

pub mod js_dates;
mod time_math;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;

use sea_orm::sea_query::{Expr, NullOrdering, Order, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationDef, Set,
};
use serde_json::Value;
use sqlx::PgPool;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{orm, utc_now};
use weldsuite_schema::tenant::{
    calendar_events, calendars, meetings, tasks, user_preferences, workspace_members,
};

use time_math::{
    DAY_MS, end_of_day, from_db, instant, iso_of, js_number, same_day, set_hours, start_of_day,
    weekday,
};
pub use time_math::{iso, now_ms};

/// The due index kind of the nightly re-plan (`calendar_replan`).
pub const REPLAN_KIND: &str = "calendar_replan";

const DEFAULT_DURATION_MINUTES: f64 = 30.0;
const MAX_SEARCH_DAYS_NO_DEADLINE: f64 = 60.0;
const MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED: f64 = 90.0;
const SLOT_STEP_MS: f64 = 15.0 * 60_000.0;
const MAX_CASCADE_DEPTH: u32 = 5;
const MINUTE_MS: f64 = 60_000.0;

const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/// A failure the TypeScript code throws: a database error, or a value it
/// can't work with (a working-hours time that isn't a string, an Invalid
/// Date bound to a query).
#[derive(Debug)]
pub enum SyncError {
    Database(DbErr),
    Invalid(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

pub type SyncResult<T> = Result<T, SyncError>;

/// A time bound to a query (`toISOString()`, then `::timestamp`: UTC to the
/// millisecond; an Invalid Date throws).
fn bind_time(ms: f64) -> SyncResult<PrimitiveDateTime> {
    if ms.is_finite() {
        #[allow(clippy::cast_possible_truncation)]
        Ok(weldsuite_db::utc_timestamp(instant(ms as i64)))
    } else {
        Err(SyncError::Invalid(
            "RangeError: Invalid time value".to_owned(),
        ))
    }
}

// ── Priorities ──────────────────────────────────────────────────────────────

/// `priorityWeight`: unknown priorities weigh as `medium`.
fn priority_weight(priority: Option<&str>) -> i32 {
    match priority.unwrap_or("medium") {
        "critical" | "urgent" => 4,
        "high" => 3,
        "low" => 1,
        "none" => 0,
        _ => 2,
    }
}

/// `taskPriorityToCalendarPriority`.
fn calendar_priority(priority: Option<&str>) -> &'static str {
    match priority {
        Some("critical") => "urgent",
        Some("high") => "high",
        Some("low" | "none") => "low",
        _ => "normal",
    }
}

/// `DEFAULT_WORKING_HOURS`: weekdays 09:00–17:00.
fn default_working_hours() -> Value {
    let open = serde_json::json!({ "isOpen": true, "openTime": "09:00", "closeTime": "17:00" });
    let closed = serde_json::json!({ "isOpen": false });
    serde_json::json!({
        "monday": open, "tuesday": open, "wednesday": open, "thursday": open, "friday": open,
        "saturday": closed, "sunday": closed,
    })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// ── Default calendar ────────────────────────────────────────────────────────

/// The user's default calendar id, created when missing
/// (`ensureDefaultCalendar`).
pub async fn ensure_default_calendar(db: &PgPool, user_id: &str) -> SyncResult<String> {
    use calendars::Column;
    let db = orm(db);
    let existing: Option<String> = calendars::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::OwnerId.eq(user_id))
        .filter(Column::IsDefault.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = weldsuite_kit::generate_id("cal");
    let now = utc_now();
    calendars::Entity::insert(calendars::ActiveModel {
        id: Set(id.clone()),
        name: Set("My Calendar".to_owned()),
        owner_id: Set(user_id.to_owned()),
        is_default: Set(Some(true)),
        is_active: Set(Some(true)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(id)
}

// ── Scheduling context ──────────────────────────────────────────────────────

/// The user's zone and working hours (`getUserSchedulingContext`).
#[derive(Debug, Clone)]
pub struct SchedulingContext {
    pub timezone: String,
    pub working_hours: Value,
}

async fn scheduling_context(db: &PgPool, user_id: &str) -> SyncResult<SchedulingContext> {
    use user_preferences::Column;
    let prefs: Option<(Option<String>, Option<Value>)> = user_preferences::Entity::find()
        .select_only()
        .columns([Column::Timezone, Column::WorkingHours])
        .filter(Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (timezone, working_hours) = prefs.unwrap_or((None, None));
    Ok(SchedulingContext {
        timezone: timezone
            .filter(|zone| !zone.is_empty())
            .unwrap_or_else(|| "UTC".to_owned()),
        working_hours: working_hours
            .filter(truthy)
            .unwrap_or_else(default_working_hours),
    })
}

// ── Per-app auto-scheduling switch ──────────────────────────────────────────

/// The app whose switch decides whether a task is auto-scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSchedulingApp {
    Flow,
    Crm,
}

impl TaskSchedulingApp {
    /// `TASK_AUTO_SCHEDULE_PREFERENCE[app]`.
    pub fn preference(self) -> &'static str {
        match self {
            Self::Flow => "autoScheduleFlowTasks",
            Self::Crm => "autoScheduleCrmTasks",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Flow => "flow",
            Self::Crm => "crm",
        }
    }
}

const LEGACY_PREFERENCE: &str = "autoScheduleTasks";

/// A task's CRM links: customer, contact, counterparty, person.
type CrmLinks = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn task_scheduling_app(db: &PgPool, task_id: Option<&str>) -> SyncResult<TaskSchedulingApp> {
    use tasks::Column;
    let Some(task_id) = task_id.filter(|id| !id.is_empty()) else {
        return Ok(TaskSchedulingApp::Flow);
    };
    let links: Option<CrmLinks> = tasks::Entity::find()
        .select_only()
        .columns([
            Column::CustomerId,
            Column::ContactId,
            Column::CounterpartyId,
            Column::PersonId,
        ])
        .filter(Column::Id.eq(task_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    // `customer_id is not null or contact_id is not null or …`.
    let crm = links.map(|(customer, contact, counterparty, person)| {
        customer.is_some() || contact.is_some() || counterparty.is_some() || person.is_some()
    });
    Ok(if crm == Some(true) {
        TaskSchedulingApp::Crm
    } else {
        TaskSchedulingApp::Flow
    })
}

/// Whether the user lets the scheduler place this task: the switch of the
/// task's app, else the legacy shared one; absent is on
/// (`isTaskAutoScheduleEnabled`).
pub async fn is_task_auto_schedule_enabled(
    db: &PgPool,
    user_id: &str,
    task_id: Option<&str>,
) -> SyncResult<bool> {
    use user_preferences::Column;
    let prefs: Option<Option<Value>> = user_preferences::Entity::find()
        .select_only()
        .column(Column::UiPreferences)
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let app = task_scheduling_app(db, task_id).await?;
    let ui = prefs.flatten().unwrap_or(Value::Null);
    let own = ui.get(app.preference()).filter(|v| !v.is_null());
    let value = own.or_else(|| ui.get(LEGACY_PREFERENCE).filter(|v| !v.is_null()));
    Ok(value != Some(&Value::Bool(false)))
}

// ── Free slots ──────────────────────────────────────────────────────────────

/// Which way a slot search walks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchDirection {
    Forward,
    Backward,
    /// Forward for medium priority and up, backward for low.
    Auto,
}

/// `FindSlotParams`.
#[derive(Debug, Clone)]
pub struct FindSlot<'a> {
    pub user_id: &'a str,
    pub deadline: f64,
    pub duration_minutes: f64,
    pub timezone: &'a str,
    pub working_hours: &'a Value,
    pub priority: Option<&'a str>,
    pub exclude_event_ids: Vec<String>,
    pub direction: SearchDirection,
    pub earliest_start: Option<f64>,
}

/// A free slot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimeSlot {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone)]
struct ExistingEvent {
    id: String,
    start: f64,
    end: Option<f64>,
}

impl ExistingEvent {
    /// Events without an end last 30 minutes (`eventEndTime`).
    fn end_time(&self) -> f64 {
        self.end.unwrap_or(self.start + 30.0 * MINUTE_MS)
    }
}

/// `parseTime`: `HH:MM` split on `:` and read with `Number()`.
fn parse_time(value: &Value) -> SyncResult<(f64, f64)> {
    let Value::String(text) = value else {
        return Err(SyncError::Invalid(
            "TypeError: timeStr.split is not a function".to_owned(),
        ));
    };
    let mut parts = text.split(':');
    let hours = parts.next().map_or(0.0, js_number);
    let minutes = parts.next().map_or(0.0, js_number);
    Ok((hours, minutes))
}

/// `roundUpTo15Min`: the next quarter hour, seconds dropped.
fn round_up_to_15(at: f64) -> f64 {
    let minute_start = at - at.rem_euclid(MINUTE_MS);
    let minutes = (minute_start / MINUTE_MS).rem_euclid(60.0);
    let remainder = minutes % 15.0;
    if remainder == 0.0 {
        minute_start
    } else {
        minute_start + (15.0 - remainder) * MINUTE_MS
    }
}

#[derive(Debug, Clone, Copy)]
struct SlotWindow {
    start: f64,
    end: f64,
}

/// `subtractBreaks`: the working window minus the breaks of `day`.
fn subtract_breaks(window: SlotWindow, breaks: &[Value], day: f64) -> SyncResult<Vec<SlotWindow>> {
    let mut windows = vec![window];
    for brk in breaks {
        let (start_h, start_m) = parse_time(&brk["start"])?;
        let (end_h, end_m) = parse_time(&brk["end"])?;
        let brk_start = set_hours(day, start_h, start_m);
        let brk_end = set_hours(day, end_h, end_m);
        let mut next = Vec::new();
        for w in windows {
            if brk_end <= w.start || brk_start >= w.end {
                next.push(w);
            } else {
                if brk_start > w.start {
                    next.push(SlotWindow {
                        start: w.start,
                        end: brk_start,
                    });
                }
                if brk_end < w.end {
                    next.push(SlotWindow {
                        start: brk_end,
                        end: w.end,
                    });
                }
            }
        }
        windows = next;
    }
    Ok(windows)
}

struct SearchContext<'a> {
    now: f64,
    deadline: f64,
    duration_ms: f64,
    working_hours: &'a Value,
    existing: Vec<ExistingEvent>,
    exclude: &'a [String],
}

/// `getWindowsForDay`, clipped to now and the deadline.
fn windows_for_day(day: f64, ctx: &SearchContext<'_>) -> SyncResult<Vec<SlotWindow>> {
    let Some(name) = weekday(day).map(|d| DAY_NAMES[d]) else {
        return Ok(Vec::new());
    };
    let hours = &ctx.working_hours[name];
    if !truthy(&hours["isOpen"]) || !truthy(&hours["openTime"]) || !truthy(&hours["closeTime"]) {
        return Ok(Vec::new());
    }
    let (open_h, open_m) = parse_time(&hours["openTime"])?;
    let (close_h, close_m) = parse_time(&hours["closeTime"])?;
    let window = SlotWindow {
        start: set_hours(day, open_h, open_m),
        end: set_hours(day, close_h, close_m),
    };
    let breaks = &hours["breaks"];
    let mut windows = match breaks {
        Value::Array(list) if !list.is_empty() => subtract_breaks(window, list, day)?,
        // `for (const brk of 'text')` walks characters that have no times.
        Value::String(text) if !text.is_empty() => {
            return Err(SyncError::Invalid(
                "TypeError: breaks are not a list of ranges".to_owned(),
            ));
        }
        _ => vec![window],
    };
    if same_day(day, ctx.now) {
        let earliest = round_up_to_15(ctx.now);
        windows = windows
            .into_iter()
            .map(|w| SlotWindow {
                start: if w.start < earliest {
                    earliest
                } else {
                    w.start
                },
                end: w.end,
            })
            .filter(|w| w.start < w.end)
            .collect();
    }
    if same_day(day, ctx.deadline) {
        windows = windows
            .into_iter()
            .map(|w| SlotWindow {
                start: w.start,
                end: if w.end > ctx.deadline {
                    ctx.deadline
                } else {
                    w.end
                },
            })
            .filter(|w| w.start < w.end)
            .collect();
    }
    Ok(windows)
}

/// `getEventsForDay`: events that start or end on `day`.
fn events_for_day<'a>(day: f64, ctx: &'a SearchContext<'_>) -> Vec<&'a ExistingEvent> {
    ctx.existing
        .iter()
        .filter(|e| !ctx.exclude.contains(&e.id))
        .filter(|e| same_day(e.start, day) || same_day(e.end_time(), day))
        .collect()
}

fn has_conflict(start: f64, end: f64, events: &[&ExistingEvent]) -> bool {
    events.iter().any(|e| start < e.end_time() && end > e.start)
}

fn latest_slot(
    windows: &[SlotWindow],
    events: &[&ExistingEvent],
    duration: f64,
) -> Option<TimeSlot> {
    for window in windows.iter().rev() {
        let mut start = window.end - duration;
        while start >= window.start {
            let end = start + duration;
            if !has_conflict(start, end, events) {
                return Some(TimeSlot { start, end });
            }
            start -= SLOT_STEP_MS;
        }
    }
    None
}

fn earliest_slot(
    windows: &[SlotWindow],
    events: &[&ExistingEvent],
    duration: f64,
) -> Option<TimeSlot> {
    for window in windows {
        let mut start = window.start;
        while start + duration <= window.end {
            let end = start + duration;
            if !has_conflict(start, end, events) {
                return Some(TimeSlot { start, end });
            }
            start += SLOT_STEP_MS;
        }
    }
    None
}

/// The user's busy blocks between two times: their confirmed events and the
/// WeldMeet meetings they organise or attend, the meetings as `high`
/// priority (`loadBusyBlocks`).
async fn busy_blocks(
    db: &PgPool,
    user_id: &str,
    day_start: f64,
    day_end: f64,
) -> SyncResult<Vec<ExistingEvent>> {
    let from = bind_time(day_start)?;
    let to = bind_time(day_end)?;
    let db = orm(db);
    let member: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Id)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&db)
        .await?;
    let events: Vec<(String, PrimitiveDateTime, Option<PrimitiveDateTime>)> = {
        use calendar_events::Column;
        calendar_events::Entity::find()
            .select_only()
            .columns([Column::Id, Column::StartTime, Column::EndTime])
            .filter(Column::DeletedAt.is_null())
            .filter(Column::OrganizerId.eq(user_id))
            .filter(Column::Status.eq("confirmed"))
            .filter(Column::StartTime.gte(from))
            .filter(Column::StartTime.lte(to))
            .into_tuple()
            .all(&db)
            .await?
    };
    let meetings: Vec<(String, Option<PrimitiveDateTime>, Option<PrimitiveDateTime>)> = {
        use meetings::Column;
        // `organizer_id = $1 or attendees @> [{ workspaceMemberId }]`.
        let mut mine = Condition::any().add(Column::OrganizerId.eq(user_id));
        if let Some(member) = &member {
            mine = mine.add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
                Expr::col((meetings::Entity, Column::Attendees)),
                Expr::val(serde_json::json!([{ "workspaceMemberId": member }])),
            ));
        }
        meetings::Entity::find()
            .select_only()
            .columns([Column::Id, Column::ScheduledStart, Column::ScheduledEnd])
            .filter(
                Condition::all()
                    .add(Column::DeletedAt.is_null())
                    .add(Column::Status.is_not_in(["cancelled", "completed", "failed"]))
                    .add(Column::ScheduledStart.gte(from))
                    .add(Column::ScheduledStart.lte(to))
                    .add(mine),
            )
            .into_tuple()
            .all(&db)
            .await?
    };
    let mut out: Vec<ExistingEvent> = events
        .into_iter()
        .map(|(id, start, end)| ExistingEvent {
            id,
            start: from_db(start),
            end: end.map(from_db),
        })
        .collect();
    out.extend(meetings.into_iter().filter_map(|(id, start, end)| {
        Some(ExistingEvent {
            id,
            start: from_db(start?),
            end: end.map(from_db),
        })
    }));
    Ok(out)
}

/// The earliest (or latest, walking back from the deadline) free slot of
/// `duration_minutes` in the user's working hours before the deadline
/// (`findFreeSlot`).
pub async fn find_free_slot(db: &PgPool, params: &FindSlot<'_>) -> SyncResult<Option<TimeSlot>> {
    let duration_ms = params.duration_minutes * MINUTE_MS;
    let weight = priority_weight(params.priority);
    let now = params.earliest_start.unwrap_or_else(now_ms);
    if params.deadline <= now {
        return Ok(None);
    }
    let existing = busy_blocks(
        db,
        params.user_id,
        start_of_day(now),
        end_of_day(params.deadline),
    )
    .await?;
    let ctx = SearchContext {
        now,
        deadline: params.deadline,
        duration_ms,
        working_hours: params.working_hours,
        existing,
        exclude: &params.exclude_event_ids,
    };
    let backward = match params.direction {
        SearchDirection::Forward => false,
        SearchDirection::Backward => true,
        SearchDirection::Auto => weight <= 1,
    };
    if backward {
        let mut day = start_of_day(params.deadline);
        let first = start_of_day(now);
        while day >= first {
            let windows = windows_for_day(day, &ctx)?;
            if let Some(slot) = latest_slot(&windows, &events_for_day(day, &ctx), ctx.duration_ms) {
                return Ok(Some(slot));
            }
            day -= DAY_MS;
        }
    } else {
        let mut day = start_of_day(now);
        while day <= params.deadline {
            let windows = windows_for_day(day, &ctx)?;
            if let Some(slot) = earliest_slot(&windows, &events_for_day(day, &ctx), ctx.duration_ms)
            {
                return Ok(Some(slot));
            }
            day += DAY_MS;
        }
    }
    Ok(None)
}

/// An auto-scheduled event as the bump search reads it.
type BumpRow = (
    String,
    PrimitiveDateTime,
    Option<PrimitiveDateTime>,
    Option<String>,
    Option<String>,
    String,
);

// ── Cascading bumps ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct BumpCandidate {
    event_id: String,
    source_id: Option<String>,
    start: f64,
    end: f64,
    priority: Option<String>,
    organizer_id: String,
}

/// The lowest-priority auto-scheduled event of the user's that is long
/// enough to give up its slot (`findBumpableEvent`).
async fn find_bumpable_event(
    db: &PgPool,
    user_id: &str,
    deadline: f64,
    incoming_weight: i32,
    duration_minutes: f64,
    visited: &HashSet<String>,
) -> SyncResult<Option<BumpCandidate>> {
    let duration_ms = duration_minutes * MINUTE_MS;
    let start = now_ms();
    let from = bind_time(start_of_day(start))?;
    let to = bind_time(end_of_day(deadline))?;
    let rows: Vec<BumpRow> = {
        use calendar_events::Column;
        calendar_events::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::StartTime,
                Column::EndTime,
                Column::Priority,
                Column::SourceId,
                Column::OrganizerId,
            ])
            .filter(Column::DeletedAt.is_null())
            .filter(Column::OrganizerId.eq(user_id))
            .filter(Column::Status.eq("confirmed"))
            .filter(Column::AutoScheduled.eq(true))
            .filter(Column::StartTime.gte(from))
            .filter(Column::StartTime.lte(to))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let mut candidates: Vec<(i32, BumpCandidate)> = rows
        .into_iter()
        .map(|(id, start, end, priority, source_id, organizer_id)| {
            let start = from_db(start);
            let end = end.map_or(start + 30.0 * MINUTE_MS, from_db);
            (
                priority_weight(priority.as_deref()),
                BumpCandidate {
                    event_id: id,
                    source_id,
                    start,
                    end,
                    priority,
                    organizer_id,
                },
            )
        })
        .filter(|(weight, c)| {
            !visited.contains(&c.event_id)
                && *weight < incoming_weight
                && c.end - c.start >= duration_ms
        })
        .collect();
    // Stable, like `Array#sort`: weight, then start.
    candidates.sort_by(|(wa, a), (wb, b)| {
        wa.cmp(wb).then(
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    Ok(candidates.into_iter().next().map(|(_, c)| c))
}

/// Due date and duration of the task behind an event (`loadSourceTaskSchedule`).
async fn source_task_schedule(
    db: &PgPool,
    source_id: Option<&str>,
) -> SyncResult<(Option<f64>, Option<f64>)> {
    let Some(source_id) = source_id.filter(|id| !id.is_empty()) else {
        return Ok((None, None));
    };
    let row: Option<(Option<PrimitiveDateTime>, Option<i32>)> = tasks::Entity::find()
        .select_only()
        .columns([tasks::Column::DueDate, tasks::Column::Duration])
        .filter(tasks::Column::Id.eq(source_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map_or((None, None), |(due, duration)| {
        (due.map(from_db), duration.map(f64::from))
    }))
}

async fn place_event(
    db: &PgPool,
    event_id: &str,
    start: f64,
    end: Option<f64>,
    all_day: bool,
) -> SyncResult<()> {
    use calendar_events::Column;
    let start = bind_time(start)?;
    let end = end.map(bind_time).transpose()?;
    calendar_events::Entity::update_many()
        .col_expr(Column::StartTime, Expr::value(start))
        .col_expr(Column::EndTime, Expr::value(end))
        .col_expr(Column::AllDay, Expr::value(all_day))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(event_id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

type BoxedSync<'a> = Pin<Box<dyn Future<Output = SyncResult<()>> + Send + 'a>>;

/// Move a bumped event to a new slot, bumping an even lower one when there
/// is none, depth-limited and cycle-protected (`rescheduleBumpedEvent`).
fn reschedule_bumped_event<'a>(
    db: &'a PgPool,
    candidate: BumpCandidate,
    ctx: &'a SchedulingContext,
    visited: HashSet<String>,
    depth: u32,
) -> BoxedSync<'a> {
    Box::pin(async move {
        let (due, task_duration) = source_task_schedule(db, candidate.source_id.as_deref()).await?;
        let duration = task_duration.unwrap_or_else(|| {
            DEFAULT_DURATION_MINUTES
                .max(((candidate.end - candidate.start) / MINUTE_MS + 0.5).floor())
        });
        let now = now_ms();
        let cap = now + MAX_SEARCH_DAYS_NO_DEADLINE * DAY_MS;
        let cap_extended = now + MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED * DAY_MS;
        let primary = due.unwrap_or(cap);
        let mut exclude = vec![candidate.event_id.clone()];
        exclude.extend(visited.iter().cloned());
        let mut slot = find_free_slot(
            db,
            &FindSlot {
                user_id: &candidate.organizer_id,
                deadline: primary,
                duration_minutes: duration,
                timezone: &ctx.timezone,
                working_hours: &ctx.working_hours,
                priority: candidate.priority.as_deref(),
                exclude_event_ids: exclude.clone(),
                direction: if due.is_some() {
                    SearchDirection::Auto
                } else {
                    SearchDirection::Forward
                },
                earliest_start: None,
            },
        )
        .await?;
        if slot.is_none() && due.is_none() {
            slot = find_free_slot(
                db,
                &FindSlot {
                    user_id: &candidate.organizer_id,
                    deadline: cap_extended,
                    duration_minutes: duration,
                    timezone: &ctx.timezone,
                    working_hours: &ctx.working_hours,
                    priority: candidate.priority.as_deref(),
                    exclude_event_ids: exclude,
                    direction: SearchDirection::Forward,
                    earliest_start: None,
                },
            )
            .await?;
        }
        if let Some(slot) = slot {
            return place_event(db, &candidate.event_id, slot.start, Some(slot.end), false).await;
        }
        let weight = priority_weight(candidate.priority.as_deref());
        if depth < MAX_CASCADE_DEPTH && weight > 0 {
            let sub = find_bumpable_event(
                db,
                &candidate.organizer_id,
                primary,
                weight,
                duration,
                &visited,
            )
            .await?;
            if let Some(sub) = sub {
                let start = sub.start;
                place_event(
                    db,
                    &candidate.event_id,
                    start,
                    Some(start + duration * MINUTE_MS),
                    false,
                )
                .await?;
                let mut next = visited.clone();
                next.insert(candidate.event_id.clone());
                return reschedule_bumped_event(db, sub, ctx, next, depth + 1).await;
            }
        }
        // Last resort: all day on the deadline, or at the far edge of the window.
        let fallback = start_of_day(due.unwrap_or(cap));
        place_event(db, &candidate.event_id, fallback, None, true).await?;
        if due.is_none() {
            tracing::warn!(
                event_id = candidate.event_id,
                "[calendar-sync] No slot found within 90 days for bumped event"
            );
        }
        Ok(())
    })
}

// ── Task events ─────────────────────────────────────────────────────────────

/// `CreateEventParams`.
#[derive(Debug, Clone, Default)]
pub struct TaskEvent {
    pub user_id: String,
    /// The source entity (`sourceId ?? taskId`).
    pub source_id: Option<String>,
    /// Defaults to `task`.
    pub source_type: Option<String>,
    pub title: String,
    pub description: Option<String>,
    /// Placed forward from now within 60 days when absent.
    pub due_date: Option<f64>,
    /// Pinned to this start (no auto-placement) when set.
    pub start_date: Option<f64>,
    pub duration_minutes: Option<f64>,
    pub priority: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn insert_task_event(
    db: &PgPool,
    id: &str,
    calendar_id: &str,
    params: &TaskEvent,
    start: f64,
    end: Option<f64>,
    all_day: bool,
    auto_scheduled: bool,
    now: f64,
) -> SyncResult<()> {
    let created = bind_time(now)?;
    let start = bind_time(start)?;
    let end = end.map(bind_time).transpose()?;
    calendar_events::Entity::insert(calendar_events::ActiveModel {
        id: Set(id.to_owned()),
        calendar_id: Set(calendar_id.to_owned()),
        title: Set(params.title.clone()),
        description: Set(params
            .description
            .clone()
            .filter(|description| !description.is_empty())),
        type_: Set("reminder".to_owned()),
        start_time: Set(start),
        end_time: Set(end),
        all_day: Set(Some(all_day)),
        status: Set("confirmed".to_owned()),
        priority: Set(Some(
            calendar_priority(params.priority.as_deref()).to_owned(),
        )),
        organizer_id: Set(params.user_id.clone()),
        source_type: Set(Some(
            params.source_type.as_deref().unwrap_or("task").to_owned(),
        )),
        source_id: Set(params.source_id.clone()),
        auto_scheduled: Set(Some(auto_scheduled)),
        created_at: Set(created),
        updated_at: Set(created),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

/// The new event's id, or `None` when nothing was placed: the user turned
/// task auto-scheduling off and the task has no start date
/// (`createCalendarEventForTask`).
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub async fn create_calendar_event_for_task(
    db: &PgPool,
    params: &TaskEvent,
) -> SyncResult<Option<String>> {
    let calendar_id = ensure_default_calendar(db, &params.user_id).await?;
    let id = weldsuite_kit::generate_id("evt");
    let now = now_ms();
    let duration = params
        .duration_minutes
        .filter(|d| *d != 0.0 && !d.is_nan())
        .unwrap_or(DEFAULT_DURATION_MINUTES);
    let weight = priority_weight(params.priority.as_deref());
    let source_type = params.source_type.as_deref().unwrap_or("task");

    if let Some(start) = params.start_date {
        let end = match params.due_date {
            Some(due) if due > start => due,
            _ => start + duration * MINUTE_MS,
        };
        insert_task_event(
            db,
            &id,
            &calendar_id,
            params,
            start,
            Some(end),
            false,
            false,
            now,
        )
        .await?;
        return Ok(Some(id));
    }

    let honours_opt_out = source_type == "task";
    if honours_opt_out
        && !is_task_auto_schedule_enabled(db, &params.user_id, params.source_id.as_deref()).await?
    {
        return Ok(None);
    }

    let ctx = scheduling_context(db, &params.user_id).await?;
    let has_due = params.due_date.is_some();
    let (mut deadline, direction) = initial_window(params.due_date, now);
    let priority = params.priority.as_deref().filter(|p| !p.is_empty());
    let find = |deadline: f64, direction: SearchDirection| FindSlot {
        user_id: &params.user_id,
        deadline,
        duration_minutes: duration,
        timezone: &ctx.timezone,
        working_hours: &ctx.working_hours,
        priority,
        exclude_event_ids: Vec::new(),
        direction,
        earliest_start: None,
    };
    let mut slot = find_free_slot(db, &find(deadline, direction)).await?;
    if slot.is_none() && !has_due {
        deadline = now + MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED * DAY_MS;
        slot = find_free_slot(db, &find(deadline, SearchDirection::Forward)).await?;
    }
    if let Some(slot) = slot {
        insert_task_event(
            db,
            &id,
            &calendar_id,
            params,
            slot.start,
            Some(slot.end),
            false,
            true,
            now,
        )
        .await?;
        return placed(db, params, honours_opt_out, id).await;
    }

    if weight >= 2 {
        let candidate = find_bumpable_event(
            db,
            &params.user_id,
            deadline,
            weight,
            duration,
            &HashSet::new(),
        )
        .await?;
        if let Some(candidate) = candidate {
            let start = candidate.start;
            insert_task_event(
                db,
                &id,
                &calendar_id,
                params,
                start,
                Some(start + duration * MINUTE_MS),
                false,
                true,
                now,
            )
            .await?;
            let visited: HashSet<String> = std::iter::once(id.clone()).collect();
            reschedule_bumped_event(db, candidate, &ctx, visited, 1).await?;
            return placed(db, params, honours_opt_out, id).await;
        }
    }

    let base = if has_due {
        deadline
    } else {
        now + MAX_SEARCH_DAYS_NO_DEADLINE * DAY_MS
    };
    insert_task_event(
        db,
        &id,
        &calendar_id,
        params,
        start_of_day(base),
        None,
        true,
        !has_due,
        now,
    )
    .await?;
    if !has_due {
        tracing::warn!(
            event_id = id,
            "[calendar-sync] No slot found within 90 days for new no-dueDate event"
        );
    }
    placed(db, params, honours_opt_out, id).await
}

/// `keepUnlessTaskAutoScheduleOff` for tasks: a placement that raced the
/// switch being turned off removes its event again.
async fn placed(
    db: &PgPool,
    params: &TaskEvent,
    honours_opt_out: bool,
    id: String,
) -> SyncResult<Option<String>> {
    if !honours_opt_out
        || is_task_auto_schedule_enabled(db, &params.user_id, params.source_id.as_deref()).await?
    {
        return Ok(Some(id));
    }
    delete_calendar_event(db, &id).await?;
    Ok(None)
}

/// Where the first search looks (`initialSchedulingWindow`).
fn initial_window(due: Option<f64>, now: f64) -> (f64, SearchDirection) {
    match due {
        None => (
            now + MAX_SEARCH_DAYS_NO_DEADLINE * DAY_MS,
            SearchDirection::Forward,
        ),
        Some(due) if due <= now && now - due < DAY_MS => (end_of_day(now), SearchDirection::Auto),
        Some(due) => (due, SearchDirection::Auto),
    }
}

/// `UpdateEventParams`: `None` leaves a field alone, `Some(None)` is a null.
#[derive(Debug, Clone, Default)]
pub struct EventUpdate {
    pub calendar_event_id: String,
    pub title: Option<String>,
    /// Time values (milliseconds), as everywhere in this crate.
    pub due_date: Option<Option<f64>>,
    pub start_date: Option<Option<f64>>,
}

/// `updateCalendarEventForTask`: the title, and the times the task's dates
/// imply.
pub async fn update_calendar_event_for_task(db: &PgPool, params: &EventUpdate) -> SyncResult<()> {
    use calendar_events::Column;
    let mut start: Option<Option<f64>> = None;
    let mut end: Option<Option<f64>> = None;
    match (params.due_date, params.start_date) {
        (Some(due), Some(Some(start_date))) => {
            start = Some(Some(start_date));
            end = Some(due);
        }
        (Some(Some(due)), _) => start = Some(Some(due)),
        (Some(None), _) | (None, None) => {}
        (None, Some(start_date)) => start = Some(start_date),
    }
    let start_at = start.flatten().map(bind_time).transpose()?;
    let end_at = end.flatten().map(bind_time).transpose()?;
    let mut update = calendar_events::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
    if let Some(title) = &params.title {
        update = update.col_expr(Column::Title, Expr::value(title.clone()));
    }
    if start.is_some() {
        update = update.col_expr(Column::StartTime, Expr::value(start_at));
    }
    if end.is_some() {
        update = update.col_expr(Column::EndTime, Expr::value(end_at));
    }
    update
        .filter(Column::Id.eq(&params.calendar_event_id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `RescheduleParams`.
#[derive(Debug, Clone, Default)]
pub struct Reschedule {
    pub calendar_event_id: String,
    pub event: TaskEvent,
}

/// Re-place a task's event after its priority or dates changed: a pinned
/// event keeps its time (title, description and length follow); an
/// auto-scheduled one is replaced (`rescheduleCalendarEvent`). The id the
/// task should point at, or `None`.
pub async fn reschedule_calendar_event(
    db: &PgPool,
    params: &Reschedule,
) -> SyncResult<Option<String>> {
    use calendar_events::Column;
    let existing: Option<(Option<bool>, PrimitiveDateTime)> = calendar_events::Entity::find()
        .select_only()
        .columns([Column::AutoScheduled, Column::StartTime])
        .filter(Column::Id.eq(&params.calendar_event_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if let Some((Some(false), start)) = existing {
        let start = from_db(start);
        let end = match params.event.duration_minutes.filter(|d| *d != 0.0) {
            Some(duration) => Some(bind_time(start + duration * MINUTE_MS)?),
            None => None,
        };
        let mut update = calendar_events::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .col_expr(Column::Title, Expr::value(params.event.title.clone()))
            .col_expr(
                Column::Description,
                Expr::value(params.event.description.clone()),
            );
        if let Some(end) = end {
            update = update.col_expr(Column::EndTime, Expr::value(end));
        }
        update
            .filter(Column::Id.eq(&params.calendar_event_id))
            .exec(&orm(db))
            .await?;
        return Ok(Some(params.calendar_event_id.clone()));
    }
    delete_calendar_event(db, &params.calendar_event_id).await?;
    create_calendar_event_for_task(db, &params.event).await
}

async fn set_status(db: &PgPool, calendar_event_id: &str, status: &str) -> Result<(), DbErr> {
    use calendar_events::Column;
    calendar_events::Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(calendar_event_id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The task was completed (`cancelCalendarEvent`).
pub async fn cancel_calendar_event(db: &PgPool, calendar_event_id: &str) -> Result<(), DbErr> {
    set_status(db, calendar_event_id, "cancelled").await
}

/// The task was reopened (`confirmCalendarEvent`).
pub async fn confirm_calendar_event(db: &PgPool, calendar_event_id: &str) -> Result<(), DbErr> {
    set_status(db, calendar_event_id, "confirmed").await
}

/// The task was deleted (`deleteCalendarEvent`).
pub async fn delete_calendar_event(db: &PgPool, calendar_event_id: &str) -> Result<(), DbErr> {
    use calendar_events::Column;
    let now = utc_now();
    calendar_events::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(calendar_event_id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// Soft-delete every auto-scheduled task event the user organises (of one
/// app's tasks when given) and unlink it from its task, in one statement
/// (`removeAutoScheduledTaskEvents`). How many were removed.
#[allow(
    clippy::disallowed_methods,
    reason = "a data-modifying CTE: soft-deletes the events and unlinks their tasks in one statement, as the TypeScript does"
)]
pub async fn remove_auto_scheduled_task_events(
    db: &PgPool,
    user_id: &str,
    app: Option<TaskSchedulingApp>,
) -> Result<i64, DbErr> {
    let now = weldsuite_events::iso_timestamp(OffsetDateTime::now_utc());
    let removed: Option<i32> = sqlx::query_scalar(
        "with removed as (
             update calendar_events
             set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where organizer_id = $1
               and source_type = 'task'
               and auto_scheduled = true
               and deleted_at is null
               and ($3::text is null
                    or ($3 = 'crm' and exists (
                         select 1 from tasks
                         where tasks.id = calendar_events.source_id
                           and (tasks.customer_id is not null or tasks.contact_id is not null
                                or tasks.counterparty_id is not null or tasks.person_id is not null)))
                    or ($3 = 'flow' and not exists (
                         select 1 from tasks
                         where tasks.id = calendar_events.source_id
                           and (tasks.customer_id is not null or tasks.contact_id is not null
                                or tasks.counterparty_id is not null or tasks.person_id is not null))))
             returning id
         ), unlinked as (
             update tasks set calendar_event_id = null
             where calendar_event_id in (select id from removed)
         )
         select count(*)::int as removed from removed",
    )
    .bind(user_id)
    .bind(&now)
    .bind(app.map(TaskSchedulingApp::as_str))
    .fetch_optional(db)
    .await
    .map_err(weldsuite_db::orm_error)?;
    Ok(i64::from(removed.unwrap_or(0)))
}

// ── Nightly re-plan ─────────────────────────────────────────────────────────

/// `inner join tasks on calendar_events.source_id = tasks.id`.
fn source_task() -> RelationDef {
    calendar_events::Entity::belongs_to(tasks::Entity)
        .from(calendar_events::Column::SourceId)
        .to(tasks::Column::Id)
        .into()
}

/// `crmLinkedTask()`: the task hangs off a CRM record.
fn crm_linked_task() -> Condition {
    Condition::any()
        .add(tasks::Column::CustomerId.is_not_null())
        .add(tasks::Column::ContactId.is_not_null())
        .add(tasks::Column::CounterpartyId.is_not_null())
        .add(tasks::Column::PersonId.is_not_null())
}

/// `replannableEventConditions` (with `tasks` joined on the event's source):
/// a live, confirmed, auto-scheduled event of an open task whose organizer
/// has not turned re-planning, or the switch of the task's app, off.
fn replannable_event_conditions() -> Condition {
    use sea_orm::ExprTrait as _;
    use user_preferences::{Column as Prefs, Entity as UserPreferences};
    let pref = |key: &str| {
        sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
            Expr::col((UserPreferences, Prefs::UiPreferences)),
            key.to_owned(),
        )
    };
    // `coalesce(ui_preferences->>'<app switch>', ui_preferences->>'autoScheduleTasks') = 'false'`.
    let switched_off = |app: TaskSchedulingApp| {
        Expr::from(sea_orm::sea_query::Func::coalesce([
            pref(app.preference()),
            pref(LEGACY_PREFERENCE),
        ]))
        .eq("false")
    };
    let opted_out = Query::select()
        .expr(Expr::val(1))
        .from(UserPreferences)
        .cond_where(
            Condition::all()
                .add(
                    Expr::col((UserPreferences, Prefs::UserId)).equals((
                        calendar_events::Entity,
                        calendar_events::Column::OrganizerId,
                    )),
                )
                .add(Prefs::DeletedAt.is_null())
                .add(
                    Condition::any()
                        .add(pref("autoRescheduleTasks").eq("false"))
                        .add(
                            Condition::all()
                                .add(switched_off(TaskSchedulingApp::Crm))
                                .add(crm_linked_task()),
                        )
                        .add(
                            Condition::all()
                                .add(switched_off(TaskSchedulingApp::Flow))
                                .add(crm_linked_task().not()),
                        ),
                ),
        )
        .to_owned();
    Condition::all()
        .add(calendar_events::Column::DeletedAt.is_null())
        .add(calendar_events::Column::AutoScheduled.eq(true))
        .add(calendar_events::Column::Status.eq("confirmed"))
        .add(tasks::Column::DeletedAt.is_null())
        .add(tasks::Column::Status.is_not_in(["done", "cancelled"]))
        .add(Expr::not_exists(opted_out))
}

/// When the workspace's next auto-scheduled task event needs re-planning
/// (its start; in the past when one is stale), or `None`
/// (`nextAutoScheduledReplanAt`).
pub async fn next_auto_scheduled_replan_at(db: &PgPool) -> Result<Option<OffsetDateTime>, DbErr> {
    let next: Option<Option<PrimitiveDateTime>> = calendar_events::Entity::find()
        .select_only()
        .column_as(calendar_events::Column::StartTime.min(), "next")
        .join(JoinType::InnerJoin, source_task())
        .filter(replannable_event_conditions())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(next.flatten().map(from_db).and_then(|ms| {
        #[allow(clippy::cast_possible_truncation)]
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms as i64) * 1_000_000).ok()
    }))
}

/// What one re-plan pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReplanStats {
    pub scanned: usize,
    pub rescheduled: usize,
    pub failed: usize,
}

/// A stale event and its open task, as the re-plan reads them.
#[derive(Debug, FromQueryResult)]
struct StaleRow {
    event_id: String,
    organizer_id: String,
    task_id: String,
    title: Option<String>,
    description: Option<String>,
    due_date: Option<PrimitiveDateTime>,
    start_date: Option<PrimitiveDateTime>,
    duration: Option<i32>,
    priority: Option<String>,
    created_at: Option<PrimitiveDateTime>,
}

/// `case priority when 'critical' then 4 … else 0 end`, the re-plan's
/// order.
fn priority_rank() -> Expr {
    use tasks::Column;
    Expr::case(Column::Priority.eq("critical"), 4)
        .case(Column::Priority.eq("urgent"), 4)
        .case(Column::Priority.eq("high"), 3)
        .case(Column::Priority.eq("medium"), 2)
        .case(Column::Priority.eq("normal"), 2)
        .case(Column::Priority.eq("low"), 1)
        .finally(0)
        .into()
}

/// Re-plan the auto-scheduled task events whose start passed while the task
/// is still open, highest priority first (`replanStaleAutoScheduledEvents`).
/// A negative `batch_limit` reads none.
pub async fn replan_stale_auto_scheduled_events(
    db: &PgPool,
    batch_limit: i64,
) -> SyncResult<ReplanStats> {
    let stale: Vec<StaleRow> = calendar_events::Entity::find()
        .select_only()
        .column_as(calendar_events::Column::Id, "event_id")
        .column_as(calendar_events::Column::OrganizerId, "organizer_id")
        .column_as(tasks::Column::Id, "task_id")
        .column_as(tasks::Column::Title, "title")
        .column_as(tasks::Column::Description, "description")
        .column_as(tasks::Column::DueDate, "due_date")
        .column_as(tasks::Column::StartDate, "start_date")
        .column_as(tasks::Column::Duration, "duration")
        .column_as(tasks::Column::Priority, "priority")
        .column_as(tasks::Column::CreatedAt, "created_at")
        .join(JoinType::InnerJoin, source_task())
        .filter(
            replannable_event_conditions()
                .add(calendar_events::Column::StartTime.lte(utc_now())),
        )
        .order_by(priority_rank(), Order::Desc)
        .order_by_with_nulls(tasks::Column::DueDate, Order::Asc, NullOrdering::Last)
        .order_by_asc(tasks::Column::CreatedAt)
        .limit(u64::try_from(batch_limit).unwrap_or(0))
        .into_model()
        .all(&orm(db))
        .await?;
    let mut result = ReplanStats {
        scanned: stale.len(),
        ..ReplanStats::default()
    };
    let mut ordered = stale;
    ordered.sort_by(|a, b| {
        let weight =
            priority_weight(b.priority.as_deref()).cmp(&priority_weight(a.priority.as_deref()));
        let due = |row: &StaleRow| row.due_date.map_or(f64::INFINITY, from_db);
        let created = |row: &StaleRow| row.created_at.map_or(f64::NAN, from_db);
        weight
            .then_with(|| {
                due(a)
                    .partial_cmp(&due(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                created(a)
                    .partial_cmp(&created(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    for row in ordered {
        let StaleRow {
            event_id,
            organizer_id,
            task_id,
            title,
            description,
            due_date,
            start_date,
            duration,
            priority,
            created_at: _,
        } = row;
        let description = description.filter(|d| !d.is_empty());
        let params = Reschedule {
            calendar_event_id: event_id.clone(),
            event: TaskEvent {
                user_id: organizer_id,
                source_id: Some(task_id.clone()),
                source_type: None,
                title: title.unwrap_or_default(),
                description,
                due_date: due_date.map(from_db),
                start_date: start_date.map(from_db),
                duration_minutes: duration.map(f64::from),
                priority,
            },
        };
        let outcome = async {
            let new_id = reschedule_calendar_event(db, &params).await?;
            tasks::Entity::update_many()
                .col_expr(tasks::Column::CalendarEventId, Expr::value(new_id))
                .filter(tasks::Column::Id.eq(&task_id))
                .exec(&orm(db))
                .await?;
            Ok::<_, SyncError>(())
        }
        .await;
        match outcome {
            Ok(()) => result.rescheduled += 1,
            Err(error) => {
                result.failed += 1;
                tracing::error!(%error, event_id, "[calendar-sync] replan failed for event");
            }
        }
    }
    Ok(result)
}

/// A task event as `fetchTaskScheduledSlots` reads it.
type SlotRow = (
    String,
    Option<String>,
    PrimitiveDateTime,
    Option<PrimitiveDateTime>,
    Option<bool>,
    String,
);

/// A task's scheduled slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledSlot {
    pub event_id: String,
    /// ISO timestamps.
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub auto_scheduled: bool,
}

/// The current slot of each task (`fetchTaskScheduledSlots`), cancelled
/// events left out.
pub async fn fetch_task_scheduled_slots(
    db: &PgPool,
    task_ids: &[String],
) -> Result<HashMap<String, ScheduledSlot>, DbErr> {
    let mut map = HashMap::new();
    if task_ids.is_empty() {
        return Ok(map);
    }
    let rows: Vec<SlotRow> = {
        use calendar_events::Column;
        calendar_events::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::SourceId,
                Column::StartTime,
                Column::EndTime,
                Column::AutoScheduled,
                Column::Status,
            ])
            .filter(Column::SourceType.eq("task"))
            .filter(Column::SourceId.is_in(task_ids))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    for (id, source_id, start, end, auto_scheduled, status) in rows {
        if status == "cancelled" {
            continue;
        }
        let Some(source_id) = source_id.filter(|s| !s.is_empty()) else {
            continue;
        };
        map.insert(
            source_id,
            ScheduledSlot {
                event_id: id,
                start_time: Some(iso_of(start)),
                end_time: end.map(iso_of),
                auto_scheduled: auto_scheduled.unwrap_or(false),
            },
        );
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarter_hours_round_up() {
        let at = 1_700_000_000_000.0; // 22:13:20 UTC
        let rounded = round_up_to_15(at);
        assert_eq!(rounded.rem_euclid(15.0 * MINUTE_MS), 0.0);
        assert!(rounded >= at && rounded - at < 15.0 * MINUTE_MS);
        let exact = 1_699_999_200_000.0; // 22:00 UTC
        assert_eq!(round_up_to_15(exact + 5_000.0), exact);
    }

    #[test]
    fn weights_and_priorities_match_the_scheduler() {
        assert_eq!(priority_weight(None), 2);
        assert_eq!(priority_weight(Some("whatever")), 2);
        assert_eq!(priority_weight(Some("none")), 0);
        assert_eq!(calendar_priority(Some("critical")), "urgent");
        assert_eq!(calendar_priority(Some("none")), "low");
        assert_eq!(calendar_priority(None), "normal");
    }

    #[test]
    fn breaks_split_the_working_window() {
        let day = 1_699_920_000_000.0; // a UTC midnight
        let window = SlotWindow {
            start: set_hours(day, 9.0, 0.0),
            end: set_hours(day, 17.0, 0.0),
        };
        let breaks = vec![serde_json::json!({ "start": "12:00", "end": "13:00" })];
        let windows = subtract_breaks(window, &breaks, day).expect("splits");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].end, set_hours(day, 12.0, 0.0));
        assert_eq!(windows[1].start, set_hours(day, 13.0, 0.0));
    }
}
