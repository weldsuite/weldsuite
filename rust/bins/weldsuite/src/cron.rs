//! `weldsuite cron <job>`: one scheduled job, run once, then exit. The Helm
//! chart runs each as a Kubernetes `CronJob` (the workers' Cron Triggers):
//!
//! - `sign-lifecycle` (every 15 minutes): WeldSign's automatic reminders
//!   and expiry (`apps/workers/sign-api/src/cron/lifecycle-sweep.ts`).
//! - `mail-outbound-ledgers` (every 5 minutes): the outbound guard's ledger
//!   alarm (risk score, automatic actions, the platform budget, pruning),
//!   which the `OutboundLedger` Durable Objects ran on their own alarms.
//! - `calendar-replan` (daily, 04:00 UTC): WeldCalendar re-plans
//!   auto-scheduled task events whose start slipped into the past
//!   (`apps/workers/calendar-api/src/cron/calendar-replan.ts`).
//! - `workflow-schedules` (every minute): WeldConnect's scheduled workflow
//!   runs (`apps/workers/workflow-worker/src/cron/schedule-sweep.ts`), started
//!   on Restate (`RESTATE_INGRESS_URL`), where `serve` runs them.
//! - `books-sweep` (daily, 03:00 UTC): WeldBooks' overdue invoices, due
//!   recurring invoices, the day's ECB rates, the US tax reminders and the
//!   fixed assets' depreciation due, in every workspace that used books
//!   (`apps/workers/books-api/src/cron/books-sweep.ts`).
//! - `flow-file-purge` (daily, 03:30 UTC): WeldFlow's purge of files deleted
//!   more than 30 days ago (`apps/workers/flow-api/src/cron/purge-deleted-files.ts`).
//! - `flow-benefit-measure` (daily, 03:30 UTC): WeldFlow's monthly measuring of
//!   benefits from the metric catalogue, in the workspaces the due index lists
//!   (kind `benefit_measure`, `apps/workers/flow-api/src/cron/benefit-measure.ts`).
//! - `domain-auto-renew` (daily, 04:00 UTC): WeldHost's auto-renew sweep
//!   (`apps/workers/host-api/src/cron/domain-auto-renew.ts`). It charges
//!   through Stripe, which stays with Global, so here it does what the
//!   worker does without `STRIPE_SECRET_KEY`: nothing (feature `domain-purchase`).
//! - `desk-sla-sweep` (every minute): WeldDesk's SLA warnings and breaches
//!   on inbox conversations, for the workspaces the due index lists
//!   (`apps/workers/desk-api/src/cron/sla-sweep.ts`).
//! - `reach-send-sweep` (every minute): WeldReach's send sweep over the
//!   due index (kind `reach_send`, `apps/workers/reach-api/src/cron/send-sweep.ts`).
//!   With `REACH_SEND_QUEUE=nats` it publishes each due workspace on NATS
//!   for the `reach-send` subscriber of `weldsuite consume`; otherwise it
//!   runs each workspace's send tick itself.
//! - `reach-warmup-sweep` (hourly, at :15): WeldReach's warmup progress
//!   over the due index (kind `reach_warmup`, `cron/warmup-sweep.ts`).
//! - `reach-slot-reconciliation` (daily, 03:15 UTC): gives back Mailpool
//!   slots no active mailbox needs (`cron/slot-reconciliation.ts`; master
//!   database only).
//! - `reach-warmup-dispatch` (every minute), `reach-warmup-plan` (every 30
//!   minutes), `reach-warmup-daily` (02:30 UTC): the WeldReach warmup
//!   network (`apps/workers/reach-warmup-worker`; master database only,
//!   kill switch `weldreach-warmup`). With `REACH_WARMUP_QUEUE=nats` the
//!   dispatch publishes the due messages for the `reach-warmup-send` and
//!   `reach-warmup-engage` subscribers of `weldsuite consume`; otherwise it
//!   sends and engages them itself.
//! - `identity-sync` (every minute): the identity provider's changes into
//!   the master and tenant databases (what Clerk's webhooks do on Global;
//!   `weldsuite_core_onboarding::IdentitySync`).
//! - `workspace-deletion` (daily): workspaces past their scheduled deletion
//!   (`workspace-worker/src/services/deletion-sweep.ts`).
//! - `workspace-teardown` (hourly): deleted workspaces whose database
//!   teardown never finished (`services/teardown-sweep.ts`).
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

const JOBS: &str = "jobs: sign-lifecycle, identity-sync, workspace-deletion, workspace-teardown, mail-outbound-ledgers, calendar-replan, flow-file-purge, flow-benefit-measure, books-sweep, domain-auto-renew, desk-sla-sweep, reach-send-sweep, reach-warmup-sweep, reach-slot-reconciliation, reach-warmup-dispatch, reach-warmup-plan, reach-warmup-daily, bank-feed-due, crm-due, ad-sync, workflow-polls, workflow-schedules, connector-catchup, moneybird-push";

/// `weldsuite cron <job>`.
pub(crate) fn main(job: Option<&str>) -> ExitCode {
    let Some(
        job @ ("sign-lifecycle"
        | "identity-sync"
        | "workspace-deletion"
        | "workspace-teardown"
        | "mail-outbound-ledgers"
        | "calendar-replan"
        | "flow-file-purge"
        | "flow-benefit-measure"
        | "books-sweep"
        | "domain-auto-renew"
        | "desk-sla-sweep"
        | "reach-send-sweep"
        | "reach-warmup-sweep"
        | "reach-slot-reconciliation"
        | "reach-warmup-dispatch"
        | "reach-warmup-plan"
        | "reach-warmup-daily"
        | "bank-feed-due"
        | "crm-due"
        | "ad-sync"
        | "connector-catchup"
        | "moneybird-push"
        | "workflow-polls"
        | "workflow-schedules"),
    ) = job
    else {
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
    let telemetry = crate::telemetry::init(config.log_format, "info");
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
        match job {
            "identity-sync" => identity_sync(config).await,
            "workspace-deletion" => workspace_deletion(config).await,
            "workspace-teardown" => workspace_teardown(config).await,
            "mail-outbound-ledgers" => mail_outbound_ledgers(config).await,
            "calendar-replan" => calendar_replan(config).await,
            "flow-file-purge" => flow_file_purge(config).await,
            "flow-benefit-measure" => flow_benefit_measure(config).await,
            "workflow-schedules" => workflow_schedules(config).await,
            "books-sweep" => books_sweep(config).await,
            "domain-auto-renew" => {
                domain_auto_renew();
                Ok(())
            }
            "desk-sla-sweep" => desk_sla_sweep(config).await,
            "reach-send-sweep" => reach_send_sweep(config).await,
            "reach-warmup-sweep" | "reach-slot-reconciliation" => reach_warmup(config, job).await,
            "reach-warmup-dispatch" | "reach-warmup-plan" | "reach-warmup-daily" => {
                reach_warmup_network(config, job).await
            }
            "bank-feed-due" => bank_feed_due(config).await,
            "crm-due" => crm_due(config).await,
            "ad-sync" => ad_sync(config).await,
            "connector-catchup" | "moneybird-push" => connectors(config, job).await,
            "workflow-polls" => workflow_polls(config).await,
            _ => sign_lifecycle(config).await,
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

/// `weldsuite cron domain-auto-renew`: the result line; the sweep needs
/// billing, which this backend has not.
fn domain_auto_renew() {
    let result = weldsuite_host::run_domain_auto_renew(&|name| std::env::var(name).ok());
    println!(
        "{}",
        serde_json::json!({ "job": "domain-auto-renew", "result": result.to_json() })
    );
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
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
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
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
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

/// `weldsuite cron workflow-schedules`: one tick of WeldConnect's schedule
/// sweep. The runs it starts go to Restate; without `RESTATE_INGRESS_URL`
/// they would die with this process, so the tick is skipped.
async fn workflow_schedules(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let Some(ingress) = config.infra.jobs.restate_ingress_url.clone() else {
        println!(
            "{}",
            serde_json::json!({ "job": "workflow-schedules", "skipped": "RESTATE_INGRESS_URL is not set" })
        );
        return Ok(());
    };
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let jobs: Arc<dyn weldsuite_ports::DynJobs> = Arc::new(
        weldsuite_adapters_oss::RestateJobs::new(&ingress, reqwest::Client::new()),
    );
    let runs = weldsuite_connect::JobsWorkflowRuns { jobs };
    let tenants: weldsuite_connect::ScheduleTenants = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            let tenant = workspaces
                .tenant(&reference)
                .await
                .map_err(|error| error.to_string())?;
            // Runs carry the Clerk org id, as Global's schedule index did.
            let run_ref = tenant.clerk_org_id.clone().unwrap_or(tenant.workspace_id);
            Ok((tenant.db, run_ref))
        })
    });
    let result = weldsuite_connect::run_schedule_sweep(
        &master,
        &tenants,
        Some(&runs),
        time::OffsetDateTime::now_utc(),
    )
    .await;
    println!(
        "{}",
        serde_json::json!({
            "job": "workflow-schedules",
            "result": { "due": result.due, "processed": result.processed, "failed": result.failed },
        })
    );
    Ok(())
}

async fn calendar_replan(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let tenants: weldsuite_calendar::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    let now = time::OffsetDateTime::now_utc();
    let result =
        weldsuite_calendar::run_replan_sweep(&master, &tenants, infra.cache.as_deref(), now).await;
    println!(
        "{}",
        serde_json::json!({ "job": "calendar-replan", "result": result })
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

/// `flow-file-purge`: the due workspaces' soft-deleted `WeldFlow` files.
async fn flow_file_purge(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    // Purged objects may sit in either bucket: delete from both.
    let stores: Vec<_> = [infra.public_files.clone(), infra.files.clone()]
        .into_iter()
        .flatten()
        .collect();
    let tenants: weldsuite_flow::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    let now = time::OffsetDateTime::now_utc();
    let tick = weldsuite_flow::purge::run_file_purge(&master, &tenants, &stores, now).await;
    println!(
        "{}",
        serde_json::json!({
            "job": "flow-file-purge",
            "result": {
                "due": tick.sweep.due,
                "processed": tick.sweep.processed,
                "failed": tick.sweep.failed,
                "rows": tick.purged.rows,
                "objects": tick.purged.objects,
            },
        })
    );
    tracker.close();
    Ok(())
}

/// `flow-benefit-measure`: the due workspaces' benefits, measured for the month
/// that just ended.
async fn flow_benefit_measure(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tenants: weldsuite_flow::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    let now = time::OffsetDateTime::now_utc();
    let tick = weldsuite_flow::benefit_measure::run_benefit_measure(&master, &tenants, now).await;
    println!(
        "{}",
        serde_json::json!({
            "job": "flow-benefit-measure",
            "result": {
                "due": tick.sweep.due,
                "processed": tick.sweep.processed,
                "failed": tick.sweep.failed,
                "measured": tick.measured,
            },
        })
    );
    Ok(())
}

/// `books-sweep`: every workspace in the books due index (marked by its
/// books requests), swept as `sweepTenant` does, then due again tomorrow.
async fn books_sweep(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let mut books = crate::routes::books::sweep_state(&master, &config.keyring);
    // The tax reminders keep their markers in the cache and publish in-app
    // notifications.
    books.cache = infra.cache.clone();
    books.realtime = infra.realtime.clone();
    let now = time::OffsetDateTime::now_utc();
    // Due again in a day; a little less, so tomorrow's run at the same hour finds it.
    let next = now + time::Duration::hours(23);
    let totals = std::sync::Mutex::new(crate::routes::books::TenantSweep::default());
    let result = weldsuite_db::due_index::run_sweep(
        &master,
        crate::routes::books::SWEEP_KIND,
        now,
        500,
        Some(time::Duration::hours(1)),
        |workspace_id, now| {
            let workspaces = Arc::clone(&workspaces);
            let books = books.clone();
            let totals = &totals;
            async move {
                let tenant = workspaces
                    .tenant(&workspace_id)
                    .await
                    .map_err(|error| error.to_string())?;
                let swept = crate::routes::books::sweep_tenant(&tenant, &books, now)
                    .await
                    .map_err(|error| error.to_string())?;
                if let Ok(mut totals) = totals.lock() {
                    totals.overdue += swept.overdue;
                    totals.recurring_generated += swept.recurring_generated;
                    totals.recurring_failed += swept.recurring_failed;
                    totals.fx_rates += swept.fx_rates;
                    totals.depreciation_posted += swept.depreciation_posted;
                    totals.depreciation_skipped += swept.depreciation_skipped;
                    totals.reminders_sent += swept.reminders_sent;
                    totals.reminders_failed += swept.reminders_failed;
                }
                Ok::<_, String>(Some(next))
            }
        },
    )
    .await;
    let totals = totals.into_inner().unwrap_or_default();
    println!(
        "{}",
        serde_json::json!({
            "job": "books-sweep",
            "result": {
                "due": result.due,
                "processed": result.processed,
                "failed": result.failed,
                "totals": totals.json(),
            },
        })
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

/// `desk-sla-sweep`: the due workspaces' SLA warnings and breaches.
async fn desk_sla_sweep(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let tenants: weldsuite_desk::sla_sweep::SlaTenants = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            let tenant = workspaces
                .tenant(&reference)
                .await
                .map_err(|error| error.to_string())?;
            Ok(weldsuite_desk::sla_sweep::SlaTenant {
                db: tenant.db,
                clerk_org_id: tenant.clerk_org_id.unwrap_or(tenant.workspace_id),
            })
        })
    });
    let services = weldsuite_desk::sla_sweep::SweepServices {
        events: infra.events.clone(),
        realtime: infra.realtime.clone(),
        mail: infra.mail.clone(),
    };
    let now = time::OffsetDateTime::now_utc();
    let result = weldsuite_desk::sla_sweep::run_sla_sweep(&master, &tenants, &services, now).await;
    println!(
        "{}",
        serde_json::json!({ "job": "desk-sla-sweep", "result": result.to_json() })
    );
    // Entity events go out in the background: let them finish.
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

async fn reach_send_sweep(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let now = time::OffsetDateTime::now_utc();
    if std::env::var("REACH_SEND_QUEUE").as_deref() == Ok("nats") {
        let Some(url) = &config.infra.nats_url else {
            return Err("REACH_SEND_QUEUE=nats needs NATS_URL".into());
        };
        let bus = weldsuite_adapters_oss::JetStreamEventBus::connect(
            &weldsuite_adapters_oss::NatsOptions {
                url: url.clone(),
                user: config.infra.nats_user.clone(),
                token: config.infra.nats_token.clone(),
                name: Some("weldsuite-cron".to_owned()),
            },
        )
        .await?;
        bus.ensure_stream(crate::reach::send_stream_config(1))
            .await?;
        let result = weldsuite_reach::send::run_send_sweep(&master, &bus, now).await;
        println!(
            "{}",
            serde_json::json!({ "job": "reach-send-sweep", "queue": "nats", "result": {
                "due": result.due, "processed": result.processed, "failed": result.failed,
            } })
        );
        return Ok(());
    }
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let engine = crate::reach::send_engine(
        master,
        &workspaces,
        config.keyring.clone(),
        infra.events.clone(),
        Arc::clone(&infra.flags),
    );
    let result =
        weldsuite_reach::send::run_send_inline(&engine, &time::OffsetDateTime::now_utc).await;
    println!(
        "{}",
        serde_json::json!({ "job": "reach-send-sweep", "queue": "inline", "result": {
            "due": result.due, "processed": result.processed, "failed": result.failed,
        } })
    );
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// The warmup network's three jobs: `reach-warmup-dispatch` (over NATS with
/// `REACH_WARMUP_QUEUE=nats`, else inline), `reach-warmup-plan` and
/// `reach-warmup-daily`.
async fn reach_warmup_network(config: Config, job: &str) -> Result<(), Box<dyn std::error::Error>> {
    use weldsuite_reach::warmup_network::{clock, daily, dispatch, planner};
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let network = crate::reach::warmup_network(master, Arc::clone(&infra.flags))?;
    let now_ms = || {
        weldsuite_reach::weldsuite_reach_domain::epoch_ms(
            weldsuite_reach::weldsuite_reach_domain::now(),
        )
    };
    let mut rng = clock::random_float;
    let result = match job {
        "reach-warmup-plan" => {
            let result = planner::run_planner(&network, now_ms(), &mut rng).await?;
            serde_json::json!({
                "status": result.status, "poolMailboxes": result.pool_mailboxes,
                "poolDomains": result.pool_domains, "started": result.started,
                "loginsRestored": result.logins_restored,
                "mailboxesPlanned": result.mailboxes_planned,
                "messagesPlanned": result.messages_planned,
            })
        }
        "reach-warmup-daily" => {
            let result = daily::run_daily(&network, now_ms()).await;
            serde_json::json!({
                "disabled": result.disabled, "advanced": result.advanced,
                "graduated": result.graduated, "rolledUp": result.rolled_up,
                "autoPaused": result.auto_paused, "resumed": result.resumed,
                "cleaned": result.cleanup.map(|c| c.cleaned),
                "mailboxesVisited": result.cleanup.map(|c| c.mailboxes_visited),
                "rowsDeleted": result.cleanup.map(|c| c.rows_deleted),
            })
        }
        _ => {
            let queued = std::env::var("REACH_WARMUP_QUEUE").as_deref() == Ok("nats");
            let bus = if queued {
                let Some(url) = &config.infra.nats_url else {
                    return Err("REACH_WARMUP_QUEUE=nats needs NATS_URL".into());
                };
                let bus = weldsuite_adapters_oss::JetStreamEventBus::connect(
                    &weldsuite_adapters_oss::NatsOptions {
                        url: url.clone(),
                        user: config.infra.nats_user.clone(),
                        token: config.infra.nats_token.clone(),
                        name: Some("weldsuite-cron".to_owned()),
                    },
                )
                .await?;
                bus.ensure_stream(crate::reach::warmup_stream_config(1))
                    .await?;
                Some(bus)
            } else {
                None
            };
            let queue = match &bus {
                Some(bus) => dispatch::WarmupQueue::Nats(bus),
                None => dispatch::WarmupQueue::Inline,
            };
            let result = dispatch::run_dispatch(&network, &queue, &now_ms, &mut rng).await?;
            serde_json::json!({
                "queue": if queued { "nats" } else { "inline" },
                "disabled": result.disabled, "expired": result.expired,
                "sendQueued": result.send_queued, "engageQueued": result.engage_queued,
            })
        }
    };
    println!("{}", serde_json::json!({ "job": job, "result": result }));
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// `reach-warmup-sweep` and `reach-slot-reconciliation`.
async fn reach_warmup(config: Config, job: &str) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let engine = crate::reach::warmup_engine(
        master,
        &workspaces,
        config.keyring.clone(),
        infra.events.clone(),
    )?;
    let result = if job == "reach-warmup-sweep" {
        let result =
            weldsuite_reach::warmup::run_warmup_sweep(&engine, time::OffsetDateTime::now_utc())
                .await;
        serde_json::json!({ "due": result.due, "processed": result.processed, "failed": result.failed })
    } else {
        weldsuite_reach::warmup::run_slot_reconciliation(&engine)
            .await?
            .unwrap_or(serde_json::Value::Null)
    };
    println!("{}", serde_json::json!({ "job": job, "result": result }));
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// `bank-feed-due`: WeldBooks' bank feed connections whose next sync is due
/// (the master `bank_feed_connection_index`), synced in this process
/// (integration-sync-worker's `runBankFeedDueSweep`). Nothing while books
/// is not served, as the worker without `BOOKS_INTERNAL`.
async fn bank_feed_due(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let books = crate::routes::integrations::in_process_books(
        &master,
        &config.keyring,
        &workspaces,
        infra.events.clone(),
    );
    let now = time::OffsetDateTime::now_utc();
    let result = weldsuite_integrations::bank_feed_due::run_bank_feed_due_sweep(
        &master,
        books.as_deref(),
        now,
        weldsuite_integrations::bank_feed_due::BANK_FEED_SWEEP_LIMIT,
    )
    .await?;
    println!(
        "{}",
        serde_json::json!({ "job": "bank-feed-due", "result": result.to_json() })
    );
    // Entity events go out in the background: let them finish.
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// `workflow-polls`: WeldConnect's Google Sheets, Gmail, Google Calendar and
/// Airtable poll triggers of the workspaces that are due (the master
/// `workspace_due_index`, kind `workflow_poll`), each new item dispatched
/// to the matching workflows (integration-webhook-worker's
/// `runIntegrationPolls`). The runs go to Restate; without
/// `RESTATE_INGRESS_URL`, or while connect is not served, the run only logs
/// a skip.
async fn workflow_polls(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let Some(ingress) = config.infra.jobs.restate_ingress_url.clone() else {
        println!(
            "{}",
            serde_json::json!({ "job": "workflow-polls", "skipped": "RESTATE_INGRESS_URL is not set" })
        );
        return Ok(());
    };
    if !crate::routes::mounts("connect") {
        println!(
            "{}",
            serde_json::json!({ "job": "workflow-polls", "skipped": "connect is not served" })
        );
        return Ok(());
    }
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let jobs: Arc<dyn weldsuite_ports::DynJobs> = Arc::new(
        weldsuite_adapters_oss::RestateJobs::new(&ingress, reqwest::Client::new()),
    );
    let runs = crate::routes::integrations::execute_workflow(jobs);
    let open: weldsuite_integrations::crm::due::WorkspaceOpener =
        Arc::new(move |reference: String| {
            let workspaces = Arc::clone(&workspaces);
            Box::pin(async move {
                let tenant = workspaces
                    .tenant(&reference)
                    .await
                    .map_err(|error| error.to_string())?;
                // Runs carry the Clerk org id, as Global's poll index did.
                let org = tenant.clerk_org_id.clone().unwrap_or(tenant.workspace_id);
                Ok((tenant.db, org))
            })
        });
    let read = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let google_client = read("GOOGLE_CLIENT_ID").zip(read("GOOGLE_CLIENT_SECRET"));
    let http = crate::routes::shared_outbound();
    let sweep = weldsuite_integrations::workflow_polls::PollSweep {
        open: &open,
        http: http.as_ref(),
        runs: Some(runs.as_ref()),
        keyring: &config.keyring,
        google_client,
    };
    let (result, dispatched) = weldsuite_integrations::workflow_polls::run_workflow_polls(
        &master,
        &sweep,
        time::OffsetDateTime::now_utc(),
    )
    .await;
    println!(
        "{}",
        serde_json::json!({
            "job": "workflow-polls",
            "result": { "due": result.due, "processed": result.processed, "failed": result.failed, "dispatched": dispatched },
        })
    );
    Ok(())
}

/// `ad-sync`: WeldAds connections whose metrics sync is due (the master
/// `ad_sync_index`), synced through WeldConnect's internal route in this
/// process (integration-sync-worker's `runAdSyncSweep`). Nothing while
/// connect is not served.
async fn ad_sync(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let jobs = Arc::clone(&infra.jobs);
    let connect = crate::routes::cron_connect_state(
        &infra,
        &workspaces,
        &config.environment,
        Arc::clone(&jobs),
    );
    let Some(binding) = crate::routes::integrations::cron_connect_internal(connect, jobs) else {
        println!(
            "{}",
            serde_json::json!({ "job": "ad-sync", "skipped": "connect is not served" })
        );
        return Ok(());
    };
    let result = weldsuite_integrations::meta_ads::run_ad_sync_sweep(
        &master,
        binding.as_ref(),
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    println!(
        "{}",
        serde_json::json!({ "job": "ad-sync", "result": { "due": result.due, "triggered": result.triggered } })
    );
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// `crm-due`: CRM connections whose next sync is due (the master
/// `workspace_due_index`, kind `crm_sync`, where Global keeps the D1
/// `crm_sync_index`), synced and their Google watches renewed through
/// WeldConnect's internal routes in this process (integration-sync-worker's
/// `runCrmDueSweep`). The syncs run on Restate; without
/// `RESTATE_INGRESS_URL`, or while connect is not served, the run only logs a
/// skip.
async fn crm_due(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let Some(ingress) = config.infra.jobs.restate_ingress_url.clone() else {
        println!(
            "{}",
            serde_json::json!({ "job": "crm-due", "skipped": "RESTATE_INGRESS_URL is not set" })
        );
        return Ok(());
    };
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let jobs: Arc<dyn weldsuite_ports::DynJobs> = Arc::new(
        weldsuite_adapters_oss::RestateJobs::new(&ingress, reqwest::Client::new()),
    );
    let connect = crate::routes::cron_connect_state(
        &infra,
        &workspaces,
        &config.environment,
        Arc::clone(&jobs),
    );
    let Some(binding) = crate::routes::integrations::cron_connect_internal(connect, jobs) else {
        println!(
            "{}",
            serde_json::json!({ "job": "crm-due", "skipped": "connect is not served" })
        );
        return Ok(());
    };
    let open: weldsuite_integrations::crm::due::WorkspaceOpener =
        Arc::new(move |reference: String| {
            let workspaces = Arc::clone(&workspaces);
            Box::pin(async move {
                let tenant = workspaces
                    .tenant(&reference)
                    .await
                    .map_err(|error| error.to_string())?;
                // Connect's internal routes take the Clerk org id (`X-Workspace-Id`).
                let org = tenant.clerk_org_id.clone().unwrap_or(tenant.workspace_id);
                Ok((tenant.db, org))
            })
        });
    let (result, counts) = weldsuite_integrations::crm::due::run_crm_due_sweep(
        &master,
        &open,
        binding.as_ref(),
        time::OffsetDateTime::now_utc(),
    )
    .await;
    println!(
        "{}",
        serde_json::json!({
            "job": "crm-due",
            "result": {
                "due": result.due, "processed": result.processed, "failed": result.failed,
                "triggered": counts.triggered, "renewed": counts.renewed, "syncFailed": counts.failed,
            },
        })
    );
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// WeldConnect's store and accounting connectors (integration-sync-worker's
/// `runConnectorCatchupSweep`, integration-webhook-worker's
/// `runMoneybirdPushSweep`), through WeldConnect's internal routes in this
/// process; while connect is not served the run only logs a skip.
///
/// - `connector-catchup`: the workspaces whose connector catch-up is due
///   (the master `workspace_due_index`, kind `connector_catchup`, where
///   Global keeps the D1 `connector_sync_index`): each due connection probed
///   for changes and caught up when there are any;
/// - `moneybird-push`: the workspaces whose last Moneybird push left work
///   (kind `moneybird_push`), another pass each.
async fn connectors(config: Config, job: &str) -> Result<(), Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let jobs = Arc::clone(&infra.jobs);
    let connect = crate::routes::cron_connect_state(
        &infra,
        &workspaces,
        &config.environment,
        Arc::clone(&jobs),
    );
    let Some(binding) = crate::routes::integrations::cron_connect_internal(connect, jobs) else {
        println!(
            "{}",
            serde_json::json!({ "job": job, "skipped": "connect is not served" })
        );
        return Ok(());
    };
    let now = time::OffsetDateTime::now_utc();
    let result = if job == "moneybird-push" {
        let result = weldsuite_integrations::connectors::run_moneybird_push_sweep(
            &master,
            binding.as_ref(),
            now,
        )
        .await;
        serde_json::json!({ "due": result.due, "processed": result.processed, "failed": result.failed })
    } else {
        let open: weldsuite_integrations::crm::due::WorkspaceOpener =
            Arc::new(move |reference: String| {
                let workspaces = Arc::clone(&workspaces);
                Box::pin(async move {
                    let tenant = workspaces
                        .tenant(&reference)
                        .await
                        .map_err(|error| error.to_string())?;
                    // Connect's internal routes take the Clerk org id (`X-Workspace-Id`).
                    let org = tenant.clerk_org_id.clone().unwrap_or(tenant.workspace_id);
                    Ok((tenant.db, org))
                })
            });
        // The probe reads the stored credentials and asks the providers.
        let env = weldsuite_integrations::connectors::probe_env(
            config.keyring.clone(),
            std::env::var("STRIPE_SECRET_KEY").ok(),
            crate::routes::shared_outbound(),
            infra.events.clone(),
        );
        let (result, counts) = weldsuite_integrations::connectors::run_connector_catchup_sweep(
            &master,
            &open,
            binding.as_ref(),
            &env,
            now,
        )
        .await;
        serde_json::json!({
            "due": result.due, "processed": result.processed, "failed": result.failed,
            "connections": counts.to_json(),
        })
    };
    println!("{}", serde_json::json!({ "job": job, "result": result }));
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}

/// The master pool and the identity provider and provisioner, for the
/// workspace jobs.
struct WorkspaceInfra {
    master: weldsuite_db::PgPool,
    workspaces: Arc<Workspaces>,
    identity: Option<Arc<dyn weldsuite_ports::Identity>>,
    provisioner: Option<Arc<dyn weldsuite_ports::DatabaseProvisioner>>,
}

fn workspace_infra(config: &Config) -> Result<WorkspaceInfra, Box<dyn std::error::Error>> {
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let identity = config.infra.identity.as_ref().map(|settings| {
        weldsuite_adapters_oss::ZitadelIdentity::new(weldsuite_adapters_oss::ZitadelOptions {
            api_url: settings.api_url.clone(),
            token: settings.token.clone(),
            project_id: settings.project_id.clone(),
            invite_url_template: settings.invite_url_template.clone(),
            application_name: "WeldSuite".to_owned(),
            host: settings.host.clone(),
        })
        .map(|identity| Arc::new(identity) as Arc<dyn weldsuite_ports::Identity>)
    });
    let identity = identity.transpose()?;
    let provisioner = crate::infra::provisioner(&config.infra, &master, &config.keyring)?;
    Ok(WorkspaceInfra {
        master,
        workspaces,
        identity,
        provisioner,
    })
}

/// Tenant databases through the app's `Workspaces`, for the onboarding jobs.
fn tenant_databases(workspaces: &Arc<Workspaces>) -> weldsuite_core_onboarding::TenantDatabases {
    let workspaces = Arc::clone(workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}

async fn identity_sync(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let infra = workspace_infra(&config)?;
    let Some(identity) = infra.identity else {
        return Err(
            "identity-sync needs ZITADEL_API_URL, ZITADEL_SERVICE_TOKEN and ZITADEL_PROJECT_ID"
                .into(),
        );
    };
    let sync = weldsuite_core_onboarding::IdentitySync::new(
        infra.master,
        identity,
        tenant_databases(&infra.workspaces),
        infra.provisioner,
    );
    let report = sync.run().await.map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::json!({ "job": "identity-sync", "result": report })
    );
    Ok(())
}

async fn workspace_deletion(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let infra = workspace_infra(&config)?;
    let Some(identity) = infra.identity else {
        return Err("workspace-deletion needs ZITADEL_API_URL, ZITADEL_SERVICE_TOKEN and ZITADEL_PROJECT_ID".into());
    };
    let result =
        weldsuite_core_onboarding::sweep_scheduled_deletions(&infra.master, &identity).await?;
    println!(
        "{}",
        serde_json::json!({ "job": "workspace-deletion", "result": result })
    );
    Ok(())
}

async fn workspace_teardown(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let infra = workspace_infra(&config)?;
    let Some(provisioner) = infra.provisioner else {
        tracing::info!("TENANT_SHARDS is not set: nothing to tear down");
        return Ok(());
    };
    let result = weldsuite_core_onboarding::sweep_unfinished_teardowns(
        &infra.master,
        &provisioner,
        weldsuite_core_onboarding::TEARDOWN_RETRY_AFTER,
    )
    .await;
    println!(
        "{}",
        serde_json::json!({ "job": "workspace-teardown", "result": result })
    );
    Ok(())
}
