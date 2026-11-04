//! The monthly measuring of benefits (`cron/benefit-measure.ts`,
//! `weldsuite cron flow-benefit-measure`, FLOW-014): every open benefit with a
//! catalogue metric (`planned`, `measuring` or `at_risk`, on any project, an
//! archived one included) gets the value of the month that just ended,
//! upserted into `project_benefit_measurements`. A benefit that is realised or
//! closed stops being measured; a `manual` benefit is never measured here.
//!
//! Only workspaces the `benefit_measure` due index lists are opened (ADR
//! DATA-008); the routes that create or edit a benefit mark them due at the
//! next month boundary. A workspace is next due on the first day of the next
//! month while an open benefit with a metric remains, else the row is dropped.

use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_flow_domain::benefit_metrics::{
    measure_metric, next_month_start_ms, previous_period,
};
use weldsuite_flow_domain::benefits::BENEFIT_OPEN_STATUSES;
use weldsuite_flow_domain::js::iso_from_millis;

use crate::governance_store::upsert_measurement;
use crate::import_tasks::TenantDatabases;

/// The due index kind.
pub const BENEFIT_MEASURE_KIND: &str = "benefit_measure";
/// A workspace that failed is retried after six hours.
const RETRY_AFTER_HOURS: i64 = 6;
/// How many due workspaces one tick opens at most.
const SWEEP_LIMIT: i64 = 500;

/// One tick: the due-index sweep and how many values it stored.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BenefitMeasureTick {
    pub sweep: SweepResult,
    pub measured: usize,
}

/// The open benefits that have a catalogue metric, on every project:
/// `(id, project id, metric, metric params)`.
async fn open_measured_benefits(
    db: &PgPool,
    limit: Option<i64>,
) -> Result<Vec<(String, String, String, serde_json::Value)>, sqlx::Error> {
    sqlx::query_as(
        "select id, project_id, metric, metric_params from project_benefits
         where deleted_at is null and closed_at is null and metric <> 'manual'
           and status = any($1)
         limit $2",
    )
    .bind(BENEFIT_OPEN_STATUSES.as_slice())
    .bind(limit)
    .fetch_all(db)
    .await
}

/// `measureDueBenefits(db, now)`: measure the month before `now` for every
/// open benefit of one workspace; how many got a value.
pub async fn measure_due_benefits(db: &PgPool, now_ms: i64) -> Result<usize, sqlx::Error> {
    let period = previous_period(now_ms);
    let now = iso_from_millis(now_ms).unwrap_or_default();
    let mut measured = 0;
    for (id, project_id, metric, params) in open_measured_benefits(db, None).await? {
        let Some(value) = measure_metric(db, &metric, &params, &period).await? else {
            continue;
        };
        upsert_measurement(db, &id, &project_id, &period, &value, None, &now).await?;
        measured += 1;
    }
    Ok(measured)
}

/// `nextBenefitMeasureDueAt(db, now)`: the first day of the next month while an
/// open benefit with a catalogue metric remains, else `None`.
pub async fn next_benefit_measure_due_at(
    db: &PgPool,
    now_ms: i64,
) -> Result<Option<OffsetDateTime>, sqlx::Error> {
    if open_measured_benefits(db, Some(1)).await?.is_empty() {
        return Ok(None);
    }
    Ok(OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(next_month_start_ms(now_ms)) * 1_000_000,
    )
    .ok())
}

/// One daily tick (`runBenefitMeasure`): the due workspaces of the master
/// database's index, each measured and re-scheduled.
pub async fn run_benefit_measure(
    master: &PgPool,
    tenants: &TenantDatabases,
    now: OffsetDateTime,
) -> BenefitMeasureTick {
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
    let measured = std::sync::Mutex::new(0usize);
    let sweep = run_sweep(
        master,
        BENEFIT_MEASURE_KIND,
        now,
        SWEEP_LIMIT,
        Some(time::Duration::hours(RETRY_AFTER_HOURS)),
        |workspace_id, _now| {
            let tenants = std::sync::Arc::clone(tenants);
            let measured = &measured;
            async move {
                let db = tenants(workspace_id).await?;
                let done = measure_due_benefits(&db, now_ms)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Ok(mut total) = measured.lock() {
                    *total += done;
                }
                next_benefit_measure_due_at(&db, now_ms)
                    .await
                    .map_err(|e| e.to_string())
            }
        },
    )
    .await;
    let measured = measured.lock().map_or(0, |total| *total);
    if sweep.due > 0 || sweep.failed > 0 {
        tracing::info!(
            due = sweep.due,
            processed = sweep.processed,
            failed = sweep.failed,
            measured,
            "[BenefitMeasure] tick"
        );
    }
    BenefitMeasureTick { sweep, measured }
}
