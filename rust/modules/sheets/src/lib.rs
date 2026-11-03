//! WeldSheets: `/api/sheets` as sheets-api serves it
//! (`apps/workers/sheets-api/src/routes/sheets`).
//!
//! A spreadsheet is a WeldDrive file plus a `sheets` row, so who may see or
//! change it follows WeldDrive's sharing rules on top of the `sheets:*`
//! permissions, and a WeldFlow project's sheet follows the project; a sheet
//! the caller may not see is a 404. Its workbook lives in its room
//! (`SheetRoom`, one per sheet) and the room's checkpoints in the private
//! bucket. The room is the collab-rooms service on Kubernetes
//! (`rust/docs/collab-rooms.md`), reached through the
//! [`CollabRooms`](weldsuite_ports::`CollabRooms`) port; so is the sheets
//! engine (`SHEET_ENGINE`) for the work the routes do without a room: a new
//! workbook, imports, legacy conversions, a version's .xlsx, and a connected
//! table's listing.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `sheets`
//! conformance suite (`rust/conformance/suites.json`). `/internal/agent/*`
//! (the `SheetsInternal` entrypoint the WeldAgent tools call) is not here.

mod data_sources;
mod records;
mod routes;
mod sheet_data;
mod versions;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequestParts};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    SHEETS_COMMENT, SHEETS_CREATE, SHEETS_DELETE, SHEETS_READ, SHEETS_UPDATE,
};
use weldsuite_core_domain::drive_access::{DriveRole, can_edit};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::FileStores;
use weldsuite_ports::collab::{CollabError, CollabRooms, RequestCollab, SHEET_ENGINE, SHEET_ROOM};

/// What the sheets handlers share.
#[derive(Clone)]
pub struct SheetsState {
    pub events: EntityEventPublisher,
    /// The private bucket (checkpoints, versions) and the public one (drive
    /// files from before private storage, read for imports). A request's
    /// [`FileStores`] (conformance) wins.
    pub files: Option<FileStores>,
    /// The collab-rooms service. A request's [`RequestCollab`] (conformance) wins.
    pub collab: Option<Arc<dyn CollabRooms>>,
}

impl std::fmt::Debug for SheetsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SheetsState")
            .field("collab", &self.collab.is_some())
            .finish_non_exhaustive()
    }
}

/// The largest request `POST /api/sheets/import` reads: the 25 MB import
/// limit with room to spare, so a larger file still gets the route's own 400.
const IMPORT_BODY_LIMIT: usize = 64 * 1024 * 1024;

/// `/api/sheets`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission`.
pub fn router<S, Q>(state: SheetsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([SHEETS_READ]);
    let update = || gate.require([SHEETS_UPDATE]);
    Router::new()
        .route("/", get(routes::list).route_layer(read()))
        .route(
            "/",
            post(routes::create).route_layer(gate.require([SHEETS_CREATE])),
        )
        .route(
            "/import",
            post(routes::import)
                .route_layer(gate.require([SHEETS_CREATE]))
                .layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT)),
        )
        .route("/convert", post(routes::convert).route_layer(read()))
        .route("/{id}/export", get(routes::export).route_layer(read()))
        .route("/{id}", get(routes::detail).route_layer(read()))
        .route("/{id}", patch(routes::update).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(routes::remove).route_layer(gate.require([SHEETS_DELETE])),
        )
        .route("/{id}/session", post(routes::session).route_layer(read()))
        .route("/{id}/versions", get(versions::list).route_layer(read()))
        .route(
            "/{id}/versions",
            post(versions::create).route_layer(update()),
        )
        .route(
            "/{id}/versions/{version_id}",
            patch(versions::rename).route_layer(update()),
        )
        .route(
            "/{id}/versions/{version_id}/snapshot",
            get(versions::snapshot).route_layer(read()),
        )
        .route(
            "/{id}/versions/{version_id}/export",
            get(versions::export).route_layer(read()),
        )
        .route(
            "/{id}/versions/{version_id}/restore",
            post(versions::restore).route_layer(update()),
        )
        .route(
            "/{id}/data-sources",
            get(data_sources::list).route_layer(read()),
        )
        .route(
            "/{id}/data-sources",
            post(data_sources::create).route_layer(update()),
        )
        .route(
            "/{id}/data-sources/{source_id}",
            patch(data_sources::update).route_layer(update()),
        )
        .route(
            "/{id}/data-sources/{source_id}",
            axum::routing::delete(data_sources::remove).route_layer(update()),
        )
        .route(
            "/{id}/data-sources/{source_id}/refresh",
            post(data_sources::refresh).route_layer(update()),
        )
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// The workspace is read-only (`c.get('readOnly')`).
    pub(crate) read_only: bool,
    /// `c.get('clerkOrgId')`: room names and bucket keys use it.
    pub(crate) clerk_org_id: Option<String>,
    files: Option<FileStores>,
    collab: Option<RequestCollab>,
}

impl Caller {
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `mayUpdate`: not read-only, with `sheets:update`.
    pub(crate) fn may_update(&self) -> bool {
        !self.read_only && self.can(SHEETS_UPDATE)
    }

    /// `mayEditSheet`: an owner or editor on the file, who may update.
    pub(crate) fn may_edit(&self, role: DriveRole) -> bool {
        can_edit(Some(role)) && self.may_update()
    }

    /// May comment without editing: not read-only, with `sheets:comment`.
    pub(crate) fn may_comment(&self) -> bool {
        !self.read_only && self.can(SHEETS_COMMENT)
    }

    /// `c.get('clerkOrgId')`, or the 400 `error.orgRequired`.
    pub(crate) fn org(&self) -> Result<&str, Refusal> {
        self.clerk_org_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ApiError::org_required().into())
    }

    pub(crate) fn files(&self, state: &SheetsState) -> Result<FileStores, Refusal> {
        self.files
            .clone()
            .or_else(|| state.files.clone())
            .ok_or_else(|| {
                tracing::error!("[sheets-api] no bucket");
                ApiError::internal().into()
            })
    }

    fn collab(&self, state: &SheetsState) -> Option<Arc<dyn CollabRooms>> {
        self.collab
            .as_ref()
            .map(|request| Arc::clone(&request.0))
            .or_else(|| state.collab.clone())
    }

    /// `env.SHEET_ROOM.get(idFromName(name))[method](...args)`.
    pub(crate) async fn room(
        &self,
        state: &SheetsState,
        name: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, Refusal> {
        self.call(state, SHEET_ROOM, name, method, args).await
    }

    /// The sheets engine's `method` (`apps/workers/sheets-api/src/engine-ops.ts`).
    pub(crate) async fn engine(
        &self,
        state: &SheetsState,
        method: &str,
        args: Value,
    ) -> Result<Value, Refusal> {
        self.call(state, SHEET_ENGINE, "", method, args).await
    }

    async fn call(
        &self,
        state: &SheetsState,
        binding: &str,
        name: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, Refusal> {
        let Some(collab) = self.collab(state) else {
            return Err(ApiError::unavailable("Live editing is not configured").into());
        };
        collab
            .call(binding, name, method, args)
            .await
            .map_err(|error| match error {
                CollabError::Threw(message) => {
                    tracing::error!(%message, binding, method, "[sheets-api] the room threw");
                    ApiError::internal().into()
                }
                CollabError::Unavailable(error) => {
                    tracing::error!(%error, binding, method, "[sheets-api] collab-rooms unreachable");
                    ApiError::unavailable("Live editing is unavailable").into()
                }
            })
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(&self, state: &SheetsState, event: EventName, id: &str, data: &Value) {
        publish_entity_event(&state.events, &self.events, event, id, data);
    }

    /// The same, with `changes`.
    pub(crate) fn publish_changes(
        &self,
        state: &SheetsState,
        event: EventName,
        id: &str,
        data: &Value,
        changes: Map<String, Value>,
    ) {
        let entity =
            weldsuite_events::EntityEvent::new(event, id, data.clone()).with_changes(changes);
        state.events.publish(&self.events, entity);
    }
}

/// Behind the session, tenant database and permission layers; without them
/// it is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let permissions = parts.extensions.get::<Permissions>();
        let caller =
            if let (Some(auth), Some(tenant), Some(permissions)) = (auth, tenant, permissions) {
                Ok(Self {
                    db: tenant.db.clone(),
                    user_id: auth.user_id.clone(),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    read_only: tenant.read_only_reason().is_some(),
                    clerk_org_id: tenant.clerk_org_id.clone(),
                    files: parts.extensions.get::<FileStores>().cloned(),
                    collab: parts.extensions.get::<RequestCollab>().cloned(),
                })
            } else {
                tracing::error!("sheets: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 403, 404, 409, a validation failure), or an unexpected error (500).
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl Refusal {
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    pub(crate) fn respond(self) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[sheets-api] a query failed");
                ApiError::internal().into_response()
            }
        }
    }
}

/// The handler's result as a response.
pub(crate) fn answer(result: Result<Response, Refusal>) -> Response {
    result.unwrap_or_else(Refusal::respond)
}

/// `new Date()` as Drizzle writes it to a `timestamp` column.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let rejected = |response: Response| Refusal::Response(Box::new(response));
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| rejected(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| rejected(invalid.into_response()))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    raw: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let query = weldsuite_kit::validation::query_values(raw);
    let mut issues = Issues::default();
    let value = read(&mut issues, &query);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// The same colour for a person in every sheet (`colorFor`).
pub(crate) fn color_for(user_id: &str) -> &'static str {
    const PALETTE: [&str; 10] = [
        "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d",
        "#4f46e5", "#ca8a04",
    ];
    let hash = user_id.encode_utf16().fold(0u32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(u32::from(unit))
    });
    PALETTE[(hash % 10) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_follow_the_workers_hash() {
        // What the TypeScript `colorFor` gives (the same as WeldDocs').
        for (user, colour) in [
            ("", "#2563eb"),
            ("a", "#65a30d"),
            ("user_alice", "#4f46e5"),
            ("user_bob", "#dc2626"),
        ] {
            assert_eq!(color_for(user), colour, "{user}");
        }
    }
}
