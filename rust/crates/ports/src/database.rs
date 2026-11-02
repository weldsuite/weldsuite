//! Database provisioning: the port behind creating and dropping a
//! workspace's tenant database (DATA-001: one database per workspace).
//!
//! Global provisions on Neon in TypeScript (`@weldsuite/neon-provisioning`,
//! called by the workspace worker); the Kubernetes editions put it behind
//! this trait, with the CloudNativePG adapter in `weldsuite-adapters-oss`
//! (`CnpgProvisioner`): `CREATE ROLE` and `CREATE DATABASE` on a shard,
//! reached through the shard's `PgBouncer` Pooler.
//!
//! What a call does, and what it leaves to its caller (the provisioning job
//! of P4 sub-phase 4a, the port of `ProvisionWorkspaceWorkflow`):
//!
//! | Step | [`DatabaseProvisioner::provision`] | The caller |
//! |---|---|---|
//! | Pick a shard (DATA-016), count the database on it | yes | may pin one ([`ProvisionRequest::shard`]) |
//! | Claim the workspace: record the placement on its master row, once | yes | |
//! | Role with a generated password, database owned by it, extensions | yes | |
//! | Store the connection URL, sealed, in `workspaces.database_url` | yes | |
//! | Apply the tenant migrations | yes | |
//! | Owner member, installed apps, seed data, mail, digest, credits | | yes, on the returned URL |
//! | Mark it ready (`database_provisioned_at`, `provisioning_status`) | | yes, last (`mark-provisioned`) |
//!
//! Both calls are idempotent and safe to retry or to run twice at once (the
//! onboarding route and an identity webhook both start provisioning in
//! Global): the master row is claimed with a conditional update, so one
//! database per workspace, and a call that finds the work (partly) done
//! finishes it. A failed call leaves nothing half-applied that a retry cannot
//! finish.
//!
//! Like [`crate::Identity`], the trait is object safe: the adapter is picked at
//! run time and never used generically. [`MemoryProvisioner`] is the double.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Mutex, PoisonError};

use crate::BoxFuture;

/// What to provision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionRequest {
    /// `workspaces.id`; the master row must exist.
    pub workspace_id: String,
    /// Put the database on this shard (its name, the CloudNativePG Cluster's,
    /// e.g. `tenants-1`): an admin's placement override (DATA-016). `None`
    /// picks the active shard with the fewest databases.
    pub shard: Option<String>,
}

impl ProvisionRequest {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            shard: None,
        }
    }

    #[must_use]
    pub fn on_shard(mut self, shard: impl Into<String>) -> Self {
        self.shard = Some(shard.into());
        self
    }
}

/// Where a workspace's database lives, as its master row records it
/// (`workspaces.neon_project_id`, `neon_database_name`, `neon_role_name`,
/// `shared_project_id`: Neon's names, kept for both editions until a
/// migration renames them).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// `neon_shared_projects.id` of the shard.
    pub shard_id: String,
    /// The shard's name (`tenants-1`).
    pub shard_name: String,
    pub database_name: String,
    pub role_name: String,
}

/// A connection string with a password in it. `Debug` and `Display` hide it.
#[derive(Clone, PartialEq, Eq)]
pub struct DatabaseUrl(String);

impl DatabaseUrl {
    pub fn new(url: impl Into<String>) -> Self {
        Self(url.into())
    }

    /// The URL itself, password included. Never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for DatabaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DatabaseUrl(<redacted>)")
    }
}

/// A workspace's database, ready for the caller's first rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionedDatabase {
    pub workspace_id: String,
    pub placement: Placement,
    /// What `workspaces.database_url` now opens to: the shard's pooler,
    /// the workspace's own role and database.
    pub database_url: DatabaseUrl,
    /// This call created the database; `false` when it found it (a retry, or
    /// a concurrent call that got there first).
    pub created: bool,
    /// Tenant migrations this call applied.
    pub migrations_applied: usize,
    /// The newest migration the database now has (the journal's latest).
    pub schema_version: Option<String>,
}

/// What [`DatabaseProvisioner::teardown`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Teardown {
    /// The database and its role are gone, the slot is counted back and the
    /// placement cleared.
    Dropped(Placement),
    /// The workspace had no placement: nothing to drop.
    NothingToDrop,
}

/// Why a provisioning call failed. Never contains a password or URL.
#[derive(Debug)]
pub enum ProvisionError {
    /// No workspace row with that id.
    WorkspaceNotFound,
    /// A workspace id that cannot name a database (too long once sanitised).
    InvalidWorkspaceId(String),
    /// The workspace's database lives where this provisioner does not manage
    /// it (a Neon project, a shard it is not configured for). Never touched.
    ForeignPlacement(String),
    /// The requested shard is not one this provisioner manages.
    UnknownShard(String),
    /// No managed shard is active with room (or the requested one is full or
    /// disabled).
    NoCapacity,
    /// The master database refused or could not be reached.
    Master(Box<dyn std::error::Error + Send + Sync>),
    /// The shard's Postgres refused or could not be reached.
    Shard(Box<dyn std::error::Error + Send + Sync>),
    /// The URL could not be sealed (no encryption key).
    Encryption(String),
    /// The tenant migrations failed. The database exists and its URL is
    /// stored, so a retry resumes there.
    Migrations(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WorkspaceNotFound => f.write_str("workspace not found"),
            Self::InvalidWorkspaceId(reason) => write!(f, "invalid workspace id: {reason}"),
            Self::ForeignPlacement(placement) => write!(
                f,
                "the workspace's database is not on a shard this provisioner manages ({placement})"
            ),
            Self::UnknownShard(shard) => write!(f, "unknown shard {shard}"),
            Self::NoCapacity => f.write_str("no shared-shard capacity available"),
            Self::Master(error) => write!(f, "master database: {error}"),
            Self::Shard(error) => write!(f, "shard: {error}"),
            Self::Encryption(error) => write!(f, "cannot seal the database URL: {error}"),
            Self::Migrations(error) => write!(f, "tenant migrations: {error}"),
        }
    }
}

impl std::error::Error for ProvisionError {}

/// Creates and drops workspace databases. See the module docs for what a
/// call does and what is left to the caller.
pub trait DatabaseProvisioner: Send + Sync {
    /// Create the workspace's database (or finish creating it), migrate it,
    /// and record its placement and sealed URL on the master row.
    ///
    /// A workspace already placed on a managed shard is resumed there, never
    /// moved (`request.shard` only applies to a first placement); one placed
    /// elsewhere is [`ProvisionError::ForeignPlacement`].
    fn provision<'a>(
        &'a self,
        request: &'a ProvisionRequest,
    ) -> BoxFuture<'a, Result<ProvisionedDatabase, ProvisionError>>;

    /// Drop the workspace's database and role, count the slot back and clear
    /// the placement (`deleteWorkspaceDatabase`). What is already gone counts
    /// as done. Like the TypeScript teardown it leaves `database_url` (dead
    /// once the placement is cleared) and the rest of the row alone.
    fn teardown<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Teardown, ProvisionError>>;
}

/// One call [`MemoryProvisioner`] saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionCall {
    Provision(ProvisionRequest),
    Teardown(String),
}

/// In-memory double: places every workspace on `shard`, hands out
/// `postgres://role_<id>:secret@memory:5432/ws_<id>`, and records the calls.
/// Idempotent like the adapter; [`MemoryProvisioner::fail_next`] makes the
/// next call fail.
#[derive(Debug, Default)]
pub struct MemoryProvisioner {
    state: Mutex<MemoryState>,
}

#[derive(Debug, Default)]
struct MemoryState {
    databases: BTreeMap<String, Placement>,
    calls: Vec<ProvisionCall>,
    fail_next: Option<String>,
}

impl MemoryProvisioner {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, MemoryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The calls so far, oldest first.
    pub fn calls(&self) -> Vec<ProvisionCall> {
        self.state().calls.clone()
    }

    /// Where a workspace's database is, if it has one.
    pub fn placement(&self, workspace_id: &str) -> Option<Placement> {
        self.state().databases.get(workspace_id).cloned()
    }

    /// The next call fails with [`ProvisionError::Shard`] and this message.
    pub fn fail_next(&self, message: impl Into<String>) {
        self.state().fail_next = Some(message.into());
    }

    fn url(placement: &Placement) -> DatabaseUrl {
        DatabaseUrl::new(format!(
            "postgres://{}:secret@memory:5432/{}",
            placement.role_name, placement.database_name
        ))
    }
}

impl DatabaseProvisioner for MemoryProvisioner {
    fn provision<'a>(
        &'a self,
        request: &'a ProvisionRequest,
    ) -> BoxFuture<'a, Result<ProvisionedDatabase, ProvisionError>> {
        Box::pin(async move {
            let mut state = self.state();
            state.calls.push(ProvisionCall::Provision(request.clone()));
            if let Some(message) = state.fail_next.take() {
                return Err(ProvisionError::Shard(message.into()));
            }
            let created = !state.databases.contains_key(&request.workspace_id);
            let shard = request.shard.clone().unwrap_or_else(|| "memory".to_owned());
            let placement = state
                .databases
                .entry(request.workspace_id.clone())
                .or_insert_with(|| Placement {
                    shard_id: format!("nsp_{shard}"),
                    shard_name: shard,
                    database_name: format!("ws_{}", request.workspace_id),
                    role_name: format!("role_{}", request.workspace_id),
                })
                .clone();
            Ok(ProvisionedDatabase {
                workspace_id: request.workspace_id.clone(),
                database_url: Self::url(&placement),
                placement,
                created,
                migrations_applied: 0,
                schema_version: None,
            })
        })
    }

    fn teardown<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Teardown, ProvisionError>> {
        Box::pin(async move {
            let mut state = self.state();
            state
                .calls
                .push(ProvisionCall::Teardown(workspace_id.to_owned()));
            if let Some(message) = state.fail_next.take() {
                return Err(ProvisionError::Shard(message.into()));
            }
            Ok(state
                .databases
                .remove(workspace_id)
                .map_or(Teardown::NothingToDrop, Teardown::Dropped))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_double_is_idempotent_and_records_calls() {
        let provisioner = MemoryProvisioner::new();
        let request = ProvisionRequest::new("ws_1").on_shard("tenants-2");
        let first = provisioner.provision(&request).await.expect("provision");
        assert!(first.created);
        assert_eq!(first.placement.shard_name, "tenants-2");
        assert_eq!(
            format!("{:?}", first.database_url),
            "DatabaseUrl(<redacted>)"
        );
        let again = provisioner.provision(&request).await.expect("again");
        assert!(!again.created);
        assert_eq!(again.placement, first.placement);

        provisioner.fail_next("shard down");
        assert!(matches!(
            provisioner.teardown("ws_1").await,
            Err(ProvisionError::Shard(_))
        ));
        assert_eq!(
            provisioner.teardown("ws_1").await.expect("teardown"),
            Teardown::Dropped(first.placement)
        );
        assert_eq!(
            provisioner.teardown("ws_1").await.expect("again"),
            Teardown::NothingToDrop
        );
        assert_eq!(provisioner.calls().len(), 5);
    }
}
