//! WeldPanel's monitoring and data out on this server: the ports of the
//! alerts, subscriptions, exports and custom-domain routes
//! ([`monitor_state`]), and `weldsuite cron panel-schedule` ([`panel_schedule`],
//! every 10 minutes): panel-api's scheduled handler, which runs the alerts,
//! scheduled reports and raw exports the master `panel_schedule_registry`
//! lists as due, opening only those workspaces' tenant databases, and polls
//! custom collector domains.
//!
//! Custom collector domains come from cert-manager on Kubernetes (ADR
//! PANEL-014), built in a later step; until then there is no provider and
//! the routes answer as Global does without Cloudflare custom hostnames (503), and
//! the cron polls none.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use weldsuite_db::Workspaces;
use weldsuite_panel::monitor::scheduled::{
    ScheduleDeps, ScheduleTenants, WorkspaceHandle, run_scheduled, summary_json,
};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use crate::config::Config;
use crate::server::AppState;

/// The client for Slack webhooks and the customers' stores: public
/// addresses only (they are URLs a workspace chose), made once per process.
pub(crate) fn public_http() -> Option<OutboundHttp> {
    static HTTP: OnceLock<Option<OutboundHttp>> = OnceLock::new();
    HTTP.get_or_init(|| {
        weldsuite_adapters_oss::ReqwestOutbound::public_only(Duration::from_secs(30))
            .ok()
            .map(|client| OutboundHttp(Arc::new(client)))
    })
    .clone()
}

/// The monitoring routes' state: system mail, the public-only client, and
/// no custom-domain provider yet. Conformance builds take the test's fetch
/// stub and Cloudflare settings per request.
pub(crate) fn monitor_state(
    state: &AppState,
    panel: weldsuite_panel::PanelState,
) -> weldsuite_panel::MonitorState {
    let conformance = cfg!(feature = "conformance");
    weldsuite_panel::MonitorState {
        panel,
        mail: state.infra.mail.clone(),
        http: (!conformance).then(public_http).flatten(),
        domains: None,
    }
}

/// Tenant databases through the app's `Workspaces`, by `workspaces.id`.
struct Tenants(Arc<Workspaces>);

impl ScheduleTenants for Tenants {
    fn open<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<WorkspaceHandle, String>> {
        Box::pin(async move {
            let tenant = self
                .0
                .tenant(workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            Ok(WorkspaceHandle {
                db: tenant.db,
                clerk_org_id: tenant
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| tenant.workspace_id.clone()),
                workspace_id: tenant.workspace_id,
                suspended: tenant.suspended,
            })
        })
    }
}

/// `panel-schedule`: one run of WeldPanel's scheduled work; nothing while
/// panel is not served.
pub(crate) async fn panel_schedule(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    if !crate::routes::mounts("panel") {
        println!(
            "{}",
            serde_json::json!({ "job": "panel-schedule", "result": { "skipped": "panel is not served" } })
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
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let sql = crate::panel_sql::engine(config.infra.panel.as_ref(), &master)?;
    // The tenant tables (erased ids, identified users); the cron writes none.
    let valkey = match &config.infra.valkey_url {
        Some(url) => Some(crate::panel_project::PanelValkey::new(
            weldsuite_adapters_oss::connect_valkey(url).await?,
            config.infra.valkey_cache_prefix.clone(),
        )),
        None => None,
    };
    let project_state: Arc<dyn weldsuite_panel::PanelProjectState> =
        Arc::new(crate::panel_project::TenantProjectState {
            pools: Arc::new(crate::panel_project::WorkspaceTenantPools(Arc::clone(
                &workspaces,
            ))),
            rows: crate::panel_project::rows::RowSink::new(None),
            valkey,
            clock: crate::panel_project::system_clock(),
        });
    let deps = ScheduleDeps {
        master,
        tenants: Arc::new(Tenants(workspaces)),
        events: infra.events.clone(),
        mail: infra.mail.clone(),
        http: public_http(),
        realtime: infra.realtime.clone(),
        cache: infra.cache.clone(),
        sql,
        project_state: Some(project_state),
        domains: None,
        keyring: config.keyring.clone(),
        platform_url: std::env::var("PLATFORM_URL")
            .ok()
            .filter(|url| !url.is_empty()),
    };
    let started = std::time::Instant::now();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        });
    let result = run_scheduled(&deps, now).await;
    weldsuite_ports::record_job_run("panel.schedule", result.is_ok(), started.elapsed());
    match result {
        Ok(summary) => println!(
            "{}",
            serde_json::json!({ "job": "panel-schedule", "result": summary_json(&summary) })
        ),
        Err(error) => {
            tracing::error!(%error, "[panel-api] cron failed");
            println!(
                "{}",
                serde_json::json!({ "job": "panel-schedule", "result": { "error": error.to_string() } })
            );
        }
    }
    // Entity events and mail go out in the background: let them finish.
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    Ok(())
}
