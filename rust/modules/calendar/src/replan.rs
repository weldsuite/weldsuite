//! The nightly calendar re-plan (`src/cron/calendar-replan.ts`), run at 04:00
//! UTC by `weldsuite cron calendar-replan`: auto-scheduled task events whose
//! start slipped into the past while the task is still open get a new slot.
//!
//! Timing lives in the master `workspace_due_index` (kind `calendar_replan`):
//! task writes that place an auto-scheduled event mark the workspace due at
//! its start, each tick opens only the due workspaces, re-plans them and
//! stores when their next auto-scheduled event starts (or drops the row).
//! The TypeScript sweep's one-time seed is kept: with a cache configured,
//! the first tick marks every active workspace due and remembers that under
//! [`CALENDAR_REPLAN_SEED_KEY`].

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{mark_due, run_sweep};
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{BoxFuture, DynCache};

/// Cache flag: active workspaces were seeded into the due index. Bump to reseed.
pub const CALENDAR_REPLAN_SEED_KEY: &str = "calendar:replan-index:seed:v1";

/// Events re-planned per workspace per tick.
const PER_WORKSPACE_BATCH_LIMIT: i64 = 200;

/// Workspaces per tick; the rest stay due for the next night.
const WORKSPACES_PER_RUN: i64 = 1000;

/// A workspace's tenant database, by `workspaces.id`.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// What one tick did (`runCalendarReplanSweep`'s result, and the seed).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplanResult {
    pub workspaces_scanned: usize,
    pub total_scanned: usize,
    pub total_rescheduled: usize,
    pub total_failed: usize,
    #[serde(skip)]
    pub seeded: usize,
}

/// The seed: every active workspace, due now, once per cache.
async fn seed(
    master: &PgPool,
    cache: Option<&dyn DynCache>,
    now: OffsetDateTime,
) -> Result<usize, String> {
    let Some(cache) = cache else {
        return Ok(0);
    };
    if cache
        .get_boxed(CALENDAR_REPLAN_SEED_KEY)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok(0);
    }
    let ids: Vec<String> = sqlx::query_scalar(
        "select id from workspaces where is_active = true and clerk_org_id is not null",
    )
    .fetch_all(master)
    .await
    .map_err(|e| e.to_string())?;
    for id in &ids {
        mark_due(master, weldsuite_calendar_domain::REPLAN_KIND, id, now).await;
    }
    cache
        .put_boxed(CALENDAR_REPLAN_SEED_KEY, &iso_timestamp(now), None)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        seeded = ids.len(),
        "[CalendarReplan] seeded the due index (one-time)"
    );
    Ok(ids.len())
}

/// One tick of the sweep (`runCalendarReplanSweep`).
pub async fn run_replan_sweep(
    master: &PgPool,
    tenants: &TenantDatabases,
    cache: Option<&dyn DynCache>,
    now: OffsetDateTime,
) -> ReplanResult {
    let mut result = ReplanResult::default();
    match seed(master, cache, now).await {
        Ok(seeded) => result.seeded = seeded,
        Err(error) => {
            tracing::error!(%error, "[CalendarReplan] seeding the due index failed; skipping tick");
            return result;
        }
    }
    let scanned = AtomicUsize::new(0);
    let rescheduled = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let swept = run_sweep(
        master,
        weldsuite_calendar_domain::REPLAN_KIND,
        now,
        WORKSPACES_PER_RUN,
        None,
        |workspace_id, _| {
            let tenants = Arc::clone(tenants);
            let (scanned, rescheduled, failed) = (&scanned, &rescheduled, &failed);
            async move {
                let db = tenants(workspace_id.clone()).await?;
                let replan = weldsuite_calendar_domain::replan_stale_auto_scheduled_events(
                    &db,
                    PER_WORKSPACE_BATCH_LIMIT,
                )
                .await
                .map_err(|e| e.to_string())?;
                scanned.fetch_add(replan.scanned, Ordering::Relaxed);
                rescheduled.fetch_add(replan.rescheduled, Ordering::Relaxed);
                failed.fetch_add(replan.failed, Ordering::Relaxed);
                if replan.scanned > 0 {
                    tracing::info!(
                        workspace_id,
                        scanned = replan.scanned,
                        rescheduled = replan.rescheduled,
                        failed = replan.failed,
                        "[CalendarReplan] workspace re-planned"
                    );
                }
                weldsuite_calendar_domain::next_auto_scheduled_replan_at(&db)
                    .await
                    .map_err(|e| e.to_string())
            }
        },
    )
    .await;
    result.workspaces_scanned = swept.processed;
    result.total_scanned = scanned.into_inner();
    result.total_rescheduled = rescheduled.into_inner();
    result.total_failed = failed.into_inner() + swept.failed;
    tracing::info!(
        due = swept.due,
        workspaces = swept.processed,
        scanned = result.total_scanned,
        rescheduled = result.total_rescheduled,
        failed = result.total_failed,
        "[CalendarReplan] Done"
    );
    result
}
