//! WeldBoard: `/api/boards` as board-api serves it
//! (`apps/workers/board-api/src/routes/boards`).
//!
//! A board is a WeldDrive file plus a `whiteboards` row, so who may see or
//! change it follows WeldDrive's sharing rules on top of the `boards:*`
//! permissions; a WeldFlow project's board follows the project, and a
//! workspace template is open to everyone. Old WeldFlow whiteboards
//! (`project_whiteboards`) are listed beside a project's boards until someone
//! opens one, which converts it in place. A board the caller may not see is a
//! 404.
//!
//! A board's content lives in its room (`BoardRoom`, one per board) and the
//! room's checkpoints in the private bucket. The room is the collab-rooms
//! service on Kubernetes (`rust/docs/collab-rooms.md`), reached through the
//! [`CollabRooms`](weldsuite_ports::`CollabRooms`) port; so is the board
//! engine (`BOARD_ENGINE`, `apps/workers/board-api/src/engine-ops.ts`) for
//! the work the routes do without a room: a new board's first checkpoint,
//! copies, imports, legacy conversions, the task cards and the SVG render.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `board`
//! conformance suite (`rust/conformance/suites.json`). The AI actions
//! (`POST /:id/ai`) call `weldsuite_ai` (feature `board`) between two engine
//! calls, `aiPrepare` and `aiPlan` (`services/ai-plan.ts`), so both backends
//! ask the same thing and place the answer alike. Not here:
//! `/internal/boards/*` (the `BoardsInternal` entrypoint for the agent tools
//! and the MCP server, whose callers are not ported).

mod ai;
mod links;
mod record_views;
mod records;
mod routes;
mod versions;

pub use links::PublicLinks;

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
    BOARDS_COMMENT, BOARDS_CREATE, BOARDS_DELETE, BOARDS_READ, BOARDS_UPDATE,
};
use weldsuite_core_domain::drive_access::{DriveRole, can_edit};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::collab::{BOARD_ENGINE, BOARD_ROOM, CollabError, CollabRooms, RequestCollab};
use weldsuite_ports::{FileStores, OutboundHttp};

/// What the board handlers share.
#[derive(Clone)]
pub struct BoardState {
    pub events: EntityEventPublisher,
    /// The private bucket (checkpoints, thumbnails, versions). A request's
    /// [`FileStores`] (conformance) wins.
    pub files: Option<FileStores>,
    /// The collab-rooms service. A request's [`RequestCollab`] (conformance) wins.
    pub collab: Option<Arc<dyn CollabRooms>>,
    /// What a link card's preview is fetched with ([`PublicLinks`]: public
    /// addresses only, redirects one by one). A request's [`OutboundHttp`]
    /// (conformance) wins.
    pub links: Option<OutboundHttp>,
    /// The install's AI (the AI actions); `None` with AI off. A request's own
    /// `Ai` (conformance) wins.
    pub ai: Option<weldsuite_ai::Ai>,
    /// The master database, for the AI actions' credit wallet. A request's
    /// `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
}

impl std::fmt::Debug for BoardState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoardState")
            .field("collab", &self.collab.is_some())
            .field("links", &self.links.is_some())
            .field("ai", &self.ai.is_some())
            .finish_non_exhaustive()
    }
}

/// The largest request `POST /api/boards` and `/import` read: the 20 MB
/// snapshot and import limit with room to spare, so a larger one still gets
/// the route's own 400.
const CREATE_BODY_LIMIT: usize = 48 * 1024 * 1024;

/// `/api/boards`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission`.
pub fn router<S, Q>(state: BoardState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([BOARDS_READ]);
    let update = || gate.require([BOARDS_UPDATE]);
    let create = || gate.require([BOARDS_CREATE]);
    Router::new()
        .route("/", get(routes::list).route_layer(read()))
        .route(
            "/",
            post(routes::create)
                .route_layer(create())
                .layer(DefaultBodyLimit::max(CREATE_BODY_LIMIT)),
        )
        .route(
            "/import",
            post(routes::import)
                .route_layer(create())
                .layer(DefaultBodyLimit::max(CREATE_BODY_LIMIT)),
        )
        .route("/convert", post(routes::convert).route_layer(read()))
        .route("/unfurl", post(links::unfurl_route).route_layer(read()))
        .route("/records", post(record_views::resolve).route_layer(read()))
        .route("/{id}/tasks", post(routes::tasks).route_layer(update()))
        .route("/{id}/ai", post(routes::ai).route_layer(read()))
        .route("/{id}", get(routes::detail).route_layer(read()))
        .route("/{id}", patch(routes::update).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(routes::remove).route_layer(gate.require([BOARDS_DELETE])),
        )
        .route("/{id}/session", post(routes::session).route_layer(read()))
        .route("/{id}/snapshot", get(routes::snapshot).route_layer(read()))
        .route(
            "/{id}/thumbnail",
            get(routes::thumbnail).route_layer(read()),
        )
        .route("/{id}/render", get(routes::render).route_layer(read()))
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
            "/{id}/versions/{version_id}/restore",
            post(versions::restore).route_layer(update()),
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
    links: Option<OutboundHttp>,
    /// `workspaces.id`: the AI actions' wallet and settings.
    pub(crate) workspace_id: String,
    /// The request's own AI and master database (conformance).
    ai: Option<weldsuite_ai::Ai>,
    master: Option<PgPool>,
}

impl Caller {
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `mayUpdate`: not read-only, with `boards:update`.
    pub(crate) fn may_update(&self) -> bool {
        !self.read_only && self.can(BOARDS_UPDATE)
    }

    /// `mayEditBoard`: an owner or editor, who may update.
    pub(crate) fn may_edit(&self, role: DriveRole) -> bool {
        can_edit(Some(role)) && self.may_update()
    }

    /// `sessionMode`: edit, comment (anyone else who may see it, with
    /// `boards:comment`), or only view; a read-only workspace is view only.
    pub(crate) fn session_mode(&self, role: DriveRole) -> &'static str {
        if self.may_edit(role) {
            "edit"
        } else if !self.read_only && self.can(BOARDS_COMMENT) {
            "comment"
        } else {
            "view"
        }
    }

    /// `c.get('userId')`, or the 401 `error.unauthorized`.
    pub(crate) fn user(&self) -> Result<&str, Refusal> {
        if self.user_id.is_empty() {
            Err(ApiError::unauthorized().into())
        } else {
            Ok(&self.user_id)
        }
    }

    /// `c.get('clerkOrgId')`, or the 400 `error.orgRequired`.
    pub(crate) fn org(&self) -> Result<&str, Refusal> {
        self.clerk_org_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ApiError::org_required().into())
    }

    pub(crate) fn files(&self, state: &BoardState) -> Result<FileStores, Refusal> {
        self.files
            .clone()
            .or_else(|| state.files.clone())
            .ok_or_else(|| {
                tracing::error!("[board-api] no bucket");
                ApiError::internal().into()
            })
    }

    pub(crate) fn links(&self, state: &BoardState) -> Option<OutboundHttp> {
        self.links.clone().or_else(|| state.links.clone())
    }

    fn collab(&self, state: &BoardState) -> Option<Arc<dyn CollabRooms>> {
        self.collab
            .as_ref()
            .map(|request| Arc::clone(&request.0))
            .or_else(|| state.collab.clone())
    }

    /// `env.BOARD_ROOM.get(idFromName(name))[method](...args)`.
    pub(crate) async fn room(
        &self,
        state: &BoardState,
        name: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, Refusal> {
        self.call(state, BOARD_ROOM, name, method, args).await
    }

    /// The AI an action calls: the request's (conformance), else the state's;
    /// `None` when it is off.
    pub(crate) fn ai(&self, state: &BoardState) -> Option<weldsuite_ai::Ai> {
        self.ai
            .as_ref()
            .or(state.ai.as_ref())
            .filter(|ai| ai.enabled())
            .cloned()
    }

    /// The master database: the request's (conformance), else the state's.
    pub(crate) fn master(&self, state: &BoardState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// The board engine's `method` (`apps/workers/board-api/src/engine-ops.ts`).
    pub(crate) async fn engine(
        &self,
        state: &BoardState,
        method: &str,
        args: Value,
    ) -> Result<Value, Refusal> {
        self.call(state, BOARD_ENGINE, "", method, args).await
    }

    async fn call(
        &self,
        state: &BoardState,
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
                    tracing::error!(%message, binding, method, "[board-api] the room threw");
                    ApiError::internal().into()
                }
                CollabError::Unavailable(error) => {
                    tracing::error!(%error, binding, method, "[board-api] collab-rooms unreachable");
                    ApiError::unavailable("Live editing is unavailable").into()
                }
            })
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(&self, state: &BoardState, event: EventName, id: &str, data: &Value) {
        publish_entity_event(&state.events, &self.events, event, id, data);
    }

    /// The same, with `changes`.
    pub(crate) fn publish_changes(
        &self,
        state: &BoardState,
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
                    links: parts.extensions.get::<OutboundHttp>().cloned(),
                    workspace_id: tenant.workspace_id.clone(),
                    ai: parts.extensions.get::<weldsuite_ai::Ai>().cloned(),
                    master: parts
                        .extensions
                        .get::<weldsuite_db::MasterDb>()
                        .map(|master| master.0.clone()),
                })
            } else {
                tracing::error!("board: a route without the session, tenant or permission layer");
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

    pub(crate) fn bad_request(message: &str) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn respond(self) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[board-api] a query failed");
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

/// `text.slice(0, n)`, in UTF-16 units as JavaScript counts them.
pub(crate) fn js_slice(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// The same colour for a person on every board (`colorFor`).
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
        // What the TypeScript `colorFor` gives (room/people.ts).
        for (user, colour) in [
            ("", "#2563eb"),
            ("a", "#65a30d"),
            ("user_alice", "#4f46e5"),
            ("user_bob", "#dc2626"),
        ] {
            assert_eq!(color_for(user), colour, "{user}");
        }
    }

    #[test]
    fn slices_count_utf16_units() {
        assert_eq!(js_slice("héllo", 2), "hé");
        assert_eq!(js_slice("a😀b", 2), "a\u{fffd}");
        assert_eq!(js_slice("abc", 10), "abc");
    }
}
