//! Integrations as core platform functionality: connect-api's integration
//! routes (`apps/workers/connect-api`), served with the core platform
//! whether or not a workspace has WeldConnect.
//!
//! | Prefix | What | TypeScript |
//! |---|---|---|
//! | `/api/integrations` | CRM sync (Attio, `HubSpot`), Google Calendar, MCP servers | `routes/integrations` |
//! | `/api/connectors` | Store and accounting connectors (WooCommerce, Shopify, Picqer, Moneybird, Stripe) | `routes/connectors` |
//! | `/api/external-webhooks` | Outbound webhooks | `routes/external-webhooks` |
//! | `/api/github-connections` | The workspace's GitHub App installation | `routes/github-connections` |
//! | `/api/workflow-integrations` | The workflow steps' provider connections (Slack, Google, GitHub, …) | `routes/workflow-integrations` |
//!
//! Beside them: the internal integration routes (`X-Internal-Secret`,
//! [`internal_router`]), WooCommerce's app-auth callback
//! (`/webhooks/woocommerce/auth`, [`woocommerce_auth_router`]) and the
//! Moneybird two-way sync's event subscriber ([`MoneybirdSyncSubscriber`]).
//!
//! What WeldConnect's own crate (`weldsuite-connect`) needs too lives in
//! `weldsuite-connect-domain`: field encryption, the GitHub App client and
//! connection views, the workflow integration catalog.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `connect`
//! conformance suites (`rust/conformance/suites.json`): "connect:
//! integrations", "connect: workflow integrations" and "connect: github".

// Handlers mirror the TypeScript routes one for one; the long ones stay whole.
#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::items_after_statements
)]

mod access;
mod connector_auth;
mod connector_push;
mod connector_sync;
mod connectors;
mod external_webhooks;
mod github_connections;
mod integrations;
mod js;
mod moneybird_sync;
mod picqer_push;
mod runs;
mod webhooks_woocommerce_auth;
mod workflow_integrations;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, OutboundHttp};

pub(crate) use access::{
    Caller, Overrides, Refusal, Unreachable, internal, now, validate, validate_query,
};
pub use integrations::internal::is_internal_call as is_internal_integrations_call;
pub use moneybird_sync::{MONEYBIRD_SYNC_CONSUMER, MONEYBIRD_SYNC_TOPICS, MoneybirdSyncSubscriber};
pub use runs::{CrmSyncRuns, RequestCrmSyncRuns};

/// Opens a workspace's tenant database by `workspaces.id` or Clerk org id,
/// for the routes that run outside a member's request.
pub type TenantDatabases = Arc<
    dyn Fn(String) -> weldsuite_ports::BoxFuture<'static, Result<PgPool, String>> + Send + Sync,
>;

/// What the integration handlers share.
#[derive(Clone)]
pub struct IntegrationsState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): OAuth states and the
    /// webhook registry's front-line cache. A request's `RequestCache`
    /// (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (due indexes, workspace lookups). A request's
    /// `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// Third-party HTTP. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// A workspace's tenant database, for the internal routes. A request's
    /// `Tenant` (conformance) wins.
    pub tenants: Option<TenantDatabases>,
    /// The worker's env values this crate reads ([`ENV_NAMES`]). A
    /// request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
    /// Where the test delivery of an outbound webhook goes out
    /// (`WebhookHttp`, which refuses private addresses unless allowed). A
    /// request's `OutboundHttp` (conformance) wins.
    pub webhooks: Option<Arc<dyn weldsuite_subscribers::DeliveryAttempts>>,
    /// The `STORAGE` bucket: Moneybird attachments and Stripe invoice PDFs
    /// the connector sync copies. A request's `StorageBuckets`
    /// (conformance) wins.
    pub storage: Option<Arc<dyn weldsuite_ports::DynFileStore>>,
    /// The edition whose connectors the catalog lists (`editions` in
    /// `catalog.ts`, ADR INT-012): `kubernetes` normally, `global` in
    /// conformance builds, which compare against Global's TypeScript
    /// catalog (it hides Odoo).
    pub connector_edition: &'static str,
}

impl std::fmt::Debug for IntegrationsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntegrationsState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .field("tenants", &self.tenants.is_some())
            .field("webhooks", &self.webhooks.is_some())
            .field("storage", &self.storage.is_some())
            .field("connector_edition", &self.connector_edition)
            .finish_non_exhaustive()
    }
}

/// The env names [`IntegrationsState::env`] holds, read from the process.
/// The workflow integrations' OAuth clients are named by their catalog
/// definitions (`clientIdEnv`), the CRM providers' by `<PROVIDER>_CLIENT_ID`.
pub const ENV_NAMES: &[&str] = &[
    "ENVIRONMENT",
    "PUBLIC_APP_URL",
    "APP_API_PUBLIC_URL",
    "DATABASE_ENCRYPTION_KEY",
    "DATABASE_ENCRYPTION_KEY_V2",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "INTERNAL_API_SECRET",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ATTIO_CLIENT_ID",
    "ATTIO_CLIENT_SECRET",
    "HUBSPOT_CLIENT_ID",
    "HUBSPOT_CLIENT_SECRET",
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_CLIENT_ID",
    "MONEYBIRD_CLIENT_ID",
    "MONEYBIRD_CLIENT_SECRET",
    "CONNECTOR_WEBHOOK_BASE_URL",
];

/// [`ENV_NAMES`] from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    ENV_NAMES
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_owned(), v)))
        .collect()
}

/// The integration routes, relative to `/api`, to merge behind the session,
/// tenant database and flag layers. A request carries the `CRM_SYNC`
/// binding the CRM sync starts on as [`RequestCrmSyncRuns`].
pub fn router<S, Q>(state: IntegrationsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/github-connections", github_connections::routes(gate))
        .nest("/external-webhooks", external_webhooks::routes(gate))
        .nest("/integrations", integrations::routes(gate))
        .nest("/connectors", connectors::routes(gate))
        .nest(
            "/workflow-integrations",
            workflow_integrations::routes(gate),
        )
        .with_state(state)
}

/// WooCommerce's application-authentication callback
/// (`POST /webhooks/woocommerce/auth`), at its full path and without a
/// session: the shop posts the API keys it made, and the HMAC-signed state
/// names the workspace, whose tenant database `workspaces` opens. A request's
/// own `Tenant` (conformance) wins.
pub fn woocommerce_auth_router<S>(
    state: IntegrationsState,
    workspaces: Option<Arc<weldsuite_db::Workspaces>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    webhooks_woocommerce_auth::router(state, workspaces)
}

/// The internal integration routes (`X-Internal-Secret`) at their full
/// `/api/integrations/...` paths. They share their paths with the member
/// routes, so the server sends a request here only when
/// [`is_internal_integrations_call`] says it is one, ahead of the session.
pub fn internal_router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    integrations::internal::router(state)
}
