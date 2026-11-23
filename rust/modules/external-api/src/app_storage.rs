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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Issues, Number, Presence, json_body, query_values};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{user_app_installs, user_apps};
use weldsuite_schema::tenant::{app_kv, app_records};

use crate::list::{ListQuery, clamp_limit, list_page};
use crate::session::{
    ApiSession, Key, KeyType, bad_request, database_error, forbidden, internal_with, not_found,
};
use crate::{ExternalApiState, RequestApiCache, master_db};

const KV_KEY_MAX_LENGTH: usize = 255;
const DEFAULT_RECORD_LIMIT: f64 = 25.0;
/// The active-install lookup's lifetime: short, so an uninstall bites fast.
const INSTALL_CACHE_TTL: Duration = Duration::from_secs(60);

/// `app_records` as Drizzle reads it.
const RECORDS: JsonTable = JsonTable::of::<app_records::Entity>();

/// The live records of the app's collection; `filter` is a `data @> filter`
/// containment.
fn records_list(app_code: &str, collection: &str, filter: Option<Value>) -> Condition {
    Condition::all()
        .add(app_records::Column::DeletedAt.is_null())
        .add(app_records::Column::AppCode.eq(app_code))
        .add(app_records::Column::Collection.eq(collection))
        .add_option(filter.map(|filter| {
            sea_orm::sea_query::extension::postgres::PgExpr::contains(
                app_records::Column::Data.into_expr(),
                filter,
            )
        }))
}

/// `new Date()` as a `timestamptz` column gets it from Drizzle: to the
/// millisecond.
fn now_tz() -> OffsetDateTime {
    weldsuite_db::utc_now().assume_utc()
}

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
    let row: Option<(String, String)> = user_app_installs::Entity::find()
        .join(
            JoinType::InnerJoin,
            user_app_installs::Entity::belongs_to(user_apps::Entity)
                .from(user_app_installs::Column::AppId)
                .to(user_apps::Column::Id)
                .into(),
        )
        .select_only()
        .column_as(user_apps::Column::Id, "app_id")
        .column_as(user_app_installs::Column::Id, "install_id")
        .filter(user_apps::Column::Code.eq(app_code))
        .filter(user_app_installs::Column::WorkspaceId.eq(workspace_id))
        .filter(user_app_installs::Column::Status.eq("active"))
        .filter(user_apps::Column::IsActive.eq(true))
        .filter(user_apps::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&storage.master))
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

/// A model as Drizzle's row.
fn to_json<T: Serialize>(model: T) -> Result<Value, ApiError> {
    serde_json::to_value(model).map_err(|error| database_error(&DbErr::Json(error.to_string())))
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
            let filter = match filter.as_deref().filter(|filter| !filter.is_empty()) {
                Some(filter) => Some(
                    serde_json::from_str::<Value>(filter)
                        .map_err(|_| bad_request("filter must be a valid JSON string"))?,
                ),
                None => None,
            };
            let query = ListQuery {
                cursor,
                limit: clamp_limit(Some(limit.unwrap_or(DEFAULT_RECORD_LIMIT))),
            };
            list_page(
                &storage.key.db,
                &RECORDS,
                records_list(&app_code, &collection, filter),
                &query,
            )
            .await
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
            let now = now_tz();
            let row = app_records::Entity::insert(app_records::ActiveModel {
                id: Set(generate_id("arec")),
                app_code: Set(app_code),
                collection: Set(collection),
                data: Set(Value::Object(data)),
                created_by: Set(Some(storage.key.session.key_id.clone())),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_with_returning(&orm(&storage.key.db))
            .await
            .map_err(|error| match error {
                DbErr::RecordNotInserted => internal_with("Failed to create record"),
                error => database_error(&error),
            })?;
            Ok((StatusCode::CREATED, Json(json!({ "data": to_json(row)? }))).into_response())
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
            let row = app_records::Entity::find()
                .filter(app_records::Column::Id.eq(id.as_str()))
                .filter(app_records::Column::AppCode.eq(app_code))
                .filter(app_records::Column::Collection.eq(collection))
                .filter(app_records::Column::DeletedAt.is_null())
                .one(&orm(&storage.key.db))
                .await
                .map_err(|error| database_error(&error))?;
            let row = row.ok_or_else(|| not_found("Record", &id))?;
            Ok(Json(json!({ "data": to_json(row)? })).into_response())
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
            let row = app_records::Entity::update_many()
                .col_expr(app_records::Column::Data, Expr::value(Value::Object(data)))
                .col_expr(
                    app_records::Column::CreatedBy,
                    Expr::value(storage.key.session.key_id.as_str()),
                )
                .col_expr(app_records::Column::UpdatedAt, Expr::value(now_tz()))
                .filter(app_records::Column::Id.eq(id.as_str()))
                .filter(app_records::Column::AppCode.eq(app_code))
                .filter(app_records::Column::Collection.eq(collection))
                .filter(app_records::Column::DeletedAt.is_null())
                .exec_with_returning(&orm(&storage.key.db))
                .await
                .map_err(|error| database_error(&error))?
                .into_iter()
                .next();
            let row = row.ok_or_else(|| not_found("Record", &id))?;
            Ok(Json(json!({ "data": to_json(row)? })).into_response())
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
            let now = now_tz();
            let deleted = app_records::Entity::update_many()
                .col_expr(app_records::Column::DeletedAt, Expr::value(now))
                .col_expr(app_records::Column::UpdatedAt, Expr::value(now))
                .filter(app_records::Column::Id.eq(id.as_str()))
                .filter(app_records::Column::AppCode.eq(app_code))
                .filter(app_records::Column::Collection.eq(collection))
                .filter(app_records::Column::DeletedAt.is_null())
                .exec(&orm(&storage.key.db))
                .await
                .map_err(|error| database_error(&error))?;
            if deleted.rows_affected == 0 {
                return Err(not_found("Record", &id));
            }
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
            let row: Option<(String, Option<Value>)> = app_kv::Entity::find()
                .select_only()
                .columns([app_kv::Column::Key, app_kv::Column::Value])
                .filter(app_kv::Column::AppCode.eq(app_code))
                .filter(app_kv::Column::Key.eq(key.as_str()))
                .into_tuple()
                .one(&orm(&storage.key.db))
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
            let now = now_tz();
            // An existing key keeps its value when the body has none.
            let mut upsert = OnConflict::columns([app_kv::Column::AppCode, app_kv::Column::Key]);
            if present {
                upsert.update_columns([app_kv::Column::Value, app_kv::Column::UpdatedAt]);
            } else {
                upsert.update_column(app_kv::Column::UpdatedAt);
            }
            let row = app_kv::Entity::insert(app_kv::ActiveModel {
                id: Set(generate_id("akv")),
                app_code: Set(app_code),
                key: Set(key),
                value: Set(stored),
                created_at: Set(now),
                updated_at: Set(now),
            })
            .on_conflict(upsert)
            .exec_with_returning(&orm(&storage.key.db))
            .await
            .map_err(|error| match error {
                DbErr::RecordNotInserted => internal_with("Failed to set key"),
                error => database_error(&error),
            })?;
            Ok(kv_answer(&row.key, row.value))
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
            let deleted = app_kv::Entity::delete_many()
                .filter(app_kv::Column::AppCode.eq(app_code))
                .filter(app_kv::Column::Key.eq(key.as_str()))
                .exec(&orm(&storage.key.db))
                .await
                .map_err(|error| database_error(&error))?;
            if deleted.rows_affected == 0 {
                return Err(not_found("Key", &key));
            }
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
