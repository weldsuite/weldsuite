//! `POST /webhooks/github` (`github/webhook.ts`): the GitHub App's
//! deliveries. Public: the App-level secret's HMAC (`X-Hub-Signature-256`)
//! is the credential, the connection's own secret the fallback. A GitHub
//! App installation is a WeldMerge connection (`merge_connections`, provider
//! `github`, `external_account_id` = the installation id as text). The
//! workspace comes from the installation: cached a day, else the master
//! installation index (`merge_provider_index`), else a scan of the
//! workspaces' tenant databases that writes the index row (a lazy backfill,
//! DATA-008). Then, in the background:
//!
//! - `installation` → the connection's status; a deleted installation also
//!   leaves the index and the cache;
//! - `projects_v2_item` and `issues` (a mapped issue) → one inbound
//!   `GITHUB_PROJECT_SYNC` run per link per minute;
//! - `pull_request`, `pull_request_review`, `check_suite`,
//!   `installation_repositories`, `issues`, `issue_comment` and
//!   `installation` → forwarded to WeldMerge (`MERGE_INTERNAL`,
//!   [`crate::merge_internal`]), fire-and-forget.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use hmac::{KeyInit, Mac};
use http::{HeaderMap, StatusCode};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, Order, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use sha2::Sha256;
use time::OffsetDateTime;
use weldsuite_db::{Keyring, PgPool, orm};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{merge_provider_index as provider_index, workspaces};
use weldsuite_schema::tenant::{
    github_issue_sync_map as sync_map, github_project_links as links, merge_connections,
};

use super::WorkflowRuns;
use crate::crm::db_text;
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

/// The live GitHub connection of an installation, newest active first
/// (`getConnectionByInstallationId`): its sealed webhook secret.
async fn connection_by_installation(
    db: &PgPool,
    installation_id: i64,
) -> Result<Option<Option<String>>, DbErr> {
    merge_connections::Entity::find()
        .select_only()
        .column(merge_connections::Column::WebhookSecret)
        .filter(merge_connections::Column::Provider.eq("github"))
        .filter(merge_connections::Column::ExternalAccountId.eq(installation_id.to_string()))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .order_by(
            sea_orm::ExprTrait::eq(
                Expr::col((merge_connections::Entity, merge_connections::Column::Status)),
                "active",
            ),
            Order::Desc,
        )
        .order_by_desc(merge_connections::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
        .await
}

/// A moment as the worker bound it (`toISOString()`): to the millisecond.
fn now_millis() -> OffsetDateTime {
    let at = OffsetDateTime::now_utc();
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
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
            let error = db_text(&error);
            tracing::error!(%error, "[GitHub Webhook] connection lookup failed");
            return answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Internal Server Error" }),
            );
        }
    };
    let Some(stored_secret) = connection else {
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

    // WeldMerge mirrors pull requests and syncs issues; the forward never
    // changes this answer.
    if crate::merge_internal::is_forwarded_to_merge(&event_type) {
        let merge = state.merge_internal.clone();
        let (workspace, event, delivery, payload) = (
            clerk_org_id.clone(),
            event_type.clone(),
            delivery.clone(),
            payload.clone(),
        );
        state.events.tracker().spawn(async move {
            crate::merge_internal::forward_to_merge(
                merge.as_deref(),
                &workspace,
                &event,
                &delivery,
                &payload,
            )
            .await;
        });
    }

    let runs = ctx.github_sync(&state);
    let installed = Installed {
        master: ctx.master(&state),
        cache,
        cache_key,
    };
    state.events.tracker().spawn(async move {
        handle_event(
            &db,
            runs.as_deref(),
            &installed,
            &clerk_org_id,
            &event_type,
            &delivery,
            &payload,
            installation,
        )
        .await;
    });
    accepted()
}

/// Where an uninstalled installation is forgotten: the master index and the
/// cached `gh-install:<id>` entry.
struct Installed {
    master: Option<PgPool>,
    cache: Option<Arc<dyn DynCache>>,
    cache_key: String,
}

/// `workspaceOfInstallation`: the workspace of an installation, as its Clerk
/// org id (what the rest of this receiver and the project-sync rows are keyed
/// by; `workspaces.id` for a workspace without one). `None` when nothing
/// knows it, or when resolving failed (logged).
async fn resolve_workspace(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    installation: i64,
) -> Option<String> {
    let Some(master) = ctx.master(state) else {
        tracing::error!(
            "[GitHub Webhook] Failed to resolve workspace for installation: no master database"
        );
        return None;
    };
    match workspace_of_installation(ctx, state, &master, installation).await {
        Ok(found) => found,
        Err(error) => {
            let error = db_text(&error);
            tracing::error!(%error, "[GitHub Webhook] Failed to resolve workspace for installation");
            None
        }
    }
}

/// The master index row (`merge_provider_index`, kind `installation`), else
/// a scan of the tenant databases.
async fn workspace_of_installation(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    master: &PgPool,
    installation: i64,
) -> Result<Option<String>, DbErr> {
    let indexed: Option<String> = provider_index::Entity::find()
        .select_only()
        .column(provider_index::Column::WorkspaceId)
        .filter(provider_index::Column::Provider.eq("github"))
        .filter(provider_index::Column::Kind.eq("installation"))
        .filter(provider_index::Column::ExternalKey.eq(installation.to_string()))
        .into_tuple()
        .one(&orm(master))
        .await?;
    if let Some(workspace_id) = indexed {
        let workspace: Option<(String, Option<String>)> = workspaces::Entity::find()
            .select_only()
            .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
            .filter(workspaces::Column::Id.eq(&workspace_id))
            .into_tuple()
            .one(&orm(master))
            .await?;
        if let Some((id, clerk_org_id)) = workspace {
            return Ok(Some(clerk_org_id.unwrap_or(id)));
        }
    }
    scan_for_installation(ctx, state, master, installation).await
}

/// `scanForInstallation`: the first of (up to 500) workspaces whose database
/// has a live connection for the installation; it writes the index row, so
/// the next delivery finds it there. A workspace whose database fails to
/// open (or whose row fails to write) is skipped.
async fn scan_for_installation(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    master: &PgPool,
    installation: i64,
) -> Result<Option<String>, DbErr> {
    let rows: Vec<(String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
        .limit(500)
        .into_tuple()
        .all(&orm(master))
        .await?;
    for (id, clerk_org_id) in rows {
        let reference = clerk_org_id.unwrap_or_else(|| id.clone());
        let Ok(db) = ctx.tenant_db(state, &reference).await else {
            continue;
        };
        let found: Result<Option<String>, DbErr> = merge_connections::Entity::find()
            .select_only()
            .column(merge_connections::Column::Id)
            .filter(merge_connections::Column::Provider.eq("github"))
            .filter(merge_connections::Column::ExternalAccountId.eq(installation.to_string()))
            .filter(merge_connections::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&db))
            .await;
        if let Ok(Some(_)) = found
            && upsert_installation_index(master, installation, &id)
                .await
                .is_ok()
        {
            return Ok(Some(reference));
        }
    }
    Ok(None)
}

/// `upsertGithubInstallationIndex`: writes (or refreshes) the master
/// `installation id → workspace` row.
async fn upsert_installation_index(
    master: &PgPool,
    installation: i64,
    workspace_id: &str,
) -> Result<(), DbErr> {
    let now = now_millis();
    provider_index::Entity::insert(provider_index::ActiveModel {
        id: Set(weldsuite_kit::generate_id("mpi")),
        provider: Set("github".to_owned()),
        kind: Set("installation".to_owned()),
        external_key: Set(installation.to_string()),
        workspace_id: Set(workspace_id.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::columns([
            provider_index::Column::Provider,
            provider_index::Column::Kind,
            provider_index::Column::ExternalKey,
        ])
        .update_columns([
            provider_index::Column::WorkspaceId,
            provider_index::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec_without_returning(&orm(master))
    .await?;
    Ok(())
}

/// `setGithubInstallationStatus`: every live connection of the installation
/// moves to `status`; `revoked_at` is set when it is revoked, cleared
/// otherwise.
async fn set_installation_status(
    db: &PgPool,
    installation: i64,
    status: &str,
) -> Result<(), DbErr> {
    let now = now_millis();
    merge_connections::Entity::update_many()
        .col_expr(merge_connections::Column::Status, Expr::value(status))
        .col_expr(
            merge_connections::Column::RevokedAt,
            Expr::value((status == "revoked").then_some(now)),
        )
        .col_expr(merge_connections::Column::UpdatedAt, Expr::value(now))
        .filter(merge_connections::Column::Provider.eq("github"))
        .filter(merge_connections::Column::ExternalAccountId.eq(installation.to_string()))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `forgetInstallation` and the cache entry: an uninstalled installation
/// resolves nowhere any more.
async fn forget_installation(installed: &Installed, installation: i64) -> Result<(), String> {
    let master = installed
        .master
        .as_ref()
        .ok_or_else(|| "no master database".to_owned())?;
    provider_index::Entity::delete_many()
        .filter(provider_index::Column::Provider.eq("github"))
        .filter(provider_index::Column::Kind.eq("installation"))
        .filter(provider_index::Column::ExternalKey.eq(installation.to_string()))
        .exec(&orm(master))
        .await
        .map_err(|error| db_text(&error))?;
    if let Some(cache) = &installed.cache {
        cache
            .delete_boxed(&installed.cache_key)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn handle_event(
    db: &PgPool,
    runs: Option<&dyn WorkflowRuns>,
    installed: &Installed,
    workspace_id: &str,
    event_type: &str,
    delivery: &str,
    payload: &Value,
    installation: i64,
) {
    let result: Result<(), String> = async {
        match event_type {
            "installation" => {
                match payload.get("action").map(js_string).as_deref() {
                    Some("deleted") => {
                        set_installation_status(db, installation, "revoked")
                            .await
                            .map_err(|error| db_text(&error))?;
                        forget_installation(installed, installation).await?;
                    }
                    Some("suspend") => set_installation_status(db, installation, "suspended")
                        .await
                        .map_err(|error| db_text(&error))?,
                    Some("unsuspend" | "created") => {
                        set_installation_status(db, installation, "active")
                            .await
                            .map_err(|error| db_text(&error))?;
                    }
                    _ => {}
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
                let link: Option<(String, String)> = links::Entity::find()
                    .select_only()
                    .columns([links::Column::Id, links::Column::SyncDirection])
                    .filter(links::Column::WorkspaceId.eq(workspace_id))
                    .filter(links::Column::ProjectV2NodeId.eq(node))
                    .filter(links::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm(db))
                    .await
                    .map_err(|error| db_text(&error))?;
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
            "issues" => handle_issue(db, runs, workspace_id, delivery, payload)
                .await
                .map_err(|error| db_text(&error))?,
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
) -> Result<(), DbErr> {
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
    let mut link_id: Option<String> = sync_map::Entity::find()
        .select_only()
        .column(sync_map::Column::ProjectLinkId)
        .filter(sync_map::Column::WorkspaceId.eq(workspace_id))
        .filter(sync_map::Column::IssueNodeId.eq(node))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let number = issue.and_then(|i| i.get("number")).and_then(Value::as_i64);
    let repo = payload
        .get("repository")
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64);
    if link_id.is_none()
        && let (Some(number), Some(repo)) = (number, repo)
    {
        link_id = sync_map::Entity::find()
            .select_only()
            .column(sync_map::Column::ProjectLinkId)
            .filter(sync_map::Column::WorkspaceId.eq(workspace_id))
            .filter(sync_map::Column::IssueNumber.eq(i32::try_from(number).unwrap_or(i32::MAX)))
            .filter(sync_map::Column::RepoId.eq(repo))
            .into_tuple()
            .one(&orm(db))
            .await?;
    }
    let Some(link_id) = link_id else {
        tracing::info!("[GitHub Webhook] issue {node} not mapped, skipping (delivery: {delivery})");
        return Ok(());
    };
    let link: Option<(String, String)> = links::Entity::find()
        .select_only()
        .columns([links::Column::Id, links::Column::SyncDirection])
        .filter(links::Column::Id.eq(&link_id))
        .filter(links::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
