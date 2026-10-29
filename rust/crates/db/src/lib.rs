//! Databases: the Rust counterpart of worker-kit's `db.ts` and
//! `workspaceDbMiddleware`, plus the permission lookups.
//!
//! One master database holds the workspaces; each workspace has its own
//! tenant database, whose connection string is stored encrypted on its
//! master row. On Kubernetes both are plain Postgres (CloudNativePG), reached
//! over TCP with a pool per database instead of the Workers' per-request
//! Neon HTTP client.
//!
//! The SQL is written by hand against the Drizzle schema in
//! `packages/core/db/src/schema/`, which stays the one definition of the
//! tables; migrations stay with Drizzle too.

mod crypto;
mod middleware;
mod permissions;
mod restrictions;
mod workspaces;

pub use crypto::{
    DecryptError, Keyring, decrypt_workspace_database_url, resolve_database_url,
    workspace_database_url_aad,
};
pub use middleware::workspace_db;
pub use permissions::TenantPermissionQueries;
pub use restrictions::{
    ReadOnlyReason, RestrictionInput, WorkspaceRestrictions, compute_workspace_restrictions,
};
pub use sqlx::PgPool;
pub use workspaces::{
    Tenant, WRITE_BLOCKING_DATABASE_MOVE_STATUSES, WorkspaceConfig, WorkspaceError, Workspaces,
    master_pool,
};
