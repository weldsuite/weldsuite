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

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::FLOW_APPROVAL_OVERDUE;
use weldsuite_db::due_index::run_sweep;
use weldsuite_db::js_row;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_flow_domain::approval_views::approval_event_data;
use weldsuite_flow_domain::approvals::{ApprovalRow, is_step_active, list_subject_approvals};
use weldsuite_notifications::Notifier;
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, DynSystemMail};

use super::announce::{NoticeKind, NotifyBase, SubjectLabel, send_approval_notification};
use super::store::{load_subject_info, project_names};

/// The due index kind.
pub const APPROVAL_DUE_KIND: &str = "approval_due";
const RETRY_AFTER: time::Duration = time::Duration::hours(6);
const ROWS_PER_TICK: i64 = 200;
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

fn iso(ms: i64) -> String {
    weldsuite_flow_domain::js::iso_from_millis(ms).unwrap_or_default()
}

async fn is_actionable(db: &PgPool, row: &ApprovalRow) -> Result<bool, sqlx::Error> {
    Ok(is_step_active(
        row,
        &list_subject_approvals(db, &row.subject_type, &row.subject_id).await?,
    ))
}

struct Labels {
    info: HashMap<String, super::store::SubjectInfo>,
    names: HashMap<String, String>,
}

impl Labels {
    async fn load(db: &PgPool, rows: &[ApprovalRow]) -> Result<Self, sqlx::Error> {
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

async fn rows(
    db: &PgPool,
    sql: &'static str,
    bind_a: &str,
    bind_b: Option<&str>,
) -> Result<Vec<ApprovalRow>, sqlx::Error> {
    let found: Vec<Value> = sqlx::query_scalar(sql)
        .bind(bind_a)
        .bind(bind_b)
        .bind(ROWS_PER_TICK)
        .fetch_all(db)
        .await?;
    Ok(found
        .into_iter()
        .filter_map(|v| ApprovalRow::from_json(&js_row(v)))
        .collect())
}

/// `sweepWorkspaceApprovals(env, db, orgId, now)`: `(reminded, overdue)`.
#[allow(clippy::too_many_lines)]
pub async fn sweep_workspace(
    services: &ApprovalSweepServices,
    db: &PgPool,
    org_id: &str,
    now: i64,
) -> Result<(usize, usize), sqlx::Error> {
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
    let (now_iso, soon_iso) = (iso(now), iso(now + DAY_MS));

    let due_soon = rows(
        db,
        "select to_jsonb(a) from flow_approvals a
         where a.decision = 'pending' and a.deleted_at is null and a.reminded_at is null
           and a.due_at is not null and a.due_at <= $2::timestamptz and a.due_at > $1::timestamptz
         order by a.due_at asc, a.id asc limit $3",
        &now_iso,
        Some(&soon_iso),
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
                sqlx::query(
                    "update flow_approvals set reminded_at = $2::timestamptz where id = $1",
                )
                .bind(&row.id)
                .bind(&now_iso)
                .execute(db)
                .await?;
                Ok::<_, sqlx::Error>(())
            }
            .await;
            if let Err(error) = sent {
                tracing::error!(%error, approval = %row.id, org_id, "[ApprovalDue] reminder failed");
            }
        }
    }

    let late = rows(
        db,
        "select to_jsonb(a) from flow_approvals a
         where a.decision = 'pending' and a.deleted_at is null and a.overdue_notified_at is null
           and a.due_at is not null and a.due_at <= $1::timestamptz and $2::text is null
         order by a.due_at asc, a.id asc limit $3",
        &now_iso,
        None,
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
                sqlx::query(
                    "update flow_approvals set overdue_notified_at = $2::timestamptz,
                         reminded_at = coalesce(reminded_at, $2::timestamptz) where id = $1",
                )
                .bind(&row.id)
                .bind(&now_iso)
                .execute(db)
                .await?;
                Ok::<_, sqlx::Error>(())
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
pub async fn next_due_at(db: &PgPool) -> Result<Option<OffsetDateTime>, sqlx::Error> {
    let next: Option<String> = sqlx::query_scalar(
        "select to_jsonb(min(case when reminded_at is null then due_at - interval '1 day' else due_at end)) #>> '{}'
         from flow_approvals
         where decision = 'pending' and deleted_at is null and due_at is not null and overdue_notified_at is null",
    )
    .fetch_one(db)
    .await?;
    Ok(next
        .as_deref()
        .and_then(weldsuite_db::js_timestamp)
        .and_then(|at| {
            OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339).ok()
        }))
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
