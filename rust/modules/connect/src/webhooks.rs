//! `/api/workflow-webhooks` (`routes/workflow-webhooks/index.ts`): webhook
//! triggers' URLs, their secrets and the runs they started.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_WEBHOOK_CREATED, WORKFLOW_WEBHOOK_DELETED, WORKFLOW_WEBHOOK_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::mvp::webhook_trigger_ids;
use crate::sync::{SyncContext, deregister_owner, register_owner, webhook_secret};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOW_WEBHOOKS_READ]);
    let create = || gate.require([perm::WORKFLOW_WEBHOOKS_CREATE]);
    let update = || gate.require([perm::WORKFLOW_WEBHOOKS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_route).route_layer(create()))
        .route(
            "/create-trigger",
            post(create_trigger).route_layer(create()),
        )
        .route(
            "/workflow/{workflow_id}",
            get(for_workflow).route_layer(read()),
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
            axum::routing::delete(delete)
                .route_layer(gate.require([perm::WORKFLOW_WEBHOOKS_DELETE])),
        )
        .route("/{id}/events", get(events).route_layer(read()))
        .route(
            "/{id}/rotate-secret",
            patch(rotate_secret).route_layer(update()),
        )
}

/// `isManagedWebhook(webhook, workflowTriggers)`.
fn is_managed(webhook: &Value, triggers: Option<&Value>) -> bool {
    webhook["triggerId"]
        .as_str()
        .filter(|t| !t.is_empty())
        .is_some_and(|t| webhook_trigger_ids(triggers).iter().any(|id| id == t))
}

/// `toWebhookView(webhook, workflow, base)`.
fn view(
    mut webhook: Value,
    name: &Value,
    status: &Value,
    triggers: Option<&Value>,
    base: &str,
) -> Value {
    let managed = is_managed(&webhook, triggers);
    let has_secret = webhook["secret"].as_str().is_some_and(|s| !s.is_empty());
    let external = match webhook["externalUrl"].as_str().filter(|u| !u.is_empty()) {
        Some(url) => url.to_owned(),
        None => format!("{base}{}", webhook["url"].as_str().unwrap_or_default()),
    };
    if let Value::Object(map) = &mut webhook {
        map.remove("secret");
        map.insert("externalUrl".into(), json!(external));
        map.insert("hasSecret".into(), json!(has_secret));
        map.insert("workflowName".into(), name.clone());
        map.insert("workflowStatus".into(), status.clone());
        map.insert("isManaged".into(), json!(managed));
    }
    webhook
}

const JOINED: &str = "jsonb_build_object('webhook', to_jsonb(t), 'name', w.name, 'status', w.status, 'triggers', w.triggers)";

fn split(row: &Value) -> (Value, Value, Value, Value) {
    (
        js_row(row["webhook"].clone()),
        row["name"].clone(),
        row["status"].clone(),
        row["triggers"].clone(),
    )
}

async fn list(
    State(state): State<ConnectState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let enabled = query_param(query, "isEnabled").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.workflow_id = $1)
        and ($2::boolean is null or t.is_enabled = $2)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {JOINED} from workflow_webhooks t left join workflows w on t.workflow_id = w.id
         where {FILTER} and ($3::text is null or t.id < $3) order by t.id desc limit $4"
    )))
    .bind(&workflow_id)
    .bind(enabled)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_webhooks t where {FILTER}"
    )))
    .bind(&workflow_id)
    .bind(enabled)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let base = caller.overrides.public_api_base(&state);
            let (rows, has_more) = page(rows, limit);
            let data: Vec<Value> = rows
                .into_iter()
                .map(|row| {
                    let (webhook, name, status, triggers) = split(&row);
                    view(webhook, &name, &status, Some(&triggers), &base)
                })
                .collect();
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow webhooks"),
    }
}

async fn for_workflow(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(workflow_id): Path<String>,
) -> Response {
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from workflow_webhooks t
             where t.workflow_id = $1 and t.deleted_at is null order by t.id desc",
        )
        .bind(&workflow_id)
        .fetch_all(&caller.db)
        .await?;
        let triggers: Option<Value> = sqlx::query_scalar(
            "select coalesce(triggers, 'null'::jsonb) from workflows where id = $1 limit 1",
        )
        .bind(&workflow_id)
        .fetch_optional(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
        let webhook = rows
            .iter()
            .find(|row| is_managed(row, triggers.as_ref()))
            .or_else(|| rows.first());
        let Some(webhook) = webhook else {
            return Ok::<_, sqlx::Error>(Data(Value::Null).into_response());
        };
        let external = match webhook["externalUrl"].as_str().filter(|u| !u.is_empty()) {
            Some(url) => url.to_owned(),
            None => format!(
                "{}{}",
                caller.overrides.public_api_base(&state),
                webhook["url"].as_str().unwrap_or_default()
            ),
        };
        Ok(Data(json!({
            "id": webhook["id"],
            "url": webhook["url"],
            "externalUrl": external,
            "hasSecret": webhook["secret"].as_str().is_some_and(|s| !s.is_empty()),
            "validateSignature": webhook["validateSignature"],
            "isEnabled": webhook["isEnabled"],
        }))
        .into_response())
    };
    result
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to fetch workflow webhook"))
}

async fn get_one(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {JOINED} from workflow_webhooks t left join workflows w on t.workflow_id = w.id
         where t.id = $1 and t.deleted_at is null limit 1"
    )))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => {
            let (webhook, name, status, triggers) = split(&row);
            let base = caller.overrides.public_api_base(&state);
            Data(view(webhook, &name, &status, Some(&triggers), &base)).into_response()
        }
        Ok(None) => ApiError::not_found("Webhook", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch webhook"),
    }
}

async fn webhook_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_webhooks t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn events(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(webhook) = webhook_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', e.id, 'startedAt', e.started_at, 'status', e.status,
                    'errorMessage', e.error->>'message', 'sourceIp', e.trigger_data->>'sourceIp')
             from workflow_executions e
             where e.workflow_id = $1 and e.trigger_type = 'webhook' and e.trigger_data->>'webhookId' = $2
             order by e.started_at desc limit 50",
        )
        .bind(webhook["workflowId"].as_str())
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        let events: Vec<Value> = rows
            .into_iter()
            .map(js_row)
            .map(|e| {
                let mut out = Map::new();
                out.insert("id".into(), e["id"].clone());
                out.insert("executionId".into(), e["id"].clone());
                out.insert("timestamp".into(), e["startedAt"].clone());
                out.insert("status".into(), e["status"].clone());
                out.insert("error".into(), e["errorMessage"].clone());
                if !e["sourceIp"].is_null() {
                    out.insert("sourceIp".into(), e["sourceIp"].clone());
                }
                Value::Object(out)
            })
            .collect();
        Ok(Data(events).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to fetch webhook events"))
}

async fn workflow_exists(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from workflows where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

fn strings(issues: &mut Issues, b: &Map<String, Value>, key: &str) -> Field<Vec<String>> {
    issues.list(b, key, Presence::Optional, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    })
}

/// A registry failure as the route's 500, after the write it followed.
fn registry_refusal(error: &crate::sync::RegistryError, message: &str) -> Refusal {
    Refusal::Response(Box::new(internal(error, message)))
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
        let trigger_id = issues
            .text(b, "triggerId", Presence::Optional, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Optional, Some(1), Some(255))
            .into_option();
        let description = issues
            .text(b, "description", Presence::Optional, None, None)
            .into_option();
        let validate_signature = issues
            .boolean(b, "validateSignature", Presence::Optional)
            .into_option();
        let header = issues
            .text(b, "signatureHeader", Presence::Optional, None, None)
            .into_option();
        let methods = strings(issues, b, "allowedMethods").into_option();
        let whitelist = strings(issues, b, "ipWhitelist").into_option();
        (
            workflow_id.unwrap_or_default(),
            trigger_id,
            name.unwrap_or_else(|| "Webhook".into()),
            description,
            validate_signature.unwrap_or(false),
            header.unwrap_or_else(|| "x-webhook-signature".into()),
            methods.unwrap_or_else(|| vec!["POST".into()]),
            whitelist,
        )
    });
    let (
        workflow_id,
        trigger_id,
        name,
        description,
        validate_signature,
        header,
        methods,
        whitelist,
    ) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create webhook"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let id = generate_id("wh");
        let url = format!("/api/workflows/webhook/{id}");
        let ctx = SyncContext::for_caller(&caller, &state);
        let stamp = now();
        sqlx::query(
            "insert into workflow_webhooks
                (id, workflow_id, trigger_id, name, description, url, external_url, secret,
                 validate_signature, signature_header, allowed_methods, ip_whitelist, is_enabled,
                 created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13::timestamp, $13::timestamp)",
        )
        .bind(&id)
        .bind(&workflow_id)
        .bind(&trigger_id)
        .bind(&name)
        .bind(&description)
        .bind(&url)
        .bind(format!("{}{url}", ctx.public_api_base))
        .bind(webhook_secret())
        .bind(validate_signature)
        .bind(&header)
        .bind(json!(methods))
        .bind(whitelist.map(|w| json!(w)))
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        register_owner(&ctx, &id)
            .await
            .map_err(|error| registry_refusal(&error, "Failed to create webhook"))?;
        let mut webhook = webhook_row(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_CREATED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id }),
        );
        if let Value::Object(map) = &mut webhook {
            map.insert("webhookUrl".into(), json!(url));
        }
        Ok(Created(webhook).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create webhook"))
}

async fn create_trigger(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let workflow_id = match validate(&headers, &body, |issues, b| {
        issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(id) => id,
        Err(refusal) => return refusal.respond("Failed to create webhook trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let trigger_id = generate_id("trg");
        let webhook_id = generate_id("wh");
        let secret = webhook_secret();
        let url = format!("/api/workflows/webhook/{webhook_id}");
        let ctx = SyncContext::for_caller(&caller, &state);
        let stamp = now();
        sqlx::query(
            "insert into workflow_triggers (id, workflow_id, name, category, config, is_enabled, created_at, updated_at)
             values ($1, $2, 'Webhook Trigger', 'webhook', $3, true, $4::timestamp, $4::timestamp)",
        )
        .bind(&trigger_id)
        .bind(&workflow_id)
        .bind(json!({ "method": "POST", "validateSignature": false }))
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "insert into workflow_webhooks
                (id, workflow_id, trigger_id, name, url, external_url, secret, validate_signature,
                 signature_header, allowed_methods, is_enabled, created_at, updated_at)
             values ($1, $2, $3, 'Webhook', $4, $5, $6, false, 'x-webhook-signature', '[\"POST\"]'::jsonb, true,
                     $7::timestamp, $7::timestamp)",
        )
        .bind(&webhook_id)
        .bind(&workflow_id)
        .bind(&trigger_id)
        .bind(&url)
        .bind(format!("{}{url}", ctx.public_api_base))
        .bind(&secret)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        register_owner(&ctx, &webhook_id)
            .await
            .map_err(|error| registry_refusal(&error, "Failed to create webhook trigger"))?;
        let trigger: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from workflow_triggers t where t.id = $1 limit 1",
        )
        .bind(&trigger_id)
        .fetch_optional(&caller.db)
        .await?;
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_CREATED,
            &webhook_id,
            &json!({ "id": webhook_id, "workflowId": workflow_id, "triggerId": trigger_id }),
        );
        let mut body = trigger.map_or_else(|| json!({}), js_row);
        if let Value::Object(map) = &mut body {
            map.insert("webhookId".into(), json!(webhook_id));
            map.insert("webhookUrl".into(), json!(url));
            map.insert("secret".into(), json!(secret));
        }
        Ok(Created(body).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create webhook trigger"))
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
        let description = issues.text(b, "description", Presence::Optional, None, None);
        let validate_signature = issues.boolean(b, "validateSignature", Presence::Optional);
        let header = issues.text(b, "signatureHeader", Presence::Optional, None, None);
        let methods = strings(issues, b, "allowedMethods");
        let whitelist = strings(issues, b, "ipWhitelist");
        let enabled = issues.boolean(b, "isEnabled", Presence::Optional);
        (
            name,
            description,
            validate_signature,
            header,
            methods,
            whitelist,
            enabled,
        )
    });
    let (name, description, validate_signature, header, methods, whitelist, enabled) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update webhook"),
    };
    let result = async {
        let Some(existing) = webhook_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        sqlx::query(
            "update workflow_webhooks set updated_at = $2::timestamp,
                name = case when $3 then $4 else name end,
                description = case when $5 then $6 else description end,
                validate_signature = case when $7 then $8 else validate_signature end,
                signature_header = case when $9 then $10 else signature_header end,
                allowed_methods = case when $11 then $12 else allowed_methods end,
                ip_whitelist = case when $13 then $14 else ip_whitelist end,
                is_enabled = case when $15 then $16 else is_enabled end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(!name.is_absent())
        .bind(name.as_set())
        .bind(!description.is_absent())
        .bind(description.as_set())
        .bind(!validate_signature.is_absent())
        .bind(validate_signature.as_set().copied())
        .bind(!header.is_absent())
        .bind(header.as_set())
        .bind(!methods.is_absent())
        .bind(methods.as_set().map(|m| json!(m)))
        .bind(!whitelist.is_absent())
        .bind(whitelist.as_set().map(|w| json!(w)))
        .bind(!enabled.is_absent())
        .bind(enabled.as_set().copied())
        .execute(&caller.db)
        .await?;
        let mut webhook = webhook_row(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        if let Value::Object(map) = &mut webhook {
            map.remove("secret");
        }
        Ok(Data(webhook).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update webhook"))
}

async fn rotate_secret(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let invalid = || ApiError::bad_request("Invalid request body").into_response();
    let parsed: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return invalid(),
        }
    };
    let Value::Object(fields) = &parsed else {
        return invalid();
    };
    let enable = match fields.get("enableSignature") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return invalid(),
    };
    let result = async {
        let Some(existing) = webhook_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        sqlx::query(
            "update workflow_webhooks set secret = $2, updated_at = $3::timestamp,
                validate_signature = case when $4 then true else validate_signature end
             where id = $1",
        )
        .bind(&id)
        .bind(webhook_secret())
        .bind(now())
        .bind(enable == Some(true))
        .execute(&caller.db)
        .await?;
        let webhook = webhook_row(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"], "secretRotated": true }),
        );
        Ok(Data(webhook).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to rotate webhook secret"))
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let row: Option<Value> = sqlx::query_scalar(
            "select jsonb_build_object('webhook', to_jsonb(t), 'triggers', w.triggers)
             from workflow_webhooks t left join workflows w on t.workflow_id = w.id
             where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(row) = row else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        let existing = js_row(row["webhook"].clone());
        if is_managed(&existing, row.get("triggers")) {
            return Err(ApiError::conflict(
                "This webhook belongs to a workflow's webhook trigger. Remove the trigger in the workflow editor instead.",
            )
            .with_details(json!({ "reason": "managed_by_trigger", "workflowId": existing["workflowId"] }))
            .into());
        }
        let stamp = now();
        sqlx::query("update workflow_webhooks set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&stamp)
            .execute(&caller.db)
            .await?;
        let ctx = SyncContext::for_caller(&caller, &state);
        deregister_owner(&ctx, &id)
            .await
            .map_err(|error| registry_refusal(&error, "Failed to delete webhook"))?;
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_DELETED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete webhook"))
}
