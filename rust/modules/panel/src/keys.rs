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
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use weldsuite_catalogs::entity_events::{EventName, PANEL_KEY_CREATED, PANEL_KEY_DELETED};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Created, List, NoContent, Pagination};
use weldsuite_ports::{Cache, DynCache, PortError};
use weldsuite_schema::master::panel_key_registry as key_registry;

use crate::projects::{live_project, registry_for};
use crate::registry::{Registry, RegistryError};
use crate::saved::{field, js_row, text};
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
) -> Result<Vec<key_registry::Model>, DbErr> {
    key_registry::Entity::find()
        .filter(key_registry::Column::WorkspaceId.eq(workspace_id))
        .filter(key_registry::Column::ProjectId.eq(project_id))
        .filter(key_registry::Column::RevokedAt.is_null())
        .all(&orm(master))
        .await
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
        let cache_key = key_cache_key(&key.key_hash);
        if deleted {
            registry.cache.delete(&cache_key).await?;
        } else {
            let record = key_record(&key.id, &registry.workspace_id, &key.project_id, status);
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
    let found = key_registry::Entity::find()
        .filter(key_registry::Column::WorkspaceId.eq(&registry.workspace_id))
        .filter(key_registry::Column::ProjectId.eq(&project_id))
        .order_by_asc(key_registry::Column::CreatedAt)
        .order_by_asc(key_registry::Column::Id)
        .all(&orm(&registry.master))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match found {
        Ok(found) => {
            let keys: Vec<Value> = found.iter().map(dto).collect();
            let count = keys.len() as u64;
            List::new(keys, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list keys"),
    }
}

/// What creating a key can fail with.
enum CreateFailure {
    Limit,
    Database(DbErr),
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
    let row = key_registry::Entity::insert(key_registry::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnk")),
        key_hash: Set(key_hash.clone()),
        key_prefix: Set(key[..PREFIX_LENGTH].to_owned()),
        name: Set(name.to_owned()),
        workspace_id: Set(registry.workspace_id.clone()),
        project_id: Set(project_id.to_owned()),
        created_by_user_id: Set(user_id.to_owned()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&registry.master))
    .await
    .and_then(js_row)
    .map_err(CreateFailure::Database)?;
    let record = key_record(
        text(&row, "id"),
        &registry.workspace_id,
        project_id,
        text(project, "status"),
    );
    if let Err(error) = cache.put(&key_cache_key(&key_hash), &record, None).await {
        if let Err(cleanup) = key_registry::Entity::delete_by_id(text(&row, "id"))
            .exec(&orm(&registry.master))
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
    let master = orm(&registry.master);
    let revoked = key_registry::Entity::update_many()
        .col_expr(key_registry::Column::RevokedAt, Expr::current_timestamp())
        .filter(key_registry::Column::Id.eq(key_id))
        .filter(key_registry::Column::WorkspaceId.eq(&registry.workspace_id))
        .filter(key_registry::Column::ProjectId.eq(project_id))
        .filter(key_registry::Column::RevokedAt.is_null())
        .exec_with_returning(&master)
        .await?
        .into_iter()
        .next();
    let row = match revoked {
        Some(row) => Some(row),
        None => {
            key_registry::Entity::find_by_id(key_id)
                .filter(key_registry::Column::WorkspaceId.eq(&registry.workspace_id))
                .filter(key_registry::Column::ProjectId.eq(project_id))
                .one(&master)
                .await?
        }
    };
    let Some(row) = row.map(js_row).transpose()? else {
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
