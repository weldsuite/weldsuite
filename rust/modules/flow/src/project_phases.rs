//! `/api/project-phases` (`routes/project-phases/index.ts`): phases and stage
//! gates (FLOW-017).
//!
//! ```text
//! GET    /?projectId=             the lifecycle: phases in order, with their gate approvals
//! POST   /                        add a phase
//! POST   /reorder                 {projectId, ids}
//! GET    /:id                     one phase
//! PATCH  /:id                     rename, re-date, replace the criteria
//! DELETE /:id                     remove a phase that has not passed
//! GET    /:id/check               the gate evaluated now
//! PATCH  /:id/criteria/:index     tick or untick a manual criterion
//! POST   /:id/waive               waive an open criterion (sponsor)
//! POST   /:id/request-approval    ask the sponsor and one change board member
//! ```
//!
//! The checks run in TypeScript's order: permission, then the object (404),
//! then project access (403), then the body (400), then the rules. Approving
//! the gate is `/api/approvals/:id/decide`'s: [`resolve_gate`] is the handler of
//! the `gate` subject, and its aftermath publishes the events, once the
//! last answer is stored.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_PHASE_CREATED, PROJECT_PHASE_DELETED, PROJECT_PHASE_GATE_REQUESTED,
    PROJECT_PHASE_PASSED, PROJECT_PHASE_REJECTED, PROJECT_PHASE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::approvals::{
    ApprovalFuture, ApprovalResolutionContext, ApprovalRow, ApprovalRowInput,
    ApprovalSubjectHandler, RequestApprovalsInput, RequestApprovalsResult, RequestRefusal,
    ResolvedApprovalOutcome, cancel_pending_approvals, list_subject_approvals,
    register_approval_subject, request_approvals, sponsor_of,
};
use weldsuite_flow_domain::gates::{
    GateChangeFact, GateDecisionFact, GateDeliverableFact, GateFacts, GateRequestBlock,
    GateRiskFact, GateSpendFact, GateWaiver, PhaseLike, SPEND_TIME_ENTRY_STATUSES, check_gate,
    criteria_error, gate_approver_ids, gate_facts_needed, gate_request_block, gate_result_of,
    is_manual_criterion, messages, next_upcoming_phase, normalize_criterion, phase_event_data,
    phase_to_activate, present_phase, reorder_error,
};
use weldsuite_flow_domain::js::{iso_from_millis, js_date, millis_of, to_fixed};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_cancelled,
    announce_approvals_requested, register_aftermath,
};
use crate::project_schedule::{PROJECT_MANAGE_DENIED, find_live_project};
use crate::raid::PROJECT_DENIED;
use crate::raid_body::{Body, IDENTIFIER, Reader, iso_date_time, parse_body, read_query, whole};
use crate::{Caller, FlowState, Refusal, Reply, now_ms, outside, reply};

const LABEL: &str = "Phase";
const DATES_REVERSED: &str = "The end date cannot be before the start date";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    register_subject();
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(need("projects:read"))
                .merge(post(create).route_layer(need("projects:create"))),
        )
        .route(
            "/reorder",
            post(reorder).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            get(detail)
                .route_layer(need("projects:read"))
                .merge(patch(update).route_layer(need("projects:update")))
                .merge(axum::routing::delete(remove).route_layer(need("projects:delete"))),
        )
        .route("/{id}/check", get(check).route_layer(need("projects:read")))
        .route(
            "/{id}/criteria/{index}",
            patch(tick).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/waive",
            post(waive).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/request-approval",
            post(request_approval).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Rows ────────────────────────────────────────────────────────────────────

async fn find_phase(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from project_phases p where p.id = $1 and p.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn list_phases(db: &PgPool, project_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from project_phases p
         where p.project_id = $1 and p.deleted_at is null order by p.position asc, p.id asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

fn phase_likes(rows: &[Value]) -> Vec<PhaseLike> {
    rows.iter()
        .map(|row| PhaseLike {
            id: row["id"].as_str().unwrap_or_default().to_owned(),
            position: row["position"].as_i64().unwrap_or_default(),
            status: row["status"].as_str().unwrap_or_default().to_owned(),
        })
        .collect()
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn criteria_of(phase: &Value) -> Vec<Value> {
    phase["gateCriteria"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn waivers_of(phase: &Value) -> Vec<GateWaiver> {
    GateWaiver::from_result(&phase["gateResult"])
}

fn iso(millis: i64) -> String {
    iso_from_millis(millis).unwrap_or_default()
}

// ── The gate's facts ────────────────────────────────────────────────────────

fn two_decimals(value: Option<&str>) -> String {
    let parsed = value
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0);
    to_fixed(parsed, 2)
}

#[allow(clippy::too_many_lines)]
async fn load_gate_facts(
    db: &PgPool,
    project_id: &str,
    criteria: &[Value],
) -> Result<GateFacts, sqlx::Error> {
    let needed = gate_facts_needed(criteria);
    let mut facts = GateFacts::default();

    if !needed.deliverable_ids.is_empty() {
        let rows: Vec<(String, i32, String, String)> = sqlx::query_as(
            "select id, number, title, status from project_deliverables
             where project_id = $1 and id = any($2) and deleted_at is null",
        )
        .bind(project_id)
        .bind(&needed.deliverable_ids)
        .fetch_all(db)
        .await?;
        let counts: Vec<(Option<String>, i64, i64)> = sqlx::query_as(
            "select deliverable_id, count(*), count(*) filter (where status = 'done') from tasks
             where project_id = $1 and deliverable_id = any($2) and deleted_at is null
               and status <> 'cancelled' group by deliverable_id",
        )
        .bind(project_id)
        .bind(&needed.deliverable_ids)
        .fetch_all(db)
        .await?;
        facts.deliverables = rows
            .into_iter()
            .map(|(id, number, title, status)| {
                let found = counts
                    .iter()
                    .find(|(d, _, _)| d.as_deref() == Some(id.as_str()));
                GateDeliverableFact {
                    tasks_done: found.map_or(0, |c| c.2),
                    tasks_total: found.map_or(0, |c| c.1),
                    id,
                    number: i64::from(number),
                    title,
                    status,
                }
            })
            .collect();
    }

    if needed.risks {
        let rows: Vec<(String, i32, String, i32)> = sqlx::query_as(
            "select id, number, title, score from project_raid_items
             where project_id = $1 and kind = 'risk' and closed_at is null
               and deleted_at is null and score is not null",
        )
        .bind(project_id)
        .fetch_all(db)
        .await?;
        facts.risks = rows
            .into_iter()
            .map(|(id, number, title, score)| GateRiskFact {
                id,
                number: i64::from(number),
                title,
                score: i64::from(score),
            })
            .collect();
    }

    if !needed.decision_ids.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from project_decisions d
             where d.project_id = $1 and d.id = any($2) and d.deleted_at is null",
        )
        .bind(project_id)
        .bind(&needed.decision_ids)
        .fetch_all(db)
        .await?;
        facts.decisions = rows
            .into_iter()
            .map(js_row)
            .map(|row| GateDecisionFact {
                id: text(&row, "id").to_owned(),
                number: row["number"].as_i64().unwrap_or_default(),
                title: text(&row, "title").to_owned(),
                status: text(&row, "status").to_owned(),
                decision_due_at: row["decisionDueAt"].as_str().map(str::to_owned),
            })
            .collect();
    }

    if needed.change_requests {
        let rows: Vec<(String, i32, String)> = sqlx::query_as(
            "select id, number, title from project_change_requests
             where project_id = $1 and status = 'awaiting_approval' and deleted_at is null
             order by number asc",
        )
        .bind(project_id)
        .fetch_all(db)
        .await?;
        facts.change_requests = rows
            .into_iter()
            .map(|(id, number, title)| GateChangeFact {
                id,
                number: i64::from(number),
                title,
            })
            .collect();
    }

    if needed.spend {
        let spent: Option<String> = sqlx::query_scalar(
            "select coalesce(sum(cost), 0)::text from time_entries
             where project_id = $1 and deleted_at is null and status = any($2)",
        )
        .bind(project_id)
        .bind(SPEND_TIME_ENTRY_STATUSES.as_slice())
        .fetch_one(db)
        .await?;
        let baseline: Option<(i32, Option<String>, Option<String>)> = sqlx::query_as(
            "select version, snapshot->>'budgetedAmount', snapshot->>'budgetCurrency'
             from project_baselines where project_id = $1 order by version desc limit 1",
        )
        .bind(project_id)
        .fetch_optional(db)
        .await?;
        let currency: Option<String> =
            sqlx::query_scalar("select budget_currency from projects where id = $1 limit 1")
                .bind(project_id)
                .fetch_optional(db)
                .await?
                .flatten();
        let budget = baseline.as_ref().and_then(|b| b.1.clone());
        facts.spend = Some(GateSpendFact {
            spent: two_decimals(spent.as_deref()),
            budget: budget.as_deref().map(|b| two_decimals(Some(b))),
            currency: baseline.as_ref().and_then(|b| b.2.clone()).or(currency),
            baseline_version: baseline.map(|b| i64::from(b.0)),
        });
    }
    Ok(facts)
}

async fn check_phase(
    db: &PgPool,
    phase: &Value,
) -> Result<weldsuite_flow_domain::gates::GateCheck, sqlx::Error> {
    let criteria = criteria_of(phase);
    let facts = load_gate_facts(db, text(phase, "projectId"), &criteria).await?;
    Ok(check_gate(&criteria, &facts, &waivers_of(phase)))
}

// ── Presenting ──────────────────────────────────────────────────────────────

fn present_approval(row: &ApprovalRow) -> Value {
    json!({
        "id": row.id,
        "approverId": row.approver_id,
        "roleLabel": row.role_label,
        "step": row.step,
        "decision": row.decision,
        "note": row.note,
        "decidedAt": row.decided_at.map(iso),
    })
}

async fn phase_summary(db: &PgPool, row: &Value, gate_number: usize) -> Result<Value, sqlx::Error> {
    let approvals = list_subject_approvals(db, "gate", text(row, "id")).await?;
    let mut out = present_phase(row);
    out["gateNumber"] = json!(gate_number);
    out["criteriaCount"] = json!(criteria_of(row).len());
    out["approvals"] = json!(approvals.iter().map(present_approval).collect::<Vec<_>>());
    Ok(out)
}

async fn gate_number_of(db: &PgPool, row: &Value) -> Result<usize, sqlx::Error> {
    let all = list_phases(db, text(row, "projectId")).await?;
    Ok(all
        .iter()
        .position(|phase| phase["id"] == row["id"])
        .map_or(1, |at| at + 1))
}

fn gate_approvers(project: &Value) -> Vec<String> {
    let sponsor = sponsor_of(
        project.get("settings"),
        project["projectManagerId"].as_str(),
    );
    let board: Vec<String> = project["settings"]["changeControl"]["boardMemberIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    gate_approver_ids(sponsor.as_deref(), &board)
}

async fn phase_gate(db: &PgPool, row: &Value, project: &Value) -> Result<Value, sqlx::Error> {
    let number = gate_number_of(db, row).await?;
    let (mut out, check) = (
        phase_summary(db, row, number).await?,
        check_phase(db, row).await?,
    );
    let approver_ids = gate_approvers(project);
    let block = gate_request_block(
        text(row, "status"),
        !row["gateRequestedAt"].is_null(),
        check.all_satisfied,
        !approver_ids.is_empty(),
    );
    out["check"] = check.to_json();
    out["approverIds"] = json!(approver_ids);
    out["requestBlockedReason"] = json!(block.map(GateRequestBlock::as_str));
    Ok(out)
}

async fn lifecycle(db: &PgPool, project_id: &str) -> Result<Value, sqlx::Error> {
    let rows = list_phases(db, project_id).await?;
    let current = rows
        .iter()
        .find(|row| row["status"] == "active")
        .map(|row| row["id"].clone());
    let mut phases = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        phases.push(phase_summary(db, row, index + 1).await?);
    }
    Ok(json!({ "currentPhaseId": current, "phases": phases }))
}

fn publish_phase(state: &FlowState, caller: &Caller, event: EventName, row: &Value, extra: Value) {
    caller.publish(state, event, text(row, "id"), &phase_event_data(row, extra));
}

// ── Settings ────────────────────────────────────────────────────────────────

fn current_phase_update(
    project_id: &str,
    phase_id: Option<&str>,
    now: &str,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(
        "update projects set
             settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('currentPhaseId', $2::text),
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(project_id.to_owned())
    .bind(phase_id.map(str::to_owned))
    .bind(now.to_owned())
}

fn set_status(
    id: &str,
    status: &str,
    now: &str,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query("update project_phases set status = $2, updated_at = $3::timestamptz where id = $1")
        .bind(id.to_owned())
        .bind(status.to_owned())
        .bind(now.to_owned())
}

// ── The gate subject handler ────────────────────────────────────────────────

struct GateHandler;

impl ApprovalSubjectHandler for GateHandler {
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(resolve_gate(db, subject_id, outcome, context.now_ms))
    }
}

/// `resolveGate(db, phaseId, outcome, now)`: approved passes the phase,
/// activates the next one and moves `settings.currentPhaseId`; rejected
/// reopens the gate. Idempotent.
pub(crate) async fn resolve_gate(
    db: &PgPool,
    phase_id: &str,
    outcome: ResolvedApprovalOutcome,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    let Some(phase) = find_phase(db, phase_id).await? else {
        return Ok(());
    };
    let now = iso(now_ms);
    if outcome == ResolvedApprovalOutcome::Rejected {
        if text(&phase, "status") != "active" || phase["gateRequestedAt"].is_null() {
            return Ok(());
        }
        sqlx::query(
            "update project_phases set gate_requested_at = null, updated_at = $2::timestamptz where id = $1",
        )
        .bind(phase_id)
        .bind(&now)
        .execute(db)
        .await?;
        return Ok(());
    }
    if text(&phase, "status") == "passed" {
        return Ok(());
    }
    let project_id = text(&phase, "projectId").to_owned();
    let all = list_phases(db, &project_id).await?;
    let next = next_upcoming_phase(&phase_likes(&all), phase_id);
    let criteria = criteria_of(&phase);
    let waivers = waivers_of(&phase);
    let facts = load_gate_facts(db, &project_id, &criteria).await?;
    let check = check_gate(&criteria, &facts, &waivers);
    let result = gate_result_of(&check, &criteria, &waivers, &now);
    let mut statements = vec![
        sqlx::query(
            "update project_phases set status = 'passed', passed_at = $2::timestamptz,
                 gate_result = $3, updated_at = $2::timestamptz where id = $1",
        )
        .bind(phase_id.to_owned())
        .bind(now.clone())
        .bind(result),
    ];
    if let Some(next) = &next {
        statements.push(set_status(next, "active", &now));
    }
    statements.push(current_phase_update(&project_id, next.as_deref(), &now));
    weldsuite_db::atomically(db, statements).await?;
    Ok(())
}

/// Plug the `gate` subject in: its handler and its aftermath.
pub(crate) fn register_subject() {
    register_approval_subject("gate", Arc::new(GateHandler));
    register_aftermath("gate", aftermath);
}

fn aftermath<'a>(
    state: &'a FlowState,
    caller: &'a Caller,
    info: &'a AftermathInfo,
) -> AftermathFuture<'a> {
    Box::pin(publish_gate_resolution(
        state,
        caller,
        &info.subject_id,
        info.outcome,
    ))
}

/// `publishGateResolution(c, db, phaseId, outcome)`: the entity events of a
/// settled gate, published by the aftermath once the last answer is stored.
async fn publish_gate_resolution(
    state: &FlowState,
    caller: &Caller,
    phase_id: &str,
    outcome: ResolvedApprovalOutcome,
) -> Result<(), sqlx::Error> {
    let db = &caller.db;
    let Some(phase) = find_phase(db, phase_id).await? else {
        return Ok(());
    };
    if outcome == ResolvedApprovalOutcome::Approved {
        if text(&phase, "status") != "passed" {
            return Ok(());
        }
        let all = list_phases(db, text(&phase, "projectId")).await?;
        let active = all.iter().find(|row| row["status"] == "active");
        publish_phase(
            state,
            caller,
            PROJECT_PHASE_PASSED,
            &phase,
            json!({
                "passedAt": phase["passedAt"],
                "nextPhaseId": active.map(|row| row["id"].clone()),
            }),
        );
        if let Some(active) = active {
            publish_phase(state, caller, PROJECT_PHASE_UPDATED, active, json!({}));
        }
        return Ok(());
    }
    let rows = list_subject_approvals(db, "gate", phase_id).await?;
    let rejected = rows.iter().find(|row| row.decision == "rejected");
    publish_phase(
        state,
        caller,
        PROJECT_PHASE_REJECTED,
        &phase,
        json!({
            "rejectedBy": rejected.map(|row| row.approver_id.clone()),
            "note": rejected.and_then(|row| row.note.clone()),
        }),
    );
    Ok(())
}

// ── Bodies ──────────────────────────────────────────────────────────────────

/// The most criteria a gate takes (`gateCriteria`: `.max(30)`).
const MAX_GATE_CRITERIA: usize = 30;

/// One option of a criterion: `{ key, params? }`, `.strict()`.
fn read_catalogue_criterion(issues: &mut Issues, item: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, item)?;
    r.choice(
        "key",
        Presence::Required,
        &weldsuite_flow_domain::gates::GATE_CRITERION_KEYS,
    )
    .record("params", Presence::Optional);
    Some(r.strict())
}

/// The other option: `{ manual: z.string().trim().min(1).max(500) }`, `.strict()`.
fn read_manual_criterion(issues: &mut Issues, item: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, item)?;
    r.text(
        "manual",
        Presence::Required,
        Text::trimmed(Some(1), Some(500)),
    );
    Some(r.strict())
}

/// Whether an option's issue leaves it only "dirty" in Zod's terms: a
/// failed check (a text too short or too long, an unknown key) on a value of
/// the right type. A type or enum failure aborts the option.
fn only_dirty(issue: &Value) -> bool {
    !matches!(
        issue["code"].as_str(),
        Some("invalid_type" | "invalid_enum_value")
    )
}

/// One item of `gateCriteria` (`gateCriterionInputSchema`, a `z.union` of the
/// two options above), at its own path. Zod tries the options in order: the
/// first that parses is the item; else the first that is only dirty reports
/// its own issues; else the item is one `invalid_union` (`Invalid input`)
/// carrying every option's issues.
fn read_criterion(issues: &mut Issues, item: &Value) -> Option<Value> {
    let options: [fn(&mut Issues, &Value) -> Option<Body>; 2] =
        [read_catalogue_criterion, read_manual_criterion];
    let here = issues.path_here();
    let mut dirty: Option<Vec<Value>> = None;
    let mut errors = Vec::with_capacity(options.len());
    for read in options {
        let mut own = Issues::default();
        let out = read(&mut own, item);
        let failed: Vec<Value> = match own.finish() {
            Ok(()) => return out.map(Value::Object),
            Err(failed) => failed
                .issues()
                .iter()
                .map(|issue| under(&here, issue))
                .collect(),
        };
        if dirty.is_none() && failed.iter().all(only_dirty) {
            dirty = Some(failed.clone());
        }
        errors.push(json!({ "issues": failed, "name": "ZodError" }));
    }
    match dirty {
        Some(found) => found.into_iter().for_each(|issue| issues.push_raw(issue)),
        None => issues.issue_here(json!({
            "code": "invalid_union",
            "unionErrors": errors,
            "message": "Invalid input",
        })),
    }
    None
}

/// An issue read on its own, moved under `prefix` (the item's path).
fn under(prefix: &Value, issue: &Value) -> Value {
    let mut path = prefix.as_array().cloned().unwrap_or_default();
    if let Some(own) = issue["path"].as_array() {
        path.extend(own.iter().cloned());
    }
    let mut issue = issue.clone();
    issue["path"] = Value::Array(path);
    issue
}

/// `createPhaseSchema` / `updatePhaseSchema`: the body, and its criteria
/// when it has them.
fn read_phase_fields(
    issues: &mut Issues,
    body: &Value,
    create: bool,
) -> Option<(Body, Option<Vec<Value>>)> {
    let mut r = Reader::of(issues, body)?;
    if create {
        r.text("projectId", Presence::Required, IDENTIFIER);
        r.text(
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        );
    } else {
        r.text(
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        );
    }
    r.text("plannedStart", Presence::Nullish, iso_date_time())
        .text("plannedEnd", Presence::Nullish, iso_date_time());
    let criteria = r.issues.list(
        r.fields,
        "gateCriteria",
        Presence::Optional,
        None,
        Some(MAX_GATE_CRITERIA),
        read_criterion,
    );
    r.keep("gateCriteria", criteria);
    let out = r.strict();
    let criteria = out.get("gateCriteria").and_then(Value::as_array).cloned();
    Some((out, criteria))
}

/// `reorderPhasesSchema`: the project and its phase ids in the new order.
fn read_reorder(issues: &mut Issues, body: &Value) -> Option<(String, Vec<String>)> {
    let mut r = Reader::of(issues, body)?;
    r.text("projectId", Presence::Required, IDENTIFIER);
    let ids = r.issues.list(
        r.fields,
        "ids",
        Presence::Required,
        None,
        Some(100),
        |issues, item| issues.item_text(item, IDENTIFIER),
    );
    r.keep("ids", ids);
    let out = r.strict();
    let ids = out
        .get("ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Some((text_of(&out, "projectId"), ids))
}

fn text_of(body: &Body, key: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn read_waive(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.whole("criterionIndex", Presence::Required, whole(0.0, 1000.0))
        .text(
            "note",
            Presence::Required,
            Text::trimmed(Some(1), Some(2000)),
        );
    Some(r.strict())
}

/// `tickCriterionSchema`: `{ met: z.boolean() }`, `.strict()`.
fn read_tick(issues: &mut Issues, body: &Value) -> Option<bool> {
    let mut r = Reader::of(issues, body)?;
    let met = r.issues.boolean(r.fields, "met", Presence::Required);
    r.keep("met", met);
    r.strict().get("met").and_then(Value::as_bool)
}

fn read_project_query(raw: Option<&str>) -> Result<String, Refusal> {
    read_query(raw, |issues, f| {
        issues
            .text_with(
                f,
                "projectId",
                Presence::Required,
                Text::length(Some(1), None),
            )
            .into_option()
            .unwrap_or_default()
    })
}

/// `new Date(value)` as an ISO string, `None` for null.
fn to_date(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(js_date)
}

fn reversed(start: Option<&str>, end: Option<&str>) -> bool {
    match (start.and_then(millis_of), end.and_then(millis_of)) {
        (Some(start), Some(end)) => end < start,
        _ => false,
    }
}

/// `criteriaRefusal`: the criteria are catalogue keys with their parameters,
/// and point at things of this project.
async fn criteria_refusal(
    db: &PgPool,
    project_id: &str,
    criteria: &[Value],
) -> Result<(), Refusal> {
    if let Some(message) = criteria_error(criteria) {
        return Err(Refusal::bad_request(message));
    }
    let needed = gate_facts_needed(criteria);
    if !needed.deliverable_ids.is_empty() {
        let found: i64 = sqlx::query_scalar(
            "select count(*) from project_deliverables
             where project_id = $1 and id = any($2) and deleted_at is null",
        )
        .bind(project_id)
        .bind(&needed.deliverable_ids)
        .fetch_one(db)
        .await?;
        if usize::try_from(found).ok() != Some(needed.deliverable_ids.len()) {
            return Err(Refusal::bad_request(messages::DELIVERABLE_NOT_FOUND));
        }
    }
    if !needed.decision_ids.is_empty() {
        let found: i64 = sqlx::query_scalar(
            "select count(*) from project_decisions
             where project_id = $1 and id = any($2) and deleted_at is null",
        )
        .bind(project_id)
        .bind(&needed.decision_ids)
        .fetch_one(db)
        .await?;
        if usize::try_from(found).ok() != Some(needed.decision_ids.len()) {
            return Err(Refusal::bad_request(messages::DECISION_NOT_FOUND));
        }
    }
    Ok(())
}

// ── Reads ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let project_id = match read_project_query(raw.as_deref()) {
        Ok(id) => id,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        list_lifecycle(&caller, &project_id).await,
        "Failed to list phases",
    )
}

async fn list_lifecycle(caller: &Caller, project_id: &str) -> Reply {
    if find_live_project(&caller.db, project_id).await?.is_none() {
        return Err(Refusal::not_found("Project", project_id));
    }
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    Ok(Data(lifecycle(&caller.db, project_id).await?).into_response())
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(read_phase(&caller, &id).await, "Failed to fetch phase")
}

async fn read_phase(caller: &Caller, id: &str) -> Reply {
    let Some(phase) = find_phase(&caller.db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    if !caller.can_access(text(&phase, "projectId")).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let number = gate_number_of(&caller.db, &phase).await?;
    Ok(Data(phase_summary(&caller.db, &phase, number).await?).into_response())
}

async fn check(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        check_gate_of(&caller, &id).await,
        "Failed to check the gate",
    )
}

async fn check_gate_of(caller: &Caller, id: &str) -> Reply {
    let Some(phase) = find_phase(&caller.db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    let project_id = text(&phase, "projectId").to_owned();
    if !caller.can_access(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let Some(project) = find_live_project(&caller.db, &project_id).await? else {
        return Err(Refusal::not_found("Project", &project_id));
    };
    Ok(Data(phase_gate(&caller.db, &phase, &project).await?).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let (input, criteria) = parse_body(&body, |issues, value| {
            read_phase_fields(issues, value, true)
        })?;
        let project_id = text_of(&input, "projectId");
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        if find_live_project(&caller.db, &project_id).await?.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let start = to_date(input.get("plannedStart"));
        let end = to_date(input.get("plannedEnd"));
        if reversed(start.as_deref(), end.as_deref()) {
            return Err(Refusal::bad_request(DATES_REVERSED));
        }
        let criteria: Vec<Value> = criteria
            .unwrap_or_default()
            .iter()
            .map(normalize_criterion)
            .collect();
        criteria_refusal(&caller.db, &project_id, &criteria).await?;
        Ok((input, project_id, start, end, criteria))
    }
    .await;
    let (input, project_id, start, end, criteria) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_phase(&state, &caller, &input, &project_id, start, end, criteria).await,
        "Failed to create phase",
    )
}

async fn create_phase(
    state: &FlowState,
    caller: &Caller,
    input: &Body,
    project_id: &str,
    start: Option<String>,
    end: Option<String>,
    criteria: Vec<Value>,
) -> Reply {
    let db = &caller.db;
    let existing = list_phases(db, project_id).await?;
    let id = generate_id("phs");
    let now = crate::now();
    let position = existing
        .iter()
        .filter_map(|row| row["position"].as_i64())
        .max()
        .map_or(0, |max| max + 1);
    let mut likes = phase_likes(&existing);
    likes.push(PhaseLike {
        id: id.clone(),
        position,
        status: "upcoming".to_owned(),
    });
    let activate = phase_to_activate(&likes);
    let status = if activate.as_deref() == Some(id.as_str()) {
        "active"
    } else {
        "upcoming"
    };
    let mut statements = vec![
        sqlx::query(
            "insert into project_phases (id, project_id, position, name, planned_start, planned_end,
                 status, gate_criteria, created_by, created_at, updated_at)
             values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9,
                 $10::timestamptz, $10::timestamptz)",
        )
        .bind(id.clone())
        .bind(project_id.to_owned())
        .bind(i32::try_from(position).unwrap_or(i32::MAX))
        .bind(text_of(input, "name"))
        .bind(start)
        .bind(end)
        .bind(status.to_owned())
        .bind(Value::Array(criteria))
        .bind(caller.user_id.clone())
        .bind(now.clone()),
    ];
    if let Some(other) = activate.as_deref().filter(|other| *other != id) {
        statements.push(set_status(other, "active", &now));
    }
    if let Some(active) = &activate {
        statements.push(current_phase_update(project_id, Some(active), &now));
    }
    weldsuite_db::atomically(db, statements).await?;
    let Some(row) = find_phase(db, &id).await? else {
        return Err(Refusal::Internal("the new phase is missing".to_owned()));
    };
    publish_phase(state, caller, PROJECT_PHASE_CREATED, &row, json!({}));
    if let Some(other) = activate.filter(|other| *other != id)
        && let Some(repaired) = find_phase(db, &other).await?
    {
        publish_phase(state, caller, PROJECT_PHASE_UPDATED, &repaired, json!({}));
    }
    let number = gate_number_of(db, &row).await?;
    Ok(Created(phase_summary(db, &row, number).await?).into_response())
}

// ── POST /reorder ───────────────────────────────────────────────────────────

async fn reorder(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let (project_id, ids) = parse_body(&body, read_reorder)?;
        if find_live_project(&caller.db, &project_id).await?.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        Ok((project_id, ids))
    }
    .await;
    let (project_id, ids) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        reorder_phases(&state, &caller, &project_id, &ids).await,
        "Failed to reorder phases",
    )
}

async fn reorder_phases(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    ids: &[String],
) -> Reply {
    let db = &caller.db;
    let existing = list_phases(db, project_id).await?;
    if let Some(message) = reorder_error(&phase_likes(&existing), ids) {
        return Err(Refusal::bad_request(message));
    }
    let now = crate::now();
    let moved: Vec<(String, usize)> = ids
        .iter()
        .enumerate()
        .filter(|(position, id)| {
            existing
                .iter()
                .find(|row| row["id"] == id.as_str())
                .is_some_and(|row| row["position"].as_i64() != i64::try_from(*position).ok())
        })
        .map(|(position, id)| (id.clone(), position))
        .collect();
    if !moved.is_empty() {
        let statements: Vec<_> = moved
            .iter()
            .map(|(id, position)| {
                sqlx::query(
                    "update project_phases set position = $2, updated_at = $3::timestamptz where id = $1",
                )
                .bind(id.clone())
                .bind(i32::try_from(*position).unwrap_or(i32::MAX))
                .bind(now.clone())
            })
            .collect();
        weldsuite_db::atomically(db, statements).await?;
        for (id, _) in &moved {
            if let Some(row) = find_phase(db, id).await? {
                publish_phase(state, caller, PROJECT_PHASE_UPDATED, &row, json!({}));
            }
        }
    }
    Ok(Data(lifecycle(db, project_id).await?).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_phase(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        let project_id = text(&existing, "projectId").to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let (input, criteria) = parse_body(&body, |issues, value| {
            read_phase_fields(issues, value, false)
        })?;
        if text(&existing, "status") == "passed" {
            return Err(Refusal::conflict(messages::PHASE_PASSED));
        }
        let start = if input.contains_key("plannedStart") {
            to_date(input.get("plannedStart"))
        } else {
            existing["plannedStart"].as_str().map(str::to_owned)
        };
        let end = if input.contains_key("plannedEnd") {
            to_date(input.get("plannedEnd"))
        } else {
            existing["plannedEnd"].as_str().map(str::to_owned)
        };
        if reversed(start.as_deref(), end.as_deref()) {
            return Err(Refusal::bad_request(DATES_REVERSED));
        }
        let criteria = match criteria {
            Some(criteria) => {
                let criteria: Vec<Value> = criteria.iter().map(normalize_criterion).collect();
                criteria_refusal(&caller.db, &project_id, &criteria).await?;
                // A gate that is waiting for approval was approved on these criteria.
                if !existing["gateRequestedAt"].is_null() {
                    return Err(Refusal::conflict(messages::ALREADY_REQUESTED));
                }
                Some(criteria)
            }
            None => None,
        };
        Ok((input, start, end, criteria))
    }
    .await;
    let (input, start, end, criteria) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_phase(&state, &caller, &id, &input, start, end, criteria).await,
        "Failed to update phase",
    )
}

async fn update_phase(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    input: &Body,
    start: Option<String>,
    end: Option<String>,
    criteria: Option<Vec<Value>>,
) -> Reply {
    let db = &caller.db;
    sqlx::query(
        "update project_phases set
             name = coalesce($2, name),
             planned_start = case when $3 then $4::timestamptz else planned_start end,
             planned_end = case when $5 then $6::timestamptz else planned_end end,
             gate_criteria = case when $7::jsonb is not null then $7::jsonb else gate_criteria end,
             gate_result = case when $7::jsonb is not null then null else gate_result end,
             updated_at = $8::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(input.get("name").and_then(Value::as_str))
    .bind(input.contains_key("plannedStart"))
    .bind(start)
    .bind(input.contains_key("plannedEnd"))
    .bind(end)
    .bind(criteria.map(Value::Array))
    .bind(crate::now())
    .execute(db)
    .await?;
    let Some(row) = find_phase(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_phase(state, caller, PROJECT_PHASE_UPDATED, &row, json!({}));
    let number = gate_number_of(db, &row).await?;
    Ok(Data(phase_summary(db, &row, number).await?).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_phase(&state, &caller, &id).await,
        "Failed to delete phase",
    )
}

async fn remove_phase(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_phase(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    let project_id = text(&existing, "projectId").to_owned();
    if !caller.can_manage(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
    }
    if text(&existing, "status") == "passed" {
        return Err(Refusal::conflict(messages::PHASE_PASSED));
    }
    let now_text = crate::now();
    let remaining: Vec<Value> = list_phases(db, &project_id)
        .await?
        .into_iter()
        .filter(|row| row["id"] != id)
        .collect();
    let activate = phase_to_activate(&phase_likes(&remaining));
    let mut statements = vec![
        sqlx::query(
            "update project_phases set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
             where id = $1 and deleted_at is null",
        )
        .bind(id.to_owned())
        .bind(now_text.clone()),
    ];
    if let Some(next) = &activate {
        statements.push(set_status(next, "active", &now_text));
    }
    if text(&existing, "status") == "active" {
        statements.push(current_phase_update(
            &project_id,
            activate.as_deref(),
            &now_text,
        ));
    }
    weldsuite_db::atomically(db, statements).await?;
    // Nobody is asked about a gate that no longer exists.
    let cleared = cancel_pending_approvals(db, "gate", id, true, now_ms()).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    publish_phase(state, caller, PROJECT_PHASE_DELETED, &existing, json!({}));
    if let Some(next) = activate
        && let Some(row) = find_phase(db, &next).await?
    {
        publish_phase(state, caller, PROJECT_PHASE_UPDATED, &row, json!({}));
    }
    Ok(NoContent.into_response())
}

// ── PATCH /:id/criteria/:index ──────────────────────────────────────────────

async fn tick(
    State(state): State<FlowState>,
    caller: Caller,
    Path((id, raw_index)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(phase) = find_phase(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller.can_manage(text(&phase, "projectId")).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let met = parse_body(&body, read_tick)?;
        let index = if !raw_index.is_empty() && raw_index.bytes().all(|b| b.is_ascii_digit()) {
            raw_index.parse::<usize>().ok()
        } else {
            None
        };
        let criteria = criteria_of(&phase);
        if text(&phase, "status") == "passed" {
            return Err(Refusal::conflict(messages::PHASE_PASSED));
        }
        let Some(index) = index.filter(|index| *index < criteria.len()) else {
            return Err(Refusal::bad_request(messages::CRITERION_NOT_FOUND));
        };
        if !is_manual_criterion(&criteria[index]) {
            return Err(Refusal::bad_request(messages::NOT_MANUAL));
        }
        if !phase["gateRequestedAt"].is_null() {
            return Err(Refusal::conflict(messages::ALREADY_REQUESTED));
        }
        Ok((phase, criteria, index, met))
    }
    .await;
    let (phase, criteria, index, met) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        tick_criterion(&state, &caller, &phase, criteria, index, met).await,
        "Failed to update the criterion",
    )
}

async fn tick_criterion(
    state: &FlowState,
    caller: &Caller,
    phase: &Value,
    criteria: Vec<Value>,
    index: usize,
    met: bool,
) -> Reply {
    let db = &caller.db;
    let id = text(phase, "id");
    let now = crate::now();
    let next: Vec<Value> = criteria
        .into_iter()
        .enumerate()
        .map(|(at, entry)| {
            if at == index {
                json!({
                    "manual": entry["manual"],
                    "met": met,
                    "metAt": if met { json!(now) } else { Value::Null },
                })
            } else {
                entry
            }
        })
        .collect();
    sqlx::query(
        "update project_phases set gate_criteria = $2, updated_at = $3::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(Value::Array(next))
    .bind(&now)
    .execute(db)
    .await?;
    let project = find_live_project(db, text(phase, "projectId")).await?;
    let (Some(row), Some(project)) = (find_phase(db, id).await?, project) else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_phase(state, caller, PROJECT_PHASE_UPDATED, &row, json!({}));
    Ok(Data(phase_gate(db, &row, &project).await?).into_response())
}

// ── POST /:id/waive ─────────────────────────────────────────────────────────

async fn waive(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(phase) = find_phase(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        let project_id = text(&phase, "projectId").to_owned();
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        // The sponsor's call, and only theirs (the project manager when no sponsor is named).
        let sponsor = sponsor_of(
            project.get("settings"),
            project["projectManagerId"].as_str(),
        );
        if sponsor.as_deref() != Some(caller.user_id.as_str()) {
            return Err(Refusal::forbidden(messages::NOT_SPONSOR));
        }
        let input = parse_body(&body, read_waive)?;
        let index = input
            .get("criterionIndex")
            .and_then(Value::as_i64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or_default();
        let note = text_of(&input, "note");
        if text(&phase, "status") == "passed" {
            return Err(Refusal::conflict(messages::PHASE_PASSED));
        }
        if !phase["gateRequestedAt"].is_null() {
            return Err(Refusal::conflict(messages::WAIVE_AFTER_REQUEST));
        }
        if index >= criteria_of(&phase).len() {
            return Err(Refusal::bad_request(messages::CRITERION_NOT_FOUND));
        }
        Ok((phase, project, index, note))
    }
    .await;
    let (phase, project, index, note) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        waive_criterion(&state, &caller, &phase, &project, index, &note).await,
        "Failed to waive the criterion",
    )
}

async fn waive_criterion(
    state: &FlowState,
    caller: &Caller,
    phase: &Value,
    project: &Value,
    index: usize,
    note: &str,
) -> Reply {
    let db = &caller.db;
    let id = text(phase, "id");
    let criteria = criteria_of(phase);
    let waivers = waivers_of(phase);
    let check = check_phase(db, phase).await?;
    if check.items[index].met {
        return Err(Refusal::conflict(messages::ALREADY_MET));
    }
    if waivers.iter().any(|w| w.index == index) {
        return Err(Refusal::conflict(messages::ALREADY_WAIVED));
    }
    let now = crate::now();
    let mut next = waivers;
    next.push(GateWaiver {
        index,
        note: note.to_owned(),
        by: caller.user_id.clone(),
        at: now.clone(),
    });
    let facts = load_gate_facts(db, text(phase, "projectId"), &criteria).await?;
    let result = gate_result_of(
        &check_gate(&criteria, &facts, &next),
        &criteria,
        &next,
        &now,
    );
    sqlx::query(
        "update project_phases set gate_result = $2, updated_at = $3::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(result)
    .bind(&now)
    .execute(db)
    .await?;
    let Some(row) = find_phase(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_phase(
        state,
        caller,
        PROJECT_PHASE_UPDATED,
        &row,
        json!({ "waivedCriterion": index }),
    );
    Ok(Data(phase_gate(db, &row, project).await?).into_response())
}

// ── POST /:id/request-approval ──────────────────────────────────────────────

async fn request_approval(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let Some(phase) = find_phase(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        let project_id = text(&phase, "projectId").to_owned();
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        Ok((phase, project))
    }
    .await;
    let (phase, project) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        ask_for_approval(&state, &caller, &id, &phase, &project).await,
        "Failed to request approval of the gate",
    )
}

async fn ask_for_approval(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    phase: &Value,
    project: &Value,
) -> Reply {
    let db = &caller.db;
    let check = check_phase(db, phase).await?;
    let approver_ids = gate_approvers(project);
    if let Some(block) = gate_request_block(
        text(phase, "status"),
        !phase["gateRequestedAt"].is_null(),
        check.all_satisfied,
        !approver_ids.is_empty(),
    ) {
        return Err(Refusal::conflict(block.message()));
    }

    // A gate asked for before and turned down starts its approvals over.
    let now_millis = now_ms();
    let cleared = cancel_pending_approvals(db, "gate", id, true, now_millis).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    let sponsor = sponsor_of(
        project.get("settings"),
        project["projectManagerId"].as_str(),
    );
    let rows: Vec<ApprovalRowInput> = approver_ids
        .iter()
        .map(|approver| {
            ApprovalRowInput::member(approver.clone(), "gate")
                .with_rule(
                    "gate",
                    &json!({ "phaseId": id, "phaseName": phase["name"] }),
                )
                .with_step(1)
                .with_role_label(if Some(approver) == sponsor.as_ref() {
                    "Sponsor"
                } else {
                    "Change board"
                })
        })
        .collect();
    let asked = request_approvals(
        db,
        &RequestApprovalsInput {
            project_id: Some(text(phase, "projectId").to_owned()),
            subject_type: "gate".to_owned(),
            subject_id: id.to_owned(),
            requested_by: caller.user_id.clone(),
            rows,
            now_ms: now_millis,
        },
    )
    .await?;
    let approvals = match asked {
        RequestApprovalsResult::Requested(rows) => rows,
        RequestApprovalsResult::Refused { code, message } => {
            return Err(match code {
                RequestRefusal::Invalid => Refusal::bad_request(message),
                RequestRefusal::AlreadyRequested => Refusal::conflict(message),
            });
        }
    };

    let criteria = criteria_of(phase);
    let now = iso(now_millis);
    sqlx::query(
        "update project_phases set gate_requested_at = $2::timestamptz, gate_result = $3,
             updated_at = $2::timestamptz where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&now)
    .bind(gate_result_of(&check, &criteria, &waivers_of(phase), &now))
    .execute(db)
    .await?;
    let Some(row) = find_phase(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };

    publish_phase(
        state,
        caller,
        PROJECT_PHASE_GATE_REQUESTED,
        &row,
        json!({ "approverIds": approvals.iter().map(|a| a.approver_id.clone()).collect::<Vec<_>>() }),
    );
    announce_approvals_requested(
        state,
        caller,
        &approvals,
        &SubjectLabel {
            code: None,
            title: format!("{} gate", text(phase, "name")),
        },
        project["name"].as_str(),
    );
    let result = json!({
        "phase": phase_gate(db, &row, project).await?,
        "approvals": approvals.iter().map(present_approval).collect::<Vec<_>>(),
    });
    Ok(Created(result).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the 400 would carry (`{ path, message }` per issue), or the read body.
    fn read<T>(
        reader: impl FnOnce(&mut Issues, &Value) -> Option<T>,
        body: &Value,
    ) -> Result<T, Value> {
        let mut issues = Issues::default();
        let out = reader(&mut issues, body);
        match issues.finish() {
            Ok(()) => Ok(out.expect("a body without issues is read")),
            Err(failed) => Err(Value::Array(
                failed
                    .issues()
                    .iter()
                    .map(|issue| {
                        let path = issue["path"]
                            .as_array()
                            .expect("a path")
                            .iter()
                            .map(|part| {
                                part.as_str()
                                    .map_or_else(|| part.to_string(), str::to_owned)
                            })
                            .collect::<Vec<_>>()
                            .join(".");
                        json!({ "path": path, "message": issue["message"] })
                    })
                    .collect(),
            )),
        }
    }

    fn create(criteria: &Value) -> Value {
        read(
            |i, b| read_phase_fields(i, b, true),
            &json!({ "projectId": "p", "name": "Build", "gateCriteria": criteria, "zzz": 1 }),
        )
        .expect_err("refused")
    }

    const ZZZ: &str = "Unrecognized key(s) in object: 'zzz'";
    const TOO_SHORT: &str = "String must contain at least 1 character(s)";

    /// Zod 3's own answers for `createPhaseSchema` (each body also has `zzz`).
    #[test]
    fn criteria_are_read_as_zods_union() {
        for criteria in [
            json!([{ "key": "moon_phase" }]),
            json!([{ "key": "decision_decided", "params": "x" }]),
            json!([{ "key": "decision_decided", "params": null }]),
            json!(["x"]),
            json!([null]),
            json!([{ "manual": 5 }]),
            json!([{}]),
        ] {
            assert_eq!(
                create(&criteria),
                json!([
                    { "path": "gateCriteria.0", "message": "Invalid input" },
                    { "path": "", "message": ZZZ },
                ]),
                "{criteria}"
            );
        }

        // An option that only failed a check reports its own issues.
        assert_eq!(
            create(&json!([{ "manual": "   " }])),
            json!([
                { "path": "gateCriteria.0.manual", "message": TOO_SHORT },
                { "path": "", "message": ZZZ },
            ])
        );
        assert_eq!(
            create(&json!([{ "manual": "", "met": true }])),
            json!([
                { "path": "gateCriteria.0.manual", "message": TOO_SHORT },
                { "path": "gateCriteria.0", "message": "Unrecognized key(s) in object: 'met'" },
                { "path": "", "message": ZZZ },
            ])
        );
        assert_eq!(
            create(&json!([{ "key": "decision_decided", "manual": "x" }])),
            json!([
                { "path": "gateCriteria.0", "message": "Unrecognized key(s) in object: 'manual'" },
                { "path": "", "message": ZZZ },
            ])
        );

        // Too many: the length, then every item still read.
        let mut many: Vec<Value> = (0..31).map(|_| json!({ "manual": "x" })).collect();
        many.push(json!({ "manual": "" }));
        assert_eq!(
            create(&Value::Array(many)),
            json!([
                { "path": "gateCriteria", "message": "Array must contain at most 30 element(s)" },
                { "path": "gateCriteria.31.manual", "message": TOO_SHORT },
                { "path": "", "message": ZZZ },
            ])
        );
        assert_eq!(
            create(&json!("nope")),
            json!([
                { "path": "gateCriteria", "message": "Expected array, received string" },
                { "path": "", "message": ZZZ },
            ])
        );

        let (body, criteria) = read(
            |i, b| read_phase_fields(i, b, true),
            &json!({ "projectId": "p", "name": " Build ", "gateCriteria": [
                { "manual": " Plan " },
                { "key": "decision_decided", "params": { "decisionId": "d" } },
            ] }),
        )
        .expect("valid");
        assert_eq!(body["name"], "Build");
        assert_eq!(
            criteria,
            Some(vec![
                json!({ "manual": "Plan" }),
                json!({ "key": "decision_decided", "params": { "decisionId": "d" } }),
            ])
        );
    }

    #[test]
    fn updates_reorders_and_ticks_answer_like_zod() {
        assert_eq!(
            read(
                |i, b| read_phase_fields(i, b, false),
                &json!({ "name": "", "zzz": 1, "plannedStart": "x" })
            )
            .expect_err("refused"),
            json!([
                { "path": "name", "message": TOO_SHORT },
                { "path": "plannedStart", "message": "Invalid datetime" },
                { "path": "", "message": ZZZ },
            ])
        );
        let (_, criteria) = read(
            |i, b| read_phase_fields(i, b, false),
            &json!({ "name": "X" }),
        )
        .expect("valid");
        assert_eq!(criteria, None);

        let reorder = |body: &Value| read(read_reorder, body).expect_err("refused");
        assert_eq!(
            reorder(&json!({ "projectId": "p" })),
            json!([{ "path": "ids", "message": "Required" }])
        );
        assert_eq!(
            reorder(&json!({ "ids": [] })),
            json!([{ "path": "projectId", "message": "Required" }])
        );
        assert_eq!(
            reorder(&json!({ "projectId": "p", "ids": ["", 3] })),
            json!([
                { "path": "ids.0", "message": TOO_SHORT },
                { "path": "ids.1", "message": "Expected string, received number" },
            ])
        );
        assert_eq!(
            read(
                read_reorder,
                &json!({ "projectId": "p", "ids": ["a", "b"] })
            )
            .expect("valid"),
            ("p".to_owned(), vec!["a".to_owned(), "b".to_owned()])
        );

        let tick = |body: &Value| read(read_tick, body);
        assert_eq!(
            tick(&json!({ "met": "yes" })).expect_err("refused"),
            json!([{ "path": "met", "message": "Expected boolean, received string" }])
        );
        assert_eq!(
            tick(&json!({})).expect_err("refused"),
            json!([{ "path": "met", "message": "Required" }])
        );
        assert_eq!(
            tick(&json!({ "met": true, "x": 1 })).expect_err("refused"),
            json!([{ "path": "", "message": "Unrecognized key(s) in object: 'x'" }])
        );
        assert_eq!(tick(&json!({ "met": false })), Ok(false));
    }
}
