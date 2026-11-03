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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::executions::{NOT_SEQUENCE_RUN, NOT_TEST_RUN};
use crate::workflows::NOT_SEQUENCE;
use crate::{Caller, ConnectState, Refusal, internal, now, validate, validate_query};

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

async fn trigger_counts(db: &PgPool) -> Result<(i64, i64), sqlx::Error> {
    let schedules: i64 = sqlx::query_scalar(
        "select count(*) from workflow_schedules where is_enabled = true and deleted_at is null",
    )
    .fetch_one(db)
    .await?;
    let webhooks: i64 = sqlx::query_scalar(
        "select count(*) from workflow_webhooks where is_enabled = true and deleted_at is null",
    )
    .fetch_one(db)
    .await?;
    Ok((schedules, webhooks))
}

async fn stats(caller: Caller) -> Response {
    let result = async {
        let workflows: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select w.status, count(*) from workflows w where w.deleted_at is null and {NOT_SEQUENCE}
             group by w.status"
        )))
        .fetch_all(&caller.db)
        .await?;
        let runs: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select e.status, count(*) from workflow_executions e where {NOT_SEQUENCE_RUN} and {NOT_TEST_RUN}
             group by e.status"
        )))
        .fetch_all(&caller.db)
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
        Ok::<_, sqlx::Error>(
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
        let Some(term) = term else {
            let recent: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status) from workflows w
                 where w.deleted_at is null and {NOT_SEQUENCE} order by w.updated_at desc limit 5"
            )))
            .fetch_all(&caller.db)
            .await?;
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
            return Ok::<_, sqlx::Error>(Data(hits).into_response());
        };
        let pattern = format!("%{term}%");
        let workflows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status) from workflows w
             where w.deleted_at is null and {NOT_SEQUENCE} and (w.name like $1 or w.description like $1) limit 5"
        )))
        .bind(&pattern)
        .fetch_all(&caller.db)
        .await?;
        let templates: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category) from workflow_templates t
             where t.deleted_at is null and (t.name like $1 or t.description like $1) limit 5",
        )
        .bind(&pattern)
        .fetch_all(&caller.db)
        .await?;
        let runs: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select jsonb_build_object('id', e.id, 'status', e.status, 'workflowName', w.name)
             from workflow_executions e left join workflows w on e.workflow_id = w.id
             where w.name like $1 and {NOT_SEQUENCE} order by e.started_at desc limit 5"
        )))
        .bind(&pattern)
        .fetch_all(&caller.db)
        .await?;
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
    const TIMED: &str = "e.status = 'completed' and coalesce(e.duration, 0) > 0";
    let row: Result<(i64, i64, Option<f64>, Option<f64>, Option<f64>), sqlx::Error> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select count(*), count(*) filter (where {TIMED}), (avg(e.duration) filter (where {TIMED}))::float8,
                    (min(e.duration) filter (where {TIMED}))::float8, (max(e.duration) filter (where {TIMED}))::float8
             from workflow_executions e
             where (($1::text is not null and e.workflow_id = $1) or ($1::text is null and {NOT_SEQUENCE_RUN}))
               and {NOT_TEST_RUN}"
        )))
        .bind(&workflow_id)
        .fetch_one(&caller.db)
        .await;
    match row {
        Ok((total, completed, avg, min, max)) => {
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

const NOT_SEQUENCE_ERROR: &str = "not exists (select 1 from workflows sw
    where sw.id = l.workflow_id and coalesce(sw.tags, '[]'::jsonb) ? '__type:sequence')";
const NOT_TEST_ERROR: &str = "not exists (select 1 from workflow_executions te
    where te.id = l.execution_id and coalesce(te.execution_context->>'isTest', 'false') = 'true')";

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
    let base = format!(
        "{NOT_SEQUENCE_ERROR} and {NOT_TEST_ERROR} and ($1::text is null or l.workflow_id = $1)"
    );
    let ack = match status.as_str() {
        "unacknowledged" => " and l.acknowledged_at is null",
        "acknowledged" => " and l.acknowledged_at is not null",
        _ => "",
    };
    let filtered = format!("{base}{ack}");
    let result = async {
        let items: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(l) || jsonb_build_object('workflow_name', w.name) from workflow_error_logs l
             left join workflows w on w.id = l.workflow_id where {filtered}
             order by l.occurred_at desc, l.id desc limit $2 offset $3"
        )))
        .bind(&workflow_id)
        .bind(limit)
        .bind((page - 1) * limit)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from workflow_error_logs l where {filtered}"
        )))
        .bind(&workflow_id)
        .fetch_one(&caller.db)
        .await?;
        let unacknowledged: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from workflow_error_logs l where {base} and l.acknowledged_at is null"
        )))
        .bind(&workflow_id)
        .fetch_one(&caller.db)
        .await?;
        let by_type_rows: Vec<(Option<String>, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select l.error_type, count(*) from workflow_error_logs l where {filtered} group by l.error_type"
        )))
        .bind(&workflow_id)
        .fetch_all(&caller.db)
        .await?;
        let by_workflow: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select jsonb_build_object('workflowId', l.workflow_id, 'workflowName', w.name, 'count', count(*))
             from workflow_error_logs l left join workflows w on w.id = l.workflow_id
             where {filtered} group by l.workflow_id, w.name order by count(*) desc limit 10"
        )))
        .bind(&workflow_id)
        .fetch_all(&caller.db)
        .await?;
        let mut by_type = Map::new();
        for (kind, count) in by_type_rows {
            let key = kind
                .filter(|k| !k.is_empty())
                .unwrap_or_else(|| "unknown".into());
            let current = by_type.get(&key).and_then(Value::as_i64).unwrap_or(0);
            by_type.insert(key, json!(current + count));
        }
        Ok::<_, sqlx::Error>(
            Data(json!({
                "total": total,
                "unacknowledged": unacknowledged,
                "byType": by_type,
                "byWorkflow": by_workflow,
                "items": items.into_iter().map(js_row).collect::<Vec<_>>(),
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
        let existing: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(l) from workflow_error_logs l where l.id = $1 limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(existing) = existing else {
            return Err(Refusal::not_found("Error log", &id));
        };
        if !existing["acknowledged_at"].is_null() {
            return Ok(Data(js_row(existing)).into_response());
        }
        let row: Option<Value> = sqlx::query_scalar(
            "update workflow_error_logs l set is_acknowledged = true, acknowledged_at = $2::timestamp,
                acknowledged_by = $3 where l.id = $1 returning to_jsonb(l)",
        )
        .bind(&id)
        .bind(now())
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        match row {
            Some(row) => Ok(Data(js_row(row)).into_response()),
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
    let stamp = now();
    let changed = match target {
        Target::Ids(ids) if ids.is_empty() => Ok(0),
        Target::Ids(ids) => sqlx::query(
            "update workflow_error_logs set is_acknowledged = true, acknowledged_at = $2::timestamp,
                acknowledged_by = $3 where acknowledged_at is null and id = any($1)",
        )
        .bind(&ids)
        .bind(&stamp)
        .bind(&caller.user_id)
        .execute(&caller.db)
        .await
        .map(|r| r.rows_affected()),
        Target::All(workflow_id) => sqlx::query(sqlx::AssertSqlSafe(format!(
            "update workflow_error_logs l set is_acknowledged = true, acknowledged_at = $2::timestamp,
                acknowledged_by = $3 where l.acknowledged_at is null and {NOT_SEQUENCE_ERROR} and {NOT_TEST_ERROR}
                and ($1::text is null or l.workflow_id = $1)"
        )))
        .bind(&workflow_id)
        .bind(&stamp)
        .bind(&caller.user_id)
        .execute(&caller.db)
        .await
        .map(|r| r.rows_affected()),
    };
    match changed {
        Ok(count) => Data(json!({ "acknowledged": count })).into_response(),
        Err(error) => internal(&error, "Failed to acknowledge errors"),
    }
}

async fn resource_usage(caller: Caller) -> Response {
    let result = async {
        let (wf_total, wf_active): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select count(*), count(*) filter (where status = 'active') from workflows w
             where w.deleted_at is null and {NOT_SEQUENCE}"
        )))
        .fetch_one(&caller.db)
        .await?;
        let (total, running, completed, failed): (i64, i64, i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select count(*), count(*) filter (where status = 'running'), count(*) filter (where status = 'completed'),
                    count(*) filter (where status = 'failed')
             from workflow_executions e where {NOT_SEQUENCE_RUN} and {NOT_TEST_RUN}"
        )))
        .fetch_one(&caller.db)
        .await?;
        let (schedules, webhooks) = trigger_counts(&caller.db).await?;
        Ok::<_, sqlx::Error>(Data(json!({
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
