//! Recording a GitHub App installation as a WeldMerge connection
//! (`@weldsuite/merge-domain/installations`, ADR MERGE-002).
//!
//! [`record_github_installation`] upserts the tenant's `merge_connections`
//! row and the master `merge_provider_index` row (`kind = installation`),
//! and answers what changed so the caller publishes `merge_connection`
//! created or updated. merge-api's public setup route
//! (`/public/merge/github/setup`) and WeldConnect's install callback
//! (`GET /api/weldconnect/github/callback`, `rust/modules/connect`) both call
//! it, so the two install paths cannot drift. Removal and suspend/unsuspend
//! go through the same module ([`remove_github_installation_index`],
//! [`release_github_installation_index`], [`set_github_installation_status`]).
//!
//! A member never takes an installation from another workspace: the index
//! row is claimed ([`claim_github_installation_index`]: written, or refreshed
//! when it already names the workspace) before anything else, and a row
//! naming another workspace refuses the recording with
//! [`RecordError::Taken`] (`installation_taken`).
//!
//! Rows are answered as Drizzle reads them (camelCase JSON,
//! `toISOString()` times), with the sealed `webhookSecret` and
//! `credentials` columns in them: never hand a row to a response or an
//! event as it is ([`connection_event_data`] is what an event carries).

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Set};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{Keyring, PgPool, encrypt_field, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::merge_provider_index;
use weldsuite_schema::tenant::merge_connections;

/// What [`record_github_installation`] records.
#[derive(Debug, Clone)]
pub struct GithubInstallation {
    /// The GitHub App installation id.
    pub installation_id: String,
    pub app_slug: String,
    pub account_login: String,
    /// `Organization` / `User` (GitHub's wording) or `organization` / `user`.
    pub account_type: String,
    /// `workspaces.id` (ws_…), ADR SEC-011: what the master index stores.
    pub workspace_id: String,
    /// The member who installed the App.
    pub user_id: String,
    /// `None`: leave the stored scopes alone (a new row stores null).
    pub scopes: Option<Vec<String>>,
    /// `active` (default) or `suspended`.
    pub status: Option<String>,
}

/// What a recording did: the row as it is now and the event to publish.
#[derive(Debug, Clone)]
pub struct RecordedInstallation {
    /// The `merge_connections` row (camelCase JSON).
    pub connection: Value,
    /// `created` or `updated`: the `merge_connection` event's action.
    pub action: &'static str,
}

/// `githubAccountType(accountType)`: `Organization` and `organization` are
/// an organisation; everything else is a user.
pub fn github_account_type(account_type: &str) -> &'static str {
    if account_type.to_lowercase().starts_with("org") {
        "organization"
    } else {
        "user"
    }
}

/// `connectionEventData(row)`: the provider and account login only, never
/// credentials (EVT-005).
pub fn connection_event_data(row: &Value) -> Value {
    let col = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": col("id"),
        "provider": col("provider"),
        "accountLogin": col("accountLogin"),
        "status": col("status"),
    })
}

/// `new Date()` as Drizzle writes it to a `timestamptz` column: UTC, to the
/// millisecond.
fn now() -> OffsetDateTime {
    weldsuite_db::utc_now().assume_utc()
}

/// A `merge_connections` row as Drizzle returns it.
fn connection_json(row: merge_connections::Model) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

/// A fresh 64-hex webhook secret (`randomHex(32)`).
fn random_hex_secret() -> String {
    weldsuite_kit::random_string(64, "0123456789abcdef")
}

/// `findGithubConnections(db, installationId)`: the live GitHub
/// connections of an installation, newest first.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_github_connections(
    tenant: &PgPool,
    installation_id: &str,
) -> Result<Vec<Value>, DbErr> {
    use merge_connections::Column;
    merge_connections::Entity::find()
        .filter(Column::Provider.eq("github"))
        .filter(Column::ExternalAccountId.eq(installation_id))
        .filter(Column::DeletedAt.is_null())
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .all(&orm(tenant))
        .await?
        .into_iter()
        .map(connection_json)
        .collect()
}

/// A new `installation` row of the master index (`github`), written at `now`.
fn index_row(
    installation_id: &str,
    workspace_id: &str,
    now: OffsetDateTime,
) -> merge_provider_index::ActiveModel {
    merge_provider_index::ActiveModel {
        id: Set(generate_id("mpi")),
        provider: Set("github".to_owned()),
        kind: Set("installation".to_owned()),
        external_key: Set(installation_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
    }
}

/// `on conflict (provider, kind, external_key)`.
fn on_index_key() -> OnConflict {
    use merge_provider_index::Column;
    OnConflict::columns([Column::Provider, Column::Kind, Column::ExternalKey])
}

/// `upsertGithubInstallationIndex(masterDb, installationId, workspaceId)`:
/// writes (or re-points) the master `installation id → workspace` row. Only
/// for the webhook receiver's backfill; a member's install goes through
/// [`claim_github_installation_index`], which never re-points.
///
/// # Errors
///
/// The master database fails.
pub async fn upsert_github_installation_index(
    master: &PgPool,
    installation_id: &str,
    workspace_id: &str,
) -> Result<(), DbErr> {
    use merge_provider_index::Column;
    merge_provider_index::Entity::insert(index_row(installation_id, workspace_id, now()))
        .on_conflict(
            on_index_key()
                .update_columns([Column::WorkspaceId, Column::UpdatedAt])
                .to_owned(),
        )
        .exec_without_returning(&orm(master))
        .await?;
    Ok(())
}

/// `claimGithubInstallationIndex(masterDb, installationId, workspaceId)`:
/// inserts the master index row, or refreshes it when it already names that
/// workspace. A row naming another workspace is left as it is: `Ok(false)`.
///
/// # Errors
///
/// The master database fails.
pub async fn claim_github_installation_index(
    master: &PgPool,
    installation_id: &str,
    workspace_id: &str,
) -> Result<bool, DbErr> {
    use merge_provider_index::Column;
    // `do update … where merge_provider_index.workspace_id = excluded.workspace_id`:
    // a row naming another workspace is neither inserted nor updated.
    let claimed = merge_provider_index::Entity::insert(index_row(
        installation_id,
        workspace_id,
        now(),
    ))
    .on_conflict(
        on_index_key()
            .update_column(Column::UpdatedAt)
            .action_and_where(Column::WorkspaceId.eq(workspace_id))
            .to_owned(),
    )
    .exec_without_returning(&orm(master))
    .await?;
    Ok(claimed > 0)
}

/// `releaseGithubInstallationIndex(masterDb, installationId, workspaceId)`:
/// drops the master index row only when it names `workspace_id` (a
/// member's own disconnect).
///
/// # Errors
///
/// The master database fails.
pub async fn release_github_installation_index(
    master: &PgPool,
    installation_id: &str,
    workspace_id: &str,
) -> Result<(), DbErr> {
    use merge_provider_index::Column;
    merge_provider_index::Entity::delete_many()
        .filter(Column::Provider.eq("github"))
        .filter(Column::Kind.eq("installation"))
        .filter(Column::ExternalKey.eq(installation_id))
        .filter(Column::WorkspaceId.eq(workspace_id))
        .exec(&orm(master))
        .await?;
    Ok(())
}

/// `removeGithubInstallationIndex(masterDb, installationId)`: the App was
/// uninstalled, whoever the row names. Only for an uninstall GitHub signed
/// (the `installation` webhook); anything a member starts uses
/// [`release_github_installation_index`].
///
/// # Errors
///
/// The master database fails.
pub async fn remove_github_installation_index(
    master: &PgPool,
    installation_id: &str,
) -> Result<(), DbErr> {
    use merge_provider_index::Column;
    merge_provider_index::Entity::delete_many()
        .filter(Column::Provider.eq("github"))
        .filter(Column::Kind.eq("installation"))
        .filter(Column::ExternalKey.eq(installation_id))
        .exec(&orm(master))
        .await?;
    Ok(())
}

/// A failure of [`record_github_installation`].
#[derive(Debug)]
pub enum RecordError {
    Db(DbErr),
    /// The keyring cannot seal the webhook secret.
    Seal(String),
    /// `GithubInstallationTakenError`: the installation's index row names
    /// another workspace; nothing was written.
    Taken(String),
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(error) => write!(f, "{error}"),
            Self::Seal(error) => write!(f, "{error}"),
            Self::Taken(installation_id) => write!(
                f,
                "GitHub installation {installation_id} belongs to another workspace"
            ),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<DbErr> for RecordError {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

fn seal_secret(keyring: &Keyring) -> Result<String, RecordError> {
    encrypt_field(&random_hex_secret(), keyring)
        .map_err(|error| RecordError::Seal(error.to_string()))
}

/// The refresh of an existing row: account, slug, status, installed now,
/// not revoked; scopes when given; a webhook secret when it had none.
async fn refresh(
    tenant: &PgPool,
    existing: &Value,
    input: &GithubInstallation,
    keyring: &Keyring,
    now: OffsetDateTime,
) -> Result<Value, RecordError> {
    use merge_connections::Column;
    let secret = if existing
        .get("webhookSecret")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        None
    } else {
        Some(seal_secret(keyring)?)
    };
    let mut update = merge_connections::Entity::update_many()
        .col_expr(Column::AppSlug, Expr::value(input.app_slug.clone()))
        .col_expr(Column::AccountLogin, Expr::value(input.account_login.clone()))
        .col_expr(
            Column::AccountType,
            Expr::value(github_account_type(&input.account_type)),
        )
        .col_expr(
            Column::Status,
            Expr::value(input.status.as_deref().unwrap_or("active")),
        )
        .col_expr(Column::InstalledAt, Expr::value(now))
        .col_expr(Column::RevokedAt, Expr::value(Option::<OffsetDateTime>::None))
        .col_expr(Column::UpdatedAt, Expr::value(now));
    // `case when $scopesSent then $scopes else scopes end`.
    if let Some(scopes) = &input.scopes {
        update = update.col_expr(Column::Scopes, Expr::value(json!(scopes)));
    }
    // `coalesce($secret, webhook_secret)`.
    if let Some(secret) = secret {
        update = update.col_expr(Column::WebhookSecret, Expr::value(secret));
    }
    let row = update
        .filter(Column::Id.eq(existing.get("id").and_then(Value::as_str).unwrap_or_default()))
        .exec_with_returning(&orm(tenant))
        .await?
        .into_iter()
        .next()
        // `fetch_one`: the row went away in between.
        .ok_or(DbErr::RecordNotUpdated)?;
    Ok(connection_json(row)?)
}

/// `recordGithubInstallation(tenantDb, masterDb, input)`: claims the
/// installation's row in the master index, then upserts its connection in
/// the tenant database. An existing live row is refreshed (and revived when
/// it was revoked or suspended), keeping its id and webhook secret; a new
/// one gets a fresh random webhook secret, sealed under the keyring.
/// Idempotent.
///
/// # Errors
///
/// [`RecordError::Taken`], writing nothing, when the index row names
/// another workspace; a database fails, or the keyring cannot seal the
/// secret.
pub async fn record_github_installation(
    tenant: &PgPool,
    master: &PgPool,
    keyring: &Keyring,
    input: &GithubInstallation,
) -> Result<RecordedInstallation, RecordError> {
    if !claim_github_installation_index(master, &input.installation_id, &input.workspace_id).await?
    {
        return Err(RecordError::Taken(input.installation_id.clone()));
    }
    let now = now();
    let existing = find_github_connections(tenant, &input.installation_id).await?;
    let (connection, action) = if let Some(existing) = existing.first() {
        (
            refresh(tenant, existing, input, keyring, now).await?,
            "updated",
        )
    } else {
        let id = generate_id("mcn");
        let secret = seal_secret(keyring)?;
        let inserted = merge_connections::Entity::insert(merge_connections::ActiveModel {
            id: Set(id),
            provider: Set("github".to_owned()),
            external_account_id: Set(input.installation_id.clone()),
            app_slug: Set(Some(input.app_slug.clone())),
            account_login: Set(Some(input.account_login.clone())),
            account_type: Set(Some(github_account_type(&input.account_type).to_owned())),
            status: Set(input.status.as_deref().unwrap_or("active").to_owned()),
            installed_at: Set(Some(now)),
            revoked_at: Set(None),
            updated_at: Set(now),
            scopes: Set(input.scopes.as_ref().map(|scopes| json!(scopes))),
            webhook_secret: Set(Some(secret)),
            created_by_user_id: Set(input.user_id.clone()),
            created_at: Set(now),
            ..Default::default()
        })
        .exec_with_returning(&orm(tenant))
        .await;
        match inserted {
            Ok(row) => (connection_json(row)?, "created"),
            Err(error) => {
                // Two installs recorded at once: the other insert won, refresh its row.
                let winner = find_github_connections(tenant, &input.installation_id).await?;
                let Some(winner) = winner.first() else {
                    return Err(error.into());
                };
                (
                    refresh(tenant, winner, input, keyring, now).await?,
                    "updated",
                )
            }
        }
    };
    Ok(RecordedInstallation { connection, action })
}

/// `setGithubInstallationStatus(tenantDb, installationId, status)`: moves
/// every live connection of an installation to `active`, `suspended` or
/// `revoked` (`revoked_at` set for revoked, cleared otherwise); answers the
/// rows as they are now, to publish `merge_connection` updated for each.
///
/// # Errors
///
/// The tenant database fails.
pub async fn set_github_installation_status(
    tenant: &PgPool,
    installation_id: &str,
    status: &str,
) -> Result<Vec<Value>, DbErr> {
    use merge_connections::Column;
    let now = now();
    // `case when $status = 'revoked' then now else null end`.
    let revoked_at = (status == "revoked").then_some(now);
    merge_connections::Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::RevokedAt, Expr::value(revoked_at))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Provider.eq("github"))
        .filter(Column::ExternalAccountId.eq(installation_id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(tenant))
        .await?
        .into_iter()
        .map(connection_json)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account_type_either_way() {
        assert_eq!(github_account_type("Organization"), "organization");
        assert_eq!(github_account_type("organization"), "organization");
        assert_eq!(github_account_type("User"), "user");
        assert_eq!(github_account_type("bot"), "user");
    }

    #[test]
    fn webhook_secrets_are_64_hex_characters() {
        let secret = random_hex_secret();
        assert_eq!(secret.len(), 64);
        assert!(secret.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
