//! Project intake queries (`services/project-requests.ts`): the rows of
//! requests, approvals and the workspace settings as Drizzle reads them, the
//! approval outcome of a request, and a thin local adapter over the approvals
//! core for asking the portfolio board.
//!
//! TODO(slice A): the approvals core is ported to Rust by slice A
//! (`rust/crates/flow-domain/src/approvals.rs`). [`request_approvals`] mirrors
//! exactly the TypeScript `requestApprovals` this route calls (one row per
//! approver, a member on delegation replaced by their delegate, each person
//! asked once, one insert), and [`settle_project_request`] is the handler the
//! `project_request` subject registers there: use `approvals.rs` and drop both
//! here.

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::intake::{Criterion, default_scoring_model, model_from_json};
use weldsuite_kit::generate_id;

/// A `project_requests` row.
macro_rules! request_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('estimated_cost', ",
            $a,
            ".estimated_cost::text, 'estimated_value', ",
            $a,
            ".estimated_value::text, 'score', ",
            $a,
            ".score::text))"
        )
    };
}

/// A `flow_workspace_settings` row.
macro_rules! settings_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('expense_approval_limit', ",
            $a,
            ".expense_approval_limit::text))"
        )
    };
}

pub(crate) use request_json;

/// `findProjectRequest(db, id)`: a live request.
pub(crate) async fn find_project_request(
    db: &PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        request_json!("t"),
        " from project_requests t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `loadSettings(db)`: the workspace's intake settings, or `None` before it saves any.
pub(crate) async fn load_settings(db: &PgPool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        settings_json!("s"),
        " from flow_workspace_settings s limit 1"
    ))
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `modelOf(settings)`: the scoring model in force, the workspace's or the default one.
pub(crate) fn model_of(settings: Option<&Value>) -> Vec<Criterion> {
    match settings {
        Some(row) => model_from_json(row.get("scoringModel")),
        None => default_scoring_model(),
    }
}

/// `boardOf(settings)`: the portfolio board, the members who approve a request.
pub(crate) fn board_of(settings: Option<&Value>) -> Vec<String> {
    settings
        .and_then(|row| row.get("portfolioBoardIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// A subject's live approval rows, in step order (`listSubjectApprovals`).
pub(crate) async fn list_subject_approvals(
    db: &PgPool,
    subject_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.subject_type = 'project_request' and a.subject_id = $1 and a.deleted_at is null
         order by a.step, a.created_at, a.id",
    )
    .bind(subject_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `settleProjectRequest(db, requestId, outcome, now)`: settle a request under
/// assessment as the board decided. Only an assessing request moves, so
/// running it again changes nothing.
#[allow(dead_code)]
pub(crate) async fn settle_project_request(
    db: &PgPool,
    request_id: &str,
    outcome: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update project_requests set status = $2, updated_at = $3::timestamptz
         where id = $1 and status = 'assessing' and deleted_at is null",
    )
    .bind(request_id)
    .bind(outcome)
    .bind(crate::capacity::iso_now())
    .execute(db)
    .await?;
    Ok(())
}

/// One approver as asked: the member on the board, or their delegate.
struct Planned {
    approver_id: String,
    delegated_from: Option<String>,
}

/// `requestApprovals(db, ...)` for a project request: one row per board
/// member in one batch (step 1, rule `project_request`, no due date). A member
/// on delegation is replaced by their delegate (the row keeps `delegated_from`),
/// and a person asked twice is asked once. Refuses a request that already has
/// live rows. Returns the rows in the order they were planned.
pub(crate) async fn request_approvals(
    db: &PgPool,
    subject_id: &str,
    requested_by: &str,
    board: &[String],
    now_ms: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    if !list_subject_approvals(db, subject_id).await?.is_empty() {
        return Err(sqlx::Error::Protocol(
            "Approvals have already been requested for this subject".to_owned(),
        ));
    }
    let now = weldsuite_flow_domain::js::iso_from_millis(now_ms).unwrap_or_default();
    // The delegation in force for each member: the one that started last, then the lowest id.
    let delegations: Vec<(String, String)> = sqlx::query_as(
        "select distinct on (member_id) member_id, delegate_id from flow_approval_delegations
         where member_id = any($1) and deleted_at is null
           and starts_at <= $2::timestamptz and ends_at > $2::timestamptz
         order by member_id, starts_at desc, id asc",
    )
    .bind(board)
    .bind(&now)
    .fetch_all(db)
    .await?;
    let mut planned: Vec<Planned> = Vec::new();
    for member in board {
        let approver = member.trim();
        let (approver_id, delegated_from) = match delegations.iter().find(|(id, _)| id == approver)
        {
            Some((_, delegate)) => (delegate.clone(), Some(approver.to_owned())),
            None => (approver.to_owned(), None),
        };
        if !planned.iter().any(|p| p.approver_id == approver_id) {
            planned.push(Planned {
                approver_id,
                delegated_from,
            });
        }
    }
    let mut statements = Vec::with_capacity(planned.len());
    for (index, person) in planned.iter().enumerate() {
        // One millisecond apart, so a subject's rows list in the order they were planned.
        let created =
            weldsuite_flow_domain::js::iso_from_millis(now_ms + i64::try_from(index).unwrap_or(0))
                .unwrap_or_default();
        statements.push(
            sqlx::query(
                "insert into flow_approvals (id, project_id, subject_type, subject_id, approver_kind,
                     approver_id, role_label, step, rule, decision, due_at, delegated_from,
                     created_by, created_at, updated_at)
                 values ($1, null, 'project_request', $2, 'member', $3, 'Portfolio board', 1, $4::jsonb,
                     'pending', null, $5, $6, $7::timestamptz, $8::timestamptz)",
            )
            .bind(generate_id("apr"))
            .bind(subject_id.to_owned())
            .bind(person.approver_id.clone())
            .bind(json!({ "code": "project_request" }))
            .bind(person.delegated_from.clone())
            .bind(requested_by.to_owned())
            .bind(created)
            .bind(now.clone()),
        );
    }
    weldsuite_db::atomically(db, statements).await?;
    list_subject_approvals(db, subject_id).await
}

/// `cancelPendingApprovals(db, { includeDecided: true })`: clear every live
/// row of a subject (soft delete).
pub(crate) async fn clear_approvals(db: &PgPool, subject_id: &str) -> Result<(), sqlx::Error> {
    let now = crate::capacity::iso_now();
    sqlx::query(
        "update flow_approvals set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
         where subject_type = 'project_request' and subject_id = $1 and deleted_at is null",
    )
    .bind(subject_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
