//! The approvals the governance registers ask for: proposed decisions (rule
//! `decision`) and deliverable sign-off (rules `deliverable_sponsor` and
//! `deliverable_client`), FLOW-016.
//!
//! TODO(slice A): use approvals.rs. Slice A ports the approvals core
//! (`@weldsuite/flow-domain/approvals`) to `rust/crates/flow-domain/src/
//! approvals.rs`; until it is merged this is a thin local adapter. Every type
//! and function of the first half has the name, shape and behaviour of slice
//! A's (`ApprovalRow`, `ApprovalRowInput`, `ApprovalSubjectHandler`,
//! `ApprovalResolutionContext`, `ResolvedApprovalOutcome`, `ApprovalActor`,
//! `register_approval_subject`, `request_approvals`, `list_subject_approvals`,
//! `cancel_pending_approvals`, `sponsor_of`), so the integrator deletes that
//! half and imports `weldsuite_flow_domain::approvals::*` in its place. The
//! second half is slice B's own: the two subject handlers
//! ([`DecisionHandler`], [`DeliverableHandler`], registered from the routers'
//! constructors), the `flow_approval` event payload and
//! [`publish_approval_subject_resolved`] for slice A's decide route
//! (`services/governance-approvals.ts`).

// Slice A's half is its API surface verbatim: parts of it are dead until its decide route
// calls them, and it is `pub` the way theirs is.
#![allow(dead_code, unreachable_pub)]

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    FLOW_APPROVAL_CANCELLED, FLOW_APPROVAL_REQUESTED, PROJECT_DECISION_DECIDED,
    PROJECT_DELIVERABLE_ACCEPTED, PROJECT_DELIVERABLE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::decisions::{decision_event_data, decision_resolution};
use weldsuite_flow_domain::deliverables::{
    DeliverableResolution, SignoffRow, deliverable_event_data, deliverable_resolution,
};
use weldsuite_flow_domain::js::{iso_from_millis, millis_of};
use weldsuite_kit::generate_id;

use crate::{Caller, FlowState};

// ── Slice A's approvals core, as far as slice B calls it ────────────────────

/// `APPROVAL_SUBJECT_TYPES`.
pub const APPROVAL_SUBJECT_TYPES: [&str; 7] = [
    "change_request",
    "gate",
    "deliverable",
    "decision",
    "risk_acceptance",
    "project_request",
    "project_close",
];

/// `APPROVER_KINDS`.
pub const APPROVER_KINDS: [&str; 2] = ["member", "contact"];

/// `OPEN_DECISIONS`: not answered yet, or the approver asked for more information.
pub const OPEN_DECISIONS: [&str; 2] = ["pending", "info_requested"];

/// `APPROVAL_MESSAGES`.
pub mod messages {
    pub const NO_APPROVERS: &str = "At least one approver is required";
    pub const INVALID_SUBJECT: &str = "Unknown approval subject type";
    pub const INVALID_APPROVER: &str = "Every approver needs a kind and an id";
    pub const INVALID_STEP: &str = "A step is a whole number of 1 or more";
    pub const INVALID_RULE: &str = "Every approval needs the rule that selected the approver";
    pub const ALREADY_REQUESTED: &str = "Approvals have already been requested for this subject";
}

/// An outcome that settled the subject (`ResolvedApprovalOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedApprovalOutcome {
    Approved,
    Rejected,
}

/// Who answers: a member (user id) or a CRM contact on the client portal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalActor {
    pub kind: String,
    pub id: String,
}

/// A `flow_approvals` row (`ApprovalRow`). Times are epoch milliseconds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApprovalRow {
    pub id: String,
    pub project_id: Option<String>,
    pub subject_type: String,
    pub subject_id: String,
    pub approver_kind: String,
    pub approver_id: String,
    pub role_label: Option<String>,
    pub step: i64,
    pub rule: Value,
    pub decision: String,
    pub note: Option<String>,
    pub due_at: Option<i64>,
    pub decided_at: Option<i64>,
    pub decided_by: Option<String>,
    pub delegated_from: Option<String>,
    pub reminded_at: Option<i64>,
    pub overdue_notified_at: Option<i64>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

fn text_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn millis_field(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(Value::as_str).and_then(millis_of)
}

fn iso_field(millis: Option<i64>) -> Value {
    millis
        .and_then(iso_from_millis)
        .map_or(Value::Null, Value::String)
}

impl ApprovalRow {
    /// A row as `js_row` gives it (camelCase keys, ISO timestamps).
    pub fn from_json(row: &Value) -> Option<Self> {
        Some(Self {
            id: text_of(row, "id")?,
            project_id: text_of(row, "projectId"),
            subject_type: text_of(row, "subjectType")?,
            subject_id: text_of(row, "subjectId")?,
            approver_kind: text_of(row, "approverKind")?,
            approver_id: text_of(row, "approverId")?,
            role_label: text_of(row, "roleLabel"),
            step: row.get("step").and_then(Value::as_i64).unwrap_or(1),
            rule: row.get("rule").cloned().unwrap_or(Value::Null),
            decision: text_of(row, "decision")?,
            note: text_of(row, "note"),
            due_at: millis_field(row, "dueAt"),
            decided_at: millis_field(row, "decidedAt"),
            decided_by: text_of(row, "decidedBy"),
            delegated_from: text_of(row, "delegatedFrom"),
            reminded_at: millis_field(row, "remindedAt"),
            overdue_notified_at: millis_field(row, "overdueNotifiedAt"),
            created_by: text_of(row, "createdBy")?,
            created_at: millis_field(row, "createdAt")?,
            updated_at: millis_field(row, "updatedAt")?,
            deleted_at: millis_field(row, "deletedAt"),
        })
    }

    /// The row as a Drizzle row reads (`js_row`'s shape).
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "projectId": self.project_id,
            "subjectType": self.subject_type,
            "subjectId": self.subject_id,
            "approverKind": self.approver_kind,
            "approverId": self.approver_id,
            "roleLabel": self.role_label,
            "step": self.step,
            "rule": self.rule,
            "decision": self.decision,
            "note": self.note,
            "dueAt": iso_field(self.due_at),
            "decidedAt": iso_field(self.decided_at),
            "decidedBy": self.decided_by,
            "delegatedFrom": self.delegated_from,
            "remindedAt": iso_field(self.reminded_at),
            "overdueNotifiedAt": iso_field(self.overdue_notified_at),
            "createdBy": self.created_by,
            "createdAt": iso_field(Some(self.created_at)),
            "updatedAt": iso_field(Some(self.updated_at)),
            "deletedAt": iso_field(self.deleted_at),
        })
    }
}

/// A `flow_approval_delegations` row (`ApprovalDelegationRow`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DelegationRow {
    pub id: String,
    pub member_id: String,
    pub delegate_id: String,
    pub starts_at: i64,
    pub ends_at: i64,
    pub deleted_at: Option<i64>,
}

impl DelegationRow {
    pub fn from_json(row: &Value) -> Option<Self> {
        Some(Self {
            id: text_of(row, "id")?,
            member_id: text_of(row, "memberId")?,
            delegate_id: text_of(row, "delegateId")?,
            starts_at: millis_field(row, "startsAt")?,
            ends_at: millis_field(row, "endsAt")?,
            deleted_at: millis_field(row, "deletedAt"),
        })
    }
}

/// `activeDelegation(delegations, memberId, now)`: the delegation in force for
/// a member at `now_ms`; when several overlap, the one that started last wins,
/// then the lowest id.
pub fn active_delegation<'a>(
    delegations: &'a [DelegationRow],
    member_id: &str,
    now_ms: i64,
) -> Option<&'a DelegationRow> {
    let mut active: Vec<&DelegationRow> = delegations
        .iter()
        .filter(|row| {
            row.deleted_at.is_none()
                && row.member_id == member_id
                && row.starts_at <= now_ms
                && now_ms < row.ends_at
        })
        .collect();
    active.sort_by(|a, b| b.starts_at.cmp(&a.starts_at).then_with(|| a.id.cmp(&b.id)));
    active.first().copied()
}

/// `sponsorOf(settings, projectManagerId)`: `settings.sponsorId`, else the
/// project manager (`||`: an empty id falls through).
pub fn sponsor_of(settings: Option<&Value>, project_manager_id: Option<&str>) -> Option<String> {
    settings
        .and_then(|settings| settings.get("sponsorId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .or(project_manager_id.filter(|id| !id.is_empty()))
        .map(str::to_owned)
}

/// One approver of a request (`ApprovalRowInput`): who, in which step, and the
/// rule that selected them.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRowInput {
    /// Default `member`.
    pub approver_kind: Option<String>,
    pub approver_id: String,
    pub role_label: Option<String>,
    /// 1-based, default 1. Same step = in parallel.
    pub step: Option<i64>,
    /// `{ code, params? }`.
    pub rule: Value,
    pub due_at: Option<i64>,
}

impl ApprovalRowInput {
    /// A member in step 1 with the rule `code` and no parameters.
    pub fn member(approver_id: impl Into<String>, code: &str) -> Self {
        Self {
            approver_kind: None,
            approver_id: approver_id.into(),
            role_label: None,
            step: None,
            rule: json!({ "code": code }),
            due_at: None,
        }
    }

    /// The rule with its parameters.
    #[must_use]
    pub fn with_rule(mut self, code: &str, params: &Value) -> Self {
        self.rule = json!({ "code": code, "params": params });
        self
    }

    #[must_use]
    pub fn with_step(mut self, step: i64) -> Self {
        self.step = Some(step);
        self
    }

    #[must_use]
    pub fn with_role_label(mut self, label: &str) -> Self {
        self.role_label = Some(label.to_owned());
        self
    }

    #[must_use]
    pub fn with_due_at(mut self, due_at: Option<i64>) -> Self {
        self.due_at = due_at;
        self
    }

    #[must_use]
    pub fn with_kind(mut self, kind: &str) -> Self {
        self.approver_kind = Some(kind.to_owned());
        self
    }

    fn kind(&self) -> &str {
        self.approver_kind.as_deref().unwrap_or("member")
    }
}

/// `approvalRequestError({ subjectType, rows })`.
pub fn approval_request_error(
    subject_type: &str,
    rows: &[ApprovalRowInput],
) -> Option<&'static str> {
    if !APPROVAL_SUBJECT_TYPES.contains(&subject_type) {
        return Some(messages::INVALID_SUBJECT);
    }
    if rows.is_empty() {
        return Some(messages::NO_APPROVERS);
    }
    for row in rows {
        if !APPROVER_KINDS.contains(&row.kind()) || row.approver_id.trim().is_empty() {
            return Some(messages::INVALID_APPROVER);
        }
        if row.step.unwrap_or(1) < 1 {
            return Some(messages::INVALID_STEP);
        }
        let code = row
            .rule
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if code.trim().is_empty() {
            return Some(messages::INVALID_RULE);
        }
    }
    None
}

/// An approver once the delegation is applied (`PlannedApprover`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedApprover {
    pub approver_kind: String,
    pub approver_id: String,
    pub delegated_from: Option<String>,
    pub role_label: Option<String>,
    pub step: i64,
    pub rule: Value,
    pub due_at: Option<i64>,
}

/// `planApprovers(rows, delegations, now)`: a member on delegation is replaced
/// by their delegate (`delegated_from` keeps the member), and a person asked
/// twice for one subject, directly or through delegation, is asked once, in the
/// lowest step. The order is by step, then as given.
pub fn plan_approvers(
    rows: &[ApprovalRowInput],
    delegations: &[DelegationRow],
    now_ms: i64,
) -> Vec<PlannedApprover> {
    let mut planned: Vec<PlannedApprover> = Vec::with_capacity(rows.len());
    for row in rows {
        let approver_kind = row.kind().to_owned();
        let mut approver_id = row.approver_id.trim().to_owned();
        let mut delegated_from = None;
        if approver_kind == "member"
            && let Some(delegation) = active_delegation(delegations, &approver_id, now_ms)
        {
            delegated_from = Some(approver_id.clone());
            approver_id.clone_from(&delegation.delegate_id);
        }
        planned.push(PlannedApprover {
            approver_kind,
            approver_id,
            delegated_from,
            role_label: row.role_label.clone(),
            step: row.step.unwrap_or(1),
            rule: row.rule.clone(),
            due_at: row.due_at,
        });
    }
    // A stable sort: the given order holds inside a step.
    planned.sort_by_key(|p| p.step);
    let mut seen = HashSet::new();
    planned.retain(|p| seen.insert(format!("{}:{}", p.approver_kind, p.approver_id)));
    planned
}

/// A boxed future, so a handler can be a trait object.
pub type ApprovalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a handler gets when its subject is settled (`ApprovalResolutionContext`).
#[derive(Debug, Clone)]
pub struct ApprovalResolutionContext {
    /// The subject's live rows, in step order.
    pub rows: Vec<ApprovalRow>,
    /// Who gave the answer that settled it (`None` when a sweep re-evaluates).
    pub actor: Option<ApprovalActor>,
    pub now_ms: i64,
}

/// How one subject type reacts to its approvals (`ApprovalSubjectHandler`).
/// The default resolution (every row approved, one rejection rejects) is the
/// approvals core's; a handler only says what to do once it settles.
pub trait ApprovalSubjectHandler: Send + Sync {
    /// Runs once the rows settle the subject. Runs after the answer is stored
    /// and may run again, so it has to be idempotent.
    fn on_resolved<'a>(
        &'a self,
        db: &'a PgPool,
        subject_id: &'a str,
        outcome: ResolvedApprovalOutcome,
        context: &'a ApprovalResolutionContext,
    ) -> ApprovalFuture<'a, Result<(), sqlx::Error>>;
}

type Registry = RwLock<HashMap<&'static str, Arc<dyn ApprovalSubjectHandler>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// `registerApprovalSubject(type, handler)`: a second call replaces the first
/// (the routers may be built more than once, in tests), which is an equal
/// handler.
pub fn register_approval_subject(
    subject_type: &'static str,
    handler: Arc<dyn ApprovalSubjectHandler>,
) {
    registry()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(subject_type, handler);
}

/// `getApprovalSubjectHandler(type)`.
pub fn approval_subject_handler(subject_type: &str) -> Option<Arc<dyn ApprovalSubjectHandler>> {
    registry()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(subject_type)
        .cloned()
}

fn approval_rows(values: Vec<Value>) -> Vec<ApprovalRow> {
    values
        .into_iter()
        .filter_map(|value| ApprovalRow::from_json(&js_row(value)))
        .collect()
}

fn iso(millis: i64) -> String {
    iso_from_millis(millis).unwrap_or_default()
}

/// `listSubjectApprovals(db, subjectType, subjectId)`: a subject's live rows,
/// in step order.
pub async fn list_subject_approvals(
    db: &PgPool,
    subject_type: &str,
    subject_id: &str,
) -> Result<Vec<ApprovalRow>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.subject_type = $1 and a.subject_id = $2 and a.deleted_at is null
         order by a.step asc, a.created_at asc, a.id asc",
    )
    .bind(subject_type)
    .bind(subject_id)
    .fetch_all(db)
    .await?;
    Ok(approval_rows(rows))
}

/// The delegations in force for any of `member_ids` at `now_ms`.
async fn delegations_in_force(
    db: &PgPool,
    member_ids: &[String],
    now_ms: i64,
) -> Result<Vec<DelegationRow>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from flow_approval_delegations d
         where d.member_id = any($1) and d.deleted_at is null
           and d.starts_at <= $2::timestamptz and d.ends_at > $2::timestamptz",
    )
    .bind(member_ids)
    .bind(iso(now_ms))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|value| DelegationRow::from_json(&js_row(value)))
        .collect())
}

/// `RequestApprovalsInput`.
#[derive(Debug, Clone)]
pub struct RequestApprovalsInput {
    /// `None` for a project request (it is not a project yet).
    pub project_id: Option<String>,
    pub subject_type: String,
    pub subject_id: String,
    /// Who asked: told when a review is overdue.
    pub requested_by: String,
    pub rows: Vec<ApprovalRowInput>,
    pub now_ms: i64,
}

/// Why a request was refused (`RequestApprovalsResult`'s `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestRefusal {
    Invalid,
    AlreadyRequested,
}

/// `RequestApprovalsResult`.
#[derive(Debug, Clone)]
pub enum RequestApprovalsResult {
    Requested(Vec<ApprovalRow>),
    Refused {
        code: RequestRefusal,
        message: &'static str,
    },
}

/// `requestApprovals(db, input)`: ask for approvals, one row per approver, in
/// one insert. A member on delegation is replaced by their delegate (the row
/// keeps `delegated_from`). Refuses a subject that still has live rows; clear
/// them first with [`cancel_pending_approvals`]. Entity events are the
/// caller's.
pub async fn request_approvals(
    db: &PgPool,
    input: &RequestApprovalsInput,
) -> Result<RequestApprovalsResult, sqlx::Error> {
    if let Some(message) = approval_request_error(&input.subject_type, &input.rows) {
        return Ok(RequestApprovalsResult::Refused {
            code: RequestRefusal::Invalid,
            message,
        });
    }
    let existing = list_subject_approvals(db, &input.subject_type, &input.subject_id).await?;
    if !existing.is_empty() {
        return Ok(RequestApprovalsResult::Refused {
            code: RequestRefusal::AlreadyRequested,
            message: messages::ALREADY_REQUESTED,
        });
    }

    let now = input.now_ms;
    let mut member_ids: Vec<String> = Vec::new();
    for row in input.rows.iter().filter(|row| row.kind() == "member") {
        let id = row.approver_id.trim().to_owned();
        if !member_ids.contains(&id) {
            member_ids.push(id);
        }
    }
    let delegations = if member_ids.is_empty() {
        Vec::new()
    } else {
        delegations_in_force(db, &member_ids, now).await?
    };

    let planned = plan_approvers(&input.rows, &delegations, now);
    let values: Vec<Value> = planned
        .iter()
        .enumerate()
        .map(|(index, p)| {
            // One millisecond apart, so a subject's rows list in the order they were planned.
            let created = i64::try_from(index).map_or(now, |i| now + i);
            let mut row = Map::new();
            row.insert("id".to_owned(), json!(generate_id("apr")));
            row.insert("project_id".to_owned(), json!(input.project_id));
            row.insert("subject_type".to_owned(), json!(input.subject_type));
            row.insert("subject_id".to_owned(), json!(input.subject_id));
            row.insert("approver_kind".to_owned(), json!(p.approver_kind));
            row.insert("approver_id".to_owned(), json!(p.approver_id));
            row.insert("role_label".to_owned(), json!(p.role_label));
            row.insert("step".to_owned(), json!(p.step));
            row.insert("rule".to_owned(), p.rule.clone());
            row.insert("decision".to_owned(), json!("pending"));
            row.insert("due_at".to_owned(), json!(p.due_at.map(iso)));
            row.insert("delegated_from".to_owned(), json!(p.delegated_from));
            row.insert("created_by".to_owned(), json!(input.requested_by));
            row.insert("created_at".to_owned(), json!(iso(created)));
            row.insert("updated_at".to_owned(), json!(iso(now)));
            Value::Object(row)
        })
        .collect();
    let inserted: Vec<Value> = sqlx::query_scalar(
        "insert into flow_approvals (id, project_id, subject_type, subject_id, approver_kind,
             approver_id, role_label, step, rule, decision, due_at, delegated_from, created_by,
             created_at, updated_at)
         select p.id, p.project_id, p.subject_type, p.subject_id, p.approver_kind, p.approver_id,
             p.role_label, p.step, p.rule, p.decision, p.due_at, p.delegated_from, p.created_by,
             p.created_at, p.updated_at
         from jsonb_populate_recordset(null::flow_approvals, $1) p
         returning to_jsonb(flow_approvals.*)",
    )
    .bind(Value::Array(values))
    .fetch_all(db)
    .await?;
    let mut rows = approval_rows(inserted);
    rows.sort_by_key(|row| row.step);
    Ok(RequestApprovalsResult::Requested(rows))
}

/// `cancelPendingApprovals(db, { subjectType, subjectId, includeDecided, now })`:
/// clear a subject's open rows (soft delete). Answered rows stay unless
/// `include_decided` is set. Returns the rows it cleared.
pub async fn cancel_pending_approvals(
    db: &PgPool,
    subject_type: &str,
    subject_id: &str,
    include_decided: bool,
    now_ms: i64,
) -> Result<Vec<ApprovalRow>, sqlx::Error> {
    let cleared: Vec<Value> = sqlx::query_scalar(
        "update flow_approvals set deleted_at = $3::timestamptz, updated_at = $3::timestamptz
         where subject_type = $1 and subject_id = $2 and deleted_at is null
           and ($4::bool or decision = any($5))
         returning to_jsonb(flow_approvals.*)",
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(iso(now_ms))
    .bind(include_decided)
    .bind(OPEN_DECISIONS.as_slice())
    .fetch_all(db)
    .await?;
    Ok(approval_rows(cleared))
}

// ── Slice B's own ───────────────────────────────────────────────────────────

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
pub struct DecisionHandler;

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
pub struct DeliverableHandler;

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
pub fn approval_event_data(row: &ApprovalRow) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn delegation(id: &str, member: &str, delegate: &str, from: i64, to: i64) -> DelegationRow {
        DelegationRow {
            id: id.into(),
            member_id: member.into(),
            delegate_id: delegate.into(),
            starts_at: from,
            ends_at: to,
            deleted_at: None,
        }
    }

    #[test]
    fn the_sponsor_is_the_setting_else_the_manager() {
        assert_eq!(
            sponsor_of(Some(&json!({ "sponsorId": "u1" })), Some("m")).as_deref(),
            Some("u1")
        );
        assert_eq!(
            sponsor_of(Some(&json!({ "sponsorId": "" })), Some("m")).as_deref(),
            Some("m")
        );
        assert_eq!(sponsor_of(None, Some("m")).as_deref(), Some("m"));
        assert_eq!(sponsor_of(None, None), None);
    }

    #[test]
    fn a_delegate_answers_for_the_member_and_a_person_is_asked_once() {
        let delegations = [delegation("d1", "u1", "u2", 0, 100)];
        let rows = [
            ApprovalRowInput::member("u1", "decision"),
            ApprovalRowInput::member("u2", "deliverable_sponsor").with_step(2),
        ];
        let planned = plan_approvers(&rows, &delegations, 50);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].approver_id, "u2");
        assert_eq!(planned[0].delegated_from.as_deref(), Some("u1"));
        assert_eq!(planned[0].step, 1);
        // Outside the delegation nothing changes.
        let planned = plan_approvers(&rows, &delegations, 150);
        assert_eq!(
            planned
                .iter()
                .map(|p| p.approver_id.as_str())
                .collect::<Vec<_>>(),
            ["u1", "u2"]
        );
    }

    #[test]
    fn refuses_what_the_approvals_core_refuses() {
        let row = ApprovalRowInput::member("u1", "decision");
        assert_eq!(
            approval_request_error("decision", std::slice::from_ref(&row)),
            None
        );
        assert_eq!(
            approval_request_error("nope", std::slice::from_ref(&row)),
            Some(messages::INVALID_SUBJECT)
        );
        assert_eq!(
            approval_request_error("decision", &[]),
            Some(messages::NO_APPROVERS)
        );
        assert_eq!(
            approval_request_error("decision", &[row.clone().with_kind("robot")]),
            Some(messages::INVALID_APPROVER)
        );
        assert_eq!(
            approval_request_error("decision", &[row.with_step(0)]),
            Some(messages::INVALID_STEP)
        );
    }
}
