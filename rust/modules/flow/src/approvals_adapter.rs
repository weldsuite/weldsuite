//! The part of the approvals core the close route calls
//! (`packages/domains/flow/src/approvals.ts`): `listSubjectApprovals`,
//! `cancelPendingApprovals`, `requestApprovals` with the delegation planning of
//! `planApprovers`, `sponsorOf`, and the `project_close` subject's
//! `onResolved` (`closeProject`, `publishProjectClosed`).
//!
//! `// TODO(slice A): use approvals.rs` — slice A ports the whole core; this
//! mirrors exactly what slice F needs until then, and the integrator dedupes.

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::PROJECT_CLOSED;
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::{iso_from_millis, millis_of};

use crate::closing_store::find_live_project;
use crate::{Caller, FlowState};

const SUBJECT_TYPES: [&str; 7] = [
    "change_request",
    "gate",
    "deliverable",
    "decision",
    "risk_acceptance",
    "project_request",
    "project_close",
];

/// `APPROVAL_MESSAGES.alreadyRequested`.
pub(crate) const ALREADY_REQUESTED: &str = "Approvals have already been requested for this subject";

/// The project's sponsor (`sponsorOf`): `settings.sponsorId`, else the project manager.
pub(crate) fn sponsor_of(settings: &Value, project_manager_id: Option<&str>) -> Option<String> {
    settings
        .text("sponsorId")
        .filter(|id| !id.is_empty())
        .or(project_manager_id.filter(|id| !id.is_empty()))
        .map(str::to_owned)
}

/// A subject's live rows, in step order (`listSubjectApprovals`).
pub(crate) async fn list_subject_approvals(
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

/// Clear a subject's open rows (soft delete); answered rows stay unless
/// `include_decided` (`cancelPendingApprovals`).
pub(crate) async fn cancel_pending_approvals(
    db: &PgPool,
    subject_type: &str,
    subject_id: &str,
    include_decided: bool,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update flow_approvals set deleted_at = $3::timestamptz, updated_at = $3::timestamptz
         where subject_type = $1 and subject_id = $2 and deleted_at is null
           and ($4::bool or decision in ('pending', 'info_requested'))",
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(iso_from_millis(now_ms))
    .bind(include_decided)
    .execute(db)
    .await?;
    Ok(())
}

/// One approver of a request (`ApprovalRowInput`, member kind).
pub(crate) struct ApproverInput {
    pub(crate) approver_id: String,
    pub(crate) role_label: Option<String>,
    /// 1-based. Same step = in parallel.
    pub(crate) step: i64,
    pub(crate) rule_code: String,
}

/// An approver once the delegation is applied (`PlannedApprover`).
#[derive(Debug, PartialEq, Eq)]
struct Planned {
    approver_id: String,
    delegated_from: Option<String>,
    role_label: Option<String>,
    step: i64,
    rule_code: String,
}

/// The delegation in force for a member at `now_ms` (`activeDelegation`): the
/// one that started last, then the lowest id.
fn active_delegation<'a>(delegations: &'a [Value], member: &str, now_ms: i64) -> Option<&'a Value> {
    let millis = |row: &Value, key: &str| row.text(key).and_then(millis_of);
    delegations
        .iter()
        .filter(|row| {
            row.at("deletedAt").is_null()
                && row.text("memberId") == Some(member)
                && millis(row, "startsAt").is_some_and(|start| start <= now_ms)
                && millis(row, "endsAt").is_some_and(|end| now_ms < end)
        })
        .min_by(|a, b| {
            millis(b, "startsAt")
                .cmp(&millis(a, "startsAt"))
                .then_with(|| a.text("id").cmp(&b.text("id")))
        })
}

/// The approvers a request creates rows for (`planApprovers`): a member on
/// delegation is replaced by their delegate, and a person asked twice is asked
/// once, in the lowest step. The order is by step, then as given.
fn plan_approvers(rows: &[ApproverInput], delegations: &[Value], now_ms: i64) -> Vec<Planned> {
    let mut planned: Vec<(usize, Planned)> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut approver_id = row.approver_id.trim().to_owned();
            let mut delegated_from = None;
            if let Some(delegation) = active_delegation(delegations, &approver_id, now_ms)
                && let Some(delegate) = delegation.text("delegateId")
            {
                delegated_from = Some(std::mem::replace(&mut approver_id, delegate.to_owned()));
            }
            (
                index,
                Planned {
                    approver_id,
                    delegated_from,
                    role_label: row.role_label.clone(),
                    step: row.step,
                    rule_code: row.rule_code.clone(),
                },
            )
        })
        .collect();
    planned.sort_by_key(|(index, row)| (row.step, *index));
    let mut seen = std::collections::HashSet::new();
    planned
        .into_iter()
        .map(|(_, row)| row)
        .filter(|row| seen.insert(row.approver_id.clone()))
        .collect()
}

/// The refusal for a request, or none (`approvalRequestError`).
fn request_error(subject_type: &str, rows: &[ApproverInput]) -> Option<&'static str> {
    if !SUBJECT_TYPES.contains(&subject_type) {
        return Some("Unknown approval subject type");
    }
    if rows.is_empty() {
        return Some("At least one approver is required");
    }
    for row in rows {
        if row.approver_id.trim().is_empty() {
            return Some("Every approver needs a kind and an id");
        }
        if row.step < 1 {
            return Some("A step is a whole number of 1 or more");
        }
        if row.rule_code.trim().is_empty() {
            return Some("Every approval needs the rule that selected the approver");
        }
    }
    None
}

/// What asking for approvals answers.
pub(crate) enum Requested {
    /// The rows made, by step.
    Rows(Vec<Value>),
    /// The message of the refusal.
    Refused(&'static str),
}

/// Ask for approvals: one row per approver, in one insert
/// (`requestApprovals`). Refuses a subject that still has live rows. Entity
/// events are the caller's.
pub(crate) async fn request_approvals(
    db: &PgPool,
    project_id: &str,
    subject_type: &str,
    subject_id: &str,
    requested_by: &str,
    rows: &[ApproverInput],
    now_ms: i64,
) -> Result<Requested, sqlx::Error> {
    if let Some(message) = request_error(subject_type, rows) {
        return Ok(Requested::Refused(message));
    }
    if !list_subject_approvals(db, subject_type, subject_id)
        .await?
        .is_empty()
    {
        return Ok(Requested::Refused(ALREADY_REQUESTED));
    }
    let member_ids: Vec<String> = rows
        .iter()
        .map(|row| row.approver_id.trim().to_owned())
        .collect();
    let now = iso_from_millis(now_ms).unwrap_or_default();
    let delegations: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from flow_approval_delegations d
         where d.member_id = any($1) and d.deleted_at is null
           and d.starts_at <= $2::timestamptz and d.ends_at > $2::timestamptz",
    )
    .bind(&member_ids)
    .bind(&now)
    .fetch_all(db)
    .await?;
    let delegations: Vec<Value> = delegations.into_iter().map(js_row).collect();

    let planned = plan_approvers(rows, &delegations, now_ms);
    let values: Vec<Value> = planned
        .iter()
        .enumerate()
        .map(|(index, p)| {
            // One millisecond apart, so a subject's rows list in the order they were planned.
            let created = iso_from_millis(now_ms + i64::try_from(index).unwrap_or(0));
            json!({
                "id": weldsuite_kit::generate_id("apr"), "project_id": project_id,
                "subject_type": subject_type, "subject_id": subject_id, "approver_kind": "member",
                "approver_id": p.approver_id, "role_label": p.role_label, "step": p.step,
                "rule": { "code": p.rule_code }, "decision": "pending", "due_at": null,
                "delegated_from": p.delegated_from, "created_by": requested_by,
                "created_at": created, "updated_at": now,
            })
        })
        .collect();
    let mut inserted: Vec<Value> = sqlx::query_scalar(
        "insert into flow_approvals as a (id, project_id, subject_type, subject_id, approver_kind,
             approver_id, role_label, step, rule, decision, due_at, delegated_from, created_by,
             created_at, updated_at)
         select id, project_id, subject_type, subject_id, approver_kind, approver_id, role_label,
             step, rule, decision, due_at, delegated_from, created_by, created_at, updated_at
         from jsonb_populate_recordset(null::flow_approvals, $1)
         returning to_jsonb(a)",
    )
    .bind(Value::Array(values))
    .fetch_all(db)
    .await?;
    inserted = inserted.into_iter().map(js_row).collect();
    inserted.sort_by_key(|row| row.int("step").unwrap_or(0));
    Ok(Requested::Rows(inserted))
}

// ── The `project_close` subject ─────────────────────────────────────────────

/// The sponsor's approval closes the project (`closeProject`): only a project
/// that is not closed yet moves. `// TODO(slice A): register as the
/// project_close handler` of the approvals registry (`onResolved`, outcome
/// approved) when it exists here.
#[allow(dead_code)] // until slice A's registry calls it
pub(crate) async fn close_project(
    db: &PgPool,
    project_id: &str,
    now_ms: i64,
) -> Result<bool, sqlx::Error> {
    let now = iso_from_millis(now_ms);
    let closed: Option<String> = sqlx::query_scalar(
        "update projects
         set status = 'Closed',
             actual_end_date = coalesce(actual_end_date, $2::timestamp),
             updated_at = $2::timestamp
         where id = $1 and deleted_at is null and status <> 'Closed'
         returning id",
    )
    .bind(project_id)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(closed.is_some())
}

/// Publish `project.closed` for a project the sign-off just closed
/// (`publishProjectClosed`).
#[allow(dead_code)] // until slice A's decide route calls it
pub(crate) async fn publish_project_closed(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    let Some(row) = find_live_project(&caller.db, project_id).await? else {
        return Ok(());
    };
    if let Some(fields) = row.as_object() {
        caller.publish(
            state,
            PROJECT_CLOSED,
            project_id,
            &crate::projects::analytics_payload(fields),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(approver: &str, step: i64) -> ApproverInput {
        ApproverInput {
            approver_id: approver.to_owned(),
            role_label: Some("Sponsor".to_owned()),
            step,
            rule_code: "close".to_owned(),
        }
    }

    fn delegation(id: &str, member: &str, delegate: &str, starts: &str, ends: &str) -> Value {
        json!({ "id": id, "memberId": member, "delegateId": delegate,
            "startsAt": starts, "endsAt": ends, "deletedAt": null })
    }

    #[test]
    fn the_sponsor_is_the_sponsor_else_the_manager() {
        assert_eq!(
            sponsor_of(&json!({ "sponsorId": "s" }), Some("m")).as_deref(),
            Some("s")
        );
        assert_eq!(sponsor_of(&json!({}), Some("m")).as_deref(), Some("m"));
        assert_eq!(
            sponsor_of(&json!({ "sponsorId": "" }), Some("m")).as_deref(),
            Some("m")
        );
        assert_eq!(sponsor_of(&Value::Null, None), None);
        assert_eq!(sponsor_of(&json!({}), Some("")), None);
    }

    #[test]
    fn a_member_on_delegation_is_replaced_by_the_delegate() {
        let now = millis_of("2027-02-20T08:00:00.000Z").unwrap_or(0);
        let delegations = [
            delegation(
                "d2",
                "sponsor",
                "second",
                "2027-02-01T00:00:00.000Z",
                "2027-03-01T00:00:00.000Z",
            ),
            delegation(
                "d1",
                "sponsor",
                "first",
                "2027-02-10T00:00:00.000Z",
                "2027-03-01T00:00:00.000Z",
            ),
            delegation(
                "d3",
                "sponsor",
                "later",
                "2027-02-21T00:00:00.000Z",
                "2027-03-01T00:00:00.000Z",
            ),
            delegation(
                "d4",
                "sponsor",
                "ended",
                "2027-01-01T00:00:00.000Z",
                "2027-02-20T08:00:00.000Z",
            ),
        ];
        let planned = plan_approvers(&[input("sponsor", 1)], &delegations, now);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].approver_id, "first");
        assert_eq!(planned[0].delegated_from.as_deref(), Some("sponsor"));
        let none = plan_approvers(&[input("sponsor", 1)], &[], now);
        assert_eq!(none[0].approver_id, "sponsor");
        assert_eq!(none[0].delegated_from, None);
    }

    #[test]
    fn a_person_asked_twice_is_asked_once_in_the_lowest_step() {
        let planned = plan_approvers(&[input("b", 2), input("a", 1), input("b", 1)], &[], 0);
        let order: Vec<(&str, i64)> = planned
            .iter()
            .map(|p| (p.approver_id.as_str(), p.step))
            .collect();
        assert_eq!(order, [("a", 1), ("b", 1)]);
    }

    #[test]
    fn a_request_is_checked_before_it_is_made() {
        assert_eq!(request_error("project_close", &[input("a", 1)]), None);
        assert_eq!(
            request_error("nope", &[input("a", 1)]),
            Some("Unknown approval subject type")
        );
        assert_eq!(
            request_error("project_close", &[]),
            Some("At least one approver is required")
        );
        assert_eq!(
            request_error("project_close", &[input(" ", 1)]),
            Some("Every approver needs a kind and an id")
        );
        assert_eq!(
            request_error("project_close", &[input("a", 0)]),
            Some("A step is a whole number of 1 or more")
        );
    }
}
