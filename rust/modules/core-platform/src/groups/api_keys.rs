//! `/api/api-keys` (`app-api/src/routes/api-keys`): the caller's own personal
//! API keys, in the tenant `api_keys` table.
//!
//! Ungated on purpose: any member manages their own credentials, and every
//! query is scoped by the caller's user id, never by one from the request.
//! Minting a key also writes the master `api_key_registry`, which external-api
//! authenticates against, and revoking drops that row; both registry writes
//! are best effort (`services/api-keys.ts`). No entity events: credentials are
//! infrastructure, and the catalog has no `api_key` entity type.
//!
//! The key material, the body readers and the registry writes are shared with
//! `/api/workspace-api-keys`.

use std::sync::Arc;

use aws_lc_rs::{digest, rand};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::{api_key_registry, workspaces};
use weldsuite_schema::tenant::api_keys;

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(detail).patch(update).delete(revoke))
}

// ── shared with /api/workspace-api-keys ─────────────────────────────────────

/// A freshly minted key (`generateApiKey`).
pub(crate) struct GeneratedKey {
    /// `wsk_` and 64 hex characters: shown to the caller once, never stored.
    pub(crate) key: String,
    /// SHA-256 of `key`, hex: what both databases store.
    pub(crate) hash: String,
    /// `wsk_` and the key's first 8 hex characters, for lists.
    pub(crate) prefix: String,
}

/// Lowercase hex, as the workers write bytes.
fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// `generateApiKey()`: 32 random bytes as hex behind `wsk_`, its SHA-256 as
/// hex, and `wsk_` plus the first 8 hex characters. Byte for byte the
/// workers' algorithm: changing it would invalidate every issued key.
pub(crate) fn generate_api_key() -> Option<GeneratedKey> {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes).ok()?;
    let key = format!("wsk_{}", to_hex(&bytes));
    let hash = to_hex(digest::digest(&digest::SHA256, key.as_bytes()).as_ref());
    let prefix = format!("wsk_{}", &key[4..12]);
    Some(GeneratedKey { key, hash, prefix })
}

/// `createApiKeyInput` / `createWorkspaceApiKeyInput`.
pub(crate) struct CreateKey {
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    /// `data.scopes || []`.
    pub(crate) scopes: Vec<String>,
    pub(crate) expires_at: Option<String>,
}

/// `updateApiKeyInput` / `updateWorkspaceApiKeyInput`: absent fields stay.
pub(crate) struct UpdateKey {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) scopes: Option<Vec<String>>,
}

/// `z.array(z.string()).optional()`.
fn scopes(issues: &mut Issues, body: &Map<String, Value>) -> Field<Vec<String>> {
    issues.list(
        body,
        "scopes",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    )
}

pub(crate) fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> CreateKey {
    let from = issues.count();
    let name = issues.text(body, "name", Presence::Required, Some(1), Some(100));
    issues.custom_message(from, "too_small", "Name is required");
    let description = issues.text(body, "description", Presence::Optional, None, None);
    let scopes = scopes(issues, body);
    let expires_at = issues.text_with(
        body,
        "expiresAt",
        Presence::Optional,
        Text {
            format: Some(Format::Datetime),
            ..Text::default()
        },
    );
    CreateKey {
        name: name.into_option().unwrap_or_default(),
        description: description.into_option(),
        scopes: scopes.into_option().unwrap_or_default(),
        expires_at: expires_at.into_option(),
    }
}

pub(crate) fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> UpdateKey {
    let name = issues.text(body, "name", Presence::Optional, Some(1), Some(100));
    let description = issues.text(body, "description", Presence::Optional, None, None);
    let scopes = scopes(issues, body);
    UpdateKey {
        name: name.into_option(),
        description: description.into_option(),
        scopes: scopes.into_option(),
    }
}

/// The scopes as the `jsonb` column stores them (`JSON.stringify(scopes)`).
pub(crate) fn scopes_json(scopes: &[String]) -> Value {
    Value::from(scopes.to_vec())
}

/// `date_trunc('milliseconds', $n::timestamptz)`: the body's `expiresAt` as
/// Postgres reads the ISO text, to the millisecond as Drizzle writes a
/// `Date` (null without one).
pub(crate) fn expires_at(text: Option<&str>) -> Expr {
    let at = sea_orm::ExprTrait::cast_as(Expr::value(text.map(str::to_owned)), "timestamptz");
    Func::cust("date_trunc").arg("milliseconds").arg(at).into()
}

/// A key row as `to_jsonb` through `js_row` read it: the entity serializes
/// as Drizzle did.
pub(crate) fn key_json(row: impl serde::Serialize) -> Value {
    serde_json::to_value(row).unwrap_or(Value::Null)
}

/// `toSafeKey(row)`: the row without `keyHash`; the timestamps are left out
/// when null (`?.toISOString()` is `undefined`), and `createdBy` is there for
/// the workspace keys only.
pub(crate) fn safe_key(row: &Value, with_creator: bool) -> Value {
    let mut out = Map::new();
    for key in ["id", "name", "description", "keyPrefix", "scopes"] {
        out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
    }
    for key in ["lastUsedAt", "expiresAt", "createdAt"] {
        if let Some(value) = row.get(key).filter(|value| !value.is_null()) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    if with_creator {
        out.insert(
            "createdBy".to_owned(),
            row.get("createdBy").cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(out)
}

/// The create answer: the one time the full key is returned.
pub(crate) fn created_key(id: &str, data: &CreateKey, minted: &GeneratedKey) -> Response {
    let mut body = json!({
        "id": id,
        "name": data.name,
        "keyPrefix": minted.prefix,
        "scopes": data.scopes,
        "key": minted.key,
    });
    if let Some(description) = &data.description {
        body["description"] = Value::String(description.clone());
    }
    Created(body).into_response()
}

/// `registerApiKey`: index a minted key in the master `api_key_registry`,
/// under the workspace the org resolves to (`matchWorkspaceRef`). Best
/// effort: a key the caller has already been shown is never rolled back.
pub(crate) async fn register_api_key(
    master: &PgPool,
    org_ref: &str,
    key_hash: &str,
    key_type: &str,
    tenant_key_id: &str,
) {
    let db = orm(master);
    let workspace: Result<Option<String>, DbErr> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(org_ref))
                .add(workspaces::Column::ClerkOrgId.eq(org_ref)),
        )
        .into_tuple()
        .one(&db)
        .await;
    let workspace_id = match workspace {
        Ok(Some(id)) => id,
        Ok(None) => {
            tracing::error!(
                org_ref,
                key_type,
                tenant_key_id,
                "api keys: no master workspace for the org; the key will not authenticate"
            );
            return;
        }
        Err(error) => {
            tracing::error!(%error, "api keys: failed to write the key to the master registry");
            return;
        }
    };
    let entry = api_key_registry::ActiveModel {
        id: Set(generate_id("akr")),
        key_hash: Set(key_hash.to_owned()),
        key_type: Set(key_type.to_owned()),
        workspace_id: Set(workspace_id),
        tenant_key_id: Set(tenant_key_id.to_owned()),
        created_at: Set(utc_now()),
    };
    if let Err(error) = api_key_registry::Entity::insert(entry)
        .exec_without_returning(&db)
        .await
    {
        tracing::error!(%error, "api keys: failed to write the key to the master registry");
    }
}

/// `unregisterApiKey`: drop a revoked key from the registry. Best effort.
pub(crate) async fn unregister_api_key(master: &PgPool, tenant_key_id: &str) {
    if let Err(error) = api_key_registry::Entity::delete_many()
        .filter(api_key_registry::Column::TenantKeyId.eq(tenant_key_id))
        .exec(&orm(master))
        .await
    {
        tracing::error!(%error, "api keys: failed to remove the key from the master registry");
    }
}

/// `c.get('orgId')` when set (`if (!orgId) return error.orgRequired(c)`).
pub(crate) fn org_of(caller: &Caller) -> PlatformResult<String> {
    caller
        .org_id
        .clone()
        .filter(|org| !org.is_empty())
        .ok_or_else(|| PlatformError::api(ApiError::org_required()))
}

// ── the personal keys ───────────────────────────────────────────────────────

const RESOURCE: &str = "API key";
const CREATE_FAILED: &str = "Failed to create API key";
const UPDATE_FAILED: &str = "Failed to update API key";
const REVOKE_FAILED: &str = "Failed to revoke API key";

/// The caller's live key, as `to_jsonb` through `js_row` read it.
async fn own_key(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = api_keys::Entity::find()
        .filter(api_keys::Column::Id.eq(id))
        .filter(api_keys::Column::UserId.eq(&caller.user_id))
        .filter(api_keys::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    Ok(row.map(key_json))
}

/// `GET /`: the caller's live keys, newest first. Not paginated.
async fn list(caller: Caller) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let rows = api_keys::Entity::find()
                .filter(api_keys::Column::UserId.eq(&caller.user_id))
                .filter(api_keys::Column::DeletedAt.is_null())
                .order_by_desc(api_keys::Column::CreatedAt)
                .all(&orm(&caller.db))
                .await
                .map_err(|e| PlatformError::internal("Failed to fetch API keys", e))?;
            let keys: Vec<Value> = rows
                .into_iter()
                .map(|row| safe_key(&key_json(row), false))
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
            let row = own_key(&caller, &id)
                .await
                .map_err(|e| PlatformError::internal("Failed to fetch API key", e))?;
            match row {
                Some(row) => Ok(Data(safe_key(&row, false)).into_response()),
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
            let id = generate_id("ak");
            insert_key(&caller, &id, &data, &minted)
                .await
                .map_err(|e| PlatformError::internal(CREATE_FAILED, e))?;
            register_api_key(&caller.master(&state), &org, &minted.hash, "personal", &id).await;
            Ok(created_key(&id, &data, &minted))
        }
        .await,
    )
}

/// `insert into api_keys …`: the minted key's row; `expiresAt` is read by
/// Postgres as before.
async fn insert_key(
    caller: &Caller,
    id: &str,
    data: &CreateKey,
    minted: &GeneratedKey,
) -> Result<(), DbErr> {
    use api_keys::Column;
    let at = utc_now().assume_utc();
    let mut insert = Query::insert();
    insert
        .into_table(api_keys::Entity)
        .columns([
            Column::Id,
            Column::UserId,
            Column::Name,
            Column::Description,
            Column::KeyHash,
            Column::KeyPrefix,
            Column::Scopes,
            Column::ExpiresAt,
            Column::CreatedAt,
            Column::UpdatedAt,
        ])
        .values([
            Expr::value(id.to_owned()),
            Expr::value(caller.user_id.clone()),
            Expr::value(data.name.clone()),
            Expr::value(data.description.clone()),
            Expr::value(minted.hash.clone()),
            Expr::value(minted.prefix.clone()),
            Expr::value(scopes_json(&data.scopes)),
            expires_at(data.expires_at.as_deref()),
            Expr::value(at),
            Expr::value(at),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    orm(&caller.db).execute(&insert).await?;
    Ok(())
}

/// `PATCH /:id`: rename or re-scope; the key material never changes.
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
            let failed = |e: DbErr| PlatformError::internal(UPDATE_FAILED, e);
            if own_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            let db = orm(&caller.db);
            let mut update = api_keys::Entity::update_many().col_expr(
                api_keys::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            );
            if let Some(name) = &data.name {
                update = update.col_expr(api_keys::Column::Name, Expr::value(name.clone()));
            }
            if let Some(description) = &data.description {
                update = update.col_expr(
                    api_keys::Column::Description,
                    Expr::value(description.clone()),
                );
            }
            if let Some(scopes) = &data.scopes {
                update = update.col_expr(api_keys::Column::Scopes, Expr::value(scopes_json(scopes)));
            }
            update
                .filter(api_keys::Column::Id.eq(&id))
                .filter(api_keys::Column::UserId.eq(&caller.user_id))
                .exec(&db)
                .await
                .map_err(failed)?;
            let updated = api_keys::Entity::find_by_id(id.clone())
                .one(&db)
                .await
                .map_err(failed)?;
            let updated = updated.ok_or_else(|| PlatformError::internal(UPDATE_FAILED, "gone"))?;
            Ok(Data(safe_key(&key_json(updated), false)).into_response())
        }
        .await,
    )
}

/// `DELETE /:id`: soft-delete the key and drop its registry row, so it stops
/// authenticating against external-api.
async fn revoke(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            org_of(&caller)?;
            let failed = |e: DbErr| PlatformError::internal(REVOKE_FAILED, e);
            if own_key(&caller, &id).await.map_err(failed)?.is_none() {
                return Err(ApiError::not_found(RESOURCE, Some(&id)).into());
            }
            let at = utc_now().assume_utc();
            api_keys::Entity::update_many()
                .col_expr(api_keys::Column::DeletedAt, Expr::value(at))
                .col_expr(api_keys::Column::UpdatedAt, Expr::value(at))
                .filter(api_keys::Column::Id.eq(&id))
                .filter(api_keys::Column::UserId.eq(&caller.user_id))
                .exec(&orm(&caller.db))
                .await
                .map_err(failed)?;
            unregister_api_key(&caller.master(&state), &id).await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn keys_look_like_the_workers_keys() {
        let minted = generate_api_key().expect("a random source");
        assert_eq!(minted.key.len(), 68);
        assert!(minted.key.starts_with("wsk_"));
        assert!(minted.key[4..].bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(minted.prefix, minted.key[..12]);
        assert_eq!(minted.hash.len(), 64);
        // sha256("wsk_test"), as `crypto.subtle.digest` hex-encodes it.
        assert_eq!(
            to_hex(digest::digest(&digest::SHA256, b"wsk_test").as_ref()),
            "96bd8628b2fcba7f44b5644b86af4b667d72f3c61ce779df100bf4a9515a4d87"
        );
    }

    #[test]
    fn safe_keys_leave_out_null_timestamps_and_the_hash() {
        let row = json!({
            "id": "ak_1", "name": "CI", "description": null, "keyPrefix": "wsk_0011aabb",
            "keyHash": "secret", "scopes": ["crm:read"], "lastUsedAt": null,
            "expiresAt": "2030-01-01T00:00:00.000Z", "createdAt": "2026-01-01T00:00:00.000Z",
            "createdBy": "user_1",
        });
        assert_eq!(
            safe_key(&row, false),
            json!({
                "id": "ak_1", "name": "CI", "description": null, "keyPrefix": "wsk_0011aabb",
                "scopes": ["crm:read"], "expiresAt": "2030-01-01T00:00:00.000Z",
                "createdAt": "2026-01-01T00:00:00.000Z",
            })
        );
        assert_eq!(safe_key(&row, true)["createdBy"], "user_1");
    }
}
