//! `/api/sprints` (`routes/sprints/index.ts`): a project's sprints; the
//! lifecycle stamps (`startedAt`, `completedAt`) follow the status. A
//! deleted sprint's tasks go back to the backlog. Starting, completing and
//! the report (EU and self-hosted only) are [`crate::sprint_lifecycle`].

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_SPRINT_COMPLETED, PROJECT_SPRINT_CREATED, PROJECT_SPRINT_DELETED,
    PROJECT_SPRINT_STARTED, PROJECT_SPRINT_UPDATED,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{sprints, tasks};

use crate::projects::{bindable, writable};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, fetch_limit, forbidden, in_accessible,
    json_rows, keyset_before, keyset_cursor, list_limit, now, outside, page, paged, reply,
    row_json, validate,
};

const SPRINTS: JsonTable = JsonTable::of::<sprints::Entity>();

/// The writable keys and their columns.
const COLUMNS: [(&str, &str); 9] = [
    ("name", "name"),
    ("projectId", "project_id"),
    ("goal", "goal"),
    ("status", "status"),
    ("startDate", "start_date"),
    ("endDate", "end_date"),
    ("velocity", "velocity"),
    ("storyPointsCommitted", "story_points_committed"),
    ("storyPointsCompleted", "story_points_completed"),
];

pub(crate) const PROJECT_DENIED: &str = "You are not a member of this project";
pub(crate) const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

/// `SPRINT_WRITABLE_FIELDS`.
const WRITABLE: [&str; 9] = [
    "name",
    "projectId",
    "goal",
    "status",
    "startDate",
    "endDate",
    "velocity",
    "storyPointsCommitted",
    "storyPointsCompleted",
];
const TIMESTAMPS: [&str; 2] = ["startDate", "endDate"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("projects:create")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("projects:delete")),
        )
        // The sprint lifecycle, EU and self-hosted only (FLOW-024).
        .route(
            "/{id}/start",
            axum::routing::post(crate::sprint_lifecycle::start)
                .route_layer(need("projects:update")),
        )
        .route(
            "/{id}/complete",
            axum::routing::post(crate::sprint_lifecycle::complete)
                .route_layer(need("projects:update")),
        )
        .route(
            "/{id}/report",
            get(crate::sprint_lifecycle::report).route_layer(need("projects:read")),
        )
        .with_state(state)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_sprints(&caller, &q).await)
}

async fn list_sprints(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    let limit = list_limit(q, 25, 100);
    let project_id = q.present("projectId").map(str::to_owned);
    // Row-level scope (`projectScope`): an explicit project must be
    // accessible; otherwise the caller's projects (scope:all: live ones).
    let (scoped, all_projects, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (false, true, Vec::new())
    } else {
        let (all, ids) = access_scope(caller).await?;
        (true, all, ids)
    };
    let status = q.present("status").map(str::to_owned);
    let search = q.present("search").map(contains_pattern);
    let cursor = match q.present("cursor") {
        Some(cursor) => {
            keyset_cursor(db, sprints::Column::Id, sprints::Column::CreatedAt, cursor).await?
        }
        None => None,
    };
    let filters = || {
        use sprints::Column;
        let mut all = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(project_id) = &project_id {
            all = all.add(Column::ProjectId.eq(project_id.as_str()));
        }
        if scoped {
            all = all.add(in_accessible(
                Column::ProjectId,
                &(all_projects, ids.clone()),
            ));
        }
        if let Some(status) = &status {
            all = all.add(Column::Status.eq(status.as_str()));
        }
        if let Some(search) = &search {
            all = all.add(Column::Name.ilike(search.as_str()));
        }
        all
    };
    let result = async {
        use sprints::Column;
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let mut found = sprints::Entity::find().filter(filters());
        if let Some(cursor) = &cursor {
            found = found.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
        }
        let rows = found
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(fetch_limit(limit)?)
            .all(&orm(db))
            .await?;
        let total = i64::try_from(
            sprints::Entity::find()
                .filter(filters())
                .count(&orm(db))
                .await?,
        )
        .unwrap_or(i64::MAX);
        let (rows, has_more, next) = page(json_rows(rows)?, limit);
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list sprints"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn sprint_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    sprints::Entity::find()
        .filter(sprints::Column::Id.eq(id))
        .filter(sprints::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// The body's keys by column (`jsonb_populate_record` casts each to its
/// column's type); `fallback` is the value of a key the body leaves out
/// (`None`: the column is not written).
fn sprint_columns(
    data: &Map<String, Value>,
    fallback: impl Fn(&str) -> Option<Value>,
) -> Result<Map<String, Value>, Refusal> {
    let Value::Object(body) = bindable(data) else {
        return Err(Refusal::Internal("body is not an object".to_owned()));
    };
    let mut row = Map::new();
    for (key, column) in COLUMNS {
        if let Some(value) = body.get(key).cloned().or_else(|| fallback(key)) {
            row.insert(column.to_owned(), value);
        }
    }
    Ok(row)
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = sprint_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Sprint", &id));
            };
            if let Some(project_id) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project_id).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch sprint",
    )
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// `createSprintSchema` (`.partial()` for a PATCH), passthrough.
fn read_sprint(
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
    issues.text(fields, "startDate", Presence::Optional, None, None);
    issues.text(fields, "endDate", Presence::Optional, None, None);
    issues.text(fields, "status", Presence::Optional, None, Some(30));
    issues.text(fields, "goal", Presence::Optional, None, None);
    fields.clone()
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| {
        read_sprint(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let data = match writable(&body, &WRITABLE, &TIMESTAMPS) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    let Some(project_id) = data
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
    reply(
        create_sprint(&state, &caller, &project_id, data).await,
        "Failed to create sprint",
    )
}

async fn create_sprint(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    data: Map<String, Value>,
) -> Reply {
    let id = generate_id("spr");
    let now = now();
    let status = data.get("status").and_then(Value::as_str);
    let started = matches!(status, Some("active" | "completed"));
    let completed = status == Some("completed");
    // Every column named: a key the body sent (even as `null`), else the
    // insert's own default.
    let mut row = sprint_columns(&data, |key| {
        Some(if key == "status" {
            json!("planned")
        } else {
            Value::Null
        })
    })?;
    row.insert("id".to_owned(), json!(id));
    row.insert("created_at".to_owned(), json!(now));
    row.insert("updated_at".to_owned(), json!(now));
    row.insert("started_at".to_owned(), json!(started.then_some(&now)));
    row.insert("completed_at".to_owned(), json!(completed.then_some(&now)));
    SPRINTS.insert(&orm(&caller.db), row).await?;
    let status = match data.get("status") {
        None | Some(Value::Null) => json!("planned"),
        Some(status) => status.clone(),
    };
    let event = json!({
        "id": id,
        "projectId": project_id,
        "name": data.get("name").cloned().unwrap_or(Value::Null),
        "status": status,
    });
    caller.publish(state, PROJECT_SPRINT_CREATED, &id, &event);
    if started {
        caller.publish(state, PROJECT_SPRINT_STARTED, &id, &event);
    }
    if completed {
        caller.publish(state, PROJECT_SPRINT_COMPLETED, &id, &event);
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
        read_sprint(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let data = match writable(&body, &WRITABLE, &TIMESTAMPS) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    reply(
        update_sprint(&state, &caller, &id, data).await,
        "Failed to update sprint",
    )
}

async fn update_sprint(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<(Option<String>, String, String, Option<PrimitiveDateTime>)> =
        sprints::Entity::find()
            .select_only()
            .columns([
                sprints::Column::ProjectId,
                sprints::Column::Name,
                sprints::Column::Status,
                sprints::Column::StartedAt,
            ])
            .filter(sprints::Column::Id.eq(id))
            .filter(sprints::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
    let Some((existing_project, existing_name, before, started_at)) = existing else {
        return Err(Refusal::not_found("Sprint", id));
    };
    let has_started = started_at.is_some();
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
    // `applyLifecycleStamps`.
    let after = match data.get("status") {
        None | Some(Value::Null) => Value::String(before.clone()),
        Some(status) => status.clone(),
    };
    let after_text = after.as_str().unwrap_or_default();
    let started = after_text == "active" && before != "active";
    let completed = after_text == "completed" && before != "completed";
    let mut set_started = started && !has_started;
    let (set_completed, completed_at) = if completed {
        if !has_started {
            set_started = true;
        }
        (true, Some(now.as_str()))
    } else if after_text != "completed" && before == "completed" {
        (true, None)
    } else {
        (false, None)
    };
    // A key the body leaves out keeps its column.
    let mut row = sprint_columns(&data, |_| None)?;
    if set_started {
        row.insert("started_at".to_owned(), json!(now));
    }
    if set_completed {
        row.insert("completed_at".to_owned(), json!(completed_at));
    }
    row.insert("updated_at".to_owned(), json!(now));
    SPRINTS.update(&orm(db), id, row, true).await?;
    let name = match data.get("name") {
        None | Some(Value::Null) => Value::String(existing_name),
        Some(name) => name.clone(),
    };
    let event = json!({ "id": id, "projectId": existing_project, "name": name, "status": after });
    caller.publish(state, PROJECT_SPRINT_UPDATED, id, &event);
    if started {
        caller.publish(state, PROJECT_SPRINT_STARTED, id, &event);
    }
    if completed {
        caller.publish(state, PROJECT_SPRINT_COMPLETED, id, &event);
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
            let project: Option<Option<String>> = sprints::Entity::find()
                .select_only()
                .column(sprints::Column::ProjectId)
                .filter(sprints::Column::Id.eq(&id))
                .filter(sprints::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Sprint", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            // Its tasks go back to the backlog: the sprint's delete and their
            // unlinking in one transaction, then an update event per task.
            let in_sprint: Vec<tasks::Model> = tasks::Entity::find()
                .filter(tasks::Column::SprintId.eq(&id))
                .filter(tasks::Column::DeletedAt.is_null())
                .all(&orm(&caller.db))
                .await?;
            let unlinked: Vec<String> = in_sprint.iter().map(|task| task.id.clone()).collect();
            let at = utc_now();
            let (sprint_id, task_ids) = (id.clone(), unlinked.clone());
            weldsuite_db::atomically_with(&caller.db, |tx| {
                Box::pin(async move {
                    let tx = OrmConn::new(tx);
                    write_delete(&tx, &sprint_id, &task_ids, at).await
                })
            })
            .await?;
            caller.publish(&state, PROJECT_SPRINT_DELETED, &id, &json!({ "id": id }));
            crate::sprint_lifecycle::publish_moves(&state, &caller, &in_sprint, &unlinked, None);
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete sprint",
    )
}

/// The delete's writes, in one transaction: the sprint is soft-deleted and
/// the tasks that were in it lose their sprint.
async fn write_delete(
    tx: &OrmConn<'_>,
    sprint_id: &str,
    task_ids: &[String],
    at: PrimitiveDateTime,
) -> Result<(), Refusal> {
    sprints::Entity::update_many()
        .col_expr(sprints::Column::DeletedAt, Expr::value(Some(at)))
        .col_expr(sprints::Column::UpdatedAt, Expr::value(at))
        .filter(sprints::Column::Id.eq(sprint_id))
        .exec(tx)
        .await?;
    if !task_ids.is_empty() {
        tasks::Entity::update_many()
            .col_expr(tasks::Column::SprintId, Expr::value(Option::<String>::None))
            .col_expr(tasks::Column::UpdatedAt, Expr::value(at))
            .filter(tasks::Column::Id.is_in(task_ids.iter().map(String::as_str)))
            .exec(tx)
            .await?;
    }
    Ok(())
}
