//! Approval reminders: the daily `approval_due` sweep
//! (`apps/workers/flow-api/src/cron/approval-reminders.ts`, FLOW-016), run by
//! `weldsuite cron flow-approval-due`. A day before a review is due its
//! approver is reminded, and once it is overdue the member who asked for it is
//! told, each once (`reminded_at`, `overdue_notified_at`).
//!
//! Only workspaces the `approval_due` due index lists (keyed by
//! `workspaces.id`) are opened (ADR DATA-008); whatever asks for approvals
//! marks them due ([`super::announce::mark_reminder_due`]). There is no
//! one-time seed: approvals only exist since the index does.

use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::FLOW_APPROVAL_OVERDUE;
use weldsuite_db::due_index::run_sweep;
use weldsuite_db::{PgPool, orm, orm_error, utc_timestamp};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_flow_domain::approval_views::approval_event_data;
use weldsuite_flow_domain::approvals::{ApprovalRow, is_step_active, list_subject_approvals};
use weldsuite_notifications::Notifier;
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, DynSystemMail};
use weldsuite_schema::tenant::flow_approvals as approvals;

use super::announce::{NoticeKind, NotifyBase, SubjectLabel, send_approval_notification};
use super::store::{approval_rows, at_millis, load_subject_info, project_names};

/// The due index kind.
pub const APPROVAL_DUE_KIND: &str = "approval_due";
const RETRY_AFTER: time::Duration = time::Duration::hours(6);
const ROWS_PER_TICK: u64 = 200;
const SWEEP_LIMIT: i64 = 200;
const DAY_MS: i64 = 86_400_000;

/// A due workspace's tenant database and its Clerk org id.
pub struct ApprovalTenant {
    pub db: PgPool,
    pub clerk_org_id: String,
}

/// Opens a workspace (`workspaces.id`) for the sweep.
pub type ApprovalTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<ApprovalTenant, String>> + Send + Sync>;

/// What an announcement goes out through.
#[derive(Clone)]
pub struct ApprovalSweepServices {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub mail: Option<Arc<dyn DynSystemMail>>,
}

/// One tick (`runApprovalReminders`'s result).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ApprovalSweepResult {
    pub due: usize,
    pub processed: usize,
    pub failed: usize,
    /// Always 0: there is no seed.
    pub seeded: usize,
    pub reminded: usize,
    pub overdue: usize,
}

impl ApprovalSweepResult {
    /// As TypeScript returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "due": self.due, "processed": self.processed, "failed": self.failed,
            "seeded": self.seeded, "reminded": self.reminded, "overdue": self.overdue,
        })
    }
}

async fn is_actionable(db: &PgPool, row: &ApprovalRow) -> Result<bool, DbErr> {
    Ok(is_step_active(
        row,
        &list_subject_approvals(db, &row.subject_type, &row.subject_id)
            .await
            .map_err(orm_error)?,
    ))
}

struct Labels {
    info: HashMap<String, super::store::SubjectInfo>,
    names: HashMap<String, String>,
}

impl Labels {
    async fn load(db: &PgPool, rows: &[ApprovalRow]) -> Result<Self, DbErr> {
        let info = load_subject_info(db, rows).await?;
        let mut ids: Vec<Option<String>> = rows.iter().map(|r| r.project_id.clone()).collect();
        ids.extend(info.values().map(|i| i.project_id.clone()));
        Ok(Self {
            names: project_names(db, &ids).await?,
            info,
        })
    }

    fn of(&self, row: &ApprovalRow) -> (SubjectLabel, Option<String>) {
        let subject = self
            .info
            .get(&format!("{}:{}", row.subject_type, row.subject_id));
        let project = row
            .project_id
            .clone()
            .or_else(|| subject.and_then(|s| s.project_id.clone()));
        (
            SubjectLabel {
                code: subject.and_then(|s| s.code.clone()),
                title: subject.map_or_else(|| row.subject_id.clone(), |s| s.title.clone()),
            },
            project.and_then(|p| self.names.get(&p).cloned()),
        )
    }
}

/// The pending live rows due by `until` that `unsent` (a notice not sent
/// yet) selects, soonest first, a tick's worth.
async fn rows(
    db: &PgPool,
    unsent: approvals::Column,
    due: Condition,
) -> Result<Vec<ApprovalRow>, DbErr> {
    let found = approvals::Entity::find()
        .filter(approvals::Column::Decision.eq("pending"))
        .filter(approvals::Column::DeletedAt.is_null())
        .filter(unsent.is_null())
        .filter(approvals::Column::DueAt.is_not_null())
        .filter(due)
        .order_by_asc(approvals::Column::DueAt)
        .order_by_asc(approvals::Column::Id)
        .limit(ROWS_PER_TICK)
        .all(&orm(db))
        .await?;
    approval_rows(found)
}

/// `sweepWorkspaceApprovals(env, db, orgId, now)`: `(reminded, overdue)`.
#[allow(clippy::too_many_lines)]
pub async fn sweep_workspace(
    services: &ApprovalSweepServices,
    db: &PgPool,
    org_id: &str,
    now: i64,
) -> Result<(usize, usize), DbErr> {
    let base = NotifyBase {
        db: db.clone(),
        notifier: Notifier {
            realtime: services.realtime.clone(),
            presence: None,
            mail: services.mail.clone(),
            http: None,
            apns: None,
        },
        org_id: org_id.to_owned(),
    };
    let (mut reminded, mut overdue) = (0, 0);
    let (now_at, soon_at) = (at_millis(now)?, at_millis(now + DAY_MS)?);

    let due_soon = rows(
        db,
        approvals::Column::RemindedAt,
        Condition::all()
            .add(approvals::Column::DueAt.lte(soon_at))
            .add(approvals::Column::DueAt.gt(now_at)),
    )
    .await?;
    if !due_soon.is_empty() {
        let labels = Labels::load(db, &due_soon).await?;
        for row in &due_soon {
            let sent = async {
                if row.approver_kind == "member" && is_actionable(db, row).await? {
                    let (label, project) = labels.of(row);
                    send_approval_notification(
                        &base,
                        &row.approver_id,
                        &row.id,
                        NoticeKind::Reminder,
                        &label,
                        None,
                        project.as_deref(),
                    )
                    .await;
                    reminded += 1;
                }
                approvals::Entity::update_many()
                    .col_expr(approvals::Column::RemindedAt, Expr::value(now_at))
                    .filter(approvals::Column::Id.eq(&row.id))
                    .exec(&orm(db))
                    .await?;
                Ok::<_, DbErr>(())
            }
            .await;
            if let Err(error) = sent {
                tracing::error!(%error, approval = %row.id, org_id, "[ApprovalDue] reminder failed");
            }
        }
    }

    let late = rows(
        db,
        approvals::Column::OverdueNotifiedAt,
        Condition::all().add(approvals::Column::DueAt.lte(now_at)),
    )
    .await?;
    if !late.is_empty() {
        let labels = Labels::load(db, &late).await?;
        let context = EventContext::new(org_id, "system", EventSource::System);
        for row in &late {
            let sent = async {
                if is_actionable(db, row).await? {
                    let (label, project) = labels.of(row);
                    send_approval_notification(
                        &base,
                        &row.created_by,
                        &row.id,
                        NoticeKind::Overdue,
                        &label,
                        None,
                        project.as_deref(),
                    )
                    .await;
                    services
                        .events
                        .publish_and_wait(
                            &context,
                            EntityEvent::new(
                                FLOW_APPROVAL_OVERDUE,
                                row.id.clone(),
                                approval_event_data(row),
                            ),
                        )
                        .await;
                    overdue += 1;
                }
                approvals::Entity::update_many()
                    .col_expr(approvals::Column::OverdueNotifiedAt, Expr::value(now_at))
                    .col_expr(
                        approvals::Column::RemindedAt,
                        Func::coalesce([
                            Expr::col((approvals::Entity, approvals::Column::RemindedAt)),
                            Expr::value(now_at),
                        ])
                        .into(),
                    )
                    .filter(approvals::Column::Id.eq(&row.id))
                    .exec(&orm(db))
                    .await?;
                Ok::<_, DbErr>(())
            }
            .await;
            if let Err(error) = sent {
                tracing::error!(%error, approval = %row.id, org_id, "[ApprovalDue] overdue notice failed");
            }
        }
    }
    Ok((reminded, overdue))
}

/// `nextApprovalDueAt`: when the workspace next has a reminder or overdue notice (None: none).
///
/// `min(case when reminded_at is null then due_at - 1 day else due_at end)`,
/// as the earliest due date of each kind, worked out here; to the
/// millisecond, as JavaScript read it back.
pub async fn next_due_at(db: &PgPool) -> Result<Option<OffsetDateTime>, DbErr> {
    let earliest = |reminded: Expr| {
        Expr::from(Func::min(Expr::case(
            reminded,
            Expr::col((approvals::Entity, approvals::Column::DueAt)),
        )))
    };
    let due: Option<(Option<OffsetDateTime>, Option<OffsetDateTime>)> = approvals::Entity::find()
        .select_only()
        .column_as(
            earliest(approvals::Column::RemindedAt.is_null()),
            "unreminded",
        )
        .column_as(
            earliest(approvals::Column::RemindedAt.is_not_null()),
            "reminded",
        )
        .filter(approvals::Column::Decision.eq("pending"))
        .filter(approvals::Column::DeletedAt.is_null())
        .filter(approvals::Column::DueAt.is_not_null())
        .filter(approvals::Column::OverdueNotifiedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (to_remind, to_flag) = due.unwrap_or_default();
    let reminder = to_remind.map(|at| at - time::Duration::DAY);
    let next = match (reminder, to_flag) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    Ok(next.map(|at| utc_timestamp(at).assume_utc()))
}

/// `runApprovalReminders(env, now)`: one tick.
pub async fn run_approval_reminders(
    master: &PgPool,
    tenants: &ApprovalTenants,
    services: &ApprovalSweepServices,
    now: OffsetDateTime,
) -> ApprovalSweepResult {
    let totals = std::sync::Mutex::new((0usize, 0usize));
    let swept = run_sweep(
        master,
        APPROVAL_DUE_KIND,
        now,
        SWEEP_LIMIT,
        Some(RETRY_AFTER),
        |workspace_id, at| {
            let tenants = Arc::clone(tenants);
            let totals = &totals;
            async move {
                let tenant = tenants(workspace_id).await?;
                let at = i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
                let (reminded, overdue) =
                    sweep_workspace(services, &tenant.db, &tenant.clerk_org_id, at)
                        .await
                        .map_err(|error| error.to_string())?;
                if let Ok(mut totals) = totals.lock() {
                    totals.0 += reminded;
                    totals.1 += overdue;
                }
                next_due_at(&tenant.db)
                    .await
                    .map_err(|error| error.to_string())
            }
        },
    )
    .await;
    let (reminded, overdue) = totals.into_inner().unwrap_or_default();
    let result = ApprovalSweepResult {
        due: swept.due,
        processed: swept.processed,
        failed: swept.failed,
        seeded: 0,
        reminded,
        overdue,
    };
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            failed = result.failed,
            reminded,
            overdue,
            "[ApprovalDue] swept"
        );
    }
    result
}
