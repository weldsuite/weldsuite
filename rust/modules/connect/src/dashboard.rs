//! `/api/workflow-dashboard` (`routes/workflow-dashboard/index.ts`,
//! `services/workflow-error-logs.ts`): stats, search, performance, the
//! Errors view and its acknowledgement, resource usage, and the editor's
//! static pickers.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    workflow_error_logs as error_logs, workflow_executions as runs, workflow_schedules,
    workflow_templates, workflow_webhooks, workflows,
};

use crate::executions::{
    js, not_sequence, not_sequence_of, not_sequence_run, not_test_run, test_flag,
};
use crate::{Caller, ConnectState, Refusal, internal, validate, validate_query};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    Router::new()
        .route("/stats", get(stats).route_layer(read()))
        .route("/search", get(search).route_layer(read()))
        .route("/performance", get(performance).route_layer(read()))
        .route("/errors", get(errors).route_layer(read()))
        .route(
            "/errors/{id}/acknowledge",
            patch(acknowledge).route_layer(update()),
        )
        .route(
            "/errors/acknowledge",
            post(acknowledge_many).route_layer(update()),
        )
        .route("/resource-usage", get(resource_usage).route_layer(read()))
        .route("/action-types", get(action_types).route_layer(read()))
        .route("/trigger-types", get(trigger_types).route_layer(read()))
        .route("/entity-events", get(entity_events).route_layer(read()))
}

async fn trigger_counts(db: &PgPool) -> Result<(u64, u64), DbErr> {
    let db = orm(db);
    let schedules = workflow_schedules::Entity::find()
        .filter(workflow_schedules::Column::IsEnabled.eq(true))
        .filter(workflow_schedules::Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    let webhooks = workflow_webhooks::Entity::find()
        .filter(workflow_webhooks::Column::IsEnabled.eq(true))
        .filter(workflow_webhooks::Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    Ok((schedules, webhooks))
}

/// `count(*)`.
fn count_all() -> Expr {
    Func::count(Expr::col(Asterisk)).into()
}

/// `count(*) filter (where <condition>)`.
fn count_where(condition: impl Into<Condition>) -> Expr {
    Func::count(Expr::col(Asterisk)).filter(condition).into()
}

/// The live workflows that are not a sequence's.
fn live_workflows() -> sea_orm::Select<workflows::Entity> {
    workflows::Entity::find()
        .filter(workflows::Column::DeletedAt.is_null())
        .filter(not_sequence())
}

/// The runs that are neither a sequence's nor a test.
fn counted_runs() -> sea_orm::Select<runs::Entity> {
    runs::Entity::find()
        .filter(not_sequence_run())
        .filter(not_test_run())
}

async fn stats(caller: Caller) -> Response {
    let result = async {
        let db = orm(&caller.db);
        let workflows: Vec<(String, i64)> = live_workflows()
            .select_only()
            .column(workflows::Column::Status)
            .expr(count_all())
            .group_by(workflows::Column::Status)
            .into_tuple()
            .all(&db)
            .await?;
        let runs: Vec<(String, i64)> = counted_runs()
            .select_only()
            .column(runs::Column::Status)
            .expr(count_all())
            .group_by(runs::Column::Status)
            .into_tuple()
            .all(&db)
            .await?;
        let (schedules, webhooks) = trigger_counts(&caller.db).await?;
        let count_of = |status: &str| {
            runs.iter()
                .find(|(s, _)| s == status)
                .map_or(0, |(_, c)| *c)
        };
        let mut wf = json!({ "total": 0, "active": 0, "draft": 0, "paused": 0, "archived": 0 });
        let mut total = 0;
        for (status, count) in &workflows {
            total += count;
            if ["active", "draft", "paused", "archived"].contains(&status.as_str()) {
                wf[status] = json!(count);
            }
        }
        wf["total"] = json!(total);
        Ok::<_, DbErr>(
            Data(json!({
                "workflows": wf,
                "executions": {
                    "total": runs.iter().map(|(_, c)| c).sum::<i64>(),
                    "running": count_of("running"),
                    "completed": count_of("completed"),
                    "failed": count_of("failed"),
                    "queued": count_of("queued"),
                },
                "triggers": { "schedules": schedules, "webhooks": webhooks },
            }))
            .into_response(),
        )
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to fetch dashboard stats"))
}

/// `jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status)`.
const WORKFLOW_HIT: [workflows::Column; 3] = [
    workflows::Column::Id,
    workflows::Column::Name,
    workflows::Column::Status,
];

fn workflow_hit((id, name, status): (String, String, String)) -> Value {
    json!({ "id": id, "name": name, "status": status })
}

/// `left join workflows w on e.workflow_id = w.id`.
fn run_workflow() -> RelationDef {
    runs::Entity::belongs_to(workflows::Entity)
        .from(runs::Column::WorkflowId)
        .to(workflows::Column::Id)
        .into()
}

fn search_hit(id: &Value, title: &Value, description: &Value, href: &str, kind: &str) -> Value {
    json!({ "id": id, "title": title, "description": description, "href": href, "type": kind })
}

/// `x || fallback` for a nullable string column.
fn or_text(value: &Value, fallback: &str) -> Value {
    match value.as_str() {
        Some(text) if !text.is_empty() => json!(text),
        _ => json!(fallback),
    }
}

async fn search(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let read = validate_query(query.as_deref(), |issues, q| {
        let term = issues
            .text(q, "q", Presence::Optional, None, None)
            .into_option();
        let limit = issues
            .number(
                q,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    max: Some(50.0),
                    ..Number::default()
                },
            )
            .into_option()
            .unwrap_or(15.0);
        (term, limit)
    });
    let (term, limit) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to search"),
    };
    let result = async {
        let term = term.filter(|t| t.encode_utf16().count() >= 2);
        let db = orm(&caller.db);
        let Some(term) = term else {
            let recent: Vec<Value> = live_workflows()
                .select_only()
                .columns(WORKFLOW_HIT)
                .order_by_desc(workflows::Column::UpdatedAt)
                .limit(5)
                .into_tuple()
                .all(&db)
                .await?
                .into_iter()
                .map(workflow_hit)
                .collect();
            let hits: Vec<Value> = recent
                .iter()
                .map(|w| {
                    let id = w["id"].as_str().unwrap_or_default();
                    search_hit(
                        &w["id"],
                        &w["name"],
                        &or_text(&w["status"], "Workflow"),
                        &format!("/weldconnect/workflows/{id}"),
                        "workflow",
                    )
                })
                .collect();
            return Ok::<_, DbErr>(Data(hits).into_response());
        };
        let pattern = format!("%{term}%");
        let workflows: Vec<Value> = live_workflows()
            .select_only()
            .columns(WORKFLOW_HIT)
            .filter(
                Condition::any()
                    .add(workflows::Column::Name.like(&pattern))
                    .add(workflows::Column::Description.like(&pattern)),
            )
            .limit(5)
            .into_tuple()
            .all(&db)
            .await?
            .into_iter()
            .map(workflow_hit)
            .collect();
        let templates: Vec<Value> = workflow_templates::Entity::find()
            .select_only()
            .columns([
                workflow_templates::Column::Id,
                workflow_templates::Column::Name,
                workflow_templates::Column::Category,
            ])
            .filter(workflow_templates::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(workflow_templates::Column::Name.like(&pattern))
                    .add(workflow_templates::Column::Description.like(&pattern)),
            )
            .limit(5)
            .into_tuple::<(String, String, String)>()
            .all(&db)
            .await?
            .into_iter()
            .map(|(id, name, category)| json!({ "id": id, "name": name, "category": category }))
            .collect();
        let runs: Vec<Value> = runs::Entity::find()
            .select_only()
            .columns([runs::Column::Id, runs::Column::Status])
            .column(workflows::Column::Name)
            .join(JoinType::LeftJoin, run_workflow())
            .filter(workflows::Column::Name.like(&pattern))
            .filter(not_sequence())
            .order_by_desc(runs::Column::StartedAt)
            .limit(5)
            .into_tuple::<(String, String, Option<String>)>()
            .all(&db)
            .await?
            .into_iter()
            .map(|(id, status, name)| json!({ "id": id, "status": status, "workflowName": name }))
            .collect();
        let mut hits = Vec::new();
        for w in &workflows {
            let id = w["id"].as_str().unwrap_or_default();
            hits.push(search_hit(
                &w["id"],
                &w["name"],
                &or_text(&w["status"], "Workflow"),
                &format!("/weldconnect/workflows/{id}"),
                "workflow",
            ));
        }
        for t in &templates {
            let id = t["id"].as_str().unwrap_or_default();
            hits.push(search_hit(
                &t["id"],
                &t["name"],
                &or_text(&t["category"], "Template"),
                &format!("/weldconnect/templates/{id}"),
                "template",
            ));
        }
        for r in &runs {
            let id = r["id"].as_str().unwrap_or_default();
            hits.push(search_hit(
                &r["id"],
                &or_text(&r["workflowName"], "Execution"),
                &or_text(&r["status"], "Execution"),
                &format!("/weldconnect/executions/{id}"),
                "execution",
            ));
        }
        // `results.slice(0, limit)`.
        let end = if limit.is_nan() {
            0
        } else if limit < 0.0 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let back = (-limit).trunc() as usize;
            hits.len().saturating_sub(back)
        } else {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let end = limit.trunc() as usize;
            end.min(hits.len())
        };
        hits.truncate(end);
        Ok(Data(hits).into_response())
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to search"))
}

async fn performance(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let workflow_id = match validate_query(query.as_deref(), |issues, q| {
        issues
            .text(q, "workflowId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(id) => id.filter(|id| !id.is_empty()),
        Err(refusal) => return refusal.respond("Failed to fetch performance metrics"),
    };
    // `e.status = 'completed' and coalesce(e.duration, 0) > 0`.
    let timed = || {
        Condition::all()
            .add(runs::Column::Status.eq("completed"))
            .add(sea_orm::ExprTrait::gt(
                Func::coalesce([Expr::col(runs::Column::Duration), Expr::val(0)]),
                0,
            ))
    };
    let float = |aggregate: sea_orm::sea_query::FunctionCall| -> Expr {
        Func::cast_as(aggregate.filter(timed()), "float8").into()
    };
    let duration = || Expr::col(runs::Column::Duration);
    let row: Result<Option<(i64, i64, Option<f64>, Option<f64>, Option<f64>)>, DbErr> =
        runs::Entity::find()
            .select_only()
            .expr(count_all())
            .expr(count_where(timed()))
            .expr(float(Func::avg(duration())))
            .expr(float(Func::min(duration())))
            .expr(float(Func::max(duration())))
            .filter(match &workflow_id {
                Some(workflow_id) => runs::Column::WorkflowId.eq(workflow_id),
                None => not_sequence_run(),
            })
            .filter(not_test_run())
            .into_tuple()
            .one(&orm(&caller.db))
            .await;
    match row {
        Ok(row) => {
            let (total, completed, avg, min, max) = row.unwrap_or_default();
            let n = |v: Option<f64>| number(v.unwrap_or(0.0));
            Data(json!({
                "totalExecutions": total,
                "completedExecutions": completed,
                "averageDuration": n(avg),
                "minDuration": n(min),
                "maxDuration": n(max),
            }))
            .into_response()
        }
        Err(error) => internal(&error, "Failed to fetch performance metrics"),
    }
}

/// A double as JavaScript prints it in JSON.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        return json!(value as i64);
    }
    json!(value)
}

/// The error logs neither a sequence's nor a test run's, of `workflow_id`
/// when given: `notSequenceError`, `notTestError`.
fn counted_errors(workflow_id: Option<&String>) -> Condition {
    let te = Alias::new("te");
    let mut condition = Condition::all()
        .add(not_sequence_of(Expr::col((
            error_logs::Entity,
            error_logs::Column::WorkflowId,
        ))))
        .add(Expr::not_exists(
            Query::select()
                .expr(Expr::val(1))
                .from_as(runs::Entity, te.clone())
                .and_where(sea_orm::ExprTrait::eq(
                    Expr::col((te.clone(), runs::Column::Id)),
                    Expr::col((error_logs::Entity, error_logs::Column::ExecutionId)),
                ))
                .and_where(sea_orm::ExprTrait::eq(
                    test_flag(Expr::col((te, runs::Column::ExecutionContext))),
                    "true",
                ))
                .to_owned(),
        ));
    if let Some(workflow_id) = workflow_id {
        condition = condition.add(error_logs::Column::WorkflowId.eq(workflow_id));
    }
    condition
}

/// An error log with its workflow's name.
#[derive(Debug, FromQueryResult)]
struct ErrorWithWorkflow {
    #[sea_orm(nested)]
    log: error_logs::Model,
    workflow_name: Option<String>,
}

/// `left join workflows w on w.id = l.workflow_id`.
fn error_workflow() -> RelationDef {
    error_logs::Entity::belongs_to(workflows::Entity)
        .from(error_logs::Column::WorkflowId)
        .to(workflows::Column::Id)
        .into()
}

async fn errors(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let read = validate_query(query.as_deref(), |issues, q| {
        let workflow_id = issues
            .text(q, "workflowId", Presence::Optional, None, None)
            .into_option();
        let page = issues
            .number(
                q,
                "page",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: None,
                },
            )
            .into_option()
            .unwrap_or(1.0);
        let limit = issues
            .number(
                q,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(100.0),
                },
            )
            .into_option()
            .unwrap_or(20.0);
        let status = issues
            .choice(
                q,
                "status",
                Presence::Optional,
                &["all", "acknowledged", "unacknowledged"],
            )
            .into_option();
        let acknowledged = issues
            .choice(q, "isAcknowledged", Presence::Optional, &["true", "false"])
            .into_option();
        (workflow_id, page, limit, status, acknowledged)
    });
    let (workflow_id, page, limit, status, acknowledged) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to fetch error stats"),
    };
    let status = status.unwrap_or_else(|| match acknowledged.as_deref() {
        Some("true") => "acknowledged".into(),
        Some("false") => "unacknowledged".into(),
        _ => "all".into(),
    });
    #[allow(clippy::cast_possible_truncation)]
    let (page, limit) = (page.max(1.0) as i64, limit.clamp(1.0, 100.0) as i64);
    let workflow_id = workflow_id.filter(|w| !w.is_empty());
    let base = || counted_errors(workflow_id.as_ref());
    let filtered = || match status.as_str() {
        "unacknowledged" => base().add(error_logs::Column::AcknowledgedAt.is_null()),
        "acknowledged" => base().add(error_logs::Column::AcknowledgedAt.is_not_null()),
        _ => base(),
    };
    let result = async {
        let db = orm(&caller.db);
        let items: Vec<ErrorWithWorkflow> = error_logs::Entity::find()
            .column_as(workflows::Column::Name, "workflow_name")
            .join(JoinType::LeftJoin, error_workflow())
            .filter(filtered())
            .order_by_desc(error_logs::Column::OccurredAt)
            .order_by_desc(error_logs::Column::Id)
            .limit(u64::try_from(limit).unwrap_or(0))
            .offset(u64::try_from((page - 1) * limit).unwrap_or(0))
            .into_model()
            .all(&db)
            .await?;
        let total = error_logs::Entity::find()
            .filter(filtered())
            .count(&db)
            .await?;
        let unacknowledged = error_logs::Entity::find()
            .filter(base().add(error_logs::Column::AcknowledgedAt.is_null()))
            .count(&db)
            .await?;
        let by_type_rows: Vec<(Option<String>, i64)> = error_logs::Entity::find()
            .select_only()
            .column(error_logs::Column::ErrorType)
            .expr(count_all())
            .filter(filtered())
            .group_by(error_logs::Column::ErrorType)
            .into_tuple()
            .all(&db)
            .await?;
        let by_workflow: Vec<Value> = error_logs::Entity::find()
            .select_only()
            .column(error_logs::Column::WorkflowId)
            .column(workflows::Column::Name)
            .expr(count_all())
            .join(JoinType::LeftJoin, error_workflow())
            .filter(filtered())
            .group_by(error_logs::Column::WorkflowId)
            .group_by(workflows::Column::Name)
            .order_by_desc(count_all())
            .limit(10)
            .into_tuple::<(Option<String>, Option<String>, i64)>()
            .all(&db)
            .await?
            .into_iter()
            .map(|(workflow_id, name, count)| {
                json!({ "workflowId": workflow_id, "workflowName": name, "count": count })
            })
            .collect();
        let mut by_type = Map::new();
        for (kind, count) in by_type_rows {
            let key = kind
                .filter(|k| !k.is_empty())
                .unwrap_or_else(|| "unknown".into());
            let current = by_type.get(&key).and_then(Value::as_i64).unwrap_or(0);
            by_type.insert(key, json!(current + count));
        }
        let items = items
            .into_iter()
            .map(|item| {
                let mut row = js(item.log)?;
                row["workflowName"] = json!(item.workflow_name);
                Ok(row)
            })
            .collect::<Result<Vec<_>, DbErr>>()?;
        Ok::<_, DbErr>(
            Data(json!({
                "total": total,
                "unacknowledged": unacknowledged,
                "byType": by_type,
                "byWorkflow": by_workflow,
                "items": items,
                "page": page,
                "limit": limit,
            }))
            .into_response(),
        )
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to fetch error stats"))
}

async fn acknowledge(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let db = orm(&caller.db);
        let Some(existing) = error_logs::Entity::find_by_id(id.as_str()).one(&db).await? else {
            return Err(Refusal::not_found("Error log", &id));
        };
        if existing.acknowledged_at.is_some() {
            return Ok(Data(js(existing)?).into_response());
        }
        let row = error_logs::Entity::update_many()
            .col_expr(error_logs::Column::IsAcknowledged, Expr::value(true))
            .col_expr(error_logs::Column::AcknowledgedAt, Expr::value(utc_now()))
            .col_expr(
                error_logs::Column::AcknowledgedBy,
                Expr::value(&caller.user_id),
            )
            .filter(error_logs::Column::Id.eq(&id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next();
        match row {
            Some(row) => Ok(Data(js(row)?).into_response()),
            None => Err(Refusal::not_found("Error log", &id)),
        }
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to acknowledge error"))
}

enum Target {
    Ids(Vec<String>),
    All(Option<String>),
}

/// `z.union([{ ids }, { all: true, workflowId }])`.
fn bulk_target(body: &Map<String, Value>) -> Result<Target, Value> {
    // Option 1: `{ ids: z.array(z.string().min(1)).min(1).max(500) }`.
    let mut first: Vec<Value> = Vec::new();
    let mut first_aborted = false;
    match body.get("ids") {
        Some(Value::Array(items)) => {
            if items.is_empty() {
                first.push(json!({ "code": "too_small", "minimum": 1, "type": "array", "inclusive": true, "exact": false,
                    "message": "Array must contain at least 1 element(s)", "path": ["ids"] }));
            }
            if items.len() > 500 {
                first.push(json!({ "code": "too_big", "maximum": 500, "type": "array", "inclusive": true, "exact": false,
                    "message": "Array must contain at most 500 element(s)", "path": ["ids"] }));
            }
            for (i, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) if text.is_empty() => first.push(json!({ "code": "too_small", "minimum": 1,
                        "type": "string", "inclusive": true, "exact": false,
                        "message": "String must contain at least 1 character(s)", "path": ["ids", i] })),
                    Value::String(_) => {}
                    other => {
                        first_aborted = true;
                        first.push(invalid_type(&["ids".into(), json!(i)], "string", Some(other)));
                    }
                }
            }
        }
        other => {
            first_aborted = true;
            first.push(invalid_type(&["ids".into()], "array", other));
        }
    }
    if first.is_empty()
        && let Some(Value::Array(items)) = body.get("ids")
    {
        return Ok(Target::Ids(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ));
    }
    // Option 2: `{ all: z.literal(true), workflowId: z.string().optional() }`.
    let mut second: Vec<Value> = Vec::new();
    if body.get("all") != Some(&Value::Bool(true)) {
        let mut issue = json!({ "code": "invalid_literal", "expected": true, "path": ["all"],
            "message": "Invalid literal value, expected true" });
        if let Some(received) = body.get("all") {
            issue["received"] = received.clone();
        }
        second.push(issue);
    }
    let workflow_id = match body.get("workflowId") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        other => {
            second.push(invalid_type(&["workflowId".into()], "string", other));
            None
        }
    };
    if second.is_empty() {
        return Ok(Target::All(workflow_id));
    }
    if !first_aborted {
        return Err(Value::Array(first));
    }
    let error = |issues: Vec<Value>| json!({ "issues": issues, "name": "ZodError" });
    Err(json!([{
        "code": "invalid_union",
        "unionErrors": [error(first), error(second)],
        "path": [],
        "message": "Invalid input",
    }]))
}

fn invalid_type(path: &[Value], expected: &str, value: Option<&Value>) -> Value {
    let received = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    let message = if received == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {received}")
    };
    json!({ "code": "invalid_type", "expected": expected, "received": received, "path": path, "message": message })
}

async fn acknowledge_many(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let target = match validate(&headers, &body, |issues, b| match bulk_target(b) {
        Ok(target) => Some(target),
        Err(found) => {
            for issue in found.as_array().into_iter().flatten() {
                issues.push_raw(issue.clone());
            }
            None
        }
    }) {
        Ok(Some(target)) => target,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond("Failed to acknowledge errors"),
    };
    let acknowledged = error_logs::Entity::update_many()
        .col_expr(error_logs::Column::IsAcknowledged, Expr::value(true))
        .col_expr(error_logs::Column::AcknowledgedAt, Expr::value(utc_now()))
        .col_expr(
            error_logs::Column::AcknowledgedBy,
            Expr::value(&caller.user_id),
        )
        .filter(error_logs::Column::AcknowledgedAt.is_null());
    let changed = match target {
        Target::Ids(ids) if ids.is_empty() => Ok(0),
        Target::Ids(ids) => acknowledged
            .filter(error_logs::Column::Id.is_in(ids))
            .exec(&orm(&caller.db))
            .await
            .map(|r| r.rows_affected),
        Target::All(workflow_id) => acknowledged
            .filter(counted_errors(workflow_id.as_ref()))
            .exec(&orm(&caller.db))
            .await
            .map(|r| r.rows_affected),
    };
    match changed {
        Ok(count) => Data(json!({ "acknowledged": count })).into_response(),
        Err(error) => internal(&error, "Failed to acknowledge errors"),
    }
}

async fn resource_usage(caller: Caller) -> Response {
    let result = async {
        let db = orm(&caller.db);
        let (wf_total, wf_active): (i64, i64) = live_workflows()
            .select_only()
            .expr(count_all())
            .expr(count_where(workflows::Column::Status.eq("active")))
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        let (total, running, completed, failed): (i64, i64, i64, i64) = counted_runs()
            .select_only()
            .expr(count_all())
            .expr(count_where(runs::Column::Status.eq("running")))
            .expr(count_where(runs::Column::Status.eq("completed")))
            .expr(count_where(runs::Column::Status.eq("failed")))
            .into_tuple()
            .one(&db)
            .await?
            .unwrap_or_default();
        let (schedules, webhooks) = trigger_counts(&caller.db).await?;
        Ok::<_, DbErr>(Data(json!({
            "workflows": { "total": wf_total, "active": wf_active },
            "executions": { "total": total, "running": running, "completed": completed, "failed": failed },
            "triggers": { "schedules": schedules, "webhooks": webhooks },
        }))
        .into_response())
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to fetch resource usage"))
}

/// `category` / `search` filtering of a static picker list.
fn picker(list: &[Value], query: Option<&str>) -> Response {
    let read = validate_query(query, |issues, q| {
        let category = issues
            .text(q, "category", Presence::Optional, None, None)
            .into_option();
        let search = issues
            .text(q, "search", Presence::Optional, None, None)
            .into_option();
        (category, search)
    });
    let (category, search) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to list"),
    };
    let category = category.filter(|c| !c.is_empty());
    let search = search.filter(|s| !s.is_empty()).map(|s| s.to_lowercase());
    let filtered: Vec<&Value> = list
        .iter()
        .filter(|item| {
            category
                .as_deref()
                .is_none_or(|c| item["category"].as_str() == Some(c))
        })
        .filter(|item| {
            search.as_deref().is_none_or(|s| {
                let has = |key: &str| {
                    item[key]
                        .as_str()
                        .is_some_and(|t| t.to_lowercase().contains(s))
                };
                has("name") || has("description")
            })
        })
        .collect();
    Data(filtered).into_response()
}

async fn action_types(RawQuery(query): RawQuery) -> Response {
    picker(crate::catalog::action_types(), query.as_deref())
}

async fn trigger_types(RawQuery(query): RawQuery) -> Response {
    picker(crate::catalog::trigger_types(), query.as_deref())
}

async fn entity_events() -> Response {
    Data(crate::catalog::entity_events()).into_response()
}
