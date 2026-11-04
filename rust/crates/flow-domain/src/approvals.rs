//! The approvals core (`@weldsuite/flow-domain/approvals`): the one table
//! behind "My reviews" (design: weldflow-delivery-and-portfolio.md; ADR
//! FLOW-016).
//!
//! Everything that waits for someone's yes (change requests, stage gates,
//! deliverable sign-off, proposed decisions, accepting a risk, closing a
//! project, new project requests) inserts `flow_approvals` rows through
//! [`request_approvals`]. Each row is one approver's answer. The table stores
//! the answers and does not decide anything: each subject type registers a
//! handler ([`register_approval_subject`]) that says whether its rows add up
//! to approved, rejected or still waiting, and what to do once they do.
//!
//! Two layers, as in TypeScript:
//!
//! 1. Pure functions and constants (no database, no clock): validation, step
//!    order, the default resolution, delegation choice, the review buckets.
//!    Every message returned here is sent to the client as it is, so both
//!    backends answer alike.
//! 2. Database functions, which take `now` (epoch milliseconds). Rows are read
//!    as `weldsuite_db::js_row` gives them and parsed into [`ApprovalRow`];
//!    times are epoch milliseconds (`Date#getTime()`).
//!
//! # Plugging in a subject type (for the slices that own one)
//!
//! Implement [`ApprovalSubjectHandler`] and call [`register_approval_subject`]
//! from the router constructor of the module that owns the subject (the
//! router is built once at start-up, and building it again, as tests do,
//! replaces the handler with an equal one):
//!
//! ```ignore
//! struct DecisionHandler;
//! impl ApprovalSubjectHandler for DecisionHandler {
//!     fn on_resolved<'a>(
//!         &'a self,
//!         db: &'a PgPool,
//!         subject_id: &'a str,
//!         outcome: ResolvedApprovalOutcome,
//!         context: &'a ApprovalResolutionContext,
//!     ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
//!         Box::pin(async move { /* apply the outcome, idempotently */ Ok(()) })
//!     }
//! }
//! register_approval_subject("decision", Arc::new(DecisionHandler));
//! ```
//!
//! `resolve` is optional (default [`resolve_unanimous`]); `on_resolved` runs
//! after the answer is stored and may run again ([`resolve_approval_subject`]),
//! so it has to be idempotent. Ask for approvals with [`request_approvals`],
//! answer through [`decide_approval`] (the routes in
//! `rust/modules/flow/src/approvals.rs` do), clear with
//! [`cancel_pending_approvals`].
//!
//! Answering is a right of the row, never of a workspace permission: the named
//! approver, or a member who is their active delegate. Callers check project
//! access and permissions for the routes around it.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::js_row;
use weldsuite_kit::generate_id;

use crate::js::{civil_from_days, days_from_civil, iso_from_millis, millis_of};

// ── Vocabulary ──────────────────────────────────────────────────────────────

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

/// `APPROVER_KINDS`: a workspace member, or a CRM contact on the client portal.
pub const APPROVER_KINDS: [&str; 2] = ["member", "contact"];

/// `APPROVAL_DECISIONS`.
pub const APPROVAL_DECISIONS: [&str; 5] = [
    "pending",
    "approved",
    "approved_with_conditions",
    "rejected",
    "info_requested",
];

/// `FINAL_DECISIONS`: the answers that settle a row for good.
pub const FINAL_DECISIONS: [&str; 3] = ["approved", "approved_with_conditions", "rejected"];

/// `OPEN_DECISIONS`: not answered yet, or the approver asked for more information.
pub const OPEN_DECISIONS: [&str; 2] = ["pending", "info_requested"];

/// `APPROVING_DECISIONS`: the answers that count as a yes.
pub const APPROVING_DECISIONS: [&str; 2] = ["approved", "approved_with_conditions"];

/// `NOTE_REQUIRED_DECISIONS`: a decline says why, conditions say which.
pub const NOTE_REQUIRED_DECISIONS: [&str; 2] = ["rejected", "approved_with_conditions"];

/// `APPROVAL_RULE_CODES`: the rule codes My reviews knows how to explain.
pub const APPROVAL_RULE_CODES: [&str; 9] = [
    "change_manager",
    "change_board_over_limit",
    "gate",
    "deliverable_sponsor",
    "deliverable_client",
    "decision",
    "risk_acceptance",
    "project_request",
    "close",
];

/// `APPROVAL_MESSAGES`: the messages of every refusal, sent as they are.
pub mod messages {
    pub const NOT_FOUND: &str = "Approval not found";
    pub const NOT_APPROVER: &str = "You are not an approver of this review";
    pub const ALREADY_DECIDED: &str = "This review has already been answered";
    pub const STEP_NOT_ACTIVE: &str = "This review is waiting for an earlier step to be answered";
    pub const INVALID_DECISION: &str =
        "Choose approve, approve with conditions, decline or ask for more information";
    pub const NOTE_REQUIRED: &str = "A note is required to decline or to set conditions";
    pub const NO_APPROVERS: &str = "At least one approver is required";
    pub const INVALID_SUBJECT: &str = "Unknown approval subject type";
    pub const INVALID_APPROVER: &str = "Every approver needs a kind and an id";
    pub const INVALID_STEP: &str = "A step is a whole number of 1 or more";
    pub const INVALID_RULE: &str = "Every approval needs the rule that selected the approver";
    pub const ALREADY_REQUESTED: &str = "Approvals have already been requested for this subject";
}

/// What a subject's rows add up to (`ApprovalOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Rejected,
    Pending,
}

impl ApprovalOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Pending => "pending",
        }
    }
}

/// An outcome that settled the subject (`ResolvedApprovalOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedApprovalOutcome {
    Approved,
    Rejected,
}

impl ResolvedApprovalOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }
}

/// Who answers: a member (user id) or a CRM contact on the client portal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalActor {
    pub kind: String,
    pub id: String,
}

impl ApprovalActor {
    /// A workspace member answering.
    pub fn member(id: impl Into<String>) -> Self {
        Self {
            kind: "member".to_owned(),
            id: id.into(),
        }
    }
}

/// My reviews groups a list as overdue, this week and later (`ReviewBucket`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewBucket {
    Overdue,
    ThisWeek,
    Later,
}

impl ReviewBucket {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Overdue => "overdue",
            Self::ThisWeek => "this_week",
            Self::Later => "later",
        }
    }
}

// ── Rows ────────────────────────────────────────────────────────────────────

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
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
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
            created_by: text_of(row, "createdBy")?,
            created_at: millis_field(row, "createdAt")?,
            updated_at: millis_field(row, "updatedAt")?,
            deleted_at: millis_field(row, "deletedAt"),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "memberId": self.member_id,
            "delegateId": self.delegate_id,
            "startsAt": iso_field(Some(self.starts_at)),
            "endsAt": iso_field(Some(self.ends_at)),
            "createdBy": self.created_by,
            "createdAt": iso_field(Some(self.created_at)),
            "updatedAt": iso_field(Some(self.updated_at)),
            "deletedAt": iso_field(self.deleted_at),
        })
    }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

/// `isFinalDecision(decision)`.
pub fn is_final_decision(decision: &str) -> bool {
    FINAL_DECISIONS.contains(&decision)
}

/// `isOpenDecision(decision)`.
pub fn is_open_decision(decision: &str) -> bool {
    OPEN_DECISIONS.contains(&decision)
}

fn is_approving(decision: &str) -> bool {
    APPROVING_DECISIONS.contains(&decision)
}

/// `decisionInputError({ decision, note })`: the refusal for the answer
/// itself, or `None`: it has to be one of the four answers (not `pending`),
/// and declining or setting conditions needs a note.
pub fn decision_input_error(decision: &str, note: Option<&str>) -> Option<&'static str> {
    if !FINAL_DECISIONS.contains(&decision) && decision != "info_requested" {
        return Some(messages::INVALID_DECISION);
    }
    if NOTE_REQUIRED_DECISIONS.contains(&decision) && note.unwrap_or_default().trim().is_empty() {
        return Some(messages::NOTE_REQUIRED);
    }
    None
}

/// `resolveUnanimous(rows)`: one rejection rejects the subject, every row
/// approved (with or without conditions) approves it, anything else is still
/// waiting. Deleted rows are ignored; no rows is waiting.
pub fn resolve_unanimous(rows: &[ApprovalRow]) -> ApprovalOutcome {
    let live: Vec<&ApprovalRow> = rows.iter().filter(|row| row.deleted_at.is_none()).collect();
    if live.is_empty() {
        return ApprovalOutcome::Pending;
    }
    if live.iter().any(|row| row.decision == "rejected") {
        return ApprovalOutcome::Rejected;
    }
    if live.iter().all(|row| is_approving(&row.decision)) {
        return ApprovalOutcome::Approved;
    }
    ApprovalOutcome::Pending
}

/// `isStepActive(row, siblings)`: a later step waits for the earlier one. It
/// can be answered only when every row of a lower step has been approved. Rows
/// of the same step run in parallel.
pub fn is_step_active(row: &ApprovalRow, siblings: &[ApprovalRow]) -> bool {
    siblings.iter().all(|other| {
        other.deleted_at.is_some() || other.step >= row.step || is_approving(&other.decision)
    })
}

/// `activeDelegation(delegations, memberId, now)`: the delegation in force for
/// a member at `now_ms`, or `None`: it starts at `starts_at` (inclusive) and
/// ends at `ends_at` (exclusive). When several overlap, the one that started
/// last wins, then the lowest id, so every backend picks the same.
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

const DAY_MS: i64 = 86_400_000;

/// `endOfIsoWeek(now)`: the last instant (UTC) of the ISO week (Monday to
/// Sunday) that holds `now_ms`.
pub fn end_of_iso_week_ms(now_ms: i64) -> i64 {
    let days = now_ms.div_euclid(DAY_MS);
    // 1970-01-01 was a Thursday; `getUTCDay()` counts Sunday as 0.
    let weekday = (days + 4).rem_euclid(7);
    let days_to_sunday = (7 - weekday) % 7;
    let (year, month, day) = civil_from_days(days + days_to_sunday);
    days_from_civil(year, month, day) * DAY_MS + (DAY_MS - 1)
}

/// `reviewBucket(dueAt, now)`: past due is overdue, due by Sunday is this
/// week, the rest (and no due date) is later.
pub fn review_bucket(due_at: Option<i64>, now_ms: i64) -> ReviewBucket {
    let Some(due) = due_at else {
        return ReviewBucket::Later;
    };
    if due < now_ms {
        return ReviewBucket::Overdue;
    }
    if due <= end_of_iso_week_ms(now_ms) {
        ReviewBucket::ThisWeek
    } else {
        ReviewBucket::Later
    }
}

/// `compareReviews(a, b)`: earliest due date first (no date last), then
/// oldest request, then id.
pub fn compare_reviews(a: &ApprovalRow, b: &ApprovalRow) -> Ordering {
    let due = |row: &ApprovalRow| row.due_at.unwrap_or(i64::MAX);
    due(a)
        .cmp(&due(b))
        .then_with(|| a.created_at.cmp(&b.created_at))
        .then_with(|| a.id.cmp(&b.id))
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

/// One approver of a request (`ApprovalRowInput`): who, in which step, and
/// the rule that selected them.
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

/// An approver once the delegation is applied (`PlannedApprover`): who is
/// asked now, and for whom.
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

/// `planApprovers(rows, delegations, now)`: a member on delegation is
/// replaced by their delegate (`delegated_from` keeps the member), and a
/// person asked twice for one subject, directly or through delegation, is
/// asked once, in the lowest step. The order is by step, then as given.
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

// ── Subject handlers ────────────────────────────────────────────────────────

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
pub trait ApprovalSubjectHandler: Send + Sync {
    /// Whether the rows add up to approved, rejected or still waiting. Default
    /// [`resolve_unanimous`]. Must be pure.
    fn resolve(&self, rows: &[ApprovalRow]) -> ApprovalOutcome {
        resolve_unanimous(rows)
    }

    /// Runs once the rows settle the subject: apply the change, pass the gate,
    /// mark the deliverable accepted. Runs after the answer is stored and may
    /// run again ([`resolve_approval_subject`]), so it has to be idempotent.
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

/// `registerApprovalSubject(type, handler)`: plug in a subject type. A type has
/// one handler. TypeScript throws when it is registered twice; here the router
/// that registers it may be built more than once (tests), so a second call
/// replaces the first, which is an equal handler.
pub fn register_approval_subject(
    subject_type: &'static str,
    handler: Arc<dyn ApprovalSubjectHandler>,
) {
    registry()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(subject_type, handler);
}

/// `unregisterApprovalSubject(type)` (tests).
pub fn unregister_approval_subject(subject_type: &str) {
    registry()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(subject_type);
}

/// `getApprovalSubjectHandler(type)`.
pub fn approval_subject_handler(subject_type: &str) -> Option<Arc<dyn ApprovalSubjectHandler>> {
    registry()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(subject_type)
        .cloned()
}

/// `resolveSubjectRows(type, rows)`: the outcome of a subject's rows under its
/// handler (default: unanimous).
pub fn resolve_subject_rows(subject_type: &str, rows: &[ApprovalRow]) -> ApprovalOutcome {
    match approval_subject_handler(subject_type) {
        Some(handler) => handler.resolve(rows),
        None => resolve_unanimous(rows),
    }
}

// ── Database ────────────────────────────────────────────────────────────────

fn approval_rows(values: Vec<Value>) -> Vec<ApprovalRow> {
    values
        .into_iter()
        .filter_map(|value| ApprovalRow::from_json(&js_row(value)))
        .collect()
}

fn delegation_rows(values: Vec<Value>) -> Vec<DelegationRow> {
    values
        .into_iter()
        .filter_map(|value| DelegationRow::from_json(&js_row(value)))
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
    Ok(delegation_rows(rows))
}

/// `findActiveDelegation(db, memberId, now)`: the delegation in force for a
/// member right now, or `None`.
pub async fn find_active_delegation(
    db: &PgPool,
    member_id: &str,
    now_ms: i64,
) -> Result<Option<DelegationRow>, sqlx::Error> {
    let rows = delegations_in_force(db, &[member_id.to_owned()], now_ms).await?;
    Ok(active_delegation(&rows, member_id, now_ms).cloned())
}

/// `listActiveDelegators(db, delegateId, now)`: the members who have delegated
/// their reviews to this person right now, sorted.
pub async fn list_active_delegators(
    db: &PgPool,
    delegate_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, sqlx::Error> {
    let mut members: Vec<String> = sqlx::query_scalar(
        "select distinct d.member_id from flow_approval_delegations d
         where d.delegate_id = $1 and d.deleted_at is null
           and d.starts_at <= $2::timestamptz and d.ends_at > $2::timestamptz",
    )
    .bind(delegate_id)
    .bind(iso(now_ms))
    .fetch_all(db)
    .await?;
    members.sort();
    Ok(members)
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

/// `DecideApprovalInput`.
#[derive(Debug, Clone)]
pub struct DecideApprovalInput {
    pub approval_id: String,
    /// A member's user id, or a portal contact (`kind: "contact"`).
    pub actor: ApprovalActor,
    pub decision: String,
    pub note: Option<String>,
    pub now_ms: i64,
}

/// `DecideApprovalError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecideRefusal {
    NotFound,
    NotApprover,
    AlreadyDecided,
    StepNotActive,
    InvalidDecision,
    NoteRequired,
}

/// An answer that was stored (`DecideApprovalResult`'s `ok` branch).
#[derive(Debug, Clone)]
pub struct DecidedApproval {
    /// The row as answered.
    pub approval: ApprovalRow,
    /// What the subject's rows add up to now.
    pub outcome: ApprovalOutcome,
    /// True when this answer settled the subject (its handler ran).
    pub resolved: bool,
    /// The subject's live rows after the answer.
    pub rows: Vec<ApprovalRow>,
    /// True when a delegate answered for the approver.
    pub via_delegation: bool,
}

/// `DecideApprovalResult`.
#[derive(Debug, Clone)]
pub enum DecideApprovalResult {
    Decided(Box<DecidedApproval>),
    Refused {
        code: DecideRefusal,
        message: &'static str,
    },
}

/// `decideApproval(db, input)`: answer a review. The checks run in a fixed
/// order, so every backend answers alike: the row exists, the actor is its
/// approver or their active delegate, it is still open, it is its step's turn,
/// then the answer itself (one of the four, a note for a decline or conditions).
///
/// The answer is stored with a guarded update (only an open row changes), so
/// two answers at once cannot both win. Then the subject's handler decides
/// whether the rows settle it; if they do, a rejection clears the other open
/// rows and `on_resolved` runs. If `on_resolved` fails, the answer stays stored
/// and the error propagates: [`resolve_approval_subject`] runs it again.
pub async fn decide_approval(
    db: &PgPool,
    input: &DecideApprovalInput,
) -> Result<DecideApprovalResult, sqlx::Error> {
    let now = input.now_ms;
    let actor = &input.actor;
    let refused = |code: DecideRefusal, message: &'static str| {
        Ok(DecideApprovalResult::Refused { code, message })
    };

    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a where a.id = $1 and a.deleted_at is null limit 1",
    )
    .bind(&input.approval_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = found.and_then(|value| ApprovalRow::from_json(&js_row(value))) else {
        return refused(DecideRefusal::NotFound, messages::NOT_FOUND);
    };

    let mut via_delegation = false;
    // A member row stored for a delegate (`delegated_from` = the member) stays the
    // member's to answer too, so it does not strand when the delegation ends.
    let is_approver = row.approver_kind == actor.kind
        && (row.approver_id == actor.id
            || (actor.kind == "member"
                && row.delegated_from.as_deref() == Some(actor.id.as_str())));
    if !is_approver {
        let delegation = if actor.kind == "member" && row.approver_kind == "member" {
            find_active_delegation(db, &row.approver_id, now).await?
        } else {
            None
        };
        match delegation {
            Some(delegation) if delegation.delegate_id == actor.id => via_delegation = true,
            _ => return refused(DecideRefusal::NotApprover, messages::NOT_APPROVER),
        }
    }

    if !is_open_decision(&row.decision) {
        return refused(DecideRefusal::AlreadyDecided, messages::ALREADY_DECIDED);
    }

    let siblings = list_subject_approvals(db, &row.subject_type, &row.subject_id).await?;
    if !is_step_active(&row, &siblings) {
        return refused(DecideRefusal::StepNotActive, messages::STEP_NOT_ACTIVE);
    }

    if let Some(message) = decision_input_error(&input.decision, input.note.as_deref()) {
        let code = if NOTE_REQUIRED_DECISIONS.contains(&input.decision.as_str()) {
            DecideRefusal::NoteRequired
        } else {
            DecideRefusal::InvalidDecision
        };
        return refused(code, message);
    }

    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty());
    let updated: Option<Value> = sqlx::query_scalar(
        "update flow_approvals set decision = $2, note = $3, decided_at = $4::timestamptz,
             decided_by = $5, updated_at = $4::timestamptz
         where id = $1 and deleted_at is null and decision = any($6)
         returning to_jsonb(flow_approvals.*)",
    )
    .bind(&row.id)
    .bind(&input.decision)
    .bind(note)
    .bind(iso(now))
    .bind(&actor.id)
    .bind(OPEN_DECISIONS.as_slice())
    .fetch_optional(db)
    .await?;
    // Someone answered between the read and the update.
    let Some(updated) = updated.and_then(|value| ApprovalRow::from_json(&js_row(value))) else {
        return refused(DecideRefusal::AlreadyDecided, messages::ALREADY_DECIDED);
    };

    let resolution = resolve_approval_subject(
        db,
        &row.subject_type,
        &row.subject_id,
        Some(actor.clone()),
        now,
    )
    .await?;
    let approval = resolution
        .rows
        .iter()
        .find(|r| r.id == updated.id)
        .cloned()
        .unwrap_or(updated);
    Ok(DecideApprovalResult::Decided(Box::new(DecidedApproval {
        approval,
        outcome: resolution.outcome,
        resolved: resolution.resolved,
        rows: resolution.rows,
        via_delegation,
    })))
}

/// What [`resolve_approval_subject`] found.
#[derive(Debug, Clone)]
pub struct SubjectResolution {
    pub outcome: ApprovalOutcome,
    pub resolved: bool,
    pub rows: Vec<ApprovalRow>,
}

/// `resolveApprovalSubject(db, type, id, { actor, now })`: evaluate a subject's
/// rows under its handler and, when they settle it, clear the other open rows
/// of a rejected subject and run `on_resolved`. Used after every answer, and to
/// run the resolution again when it failed halfway (`on_resolved` is
/// idempotent).
pub async fn resolve_approval_subject(
    db: &PgPool,
    subject_type: &str,
    subject_id: &str,
    actor: Option<ApprovalActor>,
    now_ms: i64,
) -> Result<SubjectResolution, sqlx::Error> {
    let mut rows = list_subject_approvals(db, subject_type, subject_id).await?;
    let outcome = resolve_subject_rows(subject_type, &rows);
    let resolved = match outcome {
        ApprovalOutcome::Pending => {
            return Ok(SubjectResolution {
                outcome,
                resolved: false,
                rows,
            });
        }
        ApprovalOutcome::Approved => ResolvedApprovalOutcome::Approved,
        ApprovalOutcome::Rejected => ResolvedApprovalOutcome::Rejected,
    };

    if resolved == ResolvedApprovalOutcome::Rejected
        && rows.iter().any(|row| is_open_decision(&row.decision))
    {
        cancel_pending_approvals(db, subject_type, subject_id, false, now_ms).await?;
        rows = list_subject_approvals(db, subject_type, subject_id).await?;
    }
    if let Some(handler) = approval_subject_handler(subject_type) {
        let context = ApprovalResolutionContext {
            rows: rows.clone(),
            actor,
            now_ms,
        };
        handler
            .on_resolved(db, subject_id, resolved, &context)
            .await?;
    }
    Ok(SubjectResolution {
        outcome,
        resolved: true,
        rows,
    })
}

/// `cancelPendingApprovals(db, { subjectType, subjectId, includeDecided, now })`:
/// clear a subject's open rows (soft delete): a withdrawn request, a rejected
/// subject's other approvers, a change sent back to assessing. Answered rows
/// stay unless `include_decided` is set, which a re-routed change uses to
/// start its approvals over. Returns the rows it cleared.
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

/// `PendingReviewFilters`.
#[derive(Debug, Clone, Default)]
pub struct PendingReviewFilters {
    pub subject_types: Vec<String>,
    pub project_id: Option<String>,
    /// `member` (default), or `contact` for the client portal.
    pub approver_kind: Option<String>,
    /// Which answers to list. Default: `pending` only.
    pub decisions: Option<Vec<String>>,
    /// Also list the reviews of members who delegated to this person. Default true.
    pub include_delegated: Option<bool>,
    /// Also list rows whose earlier steps are not answered yet. Default false.
    pub include_waiting: bool,
    /// The projects the caller may see (`accessibleProjectIds`): rows of other
    /// projects are left out, rows without a project stay. `None`: no limit.
    pub accessible_project_ids: Option<Vec<String>>,
    /// Default 200, at most 500.
    pub limit: Option<i64>,
}

/// `PendingReview`.
#[derive(Debug, Clone)]
pub struct PendingReview {
    pub approval: ApprovalRow,
    /// The row is a delegator's, shown because this person is their active delegate.
    pub via_delegation: bool,
    /// Its earlier steps are answered, so it can be answered now.
    pub actionable: bool,
    pub bucket: ReviewBucket,
}

/// `listPendingForApprover(db, userId, filters)`: the inbox. This person's
/// open reviews across every subject type (and, for a member, those of members
/// who delegated to them), earliest due date first. Reads the (`approver_id`,
/// `decision`, `due_at`) index. Rows that wait for an earlier step are left
/// out unless asked for.
pub async fn list_pending_for_approver(
    db: &PgPool,
    user_id: &str,
    filters: &PendingReviewFilters,
    now_ms: i64,
) -> Result<Vec<PendingReview>, sqlx::Error> {
    let kind = filters.approver_kind.as_deref().unwrap_or("member");
    let delegators = if kind == "member" && filters.include_delegated != Some(false) {
        list_active_delegators(db, user_id, now_ms).await?
    } else {
        Vec::new()
    };
    let mut approver_ids = vec![user_id.to_owned()];
    approver_ids.extend(delegators.into_iter().filter(|id| id != user_id));
    let decisions: Vec<String> = filters
        .decisions
        .clone()
        .unwrap_or_else(|| vec!["pending".to_owned()]);
    let limit = filters.limit.unwrap_or(200).clamp(1, 500);

    let values: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.approver_kind = $1
           and (a.approver_id = any($2) or ($1 = 'member' and a.delegated_from = $7))
           and a.decision = any($3)
           and a.deleted_at is null
           and (cardinality($4::text[]) = 0 or a.subject_type = any($4))
           and ($5::text is null or a.project_id = $5)
           and ($8::text[] is null or a.project_id is null or a.project_id = any($8))
         order by a.due_at asc nulls last, a.created_at asc, a.id asc
         limit $6",
    )
    .bind(kind)
    .bind(&approver_ids)
    .bind(&decisions)
    .bind(&filters.subject_types)
    .bind(filters.project_id.as_deref())
    .bind(limit)
    .bind(user_id)
    .bind(filters.accessible_project_ids.as_deref())
    .fetch_all(db)
    .await?;
    let rows = approval_rows(values);
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // A later step waits for the earlier one: read the siblings of these subjects.
    let mut subject_ids: Vec<String> = Vec::new();
    for row in &rows {
        if !subject_ids.contains(&row.subject_id) {
            subject_ids.push(row.subject_id.clone());
        }
    }
    let sibling_values: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.subject_id = any($1) and a.deleted_at is null",
    )
    .bind(&subject_ids)
    .fetch_all(db)
    .await?;
    let mut siblings: HashMap<String, Vec<ApprovalRow>> = HashMap::new();
    for sibling in approval_rows(sibling_values) {
        siblings
            .entry(format!("{}:{}", sibling.subject_type, sibling.subject_id))
            .or_default()
            .push(sibling);
    }

    let mut reviews: Vec<PendingReview> = rows
        .into_iter()
        .map(|approval| {
            let key = format!("{}:{}", approval.subject_type, approval.subject_id);
            let actionable = match siblings.get(&key) {
                Some(list) => is_step_active(&approval, list),
                None => is_step_active(&approval, std::slice::from_ref(&approval)),
            };
            PendingReview {
                via_delegation: approval.approver_id != user_id
                    && approval.delegated_from.as_deref() != Some(user_id),
                actionable,
                bucket: review_bucket(approval.due_at, now_ms),
                approval,
            }
        })
        .filter(|review| filters.include_waiting || review.actionable)
        .collect();
    reviews.sort_by(|a, b| compare_reviews(&a.approval, &b.approval));
    Ok(reviews)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        millis_of(iso).expect("a timestamp")
    }

    fn now() -> i64 {
        at("2026-11-04T10:00:00Z")
    }

    fn row(decision: &str, step: i64, deleted: bool) -> ApprovalRow {
        ApprovalRow {
            decision: decision.to_owned(),
            step,
            deleted_at: deleted.then_some(at("2026-11-01T00:00:00Z")),
            ..ApprovalRow::default()
        }
    }

    fn dated(id: &str, due: Option<&str>, created: &str) -> ApprovalRow {
        ApprovalRow {
            id: id.to_owned(),
            due_at: due.map(at),
            created_at: at(created),
            ..ApprovalRow::default()
        }
    }

    #[test]
    fn vocabulary_splits_the_answers_with_nothing_left_over() {
        let mut all: Vec<&str> = FINAL_DECISIONS.into_iter().chain(OPEN_DECISIONS).collect();
        all.sort_unstable();
        let mut expected = APPROVAL_DECISIONS.to_vec();
        expected.sort_unstable();
        assert_eq!(all, expected);
        assert!(is_final_decision("approved"));
        assert!(is_final_decision("approved_with_conditions"));
        assert!(is_final_decision("rejected"));
        assert!(!is_final_decision("pending"));
        assert!(!is_final_decision("info_requested"));
        assert!(is_open_decision("pending"));
        assert!(is_open_decision("info_requested"));
        assert!(!is_open_decision("approved"));
        let mut notes = NOTE_REQUIRED_DECISIONS.to_vec();
        notes.sort_unstable();
        assert_eq!(notes, ["approved_with_conditions", "rejected"]);
        assert!(APPROVAL_RULE_CODES.contains(&"change_board_over_limit"));
        let unique: HashSet<&str> = APPROVAL_RULE_CODES.into_iter().collect();
        assert_eq!(unique.len(), APPROVAL_RULE_CODES.len());
    }

    #[test]
    fn decision_input_accepts_the_four_answers() {
        assert_eq!(decision_input_error("approved", None), None);
        assert_eq!(decision_input_error("info_requested", None), None);
        assert_eq!(
            decision_input_error("rejected", Some("Too expensive")),
            None
        );
        assert_eq!(
            decision_input_error("approved_with_conditions", Some("After the audit")),
            None
        );
    }

    #[test]
    fn decision_input_refuses_pending_unknown_and_missing_notes() {
        assert_eq!(
            decision_input_error("pending", None),
            Some(messages::INVALID_DECISION)
        );
        assert_eq!(
            decision_input_error("maybe", None),
            Some(messages::INVALID_DECISION)
        );
        assert_eq!(
            decision_input_error("rejected", None),
            Some(messages::NOTE_REQUIRED)
        );
        assert_eq!(
            decision_input_error("rejected", Some("   ")),
            Some(messages::NOTE_REQUIRED)
        );
        assert_eq!(
            decision_input_error("approved_with_conditions", None),
            Some(messages::NOTE_REQUIRED)
        );
    }

    #[test]
    fn unanimous_waits_while_an_answer_is_missing() {
        assert_eq!(resolve_unanimous(&[]), ApprovalOutcome::Pending);
        assert_eq!(
            resolve_unanimous(&[row("pending", 1, false)]),
            ApprovalOutcome::Pending
        );
        assert_eq!(
            resolve_unanimous(&[row("approved", 1, false), row("pending", 1, false)]),
            ApprovalOutcome::Pending
        );
        assert_eq!(
            resolve_unanimous(&[row("approved", 1, false), row("info_requested", 1, false)]),
            ApprovalOutcome::Pending
        );
    }

    #[test]
    fn unanimous_approves_when_every_row_approved() {
        assert_eq!(
            resolve_unanimous(&[row("approved", 1, false)]),
            ApprovalOutcome::Approved
        );
        assert_eq!(
            resolve_unanimous(&[
                row("approved", 1, false),
                row("approved_with_conditions", 1, false)
            ]),
            ApprovalOutcome::Approved
        );
    }

    #[test]
    fn unanimous_rejects_on_one_rejection_even_while_others_are_open() {
        assert_eq!(
            resolve_unanimous(&[row("approved", 1, false), row("rejected", 1, false)]),
            ApprovalOutcome::Rejected
        );
        assert_eq!(
            resolve_unanimous(&[
                row("pending", 1, false),
                row("rejected", 1, false),
                row("pending", 1, false)
            ]),
            ApprovalOutcome::Rejected
        );
    }

    #[test]
    fn unanimous_ignores_deleted_rows() {
        assert_eq!(
            resolve_unanimous(&[row("approved", 1, false), row("rejected", 1, true)]),
            ApprovalOutcome::Approved
        );
        assert_eq!(
            resolve_unanimous(&[row("pending", 1, true)]),
            ApprovalOutcome::Pending
        );
    }

    #[test]
    fn steps_run_in_parallel_inside_a_step() {
        let rows = [
            row("pending", 1, false),
            row("pending", 1, false),
            row("pending", 2, false),
        ];
        assert!(is_step_active(&rows[0], &rows));
        assert!(is_step_active(&rows[1], &rows));
    }

    #[test]
    fn a_later_step_waits_for_every_earlier_row_to_be_approved() {
        let waiting = [
            row("approved", 1, false),
            row("pending", 1, false),
            row("pending", 2, false),
        ];
        assert!(!is_step_active(&waiting[2], &waiting));
        let open = [
            row("approved", 1, false),
            row("approved_with_conditions", 1, false),
            row("pending", 2, false),
        ];
        assert!(is_step_active(&open[2], &open));
    }

    #[test]
    fn a_later_step_stays_closed_behind_a_rejection_or_a_request_for_information() {
        let later = row("pending", 2, false);
        assert!(!is_step_active(
            &later,
            &[row("rejected", 1, false), later.clone()]
        ));
        assert!(!is_step_active(
            &later,
            &[row("info_requested", 1, false), later.clone()]
        ));
    }

    #[test]
    fn a_later_step_does_not_wait_for_a_deleted_row() {
        let later = row("pending", 2, false);
        assert!(is_step_active(
            &later,
            &[row("pending", 1, true), later.clone()]
        ));
    }

    fn delegation(id: &str, member: &str, from: &str, to: &str, deleted: bool) -> DelegationRow {
        DelegationRow {
            id: id.to_owned(),
            member_id: member.to_owned(),
            delegate_id: format!("{id}-delegate"),
            starts_at: at(from),
            ends_at: at(to),
            deleted_at: deleted.then_some(at("2026-11-03T00:00:00Z")),
            ..DelegationRow::default()
        }
    }

    #[test]
    fn a_delegation_runs_from_its_start_until_its_end() {
        let list = [delegation(
            "a",
            "u1",
            "2026-11-02T00:00:00Z",
            "2026-11-09T00:00:00Z",
            false,
        )];
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-01T23:59:59Z")),
            None
        );
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-02T00:00:00Z")).map(|d| d.id.as_str()),
            Some("a")
        );
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-08T23:59:59Z")).map(|d| d.id.as_str()),
            Some("a")
        );
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-09T00:00:00Z")),
            None
        );
    }

    #[test]
    fn a_delegation_only_counts_for_its_member_and_not_when_deleted() {
        let list = [
            delegation(
                "a",
                "u2",
                "2026-11-02T00:00:00Z",
                "2026-11-09T00:00:00Z",
                false,
            ),
            delegation(
                "b",
                "u1",
                "2026-11-02T00:00:00Z",
                "2026-11-09T00:00:00Z",
                true,
            ),
        ];
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-04T00:00:00Z")),
            None
        );
    }

    #[test]
    fn overlapping_delegations_pick_the_latest_start_then_the_lowest_id() {
        let list = [
            delegation(
                "b",
                "u1",
                "2026-11-02T00:00:00Z",
                "2026-11-20T00:00:00Z",
                false,
            ),
            delegation(
                "c",
                "u1",
                "2026-11-03T00:00:00Z",
                "2026-11-20T00:00:00Z",
                false,
            ),
            delegation(
                "a",
                "u1",
                "2026-11-03T00:00:00Z",
                "2026-11-20T00:00:00Z",
                false,
            ),
        ];
        assert_eq!(
            active_delegation(&list, "u1", at("2026-11-05T00:00:00Z")).map(|d| d.id.as_str()),
            Some("a")
        );
    }

    #[test]
    fn the_week_ends_on_sunday_night_utc() {
        assert_eq!(
            iso(end_of_iso_week_ms(now())),
            "2026-11-08T23:59:59.999Z".to_owned()
        );
        assert_eq!(
            iso(end_of_iso_week_ms(at("2026-11-08T05:00:00Z"))),
            "2026-11-08T23:59:59.999Z".to_owned()
        );
        assert_eq!(
            iso(end_of_iso_week_ms(at("2026-11-09T00:00:00Z"))),
            "2026-11-15T23:59:59.999Z".to_owned()
        );
    }

    #[test]
    fn a_due_date_is_overdue_this_week_or_later() {
        let bucket = |iso: &str| review_bucket(Some(at(iso)), now());
        assert_eq!(bucket("2026-11-03T23:00:00Z"), ReviewBucket::Overdue);
        assert_eq!(bucket("2026-11-04T10:00:00Z"), ReviewBucket::ThisWeek);
        assert_eq!(bucket("2026-11-08T23:59:59.999Z"), ReviewBucket::ThisWeek);
        assert_eq!(bucket("2026-11-09T00:00:00Z"), ReviewBucket::Later);
        assert_eq!(review_bucket(None, now()), ReviewBucket::Later);
    }

    #[test]
    fn reviews_order_by_due_date_then_request_time_then_id() {
        let base = "2026-11-01T00:00:00Z";
        let mut items = [
            dated("d", None, base),
            dated("c", Some("2026-11-06T00:00:00Z"), "2026-11-02T00:00:00Z"),
            dated("b", Some("2026-11-06T00:00:00Z"), base),
            dated("a", Some("2026-11-06T00:00:00Z"), base),
            dated("e", Some("2026-11-05T00:00:00Z"), "2026-11-03T00:00:00Z"),
        ];
        items.sort_by(compare_reviews);
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["e", "a", "b", "c", "d"]);
    }

    fn input(approver: &str) -> ApprovalRowInput {
        ApprovalRowInput::member(approver, "change_manager")
    }

    #[test]
    fn a_request_with_a_rule_per_approver_is_accepted() {
        assert_eq!(
            approval_request_error("change_request", &[input("u1")]),
            None
        );
        let contact = ApprovalRowInput {
            approver_kind: Some("contact".to_owned()),
            step: Some(2),
            ..input("c1")
        };
        assert_eq!(
            approval_request_error("deliverable", &[input("u1"), contact]),
            None
        );
    }

    #[test]
    fn a_request_is_refused_for_a_bad_subject_approver_step_or_rule() {
        assert_eq!(
            approval_request_error("nope", &[input("u1")]),
            Some(messages::INVALID_SUBJECT)
        );
        assert_eq!(
            approval_request_error("gate", &[]),
            Some(messages::NO_APPROVERS)
        );
        assert_eq!(
            approval_request_error("gate", &[input(" ")]),
            Some(messages::INVALID_APPROVER)
        );
        let bot = ApprovalRowInput {
            approver_kind: Some("bot".to_owned()),
            ..input("u1")
        };
        assert_eq!(
            approval_request_error("gate", &[bot]),
            Some(messages::INVALID_APPROVER)
        );
        assert_eq!(
            approval_request_error("gate", &[input("u1").with_step(0)]),
            Some(messages::INVALID_STEP)
        );
        let no_rule = ApprovalRowInput {
            rule: json!({ "code": "" }),
            ..input("u1")
        };
        assert_eq!(
            approval_request_error("gate", &[no_rule]),
            Some(messages::INVALID_RULE)
        );
    }

    fn away() -> DelegationRow {
        DelegationRow {
            id: "dlg1".to_owned(),
            member_id: "u1".to_owned(),
            delegate_id: "u9".to_owned(),
            starts_at: at("2026-11-01T00:00:00Z"),
            ends_at: at("2026-11-10T00:00:00Z"),
            ..DelegationRow::default()
        }
    }

    #[test]
    fn approvers_stay_as_given_defaulting_to_a_member_in_step_one() {
        type Planned<'a> = (&'a str, &'a str, i64, Option<&'a str>, Option<&'a str>);
        let rule = "change_board_over_limit";
        let planned = plan_approvers(
            &[
                ApprovalRowInput::member("u1", rule),
                ApprovalRowInput::member("u2", rule).with_role_label("Finance"),
            ],
            &[],
            now(),
        );
        let shown: Vec<Planned<'_>> = planned
            .iter()
            .map(|p| {
                (
                    p.approver_kind.as_str(),
                    p.approver_id.as_str(),
                    p.step,
                    p.delegated_from.as_deref(),
                    p.role_label.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                ("member", "u1", 1, None, None),
                ("member", "u2", 1, None, Some("Finance"))
            ]
        );
    }

    #[test]
    fn a_member_on_delegation_is_replaced_by_the_delegate() {
        let planned = plan_approvers(
            &[ApprovalRowInput::member("u1", "change_manager")],
            &[away()],
            now(),
        );
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].approver_id, "u9");
        assert_eq!(planned[0].delegated_from.as_deref(), Some("u1"));
    }

    #[test]
    fn delegation_stops_at_the_period_end_and_never_applies_to_a_contact() {
        let after = plan_approvers(
            &[ApprovalRowInput::member("u1", "change_manager")],
            &[away()],
            at("2026-11-10T00:00:00Z"),
        );
        assert_eq!(after[0].approver_id, "u1");
        assert_eq!(after[0].delegated_from, None);
        let contact = ApprovalRowInput {
            approver_kind: Some("contact".to_owned()),
            ..input("u1")
        };
        let planned = plan_approvers(&[contact], &[away()], now());
        assert_eq!(planned[0].approver_kind, "contact");
        assert_eq!(planned[0].approver_id, "u1");
        assert_eq!(planned[0].delegated_from, None);
    }

    #[test]
    fn a_person_is_asked_once_in_the_lowest_step_also_through_delegation() {
        let rule = "change_board_over_limit";
        let planned = plan_approvers(
            &[
                ApprovalRowInput::member("u2", rule).with_step(2),
                ApprovalRowInput::member("u9", rule).with_step(1),
                ApprovalRowInput::member("u1", rule).with_step(1),
                ApprovalRowInput::member("u2", rule).with_step(1),
            ],
            &[away()],
            now(),
        );
        let shown: Vec<(&str, i64)> = planned
            .iter()
            .map(|p| (p.approver_id.as_str(), p.step))
            .collect();
        assert_eq!(shown, [("u9", 1), ("u2", 1)]);
    }

    #[test]
    fn approvers_order_by_step_and_keep_the_given_order_inside_a_step() {
        let rule = "gate";
        let planned = plan_approvers(
            &[
                ApprovalRowInput::member("c", rule).with_step(2),
                ApprovalRowInput::member("a", rule).with_step(1),
                ApprovalRowInput::member("b", rule).with_step(1),
            ],
            &[],
            now(),
        );
        let ids: Vec<&str> = planned.iter().map(|p| p.approver_id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn the_sponsor_is_the_named_one_then_the_project_manager() {
        assert_eq!(
            sponsor_of(Some(&json!({ "sponsorId": "u5" })), Some("u1")).as_deref(),
            Some("u5")
        );
        assert_eq!(
            sponsor_of(Some(&json!({})), Some("u1")).as_deref(),
            Some("u1")
        );
        assert_eq!(sponsor_of(None, Some("u1")).as_deref(), Some("u1"));
        assert_eq!(sponsor_of(Some(&json!({ "sponsorId": null })), None), None);
        assert_eq!(
            sponsor_of(Some(&json!({ "sponsorId": "" })), Some("u1")).as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn a_row_survives_the_trip_through_json() {
        let source = ApprovalRow {
            id: "apr_1".to_owned(),
            project_id: Some("proj_1".to_owned()),
            subject_type: "change_request".to_owned(),
            subject_id: "pcr_1".to_owned(),
            approver_kind: "member".to_owned(),
            approver_id: "u1".to_owned(),
            role_label: Some("Finance".to_owned()),
            step: 2,
            rule: json!({ "code": "change_manager" }),
            decision: "pending".to_owned(),
            due_at: Some(at("2026-11-06T00:00:00Z")),
            created_by: "u2".to_owned(),
            created_at: at("2026-11-01T00:00:00Z"),
            updated_at: at("2026-11-01T00:00:00Z"),
            ..ApprovalRow::default()
        };
        assert_eq!(ApprovalRow::from_json(&source.to_json()), Some(source));
    }

    struct Settles;

    impl ApprovalSubjectHandler for Settles {
        fn resolve(&self, _rows: &[ApprovalRow]) -> ApprovalOutcome {
            ApprovalOutcome::Approved
        }

        fn on_resolved<'a>(
            &'a self,
            _db: &'a PgPool,
            _subject_id: &'a str,
            _outcome: ResolvedApprovalOutcome,
            _context: &'a ApprovalResolutionContext,
        ) -> ApprovalFuture<'a, Result<(), sqlx::Error>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[test]
    fn a_registered_handler_decides_and_the_default_is_unanimous() {
        let rows = [row("pending", 1, false)];
        assert_eq!(
            resolve_subject_rows("registry_test_subject", &rows),
            ApprovalOutcome::Pending
        );
        register_approval_subject("registry_test_subject", Arc::new(Settles));
        assert_eq!(
            resolve_subject_rows("registry_test_subject", &rows),
            ApprovalOutcome::Approved
        );
        unregister_approval_subject("registry_test_subject");
        assert!(approval_subject_handler("registry_test_subject").is_none());
    }
}
