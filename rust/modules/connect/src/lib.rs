//! WeldConnect: connect-api's routes (`apps/workers/connect-api`) at the
//! paths it serves under `/api` (workflows and their versions, templates,
//! schedules, variables, webhooks, triggers, executions, the dashboard and
//! the AI builder's drafts), and the public workflow webhook receiver
//! (`/api/workflows/webhook/:id`, [`public_router`]).
//!
//! A run is started through [`runs::WorkflowRuns`]: the `EXECUTE_WORKFLOW`
//! Workflow binding on Global, the `connect.execute-workflow` job here.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `connect`
//! conformance suites (`rust/conformance/suites.json`).

// Handlers mirror the TypeScript routes one for one; the long ones stay whole.
#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::items_after_statements
)]

mod builder;
mod catalog;
mod cron;
mod crypto;
mod dashboard;
pub mod engine;
mod entity_workflows;
mod executions;
mod github;
mod github_app;
mod js;
mod mvp;
mod public_webhook;
pub mod runs;
mod schedule_sweep;
mod schedules;
mod schemas;
mod sync;
mod templates;
mod triggers;
mod variables;
mod versions;
mod webhooks;
mod workflow_integrations;
mod workflows;

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
pub(crate) struct Unreachable;

impl weldsuite_ports::DynOutboundHttp for Unreachable {
    fn send(
        &self,
        _request: weldsuite_ports::HttpRequest,
    ) -> weldsuite_ports::BoxFuture<
        '_,
        Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>,
    > {
        Box::pin(std::future::ready(Err(
            weldsuite_ports::PortError::backend("no outbound HTTP client"),
        )))
    }
}

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynCache, DynJobs, OutboundHttp, RequestCache};

pub use entity_workflows::EntityWorkflowsSubscriber;
pub use public_webhook::RequestHeaderNames;
pub use runs::{
    EXECUTE_WORKFLOW_JOB, JobsWorkflowRuns, ProjectSyncRuns, RESUME_SIGNAL, RequestProjectSyncRuns,
    RequestWorkflowRuns, WorkflowRuns,
};
pub use schedule_sweep::{ScheduleTenants, run_schedule_sweep};

/// Opens a workspace's tenant database by `workspaces.id` or Clerk org id,
/// for the routes and jobs that run outside a member's request.
pub type TenantDatabases = Arc<
    dyn Fn(String) -> weldsuite_ports::BoxFuture<'static, Result<PgPool, String>> + Send + Sync,
>;

/// What the WeldConnect handlers share.
#[derive(Clone)]
pub struct ConnectState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): the webhook registry's
    /// front-line cache. A request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (the webhook registry). A request's `MasterDb`
    /// (conformance) wins.
    pub master: Option<PgPool>,
    /// Third-party HTTP. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// Where runs start (`EXECUTE_WORKFLOW`). A request's
    /// `RequestWorkflowRuns` (conformance) wins.
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// A workspace's tenant database, for the public webhook receiver. A
    /// request's `Tenant` (conformance) wins.
    pub tenants: Option<TenantDatabases>,
    /// The worker's env values this crate reads (`ENVIRONMENT`,
    /// `CONNECT_API_URL`, …). A request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
    /// `TRUSTED_PROXIES`: where the webhook caller's address sits in
    /// `X-Forwarded-For`, counted from the right.
    pub trusted_proxies: usize,
}

impl std::fmt::Debug for ConnectState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

/// The env names [`ConnectState::env`] holds, read from the process.
pub const ENV_NAMES: &[&str] = &[
    "ENVIRONMENT",
    "CONNECT_API_URL",
    "PUBLIC_APP_URL",
    "DATABASE_ENCRYPTION_KEY",
    "DATABASE_ENCRYPTION_KEY_V2",
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "CLERK_SECRET_KEY",
    "INTERNAL_API_SECRET",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
];

/// [`ENV_NAMES`] from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    ENV_NAMES
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_owned(), v)))
        .collect()
}

/// connect-api's authenticated routes, relative to `/api`, to merge behind
/// the session, tenant database, licence and flag layers.
pub fn router<S, Q>(state: ConnectState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/github-connections", github::connections_routes(gate))
        .nest("/github-repo-links", github::repo_links_routes(gate))
        .nest("/github-project-links", github::project_links_routes(gate))
        .nest("/workflow-builder", builder::routes(gate))
        .nest("/workflow-dashboard", dashboard::routes(gate))
        .nest("/workflow-executions", executions::routes(gate))
        .nest("/workflow-github", github::workflow_github_routes(gate))
        .nest(
            "/workflow-integrations",
            workflow_integrations::routes(gate),
        )
        .nest("/workflow-schedules", schedules::routes(gate))
        .nest("/workflow-templates", templates::routes(gate))
        .nest("/workflow-triggers", triggers::routes(gate))
        .nest("/workflow-variables", variables::routes(gate))
        .nest("/workflow-versions", versions::routes(gate))
        .nest("/workflow-webhooks", webhooks::routes(gate))
        .nest("/workflows", workflows::routes(gate))
        .with_state(state)
}

/// The routes connect-api mounts ahead of `apiAuth()`, at their full paths:
/// the workflow webhook receiver (`POST /api/workflows/webhook/:id`), which
/// checks the webhook's own signature, IP and method rules, and the GitHub
/// App's install callback (`GET /api/weldconnect/github/callback`), which
/// checks the state signed at `/install-url`.
pub fn public_router<S>(state: ConnectState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/api/workflows/webhook/{webhook_id}",
            axum::routing::post(public_webhook::receive),
        )
        .route(
            "/api/weldconnect/github/callback",
            axum::routing::get(github::install_callback),
        )
        .with_state(state)
}

/// What conformance builds hand a request in place of the state's.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) cache: Option<RequestCache>,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) master: Option<weldsuite_db::MasterDb>,
    pub(crate) runs: Option<RequestWorkflowRuns>,
}

impl Overrides {
    pub(crate) fn from_extensions(extensions: &http::Extensions) -> Self {
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            cache: extensions.get::<RequestCache>().cloned(),
            http: extensions.get::<OutboundHttp>().cloned(),
            master: extensions.get::<weldsuite_db::MasterDb>().cloned(),
            runs: extensions.get::<RequestWorkflowRuns>().cloned(),
        }
    }

    /// `c.env.<name>`: the request's env first (conformance), then the state's.
    pub(crate) fn env(&self, state: &ConnectState, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        state.env.get(name).cloned()
    }

    /// The workspace cache: the request's (conformance), else the state's.
    pub(crate) fn kv(&self, state: &ConnectState) -> Option<Arc<dyn DynCache>> {
        match &self.cache {
            Some(cache) => Some(Arc::clone(&cache.0)),
            None if self.env.is_some() => None,
            None => state.cache.clone(),
        }
    }

    /// Third-party HTTP: the request's (conformance), else the state's.
    #[allow(dead_code)] // the integration routes use it
    pub(crate) fn http(&self, state: &ConnectState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// The master database: the request's (conformance), else the state's.
    pub(crate) fn master(&self, state: &ConnectState) -> Option<PgPool> {
        self.master
            .as_ref()
            .map(|master| master.0.clone())
            .or_else(|| state.master.clone())
    }

    /// `c.env.EXECUTE_WORKFLOW`: the request's binding (conformance, which
    /// may be none), else the deployment's jobs.
    pub(crate) fn runs(&self, state: &ConnectState) -> Option<Arc<dyn WorkflowRuns>> {
        match &self.runs {
            Some(RequestWorkflowRuns(runs)) => runs.clone(),
            None => state
                .jobs
                .clone()
                .map(|jobs| Arc::new(JobsWorkflowRuns { jobs }) as Arc<dyn WorkflowRuns>),
        }
    }

    /// `publicApiBase(env)`: this API's public origin, for webhook URLs.
    pub(crate) fn public_api_base(&self, state: &ConnectState) -> String {
        if let Some(url) = self.env(state, "CONNECT_API_URL").filter(|v| !v.is_empty()) {
            return url;
        }
        match self.env(state, "ENVIRONMENT").as_deref() {
            Some("production") => "https://connect-api.weldsuite.org".to_owned(),
            Some("test") => "https://connect-api-test.weldsuite.org".to_owned(),
            _ => "http://localhost:8813".to_owned(),
        }
    }
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

impl Caller {
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &ConnectState,
        event: impl Into<weldsuite_events::EventType>,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }
}

/// Behind the session, tenant database and permission layers; without them
/// it is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let permissions = parts.extensions.get::<Permissions>();
        let caller =
            if let (Some(auth), Some(tenant), Some(permissions)) = (auth, tenant, permissions) {
                Ok(Self {
                    db: tenant.db.clone(),
                    user_id: auth.user_id.clone(),
                    org_id: auth.org_id.clone(),
                    workspace_id: tenant.workspace_id.clone(),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .unwrap_or_else(|| tenant.workspace_id.clone()),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    overrides: Overrides::from_extensions(&parts.extensions),
                })
            } else {
                tracing::error!("connect: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 404, a validation failure), or a database error the route maps to
/// its 500 with its own message.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl From<Response> for Refusal {
    fn from(response: Response) -> Self {
        Self::Response(Box::new(response))
    }
}

impl Refusal {
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    /// The response; a database error is logged and answered with a 500
    /// carrying `fallback` (`error.internal(c, fallback)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => internal(&error, fallback),
        }
    }
}

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[connect-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let rejected = |response: Response| Refusal::Response(Box::new(response));
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| rejected(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| rejected(invalid.into_response()))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('query', schema)`: the query string read by `read`, or the
/// 400 with the schema's issues.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let fields = weldsuite_kit::validation::query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &fields);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}
