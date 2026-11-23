//! Key authentication and CORS for `/storefront/v1`.
//!
//! `Authorization: Bearer wcp_…|wcs_…` → SHA-256 → the master
//! `storefront_key_registry` (a live entry cached 30 seconds, so a revoked
//! key stops within that) → the workspace (`workspaces.id`) and its tenant
//! database → the channel, which must be `active`. A publishable key only
//! works from one of its allowed origins and gets CORS for that origin; a
//! private key has no origin check and no CORS. A preflight is answered
//! without a key (echoing the origin: the real request is checked).
//!
//! `last_used_at` is written, in the tenant and the master, at most once a
//! minute per key.
//!
//! The storefront renderer of WeldSuite-hosted shops (storefronts plan) is a
//! third kind of caller, *hosted*: `Authorization: Hosted <renderer secret>`
//! with `X-Storefront-Host: <shop host>`. The host resolves through the
//! master `storefront_hosts` to its workspace and channel; it acts like a
//! private key of that channel (the shopper's address in `X-Shopper-Ip`),
//! and its payment redirects must stay on the shop's own hosts.

use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::header::{self, HeaderName, HeaderValue};
use http::{HeaderMap, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use weldsuite_commerce_domain::carts;
use weldsuite_events::EventContext;

use super::{Principal, StorefrontState, fail, internal, limit};

const KEY_CACHE_TTL: Duration = Duration::from_secs(30);
const ALLOW_HEADERS: &str =
    "authorization, content-type, x-cart-token, x-shopper-token, idempotency-key";
const ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    kind: String,
    workspace_id: String,
    channel_id: String,
    origins: Vec<String>,
}

fn origin_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .map(str::to_owned)
}

/// Origins compare exactly, ignoring case and a trailing slash.
fn same_origin(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|key| key.starts_with("wcp_") || key.starts_with("wcs_"))
}

/// CORS headers for `origin` on a response.
fn with_cors(mut response: Response, origin: Option<&str>) -> Response {
    if let Some(value) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("retry-after"),
        );
    }
    response
}

fn preflight(origin: Option<&str>) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOW_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOW_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    with_cors(response, origin)
}

fn invalid_key() -> Response {
    fail(
        StatusCode::UNAUTHORIZED,
        "INVALID_KEY",
        "Invalid or missing storefront key. Send Authorization: Bearer wcp_… or wcs_….",
        None,
    )
}

fn inactive() -> Response {
    fail(
        StatusCode::FORBIDDEN,
        "CHANNEL_INACTIVE",
        "This sales channel is not active",
        None,
    )
}

/// The registry entry of a key hash, from the cache or the master database;
/// `None` for an unknown or revoked key.
async fn lookup(state: &StorefrontState, hash: &str) -> Result<Option<Entry>, sqlx::Error> {
    let cache_key = format!("sfk:{hash}");
    if let Some(cache) = &state.cache
        && let Ok(Some(raw)) = cache.get_boxed(&cache_key).await
        && let Ok(entry) = serde_json::from_str::<Entry>(&raw)
    {
        return Ok(Some(entry));
    }
    let row: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'kind', kind, 'workspaceId', workspace_id, \
           'channelId', channel_id, 'origins', allowed_origins) \
         from storefront_key_registry where key_hash = $1 and revoked_at is null",
    )
    .bind(hash)
    .fetch_optional(&state.master)
    .await?;
    let entry = row.and_then(|row| serde_json::from_value::<Entry>(row).ok());
    if let (Some(entry), Some(cache)) = (&entry, &state.cache)
        && let Ok(raw) = serde_json::to_string(entry)
        && let Err(error) = cache.put_boxed(&cache_key, &raw, Some(KEY_CACHE_TTL)).await
    {
        tracing::warn!(%error, "[storefront] key cache write failed");
    }
    Ok(entry)
}

/// Write `last_used_at` once a minute.
async fn touch(state: &StorefrontState, entry: &Entry, tenant: &weldsuite_db::PgPool) {
    let Some(cache) = &state.cache else {
        return;
    };
    let counter = format!("sfk-used:{}", entry.id);
    if !matches!(
        cache
            .increment_boxed(&counter, 1, Some(Duration::from_secs(60)))
            .await,
        Ok(1)
    ) {
        return;
    }
    let (master, tenant, id) = (state.master.clone(), tenant.clone(), entry.id.clone());
    state.events.tracker().spawn(async move {
        if let Err(error) = sqlx::query(
            "update commerce_channel_keys set last_used_at = now() at time zone 'utc' where id = $1",
        )
        .bind(&id)
        .execute(&tenant)
        .await
        {
            tracing::warn!(%error, "[storefront] last_used_at not updated");
        }
        if let Err(error) = sqlx::query(
            "update storefront_key_registry set last_used_at = now() at time zone 'utc' where id = $1",
        )
        .bind(&id)
        .execute(&master)
        .await
        {
            tracing::warn!(%error, "[storefront] registry last_used_at not updated");
        }
    });
}

/// The renderer's `Authorization: Hosted <secret>`, checked; the shop host
/// it names, resolved to a registry-like entry with the shop's origins.
/// `Ok(None)` when the request isn't the renderer's.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn hosted_entry(
    state: &StorefrontState,
    headers: &HeaderMap,
) -> Result<Option<Entry>, Response> {
    let Some(given) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Hosted "))
    else {
        return Ok(None);
    };
    let secret = state.hosting.secret.as_deref().unwrap_or_default();
    if secret.is_empty() || !crate::online_store::tokens::same(given.trim(), secret) {
        return Err(invalid_key());
    }
    let Some(host) = headers
        .get("x-storefront-host")
        .and_then(|v| v.to_str().ok())
        .map(weldsuite_custom_domains::normalize_host)
        .filter(|h| !h.is_empty())
    else {
        return Err(invalid_key());
    };
    match crate::online_store::registry::lookup(&state.master, state.hosting.cache.as_ref(), &host)
        .await
    {
        Ok(Some(found)) => Ok(Some(Entry {
            id: found.id.clone(),
            kind: "hosted".to_owned(),
            workspace_id: found.workspace_id.clone(),
            channel_id: found.channel_id.clone(),
            origins: found
                .site_hosts
                .iter()
                .map(|h| state.hosting.origin(h))
                .collect(),
        })),
        Ok(None) => Err(invalid_key()),
        Err(error) => Err(internal(&error, "The shop could not be reached")),
    }
}

/// `origin` is an active WeldSuite-hosted address of the key's own channel
/// (storefronts plan, static deployments).
async fn hosted_origin(state: &StorefrontState, entry: &Entry, origin: Option<&str>) -> bool {
    let Some(host) = origin
        .and_then(|o| url::Url::parse(o).ok())
        .and_then(|u| u.host_str().map(weldsuite_custom_domains::normalize_host))
    else {
        return false;
    };
    let Ok(Some(found)) =
        crate::online_store::registry::lookup(&state.master, state.hosting.cache.as_ref(), &host)
            .await
    else {
        return false;
    };
    found.workspace_id == entry.workspace_id
        && found.channel_id == entry.channel_id
        && origin.is_some_and(|o| same_origin(&state.hosting.origin(&host), o))
}

/// The `/storefront/v1` authentication layer.
#[allow(
    clippy::too_many_lines,
    reason = "the checks in order, each with its own refusal"
)]
pub(crate) async fn authenticate(
    State(state): State<StorefrontState>,
    mut request: Request,
    next: Next,
) -> Response {
    let origin = origin_of(request.headers());
    if request.method() == Method::OPTIONS {
        return preflight(origin.as_deref());
    }
    let hosted = match hosted_entry(&state, request.headers()).await {
        Ok(hosted) => hosted,
        Err(response) => return response,
    };
    let key = match (&hosted, bearer(request.headers())) {
        (Some(entry), _) => format!("hosted:{}", entry.id),
        (None, Some(key)) => key.to_owned(),
        (None, None) => return invalid_key(),
    };
    let publishable = hosted.is_none() && key.starts_with("wcp_");
    let cors_origin = if publishable { origin.as_deref() } else { None };
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    let client = if publishable {
        limit::proxy_client(request.headers(), state.trusted_proxies)
    } else {
        limit::shopper(request.headers(), state.trusted_proxies)
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if let Some(wait) = limit::check(
        state.cache.as_ref(),
        &hash,
        &client,
        request.method(),
        request.uri().path(),
        now,
    )
    .await
    {
        let mut response = weldsuite_kit::ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many requests",
        )
        .with_retry_after(wait)
        .into_response();
        if let Ok(value) = HeaderValue::from_str(&wait.to_string()) {
            response
                .headers_mut()
                .insert(HeaderName::from_static("retry-after"), value);
        }
        return with_cors(response, cors_origin);
    }
    let entry = match hosted {
        Some(entry) => entry,
        None => match lookup(&state, &hash).await {
            Ok(Some(entry)) => entry,
            Ok(None) => return with_cors(invalid_key(), cors_origin),
            Err(error) => return internal(&error, "The key could not be checked"),
        },
    };
    // A deploy key uploads deployments; it never shops.
    if entry.kind == "deploy" {
        return with_cors(invalid_key(), cors_origin);
    }
    let mut entry = entry;
    if entry.kind == "publishable" {
        let listed = origin
            .as_deref()
            .is_some_and(|o| entry.origins.iter().any(|a| same_origin(a, o)));
        // A shop WeldSuite hosts for this channel may use the channel's
        // publishable keys from its own addresses without listing them.
        let hosted = !listed && hosted_origin(&state, &entry, origin.as_deref()).await;
        if hosted && let Some(origin) = &origin {
            entry.origins.push(origin.clone());
        }
        if !listed && !hosted {
            return fail(
                StatusCode::FORBIDDEN,
                "ORIGIN_NOT_ALLOWED",
                "This publishable key cannot be used from this origin",
                None,
            );
        }
    }
    let tenant = match state.workspaces.tenant(&entry.workspace_id).await {
        Ok(tenant) => tenant,
        Err(error) => {
            return with_cors(
                internal(&error, "The shop could not be reached"),
                cors_origin,
            );
        }
    };
    let licensed = tenant
        .licensed_apps()
        .is_none_or(|apps| apps.iter().any(|a| a == "weldcommerce"));
    let write = !matches!(*request.method(), Method::GET | Method::HEAD);
    if tenant.suspended || !licensed || (write && tenant.restrictions.read_only) {
        let response = if tenant.restrictions.read_only
            && tenant.read_only_reason() == Some(weldsuite_db::ReadOnlyReason::DatabaseMove)
        {
            weldsuite_kit::ApiError::workspace_moving().into_response()
        } else {
            inactive()
        };
        return with_cors(response, cors_origin);
    }
    let channel = {
        let mut conn = match tenant.db.acquire().await {
            Ok(conn) => conn,
            Err(error) => {
                return with_cors(
                    internal(&error, "The shop could not be reached"),
                    cors_origin,
                );
            }
        };
        match carts::load_channel(&mut conn, &entry.channel_id).await {
            Ok(Some(channel)) if channel.status == "active" => channel,
            Ok(_) => return with_cors(inactive(), cors_origin),
            Err(error) => {
                return with_cors(
                    internal(&error, "The shop could not be reached"),
                    cors_origin,
                );
            }
        }
    };
    if entry.kind != "hosted" {
        touch(&state, &entry, &tenant.db).await;
    }
    request.extensions_mut().insert(Principal {
        db: tenant.db.clone(),
        workspace_id: tenant.workspace_id.clone(),
        key_kind: entry.kind.clone(),
        key_origins: entry.origins.clone(),
        channel,
        events: EventContext::from_ids(
            &tenant.workspace_id,
            tenant.clerk_org_id.as_deref(),
            "system",
        ),
        state: state.clone(),
    });
    with_cors(next.run(request).await, cors_origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_compare_exactly() {
        assert!(same_origin(
            "https://shop.example.com",
            "https://SHOP.example.com/"
        ));
        assert!(!same_origin(
            "https://shop.example.com",
            "https://evil.example.com"
        ));
        assert!(!same_origin(
            "https://example.com",
            "https://example.com.evil.test"
        ));
    }

    #[test]
    fn only_storefront_keys_count() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wsk_x"),
        );
        assert!(bearer(&headers).is_none());
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wcp_x"),
        );
        assert_eq!(bearer(&headers), Some("wcp_x"));
    }
}

#[cfg(test)]
mod cors_tests {
    use super::*;

    #[test]
    fn a_browser_may_send_every_header_a_shop_needs() {
        let allowed: Vec<&str> = ALLOW_HEADERS.split(',').map(str::trim).collect();
        for header in [
            "authorization",
            "content-type",
            "x-cart-token",
            "x-shopper-token",
            "idempotency-key",
        ] {
            assert!(allowed.contains(&header), "{header} in {ALLOW_HEADERS}");
        }
    }
}
