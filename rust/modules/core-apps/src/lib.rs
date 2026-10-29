//! WeldApps (user-created apps) and the sign-in surfaces around them, as
//! app-api serves them (`apps/workers/app-api/src/routes/`):
//!
//! | Router | Prefix | TypeScript | Layers |
//! |---|---|---|---|
//! | [`user_apps`] | `/api/user-apps` | `routes/user-apps` | session + workspace |
//! | [`public_user_apps`] | `/public/user-apps` | `routes/public-user-apps` | none (the bundle host) |
//! | [`cli_auth_public`] | `/api/cli-auth` (`/device`, `/token`) | `routes/cli-auth` | none |
//! | [`cli_auth_approve`] | `/api/cli-auth/approve` | `routes/cli-auth` | session + workspace |
//! | [`auth_desktop`] | `/api/auth-desktop` | `routes/auth-desktop` | session only |
//!
//! Apps live in the master database (`user_apps`, `user_app_versions`,
//! `user_app_installs`, `user_app_tokens`, `user_app_oauth_clients`,
//! `user_app_dev_sessions`, `app_developer_accounts`); an install is mirrored
//! into the tenant's `workspace_installed_apps`. Bundles are objects in the
//! public bucket (`STORAGE`, the Files port's public store).
//!
//! Outbound HTTP (the app gateway's forward to external-api, lifecycle
//! webhooks) goes through [`HttpTransport`]: reqwest in a deployment, the
//! conformance harness's outbound bridge in tests. external-api is not ported
//! yet, so the gateway forwards to `EXTERNAL_API_URL` over HTTP, as app-api
//! does without its `EXTERNAL_API` service binding.
//!
//! Billing (Stripe subscriptions, Connect payouts) is Global-only: these
//! routes only read the columns Stripe's webhooks write, as app-api does.

/// A `user_apps` row as JSON, with `price_monthly` as Drizzle reads
/// `numeric` (a string). `a` is the table's alias.
macro_rules! app_json {
    () => {
        "to_jsonb(a) || jsonb_build_object('price_monthly', a.price_monthly::text)"
    };
}

mod access;
mod apps;
mod auth_desktop;
mod bundle_access;
mod bundle_host;
mod cli_auth;
mod code_routes;
mod http_transport;
mod publish;
mod schemas;
mod scopes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, FileStores, Identity};

pub use http_transport::{
    AppsHttp, HttpTransport, OutboundRequest, OutboundResponse, ReqwestTransport,
};

/// What the handlers share, cloned from the app state.
#[derive(Clone)]
pub struct CoreAppsState {
    pub events: EntityEventPublisher,
    /// The master database.
    pub master: PgPool,
    /// Every workspace's tenant database (an official app's install sweep).
    pub workspaces: Arc<Workspaces>,
    /// The workspace cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn DynCache>>,
    /// The buckets; bundles live in the public one (`STORAGE`).
    pub files: Option<FileStores>,
    /// The identity provider (Clerk in the Global edition): CLI login labels,
    /// desktop sign-in tokens.
    pub identity: Option<Arc<dyn Identity>>,
    /// Outbound HTTP (gateway forwards, lifecycle webhooks).
    pub http: Arc<dyn HttpTransport>,
    /// The environment's settings the workers read from `env`
    /// (`ENVIRONMENT`, `EXTERNAL_API_URL`, `INTERNAL_API_SECRET`,
    /// `USER_APP_BUNDLE_*`, `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS`, …).
    pub env: Arc<HashMap<String, String>>,
    /// The gateway's session tokens, per process (the worker's per-isolate
    /// cache in front of KV).
    pub gateway_tokens: Arc<GatewayTokens>,
}

/// The app gateway's session tokens, kept per process in front of the
/// workspace cache.
#[derive(Debug, Default)]
pub struct GatewayTokens(pub(crate) Mutex<HashMap<String, code_routes::CachedGatewayToken>>);

impl CoreAppsState {
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

/// The settings [`CoreAppsState::env`] holds.
pub const ENV_KEYS: [&str; 7] = [
    "ENVIRONMENT",
    "EXTERNAL_API_URL",
    "INTERNAL_API_SECRET",
    "USER_APP_BUNDLE_SIGNING_KEY",
    "USER_APP_BUNDLE_ORIGIN",
    "USER_APP_FRAME_ANCESTORS",
    "WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS",
];

impl std::fmt::Debug for CoreAppsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreAppsState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("files", &self.files.is_some())
            .field("identity", &self.identity.is_some())
            .finish_non_exhaustive()
    }
}

/// `/api/user-apps`: the developer's apps, versions, review, the store,
/// installs and consent, OAuth clients, session tokens, bundle links, the
/// app gateway and preview sessions.
pub fn user_apps<S, Q>(state: CoreAppsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    apps::router(gate)
        .merge(code_routes::router(gate))
        .with_state(state)
}

/// `/public/user-apps`: the bundle host. Unauthenticated.
pub fn public_user_apps<S>(state: CoreAppsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    bundle_host::router().with_state(state)
}

/// `/api/cli-auth/device` and `/api/cli-auth/token`: public, relative to
/// `/api/cli-auth`.
pub fn cli_auth_public<S>(state: CoreAppsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    cli_auth::public_router().with_state(state)
}

/// `/api/cli-auth/approve`: behind the session and the workspace, relative
/// to `/api/cli-auth`.
pub fn cli_auth_approve<S>(state: CoreAppsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    cli_auth::approve_router().with_state(state)
}

/// `/api/auth-desktop`: behind the session only (no workspace needed).
pub fn auth_desktop<S>(state: CoreAppsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    auth_desktop::router().with_state(state)
}

/// `bundleHostRejection`: with a dedicated bundle origin
/// (`USER_APP_BUNDLE_ORIGIN`), the bundle host answers nothing but bundles.
/// The 404 for a request on it outside `/public/user-apps/`, else `None`.
pub fn bundle_host_rejection(
    env: &HashMap<String, String>,
    headers: &http::HeaderMap,
    path: &str,
) -> Option<axum::response::Response> {
    use axum::response::IntoResponse;
    let lookup = |key: &str| env.get(key).map(String::as_str);
    if lookup("USER_APP_BUNDLE_ORIGIN").is_none_or(|value| value.trim().is_empty()) {
        return None;
    }
    let origin = bundle_host::request_origin(headers);
    (bundle_access::is_dedicated_bundle_origin(lookup, &origin)
        && !path.starts_with("/public/user-apps/"))
    .then(|| {
        weldsuite_kit::ApiError::new(http::StatusCode::NOT_FOUND, "NOT_FOUND", "Not found")
            .into_response()
    })
}
