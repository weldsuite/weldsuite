//! `/api/project-pipeline-stages` (`routes/project-pipeline-stages/index.ts`):
//! a project's board columns. Each stage's `systemStatus` is what its tasks
//! carry; the defaults are seeded on the first list.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_PIPELINE_STAGE_CREATED, PROJECT_PIPELINE_STAGE_DELETED, PROJECT_PIPELINE_STAGE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::stage::{normalize_status_opt, normalize_task_status};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{
    Caller, FlowState, Query, Refusal, Reply, all_rows, forbidden, now, outside, reply, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

/// `(name, color, systemStatus)` of the seeded columns.
const DEFAULT_STAGES: [(&str, &str, &str); 6] = [
    ("Backlog", "#94a3b8", "backlog"),
    ("To Do", "#c4b5fd", "todo"),
    ("In Progress", "#93c5fd", "in_progress"),
    ("In Review", "#fcd34d", "review"),
    ("Done", "#5eead4", "done"),
    ("Cancelled", "#f87171", "cancelled"),
];

const STAGE_ID_MAX: usize = 30;
const STAGE_SUFFIX_LENGTH: usize = 4;

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
        .route(
            "/reorder",
            axum::routing::patch(reorder).route_layer(need("projects:update")),
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

fn is_closed(status: &str) -> bool {
    matches!(status, "done" | "cancelled")
}

/// `positionForNewStage`: open stages go before the first closed one (Done
/// / Cancelled), closed ones at the end. The position, and where the
/// stages at and after it shift up from.
fn position_for_new_stage(
    existing: &[(i32, Option<String>)],
    system_status: &str,
) -> (i64, Option<i64>) {
    let max = existing
        .iter()
        .map(|(p, _)| i64::from(*p))
        .fold(-1, i64::max);
    if is_closed(system_status) {
        return (max + 1, None);
    }
    let first_closed = existing
        .iter()
        .filter(|(_, s)| s.as_deref().is_some_and(is_closed))
        .map(|(p, _)| i64::from(*p))
        .min();
    match first_closed {
        None => (max + 1, None),
        Some(first) => (first, Some(first)),
    }
}

fn trim_underscores(value: &str) -> &str {
    value.trim_matches('_')
}

/// `slugifyStage`: a readable slug of the name plus a random suffix, cut to
/// fit the column.
fn slugify_stage(name: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('_');
            in_run = true;
        }
    }
    let trimmed = trim_underscores(&slug);
    let cut: String = trimmed
        .chars()
        .take(STAGE_ID_MAX - STAGE_SUFFIX_LENGTH - 1)
        .collect();
    let base = trim_underscores(&cut);
    let suffix = random_string(STAGE_SUFFIX_LENGTH, "0123456789abcdefghijklmnopqrstuvwxyz");
    if base.is_empty() {
        format!("stage_{suffix}")
    } else {
        format!("{base}_{suffix}")
    }
}

/// `defaultStageId`: fixed per project and index, so two first loads
/// insert the same rows.
fn default_stage_id(project_id: &str, index: usize) -> String {
    let id = format!("stg{index}_{project_id}");
    if id.chars().count() <= STAGE_ID_MAX {
        id
    } else {
        generate_id("stg")
    }
}

async fn stage_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from project_pipeline_stages s
         where s.id = $1 and (not $2 or s.deleted_at is null) limit 1",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Tasks in a stage: by stage id, or (unassigned) a custom stage's id used
/// as their status (`tasksInStage`).
macro_rules! tasks_in_stage {
    ($project:literal, $stage:literal) => {
        concat!(
            "project_id = ",
            $project,
            " and deleted_at is null and (stage_id = ",
            $stage,
            " or (stage_id is null and status = ",
            $stage,
            "))"
        )
    };
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn live_stages(db: &PgPool, project_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from project_pipeline_stages s
         where s.project_id = $1 and s.deleted_at is null order by s.position asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let Some(project_id) = q.present("projectId").map(str::to_owned) else {
        return ApiError::bad_request("Missing required query param: projectId").into_response();
    };
    match caller.can_access(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        list_stages(&caller, &project_id).await,
        "Failed to list project pipeline stages",
    )
}

async fn list_stages(caller: &Caller, project_id: &str) -> Reply {
    let db = &caller.db;
    let mut stages = live_stages(db, project_id).await?;
    if stages.is_empty() {
        let now = now();
        let ids: Vec<String> = (0..DEFAULT_STAGES.len())
            .map(|i| default_stage_id(project_id, i))
            .collect();
        let names: Vec<&str> = DEFAULT_STAGES.iter().map(|s| s.0).collect();
        let colors: Vec<&str> = DEFAULT_STAGES.iter().map(|s| s.1).collect();
        let statuses: Vec<&str> = DEFAULT_STAGES.iter().map(|s| s.2).collect();
        let positions: Vec<i32> = (0..6).collect();
        sqlx::query(
            "insert into project_pipeline_stages
                 (id, project_id, name, color, position, system_status, created_at, updated_at)
             select s.id, $2, s.name, s.color, s.position, s.status, $7::timestamp, $7::timestamp
             from unnest($1::varchar[], $3::varchar[], $4::varchar[], $5::int[], $6::varchar[])
                  as s(id, name, color, position, status)
             on conflict (id) do update set
                 name = excluded.name, color = excluded.color, position = excluded.position,
                 system_status = excluded.system_status, updated_at = $7::timestamp,
                 deleted_at = null",
        )
        .bind(&ids)
        .bind(project_id)
        .bind(&names)
        .bind(&colors)
        .bind(&positions)
        .bind(&statuses)
        .bind(&now)
        .execute(db)
        .await?;
        stages = live_stages(db, project_id).await?;
    }
    // Task counts per stage; tasks without a stage match by status (a
    // custom stage's id, or a stage's system status).
    let counts: Vec<(Option<String>, Option<String>, i32)> = sqlx::query_as(
        "select stage_id, status, count(*)::int from tasks
         where project_id = $1 and deleted_at is null group by stage_id, status",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let mut usage: HashMap<String, i64> = HashMap::new();
    for (stage_id, status, count) in counts {
        let mut target = stage_id.filter(|s| !s.is_empty());
        if target.is_none()
            && let Some(status) = status.filter(|s| !s.is_empty())
        {
            let by_id = stages
                .iter()
                .find(|s| s["id"].as_str() == Some(status.as_str()));
            let by_status = || {
                stages.iter().find(|s| {
                    normalize_status_opt(s["systemStatus"].as_str())
                        == Some(normalize_task_status(&status))
                })
            };
            target = by_id
                .or_else(by_status)
                .and_then(|s| s["id"].as_str())
                .map(str::to_owned);
        }
        if let Some(target) = target {
            *usage.entry(target).or_default() += i64::from(count);
        }
    }
    let rows: Vec<Value> = stages
        .into_iter()
        .map(|mut s| {
            let id = s["id"].as_str().unwrap_or_default();
            s["usageCount"] = json!(usage.get(id).copied().unwrap_or(0));
            s
        })
        .collect();
    Ok(all_rows(rows))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = stage_row(&caller.db, &id, true).await? else {
                return Err(Refusal::not_found("Project pipeline stage", &id));
            };
            if let Some(project) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch project pipeline stage",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct NewStage {
    project_id: String,
    id: Option<String>,
    name: String,
    color: Option<String>,
    position: Option<i64>,
    system_status: Option<String>,
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| NewStage {
        project_id: issues
            .text(fields, "projectId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        id: issues
            .text(
                fields,
                "id",
                Presence::Optional,
                Some(1),
                Some(STAGE_ID_MAX),
            )
            .into_option(),
        name: issues
            .text(fields, "name", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        color: issues
            .text(fields, "color", Presence::Optional, None, None)
            .into_option(),
        position: issues
            .integer(fields, "position", Presence::Optional, Some(0))
            .into_option(),
        system_status: issues
            .text_with(fields, "systemStatus", Presence::Optional, Text::default())
            .into_option()
            .map(|s| normalize_task_status(&s)),
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| slugify_stage(&input.name));
    match caller.can_write(&input.project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        create_stage(&state, &caller, &input, &id).await,
        "Failed to create project pipeline stage",
    )
}

async fn create_stage(state: &FlowState, caller: &Caller, input: &NewStage, id: &str) -> Reply {
    let db = &caller.db;
    let now = now();
    let system_status = input.system_status.clone().unwrap_or_else(|| id.to_owned());
    let position = if let Some(position) = input.position {
        position
    } else {
        let existing: Vec<(i32, Option<String>)> = sqlx::query_as(
            "select position, system_status from project_pipeline_stages
             where project_id = $1 and deleted_at is null",
        )
        .bind(&input.project_id)
        .fetch_all(db)
        .await?;
        let (position, shift_from) = position_for_new_stage(&existing, &system_status);
        if let Some(from) = shift_from {
            sqlx::query(
                "update project_pipeline_stages set position = position + 1, updated_at = $3::timestamp
                 where project_id = $1 and deleted_at is null and position >= $2",
            )
            .bind(&input.project_id)
            .bind(i32::try_from(from).unwrap_or(i32::MAX))
            .bind(&now)
            .execute(db)
            .await?;
        }
        position
    };
    sqlx::query(
        "insert into project_pipeline_stages
             (id, project_id, name, color, position, system_status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)",
    )
    .bind(id)
    .bind(&input.project_id)
    .bind(&input.name)
    .bind(input.color.as_deref())
    .bind(i32::try_from(position).unwrap_or(i32::MAX))
    .bind(&system_status)
    .bind(&now)
    .execute(db)
    .await?;
    let created = stage_row(db, id, false).await?;
    caller.publish(
        state,
        PROJECT_PIPELINE_STAGE_CREATED,
        id,
        &json!({ "id": id, "projectId": input.project_id, "name": input.name }),
    );
    Ok(Created(created.unwrap_or(Value::Null)).into_response())
}

// ── PATCH /reorder ──────────────────────────────────────────────────────────

async fn reorder(
    State(_state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "stageIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let projects: Vec<Option<String>> = sqlx::query_scalar(
                "select project_id from project_pipeline_stages
                 where id = any($1) and deleted_at is null",
            )
            .bind(&ids)
            .fetch_all(&caller.db)
            .await?;
            let mut unique: Vec<String> = Vec::new();
            for project in projects.into_iter().flatten() {
                if !project.is_empty() && !unique.contains(&project) {
                    unique.push(project);
                }
            }
            for project in &unique {
                if !caller.can_write(project).await? {
                    return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
                }
            }
            let positions: Vec<i32> = (0..i32::try_from(ids.len()).unwrap_or(i32::MAX)).collect();
            sqlx::query(
                "update project_pipeline_stages s set position = o.position, updated_at = $3::timestamp
                 from unnest($1::varchar[], $2::int[]) as o(id, position)
                 where s.id = o.id and s.deleted_at is null",
            )
            .bind(&ids)
            .bind(&positions)
            .bind(now())
            .execute(&caller.db)
            .await?;
            Ok(Data(json!({ "reordered": true })).into_response())
        }
        .await,
        "Failed to reorder project pipeline stages",
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        let mut data = Map::new();
        if let Field::Set(name) = issues.text(fields, "name", Presence::Optional, Some(1), None) {
            data.insert("name".to_owned(), json!(name));
        }
        if let Field::Set(color) = issues.text(fields, "color", Presence::Optional, None, None) {
            data.insert("color".to_owned(), json!(color));
        }
        if let Field::Set(status) =
            issues.text_with(fields, "systemStatus", Presence::Optional, Text::default())
        {
            data.insert(
                "systemStatus".to_owned(),
                json!(normalize_task_status(&status)),
            );
        }
        data
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        update_stage(&state, &caller, &id, data).await,
        "Failed to update project pipeline stage",
    )
}

async fn update_stage(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<(String, String)> = sqlx::query_as(
        "select project_id, system_status from project_pipeline_stages
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((project_id, existing_status)) = existing else {
        return Err(Refusal::not_found("Project pipeline stage", id));
    };
    if !project_id.is_empty() && !caller.can_write(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let now = now();
    sqlx::query(concat!(
        "update project_pipeline_stages set ",
        set_text!("name", "name"),
        ", ",
        set_text!("color", "color"),
        ", ",
        set_text!("systemStatus", "system_status"),
        ", updated_at = $3::timestamp where id = $2 and deleted_at is null"
    ))
    .bind(Value::Object(data.clone()))
    .bind(id)
    .bind(&now)
    .execute(db)
    .await?;
    // Tasks carry their stage's system status: a change re-labels them.
    if let Some(status) = data.get("systemStatus").and_then(Value::as_str)
        && status != existing_status
        && !project_id.is_empty()
    {
        sqlx::query(concat!(
            "update tasks set stage_id = $2, status = $3,",
            " completed_date = case when $3 = 'done' then coalesce(completed_date, $4::timestamp) end,",
            " updated_at = $4::timestamp where ",
            tasks_in_stage!("$1", "$2")
        ))
        .bind(&project_id)
        .bind(id)
        .bind(normalize_task_status(status))
        .bind(&now)
        .execute(db)
        .await?;
    }
    let updated = stage_row(db, id, false).await?;
    let mut event = data;
    event.insert("id".to_owned(), json!(id));
    caller.publish(
        state,
        PROJECT_PIPELINE_STAGE_UPDATED,
        id,
        &Value::Object(event),
    );
    Ok(Data(updated.unwrap_or(Value::Null)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    let move_to = q.present("moveTasksToStageId").map(str::to_owned);
    reply(
        remove_stage(&state, &caller, &id, move_to.as_deref()).await,
        "Failed to delete project pipeline stage",
    )
}

#[allow(clippy::too_many_lines)]
async fn remove_stage(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    move_to: Option<&str>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<String> = sqlx::query_scalar(
        "select project_id from project_pipeline_stages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(project_id) = existing else {
        return Err(Refusal::not_found("Project pipeline stage", id));
    };
    if !project_id.is_empty() && !caller.can_write(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let now = now();
    let target: Option<(String, String)> = if let Some(move_to) = move_to {
        if move_to == id {
            return Err(Refusal::bad_request(
                "Cannot move tasks to the stage being deleted",
            ));
        }
        let requested: Option<(String, String, String)> = sqlx::query_as(
            "select id, system_status, project_id from project_pipeline_stages
             where id = $1 and deleted_at is null limit 1",
        )
        .bind(move_to)
        .fetch_optional(db)
        .await?;
        match requested {
            Some((target, status, project)) if project == project_id => Some((target, status)),
            _ => {
                return Err(Refusal::bad_request(
                    "moveTasksToStageId must be another stage of the same project",
                ));
            }
        }
    } else if project_id.is_empty() {
        None
    } else {
        // `findFallbackStage`: "To Do", else "Backlog", else the first left.
        let remaining: Vec<(String, String)> = sqlx::query_as(
            "select id, system_status from project_pipeline_stages
             where project_id = $1 and deleted_at is null and id <> $2 order by position asc",
        )
        .bind(&project_id)
        .bind(id)
        .fetch_all(db)
        .await?;
        let by_status = |status: &str| {
            remaining
                .iter()
                .find(|(_, s)| normalize_task_status(s) == status)
                .cloned()
        };
        by_status("todo")
            .or_else(|| by_status("backlog"))
            .or_else(|| remaining.first().cloned())
    };
    if !project_id.is_empty() {
        match &target {
            Some((target_id, status)) => {
                sqlx::query(concat!(
                    "update tasks set stage_id = $3, status = $4,",
                    " completed_date = case when $4 = 'done' then coalesce(completed_date, $5::timestamp) end,",
                    " updated_at = $5::timestamp where ",
                    tasks_in_stage!("$1", "$2")
                ))
                .bind(&project_id)
                .bind(id)
                .bind(target_id)
                .bind(normalize_task_status(status))
                .bind(&now)
                .execute(db)
                .await?;
            }
            None => {
                sqlx::query(concat!(
                    "update tasks set stage_id = null, updated_at = $3::timestamp where ",
                    tasks_in_stage!("$1", "$2")
                ))
                .bind(&project_id)
                .bind(id)
                .bind(&now)
                .execute(db)
                .await?;
            }
        }
    }
    sqlx::query(
        "update project_pipeline_stages set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&now)
    .execute(db)
    .await?;
    caller.publish(
        state,
        PROJECT_PIPELINE_STAGE_DELETED,
        id,
        &json!({ "id": id }),
    );
    Ok(NoContent.into_response())
}
