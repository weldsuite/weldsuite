//! Accepting a risk (`services/risk-acceptance.ts`, FLOW-016): the approval
//! subject `risk_acceptance` and `POST /api/project-raid/{id}/request-acceptance`.
//! On approval the risk moves to `monitoring` and an assessment row notes who
//! accepted it; on rejection the risk stays as it was.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::PROJECT_RAID_ITEM_UPDATED;
use weldsuite_db::js_row;
use weldsuite_flow_domain::acceptance::{
    ACCEPTANCE_DUE_DAYS, acceptance_approver_row, acceptance_assessment_note, acceptance_error,
    messages,
};
use weldsuite_flow_domain::approval_views::present_review_approver;
use weldsuite_flow_domain::approvals::request_approvals;
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalSubjectHandler, RequestApprovalsInput,
    RequestApprovalsResult, ResolvedApprovalOutcome, cancel_pending_approvals, is_open_decision,
    list_subject_approvals, register_approval_subject, sponsor_of,
};
use weldsuite_flow_domain::js::iso_from_millis;
use weldsuite_flow_domain::raid::{RaidKind, raid_code};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, generate_id};

use super::{
    Assessment, PROJECT_WRITE_DENIED, find_raid_item, insert_assessment, present_one, publish_raid,
    writable_item,
};
use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_cancelled,
    announce_approvals_requested, register_aftermath,
};
use crate::raid_body::{Body, Reader, parse_body};
use crate::{Caller, FlowState, Refusal, Reply, now_ms, outside, reply};

const NOTE_PREFIX: &str = "Accepted by the sponsor";

struct AcceptanceHandler;

impl ApprovalSubjectHandler for AcceptanceHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move {
            if outcome != ResolvedApprovalOutcome::Approved {
                return Ok(());
            }
            let Some(item) = find_raid_item(db, subject_id).await? else {
                return Ok(());
            };
            let (probability, impact) = (item["probability"].as_i64(), item["impact"].as_i64());
            // A risk that was closed or deleted since the request has nothing to accept.
            let (Some(probability), Some(impact)) = (probability, impact) else {
                return Ok(());
            };
            if item["kind"] != "risk" || !item["closedAt"].is_null() {
                return Ok(());
            }
            let requested_at = context
                .rows
                .iter()
                .map(|r| r.created_at)
                .min()
                .unwrap_or(context.now_ms);
            // Idempotent: the resolution may run again, and must not note the acceptance twice.
            let already: Option<i32> = sqlx::query_scalar(
                "select 1 from project_raid_assessments where item_id = $1 and note like $2
                   and assessed_at >= $3::timestamptz limit 1",
            )
            .bind(subject_id)
            .bind(format!("{NOTE_PREFIX}%"))
            .bind(iso_from_millis(requested_at))
            .fetch_optional(db)
            .await?;
            if already.is_some() {
                return Ok(());
            }
            let now = iso_from_millis(context.now_ms).unwrap_or_default();
            let assessment = Assessment {
                id: generate_id("rasm"),
                item_id: subject_id,
                project_id: item["projectId"].as_str().unwrap_or_default(),
                probability,
                impact,
                residual_probability: item["residualProbability"].as_i64(),
                residual_impact: item["residualImpact"].as_i64(),
                note: Some(acceptance_assessment_note(&context.rows)),
                assessed_by: context.actor.as_ref().map_or_else(
                    || item["createdBy"].as_str().unwrap_or_default(),
                    |a| a.id.as_str(),
                ),
                assessed_at: now.clone(),
            };
            weldsuite_db::atomically(
                db,
                [
                    sqlx::query(
                        "update project_raid_items set status = 'monitoring', updated_at = $2::timestamptz
                         where id = $1 and deleted_at is null",
                    )
                    .bind(subject_id.to_owned())
                    .bind(now),
                    insert_assessment(&assessment),
                ],
            )
            .await?;
            Ok(())
        })
    }
}

/// Plug the subject in: its handler and its aftermath.
pub(crate) fn register() {
    register_approval_subject("risk_acceptance", Arc::new(AcceptanceHandler));
    register_aftermath("risk_acceptance", aftermath);
}

fn aftermath<'a>(
    state: &'a FlowState,
    caller: &'a Caller,
    info: &'a AftermathInfo,
) -> AftermathFuture<'a> {
    Box::pin(async move {
        if info.outcome != ResolvedApprovalOutcome::Approved {
            return Ok(());
        }
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            raid_json!("r"),
            " from project_raid_items r where r.id = $1 limit 1"
        ))
        .bind(&info.subject_id)
        .fetch_optional(&caller.db)
        .await?;
        if let Some(row) = row.map(js_row) {
            publish_raid(state, caller, PROJECT_RAID_ITEM_UPDATED, &row, json!({}));
        }
        Ok(())
    })
}

/// `requestRiskAcceptanceSchema`.
fn read_request(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("note", Presence::Nullish, Text::trimmed(None, Some(2_000)));
    Some(r.strict())
}

/// `POST /{id}/request-acceptance`.
pub(super) async fn request_acceptance(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let (item, _) = writable_item(&caller, &id).await?;
        let input = parse_body(&body, read_request)?;
        if let Some(refusal) = acceptance_error(&item) {
            return Err(if refusal.status == 409 {
                Refusal::conflict(refusal.message)
            } else {
                Refusal::bad_request(refusal.message)
            });
        }
        Ok((item, input))
    }
    .await;
    let (item, input) = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
    reply(
        ask(&state, &caller, &item, note.as_deref()).await,
        "Failed to ask for acceptance",
    )
}

async fn ask(state: &FlowState, caller: &Caller, item: &Value, note: Option<&str>) -> Reply {
    let db = &caller.db;
    let id = item["id"].as_str().unwrap_or_default();
    let project_id = item["projectId"].as_str().unwrap_or_default();
    let project: Option<(String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select name, project_manager_id, settings from projects where id = $1 limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let sponsor = sponsor_of(
        project.as_ref().and_then(|p| p.2.as_ref()),
        project.as_ref().and_then(|p| p.1.as_deref()),
    );
    let Some(sponsor) = sponsor else {
        return Err(Refusal::bad_request(messages::NO_SPONSOR));
    };

    let existing = list_subject_approvals(db, "risk_acceptance", id).await?;
    if existing.iter().any(|row| is_open_decision(&row.decision)) {
        return Err(Refusal::conflict(messages::ALREADY_REQUESTED));
    }
    let now = now_ms();
    if !existing.is_empty() {
        let cleared = cancel_pending_approvals(db, "risk_acceptance", id, true, now).await?;
        announce_approvals_cancelled(state, caller, &cleared);
    }
    let due = now + ACCEPTANCE_DUE_DAYS * 86_400_000;
    let result = request_approvals(
        db,
        &RequestApprovalsInput {
            project_id: Some(project_id.to_owned()),
            subject_type: "risk_acceptance".to_owned(),
            subject_id: id.to_owned(),
            requested_by: caller.user_id.clone(),
            rows: vec![acceptance_approver_row(
                &sponsor,
                item["probability"].as_i64().unwrap_or(0),
                item["impact"].as_i64().unwrap_or(0),
                note,
                due,
            )],
            now_ms: now,
        },
    )
    .await?;
    let rows = match result {
        RequestApprovalsResult::Requested(rows) => rows,
        RequestApprovalsResult::Refused { message, .. } => return Err(Refusal::conflict(message)),
    };
    let kind = item["kind"]
        .as_str()
        .and_then(RaidKind::parse)
        .unwrap_or(RaidKind::Risk);
    announce_approvals_requested(
        state,
        caller,
        &rows,
        &SubjectLabel {
            code: Some(raid_code(kind, item["number"].as_i64().unwrap_or(0))),
            title: item["title"].as_str().unwrap_or_default().to_owned(),
        },
        project.as_ref().map(|p| p.0.as_str()),
    );
    let shown = present_one(caller, item).await?;
    Ok(Created(json!({
        "item": shown,
        "approvers": rows.iter().map(present_review_approver).collect::<Vec<_>>(),
    }))
    .into_response())
}

/// Referenced so the 403 message stays next to its siblings.
#[allow(dead_code)]
const WRITE_DENIED: &str = PROJECT_WRITE_DENIED;
