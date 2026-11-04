//! Deliverable rules (`@weldsuite/flow-domain/deliverables`): numbering,
//! acceptance criteria, accepting and signing off, and the shapes a
//! deliverable takes on the wire and in entity events (design:
//! weldflow-project-control.md; ADRs FLOW-011 and FLOW-016).
//!
//! Every message returned here goes to the client as it is, so both backends
//! answer alike. Rows are read as `weldsuite_db::js_row` gives them:
//! camelCase keys, timestamps as ISO strings.

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::numbering::NumberSequence;

/// `DELIVERABLE_STATUSES`.
pub const DELIVERABLE_STATUSES: [&str; 4] = ["not_started", "in_progress", "accepted", "rejected"];

/// `DELIVERABLE_MESSAGES`.
pub mod messages {
    pub const DATES_ORDER: &str = "plannedEnd cannot be before plannedStart";
    pub const ALREADY_ACCEPTED: &str = "This deliverable has already been accepted";
    pub const CRITERIA_OPEN: &str = "Every acceptance criterion has to be met first";
    pub const ACCEPTED_LOCKED: &str =
        "An accepted deliverable can only change its visibility and position";
    pub const SIGNOFF_WAITING: &str = "A sign-off is already waiting for an answer";
    pub const NO_SPONSOR: &str = "This project has no sponsor to ask for sign-off";
    pub const NOT_REJECTABLE: &str = "An accepted deliverable cannot be rejected";
}

// ── Numbering ───────────────────────────────────────────────────────────────

/// `deliverableSequence(projectId)`: scope `del:<projectId>`, prefix `D`.
pub fn deliverable_sequence(project_id: &str) -> NumberSequence {
    NumberSequence {
        scope: Cow::Owned(format!("del:{project_id}")),
        prefix: "D",
    }
}

/// `deliverableCode(number)`: `D3`.
pub fn deliverable_code(number: i64) -> String {
    format!("D{number}")
}

// ── Acceptance criteria ─────────────────────────────────────────────────────

/// `applyCriteria(previous, next, now)`: the criteria a request leaves the
/// deliverable with. `metAt` is the moment a criterion was marked met: kept
/// while the same criterion (same position and text) stays met, `now` (an ISO
/// string) when it turns met, null when it is not met. `next` items are the
/// request's `{ text, met? }`, `previous` the stored `{ text, met, metAt }`.
pub fn apply_criteria(previous: &[Value], next: &[Value], now_iso: &str) -> Vec<Value> {
    next.iter()
        .enumerate()
        .map(|(index, criterion)| {
            let text = criterion
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let met = criterion.get("met") == Some(&Value::Bool(true));
            if !met {
                return json!({ "text": text, "met": false, "metAt": null });
            }
            let kept = previous.get(index).and_then(|before| {
                let same = before.get("met") == Some(&Value::Bool(true))
                    && before.get("text").and_then(Value::as_str) == Some(text);
                same.then(|| before.get("metAt").and_then(Value::as_str))
                    .flatten()
                    .filter(|met_at| !met_at.is_empty())
            });
            json!({ "text": text, "met": true, "metAt": kept.unwrap_or(now_iso) })
        })
        .collect()
}

/// `criteriaCounts(criteria)`: how many are met, out of how many.
pub fn criteria_counts(criteria: &[Value]) -> (i64, i64) {
    let met = criteria
        .iter()
        .filter(|criterion| criterion.get("met") == Some(&Value::Bool(true)))
        .count();
    (
        i64::try_from(met).unwrap_or(i64::MAX),
        i64::try_from(criteria.len()).unwrap_or(i64::MAX),
    )
}

// ── Dates, editing, accepting ───────────────────────────────────────────────

/// `deliverableDatesError(plannedStart, plannedEnd)`: dates are epoch
/// milliseconds.
pub fn deliverable_dates_error(start: Option<i64>, end: Option<i64>) -> Option<&'static str> {
    match (start, end) {
        (Some(start), Some(end)) if end < start => Some(messages::DATES_ORDER),
        _ => None,
    }
}

/// `acceptedEditError(status, bodyKeys)`: the refusal (409) of an edit that
/// changes more than an accepted deliverable allows.
pub fn accepted_edit_error(status: &str, body_keys: &[&str]) -> Option<&'static str> {
    if status != "accepted" {
        return None;
    }
    body_keys
        .iter()
        .any(|key| !matches!(*key, "clientVisible" | "position"))
        .then_some(messages::ACCEPTED_LOCKED)
}

/// `acceptError(row)`: the refusal (409) of accepting, or asking sign-off for,
/// a deliverable that cannot be accepted.
pub fn accept_error(status: &str, criteria: &[Value]) -> Option<&'static str> {
    if status == "accepted" {
        return Some(messages::ALREADY_ACCEPTED);
    }
    let (met, total) = criteria_counts(criteria);
    (met < total).then_some(messages::CRITERIA_OPEN)
}

/// `rejectError(status)`: an accepted deliverable cannot be rejected.
pub fn reject_error(status: &str) -> Option<&'static str> {
    (status == "accepted").then_some(messages::NOT_REJECTABLE)
}

// ── Sign-off ────────────────────────────────────────────────────────────────

/// `signoffIsOpen(rows)`: whether a sign-off is still waiting for an answer:
/// one of its rows is open.
pub fn signoff_is_open(decisions: &[&str]) -> bool {
    decisions
        .iter()
        .any(|decision| matches!(*decision, "pending" | "info_requested"))
}

/// What a settled sign-off does to a deliverable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliverableResolution {
    /// Accepted by `accepted_by`, as of `accepted_at_ms`.
    Accepted {
        accepted_by: Option<String>,
        accepted_at_ms: i64,
    },
    Rejected,
}

/// One approval row as the resolution reads it.
#[derive(Debug, Clone, Copy)]
pub struct SignoffRow<'a> {
    pub decided_by: Option<&'a str>,
    pub decision: &'a str,
    pub step: i64,
}

/// `deliverableResolution(outcome, actorId, rows, now)`: approved accepts the
/// deliverable by whoever gave the answer that settled it (else the last one
/// who approved), rejected rejects it.
pub fn deliverable_resolution(
    approved: bool,
    actor_id: Option<&str>,
    rows: &[SignoffRow<'_>],
    now_ms: i64,
) -> DeliverableResolution {
    if !approved {
        return DeliverableResolution::Rejected;
    }
    // `reduce((best, row) => (!best || row.step >= best.step ? row : best), null)`.
    let last = rows
        .iter()
        .filter(|row| matches!(row.decision, "approved" | "approved_with_conditions"))
        .fold(None::<&SignoffRow<'_>>, |best, row| match best {
            Some(best) if row.step < best.step => Some(best),
            _ => Some(row),
        });
    DeliverableResolution::Accepted {
        accepted_by: actor_id
            .or_else(|| last.and_then(|row| row.decided_by))
            .map(str::to_owned),
        accepted_at_ms: now_ms,
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

fn number_of(row: &Value) -> i64 {
    row.get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn criteria_of(row: &Value) -> Vec<Value> {
    row.get("acceptanceCriteria")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `presentDeliverable(row, taskProgress, raid)`.
pub fn present_deliverable(row: &Value, done: i64, total: i64, raid: &[Value]) -> Value {
    let criteria = criteria_of(row);
    let (met, count) = criteria_counts(&criteria);
    let wire: Vec<Value> = criteria
        .iter()
        .map(|criterion| {
            json!({
                "text": field(criterion, "text"),
                "met": field(criterion, "met"),
                "metAt": field(criterion, "metAt"),
            })
        })
        .collect();
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "number": field(row, "number"),
        "code": deliverable_code(number_of(row)),
        "title": field(row, "title"),
        "description": field(row, "description"),
        "ownerId": field(row, "ownerId"),
        "status": field(row, "status"),
        "plannedStart": field(row, "plannedStart"),
        "plannedEnd": field(row, "plannedEnd"),
        "acceptanceCriteria": wire,
        "acceptedBy": field(row, "acceptedBy"),
        "acceptedAt": field(row, "acceptedAt"),
        "position": field(row, "position"),
        "clientVisible": field(row, "clientVisible"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
        "deletedAt": field(row, "deletedAt"),
        "taskProgress": { "done": done, "total": total },
        "criteriaMet": met,
        "criteriaTotal": count,
        "raid": raid,
    })
}

/// `presentSignoffApproval(row)`: one answer of a sign-off.
pub fn present_signoff_approval(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "approverKind": field(row, "approverKind"),
        "approverId": field(row, "approverId"),
        "roleLabel": field(row, "roleLabel"),
        "step": field(row, "step"),
        "decision": field(row, "decision"),
        "note": field(row, "note"),
        "dueAt": field(row, "dueAt"),
        "decidedAt": field(row, "decidedAt"),
    })
}

/// `deliverableEventData(row)`: ids and statuses, no free text beyond the title.
pub fn deliverable_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "number": field(row, "number"),
        "code": deliverable_code(number_of(row)),
        "title": field(row, "title"),
        "status": field(row, "status"),
        "ownerId": field(row, "ownerId"),
        "acceptedBy": field(row, "acceptedBy"),
        "clientVisible": field(row, "clientVisible"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-03T10:00:00.000Z";
    const LATER: &str = "2026-11-04T10:00:00.000Z";

    #[test]
    fn numbers_deliverables_dn() {
        let sequence = deliverable_sequence("prj_1");
        assert_eq!(sequence.scope, "del:prj_1");
        assert_eq!(sequence.prefix, "D");
        assert_eq!(deliverable_code(3), "D3");
    }

    #[test]
    fn stamps_met_at_when_a_criterion_turns_met_and_keeps_it_while_it_stays_met() {
        let first = apply_criteria(
            &[],
            &[
                json!({ "text": "Login works", "met": true }),
                json!({ "text": "Reset works" }),
            ],
            NOW,
        );
        assert_eq!(
            first,
            vec![
                json!({ "text": "Login works", "met": true, "metAt": NOW }),
                json!({ "text": "Reset works", "met": false, "metAt": null }),
            ]
        );
        let second = apply_criteria(
            &first,
            &[
                json!({ "text": "Login works", "met": true }),
                json!({ "text": "Reset works", "met": true }),
            ],
            LATER,
        );
        let met_at = |list: &[Value]| list.iter().map(|c| c["metAt"].clone()).collect::<Vec<_>>();
        assert_eq!(met_at(&second), vec![json!(NOW), json!(LATER)]);
        // Changing the text starts over; un-meeting clears.
        let third = apply_criteria(
            &second,
            &[
                json!({ "text": "Login works well", "met": true }),
                json!({ "text": "Reset works" }),
            ],
            LATER,
        );
        assert_eq!(met_at(&third), vec![json!(LATER), Value::Null]);
        assert_eq!(criteria_counts(&second), (2, 2));
    }

    #[test]
    fn wants_the_end_after_the_start() {
        assert_eq!(deliverable_dates_error(Some(10), Some(10)), None);
        assert_eq!(
            deliverable_dates_error(Some(10), Some(9)),
            Some(messages::DATES_ORDER)
        );
        assert_eq!(deliverable_dates_error(None, Some(9)), None);
        assert_eq!(deliverable_dates_error(Some(10), None), None);
    }

    #[test]
    fn accepts_once_every_criterion_is_met_and_locks_an_accepted_deliverable() {
        let met = json!({ "text": "a", "met": true, "metAt": NOW });
        let open = json!({ "text": "b", "met": false, "metAt": null });
        assert_eq!(
            accept_error("in_progress", std::slice::from_ref(&met)),
            None
        );
        assert_eq!(accept_error("in_progress", &[]), None);
        assert_eq!(
            accept_error("in_progress", &[met.clone(), open]),
            Some(messages::CRITERIA_OPEN)
        );
        assert_eq!(
            accept_error("accepted", &[met]),
            Some(messages::ALREADY_ACCEPTED)
        );
        assert_eq!(
            accepted_edit_error("accepted", &["position", "clientVisible"]),
            None
        );
        assert_eq!(
            accepted_edit_error("accepted", &["title"]),
            Some(messages::ACCEPTED_LOCKED)
        );
        assert_eq!(accepted_edit_error("in_progress", &["title"]), None);
        assert_eq!(reject_error("accepted"), Some(messages::NOT_REJECTABLE));
        assert_eq!(reject_error("in_progress"), None);
    }

    #[test]
    fn a_sign_off_is_open_while_a_row_waits() {
        assert!(signoff_is_open(&["approved", "pending"]));
        assert!(signoff_is_open(&["info_requested"]));
        assert!(!signoff_is_open(&["approved", "rejected"]));
    }

    #[test]
    fn accepts_by_the_one_who_answered_else_the_last_approver_a_rejection_rejects() {
        let rows = [
            SignoffRow {
                decided_by: Some("u_sponsor"),
                decision: "approved",
                step: 1,
            },
            SignoffRow {
                decided_by: Some("con_1"),
                decision: "approved",
                step: 2,
            },
        ];
        assert_eq!(
            deliverable_resolution(true, Some("con_1"), &rows, 9),
            DeliverableResolution::Accepted {
                accepted_by: Some("con_1".into()),
                accepted_at_ms: 9
            }
        );
        assert_eq!(
            deliverable_resolution(true, None, &rows, 9),
            DeliverableResolution::Accepted {
                accepted_by: Some("con_1".into()),
                accepted_at_ms: 9
            }
        );
        assert_eq!(
            deliverable_resolution(false, Some("u_sponsor"), &rows, 9),
            DeliverableResolution::Rejected
        );
    }

    #[test]
    fn presents_a_deliverable_with_progress_and_criteria_counts() {
        let row = json!({
            "id": "del_1", "projectId": "prj_1", "number": 3, "title": "Login",
            "acceptanceCriteria": [{ "text": "a", "met": true, "metAt": NOW }, { "text": "b", "met": false, "metAt": null }],
            "position": 1, "clientVisible": false, "status": "in_progress",
        });
        let wire = present_deliverable(&row, 2, 5, &[json!({ "code": "RSK-1" })]);
        assert_eq!(wire["code"], "D3");
        assert_eq!(wire["taskProgress"], json!({ "done": 2, "total": 5 }));
        assert_eq!(
            (wire["criteriaMet"].clone(), wire["criteriaTotal"].clone()),
            (json!(1), json!(2))
        );
        assert_eq!(wire["raid"], json!([{ "code": "RSK-1" }]));
        assert_eq!(deliverable_event_data(&row)["code"], "D3");
    }
}
