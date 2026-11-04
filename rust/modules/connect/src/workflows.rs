//! `/api/workflows` (`routes/workflows/index.ts`, `services/workflows.ts`):
//! workflow CRUD, status, duplicate, stats, metrics, Test runs and manual
//! runs, behind the WeldConnect activation gate. `POST /generate` (AI) is
//! not served.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{WORKFLOW_CREATED, WORKFLOW_DELETED, WORKFLOW_UPDATED};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::mvp::{
    Issue, SEQUENCE_WORKFLOW_TAG, is_sequence_workflow, validate_integrations, validate_workflow,
    workflow_complete_sources,
};
use crate::schemas::{WorkflowBody, json_list, json_tags, workflow_body};
use crate::sync::{SyncContext, sync_schedules, sync_webhooks, write_trigger_index};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

/// A `workflows` row as Drizzle reads it (`numeric` as text).
pub(crate) const ROW: &str =
    "to_jsonb(w) || jsonb_build_object('average_execution_time', w.average_execution_time::text)";

/// `notSequenceWorkflow` over the alias `w`.
pub(crate) const NOT_SEQUENCE: &str = "not (coalesce(w.tags, '[]'::jsonb) ? '__type:sequence')";

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    let create = || gate.require([perm::WORKFLOWS_CREATE]);
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    let delete = || gate.require([perm::WORKFLOWS_DELETE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_route).route_layer(create()))
        .route("/stats", get(stats).route_layer(read()))
        .route("/for-chaining", get(for_chaining).route_layer(read()))
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update_route)
                .patch(update_route)
                .route_layer(update()),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete_route).route_layer(delete()),
        )
        .route("/{id}/metrics", get(metrics).route_layer(read()))
        .route("/{id}/status", patch(status_route).route_layer(update()))
        .route("/{id}/duplicate", post(duplicate).route_layer(create()))
        .route("/{id}/test", post(test_run).route_layer(create()))
        .route("/{id}/trigger", post(trigger_run).route_layer(create()))
}

/// `getWorkflow(db, id)`: a live workflow.
pub(crate) async fn get_workflow(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {ROW} from workflows w where w.id = $1 and w.deleted_at is null limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

fn split_tags(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let search = query_truthy(query, "search").map(|s| format!("%{s}%"));
    let status = query_truthy(query, "status");
    let folder = query_truthy(query, "folderId");
    let tags = split_tags(query_param(query, "tags").as_deref());
    let exclude = split_tags(query_param(query, "excludeTags").as_deref());
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "w.deleted_at is null
        and ($1::text is null or (w.name like $1 or w.description like $1))
        and ($2::text is null or w.status = $2)
        and ($3::text is null or w.folder_id = $3)
        and not exists (select 1 from unnest($4::text[]) tag where not (coalesce(w.tags, '[]'::jsonb) ? tag))
        and not exists (select 1 from unnest($5::text[]) tag where coalesce(w.tags, '[]'::jsonb) ? tag)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {ROW} from workflows w where {FILTER} and ($6::text is null or w.id < $6)
         order by w.updated_at desc, w.id desc limit $7"
    )))
    .bind(&search)
    .bind(&status)
    .bind(&folder)
    .bind(&tags)
    .bind(&exclude)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflows w where {FILTER}"
    )))
    .bind(&search)
    .bind(&status)
    .bind(&folder)
    .bind(&tags)
    .bind(&exclude)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflows"),
    }
}

async fn stats(caller: Caller) -> Response {
    let counts: Result<(i64, i64, i64, i64, i64), sqlx::Error> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select count(*), count(*) filter (where status = 'active'), count(*) filter (where status = 'draft'),
                count(*) filter (where status = 'paused'), count(*) filter (where status = 'archived')
         from workflows w where w.deleted_at is null and {NOT_SEQUENCE}"
    )))
    .fetch_one(&caller.db)
    .await;
    let runs: Result<(i64, i64, i64, i64, i64), sqlx::Error> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select count(*), count(*) filter (where status = 'running'), count(*) filter (where status = 'completed'),
                count(*) filter (where status = 'failed'), count(*) filter (where status = 'queued')
         from workflow_executions e where {} and {}",
        crate::executions::NOT_SEQUENCE_RUN,
        crate::executions::NOT_TEST_RUN
    )))
    .fetch_one(&caller.db)
    .await;
    match (counts, runs) {
        (Ok((total, active, draft, paused, archived)), Ok((ex_total, running, completed, failed, queued))) => {
            Data(json!({
                "totalWorkflows": total,
                "activeWorkflows": active,
                "draftWorkflows": draft,
                "pausedWorkflows": paused,
                "totalExecutions": ex_total,
                "successfulExecutions": completed,
                "failedExecutions": failed,
                "pendingExecutions": queued + running,
                "workflows": { "total": total, "active": active, "draft": draft, "paused": paused, "archived": archived },
                "executions": { "total": ex_total, "running": running, "completed": completed, "failed": failed, "queued": queued },
            }))
            .into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to get workflow stats"),
    }
}

async fn for_chaining(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let exclude = query_truthy(query.as_deref(), "exclude");
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status) from workflows w
         where w.deleted_at is null and {NOT_SEQUENCE} and ($1::text is null or w.id != $1)
         order by w.name"
    )))
    .bind(&exclude)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to list workflows for chaining"),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_workflow(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Workflow", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow"),
    }
}

async fn metrics(caller: Caller, Path(id): Path<String>) -> Response {
    let found = async {
        let Some(workflow) = get_workflow(&caller.db, &id).await? else {
            return Ok::<_, sqlx::Error>(None);
        };
        let recent: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(e) from workflow_executions e where e.workflow_id = $1
             order by e.started_at desc limit 10",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        let average = workflow["averageExecutionTime"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(Some(json!({
            "totalExecutions": workflow["executionCount"].as_i64().unwrap_or(0),
            "successCount": workflow["successCount"].as_i64().unwrap_or(0),
            "failureCount": workflow["failureCount"].as_i64().unwrap_or(0),
            "averageExecutionTime": number_json(average),
            "recentExecutions": recent.into_iter().map(js_row).collect::<Vec<_>>(),
        })))
    };
    match found.await {
        Ok(Some(metrics)) => Data(metrics).into_response(),
        Ok(None) => ApiError::not_found("Workflow", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to get workflow metrics"),
    }
}

/// A number as JSON the way JavaScript prints it (integral values without
/// a fraction).
fn number_json(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        return json!(value as i64);
    }
    json!(value)
}

/// `rejectUnsupportedActivation(c, workflow, workflowId)`: the 400 when the
/// workflow may not go live.
pub(crate) async fn reject_activation(
    db: &PgPool,
    triggers: Option<&Value>,
    steps: Option<&Value>,
    tags: Option<&Value>,
    workflow_id: Option<&str>,
) -> Result<Option<Response>, sqlx::Error> {
    if is_sequence_workflow(tags) {
        return Ok(None);
    }
    let mut issues = validate_workflow(triggers, steps, workflow_id);
    issues.extend(missing_source_workflows(db, triggers).await?);
    let has_provider_step = crate::js::array(steps).iter().any(|s| {
        s.get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| t.contains('.'))
    });
    if has_provider_step {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "select id, type, status from workflow_integrations where deleted_at is null",
        )
        .fetch_all(db)
        .await?;
        issues.extend(validate_integrations(steps, &rows));
    }
    if issues.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        ApiError::bad_request(
            "This workflow cannot be activated: it uses unsupported or incomplete triggers or actions",
        )
        .with_details(json!({
            "reason": "weldconnect_unsupported",
            "issues": issues.iter().map(Issue::to_json).collect::<Vec<_>>(),
        }))
        .into_response(),
    ))
}

/// `findMissingSourceWorkflows(db, triggers)`.
async fn missing_source_workflows(
    db: &PgPool,
    triggers: Option<&Value>,
) -> Result<Vec<Issue>, sqlx::Error> {
    let sources = workflow_complete_sources(triggers);
    if sources.is_empty() {
        return Ok(vec![]);
    }
    let mut ids: Vec<String> = Vec::new();
    for (_, source) in &sources {
        if !ids.contains(source) {
            ids.push(source.clone());
        }
    }
    let existing: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select w.id from workflows w where w.id = any($1) and w.deleted_at is null and {NOT_SEQUENCE}"
    )))
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(sources
        .into_iter()
        .filter(|(_, source)| !existing.contains(source))
        .map(|(trigger_id, _)| Issue {
            code: "unknown_source_workflow",
            trigger_id,
            kind: Some("workflow_complete".into()),
            ..Issue::default()
        })
        .collect())
}

/// `createWorkflow(db, data, userId, scheduleSync, webhookSync)`'s input.
#[derive(Debug, Default)]
pub(crate) struct NewWorkflow {
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) status: String,
    pub(crate) triggers: Value,
    pub(crate) steps: Value,
    pub(crate) settings: Value,
    pub(crate) tags: Value,
    pub(crate) folder_id: Option<String>,
    pub(crate) template_id: Option<String>,
}

/// `createWorkflow`: the row and its trigger index in one transaction, then
/// the schedule and webhook syncs.
pub(crate) async fn create_workflow(
    db: &PgPool,
    ctx: &SyncContext,
    data: NewWorkflow,
    user_id: &str,
) -> Result<String, crate::sync::SyncError> {
    let id = generate_id("wf");
    let stamp = now();
    let active = data.status == "active";
    {
        let id = id.clone();
        let user_id = user_id.to_owned();
        let triggers = data.triggers.clone();
        let data = &data;
        let name = data.name.clone();
        let description = data.description.clone();
        let status = data.status.clone();
        let steps = data.steps.clone();
        let settings = data.settings.clone();
        let tags = data.tags.clone();
        let folder_id = data.folder_id.clone();
        let template_id = data.template_id.clone();
        weldsuite_db::atomically_with(db, move |conn| {
            Box::pin(async move {
                sqlx::query(
                    "insert into workflows
                        (id, name, description, status, triggers, steps, settings, tags, folder_id,
                         template_id, created_by, version, execution_count, success_count,
                         failure_count, created_at, updated_at)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 0, 0, 0,
                             $12::timestamp, $12::timestamp)",
                )
                .bind(&id)
                .bind(&name)
                .bind(&description)
                .bind(&status)
                .bind(&triggers)
                .bind(&steps)
                .bind(&settings)
                .bind(&tags)
                .bind(&folder_id)
                .bind(&template_id)
                .bind(&user_id)
                .bind(&stamp)
                .execute(&mut *conn)
                .await?;
                write_trigger_index(conn, &id, Some(&triggers), active).await
            })
        })
        .await?;
    }
    sync_schedules(db, ctx, &id, None, Some(&data.triggers), active).await?;
    sync_webhooks(db, ctx, &id, None, Some(&data.triggers)).await?;
    Ok(id)
}

/// The fields of an update that were sent (`data[k] !== undefined`), by
/// their camelCase name.
pub(crate) type WorkflowUpdate = Map<String, Value>;

fn field_value<T: serde::Serialize>(field: &Field<T>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(value) => serde_json::to_value(value).ok(),
    }
}

fn update_of(body: &WorkflowBody) -> WorkflowUpdate {
    let mut out = Map::new();
    let pairs = [
        ("name", field_value(&body.name)),
        ("description", field_value(&body.description)),
        ("status", field_value(&body.status)),
        ("triggers", json_list(&body.triggers)),
        ("steps", json_list(&body.steps)),
        ("settings", field_value(&body.settings)),
        ("tags", json_tags(&body.tags)),
        ("folderId", field_value(&body.folder_id)),
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    }
    out
}

/// `updateWorkflow(db, id, data, scheduleSync, webhookSync)`: `false` when
/// the workflow is gone.
pub(crate) async fn update_workflow(
    db: &PgPool,
    ctx: &SyncContext,
    id: &str,
    data: &WorkflowUpdate,
) -> Result<bool, crate::sync::SyncError> {
    let Some(existing) = get_workflow(db, id).await? else {
        return Ok(false);
    };
    let next_status = data
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| existing["status"].as_str())
        .unwrap_or_default()
        .to_owned();
    let next_triggers = data
        .get("triggers")
        .unwrap_or(&existing["triggers"])
        .clone();
    let active = next_status == "active";
    {
        let id = id.to_owned();
        let data = data.clone();
        let triggers = next_triggers.clone();
        let stamp = now();
        weldsuite_db::atomically_with(db, move |conn| {
            Box::pin(async move {
                let set = |k: &str| data.contains_key(k);
                let value = |k: &str| data.get(k).cloned().unwrap_or(Value::Null);
                let text = |k: &str| data.get(k).and_then(Value::as_str).map(str::to_owned);
                sqlx::query(
                    "update workflows set updated_at = $2::timestamp,
                        name = case when $3 then $4 else name end,
                        description = case when $5 then $6 else description end,
                        status = case when $7 then $8 else status end,
                        triggers = case when $9 then $10 else triggers end,
                        steps = case when $11 then $12 else steps end,
                        settings = case when $13 then $14 else settings end,
                        tags = case when $15 then $16 else tags end,
                        folder_id = case when $17 then $18 else folder_id end
                     where id = $1",
                )
                .bind(&id)
                .bind(&stamp)
                .bind(set("name"))
                .bind(text("name"))
                .bind(set("description"))
                .bind(text("description"))
                .bind(set("status"))
                .bind(text("status"))
                .bind(set("triggers"))
                .bind(value("triggers"))
                .bind(set("steps"))
                .bind(value("steps"))
                .bind(set("settings"))
                .bind(value("settings"))
                .bind(set("tags"))
                .bind(value("tags"))
                .bind(set("folderId"))
                .bind(text("folderId"))
                .execute(&mut *conn)
                .await?;
                write_trigger_index(conn, &id, Some(&triggers), active).await
            })
        })
        .await?;
    }
    sync_schedules(
        db,
        ctx,
        id,
        Some(&existing["triggers"]),
        Some(&next_triggers),
        active,
    )
    .await?;
    sync_webhooks(
        db,
        ctx,
        id,
        Some(&existing["triggers"]),
        Some(&next_triggers),
    )
    .await?;
    Ok(true)
}

/// `{ id, name }` / `{ id, name, status }` event data.
fn event(id: &str, name: &Value, status: Option<&Value>) -> Value {
    match status {
        Some(status) => json!({ "id": id, "name": name, "status": status }),
        None => json!({ "id": id, "name": name }),
    }
}

async fn create_route(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| workflow_body(issues, b, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create workflow"),
    };
    let status = data
        .status
        .as_set()
        .cloned()
        .unwrap_or_else(|| "draft".into());
    let triggers = json_list(&data.triggers);
    let steps = json_list(&data.steps);
    let tags = json_tags(&data.tags);
    if status == "active" {
        match reject_activation(
            &caller.db,
            triggers.as_ref(),
            steps.as_ref(),
            tags.as_ref(),
            None,
        )
        .await
        {
            Ok(Some(rejection)) => return rejection,
            Ok(None) => {}
            Err(error) => return internal(&error, "Failed to create workflow"),
        }
    }
    let ctx = SyncContext::for_caller(&caller, &state);
    let name = data.name.as_set().cloned().unwrap_or_default();
    let settings = data.settings.as_set().cloned();
    let new = NewWorkflow {
        name: name.clone(),
        description: data.description.as_set().cloned(),
        status: if status.is_empty() {
            "draft".into()
        } else {
            status.clone()
        },
        triggers: triggers.clone().unwrap_or_else(|| json!([])),
        steps: steps.clone().unwrap_or_else(|| json!([])),
        settings: settings.clone().unwrap_or_else(|| json!({})),
        tags: tags.unwrap_or_else(|| json!([])),
        folder_id: data.folder_id.as_set().cloned(),
        template_id: None,
    };
    let created = create_workflow(&caller.db, &ctx, new, &caller.user_id).await;
    let id = match created {
        Ok(id) => id,
        Err(error) => return internal(&error, "Failed to create workflow"),
    };
    if status == "active" {
        crate::versions::snapshot_quietly(
            &caller.db,
            crate::versions::Snapshot {
                workflow_id: &id,
                name: &json!(name),
                status: &json!("active"),
                triggers: triggers.as_ref(),
                steps: steps.as_ref(),
                settings: settings.as_ref(),
                created_by: Some(&caller.user_id),
                reason: "activated",
                restored_from: None,
                note: None,
            },
        )
        .await;
    }
    caller.publish(
        &state,
        WORKFLOW_CREATED,
        &id,
        &json!({ "id": id, "name": name }),
    );
    Created(json!({ "id": id })).into_response()
}

async fn update_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| workflow_body(issues, b, true)) {
        Ok(data) => update_of(&data),
        Err(refusal) => return refusal.respond("Failed to update workflow"),
    };
    let result = async {
        let Some(existing) = get_workflow(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow", &id));
        };
        let next_status = data
            .get("status")
            .and_then(Value::as_str)
            .or_else(|| existing["status"].as_str())
            .unwrap_or_default();
        let was_active = existing["status"].as_str() == Some("active");
        let activating = next_status == "active" && !was_active;
        let flow_changed = data.contains_key("triggers") || data.contains_key("steps");
        if next_status == "active" && (activating || flow_changed) {
            let pick = |k: &str| {
                data.get(k)
                    .filter(|v| !v.is_null())
                    .or_else(|| existing.get(k))
            };
            if let Some(rejection) = reject_activation(
                &caller.db,
                pick("triggers"),
                pick("steps"),
                pick("tags"),
                Some(&id),
            )
            .await?
            {
                return Err(rejection.into());
            }
        }
        let ctx = SyncContext::for_caller(&caller, &state);
        if !update_workflow(&caller.db, &ctx, &id, &data)
            .await
            .map_err(sync_refusal)?
        {
            return Err(Refusal::not_found("Workflow", &id));
        }
        let after = get_workflow(&caller.db, &id).await?;
        let content_changed = ["name", "triggers", "steps", "settings"]
            .iter()
            .any(|k| data.contains_key(*k));
        if let Some(after) = &after
            && after["status"].as_str() == Some("active")
            && (activating || content_changed)
        {
            crate::versions::snapshot_quietly(
                &caller.db,
                crate::versions::Snapshot {
                    workflow_id: &id,
                    name: &after["name"],
                    status: &after["status"],
                    triggers: after.get("triggers"),
                    steps: after.get("steps"),
                    settings: after.get("settings"),
                    created_by: Some(&caller.user_id),
                    reason: if activating { "activated" } else { "saved" },
                    restored_from: None,
                    note: None,
                },
            )
            .await;
        }
        let name = after.as_ref().map_or(json!(""), |a| a["name"].clone());
        let status = after.as_ref().map_or(Value::Null, |a| a["status"].clone());
        caller.publish(
            &state,
            WORKFLOW_UPDATED,
            &id,
            &event(&id, &name, Some(&status)),
        );
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal| refusal.respond("Failed to update workflow"))
}

/// A sync failure as the route's 500.
pub(crate) fn sync_refusal(error: crate::sync::SyncError) -> Refusal {
    match error {
        crate::sync::SyncError::Database(error) => Refusal::Database(error),
        crate::sync::SyncError::Registry(error) => {
            tracing::error!(%error, "[connect-api] webhook registry failed");
            Refusal::Database(sqlx::Error::Protocol(error.to_string()))
        }
    }
}

impl From<crate::sync::SyncError> for Refusal {
    fn from(error: crate::sync::SyncError) -> Self {
        sync_refusal(error)
    }
}

async fn status_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let status = match validate(&headers, &body, |issues, b| {
        issues
            .choice(
                b,
                "status",
                Presence::Required,
                &["draft", "active", "paused", "archived"],
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(status) => status,
        Err(refusal) => return refusal.respond("Failed to update workflow status"),
    };
    let result = async {
        let mut activating = false;
        if status == "active" {
            let Some(existing) = get_workflow(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Workflow", &id));
            };
            if let Some(rejection) = reject_activation(
                &caller.db,
                existing.get("triggers"),
                existing.get("steps"),
                existing.get("tags"),
                Some(&id),
            )
            .await?
            {
                return Err(rejection.into());
            }
            activating = existing["status"].as_str() != Some("active");
        }
        let ctx = SyncContext::for_caller(&caller, &state);
        let Some(existing) = get_workflow(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow", &id));
        };
        let active = status == "active";
        {
            let id = id.clone();
            let status = status.clone();
            let triggers = existing["triggers"].clone();
            let stamp = now();
            weldsuite_db::atomically_with(&caller.db, move |conn| {
                Box::pin(async move {
                    sqlx::query("update workflows set status = $2, updated_at = $3::timestamp where id = $1")
                        .bind(&id)
                        .bind(&status)
                        .bind(&stamp)
                        .execute(&mut *conn)
                        .await?;
                    write_trigger_index(conn, &id, Some(&triggers), active).await
                })
            })
            .await?;
        }
        sync_schedules(
            &caller.db,
            &ctx,
            &id,
            existing.get("triggers"),
            existing.get("triggers"),
            active,
        )
        .await?;
        let after = get_workflow(&caller.db, &id).await?;
        if active
            && activating
            && let Some(after) = &after
        {
            crate::versions::snapshot_quietly(
                &caller.db,
                crate::versions::Snapshot {
                    workflow_id: &id,
                    name: &after["name"],
                    status: &after["status"],
                    triggers: after.get("triggers"),
                    steps: after.get("steps"),
                    settings: after.get("settings"),
                    created_by: Some(&caller.user_id),
                    reason: "activated",
                    restored_from: None,
                    note: None,
                },
            )
            .await;
        }
        let name = after.as_ref().map_or(json!(""), |a| a["name"].clone());
        caller.publish(
            &state,
            WORKFLOW_UPDATED,
            &id,
            &event(&id, &name, Some(&json!(status))),
        );
        Ok(Data(json!({ "id": id, "status": status })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal| refusal.respond("Failed to update workflow status"))
}

async fn duplicate(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let name = body
        .get("name")
        .filter(|n| crate::js::truthy(n))
        .map(|n| crate::js::js_string(Some(n)));
    let result = async {
        let Some(original) = get_workflow(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow", &id));
        };
        let new_id = generate_id("wf");
        let name = name
            .unwrap_or_else(|| format!("{} (Copy)", original["name"].as_str().unwrap_or_default()));
        let or = |key: &str, fallback: Value| match original.get(key) {
            Some(Value::Null) | None => fallback,
            Some(value) => value.clone(),
        };
        {
            let new_id = new_id.clone();
            let name = name.clone();
            let description = original["description"].as_str().map(str::to_owned);
            let triggers = or("triggers", json!([]));
            let steps = or("steps", json!([]));
            let settings = or("settings", json!({}));
            let tags = or("tags", json!([]));
            let folder_id = original["folderId"].as_str().map(str::to_owned);
            let user_id = caller.user_id.clone();
            let stamp = now();
            weldsuite_db::atomically_with(&caller.db, move |conn| {
                Box::pin(async move {
                    sqlx::query(
                        "insert into workflows
                            (id, name, description, status, triggers, steps, settings, tags, folder_id,
                             created_by, version, execution_count, success_count, failure_count,
                             created_at, updated_at)
                         values ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, 1, 0, 0, 0,
                                 $10::timestamp, $10::timestamp)",
                    )
                    .bind(&new_id)
                    .bind(&name)
                    .bind(&description)
                    .bind(&triggers)
                    .bind(&steps)
                    .bind(&settings)
                    .bind(&tags)
                    .bind(&folder_id)
                    .bind(&user_id)
                    .bind(&stamp)
                    .execute(&mut *conn)
                    .await?;
                    write_trigger_index(conn, &new_id, Some(&triggers), false).await
                })
            })
            .await?;
        }
        let after = get_workflow(&caller.db, &new_id).await?;
        let name = after.as_ref().map_or(json!(""), |a| a["name"].clone());
        let status = after.as_ref().map_or(Value::Null, |a| a["status"].clone());
        caller.publish(
            &state,
            WORKFLOW_CREATED,
            &new_id,
            &event(&new_id, &name, Some(&status)),
        );
        Ok(Created(json!({ "id": new_id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to duplicate workflow"))
}

/// `deleteWorkflow(db, id, scheduleSync, webhookSync)`.
pub(crate) async fn delete_workflow(
    db: &PgPool,
    ctx: &SyncContext,
    id: &str,
) -> Result<(), crate::sync::SyncError> {
    let existing: Option<Value> = sqlx::query_scalar(
        "select coalesce(triggers, 'null'::jsonb) from workflows where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    {
        let id = id.to_owned();
        let stamp = now();
        weldsuite_db::atomically_with(db, move |conn| {
            Box::pin(async move {
                sqlx::query(
                    "update workflows set deleted_at = $2::timestamp, updated_at = $2::timestamp
                     where id = $1 and deleted_at is null",
                )
                .bind(&id)
                .bind(&stamp)
                .execute(&mut *conn)
                .await?;
                sqlx::query("delete from workflow_trigger_index where workflow_id = $1")
                    .bind(&id)
                    .execute(&mut *conn)
                    .await?;
                Ok::<_, sqlx::Error>(())
            })
        })
        .await?;
    }
    if let Some(triggers) = existing {
        sync_schedules(db, ctx, id, Some(&triggers), None, false).await?;
        sync_webhooks(db, ctx, id, Some(&triggers), None).await?;
    }
    Ok(())
}

async fn delete_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = get_workflow(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow", &id));
        };
        let ctx = SyncContext::for_caller(&caller, &state);
        delete_workflow(&caller.db, &ctx, &id).await?;
        caller.publish(
            &state,
            WORKFLOW_DELETED,
            &id,
            &event(&id, &existing["name"], Some(&existing["status"])),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow"))
}

/// `triggerWorkflowSchema`: `(testData, data, triggerType)`.
fn trigger_body(
    issues: &mut weldsuite_kit::validation::Issues,
    b: &Map<String, Value>,
) -> (Option<Value>, Option<Value>, Option<String>) {
    let record = |issues: &mut weldsuite_kit::validation::Issues, key: &str| {
        issues
            .nested(b, key, Presence::Optional, |_, fields| {
                Value::Object(fields.clone())
            })
            .into_option()
    };
    let test_data = record(issues, "testData");
    let data = record(issues, "data");
    let trigger_type = issues
        .choice(
            b,
            "triggerType",
            Presence::Optional,
            &[
                "manual",
                "schedule",
                "webhook",
                "entity_event",
                "integration_event",
                "api",
                "workflow_complete",
            ],
        )
        .into_option();
    (test_data, data, trigger_type)
}

async fn test_run(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (test_data, data, trigger_type) = match validate(&headers, &body, trigger_body) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to test workflow"),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("Organization context required").into_response();
    };
    let Some(runs) = caller.overrides.runs(&state) else {
        return ApiError::internal()
            .with_message("Workflow runtime not available")
            .into_response();
    };
    let test_data = test_data.or(data);
    match crate::executions::start_test_run(
        &caller.db,
        runs.as_ref(),
        &org_id,
        &caller.user_id,
        &id,
        test_data,
        trigger_type.as_deref(),
    )
    .await
    {
        Ok(Some(started)) => Data(json!({
            "executionId": started.execution_id,
            "instanceId": started.instance_id,
            "triggerType": started.trigger_type,
            "isTest": true,
        }))
        .into_response(),
        Ok(None) => ApiError::not_found("Workflow", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to test workflow"),
    }
}

async fn trigger_run(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (test_data, data, _) = match validate(&headers, &body, trigger_body) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to trigger workflow"),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("Organization context required").into_response();
    };
    let Some(runs) = caller.overrides.runs(&state) else {
        return ApiError::internal()
            .with_message("Workflow runtime not available")
            .into_response();
    };
    let source = if id.starts_with("hwf_") {
        "helpdesk"
    } else {
        "task"
    };
    let params = json!({
        "workspaceId": org_id,
        "userId": caller.user_id,
        "workflowId": id,
        "triggerType": "manual",
        "triggerData": data.or(test_data).unwrap_or_else(|| json!({})),
        "source": source,
    });
    match runs.create(&params).await {
        Ok(instance) => {
            Data(json!({ "executionId": instance, "instanceId": instance })).into_response()
        }
        Err(error) => internal(&error, "Failed to trigger workflow"),
    }
}

/// The CRM sequence tag, re-exported for the routes that filter on it.
#[allow(dead_code)]
pub(crate) const SEQUENCE_TAG: &str = SEQUENCE_WORKFLOW_TAG;
