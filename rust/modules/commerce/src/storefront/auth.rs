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

use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::header::{self, HeaderName, HeaderValue};
use http::{HeaderMap, Method, StatusCode};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use weldsuite_commerce_domain::carts;
use weldsuite_db::orm;
use weldsuite_events::EventContext;
use weldsuite_schema::master::storefront_key_registry as registry;
use weldsuite_schema::tenant::commerce_channel_keys;

use super::{Principal, StorefrontState, fail, internal, limit};
use crate::args::utc_now_sql;

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
async fn lookup(state: &StorefrontState, hash: &str) -> Result<Option<Entry>, DbErr> {
    let cache_key = format!("sfk:{hash}");
    if let Some(cache) = &state.cache
        && let Ok(Some(raw)) = cache.get_boxed(&cache_key).await
        && let Ok(entry) = serde_json::from_str::<Entry>(&raw)
    {
        return Ok(Some(entry));
    }
    let row: Option<(String, String, String, String, Value)> = registry::Entity::find()
        .select_only()
        .columns([
            registry::Column::Id,
            registry::Column::Kind,
            registry::Column::WorkspaceId,
            registry::Column::ChannelId,
            registry::Column::AllowedOrigins,
        ])
        .filter(registry::Column::KeyHash.eq(hash))
        .filter(registry::Column::RevokedAt.is_null())
        .into_tuple()
        .one(&orm(&state.master))
        .await?;
    // Origins that are not a list of strings make no entry, as reading the
    // row as an `Entry` refused them.
    let entry = row.and_then(|(id, kind, workspace_id, channel_id, origins)| {
        Some(Entry {
            id,
            kind,
            workspace_id,
            channel_id,
            origins: serde_json::from_value(origins).ok()?,
        })
    });
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
        if let Err(error) = commerce_channel_keys::Entity::update_many()
            .col_expr(commerce_channel_keys::Column::LastUsedAt, utc_now_sql())
            .filter(commerce_channel_keys::Column::Id.eq(id.as_str()))
            .exec(&orm(&tenant))
            .await
        {
            tracing::warn!(%error, "[storefront] last_used_at not updated");
        }
        if let Err(error) = registry::Entity::update_many()
            .col_expr(registry::Column::LastUsedAt, utc_now_sql())
            .filter(registry::Column::Id.eq(id.as_str()))
            .exec(&orm(&master))
            .await
        {
            tracing::warn!(%error, "[storefront] registry last_used_at not updated");
        }
    });
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
    let Some(key) = bearer(request.headers()).map(str::to_owned) else {
        return invalid_key();
    };
    let publishable = key.starts_with("wcp_");
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
    let entry = match lookup(&state, &hash).await {
        Ok(Some(entry)) => entry,
        Ok(None) => return with_cors(invalid_key(), cors_origin),
        Err(error) => return internal(&error, "The key could not be checked"),
    };
    if entry.kind == "publishable" {
        let allowed = origin
            .as_deref()
            .is_some_and(|o| entry.origins.iter().any(|a| same_origin(a, o)));
        if !allowed {
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
    touch(&state, &entry, &tenant.db).await;
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
