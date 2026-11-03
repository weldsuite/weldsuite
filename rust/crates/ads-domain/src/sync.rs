//! A connection's sync (`@weldsuite/ads-domain/sync`): its OAuth tokens,
//! the ad accounts it reaches, which of them sync, and the sync itself.

use serde_json::{Value, json};
use weldsuite_db::{DecryptError, EncryptError, Keyring, PgPool, decrypt_field, encrypt_field};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::campaigns::{SyncScope, sync_ad_connection};
use crate::meta::MetaClient;
use crate::sync_index::{
    SyncIndexEntry, touch_ad_sync_index_after_metrics_sync, upsert_ad_sync_index,
};
use crate::{AdsError, now};

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
    let remote_accounts = MetaClient::new(http.clone(), access_token)
        .list_ad_accounts()
        .await?;
    let now = now();
    for remote in remote_accounts {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from ad_accounts
             where connection_id = $1 and platform_account_id = $2 and deleted_at is null
             limit 1",
        )
        .bind(connection_id)
        .bind(&remote.platform_account_id)
        .fetch_optional(db)
        .await?;
        if let Some(id) = existing {
            sqlx::query(
                "update ad_accounts set
                     name = $2,
                     currency = coalesce($3, currency),
                     timezone = coalesce($4, timezone),
                     status = coalesce($5, status),
                     updated_at = $6::timestamp
                 where id = $1",
            )
            .bind(&id)
            .bind(&remote.name)
            .bind(remote.currency.as_deref())
            .bind(remote.timezone.as_deref())
            .bind(remote.status.as_deref())
            .bind(&now)
            .execute(db)
            .await?;
            continue;
        }
        sqlx::query(
            "insert into ad_accounts
                 (id, connection_id, platform_account_id, name, currency, timezone, status,
                  is_selected, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, false, $8::timestamp, $8::timestamp)",
        )
        .bind(generate_id("adac"))
        .bind(connection_id)
        .bind(&remote.platform_account_id)
        .bind(&remote.name)
        .bind(remote.currency.as_deref())
        .bind(remote.timezone.as_deref())
        .bind(remote.status.as_deref())
        .bind(&now)
        .execute(db)
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
    let now = now();
    sqlx::query(
        "update ad_platform_connections
         set last_sync_at = $2::timestamp, updated_at = $2::timestamp, last_error = null
         where id = $1",
    )
    .bind(connection_id)
    .bind(&now)
    .execute(target.db)
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
    sqlx::query(
        "update ad_accounts set is_selected = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(selection.account_id)
    .bind(selection.is_selected)
    .bind(now())
    .execute(db)
    .await?;
    let selected: i64 = sqlx::query_scalar(
        "select count(*)::bigint from ad_accounts
         where connection_id = $1 and is_selected = true and deleted_at is null",
    )
    .bind(selection.connection_id)
    .fetch_one(db)
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
    let account_ids: Vec<String> = sqlx::query_scalar(
        "select id from ad_accounts where connection_id = $1 and deleted_at is null",
    )
    .bind(connection_id)
    .fetch_all(db)
    .await?;
    let now = now();
    if !account_ids.is_empty() {
        sqlx::query(
            "update ad_campaigns set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where ad_account_id = any($1) and deleted_at is null",
        )
        .bind(&account_ids)
        .bind(&now)
        .execute(db)
        .await?;
    }
    sqlx::query(
        "update ad_accounts
         set deleted_at = $2::timestamp, updated_at = $2::timestamp, is_selected = false
         where connection_id = $1 and deleted_at is null",
    )
    .bind(connection_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}
