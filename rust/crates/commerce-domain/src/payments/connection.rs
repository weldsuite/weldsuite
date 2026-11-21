//! The workspace's connection to Mollie (`commerce_payment_connections`, at
//! most one live row per provider) and its credentials.
//!
//! Tokens and API keys are stored encrypted (`weldsuite_db::crypto`,
//! `*_encrypted` columns) and never leave this module as anything but a
//! ready client. An OAuth access token lasts an hour: [`active`] refreshes it
//! when it is about to expire and [`with_provider`] once more when Mollie
//! answers 401; a refresh Mollie refuses marks the connection `needs_reauth`
//! with the reason in `last_error`.
//!
//! Every function takes the pool and holds a connection for one statement
//! only: the Mollie calls in between hold none.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::{decrypt_field, encrypt_field};
use weldsuite_mollie::Mollie;
use weldsuite_mollie::connect::Tokens;

use super::provider::{MollieProvider, ProviderError};
use super::{Env, Error};

/// A connection as the API shows it: no credentials.
pub const PUBLIC_ROW: &str = "jsonb_build_object('id', id, 'provider', provider, \
    'authMethod', auth_method, 'status', status, 'testmode', testmode, \
    'profileId', profile_id, 'profileName', profile_name, \
    'organizationId', organization_id, 'organizationName', organization_name, \
    'connectedAt', connected_at, 'lastError', last_error)";

/// The live connection row of Mollie, without credentials.
///
/// # Errors
/// A failed statement.
pub async fn row(db: &PgPool) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PUBLIC_ROW} from commerce_payment_connections \
         where provider = 'mollie' and deleted_at is null limit 1"
    )))
    .fetch_optional(db)
    .await
}

/// A client on the connection's credentials.
pub struct Active {
    pub id: String,
    pub auth_method: String,
    pub testmode: bool,
    pub profile_id: Option<String>,
    mollie: Mollie,
}

impl Active {
    /// The Mollie client (for the calls the port does not cover).
    #[must_use]
    pub fn mollie(&self) -> &Mollie {
        &self.mollie
    }
}

struct Stored {
    id: String,
    auth_method: String,
    status: String,
    access: Option<String>,
    refresh: Option<String>,
    api_key: Option<String>,
    testmode: bool,
    profile_id: Option<String>,
    stale: bool,
}

type StoredRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    Option<String>,
    bool,
);

async fn stored(db: &PgPool) -> Result<Option<Stored>, sqlx::Error> {
    let row: Option<StoredRow> = sqlx::query_as(
        "select id, auth_method, status, access_token_encrypted, refresh_token_encrypted, \
           api_key_encrypted, testmode, profile_id, \
           (token_expires_at is null or token_expires_at < (now() at time zone 'utc') + interval '120 seconds') \
         from commerce_payment_connections where provider = 'mollie' and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(
        |(id, auth_method, status, access, refresh, api_key, testmode, profile_id, stale)| Stored {
            id,
            auth_method,
            status,
            access,
            refresh,
            api_key,
            testmode,
            profile_id,
            stale,
        },
    ))
}

fn open(env: &Env<'_>, value: Option<&str>, what: &str) -> Result<String, Error> {
    let value = value.ok_or(Error::NotConnected)?;
    decrypt_field(value, env.keyring).map_err(|error| {
        Error::Credentials(format!("the stored {what} cannot be opened: {error:?}"))
    })
}

fn client(env: &Env<'_>, stored: &Stored, access: &str) -> Mollie {
    let mollie = Mollie::new(env.api_url, access);
    if stored.auth_method == "oauth" {
        let mollie = mollie.with_testmode(stored.testmode);
        match &stored.profile_id {
            Some(profile) => mollie.with_profile(profile),
            None => mollie,
        }
    } else {
        mollie
    }
}

/// The connection's credentials as a client; refreshes an OAuth token that
/// is about to expire.
///
/// # Errors
/// [`Error::NotConnected`] without a usable connection.
pub async fn active(env: &Env<'_>) -> Result<Active, Error> {
    let stored = stored(env.db).await?.ok_or(Error::NotConnected)?;
    if stored.status != "connected" {
        return Err(Error::NotConnected);
    }
    let access = if stored.auth_method == "oauth" {
        if stored.stale || stored.access.is_none() {
            refresh(env, &stored.id).await?
        } else {
            open(env, stored.access.as_deref(), "access token")?
        }
    } else {
        open(env, stored.api_key.as_deref(), "API key")?
    };
    Ok(Active {
        mollie: client(env, &stored, &access),
        id: stored.id,
        auth_method: stored.auth_method,
        testmode: stored.testmode,
        profile_id: stored.profile_id,
    })
}

/// Gets a new access token with the stored refresh token and keeps it.
/// Returns the new access token.
///
/// # Errors
/// [`Error::NotConnected`] when the install has no Connect app or Mollie
/// refuses the refresh token (the connection is then `needs_reauth`).
pub async fn refresh(env: &Env<'_>, id: &str) -> Result<String, Error> {
    let stored = stored(env.db).await?.ok_or(Error::NotConnected)?;
    let Some(app) = env.connect else {
        return Err(Error::NotConnected);
    };
    let refresh_token = open(env, stored.refresh.as_deref(), "refresh token")?;
    match app.refresh(env.http, &refresh_token).await {
        Ok(tokens) => {
            persist_tokens(env, id, &tokens).await?;
            Ok(tokens.access_token)
        }
        Err(error) if error.is_refusal() => {
            mark_needs_reauth(env.db, id, &error.to_string()).await?;
            Err(Error::NotConnected)
        }
        Err(error) => Err(Error::Provider(error.to_string())),
    }
}

/// Stores a token set, encrypted.
///
/// # Errors
/// A failed statement or a missing encryption key.
pub async fn persist_tokens(env: &Env<'_>, id: &str, tokens: &Tokens) -> Result<(), Error> {
    let access = encrypt_field(&tokens.access_token, env.keyring)
        .map_err(|error| Error::Credentials(format!("tokens cannot be encrypted: {error:?}")))?;
    let refresh = tokens
        .refresh_token
        .as_deref()
        .map(|token| encrypt_field(token, env.keyring))
        .transpose()
        .map_err(|error| Error::Credentials(format!("tokens cannot be encrypted: {error:?}")))?;
    sqlx::query(
        "update commerce_payment_connections set access_token_encrypted = $2, \
           refresh_token_encrypted = coalesce($3, refresh_token_encrypted), \
           token_expires_at = (now() at time zone 'utc') + make_interval(secs => $4::double precision), \
           scope = coalesce($5, scope), status = 'connected', last_error = null, \
           updated_at = (now() at time zone 'utc') where id = $1",
    )
    .bind(id)
    .bind(access)
    .bind(refresh)
    .bind(i32::try_from(tokens.expires_in).unwrap_or(3600))
    .bind(tokens.scope.as_deref())
    .execute(env.db)
    .await?;
    Ok(())
}

/// The connection cannot be used until the merchant connects again.
///
/// # Errors
/// A failed statement.
pub async fn mark_needs_reauth(db: &PgPool, id: &str, why: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update commerce_payment_connections set status = 'needs_reauth', last_error = $2, \
           updated_at = (now() at time zone 'utc') where id = $1",
    )
    .bind(id)
    .bind(why.chars().take(500).collect::<String>())
    .execute(db)
    .await?;
    Ok(())
}

/// The connection's provider, ready to call.
pub struct Live<'a> {
    pub id: String,
    /// Made with Mollie Connect: a 401 is answered with a token refresh.
    pub oauth: bool,
    pub provider: MollieProvider<'a>,
}

/// The connection as a provider.
///
/// # Errors
/// [`Error::NotConnected`] without a usable connection.
pub async fn live<'a>(env: &Env<'a>) -> Result<Live<'a>, Error> {
    let active = active(env).await?;
    Ok(Live {
        oauth: active.auth_method == "oauth",
        id: active.id,
        provider: MollieProvider {
            mollie: active.mollie,
            http: env.http,
        },
    })
}

/// A provider on fresh tokens, after the provider answered 401.
///
/// # Errors
/// [`Error::NotConnected`] when the refresh fails.
pub async fn reauthorize<'a>(env: &Env<'a>, live_before: &Live<'a>) -> Result<Live<'a>, Error> {
    refresh(env, &live_before.id).await?;
    live(env).await
}

/// The outcome of provider calls as the domain's: a 401 that survived a
/// refresh marks the connection `needs_reauth`.
///
/// # Errors
/// [`Error::NotConnected`], [`Error::Provider`].
pub async fn conclude<T>(
    env: &Env<'_>,
    live: &Live<'_>,
    result: Result<T, ProviderError>,
) -> Result<T, Error> {
    match result {
        Ok(value) => Ok(value),
        Err(ProviderError::Unauthorized) => {
            mark_needs_reauth(env.db, &live.id, "Mollie does not accept the credentials").await?;
            Err(Error::NotConnected)
        }
        Err(other) => Err(Error::Provider(other.message())),
    }
}

/// Runs a call against the connection's provider: `with_provider!(env,
/// |provider| provider.read_payment(&id))`, once more on fresh tokens when
/// the provider answers 401 on an OAuth token. Evaluates to the call's
/// value, or returns the domain's error from the enclosing function.
macro_rules! with_provider {
    ($env:expr, |$provider:ident| $call:expr) => {{
        let env = $env;
        let mut live = $crate::payments::connection::live(env).await?;
        let mut result = {
            let $provider: &dyn $crate::payments::provider::PaymentProvider = &live.provider;
            $call.await
        };
        if matches!(
            result,
            Err($crate::payments::provider::ProviderError::Unauthorized)
        ) && live.oauth
        {
            live = $crate::payments::connection::reauthorize(env, &live).await?;
            result = {
                let $provider: &dyn $crate::payments::provider::PaymentProvider = &live.provider;
                $call.await
            };
        }
        $crate::payments::connection::conclude(env, &live, result).await?
    }};
}
pub(crate) use with_provider;
