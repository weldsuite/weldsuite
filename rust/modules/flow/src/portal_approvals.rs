//! The two approvals-core calls the client portal makes, as a thin local
//! adapter over `flow_approvals` (`packages/domains/flow/src/approvals.ts`):
//! `listPendingForApprover` for a contact, and `decideApproval` for a contact
//! actor (no delegation: a delegate is always a member).
//!
//! TODO(slice A): use approvals.rs. The subject handlers (`onResolved`, a
//! subject's own `resolve`) are not dispatched here: an answer that settles a
//! change request or a deliverable stores the answer, clears a rejected
//! subject's other open rows and reports the outcome, as the default
//! (unanimous) resolution does; it does not apply the change or mark the
//! deliverable accepted.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::js_row;
use weldsuite_flow_domain::js::millis_of;
use weldsuite_kit::validation::js_trim;

pub(crate) const APPROVAL_NOT_FOUND: &str = "Approval not found";
const NOT_APPROVER: &str = "You are not an approver of this review";
const ALREADY_DECIDED: &str = "This review has already been answered";
const STEP_NOT_ACTIVE: &str = "This review is waiting for an earlier step to be answered";
const INVALID_DECISION: &str =
    "Choose approve, approve with conditions, decline or ask for more information";
const NOTE_REQUIRED: &str = "A note is required to decline or to set conditions";

/// The answers that settle a row for good.
const FINAL_DECISIONS: [&str; 3] = ["approved", "approved_with_conditions", "rejected"];
/// The answers a row can still be given.
const OPEN_DECISIONS: [&str; 2] = ["pending", "info_requested"];
/// Answers that need a note.
const NOTE_REQUIRED_DECISIONS: [&str; 2] = ["rejected", "approved_with_conditions"];

fn is_approving(decision: &str) -> bool {
    matches!(decision, "approved" | "approved_with_conditions")
}

fn is_open(decision: &str) -> bool {
    OPEN_DECISIONS.contains(&decision)
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn step(row: &Value) -> i64 {
    row.get("step").and_then(Value::as_i64).unwrap_or(1)
}

/// A review waiting for the contact: the `flow_approvals` row (as Drizzle
/// returns it) and whether its earlier steps are answered.
pub(crate) struct PendingReview {
    pub(crate) approval: Value,
    pub(crate) actionable: bool,
}

/// `isStepActive(row, siblings)`: a later step waits for every row of a lower
/// step to be approved. Rows of the same step run in parallel.
fn is_step_active(row: &Value, siblings: &[Value]) -> bool {
    let mine = step(row);
    siblings.iter().all(|other| {
        !other.get("deletedAt").is_none_or(Value::is_null)
            || step(other) >= mine
            || is_approving(text(other, "decision"))
    })
}

/// `compareReviews`: earliest due date first (none last), then the oldest
/// request, then the id.
pub(crate) fn compare_reviews(a: &Value, b: &Value) -> std::cmp::Ordering {
    let at = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).and_then(millis_of);
    let due = |row: &Value| at(row, "dueAt").unwrap_or(i64::MAX);
    due(a)
        .cmp(&due(b))
        .then_with(|| {
            at(a, "createdAt")
                .unwrap_or(0)
                .cmp(&at(b, "createdAt").unwrap_or(0))
        })
        .then_with(|| text(a, "id").cmp(text(b, "id")))
}

/// `listPendingForApprover(db, contactId, { approverKind: 'contact' })`: the
/// contact's pending reviews whose earlier steps are answered, earliest due
/// date first.
pub(crate) async fn list_pending_for_contact(
    db: &PgPool,
    contact_id: &str,
) -> Result<Vec<PendingReview>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.approver_kind = 'contact' and a.approver_id = any($1) and a.decision = any($2)
           and a.deleted_at is null
         order by a.due_at asc nulls last, a.created_at asc, a.id asc
         limit 200",
    )
    .bind([contact_id.to_owned()].as_slice())
    .bind(["pending".to_owned()].as_slice())
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    // A later step waits for the earlier one: read the siblings of these subjects.
    let mut subject_ids: Vec<String> = rows
        .iter()
        .map(|row| text(row, "subjectId").to_owned())
        .collect();
    subject_ids.sort();
    subject_ids.dedup();
    let siblings: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a where a.subject_id = any($1) and a.deleted_at is null",
    )
    .bind(&subject_ids)
    .fetch_all(db)
    .await?;
    let mut by_subject: HashMap<String, Vec<Value>> = HashMap::new();
    for sibling in siblings.into_iter().map(js_row) {
        by_subject
            .entry(format!(
                "{}:{}",
                text(&sibling, "subjectType"),
                text(&sibling, "subjectId")
            ))
            .or_default()
            .push(sibling);
    }
    let mut reviews: Vec<PendingReview> = rows
        .into_iter()
        .map(|approval| {
            let key = format!(
                "{}:{}",
                text(&approval, "subjectType"),
                text(&approval, "subjectId")
            );
            let actionable = match by_subject.get(&key) {
                Some(siblings) => is_step_active(&approval, siblings),
                None => true,
            };
            PendingReview {
                approval,
                actionable,
            }
        })
        .filter(|review| review.actionable)
        .collect();
    reviews.sort_by(|a, b| compare_reviews(&a.approval, &b.approval));
    Ok(reviews)
}

/// Why an answer was refused (`DecideApprovalError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecideError {
    NotFound,
    NotApprover,
    AlreadyDecided,
    StepNotActive,
    InvalidDecision,
    NoteRequired,
}

/// An answer that was stored (`DecideApprovalResult`, `ok: true`).
pub(crate) struct Decided {
    /// The row as answered.
    pub(crate) approval: Value,
    /// What the subject's rows add up to: `approved`, `rejected` or `pending`.
    pub(crate) outcome: &'static str,
    /// True when this answer settled the subject.
    pub(crate) resolved: bool,
}

pub(crate) type DecideResult = Result<Decided, (DecideError, &'static str)>;

/// `resolveUnanimous(rows)`: one rejection rejects, every row approved
/// approves, anything else (and no rows) is still waiting.
fn resolve_unanimous(rows: &[Value]) -> &'static str {
    if rows.is_empty() {
        return "pending";
    }
    if rows.iter().any(|row| text(row, "decision") == "rejected") {
        return "rejected";
    }
    if rows.iter().all(|row| is_approving(text(row, "decision"))) {
        return "approved";
    }
    "pending"
}

/// A subject's live rows, in step order (`listSubjectApprovals`).
async fn subject_rows(
    db: &PgPool,
    subject_type: &str,
    subject_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.subject_type = $1 and a.subject_id = $2 and a.deleted_at is null
         order by a.step asc, a.created_at asc, a.id asc",
    )
    .bind(subject_type)
    .bind(subject_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `decideApproval(db, { approvalId, actor: { kind: 'contact', id }, decision, note })`.
///
/// The checks run in a fixed order: the row exists, the actor is its approver,
/// it is still open, it is its step's turn, then the answer itself. The answer
/// is stored with a guarded update (only an open row changes).
pub(crate) async fn decide_as_contact(
    db: &PgPool,
    approval_id: &str,
    contact_id: &str,
    decision: &str,
    note: Option<&str>,
    now: &str,
) -> Result<DecideResult, sqlx::Error> {
    let fail = |code: DecideError, message: &'static str| Ok(Err((code, message)));

    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a where a.id = $1 and a.deleted_at is null limit 1",
    )
    .bind(approval_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(js_row) else {
        return fail(DecideError::NotFound, APPROVAL_NOT_FOUND);
    };

    if text(&row, "approverKind") != "contact" || text(&row, "approverId") != contact_id {
        return fail(DecideError::NotApprover, NOT_APPROVER);
    }
    if !is_open(text(&row, "decision")) {
        return fail(DecideError::AlreadyDecided, ALREADY_DECIDED);
    }
    let subject_type = text(&row, "subjectType");
    let subject_id = text(&row, "subjectId");
    let siblings = subject_rows(db, subject_type, subject_id).await?;
    if !is_step_active(&row, &siblings) {
        return fail(DecideError::StepNotActive, STEP_NOT_ACTIVE);
    }

    // `decisionInputError`
    if !FINAL_DECISIONS.contains(&decision) && decision != "info_requested" {
        return fail(DecideError::InvalidDecision, INVALID_DECISION);
    }
    if NOTE_REQUIRED_DECISIONS.contains(&decision) && js_trim(note.unwrap_or_default()).is_empty() {
        return fail(DecideError::NoteRequired, NOTE_REQUIRED);
    }

    let stored_note = note.map(js_trim).filter(|n| !n.is_empty());
    let updated: Option<Value> = sqlx::query_scalar(
        "update flow_approvals set decision = $2, note = $3, decided_at = $4::timestamptz,
                decided_by = $5, updated_at = $4::timestamptz
         where id = $1 and deleted_at is null and decision = any($6)
         returning to_jsonb(flow_approvals.*)",
    )
    .bind(approval_id)
    .bind(decision)
    .bind(stored_note)
    .bind(now)
    .bind(contact_id)
    .bind(OPEN_DECISIONS.map(str::to_owned).as_slice())
    .fetch_optional(db)
    .await?;
    // Someone answered between the read and the update.
    let Some(updated) = updated.map(js_row) else {
        return fail(DecideError::AlreadyDecided, ALREADY_DECIDED);
    };

    // `resolveApprovalSubject`, without the subject's handler.
    let mut rows = subject_rows(db, subject_type, subject_id).await?;
    let outcome = resolve_unanimous(&rows);
    let resolved = outcome != "pending";
    if outcome == "rejected" && rows.iter().any(|r| is_open(text(r, "decision"))) {
        // Nobody is asked about a settled subject (`cancelPendingApprovals`).
        sqlx::query(
            "update flow_approvals set deleted_at = $3::timestamptz, updated_at = $3::timestamptz
             where subject_type = $1 and subject_id = $2 and deleted_at is null and decision = any($4)",
        )
        .bind(subject_type)
        .bind(subject_id)
        .bind(now)
        .bind(OPEN_DECISIONS.map(str::to_owned).as_slice())
        .execute(db)
        .await?;
        rows = subject_rows(db, subject_type, subject_id).await?;
    }
    let approval = rows
        .into_iter()
        .find(|r| text(r, "id") == text(&updated, "id"))
        .unwrap_or(updated);
    Ok(Ok(Decided {
        approval,
        outcome,
        resolved,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(id: &str, step: i64, decision: &str) -> Value {
        json!({"id": id, "step": step, "decision": decision, "deletedAt": null})
    }

    #[test]
    fn a_later_step_waits_for_the_earlier_one() {
        let rows = vec![row("a", 1, "pending"), row("b", 2, "pending")];
        assert!(is_step_active(&rows[0], &rows));
        assert!(!is_step_active(&rows[1], &rows));
        let answered = vec![
            row("a", 1, "approved_with_conditions"),
            row("b", 2, "pending"),
        ];
        assert!(is_step_active(&answered[1], &answered));
        let asked = vec![row("a", 1, "info_requested"), row("b", 2, "pending")];
        assert!(!is_step_active(&asked[1], &asked));
    }

    #[test]
    fn rows_add_up_unanimously() {
        assert_eq!(resolve_unanimous(&[]), "pending");
        assert_eq!(
            resolve_unanimous(&[
                row("a", 1, "approved"),
                row("b", 1, "approved_with_conditions")
            ]),
            "approved"
        );
        assert_eq!(
            resolve_unanimous(&[row("a", 1, "approved"), row("b", 1, "pending")]),
            "pending"
        );
        assert_eq!(
            resolve_unanimous(&[row("a", 1, "rejected"), row("b", 1, "pending")]),
            "rejected"
        );
    }

    #[test]
    fn reviews_sort_by_due_date_then_age_then_id() {
        let a = json!({"id":"a","dueAt":null,"createdAt":"2026-11-01T08:00:00.000Z"});
        let b = json!({"id":"b","dueAt":"2026-11-05T00:00:00.000Z","createdAt":"2026-11-02T08:00:00.000Z"});
        let c = json!({"id":"c","dueAt":null,"createdAt":"2026-11-01T08:00:00.000Z"});
        let mut rows = [c.clone(), a.clone(), b.clone()];
        rows.sort_by(compare_reviews);
        let ids: Vec<&str> = rows.iter().map(|r| text(r, "id")).collect();
        assert_eq!(ids, ["b", "a", "c"]);
    }
}
