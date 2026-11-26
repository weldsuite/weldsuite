//! `weldsuite admin import-global <step>`: the move from Global (ADR
//! OPS-025, plan `retire-global-edition.md`, phase 4), one step at a time.
//! The work is in `weldsuite-global-import`; this file reads the arguments
//! and the environment, wires the install's provisioner, billing and audit
//! in, and prints.

use std::fmt::Write as _;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_adapters_oss::{CnpgOptions, CnpgProvisioner, S3FileStore, S3Options};
use weldsuite_core_billing::MovedAccount;
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces, orm};
use weldsuite_global_import::{
    CheckOptions, CheckReport, Global, GlobalWorkspace, ImportError, LevelProvisioner,
    MasterOptions, MasterReport, PlanMap, Selection, TenantOptions, TenantReport, check, files,
    master, move_tenant, plan_names, select, verify,
};
use weldsuite_migrations::Journal;
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner as _, DatabaseUrl, DynFileStore, ProvisionError,
    ProvisionRequest,
};
use weldsuite_staff_domain::audit::{AuditEntry, record_failure, record_success};
use weldsuite_staff_domain::staff;

use crate::config::Config;

pub(crate) const USAGE: &str = "\
usage: weldsuite admin import-global <step> [options]

The move from Global (ADR OPS-025): Global's workspaces, members, tenant
databases and files into this install. Run in a server pod, which has the
install's settings, with Global's added (below). Each step can run again.

  check     what would move, and what stops it; writes nothing
            [--workspace <ref>]… [--plan <global>=<install>]… [--skip-tenants]
  master    the master rows: workspaces (plan mapped, placement cleared),
            members, credits, API keys, registries; one transaction; then a
            billing account for each paid workspace (no payment method yet)
            [--workspace <ref>]… [--plan …]… [--replace] [--dry-run]
  tenants   each workspace's database: made on a shard at Global's migration
            level, every row copied, migrated, made ready
            [--workspace <ref>]… [--replace] [--keep-going]
  files     a bucket's objects, keys unchanged, from R2 to this install
            --from <Global bucket> --to <install bucket> [--prefix <p>] [--dry-run]
  verify    counts every moved row again on both sides
            [--workspace <ref>]…

master and tenants need --as <email> (or WELDSUITE_ACTOR), a member of
this install's staff, and --reason; each workspace is recorded in
admin_audit_events. --workspace (id, slug or organization id) limits a step
to those workspaces; without it every live Global workspace with a database
moves. --replace writes over what an earlier run moved (before the install
opens only: it overwrites what happened here since). --plan maps a Global
plan to this install's by slug (same slug by default).

environment, besides the install's own (DATABASE_URL_MASTER,
DATABASE_ENCRYPTION_KEY[_V2], TENANT_SHARDS, TENANT_REGION, S3_*):
  GLOBAL_DATABASE_URL_MASTER          Global's master, read-only credentials
  GLOBAL_DATABASE_ENCRYPTION_KEY[_V2] Global's keys (default: the install's)
  GLOBAL_NEON_API_KEY                 for a Global row with no database_url
  GLOBAL_S3_ENDPOINT, GLOBAL_S3_ACCESS_KEY_ID, GLOBAL_S3_SECRET_ACCESS_KEY
                                      R2, for files (GLOBAL_S3_REGION: auto)

options: --json prints JSON; -h, --help prints this.

Exit status: 0 done, 1 refused or failed (or check found problems, or
verify found differences), 2 bad arguments, 78 missing settings.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Check,
    Master,
    Tenants,
    Files,
    Verify,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one field per command-line switch"
)]
struct Options {
    workspaces: Vec<String>,
    plans: Vec<(String, String)>,
    replace: bool,
    dry_run: bool,
    skip_tenants: bool,
    keep_going: bool,
    json: bool,
    actor: Option<String>,
    reason: Option<String>,
    from: Option<String>,
    to: Option<String>,
    prefix: String,
}

#[derive(Debug)]
enum Parsed {
    Run(Step, Options),
    Help,
}

fn parse(args: &[String], actor_env: Option<String>) -> Result<Parsed, String> {
    let mut args = args.iter();
    let step = match args.next().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => return Ok(Parsed::Help),
        Some("check") => Step::Check,
        Some("master") => Step::Master,
        Some("tenants") => Step::Tenants,
        Some("files") => Step::Files,
        Some("verify") => Step::Verify,
        Some(other) => return Err(format!("unknown step {other:?}")),
    };
    let mut options = Options {
        actor: actor_env,
        ..Options::default()
    };
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        let mut value = || -> Result<String, String> {
            inline
                .clone()
                .or_else(|| args.next().cloned())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match name {
            "-h" | "--help" => return Ok(Parsed::Help),
            "--workspace" => options.workspaces.push(value()?),
            "--plan" => {
                let pair = value()?;
                let Some((from, to)) = pair.split_once('=') else {
                    return Err(format!(
                        "--plan {pair}: write it as <global slug>=<install slug>"
                    ));
                };
                options
                    .plans
                    .push((from.trim().to_owned(), to.trim().to_owned()));
            }
            "--as" => options.actor = Some(value()?),
            "--reason" => options.reason = Some(value()?),
            "--from" => options.from = Some(value()?),
            "--to" => options.to = Some(value()?),
            "--prefix" => options.prefix = value()?,
            "--replace" => options.replace = true,
            "--dry-run" => options.dry_run = true,
            "--skip-tenants" => options.skip_tenants = true,
            "--keep-going" => options.keep_going = true,
            "--json" => options.json = true,
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    // Only master and files can roll back or just list; anywhere else a
    // "dry run" would quietly be a real one.
    if options.dry_run && !matches!(step, Step::Master | Step::Files) {
        return Err("--dry-run applies to master and files only".to_owned());
    }
    let writes = matches!(step, Step::Master | Step::Tenants) && !options.dry_run;
    if writes {
        if options.actor.is_none() {
            return Err(
                "this step needs the person acting: --as <email> (or WELDSUITE_ACTOR)".to_owned(),
            );
        }
        if options
            .reason
            .as_deref()
            .is_none_or(|reason| reason.trim().len() < 3)
        {
            return Err("this step needs --reason <text> (at least 3 characters)".to_owned());
        }
    }
    if step == Step::Files && (options.from.is_none() || options.to.is_none()) {
        return Err("files needs --from <Global bucket> and --to <install bucket>".to_owned());
    }
    Ok(Parsed::Run(step, options))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    let (step, options) = match parse(args, env("WELDSUITE_ACTOR")) {
        Ok(Parsed::Run(step, options)) => (step, options),
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(problem) => {
            eprintln!("{problem}\n\nweldsuite admin import-global --help shows the steps.");
            return ExitCode::from(2);
        }
    };
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78);
        }
    };
    // Every step but `files` reads Global's master.
    let global_url = env("GLOBAL_DATABASE_URL_MASTER").unwrap_or_default();
    if global_url.is_empty() && step != Step::Files {
        eprintln!("GLOBAL_DATABASE_URL_MASTER is required: Global's master, read-only credentials");
        return ExitCode::from(78);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(execute(step, &options, &config, &global_url)) {
        Ok(Outcome { text, ok }) => {
            print!("{text}");
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

/// What a step prints, and whether it went through.
struct Outcome {
    text: String,
    ok: bool,
}

/// The two sides, connected.
struct Sides {
    global: Global,
    install: PgPool,
    keyring: Keyring,
}

impl Sides {
    fn connect(config: &Config, global_url: &str) -> Result<Self, ImportError> {
        let install = weldsuite_db::master_pool(&config.master_database_url, 4)
            .map_err(|error| ImportError::Failed(format!("DATABASE_URL_MASTER: {error}")))?;
        let global_keyring = Keyring {
            v1: env("GLOBAL_DATABASE_ENCRYPTION_KEY").or_else(|| config.keyring.v1.clone()),
            v2: env("GLOBAL_DATABASE_ENCRYPTION_KEY_V2").or_else(|| config.keyring.v2.clone()),
        };
        let global = Global::new(
            weldsuite_global_import::global::master_pool(global_url)?,
            global_keyring,
            env("GLOBAL_NEON_API_KEY"),
        );
        Ok(Self {
            global,
            install,
            keyring: config.keyring.clone(),
        })
    }

    async fn selection(&self, options: &Options) -> Result<Selection, ImportError> {
        select(self.global.workspaces().await?, &options.workspaces)
    }

    async fn plans(&self, options: &Options) -> Result<PlanMap, ImportError> {
        PlanMap::build(
            &plan_names(self.global.master()).await?,
            &plan_names(&self.install).await?,
            &options.plans,
        )
    }
}

async fn execute(
    step: Step,
    options: &Options,
    config: &Config,
    global_url: &str,
) -> Result<Outcome, ImportError> {
    let sides = || Sides::connect(config, global_url);
    match step {
        Step::Files => copy_files(options, config).await,
        Step::Check => run_check(&sides()?, options).await,
        Step::Master => run_master(&sides()?, options).await,
        Step::Tenants => run_tenants(&sides()?, options, config).await,
        Step::Verify => run_verify(&sides()?, options).await,
    }
}

async fn run_check(sides: &Sides, options: &Options) -> Result<Outcome, ImportError> {
    let selection = sides.selection(options).await?;
    let plans = sides.plans(options).await?;
    let report = check(
        &sides.global,
        &sides.install,
        &selection,
        CheckOptions {
            plans: &plans,
            install_keyring: &sides.keyring,
            probe_tenants: !options.skip_tenants,
        },
    )
    .await?;
    let ok = report.ok();
    let text = if options.json {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        )
    } else {
        check_text(&report)
    };
    Ok(Outcome { text, ok })
}

fn check_text(report: &CheckReport) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} workspace(s) move, {} stay on Global.",
        report.moving.len(),
        report.staying.len()
    );
    for ws in &report.moving {
        let mut facts = Vec::new();
        if let Some(plan) = &ws.plan {
            facts.push(format!("plan {plan}"));
        }
        if let Some(level) = &ws.level {
            facts.push(format!("at {level}"));
        }
        if ws.gaps > 0 {
            facts.push(format!("{} skipped migration(s)", ws.gaps));
        }
        if let Some(bytes) = ws.bytes {
            facts.push(format!("{} MB", bytes / 1_000_000));
        }
        if let Some(row) = &ws.on_install {
            facts.push(format!("already here ({})", row.status));
        }
        let _ = writeln!(out, "  {} {}  {}", ws.id, ws.slug, facts.join(", "));
        for problem in &ws.problems {
            let _ = writeln!(out, "      PROBLEM: {problem}");
        }
        for warning in &ws.warnings {
            let _ = writeln!(out, "      note: {warning}");
        }
    }
    for ws in &report.staying {
        let _ = writeln!(out, "  stays: {} {} ({})", ws.id, ws.slug, ws.reason);
    }
    if !report.skipped_tables.is_empty() {
        let _ = writeln!(out, "Master tables that don't move:");
        for (table, reason) in &report.skipped_tables {
            let _ = writeln!(out, "  {table}: {reason}");
        }
    }
    for warning in &report.warnings {
        let _ = writeln!(out, "note: {warning}");
    }
    for problem in &report.problems {
        let _ = writeln!(out, "PROBLEM: {problem}");
    }
    let _ = writeln!(
        out,
        "{}",
        if report.ok() {
            "Nothing stops the move."
        } else {
            "The move can't start until the problems above are solved."
        }
    );
    out
}

/// The staff member acting, checked against this install's roster.
async fn actor(sides: &Sides, options: &Options) -> Result<String, ImportError> {
    let email = options.actor.as_deref().unwrap_or_default();
    staff::actor(&sides.install, email)
        .await
        .map(|actor| actor.email)
        .map_err(|error| ImportError::Refused(error.to_string()))
}

async fn run_master(sides: &Sides, options: &Options) -> Result<Outcome, ImportError> {
    let actor = if options.dry_run {
        options.actor.clone().unwrap_or_default()
    } else {
        actor(sides, options).await?
    };
    let selection = sides.selection(options).await?;
    let plans = sides.plans(options).await?;
    let report = check(
        &sides.global,
        &sides.install,
        &selection,
        CheckOptions {
            plans: &plans,
            install_keyring: &sides.keyring,
            probe_tenants: false,
        },
    )
    .await?;
    if !report.ok() {
        return Ok(Outcome {
            text: format!(
                "{}\nNothing was copied: `import-global check` lists what to solve first.\n",
                check_text(&report)
            ),
            ok: false,
        });
    }
    let already = master::already_on_install(&sides.install, &selection.moving).await?;
    let moving: Vec<GlobalWorkspace> = selection
        .moving
        .iter()
        .filter(|ws| options.replace || !already.contains(&ws.id))
        .cloned()
        .collect();
    let left_alone: Vec<&String> = already
        .iter()
        .filter(|id| !moving.iter().any(|ws| &ws.id == *id))
        .collect();
    let copied = master::copy(
        &sides.global,
        &sides.install,
        &moving,
        &MasterOptions {
            plans: &plans,
            replace: options.replace,
            dry_run: options.dry_run,
        },
    )
    .await?;

    // Every selected workspace now on the install, the ones an earlier run
    // copied too: if that run stopped before their billing account, this
    // one opens it (`open_account` can run again).
    let billing = if options.dry_run {
        Vec::new()
    } else {
        after_copy(sides, options, &actor, &selection.moving, &moving).await?
    };

    let text = if options.json {
        master_json(&copied, &billing, &left_alone)
    } else {
        master_text(&copied, &billing, &left_alone)
    };
    Ok(Outcome { text, ok: true })
}

/// Once the master rows are in: the billing account (no payment method yet)
/// of every workspace in `billed`, and an audit row for each one `copied`
/// in this run.
async fn after_copy(
    sides: &Sides,
    options: &Options,
    actor: &str,
    billed: &[GlobalWorkspace],
    copied: &[GlobalWorkspace],
) -> Result<Vec<(String, MovedAccount)>, ImportError> {
    let now = OffsetDateTime::now_utc();
    let mut billing = Vec::new();
    for ws in billed {
        let opened = weldsuite_core_billing::moved::open_account(&sides.install, &ws.id, now)
            .await
            .map_err(|error| {
                ImportError::Failed(format!("{}: opening its billing account: {error}", ws.id))
            })?;
        billing.push((ws.id.clone(), opened));
    }
    for ws in copied {
        let entry = AuditEntry {
            workspace_id: Some(&ws.id),
            target_type: "workspace",
            target_id: &ws.id,
            action: "workspace.import_global.master",
            actor_email: actor,
            reason: options.reason.as_deref(),
            details: Some(json!({ "slug": ws.slug, "replace": options.replace })),
        };
        record_success(&orm(&sides.install), &entry)
            .await
            .map_err(|error| ImportError::Failed(format!("recording the audit row: {error}")))?;
    }
    Ok(billing)
}

fn master_json(
    copied: &MasterReport,
    billing: &[(String, MovedAccount)],
    left_alone: &[&String],
) -> String {
    let billing: Vec<_> = billing
        .iter()
        .map(|(id, opened)| json!({ "workspaceId": id, "billing": format!("{opened:?}") }))
        .collect();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "copy": copied,
            "billing": billing,
            "leftAlone": left_alone,
        }))
        .unwrap_or_default()
    )
}

fn master_text(
    copied: &MasterReport,
    billing: &[(String, MovedAccount)],
    left_alone: &[&String],
) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} {} workspace(s) and {} user(s).",
        if copied.dry_run {
            "Would copy"
        } else {
            "Copied"
        },
        copied.workspaces.len(),
        copied.users
    );
    for table in &copied.tables {
        if let Some(reason) = &table.skipped {
            let _ = writeln!(out, "  {}: not moved ({reason})", table.table);
        } else if table.read > 0 || table.replaced > 0 {
            let replaced = if table.replaced > 0 {
                format!(", {} from an earlier run replaced", table.replaced)
            } else {
                String::new()
            };
            let dropped = if table.dropped_columns.is_empty() {
                String::new()
            } else {
                format!(", columns not here: {}", table.dropped_columns.join(", "))
            };
            let _ = writeln!(
                out,
                "  {}: {} read, {} written{replaced}{dropped}",
                table.table, table.read, table.written
            );
        }
    }
    for (id, opened) in billing {
        if let MovedAccount::Opened {
            unit_amount,
            next_charge_at,
        } = opened
        {
            let _ = writeln!(
                out,
                "  billing {id}: renews {next_charge_at} at {unit_amount} cents a seat, payment method to add"
            );
        }
    }
    if !left_alone.is_empty() {
        let names: Vec<&str> = left_alone.iter().map(|id| id.as_str()).collect();
        let _ = writeln!(
            out,
            "Already here from an earlier run, left alone (--replace copies them again): {}",
            names.join(", ")
        );
    }
    if copied.dry_run {
        let _ = writeln!(out, "Dry run: rolled back, nothing written.");
    }
    out
}

/// [`LevelProvisioner`] on the install's CloudNativePG shards
/// (`TENANT_SHARDS`): the server's provisioner, migrating with the journal
/// of Global's level instead of the latest.
struct CnpgLevels {
    master: PgPool,
    options: CnpgOptions,
}

impl CnpgLevels {
    fn provisioner(
        &self,
        journal: Option<&'static Journal>,
    ) -> Result<CnpgProvisioner, ProvisionError> {
        let provisioner = CnpgProvisioner::new(self.master.clone(), self.options.clone())?;
        Ok(match journal {
            Some(journal) => provisioner.with_journal(journal),
            None => provisioner,
        })
    }
}

impl LevelProvisioner for CnpgLevels {
    fn provision_at<'a>(
        &'a self,
        workspace_id: &'a str,
        journal: &'static Journal,
    ) -> BoxFuture<'a, Result<DatabaseUrl, ProvisionError>> {
        Box::pin(async move {
            Ok(self
                .provisioner(Some(journal))?
                .provision(&ProvisionRequest::new(workspace_id))
                .await?
                .database_url)
        })
    }

    fn teardown<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<(), ProvisionError>> {
        Box::pin(async move {
            self.provisioner(None)?
                .teardown(workspace_id)
                .await
                .map(drop)
        })
    }
}

impl CnpgLevels {
    /// The shards and keys the server provisions with (`infra::provisioner`).
    fn from_config(sides: &Sides, config: &Config) -> Result<Self, ImportError> {
        let Some(shards) = &config.infra.tenant_shards else {
            return Err(ImportError::Refused(
                "TENANT_SHARDS is not set: this install has nowhere to put the databases"
                    .to_owned(),
            ));
        };
        let mut options = CnpgOptions::new(shards.clone(), config.keyring.clone());
        if let Some(region) = &config.infra.tenant_region {
            options.region.clone_from(region);
        }
        options.aad_writes = config.infra.aad_writes;
        Ok(Self {
            master: sides.install.clone(),
            options,
        })
    }
}

/// One workspace's line (and notes) after `tenants`.
fn tenant_text(ws: &GlobalWorkspace, report: &TenantReport) -> String {
    if !report.copied {
        return format!(
            "{} {}: moved by an earlier run (--replace copies it again)\n",
            ws.id, ws.slug
        );
    }
    let outside_eu = if report.outside_eu.is_empty() {
        String::new()
    } else {
        format!(", outside the EU on: {}", report.outside_eu.join(", "))
    };
    let mut out = format!(
        "{} {}: {} rows in {} tables at {}, {} migration(s) after, {} view(s) refreshed{outside_eu} ({:.0}s)\n",
        ws.id,
        ws.slug,
        report.rows,
        report.tables.len(),
        report.level.as_deref().unwrap_or("?"),
        report.migrations_after.len(),
        report.materialized_views,
        report.seconds
    );
    for warning in &report.warnings {
        let _ = writeln!(out, "    note: {warning}");
    }
    out
}

async fn run_tenants(
    sides: &Sides,
    options: &Options,
    config: &Config,
) -> Result<Outcome, ImportError> {
    let actor = actor(sides, options).await?;
    let provisioner = CnpgLevels::from_config(sides, config)?;
    let selection = sides.selection(options).await?;
    let mut out = String::new();
    let mut reports = Vec::new();
    let mut failures = Vec::new();
    for ws in &selection.moving {
        let result = move_tenant(
            &sides.global,
            &sides.install,
            &provisioner,
            ws,
            TenantOptions {
                replace: options.replace,
                actor: &actor,
            },
        )
        .await;
        let entry = AuditEntry {
            workspace_id: Some(&ws.id),
            target_type: "workspace",
            target_id: &ws.id,
            action: "workspace.import_global.tenant",
            actor_email: &actor,
            reason: options.reason.as_deref(),
            details: None,
        };
        match result {
            Ok(report) => {
                if report.copied {
                    let details = json!({
                        "level": report.level,
                        "rows": report.rows,
                        "migrationsAfter": report.migrations_after.len(),
                        "outsideEu": report.outside_eu,
                    });
                    let _ = record_success(
                        &orm(&sides.install),
                        &AuditEntry {
                            details: Some(details),
                            ..entry
                        },
                    )
                    .await;
                }
                out.push_str(&tenant_text(ws, &report));
                reports.push(report);
            }
            Err(error) => {
                record_failure(&sides.install, &entry, &error.to_string()).await;
                let _ = writeln!(out, "{} {}: FAILED: {error}", ws.id, ws.slug);
                failures.push((ws.id.clone(), error.to_string()));
                if !options.keep_going {
                    let _ = writeln!(
                        out,
                        "Stopped (--keep-going goes on with the next workspace)."
                    );
                    break;
                }
            }
        }
    }
    for staying in &selection.staying {
        let _ = writeln!(
            out,
            "stays: {} {} ({})",
            staying.id, staying.slug, staying.reason
        );
    }
    let ok = failures.is_empty();
    let text = if options.json {
        let failures: Vec<_> = failures
            .iter()
            .map(|(id, error)| json!({ "workspaceId": id, "error": error }))
            .collect();
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "moved": reports, "failed": failures }))
                .unwrap_or_default()
        )
    } else {
        out
    };
    Ok(Outcome { text, ok })
}

async fn run_verify(sides: &Sides, options: &Options) -> Result<Outcome, ImportError> {
    let selection = sides.selection(options).await?;
    let tenants = Workspaces::new(
        sides.install.clone(),
        sides.keyring.clone(),
        WorkspaceConfig::default(),
    );
    let mut out = String::new();
    let mut all = Vec::new();
    let mut ok = true;
    for ws in &selection.moving {
        let result = verify(&sides.global, &sides.install, &tenants, ws).await?;
        ok &= result.ok();
        let _ = writeln!(
            out,
            "{} {}: {} master and {} tenant table(s) compared{}",
            ws.id,
            ws.slug,
            result.master_tables,
            result
                .tenant_tables
                .map_or_else(|| "no".to_owned(), |count| count.to_string()),
            if result.ok() { ", all equal" } else { "" }
        );
        if result.tenant_tables.is_none() {
            let _ = writeln!(out, "    its database is not on this install yet");
        }
        for difference in result.master.iter().chain(&result.tenant) {
            let _ = writeln!(
                out,
                "    {}: {} on Global, {} here",
                difference.table, difference.global, difference.install
            );
        }
        for table in &result.only_on_one_side {
            let _ = writeln!(out, "    {table}");
        }
        all.push(result);
    }
    let text = if options.json {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&all).unwrap_or_default()
        )
    } else {
        out
    };
    Ok(Outcome { text, ok })
}

async fn copy_files(options: &Options, config: &Config) -> Result<Outcome, ImportError> {
    let Some(files_config) = &config.infra.files else {
        return Err(ImportError::Refused(
            "S3_ENDPOINT is not set: this install has no object storage".to_owned(),
        ));
    };
    let required = |name: &str| {
        env(name).ok_or_else(|| ImportError::Refused(format!("{name} is required for files")))
    };
    let source_options = S3Options {
        endpoint: required("GLOBAL_S3_ENDPOINT")?,
        region: env("GLOBAL_S3_REGION").unwrap_or_else(|| "auto".to_owned()),
        bucket: options.from.clone().unwrap_or_default(),
        access_key_id: required("GLOBAL_S3_ACCESS_KEY_ID")?,
        secret_access_key: required("GLOBAL_S3_SECRET_ACCESS_KEY")?,
        path_style: true,
    };
    let target_options = S3Options {
        bucket: options.to.clone().unwrap_or_default(),
        ..files_config.private.clone()
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|error| ImportError::Failed(format!("an HTTP client: {error}")))?;
    let store = |options: &S3Options| -> Result<Arc<dyn DynFileStore>, ImportError> {
        S3FileStore::new(options, client.clone())
            .map(|store| Arc::new(store) as Arc<dyn DynFileStore>)
            .map_err(|error| ImportError::Failed(format!("bucket {}: {error}", options.bucket)))
    };
    let source = store(&source_options)?;
    let target = store(&target_options)?;
    let report = files::copy_bucket(
        source.as_ref(),
        target.as_ref(),
        &options.prefix,
        options.dry_run,
    )
    .await?;
    let ok = report.failed_count == 0;
    let text = if options.json {
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        )
    } else {
        let mut out = format!(
            "{} → {}{}: {} object(s), {} MB; {} already there; {} {} ({} MB); {} failed\n",
            source_options.bucket,
            target_options.bucket,
            if options.prefix.is_empty() {
                String::new()
            } else {
                format!(" ({})", options.prefix)
            },
            report.objects,
            report.bytes / 1_000_000,
            report.present,
            if report.dry_run { "to copy" } else { "copied" },
            report.copied,
            report.copied_bytes / 1_000_000,
            report.failed_count
        );
        for failure in &report.failed {
            let _ = writeln!(out, "  {failure}");
        }
        out
    };
    Ok(Outcome { text, ok })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    fn run_options(line: &str) -> (Step, Options) {
        match parse(&args(line), None).expect("parses") {
            Parsed::Run(step, options) => (step, options),
            Parsed::Help => panic!("help"),
        }
    }

    #[test]
    fn reads_the_steps_and_their_options() {
        let (step, options) = run_options(
            "check --workspace acme --workspace ws_2 --plan scale=business --skip-tenants",
        );
        assert_eq!(step, Step::Check);
        assert_eq!(options.workspaces, ["acme", "ws_2"]);
        assert_eq!(options.plans, [("scale".to_owned(), "business".to_owned())]);
        assert!(options.skip_tenants);

        let (step, options) = run_options(
            "master --as gert@example.com --reason cutover --replace --plan=scale=business",
        );
        assert_eq!(step, Step::Master);
        assert!(options.replace);
        assert_eq!(options.plans, [("scale".to_owned(), "business".to_owned())]);

        let (step, options) =
            run_options("files --from weldsuite-private --to eu-private --dry-run");
        assert_eq!(step, Step::Files);
        assert_eq!(options.from.as_deref(), Some("weldsuite-private"));
        assert!(options.dry_run);
    }

    #[test]
    fn a_write_needs_the_person_and_the_reason() {
        assert!(parse(&args("master --reason cutover"), None).is_err());
        assert!(parse(&args("tenants --as a@b.c"), None).is_err());
        assert!(matches!(
            parse(&args("tenants --reason cutover"), Some("a@b.c".to_owned())),
            Ok(Parsed::Run(Step::Tenants, _))
        ));
        assert!(matches!(
            parse(&args("master --dry-run"), None),
            Ok(Parsed::Run(Step::Master, _))
        ));
    }

    #[test]
    fn refuses_what_it_doesnt_know() {
        assert!(parse(&args("everything"), None).is_err());
        assert!(parse(&args("check --fast"), None).is_err());
        assert!(parse(&args("files --from a"), None).is_err());
        assert!(parse(&args("check --plan scale"), None).is_err());
        assert!(matches!(parse(&args(""), None), Ok(Parsed::Help)));
    }

    #[test]
    fn a_dry_run_is_only_for_the_steps_that_can_do_one() {
        let actor = || Some("a@b.c".to_owned());
        for line in [
            "tenants --dry-run --reason cutover",
            "check --dry-run",
            "verify --dry-run",
        ] {
            let refused = parse(&args(line), actor()).expect_err(line);
            assert!(refused.contains("--dry-run"), "{line}: {refused}");
        }
        assert!(parse(&args("master --dry-run"), actor()).is_ok());
        assert!(parse(&args("files --from a --to b --dry-run"), actor()).is_ok());
    }
}
