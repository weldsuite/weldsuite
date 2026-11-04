//! Change requests (`@weldsuite/flow-domain/changes`, FLOW-012 and FLOW-013):
//! routing by impact, the checks on the impact, "what changes once approved",
//! and `apply_approved_change`, which writes an approved change to the plan,
//! the budget, the baseline and the decision log in one batch. Rows are read
//! as `weldsuite_db::js_row` gives them; every message goes to the client as
//! it is.

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use weldsuite_db::{atomically, js_row};
use weldsuite_kit::generate_id;

use crate::approvals::{ApprovalRow, ApprovalRowInput};
use crate::baselines::{
    PlanDeliverable, PlanState, build_snapshot, day_delta, decimal, decimal_f64, decimal_sum,
    latest_baseline, load_plan_state,
};
use crate::js::{iso_from_millis, js_date, js_date_millis, slice_utf16, utf16_len};
use crate::numbering::{NumberSequence, allocate_number, allocate_numbers};

pub const OPEN_CHANGE_STATUSES: [&str; 3] = ["draft", "assessing", "awaiting_approval"];
/// How long the approvers get, in days from submission.
pub const CHANGE_APPROVAL_DUE_DAYS: i64 = 5;

pub mod messages {
    pub const NOT_EDITABLE: &str = "This change request can no longer be edited";
    pub const NOT_SUBMITTABLE: &str = "Only a draft or assessing change request can be submitted";
    pub const NOT_WITHDRAWABLE: &str = "Only an open change request can be withdrawn";
    pub const NOT_DELETABLE: &str = "Only a draft or withdrawn change request can be deleted";
    pub const WITHDRAW_DENIED: &str =
        "Only the requester or a project manager can withdraw this change request";
    pub const NO_MANAGER: &str = "This project has no project manager to approve the change";
    pub const BOARD_NOT_MEMBERS: &str = "Change board members must be members of this project";
    pub const TWICE_MILESTONE: &str = "A milestone can be moved only once in a change request";
    pub const TWICE_DELIVERABLE: &str = "A deliverable can be moved only once in a change request";
    pub const MOVED_AND_REMOVED: &str =
        "A deliverable cannot be moved and removed in the same change request";
    pub const START_AFTER_END: &str = "A deliverable cannot start after it ends";
}

pub fn unknown_milestone_message(id: &str) -> String {
    format!("Milestone {id} does not belong to this project")
}

pub fn unknown_deliverable_message(id: &str) -> String {
    format!("Deliverable {id} does not belong to this project")
}

pub fn is_open_change(status: &str) -> bool {
    OPEN_CHANGE_STATUSES.contains(&status)
}

// ── Numbering ───────────────────────────────────────────────────────────────

fn sequence(key: &str, project_id: &str, prefix: &'static str) -> NumberSequence {
    NumberSequence {
        scope: Cow::Owned(format!("{key}:{project_id}")),
        prefix,
    }
}

pub fn change_sequence(project_id: &str) -> NumberSequence {
    sequence("cr", project_id, "CR-")
}

pub fn decision_sequence(project_id: &str) -> NumberSequence {
    sequence("dec", project_id, "DEC-")
}

pub fn deliverable_sequence(project_id: &str) -> NumberSequence {
    sequence("del", project_id, "D")
}

pub fn change_code(number: i64) -> String {
    format!("CR-{number}")
}

pub fn decision_code(number: i64) -> String {
    format!("DEC-{number}")
}

pub fn deliverable_code(number: i64) -> String {
    format!("D{number}")
}

// ── Routing (FLOW-013) ──────────────────────────────────────────────────────

/// A project's change control rules over the defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeControl {
    pub cost_limit: f64,
    pub schedule_limit_days: i64,
    pub board_member_ids: Vec<String>,
}

fn whole(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        value as i64
    }
}

/// `effectiveChangeControl(settings)`: defaults 5.000, 5 days, no board.
pub fn effective_change_control(settings: &Value) -> ChangeControl {
    let own = settings.get("changeControl");
    let number = |key: &str| {
        own.and_then(|o| o.get(key))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    let mut board: Vec<String> = Vec::new();
    if let Some(ids) = own
        .and_then(|o| o.get("boardMemberIds"))
        .and_then(Value::as_array)
    {
        for id in ids
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if !board.iter().any(|b| b == id) {
                board.push(id.to_owned());
            }
        }
    }
    ChangeControl {
        cost_limit: number("costLimit").unwrap_or(5000.0),
        schedule_limit_days: number("scheduleLimitDays").map_or(5, whole),
        board_member_ids: board,
    }
}

/// `ChangeRouting`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeRouting {
    /// `manager` or `board`.
    pub route: &'static str,
    pub over_limit: bool,
    pub no_board: bool,
    pub cost_limit: f64,
    pub schedule_limit_days: i64,
    pub approver_ids: Vec<String>,
    pub rule_code: &'static str,
    pub params: Value,
}

impl ChangeRouting {
    /// `presentRouting`.
    pub fn present(&self) -> Value {
        json!({
            "route": self.route,
            "overLimit": self.over_limit,
            "costLimit": crate::js::number_value(self.cost_limit),
            "scheduleLimitDays": self.schedule_limit_days,
            "noBoard": self.no_board,
        })
    }
}

/// `amountOf(value)`: a number or numeric text, `None` for null, blank or not a number.
pub fn amount_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(text) if !text.is_empty() => {
            Some(weldsuite_kit::validation::js_number(text)).filter(|n| n.is_finite())
        }
        _ => None,
    }
}

/// `routeChange`: the project manager under both limits (saving money or time
/// stays with them), otherwise the whole board; with no board, the manager,
/// flagged.
pub fn route_change(
    cost_delta: Option<f64>,
    schedule_delta_days: Option<i64>,
    settings: &Value,
    project_manager_id: Option<&str>,
) -> ChangeRouting {
    let control = effective_change_control(settings);
    #[allow(clippy::cast_precision_loss)]
    let over_limit = cost_delta.unwrap_or(0.0) >= control.cost_limit
        || schedule_delta_days.unwrap_or(0) >= control.schedule_limit_days;
    let to_board = over_limit && !control.board_member_ids.is_empty();
    let no_board = over_limit && control.board_member_ids.is_empty();
    let manager = project_manager_id.filter(|m| !m.is_empty());
    ChangeRouting {
        route: if to_board { "board" } else { "manager" },
        over_limit,
        no_board,
        cost_limit: control.cost_limit,
        schedule_limit_days: control.schedule_limit_days,
        approver_ids: if to_board {
            control.board_member_ids.clone()
        } else {
            manager.map(str::to_owned).into_iter().collect()
        },
        rule_code: if to_board {
            "change_board_over_limit"
        } else {
            "change_manager"
        },
        params: json!({
            "costDelta": cost_delta.map(crate::js::number_value),
            "costLimit": crate::js::number_value(control.cost_limit),
            "scheduleDeltaDays": schedule_delta_days,
            "scheduleLimitDays": control.schedule_limit_days,
            "overLimit": over_limit,
            "noBoard": no_board,
        }),
    }
}

/// `changeApproverRows(routing, dueAt)`: all in step 1.
pub fn change_approver_rows(routing: &ChangeRouting, due_ms: i64) -> Vec<ApprovalRowInput> {
    routing
        .approver_ids
        .iter()
        .map(|id| {
            ApprovalRowInput::member(id.as_str(), routing.rule_code)
                .with_role_label(if routing.route == "board" {
                    "Change board"
                } else {
                    "Project manager"
                })
                .with_rule(routing.rule_code, &routing.params)
                .with_due_at(Some(due_ms))
        })
        .collect()
}

/// `boardOutsiders`.
#[allow(clippy::implicit_hasher)]
pub fn board_outsiders(board: &[String], members: &HashSet<String>) -> Vec<String> {
    board
        .iter()
        .filter(|id| !members.contains(*id))
        .cloned()
        .collect()
}

// ── Impact checks ───────────────────────────────────────────────────────────

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `changeImpactError(impact, known)`: milestone moves, deliverable moves,
/// removals, then the dates.
#[allow(clippy::implicit_hasher)]
pub fn change_impact_error(
    plan_changes: &Value,
    scope_changes: &Value,
    milestone_ids: &HashSet<String>,
    deliverable_ids: &HashSet<String>,
) -> Option<String> {
    let mut moved_milestones = HashSet::new();
    for item in array(plan_changes, "milestones") {
        let id = str_of(item, "milestoneId");
        if !milestone_ids.contains(id) {
            return Some(unknown_milestone_message(id));
        }
        if !moved_milestones.insert(id.to_owned()) {
            return Some(messages::TWICE_MILESTONE.to_owned());
        }
    }
    let mut moved = HashSet::new();
    for item in array(plan_changes, "deliverables") {
        let id = str_of(item, "deliverableId");
        if !deliverable_ids.contains(id) {
            return Some(unknown_deliverable_message(id));
        }
        if !moved.insert(id.to_owned()) {
            return Some(messages::TWICE_DELIVERABLE.to_owned());
        }
    }
    for id in array(scope_changes, "remove")
        .iter()
        .filter_map(Value::as_str)
    {
        if !deliverable_ids.contains(id) {
            return Some(unknown_deliverable_message(id));
        }
        if moved.contains(id) {
            return Some(messages::MOVED_AND_REMOVED.to_owned());
        }
    }
    let ranges = array(plan_changes, "deliverables")
        .iter()
        .map(|m| (m.get("plannedStart"), m.get("plannedEnd")))
        .chain(
            array(scope_changes, "add")
                .iter()
                .map(|a| (a.get("plannedStart"), a.get("plannedEnd"))),
        );
    for (start, end) in ranges {
        let at = |v: Option<&Value>| {
            v.and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .and_then(js_date_millis)
        };
        if let (Some(s), Some(e)) = (at(start), at(end))
            && s > e
        {
            return Some(messages::START_AFTER_END.to_owned());
        }
    }
    None
}

/// JSON with every object's keys in order; equal values print alike (`serde_json::Value` already compares so).
fn same_json(a: &Value, b: &Value) -> bool {
    a == b
}

/// `impactChanged(existing, data)`: a field of the impact present in `data`
/// that differs from the stored change.
pub fn impact_changed(existing: &Value, data: &Map<String, Value>) -> bool {
    if let Some(cost) = data.get("costDelta")
        && amount_of(cost) != amount_of(&existing["costDelta"])
    {
        return true;
    }
    if let Some(days) = data.get("scheduleDeltaDays")
        && days.as_i64() != existing["scheduleDeltaDays"].as_i64()
    {
        return true;
    }
    for key in ["planChanges", "scopeChanges"] {
        if let Some(value) = data.get(key)
            && !same_json(value, &existing[key])
        {
            return true;
        }
    }
    false
}

// ── Effects ─────────────────────────────────────────────────────────────────

fn iso_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(js_date)
}

/// `computeEffects(change, plan, applied)`: what the change does to the plan.
pub fn compute_effects(change: &Value, plan: &PlanState, applied: bool) -> Value {
    let plan_changes = change.get("planChanges").cloned().unwrap_or(Value::Null);
    let scope_changes = change.get("scopeChanges").cloned().unwrap_or(Value::Null);
    let mut milestones = Vec::new();
    for mv in array(&plan_changes, "milestones") {
        let Some(current) = plan
            .milestones
            .iter()
            .find(|m| m.id == str_of(mv, "milestoneId"))
        else {
            continue;
        };
        let from = if applied {
            None
        } else {
            js_date(&current.due_date)
        };
        let to = iso_of(mv.get("to")).unwrap_or_default();
        milestones.push(json!({
            "id": current.id, "name": current.name, "from": from, "to": to,
            "deltaDays": day_delta(from.as_deref(), Some(&to)),
        }));
    }
    let mut moved = Vec::new();
    for mv in array(&plan_changes, "deliverables") {
        let Some(current) = plan
            .deliverables
            .iter()
            .find(|d| d.id == str_of(mv, "deliverableId"))
        else {
            continue;
        };
        let pick = |key: &str, now: &Option<String>| {
            if mv.get(key).is_some() {
                iso_of(mv.get(key))
            } else {
                now.as_deref().and_then(js_date)
            }
        };
        moved.push(json!({
            "id": current.id, "code": deliverable_code(current.number), "title": current.title,
            "plannedStart": pick("plannedStart", &current.planned_start),
            "plannedEnd": pick("plannedEnd", &current.planned_end),
        }));
    }
    let added: Vec<Value> = array(&scope_changes, "add")
        .iter()
        .map(|a| json!({"title": a["title"], "plannedStart": iso_of(a.get("plannedStart")), "plannedEnd": iso_of(a.get("plannedEnd"))}))
        .collect();
    let mut removed = Vec::new();
    for id in array(&scope_changes, "remove")
        .iter()
        .filter_map(Value::as_str)
    {
        if let Some(current) = plan.deliverables.iter().find(|d| d.id == id) {
            removed.push(
                json!({"id": id, "code": deliverable_code(current.number), "title": current.title}),
            );
        }
    }
    let go_live_to = iso_of(plan_changes.get("goLive"));
    let go_live_from = if applied {
        None
    } else {
        plan.go_live.as_deref().and_then(js_date)
    };
    let delta = amount_of(&change["costDelta"]);
    let live = decimal(plan.budgeted_amount.as_deref());
    let budget = match delta {
        Some(d) if d != 0.0 => {
            let delta_text = decimal_f64(d).unwrap_or_default();
            let (from, to) = if applied {
                (
                    Some(decimal_sum(
                        live.as_deref(),
                        &decimal_f64(-d).unwrap_or_default(),
                    )),
                    live.clone(),
                )
            } else {
                (
                    live.clone(),
                    Some(decimal_sum(live.as_deref(), &delta_text)),
                )
            };
            json!({"currency": plan.budget_currency, "from": from, "to": to, "delta": delta_text})
        }
        _ => Value::Null,
    };
    json!({
        "goLive": go_live_to.as_ref().map_or(Value::Null, |to| json!({
            "from": go_live_from, "to": to, "deltaDays": day_delta(go_live_from.as_deref(), Some(to)),
        })),
        "milestones": milestones,
        "deliverables": {"moved": moved, "added": added, "removed": removed},
        "budget": budget,
    })
}

fn day_of(iso: Option<&str>) -> String {
    iso.map_or_else(|| "no date".to_owned(), |s| s.chars().take(10).collect())
}

/// `consequenceLines(effects)`: one plain line per effect.
pub fn consequence_lines(effects: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(go_live) = effects.get("goLive").filter(|g| !g.is_null()) {
        lines.push(format!(
            "Go-live moves to {}",
            day_of(go_live["to"].as_str())
        ));
    }
    for m in array(effects, "milestones") {
        lines.push(format!(
            "Milestone \"{}\" moves to {}",
            str_of(m, "name"),
            day_of(m["to"].as_str())
        ));
    }
    let d = &effects["deliverables"];
    for x in array(d, "moved") {
        lines.push(format!(
            "Deliverable {} \"{}\" is rescheduled",
            str_of(x, "code"),
            str_of(x, "title")
        ));
    }
    for x in array(d, "added") {
        lines.push(format!(
            "Deliverable \"{}\" is added to the scope",
            str_of(x, "title")
        ));
    }
    for x in array(d, "removed") {
        lines.push(format!(
            "Deliverable {} \"{}\" is removed from the scope",
            str_of(x, "code"),
            str_of(x, "title")
        ));
    }
    if let Some(b) = effects.get("budget").filter(|b| !b.is_null()) {
        let delta = str_of(b, "delta");
        let word = if delta.starts_with('-') {
            "falls"
        } else {
            "rises"
        };
        let currency = b["currency"]
            .as_str()
            .map(|c| format!(" {c}"))
            .unwrap_or_default();
        lines.push(format!(
            "The budget {word} by {}{currency}",
            delta.trim_start_matches('-')
        ));
    }
    lines
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// `presentChangeRequest(row)`.
pub fn present_change_request(row: &Value) -> Value {
    let number = row["number"].as_i64().unwrap_or(0);
    let or_null = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": row["id"], "projectId": row["projectId"], "number": number,
        "code": change_code(number), "title": row["title"],
        "description": or_null("description"), "requestedBy": or_null("requestedBy"),
        "requestedByName": or_null("requestedByName"), "status": row["status"],
        "costDelta": or_null("costDelta"), "scheduleDeltaDays": or_null("scheduleDeltaDays"),
        "planChanges": or_null("planChanges"), "scopeChanges": or_null("scopeChanges"),
        "route": or_null("route"), "submittedAt": or_null("submittedAt"),
        "decidedAt": or_null("decidedAt"), "baselineId": or_null("baselineId"),
        "clientVisible": row["clientVisible"], "createdBy": row["createdBy"],
        "createdAt": row["createdAt"], "updatedAt": row["updatedAt"],
        "deletedAt": or_null("deletedAt"),
    })
}

/// `changeEventData(row)`.
pub fn change_event_data(row: &Value) -> Value {
    let number = row["number"].as_i64().unwrap_or(0);
    let or_null = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": row["id"], "projectId": row["projectId"], "number": number,
        "code": change_code(number), "title": row["title"], "status": row["status"],
        "route": or_null("route"), "costDelta": or_null("costDelta"),
        "scheduleDeltaDays": or_null("scheduleDeltaDays"), "requestedBy": or_null("requestedBy"),
    })
}

/// `decisionEventData(row)`.
pub fn decision_event_data(row: &Value) -> Value {
    let number = row["number"].as_i64().unwrap_or(0);
    json!({
        "id": row["id"], "projectId": row["projectId"], "number": number,
        "code": decision_code(number), "title": row["title"], "status": row["status"],
        "decidedBy": row.get("decidedBy").cloned().unwrap_or(Value::Null),
    })
}

// ── Database ────────────────────────────────────────────────────────────────

/// `findChangeRequest(db, id)`: a live change as `js_row` reads it.
pub async fn find_change_request(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) || jsonb_build_object('cost_delta', c.cost_delta::text)
         from project_change_requests c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `listPendingChanges(db, projectId)`: assessing and awaiting approval, newest first.
pub async fn list_pending_changes(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(c) || jsonb_build_object('cost_delta', c.cost_delta::text)
         from project_change_requests c
         where c.project_id = $1 and c.deleted_at is null and c.status in ('assessing', 'awaiting_approval')
         order by c.created_at desc, c.id desc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

fn clip(text: &str) -> String {
    if utf16_len(text) > 255 {
        format!("{}…", slice_utf16(text, 254).trim_end())
    } else {
        text.to_owned()
    }
}

/// What `apply_approved_change` and `record_rejected_change` did.
#[derive(Debug, Clone, Default)]
pub struct AppliedChange {
    /// False: the change was not waiting for approval, so nothing was written.
    pub applied: bool,
    pub change: Option<Value>,
    /// None while the project has no baseline to move.
    pub baseline: Option<Value>,
    pub decision: Option<Value>,
}

const INSERT_DELIVERABLE: &str = "insert into project_deliverables (id, project_id, number, title, description, owner_id,
        status, planned_start, planned_end, acceptance_criteria, position, client_visible, created_by,
        created_at, updated_at)
    select p.id, p.project_id, p.number, p.title, p.description, p.owner_id, p.status, p.planned_start,
        p.planned_end, p.acceptance_criteria, p.position, p.client_visible, p.created_by, p.created_at,
        p.updated_at
    from jsonb_populate_record(null::project_deliverables, $1) p";
const INSERT_BASELINE: &str = "insert into project_baselines (id, project_id, version, change_request_id, snapshot,
        created_by, created_at)
    select p.id, p.project_id, p.version, p.change_request_id, p.snapshot, p.created_by, p.created_at
    from jsonb_populate_record(null::project_baselines, $1) p";
const INSERT_DECISION: &str =
    "insert into project_decisions (id, project_id, number, title, status, context, options,
        consequences, decided_by, decided_at, created_by, created_at, updated_at)
    select p.id, p.project_id, p.number, p.title, p.status, p.context, p.options, p.consequences,
        p.decided_by, p.decided_at, p.created_by, p.created_at, p.updated_at
    from jsonb_populate_record(null::project_decisions, $1) p";

type Statement = Query<'static, sqlx::Postgres, PgArguments>;

fn insert(sql: &'static str, row: Value) -> Statement {
    sqlx::query(sql).bind(row)
}

#[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
fn decision_row(
    change: &Value,
    id: &str,
    number: i64,
    title: String,
    context: String,
    options: Value,
    consequences: Vec<String>,
    actor: &str,
    now: &str,
) -> Value {
    json!({
        "id": id, "project_id": change["projectId"], "number": number, "title": title,
        "status": "decided", "context": context, "options": options, "consequences": consequences,
        "decided_by": actor, "decided_at": now, "created_by": change["createdBy"],
        "created_at": now, "updated_at": now,
    })
}

async fn read_back(
    db: &PgPool,
    change_id: &str,
    baseline_id: Option<&str>,
    decision_id: &str,
) -> Result<AppliedChange, sqlx::Error> {
    let change = find_change_request(db, change_id).await?;
    let baseline = match baseline_id {
        Some(id) => crate::baselines::find_baseline(db, id).await?,
        None => None,
    };
    let decision: Option<Value> =
        sqlx::query_scalar("select to_jsonb(d) from project_decisions d where d.id = $1")
            .bind(decision_id)
            .fetch_optional(db)
            .await?;
    Ok(AppliedChange {
        applied: true,
        change,
        baseline,
        decision: decision.map(js_row),
    })
}

/// `applyApprovedChange(db, changeId, { actorId, now })`: the plan moves, the
/// scope changes, the budget, the next baseline (none without one), a decided
/// decision and the status, in one batch. Idempotent: a change that is no
/// longer `awaiting_approval` is left alone.
#[allow(clippy::too_many_lines)]
pub async fn apply_approved_change(
    db: &PgPool,
    change_id: &str,
    actor_id: Option<&str>,
    now_ms: i64,
) -> Result<AppliedChange, sqlx::Error> {
    let skipped = |change: Option<Value>| AppliedChange {
        applied: false,
        change,
        baseline: None,
        decision: None,
    };
    let Some(change) = find_change_request(db, change_id).await? else {
        return Ok(skipped(None));
    };
    if change["status"] != "awaiting_approval" {
        return Ok(skipped(Some(change)));
    }
    let project_id = str_of(&change, "projectId").to_owned();
    let Some(plan) = load_plan_state(db, &project_id).await? else {
        return Ok(skipped(Some(change)));
    };
    let now = iso_from_millis(now_ms).unwrap_or_default();
    let actor = actor_id
        .unwrap_or_else(|| str_of(&change, "createdBy"))
        .to_owned();
    let plan_changes = change.get("planChanges").cloned().unwrap_or(Value::Null);
    let scope_changes = change.get("scopeChanges").cloned().unwrap_or(Value::Null);
    let effects = compute_effects(&change, &plan, false);

    let milestone_moves: Vec<(String, String)> = array(&plan_changes, "milestones")
        .iter()
        .filter(|m| {
            plan.milestones
                .iter()
                .any(|p| p.id == str_of(m, "milestoneId"))
        })
        .map(|m| {
            (
                str_of(m, "milestoneId").to_owned(),
                iso_of(m.get("to")).unwrap_or_default(),
            )
        })
        .collect();
    let deliverable_moves: Vec<&Value> = array(&plan_changes, "deliverables")
        .iter()
        .filter(|m| {
            plan.deliverables
                .iter()
                .any(|d| d.id == str_of(m, "deliverableId"))
        })
        .collect();
    let remove_ids: Vec<String> = array(&scope_changes, "remove")
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| plan.deliverables.iter().any(|d| d.id == *id))
        .map(str::to_owned)
        .collect();
    let adds = array(&scope_changes, "add");
    let numbers = allocate_numbers(
        db,
        &deliverable_sequence(&project_id),
        i64::try_from(adds.len()).unwrap_or(0),
    )
    .await?;
    let max_position: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from project_deliverables where project_id = $1 and deleted_at is null",
    )
    .bind(&project_id)
    .fetch_one(db)
    .await?;
    let added: Vec<(String, i64, &Value, i64)> = adds
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let i64_i = i64::try_from(i).unwrap_or(0);
            (
                generate_id("del"),
                numbers.get(i).copied().unwrap_or(0),
                item,
                i64::from(max_position) + 1 + i64_i,
            )
        })
        .collect();

    // The plan as it will be once the writes below have run.
    let mut after = plan.clone();
    if let Some(go_live) = iso_of(plan_changes.get("goLive")) {
        after.go_live = Some(go_live);
    }
    for m in &mut after.milestones {
        if let Some((_, to)) = milestone_moves.iter().find(|(id, _)| *id == m.id) {
            m.due_date.clone_from(to);
        }
    }
    after.deliverables.retain(|d| !remove_ids.contains(&d.id));
    for d in &mut after.deliverables {
        if let Some(mv) = deliverable_moves
            .iter()
            .find(|m| str_of(m, "deliverableId") == d.id)
        {
            if mv.get("plannedStart").is_some() {
                d.planned_start = iso_of(mv.get("plannedStart"));
            }
            if mv.get("plannedEnd").is_some() {
                d.planned_end = iso_of(mv.get("plannedEnd"));
            }
        }
    }
    for (id, number, item, _) in &added {
        after.deliverables.push(PlanDeliverable {
            id: id.clone(),
            number: *number,
            title: str_of(item, "title").to_owned(),
            planned_start: iso_of(item.get("plannedStart")),
            planned_end: iso_of(item.get("plannedEnd")),
        });
    }
    let budget_to = effects
        .get("budget")
        .filter(|b| !b.is_null())
        .and_then(|b| b["to"].as_str())
        .map(str::to_owned);
    if budget_to.is_some() {
        after.budgeted_amount.clone_from(&budget_to);
    }

    let previous = latest_baseline(db, &project_id).await?;
    let baseline_id = previous.as_ref().map(|_| generate_id("bsl"));
    let code = change_code(change["number"].as_i64().unwrap_or(0));
    let decision_number = allocate_number(db, &decision_sequence(&project_id)).await?;
    let decision_id = generate_id("dec");
    let description = change["description"].as_str().filter(|d| !d.is_empty());
    let context = [
        Some(format!("Change request {code} was approved.")),
        description.map(str::to_owned),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let decision = decision_row(
        &change,
        &decision_id,
        decision_number,
        clip(&format!("{code}: {}", str_of(&change, "title"))),
        context,
        json!([{"title": "Approve the change", "note": null, "chosen": true}, {"title": "Reject the change", "note": null, "chosen": false}]),
        consequence_lines(&effects),
        &actor,
        &now,
    );

    let mut statements: Vec<Statement> = Vec::new();
    for (id, to) in &milestone_moves {
        statements.push(
            sqlx::query("update milestones set due_date = $2::timestamp, updated_at = $3::timestamp where id = $1 and project_id = $4 and deleted_at is null")
                .bind(id.clone()).bind(to.clone()).bind(now.clone()).bind(project_id.clone()),
        );
    }
    for mv in &deliverable_moves {
        let (has_start, has_end) = (
            mv.get("plannedStart").is_some(),
            mv.get("plannedEnd").is_some(),
        );
        statements.push(
            sqlx::query(
                "update project_deliverables set
                    planned_start = case when $2::bool then $3::timestamptz else planned_start end,
                    planned_end = case when $4::bool then $5::timestamptz else planned_end end,
                    updated_at = $6::timestamptz
                 where id = $1 and project_id = $7 and deleted_at is null",
            )
            .bind(str_of(mv, "deliverableId").to_owned())
            .bind(has_start)
            .bind(iso_of(mv.get("plannedStart")))
            .bind(has_end)
            .bind(iso_of(mv.get("plannedEnd")))
            .bind(now.clone())
            .bind(project_id.clone()),
        );
    }
    if !remove_ids.is_empty() {
        statements.push(
            sqlx::query("update project_deliverables set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = any($1) and project_id = $3 and deleted_at is null")
                .bind(remove_ids.clone()).bind(now.clone()).bind(project_id.clone()),
        );
        statements.push(
            sqlx::query("update tasks set deliverable_id = null, updated_at = $2::timestamp where deliverable_id = any($1)")
                .bind(remove_ids.clone()).bind(now.clone()),
        );
    }
    for (id, number, item, position) in &added {
        statements.push(insert(
            INSERT_DELIVERABLE,
            json!({
                "id": id, "project_id": project_id, "number": number, "title": item["title"],
                "description": item.get("description").cloned().unwrap_or(Value::Null),
                "owner_id": item.get("ownerId").cloned().unwrap_or(Value::Null),
                "status": "not_started", "planned_start": iso_of(item.get("plannedStart")),
                "planned_end": iso_of(item.get("plannedEnd")), "acceptance_criteria": [],
                "position": position, "client_visible": false, "created_by": actor,
                "created_at": now, "updated_at": now,
            }),
        ));
    }
    let go_live = iso_of(plan_changes.get("goLive"));
    if go_live.is_some() || budget_to.is_some() {
        statements.push(
            sqlx::query("update projects set updated_at = $2::timestamp,
                    end_date = case when $3::text is null then end_date else $3::timestamp end,
                    budgeted_amount = case when $4::text is null then budgeted_amount else $4::numeric end
                 where id = $1")
                .bind(project_id.clone()).bind(now.clone()).bind(go_live).bind(budget_to),
        );
    }
    if let (Some(prev), Some(id)) = (&previous, &baseline_id) {
        statements.push(insert(INSERT_BASELINE, json!({
            "id": id, "project_id": project_id, "version": prev["version"].as_i64().unwrap_or(0) + 1,
            "change_request_id": change_id, "snapshot": build_snapshot(&after),
            "created_by": actor, "created_at": now,
        })));
    }
    statements.push(insert(INSERT_DECISION, decision));
    let recorded_scope: Option<Value> = if change["scopeChanges"].is_null() {
        None
    } else {
        let mut scope = scope_changes.clone();
        if !added.is_empty()
            && let Value::Object(map) = &mut scope
        {
            let with_ids: Vec<Value> = added
                .iter()
                .map(|(id, _, item, _)| {
                    let mut item = (*item).clone();
                    if let Value::Object(fields) = &mut item {
                        fields.insert("deliverableId".to_owned(), json!(id));
                    }
                    item
                })
                .collect();
            map.insert("add".to_owned(), Value::Array(with_ids));
        }
        Some(scope)
    };
    statements.push(
        sqlx::query(
            "update project_change_requests set status = 'approved', decided_at = $2::timestamptz,
                baseline_id = $3, scope_changes = $4::jsonb, updated_at = $2::timestamptz
             where id = $1 and status = 'awaiting_approval'",
        )
        .bind(change_id.to_owned())
        .bind(now.clone())
        .bind(baseline_id.clone())
        .bind(recorded_scope),
    );
    atomically(db, statements).await?;
    read_back(db, change_id, baseline_id.as_deref(), &decision_id).await
}

/// `recordRejectedChange(db, changeId, { actorId, rows, now })`: `rejected`,
/// and a decided decision with the rejecting approver's reason.
pub async fn record_rejected_change(
    db: &PgPool,
    change_id: &str,
    actor_id: Option<&str>,
    rows: &[ApprovalRow],
    now_ms: i64,
) -> Result<AppliedChange, sqlx::Error> {
    let Some(change) = find_change_request(db, change_id).await? else {
        return Ok(AppliedChange::default());
    };
    if change["status"] != "awaiting_approval" {
        return Ok(AppliedChange {
            change: Some(change),
            ..AppliedChange::default()
        });
    }
    let now = iso_from_millis(now_ms).unwrap_or_default();
    let project_id = str_of(&change, "projectId").to_owned();
    let rejecting = rows.iter().find(|r| r.decision == "rejected");
    let actor = rejecting
        .and_then(|r| r.decided_by.as_deref())
        .or(actor_id)
        .unwrap_or_else(|| str_of(&change, "createdBy"))
        .to_owned();
    let code = change_code(change["number"].as_i64().unwrap_or(0));
    let number = allocate_number(db, &decision_sequence(&project_id)).await?;
    let id = generate_id("dec");
    let note = rejecting.and_then(|r| r.note.clone());
    let reason = note
        .as_ref()
        .filter(|n| !n.is_empty())
        .map(|n| format!("Reason: {n}"));
    let description = change["description"]
        .as_str()
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    let context = [
        Some(format!("Change request {code} was rejected.")),
        reason,
        description,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let decision = decision_row(
        &change,
        &id,
        number,
        clip(&format!("{code} rejected: {}", str_of(&change, "title"))),
        context,
        json!([{"title": "Approve the change", "note": null, "chosen": false}, {"title": "Reject the change", "note": note, "chosen": true}]),
        vec!["The change was not applied.".to_owned()],
        &actor,
        &now,
    );
    atomically(
        db,
        vec![
            insert(INSERT_DECISION, decision),
            sqlx::query("update project_change_requests set status = 'rejected', decided_at = $2::timestamptz,
                    updated_at = $2::timestamptz where id = $1 and status = 'awaiting_approval'")
                .bind(change_id.to_owned()).bind(now.clone()),
        ],
    )
    .await?;
    read_back(db, change_id, None, &id).await
}

#[cfg(test)]
#[allow(clippy::assert_is_empty)]
mod tests {
    use super::*;

    fn plan() -> PlanState {
        use crate::baselines::PlanMilestone;
        PlanState {
            go_live: Some("2026-12-01T00:00:00.000Z".into()),
            milestones: vec![PlanMilestone {
                id: "m1".into(),
                name: "Beta".into(),
                due_date: "2026-11-20T00:00:00.000Z".into(),
            }],
            deliverables: vec![
                PlanDeliverable {
                    id: "d1".into(),
                    number: 1,
                    title: "App".into(),
                    planned_start: Some("2026-11-01T00:00:00.000Z".into()),
                    planned_end: Some("2026-11-15T00:00:00.000Z".into()),
                },
                PlanDeliverable {
                    id: "d2".into(),
                    number: 2,
                    title: "Manual".into(),
                    planned_start: None,
                    planned_end: None,
                },
            ],
            budgeted_amount: Some("12000.00".into()),
            budget_currency: Some("EUR".into()),
            ..PlanState::default()
        }
    }

    fn change() -> Value {
        json!({
            "costDelta": "8000.00",
            "planChanges": {"goLive": "2026-12-09T00:00:00.000Z",
                "milestones": [{"milestoneId": "m1", "to": "2026-11-28T00:00:00.000Z"}],
                "deliverables": [{"deliverableId": "d1", "plannedEnd": "2026-11-22T00:00:00.000Z"}]},
            "scopeChanges": {"add": [{"title": "Training"}], "remove": ["d2"]},
        })
    }

    #[test]
    fn numbering_is_per_register_and_project() {
        assert_eq!(change_sequence("p1").scope, "cr:p1");
        assert_eq!(decision_sequence("p1").prefix, "DEC-");
        assert_eq!(deliverable_sequence("p1").scope, "del:p1");
        assert_eq!(change_code(8), "CR-8");
        assert_eq!(deliverable_code(3), "D3");
    }

    #[test]
    fn rules_default_and_override() {
        let d = effective_change_control(&Value::Null);
        assert_eq!(
            (
                d.cost_limit,
                d.schedule_limit_days,
                d.board_member_ids.len()
            ),
            (5000.0, 5, 0)
        );
        let own = effective_change_control(
            &json!({"changeControl": {"costLimit": 1000, "scheduleLimitDays": 2, "boardMemberIds": ["a", "b", "a"]}}),
        );
        assert_eq!((own.cost_limit, own.schedule_limit_days), (1000.0, 2));
        assert_eq!(own.board_member_ids, ["a", "b"]);
    }

    #[test]
    fn routing_follows_the_impact() {
        let settings = json!({"changeControl": {"costLimit": 5000, "scheduleLimitDays": 5, "boardMemberIds": ["b1", "b2"]}});
        let under = route_change(Some(4999.99), Some(4), &settings, Some("pm"));
        assert_eq!(
            (under.route, under.over_limit, under.approver_ids.clone()),
            ("manager", false, vec!["pm".to_owned()])
        );
        let cost = route_change(Some(5000.0), None, &settings, Some("pm"));
        assert_eq!(
            (cost.route, cost.rule_code),
            ("board", "change_board_over_limit")
        );
        assert_eq!(cost.approver_ids, ["b1", "b2"]);
        assert_eq!(
            route_change(None, Some(5), &settings, Some("pm")).route,
            "board"
        );
        assert_eq!(
            route_change(Some(-90_000.0), Some(-30), &settings, Some("pm")).route,
            "manager"
        );
        let none = route_change(Some(8000.0), Some(0), &json!({}), Some("pm"));
        assert_eq!(
            (none.route, none.over_limit, none.no_board),
            ("manager", true, true)
        );
        assert!(
            route_change(Some(1.0), Some(1), &json!({}), None)
                .approver_ids
                .is_empty()
        );
        assert_eq!(none.params["noBoard"], true);
        let rows = change_approver_rows(&cost, 7);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role_label.as_deref(), Some("Change board"));
        assert_eq!(rows[0].rule["params"]["costDelta"], 5000);
        assert_eq!(
            board_outsiders(&["a".into(), "b".into()], &HashSet::from(["a".to_owned()])),
            ["b"]
        );
    }

    #[test]
    fn impact_checks_run_in_order() {
        let known = |ids: &[&str]| ids.iter().map(|s| (*s).to_owned()).collect::<HashSet<_>>();
        let (m, d) = (known(&["m1"]), known(&["d1", "d2"]));
        let to = "2026-11-20T00:00:00.000Z";
        assert_eq!(
            change_impact_error(
                &json!({"milestones": [{"milestoneId": "m1", "to": to}]}),
                &json!({"remove": ["d2"]}),
                &m,
                &d
            ),
            None
        );
        assert_eq!(
            change_impact_error(
                &json!({"milestones": [{"milestoneId": "x", "to": to}]}),
                &Value::Null,
                &m,
                &d
            ),
            Some(unknown_milestone_message("x"))
        );
        assert_eq!(
            change_impact_error(&Value::Null, &json!({"remove": ["z"]}), &m, &d),
            Some(unknown_deliverable_message("z"))
        );
        assert_eq!(
            change_impact_error(
                &json!({"milestones": [{"milestoneId": "m1"}, {"milestoneId": "m1"}]}),
                &Value::Null,
                &m,
                &d
            )
            .as_deref(),
            Some(messages::TWICE_MILESTONE)
        );
        assert_eq!(
            change_impact_error(
                &json!({"deliverables": [{"deliverableId": "d1"}]}),
                &json!({"remove": ["d1"]}),
                &m,
                &d
            )
            .as_deref(),
            Some(messages::MOVED_AND_REMOVED)
        );
        assert_eq!(change_impact_error(&json!({"deliverables": [{"deliverableId": "d1", "plannedStart": "2026-12-01T00:00:00.000Z", "plannedEnd": to}]}), &Value::Null, &m, &d).as_deref(), Some(messages::START_AFTER_END));
    }

    #[test]
    fn effects_and_consequences() {
        let effects = compute_effects(&change(), &plan(), false);
        assert_eq!(effects["goLive"]["deltaDays"], 8);
        assert_eq!(effects["milestones"][0]["from"], "2026-11-20T00:00:00.000Z");
        assert_eq!(
            effects["deliverables"]["moved"][0]["plannedEnd"],
            "2026-11-22T00:00:00.000Z"
        );
        assert_eq!(
            effects["budget"],
            json!({"currency": "EUR", "from": "12000.00", "to": "20000.00", "delta": "8000.00"})
        );
        assert_eq!(
            consequence_lines(&effects),
            [
                "Go-live moves to 2026-12-09",
                "Milestone \"Beta\" moves to 2026-11-28",
                "Deliverable D1 \"App\" is rescheduled",
                "Deliverable \"Training\" is added to the scope",
                "Deliverable D2 \"Manual\" is removed from the scope",
                "The budget rises by 8000.00 EUR",
            ]
        );
        let applied = compute_effects(&change(), &plan(), true);
        assert!(applied["goLive"]["from"].is_null());
        assert_eq!(applied["budget"]["from"], "4000.00");
        let none = compute_effects(&json!({"costDelta": null}), &plan(), false);
        assert!(none["budget"].is_null() && none["goLive"].is_null());
        let saves = compute_effects(&json!({"costDelta": "-250.00"}), &plan(), false);
        assert_eq!(
            consequence_lines(&saves),
            ["The budget falls by 250.00 EUR"]
        );
    }

    #[test]
    fn impact_changed_ignores_the_same_impact() {
        let existing = json!({"costDelta": "8000.00", "scheduleDeltaDays": 4,
            "planChanges": {"milestones": [{"milestoneId": "m1", "to": "x"}]}, "scopeChanges": null});
        let data = |v: Value| v.as_object().cloned().unwrap_or_default();
        assert!(!impact_changed(&existing, &data(json!({}))));
        assert!(!impact_changed(
            &existing,
            &data(
                json!({"costDelta": 8000, "scheduleDeltaDays": 4, "scopeChanges": null, "planChanges": {"milestones": [{"to": "x", "milestoneId": "m1"}]}})
            )
        ));
        assert!(impact_changed(&existing, &data(json!({"costDelta": 8001}))));
        assert!(impact_changed(&existing, &data(json!({"costDelta": null}))));
        assert!(impact_changed(
            &existing,
            &data(json!({"scheduleDeltaDays": null}))
        ));
        assert!(impact_changed(
            &existing,
            &data(json!({"planChanges": null}))
        ));
        assert!(impact_changed(
            &existing,
            &data(json!({"scopeChanges": {"remove": ["d1"]}}))
        ));
    }
}
