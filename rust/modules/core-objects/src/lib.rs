//! WeldObjects, custom fields, object templates and grid views: app-api's
//! core routes for user-defined data (`apps/workers/app-api/src/routes/`
//! `custom-objects`, `custom-object-records`, `custom-object-links`,
//! `custom-fields`, `object-templates`, `grid-views`, with the services in
//! `@weldsuite/core-domain/custom-objects` and `@weldsuite/db/lib/custom-*`).
//!
//! - `/api/custom-objects`: object type definitions and their relationship
//!   definitions (`weldobjects:manage`; listing also `weldobjects:read`).
//! - `/api/objects/:slug/records`: records of any custom object, behind the
//!   per-object `weldobjects:<slug>:<action>` and owner scoping
//!   (`weldobjects:<slug>:scope:all`), with relationship traversal.
//! - `/api/related/:entityType/:entityId/custom-objects`: the reverse lookup.
//! - `/api/custom-fields` (`settings:*`), `/api/object-templates`
//!   (`companies:*`), `/api/grid-views` (`general:read`).
//!
//! A record's field values live in `custom_field_values` (one typed cell per
//! value), keyed by the object's `co_<slug>` entity key; record events go
//! out as `co_<slug>:<action>`. Paths, bodies, status codes, messages and
//! events are the TypeScript routes'; their tests run against this crate in
//! the `core: objects` conformance suites.

mod fields;
mod grid_views;
mod js;
mod links;
mod objects;
mod records;
mod targets;
mod templates;
mod values;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventType, iso_timestamp, publish_entity_event,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

/// What the handlers share.
#[derive(Debug, Clone)]
pub struct CoreObjectsState {
    pub events: EntityEventPublisher,
}

/// `/api/custom-objects`: definitions and relationship definitions.
pub fn custom_objects_router<S, Q>(
    state: CoreObjectsState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    objects::router(gate)
        .merge(links::definition_router(gate))
        .with_state(state)
}

/// `/api/objects`: records and relationship traversal.
pub fn objects_router<S, Q>(state: CoreObjectsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    records::router(gate)
        .merge(links::traversal_router(gate))
        .with_state(state)
}

/// `/api/related`: custom object records linked to any record.
pub fn related_router<S, Q>(state: CoreObjectsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    links::reverse_router(gate).with_state(state)
}

/// `/api/custom-fields`.
pub fn custom_fields_router<S, Q>(
    state: CoreObjectsState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    fields::router(gate).with_state(state)
}

/// `/api/object-templates`.
pub fn object_templates_router<S, Q>(
    state: CoreObjectsState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    templates::router(gate).with_state(state)
}

/// `/api/grid-views`.
pub fn grid_views_router<S, Q>(state: CoreObjectsState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    grid_views::router(gate).with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CoreObjectsState,
        event: impl Into<EventType>,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// The same with `changes` (`null` leaves them off).
    pub(crate) fn publish_with_changes(
        &self,
        state: &CoreObjectsState,
        event: impl Into<EventType>,
        entity_id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        let mut event = EntityEvent::new(event, entity_id, data);
        event.changes = changes;
        state.events.publish(&self.events, event);
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
                tracing::error!(
                    "core objects: a route without the session, tenant or permission layer"
                );
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 403, 404, 409, a validation failure), or a database failure that
/// becomes the route's 500.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
}

impl Refusal {
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[app-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }

    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        ApiError::conflict(message).into()
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        ApiError::forbidden().with_message(message).into()
    }
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

impl From<Response> for Refusal {
    fn from(response: Response) -> Self {
        Self::Response(Box::new(response))
    }
}

pub(crate) type Answer = Result<Response, Refusal>;

/// The route's response, or its refusal with `fallback` as the 500 message.
pub(crate) fn answer(result: Answer, fallback: &str) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond(fallback))
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp` (or `::timestamptz`).
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// A response a check answers with instead of the route (400, 403, 404).
pub(crate) type Rejected = Box<Response>;

/// The rejection carrying `answer` (boxed: a `Response` is too large for an
/// `Err` the handlers pass around).
#[allow(clippy::unnecessary_box_returns)]
pub(crate) fn reject(answer: impl IntoResponse) -> Rejected {
    Box::new(answer.into_response())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Rejected> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(reject)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(reject)?;
    value.ok_or_else(|| reject(ApiError::internal()))
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Rejected> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues.finish().map_err(reject)?;
    Ok(value)
}

/// `c.req.query(name)` / `c.req.query()[name]`: the first value of a
/// parameter (Hono keeps the first of a repeated key).
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_pairs(query)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Every parameter of the query string, decoded (`+` is a space), in order.
pub(crate) fn form_pairs(query: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

/// A row as Drizzle returns it, from `to_jsonb(t)`: camelCase keys, and the
/// listed timestamp columns as `toISOString()`. Unlike `js_row`, a text
/// column that happens to look like a timestamp stays as it is.
pub(crate) fn row(value: Value, timestamps: &[&str]) -> Value {
    let Value::Object(columns) = value else {
        return value;
    };
    let mut out = Map::with_capacity(columns.len());
    for (column, value) in columns {
        let value = match value {
            Value::String(text) if timestamps.contains(&column.as_str()) => {
                Value::String(weldsuite_db::js_timestamp(&text).unwrap_or(text))
            }
            other => other,
        };
        out.insert(weldsuite_db::camel_case(&column), value);
    }
    Value::Object(out)
}

/// The timestamp columns most tables have.
pub(crate) const STAMPS: [&str; 3] = ["created_at", "updated_at", "deleted_at"];

/// A list without paging: `list(c, rows, cursorPagination(rows.length, false, null))`.
pub(crate) fn all(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}

/// `(set, value)` for an `update … set col = case when set then value …`:
/// a field the body left out keeps the column.
pub(crate) fn change<T: Clone>(field: &weldsuite_kit::validation::Field<T>) -> (bool, Option<T>) {
    use weldsuite_kit::validation::Field;
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}
