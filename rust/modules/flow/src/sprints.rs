//! `/api/sprints` (`routes/sprints/index.ts`): a project's sprints; the
//! lifecycle stamps (`startedAt`, `completedAt`) follow the status.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_SPRINT_COMPLETED, PROJECT_SPRINT_CREATED, PROJECT_SPRINT_DELETED,
    PROJECT_SPRINT_STARTED, PROJECT_SPRINT_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::projects::{bindable, writable};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, keyset_cursor, list_limit,
    now, outside, page, paged, reply, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

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
    let (scoped, all, ids) = if let Some(project_id) = &project_id {
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
            keyset_cursor(
                db,
                "select id, to_jsonb(created_at) #>> '{}' from sprints where id = $1 limit 1",
                cursor,
            )
            .await?
        }
        None => None,
    };
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(s) from sprints s where s.deleted_at is null",
            " and ($1::text is null or s.project_id = $1)",
            " and ($2::bool is not true or ",
            in_accessible!("s.project_id", "$3", "$4"),
            ")",
            " and ($5::text is null or s.status = $5)",
            " and ($6::text is null or s.name ilike $6)",
            " and ($7::timestamp is null or s.created_at < $7::timestamp",
            " or (s.created_at = $7::timestamp and s.id < $8))",
            " order by s.created_at desc, s.id desc limit $9"
        ))
        .bind(project_id.as_deref())
        .bind(scoped)
        .bind(all)
        .bind(&ids)
        .bind(status.as_deref())
        .bind(search.as_deref())
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
        let total: i64 = sqlx::query_scalar(concat!(
            "select count(*) from sprints s where s.deleted_at is null",
            " and ($1::text is null or s.project_id = $1)",
            " and ($2::bool is not true or ",
            in_accessible!("s.project_id", "$3", "$4"),
            ")",
            " and ($5::text is null or s.status = $5)",
            " and ($6::text is null or s.name ilike $6)"
        ))
        .bind(project_id.as_deref())
        .bind(scoped)
        .bind(all)
        .bind(&ids)
        .bind(status.as_deref())
        .bind(search.as_deref())
        .fetch_one(db)
        .await?;
        let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list sprints"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn sprint_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from sprints s where s.id = $1 and s.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
    sqlx::query(concat!(
        "insert into sprints (id, created_at, updated_at, started_at, completed_at, name,",
        " project_id, goal, status, start_date, end_date, velocity, story_points_committed,",
        " story_points_completed) values ($2, $3::timestamp, $3::timestamp, $4::timestamp,",
        " $5::timestamp, ",
        val_text!("name", "null"),
        ", ",
        val_text!("projectId", "null"),
        ", ",
        val_text!("goal", "null"),
        ", ",
        val_text!("status", "'planned'"),
        ", ",
        val_ts!("startDate", "null"),
        ", ",
        val_ts!("endDate", "null"),
        ", ",
        val_int!("velocity", "null"),
        ", ",
        val_int!("storyPointsCommitted", "null"),
        ", ",
        val_int!("storyPointsCompleted", "null"),
        ")"
    ))
    .bind(bindable(&data))
    .bind(&id)
    .bind(&now)
    .bind(started.then_some(now.as_str()))
    .bind(completed.then_some(now.as_str()))
    .execute(&caller.db)
    .await?;
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
    let existing: Option<(Option<String>, String, String, bool)> = sqlx::query_as(
        "select project_id, name, status, started_at is not null from sprints
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((existing_project, existing_name, before, has_started)) = existing else {
        return Err(Refusal::not_found("Sprint", id));
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
    sqlx::query(concat!(
        "update sprints set ",
        set_text!("name", "name"),
        ", ",
        set_text!("projectId", "project_id"),
        ", ",
        set_text!("goal", "goal"),
        ", ",
        set_text!("status", "status"),
        ", ",
        set_ts!("startDate", "start_date"),
        ", ",
        set_ts!("endDate", "end_date"),
        ", ",
        set_int!("velocity", "velocity"),
        ", ",
        set_int!("storyPointsCommitted", "story_points_committed"),
        ", ",
        set_int!("storyPointsCompleted", "story_points_completed"),
        ", started_at = case when $4 then $3::timestamp else started_at end",
        ", completed_at = case when $5 then $6::timestamp else completed_at end",
        ", updated_at = $3::timestamp where id = $2 and deleted_at is null"
    ))
    .bind(bindable(&data))
    .bind(id)
    .bind(&now)
    .bind(set_started)
    .bind(set_completed)
    .bind(completed_at)
    .execute(db)
    .await?;
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
            let project: Option<Option<String>> = sqlx::query_scalar(
                "select project_id from sprints where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Sprint", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            sqlx::query(
                "update sprints set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_SPRINT_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete sprint",
    )
}
