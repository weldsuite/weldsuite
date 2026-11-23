//! `/public/storefront/*`: what the storefront renderer reads, with the
//! install's `STOREFRONT_RENDERER_SECRET` as its bearer token. The renderer
//! is only reachable through the storefront edge, and this mount only from
//! inside the cluster: shop hosts never reach it (the edge serves those).
//!
//!   GET /public/storefront/site?host=<host>[&preview=<token>]
//!       → the site's published version (or, with a valid preview token for
//!         that site, its draft), its channel and its hosts

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderMap, StatusCode, header};
use sea_orm::EntityTrait;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use weldsuite_db::{Workspaces, orm};
use weldsuite_kit::{ApiError, Data};
use weldsuite_schema::tenant::{commerce_channels, storefront_site_versions};

use super::config::OnlineStoreConfig;
use super::registry;
use super::sites::{load_site, snapshot};
use super::tokens::{same, verify_preview};
use super::{failed, unavailable};

/// What the renderer's API needs from the server.
#[derive(Clone)]
pub struct RendererState {
    pub master: PgPool,
    pub workspaces: Arc<Workspaces>,
    pub config: OnlineStoreConfig,
}

impl std::fmt::Debug for RendererState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RendererState").finish_non_exhaustive()
    }
}

/// The renderer's routes, relative to `/public/storefront`.
pub fn router(state: RendererState) -> Router {
    Router::new().route("/site", get(site)).with_state(state)
}

fn site_not_found() -> Response {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "SITE_NOT_FOUND",
        "No shop on this address",
    )
    .into_response()
}

/// The renderer's credential is the request's bearer token.
pub(crate) fn renderer_allowed(
    config: &OnlineStoreConfig,
    headers: &HeaderMap,
    scheme: &str,
) -> bool {
    let Some(secret) = config.secret.as_deref().filter(|s| !s.is_empty()) else {
        return false;
    };
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix(scheme))
        .is_some_and(|given| same(given.trim(), secret))
}

fn query_value(query: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query?.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty())
}

#[allow(
    clippy::too_many_lines,
    reason = "the credential, the host, the workspace and the version in turn"
)]
async fn site(
    State(state): State<RendererState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "The shop could not be loaded";
    if state.config.secret.is_none() {
        return unavailable("The storefront renderer is not set up on this install");
    }
    if !renderer_allowed(&state.config, &headers, "Bearer ") {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Not the storefront renderer",
        )
        .into_response();
    }
    let Some(host) =
        query_value(query.as_deref(), "host").map(|h| weldsuite_custom_domains::normalize_host(&h))
    else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "host is required",
        )
        .into_response();
    };
    let preview = query_value(query.as_deref(), "preview");
    let entry = match registry::lookup(&state.master, state.config.cache.as_ref(), &host).await {
        Ok(Some(entry)) => entry,
        Ok(None) => return site_not_found(),
        Err(error) => return failed(&error, FAILED),
    };
    let tenant = match state.workspaces.tenant(&entry.workspace_id).await {
        Ok(tenant) => tenant,
        Err(error) => return failed(&error, FAILED),
    };
    let licensed = tenant
        .licensed_apps()
        .is_none_or(|apps| apps.iter().any(|a| a == "weldcommerce"));
    if tenant.suspended || !licensed {
        return site_not_found();
    }
    let db = orm(&tenant.db);
    let site = match load_site(&db, &entry.site_id).await {
        Ok(Some(site)) => site,
        Ok(None) => return site_not_found(),
        Err(error) => return failed(&error, FAILED),
    };
    let previewing = preview
        .as_deref()
        .zip(state.config.secret.as_deref())
        .and_then(|(token, secret)| verify_preview(secret, token))
        .is_some_and(|(site_id, workspace_id)| {
            site_id == site.id && workspace_id == tenant.workspace_id
        });
    let version = if previewing {
        match snapshot(&db, &site).await {
            Ok(document) => json!({ "id": "draft", "number": null, "document": document }),
            Err(error) => return failed(&error, FAILED),
        }
    } else {
        let Some(version_id) = site.published_version_id.clone() else {
            return ApiError::new(
                StatusCode::NOT_FOUND,
                "NOT_PUBLISHED",
                "This shop isn't published yet",
            )
            .into_response();
        };
        match storefront_site_versions::Entity::find_by_id(version_id)
            .one(&db)
            .await
        {
            Ok(Some(version)) => {
                json!({ "id": version.id, "number": version.number, "document": version.document })
            }
            Ok(None) => {
                return ApiError::new(
                    StatusCode::NOT_FOUND,
                    "NOT_PUBLISHED",
                    "This shop isn't published yet",
                )
                .into_response();
            }
            Err(error) => return failed(&error, FAILED),
        }
    };
    let channel = match commerce_channels::Entity::find_by_id(site.channel_id.clone())
        .one(&db)
        .await
    {
        Ok(Some(channel)) => channel,
        Ok(None) => return site_not_found(),
        Err(error) => return failed(&error, FAILED),
    };
    let origins: Vec<String> = entry
        .site_hosts
        .iter()
        .map(|h| state.config.origin(h))
        .collect();
    Data(json!({
        "workspaceId": tenant.workspace_id,
        "channelId": channel.id,
        "siteId": site.id,
        "host": host,
        "primaryHost": entry.primary_host,
        "primaryOrigin": state.config.origin(&entry.primary_host),
        "origins": origins,
        "locale": site.locale,
        "visibility": site.visibility,
        "preview": previewing,
        "version": version,
        "channel": {
            "id": channel.id,
            "name": channel.name,
            "status": channel.status,
            "audience": channel.audience,
            "currency": channel.currency,
            "pricesIncludeTax": channel.prices_include_tax,
            "guestCheckout": channel.guest_checkout,
            "paymentMethods": channel.payment_methods,
            "sellingCountries": channel.selling_countries,
        },
    }))
    .into_response()
}
