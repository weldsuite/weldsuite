//! Tasks on the calendar (`@weldsuite/db/lib/calendar-sync` as flow-api's
//! task routes call it): a task's calendar block is placed on create,
//! re-placed when its dates or priority change, cancelled when it is done
//! and confirmed again when it reopens; the list shows each task's slot.
//!
//! [`TaskCalendar`] is the port. The scheduler (free-slot search, bumps)
//! is `weldsuite-calendar-domain`'s, which implements it; until that crate
//! is wired, [`PinnedOnly`] does what needs no scheduler: a block pinned
//! to an explicit start, status changes, and the slot lookup. A task
//! without a start date then gets no block.

// The handlers follow the TypeScript route bodies one to one (long
// functions, `data`/`date`-style names from the original), and the list
// queries bind tuples of optional columns.
#![allow(
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::type_complexity,
    clippy::struct_excessive_bools,
    clippy::ref_option,
    clippy::cast_sign_loss
)]

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

/// A boxed future the port's methods answer with.
pub type CalendarFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// `CreateEventParams` for a task.
#[derive(Debug, Clone, Default)]
pub struct TaskEvent {
    pub user_id: String,
    pub task_id: String,
    pub title: String,
    pub description: Option<String>,
    /// Epoch milliseconds.
    pub due_date: Option<i64>,
    pub start_date: Option<i64>,
    pub duration_minutes: Option<f64>,
    pub priority: Option<String>,
}

/// A task's current slot (`fetchTaskScheduledSlots`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledSlot {
    pub event_id: String,
    /// ISO timestamps.
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub auto_scheduled: bool,
}

/// The calendar operations the task routes use.
pub trait TaskCalendar: Send + Sync {
    /// `createCalendarEventForTask`: the new event's id, or `None` when
    /// nothing was placed.
    fn create_for_task<'a>(
        &'a self,
        db: &'a PgPool,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>>;

    /// `rescheduleCalendarEvent`: the id the task should point at.
    fn reschedule<'a>(
        &'a self,
        db: &'a PgPool,
        calendar_event_id: &'a str,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>>;

    /// `cancelCalendarEvent`.
    fn cancel<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()>;

    /// `confirmCalendarEvent`.
    fn confirm<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()>;

    /// `fetchTaskScheduledSlots`.
    fn scheduled_slots<'a>(
        &'a self,
        db: &'a PgPool,
        task_ids: &'a [String],
    ) -> CalendarFuture<'a, HashMap<String, ScheduledSlot>>;

    /// `nextAutoScheduledReplanAt`: when the workspace's next auto-placed
    /// block needs re-planning.
    fn next_replan_at<'a>(&'a self, db: &'a PgPool) -> CalendarFuture<'a, Option<OffsetDateTime>>;
}

/// The due index kind of the calendar's nightly re-plan.
pub const REPLAN_KIND: &str = "calendar_replan";

fn now_iso() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

fn iso(millis: i64) -> Result<String, String> {
    weldsuite_flow_domain::js::iso_from_millis(millis)
        .ok_or_else(|| "Invalid time value".to_owned())
}

fn calendar_priority(priority: Option<&str>) -> &'static str {
    match priority {
        Some("critical") => "urgent",
        Some("high") => "high",
        Some("low" | "none") => "low",
        _ => "normal",
    }
}

/// The scheduler-free half of the calendar sync (see the module docs).
#[derive(Debug, Clone, Copy, Default)]
pub struct PinnedOnly;

impl PinnedOnly {
    /// `ensureDefaultCalendar`.
    async fn default_calendar(db: &PgPool, user_id: &str) -> Result<String, sqlx::Error> {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from calendars
             where owner_id = $1 and is_default = true and deleted_at is null limit 1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = generate_id("cal");
        let now = now_iso();
        sqlx::query(
            "insert into calendars (id, name, owner_id, is_default, is_active, created_at, updated_at)
             values ($1, 'My Calendar', $2, true, true, $3::timestamp, $3::timestamp)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(&now)
        .execute(db)
        .await?;
        Ok(id)
    }

    async fn create(db: &PgPool, event: &TaskEvent) -> Result<Option<String>, String> {
        let calendar_id = Self::default_calendar(db, &event.user_id)
            .await
            .map_err(|e| e.to_string())?;
        let Some(start) = event.start_date else {
            tracing::warn!(
                task = event.task_id,
                "flow: auto-placing a task's calendar block needs weldsuite-calendar-domain"
            );
            return Ok(None);
        };
        let duration = event
            .duration_minutes
            .filter(|d| *d != 0.0 && !d.is_nan())
            .unwrap_or(30.0);
        #[allow(clippy::cast_possible_truncation)]
        let end = match event.due_date {
            Some(due) if due > start => due,
            _ => start + (duration * 60_000.0) as i64,
        };
        let id = generate_id("evt");
        let now = now_iso();
        sqlx::query(
            "insert into calendar_events
                 (id, calendar_id, title, description, type, start_time, end_time, all_day, status,
                  priority, organizer_id, source_type, source_id, auto_scheduled, created_at, updated_at)
             values ($1, $2, $3, $4, 'reminder', $5::timestamp, $6::timestamp, false, 'confirmed',
                     $7, $8, 'task', $9, false, $10::timestamp, $10::timestamp)",
        )
        .bind(&id)
        .bind(&calendar_id)
        .bind(&event.title)
        .bind(event.description.as_deref().filter(|d| !d.is_empty()))
        .bind(iso(start)?)
        .bind(iso(end)?)
        .bind(calendar_priority(event.priority.as_deref()))
        .bind(&event.user_id)
        .bind(&event.task_id)
        .bind(&now)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(Some(id))
    }

    async fn set_status(db: &PgPool, id: &str, status: &str) -> Result<(), String> {
        sqlx::query(
            "update calendar_events set status = $2, updated_at = $3::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(status)
        .bind(now_iso())
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

impl TaskCalendar for PinnedOnly {
    fn create_for_task<'a>(
        &'a self,
        db: &'a PgPool,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(Self::create(db, event))
    }

    fn reschedule<'a>(
        &'a self,
        db: &'a PgPool,
        calendar_event_id: &'a str,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(async move {
            let existing: Option<(Option<bool>, Option<String>)> = sqlx::query_as(
                "select auto_scheduled, to_jsonb(start_time) #>> '{}' from calendar_events
                 where id = $1 and deleted_at is null limit 1",
            )
            .bind(calendar_event_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
            if let Some((Some(false), start)) = existing {
                let start = start
                    .as_deref()
                    .and_then(weldsuite_db::js_timestamp)
                    .and_then(|start| weldsuite_flow_domain::js::millis_of(&start));
                #[allow(clippy::cast_possible_truncation)]
                let end = match (event.duration_minutes.filter(|d| *d != 0.0), start) {
                    (Some(duration), Some(start)) => {
                        Some(iso(start + (duration * 60_000.0) as i64)?)
                    }
                    _ => None,
                };
                sqlx::query(
                    "update calendar_events set updated_at = $2::timestamp, title = $3, description = $4,
                         end_time = case when $5 then $6::timestamp else end_time end
                     where id = $1",
                )
                .bind(calendar_event_id)
                .bind(now_iso())
                .bind(&event.title)
                .bind(&event.description)
                .bind(end.is_some())
                .bind(&end)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
                return Ok(Some(calendar_event_id.to_owned()));
            }
            let now = now_iso();
            sqlx::query(
                "update calendar_events set deleted_at = $2::timestamp, updated_at = $2::timestamp
                 where id = $1 and deleted_at is null",
            )
            .bind(calendar_event_id)
            .bind(&now)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
            Self::create(db, event).await
        })
    }

    fn cancel<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(Self::set_status(db, calendar_event_id, "cancelled"))
    }

    fn confirm<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(Self::set_status(db, calendar_event_id, "confirmed"))
    }

    fn scheduled_slots<'a>(
        &'a self,
        db: &'a PgPool,
        task_ids: &'a [String],
    ) -> CalendarFuture<'a, HashMap<String, ScheduledSlot>> {
        Box::pin(async move {
            let mut map = HashMap::new();
            if task_ids.is_empty() {
                return Ok(map);
            }
            type SlotRow = (
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<bool>,
                Option<String>,
            );
            let rows: Vec<SlotRow> = sqlx::query_as(
                "select id, source_id, to_jsonb(start_time) #>> '{}', to_jsonb(end_time) #>> '{}',
                        auto_scheduled, status
                 from calendar_events
                 where source_type = 'task' and source_id = any($1) and deleted_at is null",
            )
            .bind(task_ids)
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
            for (id, source_id, start, end, auto_scheduled, status) in rows {
                if status.as_deref() == Some("cancelled") {
                    continue;
                }
                let Some(source_id) = source_id.filter(|s| !s.is_empty()) else {
                    continue;
                };
                map.insert(
                    source_id,
                    ScheduledSlot {
                        event_id: id,
                        start_time: start.as_deref().and_then(weldsuite_db::js_timestamp),
                        end_time: end.as_deref().and_then(weldsuite_db::js_timestamp),
                        auto_scheduled: auto_scheduled.unwrap_or(false),
                    },
                );
            }
            Ok(map)
        })
    }

    fn next_replan_at<'a>(&'a self, db: &'a PgPool) -> CalendarFuture<'a, Option<OffsetDateTime>> {
        Box::pin(async move {
            let next: Option<String> = sqlx::query_scalar(
                "select to_jsonb(min(e.start_time)) #>> '{}' from calendar_events e
                 inner join tasks t on e.source_id = t.id
                 where e.deleted_at is null and e.auto_scheduled = true and e.status = 'confirmed'
                   and t.deleted_at is null and t.status not in ('done', 'cancelled')
                   and not exists (
                     select 1 from user_preferences p
                     where p.user_id = e.organizer_id and p.deleted_at is null
                       and (p.ui_preferences->>'autoRescheduleTasks' = 'false'
                            or (coalesce(p.ui_preferences->>'autoScheduleCrmTasks', p.ui_preferences->>'autoScheduleTasks') = 'false'
                                and (t.customer_id is not null or t.contact_id is not null
                                     or t.counterparty_id is not null or t.person_id is not null))
                            or (coalesce(p.ui_preferences->>'autoScheduleFlowTasks', p.ui_preferences->>'autoScheduleTasks') = 'false'
                                and not (t.customer_id is not null or t.contact_id is not null
                                         or t.counterparty_id is not null or t.person_id is not null))))",
            )
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(next
                .as_deref()
                .and_then(weldsuite_db::js_timestamp)
                .and_then(|at| weldsuite_flow_domain::js::millis_of(&at))
                .and_then(|ms| {
                    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()
                }))
        })
    }
}
