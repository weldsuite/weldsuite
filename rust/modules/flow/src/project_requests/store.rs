//! Project intake queries (`services/project-requests.ts`): the rows of
//! requests, approvals and the workspace settings as Drizzle reads them, the
//! approval outcome of a request (the `project_request` approval subject), and
//! the board's approval rows, asked for through the approvals core
//! (`weldsuite_flow_domain::approvals`).

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, orm_error};
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalRowInput,
    ApprovalSubjectHandler, RequestApprovalsInput, RequestApprovalsResult, ResolvedApprovalOutcome,
    cancel_pending_approvals, list_subject_approvals as core_list_subject_approvals,
    register_approval_subject, request_approvals as core_request_approvals,
};
use weldsuite_flow_domain::intake::{Criterion, default_scoring_model, model_from_json};
use weldsuite_schema::tenant::{flow_workspace_settings, project_requests};

use crate::approvals::announce::{Aftermath, register_aftermath};
use crate::orm_bridge::sqlx_error;
use crate::row_json;

/// `new Date(millis)`, as the row stores it.
pub(crate) fn instant(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `findProjectRequest(db, id)`: a live request.
pub(crate) async fn find_project_request(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    project_requests::Entity::find_by_id(id)
        .filter(project_requests::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `loadSettings(db)`: the workspace's intake settings, or `None` before it saves any.
pub(crate) async fn load_settings(db: &PgPool) -> Result<Option<Value>, DbErr> {
    flow_workspace_settings::Entity::find()
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
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
) -> Result<Vec<ApprovalRow>, DbErr> {
    core_list_subject_approvals(db, "project_request", subject_id)
        .await
        .map_err(orm_error)
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
        Box::pin(async move {
            settle_project_request(db, subject_id, outcome, context.now_ms)
                .await
                .map_err(sqlx_error)
        })
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
) -> Result<(), DbErr> {
    use project_requests::Column;
    project_requests::Entity::update_many()
        .col_expr(Column::Status, Expr::value(outcome.as_str()))
        .col_expr(Column::UpdatedAt, Expr::value(instant(now_ms)))
        .filter(Column::Id.eq(request_id))
        .filter(Column::Status.eq("assessing"))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
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
) -> Result<Vec<ApprovalRow>, DbErr> {
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
    .await
    .map_err(orm_error)?;
    match result {
        RequestApprovalsResult::Requested(rows) => Ok(rows),
        RequestApprovalsResult::Refused { message, .. } => Err(DbErr::Custom(message.to_owned())),
    }
}

/// `cancelPendingApprovals(db, { includeDecided: true })`: clear every live
/// row of a subject (soft delete).
pub(crate) async fn clear_approvals(db: &PgPool, subject_id: &str) -> Result<(), DbErr> {
    cancel_pending_approvals(db, "project_request", subject_id, true, crate::now_ms())
        .await
        .map_err(orm_error)?;
    Ok(())
}
