//! The workspace due index (`packages/core/worker-kit/src/due-index.ts`) on
//! the master database's `workspace_due_index` table (master migration 0063),
//! where Global uses the schedule-index D1 database. A row says "open this
//! workspace's tenant database at or after `next_due_at`"; the tenant stays
//! the source of truth.
//!
//! - Write paths call [`mark_due`] / [`sync_due`], which can only pull the
//!   due time earlier. Best effort: a failure is logged, never returned.
//! - A sweep ([`run_sweep`]) lists due rows, does the work, and stores the
//!   re-derived time guarded by the row's `version`, so a write that lands
//!   meanwhile is never overwritten. It never falls back to opening every
//!   tenant.
//!
//! Global's one-time KV-flagged seed has no equivalent: the Kubernetes
//! editions have this table from their first release.

use std::future::Future;

use sqlx::PgPool;
use time::OffsetDateTime;

/// A due row as the sweep lists it; `version` is the compare-and-set token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueRow {
    pub workspace_id: String,
    pub next_due_at: OffsetDateTime,
    pub version: i32,
}

fn iso(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

async fn mark(
    pool: &PgPool,
    kind: &str,
    workspace_id: &str,
    at: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
         values ($1, $2, $3::timestamptz, now(), 1)
         on conflict (kind, workspace_id) do update set
             next_due_at = least(workspace_due_index.next_due_at, excluded.next_due_at),
             updated_at = excluded.updated_at,
             version = workspace_due_index.version + 1",
    )
    .bind(kind)
    .bind(workspace_id)
    .bind(iso(at))
    .execute(pool)
    .await?;
    Ok(())
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
) -> Result<Vec<DueRow>, sqlx::Error> {
    let rows: Vec<(String, String, i32)> = sqlx::query_as(
        "select workspace_id, to_char(next_due_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.USZ'), version
         from workspace_due_index
         where kind = $1 and next_due_at <= $2::timestamptz
         order by next_due_at asc
         limit $3",
    )
    .bind(kind)
    .bind(iso(as_of))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(workspace_id, at, version)| {
            OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339)
                .ok()
                .map(|next_due_at| DueRow {
                    workspace_id,
                    next_due_at,
                    version,
                })
        })
        .collect())
}

/// Store a listed row's re-derived due time (`None`: nothing left, drop the
/// row), unless a write touched it since it was listed (`settleWorkspaceDue`).
/// Whether the write applied.
pub async fn settle(
    pool: &PgPool,
    kind: &str,
    row: &DueRow,
    next: Option<OffsetDateTime>,
) -> Result<bool, sqlx::Error> {
    let result = match next {
        None => {
            sqlx::query(
                "delete from workspace_due_index where kind = $1 and workspace_id = $2 and version = $3",
            )
            .bind(kind)
            .bind(&row.workspace_id)
            .bind(row.version)
            .execute(pool)
            .await?
        }
        Some(at) => {
            sqlx::query(
                "update workspace_due_index
                 set next_due_at = $4::timestamptz, updated_at = now(), version = version + 1
                 where kind = $1 and workspace_id = $2 and version = $3",
            )
            .bind(kind)
            .bind(&row.workspace_id)
            .bind(row.version)
            .bind(iso(at))
            .execute(pool)
            .await?
        }
    };
    Ok(result.rows_affected() > 0)
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
