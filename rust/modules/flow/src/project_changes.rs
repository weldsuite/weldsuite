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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_CHANGE_REQUEST_CREATED, PROJECT_CHANGE_REQUEST_DELETED,
    PROJECT_CHANGE_REQUEST_SUBMITTED, PROJECT_CHANGE_REQUEST_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
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

use self::body::{has, list_query, read_create, read_settings, read_update};
use crate::approvals::announce::{
    SubjectLabel, announce_approvals_cancelled, announce_approvals_requested,
};
use crate::approvals::{find_live_project, project_member_ids, publish_project_updated};
use crate::raid_body::parse_body;
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, keyset_cursor, now_ms, outside, page, paged,
    reply,
};

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
) -> Result<(HashSet<String>, HashSet<String>), sqlx::Error> {
    let milestones: Vec<String> = sqlx::query_scalar(
        "select id from milestones where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let deliverables: Vec<String> = sqlx::query_scalar(
        "select id from project_deliverables where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
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
            sqlx::query(
                "update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('changeControl', $2::jsonb),
                     updated_at = $3::timestamp where id = $1 and deleted_at is null",
            )
            .bind(&project_id)
            .bind(control)
            .bind(crate::now())
            .execute(&caller.db)
            .await?;
            let updated = find_live_project(&caller.db, &project_id).await?;
            publish_project_updated(&state, &caller, &project_id).await?;
            Ok(Data(settings_response(updated.as_ref().unwrap_or(&project))).into_response())
        }
        .await,
        "Failed to save the change control settings",
    )
}

// ── GET / ───────────────────────────────────────────────────────────────────

const CHANGE_JSON: &str = "(to_jsonb(t) || jsonb_build_object('cost_delta', t.cost_delta::text))";

macro_rules! change_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ")",
            " and ($4::text is null or t.status = $4)",
            " and ($5::text is null or t.title ilike $5 or t.description ilike $5)"
        )
    };
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
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_change_requests where id = $1 limit 1",
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
            let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select {CHANGE_JSON} from project_change_requests t where {}
                 and ($6::timestamptz is null or t.created_at < $6::timestamptz
                      or (t.created_at = $6::timestamptz and t.id < $7))
                 order by t.created_at desc, t.id desc limit $8",
                change_filters!()
            )))
            .bind(q.project_id.as_deref())
            .bind(all)
            .bind(&ids)
            .bind(q.status.as_deref())
            .bind(search.as_deref())
            .bind(cursor.as_ref().map(|c| c.0.as_str()))
            .bind(cursor.as_ref().map(|c| c.1.as_str()))
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
            let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select count(*)::int8 from project_change_requests t where {}",
                change_filters!()
            )))
            .bind(q.project_id.as_deref())
            .bind(all)
            .bind(&ids)
            .bind(q.status.as_deref())
            .bind(search.as_deref())
            .fetch_one(&caller.db)
            .await?;
            let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
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
            sqlx::query_scalar("select version from project_baselines where id = $1 limit 1")
                .bind(baseline)
                .fetch_optional(db)
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
            sqlx::query(
                "insert into project_change_requests (id, project_id, number, title, description, requested_by,
                     status, cost_delta, schedule_delta_days, plan_changes, scope_changes, client_visible,
                     created_by, created_at, updated_at)
                 select p.id, p.project_id, p.number, p.title, p.description, p.requested_by, p.status,
                     p.cost_delta, p.schedule_delta_days, p.plan_changes, p.scope_changes, p.client_visible,
                     p.created_by, p.created_at, p.updated_at
                 from jsonb_populate_record(null::project_change_requests, $1) p",
            )
            .bind(row)
            .execute(&caller.db)
            .await?;
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
    let now = iso(now_ms());
    // Editing what the approvers weigh, once it is with them, starts the approval over (FLOW-013).
    let reroute = existing["status"] == "awaiting_approval" && impact_changed(existing, data);
    let json_opt = |key: &str| Some(null_if_absent(data.get(key))).filter(|v| !v.is_null());
    sqlx::query(
        "update project_change_requests set
            title = case when $2::bool then $3 else title end,
            description = case when $4::bool then $5 else description end,
            cost_delta = case when $6::bool then $7::numeric else cost_delta end,
            schedule_delta_days = case when $8::bool then $9::int else schedule_delta_days end,
            plan_changes = case when $10::bool then $11::jsonb else plan_changes end,
            scope_changes = case when $12::bool then $13::jsonb else scope_changes end,
            client_visible = case when $14::bool then $15::bool else client_visible end,
            status = case when $16::bool then 'assessing' else status end,
            route = case when $16::bool then null else route end,
            submitted_at = case when $16::bool then null else submitted_at end,
            updated_at = $17::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(has(data, "title"))
    .bind(data.get("title").and_then(Value::as_str))
    .bind(has(data, "description"))
    .bind(data.get("description").and_then(Value::as_str))
    .bind(has(data, "costDelta"))
    .bind(money(data.get("costDelta")).as_str().map(str::to_owned))
    .bind(has(data, "scheduleDeltaDays"))
    .bind(
        data.get("scheduleDeltaDays")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok()),
    )
    .bind(has(data, "planChanges"))
    .bind(json_opt("planChanges"))
    .bind(has(data, "scopeChanges"))
    .bind(json_opt("scopeChanges"))
    .bind(has(data, "clientVisible"))
    .bind(data.get("clientVisible").and_then(Value::as_bool))
    .bind(reroute)
    .bind(&now)
    .execute(db)
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
            sqlx::query(
                "update project_change_requests set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(iso(now_ms()))
            .execute(&caller.db)
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
    sqlx::query(
        "update project_change_requests set status = 'awaiting_approval', route = $2,
             submitted_at = $3::timestamptz, decided_at = null, updated_at = $3::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(routing.route)
    .bind(iso(now))
    .execute(db)
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
            sqlx::query(
                "update project_change_requests set status = 'withdrawn', updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(iso(now))
            .execute(&caller.db)
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
