//! WeldConnect's store and accounting connectors on the integration
//! workers (`index.ts`'s `/webhooks/connectors/:connectionId`,
//! `stripe-connect.ts`, integration-sync-worker's `connector-catchup.ts`):
//!
//! - `POST /webhooks/connectors/:connectionId`: a provider's webhook
//!   (`WooCommerce`, Shopify, Moneybird, Picqer), handed with its signature
//!   headers to WeldConnect's internal
//!   `/api/integrations/connections/:id/connector-event` for the workspace the
//!   KV entry `connconn:<id>` names, and its answer relayed;
//! - `POST /webhooks/stripe-connect`: the Stripe platform's Connect webhook,
//!   verified with `STRIPE_CONNECT_WEBHOOK_SECRET` and handed, marked as
//!   verified, to every connection of the event's account (`stripeacct:`);
//! - [`run_connector_catchup_sweep`] (`weldsuite cron connector-catchup`):
//!   the workspaces whose connector catch-up is due (the master
//!   `workspace_due_index`, kind `connector_catchup`, where Global keeps the
//!   D1 `connector_sync_index`; see `weldsuite_connect_domain::catchup`);
//! - [`run_moneybird_push_sweep`] (`weldsuite cron moneybird-push`): another
//!   Moneybird push pass for the workspaces whose last pass left work (kind
//!   `moneybird_push`, Global's `tenant_work_index`).

use std::sync::Mutex;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_connect_domain::catchup::{self, Backoff};
use weldsuite_connect_domain::sync::SyncEnv;
use weldsuite_connect_domain::webhooks::{
    STRIPE_CONNECT_VERIFIED_HEADER, connection_kv_key, stripe_account_kv_key, verify,
};
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{SweepResult, run_sweep};

use crate::connect_internal::{ConnectCall, ConnectInternal};
use crate::crm::due::WorkspaceOpener;
use crate::{IntegrationsState, PublicCtx};

/// The headers a connector webhook keeps on its way to connect-api.
const FORWARDED_HEADERS: [&str; 8] = [
    "x-wc-webhook-topic",
    "x-wc-webhook-signature",
    "x-shopify-topic",
    "x-shopify-hmac-sha256",
    "moneybird-signature",
    "x-picqer-signature",
    "stripe-signature",
    "idempotency-key",
];

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/webhooks/connectors/{connection_id}",
            post(connector_webhook),
        )
        .route("/webhooks/stripe-connect", post(stripe_connect))
        .with_state(state)
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// The app's `onError`: a 500, with the message outside production.
fn on_error(ctx: &PublicCtx, state: &IntegrationsState, message: &str) -> Response {
    let mut body = Map::new();
    body.insert("error".to_owned(), json!("Internal Server Error"));
    if ctx.env(state, "ENVIRONMENT").as_deref() != Some("production") {
        body.insert("message".to_owned(), json!(message));
    }
    answer(StatusCode::INTERNAL_SERVER_ERROR, Value::Object(body))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
}

async fn connector_webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let cached = match ctx.cache(&state) {
        Some(cache) => match cache.get_boxed(&connection_kv_key(&connection_id)).await {
            Ok(value) => value,
            Err(error) => return on_error(&ctx, &state, &error.to_string()),
        },
        None => None,
    };
    let Some(cached) = cached.filter(|c| !c.is_empty()) else {
        return answer(
            StatusCode::NOT_FOUND,
            json!({ "error": "Unknown connector" }),
        );
    };
    let workspace = match serde_json::from_str::<Value>(&cached) {
        // `JSON.parse` succeeded; `entry.workspaceId` as the header value.
        Ok(entry) => match entry.get("workspaceId") {
            Some(Value::String(id)) => id.clone(),
            Some(Value::Null) | None => "undefined".to_owned(),
            Some(other) => other.to_string(),
        },
        Err(_) => {
            return answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Corrupt connector mapping" }),
            );
        }
    };
    let Some(connect) = ctx.connect_internal(&state) else {
        tracing::error!("[Webhook/connectors] CONNECT_INTERNAL / APP_API binding missing");
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "Connector ingest unavailable" }),
        );
    };
    let mut forwarded = vec![
        (
            "Content-Type".to_owned(),
            header(&headers, "content-type")
                .unwrap_or("application/json")
                .to_owned(),
        ),
        ("X-Internal-Workspace-Id".to_owned(), workspace),
    ];
    for name in FORWARDED_HEADERS {
        if let Some(value) = header(&headers, name) {
            forwarded.push((name.to_owned(), value.to_owned()));
        }
    }
    let call = ConnectCall {
        method: "POST".to_owned(),
        path: format!("/api/integrations/connections/{connection_id}/connector-event"),
        headers: forwarded,
        body: Some(String::from_utf8_lossy(&body).into_owned()),
    };
    match connect.fetch(call).await {
        Ok(response) => (
            StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            [(http::header::CONTENT_TYPE, "application/json")],
            response.body,
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "[Webhook/connectors] connector-event forward threw");
            on_error(&ctx, &state, &error)
        }
    }
}

/// `handleStripeConnectWebhook(env, rawBody, signature)`.
async fn stripe_connect(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(secret) = ctx
        .env(&state, "STRIPE_CONNECT_WEBHOOK_SECRET")
        .filter(|s| !s.is_empty())
    else {
        tracing::error!("[Webhook/stripe-connect] STRIPE_CONNECT_WEBHOOK_SECRET is not set");
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "Stripe Connect webhook not configured" }),
        );
    };
    let raw = String::from_utf8_lossy(&body).into_owned();
    if !verify(
        "stripe",
        &secret,
        &raw,
        headers
            .get("stripe-signature")
            .and_then(|v| v.to_str().ok()),
    ) {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Invalid signature" }),
        );
    }
    let Ok(event) = serde_json::from_str::<Value>(&raw) else {
        return answer(StatusCode::BAD_REQUEST, json!({ "error": "Invalid JSON" }));
    };
    // Events on the platform account itself (billing, WeldApps) aren't ours.
    let Some(account) = event.get("account").and_then(Value::as_str) else {
        return answer(
            StatusCode::OK,
            json!({ "received": true, "ignored": "platform event" }),
        );
    };
    let targets = match ctx.cache(&state) {
        Some(cache) => match cache.get_boxed(&stripe_account_kv_key(account)).await {
            Ok(Some(raw)) if !raw.is_empty() => serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default(),
            Ok(_) => Vec::new(),
            Err(error) => return on_error(&ctx, &state, &error.to_string()),
        },
        None => Vec::new(),
    };
    if targets.is_empty() {
        return answer(
            StatusCode::OK,
            json!({ "received": true, "ignored": "unknown account" }),
        );
    }
    let Some(connect) = ctx.connect_internal(&state) else {
        tracing::error!("[Webhook/stripe-connect] CONNECT_INTERNAL / APP_API binding missing");
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "Connector ingest unavailable" }),
        );
    };
    let mut failed = 0u32;
    for target in &targets {
        let text = |key: &str| match target.get(key) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) | None => "undefined".to_owned(),
            Some(other) => other.to_string(),
        };
        let connection_id = text("connectionId");
        let call = ConnectCall {
            method: "POST".to_owned(),
            path: format!("/api/integrations/connections/{connection_id}/connector-event"),
            headers: vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("X-Internal-Workspace-Id".to_owned(), text("workspaceId")),
                (
                    STRIPE_CONNECT_VERIFIED_HEADER.to_owned(),
                    "verified".to_owned(),
                ),
            ],
            body: Some(raw.clone()),
        };
        match connect.fetch(call).await {
            Ok(response) if response.status >= 500 => failed += 1,
            Ok(_) => {}
            Err(error) => {
                failed += 1;
                tracing::error!(
                    "[Webhook/stripe-connect] forward to {connection_id} failed: {error}"
                );
            }
        }
    }
    // A 5xx makes Stripe retry; ingest is idempotent, so re-delivering to the
    // others is harmless.
    if failed > 0 {
        answer(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "Ingest failed", "failed": failed }),
        )
    } else {
        answer(
            StatusCode::OK,
            json!({ "received": true, "delivered": targets.len() }),
        )
    }
}

// ── the connector catch-up ──────────────────────────────────────────────────

/// What a catch-up tick did (`runConnectorCatchupSweep`'s counts).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CatchupCounts {
    /// Due, probed, nothing new.
    pub probed: u32,
    /// Something new: caught up through WeldConnect.
    pub ingested: u32,
    /// The probe or the catch-up failed: retried after a back-off.
    pub backed_off: u32,
}

impl CatchupCounts {
    pub fn to_json(self) -> Value {
        json!({
            "probed": self.probed,
            "ingested": self.ingested,
            "backedOff": self.backed_off,
        })
    }
}

/// What the catch-up's probe reads: the keyring for the stored
/// credentials, the Stripe platform key (`STRIPE_SECRET_KEY`, OAuth Stripe
/// connections) and third-party HTTP.
pub fn probe_env(
    keyring: weldsuite_db::Keyring,
    stripe_secret_key: Option<String>,
    http: Option<weldsuite_ports::OutboundHttp>,
    events: weldsuite_events::EntityEventPublisher,
) -> SyncEnv {
    SyncEnv {
        keyring,
        stripe_secret_key: stripe_secret_key.filter(|key| !key.is_empty()),
        storage: None,
        http,
        events,
        due: None,
    }
}

/// `requestConnectorCatchup(env, row)`: the connection's catch-up sync, run
/// by WeldConnect. Whether it ran, else how long to back off.
async fn request_catchup(
    connect: &dyn ConnectInternal,
    clerk_org_id: &str,
    connection_id: &str,
) -> Result<(), Backoff> {
    let call = ConnectCall::post(
        format!("/api/integrations/connections/{connection_id}/catch-up"),
        "X-Workspace-Id",
        clerk_org_id,
        None,
    );
    match connect.fetch(call).await {
        Ok(response) if response.ok() => Ok(()),
        Ok(response) => {
            tracing::error!(
                "[ConnectorCatchup] catch-up HTTP {} for {connection_id}",
                response.status
            );
            Err(Backoff::of_status(response.status))
        }
        Err(error) => {
            tracing::error!("[ConnectorCatchup] catch-up for {connection_id} threw: {error}");
            Err(Backoff::Transient)
        }
    }
}

/// One workspace (`processConnectorCatchupRow` per due connection): probe
/// what is due, catch up what changed, and say when the workspace is next
/// due (`None`: no connection left to look after).
pub async fn catch_up_workspace(
    db: &PgPool,
    env: &SyncEnv,
    connect: &dyn ConnectInternal,
    clerk_org_id: &str,
    now: i64,
    counts: &mut CatchupCounts,
) -> Result<Option<i64>, sqlx::Error> {
    let mut next: Option<i64> = None;
    for connection in catchup::due_connections(db).await? {
        let at = if connection.due_at <= now {
            let interval = now + connection.interval_minutes * 60_000;
            match catchup::probe_updates(&connection.row, env).await {
                Ok(false) => {
                    counts.probed += 1;
                    interval
                }
                Ok(true) => match request_catchup(connect, clerk_org_id, &connection.id).await {
                    Ok(()) => {
                        counts.ingested += 1;
                        interval
                    }
                    Err(kind) => {
                        counts.backed_off += 1;
                        now + catchup::backoff_ms(kind, None)
                    }
                },
                Err(error) => {
                    tracing::warn!(
                        "[ConnectorCatchup] probe of {} failed: {}",
                        connection.id,
                        error.message
                    );
                    counts.backed_off += 1;
                    now + catchup::backoff_ms(Backoff::of(&error), error.retry_after)
                }
            }
        } else {
            connection.due_at
        };
        next = Some(next.map_or(at, |n| n.min(at)));
    }
    Ok(next)
}

fn at_millis(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn millis(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `runConnectorCatchupSweep`: every workspace whose connector catch-up is
/// due (50 a tick). `env` reads the credentials (keyring, Stripe platform
/// key) and calls the providers.
pub async fn run_connector_catchup_sweep(
    master: &PgPool,
    open: &WorkspaceOpener,
    connect: &dyn ConnectInternal,
    env: &SyncEnv,
    now: OffsetDateTime,
) -> (SweepResult, CatchupCounts) {
    let now_ms = millis(now);
    let counts = Mutex::new(CatchupCounts::default());
    let result = run_sweep(
        master,
        catchup::DUE_KIND,
        now,
        50,
        Some(time::Duration::minutes(30)),
        |workspace_id: String, _| {
            let open = std::sync::Arc::clone(open);
            let counts = &counts;
            async move {
                let (db, clerk_org_id) = open(workspace_id).await?;
                let mut local = CatchupCounts::default();
                let next = catch_up_workspace(&db, env, connect, &clerk_org_id, now_ms, &mut local)
                    .await
                    .map_err(|e| crate::crm::db_message(&e))?;
                let mut counts = counts
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                counts.probed += local.probed;
                counts.ingested += local.ingested;
                counts.backed_off += local.backed_off;
                Ok::<_, String>(next.map(at_millis))
            }
        },
    )
    .await;
    let counts = counts
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tracing::info!(
        "[ConnectorCatchup] probed {}, ingested {}, backed off {}",
        counts.probed,
        counts.ingested,
        counts.backed_off
    );
    (result, counts)
}

// ── the Moneybird push backlog ──────────────────────────────────────────────

/// `MONEYBIRD_PUSH_INTERVAL_MS`.
const PUSH_INTERVAL_MS: i64 =
    weldsuite_connect_domain::moneybird_push::PUSH_INTERVAL_SECONDS * 1000;

/// One workspace's push pass through WeldConnect's internal
/// `/api/integrations/moneybird-push`: next due in five minutes when work
/// is left, never when none is, ten minutes after a failure.
pub async fn push_workspace(
    connect: &dyn ConnectInternal,
    clerk_org_id: &str,
    now: i64,
) -> Option<i64> {
    let call = ConnectCall::post(
        "/api/integrations/moneybird-push".to_owned(),
        "X-Workspace-Id",
        clerk_org_id,
        None,
    );
    match connect.fetch(call).await {
        Ok(response) if response.ok() => {
            let remaining = response
                .json()
                .pointer("/data/remaining")
                .is_some_and(|r| r.as_bool() == Some(true));
            // Nothing left: drop out so the workspace's database can idle.
            remaining.then_some(now + PUSH_INTERVAL_MS)
        }
        Ok(response) => {
            tracing::error!(
                "[MoneybirdPushSweep] workspace {clerk_org_id}: moneybird push HTTP {}",
                response.status
            );
            Some(now + 2 * PUSH_INTERVAL_MS)
        }
        Err(error) => {
            tracing::error!("[MoneybirdPushSweep] workspace {clerk_org_id}: {error}");
            Some(now + 2 * PUSH_INTERVAL_MS)
        }
    }
}

/// The Clerk org id connect-api's internal routes take (`X-Workspace-Id`),
/// read off the master database; the tenant stays closed.
async fn clerk_org_of(master: &PgPool, workspace_id: &str) -> Result<String, String> {
    let found: Option<String> = sqlx::query_scalar(
        "select coalesce(clerk_org_id, id) from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await
    .map_err(|e| crate::crm::db_message(&e))?;
    found.ok_or_else(|| format!("workspace {workspace_id} not found"))
}

/// `runMoneybirdPushSweep(env)`: every workspace with a Moneybird push
/// backlog (50 a tick).
pub async fn run_moneybird_push_sweep(
    master: &PgPool,
    connect: &dyn ConnectInternal,
    now: OffsetDateTime,
) -> SweepResult {
    let now_ms = millis(now);
    run_sweep(
        master,
        weldsuite_connect_domain::moneybird_push::DUE_KIND,
        now,
        50,
        Some(time::Duration::milliseconds(2 * PUSH_INTERVAL_MS)),
        |workspace_id: String, _| async move {
            let clerk_org_id = clerk_org_of(master, &workspace_id).await?;
            Ok::<_, String>(
                push_workspace(connect, &clerk_org_id, now_ms)
                    .await
                    .map(at_millis),
            )
        },
    )
    .await
}
