//! WeldKnow, the workspace wiki: `/api/knowledge` as know-api serves it
//! (`apps/workers/know-api/src/routes/knowledge/index.ts`), with the access
//! rules of `@weldsuite/know-domain/access`.
//!
//! Teamspaces and each person's private space (CRUD, members, join, leave),
//! nested pages (tree, detail, create, metadata, content autosave, move,
//! soft-delete with the subtree, trash, restore), throttled version history,
//! and per-user favorites.
//!
//! Two layers of access, both required: the workspace permissions
//! (`knowledge:read|create|update|delete`, `knowledge:manage` to see and fix
//! every teamspace), and teamspace membership ([`access`]).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `know`
//! conformance suite (`rust/conformance/suites.json`).

mod access;
mod favorites;
mod pages;
mod spaces;
mod versions;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    KNOWLEDGE_CREATE, KNOWLEDGE_DELETE, KNOWLEDGE_MANAGE, KNOWLEDGE_READ, KNOWLEDGE_UPDATE,
};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

/// What the know handlers share.
#[derive(Debug, Clone)]
pub struct KnowState {
    pub events: EntityEventPublisher,
}

/// `/api/knowledge`, to nest under `/api` behind the session, tenant
/// database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: KnowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([KNOWLEDGE_READ]);
    let create = || gate.require([KNOWLEDGE_CREATE]);
    let update = || gate.require([KNOWLEDGE_UPDATE]);
    let remove = || gate.require([KNOWLEDGE_DELETE]);
    Router::new()
        // Spaces
        .route("/spaces", get(spaces::list).route_layer(read()))
        .route("/spaces", post(spaces::create).route_layer(create()))
        .route("/spaces/{id}", patch(spaces::update).route_layer(update()))
        .route("/spaces/{id}", delete(spaces::remove).route_layer(remove()))
        // Teamspace members
        .route("/teammates", get(spaces::teammates).route_layer(read()))
        .route(
            "/spaces/{id}/members",
            get(spaces::members)
                .post(spaces::add_member)
                .route_layer(read()),
        )
        .route(
            "/spaces/{id}/members/{user_id}",
            patch(spaces::set_member_role)
                .delete(spaces::remove_member)
                .route_layer(read()),
        )
        .route("/spaces/{id}/join", post(spaces::join).route_layer(read()))
        .route(
            "/spaces/{id}/leave",
            post(spaces::leave).route_layer(read()),
        )
        // Pages
        .route("/pages/tree", get(pages::tree).route_layer(read()))
        .route("/trash", get(pages::trash).route_layer(read()))
        .route("/pages", post(pages::create).route_layer(create()))
        .route("/pages/{id}", get(pages::detail).route_layer(read()))
        .route("/pages/{id}", patch(pages::update).route_layer(update()))
        .route("/pages/{id}", delete(pages::remove).route_layer(remove()))
        .route(
            "/pages/{id}/content",
            put(pages::save_content).route_layer(update()),
        )
        .route(
            "/pages/{id}/move",
            post(pages::move_page).route_layer(update()),
        )
        .route(
            "/pages/{id}/restore",
            post(pages::restore).route_layer(update()),
        )
        // Versions
        .route(
            "/pages/{id}/versions",
            get(versions::list).route_layer(read()),
        )
        .route(
            "/pages/{id}/versions",
            post(versions::create).route_layer(update()),
        )
        .route(
            "/pages/{id}/versions/{version_id}",
            get(versions::detail).route_layer(read()),
        )
        .route(
            "/pages/{id}/versions/{version_id}/restore",
            post(versions::restore).route_layer(update()),
        )
        // Favorites
        .route(
            "/favorites",
            get(favorites::list)
                .post(favorites::add)
                .route_layer(read()),
        )
        .route(
            "/favorites/{page_id}",
            delete(favorites::remove).route_layer(read()),
        )
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
}

impl Caller {
    /// `hasContextPermission(c, 'knowledge:manage')`.
    pub(crate) fn can_manage_all(&self) -> bool {
        self.permissions.has_any(&[KNOWLEDGE_MANAGE])
    }

    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &KnowState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
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
                })
            } else {
                tracing::error!("know: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// What the access rules and the routes refuse with, mapped onto the
/// envelope by [`KnowError::respond`] (`accessError`).
#[derive(Debug)]
pub(crate) enum KnowError {
    /// 404: `<resource> with ID '<id>' not found`.
    NotFound {
        resource: &'static str,
        id: String,
    },
    /// 403 with the message.
    Forbidden(&'static str),
    /// 409 with the message.
    Conflict(&'static str),
    Database(sqlx::Error),
}

impl KnowError {
    pub(crate) fn not_found(resource: &'static str, id: &str) -> Self {
        Self::NotFound {
            resource,
            id: id.to_owned(),
        }
    }

    /// The response; anything unexpected is logged and answered with a 500
    /// carrying `fallback`.
    pub(crate) fn respond(self, fallback: &'static str) -> Response {
        match self {
            Self::NotFound { resource, id } => {
                ApiError::not_found(resource, Some(&id)).into_response()
            }
            Self::Forbidden(message) => ApiError::forbidden().with_message(message).into_response(),
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Database(error) => {
                tracing::error!(%error, "[know-api/knowledge] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for KnowError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 403, 409, a validation failure), or a [`KnowError`].
pub(crate) enum Refusal {
    Response(Box<Response>),
    Know(KnowError),
}

impl From<KnowError> for Refusal {
    fn from(error: KnowError) -> Self {
        Self::Know(error)
    }
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Know(KnowError::Database(error))
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl Refusal {
    pub(crate) fn bad_request(message: &str) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    pub(crate) fn conflict(message: &str) -> Self {
        ApiError::conflict(message).into()
    }

    pub(crate) fn not_found(resource: &'static str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    /// The response; a [`KnowError`] as [`KnowError::respond`] answers it.
    pub(crate) fn respond(self, fallback: &'static str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Know(error) => error.respond(fallback),
        }
    }
}

/// `new Date()` as Drizzle writes it to a `timestamp` column: UTC with
/// milliseconds. Bound as text and cast with `::timestamp`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `new Date(Date.now() - minutes)`, as [`now`] writes it.
pub(crate) fn minutes_ago(minutes: i64) -> String {
    iso_timestamp(OffsetDateTime::now_utc() - time::Duration::minutes(minutes))
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

/// A list without paging: `list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null })`.
pub(crate) fn all(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}
