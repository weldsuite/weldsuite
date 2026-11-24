//! The WeldDesk report schedule sweep
//! (`apps/workers/desk-api/src/cron/report-schedule-sweep.ts`), run every
//! minute by `weldsuite cron desk-report-sweep`.
//!
//! Sends the scheduled report emails that came due
//! (`helpdesk_report_schedules`, TASK-1228). It never wakes idle tenant
//! databases (ADR DATA-008): every write to a schedule marks the workspace in
//! the due index (kind `desk_report`, keyed by `workspaces.id`) at the
//! schedule's next run; each tick lists the index, opens the workspaces that
//! are due, sends their due schedules and stores when the workspace is next
//! due (or drops the row when no enabled schedule is left). Global's one-time
//! seed has nothing to add (nothing existed before the index), so there is
//! none.
//!
//! Bounds per tick: at most [`WORKSPACES_PER_TICK`] workspaces,
//! [`SCHEDULES_PER_WORKSPACE`] schedules in each, and [`SCHEDULES_PER_TICK`]
//! sends in all. Whatever does not fit stays due and goes out on the next
//! tick.
//!
//! A schedule is claimed (its `next_run_at` moved to the next slot) before it
//! is sent, so two overlapping ticks never send it twice and a failing one is
//! not retried in a loop: the next attempt is the next scheduled slot.

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::due_index::{list_due, settle};
use weldsuite_db::{PgPool, orm};
use weldsuite_desk_domain::report_schedule::{DUE_KIND, next_report_run};
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_ports::DynCache;
use weldsuite_schema::tenant::helpdesk_report_schedules::{self, Column};

use crate::settings::report_mail::{Mailer, SendOutcome, outbound_of, send_scheduled_report};
use crate::settings::schedules::{ScheduleRow, record_run};
use crate::sla_sweep::SlaTenants;

/// A workspace that failed (a database hiccup, a broken tenant) is retried after this.
const RETRY_AFTER: time::Duration = time::Duration::minutes(10);
const WORKSPACES_PER_TICK: i64 = 50;
const SCHEDULES_PER_WORKSPACE: usize = 20;
const SCHEDULES_PER_TICK: usize = 60;

/// What a schedule's `lastError` says when its saved report was deleted
/// (`REPORT_GONE_MESSAGE`).
const REPORT_GONE_MESSAGE: &str = "The saved report was deleted, so this schedule was turned off.";

/// What a report goes out through, and what its link is built from.
#[derive(Clone)]
pub struct ReportSweepServices {
    /// The relay (`SEND_EMAIL`) and the outbound guard's ledgers.
    pub outbound: OutboundBindings,
    /// For the outbound guard (the workspace's ledger key).
    pub master: Option<PgPool>,
    /// For the outbound guard's per-workspace counters.
    pub cache: Option<Arc<dyn DynCache>>,
    /// `ENVIRONMENT`.
    pub environment: Option<String>,
    /// `PUBLIC_APP_URL`: where the report link opens.
    pub public_app_url: Option<String>,
    /// `SYSTEM_EMAIL_FROM`.
    pub from_override: Option<String>,
}

/// One tick (`runReportScheduleSweep`'s result).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReportSweepResult {
    pub due: usize,
    pub processed: usize,
    /// Workspaces that failed.
    pub failed: usize,
    /// Always 0: there is no seed (see the module docs).
    pub seeded: usize,
    pub sent: usize,
    pub send_failed: usize,
    pub disabled: usize,
}

impl ReportSweepResult {
    /// As TypeScript returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "due": self.due,
            "processed": self.processed,
            "failed": self.failed,
            "seeded": self.seeded,
            "sent": self.sent,
            "sendFailed": self.send_failed,
            "disabled": self.disabled,
        })
    }

    fn handled(&self) -> usize {
        self.sent + self.send_failed + self.disabled
    }
}

/// `WorkspaceReportSweep`.
#[derive(Debug, Default)]
struct WorkspaceSweep {
    sent: usize,
    failed: usize,
    disabled: usize,
    /// When the workspace next has a schedule due (`None`: none enabled).
    next: Option<OffsetDateTime>,
}

/// A JavaScript time (milliseconds) as a `timestamp` column holds it.
fn report_stamp(ms: i64) -> PrimitiveDateTime {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_db::utc_timestamp(at)
}

/// `sweepWorkspaceReports(env, db, orgId, now, { limit })`: send one
/// workspace's due schedules and answer when it next has one due.
async fn sweep_workspace(
    mailer: &Mailer,
    now: i64,
    limit: usize,
) -> Result<WorkspaceSweep, String> {
    let db = &mailer.db;
    let failed = |error: DbErr| error.to_string();
    let mut result = WorkspaceSweep::default();
    let now_stamp = report_stamp(now);

    let due = helpdesk_report_schedules::Entity::find()
        .filter(Column::Enabled.eq(true))
        .filter(Column::NextRunAt.is_not_null())
        .filter(Column::NextRunAt.lte(now_stamp))
        .order_by_asc(Column::NextRunAt)
        .limit(u64::try_from(limit).unwrap_or(u64::MAX))
        .all(&orm(db))
        .await
        .map_err(failed)?;

    for schedule in due.into_iter().map(ScheduleRow::from_model) {
        let timing = schedule
            .timing()
            .ok_or_else(|| format!("unknown frequency {}", schedule.frequency))?;
        // Claim the slot: only the tick that moves `next_run_at` off the value it read sends.
        let next = next_report_run(&timing, now)?;
        let claimed = helpdesk_report_schedules::Entity::update_many()
            .col_expr(Column::NextRunAt, Expr::value(report_stamp(next)))
            .filter(Column::Id.eq(&schedule.id))
            .filter(Column::NextRunAt.eq(schedule.next_run_at))
            .exec(&orm(db))
            .await
            .map_err(failed)?;
        if claimed.rows_affected == 0 {
            continue;
        }

        match send_scheduled_report(mailer, &schedule, now).await {
            SendOutcome::Gone => {
                helpdesk_report_schedules::Entity::update_many()
                    .col_expr(Column::Enabled, Expr::value(false))
                    .col_expr(Column::NextRunAt, Expr::value(None::<PrimitiveDateTime>))
                    .col_expr(Column::LastRunAt, Expr::value(now_stamp))
                    .col_expr(Column::LastStatus, Expr::value("failed"))
                    .col_expr(Column::LastError, Expr::value(REPORT_GONE_MESSAGE))
                    .filter(Column::Id.eq(&schedule.id))
                    .exec(&orm(db))
                    .await
                    .map_err(failed)?;
                result.disabled += 1;
            }
            SendOutcome::Sent => {
                record_run(db, &schedule.id, now, "sent", None)
                    .await
                    .map_err(|error| error.to_string())?;
                result.sent += 1;
            }
            SendOutcome::Failed(error) => {
                record_run(db, &schedule.id, now, "failed", Some(&error))
                    .await
                    .map_err(|error| error.to_string())?;
                result.failed += 1;
            }
        }
    }

    let earliest: Option<Option<PrimitiveDateTime>> = helpdesk_report_schedules::Entity::find()
        .select_only()
        .column_as(Column::NextRunAt.min(), "earliest")
        .filter(Column::Enabled.eq(true))
        .filter(Column::NextRunAt.is_not_null())
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(failed)?;
    // To the millisecond, as the TypeScript sweep reads it.
    result.next = earliest
        .flatten()
        .map(|at| weldsuite_db::utc_timestamp(at.assume_utc()).assume_utc());
    Ok(result)
}

/// `runReportScheduleSweep(env, now)`: one tick.
pub async fn run_report_sweep(
    master: &PgPool,
    tenants: &SlaTenants,
    services: &ReportSweepServices,
    now: OffsetDateTime,
) -> ReportSweepResult {
    let mut result = ReportSweepResult::default();
    let rows = match list_due(master, DUE_KIND, now, WORKSPACES_PER_TICK).await {
        Ok(rows) => rows,
        Err(error) => {
            // Deliberately no fallback to a tenant fan-out: skip this tick instead.
            tracing::error!(%error, "[DeskReports] due index unavailable; skipping tick");
            return result;
        }
    };
    result.due = rows.len();
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();

    for row in rows {
        if result.handled() >= SCHEDULES_PER_TICK {
            break;
        }
        let swept = async {
            let tenant = tenants(row.workspace_id.clone()).await?;
            let mailer = Mailer {
                db: tenant.db,
                clerk_org_id: tenant.clerk_org_id,
                outbound: outbound_of(
                    &services.outbound,
                    services.master.clone(),
                    services.cache.clone(),
                ),
                environment: services.environment.clone(),
                public_app_url: services.public_app_url.clone(),
                from_override: services.from_override.clone(),
            };
            let limit = SCHEDULES_PER_WORKSPACE.min(SCHEDULES_PER_TICK - result.handled());
            sweep_workspace(&mailer, now_ms, limit).await
        }
        .await;
        let stored = match swept {
            Ok(swept) => {
                result.processed += 1;
                result.sent += swept.sent;
                result.send_failed += swept.failed;
                result.disabled += swept.disabled;
                settle(master, DUE_KIND, &row, swept.next).await
            }
            Err(error) => {
                result.failed += 1;
                tracing::error!(%error, workspace_id = row.workspace_id, "[DeskReports] workspace failed");
                settle(master, DUE_KIND, &row, Some(now + RETRY_AFTER)).await
            }
        };
        if let Err(error) = stored {
            tracing::warn!(%error, workspace_id = row.workspace_id, "[DeskReports] due index: settle failed");
        }
    }

    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            sent = result.sent,
            send_failed = result.send_failed,
            disabled = result.disabled,
            workspace_failures = result.failed,
            "[DeskReports] swept"
        );
    }
    result
}
