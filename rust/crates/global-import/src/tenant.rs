//! One workspace's tenant database, from Global's Neon database into a
//! database on one of the install's shards ([`move_tenant`]).
//!
//! The two schemas are the same journaled migrations (ADR DATA-019), so the
//! copy is exact: the new database is first migrated to the very migrations
//! Global's database has applied ([`SourceLevel`]), the rows are streamed
//! across table by table in one transaction on each side (a consistent
//! snapshot of Global, all or nothing on the install), and only then do the
//! migrations written since run, on the moved data, as they would have on
//! Global. While the rows load, foreign keys are lifted and put back (so the
//! order doesn't matter and every reference is checked once at the end) and
//! the tables' own triggers are quiet (the rows they would derive are copied
//! too).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Connection as _, PgConnection, PgPool};
use time::OffsetDateTime;
use weldsuite_db::{orm, utc_now};
use weldsuite_migrations::{
    ACTIVE_DATABASE_MOVE_STATUSES, DatabaseOptions, Folder, Journal, check_journal,
    migrate_database,
};
use weldsuite_outside_eu::ServiceId;
use weldsuite_outside_eu::store::{self as outside_eu, Change, Via};
use weldsuite_ports::{BoxFuture, DatabaseUrl, ProvisionError};
use weldsuite_schema::master::{workspace_database_moves as moves, workspaces};

use crate::global::{self, Global, GlobalWorkspace};
use crate::sql;
use crate::{ImportError, MOVE_KIND};

/// The bookkeeping table the migration runner keeps in each tenant: the
/// new database writes its own rows.
const MIGRATIONS_TABLE: &str = "__drizzle_migrations";

/// Every kind of the workspace due index a sweep reads
/// (`weldsuite_db::due_index`). Global keeps its schedules elsewhere (D1,
/// Cloudflare Workflows), so a moved workspace starts with none of these
/// rows: each is seeded at the move, the sweep opens the tenant once and
/// stores the time its data says is next.
pub const DUE_KINDS: &[&str] = &[
    "approval_due",
    "asset_import",
    "benefit_measure",
    "books",
    "calendar_replan",
    "connector_catchup",
    "crm_sync",
    "desk_report",
    "desk_sla",
    "digipoort_status",
    "domain_renew",
    "file_purge",
    "finance_snapshot",
    "forms_digest",
    "forms_reminders",
    "mail_snooze",
    "merge_digest",
    "moneybird_push",
    "reach_send",
    "reach_warmup",
    "sign_lifecycle",
    "stash_parcel_tracking",
    "stash_replenishment",
    "status_report_due",
    "webhook_retry",
    "weldagent_routine",
    "workflow_poll",
    "workflow_schedule",
];

/// Where a Global database stands in the tenant journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLevel {
    /// The journal migrations it has applied, in journal order.
    pub applied: Vec<String>,
    /// Journal migrations it lacks that come before its newest one: applied
    /// after the copy, with the rest.
    pub gaps: Vec<String>,
    /// Rows of migrations this build's journal doesn't know.
    pub unknown: usize,
    /// `pg_database_size`.
    pub bytes: i64,
}

impl SourceLevel {
    /// The newest migration it has.
    pub fn latest(&self) -> Option<&str> {
        self.applied.last().map(String::as_str)
    }
}

/// Read a Global database's level.
pub async fn level(conn: &mut PgConnection) -> Result<SourceLevel, ImportError> {
    let journal = Journal::embedded(Folder::Tenant);
    let matched = check_journal(conn, journal)
        .await
        .map_err(|error| ImportError::failed("reading the migrations it has", error))?;
    let applied: Vec<String> = journal
        .migrations()
        .iter()
        .map(|migration| migration.tag().to_owned())
        .filter(|tag| matched.applied.contains(tag))
        .collect();
    let newest = applied.last();
    let gaps = matched
        .missing
        .iter()
        .filter(|tag| newest.is_some_and(|newest| *tag < newest))
        .cloned()
        .collect();
    let bytes = database_size(conn).await?;
    Ok(SourceLevel {
        applied,
        gaps,
        unknown: matched.unknown.len(),
        bytes,
    })
}

#[allow(
    clippy::disallowed_methods,
    reason = "pg_database_size: a figure of the server, not a table"
)]
async fn database_size(conn: &mut PgConnection) -> Result<i64, ImportError> {
    sqlx::query_scalar("select pg_database_size(current_database())")
        .fetch_one(&mut *conn)
        .await
        .map_err(|error| ImportError::failed("reading its size", error))
}

/// The journal of exactly `applied` (in journal order), built once per
/// distinct set and kept for the process (the provisioner takes a
/// `&'static Journal`; a run sees a handful of levels).
pub fn journal_at(applied: &[String]) -> &'static Journal {
    static LEVELS: LazyLock<Mutex<Vec<&'static Journal>>> = LazyLock::new(Mutex::default);
    let wanted: BTreeSet<&str> = applied.iter().map(String::as_str).collect();
    let mut levels = LEVELS.lock().unwrap_or_else(PoisonError::into_inner);
    let same = |journal: &&Journal| {
        journal.migrations().len() == wanted.len()
            && journal
                .migrations()
                .iter()
                .all(|migration| wanted.contains(migration.tag()))
    };
    if let Some(journal) = levels.iter().find(|journal| same(journal)) {
        return journal;
    }
    let migrations = Journal::embedded(Folder::Tenant)
        .migrations()
        .iter()
        .filter(|migration| wanted.contains(migration.tag()))
        .cloned()
        .collect();
    let journal: &'static Journal = Box::leak(Box::new(Journal::new(Folder::Tenant, migrations)));
    levels.push(journal);
    journal
}

/// Makes a workspace's database on one of the install's shards, migrated
/// with a given journal (the CloudNativePG provisioner's `with_journal`),
/// and drops it again.
pub trait LevelProvisioner: Send + Sync {
    /// Create (or finish creating) the workspace's database, migrate it with
    /// `journal`, record its placement and sealed URL, and return the URL.
    fn provision_at<'a>(
        &'a self,
        workspace_id: &'a str,
        journal: &'static Journal,
    ) -> BoxFuture<'a, Result<DatabaseUrl, ProvisionError>>;

    /// Drop the workspace's database and clear its placement.
    fn teardown<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<(), ProvisionError>>;
}

/// How [`move_tenant`] runs.
#[derive(Debug, Clone, Copy)]
pub struct TenantOptions<'a> {
    /// Copy again a workspace an earlier run finished: its database on the
    /// install is dropped first.
    pub replace: bool,
    /// Who runs the move (`--as`): recorded on the move row and on the
    /// services outside the EU it switches on.
    pub actor: &'a str,
}

/// Rows of one table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRows {
    pub table: String,
    pub rows: u64,
}

/// What [`move_tenant`] did for one workspace.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantReport {
    pub workspace_id: String,
    /// `false`: an earlier run had finished it (see `--replace`).
    pub copied: bool,
    /// The migration level the database came over at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub tables: Vec<TableRows>,
    pub rows: u64,
    pub bytes: u64,
    /// Migrations applied after the copy.
    pub migrations_after: Vec<String>,
    pub materialized_views: usize,
    /// Services outside the EU switched on for what the workspace had
    /// connected on Global (ADR OPS-026).
    pub outside_eu: Vec<String>,
    /// What finished but needs a look.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub seconds: f64,
}

/// Copy `workspace`'s Global database into a new database on the install
/// and make the workspace ready there (see the module docs). The install's
/// master must already have the workspace's row ([`crate::master::copy`]).
/// A run that fails part-way leaves its `failed` move row; the next run
/// drops what it made and starts over.
pub async fn move_tenant(
    global: &Global,
    install: &PgPool,
    provisioner: &dyn LevelProvisioner,
    workspace: &GlobalWorkspace,
    options: TenantOptions<'_>,
) -> Result<TenantReport, ImportError> {
    let started = Instant::now();
    let id = workspace.id.as_str();
    let placed = install_row(install, id).await?;
    if !options.replace && last_move_status(install, id).await?.as_deref() == Some("completed") {
        return Ok(TenantReport {
            workspace_id: id.to_owned(),
            copied: false,
            level: None,
            tables: Vec::new(),
            rows: 0,
            bytes: 0,
            migrations_after: Vec::new(),
            materialized_views: 0,
            outside_eu: Vec::new(),
            warnings: Vec::new(),
            seconds: started.elapsed().as_secs_f64(),
        });
    }
    let mut source = global.connect(workspace).await?;
    let level = level(&mut source).await?;
    if level.unknown > 0 {
        return Err(ImportError::refused(format!(
            "{id}: Global's database has {} migration row(s) this build's journal doesn't know: \
             copy it with a build that has them",
            level.unknown
        )));
    }
    close_interrupted_moves(install, id).await?;
    if placed {
        // Global's side answered: only now drop what an earlier run made.
        set_ready(install, id, false).await?;
        provisioner.teardown(id).await.map_err(|error| {
            ImportError::failed(&format!("{id}: dropping the earlier copy"), error)
        })?;
    }
    let move_id = start_move(install, workspace, options.actor).await?;
    let result = copy_and_finish(
        install,
        provisioner,
        workspace,
        &mut source,
        &level,
        options,
    )
    .await;
    let _ = source.close().await;
    match result {
        Ok(mut report) => {
            report.seconds = started.elapsed().as_secs_f64();
            finish_move(install, &move_id, &report).await?;
            Ok(report)
        }
        Err(error) => {
            fail_move(install, &move_id, &error.to_string()).await;
            Err(error)
        }
    }
}

async fn copy_and_finish(
    install: &PgPool,
    provisioner: &dyn LevelProvisioner,
    workspace: &GlobalWorkspace,
    source: &mut PgConnection,
    level: &SourceLevel,
    options: TenantOptions<'_>,
) -> Result<TenantReport, ImportError> {
    let id = workspace.id.as_str();
    let url = provisioner
        .provision_at(id, journal_at(&level.applied))
        .await
        .map_err(|error| ImportError::failed(&format!("{id}: a database on the install"), error))?;
    let what = format!("{id}'s database on the install");
    let mut target = global::connect(url.expose(), &what).await?;
    let copied = copy_database(source, &mut target)
        .await
        .map_err(|error| prefix(id, error))?;
    let _ = target.close().await;

    let outcome = migrate_database(
        url.expose(),
        Journal::embedded(Folder::Tenant),
        DatabaseOptions {
            apply_skipped: true,
            check_only: false,
        },
    )
    .await
    .map_err(|error| ImportError::failed(&format!("{id}: the migrations since"), error))?;
    if let Some(gap) = outcome.journal_gap {
        return Err(ImportError::Failed(format!(
            "{id}: still not at the journal level after the copy: {gap}"
        )));
    }

    let mut target = global::connect(url.expose(), &what).await?;
    let views = refresh_materialized_views(&mut target)
        .await
        .map_err(|error| prefix(id, error))?;
    let (connected, warnings) = sql::connected_providers(&mut target)
        .await
        .map_err(|error| ImportError::failed(&format!("{id}: reading its integrations"), error))?;
    let _ = target.close().await;
    let outside_eu = switch_on_outside_eu(url.expose(), &connected, options.actor)
        .await
        .map_err(|error| prefix(id, error))?;

    set_ready(install, id, true).await?;
    let now = OffsetDateTime::now_utc();
    for kind in DUE_KINDS {
        weldsuite_db::due_index::mark_due(install, kind, id, now).await;
    }
    Ok(TenantReport {
        workspace_id: id.to_owned(),
        copied: true,
        level: level.latest().map(str::to_owned),
        rows: copied.iter().map(|table| table.rows).sum(),
        bytes: copied.iter().map(|table| table.bytes).sum(),
        tables: copied
            .into_iter()
            .map(|table| TableRows {
                table: table.table,
                rows: table.rows,
            })
            .collect(),
        migrations_after: outcome
            .applied
            .into_iter()
            .chain(outcome.applied_skipped)
            .collect(),
        materialized_views: views,
        outside_eu,
        warnings: warnings
            .into_iter()
            .map(|problem| {
                format!(
                    "connections not read ({problem}): switch their services on with `weldsuite admin outside-eu on` if needed"
                )
            })
            .collect(),
        seconds: 0.0,
    })
}

fn prefix(id: &str, error: ImportError) -> ImportError {
    match error {
        ImportError::Refused(message) => ImportError::Refused(format!("{id}: {message}")),
        ImportError::Failed(message) => ImportError::Failed(format!("{id}: {message}")),
    }
}

/// One table as [`copy_database`] moved it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CopiedTable {
    pub(crate) table: String,
    pub(crate) rows: u64,
    pub(crate) bytes: u64,
}

/// Every row of every table of `source` into `target`, whose schema is at
/// the same migration level: one snapshot of the source, one transaction on
/// the target. Refuses a table or column the target lacks (the data would
/// be lost) and fails on any count that differs.
pub(crate) async fn copy_database(
    source: &mut PgConnection,
    target: &mut PgConnection,
) -> Result<Vec<CopiedTable>, ImportError> {
    let mut read = source
        .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .await
        .map_err(|error| ImportError::failed("a snapshot of Global's database", error))?;
    sql::execute(&mut read, "SET LOCAL statement_timeout = 0")
        .await
        .map_err(|error| ImportError::failed("Global's database", error))?;
    let source_tables = sql::tables(&mut read)
        .await
        .map_err(|error| ImportError::failed("reading Global's tables", error))?;
    let target_tables = sql::tables(target)
        .await
        .map_err(|error| ImportError::failed("reading the new database's tables", error))?;
    schema_problems(&source_tables, &target_tables)?;

    let mut write = target
        .begin()
        .await
        .map_err(|error| ImportError::failed("starting the copy", error))?;
    sql::execute(&mut write, "SET LOCAL statement_timeout = 0")
        .await
        .map_err(|error| ImportError::failed("the new database", error))?;
    let lifted = lift(&mut write).await?;
    empty(&mut write, &target_tables).await?;
    let copied = copy_rows(&mut read, &mut write, &source_tables).await?;
    copy_sequences(&mut read, &mut write).await?;
    restore(&mut write, &lifted).await?;
    write
        .commit()
        .await
        .map_err(|error| ImportError::failed("committing the copy", error))?;
    let _ = read.rollback().await;
    Ok(copied)
}

/// What [`lift`] took off the new database while the rows load.
struct Lifted {
    foreign_keys: Vec<sql::ForeignKey>,
    /// Tables whose own triggers are off.
    triggered: Vec<String>,
}

/// Drop the foreign keys (kept, to put back) and turn the tables' own
/// triggers off, so rows load in any order and nothing derives rows from
/// them: the derived rows are copied too.
async fn lift(write: &mut PgConnection) -> Result<Lifted, ImportError> {
    let failed = |what: &'static str| move |error: sqlx::Error| ImportError::failed(what, error);
    let foreign_keys = sql::foreign_keys(write)
        .await
        .map_err(failed("reading the foreign keys"))?;
    for key in &foreign_keys {
        let statement = format!(
            "ALTER TABLE {} DROP CONSTRAINT {}",
            sql::qualified(&key.table),
            sql::ident(&key.name)
        );
        sql::execute(write, &statement)
            .await
            .map_err(failed("lifting a foreign key"))?;
    }
    let triggered = sql::tables_with_triggers(write)
        .await
        .map_err(failed("reading the triggers"))?;
    for table in &triggered {
        let statement = format!("ALTER TABLE {} DISABLE TRIGGER USER", sql::qualified(table));
        sql::execute(write, &statement)
            .await
            .map_err(failed("quieting a trigger"))?;
    }
    Ok(Lifted {
        foreign_keys,
        triggered,
    })
}

/// Triggers on again, foreign keys back: each key checks every row it
/// covers as it is added.
async fn restore(write: &mut PgConnection, lifted: &Lifted) -> Result<(), ImportError> {
    for table in &lifted.triggered {
        let statement = format!("ALTER TABLE {} ENABLE TRIGGER USER", sql::qualified(table));
        sql::execute(write, &statement)
            .await
            .map_err(|error| ImportError::failed("turning a trigger back on", error))?;
    }
    for key in &lifted.foreign_keys {
        let statement = format!(
            "ALTER TABLE {} ADD CONSTRAINT {} {}",
            sql::qualified(&key.table),
            sql::ident(&key.name),
            key.definition
        );
        sql::execute(write, &statement).await.map_err(|error| {
            ImportError::failed(
                &format!("{}: putting back the foreign key {}", key.table, key.name),
                error,
            )
        })?;
    }
    Ok(())
}

/// Empty every table but the migration runner's: the migrations seeded
/// rows (default settings, roles) that Global's database has too, as they
/// are there now.
async fn empty(
    write: &mut PgConnection,
    tables: &BTreeMap<String, Vec<String>>,
) -> Result<(), ImportError> {
    let list = tables
        .keys()
        .filter(|table| table.as_str() != MIGRATIONS_TABLE)
        .map(|table| sql::qualified(table))
        .collect::<Vec<_>>();
    if list.is_empty() {
        return Ok(());
    }
    sql::execute(write, &format!("TRUNCATE {}", list.join(", ")))
        .await
        .map_err(|error| ImportError::failed("emptying the new database", error))
}

/// Stream each table across and count it on both sides.
async fn copy_rows(
    read: &mut PgConnection,
    write: &mut PgConnection,
    tables: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<CopiedTable>, ImportError> {
    let mut copied = Vec::new();
    for (table, columns) in tables {
        if table == MIGRATIONS_TABLE || columns.is_empty() {
            continue;
        }
        let moved = sql::copy_table(read, write, table, columns)
            .await
            .map_err(|error| ImportError::failed(&format!("copying {table}"), error))?;
        let expected = sql::count_rows(read, table)
            .await
            .map_err(|error| ImportError::failed(&format!("counting Global's {table}"), error))?;
        let landed = sql::count_rows(write, table)
            .await
            .map_err(|error| ImportError::failed(&format!("counting the new {table}"), error))?;
        if u64::try_from(expected).ok() != Some(moved.rows) || expected != landed {
            return Err(ImportError::Failed(format!(
                "{table}: Global has {expected} rows, {} were sent and {landed} landed",
                moved.rows
            )));
        }
        copied.push(CopiedTable {
            table: table.clone(),
            rows: moved.rows,
            bytes: moved.bytes,
        });
    }
    Ok(copied)
}

/// Each sequence both sides have goes on where Global's was.
async fn copy_sequences(
    read: &mut PgConnection,
    write: &mut PgConnection,
) -> Result<(), ImportError> {
    let failed = |what: &'static str| move |error: sqlx::Error| ImportError::failed(what, error);
    let on_global: BTreeSet<String> = sql::sequences(read)
        .await
        .map_err(failed("reading Global's sequences"))?
        .into_iter()
        .collect();
    for sequence in sql::sequences(write)
        .await
        .map_err(failed("reading the sequences"))?
    {
        if on_global.contains(&sequence) {
            let state = sql::sequence_state(read, &sequence)
                .await
                .map_err(failed("reading a sequence"))?;
            sql::set_sequence(write, &sequence, state)
                .await
                .map_err(failed("setting a sequence"))?;
        }
    }
    Ok(())
}

/// A table or column Global has that the new database doesn't: its rows or
/// values would be lost.
fn schema_problems(
    source: &BTreeMap<String, Vec<String>>,
    target: &BTreeMap<String, Vec<String>>,
) -> Result<(), ImportError> {
    let mut problems = Vec::new();
    for (table, columns) in source {
        if table == MIGRATIONS_TABLE {
            continue;
        }
        let Some(target_columns) = target.get(table) else {
            problems.push(format!("table {table}"));
            continue;
        };
        for column in columns {
            if !target_columns.contains(column) {
                problems.push(format!("{table}.{column}"));
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(ImportError::refused(format!(
            "Global's database has what the same migrations didn't make here (changed by hand?): {}",
            problems.join(", ")
        )))
    }
}

/// Refresh every materialized view; one that reads another goes after it.
/// Returns how many were refreshed.
pub(crate) async fn refresh_materialized_views(
    conn: &mut PgConnection,
) -> Result<usize, ImportError> {
    let mut pending = sql::materialized_views(conn)
        .await
        .map_err(|error| ImportError::failed("reading the materialized views", error))?;
    let mut refreshed = 0;
    loop {
        let before = pending.len();
        let mut left = Vec::new();
        let mut last_error = None;
        for view in pending {
            let statement = format!("REFRESH MATERIALIZED VIEW {}", sql::qualified(&view));
            match sql::execute(conn, &statement).await {
                Ok(()) => refreshed += 1,
                Err(error) => {
                    last_error = Some((view.clone(), error));
                    left.push(view);
                }
            }
        }
        match last_error {
            None => return Ok(refreshed),
            // Nothing refreshed this round: what is left fails on its own.
            Some((view, error)) if left.len() == before => {
                return Err(ImportError::failed(&format!("refreshing {view}"), error));
            }
            Some(_) => pending = left,
        }
    }
}

/// `new Date(…).toISOString()`, as the opt-in store records times.
fn iso_timestamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

/// Switch on, for the moved workspace, the services outside the EU behind
/// what it had connected on Global (ADR OPS-026, OPS-025 decision 6).
/// Returns the services switched on.
async fn switch_on_outside_eu(
    url: &str,
    connected: &[(String, String)],
    actor: &str,
) -> Result<Vec<String>, ImportError> {
    let services: BTreeSet<ServiceId> = connected
        .iter()
        .filter(|(_, status)| is_live(status))
        .filter_map(|(provider, _)| ServiceId::for_integration(provider))
        .collect();
    if services.is_empty() {
        return Ok(Vec::new());
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .map_err(|error| ImportError::failed("connecting for the opt-ins", error))?;
    let at = iso_timestamp(OffsetDateTime::now_utc());
    let mut switched = Vec::new();
    for service in services {
        outside_eu::set(
            &pool,
            &Change {
                service,
                enabled: true,
                actor,
                via: Via::Move,
                acknowledged: false,
                reason: Some("connected on Global before the move"),
                at: &at,
            },
        )
        .await
        .map_err(|error| ImportError::failed(&format!("switching on {service}"), error))?;
        switched.push(service.to_string());
    }
    pool.close().await;
    Ok(switched)
}

/// A connection status that means it is in use (the inventory's
/// `INACTIVE_STATUS`: error, inactive, disconnected, revoked are not).
fn is_live(status: &str) -> bool {
    let status = status.to_ascii_lowercase();
    !["error", "inactive", "disconnected", "revoked"]
        .iter()
        .any(|word| status.contains(word))
}

/// Whether the install has the workspace's row, and whether it already has
/// a placement (an earlier run's database).
async fn install_row(install: &PgPool, id: &str) -> Result<bool, ImportError> {
    let row: Option<Option<String>> = workspaces::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(workspaces::Column::NeonProjectId)
        .into_tuple()
        .one(&orm(install))
        .await
        .map_err(|error| ImportError::failed("reading the install's workspace", error))?;
    match row {
        None => Err(ImportError::refused(format!(
            "{id} is not in this install's master yet: run `import-global master` first"
        ))),
        Some(placement) => Ok(placement.is_some()),
    }
}

/// The status of the workspace's latest move from Global.
async fn last_move_status(install: &PgPool, id: &str) -> Result<Option<String>, ImportError> {
    moves::Entity::find()
        .select_only()
        .column(moves::Column::Status)
        .filter(moves::Column::WorkspaceId.eq(id))
        .filter(moves::Column::Kind.eq(MOVE_KIND))
        .order_by_desc(moves::Column::CreatedAt)
        .into_tuple()
        .one(&orm(install))
        .await
        .map_err(|error| ImportError::failed("reading the earlier moves", error))
}

/// A move row still active from a run that stopped (a crash, a killed pod)
/// is closed as failed, so a new one can start.
async fn close_interrupted_moves(install: &PgPool, id: &str) -> Result<(), ImportError> {
    moves::Entity::update_many()
        .col_expr(moves::Column::Status, Expr::value("failed"))
        .col_expr(
            moves::Column::Error,
            Expr::value("interrupted: a later run started over"),
        )
        .col_expr(
            moves::Column::UpdatedAt,
            Expr::value(OffsetDateTime::now_utc()),
        )
        .filter(moves::Column::WorkspaceId.eq(id))
        .filter(moves::Column::Status.is_in(ACTIVE_DATABASE_MOVE_STATUSES))
        .exec(&orm(install))
        .await
        .map(drop)
        .map_err(|error| ImportError::failed("closing an interrupted move", error))
}

/// The `workspace_database_moves` row of this copy, `copying`: while it is
/// active, `weldsuite migrate` leaves the database alone.
async fn start_move(
    install: &PgPool,
    workspace: &GlobalWorkspace,
    actor: &str,
) -> Result<String, ImportError> {
    let id = weldsuite_kit::generate_id("wdm");
    let source = workspace.database.as_ref();
    let field = |value: Option<&str>| value.unwrap_or_default().to_owned();
    let now = OffsetDateTime::now_utc();
    moves::Entity::insert(moves::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace.id.clone()),
        kind: Set(MOVE_KIND.to_owned()),
        status: Set("copying".to_owned()),
        current_step: Set(Some("copying".to_owned())),
        requested_target: Set("install".to_owned()),
        source_neon_project_id: Set(field(source.and_then(|db| db.neon_project_id()))),
        source_neon_branch_id: Set(field(source.and_then(|db| db.neon_branch_id()))),
        source_database_name: Set(field(source.and_then(|db| db.neon_database_name()))),
        source_role_name: Set(field(source.and_then(|db| db.neon_role_name()))),
        started_by: Set(actor.to_owned()),
        reason: Set(Some("the move from Global (OPS-025)".to_owned())),
        started_at: Set(Some(now)),
        ..Default::default()
    })
    .exec_without_returning(&orm(install))
    .await
    .map_err(|error| ImportError::failed("recording the move", error))?;
    Ok(id)
}

async fn finish_move(
    install: &PgPool,
    move_id: &str,
    report: &TenantReport,
) -> Result<(), ImportError> {
    let tables: serde_json::Map<String, Value> = report
        .tables
        .iter()
        .map(|table| (table.table.clone(), json!(table.rows)))
        .collect();
    let now = OffsetDateTime::now_utc();
    moves::Entity::update_many()
        .col_expr(moves::Column::Status, Expr::value("completed"))
        .col_expr(moves::Column::CurrentStep, Expr::value("completed"))
        .col_expr(
            moves::Column::Verification,
            Expr::value(json!({
                "level": report.level,
                "rows": report.rows,
                "bytes": report.bytes,
                "tables": tables,
                "migrationsAfter": report.migrations_after,
                "outsideEu": report.outside_eu,
            })),
        )
        .col_expr(moves::Column::CompletedAt, Expr::value(now))
        .col_expr(moves::Column::UpdatedAt, Expr::value(now))
        .filter(moves::Column::Id.eq(move_id))
        .exec(&orm(install))
        .await
        .map(drop)
        .map_err(|error| ImportError::failed("recording the finished move", error))
}

/// Best effort: the error being reported matters more than this row.
async fn fail_move(install: &PgPool, move_id: &str, error: &str) {
    let result = moves::Entity::update_many()
        .col_expr(moves::Column::Status, Expr::value("failed"))
        .col_expr(moves::Column::Error, Expr::value(error.to_owned()))
        .col_expr(
            moves::Column::UpdatedAt,
            Expr::value(OffsetDateTime::now_utc()),
        )
        .filter(moves::Column::Id.eq(move_id))
        .exec(&orm(install))
        .await;
    if let Err(db_error) = result {
        tracing::error!(%db_error, move_id, "import-global: recording the failed move failed");
    }
}

/// Whether the workspace can be entered: ready once its database is, back
/// to `provisioning` while a second run makes it again.
async fn set_ready(install: &PgPool, id: &str, ready: bool) -> Result<(), ImportError> {
    let (status, provisioned_at) = if ready {
        ("ready", Some(utc_now()))
    } else {
        ("provisioning", None)
    };
    workspaces::Entity::update_many()
        .col_expr(
            workspaces::Column::DatabaseProvisionedAt,
            Expr::value(provisioned_at),
        )
        .col_expr(workspaces::Column::ProvisioningStatus, Expr::value(status))
        .col_expr(
            workspaces::Column::ProvisioningError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(workspaces::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(workspaces::Column::Id.eq(id))
        .exec(&orm(install))
        .await
        .map(drop)
        .map_err(|error| ImportError::failed("setting whether the workspace is ready", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_journal_holds_exactly_the_applied_migrations_in_order() {
        let tenant = Journal::embedded(Folder::Tenant);
        let tags: Vec<String> = tenant
            .migrations()
            .iter()
            .map(|migration| migration.tag().to_owned())
            .collect();
        let applied: Vec<String> = tags
            .iter()
            .take(5)
            .cloned()
            .chain([tags[7].clone()])
            .collect();
        let journal = journal_at(&applied);
        let got: Vec<&str> = journal
            .migrations()
            .iter()
            .map(weldsuite_migrations::Migration::tag)
            .collect();
        assert_eq!(got, applied.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(std::ptr::eq(journal, journal_at(&applied)), "built once");
        let reversed: Vec<String> = applied.iter().rev().cloned().collect();
        assert!(std::ptr::eq(journal, journal_at(&reversed)), "the same set");
    }

    #[test]
    fn a_column_or_table_only_global_has_stops_the_copy() {
        let tables = |entries: &[(&str, &[&str])]| -> BTreeMap<String, Vec<String>> {
            entries
                .iter()
                .map(|(table, columns)| {
                    (
                        (*table).to_owned(),
                        columns.iter().map(|c| (*c).to_owned()).collect(),
                    )
                })
                .collect()
        };
        let target = tables(&[("a", &["id", "x"]), ("b", &["id"])]);
        assert!(schema_problems(&tables(&[("a", &["id"]), ("b", &["id"])]), &target).is_ok());
        assert!(
            schema_problems(
                &tables(&[("__drizzle_migrations", &["id", "hash"])]),
                &target
            )
            .is_ok()
        );
        let error = schema_problems(&tables(&[("a", &["id", "y"]), ("c", &["id"])]), &target)
            .expect_err("refused");
        let message = error.to_string();
        assert!(
            message.contains("a.y") && message.contains("table c"),
            "{message}"
        );
    }

    #[test]
    fn live_connections_only() {
        assert!(is_live("active"));
        assert!(is_live("connected"));
        assert!(is_live("syncing"));
        assert!(!is_live("error"));
        assert!(!is_live("Disconnected"));
        assert!(!is_live("revoked"));
        assert!(!is_live("inactive"));
    }

    #[test]
    fn times_are_written_as_javascript_writes_them() {
        let at =
            OffsetDateTime::from_unix_timestamp_nanos(1_800_000_000_123_999_999).expect("in range");
        assert_eq!(iso_timestamp(at), "2027-01-15T08:00:00.123Z");
        assert_eq!(
            iso_timestamp(OffsetDateTime::UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn due_kinds_are_unique() {
        let unique: BTreeSet<&&str> = DUE_KINDS.iter().collect();
        assert_eq!(unique.len(), DUE_KINDS.len());
    }
}
