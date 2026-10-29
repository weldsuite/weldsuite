//! Workspace → tenant database (`worker-kit/src/db.ts`).
//!
//! A request names its workspace by either identifier, `workspaces.id` or the
//! Clerk org id. One master-DB query reads the row, its licence, its partner
//! and whether a database move blocks writes; the stored `database_url` is
//! opened with the keyring. The result is cached in process for
//! [`WorkspaceConfig::cache_ttl`] (the workers cache it in KV for the same
//! 300 seconds), and each workspace gets a small, lazily connected pool that
//! is reused across requests and evicted least-recently-used.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::crypto::{DecryptError, Keyring, resolve_database_url};
use crate::restrictions::{
    ReadOnlyReason, RestrictionInput, WorkspaceRestrictions, compute_workspace_restrictions,
};

/// Move statuses during which writes are refused
/// (`WRITE_BLOCKING_DATABASE_MOVE_STATUSES`).
pub const WRITE_BLOCKING_DATABASE_MOVE_STATUSES: [&str; 6] = [
    "soft_locked",
    "locked",
    "copying",
    "verifying",
    "switching",
    "cancelling",
];

const SELECT_WORKSPACE: &str = "
    select w.id, w.clerk_org_id, w.database_url, w.is_active, w.billing_mode,
           l.status as licence_status, l.allowed_apps as licence_apps,
           p.status as partner_status,
           exists (
               select 1 from workspace_database_moves m
               where m.workspace_id = w.id and m.status = any($2)
           ) as database_move_in_progress
    from workspaces w
    left join workspace_licences l on l.workspace_id = w.id
    left join partners p on p.id = w.partner_id
    where w.id = $1 or w.clerk_org_id = $1
    limit 1";

/// Tuning for [`Workspaces`].
#[derive(Debug, Clone)]
pub struct WorkspaceConfig {
    /// How long a resolved workspace is reused before the master DB is read
    /// again; bounds how late a suspension or licence change takes effect.
    pub cache_ttl: Duration,
    /// Connections per tenant pool.
    pub tenant_max_connections: u32,
    /// Tenant pools kept open at once; the least recently used is closed.
    pub max_tenant_pools: usize,
    /// How long a request waits for a tenant connection.
    pub acquire_timeout: Duration,
    /// Idle tenant connections are closed after this.
    pub idle_timeout: Duration,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            cache_ttl: Duration::from_secs(300),
            tenant_max_connections: 5,
            max_tenant_pools: 200,
            acquire_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(300),
        }
    }
}

/// Why a workspace could not be resolved. Never contains a connection string.
#[derive(Debug)]
pub enum WorkspaceError {
    NotFound,
    /// The row has no `database_url`.
    NoDatabase,
    Decrypt(DecryptError),
    /// A database URL that is not a usable Postgres URL.
    BadDatabaseUrl,
    Database(sqlx::Error),
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("workspace not found"),
            Self::NoDatabase => f.write_str("no database configured for the workspace"),
            Self::Decrypt(error) => write!(f, "cannot open the workspace database URL: {error}"),
            Self::BadDatabaseUrl => f.write_str("the database URL is not a Postgres URL"),
            Self::Database(error) => write!(f, "master database: {error}"),
        }
    }
}

impl std::error::Error for WorkspaceError {}

impl From<sqlx::Error> for WorkspaceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// A resolved workspace with its tenant database: what the request
/// extensions carry for handlers (`tenantDb`, `workspaceId`, `clerkOrgId`,
/// `licensedApps`, `readOnly`, `readOnlyReason` on the Hono context).
#[derive(Debug, Clone)]
pub struct Tenant {
    /// `workspaces.id`.
    pub workspace_id: String,
    pub clerk_org_id: Option<String>,
    pub db: PgPool,
    pub suspended: bool,
    pub restrictions: WorkspaceRestrictions,
}

impl Tenant {
    pub fn licensed_apps(&self) -> Option<&[String]> {
        self.restrictions.licensed_apps.as_deref()
    }

    pub fn read_only_reason(&self) -> Option<ReadOnlyReason> {
        self.restrictions.read_only_reason
    }
}

/// One workspace as the master DB described it.
struct Resolved {
    id: String,
    clerk_org_id: Option<String>,
    database_url: String,
    suspended: bool,
    restrictions: WorkspaceRestrictions,
}

struct TenantPool {
    database_url: String,
    pool: PgPool,
    last_used: Instant,
}

/// Resolves workspaces and hands out tenant pools. One per process.
pub struct Workspaces {
    master: PgPool,
    keyring: Keyring,
    config: WorkspaceConfig,
    resolved: Mutex<HashMap<String, (Instant, Arc<Resolved>)>>,
    pools: Mutex<HashMap<String, TenantPool>>,
}

impl fmt::Debug for Workspaces {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Workspaces")
            .field("keyring", &self.keyring)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// Cap on cached resolutions; past it the cache starts over.
const MAX_CACHED: usize = 10_000;

impl Workspaces {
    pub fn new(master: PgPool, keyring: Keyring, config: WorkspaceConfig) -> Self {
        Self {
            master,
            keyring,
            config,
            resolved: Mutex::new(HashMap::new()),
            pools: Mutex::new(HashMap::new()),
        }
    }

    /// The master database pool.
    pub fn master(&self) -> &PgPool {
        &self.master
    }

    /// `select 1` on the master database, for readiness.
    pub async fn ping_master(&self) -> Result<(), sqlx::Error> {
        sqlx::query("select 1")
            .execute(&self.master)
            .await
            .map(|_| ())
    }

    /// The workspace `reference` names (its id or Clerk org id) with its
    /// tenant pool.
    pub async fn tenant(&self, reference: &str) -> Result<Tenant, WorkspaceError> {
        let resolved = if let Some(resolved) = self.cached(reference) {
            resolved
        } else {
            let resolved = Arc::new(self.resolve(reference).await?);
            let mut cache = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
            if cache.len() >= MAX_CACHED {
                cache.clear();
            }
            cache.insert(
                reference.to_owned(),
                (Instant::now(), Arc::clone(&resolved)),
            );
            resolved
        };
        Ok(Tenant {
            workspace_id: resolved.id.clone(),
            clerk_org_id: resolved.clerk_org_id.clone(),
            db: self.pool_for(&resolved)?,
            suspended: resolved.suspended,
            restrictions: resolved.restrictions.clone(),
        })
    }

    /// Drop cached resolutions, so the next request reads the master DB
    /// again (`forgetWorkspaceContext`): after a database move, or when a
    /// tenant database refused the cached credentials.
    pub fn forget(&self, references: &[&str]) {
        let mut cache = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
        for reference in references {
            cache.remove(*reference);
        }
    }

    fn cached(&self, reference: &str) -> Option<Arc<Resolved>> {
        let cache = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get(reference)
            .filter(|(at, _)| at.elapsed() < self.config.cache_ttl)
            .map(|(_, resolved)| Arc::clone(resolved))
    }

    async fn resolve(&self, reference: &str) -> Result<Resolved, WorkspaceError> {
        let statuses: Vec<String> = WRITE_BLOCKING_DATABASE_MOVE_STATUSES
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let row: Option<WorkspaceRow> = sqlx::query_as(SELECT_WORKSPACE)
            .bind(reference)
            .bind(statuses)
            .fetch_optional(&self.master)
            .await?;
        let row = row.ok_or(WorkspaceError::NotFound)?;
        let stored = row
            .database_url
            .as_deref()
            .ok_or(WorkspaceError::NoDatabase)?;
        // The AAD of a v3 value is the row's own id, never the reference.
        let database_url = resolve_database_url(stored, &row.id, &self.keyring)
            .map_err(WorkspaceError::Decrypt)?;
        let licence_apps = string_array(row.licence_apps.as_ref());
        let restrictions = compute_workspace_restrictions(&RestrictionInput {
            billing_mode: row.billing_mode.as_deref(),
            licence: row
                .licence_status
                .as_deref()
                .map(|status| (status, licence_apps.as_slice())),
            partner_status: row.partner_status.as_deref(),
            database_move_in_progress: row.database_move_in_progress,
        });
        Ok(Resolved {
            id: row.id,
            clerk_org_id: row.clerk_org_id,
            database_url,
            suspended: !row.is_active,
            restrictions,
        })
    }

    /// The workspace's pool, opened on first use and replaced when its
    /// database URL changed (a move or a rotated password).
    fn pool_for(&self, resolved: &Resolved) -> Result<PgPool, WorkspaceError> {
        let mut pools = self.pools.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = pools.get_mut(&resolved.id)
            && existing.database_url == resolved.database_url
        {
            existing.last_used = Instant::now();
            return Ok(existing.pool.clone());
        }

        if !pools.contains_key(&resolved.id)
            && pools.len() >= self.config.max_tenant_pools
            && let Some(oldest) = pools
                .iter()
                .min_by_key(|(_, pool)| pool.last_used)
                .map(|(id, _)| id.clone())
            && let Some(evicted) = pools.remove(&oldest)
        {
            close_later(evicted.pool);
        }

        let pool = PgPoolOptions::new()
            .max_connections(self.config.tenant_max_connections)
            .min_connections(0)
            .acquire_timeout(self.config.acquire_timeout)
            .idle_timeout(Some(self.config.idle_timeout))
            .connect_lazy(&resolved.database_url)
            .map_err(|_| WorkspaceError::BadDatabaseUrl)?;
        let replaced = pools.insert(
            resolved.id.clone(),
            TenantPool {
                database_url: resolved.database_url.clone(),
                pool: pool.clone(),
                last_used: Instant::now(),
            },
        );
        if let Some(replaced) = replaced {
            close_later(replaced.pool);
        }
        Ok(pool)
    }
}

/// The master database pool. Lazy: nothing connects until the first query,
/// so a pod starts (and reports not ready) while the database comes up.
pub fn master_pool(url: &str, max_connections: u32) -> Result<PgPool, WorkspaceError> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(url)
        .map_err(|_| WorkspaceError::BadDatabaseUrl)
}

/// Close a pool that requests may still hold a clone of; they finish first.
fn close_later(pool: PgPool) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move { pool.close().await });
    }
}

/// The strings of a JSON array; anything else is empty.
pub(crate) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(sqlx::FromRow)]
struct WorkspaceRow {
    id: String,
    clerk_org_id: Option<String>,
    database_url: Option<String>,
    is_active: bool,
    billing_mode: Option<String>,
    licence_status: Option<String>,
    licence_apps: Option<Value>,
    partner_status: Option<String>,
    database_move_in_progress: bool,
}
