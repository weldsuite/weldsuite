//! What the pipeline talks to: the master database, workspace databases,
//! the buckets, realtime, the event hub and outbound HTTP. The worker's
//! `Env`.

use std::sync::Arc;

use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_ports::{BoxFuture, DynFileStore, DynRealtimePublisher, OutboundHttp};

/// A workspace's tenant database, by `workspaces.id`
/// (`getTenantDbForWorkspaceById`).
pub trait TenantDbs: Send + Sync {
    fn tenant_db<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<PgPool, Box<dyn std::error::Error + Send + Sync>>>;
}

/// [`TenantDbs`] over `weldsuite_db::Workspaces`.
pub struct WorkspaceDbs(pub Arc<weldsuite_db::Workspaces>);

impl TenantDbs for WorkspaceDbs {
    fn tenant_db<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<PgPool, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            self.0
                .tenant(workspace_id)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)
        })
    }
}

/// [`TenantDbs`] for tests: every workspace id in the map.
pub struct StaticDbs(pub std::collections::HashMap<String, PgPool>);

impl TenantDbs for StaticDbs {
    fn tenant_db<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<PgPool, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            self.0
                .get(workspace_id)
                .cloned()
                .ok_or_else(|| format!("Workspace not found: {workspace_id}").into())
        })
    }
}

/// Which modules' inboxes the edition serves (MAIL-010: the helpdesk and
/// accounting fan-out runs only for modules the edition serves).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FanOut {
    /// WeldDesk email inboxes (`processHelpdeskInboxEmail`).
    pub desk: bool,
    /// WeldBooks accounting inboxes (`processAccountingInboxEmail`).
    pub books: bool,
}

impl FanOut {
    /// What this build serves: a module marked ported
    /// (`RUST_PORTED_MODULES`). WeldBooks is not yet, so its inbox is a
    /// no-op until it is.
    pub fn from_catalog() -> Self {
        let ported = |id: &str| {
            weldsuite_catalogs::api_modules()
                .iter()
                .any(|m| m.id == id && m.rust)
        };
        Self {
            desk: ported("desk"),
            books: ported("books"),
        }
    }
}

/// The pipeline's dependencies.
#[derive(Clone)]
pub struct InboundContext {
    pub master: PgPool,
    pub tenants: Arc<dyn TenantDbs>,
    /// `STORAGE`: the bucket attachments and avatars go to, served at
    /// `public_url`.
    pub storage: Option<Arc<dyn DynFileStore>>,
    /// `R2_PUBLIC_URL`.
    pub public_url: Option<String>,
    /// `MAIL_STORAGE`: raw MIME (`mail/<ws>/<account>/<message>/raw.eml`).
    pub mail_storage: Option<Arc<dyn DynFileStore>>,
    /// `REALTIME`; `None` publishes nothing (the worker throws and logs).
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The entity-event hub (`ENTITY_EVENTS`).
    pub events: EntityEventPublisher,
    /// Expo push, and the notifications' push.
    pub http: Option<OutboundHttp>,
    pub fan_out: FanOut,
}

impl std::fmt::Debug for InboundContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboundContext")
            .field("storage", &self.storage.is_some())
            .field("public_url", &self.public_url)
            .field("mail_storage", &self.mail_storage.is_some())
            .field("realtime", &self.realtime.is_some())
            .field("http", &self.http.is_some())
            .field("fan_out", &self.fan_out)
            .finish_non_exhaustive()
    }
}
