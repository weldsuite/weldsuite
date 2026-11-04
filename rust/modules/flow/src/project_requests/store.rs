//! Project intake queries (`services/project-requests.ts`): the rows of
//! requests, approvals and the workspace settings as Drizzle reads them, the
//! approval outcome of a request (the `project_request` approval subject), and
//! the board's approval rows, asked for through the approvals core
//! (`weldsuite_flow_domain::approvals`).

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalRowInput,
    ApprovalSubjectHandler, RequestApprovalsInput, RequestApprovalsResult, ResolvedApprovalOutcome,
    cancel_pending_approvals, list_subject_approvals as core_list_subject_approvals,
    register_approval_subject, request_approvals as core_request_approvals,
};
use weldsuite_flow_domain::intake::{Criterion, default_scoring_model, model_from_json};
use weldsuite_flow_domain::js::iso_from_millis;

use crate::approvals::announce::{Aftermath, register_aftermath};

/// A `project_requests` row.
macro_rules! request_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('estimated_cost', ",
            $a,
            ".estimated_cost::text, 'estimated_value', ",
            $a,
            ".estimated_value::text, 'score', ",
            $a,
            ".score::text))"
        )
    };
}

/// A `flow_workspace_settings` row.
macro_rules! settings_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('expense_approval_limit', ",
            $a,
            ".expense_approval_limit::text))"
        )
    };
}

pub(crate) use request_json;

/// `findProjectRequest(db, id)`: a live request.
pub(crate) async fn find_project_request(
    db: &PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        request_json!("t"),
        " from project_requests t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `loadSettings(db)`: the workspace's intake settings, or `None` before it saves any.
pub(crate) async fn load_settings(db: &PgPool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        settings_json!("s"),
        " from flow_workspace_settings s limit 1"
    ))
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `modelOf(settings)`: the scoring model in force, the workspace's or the default one.
pub(crate) fn model_of(settings: Option<&Value>) -> Vec<Criterion> {
    match settings {
        Some(row) => model_from_json(row.get("scoringModel")),
        None => default_scoring_model(),
    }
}

/// `boardOf(settings)`: the portfolio board, the members who approve a request.
pub(crate) fn board_of(settings: Option<&Value>) -> Vec<String> {
    settings
        .and_then(|row| row.get("portfolioBoardIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// A request's live approval rows, in step order (`listSubjectApprovals`).
pub(crate) async fn list_subject_approvals(
    db: &PgPool,
    subject_id: &str,
) -> Result<Vec<ApprovalRow>, sqlx::Error> {
    core_list_subject_approvals(db, "project_request", subject_id).await
}

/// What the board decided on a project request (`settleProjectRequest`): an
/// assessing request becomes `approved` or `rejected`.
struct RequestHandler;

impl ApprovalSubjectHandler for RequestHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(settle_project_request(
            db,
            subject_id,
            outcome,
            context.now_ms,
        ))
    }
}

/// `settleProjectRequest(db, requestId, outcome, now)`: settle a request under
/// assessment as the board decided. Only an assessing request moves, so
/// running it again changes nothing.
async fn settle_project_request(
    db: &PgPool,
    request_id: &str,
    outcome: ResolvedApprovalOutcome,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update project_requests set status = $2, updated_at = $3::timestamptz
         where id = $1 and status = 'assessing' and deleted_at is null",
    )
    .bind(request_id)
    .bind(outcome.as_str())
    .bind(iso_from_millis(now_ms))
    .execute(db)
    .await?;
    Ok(())
}

/// Plug the `project_request` subject into the approvals registry: its
/// handler, and the aftermath that publishes the outcome.
pub(crate) fn register_subject(aftermath: Aftermath) {
    register_approval_subject("project_request", Arc::new(RequestHandler));
    register_aftermath("project_request", aftermath);
}

/// `requestApprovals(db, ...)` for a project request: one row per board
/// member (step 1, rule `project_request`, no due date), through the approvals
/// core. A refusal is an error: the caller rolls the submit back.
pub(crate) async fn request_approvals(
    db: &PgPool,
    subject_id: &str,
    requested_by: &str,
    board: &[String],
    now_ms: i64,
) -> Result<Vec<ApprovalRow>, sqlx::Error> {
    let result = core_request_approvals(
        db,
        &RequestApprovalsInput {
            project_id: None,
            subject_type: "project_request".to_owned(),
            subject_id: subject_id.to_owned(),
            requested_by: requested_by.to_owned(),
            rows: board
                .iter()
                .map(|member| {
                    ApprovalRowInput::member(member.clone(), "project_request")
                        .with_role_label("Portfolio board")
                        .with_step(1)
                })
                .collect(),
            now_ms,
        },
    )
    .await?;
    match result {
        RequestApprovalsResult::Requested(rows) => Ok(rows),
        RequestApprovalsResult::Refused { message, .. } => {
            Err(sqlx::Error::Protocol(message.to_owned()))
        }
    }
}

/// `cancelPendingApprovals(db, { includeDecided: true })`: clear every live
/// row of a subject (soft delete).
pub(crate) async fn clear_approvals(db: &PgPool, subject_id: &str) -> Result<(), sqlx::Error> {
    cancel_pending_approvals(db, "project_request", subject_id, true, crate::now_ms()).await?;
    Ok(())
}
