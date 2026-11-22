//! `/api/workflow-executions` (`routes/workflow-executions/index.ts`,
//! `services/workflow-executions.ts`, `services/workflow-approvals.ts`):
//! runs, their steps and logs, analytics, cancel, retry and approvals, and
//! `startRun`, which every dispatcher starts a run through.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Alias, Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_EXECUTION_CANCELLED, WORKFLOW_EXECUTION_CREATED, WORKFLOW_EXECUTION_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Presence, Text, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    workflow_execution_steps as steps_table, workflow_executions as runs_table, workflows,
    workspace_members,
};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy};
use crate::runs::{RESUME_SIGNAL, WorkflowRuns};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

/// `coalesce(<tags>, '[]'::jsonb) ? '__type:sequence'`: the tags of a
/// WeldReach sequence's workflow. The tags are a jsonb array of strings, so
/// containment (`@> '["__type:sequence"]'`) is the same test; it is written
/// with an operator, not `jsonb_exists(…)`, because Postgres estimates an
/// operator as it does `?` and a function call differently, and the plan
/// decides the order of rows that tie on `started_at`.
pub(crate) fn sequence_tagged(tags: Expr) -> Expr {
    pg::PgExpr::contains(
        Expr::from(Func::coalesce([tags, Expr::val(json!([]))])),
        Expr::val(json!(["__type:sequence"])),
    )
}

/// `notSequence` over `workflows`: not a sequence's workflow.
pub(crate) fn not_sequence() -> Expr {
    sea_orm::ExprTrait::not(sequence_tagged(Expr::col((
        workflows::Entity,
        workflows::Column::Tags,
    ))))
}

/// `not exists (select 1 from workflows sw where sw.id = <workflow id> and
/// <sw is a sequence>)`.
pub(crate) fn not_sequence_of(workflow_id: Expr) -> Expr {
    let sw = Alias::new("sw");
    Expr::not_exists(
        Query::select()
            .expr(Expr::val(1))
            .from_as(workflows::Entity, sw.clone())
            .and_where(sea_orm::ExprTrait::eq(
                Expr::col((sw.clone(), workflows::Column::Id)),
                workflow_id,
            ))
            .and_where(sequence_tagged(Expr::col((sw, workflows::Column::Tags))))
            .to_owned(),
    )
}

/// `notSequenceRun` over `workflow_executions`.
pub(crate) fn not_sequence_run() -> Expr {
    not_sequence_of(Expr::col((
        runs_table::Entity,
        runs_table::Column::WorkflowId,
    )))
}

/// `coalesce(<execution_context>->>'isTest', 'false')`.
pub(crate) fn test_flag(execution_context: Expr) -> Expr {
    Func::coalesce([
        pg::PgExpr::cast_json_field(execution_context, "isTest"),
        Expr::val("false"),
    ])
    .into()
}

/// `notTestRun` over `workflow_executions`.
pub(crate) fn not_test_run() -> Expr {
    sea_orm::ExprTrait::ne(
        test_flag(Expr::col((
            runs_table::Entity,
            runs_table::Column::ExecutionContext,
        ))),
        "true",
    )
}

/// A row as Drizzle returns it.
pub(crate) fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// Rows as Drizzle returns them.
fn js_rows<M: serde::Serialize>(models: Vec<M>) -> Result<Vec<Value>, DbErr> {
    models.into_iter().map(js).collect()
}

/// An ISO time as `$n::timestamp` reads it; `None` where Postgres would
/// refuse it.
fn timestamp_of(iso: &str) -> Option<PrimitiveDateTime> {
    let ms = crate::cron::parse_ms(iso)?;
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()?;
    Some(utc_timestamp(at))
}

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOW_EXECUTIONS_READ]);
    let update = || gate.require([perm::WORKFLOW_EXECUTIONS_UPDATE]);
    let create = || gate.require([perm::WORKFLOWS_CREATE]);
    let delete = || gate.require([perm::WORKFLOWS_DELETE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_route).route_layer(create()))
        .route("/recent", get(recent).route_layer(read()))
        .route("/trends", get(trends).route_layer(read()))
        .route("/slow", get(slow).route_layer(read()))
        .route("/{id}", get(get_one).route_layer(read()))
        .route("/{id}", patch(update_route).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(delete_route).route_layer(delete()),
        )
        .route("/{id}/steps", get(steps).route_layer(read()))
        .route("/{id}/logs", get(logs).route_layer(read()))
        .route("/{id}/cancel", patch(cancel).route_layer(update()))
        .route("/{id}/approval", get(approval).route_layer(read()))
        .route("/{id}/decision", post(decision).route_layer(read()))
        .route("/{id}/retry", post(retry).route_layer(create()))
}

async fn get_execution(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    runs_table::Entity::find_by_id(id)
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let statuses: Vec<String> = query_param(query, "status")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let trigger_type = query_truthy(query, "triggerType");
    let date_param = |name: &str| -> Result<Option<String>, ()> {
        match query_truthy(query, name) {
            None => Ok(None),
            Some(text) => js_date_iso(&text).map(Some).ok_or(()),
        }
    };
    let (Ok(start), Ok(end)) = (date_param("startDate"), date_param("endDate")) else {
        return internal(&"Invalid time value", "Failed to list workflow executions");
    };
    let cursor = query_truthy(query, "cursor");
    let parsed = |text: Option<String>| match text {
        None => Some(None),
        Some(text) => timestamp_of(&text).map(Some),
    };
    let (Some(start), Some(end)) = (parsed(start), parsed(end)) else {
        return internal(
            &"date/time field value out of range",
            "Failed to list workflow executions",
        );
    };
    let mut filtered = runs_table::Entity::find().filter(match &workflow_id {
        Some(workflow_id) => runs_table::Column::WorkflowId.eq(workflow_id),
        None => not_sequence_run(),
    });
    if !statuses.is_empty() {
        filtered = filtered.filter(runs_table::Column::Status.is_in(statuses.clone()));
    }
    if let Some(trigger_type) = &trigger_type {
        filtered = filtered.filter(runs_table::Column::TriggerType.eq(trigger_type));
    }
    if let Some(start) = start {
        filtered = filtered.filter(runs_table::Column::StartedAt.gte(start));
    }
    if let Some(end) = end {
        filtered = filtered.filter(runs_table::Column::StartedAt.lte(end));
    }
    let db = orm(&caller.db);
    let mut rows = filtered.clone();
    if let Some(cursor) = &cursor {
        rows = rows.filter(runs_table::Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(runs_table::Column::StartedAt)
        .order_by_desc(runs_table::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await
        .and_then(js_rows);
    let count = filtered.count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows, limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow executions"),
    }
}

async fn recent(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let limit = page_limit(query.as_deref(), 10, 100);
    let rows = runs_table::Entity::find()
        .filter(not_sequence_run())
        .order_by_desc(runs_table::Column::StartedAt)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to fetch recent executions"),
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

async fn trends(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let period = query_param(query.as_deref(), "period").unwrap_or_else(|| "week".into());
    let days = match period.as_str() {
        "day" => 1,
        "month" => 30,
        "year" => 365,
        _ => 7,
    };
    let now_ms = i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default();
    let Some(start) =
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms - days * DAY_MS) * 1_000_000)
            .ok()
            .map(utc_timestamp)
    else {
        return internal(
            &"invalid input syntax for type timestamp",
            "Failed to fetch execution trends",
        );
    };
    let rows: Result<Vec<(String, Option<PrimitiveDateTime>)>, DbErr> = runs_table::Entity::find()
        .select_only()
        .columns([runs_table::Column::Status, runs_table::Column::StartedAt])
        .filter(runs_table::Column::StartedAt.gte(start))
        .filter(not_sequence_run())
        .filter(not_test_run())
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to fetch execution trends"),
    };
    let mut buckets: Vec<(String, i64, i64, i64)> = Vec::new();
    for (status, started_at) in rows {
        // `to_char(started_at, 'YYYY-MM-DD')`.
        let Some(day) = started_at.map(|at| {
            let date = at.date();
            format!(
                "{:04}-{:02}-{:02}",
                date.year(),
                u8::from(date.month()),
                date.day()
            )
        }) else {
            continue;
        };
        let date = if period == "year" {
            format!("{}-01", &day[..7])
        } else {
            day
        };
        let index = if let Some(index) = buckets.iter().position(|(d, ..)| *d == date) {
            index
        } else {
            buckets.push((date, 0, 0, 0));
            buckets.len() - 1
        };
        let bucket = &mut buckets[index];
        bucket.1 += 1;
        match status.as_str() {
            "completed" => bucket.2 += 1,
            "failed" => bucket.3 += 1,
            _ => {}
        }
    }
    buckets.sort_by(|a, b| a.0.cmp(&b.0));
    let trends: Vec<Value> = buckets
        .into_iter()
        .map(|(date, total, success, failure)| {
            json!({ "date": date, "total": total, "success": success, "failure": failure })
        })
        .collect();
    Data(json!({ "trends": trends })).into_response()
}

async fn slow(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let limit = page_limit(query.as_deref(), 10, 50);
    let rows = runs_table::Entity::find()
        .filter(runs_table::Column::Status.eq("completed"))
        .filter(runs_table::Column::Duration.is_not_null())
        .filter(not_sequence_run())
        .filter(not_test_run())
        .order_by_desc(runs_table::Column::Duration)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to fetch slow executions"),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_execution(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Workflow execution", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow execution"),
    }
}

async fn step_rows(db: &PgPool, id: &str) -> Result<Vec<Value>, DbErr> {
    steps_table::Entity::find()
        .filter(steps_table::Column::ExecutionId.eq(id))
        .order_by_asc(steps_table::Column::StepIndex)
        .all(&orm(db))
        .await
        .and_then(js_rows)
}

async fn steps(caller: Caller, Path(id): Path<String>) -> Response {
    match step_rows(&caller.db, &id).await {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, "Failed to fetch execution steps"),
    }
}

async fn logs(caller: Caller, Path(id): Path<String>) -> Response {
    let steps = match step_rows(&caller.db, &id).await {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to fetch execution logs"),
    };
    let mut logs: Vec<(f64, Value)> = Vec::new();
    for step in &steps {
        let Some(Value::Array(entries)) = step.get("logs") else {
            continue;
        };
        for entry in entries {
            let mut log = match entry {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            log.insert("stepId".into(), step["stepId"].clone());
            if let Some(name) = step.get("stepName").filter(|n| !n.is_null()) {
                log.insert("stepName".into(), name.clone());
            } else {
                log.remove("stepName");
            }
            let at = log
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(js_date_iso)
                .and_then(|iso| crate::cron::parse_ms(&iso))
                .map_or(f64::NAN, |ms| {
                    #[allow(clippy::cast_precision_loss)]
                    let ms = ms as f64;
                    ms
                });
            logs.push((at, Value::Object(log)));
        }
    }
    logs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Data(logs.into_iter().map(|(_, log)| log).collect::<Vec<_>>()).into_response()
}

const CANCELLABLE: &[&str] = &["queued", "pending", "running", "waiting_for_input"];

async fn cancel(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(execution) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow execution", &id));
        };
        let status = execution["status"].as_str().unwrap_or_default();
        if !CANCELLABLE.contains(&status) {
            return Err(ApiError::bad_request(format!(
                "A {status} run can no longer be cancelled"
            ))
            .with_details(json!({ "reason": "not_cancellable", "status": status }))
            .into());
        }
        let stamp = utc_now();
        let db = orm(&caller.db);
        runs_table::Entity::update_many()
            .col_expr(runs_table::Column::Status, Expr::value("cancelled"))
            .col_expr(runs_table::Column::CompletedAt, Expr::value(stamp))
            .col_expr(runs_table::Column::UpdatedAt, Expr::value(stamp))
            .filter(runs_table::Column::Id.eq(&id))
            .filter(runs_table::Column::Status.is_in(CANCELLABLE.iter().copied()))
            .exec(&db)
            .await?;
        if let (Some(instance), Some(runs)) = (
            execution["cfWorkflowInstanceId"]
                .as_str()
                .filter(|i| !i.is_empty()),
            caller.overrides.runs(&state),
        ) && let Err(error) = runs.terminate(instance).await
        {
            tracing::warn!(%error, "[connect-api/workflow-executions] terminate failed");
        }
        if let Err(error) = steps_table::Entity::update_many()
            .col_expr(steps_table::Column::Status, Expr::value("cancelled"))
            .col_expr(steps_table::Column::CompletedAt, Expr::value(stamp))
            .filter(steps_table::Column::ExecutionId.eq(&id))
            .filter(steps_table::Column::Status.is_in(["pending", "running", "waiting_for_input"]))
            .exec(&db)
            .await
        {
            tracing::warn!(%error, "[connect-api/workflow-executions] could not settle in-flight steps");
        }
        let workflow_id = execution["workflowId"].clone();
        caller.publish(
            &state,
            WORKFLOW_EXECUTION_CANCELLED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id, "status": "cancelled" }),
        );
        Ok(Data(json!({ "id": id, "status": "cancelled" })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to cancel execution"))
}

/// `PendingApproval`.
struct PendingApproval {
    row_id: String,
    step_id: Value,
    title: Value,
    description: Value,
    approver_ids: Vec<String>,
}

async fn pending_approval(
    db: &PgPool,
    execution_id: &str,
) -> Result<Option<PendingApproval>, DbErr> {
    let row = steps_table::Entity::find()
        .filter(steps_table::Column::ExecutionId.eq(execution_id))
        .filter(steps_table::Column::Status.eq("waiting_for_input"))
        .filter(steps_table::Column::StepType.eq("manual_step"))
        .order_by_desc(steps_table::Column::StepIndex)
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| {
        let output = crate::js::bag(row.output.as_ref());
        PendingApproval {
            row_id: row.id,
            step_id: json!(row.step_id),
            title: match output.get("title") {
                Some(t @ Value::String(_)) => t.clone(),
                _ => json!(row.step_name),
            },
            description: match output.get("description") {
                Some(d @ Value::String(_)) => d.clone(),
                _ => Value::Null,
            },
            approver_ids: crate::js::array(output.get("approverIds"))
                .iter()
                .filter_map(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }))
}

fn can_decide(approval: &PendingApproval, user_id: &str, may_update: bool) -> bool {
    if approval.approver_ids.is_empty() {
        may_update
    } else {
        approval.approver_ids.iter().any(|id| id == user_id)
    }
}

async fn approval(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(execution) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow execution", &id));
        };
        let approval = if execution["status"].as_str() == Some("waiting_for_input") {
            pending_approval(&caller.db, &id).await?
        } else {
            None
        };
        let may_update = approval.is_some() && caller.can(perm::WORKFLOW_EXECUTIONS_UPDATE);
        let body = match &approval {
            Some(a) => json!({
                "approval": {
                    "stepId": a.step_id,
                    "title": a.title,
                    "description": a.description,
                    "approverIds": a.approver_ids,
                },
                "canDecide": can_decide(a, &caller.user_id, may_update),
            }),
            None => json!({ "approval": null, "canDecide": false }),
        };
        Ok(Data(body).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to fetch the approval"))
}

async fn decision(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (decision, comment) = match validate(&headers, &body, |issues, b| {
        let decision = issues
            .choice(b, "decision", Presence::Required, &["approved", "rejected"])
            .into_option()
            .unwrap_or_default();
        let comment = issues
            .text_with(
                b,
                "comment",
                Presence::Nullish,
                Text::length(None, Some(2000)),
            )
            .into_option();
        (decision, comment)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to record the decision"),
    };
    let may_update = caller.can(perm::WORKFLOW_EXECUTIONS_UPDATE);
    let result = async {
        let Some(execution) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow execution", &id));
        };
        let status = execution["status"].as_str().unwrap_or_default().to_owned();
        let not_waiting = || -> Refusal {
            ApiError::bad_request("This run is not waiting for an approval")
                .with_details(json!({ "reason": "not_waiting", "status": status }))
                .into()
        };
        if status != "waiting_for_input" {
            return Err(not_waiting());
        }
        let Some(approval) = pending_approval(&caller.db, &id).await? else {
            return Err(not_waiting());
        };
        if !can_decide(&approval, &caller.user_id, may_update) {
            return Err(ApiError::forbidden()
                .with_message("You are not an approver of this step")
                .into());
        }
        let runs = caller.overrides.runs(&state);
        let instance = execution["cfWorkflowInstanceId"]
            .as_str()
            .filter(|i| !i.is_empty());
        let (Some(runs), Some(instance)) = (runs, instance) else {
            return Err(ApiError::internal()
                .with_message("Workflow runtime not available")
                .into());
        };
        let comment = comment
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty())
            .map(|c| c.encode_utf16().take(2000).collect::<Vec<u16>>())
            .map(|units| String::from_utf16_lossy(&units));
        let db = orm(&caller.db);
        let decided_by_name: Option<String> = workspace_members::Entity::find()
            .select_only()
            .columns([
                workspace_members::Column::Name,
                workspace_members::Column::Email,
            ])
            .filter(workspace_members::Column::UserId.eq(&caller.user_id))
            .filter(workspace_members::Column::DeletedAt.is_null())
            .into_tuple::<(Option<String>, Option<String>)>()
            .one(&db)
            .await?
            .and_then(|(name, email)| {
                name.filter(|n| !n.is_empty())
                    .or(email.filter(|e| !e.is_empty()))
            });
        let payload = json!({
            "stepId": approval.step_id,
            "approved": decision == "approved",
            "decision": decision,
            "comment": comment,
            "decidedBy": caller.user_id,
            "decidedByName": decided_by_name,
            "decidedAt": now(),
        });
        let claimed = claim_decision(&db, &approval.row_id, &payload).await?;
        if !claimed {
            return Err(ApiError::conflict("Someone already decided on this approval").into());
        }
        if let Err(error) = runs.send_event(instance, RESUME_SIGNAL, &payload).await {
            if let Err(release) = steps_table::Entity::update_many()
                .col_expr(
                    steps_table::Column::Output,
                    sea_orm::ExprTrait::sub(Expr::col(steps_table::Column::Output), "decision"),
                )
                .filter(steps_table::Column::Id.eq(&approval.row_id))
                .filter(steps_table::Column::Status.eq("waiting_for_input"))
                .exec(&db)
                .await
            {
                tracing::error!(%release, "[workflow-approvals] could not release the decision");
            }
            return Err(Refusal::Response(Box::new(internal(
                &error,
                "Failed to record the decision",
            ))));
        }
        caller.publish(
            &state,
            WORKFLOW_EXECUTION_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": execution["workflowId"], "status": "running" }),
        );
        Ok(Data(payload).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to record the decision"))
}

/// The decision on the waiting step, unless one is there already: `output =
/// coalesce(output, '{}') || {decision}` while `output -> 'decision'` is null.
async fn claim_decision(
    db: &sea_orm::DatabaseConnection,
    row_id: &str,
    payload: &Value,
) -> Result<bool, DbErr> {
    let output = || Expr::col(steps_table::Column::Output);
    let claimed = steps_table::Entity::update_many()
        .col_expr(
            steps_table::Column::Output,
            pg::PgExpr::concat(
                Func::coalesce([output(), Expr::val(json!({}))]),
                Expr::val(json!({ "decision": payload })),
            ),
        )
        .filter(steps_table::Column::Id.eq(row_id))
        .filter(steps_table::Column::Status.eq("waiting_for_input"))
        .filter(sea_orm::ExprTrait::is_null(pg::PgExpr::get_json_field(
            output(),
            "decision",
        )))
        .exec(db)
        .await?;
    Ok(claimed.rows_affected > 0)
}

/// A run that never started: `insertSkippedWorkflowExecution`.
pub(crate) struct Skipped<'a> {
    pub(crate) workflow_id: &'a str,
    pub(crate) workflow_version: Option<i64>,
    pub(crate) workflow_name: Option<&'a str>,
    pub(crate) triggered_by: Option<&'a str>,
    pub(crate) trigger_type: &'a str,
    pub(crate) trigger_id: Option<&'a str>,
    pub(crate) trigger_data: Option<&'a Value>,
    pub(crate) reason: &'a str,
    pub(crate) message: String,
}

pub(crate) async fn insert_skipped(db: &PgPool, input: Skipped<'_>) -> Result<String, DbErr> {
    let id = generate_id("wex");
    let stamp = utc_now();
    runs_table::Entity::insert(runs_table::ActiveModel {
        id: Set(id.clone()),
        workflow_id: Set(input.workflow_id.to_owned()),
        workflow_version: Set(version_of(input.workflow_version)),
        workflow_name: Set(input.workflow_name.map(str::to_owned)),
        status: Set("skipped".to_owned()),
        triggered_by: Set(Some(input.triggered_by.unwrap_or("system").to_owned())),
        trigger_type: Set(Some(input.trigger_type.to_owned())),
        trigger_id: Set(input.trigger_id.map(str::to_owned)),
        trigger_data: Set(input.trigger_data.cloned()),
        started_at: Set(Some(stamp)),
        completed_at: Set(Some(stamp)),
        total_steps: Set(Some(0)),
        current_step_index: Set(Some(0)),
        error: Set(Some(
            json!({ "message": input.message, "code": input.reason }),
        )),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(id)
}

/// `workflow.version ?? 1` as the `integer` column takes it.
fn version_of(version: Option<i64>) -> i32 {
    i32::try_from(version.unwrap_or(1)).unwrap_or(i32::MAX)
}

/// `isAtWorkflowConcurrencyLimit(db, workflowId, settings)`.
pub(crate) async fn at_concurrency_limit(
    db: &PgPool,
    workflow_id: &str,
    settings: Option<&Value>,
) -> Result<bool, DbErr> {
    let limit = settings
        .and_then(|s| s.get("maxConcurrentRuns"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(f64::floor);
    let Some(limit) = limit else {
        return Ok(false);
    };
    let active = runs_table::Entity::find()
        .filter(runs_table::Column::WorkflowId.eq(workflow_id))
        .filter(runs_table::Column::Status.is_in(["queued", "running", "waiting_for_input"]))
        .count(&orm(db))
        .await?;
    #[allow(clippy::cast_precision_loss)]
    Ok(active as f64 >= limit)
}

/// `StartRunInput`.
pub(crate) struct StartRun<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) user_id: &'a str,
    pub(crate) workflow: &'a Value,
    pub(crate) trigger_type: &'a str,
    pub(crate) trigger_id: Option<&'a str>,
    pub(crate) trigger_data: Value,
    pub(crate) is_test: bool,
    /// Retry lineage: `(parent id, its retryCount)`.
    pub(crate) parent: Option<(&'a str, i64)>,
}

/// `StartRunResult`: the execution id and, unless the run was skipped, the
/// instance id.
pub(crate) struct Started {
    pub(crate) execution_id: String,
    pub(crate) instance_id: Option<String>,
}

/// Why `startRun` failed.
#[derive(Debug)]
pub(crate) enum StartError {
    Database(DbErr),
    /// The binding threw (its message).
    Runtime(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Runtime(message) => f.write_str(message),
        }
    }
}

impl From<DbErr> for StartError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// `startRun(db, executeWorkflow, input)`.
pub(crate) async fn start_run(
    db: &PgPool,
    runs: &dyn WorkflowRuns,
    input: StartRun<'_>,
) -> Result<Started, StartError> {
    let workflow = input.workflow;
    let workflow_id = workflow["id"].as_str().unwrap_or_default();
    let version = workflow["version"].as_i64();
    let name = workflow["name"].as_str();
    if !input.is_test && at_concurrency_limit(db, workflow_id, workflow.get("settings")).await? {
        let execution_id = insert_skipped(
            db,
            Skipped {
                workflow_id,
                workflow_version: version,
                workflow_name: name,
                triggered_by: Some(input.user_id),
                trigger_type: input.trigger_type,
                trigger_id: input.trigger_id,
                trigger_data: Some(&input.trigger_data),
                reason: "concurrency_limit",
                message: format!(
                    "Skipped: \"{}\" is already at its concurrent run limit.",
                    name.unwrap_or_default()
                ),
            },
        )
        .await?;
        return Ok(Started {
            execution_id,
            instance_id: None,
        });
    }
    let execution_id = generate_id("wex");
    let stamp = utc_now();
    let steps = crate::js::array(workflow.get("steps")).len();
    let db = orm(db);
    runs_table::Entity::insert(runs_table::ActiveModel {
        id: Set(execution_id.clone()),
        workflow_id: Set(workflow_id.to_owned()),
        workflow_version: Set(version_of(version)),
        workflow_name: Set(name.map(str::to_owned)),
        status: Set("queued".to_owned()),
        triggered_by: Set(Some(input.user_id.to_owned())),
        trigger_type: Set(Some(input.trigger_type.to_owned())),
        trigger_id: Set(input.trigger_id.map(str::to_owned)),
        trigger_data: Set(Some(input.trigger_data.clone())),
        started_at: Set(Some(stamp)),
        total_steps: Set(Some(i32::try_from(steps).unwrap_or(i32::MAX))),
        current_step_index: Set(Some(0)),
        parent_execution_id: Set(input.parent.map(|(id, _)| id.to_owned())),
        retry_count: Set(Some(
            i32::try_from(input.parent.map_or(0, |(_, count)| count + 1)).unwrap_or(i32::MAX),
        )),
        execution_context: Set(input.is_test.then(|| json!({ "isTest": true }))),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    let mut params = json!({
        "workspaceId": input.workspace_id,
        "userId": input.user_id,
        "workflowId": workflow_id,
        "triggerType": input.trigger_type,
        "triggerData": input.trigger_data,
        "source": "weldconnect",
        "executionId": execution_id,
    });
    if let Some(trigger_id) = input.trigger_id {
        params["triggerId"] = json!(trigger_id);
    }
    if input.is_test {
        params["isTest"] = json!(true);
    }
    match runs.create(&params).await {
        Ok(instance) => {
            if let Err(error) = runs_table::Entity::update_many()
                .col_expr(
                    runs_table::Column::CfWorkflowInstanceId,
                    Expr::value(&instance),
                )
                .filter(runs_table::Column::Id.eq(&execution_id))
                .exec(&db)
                .await
            {
                tracing::warn!(%error, "[workflow-executions] could not link the workflow instance");
            }
            Ok(Started {
                execution_id,
                instance_id: Some(instance),
            })
        }
        Err(message) => {
            let failed = utc_now();
            if let Err(error) = runs_table::Entity::update_many()
                .col_expr(runs_table::Column::Status, Expr::value("failed"))
                .col_expr(runs_table::Column::CompletedAt, Expr::value(failed))
                .col_expr(
                    runs_table::Column::Error,
                    Expr::value(
                        json!({ "message": format!("Could not start the run: {message}") }),
                    ),
                )
                .col_expr(runs_table::Column::UpdatedAt, Expr::value(failed))
                .filter(runs_table::Column::Id.eq(&execution_id))
                .exec(&db)
                .await
            {
                tracing::error!(%error, "[workflow-executions] could not mark the unstarted run failed");
            }
            Err(StartError::Runtime(message))
        }
    }
}

const TEST_TRIGGER_TYPES: &[&str] = &[
    "manual",
    "schedule",
    "webhook",
    "entity_event",
    "integration_event",
    "api",
    "workflow_complete",
];

/// A started Test run.
pub(crate) struct TestRun {
    pub(crate) execution_id: String,
    pub(crate) instance_id: String,
    pub(crate) trigger_type: String,
}

/// `startTestRun(db, executeWorkflow, input)`: `None` when the workflow is gone.
pub(crate) async fn start_test_run(
    db: &PgPool,
    runs: &dyn WorkflowRuns,
    workspace_id: &str,
    user_id: &str,
    workflow_id: &str,
    test_data: Option<Value>,
    requested: Option<&str>,
) -> Result<Option<TestRun>, StartError> {
    let Some(workflow) = crate::workflows::get_workflow(db, workflow_id).await? else {
        return Ok(None);
    };
    let triggers = crate::js::array(workflow.get("triggers"));
    let enabled = |t: &&Value| !matches!(t.get("isEnabled"), Some(Value::Bool(false)));
    let trigger_type = match requested {
        Some(t) if TEST_TRIGGER_TYPES.contains(&t) => t.to_owned(),
        _ => triggers
            .iter()
            .filter(|t| {
                t.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|k| !k.is_empty())
            })
            .find(enabled)
            .and_then(|t| t.get("type").and_then(Value::as_str))
            .filter(|t| TEST_TRIGGER_TYPES.contains(t))
            .unwrap_or("manual")
            .to_owned(),
    };
    let mut trigger_data = match test_data {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if trigger_type == "schedule" && !trigger_data.contains_key("timezone") {
        let schedule = triggers
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("schedule"))
            .find(enabled);
        if let Some(schedule) = schedule {
            let timezone = crate::js::coalesce(&[
                schedule.get("timezone"),
                schedule.get("config").and_then(|c| c.get("timezone")),
            ]);
            if let Some(tz) = timezone.filter(|tz| crate::js::truthy(tz)) {
                trigger_data.insert("timezone".into(), tz.clone());
            }
        }
    }
    let started = start_run(
        db,
        runs,
        StartRun {
            workspace_id,
            user_id,
            workflow: &workflow,
            trigger_type: &trigger_type,
            trigger_id: None,
            trigger_data: Value::Object(trigger_data),
            is_test: true,
            parent: None,
        },
    )
    .await?;
    Ok(Some(TestRun {
        execution_id: started.execution_id,
        instance_id: started.instance_id.unwrap_or_default(),
        trigger_type,
    }))
}

async fn retry(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("Organization context required").into_response();
    };
    let Some(runs) = caller.overrides.runs(&state) else {
        return ApiError::internal()
            .with_message("Workflow runtime not available")
            .into_response();
    };
    let result = async {
        let Some(original) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::from(ApiError::not_found("Execution", Some(&id))));
        };
        if original["status"].as_str() != Some("failed") {
            return Err(Refusal::bad_request(
                "Only failed executions can be retried",
            ));
        }
        let workflow_id = original["workflowId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let Some(workflow) = crate::workflows::get_workflow(&caller.db, &workflow_id).await? else {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        };
        let is_test = original["executionContext"]["isTest"] == json!(true);
        let status = workflow["status"].as_str().unwrap_or_default();
        if status != "active" && !is_test {
            return Err(ApiError::bad_request(
                "This workflow is not active, so the run would not start. Activate it first.",
            )
            .with_details(json!({ "reason": "workflow_inactive", "workflowId": workflow["id"], "status": status }))
            .into());
        }
        let trigger_type = original["triggerType"]
            .as_str()
            .unwrap_or("manual")
            .to_owned();
        let trigger_data = match &original["triggerData"] {
            Value::Null => json!({}),
            other => other.clone(),
        };
        let started = start_run(
            &caller.db,
            runs.as_ref(),
            StartRun {
                workspace_id: &org_id,
                user_id: &caller.user_id,
                workflow: &workflow,
                trigger_type: &trigger_type,
                trigger_id: original["triggerId"].as_str(),
                trigger_data,
                is_test,
                parent: Some((&id, original["retryCount"].as_i64().unwrap_or(0))),
            },
        )
        .await
        .map_err(|error| {
            Refusal::Response(Box::new(internal(&error, "Failed to retry execution")))
        })?;
        let skipped = started.instance_id.is_none();
        caller.publish(
            &state,
            WORKFLOW_EXECUTION_CREATED,
            &started.execution_id,
            &json!({
                "id": started.execution_id,
                "workflowId": "",
                "status": if skipped { "skipped" } else { "queued" },
            }),
        );
        let body = match started.instance_id {
            None => {
                json!({ "id": started.execution_id, "executionId": started.execution_id, "retryOf": id, "skipped": true })
            }
            Some(instance) => json!({
                "id": started.execution_id,
                "executionId": started.execution_id,
                "instanceId": instance,
                "retryOf": id,
            }),
        };
        Ok(Created(body).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to retry execution"))
}

/// The `workflow_executions` columns a passthrough body may set, by their
/// Drizzle name.
const COLUMNS: &[(&str, &str)] = &[
    ("id", "id"),
    ("workflowId", "workflow_id"),
    ("workflowVersion", "workflow_version"),
    ("workflowName", "workflow_name"),
    ("status", "status"),
    ("triggeredBy", "triggered_by"),
    ("triggerType", "trigger_type"),
    ("triggerId", "trigger_id"),
    ("triggerData", "trigger_data"),
    ("duration", "duration"),
    ("currentStepId", "current_step_id"),
    ("currentStepIndex", "current_step_index"),
    ("totalSteps", "total_steps"),
    ("output", "output"),
    ("error", "error"),
    ("executionContext", "execution_context"),
    ("cfWorkflowInstanceId", "cf_workflow_instance_id"),
    ("parentExecutionId", "parent_execution_id"),
    ("retryCount", "retry_count"),
];

/// `workflow_executions` written from a passthrough body.
const RUNS: JsonTable = JsonTable::of::<runs_table::Entity>();

/// Timestamp columns: Drizzle refuses anything but a `Date` there.
const DATE_COLUMNS: &[&str] = &["startedAt", "completedAt"];

/// `createWorkflowExecutionSchema` (`.passthrough()`; `partial` for the
/// update): the body as sent once its declared keys check out.
fn execution_body(
    issues: &mut weldsuite_kit::validation::Issues,
    b: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(b, "workflowId", required, None, None);
    issues.text(b, "status", Presence::Optional, None, Some(30));
    issues.text(b, "error", Presence::Optional, None, None);
    b.clone()
}

/// The body's column values as a `jsonb_populate_record` input, and the
/// columns set (`undefined` values left out).
fn column_values(data: &Map<String, Value>) -> Result<(Vec<&'static str>, Map<String, Value>), ()> {
    let mut columns = Vec::new();
    let mut record = Map::new();
    for (key, value) in data {
        if DATE_COLUMNS.contains(&key.as_str()) && !value.is_null() {
            return Err(());
        }
        if let Some((_, column)) = COLUMNS.iter().find(|(name, _)| name == key) {
            columns.push(*column);
            record.insert((*column).to_owned(), value.clone());
        }
    }
    Ok((columns, record))
}

async fn create_route(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        execution_body(issues, b, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create workflow execution"),
    };
    let id = generate_id("wfex");
    let Ok((columns, mut record)) = column_values(&data) else {
        return internal(
            &"value.toISOString is not a function",
            "Failed to create workflow execution",
        );
    };
    if !columns.contains(&"id") {
        record.insert("id".to_owned(), json!(id));
    }
    let stamp = now();
    record.insert("created_at".to_owned(), json!(stamp));
    record.insert("updated_at".to_owned(), json!(stamp));
    let inserted = RUNS.insert(&orm(&caller.db), record).await;
    if let Err(error) = inserted {
        return internal(&error, "Failed to create workflow execution");
    }
    let workflow_id = data.get("workflowId").cloned().unwrap_or_else(|| json!(""));
    let status = data
        .get("status")
        .filter(|s| !s.is_null())
        .cloned()
        .unwrap_or_else(|| json!("queued"));
    caller.publish(
        &state,
        WORKFLOW_EXECUTION_CREATED,
        &id,
        &json!({ "id": id, "workflowId": workflow_id, "status": status }),
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
    let data = match validate(&headers, &body, |issues, b| execution_body(issues, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update workflow execution"),
    };
    let result = async {
        let Some(existing) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow execution", &id));
        };
        let Ok((_, record)) = column_values(&data) else {
            return Err(Refusal::Response(Box::new(internal(
                &"value.toISOString is not a function",
                "Failed to update workflow execution",
            ))));
        };
        let mut record = record;
        record.insert("updated_at".to_owned(), json!(now()));
        RUNS.update(&orm(&caller.db), &id, record, false).await?;
        let status = data
            .get("status")
            .filter(|s| !s.is_null())
            .cloned()
            .unwrap_or_else(|| existing["status"].clone());
        caller.publish(
            &state,
            WORKFLOW_EXECUTION_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"], "status": status }),
        );
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow execution"))
}

async fn delete_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = get_execution(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow execution", &id));
        };
        runs_table::Entity::delete_by_id(id.as_str())
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            weldsuite_events::EventType::uncatalogued("workflow_execution", "deleted"),
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow execution"))
}
