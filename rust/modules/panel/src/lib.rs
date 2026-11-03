//! WeldPanel (product analytics): panel-api's project routes
//! (`apps/workers/panel-api`, `/api/panel/projects`) and the public collector
//! panel-ingest serves on Global (`apps/workers/panel-ingest`: `/s.js`,
//! `/c/:token`, `POST /e`), with `@weldsuite/panel-domain`'s rules.
//!
//! The tenant `panel_projects` row is the source of truth. Every change
//! also writes the master `panel_project_registry` row and the cache record
//! `panel:project:<token>` the collector reads ([`registry`]); the collector
//! never opens a tenant database (ADR DATA-008).
//!
//! What Cloudflare gives panel-ingest, and what it is here ([`collector`]):
//!
//! - the events stream (a Pipelines binding feeding the Basin table
//!   `panel.events_v1`): one message per row on a `JetStream` stream, subject
//!   `panel.events.v1.<workspace>`, through [`EventSink`];
//! - `PanelSalt`, the global Durable Object holding each UTC day's random
//!   salt of the cookieless visitor hash: the cache (Valkey), the salt
//!   claimed by the first pod that needs it and kept two days ([`SaltSource`]);
//! - `PanelUsage`, events counted per workspace and UTC day: atomic counters
//!   in the cache ([`UsageCounter`]);
//! - KV: the cache. The cache is not durable storage, so a project record
//!   missing from it is read from the master registry and put back.
//!
//! Paths, bodies, status codes, messages and side effects are the
//! TypeScript workers'; their tests run against this crate in the `panel`
//! conformance suites (`rust/conformance/suites.json`).

pub mod collector;
mod domain;
mod js;
mod projects;
mod registry;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    PANEL_PROJECTS_CREATE, PANEL_PROJECTS_DELETE, PANEL_PROJECTS_MANAGE, PANEL_PROJECTS_READ,
    PANEL_PROJECTS_UPDATE,
};
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, RequestCache};

pub use collector::{
    BusSink, CacheSalt, CacheUsage, CollectorState, EventSink, RequestCollector, SaltSource,
    UsageCounter,
};

/// What the project routes share.
#[derive(Clone)]
pub struct PanelState {
    pub events: EntityEventPublisher,
    /// The cache the collector reads (`WORKSPACE_CACHE` on Global). A
    /// request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (`panel_project_registry`). A request's
    /// `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// `PANEL_COLLECTOR_URL`: the collector origin the install snippets
    /// point at; else the origin the request came to, where this server
    /// serves the collector too.
    pub collector_url: Option<String>,
}

impl std::fmt::Debug for PanelState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PanelState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("collector_url", &self.collector_url)
            .finish()
    }
}

/// `/api/panel/projects`, relative to `/api/panel/projects`, behind the
/// session, tenant database, licence and flag layers.
pub fn router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_PROJECTS_READ]);
    let manage = || gate.require([PANEL_PROJECTS_MANAGE]);
    Router::new()
        .route("/", get(projects::list).route_layer(read()))
        .route(
            "/",
            post(projects::create).route_layer(gate.require([PANEL_PROJECTS_CREATE])),
        )
        .route("/{id}", get(projects::detail).route_layer(read()))
        .route(
            "/{id}",
            patch(projects::update).route_layer(gate.require([PANEL_PROJECTS_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(projects::remove)
                .route_layer(gate.require([PANEL_PROJECTS_DELETE])),
        )
        .route(
            "/{id}/settings",
            patch(projects::update_settings).route_layer(manage()),
        )
        .route(
            "/{id}/rotate-token",
            post(projects::rotate_token).route_layer(manage()),
        )
        .route("/{id}/install", get(projects::install).route_layer(read()))
        .with_state(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('workspaceId')`: `workspaces.id`; empty without one.
    pub(crate) workspace_id: String,
    pub(crate) events: EventContext,
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    headers: HeaderMap,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &PanelState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    /// `c.env.<name>`: the test's (conformance), else the process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => std::env::var(name).ok(),
        }
        .filter(|value| !value.is_empty())
    }

    /// `c.env.WORKSPACE_CACHE`: the test's KV (conformance), else the state's.
    pub(crate) fn cache(&self, state: &PanelState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    /// `getMasterDb(c.env)`: the test's (conformance), else the state's.
    pub(crate) fn master(&self, state: &PanelState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    /// `c.env.PANEL_COLLECTOR_URL`; on Kubernetes, without one, the origin
    /// the request came to (as the ingress forwarded it), which serves the
    /// collector at its root too.
    pub(crate) fn collector_url(&self, state: &PanelState) -> Option<String> {
        if self.conformance() {
            return self.env("PANEL_COLLECTOR_URL");
        }
        state
            .collector_url
            .clone()
            .or_else(|| request_origin(&self.headers))
    }
}

/// `https://<host>` of the request as the ingress forwarded it.
pub(crate) fn request_origin(headers: &HeaderMap) -> Option<String> {
    let first = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let host = first("x-forwarded-host").or_else(|| first("host"))?;
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return None;
    }
    let scheme = match first("x-forwarded-proto") {
        Some(proto) if proto.eq_ignore_ascii_case("http") => "http",
        _ => "https",
    };
    Some(format!("{scheme}://{host}"))
}

/// Behind the session and tenant database layers; without them it is a
/// routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        let caller = if let (Some(auth), Some(tenant)) =
            (extensions.get::<AuthContext>(), extensions.get::<Tenant>())
        {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                events: EventContext::for_request(auth, tenant),
                env: extensions.get::<RequestEnv>().cloned(),
                cache: extensions
                    .get::<RequestCache>()
                    .map(|cache| Arc::clone(&cache.0)),
                master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
                headers: parts.headers.clone(),
            })
        } else {
            tracing::error!("panel: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Box<Response>> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| Box::new(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    value.ok_or_else(|| Box::new(ApiError::internal().into_response()))
}

/// What the worker's `onError` answers for anything a route throws.
pub(crate) fn unexpected(error: &dyn std::fmt::Display, what: &str) -> Response {
    tracing::error!(%error, "[panel-api] {what}");
    ApiError::internal()
        .with_message("An unexpected error occurred")
        .into_response()
}
