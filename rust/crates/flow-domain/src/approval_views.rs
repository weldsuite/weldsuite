//! The shapes of the approvals routes (`/api/approvals`) and the rules of
//! their inputs (`@weldsuite/flow-domain/approval-views`): delegation checks,
//! the payload of a `flow_approval` entity event, how an approval row is
//! shown, and the figures a subject exposes to the reviewer. Every message
//! goes to the client as it is, so both backends answer alike.

use serde_json::{Value, json};

use crate::approvals::{ApprovalRow, DelegationRow};
use crate::js::iso_from_millis;

pub mod delegation_messages {
    pub const SELF: &str = "You cannot delegate your reviews to yourself";
    pub const PERIOD: &str = "The end of the delegation must be after its start";
    pub const ENDED: &str = "The delegation has already ended";
}

pub const SPONSOR_NOT_MEMBER: &str = "The sponsor must be a member of this project";
pub const TIMESHEET_ONLY_APPROVE_OR_DECLINE: &str = "Time entries can only be approved or declined";
pub const TIMESHEET_NO_PERMISSION: &str = "You do not have permission to review time entries";

/// `delegationInputError`: yourself, then a backwards period, then one that is over.
pub fn delegation_input_error(
    member_id: &str,
    delegate_id: &str,
    starts_at: i64,
    ends_at: i64,
    now: i64,
) -> Option<&'static str> {
    if member_id == delegate_id {
        return Some(delegation_messages::SELF);
    }
    if ends_at <= starts_at {
        return Some(delegation_messages::PERIOD);
    }
    if ends_at <= now {
        return Some(delegation_messages::ENDED);
    }
    None
}

fn iso(ms: Option<i64>) -> Value {
    ms.and_then(iso_from_millis)
        .map_or(Value::Null, Value::String)
}

/// `presentReviewApprover`.
pub fn present_review_approver(row: &ApprovalRow) -> Value {
    json!({
        "approvalId": row.id,
        "approverKind": row.approver_kind,
        "approverId": row.approver_id,
        "roleLabel": row.role_label,
        "step": row.step,
        "decision": row.decision,
        "note": row.note,
        "decidedAt": iso(row.decided_at),
        "delegatedFrom": row.delegated_from,
    })
}

/// `approvalEventData`: notes stay out (EVT-005).
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
        "dueAt": iso(row.due_at),
        "delegatedFrom": row.delegated_from,
    })
}

/// `presentDelegation`.
pub fn present_delegation(row: &DelegationRow) -> Value {
    json!({
        "id": row.id,
        "memberId": row.member_id,
        "delegateId": row.delegate_id,
        "startsAt": iso(Some(row.starts_at)),
        "endsAt": iso(Some(row.ends_at)),
        "createdBy": row.created_by,
        "createdAt": iso(Some(row.created_at)),
        "updatedAt": iso(Some(row.updated_at)),
    })
}

/// `delegationEventData`.
pub fn delegation_event_data(row: &DelegationRow, revoked: bool) -> Value {
    json!({
        "id": row.id,
        "memberId": row.member_id,
        "delegateId": row.delegate_id,
        "startsAt": iso(Some(row.starts_at)),
        "endsAt": iso(Some(row.ends_at)),
        "revoked": revoked,
    })
}

const SUMMARY_MAX: usize = 280;

/// `summarize`: whitespace collapsed, cut at 280 UTF-16 units; `None` when blank.
pub fn summarize(text: Option<&str>) -> Option<String> {
    let flat = text?.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    if crate::js::utf16_len(&flat) > SUMMARY_MAX {
        let cut = crate::js::slice_utf16(&flat, SUMMARY_MAX - 1);
        return Some(format!("{}…", cut.trim_end()));
    }
    Some(flat)
}

/// The figures a subject has, for `reviewImpacts`.
#[derive(Debug, Default, Clone)]
pub struct Figures {
    pub cost: Option<String>,
    pub currency: Option<String>,
    pub schedule_days: Option<i64>,
    pub risk_score: Option<i64>,
    pub hours: Option<f64>,
}

/// `reviewImpacts`: only the figures that exist, in a fixed order.
pub fn review_impacts(figures: &Figures) -> Vec<Value> {
    let mut impacts = Vec::new();
    if let Some(cost) = &figures.cost {
        impacts.push(json!({ "kind": "cost", "value": cost, "currency": figures.currency }));
    }
    if let Some(days) = figures.schedule_days {
        impacts.push(json!({ "kind": "schedule_days", "value": days }));
    }
    if let Some(score) = figures.risk_score {
        impacts.push(json!({ "kind": "risk_score", "value": score }));
    }
    if let Some(hours) = figures.hours {
        impacts.push(json!({ "kind": "hours", "value": crate::js::number_value(hours) }));
    }
    impacts
}

/// `hoursOfMinutes`: `Math.round(minutes / 60 * 100) / 100`.
pub fn hours_of_minutes(minutes: f64) -> f64 {
    crate::js::math_round(minutes / 60.0 * 100.0) / 100.0
}

#[cfg(test)]
#[allow(clippy::assert_is_empty)]
mod tests {
    use super::*;

    #[test]
    fn delegations_are_checked_in_order() {
        let now = 1_000;
        assert_eq!(
            delegation_input_error("a", "a", 5, 5, now),
            Some(delegation_messages::SELF)
        );
        assert_eq!(
            delegation_input_error("a", "b", 5, 5, now),
            Some(delegation_messages::PERIOD)
        );
        assert_eq!(
            delegation_input_error("a", "b", 1, 900, now),
            Some(delegation_messages::ENDED)
        );
        assert_eq!(delegation_input_error("a", "b", 1, 2_000, now), None);
    }

    #[test]
    fn summaries_collapse_and_cut() {
        assert_eq!(
            summarize(Some("  one   two\nthree ")).as_deref(),
            Some("one two three")
        );
        assert_eq!(summarize(Some("  ")), None);
        assert_eq!(summarize(None), None);
        assert_eq!(
            summarize(Some(&"x".repeat(400))).map(|s| s.chars().count()),
            Some(280)
        );
    }

    #[test]
    fn impacts_list_only_known_figures() {
        assert!(review_impacts(&Figures::default()).is_empty());
        let impacts = review_impacts(&Figures {
            cost: Some("8000.00".into()),
            currency: Some("EUR".into()),
            schedule_days: Some(0),
            risk_score: Some(16),
            hours: Some(1.5),
        });
        assert_eq!(impacts.len(), 4);
        assert_eq!(
            impacts[0],
            json!({"kind":"cost","value":"8000.00","currency":"EUR"})
        );
        assert_eq!(impacts[3], json!({"kind":"hours","value":1.5}));
        assert!((hours_of_minutes(90.0) - 1.5).abs() < f64::EPSILON);
        assert!((hours_of_minutes(100.0) - 1.67).abs() < f64::EPSILON);
    }
}
