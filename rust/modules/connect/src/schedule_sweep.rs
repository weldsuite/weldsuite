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

use sea_orm::sea_query::{Expr, Func, NullOrdering};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, Order, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::workflow_schedules::{self, Column};
use weldsuite_schema::tenant::workflows;

use crate::Refusal;
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

/// `extract(epoch from column) * 1000`, rounded: a `timestamp` (UTC) as
/// epoch milliseconds.
fn millis(at: PrimitiveDateTime) -> i64 {
    let micros = at.assume_utc().unix_timestamp_nanos() / 1_000;
    let half = if micros < 0 { -500 } else { 500 };
    i64::try_from((micros + half) / 1_000).unwrap_or_default()
}

fn at(ms: i64) -> String {
    iso(ms).unwrap_or_default()
}

/// Epoch milliseconds as the `timestamp` column stores them (`at(ms)` cast
/// with `::timestamp`, which refuses a time out of range).
fn stamp(ms: i64) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(utc_timestamp)
        .map_err(|error| DbErr::Custom(format!("invalid timestamp {ms}: {error}")))
}

async fn due_rows(db: &PgPool, now_ms: i64) -> Result<Vec<ScheduleRow>, DbErr> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
    );
    let rows: Vec<Row> = workflow_schedules::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::WorkflowId,
            Column::TriggerId,
            Column::ScheduleType,
            Column::CronExpression,
            Column::Timezone,
            Column::StartDate,
            Column::EndDate,
            Column::ExecuteAt,
            Column::NextRunAt,
            Column::LastRunAt,
        ])
        .filter(Column::IsEnabled.eq(true))
        .filter(Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(Column::NextRunAt.is_null())
                .add(Column::NextRunAt.lte(stamp(now_ms)?)),
        )
        .order_by_with_nulls(Column::NextRunAt, Order::Asc, NullOrdering::First)
        .into_tuple()
        .all(&orm(db))
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
            start_date: r.6.map(millis),
            end_date: r.7.map(millis),
            execute_at: r.8.map(millis),
            next_run_at: r.9.map(millis),
            last_run_at: r.10.map(millis),
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

async fn disable(db: &PgPool, id: &str, now_ms: i64) -> Result<(), DbErr> {
    workflow_schedules::Entity::update_many()
        .col_expr(Column::IsEnabled, Expr::value(false))
        .col_expr(
            Column::NextRunAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(Column::UpdatedAt, Expr::value(stamp(now_ms)?))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `checkScheduleConcurrency`: whether the run may start; at the limit a
/// `skipped` row says why. A failed check lets the run start.
async fn concurrency_allows(db: &PgPool, row: &ScheduleRow, now_ms: i64) -> bool {
    let check = async {
        let workflow: Option<(String, Option<i32>, Option<Value>)> = workflows::Entity::find()
            .select_only()
            .columns([
                workflows::Column::Name,
                workflows::Column::Version,
                workflows::Column::Settings,
            ])
            .filter(workflows::Column::Id.eq(&row.workflow_id))
            .limit(1)
            .into_tuple()
            .one(&orm(db))
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
        Ok::<_, Refusal>(false)
    };
    check.await.unwrap_or_else(|refusal| {
        if let Refusal::Database(error) = refusal {
            tracing::warn!(%error, "[ScheduleSweep] Concurrency check failed for schedule {}, allowing", row.id);
        }
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
) -> Result<(), DbErr> {
    let now = stamp(now_ms)?;
    let next = next.map(stamp).transpose()?;
    let mut update = workflow_schedules::Entity::update_many()
        .col_expr(Column::LastRunAt, Expr::value(now))
        .col_expr(
            Column::LastRunStatus,
            Expr::value(if ok { "completed" } else { "failed" }),
        )
        .col_expr(Column::NextRunAt, Expr::value(next));
    if row.schedule_type == "one_time" {
        update = update.col_expr(Column::IsEnabled, Expr::value(false));
    }
    if ok {
        // `coalesce(total_runs, 0) + 1`.
        update = update.col_expr(
            Column::TotalRuns,
            sea_orm::ExprTrait::add(
                Func::coalesce([Expr::col(Column::TotalRuns), Expr::val(0)]),
                1,
            ),
        );
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(&row.id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// One workspace: fire its due schedules; when it is next due.
async fn sweep_workspace(
    db: &PgPool,
    reference: &str,
    runs: Option<&dyn WorkflowRuns>,
    now_ms: i64,
) -> Result<Option<OffsetDateTime>, DbErr> {
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
                    workflow_schedules::Entity::update_many()
                        .col_expr(Column::NextRunAt, Expr::value(stamp(next)?))
                        .col_expr(Column::UpdatedAt, Expr::value(stamp(now_ms)?))
                        .filter(Column::Id.eq(&row.id))
                        .exec(&orm(db))
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
    // `min(coalesce(next_run_at, now))`.
    let earliest: Option<Option<PrimitiveDateTime>> = workflow_schedules::Entity::find()
        .select_only()
        .column_as(
            Expr::from(Func::min(Func::coalesce([
                Expr::col(Column::NextRunAt),
                Expr::val(stamp(now_ms)?),
            ]))),
            "earliest",
        )
        .filter(Column::IsEnabled.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(earliest.flatten().map(millis).and_then(|ms| {
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()
    }))
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
