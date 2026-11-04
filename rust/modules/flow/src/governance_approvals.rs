//! The approvals the governance registers ask for: proposed decisions (rule
//! `decision`) and deliverable sign-off (rules `deliverable_sponsor` and
//! `deliverable_client`), FLOW-016. The approvals core is slice A's
//! (`weldsuite_flow_domain::approvals`); this file is slice B's use of it:
//!
//! - the two subject handlers ([`DecisionHandler`], [`DeliverableHandler`],
//!   registered from the routers' constructors; `services/project-decisions.ts`
//!   and `project-deliverables.ts`),
//! - the `flow_approval` event payload and the two publishers every slice that
//!   asks for approvals uses (`services/governance-approvals.ts`),
//! - [`publish_approval_subject_resolved`], for the route that answers a review
//!   (slice A's `decide`): the subject's own event once its approvals settled it.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    FLOW_APPROVAL_CANCELLED, FLOW_APPROVAL_REQUESTED, PROJECT_DECISION_DECIDED,
    PROJECT_DELIVERABLE_ACCEPTED, PROJECT_DELIVERABLE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalSubjectHandler,
    ResolvedApprovalOutcome, register_approval_subject,
};
use weldsuite_flow_domain::decisions::{decision_event_data, decision_resolution};
use weldsuite_flow_domain::deliverables::{
    DeliverableResolution, SignoffRow, deliverable_event_data, deliverable_resolution,
};
use weldsuite_flow_domain::js::iso_from_millis;

use crate::{Caller, FlowState};

fn iso(millis: i64) -> String {
    iso_from_millis(millis).unwrap_or_default()
}

fn iso_field(millis: Option<i64>) -> Value {
    millis
        .and_then(iso_from_millis)
        .map_or(Value::Null, Value::String)
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

/// Plug the governance subjects into the approvals registry; called from the
/// routers' constructors.
pub(crate) fn register_decision_subject() {
    register_approval_subject("decision", Arc::new(DecisionHandler));
}

pub(crate) fn register_deliverable_subject() {
    register_approval_subject("deliverable", Arc::new(DeliverableHandler));
}

/// `approvalEventData(row)`: who is asked, for what, in which step.
pub(crate) fn approval_event_data(row: &ApprovalRow) -> Value {
    json!({
        "id": row.id,
        "projectId": row.project_id,
        "subjectType": row.subject_type,
        "subjectId": row.subject_id,
        "approverKind": row.approver_kind,
        "approverId": row.approver_id,
        "step": row.step,
        "decision": row.decision,
        "dueAt": iso_field(row.due_at),
    })
}

/// `publishRequested(c, rows)`: one `flow_approval.requested` event per row,
/// in step order.
pub(crate) fn publish_requested(state: &FlowState, caller: &Caller, rows: &[ApprovalRow]) {
    for row in rows {
        caller.publish(
            state,
            FLOW_APPROVAL_REQUESTED,
            &row.id,
            &approval_event_data(row),
        );
    }
}

/// `publishCancelled(c, rows)`: one `flow_approval.cancelled` event per
/// cleared row.
pub(crate) fn publish_cancelled(state: &FlowState, caller: &Caller, rows: &[ApprovalRow]) {
    for row in rows {
        caller.publish(
            state,
            FLOW_APPROVAL_CANCELLED,
            &row.id,
            &approval_event_data(row),
        );
    }
}

/// `publishApprovalSubjectResolved(c, db, subjectType, subjectId)`: the
/// subject's own event once its approvals settled it. For the route that
/// answers a review (slice A's `decide`), after `decide_approval` answered with
/// `resolved`; a subject type that is not a governance register is ignored.
#[allow(dead_code)]
pub(crate) async fn publish_approval_subject_resolved(
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
