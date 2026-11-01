//! `POST /public/webhooks/realtime-register?token=…`: Realtime Register's
//! process notifications. Public; the shared `?token=`
//! (`REALTIME_REGISTER_WEBHOOK_SECRET`) is the credential, and an unset
//! secret refuses everything. The process id is looked up in the workspace
//! cache (`rtr:process:{id}` → `{ workspaceId, domainId?, transferId?, kind }`,
//! written by the transfer route and billing-worker), the process polled,
//! and the workspace's domain or transfer row advanced.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use http::StatusCode;
use http::request::Parts;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::DOMAIN_UPDATED;
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::RequestEnv;
use weldsuite_kit::validation::query_values;
use weldsuite_ports::{DynCache, OutboundHttp, RequestCache};

use crate::domains::{poll_registration, poll_renewal};
use crate::js::{number_json, number_text, parse_int, text};
use crate::registrar::{Outcome, RealtimeRegistrar};
use crate::transfers::sync_from_registrar;
use crate::{HostState, Providers, env_value, json_response};

pub(crate) fn router<S>(state: HostState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/public/webhooks/realtime-register",
            get(health).post(receive),
        )
        .with_state(state)
}

/// What the public route reads off its request: the test's env, databases,
/// KV namespace and HTTP client in conformance builds.
struct PublicCtx {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    tenant: Option<(PgPool, String)>,
    cache: Option<Arc<dyn DynCache>>,
    http: Option<OutboundHttp>,
}

impl<S: Send + Sync> FromRequestParts<S> for PublicCtx {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            env: extensions.get::<RequestEnv>().cloned(),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            tenant: extensions
                .get::<Tenant>()
                .map(|tenant| (tenant.db.clone(), tenant.workspace_id.clone())),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            http: extensions.get::<OutboundHttp>().cloned(),
        }))
    }
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        json!({ "ok": true, "service": "realtime-register-webhook" }),
    )
}

/// `secretMatches(provided, expected)`, in constant time.
fn secret_matches(provided: Option<&str>, expected: &str) -> bool {
    let Some(provided) = provided.filter(|p| !p.is_empty()) else {
        return false;
    };
    let (a, b) = (provided.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `extractProcessId`: a number, or a string read with `parseInt`.
fn process_id_of(payload: &Value) -> Option<f64> {
    let data = payload.get("data");
    let raw = [
        payload.get("processId"),
        payload.get("process_id"),
        data.and_then(|d| d.get("processId")),
        data.and_then(|d| d.get("id")),
    ]
    .into_iter()
    .flatten()
    .find(|v| !v.is_null())?;
    #[allow(clippy::cast_precision_loss)]
    match raw {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_int(s).map(|n| n as f64),
        _ => None,
    }
}

fn unauthorized() -> Response {
    json_response(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }))
}

async fn receive(
    State(state): State<HostState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let Some(secret) = env_value(ctx.env.as_ref(), "REALTIME_REGISTER_WEBHOOK_SECRET") else {
        tracing::error!("[RTR Webhook] Rejected: REALTIME_REGISTER_WEBHOOK_SECRET is not configured");
        return unauthorized();
    };
    let query = query_values(query.as_deref());
    let token = match query.get("token") {
        Some(Value::String(token)) => Some(token.as_str()),
        Some(Value::Array(tokens)) => tokens.first().and_then(Value::as_str),
        _ => None,
    };
    if !secret_matches(token, &secret) {
        tracing::warn!("[RTR Webhook] Rejected: missing/invalid token");
        return unauthorized();
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return json_response(StatusCode::BAD_REQUEST, json!({ "error": "Invalid JSON" }));
    };
    let Some(process_id) = process_id_of(&payload).filter(|n| n.is_finite()) else {
        return json_response(StatusCode::OK, json!({ "received": true }));
    };
    let process_json = number_json(process_id);
    let http = ctx.http.clone().or_else(|| state.http.clone());
    let providers = Providers::new(ctx.env.as_ref(), http);
    let Some(rtr) = providers.rtr.clone() else {
        tracing::warn!("[RTR Webhook] Realtime Register not configured — ack only");
        return json_response(
            StatusCode::OK,
            json!({ "received": true, "processId": process_json }),
        );
    };
    #[allow(clippy::cast_possible_truncation)]
    let process = process_id as i64;
    let key = format!("rtr:process:{}", number_text(process_id));
    let cache = if ctx.env.is_some() {
        ctx.cache.clone()
    } else {
        state.cache.clone()
    };
    let raw = match &cache {
        Some(cache) => cache.get_boxed(&key).await.ok().flatten(),
        None => None,
    };
    let unmapped = json!({ "received": true, "processId": process_json, "mapped": false });
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        match rtr.poll_process(process).await {
            Ok(outcome) => tracing::info!(?outcome, "[RTR Webhook] process (no cache mapping)"),
            Err(error) => tracing::error!(%error, "[RTR Webhook] process poll failed"),
        }
        return json_response(StatusCode::OK, unmapped);
    };
    let Ok(mapping) = serde_json::from_str::<Value>(&raw) else {
        return json_response(StatusCode::OK, unmapped);
    };
    if let Err(error) = sync_mapped(&state, &ctx, &rtr, cache.as_deref(), &mapping, process, &key).await {
        tracing::error!(%error, "[RTR Webhook] tenant update failed");
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "processing_failed", "processId": process_json }),
        );
    }
    json_response(
        StatusCode::OK,
        json!({ "received": true, "processId": process_json, "mapped": true }),
    )
}

/// `syncMappedProcess`.
async fn sync_mapped(
    state: &HostState,
    ctx: &PublicCtx,
    rtr: &RealtimeRegistrar,
    cache: Option<&dyn DynCache>,
    mapping: &Value,
    process: i64,
    key: &str,
) -> Result<(), String> {
    let workspace = mapping
        .get("workspaceId")
        .map(crate::js::as_text)
        .unwrap_or_default();
    let (db, workspace_id) = match &ctx.tenant {
        Some(tenant) => tenant.clone(),
        None => {
            let tenants = state
                .tenants
                .as_ref()
                .ok_or_else(|| "no tenant databases".to_owned())?;
            tenants(workspace.clone()).await?
        }
    };
    let kind = text(mapping, "kind");
    let domain_id = text(mapping, "domainId").filter(|d| !d.is_empty());
    let transfer_id = text(mapping, "transferId").filter(|t| !t.is_empty());
    match (kind, domain_id, transfer_id) {
        (Some("registration"), Some(domain_id), _) => {
            poll_registration(&db, rtr, domain_id)
                .await
                .map_err(|e| e.to_string())?;
        }
        (Some("renewal"), Some(domain_id), _) => {
            let polled = poll_renewal(&db, rtr, domain_id)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(polled) = polled
                && matches!(text(&polled, "registrationStatus"), Some("renewed" | "failed"))
            {
                let context = EventContext::new(workspace.clone(), "system", EventSource::System);
                let data = json!({ "id": domain_id, "name": polled["fullDomain"], "status": polled["status"] });
                state
                    .events
                    .publish_and_wait(&context, EntityEvent::new(DOMAIN_UPDATED, domain_id, data))
                    .await;
            }
        }
        (Some("transfer"), _, Some(transfer_id)) => {
            sync_from_registrar(&db, rtr, transfer_id)
                .await
                .map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    // Settled: the auto-renew sweep re-derives when to look next.
    let master = if ctx.env.is_some() {
        ctx.master.clone()
    } else {
        state.master.clone()
    };
    if let Some(master) = master {
        weldsuite_db::due_index::mark_due(
            &master,
            crate::renew_due::KIND,
            &workspace_id,
            OffsetDateTime::now_utc(),
        )
        .await;
    }
    let outcome = rtr.poll_process(process).await.map_err(|e| e.to_string())?;
    if outcome != Outcome::Pending
        && let Some(cache) = cache
    {
        cache.delete_boxed(key).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_ids_and_tokens() {
        assert_eq!(process_id_of(&json!({ "processId": 42 })), Some(42.0));
        assert_eq!(process_id_of(&json!({ "data": { "id": "17x" } })), Some(17.0));
        assert_eq!(process_id_of(&json!({ "data": {} })), None);
        assert!(secret_matches(Some("abc"), "abc"));
        assert!(!secret_matches(Some("abd"), "abc"));
        assert!(!secret_matches(None, "abc"));
    }
}
