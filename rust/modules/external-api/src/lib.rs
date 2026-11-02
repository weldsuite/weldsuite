//! WeldSuite's public API, external-api (`apps/workers/external-api`,
//! `api.weldsuite.org` on Global): `/v1/<object>` for third-party
//! integrations, the `weld` CLI and installed WeldApps.
//!
//! On Kubernetes the API is served by `weldsuite serve` on the edition's own
//! host, at `/v1` beside `/api` (one host serves every path, OPS-013); the
//! frontends learn the origin from `/config.json` (`publicApiUrl`).
//!
//! The layers, outermost first, as `src/index.ts` runs them on `/v1/*`:
//! [`authenticate`] (a `wsk_` key or a `wsat_` app token → [`ApiSession`] and
//! the tenant database), [`licence_gate`] (a partner-managed workspace's
//! licence, a read-only workspace's writes) and [`rate_limit`] (per
//! workspace and plan tier, on the cache's counters). Routes then check
//! their scope (`requireScope`).
//!
//! The object groups are mounted only where their module is served
//! (`mounts`): a group of a module not ported to Rust is not on Kubernetes.
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the
//! `external-api` conformance suite (`rust/conformance/suites.json`).

// Handlers answer a ready `Response` as their error (a validation failure).
#![allow(clippy::result_large_err)]

/// `requireScope(scope)` as a route layer.
macro_rules! scope {
    ($scope:literal) => {
        axum::middleware::from_fn_with_state($scope, crate::session::require_scope)
    };
}

mod app_storage;
mod auth;
mod gates;
mod index;
mod list;
mod oauth;
mod session;
mod settings;
mod user_apps;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::ApiError;
use weldsuite_ports::DynCache;

pub use auth::{authenticate, insert_session};
pub use gates::{licence_gate, module_for_external_path, rate_limit};
pub use session::{ApiSession, KeyType, has_scope};

/// What the handlers share, cloned from the app state.
#[derive(Clone)]
pub struct ExternalApiState {
    pub events: EntityEventPublisher,
    /// The master database (the key registry, app tokens, WeldApps).
    pub master: PgPool,
    /// Every workspace's tenant database.
    pub workspaces: Arc<Workspaces>,
    /// The registry, app-token and tier caches, and the rate limit counters
    /// (`API_CACHE` and the rate limit bindings on Global).
    pub cache: Option<Arc<dyn DynCache>>,
    /// The settings the worker reads from `env`.
    pub env: Arc<HashMap<String, String>>,
    /// The public bucket (`STORAGE`): WeldApps bundles.
    pub public_files: Option<Arc<dyn weldsuite_ports::DynFileStore>>,
}

impl std::fmt::Debug for ExternalApiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalApiState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

/// The cache for the public API's own entries (`API_CACHE` on Global) for
/// this request, in place of the state's: conformance builds give the test's
/// namespace, or none (`None`).
#[derive(Clone)]
pub struct RequestApiCache(pub Option<Arc<dyn DynCache>>);

/// The master database: the request's (conformance builds give the test's),
/// else the state's.
pub(crate) fn master_db(state: &ExternalApiState, extensions: &http::Extensions) -> PgPool {
    extensions
        .get::<weldsuite_db::MasterDb>()
        .map_or_else(|| state.master.clone(), |master| master.0.clone())
}

/// The settings [`ExternalApiState::env`] holds.
pub const ENV_KEYS: [&str; 2] = ["ENVIRONMENT", "WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS"];

impl ExternalApiState {
    /// The env settings this crate reads, from the process environment.
    pub fn env_from_process() -> HashMap<String, String> {
        ENV_KEYS
            .iter()
            .filter_map(|key| {
                std::env::var(key)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(|value| ((*key).to_owned(), value))
            })
            .collect()
    }
}

/// `/v1`, relative to its prefix, without the layers (the server adds
/// [`authenticate`], [`licence_gate`] and [`rate_limit`], or the conformance
/// session). `mounts(module)` says whether a module is served here.
pub fn router<S>(state: ExternalApiState, mounts: &dyn Fn(&str) -> bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let router = Router::new()
        .route("/", get(index::describe))
        .route("/health/db", get(index::health_db))
        // Before authentication: the client credentials are the auth.
        .route("/oauth/token", post(oauth::token));
    let router = if mounts("core") {
        core(weldapps(router))
    } else {
        router
    };
    router
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(state)
}

/// WeldApps: the CLI's developer API (`/v1/user-apps`) and the data plane
/// (`/v1/app-storage`).
fn weldapps(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route("/user-apps/agent-tools", get(user_apps::agent_tools))
        .route("/user-apps", get(user_apps::list).post(user_apps::create))
        .route(
            "/user-apps/{id}",
            get(user_apps::detail)
                .patch(user_apps::update)
                .delete(user_apps::remove),
        )
        .route(
            "/user-apps/{id}/versions",
            get(user_apps::versions)
                .post(user_apps::upload_version)
                // Bundles go up to 50 MB, in one multipart body.
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/user-apps/{id}/submit", post(user_apps::submit))
        .route(
            "/user-apps/{id}/dev-session",
            put(user_apps::put_dev_session).delete(user_apps::delete_dev_session),
        )
        .route(
            "/user-apps/{id}/oauth-client",
            get(user_apps::oauth_client).post(user_apps::rotate_oauth_client),
        )
        .route(
            "/app-storage/collections/{collection}/records",
            get(app_storage::list_records).post(app_storage::create_record),
        )
        .route(
            "/app-storage/collections/{collection}/records/{id}",
            get(app_storage::get_record)
                .patch(app_storage::update_record)
                .delete(app_storage::delete_record),
        )
        .route(
            "/app-storage/kv/{key}",
            get(app_storage::get_kv)
                .put(app_storage::put_kv)
                .delete(app_storage::delete_kv),
        )
}

/// The core platform's own objects: `/v1/settings`.
fn core(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/settings/workspace",
            get(settings::workspace).route_layer(scope!("settings:read")),
        )
        .route(
            "/settings/members",
            get(settings::members).route_layer(scope!("members:read")),
        )
        .route(
            "/settings/members/{id}",
            get(settings::member).route_layer(scope!("members:read")),
        )
}

/// The worker's `notFound`, also for a known path with another method.
async fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "The requested endpoint does not exist",
    )
}
