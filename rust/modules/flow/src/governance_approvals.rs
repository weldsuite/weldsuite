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

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_DECISION_DECIDED, PROJECT_DELIVERABLE_ACCEPTED, PROJECT_DELIVERABLE_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalSubjectHandler,
    ResolvedApprovalOutcome, register_approval_subject,
};
use weldsuite_flow_domain::decisions::{decision_code, decision_event_data, decision_resolution};
use weldsuite_flow_domain::deliverables::{
    DeliverableResolution, SignoffRow, deliverable_code, deliverable_event_data,
    deliverable_resolution,
};
use weldsuite_schema::tenant::{
    project_decisions as decisions, project_deliverables as deliverables,
};

use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_requested, register_aftermath,
};
use crate::approvals::store::project_names;
use crate::governance_store::{find_decision, find_deliverable};
use crate::orm_bridge::sqlx_error;
use crate::{Caller, FlowState};

/// A moment in epoch milliseconds, as the `timestamptz` it is written as.
fn at(millis: i64) -> Result<OffsetDateTime, DbErr> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map_err(|error| DbErr::Type(error.to_string()))
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
            settle_decision(db, subject_id, outcome, context)
                .await
                .map_err(sqlx_error)
        })
    }
}

async fn settle_decision(
    db: &PgPool,
    subject_id: &str,
    outcome: ResolvedApprovalOutcome,
    context: &ApprovalResolutionContext,
) -> Result<(), DbErr> {
    let Some(row) = find_decision(db, subject_id).await? else {
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
    decisions::Entity::update_many()
        .col_expr(decisions::Column::Status, Expr::value("decided"))
        .col_expr(
            decisions::Column::DecidedBy,
            Expr::value(resolution.decided_by),
        )
        .col_expr(
            decisions::Column::DecidedAt,
            Expr::value(at(resolution.decided_at_ms)?),
        )
        .col_expr(
            decisions::Column::UpdatedAt,
            Expr::value(at(context.now_ms)?),
        )
        .filter(decisions::Column::Id.eq(subject_id))
        .filter(decisions::Column::Status.eq("proposed"))
        .filter(decisions::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
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
            settle_deliverable(db, subject_id, outcome, context)
                .await
                .map_err(sqlx_error)
        })
    }
}

async fn settle_deliverable(
    db: &PgPool,
    subject_id: &str,
    outcome: ResolvedApprovalOutcome,
    context: &ApprovalResolutionContext,
) -> Result<(), DbErr> {
    let Some(row) = find_deliverable(db, subject_id).await? else {
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
    let live = deliverables::Entity::update_many()
        .filter(deliverables::Column::Id.eq(subject_id))
        .filter(deliverables::Column::Status.ne("accepted"))
        .filter(deliverables::Column::DeletedAt.is_null());
    match resolution {
        DeliverableResolution::Accepted {
            accepted_by,
            accepted_at_ms,
        } => {
            live.col_expr(deliverables::Column::Status, Expr::value("accepted"))
                .col_expr(deliverables::Column::AcceptedBy, Expr::value(accepted_by))
                .col_expr(
                    deliverables::Column::AcceptedAt,
                    Expr::value(at(accepted_at_ms)?),
                )
                .col_expr(
                    deliverables::Column::UpdatedAt,
                    Expr::value(at(context.now_ms)?),
                )
                .exec(&orm(db))
                .await?;
        }
        DeliverableResolution::Rejected => {
            if row["status"] != "rejected" {
                live.col_expr(deliverables::Column::Status, Expr::value("rejected"))
                    .col_expr(
                        deliverables::Column::UpdatedAt,
                        Expr::value(at(context.now_ms)?),
                    )
                    .exec(&orm(db))
                    .await?;
            }
        }
    }
    Ok(())
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
) -> Result<(), DbErr> {
    let code = decision_code(row["number"].as_i64().unwrap_or_default());
    announce_asked(state, caller, row, rows, code).await
}

/// The same for a deliverable's sign-off.
pub(crate) async fn announce_deliverable_asked(
    state: &FlowState,
    caller: &Caller,
    row: &Value,
    rows: &[ApprovalRow],
) -> Result<(), DbErr> {
    let code = deliverable_code(row["number"].as_i64().unwrap_or_default());
    announce_asked(state, caller, row, rows, code).await
}

async fn announce_asked(
    state: &FlowState,
    caller: &Caller,
    row: &Value,
    rows: &[ApprovalRow],
    code: String,
) -> Result<(), DbErr> {
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
) -> Result<(), DbErr> {
    if subject_type == "decision" {
        if let Some(row) = find_decision(&caller.db, subject_id).await?
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
        && let Some(row) = find_deliverable(&caller.db, subject_id).await?
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
