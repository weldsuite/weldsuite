//! `/api/workflow-webhooks` (`routes/workflow-webhooks/index.ts`): webhook
//! triggers' URLs, their secrets and the runs they started.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    WORKFLOW_WEBHOOK_CREATED, WORKFLOW_WEBHOOK_DELETED, WORKFLOW_WEBHOOK_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_webhooks::{self, Column};
use weldsuite_schema::tenant::{workflow_executions, workflow_triggers, workflows};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy};
use crate::mvp::webhook_trigger_ids;
use crate::sync::{SyncContext, deregister_owner, register_owner, webhook_secret};
use crate::{Caller, ConnectState, Refusal, internal, validate};

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

/// A row as Drizzle returned it.
fn js<M: Serialize>(model: M) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// `leftJoin(workflows, eq(workflowWebhooks.workflowId, workflows.id))`.
fn workflow() -> RelationDef {
    workflow_webhooks::Entity::belongs_to(workflows::Entity)
        .from(Column::WorkflowId)
        .to(workflows::Column::Id)
        .into()
}

/// A webhook with its workflow's name, status and triggers.
#[derive(FromQueryResult)]
struct Joined {
    #[sea_orm(nested)]
    webhook: workflow_webhooks::Model,
    workflow_name: Option<String>,
    workflow_status: Option<String>,
    workflow_triggers: Option<Value>,
}

impl Joined {
    fn query() -> sea_orm::Select<workflow_webhooks::Entity> {
        workflow_webhooks::Entity::find()
            .column_as(workflows::Column::Name, "workflow_name")
            .column_as(workflows::Column::Status, "workflow_status")
            .column_as(workflows::Column::Triggers, "workflow_triggers")
            .join(JoinType::LeftJoin, workflow())
    }

    /// The webhook as Drizzle read it, the workflow's name, status and
    /// triggers (null without one).
    fn split(self) -> (Value, Value, Value, Value) {
        (
            js(self.webhook),
            json!(self.workflow_name),
            json!(self.workflow_status),
            self.workflow_triggers.unwrap_or(Value::Null),
        )
    }
}

/// The list's filters: not deleted, the `workflowId` and `isEnabled` sent.
fn filtered(workflow_id: Option<&str>, enabled: Option<bool>) -> Condition {
    let mut filter = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(workflow_id) = workflow_id {
        filter = filter.add(Column::WorkflowId.eq(workflow_id));
    }
    if let Some(enabled) = enabled {
        filter = filter.add(Column::IsEnabled.eq(enabled));
    }
    filter
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
    let db = orm(&caller.db);
    let mut rows = Joined::query().filter(filtered(workflow_id.as_deref(), enabled));
    if let Some(cursor) = &cursor {
        rows = rows.filter(Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .into_model::<Joined>()
        .all(&db)
        .await;
    let count = workflow_webhooks::Entity::find()
        .filter(filtered(workflow_id.as_deref(), enabled))
        .count(&db)
        .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let base = caller.overrides.public_api_base(&state);
            let data: Vec<Value> = rows
                .into_iter()
                .map(|row| {
                    let (webhook, name, status, triggers) = row.split();
                    view(webhook, &name, &status, Some(&triggers), &base)
                })
                .collect();
            let (data, has_more) = page(data, limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
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
        let db = orm(&caller.db);
        let rows = workflow_webhooks::Entity::find()
            .filter(Column::WorkflowId.eq(&workflow_id))
            .filter(Column::DeletedAt.is_null())
            .order_by_desc(Column::Id)
            .all(&db)
            .await?;
        // `coalesce(triggers, 'null')`: null for a workflow without them.
        let triggers: Option<Option<Value>> = workflows::Entity::find()
            .select_only()
            .column(workflows::Column::Triggers)
            .filter(workflows::Column::Id.eq(&workflow_id))
            .limit(1)
            .into_tuple()
            .one(&db)
            .await?;
        let triggers = triggers.map(|t| t.unwrap_or(Value::Null));
        let rows: Vec<Value> = rows.into_iter().map(js).collect();
        let webhook = rows
            .iter()
            .find(|row| is_managed(row, triggers.as_ref()))
            .or_else(|| rows.first());
        let Some(webhook) = webhook else {
            return Ok::<_, DbErr>(Data(Value::Null).into_response());
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
    let row = Joined::query()
        .filter(Column::Id.eq(&id))
        .filter(Column::DeletedAt.is_null())
        .into_model::<Joined>()
        .one(&orm(&caller.db))
        .await;
    match row {
        Ok(Some(row)) => {
            let (webhook, name, status, triggers) = row.split();
            let base = caller.overrides.public_api_base(&state);
            Data(view(webhook, &name, &status, Some(&triggers), &base)).into_response()
        }
        Ok(None) => ApiError::not_found("Webhook", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch webhook"),
    }
}

async fn webhook_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workflow_webhooks::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(js))
}

/// A run the webhook started, as `listWebhookEvents` selects it.
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    started_at: Option<PrimitiveDateTime>,
    status: String,
    error_message: Option<String>,
    source_ip: Option<String>,
}

async fn events(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(webhook) = webhook_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        use workflow_executions::Column as Execution;
        // `column->>'key'`.
        let field = |column: Execution, key: &str| {
            pg::PgExpr::cast_json_field(Expr::col((workflow_executions::Entity, column)), key)
        };
        let rows = workflow_executions::Entity::find()
            .select_only()
            .columns([Execution::Id, Execution::StartedAt, Execution::Status])
            .column_as(field(Execution::Error, "message"), "error_message")
            .column_as(field(Execution::TriggerData, "sourceIp"), "source_ip")
            .filter(Execution::WorkflowId.eq(webhook["workflowId"].as_str()))
            .filter(Execution::TriggerType.eq("webhook"))
            .filter(sea_orm::ExprTrait::eq(
                field(Execution::TriggerData, "webhookId"),
                id.as_str(),
            ))
            .order_by_desc(Execution::StartedAt)
            .limit(50)
            .into_model::<Event>()
            .all(&orm(&caller.db))
            .await?;
        let events: Vec<Value> = rows
            .into_iter()
            .map(js)
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

async fn workflow_exists(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = workflows::Entity::find()
        .select_only()
        .column(workflows::Column::Id)
        .filter(workflows::Column::Id.eq(id))
        .filter(workflows::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
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
        let stamp = utc_now();
        workflow_webhooks::Entity::insert(workflow_webhooks::ActiveModel {
            id: Set(id.clone()),
            workflow_id: Set(workflow_id.clone()),
            trigger_id: Set(trigger_id),
            name: Set(name),
            description: Set(description),
            url: Set(Some(url.clone())),
            external_url: Set(Some(format!("{}{url}", ctx.public_api_base))),
            secret: Set(Some(webhook_secret())),
            validate_signature: Set(Some(validate_signature)),
            signature_header: Set(Some(header)),
            allowed_methods: Set(Some(json!(methods))),
            ip_whitelist: Set(whitelist.map(|w| json!(w))),
            is_enabled: Set(true),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
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
        let stamp = utc_now();
        let db = orm(&caller.db);
        workflow_triggers::Entity::insert(workflow_triggers::ActiveModel {
            id: Set(trigger_id.clone()),
            workflow_id: Set(workflow_id.clone()),
            name: Set("Webhook Trigger".to_owned()),
            category: Set("webhook".to_owned()),
            config: Set(json!({ "method": "POST", "validateSignature": false })),
            is_enabled: Set(true),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        workflow_webhooks::Entity::insert(workflow_webhooks::ActiveModel {
            id: Set(webhook_id.clone()),
            workflow_id: Set(workflow_id.clone()),
            trigger_id: Set(Some(trigger_id.clone())),
            name: Set("Webhook".to_owned()),
            url: Set(Some(url.clone())),
            external_url: Set(Some(format!("{}{url}", ctx.public_api_base))),
            secret: Set(Some(secret.clone())),
            validate_signature: Set(Some(false)),
            signature_header: Set(Some("x-webhook-signature".to_owned())),
            allowed_methods: Set(Some(json!(["POST"]))),
            is_enabled: Set(true),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        register_owner(&ctx, &webhook_id)
            .await
            .map_err(|error| registry_refusal(&error, "Failed to create webhook trigger"))?;
        let trigger = workflow_triggers::Entity::find_by_id(trigger_id.clone())
            .one(&db)
            .await?;
        caller.publish(
            &state,
            WORKFLOW_WEBHOOK_CREATED,
            &webhook_id,
            &json!({ "id": webhook_id, "workflowId": workflow_id, "triggerId": trigger_id }),
        );
        let mut body = trigger.map_or_else(|| json!({}), js);
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
        let mut update = workflow_webhooks::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        if !name.is_absent() {
            update = update.col_expr(Column::Name, Expr::value(name.as_set().cloned()));
        }
        if !description.is_absent() {
            update = update.col_expr(
                Column::Description,
                Expr::value(description.as_set().cloned()),
            );
        }
        if !validate_signature.is_absent() {
            update = update.col_expr(
                Column::ValidateSignature,
                Expr::value(validate_signature.as_set().copied()),
            );
        }
        if !header.is_absent() {
            update = update.col_expr(
                Column::SignatureHeader,
                Expr::value(header.as_set().cloned()),
            );
        }
        if !methods.is_absent() {
            update = update.col_expr(
                Column::AllowedMethods,
                Expr::value(methods.as_set().map(|m| json!(m))),
            );
        }
        if !whitelist.is_absent() {
            update = update.col_expr(
                Column::IpWhitelist,
                Expr::value(whitelist.as_set().map(|w| json!(w))),
            );
        }
        if !enabled.is_absent() {
            update = update.col_expr(Column::IsEnabled, Expr::value(enabled.as_set().copied()));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        let mut update = workflow_webhooks::Entity::update_many()
            .col_expr(Column::Secret, Expr::value(webhook_secret()))
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        if enable == Some(true) {
            update = update.col_expr(Column::ValidateSignature, Expr::value(true));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        let row = Joined::query()
            .filter(Column::Id.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .into_model::<Joined>()
            .one(&orm(&caller.db))
            .await?;
        let Some(row) = row else {
            return Err(Refusal::not_found("Webhook", &id));
        };
        let (existing, _, _, triggers) = row.split();
        if is_managed(&existing, Some(&triggers)) {
            return Err(ApiError::conflict(
                "This webhook belongs to a workflow's webhook trigger. Remove the trigger in the workflow editor instead.",
            )
            .with_details(json!({ "reason": "managed_by_trigger", "workflowId": existing["workflowId"] }))
            .into());
        }
        let stamp = utc_now();
        workflow_webhooks::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
