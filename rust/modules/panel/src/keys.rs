//! Secret keys under `/api/panel/projects/:id/keys` (`routes/keys/index.ts`,
//! `services/keys.ts`): `wps_` + 32 hex, for server-side ingest and imports.
//! Everything here is `panel_projects:manage`.
//!
//!   GET    /          → the project's keys, revoked ones included (never the key itself)
//!   POST   /          → new key; the response carries the whole key, once
//!   DELETE /:keyId    → revoke: the collector stops accepting it
//!
//! The master `panel_key_registry` row is the source of truth and holds only
//! the key's SHA-256; the collector reads the cache record
//! `panel:key:<hash>` (written here, deleted on revoke). Each record carries
//! the project's status, so pausing, resuming or deleting a project rewrites
//! its keys' records ([`sync_key_records`]).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use weldsuite_catalogs::entity_events::{EventName, PANEL_KEY_CREATED, PANEL_KEY_DELETED};
use weldsuite_db::PgPool;
use weldsuite_kit::{ApiError, Created, List, NoContent, Pagination};
use weldsuite_ports::{Cache, DynCache, PortError};

use crate::projects::{live_project, registry_for};
use crate::registry::{Registry, RegistryError};
use crate::saved::{field, rows, text};
use crate::schemas_gen::CREATE_PANEL_KEY;
use crate::{Caller, PanelState, unexpected};

/// Keys a project may hold at once (revoked ones do not count).
const MAX_ACTIVE_KEYS: usize = 20;

/// `wps_` and the first four hex digits: what the UI shows.
const PREFIX_LENGTH: usize = 8;

/// `sha256Hex(text)`.
pub(crate) fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// `keyKvKey(keyHash)`.
fn key_cache_key(key_hash: &str) -> String {
    format!("panel:key:{key_hash}")
}

/// `generateSecretKey()`.
fn generate_secret_key() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    format!("wps_{}", hex::encode(bytes))
}

/// `toKeyDto(row)`.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "prefix": format!("{}…", text(row, "keyPrefix")),
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
        "lastUsedAt": field(row, "lastUsedAt"),
        "revokedAt": field(row, "revokedAt"),
    })
}

/// `keyEventData(row)`: never the key.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "prefix": format!("{}…", text(row, "keyPrefix")),
    })
}

/// `keyRecord(row, workspaceId, status)`, as written to the cache.
fn key_record(key_id: &str, workspace_id: &str, project_id: &str, status: &str) -> String {
    json!({ "v": 1, "keyId": key_id, "workspaceId": workspace_id, "projectId": project_id, "status": status })
        .to_string()
}

fn publish(caller: &Caller, state: &PanelState, key: &Value, event: EventName) {
    caller.publish(state, event, text(key, "id"), &event_data(key));
}

/// `activeKeys(registry, projectId)`.
async fn active_keys(
    master: &PgPool,
    workspace_id: &str,
    project_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(k) from panel_key_registry k
         where k.workspace_id = $1 and k.project_id = $2 and k.revoked_at is null",
    )
    .bind(workspace_id)
    .bind(project_id)
    .fetch_all(master)
    .await?;
    Ok(rows(found))
}

/// `syncKeyRecords(registry, project, deleted)`: the project's active keys'
/// cache records rewritten with its status, or taken out for a deleted
/// project. Repeating it is harmless.
pub(crate) async fn sync_key_records(
    registry: &Registry,
    project: &Value,
    deleted: bool,
) -> Result<(), RegistryError> {
    let project_id = text(project, "id");
    let status = text(project, "status");
    for key in active_keys(&registry.master, &registry.workspace_id, project_id).await? {
        let cache_key = key_cache_key(text(&key, "keyHash"));
        if deleted {
            registry.cache.delete(&cache_key).await?;
        } else {
            let record = key_record(
                text(&key, "id"),
                &registry.workspace_id,
                text(&key, "projectId"),
                status,
            );
            registry.cache.put(&cache_key, &record, None).await?;
        }
    }
    Ok(())
}

/// What a key route reads: the registry and the live project, or the answer.
async fn prepare(
    caller: &Caller,
    state: &PanelState,
    project_id: &str,
) -> Result<(Registry, Value), Box<Response>> {
    let registry = registry_for(caller, state)?;
    match live_project(caller, project_id).await {
        Ok(Some(project)) => Ok((registry, project)),
        Ok(None) => Err(Box::new(
            ApiError::not_found("Project", Some(project_id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get project"))),
    }
}

/// `GET /`.
pub(crate) async fn list(
    State(state): State<PanelState>,
    caller: Caller,
    Path(project_id): Path<String>,
) -> Response {
    let (registry, _) = match prepare(&caller, &state, &project_id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(k) from panel_key_registry k
         where k.workspace_id = $1 and k.project_id = $2
         order by k.created_at asc, k.id asc",
    )
    .bind(&registry.workspace_id)
    .bind(&project_id)
    .fetch_all(&registry.master)
    .await;
    match found {
        Ok(found) => {
            let keys: Vec<Value> = rows(found).iter().map(dto).collect();
            let count = keys.len() as u64;
            List::new(keys, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list keys"),
    }
}

/// What creating a key can fail with.
enum CreateFailure {
    Limit,
    Database(sqlx::Error),
    Cache(PortError),
}

/// `createKey`: the registry row first, the cache record second; when the
/// cache fails the row is taken out again, so a key the collector cannot
/// see is never shown.
async fn create_key(
    registry: &Registry,
    cache: &Arc<dyn DynCache>,
    project: &Value,
    name: &str,
    user_id: &str,
) -> Result<(Value, String), CreateFailure> {
    let project_id = text(project, "id");
    let active = active_keys(&registry.master, &registry.workspace_id, project_id)
        .await
        .map_err(CreateFailure::Database)?;
    if active.len() >= MAX_ACTIVE_KEYS {
        return Err(CreateFailure::Limit);
    }
    let key = generate_secret_key();
    let key_hash = sha256_hex(&key);
    let row: Value = sqlx::query_scalar(
        "insert into panel_key_registry as k
           (id, key_hash, key_prefix, name, workspace_id, project_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning to_jsonb(k)",
    )
    .bind(weldsuite_kit::id::generate_id("pnk"))
    .bind(&key_hash)
    .bind(&key[..PREFIX_LENGTH])
    .bind(name)
    .bind(&registry.workspace_id)
    .bind(project_id)
    .bind(user_id)
    .fetch_one(&registry.master)
    .await
    .map_err(CreateFailure::Database)?;
    let row = weldsuite_db::js_row(row);
    let record = key_record(
        text(&row, "id"),
        &registry.workspace_id,
        project_id,
        text(project, "status"),
    );
    if let Err(error) = cache.put(&key_cache_key(&key_hash), &record, None).await {
        if let Err(cleanup) = sqlx::query("delete from panel_key_registry where id = $1")
            .bind(text(&row, "id"))
            .execute(&registry.master)
            .await
        {
            tracing::error!(error = %cleanup, "[panel-api] cleanup after a failed key registration");
        }
        return Err(CreateFailure::Cache(error));
    }
    Ok((row, key))
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_KEY, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let (registry, project) = match prepare(&caller, &state, &project_id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let cache = Arc::clone(&registry.cache);
    let name = input.text("name").unwrap_or_default().to_owned();
    match create_key(&registry, &cache, &project, &name, &caller.user_id).await {
        Ok((row, key)) => {
            publish(&caller, &state, &row, PANEL_KEY_CREATED);
            let mut body = dto(&row);
            body["key"] = Value::String(key);
            Created(body).into_response()
        }
        Err(CreateFailure::Limit) => ApiError::conflict(
            "This project has the most secret keys it can hold. Revoke one first.",
        )
        .into_response(),
        Err(CreateFailure::Database(error)) => unexpected(&error, "create key"),
        Err(CreateFailure::Cache(error)) => unexpected(&error, "create key"),
    }
}

/// `revokeKey`: stamps `revokedAt` and deletes the cache record; safe to
/// repeat (the record is deleted again). `None` when the key is not this
/// project's.
async fn revoke_key(
    registry: &Registry,
    project_id: &str,
    key_id: &str,
) -> Result<Option<Value>, RegistryError> {
    let revoked: Option<Value> = sqlx::query_scalar(
        "update panel_key_registry as k set revoked_at = now()
         where k.id = $1 and k.workspace_id = $2 and k.project_id = $3 and k.revoked_at is null
         returning to_jsonb(k)",
    )
    .bind(key_id)
    .bind(&registry.workspace_id)
    .bind(project_id)
    .fetch_optional(&registry.master)
    .await?;
    let row = match revoked {
        Some(row) => Some(row),
        None => {
            sqlx::query_scalar(
                "select to_jsonb(k) from panel_key_registry k
                 where k.id = $1 and k.workspace_id = $2 and k.project_id = $3 limit 1",
            )
            .bind(key_id)
            .bind(&registry.workspace_id)
            .bind(project_id)
            .fetch_optional(&registry.master)
            .await?
        }
    };
    let Some(row) = row.map(weldsuite_db::js_row) else {
        return Ok(None);
    };
    registry
        .cache
        .delete(&key_cache_key(text(&row, "keyHash")))
        .await?;
    Ok(Some(row))
}

/// `DELETE /:keyId`.
pub(crate) async fn revoke(
    State(state): State<PanelState>,
    caller: Caller,
    Path((project_id, key_id)): Path<(String, String)>,
) -> Response {
    let (registry, _) = match prepare(&caller, &state, &project_id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match revoke_key(&registry, &project_id, &key_id).await {
        Ok(Some(key)) => {
            publish(&caller, &state, &key, PANEL_KEY_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Key", Some(&key_id)).into_response(),
        Err(error) => unexpected(&error, "revoke key"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_wps_and_32_hex() {
        let key = generate_secret_key();
        assert_eq!(key.len(), 36);
        assert!(key.starts_with("wps_"));
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
