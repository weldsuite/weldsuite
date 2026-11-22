//! Databases: the Rust counterpart of worker-kit's `db.ts` and
//! `workspaceDbMiddleware`, plus the permission lookups.
//!
//! One master database holds the workspaces; each workspace has its own
//! tenant database, whose connection string is stored encrypted on its
//! master row. On Kubernetes both are plain Postgres (CloudNativePG), reached
//! over TCP with a pool per database instead of the Workers' per-request
//! Neon HTTP client.
//!
//! The tables are the SeaORM entities in `weldsuite-schema` (ADR DATA-019).
//! New queries go through them: [`orm`] puts SeaORM on a pool, and
//! [`OrmConn`] lets ORM statements join a transaction `atomically_with`
//! opened. The SQL here predates the entities.

#![allow(
    clippy::disallowed_methods,
    reason = "not converted to the ORM yet (ADR DATA-019)"
)]

pub mod account_pictures;
mod atomically;
mod crypto;
pub mod due_index;
mod membership;
mod middleware;
mod orm;
mod permissions;
pub mod pg_errors;
pub mod record;
mod restrictions;
mod rows;
pub mod sso_settings;
mod workspaces;

pub use account_pictures::{AccountPictures, load_account_picture, overlay_account_pictures};
pub use atomically::{TransactionFuture, atomically, atomically_with};
pub use crypto::{
    DecryptError, EncryptError, Keyring, aad_writes_enabled, decrypt_field,
    decrypt_workspace_database_url, encrypt_field, encrypt_workspace_database_url,
    resolve_database_url, workspace_database_url_aad,
};
pub use membership::{
    DEFAULT_MEMBERSHIP_TTL, MemberWorkspace, MemberWorkspacesFuture, MembershipFuture,
    MembershipLookup, MembershipsFuture, SoleWorkspace, WorkspaceSelector, workspace_from_header,
};
pub use middleware::workspace_db;
pub use orm::{OrmConn, orm, orm_error, utc_minutes_ago, utc_now, utc_timestamp};
pub use permissions::TenantPermissionQueries;
pub use pg_errors::{
    MovedDatabaseFailure, classify_moved_database_error, database_error, has_pg_error_code,
    is_foreign_key_violation, is_missing_table, is_password_auth_failure, is_read_only_transaction,
    is_unique_violation, pg_constraint, pg_error_code,
};
pub use restrictions::{
    ReadOnlyReason, RestrictionInput, WorkspaceRestrictions, compute_workspace_restrictions,
    read_only_message,
};
pub use rows::{camel_case, js_row, js_timestamp};
pub use sqlx::PgPool;
pub use workspaces::{
    PoolUsage, Tenant, WRITE_BLOCKING_DATABASE_MOVE_STATUSES, WorkspaceConfig, WorkspaceError,
    WorkspacePools, Workspaces, master_pool,
};

/// The master database a request should use, as a request extension.
/// Conformance builds insert the test's master database; elsewhere modules
/// use the app's master pool.
#[derive(Debug, Clone)]
pub struct MasterDb(pub PgPool);
