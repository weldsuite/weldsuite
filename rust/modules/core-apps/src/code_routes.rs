//! `/api/user-apps/code/:code/*`: what the platform's iframe host asks for
//! an installed app (`routes/user-apps/index.ts`): a session token (bridge
//! protocol 1), the bundle link, the app gateway (bridge protocol 2) and the
//! developer's preview session.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, OriginalUri, Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{
    user_app_dev_sessions as dev_sessions, user_app_installs, user_apps,
};
use weldsuite_schema::tenant::workspace_installed_apps;

use crate::CoreAppsState;
use crate::access::{AppsError, AppsResult, Caller, OrInternal, answer, now_ms, validate};
use crate::bundle_access::{
    plain_bundle_path, sign_bundle_capability, signed_bundle_path, workspace_may_use_bundle,
};
use crate::http_transport::OutboundRequest;
use crate::publish::{is_publicly_servable, mint_app_token, now_tz, string_list, to_millis};
use crate::schemas;
use crate::scopes::{is_allowed_dev_session_url, origin_of};

/// Upper bound of a forwarded request body.
const MAX_GATEWAY_BODY_BYTES: usize = 25 * 1024 * 1024;
const GATEWAY_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// Request headers an app may set; everything else (auth, cookies, …) is dropped.
const FORWARDED_REQUEST_HEADERS: [&str; 7] = [
    "accept",
    "accept-language",
    "content-type",
    "if-match",
    "if-none-match",
    "idempotency-key",
    "x-request-id",
];
/// Response headers passed back to the app.
const FORWARDED_RESPONSE_HEADERS: [&str; 9] = [
    "content-type",
    "content-disposition",
    "etag",
    "last-modified",
    "retry-after",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
];
/// Refresh a cached gateway token this long before it expires.
const TOKEN_REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
/// KV refuses an `expirationTtl` below 60 seconds.
const MIN_KV_TTL_SECONDS: i64 = 60;
/// A preview session lives five minutes without a heartbeat.
const DEV_SESSION_TTL: time::Duration = time::Duration::minutes(5);

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreAppsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["weldapps:read"]);
    let develop = || gate.require(["weldapps:develop"]);
    Router::new()
        .route(
            "/code/{code}/session-token",
            post(session_token).route_layer(read()),
        )
        .route(
            "/code/{code}/bundle-url",
            post(bundle_url).route_layer(read()),
        )
        .route(
            "/code/{code}/gateway/{*rest}",
            // `any` has no per-method routes for a `route_layer`: every
            // method reaches the handler, behind the gate.
            any(gateway)
                .layer::<_, std::convert::Infallible>(read())
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::disable()),
        )
        .route(
            "/code/{code}/dev-session",
            get(dev_session).route_layer(read()),
        )
        .route(
            "/code/{code}/dev-session",
            axum::routing::put(put_dev_session)
                .delete(delete_dev_session)
                .route_layer(develop()),
        )
}

/// The workspace's active install of `code`: live in master, mirrored as
/// installed in the tenant, the master grant active (`resolveActiveInstall`).
struct ActiveInstall {
    app_id: String,
    install_id: String,
    granted_scopes: Vec<String>,
}

async fn resolve_active_install(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
    code: &str,
) -> Result<Option<ActiveInstall>, DbErr> {
    let master = orm(master);
    let app_id: Option<String> = user_apps::Entity::find()
        .select_only()
        .column(user_apps::Column::Id)
        .filter(user_apps::Column::Code.eq(code))
        .filter(user_apps::Column::IsActive.eq(true))
        .filter(user_apps::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&master)
        .await?;
    let Some(app_id) = app_id else {
        return Ok(None);
    };
    let tenant_row: Option<String> = workspace_installed_apps::Entity::find()
        .select_only()
        .column(workspace_installed_apps::Column::Id)
        .filter(workspace_installed_apps::Column::AppCode.eq(code))
        .filter(workspace_installed_apps::Column::AppType.eq("user"))
        .filter(workspace_installed_apps::Column::IsActive.eq(true))
        .filter(workspace_installed_apps::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(tenant))
        .await?;
    if tenant_row.is_none() {
        return Ok(None);
    }
    let install: Option<(String, Option<Value>)> = user_app_installs::Entity::find()
        .select_only()
        .columns([
            user_app_installs::Column::Id,
            user_app_installs::Column::GrantedScopes,
        ])
        .filter(user_app_installs::Column::AppId.eq(&app_id))
        .filter(user_app_installs::Column::WorkspaceId.eq(workspace_id))
        .filter(user_app_installs::Column::Status.eq("active"))
        .into_tuple()
        .one(&master)
        .await?;
    Ok(install.map(|(install_id, granted)| ActiveInstall {
        app_id,
        install_id,
        granted_scopes: string_list(granted.as_ref()),
    }))
}

// ── POST /code/:code/session-token ───────────────────────────────────────────

async fn session_token(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to mint session token";
            let master = caller.master(&state);
            let install = resolve_active_install(&master, &caller.db, &caller.workspace_id, &code)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| AppsError::api(ApiError::not_found("App install", Some(&code))))?;
            let minted = mint_app_token(
                &master,
                &install.install_id,
                &install.app_id,
                &caller.workspace_id,
                "session",
                &install.granted_scopes,
            )
            .await
            .or_internal(FAILED)?;
            let api_base_url = caller
                .overrides
                .env(&state, "EXTERNAL_API_URL")
                .filter(|url| !url.is_empty())
                .unwrap_or("https://api.weldsuite.org");
            Ok(Data(json!({
                "token": minted.token,
                "expiresAt": minted.expires_at,
                "apiBaseUrl": api_base_url,
            }))
            .into_response())
        }
        .await,
    )
}

// ── POST /code/:code/bundle-url ──────────────────────────────────────────────

async fn bundle_url(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to mint the app bundle link";
            let master = caller.master(&state);
            let app: Option<(String, String, String, String, Option<String>)> =
                user_apps::Entity::find()
                    .select_only()
                    .columns([
                        user_apps::Column::Id,
                        user_apps::Column::OwnerWorkspaceId,
                        user_apps::Column::Visibility,
                        user_apps::Column::ReviewStatus,
                        user_apps::Column::CurrentVersionId,
                    ])
                    .filter(user_apps::Column::Code.eq(&code))
                    .filter(user_apps::Column::IsActive.eq(true))
                    .filter(user_apps::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm(&master))
                    .await
                    .or_internal(FAILED)?;
            let not_found = || AppsError::api(ApiError::not_found("App", Some(&code)));
            let Some((app_id, owner, visibility, review_status, Some(_))) = app else {
                return Err(not_found());
            };
            if is_publicly_servable(&visibility, &review_status) {
                return Ok(Data(json!({
                    "path": plain_bundle_path(&code),
                    "signed": false,
                    "expiresAt": null,
                }))
                .into_response());
            }
            let allowed = workspace_may_use_bundle(&master, &app_id, &owner, &caller.workspace_id)
                .await
                .or_internal(FAILED)?;
            if !allowed {
                return Err(not_found());
            }
            let env = |key: &str| caller.overrides.env(&state, key);
            let Some(link) = sign_bundle_capability(env, &app_id, &caller.workspace_id, now_ms())
            else {
                tracing::error!("core-apps: bundle-url: no bundle signing secret is configured");
                return Err(ApiError::internal()
                    .with_message("App bundle links are not configured")
                    .into());
            };
            Ok(Data(json!({
                "path": signed_bundle_path(&code, &link.token),
                "signed": true,
                "expiresAt": iso_ms(link.expires_at_ms),
            }))
            .into_response())
        }
        .await,
    )
}

/// `new Date(ms).toISOString()`.
fn iso_ms(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(iso_timestamp)
        .unwrap_or_default()
}

// ── ALL /code/:code/gateway/* ────────────────────────────────────────────────

/// A gateway session token: in the process (the worker's per-isolate cache)
/// and in KV (`{ token, expiresAt }`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedGatewayToken {
    token: String,
    /// Epoch ms.
    expires_at: f64,
}

fn gateway_cache_key(workspace_id: &str, code: &str) -> String {
    format!("uagw:v1:{workspace_id}:{code}")
}

#[allow(clippy::cast_precision_loss)]
fn is_fresh(entry: &CachedGatewayToken, now: i64) -> bool {
    entry.expires_at - TOKEN_REFRESH_MARGIN_MS as f64 > now as f64
}

/// `decodeURIComponent`: `None` on a malformed escape or bytes that are not
/// UTF-8.
pub(crate) fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `normalizeGatewayPath`: a plain `/v1/...` path, else `None` (traversal,
/// encoded slashes, protocol-relative, backslashes).
fn normalize_gateway_path(raw: &str) -> Option<&str> {
    if !raw.starts_with("/v1/") || raw.contains("//") || raw.contains('\\') {
        return None;
    }
    let decoded = decode_uri_component(raw)?;
    if decoded.contains('\\') || decoded.contains("//") {
        return None;
    }
    if decoded.split('/').any(|s| s == ".." || s == ".") {
        return None;
    }
    if raw.to_ascii_lowercase().contains("%2f") {
        return None;
    }
    Some(raw)
}

/// `isolate cache → KV → mint`: a valid session token for the workspace's
/// install of `code`, or `None` when it is not (or no longer) installed.
async fn gateway_token(
    state: &CoreAppsState,
    master: &PgPool,
    caller: &Caller,
    cache: Option<&dyn DynCache>,
    code: &str,
) -> Result<Option<String>, DbErr> {
    let key = gateway_cache_key(&caller.workspace_id, code);
    let now = now_ms();
    let local = state
        .gateway_tokens
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&key)
        .cloned();
    if let Some(entry) = local.filter(|e| is_fresh(e, now)) {
        return Ok(Some(entry.token));
    }
    if let Some(cache) = cache {
        match cache.get_boxed(&key).await {
            Ok(Some(text)) => match serde_json::from_str::<CachedGatewayToken>(&text) {
                Ok(shared) if is_fresh(&shared, now) => {
                    let token = shared.token.clone();
                    remember(state, &key, shared);
                    return Ok(Some(token));
                }
                Ok(_) => {}
                Err(error) => tracing::error!(%error, "core-apps: gateway cache read failed"),
            },
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "core-apps: gateway cache read failed"),
        }
    }
    let Some(install) =
        resolve_active_install(master, &caller.db, &caller.workspace_id, code).await?
    else {
        return Ok(None);
    };
    let minted = mint_app_token(
        master,
        &install.install_id,
        &install.app_id,
        &caller.workspace_id,
        "session",
        &install.granted_scopes,
    )
    .await?;
    let expires_at = minted
        .expires_at_ms
        .unwrap_or(now + TOKEN_REFRESH_MARGIN_MS * 2);
    #[allow(clippy::cast_precision_loss)]
    let entry = CachedGatewayToken {
        token: minted.token.clone(),
        expires_at: expires_at as f64,
    };
    remember(state, &key, entry.clone());
    let ttl = (expires_at - TOKEN_REFRESH_MARGIN_MS - now).div_euclid(1000);
    if ttl >= MIN_KV_TTL_SECONDS
        && let Some(cache) = cache
    {
        let text = serde_json::to_string(&entry).unwrap_or_default();
        if let Err(error) = cache
            .put_boxed(
                &key,
                &text,
                Some(Duration::from_secs(u64::try_from(ttl).unwrap_or(60))),
            )
            .await
        {
            tracing::error!(%error, "core-apps: gateway cache write failed");
        }
    }
    Ok(Some(minted.token))
}

fn remember(state: &CoreAppsState, key: &str, entry: CachedGatewayToken) {
    state
        .gateway_tokens
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(key.to_owned(), entry);
}

async fn drop_gateway_token(state: &CoreAppsState, cache: Option<&dyn DynCache>, key: &str) {
    state
        .gateway_tokens
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(key);
    if let Some(cache) = cache
        && let Err(error) = cache.delete_boxed(key).await
    {
        tracing::error!(%error, "core-apps: gateway cache delete failed");
    }
}

/// `EXTERNAL_API_URL` without trailing slashes.
fn trim_slashes(text: &str) -> &str {
    text.trim_end_matches('/')
}

/// `forwardToExternalApi`: one request to external-api with the token, never
/// leaving its origin or its `/v1/` surface.
async fn forward(
    state: &CoreAppsState,
    caller: &Caller,
    method: &str,
    path_and_query: &str,
    headers: &[(String, String)],
    body: Option<&Bytes>,
    token: &str,
) -> Result<crate::http_transport::OutboundResponse, String> {
    let configured = caller
        .overrides
        .env(state, "EXTERNAL_API_URL")
        .filter(|url| !url.is_empty())
        .unwrap_or("https://api.weldsuite.org");
    let base = url::Url::parse(trim_slashes(configured)).map_err(|error| error.to_string())?;
    let base_origin = base.origin().ascii_serialization();
    let base_path = trim_slashes(base.path());
    let target = url::Url::parse(&format!("{base_origin}{base_path}{path_and_query}"))
        .map_err(|error| error.to_string())?;
    if target.origin().ascii_serialization() != base_origin
        || !target.path().starts_with(&format!("{base_path}/v1/"))
    {
        return Err("Gateway target escapes the external API".to_owned());
    }
    let mut outgoing: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| name != "authorization")
        .cloned()
        .collect();
    outgoing.push(("authorization".to_owned(), format!("Bearer {token}")));
    caller
        .overrides
        .http(state)
        .send(OutboundRequest {
            method: method.to_owned(),
            url: target.to_string(),
            headers: outgoing,
            body: body.map(|b| b.to_vec()),
            timeout: None,
        })
        .await
}

/// `error.internal(c, …)` of the gateway.
const GATEWAY_FAILED: &str = "App gateway request failed";

#[allow(clippy::too_many_lines)] // the route's steps, in the TypeScript order
async fn gateway(
    State(state): State<CoreAppsState>,
    caller: Caller,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Response {
    answer(
        async {
            // `c.req.param('code')`, decoded (kept as is when it doesn't decode).
            let full = uri.path();
            let segment = full
                .find("/code/")
                .map(|at| &full[at + "/code/".len()..])
                .and_then(|after| after.split('/').next())
                .unwrap_or_default();
            let code = decode_uri_component(segment).unwrap_or_else(|| segment.to_owned());
            let method = request.method().as_str().to_ascii_uppercase();
            if !GATEWAY_METHODS.contains(&method.as_str()) {
                return Err(ApiError::bad_request(format!(
                    "Method {method} is not supported by the app gateway"
                ))
                .into());
            }
            // The raw path after `/code/<code>/gateway` (`GATEWAY_PATH`).
            let raw = full
                .find("/code/")
                .and_then(|at| {
                    let after = &full[at + "/code/".len()..];
                    let slash = after.find('/')?;
                    after[slash..].strip_prefix("/gateway")
                })
                .unwrap_or_default();
            let Some(path) = normalize_gateway_path(raw) else {
                return Err(ApiError::bad_request(
                    "App gateway paths must be external API paths under /v1/",
                )
                .into());
            };

            let headers = picked(request.headers(), &FORWARDED_REQUEST_HEADERS);
            let body = if method == "GET" || method == "HEAD" {
                None
            } else {
                let too_large =
                    || ApiError::bad_request("Request body too large for the app gateway");
                let declared = request
                    .headers()
                    .get(http::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .unwrap_or(0.0);
                #[allow(clippy::cast_precision_loss)]
                if declared > MAX_GATEWAY_BODY_BYTES as f64 {
                    return Err(too_large().into());
                }
                let bytes = axum::body::to_bytes(request.into_body(), MAX_GATEWAY_BODY_BYTES)
                    .await
                    .map_err(|_| AppsError::api(too_large()))?;
                (!bytes.is_empty()).then_some(bytes)
            };
            let query = uri
                .query()
                .filter(|q| !q.is_empty())
                .map(|q| format!("?{q}"));
            let path_and_query = format!("{path}{}", query.unwrap_or_default());

            let master = caller.master(&state);
            let cache = caller.overrides.cache(&state).ok();
            let not_installed = || AppsError::api(ApiError::not_found("App install", Some(&code)));
            let token = gateway_token(&state, &master, &caller, cache.as_deref(), &code)
                .await
                .or_internal(GATEWAY_FAILED)?
                .ok_or_else(not_installed)?;
            let mut upstream = forward(
                &state,
                &caller,
                &method,
                &path_and_query,
                &headers,
                body.as_ref(),
                &token,
            )
            .await
            .or_internal(GATEWAY_FAILED)?;
            if upstream.status == 401 {
                // The cached token was revoked or expired early: resolve the
                // install again, once.
                drop_gateway_token(
                    &state,
                    cache.as_deref(),
                    &gateway_cache_key(&caller.workspace_id, &code),
                )
                .await;
                let token = gateway_token(&state, &master, &caller, cache.as_deref(), &code)
                    .await
                    .or_internal(GATEWAY_FAILED)?
                    .ok_or_else(not_installed)?;
                upstream = forward(
                    &state,
                    &caller,
                    &method,
                    &path_and_query,
                    &headers,
                    body.as_ref(),
                    &token,
                )
                .await
                .or_internal(GATEWAY_FAILED)?;
            }
            let status = StatusCode::from_u16(upstream.status).or_internal(GATEWAY_FAILED)?;
            let mut response = Response::new(Body::from(upstream.body));
            *response.status_mut() = status;
            for name in FORWARDED_RESPONSE_HEADERS {
                if let Some((_, value)) = upstream
                    .headers
                    .iter()
                    .find(|(n, _)| n.eq_ignore_ascii_case(name))
                    && let Ok(value) = HeaderValue::from_str(value)
                {
                    response
                        .headers_mut()
                        .insert(HeaderName::from_static(name), value);
                }
            }
            Ok(response)
        }
        .await,
    )
}

/// The allowed headers of a request, as `[name, value]`.
fn picked(headers: &HeaderMap, allowed: &[&str]) -> Vec<(String, String)> {
    allowed
        .iter()
        .filter_map(|name| {
            let values: Vec<&str> = headers
                .get_all(*name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            (!values.is_empty()).then(|| ((*name).to_owned(), values.join(", ")))
        })
        .collect()
}

// ── preview sessions ─────────────────────────────────────────────────────────

/// A stored session as the platform may see it: `{ url, origin, expiresAt }`,
/// `None` when the URL is not (or no longer) an allowed preview URL.
fn session_view(url: &str, expires_at: OffsetDateTime) -> Option<Value> {
    if !is_allowed_dev_session_url(url) {
        return None;
    }
    let origin = origin_of(url)?;
    Some(json!({
        "url": url,
        "origin": origin,
        "expiresAt": iso_timestamp(expires_at),
    }))
}

/// The app with `code` the caller's workspace owns (live apps only).
async fn owned_app_by_code(
    master: &PgPool,
    code: &str,
    workspace_id: &str,
) -> Result<Option<String>, DbErr> {
    user_apps::Entity::find()
        .select_only()
        .column(user_apps::Column::Id)
        .filter(user_apps::Column::Code.eq(code))
        .filter(user_apps::Column::OwnerWorkspaceId.eq(workspace_id))
        .filter(user_apps::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(master))
        .await
}

async fn dev_session(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to fetch preview session";
            // Only for a developer of the authoring workspace, and only their own.
            if !caller.can("weldapps:develop") {
                return Ok(Data(Value::Null).into_response());
            }
            let master = orm(&caller.master(&state));
            let app: Option<(String, String)> = user_apps::Entity::find()
                .select_only()
                .columns([user_apps::Column::Id, user_apps::Column::OwnerWorkspaceId])
                .filter(user_apps::Column::Code.eq(&code))
                .filter(user_apps::Column::IsActive.eq(true))
                .filter(user_apps::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&master)
                .await
                .or_internal(FAILED)?;
            let Some((app_id, owner)) = app else {
                return Ok(Data(Value::Null).into_response());
            };
            if owner != caller.workspace_id {
                return Ok(Data(Value::Null).into_response());
            }
            let session: Option<(String, OffsetDateTime)> = dev_sessions::Entity::find()
                .select_only()
                .columns([dev_sessions::Column::Url, dev_sessions::Column::ExpiresAt])
                .filter(dev_sessions::Column::AppId.eq(&app_id))
                .filter(dev_sessions::Column::UserId.eq(&caller.user_id))
                .filter(dev_sessions::Column::WorkspaceId.eq(&caller.workspace_id))
                .filter(dev_sessions::Column::ExpiresAt.gt(now_tz()))
                .into_tuple()
                .one(&master)
                .await
                .or_internal(FAILED)?;
            let view = session.and_then(|(url, expires)| session_view(&url, expires));
            Ok(Data(view.unwrap_or(Value::Null)).into_response())
        }
        .await,
    )
}

async fn put_dev_session(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to save preview session";
            let url = validate(&headers, &body, schemas::dev_session)?;
            let master = caller.master(&state);
            let app_id = owned_app_by_code(&master, &code, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| AppsError::api(ApiError::not_found("App", Some(&code))))?;
            if !is_allowed_dev_session_url(&url) {
                return Err(ApiError::bad_request(
                    "Preview URL must be localhost, 127.0.0.1, a Cloudflare quick tunnel, ngrok, or pages.dev",
                )
                .into());
            }
            let now = OffsetDateTime::now_utc();
            let stamp = to_millis(now);
            let expires = to_millis(now + DEV_SESSION_TTL);
            let master = orm(&master);
            let existing: Option<String> = dev_sessions::Entity::find()
                .select_only()
                .column(dev_sessions::Column::Id)
                .filter(dev_sessions::Column::AppId.eq(&app_id))
                .filter(dev_sessions::Column::UserId.eq(&caller.user_id))
                .filter(dev_sessions::Column::WorkspaceId.eq(&caller.workspace_id))
                .into_tuple()
                .one(&master)
                .await
                .or_internal(FAILED)?;
            let stored: Option<dev_sessions::Model> = match existing {
                Some(id) => dev_sessions::Entity::update_many()
                    .col_expr(dev_sessions::Column::Url, Expr::value(&url))
                    .col_expr(dev_sessions::Column::ExpiresAt, Expr::value(expires))
                    .col_expr(dev_sessions::Column::UpdatedAt, Expr::value(stamp))
                    .filter(dev_sessions::Column::Id.eq(id))
                    .exec_with_returning(&master)
                    .await
                    .or_internal(FAILED)?
                    .into_iter()
                    .next(),
                None => Some(
                    dev_sessions::Entity::insert(dev_sessions::ActiveModel {
                        id: Set(generate_id("uads")),
                        app_id: Set(app_id),
                        workspace_id: Set(caller.workspace_id.clone()),
                        user_id: Set(caller.user_id.clone()),
                        url: Set(url),
                        expires_at: Set(expires),
                        created_at: Set(stamp),
                        updated_at: Set(stamp),
                    })
                    .exec_with_returning(&master)
                    .await
                    .or_internal(FAILED)?,
                ),
            };
            let view = stored
                .and_then(|session| session_view(&session.url, session.expires_at))
                .ok_or_else(|| {
                    AppsError::internal(
                        FAILED,
                        "Preview session was stored with a URL that is not an allowed preview URL",
                    )
                })?;
            Ok(Data(view).into_response())
        }
        .await,
    )
}

async fn delete_dev_session(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
) -> Response {
    answer(delete_session(&state, &caller, &code).await)
}

async fn delete_session(
    state: &CoreAppsState,
    caller: &Caller,
    code: &str,
) -> AppsResult<Response> {
    const FAILED: &str = "Failed to clear preview session";
    let master = caller.master(state);
    let app_id = owned_app_by_code(&master, code, &caller.workspace_id)
        .await
        .or_internal(FAILED)?
        .ok_or_else(|| AppsError::api(ApiError::not_found("App", Some(code))))?;
    dev_sessions::Entity::delete_many()
        .filter(dev_sessions::Column::AppId.eq(&app_id))
        .filter(dev_sessions::Column::UserId.eq(&caller.user_id))
        .filter(dev_sessions::Column::WorkspaceId.eq(&caller.workspace_id))
        .exec(&orm(&master))
        .await
        .or_internal(FAILED)?;
    Ok(NoContent.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_paths_stay_under_v1() {
        assert_eq!(normalize_gateway_path("/v1/contacts"), Some("/v1/contacts"));
        assert_eq!(normalize_gateway_path("/v1/a%20b"), Some("/v1/a%20b"));
        for bad in [
            "/v2/x",
            "/v1",
            "/v1/a//b",
            "/v1/a%2Fb",
            "/v1/%2e%2e/x",
            "/v1/a\\b",
            "/v1/%zz",
        ] {
            assert_eq!(normalize_gateway_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn uri_components_decode_like_javascript() {
        assert_eq!(decode_uri_component("a%20b%2Fc").as_deref(), Some("a b/c"));
        assert_eq!(decode_uri_component("%E2%82%AC").as_deref(), Some("€"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%FF"), None);
    }
}
