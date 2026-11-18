//! What Global keeps in the `PanelProject` Durable Object (ADR PANEL-004),
//! on the Kubernetes editions (plan `weldpanel-eu.md`, "What the Durable
//! Objects hold on Global"): the production adapters of
//! [`weldsuite_panel::PanelProjectState`].
//!
//! - **The tenant tables** (`panel_people`, `panel_identity_links`,
//!   `panel_groups`, `panel_group_slots`, `panel_erased_ids`,
//!   `panel_project_meta`; Drizzle schema
//!   `packages/core/db/src/schema/weldpanel-project-state.ts`) hold people,
//!   links, groups, group type slots, erased ids and the version counter,
//!   with the object's rules ([`rules`], [`tenant`]).
//! - **The live view** is a Valkey sorted set per project ([`valkey`]).
//! - **[`TenantProjectState`]** is panel-api's side in the serve role: it
//!   reads and changes the tenant tables and reads the live view. An
//!   erasure's Iceberg rewrite is queued by the people route (the master
//!   `panel_erasure_ledger`); the nightly `weldsuite cron panel-maintenance`
//!   then releases the ids it rewrote (`clearErased`), opening only the
//!   tenant databases of the workspaces whose erasures it applied.
//! - **[`CollectorProjectState`]** is the collector's side: it never opens
//!   a tenant database (ADR DATA-008). It publishes the object calls to
//!   `panel.ops.v1.<workspace>` ([`ops`]) and keeps the live view; what it
//!   must answer at once (the group types it filters events by, the erased
//!   ids a touch is refused for) comes from Valkey lists the applier keeps.
//! - **The applier** is `weldsuite consume`'s `panel-state`
//!   (`crate::consume::panel_state`): it applies the operations in stream
//!   order, opening only the producing workspace's database, and writes the
//!   `identities_v1`, `people_v1` and `groups_v1` rows ([`rows`]) to
//!   `PANEL_STATE`, which `panel-writer` commits to the Iceberg tables.

mod adapter;
mod collector;
pub(crate) mod ops;
pub(crate) mod rows;
pub(crate) mod rules;
pub(crate) mod tenant;
pub(crate) mod valkey;

#[cfg(test)]
pub(crate) mod tests;

use std::sync::Arc;

use weldsuite_db::{PgPool, WorkspaceError, Workspaces};
use weldsuite_panel::PanelProjectState;
use weldsuite_ports::{BoxFuture, DynEventBus, PortError};

pub(crate) use adapter::{TenantProjectState, db};
pub(crate) use collector::CollectorProjectState;
pub(crate) use valkey::PanelValkey;

/// Now, in milliseconds since 1970 (the object's `Date.now()`).
pub(crate) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The system clock.
pub(crate) fn system_clock() -> Clock {
    Arc::new(rules::now_ms)
}

/// A workspace's tenant database.
pub(crate) trait TenantPools: Send + Sync {
    /// The pool of the workspace `workspace_id` names; `None` when there is
    /// no such workspace (deleted).
    fn pool<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<PgPool>, PortError>>;
}

/// The app's workspaces (`Workspaces::tenant`), as every role resolves them.
pub(crate) struct WorkspaceTenantPools(pub(crate) Arc<Workspaces>);

impl TenantPools for WorkspaceTenantPools {
    fn pool<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<PgPool>, PortError>> {
        Box::pin(async move {
            match self.0.tenant(workspace_id).await {
                Ok(tenant) => Ok(Some(tenant.db)),
                Err(WorkspaceError::NotFound) => Ok(None),
                Err(error) => Err(PortError::backend(error)),
            }
        })
    }
}

/// The serve role's two adapters.
#[derive(Default)]
pub(crate) struct ServePorts {
    /// panel-api's: the routes' `PanelState::project_state`.
    pub(crate) state: Option<Arc<dyn PanelProjectState>>,
    /// The collector's: needs Valkey and NATS.
    pub(crate) collector: Option<Arc<dyn PanelProjectState>>,
}

/// The adapters on this install's databases, Valkey (`VALKEY_URL`, keys
/// under `VALKEY_CACHE_PREFIX`) and event bus. Without Valkey the live view
/// is empty and the collector has no project state (the live view,
/// identities, people and groups are off, as panel-ingest without
/// `PANEL_PROJECT`); without NATS the rows are not written.
#[cfg_attr(feature = "conformance", allow(dead_code))]
pub(crate) async fn serve_ports(
    config: &crate::config::InfraConfig,
    workspaces: &Arc<Workspaces>,
    bus: Option<Arc<dyn DynEventBus>>,
) -> Result<ServePorts, PortError> {
    let valkey = if let Some(url) = &config.valkey_url {
        Some(PanelValkey::new(
            weldsuite_adapters_oss::connect_valkey(url).await?,
            config.valkey_cache_prefix.clone(),
        ))
    } else {
        tracing::warn!(
            "VALKEY_URL is not set: WeldPanel's live view and collector project state are off"
        );
        None
    };
    let state = TenantProjectState {
        pools: Arc::new(WorkspaceTenantPools(Arc::clone(workspaces))),
        rows: rows::RowSink::new(bus.clone()),
        valkey: valkey.clone(),
        clock: system_clock(),
    };
    let collector = match (valkey, bus) {
        (Some(valkey), Some(bus)) => Some(Arc::new(CollectorProjectState {
            bus,
            valkey,
            clock: system_clock(),
        }) as Arc<dyn PanelProjectState>),
        _ => None,
    };
    Ok(ServePorts {
        state: Some(Arc::new(state)),
        collector,
    })
}
