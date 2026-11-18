//! The asset register's device import sweep
//! (`apps/workers/desk-api/src/cron/asset-import-sweep.ts`), run every minute
//! by `weldsuite cron asset-import-sweep`.
//!
//! It never wakes idle tenant databases (ADR DATA-008): timing lives in the
//! due index (kind `asset_import`, keyed by `workspaces.id`). The routes
//! mark the workspace due when a source is saved or started; each tick lists
//! the index, opens the workspaces that are due, runs the import step of the
//! sources that are due or under way and stores when the workspace is next
//! due: now while an import is under way (it continues in bounded steps),
//! the throttle time when Microsoft asked to wait, the earliest
//! `next_sync_at` otherwise, and no row at all when no source is left to
//! import. A workspace without a source is never opened. Global's one-time
//! seed has nothing to add (nothing existed before the index), so there is
//! none.
//!
//! A step reads one Microsoft page and writes at most
//! [`MAX_WRITES`] records, so a tick runs [`STEPS_PER_TICK`] steps in all.
//! Whatever does not fit stays due and goes on the next tick.
//!
//! A step that takes longer than a tick is not run twice: it holds a lease
//! on its run, the next tick finds the run busy, does nothing for that
//! source and leaves the workspace due.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::due_index::{list_due, settle};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource, iso_timestamp};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use super::import::{Announcer, ImportContext, MAX_WRITES, StepFailure, run_step};
use super::source::{self, DUE_KIND, instant, to_millisecond};

/// A workspace that failed (a database hiccup, a broken tenant) is retried
/// after this.
const RETRY_AFTER: time::Duration = time::Duration::minutes(10);
const WORKSPACES_PER_TICK: i64 = 20;
/// `ASSET_IMPORT_STEPS_PER_TICK`: import steps in one tick, across
/// workspaces.
const STEPS_PER_TICK: usize = 1;

/// A due workspace's tenant database and its Clerk org id (the workspace's
/// events go by it).
pub struct ImportTenant {
    pub db: PgPool,
    pub clerk_org_id: String,
}

/// Opens a workspace (`workspaces.id`) for the sweep.
pub type ImportTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<ImportTenant, String>> + Send + Sync>;

/// What an import works with.
#[derive(Clone)]
pub struct AssetImportServices {
    pub events: EntityEventPublisher,
    /// What Microsoft is called through; it must not follow redirects.
    /// Without one every call is `unreachable`.
    pub http: Option<OutboundHttp>,
    /// The field-encryption keys the client secrets are sealed with.
    pub keyring: Keyring,
}

impl std::fmt::Debug for AssetImportServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetImportServices")
            .field("events", &self.events)
            .field("http", &self.http.is_some())
            .finish_non_exhaustive()
    }
}

/// One tick (`runAssetImportSweep`'s result).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AssetImportSweepResult {
    pub due: usize,
    pub processed: usize,
    /// Workspaces that failed.
    pub failed: usize,
    /// Always 0: there is no seed (see the module docs).
    pub seeded: usize,
    /// Import steps run.
    pub steps: usize,
    /// Runs that ended (finished or failed).
    pub ended: usize,
}

impl AssetImportSweepResult {
    /// As TypeScript returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "due": self.due,
            "processed": self.processed,
            "failed": self.failed,
            "seeded": self.seeded,
            "steps": self.steps,
            "ended": self.ended,
        })
    }
}

/// `WorkspaceAssetImportSweep`.
#[derive(Debug, Default)]
struct WorkspaceSweep {
    steps: usize,
    ended: usize,
    /// When the workspace next has work (`None`: no source is left to
    /// import).
    next: Option<OffsetDateTime>,
}

/// `sweepWorkspaceAssetImports(env, db, orgId, now, { maxSteps })`: run the
/// due import steps of one workspace and answer when it next has work.
async fn sweep_workspace(
    services: &AssetImportServices,
    tenant: &ImportTenant,
    now: OffsetDateTime,
    max_steps: usize,
) -> Result<WorkspaceSweep, StepFailure> {
    let db = &tenant.db;
    let stamp = iso_timestamp(now);
    let mut result = WorkspaceSweep::default();
    let mut throttled_until: HashMap<String, OffsetDateTime> = HashMap::new();

    let announcer = Announcer {
        publisher: &services.events,
        context: EventContext::new(&tenant.clerk_org_id, "system", EventSource::System),
    };
    let context = ImportContext {
        db,
        keyring: &services.keyring,
        http: services.http.as_ref(),
        now,
        max_writes: MAX_WRITES,
        events: Some(&announcer),
    };

    for candidate in source::list(db).await? {
        if result.steps >= max_steps {
            break;
        }
        let running = if candidate.running().is_some() {
            candidate
        } else {
            let startable = candidate.enabled
                && candidate
                    .next_sync_at
                    .as_deref()
                    .and_then(instant)
                    .is_some_and(|at| at <= now);
            if !startable {
                continue;
            }
            // Another tick started it between the read and the claim.
            let Some(started) = source::start_import(db, &candidate.id, &stamp, None).await? else {
                continue;
            };
            started
        };

        let source_id = running.id.clone();
        let step = run_step(&context, running).await?;
        // The step of an earlier tick still holds this run: nothing was
        // done. The source has a run under way, so the workspace stays due
        // now.
        if step.busy {
            continue;
        }
        result.steps += 1;
        if let Some(seconds) = step.retry_after_seconds.filter(|seconds| *seconds > 0) {
            throttled_until.insert(source_id, now + time::Duration::seconds(i64::from(seconds)));
        }
        if step.done {
            result.ended += 1;
            announcer.source_updated(&step.source).await;
        }
    }

    for after in source::list(db).await? {
        let at = throttled_until
            .get(&after.id)
            .copied()
            .or_else(|| after.due_at(now));
        if let Some(at) = at
            && result.next.is_none_or(|next| at < next)
        {
            result.next = Some(at);
        }
    }
    Ok(result)
}

/// `runAssetImportSweep(env, now)`: one tick.
pub async fn run_asset_import_sweep(
    master: &PgPool,
    tenants: &ImportTenants,
    services: &AssetImportServices,
    now: OffsetDateTime,
) -> AssetImportSweepResult {
    let now = to_millisecond(now);
    let mut result = AssetImportSweepResult::default();
    let rows = match list_due(master, DUE_KIND, now, WORKSPACES_PER_TICK).await {
        Ok(rows) => rows,
        Err(error) => {
            // Deliberately no fallback to a tenant fan-out: skip this tick instead.
            tracing::error!(%error, "[AssetImport] due index unavailable; skipping tick");
            return result;
        }
    };
    result.due = rows.len();

    for row in rows {
        if result.steps >= STEPS_PER_TICK {
            break;
        }
        let swept = async {
            let tenant = tenants(row.workspace_id.clone()).await?;
            sweep_workspace(services, &tenant, now, STEPS_PER_TICK - result.steps)
                .await
                .map_err(|failure| failure.to_string())
        }
        .await;
        let stored = match swept {
            Ok(swept) => {
                result.processed += 1;
                result.steps += swept.steps;
                result.ended += swept.ended;
                settle(master, DUE_KIND, &row, swept.next).await
            }
            Err(error) => {
                result.failed += 1;
                tracing::error!(%error, workspace_id = row.workspace_id, "[AssetImport] workspace failed");
                settle(master, DUE_KIND, &row, Some(now + RETRY_AFTER)).await
            }
        };
        if let Err(error) = stored {
            tracing::warn!(%error, workspace_id = row.workspace_id, "[AssetImport] due index: settle failed");
        }
    }

    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            steps = result.steps,
            ended = result.ended,
            workspace_failures = result.failed,
            "[AssetImport] swept"
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_result_reads_as_typescripts() {
        let result = AssetImportSweepResult {
            due: 2,
            processed: 1,
            failed: 0,
            seeded: 0,
            steps: 1,
            ended: 1,
        };
        assert_eq!(
            result.to_json(),
            json!({ "due": 2, "processed": 1, "failed": 0, "seeded": 0, "steps": 1, "ended": 1 })
        );
        assert_eq!(DUE_KIND, "asset_import");
        assert_eq!(STEPS_PER_TICK, 1);
    }
}
