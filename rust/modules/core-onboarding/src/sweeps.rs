//! The workspace worker's two deletion crons, as `weldsuite cron`
//! subcommands:
//!
//! - [`sweep_scheduled_deletions`] (`services/deletion-sweep.ts`, daily):
//!   workspaces past `scheduled_deletion_at` lose their organization, which
//!   starts the deletion cascade (the identity sync sees the organization
//!   gone and tears the database down), and are stamped deleted.
//! - [`sweep_unfinished_teardowns`] (`services/teardown-sweep.ts`, hourly):
//!   deleted workspaces that still hold a database, past a 48-hour margin,
//!   get their teardown again.
//!
//! A workspace whose database is being moved is left for a later run. Not
//! here: the lingering Stripe subscription (Global only) and the mail held
//! outside Postgres (WeldMail is not on the Kubernetes editions yet).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use weldsuite_db::PgPool;
use weldsuite_ports::{DatabaseProvisioner, Identity};

/// Workspaces handled per deletion run (`SWEEP_BATCH_LIMIT`).
const SWEEP_BATCH_LIMIT: i64 = 50;
/// Teardowns retried per run (`TEARDOWN_BATCH_LIMIT`).
pub const TEARDOWN_BATCH_LIMIT: i64 = 10;
/// How long after `deleted_at` a teardown is retried (`TEARDOWN_RETRY_AFTER_MS`).
pub const TEARDOWN_RETRY_AFTER: Duration = Duration::from_hours(48);

/// `ACTIVE_DATABASE_MOVE_STATUSES`.
pub(crate) fn active_move_statuses() -> Vec<String> {
    [
        "queued",
        "preparing",
        "soft_locked",
        "locked",
        "copying",
        "verifying",
        "switching",
        "cancelling",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// `hasActiveMove`.
async fn has_active_move(master: &PgPool, workspace_id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (select 1 from workspace_database_moves
                         where workspace_id = $1 and status = any($2))",
    )
    .bind(workspace_id)
    .bind(active_move_statuses())
    .fetch_one(master)
    .await
}

/// `DeletionSweepResult`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DeletionSweepResult {
    pub processed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub deferred: usize,
}

/// `sweepScheduledDeletions`: one failure never stops the batch.
pub async fn sweep_scheduled_deletions(
    master: &PgPool,
    identity: &Arc<dyn Identity>,
) -> Result<DeletionSweepResult, sqlx::Error> {
    let due: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, clerk_org_id from workspaces
          where deleted_at is null and scheduled_deletion_at is not null
            and scheduled_deletion_at <= now()
          limit $1",
    )
    .bind(SWEEP_BATCH_LIMIT)
    .fetch_all(master)
    .await?;
    let mut result = DeletionSweepResult {
        processed: due.len(),
        ..DeletionSweepResult::default()
    };
    for (workspace_id, org) in due {
        let Some(org) = org.filter(|org| !org.is_empty()) else {
            tracing::warn!(workspace_id, "deletion sweep: no organization id, skipping");
            continue;
        };
        match delete_one(master, identity, &workspace_id, &org).await {
            Ok(true) => result.succeeded += 1,
            Ok(false) => result.deferred += 1,
            Err(error) => {
                tracing::error!(%error, workspace_id, "deletion sweep: failed");
                result.failed += 1;
            }
        }
    }
    Ok(result)
}

/// `Ok(false)` when a database move defers it.
async fn delete_one(
    master: &PgPool,
    identity: &Arc<dyn Identity>,
    workspace_id: &str,
    org: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    if has_active_move(master, workspace_id).await? {
        tracing::warn!(
            workspace_id,
            "deletion sweep: a database move is in progress, deferring"
        );
        return Ok(false);
    }
    match identity.delete_organization(org).await {
        Ok(()) => {}
        Err(error) if error.is_not_found() => {}
        Err(error) => return Err(Box::new(error)),
    }
    sqlx::query(
        "update workspaces set deleted_at = now(), is_active = false, updated_at = now() where id = $1",
    )
    .bind(workspace_id)
    .execute(master)
    .await?;
    tracing::info!(
        workspace_id,
        org,
        "deletion sweep: organization deleted; the cascade finishes the teardown"
    );
    Ok(true)
}

/// `TeardownSweepResult`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct TeardownSweepResult {
    pub due: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub deferred: usize,
}

/// `sweepUnfinishedTeardowns`: never fails; a workspace whose retry failed
/// goes to the back of the queue.
pub async fn sweep_unfinished_teardowns(
    master: &PgPool,
    provisioner: &Arc<dyn DatabaseProvisioner>,
    retry_after: Duration,
) -> TeardownSweepResult {
    let mut result = TeardownSweepResult::default();
    let seconds = i64::try_from(retry_after.as_secs()).unwrap_or(i64::MAX);
    let due: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from workspaces
          where deleted_at is not null and deleted_at < now() - make_interval(secs => $1::bigint::double precision)
            and is_active = false and neon_project_id is not null
          order by updated_at asc, id asc
          limit $2",
    )
    .bind(seconds)
    .bind(TEARDOWN_BATCH_LIMIT)
    .fetch_all(master)
    .await;
    let due = match due {
        Ok(due) => due,
        Err(error) => {
            tracing::error!(%error, "teardown sweep: failed");
            return result;
        }
    };
    result.due = due.len();
    for workspace_id in due {
        match has_active_move(master, &workspace_id).await {
            Ok(true) => {
                result.deferred += 1;
                continue;
            }
            Ok(false) => {}
            Err(error) => {
                tracing::error!(%error, workspace_id, "teardown sweep: failed");
                result.failed += 1;
                continue;
            }
        }
        match provisioner.teardown(&workspace_id).await {
            Ok(_) => {
                tracing::info!(
                    workspace_id,
                    "teardown sweep: finished the database teardown"
                );
                result.succeeded += 1;
            }
            Err(error) => {
                tracing::error!(%error, workspace_id, "teardown sweep: the teardown failed again");
                result.failed += 1;
                let requeued =
                    sqlx::query("update workspaces set updated_at = now() where id = $1")
                        .bind(&workspace_id)
                        .execute(master)
                        .await;
                if let Err(error) = requeued {
                    tracing::error!(%error, workspace_id, "teardown sweep: could not requeue");
                }
            }
        }
    }
    result
}
