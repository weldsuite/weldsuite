//! WeldData: data-api's routes (`apps/workers/data-api`): the Lemlist lead
//! database search, lists of saved leads, converting leads into CRM people
//! and companies (and onto a CRM list), enrichment columns, cells and runs
//! under `/api/welddata`, the enrich field definitions under
//! `/api/enrich-fields` and the enrichment views under `/api/enrichments`;
//! and the `data.welddata-enrich` job that runs an enrichment column
//! (`WelddataEnrichWorkflow` of `packages/domains/data`).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `data`
//! conformance suite (`rust/conformance/suites.json`).

mod actions;
mod enrich;
mod enrich_fields;
mod enrichments;
mod js;
mod lemlist;
mod service;
mod welddata;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{
    BoxFuture, DynCache, DynJobs, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp,
    PortError, RequestCache,
};

pub use actions::{ActionKeys, PublicPages, WebPages};
pub use enrich::{
    EnrichRuns, JobsEnrichRuns, RequestEnrichRuns, TenantDatabases, WELDDATA_ENRICH_JOB,
    WelddataEnrichJob,
};

/// What the WeldData handlers share.
#[derive(Clone)]
pub struct DataState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): Lemlist's search pages and
    /// filter catalog. A request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Lemlist. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// Where enrichment runs start (`WELDDATA_ENRICH`). A request's
    /// `RequestEnrichRuns` (conformance) wins.
    pub jobs: Option<Arc<dyn DynJobs>>,
}

impl std::fmt::Debug for DataState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("http", &self.http.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish()
    }
}

/// data-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers.
pub fn router<S, Q>(state: DataState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/enrichments", enrichments::routes(gate))
        .nest("/enrich-fields", enrich_fields::routes(gate))
        .nest("/welddata", welddata::routes(gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization (the run's `workspaceId`).
    pub(crate) org_id: Option<String>,
    pub(crate) events: EventContext,
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    http: Option<OutboundHttp>,
    enrich_runs: Option<RequestEnrichRuns>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &DataState,
        event: EventName,
        entity_id: &str,
        data: Value,
    ) {
        state
            .events
            .publish(&self.events, EntityEvent::new(event, entity_id, data));
    }

    /// `publishEntityEvent({ ..., changes })`.
    pub(crate) fn publish_changes(
        &self,
        state: &DataState,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Map<String, Value>,
    ) {
        state.events.publish(
            &self.events,
            EntityEvent::new(event, entity_id, data).with_changes(changes),
        );
    }

    /// `c.env.<name>`: the request's env (conformance), else the process's.
    pub(crate) fn env_value(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => std::env::var(name).ok(),
        }
        .filter(|value| !value.is_empty())
    }

    /// The Lemlist client with the request's key, HTTP and cache.
    pub(crate) fn lemlist(&self, state: &DataState) -> lemlist::Lemlist {
        let cache = if self.env.is_some() {
            self.cache.clone()
        } else {
            state.cache.clone()
        };
        lemlist::Lemlist {
            api_key: self.env_value("LEMLIST_API_KEY"),
            http: self
                .http
                .clone()
                .or_else(|| state.http.clone())
                .unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable))),
            cache,
        }
    }

    /// `c.env.WELDDATA_ENRICH`: the request's binding (conformance), else
    /// the deployment's jobs; `None` when there is neither.
    pub(crate) fn enrich_runs(&self, state: &DataState) -> Option<Arc<dyn EnrichRuns>> {
        match &self.enrich_runs {
            Some(RequestEnrichRuns(runs)) => runs.clone(),
            None => state
                .jobs
                .clone()
                .map(|jobs| Arc::new(JobsEnrichRuns { jobs }) as Arc<dyn EnrichRuns>),
        }
    }
}

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
struct Unreachable;

impl DynOutboundHttp for Unreachable {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend(
            "no outbound HTTP client",
        ))))
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
                events: EventContext::for_request(auth, tenant),
                env: extensions.get::<RequestEnv>().cloned(),
                cache: extensions
                    .get::<RequestCache>()
                    .map(|cache| Arc::clone(&cache.0)),
                http: extensions.get::<OutboundHttp>().cloned(),
                enrich_runs: extensions.get::<RequestEnrichRuns>().cloned(),
            })
        } else {
            tracing::error!("data: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// `new Date()` as Drizzle writes it.
pub(crate) fn now() -> String {
    weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())
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

/// `zValidator('query', schema)`: the query read by `read`, or the 400.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Box<Response>> {
    let fields = weldsuite_kit::validation::query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &fields);
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    Ok(value)
}

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[data-api] {message}");
    ApiError::internal().with_message(message).into_response()
}
