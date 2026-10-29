//! `weldsuite migrate`: the master database and every tenant database to the
//! level of the migrations built into this binary (`weldsuite-migrations`).
//! The Helm chart runs it as a hook Job before every install and upgrade.
//!
//! It is `pnpm db:migrate:master` followed by `apps/tools/migrate-databases`,
//! with the same flags where they exist and the same report, so a database
//! either runner migrated is up to date for the other. Differences:
//!
//! - one command for both (`--master`, `--tenants`; neither means both);
//! - `--concurrency` migrates several tenants at once (the TypeScript runner
//!   does one at a time, the default here too);
//! - a workspace whose stored URL does not open is a failed workspace, not
//!   the end of the run;
//! - a placed workspace without a stored URL is still being provisioned (the
//!   provisioner migrates it itself) and is skipped: there is no Neon API to
//!   ask for its URL.
//!
//! Configuration: `DATABASE_URL_MASTER` (or the TypeScript runner's
//! `MASTER_DATABASE_URL`), `DATABASE_ENCRYPTION_KEY` and
//! `DATABASE_ENCRYPTION_KEY_V2` to open tenant URLs, `LOG_FORMAT`, `RUST_LOG`.

use std::process::ExitCode;

use sqlx::{Connection, PgConnection};
use weldsuite_db::Keyring;
use weldsuite_migrations::{
    CONNECT_TIMEOUT, DatabaseOptions, Folder, Journal, TenantDatabase, TenantList, TenantResult,
    WorkspaceRef, list_tenants, migrate_database, migrate_tenants, pending, redact,
};

use crate::config::LogFormat;
use crate::telemetry;

pub(crate) const USAGE: &str = "\
usage: weldsuite migrate [options]

Applies the migrations built into this binary to the master database
(DATABASE_URL_MASTER) and to every active workspace's tenant database, as
pnpm db:migrate:master and apps/tools/migrate-databases do.

options:
  --master             the master database
  --tenants            every tenant database (neither flag: both)
  --dry-run            list what would run; change nothing
  --only <id>          only this workspace (workspaces.id); also --workspace
  --check-journal      only report, per database, journal migrations it has
                       not applied (connects to every tenant; changes nothing)
  --apply-skipped      after migrating, also apply journal migrations Drizzle
                       skipped because they were merged with an older timestamp
  --concurrency <n>    tenant databases migrated at once (default 1)
  --verbose            show Postgres notices
  --redact             hide workspace names, ids and database hosts
                       (the default when CI or GITHUB_ACTIONS is set)
  --show-workspaces    show them (overrides --redact)
  -h, --help           print this message

A workspace whose database is being moved (workspace_database_moves, status
queued ... switching or cancelling) is skipped, not failed: its old database is
locked on purpose, and the next run migrates it wherever it lives by then.

Exit status: 0 when every database is at the journal level or only has gaps
(reported as warnings), 1 when any database failed, 2 for bad arguments,
78 when DATABASE_URL_MASTER is missing.";

// Command-line switches, one bool each.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Options {
    master: bool,
    tenants: bool,
    dry_run: bool,
    only: Option<String>,
    check_journal: bool,
    apply_skipped: bool,
    concurrency: usize,
    verbose: bool,
    redact: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    Run(Options),
    Help,
}

/// The flags after `migrate`. `redact_by_default` is on in CI, as the
/// TypeScript runner's (`CI` / `GITHUB_ACTIONS`).
fn parse(args: &[String], redact_by_default: bool) -> Result<Parsed, String> {
    let mut options = Options {
        master: false,
        tenants: false,
        dry_run: false,
        only: None,
        check_journal: false,
        apply_skipped: false,
        concurrency: 1,
        verbose: false,
        redact: redact_by_default,
    };
    let mut show_workspaces = false;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--master" => options.master = true,
            "--tenants" => options.tenants = true,
            "--dry-run" => options.dry_run = true,
            "--only" | "--workspace" => {
                let id = args
                    .next()
                    .filter(|id| !id.is_empty() && !id.starts_with("--"))
                    .ok_or_else(|| format!("{arg} needs a workspace id"))?;
                options.only = Some(id.clone());
            }
            "--check-journal" => options.check_journal = true,
            "--apply-skipped" => options.apply_skipped = true,
            "--concurrency" => {
                options.concurrency = args
                    .next()
                    .and_then(|n| n.parse().ok())
                    .filter(|n: &usize| *n >= 1)
                    .ok_or("--concurrency needs a whole number of at least 1")?;
            }
            "--verbose" => options.verbose = true,
            "--redact" => options.redact = true,
            "--show-workspaces" => show_workspaces = true,
            "-h" | "--help" => return Ok(Parsed::Help),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if !options.master && !options.tenants {
        options.master = true;
        options.tenants = true;
    }
    // "Show workspace details (overrides --redact)".
    if show_workspaces {
        options.redact = false;
    }
    Ok(Parsed::Run(options))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    let ci = env("CI").as_deref() == Some("true") || env("GITHUB_ACTIONS").is_some();
    let options = match parse(args, ci) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(problem) => {
            eprintln!("{problem}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let Some(master_url) = env("DATABASE_URL_MASTER").or_else(|| env("MASTER_DATABASE_URL")) else {
        eprintln!("DATABASE_URL_MASTER is required");
        return ExitCode::from(78); // EX_CONFIG
    };
    let keyring = Keyring {
        v1: env("DATABASE_ENCRYPTION_KEY"),
        v2: env("DATABASE_ENCRYPTION_KEY_V2"),
    };
    let format = if env("LOG_FORMAT").as_deref() == Some("text") {
        LogFormat::Text
    } else {
        LogFormat::Json
    };
    // Postgres notices ("already exists, skipping") only with --verbose, as
    // the TypeScript runner prints them.
    let filter = if options.verbose {
        "info"
    } else {
        "info,sqlx::postgres::notice=warn"
    };
    let telemetry = telemetry::init(format, filter);

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let succeeded = runtime.block_on(migrate(&options, &master_url, &keyring));
    telemetry.shutdown();
    if succeeded {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// What the report shows of workspaces and errors.
struct Report {
    redact: bool,
}

impl Report {
    /// `workspace #n` when redacting, `name (id)` otherwise.
    fn label(&self, position: usize, workspace: &WorkspaceRef) -> String {
        if self.redact {
            format!("workspace #{position}")
        } else {
            format!("{} ({})", workspace.name, workspace.id)
        }
    }

    fn clean(&self, message: &str) -> String {
        if self.redact {
            redact(message)
        } else {
            message.to_owned()
        }
    }
}

const RULE: &str = "===========================================";

async fn migrate(options: &Options, master_url: &str, keyring: &Keyring) -> bool {
    let report = Report {
        redact: options.redact,
    };
    println!("\n{RULE}\n  WeldSuite database migrations\n{RULE}\n");
    for folder in [Folder::Master, Folder::Tenant] {
        let journal = Journal::embedded(folder);
        println!(
            "{} journal: {} migrations, latest {}",
            folder.name(),
            journal.migrations().len(),
            journal.latest_tag().unwrap_or("none")
        );
    }
    println!();
    if options.dry_run {
        println!("Mode: DRY RUN (no migrations will be executed)\n");
    } else if options.check_journal {
        println!("Mode: CHECK JOURNAL (connects to every database, changes nothing)\n");
    } else {
        let skipped = if options.apply_skipped {
            ", skipped ones too"
        } else {
            ""
        };
        println!("Mode: LIVE (migrations will be applied{skipped})\n");
    }
    if options.redact {
        println!("Output: REDACTED (workspace details hidden, use --show-workspaces to reveal)\n");
    }

    if options.master && !migrate_master(options, master_url, &report).await {
        return false;
    }
    if options.tenants {
        return migrate_all_tenants(options, master_url, keyring, &report).await;
    }
    true
}

async fn connect(url: &str) -> Result<PgConnection, String> {
    match tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect(url)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!(
            "no connection within {}s",
            CONNECT_TIMEOUT.as_secs()
        )),
    }
}

async fn migrate_master(options: &Options, master_url: &str, report: &Report) -> bool {
    let journal = Journal::embedded(Folder::Master);
    println!("Master database");
    if options.dry_run {
        let pending = match connect(master_url).await {
            Ok(mut conn) => {
                let pending = pending(&mut conn, journal).await.map_err(|e| e.to_string());
                let _ = conn.close().await;
                pending
            }
            Err(error) => Err(error),
        };
        return match pending {
            Ok(pending) if pending.is_empty() => {
                println!("  Up to date\n");
                true
            }
            Ok(pending) => {
                println!(
                    "  {} migration(s) to apply, from {}\n",
                    pending.len(),
                    pending[0]
                );
                true
            }
            Err(error) => {
                println!("  Status: FAILED\n  Error:  {}\n", report.clean(&error));
                false
            }
        };
    }
    let database_options = DatabaseOptions {
        apply_skipped: false,
        check_only: options.check_journal,
    };
    match migrate_database(master_url, journal, database_options).await {
        Ok(outcome) => {
            println!("  Status: SUCCESS ({} applied)", outcome.applied.len());
            if let Some(gap) = &outcome.journal_gap {
                println!("  Journal: {gap}");
            }
            println!();
            true
        }
        Err(error) => {
            println!(
                "  Status: FAILED\n  Error:  {}\n\nThe tenant databases were not touched.\n",
                report.clean(&error.to_string())
            );
            false
        }
    }
}

/// The tenants to migrate, from the master database.
async fn fetch_tenants(
    options: &Options,
    master_url: &str,
    keyring: &Keyring,
) -> Result<TenantList, String> {
    let mut conn = connect(master_url).await?;
    let list = list_tenants(&mut conn, keyring, options.only.as_deref()).await;
    let _ = conn.close().await;
    list.map_err(|error| error.to_string())
}

/// Why nothing runs (`printNoWorkspacesFound`, or every workspace moving).
fn print_nothing_to_migrate(list: &TenantList, options: &Options, report: &Report) {
    if !list.moving.is_empty() {
        println!(
            "Nothing to migrate now. Skipped: {} (database move in progress).",
            list.moving.len()
        );
    } else if options.only.is_none() {
        println!("No active workspaces with database URLs found.");
    } else if report.redact {
        println!("No active workspace found with the requested ID.");
    } else {
        println!(
            "No active workspace found with ID: {}",
            options.only.as_deref().unwrap_or_default()
        );
    }
}

/// One workspace's lines, as it completes.
fn print_result(position: usize, total: usize, verb: &str, result: &TenantResult, report: &Report) {
    println!(
        "[{position}/{total}] {verb}: {}",
        report.label(position, &result.workspace)
    );
    match &result.outcome {
        Ok(outcome) => {
            println!("  Status: SUCCESS ({} applied)", outcome.applied.len());
            if !outcome.applied_skipped.is_empty() {
                println!("  Applied skipped: {}", outcome.applied_skipped.join(", "));
            }
            if let Some(gap) = &outcome.journal_gap {
                println!("  Journal: {gap}");
            }
        }
        Err(error) => {
            println!("  Status: FAILED\n  Error:  {}", report.clean(error));
        }
    }
    println!();
}

async fn migrate_all_tenants(
    options: &Options,
    master_url: &str,
    keyring: &Keyring,
    report: &Report,
) -> bool {
    println!("Fetching workspaces...\n");
    let list = match fetch_tenants(options, master_url, keyring).await {
        Ok(list) => list,
        Err(error) => {
            println!("Fatal error: {}", report.clean(&error));
            return false;
        }
    };

    print_skipped(
        &list.moving,
        "a database move is in progress (not a failure)",
        report,
    );
    print_skipped(
        &list.without_url,
        "no stored database URL yet; provisioning migrates it (not a failure)",
        report,
    );

    let total = list.databases.len() + list.unresolvable.len();
    if total == 0 {
        print_nothing_to_migrate(&list, options, report);
        return true;
    }

    println!("Found {total} workspace(s) to migrate:\n");
    println!("-------------------------------------------");
    print_workspaces(&list.databases, report);
    println!("-------------------------------------------\n");
    if options.dry_run {
        println!("Dry run complete. No migrations were executed.");
        return true;
    }

    let (verb, starting) = if options.check_journal {
        ("Checking", "Checking journals...")
    } else {
        ("Migrating", "Starting migrations...")
    };
    println!("{starting}\n");

    let offset = list.databases.len();
    let print = |position: usize, result: &TenantResult| {
        print_result(position, total, verb, result, report);
    };

    let database_options = DatabaseOptions {
        apply_skipped: options.apply_skipped,
        check_only: options.check_journal,
    };
    let mut results = migrate_tenants(
        list.databases,
        Journal::embedded(Folder::Tenant),
        database_options,
        options.concurrency,
        |index, result| print(index + 1, result),
    )
    .await;
    for (index, (workspace, error)) in list.unresolvable.into_iter().enumerate() {
        let result = TenantResult {
            workspace,
            outcome: Err(error),
        };
        print(offset + index + 1, &result);
        results.push(result);
    }

    print_summary(
        &results,
        list.moving.len(),
        list.without_url.len(),
        options,
        report,
    )
}

fn print_skipped(workspaces: &[WorkspaceRef], why: &str, report: &Report) {
    if workspaces.is_empty() {
        return;
    }
    println!("Skipping {} workspace(s): {why}:", workspaces.len());
    for (index, workspace) in workspaces.iter().enumerate() {
        if report.redact {
            println!("  skipped workspace #{}", index + 1);
        } else {
            println!("  {} ({})", workspace.name, workspace.id);
        }
    }
    println!();
}

fn print_workspaces(databases: &[TenantDatabase], report: &Report) {
    for (index, database) in databases.iter().enumerate() {
        if report.redact {
            println!("  {}", report.label(index + 1, &database.workspace));
        } else {
            println!("  ID:   {}", database.workspace.id);
            println!("  Name: {}", database.workspace.name);
            println!("  DB:   {}", database.masked_url());
        }
        println!();
    }
}

/// The summary; false when any workspace failed (`printSummary`).
fn print_summary(
    results: &[TenantResult],
    moving: usize,
    without_url: usize,
    options: &Options,
    report: &Report,
) -> bool {
    let failed: Vec<(usize, &TenantResult)> = results
        .iter()
        .enumerate()
        .filter(|(_, result)| result.outcome.is_err())
        .collect();
    let gaps: Vec<(usize, &TenantResult, &str)> = results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| {
            let gap = result.outcome.as_ref().ok()?.journal_gap.as_deref()?;
            Some((index, result, gap))
        })
        .collect();

    println!("\n{RULE}\n  Migration Summary\n{RULE}");
    println!("  Total:      {}", results.len());
    println!("  Successful: {}", results.len() - failed.len());
    println!("  Failed:     {}", failed.len());
    println!("  Skipped:    {moving} (database move in progress)");
    println!("  No URL yet: {without_url} (being provisioned)");
    println!("  Journal gaps: {}", gaps.len());

    if !gaps.is_empty() {
        println!("\nWorkspaces missing journal migrations ({}):", gaps.len());
        for (index, result, gap) in &gaps {
            println!("  - {}: {gap}", report.label(index + 1, &result.workspace));
        }
        if !options.apply_skipped {
            println!("  Run with --apply-skipped to apply the missing migrations.");
        }
    }

    if !failed.is_empty() {
        println!("\nFailed workspaces:");
        for (index, result) in &failed {
            println!("  - {}", report.label(index + 1, &result.workspace));
            if let Err(error) = &result.outcome {
                println!("    Error: {}", report.clean(error));
            }
        }
        if report.redact {
            println!("\n  Re-run with --show-workspaces to identify them.");
        }
        println!();
        return false;
    }

    println!("\nAll migrations completed successfully!\n");
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn options(list: &[&str], ci: bool) -> Options {
        match parse(&args(list), ci) {
            Ok(Parsed::Run(options)) => options,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn neither_target_means_both() {
        let both = options(&[], false);
        assert!(both.master && both.tenants);
        assert_eq!(both.concurrency, 1);
        let master = options(&["--master"], false);
        assert!(master.master && !master.tenants);
        let tenants = options(&["--tenants", "--dry-run"], false);
        assert!(!tenants.master && tenants.tenants && tenants.dry_run);
    }

    #[test]
    fn reads_the_typescript_runners_flags() {
        let parsed = options(
            &[
                "--only",
                "ws_1",
                "--check-journal",
                "--apply-skipped",
                "--verbose",
                "--concurrency",
                "4",
            ],
            false,
        );
        assert_eq!(parsed.only.as_deref(), Some("ws_1"));
        assert!(parsed.check_journal && parsed.apply_skipped && parsed.verbose);
        assert_eq!(parsed.concurrency, 4);
        assert_eq!(
            options(&["--workspace", "ws_2"], false).only.as_deref(),
            Some("ws_2")
        );
    }

    #[test]
    fn redacts_in_ci_unless_told_otherwise() {
        assert!(options(&[], true).redact);
        assert!(!options(&[], false).redact);
        assert!(options(&["--redact"], false).redact);
        assert!(!options(&["--show-workspaces"], true).redact);
    }

    #[test]
    fn refuses_bad_arguments() {
        assert!(parse(&args(&["--only"]), false).is_err());
        assert!(parse(&args(&["--only", "--master"]), false).is_err());
        assert!(parse(&args(&["--concurrency", "0"]), false).is_err());
        assert!(parse(&args(&["--concurrency", "x"]), false).is_err());
        assert!(parse(&args(&["--frobnicate"]), false).is_err());
        assert_eq!(parse(&args(&["--help"]), false), Ok(Parsed::Help));
    }
}
