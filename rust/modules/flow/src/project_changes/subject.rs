//! The approval subject `change_request` (`services/project-changes.ts`): the
//! handler that applies an approved change or records a rejected one, and the
//! aftermath that publishes the events of what it wrote.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_BASELINE_CREATED, PROJECT_CHANGE_REQUEST_APPROVED, PROJECT_CHANGE_REQUEST_REJECTED,
    PROJECT_DECISION_CREATED, PROJECT_DECISION_DECIDED, PROJECT_DELIVERABLE_CREATED,
    PROJECT_DELIVERABLE_DELETED, PROJECT_DELIVERABLE_UPDATED, PROJECT_MILESTONE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalSubjectHandler, ResolvedApprovalOutcome,
    register_approval_subject,
};
use weldsuite_flow_domain::baselines::baseline_event_data;
use weldsuite_flow_domain::changes::{
    AppliedChange, apply_approved_change, change_event_data, decision_event_data, deliverable_code,
    find_change_request, record_rejected_change,
};

use crate::approvals::announce::{AftermathFuture, AftermathInfo, register_aftermath};
use crate::{Caller, FlowState};

/// What the handler wrote, for the aftermath of the same answer to publish
/// (the handler has no request, the aftermath no handle on the handler's
/// result; both run inside one `POST /api/approvals/:id/decide`). Taken as
/// soon as it is used; at most 100 wait.
static APPLIED: Mutex<Vec<(String, AppliedChange)>> = Mutex::new(Vec::new());
const APPLIED_MAX: usize = 100;

fn remember(change_id: &str, result: AppliedChange) {
    let mut list = APPLIED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if list.len() >= APPLIED_MAX {
        list.remove(0);
    }
    list.push((change_id.to_owned(), result));
}

fn take(change_id: &str) -> Option<AppliedChange> {
    let mut list = APPLIED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let at = list.iter().position(|(id, _)| id == change_id)?;
    Some(list.remove(at).1)
}

struct ChangeHandler;

impl ApprovalSubjectHandler for ChangeHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async move {
            let actor = context.actor.as_ref().map(|a| a.id.as_str());
            let result = match outcome {
                ResolvedApprovalOutcome::Approved => {
                    apply_approved_change(db, subject_id, actor, context.now_ms).await?
                }
                ResolvedApprovalOutcome::Rejected => {
                    record_rejected_change(db, subject_id, actor, &context.rows, context.now_ms)
                        .await?
                }
            };
            if result.applied {
                remember(subject_id, result);
            }
            Ok(())
        })
    }
}

/// Plug the subject in: its handler and its aftermath.
pub(crate) fn register() {
    register_approval_subject("change_request", Arc::new(ChangeHandler));
    register_aftermath("change_request", aftermath);
}

fn aftermath<'a>(
    state: &'a FlowState,
    caller: &'a Caller,
    info: &'a AftermathInfo,
) -> AftermathFuture<'a> {
    Box::pin(async move {
        let change = find_change_request(&caller.db, &info.subject_id).await?;
        let result = take(&info.subject_id);
        let (Some(change), Some(result)) = (change, result) else {
            return Ok(());
        };
        if info.outcome == ResolvedApprovalOutcome::Approved {
            publish_applied(state, caller, &change, &result).await
        } else {
            caller.publish(
                state,
                PROJECT_CHANGE_REQUEST_REJECTED,
                &id_of(&change),
                &change_event_data(&change),
            );
            publish_decision(state, caller, &result);
            Ok(())
        }
    })
}

fn id_of(row: &Value) -> String {
    row["id"].as_str().unwrap_or_default().to_owned()
}

fn publish_decision(state: &FlowState, caller: &Caller, result: &AppliedChange) {
    if let Some(decision) = &result.decision {
        let data = decision_event_data(decision);
        caller.publish(state, PROJECT_DECISION_CREATED, &id_of(decision), &data);
        caller.publish(state, PROJECT_DECISION_DECIDED, &id_of(decision), &data);
    }
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The events of an approved change, in order: the change, what it moved and
/// added, the project, the baseline and the decision.
async fn publish_applied(
    state: &FlowState,
    caller: &Caller,
    change: &Value,
    result: &AppliedChange,
) -> Result<(), sqlx::Error> {
    let db = &caller.db;
    let project_id = change["projectId"].as_str().unwrap_or_default();
    caller.publish(
        state,
        PROJECT_CHANGE_REQUEST_APPROVED,
        &id_of(change),
        &change_event_data(change),
    );

    let plan = change.get("planChanges").cloned().unwrap_or(Value::Null);
    let scope = change.get("scopeChanges").cloned().unwrap_or(Value::Null);
    let moved: Vec<&str> = array(&plan, "milestones")
        .iter()
        .filter_map(|m| m["milestoneId"].as_str())
        .collect();
    if !moved.is_empty() {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "select id, name, status from milestones where project_id = $1 and deleted_at is null",
        )
        .bind(project_id)
        .fetch_all(db)
        .await?;
        for id in moved {
            if let Some((_, name, status)) = rows.iter().find(|(rid, _, _)| rid == id) {
                caller.publish(
                    state,
                    PROJECT_MILESTONE_UPDATED,
                    id,
                    &json!({"id": id, "projectId": project_id, "name": name, "status": status}),
                );
            }
        }
    }

    let deliverables: Vec<(String, i32, String, String)> = sqlx::query_as(
        "select id, number, title, status from project_deliverables where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let deliverable_event = |event, id: &str| {
        if let Some((_, number, title, status)) = deliverables.iter().find(|(rid, ..)| rid == id) {
            caller.publish(
                state,
                event,
                id,
                &json!({
                    "id": id, "projectId": project_id, "number": number,
                    "code": deliverable_code(i64::from(*number)), "title": title, "status": status,
                }),
            );
        }
    };
    for item in array(&scope, "add") {
        if let Some(id) = item["deliverableId"].as_str() {
            deliverable_event(PROJECT_DELIVERABLE_CREATED, id);
        }
    }
    for mv in array(&plan, "deliverables") {
        if let Some(id) = mv["deliverableId"].as_str() {
            deliverable_event(PROJECT_DELIVERABLE_UPDATED, id);
        }
    }
    for id in array(&scope, "remove").iter().filter_map(Value::as_str) {
        deliverable_event(PROJECT_DELIVERABLE_DELETED, id);
    }

    let cost_moves =
        weldsuite_flow_domain::changes::amount_of(&change["costDelta"]).is_some_and(|d| d != 0.0);
    if plan["goLive"].as_str().is_some_and(|g| !g.is_empty()) || cost_moves {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            project_json!("p"),
            " from projects p where p.id = $1 limit 1"
        ))
        .bind(project_id)
        .fetch_optional(db)
        .await?;
        if let Some(Value::Object(fields)) = row.map(js_row) {
            caller.publish(
                state,
                weldsuite_catalogs::entity_events::PROJECT_UPDATED,
                project_id,
                &crate::projects::analytics_payload(&fields),
            );
        }
    }
    if let Some(baseline) = &result.baseline {
        caller.publish(
            state,
            PROJECT_BASELINE_CREATED,
            &id_of(baseline),
            &baseline_event_data(baseline),
        );
        // A baseline was set: bring the finance snapshot sweep to this workspace.
        if let Some(master) = caller.master(state) {
            crate::project_finance::mark_finance_snapshot_due(&master, &caller.workspace_id).await;
        }
    }
    publish_decision(state, caller, result);
    Ok(())
}
