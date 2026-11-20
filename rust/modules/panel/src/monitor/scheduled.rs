//! `weldsuite cron panel-schedule` (every 10 minutes): panel-api's cron
//! (`src/scheduled.ts`). Runs the alerts, scheduled reports and raw exports
//! that are due, and refreshes custom collector domains still pending.
//!
//! Due work comes from the master `panel_schedule_registry`, so no tenant
//! database is opened unless something in it is due (ADR DATA-008):
//!
//! 1. Claim: one statement takes at most 50 rows with `next_run_at <= now`
//!    whose lock is free or expired, and locks them for 10 minutes
//!    ([`claim_due`]), so two runs never take the same row and a run that
//!    dies frees its rows on its own.
//! 2. Group the rows by workspace and open each tenant database once.
//! 3. Run each item with the tenant row as the source of truth (a row
//!    deleted, disabled or paused since leaves the registry), and hand the
//!    row back with its next run, only while the lock is still ours.
//!
//! Work is bounded: 50 rows per run, and no new item starts after 8 minutes
//! (items not started stay due). An item that fails is retried in 10
//! minutes; one never stops the others.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    PANEL_ALERT_FIRED, PANEL_ALERT_RESOLVED, PANEL_CUSTOM_DOMAIN_DELETED,
    PANEL_CUSTOM_DOMAIN_UPDATED,
};
use weldsuite_db::Keyring;
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource, publish_entity_event};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::plan_retention::event_retention_days;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery};
use weldsuite_ports::{BoxFuture, DynCache, DynRealtimePublisher, DynSystemMail, OutboundHttp};

use super::alerts::{self, CheckPorts};
use super::delivery::{self, Delivered, Delivery, Message, Senders, Target};
use super::domains::{
    CollectorDomains, domains_to_poll, event_data, refresh_domain, remove_domain,
};
use super::exports::{self, ExportPorts};
use super::schedule::{MAX_CLAIM, MINUTE, ScheduleRow, claim_due, release_schedule};
use super::subscriptions;
use crate::engine::AnalyticsSql;
use crate::project_state::{PanelProjectState, ProjectRef};
use crate::query::QueryDeps;

/// No new item starts after this much of a run (`RUN_BUDGET_MS`).
pub const RUN_BUDGET_MS: i64 = 8 * MINUTE;
/// When an item that failed is tried again (`RETRY_MS`).
pub const RETRY_MS: i64 = 10 * MINUTE;
/// Custom domains polled per run (`DOMAINS_PER_RUN`).
pub const DOMAINS_PER_RUN: i64 = 20;

/// A workspace's tenant database (`WorkspaceHandle`).
#[derive(Clone)]
pub struct WorkspaceHandle {
    pub db: PgPool,
    /// `workspaces.id`.
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub suspended: bool,
}

/// Opens a workspace's tenant database by `workspaces.id`.
pub trait ScheduleTenants: Send + Sync {
    fn open<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<WorkspaceHandle, String>>;
}

/// What the cron runs with (`ScheduledDeps`): the master database, the
/// tenants, and the ports `serve` gives the routes.
#[derive(Clone)]
pub struct ScheduleDeps {
    pub master: PgPool,
    pub tenants: Arc<dyn ScheduleTenants>,
    pub events: EntityEventPublisher,
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Slack webhooks and the customers' stores: public addresses only.
    pub http: Option<OutboundHttp>,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The query cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn DynCache>>,
    /// The analytics engine; `None` makes every check fail as unavailable.
    pub sql: Option<Arc<dyn AnalyticsSql>>,
    pub project_state: Option<Arc<dyn PanelProjectState>>,
    /// Custom collector domains; `None` polls none.
    pub domains: Option<Arc<dyn CollectorDomains>>,
    pub keyring: Keyring,
    /// `PLATFORM_URL`, for the links in messages.
    pub platform_url: Option<String>,
}

impl std::fmt::Debug for ScheduleDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScheduleDeps").finish_non_exhaustive()
    }
}

/// What one run did (`ScheduledSummary`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub claimed: u64,
    pub ran: u64,
    pub failed: u64,
    pub deferred: u64,
    pub domains: u64,
}

/// Runs one due item and says when it is next due (`None`: drop it).
pub(crate) trait ItemRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        ws: &'a WorkspaceHandle,
        row: &'a ScheduleRow,
        now: i64,
        deadline: i64,
    ) -> BoxFuture<'a, Result<Option<i64>, String>>;
}

/// The items' ports for one workspace.
struct WorkspacePorts<'a> {
    deps: &'a ScheduleDeps,
    ws: &'a WorkspaceHandle,
    delivery: Delivery,
}

impl WorkspacePorts<'_> {
    fn query_deps(&self) -> QueryDeps {
        QueryDeps {
            tenant: self.ws.db.clone(),
            master: Some(self.deps.master.clone()),
            cache: self.deps.cache.clone(),
            engine: self.deps.sql.clone(),
            state: self.deps.project_state.clone(),
            workspace_id: self.ws.workspace_id.clone(),
            now: None,
        }
    }
}

impl CheckPorts for WorkspacePorts<'_> {
    fn run(&self, spec: Value) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move { super::run_spec(&self.query_deps(), spec).await })
    }

    fn deliver<'a>(
        &'a self,
        target: &'a Target,
        message: &'a Message,
    ) -> BoxFuture<'a, Vec<Delivered>> {
        Box::pin(async move {
            let mut ctx = self.delivery.clone();
            target.owner_user_id.clone_into(&mut ctx.actor_user_id);
            delivery::deliver(&ctx, target, message).await
        })
    }

    fn publish<'a>(&'a self, alert: &'a Value, action: &'static str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let event = if action == "fired" {
                PANEL_ALERT_FIRED
            } else {
                PANEL_ALERT_RESOLVED
            };
            let owner = alert["ownerUserId"].as_str().unwrap_or_default();
            publish_entity_event(
                &self.deps.events,
                &EventContext::new(self.ws.clerk_org_id.clone(), owner, EventSource::System),
                event,
                alert["id"].as_str().unwrap_or_default(),
                &alerts::event_data(alert),
            );
        })
    }
}

/// An export's ports in one workspace.
struct ExportRunPorts<'a> {
    ports: &'a WorkspacePorts<'a>,
    project_id: String,
    now: i64,
}

impl ExportPorts for ExportRunPorts<'_> {
    fn context(&self) -> BoxFuture<'_, Result<PanelQueryContext, String>> {
        Box::pin(async move {
            // `exportContext`: the erased ids and the plan's retention.
            let Some(state) = self.ports.deps.project_state.clone() else {
                return Err("Analytics queries are not configured here".to_owned());
            };
            let workspace_id = self.ports.ws.workspace_id.as_str();
            let erased_ids = state
                .erased_ids(ProjectRef {
                    workspace_id,
                    project_id: &self.project_id,
                })
                .await
                .map_err(|error| error.to_string())?;
            let slug: Option<Option<String>> = sqlx::query_scalar(
                "select p.slug from workspaces w left join plans p on p.id = w.plan_id where w.id = $1 limit 1",
            )
            .bind(workspace_id)
            .fetch_optional(&self.ports.deps.master)
            .await
            .map_err(|error| error.to_string())?;
            // 366 or 762 days: an f64 holds them exactly.
            #[allow(clippy::cast_precision_loss)]
            let retention_days = event_retention_days(slug.flatten().as_deref()) as f64;
            Ok(PanelQueryContext {
                workspace_id: workspace_id.to_owned(),
                project_id: self.project_id.clone(),
                retention_days,
                has_identified_users: false,
                erased_ids,
                now: Some(self.now),
                ..PanelQueryContext::default()
            })
        })
    }

    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let Some(sql) = self.ports.deps.sql.clone() else {
                return Err("Analytics queries are not configured here".to_owned());
            };
            sql.execute(query)
                .await
                .map(|result| result.rows)
                .map_err(|error| error.to_string())
        })
    }

    fn http(&self) -> Option<OutboundHttp> {
        self.ports.deps.http.clone()
    }

    fn notify_failing<'a>(&'a self, export: &'a Value, error: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Err(failure) =
                exports::send_failing_mail(&self.ports.delivery, export, error).await
            {
                tracing::error!(export = export["id"].as_str().unwrap_or_default(), %failure, "[panel-api] export failing mail failed");
            }
        })
    }
}

/// The items as `runScheduleItem` runs them.
pub(crate) struct DefaultItems<'a> {
    pub(crate) deps: &'a ScheduleDeps,
    /// Tests: senders that record.
    pub(crate) senders: Option<Arc<dyn Senders>>,
}

impl ItemRunner for DefaultItems<'_> {
    fn run<'a>(
        &'a self,
        ws: &'a WorkspaceHandle,
        row: &'a ScheduleRow,
        now: i64,
        deadline: i64,
    ) -> BoxFuture<'a, Result<Option<i64>, String>> {
        Box::pin(async move {
            run_schedule_item(self.deps, self.senders.clone(), ws, row, now, deadline)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// `runScheduleItem(deps, ws, row, now, deadline)`.
async fn run_schedule_item(
    deps: &ScheduleDeps,
    senders: Option<Arc<dyn Senders>>,
    ws: &WorkspaceHandle,
    row: &ScheduleRow,
    now: i64,
    deadline: i64,
) -> Result<Option<i64>, sqlx::Error> {
    let ports = WorkspacePorts {
        deps,
        ws,
        delivery: Delivery {
            db: ws.db.clone(),
            clerk_org_id: ws.clerk_org_id.clone(),
            actor_user_id: String::new(),
            platform_url: deps.platform_url.clone(),
            keyring: deps.keyring.clone(),
            mail: deps.mail.clone(),
            http: deps.http.clone(),
            realtime: deps.realtime.clone(),
            events: deps.events.clone(),
            senders,
        },
    };
    let db = &ws.db;
    match row.kind.as_str() {
        "alert" => {
            let Some(alert) = alerts::get_alert(db, &row.object_id)
                .await?
                .filter(|a| a["enabled"].as_bool() == Some(true))
            else {
                return Ok(None);
            };
            let result = alerts::run_alert_check(db, now, &ports, &alert).await?;
            Ok(alerts::next_check_of(&result.alert, &result.time_zone, now))
        }
        "subscription" => {
            let Some(sub) = subscriptions::get_subscription(db, &row.object_id)
                .await?
                .filter(|s| s["enabled"].as_bool() == Some(true))
            else {
                return Ok(None);
            };
            let (_, _, after) =
                subscriptions::send_subscription(db, now, &ports, &sub, true).await?;
            Ok(after["nextRunAt"]
                .as_str()
                .and_then(js::parse_iso)
                .or_else(|| subscriptions::next_run_of(&sub, now)))
        }
        _ => {
            let Some(export) = exports::get_export(db, &row.object_id)
                .await?
                .filter(|e| e["status"].as_str() != Some("paused"))
            else {
                return Ok(None);
            };
            let run_ports = ExportRunPorts {
                ports: &ports,
                project_id: export["projectId"].as_str().unwrap_or_default().to_owned(),
                now,
            };
            let result =
                exports::run_export(db, now, deadline, &deps.keyring, &run_ports, &export).await?;
            let Some(next) = exports::next_run_of(&result.export, now) else {
                return Ok(None);
            };
            // More windows waiting: carry on with the next run.
            if !result.caught_up && result.error.is_none() {
                return Ok(Some(now));
            }
            if result.error.is_some() {
                return Ok(Some(next.min(now + 60 * MINUTE)));
            }
            Ok(Some(next))
        }
    }
}

/// `pollDomains(env, masterDb, now)`: refreshes pending custom domains and
/// retries removals the provider refused.
async fn poll_domains(deps: &ScheduleDeps, now: i64) -> Result<u64, sqlx::Error> {
    let Some(domains) = deps.domains.clone() else {
        return Ok(0);
    };
    let rows = domains_to_poll(&deps.master, now, DOMAINS_PER_RUN).await?;
    for domain in &rows {
        let context = EventContext::new(
            domain["workspaceId"].as_str().unwrap_or_default(),
            domain["createdByUserId"].as_str().unwrap_or_default(),
            EventSource::System,
        );
        let id = domain["id"].as_str().unwrap_or_default();
        let outcome = if domain["status"].as_str() == Some("deleting") {
            remove_domain(&deps.master, domains.as_ref(), domain, now)
                .await
                .map(|(removed, after)| {
                    if removed {
                        publish_entity_event(
                            &deps.events,
                            &context,
                            PANEL_CUSTOM_DOMAIN_DELETED,
                            id,
                            &event_data(&after),
                        );
                    }
                })
        } else {
            refresh_domain(&deps.master, domains.as_ref(), domain, now)
                .await
                .map(|fresh| {
                    if fresh["status"] != domain["status"] {
                        publish_entity_event(
                            &deps.events,
                            &context,
                            PANEL_CUSTOM_DOMAIN_UPDATED,
                            id,
                            &event_data(&fresh),
                        );
                    }
                })
        };
        if let Err(error) = outcome {
            tracing::error!(domain = id, %error, "[panel-api] custom domain poll failed");
        }
    }
    Ok(rows.len() as u64)
}

/// One claimed row run (or deferred) and handed back (`runRow`).
async fn run_row(
    master: &PgPool,
    items: &dyn ItemRunner,
    ws: Option<&WorkspaceHandle>,
    row: &ScheduleRow,
    now: i64,
    deadline: i64,
    summary: &mut Summary,
) -> Result<(), sqlx::Error> {
    let Some(ws) = ws.filter(|ws| !ws.suspended) else {
        // A suspended workspace runs nothing until it is back.
        let later = if ws.is_some_and(|ws| ws.suspended) {
            60 * MINUTE
        } else {
            RETRY_MS
        };
        release_schedule(master, row, Some(now + later)).await?;
        summary.deferred += 1;
        return Ok(());
    };
    if js::now_millis() > deadline {
        // Out of time: leave it due for the next run.
        release_schedule(master, row, Some(row.next_run_at)).await?;
        summary.deferred += 1;
        return Ok(());
    }
    let next = match items.run(ws, row, now, deadline).await {
        Ok(next) => {
            summary.ran += 1;
            next
        }
        Err(error) => {
            tracing::error!(kind = %row.kind, object = %row.object_id, %error, "[panel-api] cron item failed");
            summary.failed += 1;
            Some(now + RETRY_MS)
        }
    };
    release_schedule(master, row, next).await
}

/// One run (`runScheduled`), with the item runner given.
pub(crate) async fn run_scheduled_with(
    deps: &ScheduleDeps,
    items: &dyn ItemRunner,
    now: i64,
    budget_ms: i64,
) -> Result<Summary, sqlx::Error> {
    let deadline = js::now_millis() + budget_ms;
    let mut summary = Summary::default();
    let claimed = claim_due(&deps.master, now, MAX_CLAIM).await?;
    summary.claimed = claimed.len() as u64;
    let mut by_workspace: Vec<(String, Vec<&ScheduleRow>)> = Vec::new();
    for row in &claimed {
        match by_workspace
            .iter_mut()
            .find(|(ws, _)| *ws == row.workspace_id)
        {
            Some((_, rows)) => rows.push(row),
            None => by_workspace.push((row.workspace_id.clone(), vec![row])),
        }
    }
    for (workspace_id, rows) in &by_workspace {
        let ws = match deps.tenants.open(workspace_id).await {
            Ok(ws) => Some(ws),
            Err(error) => {
                tracing::error!(workspace = %workspace_id, %error, "[panel-api] cron: workspace could not be opened");
                None
            }
        };
        for row in rows {
            run_row(
                &deps.master,
                items,
                ws.as_ref(),
                row,
                now,
                deadline,
                &mut summary,
            )
            .await?;
        }
    }
    match poll_domains(deps, now).await {
        Ok(polled) => summary.domains = polled,
        Err(error) => tracing::error!(%error, "[panel-api] cron: custom domains poll failed"),
    }
    Ok(summary)
}

/// `weldsuite cron panel-schedule`: one run at `now`.
pub async fn run_scheduled(deps: &ScheduleDeps, now: i64) -> Result<Summary, sqlx::Error> {
    let items = DefaultItems {
        deps,
        senders: None,
    };
    run_scheduled_with(deps, &items, now, RUN_BUDGET_MS).await
}

/// The summary as the cron prints it.
pub fn summary_json(summary: &Summary) -> Value {
    json!(summary)
}
