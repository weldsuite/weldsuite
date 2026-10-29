//! `weldsuite cron <job>`: one scheduled job, run once, then exit. The Helm
//! chart runs each as a Kubernetes `CronJob` (the workers' Cron Triggers):
//!
//! - `sign-lifecycle` (every 15 minutes): WeldSign's automatic reminders
//!   and expiry (`apps/workers/sign-api/src/cron/lifecycle-sweep.ts`).
//! - `mail-outbound-ledgers` (every 5 minutes): the outbound guard's ledger
//!   alarm (risk score, automatic actions, the platform budget, pruning),
//!   which the `OutboundLedger` Durable Objects ran on their own alarms.
//!
//! A job takes the same environment as `serve`. It prints what it did as one
//! JSON line and exits 0 even when a workspace failed (the due index retries
//! it), as the Cron Trigger does; it exits non-zero only when it can't start.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use weldsuite_db::Workspaces;
use weldsuite_ports::{BoxFuture, FileStores};
use weldsuite_sign::{TenantRef, TenantResolver};

use crate::config::Config;

/// Tenant databases through the app's `Workspaces` (id or Clerk org id).
pub(crate) struct WorkspaceTenants(pub(crate) Arc<Workspaces>);

impl TenantResolver for WorkspaceTenants {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<TenantRef, String>> {
        Box::pin(async move {
            let tenant = self
                .0
                .tenant(reference)
                .await
                .map_err(|error| error.to_string())?;
            Ok(TenantRef {
                db: tenant.db,
                workspace_id: tenant.workspace_id,
                clerk_org_id: tenant.clerk_org_id,
            })
        })
    }
}

const JOBS: &str = "jobs: sign-lifecycle, mail-outbound-ledgers";

/// `weldsuite cron <job>`.
pub(crate) fn main(job: Option<&str>) -> ExitCode {
    let Some(job @ ("sign-lifecycle" | "mail-outbound-ledgers")) = job else {
        eprintln!("usage: weldsuite cron <job>\n{JOBS}");
        return ExitCode::from(2);
    };
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78); // EX_CONFIG
        }
    };
    let telemetry = crate::telemetry::init(config.log_format);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "cannot start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    let run = async {
        if job == "mail-outbound-ledgers" {
            mail_outbound_ledgers(config).await
        } else {
            sign_lifecycle(config).await
        }
    };
    let code = match runtime.block_on(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, job, "cron job failed to start");
            ExitCode::FAILURE
        }
    };
    telemetry.shutdown();
    code
}

/// `weldsuite cron mail-outbound-ledgers`: every active ledger's alarm, on
/// the same Valkey ledgers (`VALKEY_URL`, `VALKEY_LEDGER_PREFIX`) and quota
/// (`MAIL_DAILY_QUOTA`) as `serve`.
async fn mail_outbound_ledgers(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    use weldsuite_mail_domain::outbound::{LedgerDeps, StoreLedger, clock};
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let Some(url) = read("VALKEY_URL") else {
        // In-process ledgers die with `serve`: nothing to sweep from here.
        println!(
            "{}",
            serde_json::json!({ "job": "mail-outbound-ledgers", "skipped": "VALKEY_URL is not set" })
        );
        return Ok(());
    };
    let store = weldsuite_adapters_oss::ValkeyLedgerStore::from_url(
        &url,
        read("VALKEY_LEDGER_PREFIX").unwrap_or_else(|| "weldsuite:outbound:".to_owned()),
    )?;
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra = crate::infra::connect(&config.infra, &master, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let ledger = StoreLedger::new(LedgerDeps {
        store: Arc::new(store),
        master: Some(master),
        flags: Some(Arc::clone(&infra.flags)),
        reviews: None,
        daily_quota: read("MAIL_DAILY_QUOTA")
            .and_then(|v| v.parse().ok())
            .filter(|q| *q > 0),
        clock: clock::system_clock(),
    });
    let ran = weldsuite_mail::cron::outbound_ledgers(&ledger).await?;
    println!(
        "{}",
        serde_json::json!({ "job": "mail-outbound-ledgers", "ledgers": ran })
    );
    Ok(())
}

async fn sign_lifecycle(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra = crate::infra::connect(&config.infra, &master, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let services = weldsuite_sign::Services {
        events: infra.events.clone(),
        files: infra.files.clone().map(|private| FileStores {
            private,
            public: infra.public_files.clone(),
        }),
        mail: infra.mail.clone(),
        cache: infra.cache.clone(),
        flags: Arc::clone(&infra.flags),
        portal_url: config.sign_portal_url.clone(),
        environment: Some(config.environment.clone()),
    };
    let tenants: Arc<dyn TenantResolver> = Arc::new(WorkspaceTenants(workspaces));
    let now = time::OffsetDateTime::now_utc();
    let result = weldsuite_sign::run_lifecycle_sweep(&master, &tenants, &services, now).await;
    println!(
        "{}",
        serde_json::json!({ "job": "sign-lifecycle", "result": result })
    );
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(30), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}
