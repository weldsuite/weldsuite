//! Tasks on the calendar (`@weldsuite/db/lib/calendar-sync` as flow-api's
//! task routes call it): a task's calendar block is placed on create,
//! re-placed when its dates or priority change, cancelled when it is done
//! and confirmed again when it reopens; the list shows each task's slot.
//!
//! [`TaskCalendar`] is the port; [`CalendarSync`] implements it with
//! `weldsuite-calendar-domain`, the scheduler (free-slot search in the
//! assignee's working hours, bumps of lower-priority blocks) WeldCalendar
//! and WeldConnect share.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_calendar_domain as sync;

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
pub const REPLAN_KIND: &str = sync::REPLAN_KIND;

/// The calendar sync of `@weldsuite/db/lib/calendar-sync`, on
/// `weldsuite-calendar-domain`.
#[derive(Debug, Clone, Copy, Default)]
pub struct CalendarSync;

/// A time value as the scheduler takes it.
#[allow(clippy::cast_precision_loss)]
fn millis(ms: Option<i64>) -> Option<f64> {
    ms.map(|ms| ms as f64)
}

/// `createCalendarEventForTask(db, { userId, taskId, ... })`.
fn sync_event(event: &TaskEvent) -> sync::TaskEvent {
    sync::TaskEvent {
        user_id: event.user_id.clone(),
        source_id: Some(event.task_id.clone()),
        source_type: None,
        title: event.title.clone(),
        description: event.description.clone(),
        due_date: millis(event.due_date),
        start_date: millis(event.start_date),
        duration_minutes: event.duration_minutes,
        priority: event.priority.clone(),
    }
}

impl TaskCalendar for CalendarSync {
    fn create_for_task<'a>(
        &'a self,
        db: &'a PgPool,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(async move {
            sync::create_calendar_event_for_task(db, &sync_event(event))
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn reschedule<'a>(
        &'a self,
        db: &'a PgPool,
        calendar_event_id: &'a str,
        event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(async move {
            let params = sync::Reschedule {
                calendar_event_id: calendar_event_id.to_owned(),
                event: sync_event(event),
            };
            sync::reschedule_calendar_event(db, &params)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn cancel<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(async move {
            sync::cancel_calendar_event(db, calendar_event_id)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn confirm<'a>(&'a self, db: &'a PgPool, calendar_event_id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(async move {
            sync::confirm_calendar_event(db, calendar_event_id)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn scheduled_slots<'a>(
        &'a self,
        db: &'a PgPool,
        task_ids: &'a [String],
    ) -> CalendarFuture<'a, HashMap<String, ScheduledSlot>> {
        Box::pin(async move {
            let slots = sync::fetch_task_scheduled_slots(db, task_ids)
                .await
                .map_err(|error| error.to_string())?;
            Ok(slots
                .into_iter()
                .map(|(task, slot)| {
                    (
                        task,
                        ScheduledSlot {
                            event_id: slot.event_id,
                            start_time: slot.start_time,
                            end_time: slot.end_time,
                            auto_scheduled: slot.auto_scheduled,
                        },
                    )
                })
                .collect())
        })
    }

    fn next_replan_at<'a>(&'a self, db: &'a PgPool) -> CalendarFuture<'a, Option<OffsetDateTime>> {
        Box::pin(async move {
            sync::next_auto_scheduled_replan_at(db)
                .await
                .map_err(|error| error.to_string())
        })
    }
}
