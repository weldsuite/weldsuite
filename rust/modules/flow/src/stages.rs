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
use sea_orm::sea_query::{CaseStatement, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::stage::{normalize_status_opt, normalize_task_status};
use weldsuite_schema::tenant::project_pipeline_stages::{self as stages, Column as Stage};
use weldsuite_schema::tenant::tasks::{self, Column as Task};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::tasks::{count_int, json_text, plus, row_json};
use crate::{Caller, FlowState, Query, Refusal, Reply, all_rows, forbidden, outside, reply, validate};

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

async fn stage_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, DbErr> {
    let mut select = stages::Entity::find_by_id(id.to_owned());
    if live {
        select = select.filter(Stage::DeletedAt.is_null());
    }
    select.one(&orm(db)).await?.map(row_json).transpose()
}

/// Tasks in a stage: by stage id, or (unassigned) a custom stage's id used
/// as their status (`tasksInStage`).
fn tasks_in_stage(project_id: &str, stage_id: &str) -> Condition {
    Condition::all()
        .add(Task::ProjectId.eq(project_id))
        .add(Task::DeletedAt.is_null())
        .add(
            Condition::any().add(Task::StageId.eq(stage_id)).add(
                Condition::all()
                    .add(Task::StageId.is_null())
                    .add(Task::Status.eq(stage_id)),
            ),
        )
}

/// The stage's tasks move to `target` with its status: `stage_id = target,
/// status = status, completed_date = case when status = 'done' then
/// coalesce(completed_date, now) end`.
async fn move_stage_tasks(
    db: &PgPool,
    project_id: &str,
    stage_id: &str,
    target: &str,
    status: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let completed = if status == "done" {
        Expr::from(Func::coalesce([
            Expr::col(Task::CompletedDate),
            Expr::value(at),
        ]))
    } else {
        Expr::value(Option::<PrimitiveDateTime>::None)
    };
    tasks::Entity::update_many()
        .col_expr(Task::StageId, Expr::value(target))
        .col_expr(Task::Status, Expr::value(status))
        .col_expr(Task::CompletedDate, completed)
        .col_expr(Task::UpdatedAt, Expr::value(at))
        .filter(tasks_in_stage(project_id, stage_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn live_stages(db: &PgPool, project_id: &str) -> Result<Vec<Value>, DbErr> {
    stages::Entity::find()
        .filter(Stage::ProjectId.eq(project_id))
        .filter(Stage::DeletedAt.is_null())
        .order_by_asc(Stage::Position)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// The default columns, inserted, or revived and reset where a first load
/// already wrote them (`on conflict (id) do update`).
async fn seed_stages(db: &PgPool, project_id: &str) -> Result<(), DbErr> {
    let at = utc_now();
    let rows = DEFAULT_STAGES
        .iter()
        .enumerate()
        .map(|(i, (name, color, status))| stages::ActiveModel {
            id: Set(default_stage_id(project_id, i)),
            project_id: Set(project_id.to_owned()),
            name: Set((*name).to_owned()),
            color: Set(Some((*color).to_owned())),
            position: Set(i32::try_from(i).unwrap_or(i32::MAX)),
            system_status: Set((*status).to_owned()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        });
    stages::Entity::insert_many(rows)
        .on_conflict(
            OnConflict::column(Stage::Id)
                .update_columns([Stage::Name, Stage::Color, Stage::Position, Stage::SystemStatus])
                .value(Stage::UpdatedAt, Expr::value(at))
                .value(Stage::DeletedAt, Expr::value(Option::<PrimitiveDateTime>::None))
                .to_owned(),
        )
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// The live tasks of the project per `(stage_id, status)`.
async fn task_counts(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<(Option<String>, Option<String>, i32)>, DbErr> {
    tasks::Entity::find()
        .select_only()
        .column(Task::StageId)
        .column(Task::Status)
        .column_as(count_int(), "count")
        .filter(Task::ProjectId.eq(project_id))
        .filter(Task::DeletedAt.is_null())
        .group_by(Task::StageId)
        .group_by(Task::Status)
        .into_tuple()
        .all(&orm(db))
        .await
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
        seed_stages(db, project_id).await?;
        stages = live_stages(db, project_id).await?;
    }
    // Task counts per stage; tasks without a stage match by status (a
    // custom stage's id, or a stage's system status).
    let counts = task_counts(db, project_id).await?;
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
    let db = &orm(&caller.db);
    let at = utc_now();
    let system_status = input.system_status.clone().unwrap_or_else(|| id.to_owned());
    let position = if let Some(position) = input.position {
        position
    } else {
        let existing: Vec<(i32, Option<String>)> = stages::Entity::find()
            .select_only()
            .column(Stage::Position)
            .column(Stage::SystemStatus)
            .filter(Stage::ProjectId.eq(&input.project_id))
            .filter(Stage::DeletedAt.is_null())
            .into_tuple()
            .all(db)
            .await?;
        let (position, shift_from) = position_for_new_stage(&existing, &system_status);
        if let Some(from) = shift_from {
            stages::Entity::update_many()
                .col_expr(Stage::Position, plus(Stage::Position, 1))
                .col_expr(Stage::UpdatedAt, Expr::value(at))
                .filter(Stage::ProjectId.eq(&input.project_id))
                .filter(Stage::DeletedAt.is_null())
                .filter(Stage::Position.gte(i32::try_from(from).unwrap_or(i32::MAX)))
                .exec(db)
                .await?;
        }
        position
    };
    stages::Entity::insert(stages::ActiveModel {
        id: Set(id.to_owned()),
        project_id: Set(input.project_id.clone()),
        name: Set(input.name.clone()),
        color: Set(input.color.clone()),
        position: Set(i32::try_from(position).unwrap_or(i32::MAX)),
        system_status: Set(system_status),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;
    let created = stage_row(&caller.db, id, false).await?;
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
            let projects: Vec<Option<String>> = stages::Entity::find()
                .select_only()
                .column(Stage::ProjectId)
                .filter(Stage::Id.is_in(ids.iter().map(String::as_str)))
                .filter(Stage::DeletedAt.is_null())
                .into_tuple()
                .all(&orm(&caller.db))
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
            // `update … from unnest(ids, positions)`: each stage takes its
            // index in the list.
            let mut position = CaseStatement::new();
            for (index, stage) in ids.iter().enumerate() {
                position = position.case(
                    Stage::Id.eq(stage.as_str()),
                    i32::try_from(index).unwrap_or(i32::MAX),
                );
            }
            stages::Entity::update_many()
                .col_expr(Stage::Position, Expr::Case(Box::new(position)))
                .col_expr(Stage::UpdatedAt, Expr::value(utc_now()))
                .filter(Stage::Id.is_in(ids.iter().map(String::as_str)))
                .filter(Stage::DeletedAt.is_null())
                .exec(&orm(&caller.db))
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
    let existing: Option<(String, String)> = stages::Entity::find()
        .select_only()
        .column(Stage::ProjectId)
        .column(Stage::SystemStatus)
        .filter(Stage::Id.eq(id))
        .filter(Stage::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((project_id, existing_status)) = existing else {
        return Err(Refusal::not_found("Project pipeline stage", id));
    };
    if !project_id.is_empty() && !caller.can_write(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let at = utc_now();
    // Only the keys the body sent.
    let mut update = stages::Entity::update_many();
    for (key, column) in [
        ("name", Stage::Name),
        ("color", Stage::Color),
        ("systemStatus", Stage::SystemStatus),
    ] {
        if let Some(value) = data.get(key) {
            update = update.col_expr(column, Expr::value(json_text(value)));
        }
    }
    update
        .col_expr(Stage::UpdatedAt, Expr::value(at))
        .filter(Stage::Id.eq(id))
        .filter(Stage::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    // Tasks carry their stage's system status: a change re-labels them.
    if let Some(status) = data.get("systemStatus").and_then(Value::as_str)
        && status != existing_status
        && !project_id.is_empty()
    {
        move_stage_tasks(
            db,
            &project_id,
            id,
            id,
            &normalize_task_status(status),
            at,
        )
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
    let existing: Option<String> = stages::Entity::find()
        .select_only()
        .column(Stage::ProjectId)
        .filter(Stage::Id.eq(id))
        .filter(Stage::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some(project_id) = existing else {
        return Err(Refusal::not_found("Project pipeline stage", id));
    };
    if !project_id.is_empty() && !caller.can_write(&project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let at = utc_now();
    let target: Option<(String, String)> = if let Some(move_to) = move_to {
        if move_to == id {
            return Err(Refusal::bad_request(
                "Cannot move tasks to the stage being deleted",
            ));
        }
        let requested: Option<(String, String, String)> = stages::Entity::find()
            .select_only()
            .column(Stage::Id)
            .column(Stage::SystemStatus)
            .column(Stage::ProjectId)
            .filter(Stage::Id.eq(move_to))
            .filter(Stage::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
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
        let remaining: Vec<(String, String)> = stages::Entity::find()
            .select_only()
            .column(Stage::Id)
            .column(Stage::SystemStatus)
            .filter(Stage::ProjectId.eq(&project_id))
            .filter(Stage::DeletedAt.is_null())
            .filter(Stage::Id.ne(id))
            .order_by_asc(Stage::Position)
            .into_tuple()
            .all(&orm(db))
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
                move_stage_tasks(
                    db,
                    &project_id,
                    id,
                    target_id,
                    &normalize_task_status(status),
                    at,
                )
                .await?;
            }
            None => {
                tasks::Entity::update_many()
                    .col_expr(Task::StageId, Expr::value(Option::<String>::None))
                    .col_expr(Task::UpdatedAt, Expr::value(at))
                    .filter(tasks_in_stage(&project_id, id))
                    .exec(&orm(db))
                    .await?;
            }
        }
    }
    stages::Entity::update_many()
        .col_expr(Stage::DeletedAt, Expr::value(at))
        .col_expr(Stage::UpdatedAt, Expr::value(at))
        .filter(Stage::Id.eq(id))
        .exec(&orm(db))
        .await?;
    caller.publish(
        state,
        PROJECT_PIPELINE_STAGE_DELETED,
        id,
        &json!({ "id": id }),
    );
    Ok(NoContent.into_response())
}
