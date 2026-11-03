//! `authMiddleware` (`apps/workers/external-api/src/middleware/auth.ts` and
//! `api-key-session.ts`): a `wsk_` key or a `wsat_` app token becomes the
//! request's [`ApiSession`] and tenant database.
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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use weldsuite_auth::AuthContext;
use weldsuite_db::pg_errors::{MovedDatabaseFailure, classify_moved_database_error};
use weldsuite_db::{ReadOnlyReason, Tenant};
use weldsuite_kit::ApiError;
use weldsuite_ports::DynCache;

use crate::ExternalApiState;
use crate::session::{ApiSession, KeyType, unauthorized};

/// The registry and workspace entries' lifetime (`KV_TTL_SECONDS`).
const KEY_CACHE_TTL: Duration = Duration::from_secs(300);
/// An app token's entry: short, so uninstall and revoke bite fast.
const APP_TOKEN_CACHE_TTL: Duration = Duration::from_secs(60);

const MISSING_KEY: &str = "Invalid or missing API key. Provide a valid key via Authorization: Bearer wsk_... or X-Api-Key header.";
const INVALID_KEY: &str =
    "Invalid API key. The key may have been revoked, expired, or never existed.";

/// `extractApiKey`: `Authorization: Bearer wsk_…|wsat_…`, else `X-Api-Key`.
pub(crate) fn extract_api_key(headers: &http::HeaderMap) -> Option<String> {
    let is_key = |value: &str| value.starts_with("wsk_") || value.starts_with("wsat_");
    if let Some(token) = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        && is_key(token)
    {
        return Some(token.to_owned());
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
    if crate::gates::is_before_authentication(&crate::gates::full_path(&request)) {
        return next.run(request).await;
    }
    let Some(key) = extract_api_key(request.headers()) else {
        return unauthorized(MISSING_KEY).into_response();
    };
    let opened = if key.starts_with("wsat_") {
        validate_app_token(&state, &key).await
    } else {
        validate_api_key(&state, &key).await
    };
    let (session, tenant) = match opened {
        Ok(opened) => opened,
        Err(Refusal::Invalid) => return unauthorized(INVALID_KEY).into_response(),
        Err(Refusal::Respond(response)) => return response,
    };
    insert_session(request.extensions_mut(), session, tenant);
    next.run(request).await
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
        let slug: Option<String> = sqlx::query_scalar(
            "select p.slug from workspaces w left join plans p on p.id = w.plan_id where w.id = $1",
        )
        .bind(workspace_id)
        .fetch_optional(&state.master)
        .await
        .ok()
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
        let row: Option<(String, String, String)> = sqlx::query_as(
            "select workspace_id, key_type, tenant_key_id from api_key_registry where key_hash = $1 limit 1",
        )
        .bind(&hash)
        .fetch_optional(&state.master)
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
) -> Result<Option<(String, Option<String>, Vec<String>)>, sqlx::Error> {
    let row: Option<(String, Option<serde_json::Value>)> = sqlx::query_as(
        "select id, scopes from workspace_api_keys
          where id = $1 and deleted_at is null and (expires_at is null or expires_at > now())
          limit 1",
    )
    .bind(id)
    .fetch_optional(&tenant.db)
    .await?;
    Ok(row.map(|(id, scopes)| (id, None, scope_list(scopes))))
}

/// `loadPersonalKey`: a live personal key whose owner is still an active
/// member of the workspace.
async fn load_personal_key(
    tenant: &Tenant,
    id: &str,
) -> Result<Option<(String, Option<String>, Vec<String>)>, sqlx::Error> {
    let row: Option<(String, String, Option<serde_json::Value>)> = sqlx::query_as(
        "select k.id, k.user_id, k.scopes from api_keys k
           join workspace_members m on m.user_id = k.user_id
          where k.id = $1 and k.deleted_at is null and (k.expires_at is null or k.expires_at > now())
            and m.deleted_at is null and m.status = 'ACTIVE'
          limit 1",
    )
    .bind(id)
    .fetch_optional(&tenant.db)
    .await?;
    Ok(row.map(|(id, user_id, scopes)| (id, Some(user_id), scope_list(scopes))))
}

/// The fire-and-forget `lastUsedAt` update of a key row.
fn touch_tenant_key(state: &ExternalApiState, tenant: &Tenant, workspace_key: bool, id: &str) {
    let db = tenant.db.clone();
    let id = id.to_owned();
    state.events.tracker().spawn(async move {
        let statement = if workspace_key {
            "update workspace_api_keys set last_used_at = now() where id = $1"
        } else {
            "update api_keys set last_used_at = now() where id = $1"
        };
        if let Err(error) = sqlx::query(statement).bind(&id).execute(&db).await {
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
        let row: Option<serde_json::Value> = sqlx::query_scalar(
            "select jsonb_build_object(
                      'tokenId', t.id, 'tokenType', t.token_type, 'scopes', coalesce(t.scopes, '[]'::jsonb),
                      'expiresAt', to_char(t.expires_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                      'installId', i.id, 'workspaceId', t.workspace_id, 'appId', a.id, 'appCode', a.code)
               from user_app_tokens t
               join user_app_installs i on i.id = t.install_id
               join user_apps a on a.id = t.app_id
              where t.token_hash = $1 and t.revoked_at is null
                and (t.expires_at is null or t.expires_at > now())
                and i.status = 'active' and a.is_active = true and a.deleted_at is null
              limit 1",
        )
        .bind(&hash)
        .fetch_optional(&state.master)
        .await
        .map_err(|error| {
            tracing::error!(%error, "external-api: app token lookup failed");
            Refusal::Invalid
        })?;
        let entry: AppToken = row
            .and_then(|row| serde_json::from_value(row).ok())
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
    let master = state.master.clone();
    let token_id = entry.token_id.clone();
    state.events.tracker().spawn(async move {
        if let Err(error) =
            sqlx::query("update user_app_tokens set last_used_at = now() where id = $1")
                .bind(&token_id)
                .execute(&master)
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
    };
    restricted(&mut session, &tenant, tier);
    Ok((session, tenant))
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
        assert_eq!(
            extract_api_key(&headers(&[("authorization", "Bearer wsk_abc")])).as_deref(),
            Some("wsk_abc")
        );
        assert_eq!(
            extract_api_key(&headers(&[("x-api-key", "wsat_abc")])).as_deref(),
            Some("wsat_abc")
        );
        // A bearer token that is not a key falls through to X-Api-Key.
        assert_eq!(
            extract_api_key(&headers(&[
                ("authorization", "Bearer eyJ"),
                ("x-api-key", "wsk_x")
            ]))
            .as_deref(),
            Some("wsk_x")
        );
        assert_eq!(
            extract_api_key(&headers(&[("authorization", "Basic wsk_x")])),
            None
        );
        assert_eq!(extract_api_key(&headers(&[])), None);
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
