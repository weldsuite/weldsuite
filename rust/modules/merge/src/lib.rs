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
/// Recording a GitHub App installation: shared with WeldConnect through
/// `crates/merge-domain` (`@weldsuite/merge-domain/installations`).
pub use weldsuite_merge_domain::installations;
pub mod keys;

/// `MergeInternal.workflowAction` in process (WeldConnect's `merge.*` actions).
pub use across::workflow_action;
/// The WeldChat daily digest's hourly sweep (`weldsuite cron merge-digest-sweep`).
pub use chat::digest::run_digest_sweep;

mod accounts;
mod across;
mod chat;
mod comments;
mod connections;
mod credentials;
mod cycles;
mod db;
mod draft_pull_request;
mod github_events;
mod github_install;
mod hooks;
mod inbox;
mod issue_sync;
mod issues;
mod labels;
mod mappers;
mod oauth;
mod pr_sync;
mod provider_events;
mod providers;
mod pull_requests;
mod record_links;
mod releases;
mod repositories;
mod review;
mod schemas;
mod teams;
mod webhooks;

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
use weldsuite_db::{Keyring, MasterDb, PgPool, Tenant};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType, iso_timestamp,
};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{BoxFuture, DynCache, OutboundHttp, RequestCache};

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
    /// The master database: the provider index (`merge_provider_index`).
    /// A request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// The cache the OAuth state lives in (`WORKSPACE_CACHE` on Global). A
    /// request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Realtime (`env.REALTIME`): the WeldChat posts' broadcasts and unread
    /// pings. None publishes nothing.
    pub realtime: Option<Arc<dyn weldsuite_ports::DynRealtimePublisher>>,
    /// Customer mail (`SEND_EMAIL`) and the outbound guard's ledgers, for a
    /// release's notes sent by email. A request's `RequestOutbound`
    /// (conformance) wins.
    pub mail: weldsuite_mail_domain::outbound::OutboundBindings,
    /// The install's AI (ADR AI-012), for a release's notes; `None` with AI
    /// off. A request's `Ai` (conformance) wins.
    pub ai: Option<weldsuite_ai::Ai>,
}

impl std::fmt::Debug for MergeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MergeState")
            .field("http", &self.http.is_some())
            .field("tenants", &self.tenants.is_some())
            .field("master", &self.master.is_some())
            .field("cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

/// The settings merge-api reads, by binding name.
pub const ENV_NAMES: &[&str] = &[
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITLAB_OAUTH_CLIENT_ID",
    "GITLAB_OAUTH_CLIENT_SECRET",
    "BITBUCKET_OAUTH_CLIENT_ID",
    "BITBUCKET_OAUTH_CLIENT_SECRET",
    "AZURE_DEVOPS_CLIENT_ID",
    "AZURE_DEVOPS_CLIENT_SECRET",
    "APP_URL",
    "WEBHOOK_BASE_URL",
    "CLERK_SECRET_KEY",
    "INTERNAL_API_SECRET",
    "DATABASE_ENCRYPTION_KEY",
    "DATABASE_ENCRYPTION_KEY_V2",
    // The internal calls' member check (`checkAppPermission` enforcement).
    "PERMISSIONS_APP_ENFORCE",
];

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
    let releases_read = || gate.require([weldsuite_catalogs::permission_keys::MERGE_RELEASES_READ]);
    let releases_manage =
        || gate.require([weldsuite_catalogs::permission_keys::MERGE_RELEASES_MANAGE]);
    let prs_review =
        || gate.require([weldsuite_catalogs::permission_keys::MERGE_PULL_REQUESTS_REVIEW]);
    let prs_merge =
        || gate.require([weldsuite_catalogs::permission_keys::MERGE_PULL_REQUESTS_MERGE]);
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
        // Record links (R1b)
        .route(
            "/issues/{id}/links",
            get(record_links::list).route_layer(issues_read()),
        )
        .route(
            "/issues/{id}/links",
            post(record_links::create).route_layer(issues_update()),
        )
        .route(
            "/issues/{id}/links/{link_id}",
            delete(record_links::remove).route_layer(issues_update()),
        )
        .route(
            "/record-links",
            get(record_links::lookup).route_layer(issues_read()),
        )
        // Review and merge (R1b)
        .route(
            "/pull-requests/{id}/files",
            get(review::files).route_layer(prs_read()),
        )
        .route(
            "/pull-requests/{id}/threads",
            get(review::threads).route_layer(prs_read()),
        )
        .route(
            "/pull-requests/{id}/reviews",
            post(review::reviews).route_layer(prs_review()),
        )
        .route(
            "/pull-requests/{id}/comments",
            post(review::comments).route_layer(prs_review()),
        )
        .route(
            "/pull-requests/{id}/merge",
            post(review::merge).route_layer(prs_merge()),
        )
        // Releases (R1b)
        .route(
            "/releases",
            get(releases::list).route_layer(releases_read()),
        )
        .route(
            "/releases",
            post(releases::create).route_layer(releases_manage()),
        )
        .route(
            "/releases/{id}",
            get(releases::detail).route_layer(releases_read()),
        )
        .route(
            "/releases/{id}",
            patch(releases::update)
                .delete(releases::remove)
                .route_layer(releases_manage()),
        )
        .route(
            "/releases/{id}/refresh",
            post(releases::refresh).route_layer(releases_manage()),
        )
        .route(
            "/releases/{id}/generate-notes",
            post(releases::generate_notes).route_layer(releases_manage()),
        )
        .route(
            "/releases/{id}/ship",
            post(releases::ship).route_layer(releases_manage()),
        )
        .route(
            "/releases/{id}/publish",
            post(releases::publish_release).route_layer(releases_manage()),
        )
        // WeldChat subscriptions (R1b)
        .route(
            "/chat-subscriptions",
            get(chat::subscriptions::list).route_layer(teams_read()),
        )
        .route(
            "/chat-subscriptions",
            post(chat::subscriptions::create).route_layer(teams_manage()),
        )
        .route(
            "/chat-subscriptions/{id}",
            patch(chat::subscriptions::update)
                .delete(chat::subscriptions::remove)
                .route_layer(teams_manage()),
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
        .route(
            "/inbox/items/{item_key}",
            patch(inbox::update_item).route_layer(prs_read()),
        )
        .route(
            "/inbox/read-all",
            post(inbox::read_all).route_layer(prs_read()),
        )
        // The member's own provider logins and linked accounts
        .route(
            "/accounts/me",
            get(accounts::read)
                .put(accounts::update)
                .route_layer(prs_read()),
        )
        .route(
            "/accounts/gitlab-token",
            post(oauth::link_gitlab_token).route_layer(prs_read()),
        )
        .route(
            "/accounts/{id}",
            delete(oauth::unlink_account).route_layer(prs_read()),
        )
        .route(
            "/accounts/{id}/authorize-url",
            get(oauth::account_authorize_url).route_layer(prs_read()),
        )
        .route(
            "/oauth/callback",
            post(oauth::callback).route_layer(prs_read()),
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
            "/connections/github/install-url",
            get(github_install::install_url).route_layer(connections_manage()),
        )
        .route(
            "/connections/gitlab",
            post(oauth::connect_gitlab_token).route_layer(connections_manage()),
        )
        .route(
            "/connections/azure_devops/organization",
            post(oauth::azure_organization).route_layer(connections_manage()),
        )
        .route(
            "/connections/{id}",
            delete(connections::remove).route_layer(connections_manage()),
        )
        .route(
            "/connections/{id}/authorize-url",
            get(oauth::connection_authorize_url).route_layer(connections_manage()),
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
        .route(
            "/repositories/{id}/import-issues",
            post(issue_sync::routes::import_issues).route_layer(connections_manage()),
        )
        // Issue to provider issue links
        .route(
            "/issues/{id}/external",
            post(issue_sync::routes::create_external)
                .delete(issue_sync::routes::remove_external)
                .route_layer(issues_update()),
        )
        .with_state(state)
}

/// merge-api's public routes (before any session): the GitHub App's setup
/// redirect, `GET /public/merge/github/setup`, trusted by its signed state.
/// At its full path, to merge into the server's public routes.
pub fn public_router<S>(state: MergeState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/public/merge/github/setup", get(github_install::setup))
        .with_state(state)
}

/// merge-api's internal routes (the `MergeInternal` entrypoint, trusted by
/// topology), relative to `/internal`: `POST /github-event` (a verified
/// GitHub App delivery) and `POST /provider-event` (a GitLab, Bitbucket or
/// Azure DevOps delivery, `{workspaceId, provider, key, headers, body}`:
/// what `MergeInternal.providerEvent` posts; it answers `{ data: { outcome,
/// reason? } }`). Served only in process (the integration workers'
/// receivers) and in conformance builds; never on the server's own listener.
pub fn internal_router<S>(state: MergeState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/github-event", post(github_events::intake))
        .route("/provider-event", post(provider_events::intake))
        .route("/workflow-action", post(across::workflow_action_route))
        .route("/agent-tool", post(across::agent_tool_route))
        .with_state(state)
}

/// What the request overrides in conformance builds: the test's env,
/// third-party HTTP, master database and KV.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) master: Option<PgPool>,
    pub(crate) cache: Option<RequestCache>,
    /// The request's AI (conformance builds: on with the test's mock model,
    /// off without it).
    pub(crate) ai: Option<weldsuite_ai::Ai>,
}

impl Overrides {
    pub(crate) fn from_extensions(extensions: &http::Extensions) -> Self {
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            http: extensions.get::<OutboundHttp>().cloned(),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            cache: extensions.get::<RequestCache>().cloned(),
            ai: extensions.get::<weldsuite_ai::Ai>().cloned(),
        }
    }

    /// The AI a call runs on: the request's (conformance), then the state's;
    /// `None` when it is off.
    pub(crate) fn ai(&self, state: &MergeState) -> Option<weldsuite_ai::Ai> {
        self.ai
            .as_ref()
            .or(state.ai.as_ref())
            .filter(|ai| ai.enabled())
            .cloned()
    }

    /// `c.env.<name>`: the request's env first (conformance), then the state's.
    pub(crate) fn env(&self, state: &MergeState, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => state.env.get(name).cloned(),
        }
    }

    /// `c.env.<name>` when it is set and not empty.
    pub(crate) fn env_set(&self, state: &MergeState, name: &str) -> Option<String> {
        self.env(state, name).filter(|value| !value.is_empty())
    }

    /// Third-party HTTP: the request's (conformance), then the state's.
    pub(crate) fn outbound(&self, state: &MergeState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// `getMasterDb(c.env)`: the request's (conformance), then the state's.
    pub(crate) fn master(&self, state: &MergeState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// `c.env.WORKSPACE_CACHE`: the request's (conformance), then the state's.
    pub(crate) fn cache(&self, state: &MergeState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| state.cache.clone())
    }

    /// `keyringFromEnv(c.env)`: `DATABASE_ENCRYPTION_KEY` and `_V2`.
    pub(crate) fn keyring(&self, state: &MergeState) -> Keyring {
        Keyring {
            v1: self.env_set(state, "DATABASE_ENCRYPTION_KEY"),
            v2: self.env_set(state, "DATABASE_ENCRYPTION_KEY_V2"),
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
    /// `c.get('workspaceId')`: `workspaces.id` (ws_…).
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `hookContext(c)`: what the area hooks (issue sync, chat posts) need.
    pub(crate) fn hook_context(&self, state: &MergeState) -> hooks::HookContext {
        hooks::HookContext {
            db: self.db.clone(),
            state: state.clone(),
            overrides: self.overrides.clone(),
            user_id: self.user_id.clone(),
            workspace_id: self.workspace_id.clone(),
            clerk_org_id: self.clerk_org_id.clone(),
            events: self.events.clone(),
        }
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
                    workspace_id: tenant.workspace_id.clone(),
                    clerk_org_id: tenant.clerk_org_id.clone(),
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

/// A failure off the route's own refusals: what `providerFailure` answers
/// (`githubFailure`'s 503 without the App's credentials and 502 when GitHub
/// refuses or fails; a provider's 502 `provider_error`, 503 without its
/// OAuth app, 409 `connection_needs_attention`, 422 for what it cannot do),
/// and anything else as the module workers answer a thrown error.
#[derive(Debug)]
pub(crate) enum MergeError {
    Db(sqlx::Error),
    /// `GithubNotConfiguredError`.
    GithubNotConfigured,
    /// `GithubApiError`: GitHub answered with this status.
    GithubApi(u16),
    /// `ProviderApiError`: the provider answered with this status and its
    /// own message (a 502 `provider_error`).
    ProviderApi {
        provider: String,
        status: u16,
        message: String,
    },
    /// `ProviderNotConfiguredError`: no OAuth app for the provider (503).
    ProviderNotConfigured(String),
    /// `ProviderCredentialsError`: no usable token (409).
    ProviderCredentials(String),
    /// `ProviderUnsupportedError`: `<provider> does not support <capability>` (422).
    ProviderUnsupported {
        provider: String,
        capability: String,
    },
    /// Anything else the worker would throw.
    Unexpected(String),
}

impl From<sqlx::Error> for MergeError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl MergeError {
    /// `new ProviderApiError(provider, status, message)`.
    pub(crate) fn provider_api(provider: &str, status: u16, message: impl Into<String>) -> Self {
        Self::ProviderApi {
            provider: provider.to_owned(),
            status,
            message: message.into(),
        }
    }

    /// `new ProviderUnsupportedError(provider, capability)`.
    pub(crate) fn unsupported(provider: &str, capability: &str) -> Self {
        Self::ProviderUnsupported {
            provider: provider.to_owned(),
            capability: capability.to_owned(),
        }
    }

    /// `isStatus(err, ...statuses)`: a provider answer with one of these statuses.
    pub(crate) fn is_status(&self, statuses: &[u16]) -> bool {
        matches!(self, Self::ProviderApi { status, .. } if statuses.contains(status))
    }

    /// `syncFailure(c, err)`: the explicit issue-sync routes answer only a
    /// provider refusal, a missing capability and GitHub without the App;
    /// anything else (no OAuth app, no token) is thrown (500).
    #[must_use]
    pub(crate) fn for_sync(self) -> Self {
        match self {
            Self::ProviderNotConfigured(provider) => {
                Self::Unexpected(format!("{provider} OAuth is not configured for WeldMerge"))
            }
            Self::ProviderCredentials(message) => Self::Unexpected(message),
            Self::GithubApi(status) => Self::Unexpected(format!("GitHub answered {status}")),
            other => other,
        }
    }

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
            Self::ProviderApi {
                provider,
                status,
                message,
            } => {
                tracing::warn!(%provider, status, "merge: a provider answered with an error");
                ApiError::new(StatusCode::BAD_GATEWAY, "provider_error", message).into_response()
            }
            Self::ProviderNotConfigured(provider) => {
                ApiError::unavailable(format!("{provider} OAuth is not configured for WeldMerge"))
                    .into_response()
            }
            Self::ProviderCredentials(message) => {
                ApiError::new(StatusCode::CONFLICT, "connection_needs_attention", message)
                    .into_response()
            }
            Self::ProviderUnsupported {
                provider,
                capability,
            } => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "UNPROCESSABLE_ENTITY",
                format!("{provider} does not support {capability}"),
            )
            .into_response(),
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
