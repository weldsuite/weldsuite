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

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, Order, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::{DatabaseProvisioner, Identity};
use weldsuite_schema::master::{workspace_database_moves as moves, workspaces};

/// Workspaces handled per deletion run (`SWEEP_BATCH_LIMIT`).
const SWEEP_BATCH_LIMIT: u64 = 50;
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

/// `hasActiveMove`: a move of the workspace's database in one of
/// [`active_move_statuses`].
pub(crate) async fn has_active_move(master: &PgPool, workspace_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = moves::Entity::find()
        .select_only()
        .column(moves::Column::Id)
        .filter(moves::Column::WorkspaceId.eq(workspace_id))
        .filter(moves::Column::Status.is_in(active_move_statuses()))
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(found.is_some())
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
) -> Result<DeletionSweepResult, DbErr> {
    use sea_orm::ExprTrait as _;
    let due: Vec<(String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
        .filter(workspaces::Column::DeletedAt.is_null())
        .filter(workspaces::Column::ScheduledDeletionAt.is_not_null())
        .filter(
            Expr::col((workspaces::Entity, workspaces::Column::ScheduledDeletionAt))
                .lte(Expr::current_timestamp()),
        )
        .limit(SWEEP_BATCH_LIMIT)
        .into_tuple()
        .all(&orm(master))
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
    workspaces::Entity::update_many()
        .col_expr(workspaces::Column::DeletedAt, Expr::current_timestamp())
        .col_expr(workspaces::Column::IsActive, Expr::value(false))
        .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
        .filter(workspaces::Column::Id.eq(workspace_id))
        .exec(&orm(master))
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
    let due = match unfinished_teardowns(master, retry_after).await {
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
                let requeued = workspaces::Entity::update_many()
                    .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                    .filter(workspaces::Column::Id.eq(&workspace_id))
                    .exec(&orm(master))
                    .await;
                if let Err(error) = requeued {
                    tracing::error!(%error, workspace_id, "teardown sweep: could not requeue");
                }
            }
        }
    }
    result
}

/// Deleted workspaces that still hold a database, `deleted_at` older than
/// `retry_after` (whole seconds, `now() - make_interval(secs => …)`), the
/// longest untouched first.
async fn unfinished_teardowns(
    master: &PgPool,
    retry_after: Duration,
) -> Result<Vec<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    let seconds = Duration::from_secs(retry_after.as_secs()).as_secs_f64();
    let cutoff = Expr::current_timestamp().sub(Func::cust("make_interval").args([
        Expr::val(0),
        Expr::val(0),
        Expr::val(0),
        Expr::val(0),
        Expr::val(0),
        Expr::val(0),
        Expr::val(seconds),
    ]));
    workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::DeletedAt.is_not_null())
        .filter(Expr::col((workspaces::Entity, workspaces::Column::DeletedAt)).lt(cutoff))
        .filter(workspaces::Column::IsActive.eq(false))
        .filter(workspaces::Column::NeonProjectId.is_not_null())
        .order_by(workspaces::Column::UpdatedAt, Order::Asc)
        .order_by(workspaces::Column::Id, Order::Asc)
        .limit(TEARDOWN_BATCH_LIMIT.unsigned_abs())
        .into_tuple()
        .all(&orm(master))
        .await
}
