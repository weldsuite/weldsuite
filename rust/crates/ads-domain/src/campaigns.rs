//! Campaign sync with Meta (`@weldsuite/ads-domain/campaign-management`):
//! push the campaigns edited in WeldSuite (`pending_push`), pull the synced
//! ones whose content changed on Meta.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_core_domain::js::number_text;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::enums::AdCampaignSyncStatus;
use weldsuite_schema::tenant::{ad_accounts, ad_campaigns};

use crate::AdsError;
use crate::meta::{
    CampaignChanges, CampaignContent, MetaCampaign, MetaClient, NewCampaign, hash_campaign_payload,
};

/// What a sync covers: pushes, pulls, or both (`'push' | 'pull' | 'full'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncScope {
    Full,
    Push,
    Pull,
}

impl SyncScope {
    fn pushes(self) -> bool {
        matches!(self, Self::Push | Self::Full)
    }

    fn pulls(self) -> bool {
        matches!(self, Self::Pull | Self::Full)
    }
}

/// What `syncAdConnection` did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncCounts {
    pub pushed: u64,
    pub failed: u64,
    pub pulled: u64,
}

/// A selected ad account, as the sync reads it.
#[derive(Debug, Clone)]
struct Account {
    id: String,
    platform_account_id: String,
    currency: Option<String>,
}

/// An ad campaign, as the sync reads it.
#[derive(Debug, Clone)]
struct Campaign {
    id: String,
    ad_account_id: String,
    platform_campaign_id: Option<String>,
    name: String,
    status: Option<String>,
    objective: Option<String>,
    daily_budget: Option<i32>,
    lifetime_budget: Option<i32>,
    content_hash: Option<String>,
}

type CampaignTuple = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
    Option<String>,
);

impl From<CampaignTuple> for Campaign {
    fn from(row: CampaignTuple) -> Self {
        Self {
            id: row.0,
            ad_account_id: row.1,
            platform_campaign_id: row.2,
            name: row.3,
            status: row.4,
            objective: row.5,
            daily_budget: row.6,
            lifetime_budget: row.7,
            content_hash: row.8,
        }
    }
}

/// `value` when JavaScript reads it as true (a non-empty string).
fn filled(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// The connection's accounts chosen for sync, or the one with
/// `platform_account_id` among them.
async fn load_selected_accounts(
    db: &PgPool,
    connection_id: &str,
    platform_account_id: Option<&str>,
) -> Result<Vec<Account>, AdsError> {
    use ad_accounts::Column;
    let mut filter = Condition::all()
        .add(Column::ConnectionId.eq(connection_id))
        .add(Column::IsSelected.eq(true))
        .add(Column::DeletedAt.is_null());
    if let Some(platform_account_id) = filled(platform_account_id) {
        filter = filter.add(Column::PlatformAccountId.eq(platform_account_id));
    }
    let rows: Vec<(String, String, Option<String>)> = ad_accounts::Entity::find()
        .select_only()
        .columns([Column::Id, Column::PlatformAccountId, Column::Currency])
        .filter(filter)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, platform_account_id, currency)| Account {
            id,
            platform_account_id,
            currency,
        })
        .collect())
}

/// The live campaigns of `accounts` in `sync_status`, or the one with
/// `platform_campaign_id` among them.
async fn load_campaigns(
    db: &PgPool,
    accounts: &[Account],
    sync_status: AdCampaignSyncStatus,
    platform_campaign_id: Option<&str>,
) -> Result<Vec<Campaign>, AdsError> {
    use ad_campaigns::Column;
    // `ad_account_id = any('{}')` matches nothing.
    if accounts.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();
    let mut filter = Condition::all()
        .add(Column::AdAccountId.is_in(ids))
        .add(Column::SyncStatus.eq(sync_status))
        .add(Column::DeletedAt.is_null());
    if let Some(platform_campaign_id) = filled(platform_campaign_id) {
        filter = filter.add(Column::PlatformCampaignId.eq(platform_campaign_id));
    }
    let rows: Vec<CampaignTuple> = ad_campaigns::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::AdAccountId,
            Column::PlatformCampaignId,
            Column::Name,
            Column::Status,
            Column::Objective,
            Column::DailyBudget,
            Column::LifetimeBudget,
            Column::ContentHash,
        ])
        .filter(filter)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Campaign::from).collect())
}

/// `markCampaignSyncError`.
async fn mark_campaign_sync_error(
    db: &PgPool,
    campaign_id: &str,
    message: &str,
) -> Result<(), AdsError> {
    use ad_campaigns::Column;
    ad_campaigns::Entity::update_many()
        .col_expr(
            Column::SyncStatus,
            Column::SyncStatus.save_as(Expr::val(AdCampaignSyncStatus::Error)),
        )
        .col_expr(Column::SyncError, Expr::value(message.to_owned()))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(campaign_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `applyRemoteCampaignState`: Meta's state onto the campaign, marked synced.
/// What Meta left out stays as it was (Drizzle skips `undefined`).
async fn apply_remote_campaign_state(
    db: &PgPool,
    campaign_id: &str,
    account_currency: Option<&str>,
    remote: &MetaCampaign,
) -> Result<(), AdsError> {
    use ad_campaigns::Column;
    use sea_orm::ExprTrait as _;
    let content_hash = hash_campaign_payload(&CampaignContent::from(remote));
    let now = utc_now();
    let mut update = ad_campaigns::Entity::update_many()
        .col_expr(
            Column::PlatformCampaignId,
            Expr::value(remote.platform_campaign_id.clone()),
        )
        .col_expr(Column::Name, Expr::value(remote.name.clone()));
    // `coalesce($n, column)`: what Meta left out stays.
    if let Some(status) = &remote.status {
        update = update.col_expr(Column::Status, Expr::value(status.clone()));
    }
    if let Some(objective) = &remote.objective {
        update = update.col_expr(Column::Objective, Expr::value(objective.clone()));
    }
    // `$n::integer` of the number's JavaScript text, as before.
    if let Some(budget) = remote.daily_budget {
        update = update.col_expr(
            Column::DailyBudget,
            Expr::val(number_text(budget)).cast_as("integer"),
        );
    }
    if let Some(budget) = remote.lifetime_budget {
        update = update.col_expr(
            Column::LifetimeBudget,
            Expr::val(number_text(budget)).cast_as("integer"),
        );
    }
    if let Some(currency) = account_currency {
        update = update.col_expr(Column::Currency, Expr::value(currency.to_owned()));
    }
    if let Some(metrics) = &remote.metrics {
        update = update
            .col_expr(Column::Metrics, Expr::value(metrics.to_value()))
            .col_expr(Column::MetricsSyncedAt, Expr::value(now));
    }
    update
        .col_expr(Column::ContentHash, Expr::value(content_hash))
        .col_expr(
            Column::SyncStatus,
            Column::SyncStatus.save_as(Expr::val(AdCampaignSyncStatus::Synced)),
        )
        .col_expr(Column::SyncError, Expr::value(None::<String>))
        .col_expr(Column::LastSyncedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(campaign_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `buildCampaignUpdate`: the name always, the rest when set.
fn campaign_changes(campaign: &Campaign) -> CampaignChanges {
    CampaignChanges {
        name: Some(campaign.name.clone()),
        objective: filled(campaign.objective.as_deref()).map(str::to_owned),
        status: filled(campaign.status.as_deref()).map(str::to_owned),
        daily_budget: campaign.daily_budget.map(i64::from),
        lifetime_budget: campaign.lifetime_budget.map(i64::from),
    }
}

/// `pushCampaignToMeta`: create the campaign on Meta when it has no platform
/// id yet, otherwise update it.
async fn push_campaign(
    client: &MetaClient,
    account: &Account,
    campaign: &Campaign,
) -> Result<MetaCampaign, AdsError> {
    if let Some(platform_id) = filled(campaign.platform_campaign_id.as_deref()) {
        return client
            .update_campaign(
                &account.platform_account_id,
                platform_id,
                &campaign_changes(campaign),
            )
            .await;
    }
    let Some(objective) = filled(campaign.objective.as_deref()) else {
        return Err(AdsError::message(
            "Campaign objective is required before syncing",
        ));
    };
    if campaign.daily_budget.is_none() && campaign.lifetime_budget.is_none() {
        return Err(AdsError::message(
            "Campaign budget is required before syncing",
        ));
    }
    client
        .create_campaign(
            &account.platform_account_id,
            &NewCampaign {
                name: campaign.name.clone(),
                objective: objective.to_owned(),
                status: Some(
                    campaign
                        .status
                        .clone()
                        .unwrap_or_else(|| "PAUSED".to_owned()),
                ),
                daily_budget: campaign.daily_budget.map(i64::from),
                lifetime_budget: campaign.lifetime_budget.map(i64::from),
            },
        )
        .await
}

/// `pushPendingCampaigns`: each pending campaign of the selected accounts to
/// Meta; a campaign that fails is marked with the error and counted.
pub async fn push_pending_campaigns(
    db: &PgPool,
    http: &OutboundHttp,
    connection_id: &str,
    access_token: &str,
    platform_account_id: Option<&str>,
) -> Result<(u64, u64), AdsError> {
    let accounts = load_selected_accounts(db, connection_id, platform_account_id).await?;
    if accounts.is_empty() {
        return Ok((0, 0));
    }
    let pending = load_campaigns(db, &accounts, AdCampaignSyncStatus::PendingPush, None).await?;
    let client = MetaClient::new(http.clone(), access_token);
    let (mut pushed, mut failed) = (0, 0);
    for campaign in pending {
        let Some(account) = accounts.iter().find(|a| a.id == campaign.ad_account_id) else {
            continue;
        };
        let outcome = match push_campaign(&client, account, &campaign).await {
            Ok(remote) => {
                apply_remote_campaign_state(db, &campaign.id, account.currency.as_deref(), &remote)
                    .await
            }
            Err(error) => Err(error),
        };
        match outcome {
            Ok(()) => pushed += 1,
            Err(error) => {
                failed += 1;
                mark_campaign_sync_error(db, &campaign.id, &error.to_string()).await?;
            }
        }
    }
    Ok((pushed, failed))
}

/// `pullSyncedCampaigns`: Meta's state of each synced campaign, written when
/// its content hash changed.
pub async fn pull_synced_campaigns(
    db: &PgPool,
    http: &OutboundHttp,
    access_token: &str,
    connection_id: &str,
    platform_account_id: Option<&str>,
    platform_campaign_id: Option<&str>,
) -> Result<u64, AdsError> {
    let accounts = load_selected_accounts(db, connection_id, platform_account_id).await?;
    if accounts.is_empty() {
        return Ok(0);
    }
    let synced = load_campaigns(
        db,
        &accounts,
        AdCampaignSyncStatus::Synced,
        platform_campaign_id,
    )
    .await?;
    let client = MetaClient::new(http.clone(), access_token);
    let mut pulled = 0;
    for campaign in synced {
        let Some(platform_id) = filled(campaign.platform_campaign_id.as_deref()) else {
            continue;
        };
        let Some(account) = accounts.iter().find(|a| a.id == campaign.ad_account_id) else {
            continue;
        };
        let Some(remote) = client
            .get_campaign(&account.platform_account_id, platform_id)
            .await
        else {
            continue;
        };
        let hash = hash_campaign_payload(&CampaignContent::from(&remote));
        if campaign.content_hash.as_deref() == Some(hash.as_str()) {
            continue;
        }
        apply_remote_campaign_state(db, &campaign.id, account.currency.as_deref(), &remote).await?;
        pulled += 1;
    }
    Ok(pulled)
}

/// `syncAdConnection`: pushes, then pulls, as the scope says.
pub async fn sync_ad_connection(
    db: &PgPool,
    http: &OutboundHttp,
    connection_id: &str,
    access_token: &str,
    scope: SyncScope,
    platform_account_id: Option<&str>,
    platform_campaign_id: Option<&str>,
) -> Result<SyncCounts, AdsError> {
    let mut counts = SyncCounts::default();
    if scope.pushes() {
        let (pushed, failed) =
            push_pending_campaigns(db, http, connection_id, access_token, platform_account_id)
                .await?;
        counts.pushed = pushed;
        counts.failed = failed;
    }
    if scope.pulls() {
        counts.pulled = pull_synced_campaigns(
            db,
            http,
            access_token,
            connection_id,
            platform_account_id,
            platform_campaign_id,
        )
        .await?;
    }
    Ok(counts)
}
