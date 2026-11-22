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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
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
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, orm};
use weldsuite_flow_domain::js::{contains_pattern, js_date_millis};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_control_links;
use weldsuite_schema::tenant::project_decisions::{self, Column};

use crate::approvals::announce::announce_approvals_cancelled;
use crate::governance_approvals::{announce_decision_asked, register_decision_subject};
use crate::governance_body::{
    RegisterQuery, decision_list_query, read_create_decision, read_decide, read_supersede,
    read_update_decision,
};
use crate::governance_store::{decisions_replaced_by, find_decision, find_decision_ref};
use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, or_null, parse_limit, to_date};
use crate::raid_body::{Body, parse_body};
use crate::raid_store::{Direction, links_of_object, live_project_exists, present_linked_objects};
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, in_accessible, outside, page, paged, reply,
};
use weldsuite_flow_domain::approvals::{
    ApprovalRow, ApprovalRowInput, RequestApprovalsInput, RequestApprovalsResult,
    cancel_pending_approvals, list_subject_approvals, request_approvals,
};

const DECISION_LABEL: &str = "Decision";
/// `project_decisions`, written from `{ column: value }` objects as Drizzle's
/// `insert(...).values(...)` and `update(...).set(...)` wrote them.
const DECISIONS: JsonTable = JsonTable::of::<project_decisions::Entity>();
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

/// `new Date(millis)`, as the row stores it.
fn instant(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `new Date(millis).toISOString()`, as the row's JSON writes it.
fn iso(millis: i64) -> String {
    weldsuite_events::iso_timestamp(instant(millis))
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

/// The list's `where`, without the cursor: the project scope (the project,
/// else the accessible ones), the status and the search.
fn decision_filters(q: &RegisterQuery, scope: &(bool, Vec<String>)) -> Condition {
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    filters = match q.project_id.as_deref() {
        Some(project_id) => filters.add(Column::ProjectId.eq(project_id)),
        None => filters.add(in_accessible(Column::ProjectId, scope)),
    };
    if let Some(status) = q.status.as_deref() {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(search) = q.search.as_deref() {
        let pattern = contains_pattern(search);
        filters = filters.add(
            Condition::any()
                .add(Column::Title.ilike(pattern.as_str()))
                .add(Column::Context.ilike(pattern.as_str())),
        );
    }
    filters
}

/// The keyset cursor row (`select createdAt, id where id = cursor`):
/// `created_at` as Drizzle reads it back (milliseconds), and the id.
async fn decision_cursor(
    db: &DatabaseConnection,
    cursor: &str,
) -> Result<Option<(OffsetDateTime, String)>, DbErr> {
    let created: Option<OffsetDateTime> = project_decisions::Entity::find_by_id(cursor)
        .select_only()
        .column(Column::CreatedAt)
        .into_tuple()
        .one(db)
        .await?;
    Ok(created.map(|at| {
        let at = at.replace_millisecond(at.millisecond()).unwrap_or(at);
        (at, cursor.to_owned())
    }))
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
    let scope = match project_scope(&caller, q.project_id.as_deref()).await {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match decision_cursor(&orm(&caller.db), cursor).await {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        list_decisions(&caller, &q, limit, &scope, cursor).await,
        "Failed to list decisions",
    )
}

async fn list_decisions(
    caller: &Caller,
    q: &RegisterQuery,
    limit: i64,
    scope: &(bool, Vec<String>),
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    let db = &orm(&caller.db);
    let filters = decision_filters(q, scope);
    let mut select = project_decisions::Entity::find().filter(filters.clone());
    if let Some((at, id)) = cursor {
        select = select.filter(
            Condition::any().add(Column::CreatedAt.lt(at)).add(
                Condition::all()
                    .add(Column::CreatedAt.eq(at))
                    .add(Column::Id.lt(id)),
            ),
        );
    }
    let rows = select
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(db)
        .await?;
    let total = project_decisions::Entity::find()
        .filter(filters)
        .count(db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(|model| serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let (rows, has_more, next) = page(rows, limit);
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
        let taken = instant(crate::now_ms());
        if let Err(error) = project_decisions::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(taken))
            .col_expr(Column::UpdatedAt, Expr::value(taken))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
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
    let now = iso(crate::now_ms());
    let number = allocate_number(db, &decision_sequence(project_id)).await?;
    let decided = status == "decided";
    // `{ column: value }`, each converted to its column's type by Postgres.
    let mut values = Map::new();
    values.insert("id".to_owned(), json!(id));
    values.insert("project_id".to_owned(), json!(project_id));
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
        "decider_id".to_owned(),
        if decided {
            Value::Null
        } else {
            or_null(input, "deciderId")
        },
    );
    values.insert(
        "decision_due_at".to_owned(),
        if decided {
            Value::Null
        } else {
            to_date(input.get("decisionDueAt"))
        },
    );
    values.insert(
        "decided_by".to_owned(),
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
        "decided_at".to_owned(),
        if decided {
            match to_date(input.get("decidedAt")) {
                Value::Null => json!(now),
                at => at,
            }
        } else {
            Value::Null
        },
    );
    values.insert("created_by".to_owned(), json!(caller.user_id));
    values.insert("created_at".to_owned(), json!(now));
    values.insert("updated_at".to_owned(), json!(now));
    DECISIONS.insert(&orm(db), values).await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::Internal("the new decision is missing".to_owned()));
    };

    let asked = ask_decider(caller, &row, &caller.user_id).await?;

    publish_decision(state, caller, PROJECT_DECISION_CREATED, &row, json!({}));
    if row["status"] == "decided" {
        publish_decision(state, caller, PROJECT_DECISION_DECIDED, &row, json!({}));
    }
    announce_decision_asked(state, caller, &row, &asked).await?;
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
    let now = iso(crate::now_ms());
    // `{ column: value }` of the fields sent, each converted to its column's
    // type by Postgres.
    let mut set = Map::new();
    set.insert("updated_at".to_owned(), json!(now));
    for (key, column) in [
        ("title", "title"),
        ("context", "context"),
        ("consequences", "consequences"),
        ("deciderId", "decider_id"),
    ] {
        if let Some(value) = input.get(key) {
            set.insert(column.to_owned(), value.clone());
        }
    }
    if input.contains_key("options") {
        set.insert("options".to_owned(), options_json(&body_options(input)));
    }
    if input.contains_key("decisionDueAt") {
        set.insert(
            "decision_due_at".to_owned(),
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

    DECISIONS.update(&orm(db), id, set, true).await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::not_found(DECISION_LABEL, id));
    };
    publish_decision(state, caller, PROJECT_DECISION_UPDATED, &row, json!({}));

    if reroute {
        // Asked again from scratch: the decider or the date changed, or the proposal was declined.
        let cleared = cancel_pending_approvals(db, "decision", id, true, crate::now_ms()).await?;
        announce_approvals_cancelled(state, caller, &cleared);
        let asked = ask_decider(caller, &row, &caller.user_id).await?;
        announce_decision_asked(state, caller, &row, &asked).await?;
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
    let now = instant(crate::now_ms());
    let replaced: Vec<String> = project_decisions::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::SupersededById.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    // The decision's links go with it, and the decisions it replaced take their place again.
    let id_owned = id.to_owned();
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            let id = id_owned.as_str();
            project_decisions::Entity::update_many()
                .col_expr(Column::DeletedAt, Expr::value(now))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            delete_links(&tx, "decision", id).await?;
            project_decisions::Entity::update_many()
                .col_expr(Column::Status, Expr::value("decided"))
                .col_expr(Column::SupersededById, Expr::value(Option::<String>::None))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::SupersededById.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
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
    announce_approvals_cancelled(state, caller, &cleared);
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

/// `delete from project_control_links where (from_type = kind and from_id =
/// id) or (to_type = kind and to_id = id)`: the links of a deleted object.
pub(crate) async fn delete_links(tx: &OrmConn<'_>, kind: &str, id: &str) -> Result<(), DbErr> {
    use project_control_links::Column as Link;
    project_control_links::Entity::delete_many()
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(Link::FromType.eq(kind))
                        .add(Link::FromId.eq(id)),
                )
                .add(
                    Condition::all()
                        .add(Link::ToType.eq(kind))
                        .add(Link::ToId.eq(id)),
                ),
        )
        .exec(tx)
        .await?;
    Ok(())
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
    let now = instant(now_ms);
    // `toDate(decidedAt) ?? now`: the body's moment as `new Date()` reads it.
    let decided_at = match input.get("decidedAt") {
        Some(Value::String(raw)) if !raw.is_empty() => js_date_millis(raw)
            .map(instant)
            .ok_or_else(|| Refusal::Internal(format!("invalid decidedAt: {raw}")))?,
        _ => now,
    };
    project_decisions::Entity::update_many()
        .col_expr(Column::Status, Expr::value("decided"))
        .col_expr(
            Column::Options,
            Expr::value(options_json(&options_after_decide(options, chosen))),
        )
        .col_expr(
            Column::DecidedBy,
            Expr::value(text(input, "decidedBy").unwrap_or(&caller.user_id)),
        )
        .col_expr(Column::DecidedAt, Expr::value(decided_at))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::Status.eq("proposed"))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    let Some(row) = find_decision(db, id).await? else {
        return Err(Refusal::Internal("the decision is missing".to_owned()));
    };

    publish_decision(state, caller, PROJECT_DECISION_DECIDED, &row, json!({}));
    // Nobody is asked about a decision that is taken.
    let cleared = cancel_pending_approvals(db, "decision", id, false, now_ms).await?;
    announce_approvals_cancelled(state, caller, &cleared);
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
    let now = instant(crate::now_ms());
    project_decisions::Entity::update_many()
        .col_expr(Column::Status, Expr::value("superseded"))
        .col_expr(
            Column::SupersededById,
            Expr::value(target["id"].as_str().unwrap_or_default()),
        )
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
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
