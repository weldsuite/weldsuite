//! The master database's `ad_sync_index` (`@weldsuite/ads-domain/sync-index`):
//! one row per workspace and ad connection, telling the metrics sweep which
//! connections to pull and when.

use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::{AdsError, hours_from_now, now};

/// Hours between metrics pulls when the caller names none.
pub const DEFAULT_METRICS_INTERVAL_HOURS: i64 = 6;

/// `getMasterDb(env)`, which fails without a master database.
fn master(master: Option<&PgPool>) -> Result<&PgPool, AdsError> {
    master.ok_or_else(|| AdsError::message("No database connection string was provided"))
}

/// `UpsertAdSyncIndexInput`.
#[derive(Debug, Clone)]
pub struct SyncIndexEntry<'a> {
    pub workspace_id: &'a str,
    pub connection_id: &'a str,
    pub clerk_org_id: &'a str,
    pub is_enabled: bool,
    pub metrics_interval_hours: Option<i64>,
    /// `webhookSubscribedAt`: `None` keeps an existing row's value and
    /// writes null into a new one.
    pub webhook_subscribed_at: Option<String>,
}

/// `upsertAdSyncIndex(env, input)`: update the workspace's row for the
/// connection, or insert one. An enabled connection is due for metrics in
/// `metricsIntervalHours` (6); a disabled one is not due.
pub async fn upsert_ad_sync_index(
    db: Option<&PgPool>,
    entry: &SyncIndexEntry<'_>,
) -> Result<(), AdsError> {
    let db = master(db)?;
    let now = now();
    let interval = entry
        .metrics_interval_hours
        .unwrap_or(DEFAULT_METRICS_INTERVAL_HOURS);
    let next_metrics_sync_at = entry.is_enabled.then(|| hours_from_now(interval));
    let existing: Option<String> = sqlx::query_scalar(
        "select id from ad_sync_index where workspace_id = $1 and connection_id = $2 limit 1",
    )
    .bind(entry.workspace_id)
    .bind(entry.connection_id)
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        sqlx::query(
            "update ad_sync_index set
                 clerk_org_id = $2,
                 is_enabled = $3,
                 metrics_interval_hours = $4::int,
                 next_metrics_sync_at = $5::timestamptz,
                 webhook_subscribed_at = case when $6::text is null then webhook_subscribed_at
                                              else $6::timestamptz end,
                 updated_at = $7::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(entry.clerk_org_id)
        .bind(entry.is_enabled)
        .bind(interval)
        .bind(next_metrics_sync_at)
        .bind(entry.webhook_subscribed_at.as_deref())
        .bind(&now)
        .execute(db)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "insert into ad_sync_index
             (id, workspace_id, connection_id, clerk_org_id, is_enabled, metrics_interval_hours,
              next_metrics_sync_at, webhook_subscribed_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::int, $7::timestamptz, $8::timestamptz, $9::timestamptz)",
    )
    .bind(generate_id("adsx"))
    .bind(entry.workspace_id)
    .bind(entry.connection_id)
    .bind(entry.clerk_org_id)
    .bind(entry.is_enabled)
    .bind(interval)
    .bind(next_metrics_sync_at)
    .bind(entry.webhook_subscribed_at.as_deref())
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// `deleteAdSyncIndex(env, workspaceId, connectionId)`.
pub async fn delete_ad_sync_index(
    db: Option<&PgPool>,
    workspace_id: &str,
    connection_id: &str,
) -> Result<(), AdsError> {
    sqlx::query("delete from ad_sync_index where workspace_id = $1 and connection_id = $2")
        .bind(workspace_id)
        .bind(connection_id)
        .execute(master(db)?)
        .await?;
    Ok(())
}

/// `touchAdSyncIndexAfterMetricsSync(env, workspaceId, connectionId)`: the
/// next metrics pull is due in six hours.
pub async fn touch_ad_sync_index_after_metrics_sync(
    db: Option<&PgPool>,
    workspace_id: &str,
    connection_id: &str,
) -> Result<(), AdsError> {
    sqlx::query(
        "update ad_sync_index set next_metrics_sync_at = $3::timestamptz, updated_at = $4::timestamptz
         where workspace_id = $1 and connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(hours_from_now(DEFAULT_METRICS_INTERVAL_HOURS))
    .bind(now())
    .execute(master(db)?)
    .await?;
    Ok(())
}
