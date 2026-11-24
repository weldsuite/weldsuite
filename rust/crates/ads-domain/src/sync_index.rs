//! The master database's `ad_sync_index` (`@weldsuite/ads-domain/sync-index`):
//! one row per workspace and ad connection, telling the metrics sweep which
//! connections to pull and when.

use sea_orm::sea_query::{Expr, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::ad_sync_index;

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
    pub webhook_subscribed_at: Option<OffsetDateTime>,
}

/// `upsertAdSyncIndex(env, input)`: update the workspace's row for the
/// connection, or insert one. An enabled connection is due for metrics in
/// `metricsIntervalHours` (6); a disabled one is not due.
pub async fn upsert_ad_sync_index(
    db: Option<&PgPool>,
    entry: &SyncIndexEntry<'_>,
) -> Result<(), AdsError> {
    use ad_sync_index::Column;
    use sea_orm::ExprTrait as _;
    let db = orm(master(db)?);
    let now = now();
    let interval = entry
        .metrics_interval_hours
        .unwrap_or(DEFAULT_METRICS_INTERVAL_HOURS);
    let next_metrics_sync_at = entry.is_enabled.then(|| hours_from_now(interval));
    // `$n::int` of the hours, as before.
    let interval_hours = || Expr::val(interval).cast_as("int");
    let existing: Option<String> = ad_sync_index::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::WorkspaceId.eq(entry.workspace_id))
        .filter(Column::ConnectionId.eq(entry.connection_id))
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = existing {
        let mut update = ad_sync_index::Entity::update_many()
            .col_expr(
                Column::ClerkOrgId,
                Expr::value(entry.clerk_org_id.to_owned()),
            )
            .col_expr(Column::IsEnabled, Expr::value(entry.is_enabled))
            .col_expr(Column::MetricsIntervalHours, interval_hours())
            .col_expr(Column::NextMetricsSyncAt, Expr::value(next_metrics_sync_at));
        // `case when $n is null then webhook_subscribed_at else $n end`
        if let Some(subscribed_at) = entry.webhook_subscribed_at {
            update = update.col_expr(Column::WebhookSubscribedAt, Expr::value(subscribed_at));
        }
        update
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let insert = Query::insert()
        .into_table(ad_sync_index::Entity)
        .columns([
            Column::Id,
            Column::WorkspaceId,
            Column::ConnectionId,
            Column::ClerkOrgId,
            Column::IsEnabled,
            Column::MetricsIntervalHours,
            Column::NextMetricsSyncAt,
            Column::WebhookSubscribedAt,
            Column::UpdatedAt,
        ])
        .values([
            Expr::value(generate_id("adsx")),
            Expr::value(entry.workspace_id.to_owned()),
            Expr::value(entry.connection_id.to_owned()),
            Expr::value(entry.clerk_org_id.to_owned()),
            Expr::value(entry.is_enabled),
            interval_hours(),
            Expr::value(next_metrics_sync_at),
            Expr::value(entry.webhook_subscribed_at),
            Expr::value(now),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .to_owned();
    db.execute(&insert).await?;
    Ok(())
}

/// `deleteAdSyncIndex(env, workspaceId, connectionId)`.
pub async fn delete_ad_sync_index(
    db: Option<&PgPool>,
    workspace_id: &str,
    connection_id: &str,
) -> Result<(), AdsError> {
    ad_sync_index::Entity::delete_many()
        .filter(ad_sync_index::Column::WorkspaceId.eq(workspace_id))
        .filter(ad_sync_index::Column::ConnectionId.eq(connection_id))
        .exec(&orm(master(db)?))
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
    use ad_sync_index::Column;
    ad_sync_index::Entity::update_many()
        .col_expr(
            Column::NextMetricsSyncAt,
            Expr::value(hours_from_now(DEFAULT_METRICS_INTERVAL_HOURS)),
        )
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::WorkspaceId.eq(workspace_id))
        .filter(Column::ConnectionId.eq(connection_id))
        .exec(&orm(master(db)?))
        .await?;
    Ok(())
}
