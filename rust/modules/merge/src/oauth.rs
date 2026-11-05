//! OAuth and token connections, and member accounts (`routes/connections/
//! oauth.ts`, `routes/accounts/oauth.ts`, `routes/oauth/index.ts`,
//! `services/oauth/*`):
//!
//! ```text
//!   GET    /connections/:provider/authorize-url?returnTo=  → { url } (gitlab, bitbucket, azure_devops; merge_connections:manage)
//!   POST   /connections/gitlab {host, token}               → a self-managed GitLab connection (merge_connections:manage)
//!   POST   /connections/azure_devops/organization          → choose an Azure DevOps connection's organisation
//!   GET    /accounts/:provider/authorize-url?returnTo=&host= → { url } (all four; merge_pull_requests:read)
//!   POST   /accounts/gitlab-token {host, token}            → link a personal token; the member's accounts
//!   DELETE /accounts/:provider?host=                       → unlink the member's account
//!   POST   /oauth/callback {code, state}                   → { purpose, provider, returnTo, connectionId, accountId, organizations? }
//! ```
//!
//! The OAuth `state` is a random single-use id in the cache
//! (`merge_oauth_state:<id>`, 600 s) holding who started the round trip
//! and what for; the SPA's callback page posts it back with the code, and
//! the state's user and workspace must match the caller. Credentials are
//! stored sealed and never returned; a connection's events carry the
//! provider and account login only, and an account link (per-member UI
//! state) publishes nothing.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::MERGE_CONNECTIONS_MANAGE;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id, random_string};

use crate::accounts::list_accounts;
use crate::connections::{find_connection, repository_count};
use crate::credentials::{StoredCredentials, connection_token, seal_credentials};
use crate::db::{Row, is_unique_violation, text};
use crate::mappers::{connection_dto, connection_event_data};
use crate::providers::http::{Body, bearer, send_request};
use crate::providers::shared::trim_trailing_slashes;
use crate::providers::{self, OAuthUser, PROVIDERS, azure_devops, gitlab};
use crate::{
    Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, now, publish, validate,
    validate_query,
};

/// `MERGE_OAUTH_CONNECTION_PROVIDERS`.
const CONNECTION_PROVIDERS: [&str; 3] = ["gitlab", "bitbucket", "azure_devops"];
/// `MERGE_OAUTH_CALLBACK_PATH`.
const CALLBACK_PATH: &str = "/weldmerge/oauth/callback";
/// `MERGE_OAUTH_STATE_TTL_SECONDS`.
const STATE_TTL_SECONDS: u64 = 600;

fn state_key(id: &str) -> String {
    format!("merge_oauth_state:{id}")
}

/// `redirectUriOf(env)`.
fn redirect_uri(app_url: Option<&str>) -> String {
    format!(
        "{}{CALLBACK_PATH}",
        trim_trailing_slashes(app_url.unwrap_or_default())
    )
}

/// `safeReturnTo(value)`: a same-app relative path, else none.
fn safe_return_to(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty() && v.chars().count() <= 500)?;
    (value.starts_with('/') && !value.starts_with("//") && !value.contains('\\'))
        .then(|| value.to_owned())
}

/// `normalizeGitlabHost(host)`: no trailing slash, lower-case origin;
/// gitlab.com (and no host) is `None` (cloud). `Err` when not a URL.
pub(crate) fn normalize_gitlab_host(host: Option<&str>) -> Result<Option<String>, ()> {
    let Some(host) = host.map(str::trim).filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let url = url::Url::parse(host).map_err(|_| ())?;
    let origin = url.origin().ascii_serialization();
    let normalized = trim_trailing_slashes(&format!("{origin}{}", url.path())).to_owned();
    Ok((normalized != gitlab::GITLAB_COM).then_some(normalized))
}

/// `z.string().url().max(500)`.
fn url_rules() -> Text {
    Text {
        format: Some(Format::Url),
        max: Some(500),
        ..Text::default()
    }
}

// ── State ──────────────────────────────────────────────────────────────────

/// `MergeOauthState`.
struct OAuthState {
    workspace_id: String,
    user_id: String,
    provider: String,
    purpose: String,
    return_to: Option<String>,
}

/// `createOAuthState(kv, state)`: stores it and answers its id.
async fn create_state(
    caller: &Caller,
    state: &MergeState,
    provider: &str,
    purpose: &str,
    return_to: Option<String>,
) -> Result<String, MergeError> {
    let cache = caller
        .overrides
        .cache(state)
        .ok_or_else(|| MergeError::Unexpected("WORKSPACE_CACHE is not bound".to_owned()))?;
    let id = random_string(40, ALPHANUMERIC);
    let value = json!({
        "workspaceId": caller.workspace_id,
        "userId": caller.user_id,
        "provider": provider,
        "purpose": purpose,
        "host": null,
        "returnTo": return_to,
    });
    cache
        .put_boxed(
            &state_key(&id),
            &value.to_string(),
            Some(Duration::from_secs(STATE_TTL_SECONDS)),
        )
        .await
        .map_err(|error| MergeError::Unexpected(error.to_string()))?;
    Ok(id)
}

/// `consumeOAuthState(kv, id)`: reads and removes it (single use); `None`
/// when unknown, expired or unreadable.
async fn consume_state(
    caller: &Caller,
    state: &MergeState,
    id: &str,
) -> Result<Option<OAuthState>, MergeError> {
    let cache = caller
        .overrides
        .cache(state)
        .ok_or_else(|| MergeError::Unexpected("WORKSPACE_CACHE is not bound".to_owned()))?;
    let key = state_key(id);
    let Some(raw) = cache
        .get_boxed(&key)
        .await
        .map_err(|error| MergeError::Unexpected(error.to_string()))?
    else {
        return Ok(None);
    };
    cache
        .delete_boxed(&key)
        .await
        .map_err(|error| MergeError::Unexpected(error.to_string()))?;
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None);
    };
    let string = |key: &str| fields.get(key).and_then(Value::as_str).map(str::to_owned);
    let nullish_ok = |key: &str| {
        fields
            .get(key)
            .is_none_or(|value| value.is_null() || value.is_string())
    };
    let (Some(workspace_id), Some(user_id), Some(provider), Some(purpose)) = (
        string("workspaceId"),
        string("userId"),
        string("provider"),
        string("purpose"),
    ) else {
        return Ok(None);
    };
    if !PROVIDERS.contains(&provider.as_str())
        || !matches!(purpose.as_str(), "connection" | "account")
        || !nullish_ok("host")
        || !nullish_ok("returnTo")
    {
        return Ok(None);
    }
    Ok(Some(OAuthState {
        workspace_id,
        user_id,
        provider,
        purpose,
        return_to: string("returnTo"),
    }))
}

/// `buildAuthorizeUrl(env, input)`: `Ok(None)` for self-managed GitLab,
/// which connects with a token.
async fn build_authorize_url(
    caller: &Caller,
    state: &MergeState,
    provider: &str,
    purpose: &str,
    return_to: Option<&str>,
    host: Option<&str>,
) -> Result<Option<String>, Refusal> {
    let overrides = &caller.overrides;
    let Some(app_url) = overrides.env_set(state, "APP_URL") else {
        return Err(MergeError::ProviderNotConfigured(provider.to_owned()).into());
    };
    if provider == "gitlab" {
        match normalize_gitlab_host(host) {
            Ok(None) => {}
            Ok(Some(_)) => return Ok(None),
            Err(()) => return Err(MergeError::Unexpected("Invalid URL".to_owned()).into()),
        }
    }
    let id = create_state(caller, state, provider, purpose, safe_return_to(return_to)).await?;
    let env = |name: &str| overrides.env_set(state, name);
    Ok(Some(providers::authorize_url(
        provider,
        &env,
        &id,
        &redirect_uri(Some(&app_url)),
    )?))
}

/// The query of an authorize-url route: `returnTo`, and `host` (accounts).
fn authorize_query(query: Option<&str>) -> Result<(Option<String>, Option<String>), Refusal> {
    validate_query(query, |issues, fields| {
        let return_to = issues
            .text_with(
                fields,
                "returnTo",
                Presence::Optional,
                Text::length(None, Some(500)),
            )
            .into_option();
        let host = issues
            .text_with(fields, "host", Presence::Optional, url_rules())
            .into_option();
        (return_to, host)
    })
}

/// `GET /connections/:provider/authorize-url`.
pub(crate) async fn connection_authorize_url(
    State(state): State<MergeState>,
    caller: Caller,
    Path(provider): Path<String>,
    RawQuery(query): RawQuery,
) -> Answer {
    let (return_to, _) = authorize_query(query.as_deref())?;
    if !CONNECTION_PROVIDERS.contains(&provider.as_str()) {
        return Err(Refusal::not_found("Provider", Some(&provider)));
    }
    match build_authorize_url(
        &caller,
        &state,
        &provider,
        "connection",
        return_to.as_deref(),
        None,
    )
    .await?
    {
        Some(url) => Ok(Data(json!({ "url": url })).into_response()),
        None => Err(Refusal::unprocessable(
            "Self-managed GitLab connects with an access token",
        )),
    }
}

/// `GET /accounts/:provider/authorize-url`.
pub(crate) async fn account_authorize_url(
    State(state): State<MergeState>,
    caller: Caller,
    Path(provider): Path<String>,
    RawQuery(query): RawQuery,
) -> Answer {
    let (return_to, host) = authorize_query(query.as_deref())?;
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(Refusal::not_found("Provider", Some(&provider)));
    }
    match build_authorize_url(
        &caller,
        &state,
        &provider,
        "account",
        return_to.as_deref(),
        host.as_deref(),
    )
    .await?
    {
        Some(url) => Ok(Data(json!({ "url": url })).into_response()),
        None => Err(Refusal::unprocessable(
            "Self-managed GitLab links with a personal access token",
        )),
    }
}

// ── Connections ────────────────────────────────────────────────────────────

/// `OAuthConnectionInput`.
struct OAuthConnection {
    provider: &'static str,
    external_account_id: String,
    account_login: Option<String>,
    account_type: Option<String>,
    host: Option<String>,
    oauth_user_login: Option<String>,
    credentials: StoredCredentials,
    status: &'static str,
}

async fn find_live(
    db: &PgPool,
    provider: &str,
    external_account_id: &str,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from merge_connections c where c.provider = $1 \
         and c.external_account_id = $2 and c.deleted_at is null limit 1",
    )
    .bind(provider)
    .bind(external_account_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `upsertOAuthConnection(db, env, input)`: creates the connection, or
/// renews the stored credentials of the one for the same account.
async fn upsert_connection(
    caller: &Caller,
    state: &MergeState,
    input: &OAuthConnection,
) -> Result<(Row, bool), MergeError> {
    let db = &caller.db;
    let sealed = seal_credentials(&caller.overrides.keyring(state), &input.credentials)?;
    let now = now();
    let renew = |existing: Row| {
        let sealed = sealed.clone();
        let now = now.clone();
        async move {
            let row: Value = sqlx::query_scalar(
                "update merge_connections set account_login = $2, account_type = $3, host = $4, status = $5, \
                   credentials = $6, credentials_expire_at = $7::timestamptz, oauth_user_login = $8, \
                   revoked_at = null, updated_at = $9::timestamptz \
                 where id = $1 returning to_jsonb(merge_connections.*)",
            )
            .bind(text(&existing, "id"))
            .bind(&input.account_login)
            .bind(&input.account_type)
            .bind(&input.host)
            .bind(input.status)
            .bind(&sealed)
            .bind(input.credentials.expiry())
            .bind(&input.oauth_user_login)
            .bind(&now)
            .fetch_one(db)
            .await?;
            Ok::<(Row, bool), MergeError>((js_row(row), false))
        }
    };
    if let Some(existing) = find_live(db, input.provider, &input.external_account_id).await? {
        return renew(existing).await;
    }
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into merge_connections (id, provider, external_account_id, created_by_user_id, installed_at, \
           created_at, account_login, account_type, host, status, credentials, credentials_expire_at, \
           oauth_user_login, revoked_at, updated_at) \
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11::timestamptz, $12, \
           null, $5::timestamptz) \
         returning to_jsonb(merge_connections.*)",
    )
    .bind(generate_id("mcn"))
    .bind(input.provider)
    .bind(&input.external_account_id)
    .bind(&caller.user_id)
    .bind(&now)
    .bind(&input.account_login)
    .bind(&input.account_type)
    .bind(&input.host)
    .bind(input.status)
    .bind(&sealed)
    .bind(input.credentials.expiry())
    .bind(&input.oauth_user_login)
    .fetch_one(db)
    .await;
    match inserted {
        Ok(row) => Ok((js_row(row), true)),
        // Two members connected the same account at once: the other insert won.
        Err(error) if is_unique_violation(&error) => {
            match find_live(db, input.provider, &input.external_account_id).await? {
                Some(winner) => renew(winner).await,
                None => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn connection_event(connection: &Row, created: bool) -> PendingEvent {
    PendingEvent::new(
        "merge_connection",
        if created { "created" } else { "updated" },
        text(connection, "id"),
        connection_event_data(connection),
    )
}

// ── Accounts ───────────────────────────────────────────────────────────────

/// `claimAuthoredPullRequests(db, userId, provider, login)`.
async fn claim_authored_pull_requests(
    db: &PgPool,
    user_id: &str,
    provider: &str,
    login: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update merge_pull_requests set author_user_id = null \
         where author_user_id = $1 and provider = $2 and author_login <> $3",
    )
    .bind(user_id)
    .bind(provider)
    .bind(login)
    .execute(db)
    .await?;
    sqlx::query(
        "update merge_pull_requests set author_user_id = $1 \
         where provider = $2 and author_login = $3 and author_user_id is null",
    )
    .bind(user_id)
    .bind(provider)
    .bind(login)
    .execute(db)
    .await?;
    Ok(())
}

/// `linkProviderAccount(db, env, input)`: links (or re-links) the member's
/// account; `None` when another member holds that login on the provider.
async fn link_account(
    caller: &Caller,
    state: &MergeState,
    provider: &str,
    host: Option<&str>,
    user: &OAuthUser,
    credentials: &StoredCredentials,
) -> Result<Option<Row>, MergeError> {
    let db = &caller.db;
    let login = user.login.to_lowercase();
    let holder: Option<String> = sqlx::query_scalar(
        "select user_id from merge_provider_accounts where provider = $1 \
         and (case when $2::text is null then host is null else host = $2 end) and login = $3 limit 1",
    )
    .bind(provider)
    .bind(host)
    .bind(&login)
    .fetch_optional(db)
    .await?;
    if holder.is_some_and(|holder| holder != caller.user_id) {
        return Ok(None);
    }
    let sealed = seal_credentials(&caller.overrides.keyring(state), credentials)?;
    let now = now();
    let mine: Option<String> = sqlx::query_scalar(
        "select id from merge_provider_accounts where user_id = $1 and provider = $2 \
         and (case when $3::text is null then host is null else host = $3 end) limit 1",
    )
    .bind(&caller.user_id)
    .bind(provider)
    .bind(host)
    .fetch_optional(db)
    .await?;
    let written: Result<Value, sqlx::Error> = match mine {
        Some(id) => {
            sqlx::query_scalar(
                "update merge_provider_accounts set login = $2, external_user_id = $3, host = $4, credentials = $5, \
                   credentials_expire_at = $6::timestamptz, verified_at = $7::timestamptz, avatar_url = $8, \
                   display_name = $9, updated_at = $7::timestamptz \
                 where id = $1 returning to_jsonb(merge_provider_accounts.*)",
            )
            .bind(&id)
            .bind(&login)
            .bind(&user.external_id)
            .bind(host)
            .bind(&sealed)
            .bind(credentials.expiry())
            .bind(&now)
            .bind(&user.avatar_url)
            .bind(&user.display_name)
            .fetch_one(db)
            .await
        }
        None => {
            sqlx::query_scalar(
                "insert into merge_provider_accounts (id, user_id, provider, created_at, login, external_user_id, \
                   host, credentials, credentials_expire_at, verified_at, avatar_url, display_name, updated_at) \
                 values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9::timestamptz, $4::timestamptz, $10, $11, \
                   $4::timestamptz) \
                 returning to_jsonb(merge_provider_accounts.*)",
            )
            .bind(generate_id("mpa"))
            .bind(&caller.user_id)
            .bind(provider)
            .bind(&now)
            .bind(&login)
            .bind(&user.external_id)
            .bind(host)
            .bind(&sealed)
            .bind(credentials.expiry())
            .bind(&user.avatar_url)
            .bind(&user.display_name)
            .fetch_one(db)
            .await
        }
    };
    let account = match written {
        Ok(row) => js_row(row),
        Err(error) if is_unique_violation(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match claim_authored_pull_requests(db, &caller.user_id, provider, &login).await {
        Ok(()) => Ok(Some(account)),
        Err(error) if is_unique_violation(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `DELETE /accounts/:provider?host=`.
pub(crate) async fn unlink_account(
    caller: Caller,
    Path(provider): Path<String>,
    RawQuery(query): RawQuery,
) -> Answer {
    let host = validate_query(query.as_deref(), |issues, fields| {
        issues
            .text_with(
                fields,
                "host",
                Presence::Optional,
                Text::length(None, Some(500)),
            )
            .into_option()
    })?;
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(Refusal::not_found("Provider", Some(&provider)));
    }
    let host = if provider == "gitlab" {
        normalize_gitlab_host(host.as_deref())
            .map_err(|()| Refusal::bad_request("host must be a URL"))?
    } else {
        None
    };
    let db = &caller.db;
    let removed: Vec<String> = sqlx::query_scalar(
        "delete from merge_provider_accounts where user_id = $1 and provider = $2 \
         and (case when $3::text is null then host is null else host = $3 end) returning id",
    )
    .bind(&caller.user_id)
    .bind(&provider)
    .bind(&host)
    .fetch_all(db)
    .await?;
    if removed.is_empty() {
        return Err(Refusal::not_found("Account", Some(&provider)));
    }
    sqlx::query(
        "update merge_pull_requests set author_user_id = null where author_user_id = $1 and provider = $2",
    )
    .bind(&caller.user_id)
    .bind(&provider)
    .execute(db)
    .await?;
    Ok(NoContent.into_response())
}

// ── GitLab access tokens ───────────────────────────────────────────────────

/// `validateGitlabToken(host, token)`: `Err(message)` for a host that is
/// not https or a token GitLab refuses.
async fn validate_gitlab_token(
    caller: &Caller,
    state: &MergeState,
    host: &str,
    token: &str,
) -> Result<Result<(Option<String>, OAuthUser), String>, MergeError> {
    let https = url::Url::parse(host).is_ok_and(|url| url.scheme() == "https");
    let (true, Ok(normalized)) = (https, normalize_gitlab_host(Some(host))) else {
        return Ok(Err("The GitLab host must be an https URL".to_owned()));
    };
    let http = caller
        .overrides
        .outbound(state)
        .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))?;
    match gitlab::current_user(&http, normalized.as_deref(), token).await {
        Ok(user) => Ok(Ok((normalized, user))),
        Err(MergeError::ProviderApi {
            status: 401 | 403,
            message,
            ..
        }) => Ok(Err(message)),
        Err(error) => Err(error),
    }
}

/// `externalAccountId(host, user)`: unique per host and GitLab user.
fn token_account_id(host: Option<&str>, user: &OAuthUser) -> String {
    let Some(url) = host.and_then(|h| url::Url::parse(h).ok()) else {
        return user.external_id.clone();
    };
    let authority = match (url.host_str(), url.port()) {
        (Some(name), Some(port)) => format!("{name}:{port}"),
        (Some(name), None) => name.to_owned(),
        _ => String::new(),
    };
    let path = if url.path() == "/" { "" } else { url.path() };
    format!("{authority}{path}:{}", user.external_id)
}

/// `{host, token}` (`mergeGitlabTokenSchema`).
fn gitlab_token_body(headers: &HeaderMap, body: &Bytes) -> Result<(String, String), Refusal> {
    validate(headers, body, |issues, fields| {
        let host = issues
            .text_with(fields, "host", Presence::Required, url_rules())
            .into_option()
            .unwrap_or_default();
        let token = issues
            .text(fields, "token", Presence::Required, Some(1), Some(500))
            .into_option()
            .unwrap_or_default();
        (host, token)
    })
}

fn token_credentials(token: &str) -> StoredCredentials {
    StoredCredentials {
        access_token: token.to_owned(),
        refresh_token: None,
        expires_at: None,
        token_type: Some("Bearer".to_owned()),
    }
}

/// `POST /connections/gitlab {host, token}`.
pub(crate) async fn connect_gitlab_token(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (host, token) = gitlab_token_body(&headers, &body)?;
    let (normalized, user) = match validate_gitlab_token(&caller, &state, &host, &token).await? {
        Ok(valid) => valid,
        Err(message) => return Err(Refusal::unprocessable(&message)),
    };
    let (connection, created) = upsert_connection(
        &caller,
        &state,
        &OAuthConnection {
            provider: "gitlab",
            external_account_id: token_account_id(normalized.as_deref(), &user),
            account_login: Some(user.login.clone()),
            account_type: Some("user".to_owned()),
            host: normalized,
            oauth_user_login: Some(user.login.clone()),
            credentials: token_credentials(&token),
            status: "active",
        },
    )
    .await?;
    publish(
        &state,
        &caller.events,
        vec![connection_event(&connection, created)],
    );
    let dto = connection_dto(
        &connection,
        repository_count(&caller.db, text(&connection, "id")).await?,
    );
    Ok(if created {
        Created(dto).into_response()
    } else {
        Data(dto).into_response()
    })
}

/// `POST /accounts/gitlab-token {host, token}`.
pub(crate) async fn link_gitlab_token(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (host, token) = gitlab_token_body(&headers, &body)?;
    let (normalized, user) = match validate_gitlab_token(&caller, &state, &host, &token).await? {
        Ok(valid) => valid,
        Err(message) => return Err(Refusal::unprocessable(&message)),
    };
    if link_account(
        &caller,
        &state,
        "gitlab",
        normalized.as_deref(),
        &user,
        &token_credentials(&token),
    )
    .await?
    .is_none()
    {
        return Err(Refusal::conflict(
            "This GitLab account is already linked to another member",
        ));
    }
    Ok(Created(list_accounts(&caller.db, &caller.user_id).await?).into_response())
}

// ── Azure DevOps organisation ──────────────────────────────────────────────

/// `POST /connections/azure_devops/organization {connectionId, organization}`.
pub(crate) async fn azure_organization(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (connection_id, organization) = validate(&headers, &body, |issues, fields| {
        let id = issues
            .text(fields, "connectionId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        let organization = issues
            .text_with(
                fields,
                "organization",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option()
            .unwrap_or_default();
        (id, organization)
    })?;
    let db = &caller.db;
    let connection = find_connection(db, &connection_id)
        .await?
        .filter(|c| text(c, "provider") == "azure_devops");
    let Some(connection) = connection else {
        return Err(Refusal::not_found("Connection", Some(&connection_id)));
    };
    let not_accessible = || {
        Refusal::unprocessable(
            "Azure DevOps does not give this account access to that organisation",
        )
    };
    let organization_taken = || Refusal::conflict("This organisation is already connected");
    let name = weldsuite_kit::validation::js_trim(&organization).to_owned();
    let url = format!(
        "https://dev.azure.com/{}",
        crate::github_client::encode_uri_component(&name)
    );
    let Some(token) = connection_token(db, &state, &caller.overrides, &connection).await? else {
        return Err(not_accessible());
    };
    let http = caller
        .overrides
        .outbound(&state)
        .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))?;
    match send_request(
        &http,
        "azure_devops",
        "GET",
        &format!("{url}/_apis/projects?$top=1&api-version=7.1"),
        &bearer(&token.access_token),
        Body::None,
    )
    .await
    {
        Ok(_) => {}
        Err(error) if error.is_status(&[401, 403, 404]) => return Err(not_accessible()),
        Err(error) => return Err(error.into()),
    }
    if let Some(clash) = find_live(db, "azure_devops", &name).await?
        && text(&clash, "id") != text(&connection, "id")
    {
        return Err(organization_taken());
    }
    let updated: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "update merge_connections set external_account_id = $2, account_login = $2, account_type = 'organization', \
           host = $3, status = 'active', updated_at = $4::timestamptz \
         where id = $1 returning to_jsonb(merge_connections.*)",
    )
    .bind(text(&connection, "id"))
    .bind(&name)
    .bind(&url)
    .bind(now())
    .fetch_one(db)
    .await;
    let updated = match updated {
        Ok(row) => js_row(row),
        Err(error) if is_unique_violation(&error) => return Err(organization_taken()),
        Err(error) => return Err(error.into()),
    };
    publish(
        &state,
        &caller.events,
        vec![connection_event(&updated, false)],
    );
    Ok(Data(connection_dto(
        &updated,
        repository_count(db, text(&updated, "id")).await?,
    ))
    .into_response())
}

// ── The callback ───────────────────────────────────────────────────────────

/// `POST /oauth/callback {code, state}`.
pub(crate) async fn callback(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (code, state_id) = validate(&headers, &body, |issues, fields| {
        (
            issues
                .text(fields, "code", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default(),
            issues
                .text(fields, "state", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default(),
        )
    })?;
    let can_connect = caller.can(MERGE_CONNECTIONS_MANAGE);
    let Some(oauth) = consume_state(&caller, &state, &state_id).await? else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_state",
            "This sign-in link expired or was already used: start again",
        )
        .into());
    };
    let not_yours = || Refusal::forbidden("This sign-in was not started by you in this workspace");
    if oauth.user_id != caller.user_id || oauth.workspace_id != caller.workspace_id {
        return Err(not_yours());
    }
    if oauth.purpose == "connection" && !can_connect {
        return Err(not_yours());
    }
    let overrides = &caller.overrides;
    let http = overrides
        .outbound(&state)
        .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))?;
    let env = |name: &str| overrides.env_set(&state, name);
    let redirect = redirect_uri(overrides.env_set(&state, "APP_URL").as_deref());
    let credentials =
        providers::exchange_code(&oauth.provider, &http, &env, &code, &redirect).await?;
    let user = providers::current_user(&oauth.provider, &http, &credentials.access_token).await?;

    let mut result = Map::new();
    result.insert("purpose".to_owned(), json!(oauth.purpose));
    result.insert("provider".to_owned(), json!(oauth.provider));
    result.insert("returnTo".to_owned(), json!(oauth.return_to));

    if oauth.purpose == "account" {
        let Some(account) =
            link_account(&caller, &state, &oauth.provider, None, &user, &credentials).await?
        else {
            return Err(Refusal::conflict(
                "This provider account is already linked to another member",
            ));
        };
        result.insert("connectionId".to_owned(), Value::Null);
        result.insert("accountId".to_owned(), account["id"].clone());
        return Ok(Data(Value::Object(result)).into_response());
    }

    let (connection, created, organizations) = match oauth.provider.as_str() {
        "azure_devops" => {
            let organizations = azure_devops::list_organizations(
                &http,
                &credentials.access_token,
                &user.external_id,
            )
            .await?;
            if organizations.is_empty() {
                return Err(Refusal::unprocessable(
                    "This Azure DevOps account does not belong to any organisation",
                ));
            }
            let only = (organizations.len() == 1).then(|| organizations[0].clone());
            let (connection, created) = upsert_connection(
                &caller,
                &state,
                &OAuthConnection {
                    provider: "azure_devops",
                    external_account_id: only.as_ref().map_or_else(
                        || format!("pending:{}", user.external_id),
                        |(name, _)| name.clone(),
                    ),
                    account_login: Some(
                        only.as_ref()
                            .map_or_else(|| user.login.clone(), |(name, _)| name.clone()),
                    ),
                    account_type: Some(
                        if only.is_some() {
                            "organization"
                        } else {
                            "user"
                        }
                        .to_owned(),
                    ),
                    host: only.as_ref().map(|(_, url)| url.clone()),
                    oauth_user_login: Some(user.login.clone()),
                    credentials,
                    status: if only.is_some() {
                        "active"
                    } else {
                        "needs_attention"
                    },
                },
            )
            .await?;
            let options = only.is_none().then(|| {
                organizations
                    .iter()
                    .map(|(name, url)| json!({ "name": name, "url": url }))
                    .collect::<Vec<_>>()
            });
            (connection, created, options)
        }
        "gitlab" | "bitbucket" => {
            let provider = if oauth.provider == "gitlab" {
                "gitlab"
            } else {
                "bitbucket"
            };
            let (connection, created) = upsert_connection(
                &caller,
                &state,
                &OAuthConnection {
                    provider,
                    external_account_id: user.external_id.clone(),
                    account_login: Some(user.login.clone()),
                    account_type: Some("user".to_owned()),
                    host: None,
                    oauth_user_login: Some(user.login.clone()),
                    credentials,
                    status: "active",
                },
            )
            .await?;
            (connection, created, None)
        }
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_state",
                "This sign-in link expired or was already used: start again",
            )
            .into());
        }
    };
    publish(
        &state,
        &caller.events,
        vec![connection_event(&connection, created)],
    );
    result.insert("connectionId".to_owned(), connection["id"].clone());
    result.insert("accountId".to_owned(), Value::Null);
    if let Some(options) = organizations {
        result.insert("organizations".to_owned(), Value::Array(options));
    }
    Ok(Data(Value::Object(result)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_gitlab_hosts() {
        assert_eq!(normalize_gitlab_host(Some("https://gitlab.com/")), Ok(None));
        assert_eq!(normalize_gitlab_host(None), Ok(None));
        assert_eq!(
            normalize_gitlab_host(Some(" https://Git.Example.com/gitlab/ ")),
            Ok(Some("https://git.example.com/gitlab".to_owned()))
        );
        assert_eq!(normalize_gitlab_host(Some("not a url")), Err(()));
    }

    #[test]
    fn token_accounts_are_per_host() {
        let user = OAuthUser {
            external_id: "7".to_owned(),
            login: "a".to_owned(),
            display_name: None,
            avatar_url: None,
        };
        assert_eq!(token_account_id(None, &user), "7");
        assert_eq!(
            token_account_id(Some("https://git.example.com"), &user),
            "git.example.com:7"
        );
        assert_eq!(
            token_account_id(Some("https://git.example.com:8443/gl"), &user),
            "git.example.com:8443/gl:7"
        );
    }

    #[test]
    fn keeps_same_app_return_paths() {
        assert_eq!(
            safe_return_to(Some("/weldmerge")).as_deref(),
            Some("/weldmerge")
        );
        assert_eq!(safe_return_to(Some("//evil")), None);
        assert_eq!(safe_return_to(Some("https://evil")), None);
    }
}
