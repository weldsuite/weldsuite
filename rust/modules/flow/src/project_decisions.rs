//! `/api/project-decisions` (`routes/project-decisions/index.ts`): the
//! decision log in `project_decisions` (design: weldflow-project-control.md;
//! ADRs FLOW-011 and FLOW-016).
//!
//! ```text
//! GET    /                 list (projectId optional, filters, cursor)
//! GET    /:id              decision, links, approvals, what replaced it and what it replaced
//! POST   /                 create: proposed (with an optional named decider), or recorded as decided
//! PATCH  /:id              edit (while decided, only title, context and consequences)
//! DELETE /:id              soft delete, with the decision's links and open approvals
//! POST   /:id/decide       record the decision: the project manager or the named decider
//! POST   /:id/supersede    a newer decision replaces this one
//! ```
//!
//! A proposed decision with a named decider asks them through `flow_approvals`
//! (subject `decision`, rule `decision`, due `decision_due_at`). The checks run
//! in TypeScript's order: permission, then the decision (404), then project
//! access (403), then the body (400), then the business rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_CONTROL_LINK_DELETED, PROJECT_DECISION_CREATED, PROJECT_DECISION_DECIDED,
    PROJECT_DECISION_DELETED, PROJECT_DECISION_SUPERSEDED, PROJECT_DECISION_UPDATED,
};
use weldsuite_flow_domain::decisions::{
    CreateFields, DecisionOption, decide_input_error, decide_state_error, decision_code,
    decision_create_error, decision_edit_locked_error, decision_event_data, decision_sequence,
    due_millis, may_record_decision, messages, needs_rerouting, normalize_options,
    options_after_decide, options_error, present_decision, present_decision_approval,
    supersede_source_error, supersede_target_error,
};
use weldsuite_flow_domain::js::{contains_pattern, js_date_millis};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::governance_approvals::{
    ApprovalRow, ApprovalRowInput, RequestApprovalsInput, RequestApprovalsResult,
    cancel_pending_approvals, list_subject_approvals, publish_cancelled, publish_requested,
    register_decision_subject, request_approvals,
};
use crate::governance_body::{
    RegisterQuery, decision_list_query, read_create_decision, read_decide, read_supersede,
    read_update_decision,
};
use crate::governance_store::{
    decisions_replaced_by, find_decision, find_decision_ref, insert_statement, update_statement,
};
use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, iso_ms, or_null, parse_limit, to_date};
use crate::raid_body::{Body, parse_body};
use crate::raid_store::{Direction, links_of_object, live_project_exists, present_linked_objects};
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, keyset_cursor, outside, page, paged, reply,
};

const DECISION_LABEL: &str = "Decision";
pub(crate) const PROJECT_MANAGE_DENIED: &str = "You do not have manage access to this project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    register_decision_subject();
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:delete")))
        .route(
            "/{id}/decide",
            post(decide).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/supersede",
            post(supersede).route_layer(need("projects:update")),
        )
        .with_state(state)
}

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// `publishDecision(c, action, row, extra)`.
fn publish_decision(
    state: &FlowState,
    caller: &Caller,
    event: EventName,
    row: &Value,
    extra: Value,
) {
    let mut data = decision_event_data(row);
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra);
    }
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &data);
}

/// `askDecider(c, row, userId)`: the approval rows of a proposed decision (the
/// caller publishes their events).
async fn ask_decider(
    caller: &Caller,
    row: &Value,
    user_id: &str,
) -> Result<Vec<ApprovalRow>, Refusal> {
    let Some(decider_id) = row["deciderId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    if row["status"] != "proposed" {
        return Ok(Vec::new());
    }
    let due_at = due_millis(row["decisionDueAt"].as_str());
    let input = RequestApprovalsInput {
        project_id: row["projectId"].as_str().map(str::to_owned),
        subject_type: "decision".to_owned(),
        subject_id: row["id"].as_str().unwrap_or_default().to_owned(),
        requested_by: user_id.to_owned(),
        rows: vec![
            ApprovalRowInput::member(decider_id, "decision")
                .with_rule("decision", &json!({ "rule": "named_decider" }))
                .with_role_label("Decider")
                .with_step(1)
                .with_due_at(due_at),
        ],
        now_ms: crate::now_ms(),
    };
    match request_approvals(&caller.db, &input).await? {
        RequestApprovalsResult::Requested(rows) => Ok(rows),
        RequestApprovalsResult::Refused { message, .. } => {
            Err(Refusal::Internal(message.to_owned()))
        }
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: the project scope (`$1` the
/// project, else `$2`/`$3` the accessible ones), the status and the search.
macro_rules! decision_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ")",
            " and ($4::text is null or t.status = $4)",
            " and ($5::text is null or t.title ilike $5 or t.context ilike $5)"
        )
    };
}

/// `projectScope(c, projectId)` of the registers.
pub(crate) async fn project_scope(
    caller: &Caller,
    project_id: Option<&str>,
) -> Result<(bool, Vec<String>), Refusal> {
    if let Some(project_id) = project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        return Ok((true, Vec::new()));
    }
    Ok(access_scope(caller).await?)
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match decision_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 25, 100);
    let (all, ids) = match project_scope(&caller, q.project_id.as_deref()).await {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_decisions where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        list_decisions(&caller, &q, limit, (all, &ids), cursor).await,
        "Failed to list decisions",
    )
}

async fn list_decisions(
    caller: &Caller,
    q: &RegisterQuery,
    limit: i64,
    (all, ids): (bool, &[String]),
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let search = q.search.as_deref().map(contains_pattern);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(t) from project_decisions t where ",
        decision_filters!(),
        " and ($6::timestamptz is null or t.created_at < $6::timestamptz",
        " or (t.created_at = $6::timestamptz and t.id < $7))",
        " order by t.created_at desc, t.id desc limit $8"
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.status.as_deref())
    .bind(search.as_deref())
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_decisions t where ",
        decision_filters!()
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.status.as_deref())
    .bind(search.as_deref())
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(weldsuite_db::js_row).collect(), limit);
    let items = rows.iter().map(present_decision).collect();
    Ok(paged(items, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(fetch_detail(&caller, &id).await, "Failed to fetch decision")
}

async fn fetch_detail(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::not_found(DECISION_LABEL, id));
    };
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let link_rows = links_of_object(db, "decision", id).await?;
    let approval_rows = list_subject_approvals(db, "decision", id).await?;
    let superseded_by = find_decision_ref(db, row["supersededById"].as_str()).await?;
    let supersedes = decisions_replaced_by(db, id).await?;
    let links = present_linked_objects(caller, link_rows, |link| {
        if link["fromType"] == "decision" && link["fromId"] == id {
            Direction::Outgoing
        } else {
            Direction::Incoming
        }
    })
    .await?;
    let mut decision = present_decision(&row);
    if let Value::Object(fields) = &mut decision {
        fields.insert("links".to_owned(), Value::Array(links));
        fields.insert(
            "approvals".to_owned(),
            Value::Array(
                approval_rows
                    .iter()
                    .map(|approval| present_decision_approval(&approval.to_json()))
                    .collect(),
            ),
        );
        fields.insert(
            "supersededBy".to_owned(),
            superseded_by.unwrap_or(Value::Null),
        );
        fields.insert("supersedes".to_owned(), Value::Array(supersedes));
    }
    Ok(Data(decision).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// The options of a body as they are stored (`normalizeOptions`).
fn body_options(body: &Body) -> Vec<DecisionOption> {
    let items = body
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    normalize_options(&items)
}

fn options_json(options: &[DecisionOption]) -> Value {
    Value::Array(options.iter().map(DecisionOption::to_json).collect())
}

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_decision)?;
        let project_id = text(&input, "projectId").unwrap_or_default().to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let status = text(&input, "status").unwrap_or("proposed").to_owned();
        let options = body_options(&input);
        let fields = CreateFields {
            decider_id: text(&input, "deciderId"),
            decision_due_at: text(&input, "decisionDueAt"),
            decided_by: text(&input, "decidedBy"),
            decided_at: text(&input, "decidedAt"),
        };
        if let Some(message) = decision_create_error(&status, &options, fields) {
            return Err(Refusal::bad_request(message));
        }
        Ok((project_id, status, options, input))
    }
    .await;
    let (project_id, status, options, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    let id = generate_id("dec");
    let result = create_decision(
        &state,
        &caller,
        &id,
        (&project_id, &status),
        &options,
        &input,
    )
    .await;
    if result.is_err() {
        // The decision is taken back out when asking the decider failed.
        let taken = iso_ms(crate::now_ms());
        if let Err(error) = sqlx::query(
            "update project_decisions set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(taken)
        .execute(&caller.db)
        .await
        {
            tracing::error!(%error, "[flow-api/project-decisions] decision rollback failed");
        }
    }
    reply(result, "Failed to create decision")
}

async fn create_decision(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    (project_id, status): (&str, &str),
    options: &[DecisionOption],
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now = iso_ms(crate::now_ms());
    let number = allocate_number(db, &decision_sequence(project_id)).await?;
    let decided = status == "decided";
    let mut values = Body::new();
    values.insert("id".to_owned(), json!(id));
    values.insert("projectId".to_owned(), json!(project_id));
    values.insert("number".to_owned(), json!(number));
    values.insert("title".to_owned(), or_null(input, "title"));
    values.insert("status".to_owned(), json!(status));
    values.insert("context".to_owned(), or_null(input, "context"));
    values.insert("options".to_owned(), options_json(options));
    values.insert(
        "consequences".to_owned(),
        input
            .get("consequences")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    values.insert(
        "deciderId".to_owned(),
        if decided {
            Value::Null
        } else {
            or_null(input, "deciderId")
        },
    );
    values.insert(
        "decisionDueAt".to_owned(),
        if decided {
            Value::Null
        } else {
            to_date(input.get("decisionDueAt"))
        },
    );
    values.insert(
        "decidedBy".to_owned(),
        if decided {
            match input.get("decidedBy") {
                Some(Value::String(by)) => json!(by),
                _ => json!(caller.user_id),
            }
        } else {
            Value::Null
        },
    );
    values.insert(
        "decidedAt".to_owned(),
        if decided {
            match to_date(input.get("decidedAt")) {
                Value::Null => json!(now),
                at => at,
            }
        } else {
            Value::Null
        },
    );
    values.insert("createdBy".to_owned(), json!(caller.user_id));
    values.insert("createdAt".to_owned(), json!(now));
    values.insert("updatedAt".to_owned(), json!(now));
    weldsuite_db::atomically(db, [insert_statement("project_decisions", &values)]).await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::Internal("the new decision is missing".to_owned()));
    };

    let asked = ask_decider(caller, &row, &caller.user_id).await?;

    publish_decision(state, caller, PROJECT_DECISION_CREATED, &row, json!({}));
    if row["status"] == "decided" {
        publish_decision(state, caller, PROJECT_DECISION_DECIDED, &row, json!({}));
    }
    publish_requested(state, caller, &asked);
    Ok(Created(present_decision(&row)).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_decision(&caller.db, &id).await? else {
            return Err(Refusal::not_found(DECISION_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_write(project).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_update_decision)?;
        let status = existing["status"].as_str().unwrap_or_default();
        if let Some(message) = decision_edit_locked_error(
            status,
            input.contains_key("options"),
            input.contains_key("deciderId"),
            input.contains_key("decisionDueAt"),
        ) {
            return Err(Refusal::conflict(message));
        }
        if input.contains_key("options")
            && let Some(message) = options_error(&body_options(&input))
        {
            return Err(Refusal::bad_request(message));
        }
        Ok((existing, input))
    }
    .await;
    let (existing, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_decision(&state, &caller, &id, &existing, &input).await,
        "Failed to update decision",
    )
}

async fn update_decision(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now = iso_ms(crate::now_ms());
    let mut set = Body::new();
    set.insert("updatedAt".to_owned(), json!(now));
    for key in ["title", "context", "consequences", "deciderId"] {
        if let Some(value) = input.get(key) {
            set.insert(key.to_owned(), value.clone());
        }
    }
    if input.contains_key("options") {
        set.insert("options".to_owned(), options_json(&body_options(input)));
    }
    if input.contains_key("decisionDueAt") {
        set.insert(
            "decisionDueAt".to_owned(),
            to_date(input.get("decisionDueAt")),
        );
    }

    let proposed = existing["status"] == "proposed";
    let existing_approvals = if proposed {
        list_subject_approvals(db, "decision", id).await?
    } else {
        Vec::new()
    };
    let next_decider = if input.contains_key("deciderId") {
        text(input, "deciderId")
    } else {
        existing["deciderId"].as_str()
    };
    let next_due_ms = if input.contains_key("decisionDueAt") {
        text(input, "decisionDueAt").and_then(js_date_millis)
    } else {
        due_millis(existing["decisionDueAt"].as_str())
    };
    let reroute = proposed
        && (input.contains_key("deciderId") || input.contains_key("decisionDueAt"))
        && needs_rerouting(
            existing["deciderId"].as_str(),
            next_decider,
            due_millis(existing["decisionDueAt"].as_str()),
            next_due_ms,
            existing_approvals
                .iter()
                .any(|approval| approval.decision == "rejected"),
        );

    weldsuite_db::atomically(db, [update_statement("project_decisions", &set, id)]).await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::not_found(DECISION_LABEL, id));
    };
    publish_decision(state, caller, PROJECT_DECISION_UPDATED, &row, json!({}));

    if reroute {
        // Asked again from scratch: the decider or the date changed, or the proposal was declined.
        let cleared = cancel_pending_approvals(db, "decision", id, true, crate::now_ms()).await?;
        publish_cancelled(state, caller, &cleared);
        let asked = ask_decider(caller, &row, &caller.user_id).await?;
        publish_requested(state, caller, &asked);
    }
    Ok(Data(present_decision(&row)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_decision(&state, &caller, &id).await,
        "Failed to delete decision",
    )
}

async fn remove_decision(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_decision(db, id).await? else {
        return Err(Refusal::not_found(DECISION_LABEL, id));
    };
    let project = existing["projectId"].as_str().unwrap_or_default();
    if !caller.can_write(project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }

    let links = links_of_object(db, "decision", id).await?;
    let now = iso_ms(crate::now_ms());
    let replaced: Vec<String> = sqlx::query_scalar(
        "select id from project_decisions where superseded_by_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    // The decision's links go with it, and the decisions it replaced take their place again.
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "update project_decisions set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now.clone()),
            sqlx::query(
                "delete from project_control_links
                 where (from_type = 'decision' and from_id = $1)
                    or (to_type = 'decision' and to_id = $1)",
            )
            .bind(id.to_owned()),
            sqlx::query(
                "update project_decisions set status = 'decided', superseded_by_id = null,
                        updated_at = $2::timestamptz
                 where superseded_by_id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now),
        ],
    )
    .await?;
    let number = existing["number"].as_i64().unwrap_or_default();
    caller.publish(
        state,
        PROJECT_DECISION_DELETED,
        id,
        &json!({ "id": id, "projectId": existing["projectId"], "code": decision_code(number) }),
    );
    for link in &links {
        crate::raid::publish_link(state, caller, PROJECT_CONTROL_LINK_DELETED, link);
    }
    let cleared = cancel_pending_approvals(db, "decision", id, true, crate::now_ms()).await?;
    publish_cancelled(state, caller, &cleared);
    for source in &replaced {
        if let Some(reverted) = find_decision(db, source).await? {
            publish_decision(
                state,
                caller,
                PROJECT_DECISION_UPDATED,
                &reverted,
                json!({}),
            );
        }
    }
    Ok(NoContent.into_response())
}

// ── POST /:id/decide ────────────────────────────────────────────────────────

async fn decide(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_decision(&caller.db, &id).await? else {
            return Err(Refusal::not_found(DECISION_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_access(project).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let is_manager = caller.can_manage(project).await?;
        let is_named_decider = existing["deciderId"]
            .as_str()
            .is_some_and(|decider| decider == caller.user_id);
        if !may_record_decision(is_manager, is_named_decider) {
            return Err(Refusal::forbidden(messages::NOT_DECIDER_OR_MANAGER));
        }
        let input = parse_body(&body, read_decide)?;
        if let Some(message) = decide_state_error(existing["status"].as_str().unwrap_or_default()) {
            return Err(Refusal::conflict(message));
        }
        let options = existing
            .get("options")
            .and_then(Value::as_array)
            .map(|items| normalize_options(items))
            .unwrap_or_default();
        let chosen = input
            .get("chosenIndex")
            .and_then(Value::as_i64)
            .and_then(|index| usize::try_from(index).ok());
        if let Some(message) = decide_input_error(&options, chosen) {
            return Err(Refusal::bad_request(message));
        }
        Ok((options, chosen, input))
    }
    .await;
    let (options, chosen, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        record_decision(&state, &caller, &id, &options, chosen, &input).await,
        "Failed to record decision",
    )
}

async fn record_decision(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    options: &[DecisionOption],
    chosen: Option<usize>,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = iso_ms(now_ms);
    let decided_at = match to_date(input.get("decidedAt")) {
        Value::String(at) => at,
        _ => now.clone(),
    };
    sqlx::query(
        "update project_decisions set status = 'decided', options = $2::jsonb,
                decided_by = $3, decided_at = $4::timestamptz, updated_at = $5::timestamptz
         where id = $1 and status = 'proposed' and deleted_at is null",
    )
    .bind(id)
    .bind(options_json(&options_after_decide(options, chosen)))
    .bind(text(input, "decidedBy").unwrap_or(&caller.user_id))
    .bind(decided_at)
    .bind(&now)
    .execute(db)
    .await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::Internal("the decision is missing".to_owned()));
    };

    publish_decision(state, caller, PROJECT_DECISION_DECIDED, &row, json!({}));
    // Nobody is asked about a decision that is taken.
    let cleared = cancel_pending_approvals(db, "decision", id, false, now_ms).await?;
    publish_cancelled(state, caller, &cleared);
    Ok(Data(present_decision(&row)).into_response())
}

// ── POST /:id/supersede ─────────────────────────────────────────────────────

async fn supersede(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_decision(&caller.db, &id).await? else {
            return Err(Refusal::not_found(DECISION_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_access(project).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        if !caller.can_manage(project).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let input = parse_body(&body, read_supersede)?;
        if let Some(message) =
            supersede_source_error(existing["status"].as_str().unwrap_or_default())
        {
            return Err(Refusal::conflict(message));
        }
        let target_id = text(&input, "supersededById")
            .unwrap_or_default()
            .to_owned();
        let Some(target) = find_decision(&caller.db, &target_id).await? else {
            return Err(Refusal::not_found(DECISION_LABEL, &target_id));
        };
        if let Some((status, message)) = supersede_target_error(
            &id,
            project,
            target["id"].as_str().unwrap_or_default(),
            target["projectId"].as_str().unwrap_or_default(),
            target["status"].as_str().unwrap_or_default(),
        ) {
            return Err(if status == 409 {
                Refusal::conflict(message)
            } else {
                Refusal::bad_request(message)
            });
        }
        Ok(target)
    }
    .await;
    let target = match checked {
        Ok(target) => target,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        supersede_decision(&state, &caller, &id, &target).await,
        "Failed to supersede decision",
    )
}

async fn supersede_decision(state: &FlowState, caller: &Caller, id: &str, target: &Value) -> Reply {
    let db = &caller.db;
    let now = iso_ms(crate::now_ms());
    sqlx::query(
        "update project_decisions set status = 'superseded', superseded_by_id = $2,
                updated_at = $3::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(target["id"].as_str().unwrap_or_default())
    .bind(now)
    .execute(db)
    .await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::Internal("the decision is missing".to_owned()));
    };
    let code = decision_code(target["number"].as_i64().unwrap_or_default());
    publish_decision(
        state,
        caller,
        PROJECT_DECISION_SUPERSEDED,
        &row,
        json!({ "supersededByCode": code }),
    );
    Ok(Data(present_decision(&row)).into_response())
}
