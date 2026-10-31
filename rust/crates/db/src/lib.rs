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

mod atomically;
mod crypto;
pub mod due_index;
mod middleware;
mod permissions;
pub mod pg_errors;
mod restrictions;
mod rows;
mod workspaces;

pub use atomically::{TransactionFuture, atomically, atomically_with};
pub use crypto::{
    DecryptError, EncryptError, Keyring, aad_writes_enabled, decrypt_field,
    decrypt_workspace_database_url, encrypt_field, encrypt_workspace_database_url,
    resolve_database_url, workspace_database_url_aad,
};
pub use middleware::workspace_db;
pub use permissions::TenantPermissionQueries;
pub use pg_errors::{
    MovedDatabaseFailure, classify_moved_database_error, database_error, has_pg_error_code,
    is_foreign_key_violation, is_missing_table, is_password_auth_failure, is_read_only_transaction,
    is_unique_violation, pg_error_code,
};
pub use restrictions::{
    ReadOnlyReason, RestrictionInput, WorkspaceRestrictions, compute_workspace_restrictions,
};
pub use rows::{camel_case, js_row, js_timestamp};
pub use sqlx::PgPool;
pub use workspaces::{
    Tenant, WRITE_BLOCKING_DATABASE_MOVE_STATUSES, WorkspaceConfig, WorkspaceError, Workspaces,
    master_pool,
};

/// The master database a request should use, as a request extension.
/// Conformance builds insert the test's master database; elsewhere modules
/// use the app's master pool.
#[derive(Debug, Clone)]
pub struct MasterDb(pub PgPool);
