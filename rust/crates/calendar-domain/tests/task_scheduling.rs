//! Task auto-scheduling against the real tenant schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`): a task without a start
//! is placed in a free slot of the default working hours, a task with one is
//! pinned to it, the nightly re-plan moves a stale event forward, and turning
//! auto-scheduling off clears the auto-placed events.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use weldsuite_calendar_domain::{
    EventUpdate, TaskEvent, TaskSchedulingApp, create_calendar_event_for_task,
    fetch_task_scheduled_slots, is_task_auto_schedule_enabled, next_auto_scheduled_replan_at,
    now_ms, remove_auto_scheduled_task_events, replan_stale_auto_scheduled_events,
    update_calendar_event_for_task,
};
use weldsuite_db::master_pool;

const USER: &str = "user_cdt_scheduler";
const HOUR: f64 = 3_600_000.0;

async fn reset(db: &sqlx::PgPool) {
    sqlx::raw_sql(
        r"delete from calendar_events where organizer_id like 'user_cdt_%';
          delete from calendars where owner_id like 'user_cdt_%';
          delete from tasks where id like 'task_cdt_%';
          delete from user_preferences where user_id like 'user_cdt_%';",
    )
    .execute(db)
    .await
    .expect("reset");
}

async fn insert_task(db: &sqlx::PgPool, id: &str) {
    sqlx::query("insert into tasks (id, title) values ($1, 'Write the report')")
        .bind(id)
        .execute(db)
        .await
        .expect("task");
}

/// `(start ms, end ms, auto_scheduled)` of an event.
async fn event(db: &sqlx::PgPool, id: &str) -> (f64, Option<f64>, bool) {
    let (start, end, auto): (f64, Option<f64>, Option<bool>) = sqlx::query_as(
        "select (extract(epoch from start_time) * 1000)::float8,
                (extract(epoch from end_time) * 1000)::float8,
                auto_scheduled
         from calendar_events where id = $1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .expect("event");
    (start, end, auto.unwrap_or(false))
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn tasks_are_placed_pinned_replanned_and_cleared() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    reset(&db).await;

    // No start date: auto-placed in a 30-minute slot of Mon–Fri 09:00–17:00 UTC.
    insert_task(&db, "task_cdt_auto").await;
    assert!(
        is_task_auto_schedule_enabled(&db, USER, Some("task_cdt_auto"))
            .await
            .expect("switch")
    );
    let placed = create_calendar_event_for_task(
        &db,
        &TaskEvent {
            user_id: USER.to_owned(),
            source_id: Some("task_cdt_auto".to_owned()),
            title: "Write the report".to_owned(),
            ..TaskEvent::default()
        },
    )
    .await
    .expect("placed")
    .expect("an event");
    let (start, end, auto) = event(&db, &placed).await;
    assert!(auto);
    assert_eq!(end, Some(start + 30.0 * 60_000.0));
    #[allow(clippy::cast_possible_truncation)]
    let minute_of_day = ((start / 60_000.0) as i64).rem_euclid(24 * 60);
    assert!(
        (9 * 60..17 * 60).contains(&minute_of_day),
        "{minute_of_day}"
    );
    assert!(start >= now_ms() - 15.0 * 60_000.0);

    // A start date pins the event there.
    insert_task(&db, "task_cdt_pinned").await;
    let pinned_at = (now_ms() / HOUR).floor() * HOUR + 48.0 * HOUR;
    let pinned = create_calendar_event_for_task(
        &db,
        &TaskEvent {
            user_id: USER.to_owned(),
            source_id: Some("task_cdt_pinned".to_owned()),
            title: "Pinned".to_owned(),
            start_date: Some(pinned_at),
            duration_minutes: Some(45.0),
            ..TaskEvent::default()
        },
    )
    .await
    .expect("pinned")
    .expect("an event");
    assert_eq!(
        event(&db, &pinned).await,
        (pinned_at, Some(pinned_at + 45.0 * 60_000.0), false)
    );
    update_calendar_event_for_task(
        &db,
        &EventUpdate {
            calendar_event_id: pinned.clone(),
            due_date: Some(Some(pinned_at + HOUR)),
            ..EventUpdate::default()
        },
    )
    .await
    .expect("update");
    assert_eq!(event(&db, &pinned).await.0, pinned_at + HOUR);

    let slots = fetch_task_scheduled_slots(&db, &["task_cdt_auto".to_owned()])
        .await
        .expect("slots");
    assert_eq!(slots["task_cdt_auto"].event_id, placed);

    // A stale auto-placed event is moved forward by the re-plan.
    sqlx::query("update calendar_events set start_time = now() - interval '1 day' where id = $1")
        .bind(&placed)
        .execute(&db)
        .await
        .expect("stale");
    sqlx::query("update tasks set calendar_event_id = $1 where id = 'task_cdt_auto'")
        .bind(&placed)
        .execute(&db)
        .await
        .expect("link");
    let due = next_auto_scheduled_replan_at(&db)
        .await
        .expect("due")
        .expect("a stale event");
    assert!(due < time::OffsetDateTime::now_utc());
    let stats = replan_stale_auto_scheduled_events(&db, 200)
        .await
        .expect("replan");
    assert_eq!((stats.scanned, stats.rescheduled, stats.failed), (1, 1, 0));
    let relinked: Option<String> =
        sqlx::query_scalar("select calendar_event_id from tasks where id = 'task_cdt_auto'")
            .fetch_one(&db)
            .await
            .expect("task");
    let relinked = relinked.expect("a new event");
    assert_ne!(relinked, placed);
    assert!(event(&db, &relinked).await.0 >= now_ms() - 15.0 * 60_000.0);

    // Turning WeldFlow's auto-scheduling off clears the auto-placed event only.
    assert_eq!(
        remove_auto_scheduled_task_events(&db, USER, Some(TaskSchedulingApp::Flow))
            .await
            .expect("removed"),
        1
    );
    reset(&db).await;
}
