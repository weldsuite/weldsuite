//! `/v1/app-storage` (`routes/v1/app-storage.ts`): WeldApps' own storage in
//! the workspace's tenant database, records in collections (`app_records`)
//! and key-value pairs (`app_kv`), namespaced by the app's code.
//!
//! No scope gate on the routes: an app token addresses its own app; a
//! workspace or personal key names the app in `X-App-Code` and needs
//! `user-apps:manage` and an active install of that app. The body or query
//! is validated first (`zValidator` runs before the handler), then the app
//! is resolved, then the collection name or key is checked.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::ApiError;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Issues, Number, Presence, json_body, query_values};
use weldsuite_ports::DynCache;

use crate::list::{ListQuery, clamp_limit, list_page, list_sql};
use crate::session::{
    ApiSession, Key, KeyType, bad_request, database_error, forbidden, internal_with, not_found,
};
use crate::{ExternalApiState, RequestApiCache, master_db};

const KV_KEY_MAX_LENGTH: usize = 255;
const DEFAULT_RECORD_LIMIT: f64 = 25.0;
/// The active-install lookup's lifetime: short, so an uninstall bites fast.
const INSTALL_CACHE_TTL: Duration = Duration::from_secs(60);

const RECORDS: (&str, &str) = list_sql!(
    "app_records",
    "to_jsonb(t)",
    "t.deleted_at is null and t.app_code = $3->>'appCode' and t.collection = $3->>'collection' \
     and ($3->'filter' is null or t.data @> ($3->'filter'))"
);

/// The cached `uai:` entry (`CachedActiveInstall`).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveInstall {
    app_id: String,
    install_id: String,
}

/// What every route needs: the key, the cache and the master database.
pub(crate) struct Storage {
    key: Key,
    cache: Option<Arc<dyn DynCache>>,
    master: PgPool,
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Storage
where
    ExternalApiState: axum::extract::FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let shared = <ExternalApiState as axum::extract::FromRef<S>>::from_ref(state);
        // The worker reads the session unguarded: without one it throws (500).
        let key = Key::from_request_parts(parts, state)
            .await
            .map_err(|_| crate::session::internal())?;
        let cache = match parts.extensions.get::<RequestApiCache>() {
            Some(RequestApiCache(cache)) => cache.clone(),
            None => shared.cache.clone(),
        };
        let master = master_db(&shared, &parts.extensions);
        Ok(Self { key, cache, master })
    }
}

/// `resolveAppCode`: the app the request addresses.
async fn resolve_app_code(storage: &Storage, headers: &HeaderMap) -> Result<String, ApiError> {
    let session: &ApiSession = &storage.key.session;
    if session.key_type == KeyType::App
        && let Some(code) = session.app_code.as_deref().filter(|code| !code.is_empty())
    {
        return Ok(code.to_owned());
    }
    let app_code = headers
        .get("x-app-code")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            bad_request(
                "X-App-Code header is required when accessing app storage with a workspace or personal API key",
            )
        })?;
    if !session.has_scope("user-apps:manage") {
        return Err(forbidden("Missing required scope: user-apps:manage"));
    }
    if active_install(storage, &session.workspace_id, app_code)
        .await?
        .is_none()
    {
        return Err(not_found("Installed app", app_code));
    }
    Ok(app_code.to_owned())
}

/// `getActiveInstall`: the workspace's active install of the app, cached
/// for 60 seconds.
async fn active_install(
    storage: &Storage,
    workspace_id: &str,
    app_code: &str,
) -> Result<Option<ActiveInstall>, ApiError> {
    let cache_key = format!("uai:{workspace_id}:{app_code}");
    if let Some(cache) = &storage.cache
        && let Ok(Some(raw)) = cache.get_boxed(&cache_key).await
        && let Ok(cached) = serde_json::from_str::<ActiveInstall>(&raw)
    {
        return Ok(Some(cached));
    }
    let row: Option<(String, String)> = sqlx::query_as(
        "select a.id, i.id from user_app_installs i
           join user_apps a on a.id = i.app_id
          where a.code = $1 and i.workspace_id = $2 and i.status = 'active'
            and a.is_active = true and a.deleted_at is null
          limit 1",
    )
    .bind(app_code)
    .bind(workspace_id)
    .fetch_optional(&storage.master)
    .await
    .map_err(|error| database_error(&error))?;
    let Some((app_id, install_id)) = row else {
        return Ok(None);
    };
    let install = ActiveInstall { app_id, install_id };
    if let (Some(cache), Ok(raw)) = (&storage.cache, serde_json::to_string(&install))
        && let Err(error) = cache
            .put_boxed(&cache_key, &raw, Some(INSTALL_CACHE_TTL))
            .await
    {
        tracing::warn!(%error, "external-api: install cache write failed");
    }
    Ok(Some(install))
}

/// `COLLECTION_NAME_RE`: `^[a-z][a-z0-9_-]{0,99}$`.
fn is_collection_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= 100
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn check_collection(collection: &str) -> Result<(), ApiError> {
    if is_collection_name(collection) {
        Ok(())
    } else {
        Err(bad_request(
            "Invalid collection name — lowercase letters, digits, dashes and underscores, starting with a letter (max 100 chars)",
        ))
    }
}

fn check_key(key: &str) -> Result<(), ApiError> {
    // JavaScript string length: UTF-16 units.
    if key.encode_utf16().count() > KV_KEY_MAX_LENGTH {
        return Err(bad_request(format!(
            "Key must be at most {KV_KEY_MAX_LENGTH} characters"
        )));
    }
    Ok(())
}

/// `{ data: z.record(z.unknown()) }` (create and update alike).
fn read_record_body(headers: &HeaderMap, body: &Bytes) -> Result<Map<String, Value>, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let data = issues.object(&body).map(|fields| {
        issues
            .nested(fields, "data", Presence::Required, |_, data| data.clone())
            .into_option()
    });
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(data.flatten().unwrap_or_default())
}

fn respond(result: Result<Response, ApiError>) -> Response {
    result.unwrap_or_else(IntoResponse::into_response)
}

/// `GET /collections/:collection/records`.
pub(crate) async fn list_records(
    storage: Storage,
    headers: HeaderMap,
    Path(collection): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    // `appRecordListQuerySchema`: limit, cursor, filter.
    let fields = query_values(raw.as_deref());
    let mut issues = Issues::default();
    let limit = issues
        .number(
            &fields,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        )
        .into_option();
    let cursor = issues
        .text(&fields, "cursor", Presence::Optional, None, None)
        .into_option();
    let filter = issues
        .text(&fields, "filter", Presence::Optional, None, None)
        .into_option();
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_collection(&collection)?;
            let mut filters = json!({ "appCode": app_code, "collection": collection });
            if let Some(filter) = filter.as_deref().filter(|filter| !filter.is_empty()) {
                let parsed: Value = serde_json::from_str(filter)
                    .map_err(|_| bad_request("filter must be a valid JSON string"))?;
                filters["filter"] = parsed;
            }
            let query = ListQuery {
                cursor,
                limit: clamp_limit(Some(limit.unwrap_or(DEFAULT_RECORD_LIMIT))),
                fields: Map::new(),
            };
            list_page(&storage.key.db, RECORDS, &query, &filters).await
        }
        .await,
    )
}

/// `POST /collections/:collection/records`.
pub(crate) async fn create_record(
    storage: Storage,
    headers: HeaderMap,
    Path(collection): Path<String>,
    body: Bytes,
) -> Response {
    let data = match read_record_body(&headers, &body) {
        Ok(data) => data,
        Err(response) => return response,
    };
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_collection(&collection)?;
            let now = iso_timestamp(OffsetDateTime::now_utc());
            let row: Option<Value> = sqlx::query_scalar(
                "insert into app_records (id, app_code, collection, data, created_by, created_at, updated_at)
                 values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)
                 returning to_jsonb(app_records)",
            )
            .bind(generate_id("arec"))
            .bind(&app_code)
            .bind(&collection)
            .bind(Value::Object(data))
            .bind(&storage.key.session.key_id)
            .bind(&now)
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            let row = row.ok_or_else(|| internal_with("Failed to create record"))?;
            Ok((StatusCode::CREATED, Json(json!({ "data": js_row(row) }))).into_response())
        }
        .await,
    )
}

/// `GET /collections/:collection/records/:id`.
pub(crate) async fn get_record(
    storage: Storage,
    headers: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
) -> Response {
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_collection(&collection)?;
            let row: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(r) from app_records r
                  where r.id = $1 and r.app_code = $2 and r.collection = $3 and r.deleted_at is null
                  limit 1",
            )
            .bind(&id)
            .bind(&app_code)
            .bind(&collection)
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            let row = row.ok_or_else(|| not_found("Record", &id))?;
            Ok(Json(json!({ "data": js_row(row) })).into_response())
        }
        .await,
    )
}

/// `PATCH /collections/:collection/records/:id`: replaces `data`; the key
/// that wrote it becomes `createdBy`, as in the worker.
pub(crate) async fn update_record(
    storage: Storage,
    headers: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let data = match read_record_body(&headers, &body) {
        Ok(data) => data,
        Err(response) => return response,
    };
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_collection(&collection)?;
            let row: Option<Value> = sqlx::query_scalar(
                "update app_records set data = $4, created_by = $5, updated_at = $6::timestamptz
                  where id = $1 and app_code = $2 and collection = $3 and deleted_at is null
                 returning to_jsonb(app_records)",
            )
            .bind(&id)
            .bind(&app_code)
            .bind(&collection)
            .bind(Value::Object(data))
            .bind(&storage.key.session.key_id)
            .bind(iso_timestamp(OffsetDateTime::now_utc()))
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            let row = row.ok_or_else(|| not_found("Record", &id))?;
            Ok(Json(json!({ "data": js_row(row) })).into_response())
        }
        .await,
    )
}

/// `DELETE /collections/:collection/records/:id`: a soft delete.
pub(crate) async fn delete_record(
    storage: Storage,
    headers: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
) -> Response {
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_collection(&collection)?;
            let deleted: Option<String> = sqlx::query_scalar(
                "update app_records set deleted_at = $4::timestamptz, updated_at = $4::timestamptz
                  where id = $1 and app_code = $2 and collection = $3 and deleted_at is null
                 returning id",
            )
            .bind(&id)
            .bind(&app_code)
            .bind(&collection)
            .bind(iso_timestamp(OffsetDateTime::now_utc()))
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            deleted.ok_or_else(|| not_found("Record", &id))?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

/// `{ key, value }` of an `app_kv` row.
fn kv_answer(key: &str, value: Option<Value>) -> Response {
    Json(json!({ "data": { "key": key, "value": value.unwrap_or(Value::Null) } })).into_response()
}

/// `GET /kv/:key`.
pub(crate) async fn get_kv(
    storage: Storage,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Response {
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_key(&key)?;
            let row: Option<(String, Option<Value>)> = sqlx::query_as(
                "select key, value from app_kv where app_code = $1 and key = $2 limit 1",
            )
            .bind(&app_code)
            .bind(&key)
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            let (stored, value) = row.ok_or_else(|| not_found("Key", &key))?;
            Ok(kv_answer(&stored, value))
        }
        .await,
    )
}

/// `PUT /kv/:key`: an upsert. A body without `value` leaves the stored value
/// as it is (Drizzle drops an `undefined` field from the insert and the
/// update alike); `null` stores SQL `NULL`.
pub(crate) async fn put_kv(
    storage: Storage,
    headers: HeaderMap,
    Path(key): Path<String>,
    body: Bytes,
) -> Response {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = match json_body(content_type, &body) {
        Ok(body) => body,
        Err(malformed) => return malformed.into_response(),
    };
    let mut issues = Issues::default();
    // `{ value: z.unknown() }`: any value, or none.
    let value = issues
        .object(&body)
        .map(|fields| fields.get("value").cloned());
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let value = value.flatten();
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_key(&key)?;
            let present = value.is_some();
            let stored = value.filter(|value| !value.is_null());
            let row: Option<(String, Option<Value>)> = sqlx::query_as(
                "insert into app_kv (id, app_code, key, value, created_at, updated_at)
                 values ($1, $2, $3, case when $4 then $5::jsonb else null end, $6::timestamptz, $6::timestamptz)
                 on conflict (app_code, key) do update
                   set value = case when $4 then excluded.value else app_kv.value end,
                       updated_at = excluded.updated_at
                 returning key, value",
            )
            .bind(generate_id("akv"))
            .bind(&app_code)
            .bind(&key)
            .bind(present)
            .bind(stored)
            .bind(iso_timestamp(OffsetDateTime::now_utc()))
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            let (stored, value) = row.ok_or_else(|| internal_with("Failed to set key"))?;
            Ok(kv_answer(&stored, value))
        }
        .await,
    )
}

/// `DELETE /kv/:key`.
pub(crate) async fn delete_kv(
    storage: Storage,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Response {
    respond(
        async {
            let app_code = resolve_app_code(&storage, &headers).await?;
            check_key(&key)?;
            let deleted: Option<String> = sqlx::query_scalar(
                "delete from app_kv where app_code = $1 and key = $2 returning id",
            )
            .bind(&app_code)
            .bind(&key)
            .fetch_optional(&storage.key.db)
            .await
            .map_err(|error| database_error(&error))?;
            deleted.ok_or_else(|| not_found("Key", &key))?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_names_follow_the_pattern() {
        assert!(is_collection_name("tasks"));
        assert!(is_collection_name("a_b-c9"));
        assert!(!is_collection_name("Tasks"));
        assert!(!is_collection_name("9tasks"));
        assert!(!is_collection_name(""));
        assert!(is_collection_name(&format!("a{}", "b".repeat(99))));
        assert!(!is_collection_name(&format!("a{}", "b".repeat(100))));
    }
}
