//! `POST /webhooks/github` (`github/webhook.ts`): the GitHub App's
//! deliveries. Public: the App-level secret's HMAC (`X-Hub-Signature-256`)
//! is the credential, the connection's own secret the fallback. The
//! workspace comes from the installation (cached a day, else a scan of the
//! workspaces' `github_connections`). Then, in the background:
//!
//! - `installation` → the connection's status;
//! - `projects_v2_item` and `issues` (a mapped issue) → one inbound
//!   `GITHUB_PROJECT_SYNC` run per link per minute.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use hmac::{KeyInit, Mac};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sha2::Sha256;
use weldsuite_db::{Keyring, PgPool};

use super::WorkflowRuns;
use crate::{IntegrationsState, PublicCtx};

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/github", post(webhook))
        .with_state(state)
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn unauthorized() -> Response {
    answer(
        StatusCode::UNAUTHORIZED,
        json!({ "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }),
    )
}

fn accepted() -> Response {
    answer(StatusCode::ACCEPTED, json!({ "received": true }))
}

/// `payload.installation?.id ?? null`, as a falsy check reads it.
fn installation_id(payload: &Value) -> Option<i64> {
    match payload.get("installation")?.get("id")? {
        Value::Number(n) => n.as_i64().filter(|id| *id != 0),
        Value::String(text) => text.parse().ok().filter(|id| *id != 0),
        _ => None,
    }
}

/// `verifyWebhookSignature(rawBody, header, secret)`.
///
/// # Panics
///
/// Never: HMAC takes a key of any length.
pub fn verify_signature(body: &[u8], header: Option<&str>, secret: &str) -> bool {
    let Some(received) = header.and_then(|h| h.strip_prefix("sha256=")) else {
        return false;
    };
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key");
    mac.update(body);
    let expected = hex::encode(mac.finalize().into_bytes());
    if received.len() != expected.len() {
        return false;
    }
    received
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// A connection of the installation: `(workspace_id, webhook_secret)`.
async fn connection_by_installation(
    db: &PgPool,
    installation_id: i64,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "select workspace_id, webhook_secret from github_connections \
         where installation_id = $1 and deleted_at is null limit 1",
    )
    .bind(installation_id)
    .fetch_optional(db)
    .await
}

async fn webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let event_type = header("x-github-event").unwrap_or_default().to_owned();
    let delivery = header("x-github-delivery").unwrap_or_default().to_owned();
    let Ok(payload) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&body)) else {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }),
        );
    };
    let Some(installation) = installation_id(&payload) else {
        return accepted(); // ping, or an event without an installation
    };
    let keyring = Keyring {
        v1: ctx
            .env(&state, "DATABASE_ENCRYPTION_KEY")
            .filter(|k| !k.is_empty()),
        v2: ctx
            .env(&state, "DATABASE_ENCRYPTION_KEY_V2")
            .filter(|k| !k.is_empty()),
    };
    if keyring.v1.is_none() && keyring.v2.is_none() {
        tracing::error!("[GitHub Webhook] DATABASE_ENCRYPTION_KEY not configured");
        return unauthorized();
    }

    // The workspace of the installation: the cache, else a scan.
    let cache = ctx.cache(&state);
    let cache_key = format!("gh-install:{installation}");
    let cached = match &cache {
        Some(cache) => cache.get_boxed(&cache_key).await.ok().flatten(),
        None => None,
    };
    let clerk_org_id = if let Some(org) = cached.filter(|c| !c.is_empty()) {
        Some(org)
    } else {
        {
            let found = resolve_workspace(&ctx, &state, installation).await;
            if let (Some(org), Some(cache)) = (&found, &cache)
                && let Err(error) = cache
                    .put_boxed(&cache_key, org, Some(Duration::from_hours(24)))
                    .await
            {
                tracing::warn!(%error, "[GitHub Webhook] installation not cached");
            }
            found
        }
    };
    let Some(clerk_org_id) = clerk_org_id else {
        tracing::warn!("[GitHub Webhook] Unknown installation {installation} — ignoring");
        return accepted();
    };
    let db = match ctx.tenant_db(&state, &clerk_org_id).await {
        Ok(db) => db,
        Err(error) => {
            tracing::error!("[GitHub Webhook] Failed to get tenant DB for {clerk_org_id}: {error}");
            return unauthorized();
        }
    };
    let connection = match connection_by_installation(&db, installation).await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::error!(%error, "[GitHub Webhook] connection lookup failed");
            return answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Internal Server Error" }),
            );
        }
    };
    let Some((workspace_id, stored_secret)) = connection else {
        tracing::warn!("[GitHub Webhook] No connection for installation {installation}");
        return accepted();
    };

    // The App-level secret signs every delivery; the connection's is the fallback.
    let connection_secret = match stored_secret.filter(|s| !s.is_empty()) {
        Some(sealed) => match weldsuite_db::decrypt_field(&sealed, &keyring) {
            Ok(secret) => Some(secret),
            Err(error) => {
                tracing::error!(?error, "[GitHub Webhook] connection secret does not open");
                return answer(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "Internal Server Error" }),
                );
            }
        },
        None => None,
    };
    let secret = ctx
        .env(&state, "GITHUB_WEBHOOK_SECRET")
        .filter(|s| !s.is_empty())
        .or(connection_secret)
        .filter(|s| !s.is_empty());
    let Some(secret) = secret else {
        tracing::error!("[GitHub Webhook] No webhook secret available for verification");
        return unauthorized();
    };
    if !verify_signature(&body, header("x-hub-signature-256"), &secret) {
        return unauthorized();
    }

    let runs = ctx.github_sync(&state);
    state.events.tracker().spawn(async move {
        handle_event(
            &db,
            runs.as_deref(),
            &workspace_id,
            &event_type,
            &delivery,
            &payload,
            installation,
        )
        .await;
    });
    accepted()
}

/// `resolveWorkspaceForInstallation`: the first of (up to 500) workspaces
/// whose database has a live connection for the installation.
async fn resolve_workspace(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    installation: i64,
) -> Option<String> {
    let master = ctx.master(state)?;
    let orgs: Vec<Option<String>> = match sqlx::query_scalar(
        "select clerk_org_id from workspaces limit 500",
    )
    .fetch_all(&master)
    .await
    {
        Ok(orgs) => orgs,
        Err(error) => {
            tracing::error!(%error, "[GitHub Webhook] Failed to resolve workspace for installation");
            return None;
        }
    };
    for org in orgs.into_iter().flatten().filter(|o| !o.is_empty()) {
        let Ok(db) = ctx.tenant_db(state, &org).await else {
            continue;
        };
        if let Ok(Some(_)) = connection_by_installation(&db, installation).await {
            return Some(org);
        }
    }
    None
}

async fn handle_event(
    db: &PgPool,
    runs: Option<&dyn WorkflowRuns>,
    workspace_id: &str,
    event_type: &str,
    delivery: &str,
    payload: &Value,
    installation: i64,
) {
    let result: Result<(), sqlx::Error> = async {
        match event_type {
            "installation" => {
                let status = match payload.get("action").map(js_string).as_deref() {
                    Some("deleted") => Some("revoked"),
                    Some("suspend") => Some("suspended"),
                    Some("unsuspend" | "created") => Some("active"),
                    _ => None,
                };
                if let Some(status) = status {
                    let now = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc());
                    sqlx::query(
                        "update github_connections set status = $2, \
                         revoked_at = case when $2 = 'revoked' then $3::timestamp else revoked_at end, \
                         updated_at = $3::timestamp where installation_id = $1",
                    )
                    .bind(installation)
                    .bind(status)
                    .bind(&now)
                    .execute(db)
                    .await?;
                }
            }
            "projects_v2_item" => {
                let node = payload
                    .get("projects_v2_item")
                    .and_then(|item| item.get("project_node_id"))
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty());
                let Some(node) = node else {
                    tracing::info!(
                        "[GitHub Webhook] projects_v2_item without project_node_id (delivery: {delivery})"
                    );
                    return Ok(());
                };
                let link: Option<(String, String)> = sqlx::query_as(
                    "select id, sync_direction from github_project_links \
                     where workspace_id = $1 and project_v2_node_id = $2 and deleted_at is null limit 1",
                )
                .bind(workspace_id)
                .bind(node)
                .fetch_optional(db)
                .await?;
                match link {
                    None => tracing::info!(
                        "[GitHub Webhook] Project {node} not linked in {workspace_id}, skipping"
                    ),
                    Some((id, direction)) if direction == "outbound" => tracing::info!(
                        "[GitHub Webhook] Link {id} is outbound-only, ignoring inbound item event"
                    ),
                    Some((id, _)) => dispatch(runs, workspace_id, &id, delivery).await,
                }
            }
            "projects_v2" => tracing::info!(
                "[GitHub Webhook] projects_v2 {} (delivery: {delivery})",
                payload.get("action").map(js_string).unwrap_or_default()
            ),
            "issues" => handle_issue(db, runs, workspace_id, delivery, payload).await?,
            other => tracing::info!(
                "[GitHub Webhook] Unhandled event type: {other} (delivery: {delivery})"
            ),
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!("[GitHub Webhook] Error handling {event_type} ({delivery}): {error}");
    }
}

/// `String(value)` for an event's `action`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// An `issues` event on a mapped issue: an inbound sync of its link.
async fn handle_issue(
    db: &PgPool,
    runs: Option<&dyn WorkflowRuns>,
    workspace_id: &str,
    delivery: &str,
    payload: &Value,
) -> Result<(), sqlx::Error> {
    let issue = payload.get("issue");
    let Some(node) = issue
        .and_then(|i| i.get("node_id"))
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
    else {
        tracing::info!(
            "[GitHub Webhook] issues event without issue node_id (delivery: {delivery})"
        );
        return Ok(());
    };
    let mut link_id: Option<String> = sqlx::query_scalar(
        "select project_link_id from github_issue_sync_map where workspace_id = $1 and issue_node_id = $2 limit 1",
    )
    .bind(workspace_id)
    .bind(node)
    .fetch_optional(db)
    .await?;
    let number = issue.and_then(|i| i.get("number")).and_then(Value::as_i64);
    let repo = payload
        .get("repository")
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64);
    if link_id.is_none()
        && let (Some(number), Some(repo)) = (number, repo)
    {
        link_id = sqlx::query_scalar(
            "select project_link_id from github_issue_sync_map \
             where workspace_id = $1 and issue_number = $2 and repo_id = $3 limit 1",
        )
        .bind(workspace_id)
        .bind(i32::try_from(number).unwrap_or(i32::MAX))
        .bind(repo)
        .fetch_optional(db)
        .await?;
    }
    let Some(link_id) = link_id else {
        tracing::info!("[GitHub Webhook] issue {node} not mapped, skipping (delivery: {delivery})");
        return Ok(());
    };
    let link: Option<(String, String)> = sqlx::query_as(
        "select id, sync_direction from github_project_links where id = $1 and deleted_at is null limit 1",
    )
    .bind(&link_id)
    .fetch_optional(db)
    .await?;
    if let Some((id, direction)) = link
        && direction != "outbound"
    {
        dispatch(runs, workspace_id, &id, delivery).await;
    }
    Ok(())
}

/// One inbound sync per link per minute: a burst of deliveries (the sync's
/// own writes fire more) collapses onto one run id.
async fn dispatch(
    runs: Option<&dyn WorkflowRuns>,
    workspace_id: &str,
    link_id: &str,
    delivery: &str,
) {
    let Some(runs) = runs else {
        // `env.GITHUB_PROJECT_SYNC.create` on a missing binding throws: logged.
        tracing::info!(
            "[GitHub Webhook] Sync already queued for link {link_id}, skipping delivery {delivery}"
        );
        return;
    };
    let bucket = time::OffsetDateTime::now_utc().unix_timestamp() / 60;
    let id = format!("github-project-sync-{link_id}-{bucket}");
    let params =
        json!({ "workspaceId": workspace_id, "projectLinkId": link_id, "inboundOnly": true });
    if runs.create(&id, &params).await.is_ok() {
        tracing::info!(
            "[GitHub Webhook] Dispatched project sync for link {link_id} (bucket {bucket}, delivery {delivery})"
        );
    } else {
        tracing::info!(
            "[GitHub Webhook] Sync already queued for link {link_id} (bucket {bucket}), skipping delivery {delivery}"
        );
    }
}
