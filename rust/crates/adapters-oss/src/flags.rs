//! Feature flags from the master database, in place of Cloudflare Flagship
//! (`packages/core/feature-flags/src/server.ts`). Reads the
//! `feature_flag_overrides` table (Drizzle schema
//! `packages/core/db/src/schema/feature-flag-overrides.ts`, master migration
//! 0062): `flag_key`, `workspace_id` (`workspaces.id` or Clerk org id; null =
//! every workspace) and `value` (jsonb), unique per flag and workspace.
//!
//! A workspace's row wins over the row for every workspace; with neither, the
//! catalog default applies. The whole table is read at once and kept for the
//! refresh period ([`DEFAULT_FLAG_REFRESH`]), so a change (a kill switch)
//! takes effect within that time on every replica, and a request costs no
//! query.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;
use weldsuite_ports::{FlagContext, FlagSource, PortError};

/// How long a read of the table is used before it is read again.
pub const DEFAULT_FLAG_REFRESH: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
struct Overrides {
    everyone: Option<Value>,
    workspaces: HashMap<String, Value>,
}

type Table = Arc<HashMap<String, Overrides>>;

#[derive(Debug, Clone)]
struct Snapshot {
    read_at: Instant,
    flags: Table,
}

/// [`FlagSource`] on the master database's `feature_flag_overrides`.
pub struct MasterDbFlagSource {
    master: PgPool,
    refresh: Duration,
    current: RwLock<Option<Snapshot>>,
    reading: tokio::sync::Mutex<()>,
}

impl MasterDbFlagSource {
    pub fn new(master: PgPool, refresh: Duration) -> Self {
        Self {
            master,
            refresh,
            current: RwLock::new(None),
            reading: tokio::sync::Mutex::new(()),
        }
    }

    /// Reads the table again on the next evaluation (after a change made in
    /// this process).
    pub fn invalidate(&self) {
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn cached(&self) -> Option<Snapshot> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn fresh(&self) -> Option<Table> {
        self.cached()
            .filter(|snapshot| snapshot.read_at.elapsed() < self.refresh)
            .map(|snapshot| snapshot.flags)
    }

    fn store(&self, flags: Table) -> Table {
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = Some(Snapshot {
            read_at: Instant::now(),
            flags: flags.clone(),
        });
        flags
    }

    /// The table, read again when stale. One reader at a time; a failed read
    /// keeps serving the previous values for another period.
    async fn table(&self) -> Result<Table, PortError> {
        if let Some(flags) = self.fresh() {
            return Ok(flags);
        }
        let _reading = self.reading.lock().await;
        if let Some(flags) = self.fresh() {
            return Ok(flags);
        }
        match self.read().await {
            Ok(flags) => Ok(self.store(Arc::new(flags))),
            Err(error) => match self.cached() {
                Some(stale) => {
                    tracing::warn!(%error, "feature flags: reading overrides failed; keeping the previous values");
                    Ok(self.store(stale.flags))
                }
                None => Err(error),
            },
        }
    }

    async fn read(&self) -> Result<HashMap<String, Overrides>, PortError> {
        let rows: Vec<(String, Option<String>, Json<Value>)> =
            sqlx::query_as("select flag_key, workspace_id, value from feature_flag_overrides")
                .fetch_all(&self.master)
                .await
                .map_err(PortError::backend)?;

        let mut flags: HashMap<String, Overrides> = HashMap::new();
        for (key, workspace, Json(value)) in rows {
            let overrides = flags.entry(key).or_default();
            match workspace {
                Some(workspace) => {
                    overrides.workspaces.insert(workspace, value);
                }
                None => overrides.everyone = Some(value),
            }
        }
        Ok(flags)
    }
}

impl FlagSource for MasterDbFlagSource {
    async fn value(&self, key: &str, context: &FlagContext) -> Result<Option<Value>, PortError> {
        let flags = self.table().await?;
        let Some(overrides) = flags.get(key) else {
            return Ok(None);
        };
        let for_workspace = overrides.workspaces.get(&context.workspace_id).or_else(|| {
            context
                .clerk_org_id
                .as_ref()
                .and_then(|org| overrides.workspaces.get(org))
        });
        Ok(for_workspace.or(overrides.everyone.as_ref()).cloned())
    }
}
