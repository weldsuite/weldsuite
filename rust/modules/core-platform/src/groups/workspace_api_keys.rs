//! `/api/workspace-api-keys` (`app-api/src/routes/workspace-api-keys`): the
//! workspace's shared API keys, in the tenant `workspace_api_keys` table.
//!
//! A different table from the personal keys: `created_by` records who minted
//! a key, it is no ownership filter. Gated per method as the workers are:
//! `apikeys:read`, `apikeys:create`, `apikeys:update` (not in the permission
//! catalog, so only a wildcard holds it: kept as the workers have it) and
//! `apikeys:delete`. Minting and revoking pair with the master
//! `api_key_registry` like the personal keys. No entity events.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::HeaderMap;
use serde_json::Value;
use weldsuite_db::js_row;
use weldsuite_kit::{ApiError, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::api_keys::{
    created_key, generate_api_key, org_of, read_create, read_update, register_api_key, safe_key,
    scopes_json, unregister_api_key,
};
use crate::{Caller, CorePlatformState, PlatformError, answer, now, validate};

const RESOURCE: &str = "Workspace API key";
const CREATE_FAILED: &str = "Failed to create workspace API key";
const UPDATE_FAILED: &str = "Failed to update workspace API key";
const REVOKE_FAILED: &str = "Failed to revoke workspace API key";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("apikeys:read")))
        .route("/", post(create).route_layer(need("apikeys:create")))
        .route("/{id}", get(detail).route_layer(need("apikeys:read")))
        .route("/{id}", put(update).route_layer(need("apikeys:update")))
        .route("/{id}", delete(revoke).route_layer(need("apikeys:delete")))
}

/// A live key of the workspace, as `to_jsonb` through [`js_row`].
async fn live_key(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(k) from workspace_api_keys k
         where k.id = $1 and k.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

/// `GET /`: the workspace's live keys, newest first. Not paginated.
async fn list(caller: Caller) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let rows: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(k) from workspace_api_keys k
                 where k.deleted_at is null
                 order by k.created_at desc",
            )
            .fetch_all(&caller.db)
            .await
            .map_err(|e| PlatformError::internal("Failed to fetch workspace API keys", e))?;
            let keys: Vec<Value> = rows
                .into_iter()
                .map(|row| safe_key(&js_row(row), true))
                .collect();
            Ok(Data(keys).into_response())
        }
        .await,
    )
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let row = live_key(&caller, &id)
                .await
                .map_err(|e| PlatformError::internal("Failed to fetch workspace API key", e))?;
            match row {
                Some(row) => Ok(Data(safe_key(&row, true)).into_response()),
                None => Err(ApiError::not_found(RESOURCE, Some(&id)).into()),
            }
        }
        .await,
    )
}

/// `POST /`: mint a key; the plaintext is returned here and only here.
async fn create(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, read_create)?;
            let org = org_of(&caller)?;
            let minted = generate_api_key()
                .ok_or_else(|| PlatformError::internal(CREATE_FAILED, "no random"))?;
            let id = generate_id("wak");
            sqlx::query(
                "insert into workspace_api_keys
                   (id, name, description, key_hash, key_prefix, scopes, expires_at, created_by,
                    created_at, updated_at)
                 values ($1, $2, $3, $4, $5, $6::jsonb,
                         date_trunc('milliseconds', $7::timestamptz), $8,
                         $9::timestamptz, $9::timestamptz)",
            )
            .bind(&id)
            .bind(&data.name)
            .bind(&data.description)
            .bind(&minted.hash)
            .bind(&minted.prefix)
            .bind(scopes_json(&data.scopes))
            .bind(&data.expires_at)
            .bind(&caller.user_id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(|e| PlatformError::internal(CREATE_FAILED, e))?;
            register_api_key(&caller.master(&state), &org, &minted.hash, "workspace", &id).await;
            Ok(created_key(&id, &data, &minted))
        }
        .await,
    )
}

/// `PUT /:id`: rename or re-scope (PUT, as the settings UI calls it).
async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, read_update)?;
            org_of(&caller)?;
            let failed = |e: sqlx::Error| PlatformError::internal(UPDATE_FAILED, e);
            if live_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            sqlx::query(
                "update workspace_api_keys set
                   updated_at = $2::timestamptz,
                   name = case when $3 then $4 else name end,
                   description = case when $5 then $6 else description end,
                   scopes = case when $7 then $8::jsonb else scopes end
                 where id = $1",
            )
            .bind(&id)
            .bind(now())
            .bind(data.name.is_some())
            .bind(&data.name)
            .bind(data.description.is_some())
            .bind(&data.description)
            .bind(data.scopes.is_some())
            .bind(data.scopes.as_deref().map(scopes_json))
            .execute(&caller.db)
            .await
            .map_err(failed)?;
            let updated: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(k) from workspace_api_keys k where k.id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await
            .map_err(failed)?;
            let updated = updated.ok_or_else(|| PlatformError::internal(UPDATE_FAILED, "gone"))?;
            Ok(Data(safe_key(&js_row(updated), true)).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`: soft-delete the key and drop its registry row.
async fn revoke(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let failed = |e: sqlx::Error| PlatformError::internal(REVOKE_FAILED, e);
            if live_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            sqlx::query(
                "update workspace_api_keys
                 set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(failed)?;
            unregister_api_key(&caller.master(&state), &id).await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}
