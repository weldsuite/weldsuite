//! Core platform files, from app-api (`apps/workers/app-api/src/routes/`):
//!
//! - `/api/files`: WeldDrive's file store, content and per-person sharing;
//! - `/api/folders`: the folder tree and folder sharing;
//! - `/api/drive`: the views across modules (all files, counts, "Shared with
//!   me") and the trash;
//! - `/api/search`: the federated search over every module's records.
//!
//! `files:*` / `folders:*` open the door to Drive; which items a caller sees,
//! and at what role, follows the WeldDrive rules in
//! `weldsuite_core_domain::drive_access`. An item the caller cannot see is a
//! 404.
//!
//! - `/api/storage`: the upload broker, the files cookie and signed URLs,
//!   the private-object read (some of it before authentication:
//!   [`storage_public_router`]) and the move of old private files out of the
//!   public bucket;
//! - the 30-day purge of trashed files, a job ([`TrashPurgeJob`]) that
//!   `DELETE /api/files/:id` starts with a delay.
//!
//! Not here yet: the search reindex and the model tier of query
//! understanding (both need an AI port).

mod drive;
mod files;
mod folders;
mod names;
mod search;
mod storage;
mod trash_purge;
mod understanding;

pub use storage::{StorageState, storage_public_router, storage_router};
pub use trash_purge::{
    TRASH_PURGE_JOB, TRASH_RETENTION, TenantDatabases, TrashPurge, TrashPurgeJob,
};

use std::fmt::Write as _;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use http::header::{CONTENT_TYPE, HOST};
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    FILES_CREATE, FILES_DELETE, FILES_READ, FILES_UPDATE, FOLDERS_CREATE, FOLDERS_DELETE,
    FOLDERS_READ, FOLDERS_UPDATE,
};
use weldsuite_core_domain::drive_access::{DriveAccessIndex, DriveCaller, load_drive_access};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event,
};
use weldsuite_kit::validation::{Invalid, Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{FileStores, PortError};

/// What the handlers share.
#[derive(Debug, Clone)]
pub struct CoreFilesState {
    pub events: EntityEventPublisher,
    /// The private bucket (and the legacy public one), when configured.
    pub files: Option<FileStores>,
    /// `R2_PUBLIC_URL`: the public bucket's own domain, for rows that store
    /// only a key.
    pub public_files_url: Option<Arc<str>>,
    /// The upload broker's cache, signing key and session verifier, and the
    /// jobs port the trash purge is started on.
    pub storage: StorageState,
}

/// `/api/files`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers.
pub fn files_router<S, Q>(state: CoreFilesState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(files::list).route_layer(need(FILES_READ)))
        .route("/", post(files::create).route_layer(need(FILES_CREATE)))
        .route("/{id}", get(files::detail).route_layer(need(FILES_READ)))
        .route(
            "/{id}",
            patch(files::update).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/{id}",
            delete(files::remove).route_layer(need(FILES_DELETE)),
        )
        .route(
            "/{id}/star",
            post(files::star).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/{id}/pin",
            post(files::pin).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/{id}/content",
            get(files::content).route_layer(need(FILES_READ)),
        )
        .route(
            "/{id}/content",
            put(files::write_content)
                .route_layer(need(FILES_UPDATE))
                .layer(axum::extract::DefaultBodyLimit::max(MAX_CONTENT_BYTES)),
        )
        .route(
            "/{id}/move",
            post(files::move_to).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/{id}/shares",
            get(files::sharing).route_layer(need(FILES_READ)),
        )
        .route(
            "/{id}/shares/{user_id}",
            put(files::share).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/{id}/shares/{user_id}",
            delete(files::unshare).route_layer(need(FILES_READ)),
        )
        .with_state(state)
}

/// What a content write may carry: the TypeScript reads any body (Workers
/// cap requests at 100 MB).
const MAX_CONTENT_BYTES: usize = 100 * 1024 * 1024;

/// `/api/folders`.
pub fn folders_router<S, Q>(state: CoreFilesState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(folders::list).route_layer(need(FOLDERS_READ)))
        .route("/", post(folders::create).route_layer(need(FOLDERS_CREATE)))
        .route(
            "/{id}",
            get(folders::detail).route_layer(need(FOLDERS_READ)),
        )
        .route(
            "/{id}",
            patch(folders::update).route_layer(need(FOLDERS_UPDATE)),
        )
        .route(
            "/{id}",
            delete(folders::remove).route_layer(need(FOLDERS_DELETE)),
        )
        .route(
            "/{id}/shares",
            get(folders::sharing).route_layer(need(FOLDERS_READ)),
        )
        .route(
            "/{id}/shares/{user_id}",
            put(folders::share).route_layer(need(FOLDERS_UPDATE)),
        )
        .route(
            "/{id}/shares/{user_id}",
            delete(folders::unshare).route_layer(need(FOLDERS_READ)),
        )
        .with_state(state)
}

/// `/api/drive`.
pub fn drive_router<S, Q>(state: CoreFilesState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/all", get(drive::all).route_layer(need(FILES_READ)))
        .route("/stats", get(drive::stats).route_layer(need(FILES_READ)))
        .route("/shared", get(drive::shared).route_layer(need(FILES_READ)))
        .route("/trash", get(drive::trash).route_layer(need(FILES_READ)))
        .route(
            "/trash/restore/file/{id}",
            post(drive::restore_file).route_layer(need(FILES_UPDATE)),
        )
        .route(
            "/trash/restore/folder/{id}",
            post(drive::restore_folder).route_layer(need(FOLDERS_UPDATE)),
        )
        .route(
            "/trash/file/{id}",
            delete(drive::purge_file).route_layer(need(FILES_DELETE)),
        )
        .route(
            "/trash/folder/{id}",
            delete(drive::purge_folder).route_layer(need(FOLDERS_DELETE)),
        )
        .route(
            "/trash/empty",
            delete(drive::empty_trash).route_layer(need(FILES_DELETE)),
        )
        .with_state(state)
}

/// `/api/search`: no `requirePermission`; each result type is filtered by
/// the caller's permissions instead.
pub fn search_router<S, Q>(state: CoreFilesState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", post(search::search).route_layer(gate.resolve()))
        .with_state(state)
}

// ── The caller ─────────────────────────────────────────────────────────────

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: Option<String>,
    pub(crate) permissions: Option<Permissions>,
    pub(crate) events: EventContext,
    /// `c.get('clerkOrgId')`: storage keys are `workspaces/<org>/…`.
    pub(crate) clerk_org_id: Option<String>,
    /// `new URL(c.req.url).origin`.
    pub(crate) origin: String,
    env: Option<RequestEnv>,
    files: Option<FileStores>,
    /// What the storage routes read from the request (conformance builds).
    pub(crate) storage: storage::Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CoreFilesState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// The same, with the change list (`changes: computeChanges(...)`).
    pub(crate) fn publish_with_changes(
        &self,
        state: &CoreFilesState,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        let mut event = EntityEvent::new(event, entity_id, data);
        if let Some(changes) = changes {
            event = event.with_changes(changes);
        }
        state.events.publish(&self.events, event);
    }

    /// The request's buckets (conformance mode), else the app's.
    pub(crate) fn files(&self, state: &CoreFilesState) -> Option<FileStores> {
        self.files.clone().or_else(|| state.files.clone())
    }

    /// `c.env.R2_PUBLIC_URL`.
    pub(crate) fn public_files_url(&self, state: &CoreFilesState) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get("R2_PUBLIC_URL"))
            .map(str::to_owned)
            .or_else(|| state.public_files_url.as_deref().map(str::to_owned))
            .filter(|url| !url.is_empty())
    }

    /// The caller as the Drive rules see them (`driveCaller`): workspace
    /// OWNER / ADMIN open every item.
    pub(crate) async fn drive_caller(&self) -> Result<DriveCaller, sqlx::Error> {
        let Some(user_id) = self.user_id.clone() else {
            return Ok(DriveCaller {
                user_id: None,
                is_admin: false,
            });
        };
        if let Some(permissions) = &self.permissions {
            let resolved = permissions.resolved();
            let role = resolved.role.to_uppercase();
            return Ok(DriveCaller {
                user_id: Some(user_id),
                is_admin: resolved.is_owner || role == "OWNER" || role == "ADMIN",
            });
        }
        let is_admin =
            weldsuite_core_domain::drive_access::is_workspace_admin(&self.db, &user_id).await?;
        Ok(DriveCaller {
            user_id: Some(user_id),
            is_admin,
        })
    }

    /// The Drive rules for this caller (`driveAccess(c)`).
    pub(crate) async fn drive_access(&self) -> Result<DriveAccessIndex, sqlx::Error> {
        load_drive_access(&self.db, self.drive_caller().await?).await
    }

    /// `isWorkspaceObjectKey(key, c.get('clerkOrgId'))`.
    pub(crate) fn owns_key(&self, key: &str) -> bool {
        self.clerk_org_id
            .as_deref()
            .is_some_and(|org| is_workspace_object_key(key, org))
    }
}

/// The request's origin as the client reached it: `X-Forwarded-Proto` and
/// `X-Forwarded-Host` from the ingress, else the `Host` header over HTTP.
pub(crate) fn request_origin(headers: &HeaderMap) -> String {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let host = header("x-forwarded-host")
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("localhost");
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    // `new URL(...).origin` drops a default port.
    let host = match (scheme, host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name,
        _ => host,
    };
    format!("{scheme}://{}", host.to_ascii_lowercase())
}

/// Behind the session and tenant database layers; without them it is a
/// routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let caller = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: Some(auth.user_id.clone()).filter(|id| !id.is_empty()),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                events: EventContext::for_request(auth, tenant),
                clerk_org_id: tenant.clerk_org_id.clone(),
                origin: request_origin(&parts.headers),
                env: parts.extensions.get::<RequestEnv>().cloned(),
                files: parts.extensions.get::<FileStores>().cloned(),
                storage: storage::Overrides::from_parts(parts),
            })
        } else {
            tracing::error!("core-files: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

// ── Errors ─────────────────────────────────────────────────────────────────

/// Why a handler stopped: a response it wrote itself (a refusal, a 400), or
/// a failure the route's `catch` turns into its 500.
#[derive(Debug)]
pub(crate) enum Fail {
    Response(Box<Response>),
    Database(sqlx::Error),
    Storage(PortError),
}

impl From<ApiError> for Fail {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl From<Invalid> for Fail {
    fn from(invalid: Invalid) -> Self {
        Self::Response(Box::new(invalid.into_response()))
    }
}

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PortError> for Fail {
    fn from(error: PortError) -> Self {
        Self::Storage(error)
    }
}

pub(crate) type Outcome = Result<Response, Fail>;

/// The route's answer, or `error.internal(c, message)` for what its `catch`
/// caught.
pub(crate) fn answer(outcome: Outcome, message: &str) -> Response {
    match outcome {
        Ok(response) => response,
        Err(Fail::Response(response)) => *response,
        Err(Fail::Database(error)) => {
            tracing::error!(%error, "{message}");
            ApiError::internal().with_message(message).into_response()
        }
        Err(Fail::Storage(error)) => {
            tracing::error!(%error, "{message}");
            ApiError::internal().with_message(message).into_response()
        }
    }
}

/// `error.forbidden(c, message)`.
pub(crate) fn forbidden(message: &str) -> Fail {
    ApiError::forbidden().with_message(message).into()
}

/// `error.notFound(c, resource, id)`.
pub(crate) fn not_found(resource: &str, id: &str) -> Fail {
    ApiError::not_found(resource, Some(id)).into()
}

/// `success(c, data)`.
#[allow(clippy::unnecessary_wraps)] // the handlers' `Outcome`
pub(crate) fn ok(data: Value) -> Outcome {
    Ok(weldsuite_kit::Data(data).into_response())
}

/// `success(c, data, 201)`.
#[allow(clippy::unnecessary_wraps)] // the handlers' `Outcome`
pub(crate) fn created(data: Value) -> Outcome {
    Ok(weldsuite_kit::Created(data).into_response())
}

/// `c.json(body, status)`.
pub(crate) fn json_response(status: http::StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Fail> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| Fail::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish()?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Fail> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues.finish()?;
    Ok(value)
}

/// `c.req.query(name)`: the first value of a query parameter.
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query_values(query).get(name).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    })
}

/// A string field of a row, `None` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str()
}

// ── Storage keys and URLs ──────────────────────────────────────────────────

/// `PRIVATE_OBJECT_PATH`: where app-api serves private objects.
use storage::PRIVATE_OBJECT_PATH;

/// `workspaceOfKey`: the workspace a key belongs to (`workspaces/<id>/…`).
pub(crate) fn workspace_of_key(key: &str) -> Option<&str> {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(id), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

/// `isWorkspaceObjectKey(key, org)`.
pub(crate) fn is_workspace_object_key(key: &str, org: &str) -> bool {
    weldsuite_ports::is_safe_key(key) && workspace_of_key(key) == Some(org)
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `privateObjectUrl(origin, key)`: the stable URL app-api serves a private
/// object at.
pub(crate) fn private_object_url(origin: &str, key: &str) -> String {
    let encoded: Vec<String> = key.split('/').map(encode_uri_component).collect();
    format!(
        "{}{PRIVATE_OBJECT_PATH}{}",
        origin.trim_end_matches('/'),
        encoded.join("/")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_like_new_url() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, "127.0.0.1:18089".parse().expect("header"));
        assert_eq!(request_origin(&headers), "http://127.0.0.1:18089");
        headers.insert("x-forwarded-host", "localhost".parse().expect("header"));
        assert_eq!(request_origin(&headers), "http://localhost");
        headers.insert("x-forwarded-proto", "https".parse().expect("header"));
        headers.insert(
            "x-forwarded-host",
            "App-API.weldsuite.org:443".parse().expect("header"),
        );
        assert_eq!(request_origin(&headers), "https://app-api.weldsuite.org");
    }

    #[test]
    fn keys_and_urls() {
        assert!(is_workspace_object_key(
            "workspaces/org_1/drive/a.txt",
            "org_1"
        ));
        assert!(!is_workspace_object_key(
            "workspaces/org_2/drive/a.txt",
            "org_1"
        ));
        assert!(!is_workspace_object_key(
            "workspaces/org_1/../org_2/a",
            "org_1"
        ));
        assert!(!is_workspace_object_key("avatars/a.txt", "org_1"));
        assert_eq!(
            private_object_url("http://localhost/", "workspaces/org_1/a b/ü.txt"),
            "http://localhost/api/storage/private/workspaces/org_1/a%20b/%C3%BC.txt"
        );
        assert_eq!(encode_uri_component("a\"b's(1).txt"), "a%22b's(1).txt");
    }
}
