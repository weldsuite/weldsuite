//! The workspace due index (`packages/core/worker-kit/src/due-index.ts`) on
//! the master database's `workspace_due_index` table (master migration 0063),
//! where Global uses the schedule-index D1 database. A row says "open this
//! workspace's tenant database at or after `next_due_at`"; the tenant stays
//! the source of truth.
//!
//! - Write paths call [`mark_due`] / [`sync_due`], which can only pull the
//!   due time earlier. Best effort: a failure is logged, never returned.
//!   [`set_due`] moves it either way, for a schedule the user moved.
//! - A sweep ([`run_sweep`]) lists due rows, does the work, and stores the
//!   re-derived time guarded by the row's `version`, so a write that lands
//!   meanwhile is never overwritten. It never falls back to opening every
//!   tenant.
//!
//! Global's one-time KV-flagged seed has no equivalent: the Kubernetes
//! editions have this table from their first release.

use std::future::Future;

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::sea_query::{self, Alias, Expr, Func, OnConflict};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_schema::master::workspace_due_index;

use crate::orm::orm;

/// A due row as the sweep lists it; `version` is the compare-and-set token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueRow {
    pub workspace_id: String,
    pub next_due_at: OffsetDateTime,
    pub version: i32,
}

/// Insert the row at `at`, or bump the one there: `next_due_at` becomes
/// `next(stored, at)`, and the version moves so a sweep that listed the row
/// before does not overwrite it.
async fn upsert(
    pool: &PgPool,
    kind: &str,
    workspace_id: &str,
    at: OffsetDateTime,
    next: Expr,
) -> Result<(), DbErr> {
    let row = workspace_due_index::ActiveModel {
        kind: Set(kind.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        next_due_at: Set(at),
        updated_at: NotSet,
        version: Set(1),
    };
    workspace_due_index::Entity::insert(row)
        .on_conflict(
            OnConflict::columns([
                workspace_due_index::Column::Kind,
                workspace_due_index::Column::WorkspaceId,
            ])
            .value(workspace_due_index::Column::NextDueAt, next)
            .value(
                workspace_due_index::Column::UpdatedAt,
                Expr::col((
                    Alias::new("excluded"),
                    workspace_due_index::Column::UpdatedAt,
                )),
            )
            .value(
                workspace_due_index::Column::Version,
                sea_query::ExprTrait::add(
                    Expr::col((
                        workspace_due_index::Entity,
                        workspace_due_index::Column::Version,
                    )),
                    1,
                ),
            )
            .to_owned(),
        )
        .exec_without_returning(&orm(pool))
        .await?;
    Ok(())
}

/// `excluded.next_due_at`: the time being written.
fn written() -> Expr {
    Expr::col((
        Alias::new("excluded"),
        workspace_due_index::Column::NextDueAt,
    ))
}

async fn mark(
    pool: &PgPool,
    kind: &str,
    workspace_id: &str,
    at: OffsetDateTime,
) -> Result<(), DbErr> {
    let stored = Expr::col((
        workspace_due_index::Entity,
        workspace_due_index::Column::NextDueAt,
    ));
    let earlier = Func::cust("least").arg(stored).arg(written());
    upsert(pool, kind, workspace_id, at, Expr::from(earlier)).await
}

/// Make sure the sweep looks at this workspace no later than `at`
/// (`markWorkspaceDue`). Never pushes a due time later. Best effort.
pub async fn mark_due(pool: &PgPool, kind: &str, workspace_id: &str, at: OffsetDateTime) {
    if workspace_id.is_empty() {
        return;
    }
    if let Err(error) = mark(pool, kind, workspace_id, at).await {
        tracing::warn!(%error, kind, workspace_id, "due index: mark failed");
    }
}

/// Make `at` the workspace's due time, later or earlier than the row's
/// (a schedule moved to another hour: [`mark_due`] would keep the old time
/// when it is earlier, and the sweep would then run at both). Like a mark,
/// it bumps the row's version, so a sweep that listed the row before does
/// not overwrite it. Best effort.
pub async fn set_due(pool: &PgPool, kind: &str, workspace_id: &str, at: OffsetDateTime) {
    if workspace_id.is_empty() {
        return;
    }
    if let Err(error) = upsert(pool, kind, workspace_id, at, written()).await {
        tracing::warn!(%error, kind, workspace_id, "due index: set failed");
    }
}

/// [`mark_due`] with the time derived from the tenant (`syncWorkspaceDue`);
/// `None` (nothing due) leaves the row alone. Best effort.
pub async fn sync_due<F, Fut, E>(pool: &PgPool, kind: &str, workspace_id: &str, derive: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Option<OffsetDateTime>, E>>,
    E: std::fmt::Display,
{
    if workspace_id.is_empty() {
        return;
    }
    match derive().await {
        Ok(Some(at)) => mark_due(pool, kind, workspace_id, at).await,
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, kind, workspace_id, "due index: sync failed"),
    }
}

/// Workspaces whose `kind` work is due at `as_of`, earliest first
/// (`listDueWorkspaces`).
pub async fn list_due(
    pool: &PgPool,
    kind: &str,
    as_of: OffsetDateTime,
    limit: i64,
) -> Result<Vec<DueRow>, DbErr> {
    let rows = workspace_due_index::Entity::find()
        .filter(workspace_due_index::Column::Kind.eq(kind))
        .filter(workspace_due_index::Column::NextDueAt.lte(as_of))
        .order_by_asc(workspace_due_index::Column::NextDueAt)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&orm(pool))
        .await?;
    Ok(rows.into_iter().map(due_row).collect())
}

fn due_row(row: workspace_due_index::Model) -> DueRow {
    DueRow {
        workspace_id: row.workspace_id,
        next_due_at: row.next_due_at,
        version: row.version,
    }
}

/// One workspace's row as it is now, to [`settle`] later (reach-api's
/// `readSendDueRow`: read before the tenant is looked at, so a write that
/// lands meanwhile is not lost).
pub async fn read_due(
    pool: &PgPool,
    kind: &str,
    workspace_id: &str,
) -> Result<Option<DueRow>, DbErr> {
    let row = workspace_due_index::Entity::find_by_id((kind.to_owned(), workspace_id.to_owned()))
        .one(&orm(pool))
        .await?;
    Ok(row.map(due_row))
}

/// Store a listed row's re-derived due time (`None`: nothing left, drop the
/// row), unless a write touched it since it was listed (`settleWorkspaceDue`).
/// Whether the write applied.
pub async fn settle(
    pool: &PgPool,
    kind: &str,
    row: &DueRow,
    next: Option<OffsetDateTime>,
) -> Result<bool, DbErr> {
    let listed = Condition::all()
        .add(workspace_due_index::Column::Kind.eq(kind))
        .add(workspace_due_index::Column::WorkspaceId.eq(&row.workspace_id))
        .add(workspace_due_index::Column::Version.eq(row.version));
    let db = orm(pool);
    let rows_affected = match next {
        None => {
            workspace_due_index::Entity::delete_many()
                .filter(listed)
                .exec(&db)
                .await?
                .rows_affected
        }
        Some(at) => {
            workspace_due_index::Entity::update_many()
                .col_expr(workspace_due_index::Column::NextDueAt, Expr::value(at))
                .col_expr(
                    workspace_due_index::Column::UpdatedAt,
                    Expr::current_timestamp(),
                )
                .col_expr(
                    workspace_due_index::Column::Version,
                    sea_query::ExprTrait::add(Expr::col(workspace_due_index::Column::Version), 1),
                )
                .filter(listed)
                .exec(&db)
                .await?
                .rows_affected
        }
    };
    Ok(rows_affected > 0)
}

/// What one sweep tick did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepResult {
    pub due: usize,
    pub processed: usize,
    pub failed: usize,
}

/// One tick of a due-index sweep (`runDueIndexSweep`): list the due rows,
/// process each workspace, and store when it is next due. A failed workspace
/// is retried no sooner than `retry_after`, or next tick. When the index
/// can't be read the tick is skipped, never replaced by a fan-out.
pub async fn run_sweep<F, Fut, E>(
    pool: &PgPool,
    kind: &str,
    now: OffsetDateTime,
    limit: i64,
    retry_after: Option<time::Duration>,
    mut process: F,
) -> SweepResult
where
    F: FnMut(String, OffsetDateTime) -> Fut,
    Fut: Future<Output = Result<Option<OffsetDateTime>, E>>,
    E: std::fmt::Display,
{
    let mut result = SweepResult::default();
    let rows = match list_due(pool, kind, now, limit).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, kind, "due index unavailable; skipping tick");
            return result;
        }
    };
    result.due = rows.len();
    for row in rows {
        match process(row.workspace_id.clone(), now).await {
            Ok(next) => {
                result.processed += 1;
                if let Err(error) = settle(pool, kind, &row, next).await {
                    tracing::warn!(%error, kind, workspace_id = row.workspace_id, "due index: settle failed");
                }
            }
            Err(error) => {
                result.failed += 1;
                tracing::error!(%error, kind, workspace_id = row.workspace_id, "sweep: workspace failed");
                if let Some(retry_after) = retry_after
                    && let Err(error) = settle(pool, kind, &row, Some(now + retry_after)).await
                {
                    tracing::warn!(%error, kind, workspace_id = row.workspace_id, "due index: back-off failed");
                }
            }
        }
    }
    result
}
