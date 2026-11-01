//! `/api/workflow-builder` (`routes/workflow-builder/index.ts`,
//! `services/workflow-builder.ts`): the AI builder's drafts, which are
//! `workflows` rows with their chat state in `settings.builderState`. The
//! chat itself answers 503, as on Global since the AI teardown.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{WORKFLOW_CREATED, WORKFLOW_UPDATED};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::workflows::get_workflow;
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    Router::new()
        .route(
            "/drafts",
            post(create).route_layer(gate.require([perm::WORKFLOWS_CREATE])),
        )
        .route(
            "/drafts/{id}",
            get(get_one).route_layer(gate.require([perm::WORKFLOWS_READ])),
        )
        .route("/drafts/{id}/chat", post(chat).route_layer(update()))
        .route(
            "/drafts/{id}/finalize",
            post(finalize).route_layer(update()),
        )
}

/// `rowToDraft(row)`.
fn draft(row: &Value) -> Value {
    let trigger = match row["triggers"].as_array().and_then(|t| t.first()) {
        Some(t) => {
            let mut node = Map::new();
            if let Some(id) = t.get("id") {
                node.insert("id".into(), id.clone());
            }
            node.insert("kind".into(), json!("trigger"));
            if let Some(kind) = t.get("type") {
                node.insert("triggerType".into(), kind.clone());
            }
            if let Some(name) = t.get("name") {
                node.insert("label".into(), name.clone());
            }
            node.insert(
                "config".into(),
                match t.get("config") {
                    None | Some(Value::Null) => json!({}),
                    Some(config) => config.clone(),
                },
            );
            Value::Object(node)
        }
        None => Value::Null,
    };
    let steps: Vec<Value> = crate::js::array(row.get("steps"))
        .iter()
        .map(|step| {
            let config = step.get("config").filter(|c| !c.is_null());
            let mut node = Map::new();
            if let Some(id) = step.get("id") {
                node.insert("id".into(), id.clone());
            }
            if step.get("type").and_then(Value::as_str) == Some("condition") {
                node.insert("kind".into(), json!("condition"));
                if let Some(name) = step.get("name") {
                    node.insert("label".into(), name.clone());
                }
                let field = |key: &str, fallback: Value| {
                    config
                        .and_then(|c| c.get(key))
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(fallback)
                };
                node.insert("expression".into(), field("expression", json!("")));
                node.insert("branches".into(), field("branches", json!([])));
            } else {
                node.insert("kind".into(), json!("action"));
                if let Some(kind) = step.get("type") {
                    node.insert("actionType".into(), kind.clone());
                }
                if let Some(name) = step.get("name") {
                    node.insert("label".into(), name.clone());
                }
                if let Some(description) = step.get("description") {
                    node.insert("description".into(), description.clone());
                }
                node.insert(
                    "config".into(),
                    config.cloned().unwrap_or_else(|| json!({})),
                );
            }
            Value::Object(node)
        })
        .collect();
    json!({
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "status": row["status"],
        "trigger": trigger,
        "steps": steps,
        "finalized": row["settings"]["builderState"]["finalized"].as_bool().unwrap_or(false),
    })
}

async fn create(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(refusal) = validate(&headers, &body, |issues, b| {
        issues.text_with(
            b,
            "initialMessage",
            Presence::Optional,
            Text::length(None, Some(2000)),
        );
    }) {
        return refusal.respond("Failed to create builder draft");
    }
    let result = async {
        let id = generate_id("wf");
        let stamp = now();
        sqlx::query(
            "insert into workflows
                (id, name, description, status, triggers, steps, settings, tags, created_by, version,
                 execution_count, success_count, failure_count, created_at, updated_at)
             values ($1, 'Untitled AI workflow', null, 'draft', '[]'::jsonb, '[]'::jsonb, $2, '[\"ai-builder\"]'::jsonb,
                     $3, 1, 0, 0, 0, $4::timestamp, $4::timestamp)",
        )
        .bind(&id)
        .bind(json!({ "builderState": { "isBuilderDraft": true, "chatHistory": [], "finalized": false } }))
        .bind(&caller.user_id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        let row = get_workflow(&caller.db, &id).await?.unwrap_or(Value::Null);
        let draft = draft(&row);
        caller.publish(
            &state,
            WORKFLOW_CREATED,
            &id,
            &json!({ "id": id, "name": draft["name"], "status": draft["status"] }),
        );
        Ok::<_, sqlx::Error>(Created(draft).into_response())
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to create builder draft"))
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_workflow(&caller.db, &id).await {
        Ok(Some(row)) => Data(draft(&row)).into_response(),
        Ok(None) => ApiError::not_found("Workflow draft", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to load builder draft"),
    }
}

async fn chat(headers: HeaderMap, body: Bytes) -> Response {
    if let Err(refusal) = validate(&headers, &body, |issues, b| {
        issues.text(b, "message", Presence::Required, Some(1), Some(2000));
    }) {
        return refusal.respond("AI is currently unavailable");
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": { "code": "ai_unavailable", "message": "AI is currently unavailable" } })),
    )
        .into_response()
}

async fn finalize_draft(
    db: &PgPool,
    id: &str,
    name: Option<String>,
    description: Option<String>,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = get_workflow(db, id).await? else {
        return Ok(None);
    };
    let mut settings = match &row["settings"] {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let state = &row["settings"]["builderState"];
    settings.insert(
        "builderState".into(),
        json!({
            "isBuilderDraft": state["isBuilderDraft"].as_bool().unwrap_or(true),
            "chatHistory": if state["chatHistory"].is_null() { json!([]) } else { state["chatHistory"].clone() },
            "finalized": true,
        }),
    );
    let name = name.filter(|n| !n.is_empty());
    sqlx::query(
        "update workflows set settings = $2, updated_at = $3::timestamp,
            name = case when $4::text is not null then $4 else name end,
            description = case when $5 then $6 else description end
         where id = $1",
    )
    .bind(id)
    .bind(Value::Object(settings))
    .bind(now())
    .bind(&name)
    .bind(description.is_some())
    .bind(&description)
    .execute(db)
    .await?;
    Ok(get_workflow(db, id).await?.map(|row| draft(&row)))
}

async fn finalize(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, description) = match validate(&headers, &body, |issues, b| {
        let name = issues
            .text(b, "name", Presence::Optional, Some(1), Some(255))
            .into_option();
        let description = issues
            .text(b, "description", Presence::Optional, None, Some(500))
            .into_option();
        (name, description)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to finalize builder draft"),
    };
    let result = async {
        let Some(draft) = finalize_draft(&caller.db, &id, name, description).await? else {
            return Err(Refusal::not_found("Workflow draft", &id));
        };
        caller.publish(
            &state,
            WORKFLOW_UPDATED,
            &id,
            &json!({ "id": draft["id"], "name": draft["name"] }),
        );
        Ok(Data(json!({ "id": draft["id"] })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to finalize builder draft"))
}
