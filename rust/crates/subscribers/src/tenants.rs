//! Finding an event's workspace: its tenant database and its organization
//! id. The TypeScript consumers each carry a copy of this (`db.ts` in
//! audit-log-worker, integration-webhook-worker and realtime-worker); here it
//! is one trait over `weldsuite_db::Workspaces`, which tests replace.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use weldsuite_db::{PgPool, WorkspaceError, Workspaces};
use weldsuite_ports::BoxFuture;

/// A resolved workspace.
#[derive(Debug, Clone)]
pub struct ResolvedTenant {
    /// `workspaces.id`.
    pub workspace_id: String,
    /// The identity provider's organization id.
    pub clerk_org_id: Option<String>,
    pub db: PgPool,
}

/// Why a workspace could not be resolved.
#[derive(Debug)]
pub enum TenantError {
    NotFound,
    Other(Box<dyn StdError + Send + Sync>),
}

impl fmt::Display for TenantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("workspace not found"),
            Self::Other(error) => write!(f, "{error}"),
        }
    }
}

impl StdError for TenantError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::NotFound => None,
            Self::Other(error) => Some(error.as_ref()),
        }
    }
}

impl From<WorkspaceError> for TenantError {
    fn from(error: WorkspaceError) -> Self {
        match error {
            WorkspaceError::NotFound => Self::NotFound,
            other => Self::Other(Box::new(other)),
        }
    }
}

impl From<sqlx::Error> for TenantError {
    fn from(error: sqlx::Error) -> Self {
        Self::Other(Box::new(error))
    }
}

/// Workspace lookups the subscribers need.
pub trait Tenants: Send + Sync {
    /// The workspace `reference` names (its id or its organization id),
    /// with its tenant pool.
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<ResolvedTenant, TenantError>>;

    /// `workspaceHubKey` (realtime-worker `lib/db.ts`): the name of the
    /// workspace's realtime hub, its organization id. An `org_…` reference
    /// is one already; a workspace id maps to its organization id, or stays
    /// as it is when the workspace has none (or there is no such row).
    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, TenantError>>;
}

/// [`Tenants`] over the master database.
pub struct WorkspaceTenants {
    workspaces: Arc<Workspaces>,
    hub_keys: Mutex<HashMap<String, String>>,
}

impl fmt::Debug for WorkspaceTenants {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceTenants").finish_non_exhaustive()
    }
}

/// Hub keys remembered per process (`hubKeyMemo`); past this the memo starts
/// over.
const MAX_HUB_KEYS: usize = 10_000;

impl WorkspaceTenants {
    pub fn new(workspaces: Arc<Workspaces>) -> Self {
        Self {
            workspaces,
            hub_keys: Mutex::default(),
        }
    }

    async fn resolve(&self, reference: &str) -> Result<ResolvedTenant, TenantError> {
        let tenant = self.workspaces.tenant(reference).await?;
        Ok(ResolvedTenant {
            workspace_id: tenant.workspace_id,
            clerk_org_id: tenant.clerk_org_id,
            db: tenant.db,
        })
    }

    async fn lookup_hub_key(&self, reference: &str) -> Result<String, TenantError> {
        if reference.starts_with("org_") {
            return Ok(reference.to_owned());
        }
        if let Some(key) = self
            .hub_keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(reference)
        {
            return Ok(key.clone());
        }
        let org: Option<Option<String>> =
            sqlx::query_scalar("select clerk_org_id from workspaces where id = $1 limit 1")
                .bind(reference)
                .fetch_optional(self.workspaces.master())
                .await?;
        let key = org.flatten().unwrap_or_else(|| reference.to_owned());
        let mut memo = self.hub_keys.lock().unwrap_or_else(PoisonError::into_inner);
        if memo.len() >= MAX_HUB_KEYS {
            memo.clear();
        }
        memo.insert(reference.to_owned(), key.clone());
        Ok(key)
    }
}

impl Tenants for WorkspaceTenants {
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<ResolvedTenant, TenantError>> {
        Box::pin(self.resolve(reference))
    }

    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, TenantError>> {
        Box::pin(self.lookup_hub_key(reference))
    }
}

/// Is `error` the signature of a tenant database locked by a move (28P01 or
/// 25006, `isTenantLockedError`)?
pub fn is_tenant_locked(error: &(dyn StdError + 'static)) -> bool {
    weldsuite_db::is_password_auth_failure(error) || weldsuite_db::is_read_only_transaction(error)
}

/// [`Tenants`] for tests: every reference in the map resolves to its pool;
/// hub keys come from the same map.
#[derive(Debug, Default, Clone)]
pub struct StaticTenants {
    tenants: HashMap<String, ResolvedTenant>,
}

impl StaticTenants {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve `workspace_id` and `clerk_org_id` (when given) to `db`.
    #[must_use]
    pub fn with(mut self, workspace_id: &str, clerk_org_id: Option<&str>, db: PgPool) -> Self {
        let tenant = ResolvedTenant {
            workspace_id: workspace_id.to_owned(),
            clerk_org_id: clerk_org_id.map(str::to_owned),
            db,
        };
        if let Some(org) = clerk_org_id {
            self.tenants.insert(org.to_owned(), tenant.clone());
        }
        self.tenants.insert(workspace_id.to_owned(), tenant);
        self
    }
}

impl Tenants for StaticTenants {
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<ResolvedTenant, TenantError>> {
        let found = self
            .tenants
            .get(reference)
            .cloned()
            .ok_or(TenantError::NotFound);
        Box::pin(std::future::ready(found))
    }

    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, TenantError>> {
        let key = if reference.starts_with("org_") {
            reference.to_owned()
        } else {
            self.tenants
                .get(reference)
                .and_then(|tenant| tenant.clerk_org_id.clone())
                .unwrap_or_else(|| reference.to_owned())
        };
        Box::pin(std::future::ready(Ok(key)))
    }
}
