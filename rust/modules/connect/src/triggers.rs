//! `/api/workflow-triggers` (`routes/workflow-triggers/index.ts`): the
//! standalone `workflow_triggers` rows (entity and schedule shortcuts
//! included).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_TRIGGER_CREATED, WORKFLOW_TRIGGER_DELETED, WORKFLOW_TRIGGER_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::schedules::{CreateError, NewSchedule, create_schedule};
use crate::sync::SyncContext;
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

const CATEGORIES: &[&str] = &["schedule", "entity_event", "webhook", "manual", "api"];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    let create = || gate.require([perm::WORKFLOWS_CREATE]);
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_route).route_layer(create()))
        .route("/entity", post(create_entity).route_layer(create()))
        .route(
            "/schedule",
            post(create_schedule_trigger).route_layer(create()),
        )
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update_route)
                .patch(update_route)
                .route_layer(update()),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete).route_layer(gate.require([perm::WORKFLOWS_DELETE])),
        )
        .route("/{id}/enable", patch(enable).route_layer(update()))
        .route("/{id}/disable", patch(disable).route_layer(update()))
}

const JOINED: &str = "to_jsonb(t) || jsonb_build_object('workflowName', w.name)";

/// `{ ...trigger, workflowName }`: the row read as Drizzle reads it.
fn joined(row: Value) -> Value {
    let name = row.get("workflowName").cloned().unwrap_or(Value::Null);
    let mut row = js_row(row);
    if let Value::Object(map) = &mut row {
        map.insert("workflowName".into(), name);
    }
    row
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let category = query_truthy(query, "category");
    let enabled = query_param(query, "isEnabled").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.workflow_id = $1)
        and ($2::text is null or t.category = $2) and ($3::boolean is null or t.is_enabled = $3)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {JOINED} from workflow_triggers t left join workflows w on t.workflow_id = w.id
         where {FILTER} and ($4::text is null or t.id < $4)
         order by t.created_at desc, t.id desc limit $5"
    )))
    .bind(&workflow_id)
    .bind(&category)
    .bind(enabled)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_triggers t where {FILTER}"
    )))
    .bind(&workflow_id)
    .bind(&category)
    .bind(enabled)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(joined).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow triggers"),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {JOINED} from workflow_triggers t left join workflows w on t.workflow_id = w.id
         where t.id = $1 and t.deleted_at is null limit 1"
    )))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => Data(joined(row)).into_response(),
        Ok(None) => ApiError::not_found("Workflow trigger", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow trigger"),
    }
}

async fn trigger_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_triggers t where t.id = $1 and ($2 = false or t.deleted_at is null) limit 1",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn workflow_exists(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from workflows where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

fn record(issues: &mut Issues, b: &Map<String, Value>, key: &str) -> Field<Value> {
    issues.nested(b, key, Presence::Optional, |_, fields| {
        Value::Object(fields.clone())
    })
}

async fn insert_trigger(
    db: &PgPool,
    workflow_id: &str,
    name: &str,
    category: &str,
    config: &Value,
    enabled: bool,
) -> Result<String, sqlx::Error> {
    let id = generate_id("trg");
    sqlx::query(
        "insert into workflow_triggers (id, workflow_id, name, category, config, is_enabled, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)",
    )
    .bind(&id)
    .bind(workflow_id)
    .bind(name)
    .bind(category)
    .bind(config)
    .bind(enabled)
    .bind(now())
    .execute(db)
    .await?;
    Ok(id)
}

async fn create_route(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Required, Some(1), Some(255))
            .into_option();
        let category = issues
            .choice(b, "category", Presence::Required, CATEGORIES)
            .into_option();
        let config = record(issues, b, "config").into_option();
        let enabled = issues
            .boolean(b, "isEnabled", Presence::Optional)
            .into_option();
        (
            workflow_id.unwrap_or_default(),
            name.unwrap_or_default(),
            category.unwrap_or_default(),
            config,
            enabled,
        )
    });
    let (workflow_id, name, category, config, enabled) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create workflow trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let config = config.unwrap_or_else(|| json!({}));
        let id = insert_trigger(
            &caller.db,
            &workflow_id,
            &name,
            &category,
            &config,
            enabled.unwrap_or(true),
        )
        .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id, "category": category }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create workflow trigger"))
}

async fn create_entity(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Optional, None, None)
            .into_option();
        let entity_type = issues
            .text(b, "entityType", Presence::Required, None, None)
            .into_option();
        let event_type = issues
            .text(b, "eventType", Presence::Required, None, None)
            .into_option();
        let filters = record(issues, b, "filters").into_option();
        (
            workflow_id.unwrap_or_default(),
            name,
            entity_type,
            event_type,
            filters,
        )
    });
    let (workflow_id, name, entity_type, event_type, filters) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create entity trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let mut config = json!({ "entityType": entity_type, "eventType": event_type });
        if let Some(filters) = filters {
            config["filters"] = filters;
        }
        let name = name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Entity Event Trigger".into());
        let id = insert_trigger(
            &caller.db,
            &workflow_id,
            &name,
            "entity_event",
            &config,
            true,
        )
        .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id, "category": "entity_event" }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create entity trigger"))
}

async fn create_schedule_trigger(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Optional, None, None)
            .into_option();
        let cron = issues
            .text(b, "cronExpression", Presence::Required, None, None)
            .into_option();
        let timezone = issues
            .text(b, "timezone", Presence::Optional, None, None)
            .into_option();
        let start = issues
            .text(b, "startDate", Presence::Optional, None, None)
            .into_option();
        let end = issues
            .text(b, "endDate", Presence::Optional, None, None)
            .into_option();
        (
            workflow_id.unwrap_or_default(),
            name,
            cron.unwrap_or_default(),
            timezone,
            start,
            end,
        )
    });
    let (workflow_id, name, cron, timezone, start, end) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create schedule trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let timezone = timezone
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "UTC".into());
        let mut config = json!({ "cronExpression": cron, "timezone": timezone });
        if let Some(start) = &start {
            config["startDate"] = json!(start);
        }
        if let Some(end) = &end {
            config["endDate"] = json!(end);
        }
        let trigger_name = name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Schedule Trigger".into());
        let trigger_id = insert_trigger(
            &caller.db,
            &workflow_id,
            &trigger_name,
            "schedule",
            &config,
            true,
        )
        .await?;
        let ctx = SyncContext::for_caller(&caller, &state);
        let created = create_schedule(
            &caller.db,
            &ctx,
            NewSchedule {
                workflow_id: workflow_id.clone(),
                trigger_id: Some(trigger_id.clone()),
                name: Some(
                    name.filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "Schedule".into()),
                ),
                cron_expression: cron,
                timezone: Some(timezone),
                start_date: start,
                end_date: end,
                is_enabled: true,
            },
        )
        .await;
        let schedule_id = match created {
            Ok(id) => id,
            Err(CreateError::WorkflowNotFound) => {
                return Err(Refusal::not_found("Workflow", &workflow_id));
            }
            Err(CreateError::InvalidDate) => {
                return Err(Refusal::Response(Box::new(internal(
                    &"Invalid time value",
                    "Failed to create schedule trigger",
                ))));
            }
            Err(CreateError::Database(error)) => return Err(error.into()),
        };
        let trigger = trigger_row(&caller.db, &trigger_id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &trigger_id,
            &json!({ "id": trigger_id, "workflowId": workflow_id, "category": "schedule", "scheduleId": schedule_id }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create schedule trigger"))
}

async fn update_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let name = issues.text(b, "name", Presence::Optional, Some(1), Some(255));
        let category = issues.choice(b, "category", Presence::Optional, CATEGORIES);
        let config = record(issues, b, "config");
        let enabled = issues.boolean(b, "isEnabled", Presence::Optional);
        (name, category, config, enabled)
    });
    let (name, category, config, enabled) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update workflow trigger"),
    };
    let result = async {
        let Some(existing) = trigger_row(&caller.db, &id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", &id));
        };
        sqlx::query(
            "update workflow_triggers set updated_at = $2::timestamp,
                name = case when $3 then $4 else name end,
                category = case when $5 then $6 else category end,
                config = case when $7 then $8 else config end,
                is_enabled = case when $9 then $10 else is_enabled end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(!name.is_absent())
        .bind(name.as_set())
        .bind(!category.is_absent())
        .bind(category.as_set())
        .bind(!config.is_absent())
        .bind(config.as_set())
        .bind(!enabled.is_absent())
        .bind(enabled.as_set().copied())
        .execute(&caller.db)
        .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(Data(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow trigger"))
}

async fn set_enabled(state: &ConnectState, caller: &Caller, id: &str, enabled: bool) -> Response {
    let result = async {
        let Some(existing) = trigger_row(&caller.db, id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", id));
        };
        sqlx::query("update workflow_triggers set is_enabled = $2, updated_at = $3::timestamp where id = $1")
            .bind(id)
            .bind(enabled)
            .bind(now())
            .execute(&caller.db)
            .await?;
        let trigger = trigger_row(&caller.db, id, false).await?;
        caller.publish(
            state,
            WORKFLOW_TRIGGER_UPDATED,
            id,
            &json!({ "id": id, "workflowId": existing["workflowId"], "isEnabled": enabled }),
        );
        Ok(Data(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to toggle workflow trigger"))
}

async fn enable(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_enabled(&state, &caller, &id, true).await
}

async fn disable(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_enabled(&state, &caller, &id, false).await
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = trigger_row(&caller.db, &id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", &id));
        };
        let stamp = now();
        sqlx::query("update workflow_triggers set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&stamp)
            .execute(&caller.db)
            .await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_DELETED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow trigger"))
}
