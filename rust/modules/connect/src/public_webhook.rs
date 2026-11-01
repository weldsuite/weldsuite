//! `POST /api/workflows/webhook/:webhookId` (`routes/public-workflow-webhook`,
//! `services/workflow-webhook-receiver.ts`): an external system starts a
//! workflow. No session: the webhook's own rules (signature over the raw
//! body, allowed methods, IP list) guard it, and the answers keep the legacy
//! `{ success, executionId }` / `{ error }` shapes.
//!
//! The caller's address is the `X-Forwarded-For` entry the ingress appended
//! (`TRUSTED_PROXIES` from the right), not `CF-Connecting-IP`: nothing in
//! front of the server on Kubernetes overwrites that header.

use std::collections::BTreeMap;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_db::{PgPool, Tenant, js_row};
use weldsuite_kit::ApiError;

use crate::executions::{StartRun, start_run};
use crate::sync::resolve_owner;
use crate::{ConnectState, Overrides, now};

const MAX_BODY_BYTES: usize = 1_000_000;

/// The header names the test's request carried (conformance builds): the
/// trigger data keeps exactly those, as the Hono app sees them.
#[derive(Debug, Clone)]
pub struct RequestHeaderNames(pub Vec<String>);

fn legacy(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// `computeWebhookHmacHex(secret, payload)`.
pub(crate) fn hmac_hex(secret: &str, payload: &str) -> String {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return String::new();
    };
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// `constantTimeEqual(a, b)` over UTF-16 units.
pub(crate) fn constant_time_equal(a: &str, b: &str) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(&b).fold(0u16, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The client's address: the `X-Forwarded-For` entry `trusted` from the right.
fn source_ip(headers: &http::HeaderMap, trusted: usize) -> String {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted.max(1))
        .and_then(|at| hops.get(at))
        .map(|ip| (*ip).to_owned())
        .unwrap_or_default()
}

async fn update_stats(db: &PgPool, webhook_id: &str, success: bool, source_ip: &str) {
    let updated = sqlx::query(
        "update workflow_webhooks set total_calls = coalesce(total_calls, 0) + 1,
            successful_calls = case when $2 then coalesce(successful_calls, 0) + 1 else successful_calls end,
            failed_calls = case when $2 then failed_calls else coalesce(failed_calls, 0) + 1 end,
            last_called_at = $3::timestamp, last_call_status = $4, last_call_ip = $5,
            updated_at = $3::timestamp
         where id = $1",
    )
    .bind(webhook_id)
    .bind(success)
    .bind(now())
    .bind(if success { "success" } else { "failed" })
    .bind(source_ip)
    .execute(db)
    .await;
    if let Err(error) = updated {
        tracing::error!(%error, "[WebhookReceiver] Failed to update stats");
    }
}

pub(crate) async fn receive(
    State(state): State<ConnectState>,
    Path(webhook_id): Path<String>,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let overrides = Overrides::from_extensions(&parts.extensions);
    let source_ip = source_ip(&parts.headers, state.trusted_proxies);
    let declared = parts
        .headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    #[allow(clippy::cast_precision_loss)]
    if declared > MAX_BODY_BYTES as f64 {
        // Read what the sender is still sending (up to a bound) first:
        // answering mid-upload resets the connection under the client.
        let _ = axum::body::to_bytes(body, 4 * MAX_BODY_BYTES).await;
        return legacy(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
    }
    let bytes: Bytes = match axum::body::to_bytes(body, 4 * MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return legacy(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large"),
    };
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    if raw.len() > MAX_BODY_BYTES {
        return legacy(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
    }
    let body: Value = serde_json::from_str(&raw).unwrap_or_else(|_| Value::String(raw.clone()));

    let allowed_names = parts.extensions.get::<RequestHeaderNames>().map(|n| &n.0);
    let mut headers = BTreeMap::new();
    for (name, value) in &parts.headers {
        let name = name.as_str().to_lowercase();
        if allowed_names.is_some_and(|names| !names.contains(&name)) {
            continue;
        }
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        headers
            .entry(name)
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }
    let mut query = Map::new();
    if let Some(raw_query) = parts.uri.query() {
        for (key, value) in url::form_urlencoded::parse(raw_query.as_bytes()) {
            query.insert(key.into_owned(), Value::String(value.into_owned()));
        }
    }

    let master = overrides.master(&state);
    let cache = overrides.kv(&state);
    let workspace = match resolve_owner(master.as_ref(), cache.as_ref(), &webhook_id).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return legacy(StatusCode::NOT_FOUND, "Webhook not found"),
        Err(error) => {
            tracing::error!(%error, "[WebhookReceiver] registry lookup failed");
            return ApiError::internal().into_response();
        }
    };
    let db = if let Some(tenant) = parts.extensions.get::<Tenant>() {
        tenant.db.clone()
    } else {
        let Some(tenants) = &state.tenants else {
            return ApiError::internal().into_response();
        };
        match tenants(workspace.clone()).await {
            Ok(db) => db,
            Err(error) => {
                tracing::error!(%error, "[WebhookReceiver] tenant database unavailable");
                return ApiError::internal().into_response();
            }
        }
    };

    let webhook: Option<Value> = match sqlx::query_scalar(
        "select to_jsonb(t) from workflow_webhooks t
         where t.id = $1 and t.is_enabled = true and t.deleted_at is null limit 1",
    )
    .bind(&webhook_id)
    .fetch_optional(&db)
    .await
    {
        Ok(row) => row.map(js_row),
        Err(error) => {
            tracing::error!(%error, "[WebhookReceiver] webhook lookup failed");
            return ApiError::internal().into_response();
        }
    };
    let Some(webhook) = webhook else {
        return legacy(StatusCode::NOT_FOUND, "Webhook not found or disabled");
    };

    // Signature (when required) over the raw body.
    if webhook["validateSignature"].as_bool() == Some(true)
        && let Some(secret) = webhook["secret"].as_str().filter(|s| !s.is_empty())
    {
        let header = webhook["signatureHeader"]
            .as_str()
            .filter(|h| !h.is_empty())
            .unwrap_or("x-webhook-signature")
            .to_lowercase();
        let Some(provided) = headers.get(&header).filter(|v| !v.is_empty()) else {
            return legacy(StatusCode::UNAUTHORIZED, "Missing signature");
        };
        let expected = hmac_hex(secret, &raw);
        if !(constant_time_equal(provided, &expected)
            || constant_time_equal(provided, &format!("sha256={expected}")))
        {
            return legacy(StatusCode::UNAUTHORIZED, "Invalid signature");
        }
    }
    let methods: Vec<&str> = crate::js::array(webhook.get("allowedMethods"))
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if !webhook["allowedMethods"]
        .as_array()
        .is_none_or(Vec::is_empty)
        && !methods.contains(&"POST")
    {
        return legacy(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let whitelist: Vec<&str> = crate::js::array(webhook.get("ipWhitelist"))
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if !webhook["ipWhitelist"].as_array().is_none_or(Vec::is_empty)
        && !source_ip.is_empty()
        && !whitelist.contains(&source_ip.as_str())
    {
        return legacy(StatusCode::FORBIDDEN, "IP not allowed");
    }

    let workflow_id = webhook["workflowId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let workflow = match crate::workflows::get_workflow(&db, &workflow_id).await {
        Ok(found) => found.filter(|w| w["status"].as_str() == Some("active")),
        Err(error) => {
            tracing::error!(%error, "[WebhookReceiver] workflow lookup failed");
            return ApiError::internal().into_response();
        }
    };
    let Some(workflow) = workflow else {
        return legacy(StatusCode::NOT_FOUND, "Workflow not found or not active");
    };
    let Some(runs) = overrides.runs(&state) else {
        update_stats(&db, &webhook_id, false, &source_ip).await;
        return legacy(
            StatusCode::SERVICE_UNAVAILABLE,
            "Workflow runtime not available",
        );
    };
    let user_id = workflow["createdBy"]
        .as_str()
        .filter(|u| !u.is_empty())
        .unwrap_or("webhook")
        .to_owned();
    let trigger_data = json!({
        "webhookId": webhook["id"],
        "headers": headers,
        "body": body,
        "query": query,
        "sourceIp": source_ip,
        "receivedAt": now(),
    });
    let started = start_run(
        &db,
        runs.as_ref(),
        StartRun {
            workspace_id: &workspace,
            user_id: &user_id,
            workflow: &workflow,
            trigger_type: "webhook",
            trigger_id: webhook["triggerId"].as_str(),
            trigger_data,
            is_test: false,
            parent: None,
        },
    )
    .await;
    match started {
        Ok(started) => {
            update_stats(&db, &webhook_id, true, &source_ip).await;
            let mut body = json!({ "success": true, "executionId": started.execution_id });
            if started.instance_id.is_none() {
                body["skipped"] = json!(true);
            }
            Json(body).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "[WebhookReceiver] Failed to dispatch workflow");
            update_stats(&db, &webhook_id, false, &source_ip).await;
            legacy(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to trigger workflow",
            )
        }
    }
}
