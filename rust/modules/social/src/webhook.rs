//! `POST /public/social/postpeer/webhook`: PostPeer's delivery results.
//! Public (PostPeer has no session): the HMAC signature is the credential.
//! The post is found through the master PostPeer post index (or the legacy
//! KV mapping), its workspace's tenant database opened, and the post
//! reconciled.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{BoxFuture, DynCache, OutboundHttp, RequestCache};
use weldsuite_social_domain::postpeer::verify_postpeer_signature;
use weldsuite_social_domain::publishing::{reconcile_from_webhook, resolve_postpeer_post};

use crate::{SocialState, context, env_value};

/// A workspace's tenant database, by its Clerk org id
/// (`getTenantDbForWorkspace`).
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

pub(crate) fn router<S>(state: SocialState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/public/social/postpeer/webhook", post(webhook))
        .with_state(state)
}

/// What the public route reads off its request: the test's env, master and
/// tenant databases, KV namespace and HTTP client in conformance builds.
struct PublicCtx {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    tenant: Option<PgPool>,
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
            tenant: extensions.get::<Tenant>().map(|tenant| tenant.db.clone()),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            http: extensions.get::<OutboundHttp>().cloned(),
        }))
    }
}

impl PublicCtx {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

async fn webhook(
    State(state): State<SocialState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = String::from_utf8_lossy(&body).into_owned();
    let signature = headers
        .get("x-postpeer-signature")
        .and_then(|v| v.to_str().ok());
    let secret = env_value(ctx.env.as_ref(), "POSTPEER_WEBHOOK_SECRET");
    if !verify_postpeer_signature(secret.as_deref(), &raw, signature) {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signature" } }),
        );
    }
    let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }),
        );
    };
    let postpeer_post_id = payload
        .get("data")
        .and_then(|data| data.get("postId"))
        .filter(|id| !id.is_null())
        .or_else(|| payload.get("postId"))
        .filter(|id| match id {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
            Value::String(text) => !text.is_empty(),
            _ => true,
        })
        .map(text_of);
    let Some(postpeer_post_id) = postpeer_post_id else {
        return answer(
            StatusCode::OK,
            json!({ "ok": true, "ignored": "no_post_id" }),
        );
    };

    let master = if ctx.conformance() {
        ctx.master.clone()
    } else {
        state.master.clone()
    };
    let http = ctx.http.clone().or_else(|| state.http.clone());
    let publishing = context(ctx.env.as_ref(), master, http);
    let mapping = match resolve_postpeer_post(&publishing, &postpeer_post_id).await {
        Some(mapping) => Some(mapping),
        None => match legacy_mapping(&ctx, &state, &postpeer_post_id).await {
            Ok(mapping) => mapping,
            Err(response) => return *response,
        },
    };
    let Some((org_id, post_id)) = mapping else {
        return answer(
            StatusCode::OK,
            json!({ "ok": true, "ignored": "unknown_post" }),
        );
    };

    let db = if ctx.conformance() {
        ctx.tenant
            .clone()
            .ok_or_else(|| "no tenant database".to_owned())
    } else {
        match &state.tenants {
            Some(tenants) => tenants(org_id.clone()).await,
            None => Err("no tenant resolver".to_owned()),
        }
    };
    let failed = || {
        answer(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": { "code": "INTERNAL_ERROR", "message": "Failed to reconcile" } }),
        )
    };
    let db = match db {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, "[postpeer-webhook] reconcile failed");
            return failed();
        }
    };
    match reconcile_from_webhook(&db, &publishing, &org_id, &post_id, &payload).await {
        Ok(reconciled) => answer(
            StatusCode::OK,
            json!({ "ok": true, "reconciled": reconciled }),
        ),
        Err(error) => {
            tracing::error!(%error, "[postpeer-webhook] reconcile failed");
            failed()
        }
    }
}

/// The legacy `pp:post:<id>` KV mapping, from before the master index.
async fn legacy_mapping(
    ctx: &PublicCtx,
    state: &SocialState,
    postpeer_post_id: &str,
) -> Result<Option<(String, String)>, Box<Response>> {
    let cache = if ctx.conformance() {
        ctx.cache.clone()
    } else {
        state.cache.clone()
    };
    let Some(cache) = cache else {
        return Ok(None);
    };
    let stored = cache
        .get_boxed(&format!("pp:post:{postpeer_post_id}"))
        .await
        .map_err(|error| Box::new(crate::internal(&error, "Internal server error")))?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let mapping: Value = serde_json::from_str(&stored)
        .map_err(|error| Box::new(crate::internal(&error, "Internal server error")))?;
    if mapping.is_null() {
        return Ok(None);
    }
    Ok(Some((
        mapping.get("orgId").map(text_of).unwrap_or_default(),
        mapping.get("postId").map(text_of).unwrap_or_default(),
    )))
}
