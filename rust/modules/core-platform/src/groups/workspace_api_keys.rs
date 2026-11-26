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
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::Value;
use weldsuite_auth::{StepUp, StepUpGuard};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::{ApiError, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workspace_api_keys;

use super::api_keys::{
    CreateKey, GeneratedKey, created_key, expires_at, generate_api_key, key_json, org_of,
    read_create, read_update, register_api_key, safe_key, scopes_json, unregister_api_key,
};
use crate::{Caller, CorePlatformState, PlatformError, answer, validate};

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

/// A live key of the workspace, as `to_jsonb` through `js_row` read it.
async fn live_key(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workspace_api_keys::Entity::find()
        .filter(workspace_api_keys::Column::Id.eq(id))
        .filter(workspace_api_keys::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    Ok(row.map(key_json))
}

/// `insert into workspace_api_keys …`: the minted key's row; `expiresAt` is
/// read by Postgres as before.
async fn insert_key(
    caller: &Caller,
    id: &str,
    data: &CreateKey,
    minted: &GeneratedKey,
) -> Result<(), DbErr> {
    use workspace_api_keys::Column;
    let at = utc_now().assume_utc();
    let mut insert = Query::insert();
    insert
        .into_table(workspace_api_keys::Entity)
        .columns([
            Column::Id,
            Column::Name,
            Column::Description,
            Column::KeyHash,
            Column::KeyPrefix,
            Column::Scopes,
            Column::ExpiresAt,
            Column::CreatedBy,
            Column::CreatedAt,
            Column::UpdatedAt,
        ])
        .values([
            Expr::value(id.to_owned()),
            Expr::value(data.name.clone()),
            Expr::value(data.description.clone()),
            Expr::value(minted.hash.clone()),
            Expr::value(minted.prefix.clone()),
            Expr::value(scopes_json(&data.scopes)),
            expires_at(data.expires_at.as_deref()),
            Expr::value(caller.user_id.clone()),
            Expr::value(at),
            Expr::value(at),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    orm(&caller.db).execute(&insert).await?;
    Ok(())
}

/// `GET /`: the workspace's live keys, newest first. Not paginated.
async fn list(caller: Caller) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let rows = workspace_api_keys::Entity::find()
                .filter(workspace_api_keys::Column::DeletedAt.is_null())
                .order_by_desc(workspace_api_keys::Column::CreatedAt)
                .all(&orm(&caller.db))
                .await
                .map_err(|e| PlatformError::internal("Failed to fetch workspace API keys", e))?;
            let keys: Vec<Value> = rows
                .into_iter()
                .map(|row| safe_key(&key_json(row), true))
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
    step_up: StepUpGuard,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, read_create)?;
            let org = org_of(&caller)?;
            step_up.require(StepUp::Recent)?;
            let minted = generate_api_key()
                .ok_or_else(|| PlatformError::internal(CREATE_FAILED, "no random"))?;
            let id = generate_id("wak");
            insert_key(&caller, &id, &data, &minted)
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
    step_up: StepUpGuard,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, read_update)?;
            org_of(&caller)?;
            let failed = |e: DbErr| PlatformError::internal(UPDATE_FAILED, e);
            if live_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            step_up.require(StepUp::Recent)?;
            let db = orm(&caller.db);
            let mut update = workspace_api_keys::Entity::update_many().col_expr(
                workspace_api_keys::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            );
            if let Some(name) = &data.name {
                update =
                    update.col_expr(workspace_api_keys::Column::Name, Expr::value(name.clone()));
            }
            if let Some(description) = &data.description {
                update = update.col_expr(
                    workspace_api_keys::Column::Description,
                    Expr::value(description.clone()),
                );
            }
            if let Some(scopes) = &data.scopes {
                update = update.col_expr(
                    workspace_api_keys::Column::Scopes,
                    Expr::value(scopes_json(scopes)),
                );
            }
            update
                .filter(workspace_api_keys::Column::Id.eq(&id))
                .exec(&db)
                .await
                .map_err(failed)?;
            let updated = workspace_api_keys::Entity::find_by_id(id.clone())
                .one(&db)
                .await
                .map_err(failed)?;
            let updated = updated.ok_or_else(|| PlatformError::internal(UPDATE_FAILED, "gone"))?;
            Ok(Data(safe_key(&key_json(updated), true)).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`: soft-delete the key and drop its registry row.
async fn revoke(
    State(state): State<CorePlatformState>,
    caller: Caller,
    step_up: StepUpGuard,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let failed = |e: DbErr| PlatformError::internal(REVOKE_FAILED, e);
            if live_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            step_up.require(StepUp::Recent)?;
            let at = utc_now().assume_utc();
            workspace_api_keys::Entity::update_many()
                .col_expr(workspace_api_keys::Column::DeletedAt, Expr::value(at))
                .col_expr(workspace_api_keys::Column::UpdatedAt, Expr::value(at))
                .filter(workspace_api_keys::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
                .await
                .map_err(failed)?;
            unregister_api_key(&caller.master(&state), &id).await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}
