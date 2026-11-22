//! `/api/project-changes` (`routes/project-changes/index.ts`, FLOW-012 and
//! FLOW-013): change requests in `project_change_requests`. The approvers'
//! answers are `flow_approvals` rows (subject `change_request`), answered in
//! My reviews; approving runs `apply_approved_change` (see [`subject`]).
//!
//! ```text
//! GET    /                       list (projectId optional, filters, cursor)
//! GET    /settings/{projectId}   the approval rules, the sponsor and the warnings
//! PUT    /settings/{projectId}   set the rules (merge write of settings.changeControl)
//! GET    /{id}                   change with approvers, effects, routing and baseline version
//! POST   /                       create a draft
//! PATCH  /{id}                   edit; the impact of a submitted change sends it back to assessing
//! DELETE /{id}                   delete a draft or a withdrawn change
//! POST   /{id}/submit            route it by its impact and ask the approvers
//! POST   /{id}/withdraw          withdraw an open change and clear its approvals
//! ```
//!
//! The checks run in TypeScript's order: permission, the change (404), project
//! access (403), the body (400), then the business rules.

mod body;
pub(crate) mod subject;

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_CHANGE_REQUEST_CREATED, PROJECT_CHANGE_REQUEST_DELETED,
    PROJECT_CHANGE_REQUEST_SUBMITTED, PROJECT_CHANGE_REQUEST_UPDATED,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::approval_views::present_review_approver;
use weldsuite_flow_domain::approvals::{
    PendingReviewFilters, RequestApprovalsInput, RequestApprovalsResult, cancel_pending_approvals,
    list_pending_for_approver, list_subject_approvals, request_approvals,
};
use weldsuite_flow_domain::baselines::load_plan_state;
use weldsuite_flow_domain::changes::{
    CHANGE_APPROVAL_DUE_DAYS, ChangeRouting, board_outsiders, change_approver_rows, change_code,
    change_event_data, change_impact_error, change_sequence, compute_effects,
    effective_change_control, find_change_request, impact_changed, is_open_change, messages,
    present_change_request, route_change,
};
use weldsuite_flow_domain::js::{iso_from_millis, parse_int, to_fixed};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    milestones, project_baselines, project_change_requests, project_deliverables, projects,
};

use self::body::{has, list_query, read_create, read_settings, read_update};
use crate::approvals::announce::{
    SubjectLabel, announce_approvals_cancelled, announce_approvals_requested,
};
use crate::approvals::{find_live_project, project_member_ids, publish_project_updated};
use crate::raid_body::parse_body;
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, fetch_limit, in_accessible, json_rows,
    keyset_before, keyset_cursor_tz, now_ms, outside, page, paged, reply,
};

/// `project_change_requests`, written whole from a row object: Postgres
/// converts each value to its column's type, as `jsonb_populate_record` did.
const CHANGES: JsonTable = JsonTable::of::<project_change_requests::Entity>();

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const PROJECT_EDIT_DENIED: &str =
    "You must be a project owner, admin, or manager to edit this project";
const ITEM_LABEL: &str = "Change request";
const DAY_MS: i64 = 86_400_000;

/// Plug the `change_request` subject in (idempotent).
pub(crate) fn register_subject() {
    subject::register();
}

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    register_subject();
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        .route(
            "/settings/{project_id}",
            get(get_settings).route_layer(need("projects:read")),
        )
        .route(
            "/settings/{project_id}",
            put(put_settings).route_layer(need("projects:update")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:delete")))
        .route(
            "/{id}/submit",
            post(submit).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/withdraw",
            post(withdraw).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn iso(ms: i64) -> String {
    iso_from_millis(ms).unwrap_or_default()
}

/// `new Date(ms)`: the instant a `timestamptz` column stores.
fn instant(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `update project_change_requests set … where id = $id and deleted_at is
/// null`, the sets given by `set`.
async fn update_live_change(
    db: &PgPool,
    id: &str,
    set: impl FnOnce(
        sea_orm::UpdateMany<project_change_requests::Entity>,
    ) -> sea_orm::UpdateMany<project_change_requests::Entity>,
) -> Result<(), DbErr> {
    use project_change_requests::Column;
    set(project_change_requests::Entity::update_many())
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `money(value)`: two decimals as the numeric column stores it, or null.
fn money(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_f64) {
        Some(amount) => Value::String(to_fixed(amount, 2)),
        None => Value::Null,
    }
}

fn publish_change(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        row["id"].as_str().unwrap_or_default(),
        &change_event_data(row),
    );
}

async fn change_or_404(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    find_change_request(&caller.db, id)
        .await?
        .ok_or_else(|| Refusal::not_found(ITEM_LABEL, id))
}

/// The change, writable by the caller: the 404 and 403 checks every write runs before its body.
async fn writable_change(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let row = change_or_404(caller, id).await?;
    if !caller
        .can_write(row["projectId"].as_str().unwrap_or_default())
        .await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    Ok(row)
}

/// The ids of the live milestones and deliverables of a project.
async fn known_plan_ids(
    db: &PgPool,
    project_id: &str,
) -> Result<(HashSet<String>, HashSet<String>), DbErr> {
    let milestones: Vec<String> = milestones::Entity::find()
        .select_only()
        .column(milestones::Column::Id)
        .filter(milestones::Column::ProjectId.eq(project_id))
        .filter(milestones::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let deliverables: Vec<String> = project_deliverables::Entity::find()
        .select_only()
        .column(project_deliverables::Column::Id)
        .filter(project_deliverables::Column::ProjectId.eq(project_id))
        .filter(project_deliverables::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok((
        milestones.into_iter().collect(),
        deliverables.into_iter().collect(),
    ))
}

fn null_if_absent(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn settings_response(project: &Value) -> Value {
    let settings = project.get("settings").cloned().unwrap_or(Value::Null);
    let control = effective_change_control(&settings);
    json!({
        "projectId": project["id"],
        "changeControl": {
            "costLimit": weldsuite_flow_domain::js::number_value(control.cost_limit),
            "scheduleLimitDays": control.schedule_limit_days,
            "boardMemberIds": control.board_member_ids,
        },
        "configured": settings.get("changeControl").is_some_and(|c| !c.is_null()),
        "sponsorId": settings.get("sponsorId").and_then(Value::as_str).filter(|s| !s.is_empty()),
        "projectManagerId": project["projectManagerId"],
        "currency": project["budgetCurrency"],
        "warnings": if control.board_member_ids.is_empty() { json!(["no_board"]) } else { json!([]) },
    })
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        async {
            let Some(project) = find_live_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(settings_response(&project)).into_response())
        }
        .await,
        "Failed to load the change control settings",
    )
}

async fn put_settings(
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
        let input = parse_body(&body, read_settings)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let mut board: Vec<String> = Vec::new();
            for id in input["boardMemberIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if !board.iter().any(|b| b == id) {
                    board.push(id.to_owned());
                }
            }
            let members =
                project_member_ids(&caller.db, &project_id, project["projectManagerId"].as_str())
                    .await?;
            if !board_outsiders(&board, &members).is_empty() {
                return Err(Refusal::bad_request(messages::BOARD_NOT_MEMBERS));
            }
            let control = json!({
                "costLimit": input["costLimit"],
                "scheduleLimitDays": input["scheduleLimitDays"],
                "boardMemberIds": board,
            });
            {
                use projects::Column;
                // `coalesce(settings, '{}') || jsonb_build_object('changeControl', control)`.
                let settings = sea_orm::sea_query::extension::postgres::PgExpr::concat(
                    Expr::from(Func::coalesce([
                        Expr::col((projects::Entity, Column::Settings)),
                        Expr::val(json!({})),
                    ])),
                    Expr::val(json!({ "changeControl": control })),
                );
                projects::Entity::update_many()
                    .col_expr(Column::Settings, settings)
                    .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                    .filter(Column::Id.eq(project_id.as_str()))
                    .filter(Column::DeletedAt.is_null())
                    .exec(&orm(&caller.db))
                    .await?;
            }
            let updated = find_live_project(&caller.db, &project_id).await?;
            publish_project_updated(&state, &caller, &project_id).await?;
            Ok(Data(settings_response(updated.as_ref().unwrap_or(&project))).into_response())
        }
        .await,
        "Failed to save the change control settings",
    )
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: the project (else the
/// accessible ones), the status and the search.
fn change_filters(
    project_id: Option<&str>,
    scope: &(bool, Vec<String>),
    status: Option<&str>,
    search: Option<&str>,
) -> Condition {
    use project_change_requests::Column;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    filters = match project_id {
        Some(project_id) => filters.add(Column::ProjectId.eq(project_id)),
        None => filters.add(in_accessible(Column::ProjectId, scope)),
    };
    if let Some(status) = status {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(search) = search {
        filters = filters.add(
            Condition::any()
                .add(Column::Title.ilike(search))
                .add(Column::Description.ilike(search)),
        );
    }
    filters
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = match q.limit.as_deref().and_then(parse_int) {
        Some(n) if n >= 1 => n.min(100),
        _ => 25,
    };
    let scope = async {
        if let Some(project_id) = &q.project_id {
            if !caller.can_access(project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            return Ok((true, Vec::new()));
        }
        Ok(access_scope(&caller).await?)
    }
    .await;
    let (all, ids) = match scope {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor_tz(
            &caller.db,
            project_change_requests::Column::Id,
            project_change_requests::Column::CreatedAt,
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
        async {
            let search = q
                .search
                .as_deref()
                .map(weldsuite_flow_domain::js::contains_pattern);
            use project_change_requests::Column;
            let filters = change_filters(
                q.project_id.as_deref(),
                &(all, ids),
                q.status.as_deref(),
                search.as_deref(),
            );
            let mut rows = project_change_requests::Entity::find().filter(filters.clone());
            if let Some(cursor) = &cursor {
                rows = rows.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
            }
            let rows = rows
                .order_by_desc(Column::CreatedAt)
                .order_by_desc(Column::Id)
                .limit(fetch_limit(limit)?)
                .all(&orm(&caller.db))
                .await?;
            let total = project_change_requests::Entity::find()
                .filter(filters)
                .count(&orm(&caller.db))
                .await?;
            let total = i64::try_from(total).unwrap_or(i64::MAX);
            let (rows, has_more, next) = page(json_rows(rows)?, limit);
            Ok(paged(
                rows.iter().map(present_change_request).collect(),
                total,
                has_more,
                next,
            ))
        }
        .await,
        "Failed to list change requests",
    )
}

// ── GET /{id} ───────────────────────────────────────────────────────────────

/// `routingOf(row, project, rules)`: what the current rules say about the impact, or what the change was routed by.
fn routing_of(row: &Value, project: &Value, params: &[Value]) -> ChangeRouting {
    let settings = project.get("settings").cloned().unwrap_or(Value::Null);
    let mut routing = route_change(
        weldsuite_flow_domain::changes::amount_of(&row["costDelta"]),
        row["scheduleDeltaDays"].as_i64(),
        &settings,
        project["projectManagerId"].as_str(),
    );
    let stored = params.iter().find(|p| p.is_object());
    let (Some(route), Some(stored)) = (row["route"].as_str(), stored) else {
        return routing;
    };
    routing.route = if route == "board" { "board" } else { "manager" };
    routing.over_limit = stored["overLimit"] == true;
    routing.no_board = stored["noBoard"] == true;
    if let Some(limit) = stored["costLimit"].as_f64() {
        routing.cost_limit = limit;
    }
    if let Some(days) = stored["scheduleLimitDays"].as_i64() {
        routing.schedule_limit_days = days;
    }
    routing
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        fetch_detail(&caller, &id).await,
        "Failed to fetch change request",
    )
}

async fn fetch_detail(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let row = change_or_404(caller, id).await?;
    let project_id = row["projectId"].as_str().unwrap_or_default().to_owned();
    if !caller.can_access(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let Some(project) = find_live_project(db, &project_id).await? else {
        return Err(Refusal::not_found(ITEM_LABEL, id));
    };
    let rows = list_subject_approvals(db, "change_request", id).await?;
    let plan = load_plan_state(db, &project_id).await?.unwrap_or_default();
    let filters = PendingReviewFilters {
        subject_types: vec!["change_request".to_owned()],
        ..PendingReviewFilters::default()
    };
    let pending = list_pending_for_approver(db, &caller.user_id, &filters, now_ms()).await?;
    let version: Option<i32> = match row["baselineId"].as_str() {
        Some(baseline) => {
            project_baselines::Entity::find_by_id(baseline)
                .select_only()
                .column(project_baselines::Column::Version)
                .into_tuple()
                .one(&orm(db))
                .await?
        }
        None => None,
    };
    let applied = row["status"] == "approved" || row["status"] == "implemented";
    let effects = compute_effects(&row, &plan, applied);
    let params: Vec<Value> = rows
        .iter()
        .map(|r| r.rule.get("params").cloned().unwrap_or(Value::Null))
        .collect();
    let mut out = present_change_request(&row);
    if let Value::Object(map) = &mut out {
        map.insert(
            "approvers".to_owned(),
            json!(rows.iter().map(present_review_approver).collect::<Vec<_>>()),
        );
        map.insert("effects".to_owned(), effects);
        map.insert(
            "routing".to_owned(),
            routing_of(&row, &project, &params).present(),
        );
        map.insert("baselineVersion".to_owned(), json!(version));
        map.insert(
            "canDecide".to_owned(),
            json!(pending.iter().any(|p| p.approval.subject_id == id)),
        );
    }
    Ok(Data(out).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create)?;
        let project_id = input["projectId"].as_str().unwrap_or_default().to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if find_live_project(&caller.db, &project_id).await?.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let (milestones, deliverables) = known_plan_ids(&caller.db, &project_id).await?;
        if let Some(message) = change_impact_error(
            &null_if_absent(input.get("planChanges")),
            &null_if_absent(input.get("scopeChanges")),
            &milestones,
            &deliverables,
        ) {
            return Err(Refusal::bad_request(message));
        }
        Ok((input, project_id))
    }
    .await;
    let (input, project_id) = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let now = iso(now_ms());
            let id = generate_id("pcr");
            let number = allocate_number(&caller.db, &change_sequence(&project_id)).await?;
            let row = json!({
                "id": id, "project_id": project_id, "number": number, "title": input["title"],
                "description": null_if_absent(input.get("description")),
                "requested_by": caller.user_id, "status": "draft",
                "cost_delta": money(input.get("costDelta")),
                "schedule_delta_days": null_if_absent(input.get("scheduleDeltaDays")),
                "plan_changes": null_if_absent(input.get("planChanges")),
                "scope_changes": null_if_absent(input.get("scopeChanges")),
                "client_visible": input.get("clientVisible").and_then(Value::as_bool).unwrap_or(false),
                "created_by": caller.user_id, "created_at": now, "updated_at": now,
            });
            let Value::Object(row) = row else {
                return Err(Refusal::Internal("the row is not an object".to_owned()));
            };
            CHANGES.insert(&orm(&caller.db), row).await?;
            let Some(created) = find_change_request(&caller.db, &id).await? else {
                return Err(Refusal::Internal("the new change is missing".to_owned()));
            };
            publish_change(&state, &caller, PROJECT_CHANGE_REQUEST_CREATED, &created);
            Ok(Created(present_change_request(&created)).into_response())
        }
        .await,
        "Failed to create change request",
    )
}

// ── PATCH /{id} ─────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = writable_change(&caller, &id).await?;
        let data = parse_body(&body, read_update)?;
        if !is_open_change(existing["status"].as_str().unwrap_or_default()) {
            return Err(Refusal::conflict(messages::NOT_EDITABLE));
        }
        Ok((existing, data))
    }
    .await;
    let (existing, data) = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_change(&state, &caller, &id, &existing, &data).await,
        "Failed to update change request",
    )
}

async fn update_change(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    data: &Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let project_id = existing["projectId"].as_str().unwrap_or_default();
    if has(data, "planChanges") || has(data, "scopeChanges") {
        let pick = |key: &str| {
            if has(data, key) {
                null_if_absent(data.get(key))
            } else {
                null_if_absent(existing.get(key))
            }
        };
        let (milestones, deliverables) = known_plan_ids(db, project_id).await?;
        if let Some(message) = change_impact_error(
            &pick("planChanges"),
            &pick("scopeChanges"),
            &milestones,
            &deliverables,
        ) {
            return Err(Refusal::bad_request(message));
        }
    }
    let now = instant(now_ms());
    // Editing what the approvers weigh, once it is with them, starts the approval over (FLOW-013).
    let reroute = existing["status"] == "awaiting_approval" && impact_changed(existing, data);
    update_live_change(db, id, |mut update| {
        use project_change_requests::Column;
        let text = |key: &str| Expr::value(data.get(key).and_then(Value::as_str).map(str::to_owned));
        let json_opt = |key: &str| {
            Expr::value(Some(null_if_absent(data.get(key))).filter(|v| !v.is_null()))
        };
        if has(data, "title") {
            update = update.col_expr(Column::Title, text("title"));
        }
        if has(data, "description") {
            update = update.col_expr(Column::Description, text("description"));
        }
        if has(data, "costDelta") {
            // The two-decimal text, cast as the column takes it.
            let amount = money(data.get("costDelta")).as_str().map(str::to_owned);
            update = update.col_expr(
                Column::CostDelta,
                sea_orm::ExprTrait::cast_as(Expr::value(amount), "numeric"),
            );
        }
        if has(data, "scheduleDeltaDays") {
            let days = data
                .get("scheduleDeltaDays")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok());
            update = update.col_expr(Column::ScheduleDeltaDays, Expr::value(days));
        }
        if has(data, "planChanges") {
            update = update.col_expr(Column::PlanChanges, json_opt("planChanges"));
        }
        if has(data, "scopeChanges") {
            update = update.col_expr(Column::ScopeChanges, json_opt("scopeChanges"));
        }
        if has(data, "clientVisible") {
            let visible = data.get("clientVisible").and_then(Value::as_bool);
            update = update.col_expr(Column::ClientVisible, Expr::value(visible));
        }
        if reroute {
            update = update
                .col_expr(Column::Status, Expr::value("assessing"))
                .col_expr(Column::Route, Expr::value(Option::<String>::None))
                .col_expr(Column::SubmittedAt, Expr::value(Option::<OffsetDateTime>::None));
        }
        update.col_expr(Column::UpdatedAt, Expr::value(now))
    })
    .await?;
    let Some(row) = find_change_request(db, id).await? else {
        return Err(Refusal::not_found(ITEM_LABEL, id));
    };
    publish_change(state, caller, PROJECT_CHANGE_REQUEST_UPDATED, &row);
    if reroute {
        let cleared = cancel_pending_approvals(db, "change_request", id, true, now_ms()).await?;
        announce_approvals_cancelled(state, caller, &cleared);
    }
    Ok(Data(present_change_request(&row)).into_response())
}

// ── DELETE /{id} ────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let existing = writable_change(&caller, &id).await?;
            let status = existing["status"].as_str().unwrap_or_default();
            if status != "draft" && status != "withdrawn" {
                return Err(Refusal::conflict(messages::NOT_DELETABLE));
            }
            let now = instant(now_ms());
            update_live_change(&caller.db, &id, |update| {
                use project_change_requests::Column;
                update
                    .col_expr(Column::DeletedAt, Expr::value(now))
                    .col_expr(Column::UpdatedAt, Expr::value(now))
            })
            .await?;
            let number = existing["number"].as_i64().unwrap_or(0);
            caller.publish(
                &state,
                PROJECT_CHANGE_REQUEST_DELETED,
                &id,
                &json!({"id": id, "projectId": existing["projectId"], "number": number, "code": change_code(number)}),
            );
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete change request",
    )
}

// ── POST /{id}/submit ───────────────────────────────────────────────────────

async fn submit(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let existing = writable_change(&caller, &id).await?;
        let status = existing["status"].as_str().unwrap_or_default();
        if status != "draft" && status != "assessing" {
            return Err(Refusal::conflict(messages::NOT_SUBMITTABLE));
        }
        Ok(existing)
    }
    .await;
    let existing = match checked {
        Ok(ok) => ok,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        submit_change(&state, &caller, &id, &existing).await,
        "Failed to submit change request",
    )
}

async fn submit_change(state: &FlowState, caller: &Caller, id: &str, existing: &Value) -> Reply {
    let db = &caller.db;
    let project_id = existing["projectId"].as_str().unwrap_or_default();
    let Some(project) = find_live_project(db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    let (milestones, deliverables) = known_plan_ids(db, project_id).await?;
    if let Some(message) = change_impact_error(
        &null_if_absent(existing.get("planChanges")),
        &null_if_absent(existing.get("scopeChanges")),
        &milestones,
        &deliverables,
    ) {
        return Err(Refusal::bad_request(message));
    }
    let routing = route_change(
        weldsuite_flow_domain::changes::amount_of(&existing["costDelta"]),
        existing["scheduleDeltaDays"].as_i64(),
        &project.get("settings").cloned().unwrap_or(Value::Null),
        project["projectManagerId"].as_str(),
    );
    if routing.route == "board" {
        let members =
            project_member_ids(db, project_id, project["projectManagerId"].as_str()).await?;
        if !board_outsiders(&routing.approver_ids, &members).is_empty() {
            return Err(Refusal::bad_request(messages::BOARD_NOT_MEMBERS));
        }
    }
    if routing.approver_ids.is_empty() {
        return Err(Refusal::bad_request(messages::NO_MANAGER));
    }

    let now = now_ms();
    let requested = request_approvals(
        db,
        &RequestApprovalsInput {
            project_id: Some(project_id.to_owned()),
            subject_type: "change_request".to_owned(),
            subject_id: id.to_owned(),
            requested_by: caller.user_id.clone(),
            rows: change_approver_rows(&routing, now + CHANGE_APPROVAL_DUE_DAYS * DAY_MS),
            now_ms: now,
        },
    )
    .await?;
    let rows = match requested {
        RequestApprovalsResult::Requested(rows) => rows,
        RequestApprovalsResult::Refused { message, .. } => {
            return Err(Refusal::bad_request(message));
        }
    };
    let at = instant(now);
    update_live_change(db, id, |update| {
        use project_change_requests::Column;
        update
            .col_expr(Column::Status, Expr::value("awaiting_approval"))
            .col_expr(Column::Route, Expr::value(routing.route))
            .col_expr(Column::SubmittedAt, Expr::value(at))
            .col_expr(Column::DecidedAt, Expr::value(Option::<OffsetDateTime>::None))
            .col_expr(Column::UpdatedAt, Expr::value(at))
    })
    .await?;
    let Some(row) = find_change_request(db, id).await? else {
        cancel_pending_approvals(db, "change_request", id, true, now).await?;
        return Err(Refusal::not_found(ITEM_LABEL, id));
    };
    publish_change(state, caller, PROJECT_CHANGE_REQUEST_SUBMITTED, &row);
    announce_approvals_requested(
        state,
        caller,
        &rows,
        &SubjectLabel {
            code: Some(change_code(row["number"].as_i64().unwrap_or(0))),
            title: row["title"].as_str().unwrap_or_default().to_owned(),
        },
        project["name"].as_str(),
    );
    Ok(Data(json!({
        "change": present_change_request(&row),
        "approvers": rows.iter().map(present_review_approver).collect::<Vec<_>>(),
        "routing": routing.present(),
    }))
    .into_response())
}

// ── POST /{id}/withdraw ─────────────────────────────────────────────────────

async fn withdraw(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let existing = writable_change(&caller, &id).await?;
        let project_id = existing["projectId"].as_str().unwrap_or_default();
        if existing["requestedBy"].as_str() != Some(caller.user_id.as_str())
            && !caller.can_manage(project_id).await?
        {
            return Err(Refusal::forbidden(messages::WITHDRAW_DENIED));
        }
        if !is_open_change(existing["status"].as_str().unwrap_or_default()) {
            return Err(Refusal::conflict(messages::NOT_WITHDRAWABLE));
        }
        Ok(existing)
    }
    .await;
    if let Err(refused) = checked {
        return outside(Err(refused));
    }
    reply(
        async {
            let now = now_ms();
            let at = instant(now);
            update_live_change(&caller.db, &id, |update| {
                use project_change_requests::Column;
                update
                    .col_expr(Column::Status, Expr::value("withdrawn"))
                    .col_expr(Column::UpdatedAt, Expr::value(at))
            })
            .await?;
            let Some(row) = find_change_request(&caller.db, &id).await? else {
                return Err(Refusal::not_found(ITEM_LABEL, &id));
            };
            publish_change(&state, &caller, PROJECT_CHANGE_REQUEST_UPDATED, &row);
            let cleared =
                cancel_pending_approvals(&caller.db, "change_request", &id, true, now).await?;
            announce_approvals_cancelled(&state, &caller, &cleared);
            Ok(Data(present_change_request(&row)).into_response())
        }
        .await,
        "Failed to withdraw change request",
    )
}
