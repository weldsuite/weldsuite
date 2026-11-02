//! The schedule sweep: workflow-worker's `cron/schedule-sweep.ts`, run as
//! `weldsuite cron workflow-schedules` every minute.
//!
//! Global keeps a copy of every schedule in the schedule-index D1 database
//! and sweeps that. Here a schedule's own row is the index: its
//! `next_run_at` (null: compute it again) and `is_enabled`, and the master
//! `workspace_due_index` row of kind [`SCHEDULE_DUE_KIND`] says which
//! workspaces to open (a save marks it due; each sweep stores the
//! workspace's earliest next run). For each due schedule the sweep
//! computes its next run, guards against a double fire, checks the
//! workflow's concurrent-run limit, starts the run with the schedule's
//! trigger data and records the outcome on the row.

use std::sync::Arc;

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_ports::BoxFuture;

use crate::cron::{compute_next_run_at, iso};
use crate::executions::{Skipped, at_concurrency_limit, insert_skipped};
use crate::runs::WorkflowRuns;
use crate::sync::SCHEDULE_DUE_KIND;

/// `DOUBLE_FIRE_GUARD_MS`.
const DOUBLE_FIRE_GUARD_MS: i64 = 55_000;
/// Workspaces one tick looks at.
const SWEEP_LIMIT: i64 = 500;

/// A workspace's tenant database and the reference its runs carry
/// (its Clerk org id, as Global's index rows did; else `workspaces.id`).
pub type ScheduleTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<(PgPool, String), String>> + Send + Sync>;

/// A schedule as the sweep reads it; times in epoch milliseconds.
#[derive(Debug, Clone)]
struct ScheduleRow {
    id: String,
    workflow_id: String,
    trigger_id: Option<String>,
    schedule_type: String,
    cron_expression: String,
    timezone: String,
    start_date: Option<i64>,
    end_date: Option<i64>,
    execute_at: Option<i64>,
    next_run_at: Option<i64>,
    last_run_at: Option<i64>,
}

fn ms(value: Option<f64>) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation)]
    value.map(|v| v.round() as i64)
}

fn at(ms: i64) -> String {
    iso(ms).unwrap_or_default()
}

async fn due_rows(db: &PgPool, now_ms: i64) -> Result<Vec<ScheduleRow>, sqlx::Error> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "select id, workflow_id, trigger_id, schedule_type, cron_expression, timezone,
                extract(epoch from start_date)::float8 * 1000, extract(epoch from end_date)::float8 * 1000,
                extract(epoch from execute_at)::float8 * 1000, extract(epoch from next_run_at)::float8 * 1000,
                extract(epoch from last_run_at)::float8 * 1000
         from workflow_schedules
         where is_enabled = true and deleted_at is null
           and (next_run_at is null or next_run_at <= $1::timestamp)
         order by next_run_at asc nulls first",
    )
    .bind(at(now_ms))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ScheduleRow {
            id: r.0,
            workflow_id: r.1,
            trigger_id: r.2.filter(|t| !t.is_empty()),
            schedule_type: r.3.unwrap_or_else(|| "recurring".into()),
            cron_expression: r.4.unwrap_or_default(),
            timezone: r
                .5
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "UTC".into()),
            start_date: ms(r.6),
            end_date: ms(r.7),
            execute_at: ms(r.8),
            next_run_at: ms(r.9),
            last_run_at: ms(r.10),
        })
        .collect())
}

fn next_run(row: &ScheduleRow, now_ms: i64) -> Option<i64> {
    if row.schedule_type == "one_time" {
        return None;
    }
    compute_next_run_at(
        &row.cron_expression,
        &row.timezone,
        now_ms,
        row.start_date,
        row.end_date,
    )
}

async fn disable(db: &PgPool, id: &str, now_ms: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update workflow_schedules set is_enabled = false, next_run_at = null, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(at(now_ms))
    .execute(db)
    .await?;
    Ok(())
}

/// `checkScheduleConcurrency`: whether the run may start; at the limit a
/// `skipped` row says why. A failed check lets the run start.
async fn concurrency_allows(db: &PgPool, row: &ScheduleRow, now_ms: i64) -> bool {
    let check = async {
        let workflow: Option<(String, Option<i32>, Option<Value>)> =
            sqlx::query_as("select name, version, settings from workflows where id = $1 limit 1")
                .bind(&row.workflow_id)
                .fetch_optional(db)
                .await?;
        let Some((name, version, settings)) = workflow else {
            return Ok(true);
        };
        if !at_concurrency_limit(db, &row.workflow_id, settings.as_ref()).await? {
            return Ok(true);
        }
        let slot = crate::engine::template::scheduled_slot(
            row.next_run_at.map(|n| json!(n)).as_ref(),
            now_ms,
        );
        insert_skipped(
            db,
            Skipped {
                workflow_id: &row.workflow_id,
                workflow_version: version.map(i64::from),
                workflow_name: Some(&name),
                triggered_by: None,
                trigger_type: "schedule",
                trigger_id: row.trigger_id.as_deref(),
                trigger_data: Some(&json!({ "scheduleId": row.id, "scheduledTime": at(slot) })),
                reason: "concurrency_limit",
                message: format!("Skipped: \"{name}\" is already at its concurrent run limit."),
            },
        )
        .await?;
        Ok::<_, sqlx::Error>(false)
    };
    check.await.unwrap_or_else(|error| {
        tracing::warn!(%error, "[ScheduleSweep] Concurrency check failed for schedule {}, allowing", row.id);
        true
    })
}

/// `writeTenantScheduleRun`: the outcome on the schedule's row.
async fn record_run(
    db: &PgPool,
    row: &ScheduleRow,
    ok: bool,
    next: Option<i64>,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    let one_time = row.schedule_type == "one_time";
    sqlx::query(
        "update workflow_schedules
         set last_run_at = $2::timestamp, last_run_status = $3, next_run_at = $4::timestamp,
             is_enabled = case when $5 then false else is_enabled end,
             total_runs = case when $6 then coalesce(total_runs, 0) + 1 else total_runs end,
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&row.id)
    .bind(at(now_ms))
    .bind(if ok { "completed" } else { "failed" })
    .bind(next.map(at))
    .bind(one_time)
    .bind(ok)
    .execute(db)
    .await?;
    Ok(())
}

/// One workspace: fire its due schedules; when it is next due.
async fn sweep_workspace(
    db: &PgPool,
    reference: &str,
    runs: Option<&dyn WorkflowRuns>,
    now_ms: i64,
) -> Result<Option<OffsetDateTime>, sqlx::Error> {
    for row in due_rows(db, now_ms).await? {
        let Some(slot) = row.next_run_at else {
            // `computeMissingNextRun`.
            let next = if row.schedule_type == "one_time" {
                row.execute_at
            } else {
                next_run(&row, now_ms)
            };
            match next {
                None => disable(db, &row.id, now_ms).await?,
                Some(next) => {
                    sqlx::query(
                        "update workflow_schedules set next_run_at = $2::timestamp, updated_at = $3::timestamp
                         where id = $1",
                    )
                    .bind(&row.id)
                    .bind(at(next))
                    .bind(at(now_ms))
                    .execute(db)
                    .await?;
                }
            }
            continue;
        };
        // `isReadyToFire`.
        if row.start_date.is_some_and(|start| now_ms < start) {
            continue;
        }
        if row.end_date.is_some_and(|end| now_ms > end) {
            disable(db, &row.id, now_ms).await?;
            continue;
        }
        if row
            .last_run_at
            .is_some_and(|last| now_ms - last < DOUBLE_FIRE_GUARD_MS)
        {
            continue;
        }
        let Some(runs) = runs else {
            tracing::warn!(
                "[ScheduleSweep] EXECUTE_WORKFLOW binding unavailable, skipping schedule {}",
                row.id
            );
            continue;
        };
        let next = next_run(&row, now_ms);
        let allowed = concurrency_allows(db, &row, now_ms).await;
        let ok = allowed
            && {
                let mut params = json!({
                    "workspaceId": reference,
                    "userId": "system",
                    "workflowId": row.workflow_id,
                    "triggerType": "schedule",
                    "triggerData": {
                        "scheduleId": row.id,
                        "cronExpression": row.cron_expression,
                        "scheduledTime": at(crate::engine::template::scheduled_slot(Some(&json!(slot)), now_ms)),
                        "timezone": row.timezone,
                    },
                    "source": if row.workflow_id.starts_with("hwf_") { "helpdesk" } else { "weldconnect" },
                });
                if let Some(trigger_id) = &row.trigger_id {
                    params["triggerId"] = json!(trigger_id);
                }
                match runs.create(&params).await {
                    Ok(_) => true,
                    Err(error) => {
                        tracing::error!(%error, "[ScheduleSweep] Failed to dispatch workflow {}", row.workflow_id);
                        false
                    }
                }
            };
        if let Err(error) = record_run(db, &row, ok, next, now_ms).await {
            tracing::warn!(%error, "[ScheduleSweep] Tenant stat update failed for {}", row.id);
        }
        // A recurring schedule with no next run within its end date is done.
        if next.is_none() && row.schedule_type != "one_time" {
            disable(db, &row.id, now_ms).await?;
        }
    }
    let earliest: Option<f64> = sqlx::query_scalar(
        "select extract(epoch from min(coalesce(next_run_at, $1::timestamp)))::float8 * 1000
         from workflow_schedules where is_enabled = true and deleted_at is null",
    )
    .bind(at(now_ms))
    .fetch_one(db)
    .await?;
    Ok(ms(earliest)
        .and_then(|ms| OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()))
}

/// One tick of `weldsuite cron workflow-schedules`.
pub async fn run_schedule_sweep(
    master: &PgPool,
    tenants: &ScheduleTenants,
    runs: Option<&dyn WorkflowRuns>,
    now: OffsetDateTime,
) -> SweepResult {
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    run_sweep(
        master,
        SCHEDULE_DUE_KIND,
        now,
        SWEEP_LIMIT,
        Some(time::Duration::minutes(5)),
        |workspace_id, _| async move {
            let (db, reference) = tenants(workspace_id).await?;
            sweep_workspace(&db, &reference, runs, now_ms)
                .await
                .map_err(|error| error.to_string())
        },
    )
    .await
}
