//! Asset sources: importing managed devices from Microsoft Intune into the
//! asset register, the ready-made `asset` custom object
//! (`@weldsuite/core-domain/asset-sources`, app-api's
//! `routes/asset-sources` and desk-api's `cron/asset-import-sweep.ts`).
//!
//! The customer connects their own Entra app registration (tenant id, client
//! id, client secret), so there is no WeldSuite-wide Microsoft app.
//! `/api/asset-sources` manages the sources and starts imports
//! ([`routes`]); `weldsuite cron asset-import-sweep` runs them
//! ([`run_asset_import_sweep`]), found through the due index (kind
//! `asset_import`, keyed by `workspaces.id`), so a workspace without a source
//! is never opened.
//!
//! An import is a run in bounded steps ([`import`]): a step gets a token,
//! reads one Graph page, loads that page's mappings in one query and writes
//! at most [`import::MAX_WRITES`] records; then it saves where it stopped in
//! `asset_sources.sync_state` and the next tick continues.
//!
//! The client secret is write-only: stored field-encrypted with the keyring
//! (`secret_encrypted`, as `encryptField` seals it, so either backend opens
//! what the other stored), never selected into a row these modules pass
//! around, never put in an entity event or a log. Rows carry `hasSecret`.
//!
//! Microsoft is called only through the outbound HTTP port, and only at
//! `login.microsoftonline.com` and `graph.microsoft.com` ([`microsoft`]).

mod device;
mod import;
mod microsoft;
mod routes;
mod source;
mod sweep;

use std::sync::Arc;

use axum::Router;
use weldsuite_db::{Keyring, PgPool};
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;

pub use source::DUE_KIND;
pub use sweep::{
    AssetImportServices, AssetImportSweepResult, ImportTenant, ImportTenants,
    run_asset_import_sweep,
};

/// What the `/api/asset-sources` handlers share.
#[derive(Clone)]
pub struct AssetSourcesState {
    pub events: EntityEventPublisher,
    /// The master database, where the due index lives. Conformance builds
    /// take the test's per request, or none.
    pub master: Option<PgPool>,
    /// What Microsoft is called through (it must not follow redirects: one
    /// would carry the token to another host). Conformance builds take the
    /// test's fetch stub per request.
    pub http: Option<OutboundHttp>,
    /// The field-encryption keys (`keyringFromEnv`). A request that brings
    /// its own env (conformance) reads them there instead.
    pub keyring: Keyring,
}

impl std::fmt::Debug for AssetSourcesState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetSourcesState")
            .field("events", &self.events)
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .finish_non_exhaustive()
    }
}

/// `/api/asset-sources`.
pub fn asset_sources_router<S, Q>(
    state: AssetSourcesState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    routes::router(gate).with_state(state)
}
