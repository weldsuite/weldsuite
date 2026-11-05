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
//! [`set_github_installation_status`]).
//!
//! Rows are answered as Drizzle reads them (camelCase JSON,
//! `toISOString()` times), with the sealed `webhookSecret` and
//! `credentials` columns in them: never hand a row to a response or an
//! event as it is ([`connection_event_data`] is what an event carries).

use serde_json::{Value, json};
use weldsuite_db::{Keyring, PgPool, encrypt_field, js_row};
use weldsuite_kit::generate_id;

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

/// `new Date()` as Drizzle writes it: UTC with milliseconds.
fn now() -> String {
    weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())
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
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from merge_connections c where c.provider = 'github' \
         and c.external_account_id = $1 and c.deleted_at is null \
         order by c.created_at desc, c.id desc",
    )
    .bind(installation_id)
    .fetch_all(tenant)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `upsertGithubInstallationIndex(masterDb, installationId, workspaceId)`:
/// writes (or re-points) the master `installation id → workspace` row.
///
/// # Errors
///
/// The master database fails.
pub async fn upsert_github_installation_index(
    master: &PgPool,
    installation_id: &str,
    workspace_id: &str,
) -> Result<(), sqlx::Error> {
    let now = now();
    sqlx::query(
        "insert into merge_provider_index (id, provider, kind, external_key, workspace_id, created_at, updated_at) \
         values ($1, 'github', 'installation', $2, $3, $4::timestamptz, $4::timestamptz) \
         on conflict (provider, kind, external_key) do update set workspace_id = excluded.workspace_id, \
           updated_at = excluded.updated_at",
    )
    .bind(generate_id("mpi"))
    .bind(installation_id)
    .bind(workspace_id)
    .bind(&now)
    .execute(master)
    .await?;
    Ok(())
}

/// `removeGithubInstallationIndex(masterDb, installationId)`: the App was
/// uninstalled.
///
/// # Errors
///
/// The master database fails.
pub async fn remove_github_installation_index(
    master: &PgPool,
    installation_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from merge_provider_index where provider = 'github' and kind = 'installation' \
         and external_key = $1",
    )
    .bind(installation_id)
    .execute(master)
    .await?;
    Ok(())
}

/// A failure of [`record_github_installation`].
#[derive(Debug)]
pub enum RecordError {
    Db(sqlx::Error),
    /// The keyring cannot seal the webhook secret.
    Seal(String),
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(error) => write!(f, "{error}"),
            Self::Seal(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<sqlx::Error> for RecordError {
    fn from(error: sqlx::Error) -> Self {
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
    now: &str,
) -> Result<Value, RecordError> {
    let secret = if existing
        .get("webhookSecret")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        None
    } else {
        Some(seal_secret(keyring)?)
    };
    let row: Value = sqlx::query_scalar(
        "update merge_connections set app_slug = $2, account_login = $3, account_type = $4, status = $5, \
           installed_at = $6::timestamptz, revoked_at = null, updated_at = $6::timestamptz, \
           scopes = case when $7 then $8::jsonb else scopes end, \
           webhook_secret = coalesce($9, webhook_secret) \
         where id = $1 returning to_jsonb(merge_connections.*)",
    )
    .bind(existing.get("id").and_then(Value::as_str).unwrap_or_default())
    .bind(&input.app_slug)
    .bind(&input.account_login)
    .bind(github_account_type(&input.account_type))
    .bind(input.status.as_deref().unwrap_or("active"))
    .bind(now)
    .bind(input.scopes.is_some())
    .bind(input.scopes.as_ref().map(|scopes| json!(scopes)))
    .bind(secret)
    .fetch_one(tenant)
    .await?;
    Ok(js_row(row))
}

/// `recordGithubInstallation(tenantDb, masterDb, input)`: upserts the
/// installation's connection in the tenant database and its row in the
/// master index. An existing live row is refreshed (and revived when it
/// was revoked or suspended), keeping its id and webhook secret; a new one
/// gets a fresh random webhook secret, sealed under the keyring. Idempotent.
///
/// # Errors
///
/// A database fails, or the keyring cannot seal the secret.
pub async fn record_github_installation(
    tenant: &PgPool,
    master: &PgPool,
    keyring: &Keyring,
    input: &GithubInstallation,
) -> Result<RecordedInstallation, RecordError> {
    let now = now();
    let existing = find_github_connections(tenant, &input.installation_id).await?;
    let (connection, action) = if let Some(existing) = existing.first() {
        (
            refresh(tenant, existing, input, keyring, &now).await?,
            "updated",
        )
    } else {
        let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
            "insert into merge_connections (id, provider, external_account_id, app_slug, account_login, \
               account_type, status, installed_at, revoked_at, updated_at, scopes, webhook_secret, \
               created_by_user_id, created_at) \
             values ($1, 'github', $2, $3, $4, $5, $6, $7::timestamptz, null, $7::timestamptz, $8::jsonb, $9, \
               $10, $7::timestamptz) \
             returning to_jsonb(merge_connections.*)",
        )
        .bind(generate_id("mcn"))
        .bind(&input.installation_id)
        .bind(&input.app_slug)
        .bind(&input.account_login)
        .bind(github_account_type(&input.account_type))
        .bind(input.status.as_deref().unwrap_or("active"))
        .bind(&now)
        .bind(input.scopes.as_ref().map(|scopes| json!(scopes)))
        .bind(seal_secret(keyring)?)
        .bind(&input.user_id)
        .fetch_one(tenant)
        .await;
        match inserted {
            Ok(row) => (js_row(row), "created"),
            Err(error) => {
                // Two installs recorded at once: the other insert won, refresh its row.
                let winner = find_github_connections(tenant, &input.installation_id).await?;
                let Some(winner) = winner.first() else {
                    return Err(error.into());
                };
                (
                    refresh(tenant, winner, input, keyring, &now).await?,
                    "updated",
                )
            }
        }
    };
    upsert_github_installation_index(master, &input.installation_id, &input.workspace_id).await?;
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
) -> Result<Vec<Value>, sqlx::Error> {
    let now = now();
    let rows: Vec<Value> = sqlx::query_scalar(
        "update merge_connections set status = $2, \
           revoked_at = case when $2 = 'revoked' then $3::timestamptz else null end, \
           updated_at = $3::timestamptz \
         where provider = 'github' and external_account_id = $1 and deleted_at is null \
         returning to_jsonb(merge_connections.*)",
    )
    .bind(installation_id)
    .bind(status)
    .bind(&now)
    .fetch_all(tenant)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
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
