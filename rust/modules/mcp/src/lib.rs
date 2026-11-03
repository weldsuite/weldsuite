//! WeldSuite's MCP server (`apps/workers/mcp-server`, `mcp.weldsuite.org` on
//! Global): the workspace for AI clients, over the Model Context Protocol.
//!
//! On Kubernetes it is served by `weldsuite serve` at `/mcp` on the
//! edition's own host (one host serves every path, OPS-013), with the OAuth
//! discovery documents at `/.well-known/oauth-protected-resource` and
//! `/.well-known/oauth-authorization-server`. Design and inventory:
//! `rust/docs/mcp-server.md`.
//!
//! - [`transport`]: the stateless streamable-HTTP transport the worker runs
//!   (`lib/mcp-transport.ts` and the SDK's web-standard transport): JSON
//!   answers, no sessions.
//! - [`rpc`]: the JSON-RPC methods (`initialize`, `ping`, `tools/*`,
//!   `resources/*`).
//! - [`catalog`]: the tools as the TypeScript server lists them (titles and
//!   annotations included), generated (`tools/generate.mts`), and the routes
//!   of the worker's `/v1` copy; [`annotations`] derives the WeldApps tools'.
//! - [`call`]: a tool call (`lib/proxy.ts`): arguments validated with the
//!   tool's Zod shape, the request built, the public API's `/v1` router run in
//!   process with the member as its caller, the answer presented
//!   ([`present`]).
//! - [`auth`]: the bearer token, the workspace, the member's permissions and
//!   the rate limit, for the server; conformance builds take the session from
//!   the test instead.

#![allow(clippy::result_large_err)]

mod annotations;
#[rustfmt::skip]
mod args_gen;
pub mod auth;
mod call;
pub mod catalog;
mod hooks;
mod js;
pub mod permissions;
pub mod present;
mod rpc;
pub mod transport;
mod user_apps;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::routing::any;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tower::ServiceExt;
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_ports::DynCache;

pub use auth::{McpAuth, well_known_router};
pub use transport::serve;

/// An authenticated MCP session (`McpSession`): a member acting inside one
/// workspace. Built from the bearer token by [`auth`], or given by the
/// conformance test.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSession {
    /// The access token's id: the caller's stable identifier.
    pub token_id: String,
    /// The member (`sub`).
    pub user_id: String,
    /// The identity provider's organization id (`workspaces.clerk_org_id`).
    pub clerk_org_id: String,
    /// `workspaces.id`.
    pub workspace_id: String,
    pub workspace_name: String,
    /// `free`, `business`, `scale` or `enterprise`.
    pub tier: String,
    /// Not used here: the tenant database comes with the request.
    #[serde(default)]
    pub database_url: Option<String>,
    /// The member's effective permissions.
    pub permissions: Vec<String>,
    #[serde(default)]
    pub permission_denies: Vec<String>,
    pub role: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub licensed_apps: Option<Vec<String>>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub read_only_reason: Option<String>,
}

/// What the endpoint shares, cloned from the app state.
#[derive(Clone)]
pub struct McpState {
    /// The public API's `/v1` behind its licence gate, without its key
    /// authentication: the tools' data plane (the worker's `apiApp`).
    internal: Router,
    /// The licence gate, then Hono's plain 404: a `/v1` path the worker's
    /// copy does not mount.
    unmounted: Router,
    /// The tools whose `/v1` route this server serves, found once.
    served: Arc<OnceCell<HashSet<String>>>,
    /// The master database (the workspace's name and plan).
    pub master: PgPool,
    pub workspaces: Arc<Workspaces>,
    /// The rate limit counters.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The bearer token's verifier, and what discovery names.
    pub auth: Option<Arc<McpAuth>>,
    /// Settings read from the environment (`MCP_SERVER_URL`, …).
    pub env: Arc<HashMap<String, String>>,
}

impl McpState {
    /// `v1` is the public API's router relative to `/v1`
    /// (`weldsuite_external_api::router`), without its layers.
    pub fn new(
        v1: Router,
        master: PgPool,
        workspaces: Arc<Workspaces>,
        cache: Option<Arc<dyn DynCache>>,
        auth: Option<Arc<McpAuth>>,
        env: Arc<HashMap<String, String>>,
    ) -> Self {
        let gate = axum::middleware::from_fn(weldsuite_external_api::licence_gate);
        Self {
            internal: Router::new().nest("/v1", v1).layer(gate.clone()),
            unmounted: Router::new().fallback(call::hono_not_found).layer(gate),
            served: Arc::new(OnceCell::new()),
            master,
            workspaces,
            cache,
            auth,
            env,
        }
    }

    /// Whether `tool`'s route is served here: its group is ported and its
    /// module mounted. Found by asking the router once per process, without a
    /// caller: a route answers 401, a missing one 404.
    pub(crate) async fn serves(&self, tool: &catalog::Tool) -> bool {
        let served = self
            .served
            .get_or_init(|| async {
                let mut served = HashSet::new();
                for tool in &catalog::catalog().tools {
                    if tool.variant_pending() {
                        continue;
                    }
                    let path: String = tool
                        .path
                        .split('/')
                        .map(|segment| {
                            if segment.starts_with(':') {
                                "x"
                            } else {
                                segment
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("/");
                    let Ok(request) = axum::extract::Request::builder()
                        .method(tool.method.clone())
                        .uri(path)
                        .body(axum::body::Body::empty())
                    else {
                        continue;
                    };
                    let Ok(response) = self.internal.clone().oneshot(request).await;
                    if response.status() != http::StatusCode::NOT_FOUND {
                        served.insert(tool.name.clone());
                    }
                }
                served
            })
            .await;
        served.contains(&tool.name)
    }
}

impl std::fmt::Debug for McpState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpState")
            .field("auth", &self.auth.is_some())
            .finish_non_exhaustive()
    }
}

/// The settings [`McpState::env`] holds.
pub const ENV_KEYS: [&str; 2] = ["MCP_SERVER_URL", "ENVIRONMENT"];

impl McpState {
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

/// `/mcp` at its full path. The server puts [`auth::authenticate`] in front
/// of it (conformance builds the test's session instead).
pub fn router<S>(state: McpState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/mcp", any(transport::serve))
        .with_state(state)
}
