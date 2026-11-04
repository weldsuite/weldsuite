//! `/api/approvals` (`routes/approvals/index.ts`, FLOW-016): My reviews, the
//! sidebar count, Sent by me, Done, answering a review, delegation and the
//! project sponsor.
//!
//! ```text
//! GET    /mine                          open reviews in groups (overdue, this week, later), type filter
//! GET    /mine/count                    the sidebar badge (one indexed count)
//! GET    /sent                          subjects the caller asked approval for that still wait
//! GET    /done                          reviews the caller answered
//! POST   /{id}/decide                   approve, approve with conditions, decline, ask for information
//! GET    /delegations                   delegations that have not ended, given and received
//! POST   /delegations                   hand the caller's reviews to a member for a period
//! DELETE /delegations/{id}              end a delegation of the caller's
//! PUT    /projects/{projectId}/sponsor  set or clear the sponsor (settings.sponsorId)
//! ```
//!
//! Answering is a right of the row (the named approver or their active
//! delegate), never of a workspace permission: every route needs
//! `projects:read`, the sponsor route `projects:update` and `canManageProject`.
//!
//! # For the slices that own an approval subject
//!
//! * Register the subject's handler with
//!   `weldsuite_flow_domain::approvals::register_approval_subject` from your
//!   module's `router()` constructor (see `project_changes::subject`).
//! * After `request_approvals` call `announce::announce_approvals_requested`
//!   with the rows: it publishes `flow_approval.requested`, notifies the
//!   approvers who can answer now and marks the `approval_due` index. After
//!   `cancel_pending_approvals` call `announce::announce_approvals_cancelled`.
//! * The handler's `on_resolved` has no request: to publish your own entity
//!   events when `/decide` settles the subject, register an aftermath hook
//!   with `announce::register_aftermath` (`for<'a> fn(&FlowState, &Caller,
//!   &AftermathInfo) -> Pin<Box<dyn Future<Output = Result<(), sqlx::Error>>>>`).
//! * `store::load_subject_info` shows a subject in My reviews; the seven
//!   subject types are already covered.
//!
//! Registering from `router()` means any process that serves `/decide` can
//! settle every subject of the slice.

pub(crate) mod announce;
mod body;
pub(crate) mod store;
pub mod sweep;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{FLOW_APPROVAL_DELEGATED, PROJECT_UPDATED};
use weldsuite_db::js_row;
use weldsuite_flow_domain::approval_views::{
    SPONSOR_NOT_MEMBER, TIMESHEET_NO_PERMISSION, TIMESHEET_ONLY_APPROVE_OR_DECLINE,
    delegation_event_data, delegation_input_error, present_delegation, present_review_approver,
};
use weldsuite_flow_domain::approvals::{
    ApprovalActor, ApprovalOutcome, ApprovalRow, DecideApprovalInput, DecideApprovalResult,
    DecideRefusal, DelegationRow, ResolvedApprovalOutcome, decide_approval, decision_input_error,
    list_subject_approvals,
};
use weldsuite_flow_domain::js::{js_date_millis, parse_int};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::announce::{
    AftermathInfo, ApprovalAction, SubjectLabel, announce_approvals_cancelled,
    announce_steps_activated, publish_approval, run_aftermath,
};
use self::body::{page_query, read_decide, read_delegation, read_sponsor};
use self::store::{ListFilters, MineOptions};
use crate::raid_body::parse_body;
use crate::time_entries::{apply_review, find_entry, review_denial};
use crate::{Caller, FlowState, Refusal, Reply, now_ms, outside, paged, reply};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_EDIT_DENIED: &str =
    "You must be a project owner, admin, or manager to edit this project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    crate::project_changes::register_subject();
    crate::raid::register_subject();
    // Every subject of the slice, so any process that serves `/decide` can settle it.
    crate::governance_approvals::register_decision_subject();
    crate::governance_approvals::register_deliverable_subject();
    crate::project_phases::register_subject();
    crate::project_close::register_subject();
    crate::project_requests::register_subject();
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/mine", get(mine).route_layer(need("projects:read")))
        .route("/mine/count", get(count).route_layer(need("projects:read")))
        .route("/sent", get(sent).route_layer(need("projects:read")))
        .route("/done", get(done).route_layer(need("projects:read")))
        .route(
            "/delegations",
            get(delegations).route_layer(need("projects:read")),
        )
        .route(
            "/delegations",
            post(create_delegation).route_layer(need("projects:read")),
        )
        .route(
            "/delegations/{id}",
            delete(end_delegation).route_layer(need("projects:read")),
        )
        .route(
            "/projects/{project_id}/sponsor",
            put(set_sponsor).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/decide",
            post(decide).route_layer(need("projects:read")),
        )
        .with_state(state)
}

/// `parseLimit(raw, 25, 100)`.
fn parse_limit(raw: Option<&str>) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(100),
        _ => 25,
    }
}

// ── My reviews ──────────────────────────────────────────────────────────────

async fn mine(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (review_type, project_id) = match body::mine_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let accessible = caller.accessible_project_ids().await?;
            let options = MineOptions {
                user_id: &caller.user_id,
                accessible_project_ids: accessible.as_deref(),
                scope_all: caller.can("projects:scope:all"),
                can_review_time: caller.can("time:update"),
                review_type: review_type.as_deref(),
                project_id: project_id.as_deref(),
                now: now_ms(),
            };
            Ok(Data(store::load_my_reviews(&caller.db, &options).await?).into_response())
        }
        .await,
        "Failed to load your reviews",
    )
}

async fn count(caller: Caller) -> Response {
    reply(
        async {
            let accessible = caller.accessible_project_ids().await?;
            let value = store::count_my_reviews(
                &caller.db,
                &caller.user_id,
                accessible.as_deref(),
                caller.can("projects:scope:all"),
                caller.can("time:update"),
                now_ms(),
            )
            .await?;
            Ok(Data(value).into_response())
        }
        .await,
        "Failed to count your reviews",
    )
}

async fn sent(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match page_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let accessible = caller.accessible_project_ids().await?;
            let filters = ListFilters {
                review_type: q.review_type.as_deref(),
                project_id: q.project_id.as_deref(),
                cursor: q.cursor.as_deref(),
                limit: parse_limit(q.limit.as_deref()),
                accessible_project_ids: accessible.as_deref(),
            };
            let (items, has_more, next, total) =
                store::load_sent_reviews(&caller.db, &caller.user_id, &filters).await?;
            Ok(paged(items, total, has_more, next))
        }
        .await,
        "Failed to load the reviews you sent",
    )
}

async fn done(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match page_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let accessible = caller.accessible_project_ids().await?;
            let filters = ListFilters {
                review_type: q.review_type.as_deref(),
                project_id: q.project_id.as_deref(),
                cursor: q.cursor.as_deref(),
                limit: parse_limit(q.limit.as_deref()),
                accessible_project_ids: accessible.as_deref(),
            };
            let (items, has_more, next, total) =
                store::load_done_reviews(&caller.db, &caller.user_id, &filters, now_ms()).await?;
            Ok(paged(items, total, has_more, next))
        }
        .await,
        "Failed to load the reviews you answered",
    )
}

// ── Delegations ─────────────────────────────────────────────────────────────

fn delegation_rows(values: Vec<Value>) -> Vec<DelegationRow> {
    values
        .into_iter()
        .filter_map(|v| DelegationRow::from_json(&js_row(v)))
        .collect()
}

fn iso(ms: i64) -> String {
    weldsuite_flow_domain::js::iso_from_millis(ms).unwrap_or_default()
}

async fn delegations(caller: Caller) -> Response {
    reply(
        async {
            let now = iso(now_ms());
            let mut lists = Vec::new();
            for column in ["member_id", "delegate_id"] {
                let sql = format!(
                    "select to_jsonb(d) from flow_approval_delegations d where d.{column} = $1
                     and d.deleted_at is null and d.ends_at > $2::timestamptz
                     order by d.starts_at asc, d.id asc"
                );
                let found: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                    .bind(&caller.user_id)
                    .bind(&now)
                    .fetch_all(&caller.db)
                    .await?;
                lists.push(delegation_rows(found));
            }
            Ok(Data(json!({
                "given": lists[0].iter().map(present_delegation).collect::<Vec<_>>(),
                "received": lists[1].iter().map(present_delegation).collect::<Vec<_>>(),
            }))
            .into_response())
        }
        .await,
        "Failed to load delegations",
    )
}

async fn create_delegation(
    State(state): State<FlowState>,
    caller: Caller,
    body: Bytes,
) -> Response {
    let input = match parse_body(&body, read_delegation) {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let (delegate, starts, ends) = (text("delegateId"), text("startsAt"), text("endsAt"));
    let (Some(starts_ms), Some(ends_ms)) = (js_date_millis(&starts), js_date_millis(&ends)) else {
        return outside(Err(Refusal::bad_request("Invalid request body")));
    };
    let now = now_ms();
    if let Some(message) =
        delegation_input_error(&caller.user_id, &delegate, starts_ms, ends_ms, now)
    {
        return outside(Err(Refusal::bad_request(message)));
    }
    reply(
        async {
            let row: Option<Value> = sqlx::query_scalar(
                "insert into flow_approval_delegations (id, member_id, delegate_id, starts_at, ends_at,
                     created_by, created_at, updated_at)
                 values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $2, $6::timestamptz, $6::timestamptz)
                 returning to_jsonb(flow_approval_delegations.*)",
            )
            .bind(generate_id("apd"))
            .bind(&caller.user_id)
            .bind(&delegate)
            .bind(iso(starts_ms))
            .bind(iso(ends_ms))
            .bind(iso(now))
            .fetch_optional(&caller.db)
            .await?;
            let Some(row) = row.and_then(|v| DelegationRow::from_json(&js_row(v))) else {
                return Err(Refusal::Internal("the delegation is missing".to_owned()));
            };
            caller.publish(&state, FLOW_APPROVAL_DELEGATED, &row.id, &delegation_event_data(&row, false));
            Ok(Created(present_delegation(&row)).into_response())
        }
        .await,
        "Failed to create the delegation",
    )
}

async fn end_delegation(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let found: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(d) from flow_approval_delegations d
                 where d.id = $1 and d.member_id = $2 and d.deleted_at is null limit 1",
            )
            .bind(&id)
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(row) = found.and_then(|v| DelegationRow::from_json(&js_row(v))) else {
                return Err(Refusal::not_found("Delegation", &id));
            };
            sqlx::query(
                "update flow_approval_delegations set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(iso(now_ms()))
            .execute(&caller.db)
            .await?;
            caller.publish(&state, FLOW_APPROVAL_DELEGATED, &id, &delegation_event_data(&row, true));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to end the delegation",
    )
}

// ── Sponsor ─────────────────────────────────────────────────────────────────

/// `findLiveProject(db, projectId)`: the project as `js_row` reads it.
pub(crate) async fn find_live_project(
    db: &sqlx::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!("p"),
        " from projects p where p.id = $1 and p.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `projectMemberIds(db, projectId, managerId)`: the manager and the active members.
pub(crate) async fn project_member_ids(
    db: &sqlx::PgPool,
    project_id: &str,
    manager: Option<&str>,
) -> Result<std::collections::HashSet<String>, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select user_id from project_members where project_id = $1 and is_active = true and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let mut set: std::collections::HashSet<String> = ids.into_iter().collect();
    if let Some(manager) = manager.filter(|m| !m.is_empty()) {
        set.insert(manager.to_owned());
    }
    Ok(set)
}

/// Publish `project.updated` for a project's current row.
pub(crate) async fn publish_project_updated(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    if let Some(Value::Object(fields)) = find_live_project(&caller.db, project_id).await? {
        caller.publish(
            state,
            PROJECT_UPDATED,
            project_id,
            &crate::projects::analytics_payload(&fields),
        );
    }
    Ok(())
}

async fn set_sponsor(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_EDIT_DENIED));
        }
        let input = parse_body(&body, read_sponsor)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let sponsor = input.get("sponsorId").and_then(Value::as_str).map(str::to_owned);
            if let Some(id) = &sponsor {
                let members =
                    project_member_ids(&caller.db, &project_id, project["projectManagerId"].as_str())
                        .await?;
                if !members.contains(id) {
                    return Err(Refusal::bad_request(SPONSOR_NOT_MEMBER));
                }
            }
            sqlx::query(
                "update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('sponsorId', $2::text),
                     updated_at = $3::timestamp where id = $1 and deleted_at is null",
            )
            .bind(&project_id)
            .bind(&sponsor)
            .bind(crate::now())
            .execute(&caller.db)
            .await?;
            publish_project_updated(&state, &caller, &project_id).await?;
            Ok(Data(json!({"projectId": project_id, "sponsorId": sponsor})).into_response())
        }
        .await,
        "Failed to set the sponsor",
    )
}

// ── Answer a review ─────────────────────────────────────────────────────────

async fn decide(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input = match parse_body(&body, read_decide) {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    let decision = input
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
    reply(
        decide_review(&state, &caller, &id, &decision, note).await,
        "Failed to answer the review",
    )
}

#[allow(clippy::too_many_lines)]
async fn decide_review(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    decision: &str,
    note: Option<String>,
) -> Reply {
    let db = &caller.db;
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a where a.id = $1 and a.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = found.and_then(|v| ApprovalRow::from_json(&js_row(v))) else {
        return decide_time_entry(state, caller, id, decision, note.as_deref()).await;
    };

    // Project membership is the row boundary (FLOW-001): a row without a project
    // (a project request) keeps its own rules.
    if let Some(project_id) = row.project_id.as_deref().filter(|p| !p.is_empty())
        && !caller.can_access(project_id).await?
    {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }

    let result = decide_and_announce(
        state,
        caller,
        &row,
        ApprovalActor::member(caller.user_id.clone()),
        decision,
        note,
    )
    .await?;
    let decided = match result {
        DecideApprovalResult::Decided(decided) => decided,
        DecideApprovalResult::Refused { code, message } => {
            return Err(match code {
                DecideRefusal::NotFound => Refusal::not_found("Approval", id),
                DecideRefusal::NotApprover => Refusal::forbidden(message),
                DecideRefusal::AlreadyDecided | DecideRefusal::StepNotActive => {
                    Refusal::conflict(message)
                }
                DecideRefusal::InvalidDecision | DecideRefusal::NoteRequired => {
                    Refusal::bad_request(message)
                }
            });
        }
    };

    let mut approval = present_review_approver(&decided.approval);
    if let Value::Object(map) = &mut approval {
        map.insert("subjectType".to_owned(), json!(row.subject_type));
        map.insert("subjectId".to_owned(), json!(row.subject_id));
        map.insert("projectId".to_owned(), json!(row.project_id));
    }
    Ok(Data(json!({
        "approval": approval,
        "outcome": decided.outcome.as_str(),
        "resolved": decided.resolved,
        "viaDelegation": decided.via_delegation,
    }))
    .into_response())
}

/// `decideAndAnnounce(c, row, { actor, decision, note })`: answer a review and
/// announce it. The one path behind `POST /api/approvals/{id}/decide` and the
/// client portal's decide. Runs `decide_approval`, publishes
/// `flow_approval.decided`, clears the rows a rejection leaves open
/// (`cancelled`), then runs the subject's aftermath (the answer settled it) or
/// tells the approvers whose step came up. A refusal is returned untouched.
pub(crate) async fn decide_and_announce(
    state: &FlowState,
    caller: &Caller,
    row: &ApprovalRow,
    actor: ApprovalActor,
    decision: &str,
    note: Option<String>,
) -> Result<DecideApprovalResult, sqlx::Error> {
    let db = &caller.db;
    let before = list_subject_approvals(db, &row.subject_type, &row.subject_id).await?;
    let result = decide_approval(
        db,
        &DecideApprovalInput {
            approval_id: row.id.clone(),
            actor: actor.clone(),
            decision: decision.to_owned(),
            note,
            now_ms: now_ms(),
        },
    )
    .await?;
    let DecideApprovalResult::Decided(decided) = &result else {
        return Ok(result);
    };

    publish_approval(
        state,
        caller,
        ApprovalAction::Decided,
        &decided.approval,
        &json!({
            "outcome": decided.outcome.as_str(),
            "resolved": decided.resolved,
            "viaDelegation": decided.via_delegation,
        }),
    );
    // A rejection clears the other open rows: nobody is asked about a settled subject.
    let cleared: Vec<ApprovalRow> = before
        .iter()
        .filter(|b| !decided.rows.iter().any(|r| r.id == b.id))
        .cloned()
        .collect();
    announce_approvals_cancelled(state, caller, &cleared);

    if decided.resolved {
        let resolved = if decided.outcome == ApprovalOutcome::Approved {
            ResolvedApprovalOutcome::Approved
        } else {
            ResolvedApprovalOutcome::Rejected
        };
        run_aftermath(
            state,
            caller,
            &row.subject_type,
            &AftermathInfo {
                subject_id: row.subject_id.clone(),
                project_id: row.project_id.clone(),
                outcome: resolved,
                rows: decided.rows.clone(),
                decided: decided.approval.clone(),
                actor,
            },
        )
        .await;
    } else if decision == "approved" || decision == "approved_with_conditions" {
        // The next step's approvers are told when their turn comes.
        let info = store::load_subject_info(db, std::slice::from_ref(row)).await?;
        let subject = info.get(&format!("{}:{}", row.subject_type, row.subject_id));
        let updated: Vec<ApprovalRow> = before
            .iter()
            .map(|b| {
                if b.id == decided.approval.id {
                    decided.approval.clone()
                } else {
                    b.clone()
                }
            })
            .collect();
        announce_steps_activated(
            state,
            caller,
            &updated,
            &decided.rows,
            &SubjectLabel {
                code: subject.and_then(|s| s.code.clone()),
                title: subject.map_or_else(|| row.subject_id.clone(), |s| s.title.clone()),
            },
            None,
        );
    }
    Ok(result)
}

/// A pending time entry answered from My reviews, with the rules and events
/// of `PATCH /api/time-entries/:id/approve` and `/reject`.
async fn decide_time_entry(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    decision: &str,
    note: Option<&str>,
) -> Reply {
    let Some(entry) = find_entry(&caller.db, id).await? else {
        return Err(Refusal::not_found("Approval", id));
    };
    if !caller.can("time:update") {
        return Err(Refusal::forbidden(TIMESHEET_NO_PERMISSION));
    }
    if let Some(denial) = review_denial(caller, &entry).await? {
        return Err(Refusal::forbidden(denial));
    }
    if decision != "approved" && decision != "rejected" {
        return Err(Refusal::bad_request(TIMESHEET_ONLY_APPROVE_OR_DECLINE));
    }
    if let Some(invalid) = decision_input_error(decision, note) {
        return Err(Refusal::bad_request(invalid));
    }
    if entry["status"] == "approved" || entry["status"] == "rejected" {
        return Err(Refusal::conflict("This review has already been answered"));
    }
    apply_review(state, caller, id, &entry, decision == "approved").await?;
    let trimmed = note.map(str::trim).filter(|n| !n.is_empty());
    Ok(Data(json!({
        "approval": {
            "approvalId": id,
            "approverKind": "member",
            "approverId": caller.user_id,
            "roleLabel": null,
            "step": 1,
            "decision": decision,
            "note": trimmed,
            "decidedAt": iso(now_ms()),
            "delegatedFrom": null,
            "subjectType": "timesheet",
            "subjectId": id,
            "projectId": entry["projectId"],
        },
        "outcome": decision,
        "resolved": true,
        "viaDelegation": false,
    }))
    .into_response())
}
