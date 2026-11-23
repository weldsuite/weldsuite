//! A connection's sync (`@weldsuite/ads-domain/sync`): its OAuth tokens,
//! the ad accounts it reaches, which of them sync, and the sync itself.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{
    DecryptError, EncryptError, Keyring, PgPool, decrypt_field, encrypt_field, orm, utc_now,
};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{ad_accounts, ad_campaigns, ad_platform_connections};

use crate::AdsError;
use crate::campaigns::{SyncScope, sync_ad_connection};
use crate::meta::MetaClient;
use crate::sync_index::{
    SyncIndexEntry, touch_ad_sync_index_after_metrics_sync, upsert_ad_sync_index,
};

/// `decryptAccessToken(encrypted, keyring)`: `None` for a missing or empty
/// token.
pub fn decrypt_access_token(
    encrypted: Option<&str>,
    keyring: &Keyring,
) -> Result<Option<String>, DecryptError> {
    match encrypted {
        None | Some("") => Ok(None),
        Some(value) => decrypt_field(value, keyring).map(Some),
    }
}

/// `encryptOAuthTokens(accessToken, keyring)`: the `oauth_tokens` value.
pub fn encrypt_oauth_tokens(access_token: &str, keyring: &Keyring) -> Result<Value, AdsError> {
    let sealed = encrypt_field(access_token, keyring).map_err(|error| match error {
        EncryptError::NoKey => AdsError::message("encryptField: keyring has no keys"),
        other => AdsError::message(other.to_string()),
    })?;
    Ok(json!({ "accessToken": sealed, "tokenType": "bearer" }))
}

/// `stripConnectionSecrets(row)`: the row without its tokens.
pub fn strip_connection_secrets(mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        fields.remove("oauthTokens");
    }
    row
}

/// `discoverAdAccounts`: the accounts the token reaches, added to the
/// connection (unselected) or refreshed. What Meta leaves out of a known
/// account stays as it was.
pub async fn discover_ad_accounts(
    db: &PgPool,
    http: &OutboundHttp,
    connection_id: &str,
    access_token: &str,
) -> Result<(), AdsError> {
    use ad_accounts::Column;
    let remote_accounts = MetaClient::new(http.clone(), access_token)
        .list_ad_accounts()
        .await?;
    let now = utc_now();
    let db = orm(db);
    for remote in remote_accounts {
        let existing: Option<String> = ad_accounts::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::ConnectionId.eq(connection_id))
            .filter(Column::PlatformAccountId.eq(remote.platform_account_id.as_str()))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&db)
            .await?;
        if let Some(id) = existing {
            let mut update = ad_accounts::Entity::update_many()
                .col_expr(Column::Name, Expr::value(remote.name.clone()));
            // `coalesce($n, column)`: what Meta left out stays.
            if let Some(currency) = &remote.currency {
                update = update.col_expr(Column::Currency, Expr::value(currency.clone()));
            }
            if let Some(timezone) = &remote.timezone {
                update = update.col_expr(Column::Timezone, Expr::value(timezone.clone()));
            }
            if let Some(status) = &remote.status {
                update = update.col_expr(Column::Status, Expr::value(status.clone()));
            }
            update
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id))
                .exec(&db)
                .await?;
            continue;
        }
        ad_accounts::Entity::insert(ad_accounts::ActiveModel {
            id: Set(generate_id("adac")),
            connection_id: Set(connection_id.to_owned()),
            platform_account_id: Set(remote.platform_account_id.clone()),
            name: Set(remote.name.clone()),
            currency: Set(remote.currency.clone()),
            timezone: Set(remote.timezone.clone()),
            status: Set(remote.status.clone()),
            is_selected: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
    }
    Ok(())
}

/// What `syncSelectedAccounts` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncResult {
    pub synced_campaigns: u64,
    pub written_campaigns: u64,
    pub pushed: u64,
    pub failed: u64,
    pub pulled: u64,
}

impl SyncResult {
    /// The route's `data`.
    pub fn to_json(self) -> Value {
        json!({
            "syncedCampaigns": self.synced_campaigns,
            "writtenCampaigns": self.written_campaigns,
            "pushed": self.pushed,
            "failed": self.failed,
            "pulled": self.pulled,
        })
    }
}

/// Where a sync runs: the tenant database, the master database (the sync
/// index) and Meta.
#[derive(Clone, Copy)]
pub struct SyncTarget<'a> {
    pub db: &'a PgPool,
    pub master: Option<&'a PgPool>,
    pub http: &'a OutboundHttp,
}

/// `syncSelectedAccounts`: sync the connection, stamp it, and after a pull
/// put its next metrics pull six hours out.
#[allow(clippy::too_many_arguments)]
pub async fn sync_selected_accounts(
    target: SyncTarget<'_>,
    connection_id: &str,
    access_token: &str,
    workspace_id: &str,
    scope: SyncScope,
    platform_account_id: Option<&str>,
    platform_campaign_id: Option<&str>,
) -> Result<SyncResult, AdsError> {
    let counts = sync_ad_connection(
        target.db,
        target.http,
        connection_id,
        access_token,
        scope,
        platform_account_id,
        platform_campaign_id,
    )
    .await?;
    let now = utc_now();
    ad_platform_connections::Entity::update_many()
        .col_expr(
            ad_platform_connections::Column::LastSyncAt,
            Expr::value(now),
        )
        .col_expr(ad_platform_connections::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            ad_platform_connections::Column::LastError,
            Expr::value(None::<String>),
        )
        .filter(ad_platform_connections::Column::Id.eq(connection_id))
        .exec(&orm(target.db))
        .await?;
    if matches!(scope, SyncScope::Pull | SyncScope::Full) {
        touch_ad_sync_index_after_metrics_sync(target.master, workspace_id, connection_id).await?;
    }
    let written = counts.pushed + counts.pulled;
    Ok(SyncResult {
        synced_campaigns: written,
        written_campaigns: written,
        pushed: counts.pushed,
        failed: counts.failed,
        pulled: counts.pulled,
    })
}

/// Which account of which connection to (un)select, for whom.
#[derive(Debug, Clone, Copy)]
pub struct AccountSelection<'a> {
    pub account_id: &'a str,
    pub is_selected: bool,
    pub workspace_id: &'a str,
    pub clerk_org_id: &'a str,
    pub connection_id: &'a str,
}

/// `setAccountSelection`: (un)select the account, and enable the connection
/// in the sync index while any of its accounts is selected.
pub async fn set_account_selection(
    db: &PgPool,
    master: Option<&PgPool>,
    selection: AccountSelection<'_>,
) -> Result<(), AdsError> {
    use ad_accounts::Column;
    let db = orm(db);
    ad_accounts::Entity::update_many()
        .col_expr(Column::IsSelected, Expr::value(selection.is_selected))
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(selection.account_id))
        .exec(&db)
        .await?;
    let selected = ad_accounts::Entity::find()
        .filter(Column::ConnectionId.eq(selection.connection_id))
        .filter(Column::IsSelected.eq(true))
        .filter(Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    upsert_ad_sync_index(
        master,
        &SyncIndexEntry {
            workspace_id: selection.workspace_id,
            connection_id: selection.connection_id,
            clerk_org_id: selection.clerk_org_id,
            is_enabled: selected > 0,
            metrics_interval_hours: None,
            webhook_subscribed_at: None,
        },
    )
    .await
}

/// `cleanupConnectionMappings`: a disconnected connection's campaigns and
/// accounts are deleted (soft), its accounts unselected.
pub async fn cleanup_connection_mappings(db: &PgPool, connection_id: &str) -> Result<(), AdsError> {
    use ad_accounts::Column;
    let db = orm(db);
    let account_ids: Vec<String> = ad_accounts::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::ConnectionId.eq(connection_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    let now = utc_now();
    if !account_ids.is_empty() {
        ad_campaigns::Entity::update_many()
            .col_expr(ad_campaigns::Column::DeletedAt, Expr::value(now))
            .col_expr(ad_campaigns::Column::UpdatedAt, Expr::value(now))
            .filter(ad_campaigns::Column::AdAccountId.is_in(account_ids))
            .filter(ad_campaigns::Column::DeletedAt.is_null())
            .exec(&db)
            .await?;
    }
    ad_accounts::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::IsSelected, Expr::value(false))
        .filter(Column::ConnectionId.eq(connection_id))
        .filter(Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    Ok(())
}
