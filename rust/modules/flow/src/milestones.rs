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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_MILESTONE_COMPLETED, PROJECT_MILESTONE_CREATED, PROJECT_MILESTONE_DELETED,
    PROJECT_MILESTONE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_flow_domain::stats::{milestone_refs, milestone_stats, with_milestone_stats};
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

async fn milestone_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        milestone_json!("m"),
        " from milestones m where m.id = $1 and m.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_milestones(&caller, &q).await)
}

/// The list's `where` (`buildListFilters`), each condition behind its own
/// flag so the count can leave out the last one, as TypeScript does when
/// a cursor is given (`conditions.slice(0, -1)`).
macro_rules! milestone_filters {
    () => {
        concat!(
            "($1::bool is not true or m.deleted_at is null)",
            " and ($2::text is null or m.project_id = $2)",
            " and ($3::bool is not true or ",
            in_accessible!("m.project_id", "$4", "$5"),
            ")",
            " and ($6::text is null or m.status = $6)",
            " and ($7::text is null or m.name ilike $7)"
        )
    };
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
    let cursor =
        match q.present("cursor") {
            Some(cursor) => keyset_cursor(
                db,
                "select id, to_jsonb(created_at) #>> '{}' from milestones where id = $1 limit 1",
                cursor,
            )
            .await?,
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
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            milestone_json!("m"),
            " from milestones m where ",
            milestone_filters!(),
            " and ($8::timestamp is null or m.created_at < $8::timestamp",
            " or (m.created_at = $8::timestamp and m.id < $9))",
            " order by m.created_at desc, m.id desc limit $10"
        ))
        .bind(fetch_flags[0])
        .bind(project_id.as_deref().filter(|_| fetch_flags[1]))
        .bind(fetch_flags[2])
        .bind(all)
        .bind(&ids)
        .bind(status.as_deref().filter(|_| fetch_flags[3]))
        .bind(search.as_deref().filter(|_| fetch_flags[4]))
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
        let total: i64 = sqlx::query_scalar(concat!(
            "select count(*) from milestones m where ",
            milestone_filters!()
        ))
        .bind(flags[0])
        .bind(project_id.as_deref().filter(|_| flags[1]))
        .bind(flags[2])
        .bind(all)
        .bind(&ids)
        .bind(status.as_deref().filter(|_| flags[3]))
        .bind(search.as_deref().filter(|_| flags[4]))
        .fetch_one(db)
        .await?;
        let (rows, has_more, cursor) = page(rows.into_iter().map(js_row).collect(), limit);
        let counters = milestone_stats(db, &milestone_refs(&rows)).await?;
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
            let stats = milestone_stats(&caller.db, &milestone_refs(&rows)).await?;
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
    sqlx::query(concat!(
        "insert into milestones (id, created_at, updated_at, completed_at, name, project_id,",
        " description, due_date, status, deliverables, depends_on, owner_id, responsible, tags,",
        " is_key_milestone) values ($2, $3::timestamp, $3::timestamp, $4::timestamp, ",
        val_text!("name", "null"),
        ", ",
        val_text!("projectId", "null"),
        ", ",
        val_text!("description", "null"),
        ", ",
        val_ts!("dueDate", "null"),
        ", ",
        val_text!("status", "'pending'"),
        ", ",
        val_json!("deliverables", "null"),
        ", ",
        val_json!("dependsOn", "null"),
        ", ",
        val_text!("ownerId", "null"),
        ", ",
        val_json!("responsible", "null"),
        ", ",
        val_json!("tags", "null"),
        ", ",
        val_bool!("isKeyMilestone", "false"),
        ")"
    ))
    .bind(bindable(&data))
    .bind(&id)
    .bind(&now)
    .bind(completed.then_some(now.as_str()))
    .execute(&caller.db)
    .await?;
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
    let existing: Option<(Option<String>, String, String)> = sqlx::query_as(
        "select project_id, name, status from milestones where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((existing_project, existing_name, existing_status)) = existing else {
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
    sqlx::query(concat!(
        "update milestones set ",
        set_text!("name", "name"),
        ", ",
        set_text!("projectId", "project_id"),
        ", ",
        set_text!("description", "description"),
        ", ",
        set_ts!("dueDate", "due_date"),
        ", ",
        set_text!("status", "status"),
        ", ",
        set_json!("deliverables", "deliverables"),
        ", ",
        set_json!("dependsOn", "depends_on"),
        ", ",
        set_text!("ownerId", "owner_id"),
        ", ",
        set_json!("responsible", "responsible"),
        ", ",
        set_json!("tags", "tags"),
        ", ",
        set_bool!("isKeyMilestone", "is_key_milestone"),
        ", completed_at = case when $4 then $5::timestamp else completed_at end",
        ", updated_at = $3::timestamp where id = $2 and deleted_at is null"
    ))
    .bind(bindable(&data))
    .bind(id)
    .bind(&now)
    .bind(set_completed)
    .bind(completed_at)
    .execute(db)
    .await?;
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
            let project: Option<Option<String>> = sqlx::query_scalar(
                "select project_id from milestones where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Milestone", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            sqlx::query(
                "update milestones set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_MILESTONE_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete milestone",
    )
}
