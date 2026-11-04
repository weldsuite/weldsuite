//! The `status_report_due` sweep (`cron/status-report-sweep.ts`, ADR
//! FLOW-018, `weldsuite cron flow-status-reports`): a project with a
//! `statusReport` schedule gets a draft on its cadence's slot day, once per
//! period, and its project manager is told it is ready. Only workspaces the
//! `status_report_due` due index lists are opened (ADR DATA-008); saving a
//! schedule marks them due.

use std::sync::Arc;

use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::PROJECT_STATUS_REPORT_CREATED;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_flow_domain::status_report::{
    event_data, last_slot_on_or_before, next_slot_after, period_for_slot,
};
use weldsuite_notifications::Notifier;
use weldsuite_ports::BoxFuture;

use crate::reporting_notify::{NotifyContext, notify_draft_ready};
use crate::reporting_store::{insert_draft, period_handled, schedule_of, scheduled_projects};

/// The due index kind.
pub const STATUS_REPORT_KIND: &str = "status_report_due";
/// A workspace that failed is retried after six hours.
const RETRY_AFTER_HOURS: i64 = 6;
/// How many due workspaces one tick opens at most.
const SWEEP_LIMIT: i64 = 500;

/// Opens a workspace's tenant database outside a request: the database and the
/// Clerk org id (its events and in-app notifications go there).
pub type SweepTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<(PgPool, String), String>> + Send + Sync>;

/// What the sweep sends through.
#[derive(Clone)]
pub struct SweepSinks {
    pub events: EntityEventPublisher,
    pub notifier: Notifier,
}

impl SweepSinks {
    /// The sinks of a cron process: the event publisher and the realtime hub for in-app notifications.
    pub fn new(
        events: EntityEventPublisher,
        realtime: Option<Arc<dyn weldsuite_ports::DynRealtimePublisher>>,
    ) -> Self {
        Self {
            events,
            notifier: Notifier {
                realtime,
                presence: None,
                mail: None,
                http: None,
                apns: None,
            },
        }
    }
}

/// `sweepStatusReports(env, db, orgId, now)`: draft what is due in one
/// workspace and answer when the next slot of any scheduled project comes.
pub async fn sweep_status_reports(
    db: &PgPool,
    org_id: &str,
    sinks: &SweepSinks,
    now_ms: i64,
) -> Result<Option<OffsetDateTime>, String> {
    let mut next: Option<i64> = None;
    let mut failed: Option<String> = None;
    for project in scheduled_projects(db).await.map_err(|e| e.to_string())? {
        let Some(schedule) = schedule_of(&project) else {
            continue;
        };
        if !["weekly", "biweekly", "monthly"].contains(&schedule.cadence.as_str())
            || !(1..=7).contains(&schedule.weekday)
        {
            continue;
        }
        let outcome: Result<(), sqlx::Error> = async {
            let period = period_for_slot(
                &schedule.cadence,
                last_slot_on_or_before(&schedule.cadence, schedule.weekday, now_ms),
            );
            if !period_handled(db, &project.id, &period).await?
                && let Some(report) =
                    insert_draft(db, &project, &period, now_ms, "system", None).await?
            {
                announce(db, org_id, sinks, &report, &project).await;
            }
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => {
                let slot = next_slot_after(&schedule.cadence, schedule.weekday, now_ms);
                next = Some(next.map_or(slot, |n| n.min(slot)));
            }
            Err(error) => {
                tracing::error!(%error, project = project.id, "[StatusReports] project failed");
                failed = Some(error.to_string());
            }
        }
    }
    if let Some(error) = failed {
        return Err(error);
    }
    Ok(next
        .and_then(|ms| OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()))
}

async fn announce(
    db: &PgPool,
    org_id: &str,
    sinks: &SweepSinks,
    report: &Value,
    project: &crate::reporting_store::ReportProject,
) {
    let context = EventContext::new(org_id, "system", EventSource::System);
    let id = report["id"].as_str().unwrap_or_default();
    sinks
        .events
        .publish_and_wait(
            &context,
            EntityEvent::new(PROJECT_STATUS_REPORT_CREATED, id, event_data(report)),
        )
        .await;
    // The workspace's `workspaces.id` is not known here and not needed: only the in-app notification goes out.
    let notify = NotifyContext {
        db: db.clone(),
        notifier: sinks.notifier.clone(),
        master: None,
        mail: None,
        portal_url: None,
        workspace_id: org_id.to_owned(),
        org_id: org_id.to_owned(),
        actor_id: None,
    };
    notify_draft_ready(&notify, report, project).await;
}

/// One daily tick (`runStatusReportSweep`): the due workspaces of the master
/// database's index, each drafted and re-scheduled.
pub async fn run_status_report_sweep(
    master: &PgPool,
    tenants: &SweepTenants,
    sinks: &SweepSinks,
    now: OffsetDateTime,
) -> SweepResult {
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
    let result = run_sweep(
        master,
        STATUS_REPORT_KIND,
        now,
        SWEEP_LIMIT,
        Some(time::Duration::hours(RETRY_AFTER_HOURS)),
        |workspace_id, _now| {
            let tenants = Arc::clone(tenants);
            let sinks = sinks.clone();
            async move {
                let (db, org_id) = tenants(workspace_id).await?;
                sweep_status_reports(&db, &org_id, &sinks, now_ms).await
            }
        },
    )
    .await;
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            failed = result.failed,
            "[StatusReports] tick"
        );
    }
    result
}
