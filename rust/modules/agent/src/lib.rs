//! WeldAgent on the Kubernetes editions (ADR AI-012, `docs/plans/eu-ai-mistral.md`
//! "Phase 5"): agent-api's `/api/weldagent`, `/api/ai-models` and
//! `/api/chat-agent` (`apps/workers/agent-api/src/routes/`), with the domain
//! rules of `@weldsuite/agent-domain` (`packages/domains/agent/src/`).
//!
//! Global runs workspace agents on Claude Managed Agents. Here the model loop
//! is WeldSuite's own, over [`weldsuite_ai`] ([`run`]): conversation state
//! stays in the `weldagent_*` tenant tables, and platform tools ([`tools`])
//! are Rust functions that run with the agent's grants, narrowed to the
//! person who drives the turn.
//!
//! Part one (this crate so far): the data routes that need no model (agents,
//! access, sub-agents, conversations and messages), the tool registry and its
//! executor, subscriptions and grants. Routes that would run the model
//! (`POST /agents/:id/run`, `complete-turn`) answer through the [`run`] seam,
//! which says what the worker says without its model (503 `ai_unavailable`)
//! until the loop is filled in.
//!
//! Paths, bodies, status codes and messages are the TypeScript worker's.

// The `Err` of the helpers below is the response a handler returns as it is.
#![allow(clippy::result_large_err)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::assert_is_empty))]
// The ports of TypeScript routes and tools keep their steps in one place, with
// the same arguments and row shapes as the twin they name.
#![allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::collapsible_if
)]

pub mod access;
pub mod agent_loop;
mod agent_routes;
pub mod agents;
pub mod approvals;
pub mod assistant;
mod conversations;
pub mod dispatch;
pub mod grants;
mod parity;
pub mod rooms;
pub mod routines;
pub mod run;
pub mod runs;
pub mod subscriptions;
pub mod tools;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

/// What the agent handlers share.
#[derive(Clone)]
pub struct AgentState {
    pub events: EntityEventPublisher,
    /// The install's AI. `None` when no provider is configured: the routes
    /// that run the model answer `503 ai_unavailable`.
    pub ai: Option<weldsuite_ai::Ai>,
    /// Whether the sandbox and web grants (`computer:use`, `browser:use`)
    /// exist: true on Global and in conformance builds, and on the
    /// Kubernetes editions when the install has a sandbox (`agent-sandbox`,
    /// `SANDBOX_ENABLED`).
    pub sandbox: bool,
    /// The install's sandbox (`weldsuite-sandbox`), where the sandbox and web
    /// tools run: give a turn [`tools::SandboxAccess::for_turn`] and run its
    /// tools with [`tools::execute_tool_with`]. `None` without one.
    pub sandboxes: Option<weldsuite_sandbox::Sandboxes>,
    /// The `modelId` of an agent created without one: Global's default
    /// Claude id there, [`agents::POLICY_DEFAULT_MODEL`] on the Kubernetes
    /// editions.
    pub default_model: String,
    /// The master database, for the routine due index. `None` in conformance
    /// builds.
    pub master: Option<PgPool>,
    /// The realtime publisher, for room replies.
    pub realtime: Option<Arc<dyn weldsuite_ports::DynRealtimePublisher>>,
}

impl std::fmt::Debug for AgentState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentState")
            .field("ai", &self.ai.is_some())
            .field("sandbox", &self.sandbox)
            .finish_non_exhaustive()
    }
}

impl AgentState {
    /// What a run needs besides its database.
    pub fn run_env(&self) -> run::RunEnv {
        run::RunEnv {
            master: self.master.clone(),
            realtime: self.realtime.clone(),
            sandbox: self.sandbox,
        }
    }
}

/// `/api` routes of the module (`/weldagent`, `/ai-models`, `/chat-agent`),
/// to merge under `/api` behind the session, tenant database, licence and
/// flag layers. Each route carries its `requirePermission` from `gate`.
///
/// `/api/ai` (the assistant chat and generate) is [`assistant`].
#[allow(clippy::too_many_lines)] // one block of routes, as the workers mount them
pub fn router<S, Q>(state: AgentState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    use weldsuite_catalogs::permission_keys::{
        AGENTS_READ, MESSAGES_CREATE, WELDAGENT_CREATE, WELDAGENT_DELETE, WELDAGENT_MANAGE,
        WELDAGENT_READ, WELDAGENT_UPDATE, WELDAGENT_USE,
    };
    let read = || gate.require([WELDAGENT_READ]);
    let update = || gate.require([WELDAGENT_UPDATE, WELDAGENT_MANAGE]);
    let create = || gate.require([WELDAGENT_CREATE, WELDAGENT_MANAGE]);
    let remove_gate = || gate.require([WELDAGENT_DELETE, WELDAGENT_MANAGE]);
    let must_use = || gate.require([WELDAGENT_USE]);
    // Conversations carry no permission, only the session and the user filter.
    let session = || gate.resolve();
    Router::new()
        .route(
            "/weldagent/conversations",
            get(conversations::list).route_layer(session()),
        )
        .route(
            "/weldagent/conversations",
            post(conversations::create).route_layer(session()),
        )
        .route(
            "/weldagent/conversations/{conversation_id}",
            get(conversations::detail)
                .patch(conversations::update)
                .delete(conversations::remove)
                .route_layer(session()),
        )
        .route(
            "/weldagent/conversations/{conversation_id}/messages",
            get(conversations::messages)
                .post(conversations::append_message)
                .route_layer(session()),
        )
        .route(
            "/weldagent/conversations/{conversation_id}/complete-turn",
            post(conversations::complete_turn)
                .route_layer(gate.require([AGENTS_READ, WELDAGENT_USE])),
        )
        .route(
            "/weldagent/conversations/{conversation_id}/auto-title",
            post(conversations::auto_title).route_layer(session()),
        )
        .route(
            "/weldagent/settings",
            get(conversations::settings)
                .put(conversations::put_settings)
                .route_layer(session()),
        )
        .route(
            "/weldagent/mentions/search",
            get(conversations::mentions_search).route_layer(session()),
        )
        .route(
            "/weldagent/agents",
            get(agent_routes::list).route_layer(read()),
        )
        .route(
            "/weldagent/agents",
            post(agent_routes::create).route_layer(create()),
        )
        .route(
            "/weldagent/agents/tools",
            get(agent_routes::tools).route_layer(read()),
        )
        .route(
            "/weldagent/agents/grantable-permissions",
            get(agent_routes::grantable_permissions).route_layer(read()),
        )
        .route(
            "/weldagent/agents/{id}",
            get(agent_routes::detail).route_layer(read()),
        )
        .route(
            "/weldagent/agents/{id}",
            patch(agent_routes::update).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}",
            delete(agent_routes::remove).route_layer(remove_gate()),
        )
        .route(
            "/weldagent/agents/{id}/access",
            put(agent_routes::set_access).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/subagents",
            put(agent_routes::set_subagents).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/chat",
            post(agent_routes::open_chat).route_layer(must_use()),
        )
        .route(
            "/weldagent/agents/{id}/activate",
            post(agent_routes::activate).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/pause",
            post(agent_routes::pause).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/runs",
            get(agent_routes::runs).route_layer(read()),
        )
        .route(
            "/weldagent/agents/{id}/run",
            post(agent_routes::run).route_layer(must_use()),
        )
        .route(
            "/weldagent/approvals",
            get(approvals::list).route_layer(read()),
        )
        .route(
            "/weldagent/approvals/{id}/decide",
            post(approvals::decide).route_layer(gate.require([
                WELDAGENT_USE,
                WELDAGENT_UPDATE,
                WELDAGENT_MANAGE,
            ])),
        )
        .merge(parity_router(gate))
        .route(
            "/ai-models/models",
            get(conversations::models_unavailable).route_layer(session()),
        )
        .route(
            "/chat-agent/ask",
            post(conversations::chat_ask).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .with_state(state.clone())
        .merge(assistant::router(state, gate))
}

/// Skills, routines, memories, templates, teach sessions and connector events
/// (`routes/weldagent/parity.ts`).
#[allow(clippy::too_many_lines)] // one block of routes, as the worker mounts them
fn parity_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<AgentState>
where
    Q: PermissionQueries + 'static,
{
    use weldsuite_catalogs::permission_keys::{
        WELDAGENT_CREATE, WELDAGENT_MANAGE, WELDAGENT_READ, WELDAGENT_UPDATE,
    };
    let read = || gate.require([WELDAGENT_READ]);
    let update = || gate.require([WELDAGENT_UPDATE, WELDAGENT_MANAGE]);
    let create = || gate.require([WELDAGENT_CREATE, WELDAGENT_MANAGE]);
    let manage = || gate.require([WELDAGENT_MANAGE, WELDAGENT_UPDATE]);
    Router::new()
        .route(
            "/weldagent/skills",
            get(parity::skills_list).route_layer(read()),
        )
        .route(
            "/weldagent/skills",
            post(parity::skills_create).route_layer(create()),
        )
        .route(
            "/weldagent/skills/{id}",
            patch(parity::skills_update).route_layer(update()),
        )
        .route(
            "/weldagent/skills/{id}",
            delete(parity::skills_delete).route_layer(manage()),
        )
        .route(
            "/weldagent/agents/{id}/skills",
            get(parity::agent_skills).route_layer(read()),
        )
        .route(
            "/weldagent/agents/{id}/skills/{skill_id}",
            post(parity::agent_skill_enable).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/skills/{skill_id}",
            delete(parity::agent_skill_disable).route_layer(update()),
        )
        .route(
            "/weldagent/routines",
            get(parity::routines_list).route_layer(read()),
        )
        .route(
            "/weldagent/routines",
            post(parity::routines_create).route_layer(create()),
        )
        .route(
            "/weldagent/routines/{id}",
            patch(parity::routines_update).route_layer(update()),
        )
        .route(
            "/weldagent/routines/{id}",
            delete(parity::routines_delete).route_layer(manage()),
        )
        .route(
            "/weldagent/routines/{id}/runs",
            get(parity::routines_runs).route_layer(read()),
        )
        .route(
            "/weldagent/routines/{id}/test",
            post(parity::routines_test).route_layer(update()),
        )
        .route(
            "/weldagent/agents/{id}/memories",
            get(parity::memories_list).route_layer(read()),
        )
        .route(
            "/weldagent/memories",
            post(parity::memories_create).route_layer(update()),
        )
        .route(
            "/weldagent/memories/{id}",
            patch(parity::memories_update).route_layer(update()),
        )
        .route(
            "/weldagent/memories/{id}",
            delete(parity::memories_delete).route_layer(update()),
        )
        .route(
            "/weldagent/templates/export",
            post(parity::templates_export).route_layer(create()),
        )
        .route(
            "/weldagent/templates/install",
            post(parity::templates_install).route_layer(create()),
        )
        .route(
            "/weldagent/templates/share/{token}",
            get(parity::templates_share).route_layer(read()),
        )
        .route(
            "/weldagent/templates/{id}",
            get(parity::templates_get).route_layer(read()),
        )
        .route(
            "/weldagent/agents/{id}/teach/start",
            post(parity::teach_start).route_layer(update()),
        )
        .route(
            "/weldagent/teach/{id}/steps",
            post(parity::teach_step).route_layer(update()),
        )
        .route(
            "/weldagent/teach/{id}/stop",
            post(parity::teach_stop).route_layer(update()),
        )
        .route(
            "/weldagent/connectors/events",
            post(parity::connector_event).route_layer(manage()),
        )
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) workspace_id: String,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// The `Ai` on the request (conformance builds put one on every request).
    pub(crate) request_ai: Option<weldsuite_ai::Ai>,
}

impl Caller {
    /// The AI this request calls: the request's first, then the app's; `None`
    /// without a provider.
    pub(crate) fn ai(&self, state: &AgentState) -> Option<weldsuite_ai::Ai> {
        self.request_ai
            .as_ref()
            .or(state.ai.as_ref())
            .filter(|ai| ai.enabled())
            .cloned()
    }

    /// `agentViewer(c)`: who they are and whether they manage every agent.
    pub(crate) fn viewer(&self) -> access::AgentViewer {
        access::agent_viewer_for(&self.user_id, Some(self.permissions.resolved()))
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
                    workspace_id: tenant.workspace_id.clone(),
                    user_id: auth.user_id.clone(),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    request_ai: parts.extensions.get::<weldsuite_ai::Ai>().cloned(),
                })
            } else {
                tracing::error!("agent: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A database failure: logged, answered with a 500 carrying `message`.
pub(crate) fn failed(
    error: &impl std::fmt::Display,
    context: &str,
    message: &'static str,
) -> Response {
    tracing::error!(%error, "[agent-api/{context}] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `new Date()` as Drizzle writes a `timestamp with time zone`: UTC with
/// milliseconds, bound as text and cast with `::timestamptz`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(IntoResponse::into_response)?;
    value.ok_or_else(|| ApiError::internal().into_response())
}
