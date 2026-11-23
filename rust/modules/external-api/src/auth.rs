//! `authMiddleware` (`apps/workers/external-api/src/middleware/auth.ts` and
//! `api-key-session.ts`): a `wsk_` key or a `wsat_` app token becomes the
//! request's [`ApiSession`] and tenant database.
//!
//! The key comes from `Authorization: Bearer` or `X-Api-Key`. Under
//! `/v1/odata` only, HTTP Basic is read too (the password is the key, the
//! username is ignored), and a missing or bad key is answered with a Basic
//! challenge, so Power BI prompts for credentials.
//!
//! A `wsk_` key: its SHA-256 → the master `api_key_registry` (cached five
//! minutes under `akr:<hash>`) → the workspace (the shared workspace
//! resolver, which caches as long) → the key row in the workspace's own
//! database, read live on every request, so a revoked or expired key, or a
//! personal key whose owner left, stops at once. `lastUsedAt` is updated in
//! the background, except while the workspace's database is being moved.
//!
//! A `wsat_` token: its SHA-256 → the token with its install and app in the
//! master database, cached for only 60 seconds under `uat:<hash>` (uninstall
//! and revoke must bite fast), its expiry checked on a cache hit too.
//!
//! On Global the caches are Workers KV (`API_CACHE`); here they are the
//! cache port (Valkey), or the process without it.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QuerySelect,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use weldsuite_auth::AuthContext;
use weldsuite_db::pg_errors::{MovedDatabaseFailure, classify_moved_database_error};
use weldsuite_db::{ReadOnlyReason, Tenant, orm};
use weldsuite_kit::ApiError;
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{
    api_key_registry, plans, user_app_installs, user_app_tokens, user_apps, workspaces,
};
use weldsuite_schema::tenant::{api_keys, workspace_api_keys, workspace_members};

use crate::ExternalApiState;
use crate::session::{ApiSession, KeyType, unauthorized};

/// The registry and workspace entries' lifetime (`KV_TTL_SECONDS`).
const KEY_CACHE_TTL: Duration = Duration::from_secs(300);
/// An app token's entry: short, so uninstall and revoke bite fast.
const APP_TOKEN_CACHE_TTL: Duration = Duration::from_secs(60);

const MISSING_KEY: &str = "Invalid or missing API key. Provide a valid key via Authorization: Bearer wsk_... or X-Api-Key header.";
const INVALID_KEY: &str =
    "Invalid API key. The key may have been revoked, expired, or never existed.";

/// The challenge the `OData` feed answers a missing or bad key with, so Power
/// BI prompts for credentials.
const BASIC_CHALLENGE: &str = "Basic realm=\"WeldSuite\"";

/// `isODataPath(path)`: `/v1/odata` and everything below it, the one place
/// HTTP Basic is accepted.
pub(crate) fn is_odata_path(path: &str) -> bool {
    path == "/v1/odata" || path.starts_with("/v1/odata/")
}

/// JavaScript's `atob(input)` (the forgiving base64 decode): ASCII
/// whitespace is skipped, padding is optional, bits past the last whole
/// byte are dropped. `None` where `atob` throws.
pub(crate) fn atob(input: &str) -> Option<Vec<u8>> {
    let mut symbols: Vec<u8> = input
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if symbols.len().is_multiple_of(4) {
        for _ in 0..2 {
            if symbols.last() == Some(&b'=') {
                symbols.pop();
            }
        }
    }
    if symbols.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(symbols.len() / 4 * 3 + 2);
    let (mut buffer, mut bits) = (0_u32, 0_u32);
    for symbol in symbols {
        let value = match symbol {
            b'A'..=b'Z' => symbol - b'A',
            b'a'..=b'z' => symbol - b'a' + 26,
            b'0'..=b'9' => symbol - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

/// `basicPassword(encoded)`: what a Basic credential (`base64(user:rest)`)
/// carries after its first colon, or `None` if it is not one. Basic calls
/// that part the password; the feed's clients put their API key there, a
/// random token and not a password someone chose, so it is named for that.
fn basic_key(encoded: &str) -> Option<String> {
    let bytes = atob(weldsuite_kit::validation::js_trim(encoded))?;
    let decoded = String::from_utf8_lossy(&bytes);
    decoded.split_once(':').map(|(_, key)| key.to_owned())
}

/// `extractApiKey`: `Authorization: Bearer wsk_…|wsat_…`, on the `OData` feed
/// also `Authorization: Basic` with the key as the password (the username is
/// ignored: Power BI's connector sends credentials that way), else
/// `X-Api-Key`.
pub(crate) fn extract_api_key(path: &str, headers: &http::HeaderMap) -> Option<String> {
    let is_key = |value: &str| value.starts_with("wsk_") || value.starts_with("wsat_");
    let authorization = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer "))
        && is_key(token)
    {
        return Some(token.to_owned());
    }
    if is_odata_path(path)
        && let Some(key) = authorization
            .and_then(|value| value.strip_prefix("Basic "))
            .and_then(basic_key)
        && is_key(&key)
    {
        return Some(key);
    }
    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_key(value))
        .map(str::to_owned)
}

/// SHA-256 in lowercase hex, as the registry stores key hashes.
pub(crate) fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// `getTierFromPlan`: the plan slug when it is a tier, else `free`.
pub(crate) fn tier_from_plan(slug: Option<&str>) -> &'static str {
    match slug {
        Some("business") => "business",
        Some("scale") => "scale",
        Some("enterprise") => "enterprise",
        _ => "free",
    }
}

/// `CachedRegistryEntry`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    workspace_id: String,
    key_type: String,
    tenant_key_id: String,
}

/// `CachedAppToken`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppToken {
    workspace_id: String,
    app_id: String,
    app_code: String,
    install_id: String,
    scopes: Vec<String>,
    token_id: String,
    token_type: String,
    /// ISO timestamp, or `None` for an install token (no expiry).
    expires_at: Option<String>,
}

/// Why a key did not open a session: a bad key (401), or a response to give
/// as it is (the workspace's database moved).
enum Refusal {
    Invalid,
    Respond(Response),
}

/// Whether an ISO timestamp is now or earlier (`new Date(at) <= now`); an
/// unreadable one counts as past.
fn is_past(at: &str) -> bool {
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .map_or(true, |at| at <= time::OffsetDateTime::now_utc())
}

/// The `/v1` authentication layer.
pub async fn authenticate(
    State(state): State<ExternalApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = crate::gates::full_path(&request);
    if crate::gates::is_before_authentication(&path) {
        return next.run(request).await;
    }
    let Some(key) = extract_api_key(&path, request.headers()) else {
        return refuse_key(&path, MISSING_KEY);
    };
    let opened = if key.starts_with("wsat_") {
        validate_app_token(&state, &key).await
    } else {
        validate_api_key(&state, &key).await
    };
    let (session, tenant) = match opened {
        Ok(opened) => opened,
        Err(Refusal::Invalid) => return refuse_key(&path, INVALID_KEY),
        Err(Refusal::Respond(response)) => return response,
    };
    insert_session(request.extensions_mut(), session, tenant);
    next.run(request).await
}

/// The 401 for a missing or bad key; on the `OData` feed with a Basic
/// challenge.
fn refuse_key(path: &str, message: &str) -> Response {
    let mut response = unauthorized(message).into_response();
    if is_odata_path(path) {
        response.headers_mut().insert(
            http::header::WWW_AUTHENTICATE,
            http::HeaderValue::from_static(BASIC_CHALLENGE),
        );
    }
    response
}

/// What the routes read: the session, the tenant database, and the actor as
/// the request's [`AuthContext`] (workspace keys act as the key itself).
pub fn insert_session(extensions: &mut http::Extensions, session: ApiSession, tenant: Tenant) {
    extensions.insert(AuthContext {
        user_id: session.actor().to_owned(),
        org_id: tenant.clerk_org_id.clone(),
        session_id: String::new(),
        factor_verification_age: None,
    });
    extensions.insert(tenant);
    extensions.insert(session);
}

async fn cached<T: for<'de> Deserialize<'de>>(
    cache: Option<&Arc<dyn DynCache>>,
    key: &str,
) -> Option<T> {
    let raw = cache?.get_boxed(key).await.ok()??;
    serde_json::from_str(&raw).ok()
}

async fn remember<T: Serialize>(
    cache: Option<&Arc<dyn DynCache>>,
    key: &str,
    value: &T,
    ttl: Duration,
) {
    let (Some(cache), Ok(raw)) = (cache, serde_json::to_string(value)) else {
        return;
    };
    if let Err(error) = cache.put_boxed(key, &raw, Some(ttl)).await {
        tracing::warn!(%error, "external-api: cache write failed");
    }
}

/// The workspace's tenant database and plan tier, or `None` when it cannot be
/// resolved.
async fn workspace(state: &ExternalApiState, workspace_id: &str) -> Option<(Tenant, &'static str)> {
    let tenant = match state.workspaces.tenant(workspace_id).await {
        Ok(tenant) => tenant,
        Err(error) => {
            tracing::warn!(%error, "external-api: workspace not resolved");
            return None;
        }
    };
    let cache_key = format!("extapi:tier:{workspace_id}");
    let slug = if let Some(slug) = cached::<Option<String>>(state.cache.as_ref(), &cache_key).await
    {
        slug
    } else {
        let slug: Option<String> = workspaces::Entity::find_by_id(workspace_id.to_owned())
            .join(
                JoinType::LeftJoin,
                workspaces::Entity::belongs_to(plans::Entity)
                    .from(workspaces::Column::PlanId)
                    .to(plans::Column::Id)
                    .into(),
            )
            .select_only()
            .column(plans::Column::Slug)
            .into_tuple::<Option<String>>()
            .one(&orm(&state.master))
            .await
            .ok()
            .flatten()
            .flatten();
        remember(state.cache.as_ref(), &cache_key, &slug, KEY_CACHE_TTL).await;
        slug
    };
    Some((tenant, tier_from_plan(slug.as_deref())))
}

/// The session fields that come from the workspace.
fn restricted(session: &mut ApiSession, tenant: &Tenant, tier: &str) {
    tier.clone_into(&mut session.tier);
    session.clerk_org_id.clone_from(&tenant.clerk_org_id);
    session.licensed_apps = tenant.licensed_apps().map(<[String]>::to_vec);
    session.read_only = tenant.restrictions.read_only;
    session.read_only_reason = tenant.restrictions.read_only.then(|| {
        tenant
            .read_only_reason()
            .map_or("licence_inactive", ReadOnlyReason::as_str)
            .to_owned()
    });
}

/// `validateApiKey`.
async fn validate_api_key(
    state: &ExternalApiState,
    key: &str,
) -> Result<(ApiSession, Tenant), Refusal> {
    let hash = sha256_hex(key);
    let cache_key = format!("akr:{hash}");
    let entry = if let Some(entry) = cached::<RegistryEntry>(state.cache.as_ref(), &cache_key).await
    {
        entry
    } else {
        let row: Option<(String, String, String)> = api_key_registry::Entity::find()
            .select_only()
            .columns([
                api_key_registry::Column::WorkspaceId,
                api_key_registry::Column::KeyType,
                api_key_registry::Column::TenantKeyId,
            ])
            .filter(api_key_registry::Column::KeyHash.eq(hash.as_str()))
            .into_tuple()
            .one(&orm(&state.master))
            .await
        .map_err(|error| {
            tracing::error!(%error, "external-api: registry lookup failed");
            Refusal::Invalid
        })?;
        let Some((workspace_id, key_type, tenant_key_id)) = row else {
            return Err(Refusal::Invalid);
        };
        let entry = RegistryEntry {
            workspace_id,
            key_type,
            tenant_key_id,
        };
        remember(state.cache.as_ref(), &cache_key, &entry, KEY_CACHE_TTL).await;
        entry
    };
    let (tenant, tier) = workspace(state, &entry.workspace_id)
        .await
        .ok_or(Refusal::Invalid)?;
    // A database move is copying the tenant database: nothing may be
    // written to it, not even `lastUsedAt`.
    let moving = tenant.read_only_reason() == Some(ReadOnlyReason::DatabaseMove);
    let live = if entry.key_type == "workspace" {
        load_workspace_key(&tenant, &entry.tenant_key_id).await
    } else {
        load_personal_key(&tenant, &entry.tenant_key_id).await
    };
    let (key_id, user_id, scopes) = match live {
        Ok(Some(row)) => row,
        Ok(None) => return Err(Refusal::Invalid),
        Err(error) => {
            // The tenant database refused because the workspace moved: a
            // retryable 503, not a bad key.
            if let Some(moved) = classify_moved_database_error(&error) {
                if moved == MovedDatabaseFailure::PasswordRotated {
                    state.workspaces.forget(&[entry.workspace_id.as_str()]);
                }
                return Err(Refusal::Respond(
                    ApiError::workspace_moving().into_response(),
                ));
            }
            tracing::error!(%error, "external-api: key lookup failed");
            return Err(Refusal::Invalid);
        }
    };
    if !moving {
        touch_tenant_key(state, &tenant, entry.key_type == "workspace", &key_id);
    }
    let mut session = ApiSession {
        key_id,
        key_type: if entry.key_type == "workspace" {
            KeyType::Workspace
        } else {
            KeyType::Personal
        },
        workspace_id: entry.workspace_id,
        user_id,
        scopes,
        tier: String::new(),
        clerk_org_id: None,
        licensed_apps: None,
        read_only: false,
        read_only_reason: None,
        app_id: None,
        app_code: None,
        install_id: None,
        member: None,
    };
    restricted(&mut session, &tenant, tier);
    Ok((session, tenant))
}

/// The scopes stored on a key row (`jsonb`), as strings.
fn scope_list(value: Option<serde_json::Value>) -> Vec<String> {
    value
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default()
}

/// `loadWorkspaceKey`: a live workspace key (not deleted, not expired).
async fn load_workspace_key(
    tenant: &Tenant,
    id: &str,
) -> Result<Option<(String, Option<String>, Vec<String>)>, DbErr> {
    use workspace_api_keys::Column;
    let row: Option<(String, Option<serde_json::Value>)> = workspace_api_keys::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Scopes])
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .filter(not_expired(Column::ExpiresAt))
        .into_tuple()
        .one(&orm(&tenant.db))
        .await?;
    Ok(row.map(|(id, scopes)| (id, None, scope_list(scopes))))
}

/// `loadPersonalKey`: a live personal key whose owner is still an active
/// member of the workspace.
async fn load_personal_key(
    tenant: &Tenant,
    id: &str,
) -> Result<Option<(String, Option<String>, Vec<String>)>, DbErr> {
    let row: Option<(String, String, Option<serde_json::Value>)> = api_keys::Entity::find()
        .join(
            JoinType::InnerJoin,
            api_keys::Entity::belongs_to(workspace_members::Entity)
                .from(api_keys::Column::UserId)
                .to(workspace_members::Column::UserId)
                .into(),
        )
        .select_only()
        .columns([
            api_keys::Column::Id,
            api_keys::Column::UserId,
            api_keys::Column::Scopes,
        ])
        .filter(api_keys::Column::Id.eq(id))
        .filter(api_keys::Column::DeletedAt.is_null())
        .filter(not_expired(api_keys::Column::ExpiresAt))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .into_tuple()
        .one(&orm(&tenant.db))
        .await?;
    Ok(row.map(|(id, user_id, scopes)| (id, Some(user_id), scope_list(scopes))))
}

/// `expires_at is null or expires_at > now()`.
fn not_expired<C: ColumnTrait>(expires_at: C) -> Condition {
    use sea_orm::ExprTrait as _;
    Condition::any()
        .add(expires_at.is_null())
        .add(expires_at.into_expr().gt(Expr::current_timestamp()))
}

/// The fire-and-forget `lastUsedAt` update of a key row
/// (`last_used_at = now()`).
fn touch_tenant_key(state: &ExternalApiState, tenant: &Tenant, workspace_key: bool, id: &str) {
    let db = orm(&tenant.db);
    let id = id.to_owned();
    state.events.tracker().spawn(async move {
        let touched = if workspace_key {
            workspace_api_keys::Entity::update_many()
                .col_expr(
                    workspace_api_keys::Column::LastUsedAt,
                    Expr::current_timestamp(),
                )
                .filter(workspace_api_keys::Column::Id.eq(id))
                .exec(&db)
                .await
        } else {
            api_keys::Entity::update_many()
                .col_expr(api_keys::Column::LastUsedAt, Expr::current_timestamp())
                .filter(api_keys::Column::Id.eq(id))
                .exec(&db)
                .await
        };
        if let Err(error) = touched {
            tracing::warn!(%error, "external-api: lastUsedAt not updated");
        }
    });
}

/// `validateAppToken`.
async fn validate_app_token(
    state: &ExternalApiState,
    token: &str,
) -> Result<(ApiSession, Tenant), Refusal> {
    let hash = sha256_hex(token);
    let cache_key = format!("uat:{hash}");
    let entry = if let Some(entry) = cached::<AppToken>(state.cache.as_ref(), &cache_key).await {
        // Still cheap-verify the expiry: a session token dies on time.
        if entry.expires_at.as_deref().is_some_and(is_past) {
            return Err(Refusal::Invalid);
        }
        entry
    } else {
        let row = app_token_row(state, &hash).await.map_err(|error| {
            tracing::error!(%error, "external-api: app token lookup failed");
            Refusal::Invalid
        })?;
        let entry: AppToken = row
            .and_then(|row| serde_json::from_value(row.cached()).ok())
            .ok_or(Refusal::Invalid)?;
        remember(
            state.cache.as_ref(),
            &cache_key,
            &entry,
            APP_TOKEN_CACHE_TTL,
        )
        .await;
        entry
    };
    let (tenant, tier) = workspace(state, &entry.workspace_id)
        .await
        .ok_or(Refusal::Invalid)?;
    let master = orm(&state.master);
    let token_id = entry.token_id.clone();
    state.events.tracker().spawn(async move {
        if let Err(error) = user_app_tokens::Entity::update_many()
            .col_expr(user_app_tokens::Column::LastUsedAt, Expr::current_timestamp())
            .filter(user_app_tokens::Column::Id.eq(token_id))
            .exec(&master)
            .await
        {
            tracing::warn!(%error, "external-api: app token lastUsedAt not updated");
        }
    });
    let mut session = ApiSession {
        key_id: entry.token_id,
        key_type: KeyType::App,
        workspace_id: entry.workspace_id,
        user_id: None,
        scopes: entry.scopes,
        tier: String::new(),
        clerk_org_id: None,
        licensed_apps: None,
        read_only: false,
        read_only_reason: None,
        app_id: Some(entry.app_id),
        app_code: Some(entry.app_code),
        install_id: Some(entry.install_id),
        member: None,
    };
    restricted(&mut session, &tenant, tier);
    Ok((session, tenant))
}

/// A live token with its active install and app, as the lookup reads it.
#[derive(Debug, FromQueryResult)]
struct AppTokenRow {
    token_id: String,
    token_type: String,
    scopes: Option<serde_json::Value>,
    expires_at: Option<time::OffsetDateTime>,
    install_id: String,
    workspace_id: String,
    app_id: String,
    app_code: String,
}

impl AppTokenRow {
    /// `CachedAppToken` as JSON: `scopes` `coalesce(t.scopes, '[]')`,
    /// `expiresAt` as `toISOString()` (UTC, milliseconds).
    fn cached(self) -> serde_json::Value {
        serde_json::json!({
            "tokenId": self.token_id,
            "tokenType": self.token_type,
            "scopes": self.scopes.unwrap_or_else(|| serde_json::json!([])),
            "expiresAt": self.expires_at.map(weldsuite_events::iso_timestamp),
            "installId": self.install_id,
            "workspaceId": self.workspace_id,
            "appId": self.app_id,
            "appCode": self.app_code,
        })
    }
}

/// The token whose hash is `hash`: not revoked or expired, its install
/// active, its app active and not deleted.
async fn app_token_row(state: &ExternalApiState, hash: &str) -> Result<Option<AppTokenRow>, DbErr> {
    use user_app_tokens::Column;
    user_app_tokens::Entity::find()
        .join(
            JoinType::InnerJoin,
            user_app_tokens::Entity::belongs_to(user_app_installs::Entity)
                .from(Column::InstallId)
                .to(user_app_installs::Column::Id)
                .into(),
        )
        .join(
            JoinType::InnerJoin,
            user_app_tokens::Entity::belongs_to(user_apps::Entity)
                .from(Column::AppId)
                .to(user_apps::Column::Id)
                .into(),
        )
        .select_only()
        .column_as(Column::Id, "token_id")
        .column(Column::TokenType)
        .column(Column::Scopes)
        .column(Column::ExpiresAt)
        .column_as(user_app_installs::Column::Id, "install_id")
        .column(Column::WorkspaceId)
        .column_as(user_apps::Column::Id, "app_id")
        .column_as(user_apps::Column::Code, "app_code")
        .filter(Column::TokenHash.eq(hash))
        .filter(Column::RevokedAt.is_null())
        .filter(not_expired(Column::ExpiresAt))
        .filter(user_app_installs::Column::Status.eq("active"))
        .filter(user_apps::Column::IsActive.eq(true))
        .filter(user_apps::Column::DeletedAt.is_null())
        .into_model()
        .one(&orm(&state.master))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> http::HeaderMap {
        let mut map = http::HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                http::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                http::HeaderValue::from_str(value).expect("value"),
            );
        }
        map
    }

    #[test]
    fn keys_come_from_bearer_or_x_api_key() {
        for path in ["/v1/people", "/v1/odata", "/v1/odata/Conversations"] {
            assert_eq!(
                extract_api_key(path, &headers(&[("authorization", "Bearer wsk_abc")])).as_deref(),
                Some("wsk_abc"),
                "{path}"
            );
            assert_eq!(
                extract_api_key(path, &headers(&[("x-api-key", "wsat_abc")])).as_deref(),
                Some("wsat_abc"),
                "{path}"
            );
        }
        // A bearer token that is not a key falls through to X-Api-Key.
        assert_eq!(
            extract_api_key(
                "/v1/people",
                &headers(&[("authorization", "Bearer eyJ"), ("x-api-key", "wsk_x")])
            )
            .as_deref(),
            Some("wsk_x")
        );
        assert_eq!(
            extract_api_key("/v1/people", &headers(&[("authorization", "Basic wsk_x")])),
            None
        );
        assert_eq!(
            extract_api_key("/v1/people", &headers(&[("authorization", "Bearer nope")])),
            None
        );
        assert_eq!(extract_api_key("/v1/people", &headers(&[])), None);
    }

    const KEY: &str = "wsk_0123456789abcdef";

    /// `Basic base64(user:rest)`, as a client sends it: `rest` is whatever
    /// follows the first colon (the API key, for the feed).
    fn basic(user: &str, rest: &str) -> String {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{rest}"));
        format!("Basic {encoded}")
    }

    fn from_authorization(path: &str, value: &str) -> Option<String> {
        extract_api_key(path, &headers(&[("authorization", value)]))
    }

    #[test]
    fn the_feed_reads_the_basic_password_as_the_key_whatever_the_username() {
        for path in [
            "/v1/odata",
            "/v1/odata/",
            "/v1/odata/$metadata",
            "/v1/odata/Conversations",
        ] {
            assert_eq!(
                from_authorization(path, &basic("anything", KEY)).as_deref(),
                Some(KEY),
                "{path}"
            );
        }
        assert_eq!(
            from_authorization("/v1/odata", &basic("", KEY)).as_deref(),
            Some(KEY)
        );
        assert_eq!(
            from_authorization("/v1/odata", &basic("Jan Müller", KEY)).as_deref(),
            Some(KEY)
        );
        // Only the first colon splits the user from the password.
        assert_eq!(from_authorization("/v1/odata", &basic("a:b", KEY)), None);
        assert_eq!(
            from_authorization("/v1/odata", &basic("a", &format!("{KEY}:x"))),
            Some(format!("{KEY}:x"))
        );
        assert_eq!(
            from_authorization("/v1/odata", &basic("u", "wsat_abc123")).as_deref(),
            Some("wsat_abc123")
        );
        // A Basic credential that is not a key still leaves X-Api-Key.
        let not_a_key = basic("u", "password");
        assert_eq!(
            extract_api_key(
                "/v1/odata",
                &headers(&[("authorization", not_a_key.as_str()), ("x-api-key", KEY)])
            )
            .as_deref(),
            Some(KEY)
        );
    }

    #[test]
    fn basic_is_refused_anywhere_else_and_on_lookalike_paths() {
        for path in [
            "/v1/people",
            "/v1/audit-logs",
            "/v1",
            "/v1/odatax",
            "/v1/odata-evil",
            "/v2/odata",
            "/odata",
            "/v1/people/odata",
        ] {
            assert_eq!(from_authorization(path, &basic("u", KEY)), None, "{path}");
            assert!(!is_odata_path(path), "{path}");
        }
        assert!(is_odata_path("/v1/odata"));
        assert!(is_odata_path("/v1/odata/Teams"));
    }

    #[test]
    fn a_basic_credential_that_is_not_a_key_or_is_malformed_is_refused() {
        use base64::Engine;
        let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
        for header in [
            basic("u", "password"),
            basic("u", ""),
            basic("u", &format!("x{KEY}")),
            format!("Basic {}", encode("no-colon-here")),
            "Basic !!!not-base64!!!".to_owned(),
            "Basic ".to_owned(),
            "Basic".to_owned(),
            format!("basic {}", encode(&format!("u:{KEY}"))),
            format!("Digest {KEY}"),
        ] {
            assert_eq!(from_authorization("/v1/odata", &header), None, "{header}");
        }
    }

    #[test]
    fn atob_decodes_as_javascript_does() {
        assert_eq!(atob("dTp3c2tfeA==").as_deref(), Some(&b"u:wsk_x"[..]));
        // Padding is optional and whitespace is skipped.
        assert_eq!(atob("dTp3c2tfeA").as_deref(), Some(&b"u:wsk_x"[..]));
        assert_eq!(atob(" dTp3\nc2tf eA= =").as_deref(), Some(&b"u:wsk_x"[..]));
        assert_eq!(atob("").as_deref(), Some(&b""[..]));
        assert_eq!(atob("YQ").as_deref(), Some(&b"a"[..]));
        // Bits past the last whole byte are dropped.
        assert_eq!(atob("YR").as_deref(), Some(&b"a"[..]));
        for refused in ["a", "YQ=", "Y=Q=", "YQ===", "a-b_", "é", "!!!!"] {
            assert_eq!(atob(refused), None, "{refused}");
        }
    }

    #[test]
    fn a_missing_or_bad_key_is_challenged_on_the_feed_only() {
        for path in ["/v1/odata", "/v1/odata/Conversations", "/v1/odata/Teams"] {
            for message in [MISSING_KEY, INVALID_KEY] {
                let response = refuse_key(path, message);
                assert_eq!(response.status(), http::StatusCode::UNAUTHORIZED);
                assert_eq!(
                    response
                        .headers()
                        .get(http::header::WWW_AUTHENTICATE)
                        .and_then(|value| value.to_str().ok()),
                    Some("Basic realm=\"WeldSuite\""),
                    "{path}"
                );
            }
        }
        for path in ["/v1/audit-logs", "/v1", "/v1/odatax"] {
            let response = refuse_key(path, MISSING_KEY);
            assert_eq!(response.status(), http::StatusCode::UNAUTHORIZED);
            assert!(
                response
                    .headers()
                    .get(http::header::WWW_AUTHENTICATE)
                    .is_none(),
                "{path}"
            );
        }
    }

    #[test]
    fn hashes_and_tiers() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(tier_from_plan(Some("scale")), "scale");
        assert_eq!(tier_from_plan(Some("pro")), "free");
        assert_eq!(tier_from_plan(None), "free");
    }
}
