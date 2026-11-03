//! WeldConnect's objects: `/v1/webhooks` (`routes/v1/webhooks/index.ts`)
//! and `/v1/workflows` with their schedules and (read-only) executions
//! (`routes/v1/workflows/index.ts`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    self, WORKFLOW_CREATED, WORKFLOW_DELETED, WORKFLOW_SCHEDULE_CREATED, WORKFLOW_SCHEDULE_DELETED,
    WORKFLOW_SCHEDULE_UPDATED, WORKFLOW_UPDATED, WORKFLOW_WEBHOOK_CREATED,
    WORKFLOW_WEBHOOK_DELETED, WORKFLOW_WEBHOOK_UPDATED,
};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, created, dates, field, flag, get_live, like, no_content, now, ok, page,
    soft_delete, table_list_sql, text, to_date, with_updated,
};
use crate::schemas::{
    CREATE_WEBHOOK, LIST_EXECUTIONS, LIST_SCHEDULES, LIST_WEBHOOKS, LIST_WORKFLOWS, UPDATE_WEBHOOK,
};
use crate::schemas_gen::{CREATE_SCHEDULE, CREATE_WORKFLOW, UPDATE_SCHEDULE, UPDATE_WORKFLOW};
use crate::session::not_found;
use crate::simple::scoped;
use crate::tables_gen::{WORKFLOW_EXECUTIONS, WORKFLOW_SCHEDULES, WORKFLOW_WEBHOOKS, WORKFLOWS};
use crate::zod;

type S = State<ExternalApiState>;

/// Connect's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/webhooks/events",
            scoped(get(webhook_events), "webhooks:read"),
        )
        .route(
            "/webhooks",
            scoped(get(list_webhooks), "webhooks:read")
                .merge(scoped(post(create_webhook), "webhooks:write")),
        )
        .route(
            "/webhooks/{id}",
            scoped(get(get_webhook), "webhooks:read").merge(scoped(
                patch(update_webhook).delete(delete_webhook),
                "webhooks:write",
            )),
        )
        .route(
            "/workflows",
            scoped(get(list_workflows), "workflows:read")
                .merge(scoped(post(create_workflow), "workflows:write")),
        )
        .route(
            "/workflows/{id}",
            scoped(get(get_workflow), "workflows:read").merge(scoped(
                patch(update_workflow).delete(delete_workflow),
                "workflows:write",
            )),
        )
        .route(
            "/workflows/{workflow_id}/schedules",
            scoped(get(list_schedules), "workflows:read")
                .merge(scoped(post(create_schedule), "workflows:write")),
        )
        .route(
            "/workflows/{workflow_id}/schedules/{id}",
            scoped(get(get_schedule), "workflows:read").merge(scoped(
                patch(update_schedule).delete(delete_schedule),
                "workflows:write",
            )),
        )
        .route(
            "/workflows/{workflow_id}/executions",
            scoped(get(list_executions), "workflows:read"),
        )
        .route(
            "/workflows/{workflow_id}/executions/{id}",
            scoped(get(get_execution), "workflows:read"),
        )
}

// ── webhooks ─────────────────────────────────────────────────────────────────

/// `listAllEvents()` as `{ event, entity, action }`, in the catalog's own
/// declaration order.
fn all_events() -> Vec<Value> {
    let mut out = Vec::new();
    for entity in entity_events::ORDER {
        let Some((_, actions)) = entity_events::ALL.iter().find(|(known, _)| known == entity)
        else {
            continue;
        };
        for action in *actions {
            out.push(json!({ "event": format!("{entity}.{action}"), "entity": entity, "action": action }));
        }
    }
    out
}

async fn webhook_events() -> Answer {
    ok(Value::Array(all_events()))
}

const WEBHOOKS_LIST: (&str, &str) = table_list_sql!(
    workflow_webhooks,
    "t.deleted_at is null \
     and ($3->>'workflowId' is null or t.workflow_id = $3->>'workflowId') \
     and ($3->>'isEnabled' is null or t.is_enabled = ($3->>'isEnabled')::boolean)"
);

async fn list_webhooks(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_WEBHOOKS, raw.as_deref())?;
    let filters = json!({
        "workflowId": text(&q, "workflowId"),
        "isEnabled": flag(&q, "isEnabled"),
    });
    page(&caller.db, WEBHOOKS_LIST, &WORKFLOW_WEBHOOKS, &q, filters).await
}

async fn get_webhook(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &WORKFLOW_WEBHOOKS, "Webhook", &id).await
}

/// The body's webhook fields as columns (`url` is `externalUrl`).
fn webhook_columns(body: &Map<String, Value>, values: &mut Map<String, Value>) {
    for (key, column) in [
        ("name", "name"),
        ("description", "description"),
        ("workflowId", "workflowId"),
        ("url", "externalUrl"),
        ("isEnabled", "isEnabled"),
        ("allowedMethods", "allowedMethods"),
        ("headers", "headers"),
    ] {
        if let Some(value) = body.get(key) {
            values.insert(column.into(), value.clone());
        }
    }
}

async fn create_webhook(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_WEBHOOK, &headers, &body)?;
    let body = &parsed.body;
    let stamp = now();
    let id = generate_id("wh");
    // workflowId is NOT NULL: a placeholder until it is linked with PATCH.
    let workflow_id = body.get("workflowId").cloned().unwrap_or_else(|| json!(""));
    let mut values = Map::new();
    webhook_columns(body, &mut values);
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values.insert("workflowId".into(), workflow_id.clone());
    values.insert(
        "isEnabled".into(),
        body.get("isEnabled").cloned().unwrap_or(json!(true)),
    );
    let row = WORKFLOW_WEBHOOKS
        .insert(&caller.db, &values, &["createdAt", "updatedAt"])
        .await?;
    caller.publish(
        &state.events,
        WORKFLOW_WEBHOOK_CREATED,
        &id,
        json!({ "id": id, "workflowId": workflow_id }),
    );
    created(row)
}

async fn update_webhook(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_WEBHOOK, &headers, &body)?;
    let mut updates = Map::new();
    updates.insert("updatedAt".into(), json!(now()));
    webhook_columns(&parsed.body, &mut updates);
    let row = WORKFLOW_WEBHOOKS
        .patch(&caller.db, &id, &updates, true, &["updatedAt"])
        .await?
        .ok_or_else(|| not_found("Webhook", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_WEBHOOK_UPDATED,
        &id,
        json!({ "id": id, "workflowId": field(&row, "workflowId") }),
    );
    ok(row)
}

async fn delete_webhook(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &WORKFLOW_WEBHOOKS, &id)
        .await?
        .ok_or_else(|| not_found("Webhook", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_WEBHOOK_DELETED,
        &id,
        json!({ "id": id, "workflowId": field(&row, "workflowId") }),
    );
    no_content()
}

// ── workflows ────────────────────────────────────────────────────────────────

const WORKFLOWS_LIST: (&str, &str) = table_list_sql!(
    workflows,
    "t.deleted_at is null \
     and ($3->>'search' is null or (t.name like $3->>'search' or t.description like $3->>'search')) \
     and ($3->>'status' is null or t.status::text = $3->>'status') \
     and ($3->>'folderId' is null or t.folder_id = $3->>'folderId')"
);

async fn list_workflows(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_WORKFLOWS, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "folderId": text(&q, "folderId"),
    });
    page(&caller.db, WORKFLOWS_LIST, &WORKFLOWS, &q, filters).await
}

async fn get_workflow(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &WORKFLOWS, "Workflow", &id).await
}

async fn create_workflow(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_WORKFLOW, &headers, &body)?;
    let stamp = now();
    let id = generate_id("wf");
    let mut values = parsed.body.clone();
    let mut or_default = |key: &str, fallback: Value| {
        if matches!(values.get(key), None | Some(Value::Null)) {
            values.insert(key.into(), fallback);
        }
    };
    or_default("status", json!("draft"));
    or_default("triggers", json!([]));
    or_default("steps", json!([]));
    or_default("settings", json!({}));
    or_default("tags", json!([]));
    values.insert("id".into(), json!(id));
    values.insert("createdBy".into(), json!(caller.session.actor()));
    values.insert("version".into(), json!(1));
    values.insert("executionCount".into(), json!(0));
    values.insert("successCount".into(), json!(0));
    values.insert("failureCount".into(), json!(0));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = WORKFLOWS
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        WORKFLOW_CREATED,
        &id,
        json!({ "id": id, "name": field(&row, "name") }),
    );
    created(row)
}

async fn update_workflow(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_WORKFLOW, &headers, &body)?;
    let row = WORKFLOWS
        .patch(
            &caller.db,
            &id,
            &with_updated(&parsed.body, &now()),
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Workflow", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_UPDATED,
        &id,
        json!({ "id": id, "name": field(&row, "name"), "status": field(&row, "status") }),
    );
    ok(row)
}

async fn delete_workflow(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &WORKFLOWS, &id)
        .await?
        .ok_or_else(|| not_found("Workflow", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_DELETED,
        &id,
        json!({ "id": id, "name": field(&row, "name"), "status": field(&row, "status") }),
    );
    no_content()
}

// ── schedules ────────────────────────────────────────────────────────────────

const SCHEDULES_LIST: (&str, &str) = table_list_sql!(
    workflow_schedules,
    "t.deleted_at is null and t.workflow_id = $3->>'workflowId' \
     and ($3->>'isEnabled' is null or t.is_enabled = ($3->>'isEnabled')::boolean)"
);

async fn list_schedules(
    caller: Caller,
    Path(workflow_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&LIST_SCHEDULES, raw.as_deref())?;
    let filters = json!({ "workflowId": workflow_id, "isEnabled": flag(&q, "isEnabled") });
    page(&caller.db, SCHEDULES_LIST, &WORKFLOW_SCHEDULES, &q, filters).await
}

async fn get_schedule(caller: Caller, Path((_workflow, id)): Path<(String, String)>) -> Answer {
    get_live(&caller.db, &WORKFLOW_SCHEDULES, "WorkflowSchedule", &id).await
}

/// `startDate` / `endDate` as `Date`s: on create a falsy one is left out,
/// on update a string becomes a `Date`. The properties now holding one.
fn schedule_dates(
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Vec<&'static str>, crate::crud::Fail> {
    let mut out = Vec::new();
    for key in ["startDate", "endDate"] {
        match values.get(key).cloned() {
            Some(Value::String(text)) if !text.is_empty() || !create => {
                values.insert(key.into(), to_date(&text)?);
                out.push(key);
            }
            Some(value) if create && !js_truthy(&value) => {
                values.remove(key);
            }
            _ => {}
        }
    }
    Ok(out)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

async fn create_schedule(
    State(state): S,
    caller: Caller,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_SCHEDULE, &headers, &body)?;
    if WORKFLOWS
        .find_live(&caller.db, &workflow_id)
        .await?
        .is_none()
    {
        return Err(not_found("Workflow", &workflow_id).into());
    }
    let stamp = now();
    let id = generate_id("wfs");
    let mut values = parsed.body.clone();
    let mut own = schedule_dates(&mut values, true)?;
    values.insert("id".into(), json!(id));
    values.insert("workflowId".into(), json!(workflow_id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    own.extend(["createdAt", "updatedAt"]);
    let row = WORKFLOW_SCHEDULES
        .insert(&caller.db, &values, &dates(&parsed, &own))
        .await?;
    caller.publish(
        &state.events,
        WORKFLOW_SCHEDULE_CREATED,
        &id,
        json!({ "id": id, "workflowId": workflow_id }),
    );
    created(row)
}

async fn update_schedule(
    State(state): S,
    caller: Caller,
    Path((_workflow, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_SCHEDULE, &headers, &body)?;
    let mut values = with_updated(&parsed.body, &now());
    let mut own = schedule_dates(&mut values, false)?;
    own.push("updatedAt");
    let row = WORKFLOW_SCHEDULES
        .patch(&caller.db, &id, &values, true, &dates(&parsed, &own))
        .await?
        .ok_or_else(|| not_found("WorkflowSchedule", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_SCHEDULE_UPDATED,
        &id,
        json!({ "id": id }),
    );
    ok(row)
}

async fn delete_schedule(
    State(state): S,
    caller: Caller,
    Path((_workflow, id)): Path<(String, String)>,
) -> Answer {
    soft_delete(&caller.db, &WORKFLOW_SCHEDULES, &id)
        .await?
        .ok_or_else(|| not_found("WorkflowSchedule", &id))?;
    caller.publish(
        &state.events,
        WORKFLOW_SCHEDULE_DELETED,
        &id,
        json!({ "id": id }),
    );
    no_content()
}

// ── executions ───────────────────────────────────────────────────────────────

const EXECUTIONS_LIST: (&str, &str) = table_list_sql!(
    workflow_executions,
    "t.workflow_id = $3->>'workflowId' \
     and ($3->>'status' is null or t.status::text = $3->>'status')"
);

async fn list_executions(
    caller: Caller,
    Path(workflow_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&LIST_EXECUTIONS, raw.as_deref())?;
    let filters = json!({ "workflowId": workflow_id, "status": text(&q, "status") });
    page(
        &caller.db,
        EXECUTIONS_LIST,
        &WORKFLOW_EXECUTIONS,
        &q,
        filters,
    )
    .await
}

async fn get_execution(caller: Caller, Path((_workflow, id)): Path<(String, String)>) -> Answer {
    match WORKFLOW_EXECUTIONS.find_any(&caller.db, &id).await? {
        Some(row) => ok(row),
        None => Err(not_found("WorkflowExecution", &id).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_list_in_declaration_order() {
        let events = all_events();
        let total: usize = entity_events::ALL.iter().map(|(_, a)| a.len()).sum();
        assert_eq!(events.len(), total);
        assert_eq!(
            events[0]["entity"],
            json!(entity_events::ORDER[0]),
            "the first event is of the first declared entity type"
        );
    }
}
