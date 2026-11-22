//! `/api/milestones` (`routes/milestones/index.ts`): a project's milestones
//! with their task counters and progress computed on read; `completedAt`
//! follows the status.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_MILESTONE_COMPLETED, PROJECT_MILESTONE_CREATED, PROJECT_MILESTONE_DELETED,
    PROJECT_MILESTONE_UPDATED,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, orm_error, utc_now};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_flow_domain::stats::{milestone_refs, milestone_stats, with_milestone_stats};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::milestones;

use crate::projects::{bindable, writable};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, fetch_limit, forbidden, in_accessible,
    row_json, json_rows, keyset_before, keyset_cursor, list_limit, now, outside, page, paged,
    reply, validate,
};

/// `milestones`, written from the picked body: Postgres converts each value
/// to its column's type, as the jsonb casts did.
const MILESTONES: JsonTable = JsonTable::of::<milestones::Entity>();

/// The writable keys and their columns.
const COLUMNS: [(&str, &str); 11] = [
    ("name", "name"),
    ("projectId", "project_id"),
    ("description", "description"),
    ("dueDate", "due_date"),
    ("status", "status"),
    ("deliverables", "deliverables"),
    ("dependsOn", "depends_on"),
    ("ownerId", "owner_id"),
    ("responsible", "responsible"),
    ("tags", "tags"),
    ("isKeyMilestone", "is_key_milestone"),
];

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

/// `MILESTONE_WRITABLE_FIELDS`.
const WRITABLE: [&str; 11] = [
    "name",
    "projectId",
    "description",
    "dueDate",
    "status",
    "deliverables",
    "dependsOn",
    "ownerId",
    "responsible",
    "tags",
    "isKeyMilestone",
];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("milestones:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("milestones:create")),
        )
        .route("/{id}", get(detail).route_layer(need("milestones:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("milestones:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("milestones:delete")),
        )
        .with_state(state)
}

async fn milestone_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    milestones::Entity::find_by_id(id)
        .filter(milestones::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// The live milestone's `projectId`, `None` when there is no such milestone.
async fn milestone_project(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Option<String>>, DbErr> {
    use milestones::Column;
    let project: Option<String> = milestones::Entity::find_by_id(id)
        .select_only()
        .column(Column::ProjectId)
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(project.map(Some))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_milestones(&caller, &q).await)
}

/// The list's `where` (`buildListFilters`), each condition behind its own
/// flag so the count can leave out the last one, as TypeScript does when
/// a cursor is given (`conditions.slice(0, -1)`): deleted, project, scope,
/// status, search.
fn milestone_filters(
    flags: [bool; 5],
    project_id: Option<&str>,
    scope: &(bool, Vec<String>),
    status: Option<&str>,
    search: Option<&str>,
) -> Condition {
    use milestones::Column;
    let mut filters = Condition::all();
    if flags[0] {
        filters = filters.add(Column::DeletedAt.is_null());
    }
    if flags[1]
        && let Some(project_id) = project_id
    {
        filters = filters.add(Column::ProjectId.eq(project_id));
    }
    if flags[2] {
        filters = filters.add(in_accessible(Column::ProjectId, scope));
    }
    if flags[3]
        && let Some(status) = status
    {
        filters = filters.add(Column::Status.eq(status));
    }
    if flags[4]
        && let Some(search) = search
    {
        filters = filters.add(Column::Name.ilike(search));
    }
    filters
}

async fn list_milestones(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    let limit = list_limit(q, 25, 100);
    let project_id = q.present("projectId").map(str::to_owned);
    let (all, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (true, Vec::new())
    } else {
        access_scope(caller).await?
    };
    let status = q.present("status").map(str::to_owned);
    let search = q.present("search").map(contains_pattern);
    // The conditions in TypeScript's order: deleted, project, scope, status, search.
    let mut flags = [
        true,
        project_id.is_some(),
        project_id.is_none(),
        status.is_some(),
        search.is_some(),
    ];
    let cursor = match q.present("cursor") {
        Some(cursor) => {
            use milestones::Column;
            keyset_cursor(db, Column::Id, Column::CreatedAt, cursor).await?
        }
        None => None,
    };
    let fetch_flags = flags;
    // A cursor drops the last condition from the count: the cursor's own
    // when its row was found, else the last filter.
    if q.present("cursor").is_some()
        && cursor.is_none()
        && let Some(last) = flags.iter().rposition(|on| *on)
    {
        flags[last] = false;
    }
    let result = async {
        use milestones::Column;
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let scope = (all, ids);
        let filters = |flags: [bool; 5]| {
            milestone_filters(
                flags,
                project_id.as_deref(),
                &scope,
                status.as_deref(),
                search.as_deref(),
            )
        };
        let mut rows = milestones::Entity::find().filter(filters(fetch_flags));
        if let Some(cursor) = &cursor {
            rows = rows.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
        }
        let rows = rows
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(fetch_limit(limit)?)
            .all(&orm(db))
            .await?;
        let total = milestones::Entity::find()
            .filter(filters(flags))
            .count(&orm(db))
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let (rows, has_more, cursor) = page(json_rows(rows)?, limit);
        let counters = milestone_stats(db, &milestone_refs(&rows))
            .await
            .map_err(orm_error)?;
        Ok(paged(
            with_milestone_stats(rows, &counters),
            total,
            has_more,
            cursor,
        ))
    }
    .await;
    Ok(reply(result, "Failed to list milestones"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = milestone_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Milestone", &id));
            };
            if let Some(project_id) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project_id).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let rows = vec![row];
            let stats = milestone_stats(&caller.db, &milestone_refs(&rows))
                .await
                .map_err(orm_error)?;
            let mut rows = with_milestone_stats(rows, &stats);
            Ok(Data(rows.remove(0)).into_response())
        }
        .await,
        "Failed to fetch milestone",
    )
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// `createMilestoneSchema` (`.partial()` for a PATCH), passthrough.
fn read_milestone(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let name = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "name", name, Some(1), Some(255));
    issues.text(fields, "projectId", Presence::Nullish, None, None);
    issues.text(fields, "description", Presence::Optional, None, None);
    issues.text(fields, "dueDate", Presence::Optional, None, None);
    issues.text(fields, "status", Presence::Optional, None, Some(30));
    fields.clone()
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| {
        read_milestone(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Ok(picked) = writable(&body, &WRITABLE, &[]) else {
        return ApiError::internal().into_response();
    };
    let Some(project_id) = picked
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
    else {
        return ApiError::bad_request("Missing required field: projectId").into_response();
    };
    match caller.can_write(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    if !weldsuite_flow_domain::js::truthy(picked.get("dueDate")) {
        return ApiError::bad_request("Missing required field: dueDate").into_response();
    }
    let data = match writable(&picked, &WRITABLE, &["dueDate"]) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    reply(
        create_milestone(&state, &caller, &project_id, data).await,
        "Failed to create milestone",
    )
}

async fn create_milestone(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    data: Map<String, Value>,
) -> Reply {
    let id = generate_id("ms");
    let now = now();
    let completed = data.get("status").and_then(Value::as_str) == Some("completed");
    // Every column named: a key the body sent (even as `null`), else the
    // default the insert spelled out.
    let Value::Object(body) = bindable(&data) else {
        return Err(Refusal::Internal("body is not an object".to_owned()));
    };
    let mut row = Map::new();
    row.insert("id".to_owned(), json!(id));
    row.insert("created_at".to_owned(), json!(now));
    row.insert("updated_at".to_owned(), json!(now));
    row.insert("completed_at".to_owned(), json!(completed.then_some(&now)));
    for (key, column) in COLUMNS {
        let fallback = match key {
            "status" => json!("pending"),
            "isKeyMilestone" => json!(false),
            _ => Value::Null,
        };
        let value = body.get(key).cloned().unwrap_or(fallback);
        row.insert(column.to_owned(), value);
    }
    MILESTONES.insert(&orm(&caller.db), row).await?;
    let name = data.get("name").cloned().unwrap_or(Value::Null);
    let status = match data.get("status") {
        None | Some(Value::Null) => json!("pending"),
        Some(status) => status.clone(),
    };
    caller.publish(
        state,
        PROJECT_MILESTONE_CREATED,
        &id,
        &json!({ "id": id, "projectId": project_id, "name": name, "status": status }),
    );
    if completed {
        caller.publish(
            state,
            PROJECT_MILESTONE_COMPLETED,
            &id,
            &json!({ "id": id, "projectId": project_id, "name": name, "status": "completed" }),
        );
    }
    Ok(Created(json!({ "id": id })).into_response())
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| {
        read_milestone(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let data = match writable(&body, &WRITABLE, &["dueDate"]) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    reply(
        update_milestone(&state, &caller, &id, data).await,
        "Failed to update milestone",
    )
}

async fn update_milestone(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<(String, String, String)> = {
        use milestones::Column;
        milestones::Entity::find_by_id(id)
            .select_only()
            .columns([Column::ProjectId, Column::Name, Column::Status])
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?
    };
    let Some((existing_project, existing_name, existing_status)) =
        existing.map(|(project, name, status)| (Some(project), name, status))
    else {
        return Err(Refusal::not_found("Milestone", id));
    };
    if let Some(project) = existing_project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if let Some(next) = data
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        && Some(next) != existing_project.as_deref()
        && !caller.can_write(next).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let now = now();
    let status = match data.get("status") {
        None | Some(Value::Null) => Value::String(existing_status.clone()),
        Some(status) => status.clone(),
    };
    let was_completed = existing_status == "completed";
    let is_completed = status.as_str() == Some("completed");
    // completedAt follows the status: stamped on the move to completed,
    // cleared on the move away.
    let (set_completed, completed_at) = if is_completed && !was_completed {
        (true, Some(now.as_str()))
    } else if !is_completed && was_completed {
        (true, None)
    } else {
        (false, None)
    };
    // The keys the body sent (even as `null`); the others keep their column.
    let Value::Object(body) = bindable(&data) else {
        return Err(Refusal::Internal("body is not an object".to_owned()));
    };
    let mut row = Map::new();
    for (key, column) in COLUMNS {
        if let Some(value) = body.get(key) {
            row.insert(column.to_owned(), value.clone());
        }
    }
    if set_completed {
        row.insert("completed_at".to_owned(), json!(completed_at));
    }
    row.insert("updated_at".to_owned(), json!(now));
    MILESTONES.update(&orm(db), id, row, true).await?;
    let name = match data.get("name") {
        None | Some(Value::Null) => Value::String(existing_name),
        Some(name) => name.clone(),
    };
    let event = json!({ "id": id, "projectId": existing_project, "name": name, "status": status });
    caller.publish(state, PROJECT_MILESTONE_UPDATED, id, &event);
    if is_completed && !was_completed {
        caller.publish(state, PROJECT_MILESTONE_COMPLETED, id, &event);
    }
    Ok(Data(json!({ "id": id })).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(project) = milestone_project(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Milestone", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            let now = utc_now();
            milestones::Entity::update_many()
                .col_expr(milestones::Column::DeletedAt, Expr::value(now))
                .col_expr(milestones::Column::UpdatedAt, Expr::value(now))
                .filter(milestones::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(&state, PROJECT_MILESTONE_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete milestone",
    )
}
