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
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::MERGE_CONNECTIONS_MANAGE;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id, random_string};
use weldsuite_schema::tenant::{merge_connections, merge_provider_accounts, merge_pull_requests};

use crate::accounts::list_accounts;
use crate::connections::{connection_row, find_connection, repository_count};
use crate::credentials::{StoredCredentials, connection_token, seal_credentials};
use crate::db::{Row, instant_opt, is_unique_violation, json_row, now_at, same_or_null, text};
use crate::mappers::{connection_dto, connection_event_data};
use crate::providers::http::{Body, bearer, send_request};
use crate::providers::shared::trim_trailing_slashes;
use crate::providers::{self, OAuthUser, PROVIDERS, azure_devops, gitlab};
use crate::{
    Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, publish, validate,
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
) -> Result<Option<Row>, DbErr> {
    merge_connections::Entity::find()
        .filter(merge_connections::Column::Provider.eq(provider))
        .filter(merge_connections::Column::ExternalAccountId.eq(external_account_id))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(connection_row)
        .transpose()
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
    let (_, at) = now_at();
    let expires = instant_opt(input.credentials.expiry().as_deref())?;
    let renew = |existing: Row| {
        let sealed = sealed.clone();
        async move {
            let row = merge_connections::ActiveModel {
                id: Unchanged(text(&existing, "id").to_owned()),
                account_login: Set(input.account_login.clone()),
                account_type: Set(input.account_type.clone()),
                host: Set(input.host.clone()),
                status: Set(input.status.to_owned()),
                credentials: Set(Some(sealed)),
                credentials_expire_at: Set(expires),
                oauth_user_login: Set(input.oauth_user_login.clone()),
                revoked_at: Set(None),
                updated_at: Set(at),
                ..Default::default()
            }
            .update(&orm(db))
            .await?;
            Ok::<(Row, bool), MergeError>((connection_row(row)?, false))
        }
    };
    if let Some(existing) = find_live(db, input.provider, &input.external_account_id).await? {
        return renew(existing).await;
    }
    let inserted = merge_connections::Entity::insert(merge_connections::ActiveModel {
        id: Set(generate_id("mcn")),
        provider: Set(input.provider.to_owned()),
        external_account_id: Set(input.external_account_id.clone()),
        created_by_user_id: Set(caller.user_id.clone()),
        installed_at: Set(Some(at)),
        created_at: Set(at),
        account_login: Set(input.account_login.clone()),
        account_type: Set(input.account_type.clone()),
        host: Set(input.host.clone()),
        status: Set(input.status.to_owned()),
        credentials: Set(Some(sealed.clone())),
        credentials_expire_at: Set(expires),
        oauth_user_login: Set(input.oauth_user_login.clone()),
        revoked_at: Set(None),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await;
    match inserted {
        Ok(row) => Ok((connection_row(row)?, true)),
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
pub(crate) async fn claim_authored_pull_requests(
    db: &PgPool,
    user_id: &str,
    provider: &str,
    login: &str,
) -> Result<(), DbErr> {
    let db = orm(db);
    merge_pull_requests::Entity::update_many()
        .col_expr(
            merge_pull_requests::Column::AuthorUserId,
            Expr::value(Option::<String>::None),
        )
        .filter(merge_pull_requests::Column::AuthorUserId.eq(user_id))
        .filter(merge_pull_requests::Column::Provider.eq(provider))
        .filter(merge_pull_requests::Column::AuthorLogin.ne(login))
        .exec(&db)
        .await?;
    merge_pull_requests::Entity::update_many()
        .col_expr(
            merge_pull_requests::Column::AuthorUserId,
            Expr::value(user_id.to_owned()),
        )
        .filter(merge_pull_requests::Column::Provider.eq(provider))
        .filter(merge_pull_requests::Column::AuthorLogin.eq(login))
        .filter(merge_pull_requests::Column::AuthorUserId.is_null())
        .exec(&db)
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
    let orm_db = orm(db);
    let login = user.login.to_lowercase();
    let holder = merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::UserId)
        .filter(merge_provider_accounts::Column::Provider.eq(provider))
        .filter(same_or_null(merge_provider_accounts::Column::Host, host))
        .filter(merge_provider_accounts::Column::Login.eq(&login))
        .into_tuple::<String>()
        .one(&orm_db)
        .await?;
    if holder.is_some_and(|holder| holder != caller.user_id) {
        return Ok(None);
    }
    let sealed = seal_credentials(&caller.overrides.keyring(state), credentials)?;
    let (_, at) = now_at();
    let expires = instant_opt(credentials.expiry().as_deref())?;
    let mine = merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::Id)
        .filter(merge_provider_accounts::Column::UserId.eq(&caller.user_id))
        .filter(merge_provider_accounts::Column::Provider.eq(provider))
        .filter(same_or_null(merge_provider_accounts::Column::Host, host))
        .into_tuple::<String>()
        .one(&orm_db)
        .await?;
    let written = match mine {
        Some(id) => {
            merge_provider_accounts::ActiveModel {
                id: Unchanged(id),
                login: Set(login.clone()),
                external_user_id: Set(Some(user.external_id.clone())),
                host: Set(host.map(str::to_owned)),
                credentials: Set(Some(sealed)),
                credentials_expire_at: Set(expires),
                verified_at: Set(Some(at)),
                avatar_url: Set(user.avatar_url.clone()),
                display_name: Set(user.display_name.clone()),
                updated_at: Set(at),
                ..Default::default()
            }
            .update(&orm_db)
            .await
        }
        None => {
            merge_provider_accounts::Entity::insert(merge_provider_accounts::ActiveModel {
                id: Set(generate_id("mpa")),
                user_id: Set(caller.user_id.clone()),
                provider: Set(provider.to_owned()),
                created_at: Set(at),
                login: Set(login.clone()),
                external_user_id: Set(Some(user.external_id.clone())),
                host: Set(host.map(str::to_owned)),
                credentials: Set(Some(sealed)),
                credentials_expire_at: Set(expires),
                verified_at: Set(Some(at)),
                avatar_url: Set(user.avatar_url.clone()),
                display_name: Set(user.display_name.clone()),
                updated_at: Set(at),
            })
            .exec_with_returning(&orm_db)
            .await
        }
    };
    let account = match written {
        Ok(row) => json_row(serde_json::to_value(row))?,
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
    let db = orm(&caller.db);
    let removed = merge_provider_accounts::Entity::delete_many()
        .filter(merge_provider_accounts::Column::UserId.eq(&caller.user_id))
        .filter(merge_provider_accounts::Column::Provider.eq(&provider))
        .filter(same_or_null(
            merge_provider_accounts::Column::Host,
            host.as_deref(),
        ))
        .exec(&db)
        .await?;
    if removed.rows_affected == 0 {
        return Err(Refusal::not_found("Account", Some(&provider)));
    }
    merge_pull_requests::Entity::update_many()
        .col_expr(
            merge_pull_requests::Column::AuthorUserId,
            Expr::value(Option::<String>::None),
        )
        .filter(merge_pull_requests::Column::AuthorUserId.eq(&caller.user_id))
        .filter(merge_pull_requests::Column::Provider.eq(&provider))
        .exec(&db)
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
    let (_, at) = now_at();
    let updated = merge_connections::ActiveModel {
        id: Unchanged(text(&connection, "id").to_owned()),
        external_account_id: Set(name.clone()),
        account_login: Set(Some(name.clone())),
        account_type: Set(Some("organization".to_owned())),
        host: Set(Some(url.clone())),
        status: Set("active".to_owned()),
        updated_at: Set(at),
        ..Default::default()
    }
    .update(&orm(db))
    .await;
    let updated = match updated {
        Ok(row) => connection_row(row)?,
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
