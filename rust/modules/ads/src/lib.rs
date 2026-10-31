//! WeldAds: ads-api's routes (`apps/workers/ads-api`): Meta ad connections
//! (`/api/ad-connections`, the OAuth start and callback, a sync, the
//! disconnect), the ad accounts they reach (`/api/ad-accounts`) and the
//! campaigns on them (`/api/ad-campaigns`). The Meta client, the campaign
//! sync and the master sync index are `weldsuite-ads-domain`'s, shared with
//! connect-api's integration endpoints.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `ads`
//! conformance suite (`rust/conformance/suites.json`).

mod accounts;
mod campaigns;
mod connections;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    AD_ACCOUNTS_READ, AD_ACCOUNTS_UPDATE, AD_CAMPAIGNS_CREATE, AD_CAMPAIGNS_READ,
    AD_CAMPAIGNS_UPDATE,
};
use weldsuite_db::{Keyring, MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, OutboundHttp, RequestCache};

/// What the WeldAds handlers share.
#[derive(Clone)]
pub struct AdsState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`), where the OAuth start keeps
    /// its state for ten minutes. A request's `RequestCache` (conformance)
    /// wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (`ad_sync_index`). A request's `MasterDb`
    /// (conformance) wins.
    pub master: Option<PgPool>,
    /// Meta's API. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
}

impl std::fmt::Debug for AdsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdsState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .finish()
    }
}

/// ads-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: AdsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let accounts_read = || gate.require([AD_ACCOUNTS_READ]);
    let accounts_update = || gate.require([AD_ACCOUNTS_UPDATE]);
    let campaigns_read = || gate.require([AD_CAMPAIGNS_READ]);
    Router::new()
        .route(
            "/ad-accounts",
            get(accounts::list).route_layer(accounts_read()),
        )
        .route(
            "/ad-accounts/{id}",
            patch(accounts::update).route_layer(accounts_update()),
        )
        .route(
            "/ad-campaigns",
            get(campaigns::list).route_layer(campaigns_read()),
        )
        .route(
            "/ad-campaigns",
            post(campaigns::create).route_layer(gate.require([AD_CAMPAIGNS_CREATE])),
        )
        .route(
            "/ad-campaigns/{id}",
            get(campaigns::detail).route_layer(campaigns_read()),
        )
        .route(
            "/ad-campaigns/{id}",
            patch(campaigns::update).route_layer(gate.require([AD_CAMPAIGNS_UPDATE])),
        )
        .route(
            "/ad-connections",
            get(connections::list).route_layer(accounts_read()),
        )
        .route(
            "/ad-connections/facebook/authorize",
            post(connections::authorize).route_layer(accounts_update()),
        )
        .route(
            "/ad-connections/facebook/callback",
            post(connections::callback).route_layer(accounts_update()),
        )
        .route(
            "/ad-connections/{id}/sync",
            post(connections::sync).route_layer(accounts_update()),
        )
        .route(
            "/ad-connections/{id}",
            delete(connections::remove).route_layer(accounts_update()),
        )
        .with_state(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization, if any.
    pub(crate) org_id: Option<String>,
    /// `workspaces.id`, what `getWorkspaceForOrg` resolves the org to.
    pub(crate) workspace_id: String,
    pub(crate) events: EventContext,
    /// The test's env (conformance); the process's otherwise.
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &AdsState,
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

    /// The field-encryption keyring (`DATABASE_ENCRYPTION_KEY[_V2]`).
    pub(crate) fn keyring(&self) -> Keyring {
        Keyring {
            v1: self.env("DATABASE_ENCRYPTION_KEY"),
            v2: self.env("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }

    /// `c.env.WORKSPACE_CACHE`: the test's KV (conformance), else the state's.
    pub(crate) fn cache(&self, state: &AdsState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    /// `getMasterDb(c.env)`: the test's (conformance), else the state's.
    pub(crate) fn master(&self, state: &AdsState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    /// The HTTP client Meta is called with: the request's (conformance),
    /// else the state's.
    pub(crate) fn http(&self, state: &AdsState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }
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
                org_id: auth.org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                events: EventContext::for_request(auth, tenant),
                env: extensions.get::<RequestEnv>().cloned(),
                cache: extensions
                    .get::<RequestCache>()
                    .map(|cache| Arc::clone(&cache.0)),
                master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
                http: extensions.get::<OutboundHttp>().cloned(),
            })
        } else {
            tracing::error!("ads: a route without the session or tenant layer");
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

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[ads-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `c.req.query(name)`: the first value of a parameter.
pub(crate) fn query_param(query: &Map<String, Value>, name: &str) -> Option<String> {
    match query.get(name)? {
        Value::Array(values) => values.first().and_then(Value::as_str).map(str::to_owned),
        value => value.as_str().map(str::to_owned),
    }
}

/// `select to_jsonb(t)` rows as Drizzle returns them.
pub(crate) fn rows(values: Vec<Value>) -> Vec<Value> {
    values.into_iter().map(weldsuite_db::js_row).collect()
}
