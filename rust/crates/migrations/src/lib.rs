//! The database migrations of the Kubernetes editions (`weldsuite migrate`).
//!
//! The Drizzle schema in `packages/core/db` stays the one definition of the
//! tables, and its generated SQL (`packages/core/db/drizzle/{master,tenant}-migrations`)
//! the one list of migrations. `build.rs` embeds that SQL in the binary, in
//! journal order, so the image carries exactly the migrations its code was
//! built against and needs no Node and no files at run time (OPS-013).
//!
//! The runner is the TypeScript one's twin, so a database migrated by either
//! is up to date for the other:
//!
//! - the master database as `pnpm db:migrate:master` (drizzle-kit) does it,
//!   bookkeeping in `drizzle.__drizzle_migrations`;
//! - each tenant database as `apps/tools/migrate-databases` does it,
//!   bookkeeping in `public.__drizzle_migrations`: the same rows (`hash` is
//!   the file's SHA-256, `created_at` the journal's `when`), the same
//!   `--> statement-breakpoint` split, one transaction per run, the same
//!   journal-gap check and `--apply-skipped`;
//! - the same tenants: active workspaces with a recorded placement, minus
//!   those a database move owns ([`list_tenants`]).
//!
//! [`migrate_database`] is the library entry the `DatabaseProvisioner`
//! adapter calls to bring a new tenant database to the journal level.

mod apply;
mod journal;
mod tenants;

pub use apply::{
    CONNECT_TIMEOUT, DatabaseOptions, DatabaseOutcome, MigrateError, apply_skipped, check_journal,
    migrate, migrate_connection, migrate_database, pending, recorded,
};
pub use journal::{
    Folder, Journal, JournalMatch, Migration, RETIRED_MIGRATION_HASHES, RecordedMigration,
    STATEMENT_BREAKPOINT, SUPERSEDED_MIGRATION_HASHES, match_journal,
};
pub use tenants::{
    ACTIVE_DATABASE_MOVE_STATUSES, TenantDatabase, TenantList, TenantResult, WorkspaceRef,
    list_tenants, mask_database_url, migrate_tenants, redact,
};
