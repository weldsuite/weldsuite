//! `weldsuite cron workflow-schedules` (`run_schedule_sweep`) against the
//! real schema: due schedules fire with workflow-worker's trigger data, a
//! schedule without a next run gets one, the double-fire guard, end dates,
//! one-time schedules, the concurrent-run limit, and the due index left at
//! the workspace's earliest next run.
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` (built
//! by `scripts/rust-test-db.ts`); skips without them.

#![allow(clippy::unwrap_used, clippy::too_many_lines, clippy::type_complexity)]

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_connect::{ScheduleTenants, WorkflowRuns, run_schedule_sweep};
use weldsuite_ports::BoxFuture;

#[derive(Default)]
struct RecordingRuns {
    created: Mutex<Vec<Value>>,
}

impl WorkflowRuns for RecordingRuns {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>> {
        self.created
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(params.clone());
        Box::pin(async { Ok("inst".to_owned()) })
    }

    fn terminate<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn send_event<'a>(
        &'a self,
        _id: &'a str,
        _event_type: &'a str,
        _payload: &'a Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

async fn pool(var: &str) -> Option<PgPool> {
    let url = std::env::var(var).ok()?;
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap(),
    )
}

async fn exec(db: &PgPool, sql: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(db)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn due_schedules_fire_and_the_index_settles() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set; skipping");
        return;
    };
    exec(
        &tenant,
        "delete from workflow_execution_steps; delete from workflow_error_logs; delete from workflow_executions;
         delete from workflow_schedules; delete from workflows;
         insert into workflows (id, name, status, version, steps, triggers, settings)
           values ('wf_s', 'Nightly', 'active', 2, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb),
                  ('wf_busy', 'Busy', 'active', 1, '[]'::jsonb, '[]'::jsonb, '{\"maxConcurrentRuns\": 1}'::jsonb);
         insert into workflow_executions (id, workflow_id, status, triggered_by, trigger_type)
           values ('wex_running', 'wf_busy', 'running', 'system', 'schedule');
         insert into workflow_schedules (id, workflow_id, trigger_id, name, schedule_type, cron_expression,
             timezone, is_enabled, next_run_at, last_run_at, end_date, execute_at, total_runs)
           values
             ('sch_due', 'wf_s', 'trg_1', 'a', 'recurring', '*/5 * * * *', 'Europe/Amsterdam', true,
              now() at time zone 'utc' - interval '1 minute', null, null, null, 4),
             ('sch_new', 'wf_s', 'trg_2', 'b', 'recurring', '0 9 * * *', 'UTC', true, null, null, null, null, 0),
             ('sch_guard', 'wf_s', 'trg_3', 'c', 'recurring', '* * * * *', 'UTC', true,
              now() at time zone 'utc' - interval '1 minute', now() at time zone 'utc' - interval '10 seconds', null, null, 1),
             ('sch_once', 'wf_s', 'trg_4', 'd', 'one_time', null, 'UTC', true,
              now() at time zone 'utc' - interval '2 minutes', null, null, now() at time zone 'utc' - interval '2 minutes', 0),
             ('sch_ended', 'wf_s', 'trg_5', 'e', 'recurring', '* * * * *', 'UTC', true,
              now() at time zone 'utc' - interval '1 minute', null, now() at time zone 'utc' - interval '1 hour', null, 0),
             ('sch_busy', 'wf_busy', 'trg_6', 'f', 'recurring', '* * * * *', 'UTC', true,
              now() at time zone 'utc' - interval '1 minute', null, null, null, 0)",
    )
    .await;
    exec(
        &master,
        "delete from workspace_due_index where kind = 'workflow_schedule';
         insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
           values ('workflow_schedule', 'ws_sched', now() - interval '1 minute', now(), 1)",
    )
    .await;

    let runs = RecordingRuns::default();
    let db = tenant.clone();
    let tenants: ScheduleTenants = Arc::new(move |reference: String| {
        let db = db.clone();
        Box::pin(async move {
            assert_eq!(reference, "ws_sched");
            Ok((db, "org_sched".to_owned()))
        })
    });
    let result =
        run_schedule_sweep(&master, &tenants, Some(&runs), OffsetDateTime::now_utc()).await;
    assert_eq!((result.due, result.processed, result.failed), (1, 1, 0));

    let created = runs.created.into_inner().unwrap();
    let fired: Vec<&str> = created
        .iter()
        .map(|p| p["triggerData"]["scheduleId"].as_str().unwrap())
        .collect();
    assert_eq!(fired.len(), 2, "{created:?}");
    assert!(fired.contains(&"sch_due") && fired.contains(&"sch_once"));
    let due = created
        .iter()
        .find(|p| p["triggerData"]["scheduleId"] == "sch_due")
        .unwrap();
    assert_eq!(due["workspaceId"], json!("org_sched"));
    assert_eq!(due["userId"], json!("system"));
    assert_eq!(due["triggerId"], json!("trg_1"));
    assert_eq!(due["triggerType"], json!("schedule"));
    assert_eq!(due["source"], json!("weldconnect"));
    assert_eq!(due["triggerData"]["timezone"], json!("Europe/Amsterdam"));
    assert!(
        due["triggerData"]["scheduledTime"]
            .as_str()
            .unwrap()
            .ends_with(":00.000Z")
    );

    let rows: Vec<(String, bool, Option<String>, Option<i32>, bool, bool)> = sqlx::query_as(
        "select id, is_enabled, last_run_status, total_runs, next_run_at is not null,
                coalesce(next_run_at > now() at time zone 'utc', false)
         from workflow_schedules order by id",
    )
    .fetch_all(&tenant)
    .await
    .unwrap();
    let row = |id: &str| rows.iter().find(|r| r.0 == id).unwrap().clone();
    assert_eq!(
        row("sch_due"),
        (
            "sch_due".into(),
            true,
            Some("completed".into()),
            Some(5),
            true,
            true
        )
    );
    let new = row("sch_new");
    assert!(new.1 && new.2.is_none() && new.4 && new.5, "{new:?}");
    assert_eq!(row("sch_guard").2, None);
    assert_eq!(
        row("sch_once"),
        (
            "sch_once".into(),
            false,
            Some("completed".into()),
            Some(1),
            false,
            false
        )
    );
    assert!(!row("sch_ended").1);
    let busy = row("sch_busy");
    assert_eq!(busy.2.as_deref(), Some("failed"));
    let skipped: i64 = sqlx::query_scalar(
        "select count(*) from workflow_executions where workflow_id = 'wf_busy' and status = 'skipped'",
    )
    .fetch_one(&tenant)
    .await
    .unwrap();
    assert_eq!(skipped, 1);

    // The index is left at the earliest next run: the guarded schedule's,
    // which is still due.
    let left: Option<bool> = sqlx::query_scalar(
        "select next_due_at <= now() from workspace_due_index where kind = 'workflow_schedule' and workspace_id = 'ws_sched'",
    )
    .fetch_optional(&master)
    .await
    .unwrap();
    assert_eq!(left, Some(true));
}
