//! Applying a journal to one database, as the TypeScript runners do, so a
//! database either runner migrated is up to date for the other.
//!
//! - [`migrate`] is Drizzle's migrator (`PgDialect.migrate` in drizzle-orm
//!   0.45), which both `pnpm db:migrate:master` (drizzle-kit) and
//!   `apps/tools/migrate-databases` run: the bookkeeping table
//!   `<schema>.__drizzle_migrations (id serial, hash text, created_at bigint)`,
//!   then every migration whose `when` is newer than the newest row's
//!   `created_at`, split on `--> statement-breakpoint`, all of them in one
//!   transaction, each recorded with its file's SHA-256 and `when`.
//! - [`check_journal`] and [`apply_skipped`] are the runner's journal
//!   reconciliation (`lib/journal-gap.ts`): Drizzle never applies a migration
//!   merged with an older `when` than one a database already ran, so the
//!   rows are judged migration by migration, and `--apply-skipped` applies
//!   the missing ones, each in its own transaction, recorded with its tag.
//!
//! One addition: every transaction first takes a transaction-scoped advisory
//! lock, so two Rust runners (the deploy Job and a provisioning call, or two
//! Jobs) on one database take turns, and the newest row is read after the
//! lock. Drizzle takes none; the TypeScript runners never run against the
//! Kubernetes databases, so nothing waits on a lock they do not take. A
//! transaction-scoped lock works through a transaction-mode `PgBouncer`.

use std::fmt;
use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection, Postgres, Transaction};

use crate::journal::{Folder, Journal, JournalMatch, Migration, RecordedMigration, match_journal};

/// The bookkeeping SQL of one folder. sqlx takes literal SQL only, so each
/// schema has its own set.
struct Bookkeeping {
    create_schema: &'static str,
    create_table: &'static str,
    newest: &'static str,
    record: &'static str,
    has_tag_column: &'static str,
    rows_with_tag: &'static str,
    rows_without_tag: &'static str,
    add_tag_column: &'static str,
    record_with_tag: &'static str,
    lock_key: i64,
}

const MASTER: Bookkeeping = Bookkeeping {
    create_schema: r#"CREATE SCHEMA IF NOT EXISTS "drizzle""#,
    create_table: r#"CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)"#,
    newest: r#"select id, hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1"#,
    record: r#"insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values($1, $2)"#,
    has_tag_column: "SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' AND column_name = 'tag'
    ) AS present",
    rows_with_tag: r#"SELECT tag, hash, created_at::text AS created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id"#,
    rows_without_tag: r#"SELECT NULL::text AS tag, hash, created_at::text AS created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id"#,
    add_tag_column: r#"ALTER TABLE "drizzle"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text"#,
    record_with_tag: r#"INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at, tag) VALUES ($1, $2, $3)"#,
    // "WELDMSTR"
    lock_key: 0x5745_4C44_4D53_5452,
};

const TENANT: Bookkeeping = Bookkeeping {
    create_schema: r#"CREATE SCHEMA IF NOT EXISTS "public""#,
    create_table: r#"CREATE TABLE IF NOT EXISTS "public"."__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)"#,
    newest: r#"select id, hash, created_at from "public"."__drizzle_migrations" order by created_at desc limit 1"#,
    record: r#"insert into "public"."__drizzle_migrations" ("hash", "created_at") values($1, $2)"#,
    has_tag_column: "SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '__drizzle_migrations' AND column_name = 'tag'
    ) AS present",
    rows_with_tag: r#"SELECT tag, hash, created_at::text AS created_at FROM "public"."__drizzle_migrations" ORDER BY id"#,
    rows_without_tag: r#"SELECT NULL::text AS tag, hash, created_at::text AS created_at FROM "public"."__drizzle_migrations" ORDER BY id"#,
    add_tag_column: r#"ALTER TABLE "public"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text"#,
    record_with_tag: r#"INSERT INTO "public"."__drizzle_migrations" (hash, created_at, tag) VALUES ($1, $2, $3)"#,
    // "WELDTNNT"
    lock_key: 0x5745_4C44_544E_4E54,
};

fn bookkeeping(folder: Folder) -> &'static Bookkeeping {
    match folder {
        Folder::Master => &MASTER,
        Folder::Tenant => &TENANT,
    }
}

/// How long [`migrate_database`] waits for a connection (postgres.js's
/// default `connect_timeout`, which the TypeScript runner uses).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a database was not migrated. The whole transaction rolled back: the
/// database is as it was before the call.
#[derive(Debug)]
pub enum MigrateError {
    /// No connection within [`CONNECT_TIMEOUT`].
    ConnectTimeout,
    /// Postgres refused migration `tag`: one of its statements, or its row.
    Migration {
        tag: String,
        statements: usize,
        source: sqlx::Error,
    },
    /// Connecting, the bookkeeping table, or the commit.
    Database(sqlx::Error),
}

impl MigrateError {
    /// The SQLSTATE Postgres answered with, if it answered.
    pub fn sql_state(&self) -> Option<String> {
        let source = match self {
            Self::Migration { source, .. } | Self::Database(source) => source,
            Self::ConnectTimeout => return None,
        };
        source
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .map(std::borrow::Cow::into_owned)
    }

    /// The migration that failed, if one did.
    pub fn tag(&self) -> Option<&str> {
        match self {
            Self::Migration { tag, .. } => Some(tag),
            _ => None,
        }
    }
}

impl fmt::Display for MigrateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConnectTimeout => write!(
                f,
                "no connection to the database within {}s",
                CONNECT_TIMEOUT.as_secs()
            ),
            Self::Migration {
                tag,
                statements,
                source,
            } => {
                let count = if *statements == 1 {
                    "1 statement".to_owned()
                } else {
                    format!("{statements} statements")
                };
                write!(f, "migration {tag} failed ({count} in one transaction")?;
                if let Some(state) = self.sql_state() {
                    write!(f, ", SQLSTATE {state}")?;
                }
                write!(f, "): {}", describe(source))
            }
            Self::Database(source) => f.write_str(&describe(source)),
        }
    }
}

impl std::error::Error for MigrateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Migration { source, .. } | Self::Database(source) => Some(source),
            Self::ConnectTimeout => None,
        }
    }
}

impl From<sqlx::Error> for MigrateError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// Postgres's own message for a database error (what postgres.js puts in
/// `error.message`), sqlx's description otherwise.
fn describe(error: &sqlx::Error) -> String {
    error.as_database_error().map_or_else(
        || error.to_string(),
        |database| database.message().to_owned(),
    )
}

async fn lock(tx: &mut Transaction<'_, Postgres>, bookkeeping: &Bookkeeping) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock($1)")
        .bind(bookkeeping.lock_key)
        .execute(&mut **tx)
        .await
        .map(|_| ())
}

/// Run a migration's statements and its row (with the tag when `with_tag`)
/// inside `tx`.
async fn apply_one(
    tx: &mut Transaction<'_, Postgres>,
    bookkeeping: &Bookkeeping,
    migration: &Migration,
    with_tag: bool,
) -> Result<(), MigrateError> {
    let statements: Vec<&str> = migration.statements().collect();
    let failed = |source| MigrateError::Migration {
        tag: migration.tag().to_owned(),
        statements: statements.len(),
        source,
    };
    for statement in &statements {
        // The simple query protocol, as postgres.js's `unsafe` without
        // parameters: a piece may hold several statements.
        sqlx::raw_sql(AssertSqlSafe(*statement))
            .execute(&mut **tx)
            .await
            .map_err(failed)?;
    }
    let record = if with_tag {
        sqlx::query(bookkeeping.record_with_tag)
            .bind(migration.hash())
            .bind(migration.when())
            .bind(migration.tag())
    } else {
        sqlx::query(bookkeeping.record)
            .bind(migration.hash())
            .bind(migration.when())
    };
    record.execute(&mut **tx).await.map_err(failed)?;
    Ok(())
}

/// Drizzle's migrator: apply every migration newer than the newest recorded
/// one, all in one transaction. Returns the tags applied, in order.
pub async fn migrate(
    conn: &mut PgConnection,
    journal: &Journal,
) -> Result<Vec<String>, MigrateError> {
    let bookkeeping = bookkeeping(journal.folder());

    // Drizzle creates the table before (and outside) its transaction, so it
    // stays when the migrations fail; so does this.
    let mut tx = conn.begin().await?;
    lock(&mut tx, bookkeeping).await?;
    sqlx::raw_sql(bookkeeping.create_schema)
        .execute(&mut *tx)
        .await?;
    sqlx::raw_sql(bookkeeping.create_table)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut tx = conn.begin().await?;
    lock(&mut tx, bookkeeping).await?;
    let newest: Option<(i32, String, Option<i64>)> = sqlx::query_as(bookkeeping.newest)
        .fetch_optional(&mut *tx)
        .await?;
    // `Number(lastDbMigration.created_at) < migration.folderMillis`; a null
    // `created_at` reads as 0 (and sorts first under `desc`).
    let newest = newest.map(|(_, _, created_at)| created_at.unwrap_or(0));

    let mut applied = Vec::new();
    for migration in journal.migrations() {
        if newest.is_some_and(|newest| newest >= migration.when()) {
            continue;
        }
        apply_one(&mut tx, bookkeeping, migration, false).await?;
        applied.push(migration.tag().to_owned());
    }
    tx.commit().await?;
    Ok(applied)
}

/// The migrations [`migrate`] would apply now, without applying them: none
/// recorded yet (or no table) means all.
pub async fn pending(
    conn: &mut PgConnection,
    journal: &Journal,
) -> Result<Vec<String>, MigrateError> {
    let bookkeeping = bookkeeping(journal.folder());
    let exists: bool = sqlx::query_scalar(
        "select exists (select 1 from information_schema.tables
                        where table_schema = $1 and table_name = '__drizzle_migrations')",
    )
    .bind(journal.folder().schema())
    .fetch_one(&mut *conn)
    .await?;
    let newest = if exists {
        let row: Option<(i32, String, Option<i64>)> = sqlx::query_as(bookkeeping.newest)
            .fetch_optional(&mut *conn)
            .await?;
        row.map(|(_, _, created_at)| created_at.unwrap_or(0))
    } else {
        None
    };
    Ok(journal
        .migrations()
        .iter()
        .filter(|migration| newest.is_none_or(|newest| newest < migration.when()))
        .map(|migration| migration.tag().to_owned())
        .collect())
}

/// The rows of `__drizzle_migrations`, oldest first (`readRecordedMigrations`).
/// Fails when the table does not exist.
pub async fn recorded(
    conn: &mut PgConnection,
    folder: Folder,
) -> Result<Vec<RecordedMigration>, MigrateError> {
    let bookkeeping = bookkeeping(folder);
    let has_tag: bool = sqlx::query_scalar(bookkeeping.has_tag_column)
        .fetch_one(&mut *conn)
        .await?;
    let query = if has_tag {
        bookkeeping.rows_with_tag
    } else {
        bookkeeping.rows_without_tag
    };
    let rows: Vec<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(query).fetch_all(&mut *conn).await?;
    Ok(rows
        .into_iter()
        .map(|(tag, hash, created_at)| RecordedMigration {
            tag,
            hash,
            created_at,
        })
        .collect())
}

/// Which journal migrations the database has applied (`checkJournal`).
pub async fn check_journal(
    conn: &mut PgConnection,
    journal: &Journal,
) -> Result<JournalMatch, MigrateError> {
    Ok(match_journal(
        &recorded(conn, journal.folder()).await?,
        journal,
    ))
}

/// Apply every migration `matched` reports missing, in journal order, each in
/// its own transaction with its row (hash, `when` and tag), so a failure
/// leaves the earlier ones applied and recorded (`applySkippedMigrations`).
/// Returns the tags applied.
pub async fn apply_skipped(
    conn: &mut PgConnection,
    journal: &Journal,
    matched: &JournalMatch,
) -> Result<Vec<String>, MigrateError> {
    let bookkeeping = bookkeeping(journal.folder());
    sqlx::raw_sql(bookkeeping.add_tag_column)
        .execute(&mut *conn)
        .await?;
    let mut applied = Vec::new();
    for tag in &matched.missing {
        let Some(migration) = journal.get(tag) else {
            continue;
        };
        let mut tx = conn.begin().await?;
        lock(&mut tx, bookkeeping).await?;
        apply_one(&mut tx, bookkeeping, migration, true).await?;
        tx.commit().await?;
        applied.push(tag.clone());
    }
    Ok(applied)
}

/// What [`migrate_database`] does besides Drizzle's migrator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DatabaseOptions {
    /// Also apply journal migrations Drizzle skipped (`--apply-skipped`).
    pub apply_skipped: bool,
    /// Change nothing: only report the journal gap (`--check-journal`).
    pub check_only: bool,
}

/// One database after [`migrate_database`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DatabaseOutcome {
    /// Tags Drizzle's migrator applied, in order.
    pub applied: Vec<String>,
    /// Skipped migrations applied with [`DatabaseOptions::apply_skipped`].
    pub applied_skipped: Vec<String>,
    /// Journal migrations still not applied (one line), when any.
    pub journal_gap: Option<String>,
}

/// Connect to `url` and bring the database to the journal level as
/// `apps/tools/migrate-databases` does for one workspace (`migrateWorkspace`):
/// Drizzle's migrator, then the journal check, and with `apply_skipped` the
/// migrations it skipped. One connection, closed at the end.
pub async fn migrate_database(
    url: &str,
    journal: &Journal,
    options: DatabaseOptions,
) -> Result<DatabaseOutcome, MigrateError> {
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect(url))
        .await
        .map_err(|_| MigrateError::ConnectTimeout)??;
    let outcome = migrate_connection(&mut conn, journal, options).await;
    let _ = conn.close().await;
    outcome
}

/// [`migrate_database`] on an open connection.
pub async fn migrate_connection(
    conn: &mut PgConnection,
    journal: &Journal,
    options: DatabaseOptions,
) -> Result<DatabaseOutcome, MigrateError> {
    let mut outcome = DatabaseOutcome::default();
    if !options.check_only {
        outcome.applied = migrate(conn, journal).await?;
    }
    let mut matched = check_journal(conn, journal).await?;
    if options.apply_skipped && !options.check_only && !matched.missing.is_empty() {
        outcome.applied_skipped = apply_skipped(conn, journal, &matched).await?;
        matched = check_journal(conn, journal).await?;
    }
    if !matched.is_at_journal_level() {
        outcome.journal_gap = Some(matched.describe_gap());
    }
    Ok(outcome)
}
