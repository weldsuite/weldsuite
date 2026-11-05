//! WeldMerge (pull requests and issues across git providers): merge-api's
//! `/api/merge` routes (`apps/workers/merge-api`), with the rules of
//! `@weldsuite/merge-domain` ([`keys`], [`automation`], [`github`]).
//!
//! Members work on teams, labels, cycles, issues (keyed `<team key>-<number>`,
//! ADR MERGE-003), comments, the pull request mirror and its issue links,
//! the derived inbox, their own provider logins, and git-provider
//! connections and repositories (a GitHub connection adopts the workspace's
//! GitHub App installation, ADR MERGE-002; tokens are minted per call).
//!
//! GitHub's webhook deliveries reach [`internal_router`]'s
//! `POST /internal/github-event` (merge-api's `MergeInternal` entrypoint):
//! the integration workers' receiver calls it in process once the App's
//! HMAC is checked and the workspace resolved. It is never served on its own
//! (conformance builds mount it for the worker's tests).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `merge`
//! conformance suite (`rust/conformance/suites.json`).

// The services mirror the worker's one for one, so some read long.
#![allow(clippy::too_many_lines)]

pub mod automation;
pub mod github;
mod github_client;
pub mod keys;

mod accounts;
mod comments;
mod connections;
mod cycles;
mod db;
mod github_events;
mod inbox;
mod issues;
mod labels;
mod mappers;
mod pr_sync;
mod pull_requests;
mod repositories;
mod schemas;
mod teams;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys::{
    MERGE_CONNECTIONS_MANAGE, MERGE_CONNECTIONS_READ, MERGE_ISSUES_CREATE, MERGE_ISSUES_DELETE,
    MERGE_ISSUES_READ, MERGE_ISSUES_UPDATE, MERGE_PULL_REQUESTS_READ, MERGE_TEAMS_MANAGE,
    MERGE_TEAMS_READ,
};
use weldsuite_connect_domain::github_app::AppCredentials;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType, iso_timestamp,
};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use crate::github_client::GithubClient;

/// A workspace's tenant, by its Clerk org id or `workspaces.id`
/// (`getWorkspaceContextForOrg`).
pub type TenantResolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Tenant, String>> + Send + Sync>;

/// What the merge handlers share.
#[derive(Clone)]
pub struct MergeState {
    pub events: EntityEventPublisher,
    /// `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, from the process
    /// environment. A request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
    /// GitHub over HTTP. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// The workspaces' tenants, for the GitHub event intake (which has no
    /// session). None: every event answers 404 for its workspace.
    pub tenants: Option<TenantResolver>,
}

impl std::fmt::Debug for MergeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MergeState")
            .field("http", &self.http.is_some())
            .field("tenants", &self.tenants.is_some())
            .finish_non_exhaustive()
    }
}

/// The settings merge-api reads, by binding name.
pub const ENV_NAMES: &[&str] = &["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"];

/// [`ENV_NAMES`] from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    std::env::vars()
        .filter(|(name, _)| ENV_NAMES.contains(&name.as_str()))
        .collect()
}

/// `/api/merge`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission` from
/// `gate`.
pub fn router<S, Q>(state: MergeState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let teams_read = || gate.require([MERGE_TEAMS_READ]);
    let teams_manage = || gate.require([MERGE_TEAMS_MANAGE]);
    let issues_read = || gate.require([MERGE_ISSUES_READ]);
    let issues_create = || gate.require([MERGE_ISSUES_CREATE]);
    let issues_update = || gate.require([MERGE_ISSUES_UPDATE]);
    let issues_delete = || gate.require([MERGE_ISSUES_DELETE]);
    let prs_read = || gate.require([MERGE_PULL_REQUESTS_READ]);
    let connections_read = || gate.require([MERGE_CONNECTIONS_READ]);
    let connections_manage = || gate.require([MERGE_CONNECTIONS_MANAGE]);
    Router::new()
        // Teams
        .route("/teams", get(teams::list).route_layer(teams_read()))
        .route("/teams", post(teams::create).route_layer(teams_manage()))
        .route("/teams/{id}", get(teams::detail).route_layer(teams_read()))
        .route(
            "/teams/{id}",
            patch(teams::update)
                .delete(teams::remove)
                .route_layer(teams_manage()),
        )
        // Labels
        .route("/labels", get(labels::list).route_layer(teams_read()))
        .route("/labels", post(labels::create).route_layer(teams_manage()))
        .route(
            "/labels/{id}",
            patch(labels::update)
                .delete(labels::remove)
                .route_layer(teams_manage()),
        )
        // Cycles
        .route("/cycles", get(cycles::list).route_layer(teams_read()))
        .route("/cycles", post(cycles::create).route_layer(teams_manage()))
        .route(
            "/cycles/{id}",
            patch(cycles::update)
                .delete(cycles::remove)
                .route_layer(teams_manage()),
        )
        // Issues
        .route("/issues", get(issues::list).route_layer(issues_read()))
        .route("/issues", post(issues::create).route_layer(issues_create()))
        .route(
            "/issues/{id}",
            get(issues::detail).route_layer(issues_read()),
        )
        .route(
            "/issues/{id}",
            patch(issues::update).route_layer(issues_update()),
        )
        .route(
            "/issues/{id}",
            delete(issues::remove).route_layer(issues_delete()),
        )
        .route(
            "/issues/{id}/comments",
            get(comments::list).route_layer(issues_read()),
        )
        .route(
            "/issues/{id}/comments",
            post(comments::create).route_layer(issues_update()),
        )
        .route(
            "/issues/{id}/pull-requests",
            post(pull_requests::link).route_layer(issues_update()),
        )
        .route(
            "/issues/{id}/pull-requests/{pr_id}",
            delete(pull_requests::unlink).route_layer(issues_update()),
        )
        // Comments
        .route(
            "/comments/{id}",
            patch(comments::update)
                .delete(comments::remove)
                .route_layer(issues_update()),
        )
        // Pull requests
        .route(
            "/pull-requests",
            get(pull_requests::list).route_layer(prs_read()),
        )
        .route(
            "/pull-requests/{id}",
            get(pull_requests::detail).route_layer(prs_read()),
        )
        // Inbox
        .route("/inbox", get(inbox::list).route_layer(prs_read()))
        // The member's own provider logins
        .route(
            "/accounts/me",
            get(accounts::read)
                .put(accounts::update)
                .route_layer(prs_read()),
        )
        // Connections
        .route(
            "/connections",
            get(connections::list).route_layer(connections_read()),
        )
        .route(
            "/connections/github",
            post(connections::connect_github).route_layer(connections_manage()),
        )
        .route(
            "/connections/{id}",
            delete(connections::remove).route_layer(connections_manage()),
        )
        .route(
            "/connections/{id}/available-repositories",
            get(connections::available_repositories).route_layer(connections_manage()),
        )
        // Repositories
        .route(
            "/repositories",
            get(repositories::list).route_layer(connections_read()),
        )
        .route(
            "/repositories",
            post(repositories::add).route_layer(connections_manage()),
        )
        .route(
            "/repositories/{id}",
            patch(repositories::update)
                .delete(repositories::remove)
                .route_layer(connections_manage()),
        )
        .route(
            "/repositories/{id}/sync",
            post(repositories::sync).route_layer(connections_manage()),
        )
        .with_state(state)
}

/// merge-api's internal routes (the `MergeInternal` entrypoint, trusted by
/// topology), relative to `/internal`: `POST /github-event`. Served only in
/// process (the integration workers' GitHub receiver) and in conformance
/// builds; never on the server's own listener.
pub fn internal_router<S>(state: MergeState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/github-event", post(github_events::intake))
        .with_state(state)
}

/// What the request overrides in conformance builds: the test's env and
/// third-party HTTP.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) http: Option<OutboundHttp>,
}

impl Overrides {
    fn from_extensions(extensions: &http::Extensions) -> Self {
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            http: extensions.get::<OutboundHttp>().cloned(),
        }
    }

    /// `c.env.<name>`: the request's env first (conformance), then the state's.
    fn env(&self, state: &MergeState, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => state.env.get(name).cloned(),
        }
    }

    /// `githubClientFor(c)(installationId)`: a client minting the
    /// installation's token on first use. Without the App's id and key every
    /// call answers 503.
    pub(crate) fn github(&self, state: &MergeState, installation_id: &str) -> GithubClient {
        let set = |name: &str| self.env(state, name).filter(|v| !v.is_empty());
        let credentials = match (set("GITHUB_APP_ID"), set("GITHUB_APP_PRIVATE_KEY")) {
            (Some(app_id), Some(private_key)) => Some(AppCredentials {
                app_id,
                private_key,
            }),
            _ => None,
        };
        GithubClient::new(
            self.http.clone().or_else(|| state.http.clone()),
            credentials,
            installation_id,
            // Conformance runs carry their own HTTP stub: no process cache.
            self.http.is_none(),
        )
    }
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
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
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    overrides: Overrides::from_extensions(&parts.extensions),
                })
            } else {
                tracing::error!("merge: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// An entity event a service wants published (`PendingEvent`): services
/// have no request, so they return these and the route publishes them after
/// the write, before it answers.
#[derive(Debug, Clone)]
pub(crate) struct PendingEvent {
    pub(crate) entity_type: &'static str,
    pub(crate) action: &'static str,
    pub(crate) entity_id: String,
    pub(crate) data: Value,
    pub(crate) changes: Option<Map<String, Value>>,
}

impl PendingEvent {
    pub(crate) fn new(
        entity_type: &'static str,
        action: &'static str,
        entity_id: &str,
        data: Value,
    ) -> Self {
        Self {
            entity_type,
            action,
            entity_id: entity_id.to_owned(),
            data,
            changes: None,
        }
    }

    #[must_use]
    pub(crate) fn with_changes(mut self, changes: Option<Map<String, Value>>) -> Self {
        self.changes = changes;
        self
    }
}

/// `publishEntityEvents(c, events, source)`.
pub(crate) fn publish(state: &MergeState, context: &EventContext, events: Vec<PendingEvent>) {
    for event in events {
        let kind = match EventType::catalog(event.entity_type, event.action) {
            Ok(kind) => kind,
            Err(error) => {
                tracing::error!(?error, "merge: an event outside the catalog");
                continue;
            }
        };
        let mut entity = EntityEvent::new(kind, event.entity_id, event.data);
        if let Some(changes) = event.changes {
            entity = entity.with_changes(changes);
        }
        state.events.publish(context, entity);
    }
}

/// A failure off the route's own refusals: what `githubFailure` answers
/// (503 without the App's credentials, 502 when GitHub refuses or fails),
/// and anything else as the module workers answer a thrown error.
#[derive(Debug)]
pub(crate) enum MergeError {
    Db(sqlx::Error),
    /// `GithubNotConfiguredError`.
    GithubNotConfigured,
    /// `GithubApiError`: GitHub answered with this status.
    GithubApi(u16),
    /// Anything else the worker would throw.
    Unexpected(String),
}

impl From<sqlx::Error> for MergeError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl MergeError {
    pub(crate) fn respond(self) -> Response {
        match self {
            Self::GithubNotConfigured => {
                ApiError::unavailable("GitHub is not configured for WeldMerge").into_response()
            }
            Self::GithubApi(status) => {
                tracing::warn!(status, "merge: GitHub answered with an error");
                ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "UPSTREAM_ERROR",
                    "GitHub answered with an error",
                )
                .into_response()
            }
            Self::Db(error) => {
                tracing::error!(%error, "merge: a statement failed");
                unexpected()
            }
            Self::Unexpected(error) => {
                tracing::error!(%error, "merge: the request failed");
                unexpected()
            }
        }
    }
}

/// `createModuleApi`'s answer to a thrown error.
fn unexpected() -> Response {
    ApiError::internal()
        .with_message("An unexpected error occurred")
        .into_response()
}

/// A route's answer off the happy path: a response the route writes itself
/// (a 400, 403, 404, 409 or 422), or a [`MergeError`].
pub(crate) enum Refusal {
    Response(Box<Response>),
    Error(MergeError),
}

impl From<MergeError> for Refusal {
    fn from(error: MergeError) -> Self {
        Self::Error(error)
    }
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Error(MergeError::Db(error))
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Error(error) => error.respond(),
        }
    }
}

impl Refusal {
    pub(crate) fn not_found(resource: &str, id: Option<&str>) -> Self {
        ApiError::not_found(resource, id).into()
    }

    pub(crate) fn conflict(message: &str) -> Self {
        ApiError::conflict(message).into()
    }

    pub(crate) fn bad_request(message: &str) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    /// `unprocessable(c, message)`: 422 for a well-formed request the module
    /// cannot accept.
    pub(crate) fn unprocessable(message: &str) -> Self {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "UNPROCESSABLE_ENTITY",
            message,
        )
        .into()
    }
}

/// A handler's result.
pub(crate) type Answer = Result<Response, Refusal>;

/// `new Date()` as Drizzle writes it: UTC with milliseconds.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `Date.now()`.
pub(crate) fn now_ms() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let ms = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64;
    ms
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
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| rejected(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| rejected(invalid.into_response()))?;
    value.ok_or_else(|| Refusal::Error(MergeError::Unexpected("no body".to_owned())))
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// A list without paging: `list(c, rows, cursorPagination(rows.length, false, null))`.
pub(crate) fn all(rows: Vec<Value>) -> Response {
    page(rows, false, None)
}

/// `list(c, rows, cursorPagination(rows.length, hasMore, cursor))`.
pub(crate) fn page(rows: Vec<Value>, has_more: bool, cursor: Option<String>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(
        rows,
        weldsuite_kit::Pagination::new(total, has_more, cursor),
    )
    .into_response()
}

/// The `system` actor's event context in a workspace (the GitHub sync).
pub(crate) fn system_events(tenant: &Tenant) -> EventContext {
    EventContext::from_ids(
        &tenant.workspace_id,
        tenant.clerk_org_id.as_deref(),
        "system",
    )
    .with_source(EventSource::System)
}
