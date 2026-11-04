//! The approvals the governance registers ask for: proposed decisions (rule
//! `decision`) and deliverable sign-off (rules `deliverable_sponsor` and
//! `deliverable_client`), FLOW-016. The approvals core is slice A's
//! (`weldsuite_flow_domain::approvals`); this file is slice B's use of it:
//!
//! - the two subject handlers ([`DecisionHandler`], [`DeliverableHandler`],
//!   registered from the routers' constructors; `services/project-decisions.ts`
//!   and `project-deliverables.ts`),
//! - the aftermath (registered with the handlers): once `/decide` settles a
//!   subject, `publish_approval_subject_resolved` publishes its own event.
//!
//! Asking and cancelling go through the approvals core (`announce`), so the
//! `flow_approval` events are one payload for every slice.

use std::sync::Arc;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    PROJECT_DECISION_DECIDED, PROJECT_DELIVERABLE_ACCEPTED, PROJECT_DELIVERABLE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalSubjectHandler,
    ResolvedApprovalOutcome, register_approval_subject,
};
use weldsuite_flow_domain::decisions::{decision_code, decision_event_data, decision_resolution};
use weldsuite_flow_domain::deliverables::{
    DeliverableResolution, SignoffRow, deliverable_code, deliverable_event_data,
    deliverable_resolution,
};
use weldsuite_flow_domain::js::iso_from_millis;

use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_requested, register_aftermath,
};
use crate::approvals::store::project_names;
use crate::{Caller, FlowState};

fn iso(millis: i64) -> String {
    iso_from_millis(millis).unwrap_or_default()
}

/// A live decision row by id, as Drizzle reads it.
async fn decision_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_decisions d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// A live deliverable row by id, as Drizzle reads it.
async fn deliverable_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_deliverables d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The `decision` subject: a named decider's approval makes the decision
/// decided (by whoever answered, the decider or their delegate); a rejection
/// leaves it proposed, with the note on the approval row. Idempotent
/// (`services/project-decisions.ts`).
pub(crate) struct DecisionHandler;

impl ApprovalSubjectHandler for DecisionHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move {
            let Some(row) = decision_row(db, subject_id).await? else {
                return Ok(());
            };
            if row["status"] != "proposed" {
                return Ok(());
            }
            let resolution = decision_resolution(
                outcome == ResolvedApprovalOutcome::Approved,
                context.actor.as_ref().map(|actor| actor.id.as_str()),
                row["deciderId"].as_str(),
                context.now_ms,
            );
            let Some(resolution) = resolution else {
                return Ok(());
            };
            sqlx::query(
                "update project_decisions set status = 'decided', decided_by = $2,
                        decided_at = $3::timestamptz, updated_at = $4::timestamptz
                 where id = $1 and status = 'proposed' and deleted_at is null",
            )
            .bind(subject_id)
            .bind(resolution.decided_by)
            .bind(iso(resolution.decided_at_ms))
            .bind(iso(context.now_ms))
            .execute(db)
            .await?;
            Ok(())
        })
    }
}

/// The `deliverable` subject: a full sign-off accepts the deliverable, a
/// rejection rejects it. Idempotent (`services/project-deliverables.ts`).
pub(crate) struct DeliverableHandler;

impl ApprovalSubjectHandler for DeliverableHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move {
            let Some(row) = deliverable_row(db, subject_id).await? else {
                return Ok(());
            };
            if row["status"] == "accepted" {
                return Ok(());
            }
            let rows: Vec<SignoffRow<'_>> = context
                .rows
                .iter()
                .map(|row| SignoffRow {
                    decided_by: row.decided_by.as_deref(),
                    decision: row.decision.as_str(),
                    step: row.step,
                })
                .collect();
            let resolution = deliverable_resolution(
                outcome == ResolvedApprovalOutcome::Approved,
                context.actor.as_ref().map(|actor| actor.id.as_str()),
                &rows,
                context.now_ms,
            );
            match resolution {
                DeliverableResolution::Accepted {
                    accepted_by,
                    accepted_at_ms,
                } => {
                    sqlx::query(
                        "update project_deliverables set status = 'accepted', accepted_by = $2,
                                accepted_at = $3::timestamptz, updated_at = $4::timestamptz
                         where id = $1 and status <> 'accepted' and deleted_at is null",
                    )
                    .bind(subject_id)
                    .bind(accepted_by)
                    .bind(iso(accepted_at_ms))
                    .bind(iso(context.now_ms))
                    .execute(db)
                    .await?;
                }
                DeliverableResolution::Rejected => {
                    if row["status"] != "rejected" {
                        sqlx::query(
                            "update project_deliverables set status = 'rejected',
                                    updated_at = $2::timestamptz
                             where id = $1 and status <> 'accepted' and deleted_at is null",
                        )
                        .bind(subject_id)
                        .bind(iso(context.now_ms))
                        .execute(db)
                        .await?;
                    }
                }
            }
            Ok(())
        })
    }
}

/// Plug the governance subjects into the approvals registry (handler and
/// aftermath); called from the routers' constructors.
pub(crate) fn register_decision_subject() {
    register_approval_subject("decision", Arc::new(DecisionHandler));
    register_aftermath("decision", aftermath);
}

pub(crate) fn register_deliverable_subject() {
    register_approval_subject("deliverable", Arc::new(DeliverableHandler));
    register_aftermath("deliverable", aftermath);
}

/// The aftermath of both governance types: the subject's own event once the
/// answer settled it.
fn aftermath<'a>(
    state: &'a FlowState,
    caller: &'a Caller,
    info: &'a AftermathInfo,
) -> AftermathFuture<'a> {
    Box::pin(async move {
        let subject_type = info.decided.subject_type.as_str();
        publish_approval_subject_resolved(state, caller, subject_type, &info.subject_id).await
    })
}

/// Tell the world that `rows` were asked about a decision
/// (`announceApprovalsRequested` with the decision's code and title).
pub(crate) async fn announce_decision_asked(
    state: &FlowState,
    caller: &Caller,
    row: &Value,
    rows: &[ApprovalRow],
) -> Result<(), sqlx::Error> {
    let code = decision_code(row["number"].as_i64().unwrap_or_default());
    announce_asked(state, caller, row, rows, code).await
}

/// The same for a deliverable's sign-off.
pub(crate) async fn announce_deliverable_asked(
    state: &FlowState,
    caller: &Caller,
    row: &Value,
    rows: &[ApprovalRow],
) -> Result<(), sqlx::Error> {
    let code = deliverable_code(row["number"].as_i64().unwrap_or_default());
    announce_asked(state, caller, row, rows, code).await
}

async fn announce_asked(
    state: &FlowState,
    caller: &Caller,
    row: &Value,
    rows: &[ApprovalRow],
    code: String,
) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let project_id = row["projectId"].as_str().map(str::to_owned);
    let names = project_names(&caller.db, std::slice::from_ref(&project_id)).await?;
    announce_approvals_requested(
        state,
        caller,
        rows,
        &SubjectLabel {
            code: Some(code),
            title: row["title"].as_str().unwrap_or_default().to_owned(),
        },
        project_id.and_then(|id| names.get(&id).cloned()).as_deref(),
    );
    Ok(())
}

/// `publishApprovalSubjectResolved(c, db, subjectType, subjectId)`: the
/// subject's own event once its approvals settled it; a subject type that is
/// not a governance register is ignored.
async fn publish_approval_subject_resolved(
    state: &FlowState,
    caller: &Caller,
    subject_type: &str,
    subject_id: &str,
) -> Result<(), sqlx::Error> {
    if subject_type == "decision" {
        if let Some(row) = decision_row(&caller.db, subject_id).await?
            && row["status"] == "decided"
        {
            caller.publish(
                state,
                PROJECT_DECISION_DECIDED,
                subject_id,
                &decision_event_data(&row),
            );
        }
    } else if subject_type == "deliverable"
        && let Some(row) = deliverable_row(&caller.db, subject_id).await?
    {
        let event = match row["status"].as_str() {
            Some("accepted") => Some(PROJECT_DELIVERABLE_ACCEPTED),
            Some("rejected") => Some(PROJECT_DELIVERABLE_UPDATED),
            _ => None,
        };
        if let Some(event) = event {
            caller.publish(state, event, subject_id, &deliverable_event_data(&row));
        }
    }
    Ok(())
}
