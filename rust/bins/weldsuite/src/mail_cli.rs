//! `weldsuite mail`: operator commands for WeldMail's DMARC reports (ADR
//! MAIL-015), run in a server pod.
//!
//! - `dmarc [--days N]`: WeldSuite's own sending addresses as the receivers
//!   saw them (master `mail_dmarc_pool_daily`): per pool, address and
//!   reporter, the messages and how many passed DMARC, DKIM and SPF; then
//!   the From domains whose mail from those addresses failed DMARC, which is
//!   a customer's DNS (usually its DKIM record), not the address.
//! - `backfill-domain-registry [--dry-run]`: files every verified custom
//!   mail domain in master `mail_domain_registry`, once, for domains
//!   verified before the registry existed. It opens every active
//!   workspace's database: a one-off by hand, never on a timer.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::process::ExitCode;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use time::{Duration, OffsetDateTime};
use weldsuite_db::{Keyring, PgPool, WorkspaceConfig, Workspaces, orm};
use weldsuite_schema::master::{mail_dmarc_pool_daily, mail_domain_registry, workspaces};
use weldsuite_schema::tenant::enums::MailDomainDnsStatus;
use weldsuite_schema::tenant::mail_domains;

const USAGE: &str = "\
usage: weldsuite mail <command>

commands:
  dmarc [--days N]                    WeldSuite's sending addresses in DMARC
                                      reports over the last N days (14), and
                                      the From domains failing DMARC from them
  backfill-domain-registry [--dry-run]
                                      file every verified custom mail domain
                                      in mail_domain_registry (one-off; opens
                                      every workspace's database)

environment: DATABASE_URL_MASTER; for backfill-domain-registry also
DATABASE_ENCRYPTION_KEY and DATABASE_ENCRYPTION_KEY_V2.";

type Error = Box<dyn std::error::Error>;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    let command = args.first().map(String::as_str);
    if matches!(command, None | Some("help" | "--help" | "-h")) {
        println!("{USAGE}");
        return if command.is_none() {
            ExitCode::from(2)
        } else {
            ExitCode::SUCCESS
        };
    }
    let flag = |name: &str| args.iter().any(|a| a == name);
    let days = args
        .iter()
        .position(|a| a == "--days")
        .and_then(|at| args.get(at + 1))
        .and_then(|d| d.parse::<i64>().ok())
        .unwrap_or(14)
        .clamp(1, 400);
    let Some(master_url) = env("DATABASE_URL_MASTER").or_else(|| env("MASTER_DATABASE_URL")) else {
        eprintln!("DATABASE_URL_MASTER is required");
        return ExitCode::from(78); // EX_CONFIG
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        let master = weldsuite_db::master_pool(&master_url, 2)?;
        match command {
            Some("dmarc") => dmarc(&master, days).await,
            Some("backfill-domain-registry") => backfill(&master, flag("--dry-run")).await,
            _ => Err(format!("unknown command\n\n{USAGE}").into()),
        }
    });
    match result {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn percent(part: i64, whole: i64) -> String {
    if whole == 0 {
        return "-".to_owned();
    }
    #[allow(clippy::cast_precision_loss, reason = "a percentage for people")]
    let value = part as f64 * 100.0 / whole as f64;
    format!("{value:.1}%")
}

/// Sums of one group: messages, DMARC pass, DKIM aligned, SPF aligned.
type Sums = (i64, i64, i64, i64);

fn add(sums: &mut Sums, row: &mail_dmarc_pool_daily::Model) {
    sums.0 += i64::from(row.messages);
    sums.1 += i64::from(row.dmarc_pass);
    sums.2 += i64::from(row.dkim_aligned);
    sums.3 += i64::from(row.spf_aligned);
}

async fn dmarc(master: &PgPool, days: i64) -> Result<String, Error> {
    let since = (OffsetDateTime::now_utc() - Duration::days(days)).date();
    let rows = mail_dmarc_pool_daily::Entity::find()
        .filter(mail_dmarc_pool_daily::Column::Day.gte(since))
        .all(&orm(master))
        .await?;
    let mut out = String::new();
    if rows.is_empty() {
        writeln!(
            out,
            "No DMARC reports with WeldSuite's sending addresses in the last {days} days."
        )?;
        return Ok(out);
    }
    let mut by_address: BTreeMap<(String, String, String), Sums> = BTreeMap::new();
    let mut failing: BTreeMap<(String, String), Sums> = BTreeMap::new();
    for row in &rows {
        add(
            by_address
                .entry((
                    row.pool.clone(),
                    row.source_ip.clone(),
                    row.reporter.clone(),
                ))
                .or_default(),
            row,
        );
        if row.dmarc_pass < row.messages {
            add(
                failing
                    .entry((row.header_from_domain.clone(), row.pool.clone()))
                    .or_default(),
                row,
            );
        }
    }
    writeln!(
        out,
        "WeldSuite's sending addresses in DMARC reports, last {days} days"
    )?;
    writeln!(
        out,
        "{:<10} {:<16} {:<24} {:>9} {:>7} {:>7} {:>7}",
        "pool", "address", "reporter", "messages", "dmarc", "dkim", "spf"
    )?;
    for ((pool, ip, reporter), (messages, pass, dkim, spf)) in &by_address {
        writeln!(
            out,
            "{pool:<10} {ip:<16} {reporter:<24} {messages:>9} {:>7} {:>7} {:>7}",
            percent(*pass, *messages),
            percent(*dkim, *messages),
            percent(*spf, *messages)
        )?;
    }
    writeln!(out)?;
    if failing.is_empty() {
        writeln!(out, "Every From domain passed DMARC from these addresses.")?;
    } else {
        writeln!(
            out,
            "From domains failing DMARC from these addresses (check the domain's DKIM record):"
        )?;
        for ((domain, pool), (messages, pass, dkim, _)) in &failing {
            writeln!(
                out,
                "  {domain} ({pool}): {} of {messages} failed, DKIM aligned {}",
                messages - pass,
                percent(*dkim, *messages)
            )?;
        }
    }
    writeln!(
        out,
        "\nSPF never aligns for customer domains (the return path is the bounce domain); DMARC rests on DKIM."
    )?;
    Ok(out)
}

async fn backfill(master: &PgPool, dry_run: bool) -> Result<String, Error> {
    let keyring = Keyring {
        v1: env("DATABASE_ENCRYPTION_KEY"),
        v2: env("DATABASE_ENCRYPTION_KEY_V2"),
    };
    let tenants = Workspaces::new(master.clone(), keyring, WorkspaceConfig::default());
    let ids: Vec<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::DeletedAt.is_null())
        .filter(workspaces::Column::IsActive.eq(true))
        .into_tuple()
        .all(&orm(master))
        .await?;
    let mut out = String::new();
    let (mut found, mut skipped) = (0, 0);
    for workspace_id in ids {
        let db = match tenants.tenant(&workspace_id).await {
            Ok(tenant) => tenant.db,
            Err(error) => {
                writeln!(out, "{workspace_id}: skipped ({error})")?;
                skipped += 1;
                continue;
            }
        };
        let domains: Vec<(String, String)> = mail_domains::Entity::find()
            .select_only()
            .columns([mail_domains::Column::Id, mail_domains::Column::DomainName])
            .filter(mail_domains::Column::DeletedAt.is_null())
            .filter(mail_domains::Column::DnsStatus.eq(MailDomainDnsStatus::Verified))
            .into_tuple()
            .all(&orm(&db))
            .await?;
        for (id, domain) in domains {
            writeln!(out, "{workspace_id}: {domain}")?;
            found += 1;
            if dry_run {
                continue;
            }
            let now = OffsetDateTime::now_utc();
            mail_domain_registry::Entity::insert(mail_domain_registry::ActiveModel {
                id: Set(weldsuite_kit::generate_id("mdreg")),
                domain: Set(domain.to_lowercase()),
                workspace_id: Set(workspace_id.clone()),
                mail_domain_id: Set(id.clone()),
                verified_at: Set(now),
                created_at: Set(now),
                updated_at: Set(now),
            })
            .on_conflict(
                OnConflict::columns([
                    mail_domain_registry::Column::Domain,
                    mail_domain_registry::Column::WorkspaceId,
                ])
                .value(mail_domain_registry::Column::MailDomainId, Expr::value(id))
                .value(mail_domain_registry::Column::UpdatedAt, Expr::value(now))
                .to_owned(),
            )
            .exec_without_returning(&orm(master))
            .await?;
        }
    }
    writeln!(
        out,
        "{found} verified domain(s){}; {skipped} workspace(s) skipped.",
        if dry_run {
            " found (dry run)"
        } else {
            " filed"
        }
    )?;
    Ok(out)
}
