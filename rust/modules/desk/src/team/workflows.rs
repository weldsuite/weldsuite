//! `/api/helpdesk-workflows` (`routes/helpdesk-workflows/index.ts`): the
//! plain CRUD of [`crate::library::WORKFLOWS`], plus `GET /stats`,
//! `GET /for-chaining`, `PATCH /:id/status`, `POST /:id/duplicate`, the
//! default workflows (`POST /seed-defaults`, `POST /reset-defaults`) and
//! `POST /executions/:executionId/resume`. Permissions
//! `tickets:read|create|update|delete`.
//!
//! Resume forwards the response to the workflow engine (`HELPDESK_WORKFLOW`'s
//! `/respond`) when there is one; without it, or when the engine refuses,
//! the execution row is rewritten locally, as TypeScript does.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::write_failed;
use crate::js::query_param;
use crate::library::{TICKETS, WORKFLOWS};
use crate::tables::{HELPDESK_WORKFLOW_EXECUTIONS, HELPDESK_WORKFLOWS};
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    crate::crud::routes(&WORKFLOWS, gate)
        .route("/stats", get(stats).route_layer(need(TICKETS.read)))
        .route(
            "/for-chaining",
            get(for_chaining).route_layer(need(TICKETS.read)),
        )
        .route(
            "/{id}/status",
            patch(set_status).route_layer(need(TICKETS.update)),
        )
        .route(
            "/{id}/duplicate",
            post(duplicate).route_layer(need(TICKETS.create)),
        )
        .route(
            "/seed-defaults",
            post(seed_defaults).route_layer(need(TICKETS.create)),
        )
        .route(
            "/reset-defaults",
            post(reset_defaults).route_layer(need(TICKETS.update)),
        )
        .route(
            "/executions/{execution_id}/resume",
            post(resume).route_layer(need(TICKETS.update)),
        )
}

async fn stats(caller: Caller) -> Response {
    let rows: Result<Vec<(String, i32)>, _> = sqlx::query_as(
        "select status, count(*)::int from helpdesk_workflows where deleted_at is null group by status",
    )
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond("Failed to fetch workflow stats"),
    };
    let (mut total, mut active, mut draft, mut paused) = (0_i64, 0_i64, 0_i64, 0_i64);
    for (status, count) in rows {
        let count = i64::from(count);
        total += count;
        match status.as_str() {
            "active" => active = count,
            "draft" => draft = count,
            "paused" => paused = count,
            _ => {}
        }
    }
    Data(json!({
        "totalWorkflows": total,
        "activeWorkflows": active,
        "draftWorkflows": draft,
        "pausedWorkflows": paused,
        "totalExecutions": 0,
        "successfulExecutions": 0,
        "failedExecutions": 0,
        "pendingExecutions": 0,
    }))
    .into_response()
}

async fn for_chaining(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let exclude = query_param(query.as_deref(), "exclude");
    // No ORDER BY, as TypeScript has none.
    let rows: Result<Vec<(String, String, String)>, _> = sqlx::query_as(
        "select id, name, status from helpdesk_workflows where deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .filter(|(id, _, status)| Some(id) != exclude.as_ref() && status != "archived")
                .map(|(id, name, status)| json!({ "id": id, "name": name, "status": status }))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch workflows"),
    }
}

async fn set_status(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update workflow status";
    let status = match validate(&headers, &body, |issues, fields| {
        issues
            .choice(
                fields,
                "status",
                Presence::Required,
                &["draft", "active", "paused", "archived"],
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(status) => status,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let found: Result<Option<String>, _> = sqlx::query_scalar(
        "select id from helpdesk_workflows where id = $1 and deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match found {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Workflow", &id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    }
    let updated = sqlx::query(
        "update helpdesk_workflows set status = $2, updated_at = $3::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&status)
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = updated {
        return Refusal::Database(error).respond(MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_WORKFLOW_UPDATED,
        &id,
        &json!({ "id": id, "status": status }),
    );
    Data(json!({ "id": id, "status": status })).into_response()
}

async fn duplicate(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to duplicate workflow";
    let name = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "name", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(name) => name,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let table = &HELPDESK_WORKFLOWS;
    let original = match table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Workflow", &id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    // `name || \`${original.name} (Copy)\``.
    let name = name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
        format!(
            "{} (Copy)",
            original["name"].as_str().unwrap_or("undefined")
        )
    });
    let new_id = generate_id("hwfl");
    let now = now();
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| table.set(&mut values, prop, value);
    set("id", json!(new_id));
    set("name", json!(name));
    for prop in ["description"] {
        set(prop, original[prop].clone());
    }
    set("status", json!("draft"));
    for prop in ["triggers", "steps", "settings", "tags", "folderId"] {
        set(prop, original[prop].clone());
    }
    set("createdBy", json!(caller.user_id));
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    let row = match table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, MESSAGE),
    };
    caller.publish(
        &state,
        ev::HELPDESK_WORKFLOW_CREATED,
        &new_id,
        &json!({ "id": new_id, "name": name }),
    );
    Created(row).into_response()
}

// ── default workflows ───────────────────────────────────────────────────────

/// The template ids of the default workflows, in order.
const TEMPLATE_IDS: [&str; 4] = [
    "hwf_tpl_collect_info",
    "hwf_tpl_welcome",
    "hwf_tpl_auto_assign",
    "hwf_tpl_csat_resolved",
];

/// `getDefaultWorkflowDefinitions(now)`: the rows, as `{ prop: value }`.
fn default_workflows() -> Vec<Map<String, Value>> {
    let definitions = [
        json!({
            "name": "Collect Customer Info",
            "description": "Asks unidentified visitors for their name and email before routing the conversation.",
            "status": "active",
            "sortOrder": 5,
            "templateId": "hwf_tpl_collect_info",
            "triggers": [{
                "id": "trg_collect_info", "type": "entity_event", "name": "New conversation from visitor", "isEnabled": true,
                "config": { "type": "entity_event", "entityType": "helpdesk_conversation", "eventType": "created", "channels": ["chat"] },
            }],
            "steps": [
                { "id": "step_collect", "type": "collect_customer_info", "name": "Collect customer data", "order": 1, "config": {}, "inputs": {
                    "message": "Hi there! Before we connect you with our team, could you share your details so we can assist you better?",
                    "fields": [
                        { "id": "name", "label": "Name", "type": "text", "required": false, "placeholder": "Your name" },
                        { "id": "email", "label": "Email", "type": "email", "required": true, "placeholder": "your@email.com" },
                    ],
                } },
                { "id": "step_confirm", "type": "send_message", "name": "Confirmation", "order": 2, "config": {}, "inputs": { "message": "Thanks! Let me connect you with our team now." } },
            ],
        }),
        json!({
            "name": "Welcome Message",
            "description": "Sends a friendly greeting when a new conversation starts. Enable this instead of \"Collect Customer Info\" if you don't need to collect visitor emails.",
            "status": "draft",
            "sortOrder": 10,
            "templateId": "hwf_tpl_welcome",
            "triggers": [{
                "id": "trg_welcome", "type": "entity_event", "name": "New conversation created", "isEnabled": true,
                "config": { "type": "entity_event", "entityType": "helpdesk_conversation", "eventType": "created", "channels": ["chat"] },
            }],
            "steps": [
                { "id": "step_greet", "type": "send_message", "name": "Send welcome message", "order": 1, "config": {}, "inputs": { "message": "Welcome! We typically respond within a few minutes during business hours (Mon-Fri, 9AM-5PM). How can we help you today?" } },
            ],
        }),
        json!({
            "name": "Auto-Assign Round Robin",
            "description": "Automatically assigns new conversations to available agents in round-robin order.",
            "status": "draft",
            "sortOrder": 20,
            "templateId": "hwf_tpl_auto_assign",
            "triggers": [{
                "id": "trg_auto_assign", "type": "entity_event", "name": "New conversation created", "isEnabled": true,
                "config": { "type": "entity_event", "entityType": "helpdesk_conversation", "eventType": "created" },
            }],
            "steps": [
                { "id": "step_assign", "type": "assign_conversation", "name": "Round-robin assignment", "order": 1, "config": {}, "inputs": { "strategy": "round_robin" } },
                { "id": "step_notify", "type": "send_notification", "name": "Notify assigned agent", "order": 2, "config": {}, "inputs": { "title": "New conversation assigned", "body": "A new conversation has been assigned to you." } },
            ],
        }),
        json!({
            "name": "CSAT After Resolution",
            "description": "Sends a customer satisfaction survey after a conversation is resolved.",
            "status": "draft",
            "sortOrder": 30,
            "templateId": "hwf_tpl_csat_resolved",
            "triggers": [{
                "id": "trg_csat_resolved", "type": "entity_event", "name": "Conversation resolved", "isEnabled": true,
                "config": { "type": "entity_event", "entityType": "helpdesk_conversation", "eventType": "status_changed", "filters": [{ "field": "status", "operator": "equals", "value": "resolved" }] },
            }],
            "steps": [
                { "id": "step_delay", "type": "delay", "name": "Wait before sending survey", "order": 1, "config": {}, "inputs": { "minutes": 60 } },
                { "id": "step_send_csat", "type": "trigger_csat", "name": "Send CSAT survey", "order": 2, "config": {}, "inputs": { "delayMinutes": 0 } },
            ],
        }),
    ];
    let now = now();
    definitions
        .into_iter()
        .map(|definition| {
            let mut row = Map::new();
            row.insert("id".to_owned(), json!(generate_id("hwfl")));
            if let Value::Object(fields) = definition {
                row.extend(fields);
            }
            row.insert("version".to_owned(), json!(1));
            row.insert("createdBy".to_owned(), json!("system"));
            row.insert("tags".to_owned(), json!(["system-default"]));
            row.insert("settings".to_owned(), json!({ "logLevel": "info" }));
            row.insert("createdAt".to_owned(), json!(now));
            row.insert("updatedAt".to_owned(), json!(now));
            row
        })
        .collect()
}

/// Insert the default rows, one statement for all of them as Drizzle does.
async fn insert_defaults(
    caller: &Caller,
    rows: &[Map<String, Value>],
) -> Result<(), crate::table::WriteError> {
    let table = &HELPDESK_WORKFLOWS;
    let mut tx = caller.db.begin().await?;
    for row in rows {
        table
            .insert(&mut *tx, table.values(row), &["createdAt", "updatedAt"])
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn text_of<'a>(row: &'a Map<String, Value>, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn created_event(state: &DeskState, caller: &Caller, row: &Map<String, Value>) {
    let id = text_of(row, "id");
    caller.publish(
        state,
        ev::HELPDESK_WORKFLOW_CREATED,
        id,
        &json!({ "id": id, "name": row["name"], "templateId": row["templateId"] }),
    );
}

async fn seed_defaults(State(state): State<DeskState>, caller: Caller) -> Response {
    const MESSAGE: &str = "Failed to seed default workflows";
    let existing: Result<Vec<Option<String>>, _> = sqlx::query_scalar(
        "select template_id from helpdesk_workflows where template_id = any($1)",
    )
    .bind(TEMPLATE_IDS.map(str::to_owned).to_vec())
    .fetch_all(&caller.db)
    .await;
    let existing = match existing {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let missing: Vec<&str> = TEMPLATE_IDS
        .into_iter()
        .filter(|id| !existing.iter().any(|e| e.as_deref() == Some(*id)))
        .collect();
    if missing.is_empty() {
        return Data(json!({ "seeded": 0, "message": "All default workflows already exist" }))
            .into_response();
    }
    let rows: Vec<Map<String, Value>> = default_workflows()
        .into_iter()
        .filter(|row| missing.contains(&text_of(row, "templateId")))
        .collect();
    if !rows.is_empty() {
        if let Err(error) = insert_defaults(&caller, &rows).await {
            return write_failed(&error, MESSAGE);
        }
        for row in &rows {
            created_event(&state, &caller, row);
        }
    }
    let template_ids: Vec<&str> = rows.iter().map(|row| text_of(row, "templateId")).collect();
    Created(json!({ "seeded": rows.len(), "templateIds": template_ids })).into_response()
}

async fn reset_defaults(State(state): State<DeskState>, caller: Caller) -> Response {
    const MESSAGE: &str = "Failed to reset default workflows";
    let deleted: Result<Vec<String>, _> = sqlx::query_scalar(
        "delete from helpdesk_workflows where template_id = any($1) returning id",
    )
    .bind(TEMPLATE_IDS.map(str::to_owned).to_vec())
    .fetch_all(&caller.db)
    .await;
    let deleted = match deleted {
        Ok(ids) => ids,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let rows = default_workflows();
    if let Err(error) = insert_defaults(&caller, &rows).await {
        return write_failed(&error, MESSAGE);
    }
    for id in &deleted {
        caller.publish(
            &state,
            ev::HELPDESK_WORKFLOW_DELETED,
            id,
            &json!({ "id": id }),
        );
    }
    for row in &rows {
        created_event(&state, &caller, row);
    }
    let template_ids: Vec<&str> = rows.iter().map(|row| text_of(row, "templateId")).collect();
    Data(json!({
        "deleted": deleted.len(),
        "created": rows.len(),
        "templateIds": template_ids,
    }))
    .into_response()
}

// ── resume ──────────────────────────────────────────────────────────────────

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

async fn resume(
    State(state): State<DeskState>,
    caller: Caller,
    Path(execution_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to resume execution";
    let read = validate(&headers, &body, |issues, fields| {
        let step = issues.text(fields, "stepId", Presence::Required, None, None);
        let response = issues.nested(fields, "response", Presence::Required, |_, map| map.clone());
        (
            step.into_option().unwrap_or_default(),
            response.into_option().unwrap_or_default(),
        )
    });
    let (step_id, response) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let execution = match HELPDESK_WORKFLOW_EXECUTIONS
        .find_live(&caller.db, &execution_id)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Execution", &execution_id).respond(MESSAGE),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let status = &execution["status"];
    if status.as_str() != Some("waiting_for_input") {
        let shown = status
            .as_str()
            .map_or_else(|| status.to_string(), str::to_owned);
        return Refusal::bad_request(format!(
            "Execution is not waiting for input (status: {shown})"
        ))
        .respond(MESSAGE);
    }
    // Forward to the engine's `/respond` (the real resume path).
    let mut forwarded = false;
    let conversation = execution["conversationId"].as_str().filter(|c| !c.is_empty());
    if let Some(conversation) = conversation
        && !caller.clerk_org_id.is_empty()
    {
        let mut forward = Map::new();
        forward.insert("conversationId".to_owned(), json!(conversation));
        forward.insert("workspaceId".to_owned(), json!(caller.clerk_org_id));
        forward.insert("executionId".to_owned(), json!(execution_id));
        forward.insert("stepId".to_owned(), json!(step_id));
        for key in [
            "selectedValue",
            "selectedLabel",
            "submittedData",
            "rating",
            "feedback",
        ] {
            if let Some(value) = response.get(key) {
                forward.insert(key.to_owned(), value.clone());
            }
        }
        match state.workflow.respond(&Value::Object(forward)).await {
            Ok(answer) if (200..300).contains(&answer.status) => forwarded = true,
            Ok(answer) => tracing::error!(
                status = answer.status,
                "[app-api/helpdesk-workflows] resume forward to workflow worker failed"
            ),
            Err(weldsuite_desk_domain::workflow::EngineError::Unavailable) => {}
            Err(error) => tracing::error!(
                ?error,
                "[app-api/helpdesk-workflows] resume forward to workflow worker failed"
            ),
        }
    }
    if !forwarded {
        // The local fallback: record the response, flip to running.
        let raw = &execution["executionContext"];
        let mut context = match raw {
            Value::Object(map) if truthy(raw) => map.clone(),
            _ => Map::new(),
        };
        let variables = context
            .get("variables")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}));
        context.insert("variables".to_owned(), variables);
        let mut outputs = match context.get("stepOutputs") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        outputs.insert(step_id.clone(), Value::Object(response.clone()));
        context.insert("stepOutputs".to_owned(), Value::Object(outputs));
        context.remove("waitingForInput");
        let index = execution["currentStepIndex"].as_i64().unwrap_or(0) + 1;
        let updated = sqlx::query(
            "update helpdesk_workflow_executions set status = 'running', execution_context = $2,
                 current_step_index = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&execution_id)
        .bind(Value::Object(context))
        .bind(i32::try_from(index).unwrap_or(i32::MAX))
        .bind(now())
        .execute(&caller.db)
        .await;
        if let Err(error) = updated {
            return Refusal::Database(error).respond(MESSAGE);
        }
    }
    Data(json!({ "resumed": true, "executionId": execution_id, "forwarded": forwarded }))
        .into_response()
}
