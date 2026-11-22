//! `/api/project-deliverables` (`routes/project-deliverables/index.ts`): the
//! deliverables of a project in `project_deliverables` (design:
//! weldflow-project-control.md; ADRs FLOW-011 and FLOW-016).
//!
//! ```text
//! GET    /                    list in position order (projectId optional, filters, cursor)
//! GET    /:id                 deliverable, links and its sign-off
//! POST   /                    create (code D<n>, acceptance criteria)
//! PATCH  /:id                 edit (once accepted, only visibility and position)
//! DELETE /:id                 soft delete, with its links and open sign-off; its tasks lose the deliverable
//! POST   /:id/request-signoff ask the sponsor and then, optionally, a client contact
//! POST   /:id/accept          the project manager accepts directly
//! POST   /:id/reject          the project manager rejects
//! ```
//!
//! Tasks count toward a deliverable through `tasks.deliverable_id`; its
//! progress is computed from them on read. A full sign-off accepts the
//! deliverable, one rejection rejects it. The checks run in TypeScript's
//! order: permission, then the deliverable (404), then project access (403),
//! then the body (400), then the business rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_CONTROL_LINK_DELETED, PROJECT_DELIVERABLE_ACCEPTED,
    PROJECT_DELIVERABLE_CREATED, PROJECT_DELIVERABLE_DELETED, PROJECT_DELIVERABLE_UPDATED,
};
use weldsuite_db::{OrmConn, orm};
use weldsuite_flow_domain::deliverables::{
    accept_error, accepted_edit_error, apply_criteria, deliverable_code, deliverable_dates_error,
    deliverable_event_data, deliverable_sequence, messages, present_deliverable,
    present_signoff_approval, reject_error, signoff_is_open,
};
use weldsuite_flow_domain::js::{contains_pattern, js_date_millis};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_deliverables::{self, Column};
use weldsuite_schema::tenant::{projects, tasks};

use crate::approvals::announce::announce_approvals_cancelled;
use crate::governance_approvals::{announce_deliverable_asked, register_deliverable_subject};
use crate::governance_body::{
    RegisterQuery, deliverable_list_query, read_create_deliverable, read_reject_deliverable,
    read_request_signoff, read_update_deliverable, sent,
};
use crate::governance_store::{
    DELIVERABLES, find_deliverable, insert_values, next_deliverable_position,
    raid_for_deliverables, task_progress_for_deliverables, update_values,
};
use crate::project_decisions::{PROJECT_MANAGE_DENIED, delete_links, project_scope};
use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, or_null, parse_limit, to_date};
use crate::raid_body::{Body, parse_body};
use crate::raid_store::{Direction, links_of_object, live_project_exists, present_linked_objects};
use crate::{
    Caller, FlowState, Refusal, Reply, in_accessible, json_rows, outside, page, paged, reply,
};
use weldsuite_flow_domain::approvals::{
    ApprovalRow, ApprovalRowInput, RequestApprovalsInput, RequestApprovalsResult,
    cancel_pending_approvals, list_subject_approvals, request_approvals, sponsor_of,
};

const DELIVERABLE_LABEL: &str = "Deliverable";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    register_deliverable_subject();
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:delete")))
        .route(
            "/{id}/request-signoff",
            post(request_signoff).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/accept",
            post(accept).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/reject",
            post(reject).route_layer(need("projects:update")),
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

fn criteria_of(row: &Value) -> Vec<Value> {
    row.get("acceptanceCriteria")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `publishDeliverable(c, action, row, extra)`.
fn publish_deliverable(
    state: &FlowState,
    caller: &Caller,
    event: EventName,
    row: &Value,
    extra: Value,
) {
    let mut data = deliverable_event_data(row);
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra);
    }
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &data);
}

/// `presentOne(c, row)`: the deliverable with its task progress and register items.
async fn present_one(caller: &Caller, row: &Value) -> Result<Value, Refusal> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let ids = std::slice::from_ref(&id);
    let progress = task_progress_for_deliverables(&caller.db, ids).await?;
    let mut raid = raid_for_deliverables(&caller.db, ids).await?;
    let (done, total) = progress.get(&id).copied().unwrap_or((0, 0));
    Ok(present_deliverable(
        row,
        done,
        total,
        &raid.remove(&id).unwrap_or_default(),
    ))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: the project scope (the project,
/// else the accessible ones), the status and the search.
fn deliverable_filters(q: &RegisterQuery, scope: &(bool, Vec<String>)) -> Condition {
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
                .add(Column::Description.ilike(pattern.as_str())),
        );
    }
    filters
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match deliverable_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 50, 200);
    let scope = match project_scope(&caller, q.project_id.as_deref()).await {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor: Option<(i32, String)> = match &q.cursor {
        Some(cursor) => {
            let found: Result<Option<(String, i32)>, DbErr> =
                project_deliverables::Entity::find_by_id(cursor)
                    .select_only()
                    .columns([Column::Id, Column::Position])
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await;
            match found {
                Ok(found) => found.map(|(id, position)| (position, id)),
                Err(error) => return outside(Err(error.into())),
            }
        }
        None => None,
    };
    reply(
        list_deliverables(&caller, &q, limit, &scope, cursor).await,
        "Failed to list deliverables",
    )
}

async fn list_deliverables(
    caller: &Caller,
    q: &RegisterQuery,
    limit: i64,
    scope: &(bool, Vec<String>),
    cursor: Option<(i32, String)>,
) -> Reply {
    let db = &caller.db;
    let orm = &orm(db);
    let filters = deliverable_filters(q, scope);
    let mut select = project_deliverables::Entity::find().filter(filters.clone());
    if let Some((position, id)) = cursor {
        select = select.filter(
            Condition::any().add(Column::Position.gt(position)).add(
                Condition::all()
                    .add(Column::Position.eq(position))
                    .add(Column::Id.gt(id)),
            ),
        );
    }
    let rows = select
        .order_by_asc(Column::Position)
        .order_by_asc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(orm)
        .await?;
    let total = project_deliverables::Entity::find()
        .filter(filters)
        .count(orm)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = json_rows(rows)?;
    let (rows, has_more, next) = page(rows, limit);
    let page_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let progress = task_progress_for_deliverables(db, &page_ids).await?;
    let mut raid = raid_for_deliverables(db, &page_ids).await?;
    let items = rows
        .iter()
        .map(|row| {
            let id = row["id"].as_str().unwrap_or_default();
            let (done, total) = progress.get(id).copied().unwrap_or((0, 0));
            present_deliverable(row, done, total, &raid.remove(id).unwrap_or_default())
        })
        .collect();
    Ok(paged(items, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        fetch_detail(&caller, &id).await,
        "Failed to fetch deliverable",
    )
}

async fn fetch_detail(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(row) = find_deliverable(db, id).await? else {
        return Err(Refusal::not_found(DELIVERABLE_LABEL, id));
    };
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let link_rows = links_of_object(db, "deliverable", id).await?;
    let signoff_rows = list_subject_approvals(db, "deliverable", id).await?;
    let mut base = present_one(caller, &row).await?;
    let links = present_linked_objects(caller, link_rows, |link| {
        if link["fromType"] == "deliverable" && link["fromId"] == id {
            Direction::Outgoing
        } else {
            Direction::Incoming
        }
    })
    .await?;
    if let Value::Object(fields) = &mut base {
        fields.insert("links".to_owned(), Value::Array(links));
        fields.insert("signoff".to_owned(), signoff_json(&signoff_rows));
    }
    Ok(Data(base).into_response())
}

fn signoff_json(rows: &[ApprovalRow]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| present_signoff_approval(&row.to_json()))
            .collect(),
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_deliverable)?;
        let project_id = text(&input, "projectId").unwrap_or_default().to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let planned_start = text(&input, "plannedStart").and_then(js_date_millis);
        let planned_end = text(&input, "plannedEnd").and_then(js_date_millis);
        if let Some(message) = deliverable_dates_error(planned_start, planned_end) {
            return Err(Refusal::bad_request(message));
        }
        Ok((project_id, input))
    }
    .await;
    let (project_id, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_deliverable(&state, &caller, &project_id, &input).await,
        "Failed to create deliverable",
    )
}

async fn create_deliverable(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now = iso(crate::now_ms());
    let id = generate_id("del");
    let number = allocate_number(db, &deliverable_sequence(project_id)).await?;
    let position = match input.get("position").and_then(Value::as_i64) {
        Some(position) => position,
        None => next_deliverable_position(db, project_id).await?,
    };
    let criteria = input
        .get("acceptanceCriteria")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut values = Body::new();
    values.insert("id".to_owned(), json!(id));
    values.insert("projectId".to_owned(), json!(project_id));
    values.insert("number".to_owned(), json!(number));
    values.insert("title".to_owned(), or_null(input, "title"));
    values.insert("description".to_owned(), or_null(input, "description"));
    values.insert("ownerId".to_owned(), or_null(input, "ownerId"));
    values.insert(
        "status".to_owned(),
        json!(text(input, "status").unwrap_or("not_started")),
    );
    values.insert(
        "plannedStart".to_owned(),
        to_date(input.get("plannedStart")),
    );
    values.insert("plannedEnd".to_owned(), to_date(input.get("plannedEnd")));
    values.insert(
        "acceptanceCriteria".to_owned(),
        Value::Array(apply_criteria(&[], &criteria, &now)),
    );
    values.insert("position".to_owned(), json!(position));
    values.insert(
        "clientVisible".to_owned(),
        json!(input.get("clientVisible") == Some(&Value::Bool(true))),
    );
    values.insert("createdBy".to_owned(), json!(caller.user_id));
    values.insert("createdAt".to_owned(), json!(now));
    values.insert("updatedAt".to_owned(), json!(now));
    insert_values(db, DELIVERABLES, &values).await?;
    let Some(row) = find_deliverable(db, &id).await? else {
        return Err(Refusal::Internal(
            "the new deliverable is missing".to_owned(),
        ));
    };

    publish_deliverable(state, caller, PROJECT_DELIVERABLE_CREATED, &row, json!({}));
    Ok(Created(present_deliverable(&row, 0, 0, &[])).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_deliverable(&caller.db, &id).await? else {
            return Err(Refusal::not_found(DELIVERABLE_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_write(project).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_update_deliverable)?;
        if let Some(message) = accepted_edit_error(
            existing["status"].as_str().unwrap_or_default(),
            &sent(&input),
        ) {
            return Err(Refusal::conflict(message));
        }
        let planned = |key: &str| {
            if input.contains_key(key) {
                text(&input, key).and_then(js_date_millis)
            } else {
                existing[key].as_str().and_then(js_date_millis)
            }
        };
        if let Some(message) =
            deliverable_dates_error(planned("plannedStart"), planned("plannedEnd"))
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
        update_deliverable(&state, &caller, &id, &existing, &input).await,
        "Failed to update deliverable",
    )
}

async fn update_deliverable(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now = iso(crate::now_ms());
    let mut set = Body::new();
    set.insert("updatedAt".to_owned(), json!(now));
    for key in [
        "title",
        "description",
        "ownerId",
        "status",
        "clientVisible",
        "position",
    ] {
        if let Some(value) = input.get(key) {
            set.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["plannedStart", "plannedEnd"] {
        if input.contains_key(key) {
            set.insert(key.to_owned(), to_date(input.get(key)));
        }
    }
    if let Some(criteria) = input.get("acceptanceCriteria").and_then(Value::as_array) {
        set.insert(
            "acceptanceCriteria".to_owned(),
            Value::Array(apply_criteria(&criteria_of(existing), criteria, &now)),
        );
    }

    update_values(db, DELIVERABLES, &set, id).await?;
    let Some(row) = find_deliverable(db, id).await? else {
        return Err(Refusal::not_found(DELIVERABLE_LABEL, id));
    };

    publish_deliverable(state, caller, PROJECT_DELIVERABLE_UPDATED, &row, json!({}));
    Ok(Data(present_one(caller, &row).await?).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_deliverable(&state, &caller, &id).await,
        "Failed to delete deliverable",
    )
}

async fn remove_deliverable(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_deliverable(db, id).await? else {
        return Err(Refusal::not_found(DELIVERABLE_LABEL, id));
    };
    let project = existing["projectId"].as_str().unwrap_or_default();
    if !caller.can_write(project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }

    let links = links_of_object(db, "deliverable", id).await?;
    let now = instant(crate::now_ms());
    // Its links go with it, and its tasks stop counting toward it, in the same batch.
    let id_owned = id.to_owned();
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            let id = id_owned.as_str();
            project_deliverables::Entity::update_many()
                .col_expr(Column::DeletedAt, Expr::value(now))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            delete_links(&tx, "deliverable", id).await?;
            tasks::Entity::update_many()
                .col_expr(
                    tasks::Column::DeliverableId,
                    Expr::value(Option::<String>::None),
                )
                .filter(tasks::Column::DeliverableId.eq(id))
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    let number = existing["number"].as_i64().unwrap_or_default();
    caller.publish(
        state,
        PROJECT_DELIVERABLE_DELETED,
        id,
        &json!({ "id": id, "projectId": existing["projectId"], "code": deliverable_code(number) }),
    );
    for link in &links {
        crate::raid::publish_link(state, caller, PROJECT_CONTROL_LINK_DELETED, link);
    }
    let cleared = cancel_pending_approvals(db, "deliverable", id, true, crate::now_ms()).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    Ok(NoContent.into_response())
}

// ── Sign-off, accept, reject ────────────────────────────────────────────────

/// `managedDeliverable(c, id)`: the deliverable and the caller's right to
/// manage its project, or the refusal.
async fn managed_deliverable(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let Some(existing) = find_deliverable(&caller.db, id).await? else {
        return Err(Refusal::not_found(DELIVERABLE_LABEL, id));
    };
    let project = existing["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    if !caller.can_manage(project).await? {
        return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
    }
    Ok(existing)
}

async fn request_signoff(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = managed_deliverable(&caller, &id).await?;
        let input = parse_body(&body, read_request_signoff)?;
        if let Some(message) = accept_error(
            existing["status"].as_str().unwrap_or_default(),
            &criteria_of(&existing),
        ) {
            return Err(Refusal::conflict(message));
        }
        let previous = list_subject_approvals(&caller.db, "deliverable", &id).await?;
        let decisions: Vec<&str> = previous.iter().map(|row| row.decision.as_str()).collect();
        if signoff_is_open(&decisions) {
            return Err(Refusal::conflict(messages::SIGNOFF_WAITING));
        }
        let project: Option<(Option<Value>, Option<String>)> =
            projects::Entity::find_by_id(existing["projectId"].as_str().unwrap_or_default())
                .select_only()
                .columns([
                    projects::Column::Settings,
                    projects::Column::ProjectManagerId,
                ])
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
        let (settings, manager) = project.unwrap_or((None, None));
        let Some(sponsor) = sponsor_of(settings.as_ref(), manager.as_deref()) else {
            return Err(Refusal::conflict(messages::NO_SPONSOR));
        };
        Ok((existing, input, previous.len(), sponsor))
    }
    .await;
    let (existing, input, previous, sponsor) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        ask_signoff(&state, &caller, &id, &existing, &input, previous, &sponsor).await,
        "Failed to request sign-off",
    )
}

/// `signoffApprovalRows(sponsorId, contactId, dueAt)`: the sponsor first (step
/// 1), then, when asked for, the client contact (step 2).
fn signoff_approval_rows(
    sponsor_id: &str,
    contact_id: Option<&str>,
    due_at: Option<i64>,
) -> Vec<ApprovalRowInput> {
    let mut rows = vec![
        ApprovalRowInput::member(sponsor_id, "deliverable_sponsor")
            .with_role_label("Sponsor")
            .with_step(1)
            .with_due_at(due_at),
    ];
    if let Some(contact) = contact_id {
        let mut client = ApprovalRowInput::member(contact, "deliverable_client")
            .with_role_label("Client")
            .with_step(2)
            .with_due_at(due_at);
        client.approver_kind = Some("contact".to_owned());
        rows.push(client);
    }
    rows
}

async fn ask_signoff(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
    previous: usize,
    sponsor: &str,
) -> Reply {
    let db = &caller.db;
    // An earlier, settled sign-off (declined) is replaced by the new request.
    let cleared = if previous > 0 {
        cancel_pending_approvals(db, "deliverable", id, true, crate::now_ms()).await?
    } else {
        Vec::new()
    };
    let request = RequestApprovalsInput {
        project_id: existing["projectId"].as_str().map(str::to_owned),
        subject_type: "deliverable".to_owned(),
        subject_id: id.to_owned(),
        requested_by: caller.user_id.clone(),
        rows: signoff_approval_rows(
            sponsor,
            text(input, "contactId"),
            text(input, "dueAt").and_then(js_date_millis),
        ),
        now_ms: crate::now_ms(),
    };
    let rows = match request_approvals(db, &request).await? {
        RequestApprovalsResult::Requested(rows) => rows,
        RequestApprovalsResult::Refused { message, .. } => {
            return Err(Refusal::conflict(message));
        }
    };

    announce_approvals_cancelled(state, caller, &cleared);
    announce_deliverable_asked(state, caller, existing, &rows).await?;
    let Some(row) = find_deliverable(db, id).await? else {
        return Err(Refusal::Internal("the deliverable is missing".to_owned()));
    };
    Ok(Created(json!({
        "deliverable": present_one(caller, &row).await?,
        "signoff": signoff_json(&rows),
    }))
    .into_response())
}

async fn accept(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let existing = managed_deliverable(&caller, &id).await?;
        if let Some(message) = accept_error(
            existing["status"].as_str().unwrap_or_default(),
            &criteria_of(&existing),
        ) {
            return Err(Refusal::conflict(message));
        }
        Ok(())
    }
    .await;
    if let Err(refused) = checked {
        return outside(Err(refused));
    }
    reply(
        accept_deliverable(&state, &caller, &id).await,
        "Failed to accept deliverable",
    )
}

async fn accept_deliverable(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = instant(now_ms);
    project_deliverables::Entity::update_many()
        .col_expr(Column::Status, Expr::value("accepted"))
        .col_expr(Column::AcceptedBy, Expr::value(caller.user_id.as_str()))
        .col_expr(Column::AcceptedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    let Some(row) = find_deliverable(db, id).await? else {
        return Err(Refusal::Internal("the deliverable is missing".to_owned()));
    };

    publish_deliverable(state, caller, PROJECT_DELIVERABLE_ACCEPTED, &row, json!({}));
    // Nobody is asked to sign off a deliverable that is accepted.
    let cleared = cancel_pending_approvals(db, "deliverable", id, false, now_ms).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    Ok(Data(present_one(caller, &row).await?).into_response())
}

async fn reject(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = managed_deliverable(&caller, &id).await?;
        let input = parse_body(&body, read_reject_deliverable)?;
        if let Some(message) = reject_error(existing["status"].as_str().unwrap_or_default()) {
            return Err(Refusal::conflict(message));
        }
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        reject_deliverable(&state, &caller, &id, &input).await,
        "Failed to reject deliverable",
    )
}

async fn reject_deliverable(state: &FlowState, caller: &Caller, id: &str, input: &Body) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    project_deliverables::Entity::update_many()
        .col_expr(Column::Status, Expr::value("rejected"))
        .col_expr(Column::UpdatedAt, Expr::value(instant(now_ms)))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    let Some(row) = find_deliverable(db, id).await? else {
        return Err(Refusal::Internal("the deliverable is missing".to_owned()));
    };

    publish_deliverable(
        state,
        caller,
        PROJECT_DELIVERABLE_UPDATED,
        &row,
        json!({ "note": input.get("note").cloned().unwrap_or(Value::Null) }),
    );
    let cleared = cancel_pending_approvals(db, "deliverable", id, false, now_ms).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    Ok(Data(present_one(caller, &row).await?).into_response())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn signs_off_by_the_sponsor_first_and_then_the_client_contact() {
        let rows = signoff_approval_rows("u_sponsor", None, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].approver_id, "u_sponsor");
        assert_eq!(rows[0].role_label.as_deref(), Some("Sponsor"));
        assert_eq!(rows[0].step, Some(1));
        assert_eq!(rows[0].rule, json!({ "code": "deliverable_sponsor" }));

        let rows = signoff_approval_rows("u_sponsor", Some("con_1"), Some(5));
        let kinds: Vec<Option<&str>> = rows
            .iter()
            .map(|row| row.approver_kind.as_deref())
            .collect();
        let ids: Vec<&str> = rows.iter().map(|row| row.approver_id.as_str()).collect();
        let steps: Vec<Option<i64>> = rows.iter().map(|row| row.step).collect();
        let dues: Vec<Option<i64>> = rows.iter().map(|row| row.due_at).collect();
        assert_eq!(kinds, [None, Some("contact")]);
        assert_eq!(ids, ["u_sponsor", "con_1"]);
        assert_eq!(steps, [Some(1), Some(2)]);
        assert_eq!(dues, [Some(5), Some(5)]);
        assert_eq!(rows[1].rule, json!({ "code": "deliverable_client" }));
        assert_eq!(rows[1].role_label.as_deref(), Some("Client"));
    }
}
