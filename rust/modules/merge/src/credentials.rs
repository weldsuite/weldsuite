//! Provider credentials at rest (`services/credentials.ts`,
//! `credentials-seal.ts`). Connection and member-account tokens are stored
//! as one encrypted JSON blob (`{accessToken, refreshToken?, expiresAt?,
//! tokenType?}`) under the `DATABASE_ENCRYPTION_KEY` keyring, and never leave
//! the backend: no DTO carries them and no entity event does (EVT-005).
//!
//! [`member_token`] and [`connection_token`] decrypt, and refresh first when
//! `expiresAt` is within five minutes: the new credentials replace the stored
//! ones. A refresh the provider refuses marks the connection
//! `needs_attention` (a member account loses its credentials and its
//! `verified_at`, so the member links it again), unless another request
//! renewed the credentials meanwhile: every write is conditional on the
//! sealed credentials this request read.

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, decrypt_field, encrypt_field};
use weldsuite_kit::validation::js_date_parse;

use crate::db::{Row, opt_text, text};
use crate::{MergeError, MergeState, Overrides, now, now_ms, providers};

/// `MergeStoredCredentials`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredCredentials {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) expires_at: Option<String>,
    pub(crate) token_type: Option<String>,
}

impl StoredCredentials {
    /// The JSON the column seals (`JSON.stringify(credentials)`).
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("accessToken".to_owned(), json!(self.access_token));
        if let Some(token) = &self.refresh_token {
            out.insert("refreshToken".to_owned(), json!(token));
        }
        if let Some(at) = &self.expires_at {
            out.insert("expiresAt".to_owned(), json!(at));
        }
        if let Some(kind) = &self.token_type {
            out.insert("tokenType".to_owned(), json!(kind));
        }
        Value::Object(out)
    }

    /// `mergeStoredCredentialsSchema.safeParse(value)`.
    fn from_json(value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        let optional = |key: &str| -> Result<Option<String>, ()> {
            match fields.get(key) {
                None => Ok(None),
                Some(Value::String(text)) => Ok(Some(text.clone())),
                Some(_) => Err(()),
            }
        };
        Some(Self {
            access_token: fields.get("accessToken")?.as_str()?.to_owned(),
            refresh_token: optional("refreshToken").ok()?,
            expires_at: optional("expiresAt").ok()?,
            token_type: optional("tokenType").ok()?,
        })
    }

    /// `credentials.expiresAt ? new Date(credentials.expiresAt) : null`, as
    /// a column value.
    pub(crate) fn expiry(&self) -> Option<String> {
        self.expires_at
            .as_deref()
            .and_then(js_date_parse)
            .and_then(weldsuite_kit::validation::js_iso_from_millis)
    }
}

/// `sealCredentials(env, credentials)`.
pub(crate) fn seal_credentials(
    keyring: &Keyring,
    credentials: &StoredCredentials,
) -> Result<String, MergeError> {
    encrypt_field(&credentials.to_json().to_string(), keyring)
        .map_err(|error| MergeError::Unexpected(error.to_string()))
}

/// `openCredentials(env, sealed)`: `None` when empty or unreadable.
pub(crate) fn open_credentials(
    keyring: &Keyring,
    sealed: Option<&str>,
) -> Option<StoredCredentials> {
    let sealed = sealed.filter(|s| !s.is_empty())?;
    let plain = decrypt_field(sealed, keyring).ok()?;
    let value: Value = serde_json::from_str(&plain).ok()?;
    StoredCredentials::from_json(&value)
}

/// A token is refreshed when it expires within this long.
const REFRESH_WINDOW_MS: f64 = 5.0 * 60.0 * 1000.0;

/// `needsRefresh(credentials, now)`.
pub(crate) fn needs_refresh(credentials: &StoredCredentials, now_ms: f64) -> bool {
    let (Some(_), Some(at)) = (&credentials.refresh_token, &credentials.expires_at) else {
        return false;
    };
    // `new Date(x).getTime() - now < window`: NaN compares false.
    js_date_parse(at).is_some_and(|ms| ms - now_ms < REFRESH_WINDOW_MS)
}

/// A token to use on a provider (`ResolvedToken`).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedToken {
    pub(crate) access_token: String,
    /// The linked account's login, for member tokens.
    #[allow(dead_code)]
    pub(crate) login: Option<String>,
}

/// `refreshedCredentials(env, provider, host, credentials)`: a rotated
/// refresh token replaces the old one, an unchanged one stays.
async fn refreshed(
    state: &MergeState,
    overrides: &Overrides,
    provider: &str,
    host: Option<&str>,
    credentials: &StoredCredentials,
) -> Result<StoredCredentials, MergeError> {
    let http = overrides
        .outbound(state)
        .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))?;
    let env = |name: &str| overrides.env_set(state, name);
    let fresh = providers::refresh(
        provider,
        &http,
        &env,
        credentials.refresh_token.as_deref().unwrap_or_default(),
        host,
    )
    .await?;
    Ok(StoredCredentials {
        refresh_token: fresh
            .refresh_token
            .clone()
            .or_else(|| credentials.refresh_token.clone()),
        ..fresh
    })
}

/// `getMemberToken(db, env, userId, provider, host)`: the member's own token
/// (review and merge run as the member), or `None` without a verified
/// linked account. An Azure DevOps account has no host; a self-managed
/// GitLab one is per host.
///
/// Concurrent refreshes: GitLab and GitHub rotate the refresh token, so of
/// two requests refreshing at once the second is refused. Every write is
/// conditional on the sealed credentials this request read: a refused
/// refresh drops the link only while those are still stored, and otherwise
/// uses what the other request stored. A refresh that succeeds after the
/// other one dropped the link puts it back (credentials and `verified_at`).
#[allow(dead_code)]
pub(crate) async fn member_token(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    user_id: &str,
    provider: &str,
    host: Option<&str>,
) -> Result<Option<ResolvedToken>, MergeError> {
    let host = if provider == "azure_devops" {
        None
    } else {
        Some(host.filter(|h| !h.is_empty()))
    };
    let account: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from merge_provider_accounts a where a.user_id = $1 and a.provider = $2 \
         and (not $3 or (case when $4::text is null then a.host is null else a.host = $4 end)) limit 1",
    )
    .bind(user_id)
    .bind(provider)
    .bind(host.is_some())
    .bind(host.flatten())
    .fetch_optional(db)
    .await?;
    let Some(account) = account.map(weldsuite_db::js_row) else {
        return Ok(None);
    };
    if account.get("verifiedAt").is_none_or(Value::is_null) {
        return Ok(None);
    }
    let keyring = overrides.keyring(state);
    let Some(sealed) = opt_text(&account, "credentials").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(mut credentials) = open_credentials(&keyring, Some(&sealed)) else {
        return Ok(None);
    };
    if needs_refresh(&credentials, now_ms()) {
        let account_host = opt_text(&account, "host");
        match refreshed(
            state,
            overrides,
            provider,
            account_host.as_deref(),
            &credentials,
        )
        .await
        {
            Ok(fresh) => credentials = fresh,
            Err(error) => {
                tracing::error!(?error, provider, "merge: a member token refresh failed");
                let dropped = sqlx::query(
                    "update merge_provider_accounts set credentials = null, credentials_expire_at = null, \
                       verified_at = null, updated_at = $2::timestamptz where id = $1 and credentials = $3",
                )
                .bind(text(&account, "id"))
                .bind(now())
                .bind(&sealed)
                .execute(db)
                .await?;
                if dropped.rows_affected() > 0 {
                    return Ok(None);
                }
                return stored_member_token(db, &keyring, text(&account, "id")).await;
            }
        }
        sqlx::query(
            "update merge_provider_accounts set credentials = $2, credentials_expire_at = $3::timestamptz, \
               verified_at = $4::timestamptz, updated_at = $5::timestamptz \
             where id = $1 and (credentials = $6 or credentials is null)",
        )
        .bind(text(&account, "id"))
        .bind(seal_credentials(&keyring, &credentials)?)
        .bind(credentials.expiry())
        .bind(text(&account, "verifiedAt"))
        .bind(now())
        .bind(&sealed)
        .execute(db)
        .await?;
    }
    Ok(Some(ResolvedToken {
        access_token: credentials.access_token,
        login: opt_text(&account, "login"),
    }))
}

/// `storedMemberToken(db, env, accountId)`: the member token another request
/// stored meanwhile (its refresh won), or `None` when the link is gone.
async fn stored_member_token(
    db: &PgPool,
    keyring: &Keyring,
    account_id: &str,
) -> Result<Option<ResolvedToken>, MergeError> {
    let account: Option<(Option<String>, Option<String>, bool)> = sqlx::query_as(
        "select credentials, login, verified_at is not null from merge_provider_accounts \
         where id = $1 limit 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    let Some((sealed, login, true)) = account else {
        return Ok(None);
    };
    Ok(
        open_credentials(keyring, sealed.as_deref()).map(|credentials| ResolvedToken {
            access_token: credentials.access_token,
            login,
        }),
    )
}

/// `awaitingOrganization(connection)`: a multi-organisation Azure DevOps
/// connection still waiting for the member to choose one
/// (`setAzureOrganization`) stays `needs_attention` until then, whatever a
/// refresh does.
fn awaiting_organization(connection: &Row) -> bool {
    text(connection, "externalAccountId").starts_with("pending:")
}

/// `getConnectionToken(db, env, connection)`: the connection's own token
/// (GitLab, Bitbucket, Azure DevOps). `None` when it stores none, or its
/// refresh failed (the connection is then `needs_attention`). Concurrent
/// refreshes are handled as in [`member_token`]: a refused refresh flags the
/// connection only while the credentials this request read are still
/// stored, and otherwise uses the ones the other request stored.
pub(crate) async fn connection_token(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    connection: &Row,
) -> Result<Option<ResolvedToken>, MergeError> {
    let keyring = overrides.keyring(state);
    let Some(sealed) = opt_text(connection, "credentials").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(mut credentials) = open_credentials(&keyring, Some(&sealed)) else {
        return Ok(None);
    };
    if needs_refresh(&credentials, now_ms()) {
        let provider = text(connection, "provider");
        let host = opt_text(connection, "host");
        match refreshed(state, overrides, provider, host.as_deref(), &credentials).await {
            Ok(fresh) => credentials = fresh,
            Err(error) => {
                tracing::error!(?error, provider, "merge: a connection token refresh failed");
                let flagged = sqlx::query(
                    "update merge_connections set status = 'needs_attention', updated_at = $2::timestamptz \
                     where id = $1 and credentials = $3",
                )
                .bind(text(connection, "id"))
                .bind(now())
                .bind(&sealed)
                .execute(db)
                .await?;
                if flagged.rows_affected() > 0 {
                    return Ok(None);
                }
                return stored_connection_token(db, &keyring, text(connection, "id")).await;
            }
        }
        let status = if text(connection, "status") == "needs_attention"
            && !awaiting_organization(connection)
        {
            "active"
        } else {
            text(connection, "status")
        };
        sqlx::query(
            "update merge_connections set credentials = $2, credentials_expire_at = $3::timestamptz, \
               status = $4, updated_at = $5::timestamptz where id = $1 and credentials = $6",
        )
        .bind(text(connection, "id"))
        .bind(seal_credentials(&keyring, &credentials)?)
        .bind(credentials.expiry())
        .bind(status)
        .bind(now())
        .bind(&sealed)
        .execute(db)
        .await?;
    }
    Ok(Some(ResolvedToken {
        access_token: credentials.access_token,
        login: None,
    }))
}

/// `storedConnectionToken(db, env, connectionId)`: the connection token
/// another request stored meanwhile (its refresh won), or `None`.
async fn stored_connection_token(
    db: &PgPool,
    keyring: &Keyring,
    connection_id: &str,
) -> Result<Option<ResolvedToken>, MergeError> {
    let sealed: Option<Option<String>> =
        sqlx::query_scalar("select credentials from merge_connections where id = $1 limit 1")
            .bind(connection_id)
            .fetch_optional(db)
            .await?;
    Ok(
        open_credentials(keyring, sealed.flatten().as_deref()).map(|credentials| ResolvedToken {
            access_token: credentials.access_token,
            login: None,
        }),
    )
}

/// `adapterContextFor(db, env, connection, memberToken?)`: GitHub acts with
/// the App's installation tokens; the other providers with the connection's
/// stored token, refreshed first when it is about to expire. No usable
/// token is a 409 (`ProviderCredentialsError`).
pub(crate) async fn adapter_context(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    connection: &Row,
    member_token: Option<String>,
) -> Result<providers::AdapterContext, MergeError> {
    let context = |member_token| providers::AdapterContext {
        state: state.clone(),
        overrides: overrides.clone(),
        connection: connection.clone(),
        member_token,
    };
    if member_token.is_some() {
        return Ok(context(member_token));
    }
    let provider = text(connection, "provider");
    if provider == "github" {
        return Ok(context(None));
    }
    match connection_token(db, state, overrides, connection).await? {
        Some(token) => Ok(context(Some(token.access_token))),
        None => Err(MergeError::ProviderCredentials(format!(
            "The {provider} connection needs to be connected again"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring() -> Keyring {
        Keyring {
            v1: Some("ab".repeat(32)),
            v2: None,
        }
    }

    #[test]
    fn seals_and_opens_credentials() {
        let credentials = StoredCredentials {
            access_token: "t".to_owned(),
            refresh_token: Some("r".to_owned()),
            expires_at: Some("2026-11-05T10:00:00.000Z".to_owned()),
            token_type: None,
        };
        let sealed = seal_credentials(&keyring(), &credentials).expect("seal");
        assert_eq!(
            open_credentials(&keyring(), Some(&sealed)),
            Some(credentials)
        );
        assert_eq!(open_credentials(&keyring(), Some("garbage")), None);
        assert_eq!(open_credentials(&keyring(), None), None);
    }

    #[test]
    fn refreshes_within_five_minutes_of_expiry() {
        let at = |iso: &str| StoredCredentials {
            access_token: "t".to_owned(),
            refresh_token: Some("r".to_owned()),
            expires_at: Some(iso.to_owned()),
            token_type: None,
        };
        let now = js_date_parse("2026-11-05T10:00:00.000Z").unwrap_or_default();
        assert!(needs_refresh(&at("2026-11-05T10:04:00.000Z"), now));
        assert!(!needs_refresh(&at("2026-11-05T10:06:00.000Z"), now));
        let mut never = at("2026-11-05T10:00:00.000Z");
        never.refresh_token = None;
        assert!(!needs_refresh(&never, now));
    }
}
