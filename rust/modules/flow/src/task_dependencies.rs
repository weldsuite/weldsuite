//! `/api/task-dependencies` (`routes/task-dependencies/index.ts`): typed task
//! dependencies: create, update type and lag, delete, list by project or task
//! (FLOW-015).
//!
//! ```text
//! GET    /           list (projectId and/or taskId, cursor)
//! POST   /           link two tasks of one project (fs, lag 0 by default)
//! PATCH  /:id        change the type and/or the lag
//! DELETE /:id        remove the link
//! ```
//!
//! The checks run in TypeScript's order: permission, then the objects (404),
//! then project access (403), then the body (400), then the rules. A write
//! keeps `tasks.depends_on` / `tasks.blocks` in step in the same batch.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::entity_events::{
    PROJECT_TASK_UPDATED, TASK_DEPENDENCY_CREATED, TASK_DEPENDENCY_DELETED, TASK_DEPENDENCY_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::js::parse_int;
use weldsuite_flow_domain::task_dependencies::{messages, with_id, without_id, would_close_cycle};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED};
use crate::raid_body::{Body, IDENTIFIER, Reader, parse_body, read_query, whole};
use crate::{
    Caller, FlowState, Refusal, Reply, keyset_cursor, now_ms, outside, page, paged, reply,
};

const LABEL: &str = "Dependency";
const DEPENDENCY_TYPES: [&str; 4] = ["fs", "ss", "ff", "sf"];
const MAX_LAG_DAYS: f64 = 3650.0;

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(need("projects:read"))
                .merge(axum::routing::post(create).route_layer(need("projects:update"))),
        )
        .route(
            "/{id}",
            patch(update)
                .delete(remove)
                .route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Rows ────────────────────────────────────────────────────────────────────

pub(crate) async fn find_dependency(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(d) from task_dependencies d where d.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// The task columns a link write needs, as the camelCase row Drizzle reads.
macro_rules! task_json {
    () => {
        "jsonb_build_object('id', t.id, 'projectId', t.project_id, 'title', t.title,
    'number', t.number, 'status', t.status, 'priority', t.priority, 'type', t.type,
    'assigneeId', t.assignee_id, 'estimatedHours', t.estimated_hours::text,
    'actualHours', t.actual_hours::text, 'progress', t.progress::text,
    'dependsOn', t.depends_on, 'blocks', t.blocks)"
    };
}

pub(crate) async fn linked_tasks(
    db: &weldsuite_db::PgPool,
    ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(concat!(
        "select ",
        task_json!(),
        " from tasks t where t.id = any($1) and t.deleted_at is null"
    ))
    .bind(ids)
    .fetch_all(db)
    .await
}

fn id_list(task: &Value, key: &str) -> Vec<String> {
    weldsuite_flow_domain::task_dependencies::id_list(task.get(key))
}

fn present(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "predecessorId": field("predecessorId"),
        "successorId": field("successorId"),
        "type": field("type"),
        "lagDays": field("lagDays"),
        "createdBy": field("createdBy"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
    })
}

pub(crate) fn present_dependency(row: &Value) -> Value {
    present(row)
}

pub(crate) fn event_data(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "predecessorId": field("predecessorId"),
        "successorId": field("successorId"),
        "type": field("type"),
        "lagDays": field("lagDays"),
    })
}

fn publish_dependency(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        row["id"].as_str().unwrap_or_default(),
        &event_data(row),
    );
}

fn publish_linked_task(state: &FlowState, caller: &Caller, task: &Value) {
    let data = task_analytics_payload(task, &json!({}), now_ms());
    caller.publish(
        state,
        PROJECT_TASK_UPDATED,
        task["id"].as_str().unwrap_or_default(),
        &data,
    );
}

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

// ── Bodies ──────────────────────────────────────────────────────────────────

fn read_create(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("predecessorId", Presence::Required, IDENTIFIER)
        .text("successorId", Presence::Required, IDENTIFIER)
        .choice("type", Presence::Optional, &DEPENDENCY_TYPES)
        .whole(
            "lagDays",
            Presence::Optional,
            whole(-MAX_LAG_DAYS, MAX_LAG_DAYS),
        );
    Some(r.strict())
}

fn read_update(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.choice("type", Presence::Optional, &DEPENDENCY_TYPES)
        .whole(
            "lagDays",
            Presence::Optional,
            whole(-MAX_LAG_DAYS, MAX_LAG_DAYS),
        );
    let out = r.strict();
    if !out.contains_key("type") && !out.contains_key("lagDays") && issues.is_empty() {
        issues.custom_root("Give a type, a lag, or both");
    }
    Some(out)
}

struct ListQuery {
    project_id: Option<String>,
    task_id: Option<String>,
    cursor: Option<String>,
    limit: Option<String>,
}

fn list_query(raw: Option<&str>) -> Result<ListQuery, Refusal> {
    read_query(raw, |issues, f| {
        let mut get = |key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        ListQuery {
            project_id: get("projectId"),
            task_id: get("taskId"),
            cursor: get("cursor"),
            limit: get("limit"),
        }
    })
}

/// `parseLimit(raw, fallback, max)`.
fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    if q.project_id.is_none() && q.task_id.is_none() {
        return outside(Err(Refusal::bad_request(messages::LIST_SCOPE)));
    }
    let limit = parse_limit(q.limit.as_deref(), 100, 500);
    let scoped = async {
        if let Some(project_id) = &q.project_id
            && !caller.can_access(project_id).await?
        {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        if let Some(task_id) = &q.task_id {
            let found = linked_tasks(&caller.db, std::slice::from_ref(task_id)).await?;
            let Some(task) = found.first() else {
                return Err(Refusal::not_found("Task", task_id));
            };
            let allowed = match task["projectId"].as_str() {
                Some(project) => caller.can_access(project).await?,
                None => false,
            };
            if !allowed {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
        }
        Ok(())
    }
    .await;
    if let Err(refused) = scoped {
        return outside(Err(refused));
    }
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from task_dependencies where id = $1 limit 1",
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
        list_rows(&caller, &q, limit, cursor).await,
        "Failed to list dependencies",
    )
}

macro_rules! filters {
    () => {
        "($1::text is null or d.project_id = $1)
    and ($2::text is null or d.predecessor_id = $2 or d.successor_id = $2)"
    };
}

async fn list_rows(
    caller: &Caller,
    q: &ListQuery,
    limit: i64,
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(d) from task_dependencies d where ",
        filters!(),
        " and ($3::timestamptz is null or d.created_at < $3::timestamptz
                or (d.created_at = $3::timestamptz and d.id < $4))
         order by d.created_at desc, d.id desc limit $5"
    ))
    .bind(q.project_id.as_deref())
    .bind(q.task_id.as_deref())
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from task_dependencies d where ",
        filters!()
    ))
    .bind(q.project_id.as_deref())
    .bind(q.task_id.as_deref())
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
    Ok(paged(
        rows.iter().map(present).collect(),
        total,
        has_more,
        next,
    ))
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let input = match parse_body(&body, read_create) {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    if text(&input, "predecessorId") == text(&input, "successorId") {
        return outside(Err(Refusal::bad_request(messages::SELF)));
    }
    reply(
        create_link(&state, &caller, &input).await,
        "Failed to create dependency",
    )
}

async fn create_link(state: &FlowState, caller: &Caller, input: &Body) -> Reply {
    let db = &caller.db;
    let pred_id = text(input, "predecessorId").unwrap_or_default().to_owned();
    let succ_id = text(input, "successorId").unwrap_or_default().to_owned();
    let found = linked_tasks(db, &[pred_id.clone(), succ_id.clone()]).await?;
    let find = |id: &str| found.iter().find(|task| task["id"] == id).cloned();
    let Some(predecessor) = find(&pred_id) else {
        return Err(Refusal::not_found("Task", &pred_id));
    };
    let Some(successor) = find(&succ_id) else {
        return Err(Refusal::not_found("Task", &succ_id));
    };
    let (Some(pred_project), Some(succ_project)) = (
        predecessor["projectId"].as_str(),
        successor["projectId"].as_str(),
    ) else {
        return Err(Refusal::bad_request(messages::NO_PROJECT));
    };
    if !caller.can_write(pred_project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if succ_project != pred_project && !caller.can_write(succ_project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if succ_project != pred_project {
        return Err(Refusal::bad_request(messages::DIFFERENT_PROJECTS));
    }
    let existing: Option<String> = sqlx::query_scalar(
        "select id from task_dependencies where predecessor_id = $1 and successor_id = $2 limit 1",
    )
    .bind(&pred_id)
    .bind(&succ_id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Err(Refusal::conflict(messages::DUPLICATE));
    }
    if would_close_cycle(db, &pred_id, &succ_id).await? {
        return Err(Refusal::bad_request(messages::CYCLE));
    }

    let now = crate::now();
    let id = generate_id("tdp");
    let next_depends_on = with_id(&id_list(&successor, "dependsOn"), &pred_id);
    let next_blocks = with_id(&id_list(&predecessor, "blocks"), &succ_id);
    let lag = i32::try_from(input.get("lagDays").and_then(Value::as_i64).unwrap_or(0)).unwrap_or(0);
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "insert into task_dependencies
                     (id, project_id, predecessor_id, successor_id, type, lag_days, created_by, created_at, updated_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)",
            )
            .bind(id.clone())
            .bind(pred_project.to_owned())
            .bind(pred_id.clone())
            .bind(succ_id.clone())
            .bind(text(input, "type").unwrap_or("fs").to_owned())
            .bind(lag)
            .bind(caller.user_id.clone())
            .bind(now.clone()),
            sqlx::query("update tasks set depends_on = $2, updated_at = $3::timestamp where id = $1")
                .bind(succ_id.clone())
                .bind(json!(next_depends_on))
                .bind(now.clone()),
            sqlx::query("update tasks set blocks = $2, updated_at = $3::timestamp where id = $1")
                .bind(pred_id.clone())
                .bind(json!(next_blocks))
                .bind(now),
        ],
    )
    .await?;
    let Some(row) = find_dependency(db, &id).await? else {
        return Err(Refusal::Internal(
            "the new dependency is missing".to_owned(),
        ));
    };
    publish_dependency(state, caller, TASK_DEPENDENCY_CREATED, &row);
    publish_linked_task(state, caller, &predecessor);
    publish_linked_task(state, caller, &successor);
    Ok(Created(present(&row)).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_dependency(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_write(project).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        parse_body(&body, read_update)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_link(&state, &caller, &id, &input).await,
        "Failed to update dependency",
    )
}

async fn update_link(state: &FlowState, caller: &Caller, id: &str, input: &Body) -> Reply {
    let db = &caller.db;
    let lag = input
        .get("lagDays")
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok());
    sqlx::query(
        "update task_dependencies set
             type = coalesce($2, type), lag_days = coalesce($3, lag_days), updated_at = $4::timestamptz
         where id = $1",
    )
    .bind(id)
    .bind(text(input, "type"))
    .bind(lag)
    .bind(crate::now())
    .execute(db)
    .await?;
    let Some(row) = find_dependency(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_dependency(state, caller, TASK_DEPENDENCY_UPDATED, &row);
    Ok(Data(present(&row)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_link(&state, &caller, &id).await,
        "Failed to delete dependency",
    )
}

async fn remove_link(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_dependency(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    if !caller
        .can_write(existing["projectId"].as_str().unwrap_or_default())
        .await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let pred_id = existing["predecessorId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let succ_id = existing["successorId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let found = linked_tasks(db, &[pred_id.clone(), succ_id.clone()]).await?;
    let predecessor = found
        .iter()
        .find(|task| task["id"] == pred_id.as_str())
        .cloned();
    let successor = found
        .iter()
        .find(|task| task["id"] == succ_id.as_str())
        .cloned();
    let now = crate::now();
    let next_blocks = predecessor
        .as_ref()
        .map(|task| without_id(&id_list(task, "blocks"), &succ_id));
    let next_depends_on = successor
        .as_ref()
        .map(|task| without_id(&id_list(task, "dependsOn"), &pred_id));
    let mut statements =
        vec![sqlx::query("delete from task_dependencies where id = $1").bind(id.to_owned())];
    if let Some(blocks) = &next_blocks {
        statements.push(
            sqlx::query("update tasks set blocks = $2, updated_at = $3::timestamp where id = $1")
                .bind(pred_id.clone())
                .bind(json!(blocks))
                .bind(now.clone()),
        );
    }
    if let Some(depends_on) = &next_depends_on {
        statements.push(
            sqlx::query(
                "update tasks set depends_on = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(succ_id.clone())
            .bind(json!(depends_on))
            .bind(now),
        );
    }
    weldsuite_db::atomically(db, statements).await?;
    publish_dependency(state, caller, TASK_DEPENDENCY_DELETED, &existing);
    if let (Some(task), Some(_)) = (&predecessor, &next_blocks) {
        publish_linked_task(state, caller, task);
    }
    if let (Some(task), Some(_)) = (&successor, &next_depends_on) {
        publish_linked_task(state, caller, task);
    }
    Ok(NoContent.into_response())
}
