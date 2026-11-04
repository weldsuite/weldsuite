//! WeldStash, the WMS: stash-api's routes (`apps/workers/stash-api`), at the
//! paths it serves under `/api`: warehouses, zones and locations, stock
//! buckets and the inventory ledger behind every quantity change, movements,
//! stock adjustments, putaway tasks, pick lists (generate from an order,
//! scan-confirm, pack, ship through Sendcloud), pickers, suppliers, purchase
//! orders, cycle counts, boxes and the activity log.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `stash`
//! conformance suites (`rust/conformance/suites.json`).

mod activity;
mod args;
mod crud;
mod inventory;
mod js;
mod ledger;
mod pick_lists;
mod pickers;
mod picking;
mod putaway;
mod rows;
mod sendcloud;
mod stock_adjustments;
mod table;
#[rustfmt::skip]
mod tables;

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
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::OutboundHttp;

use crate::table::WriteError;

/// What the stash handlers share.
#[derive(Clone)]
pub struct StashState {
    pub events: EntityEventPublisher,
    /// Sendcloud calls (the pick-list ship action). A request's
    /// `OutboundHttp` (conformance) wins; without either, a ship that needs
    /// a carrier fails as an unreachable Sendcloud does.
    pub http: Option<OutboundHttp>,
}

impl std::fmt::Debug for StashState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StashState")
            .field("events", &self.events)
            .field("http", &self.http.is_some())
            .finish()
    }
}

/// stash-api's routes, relative to `/api` (`/warehouses`, `/inventory`,
/// `/pick-lists`, …), to merge under `/api` behind the session, tenant
/// database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: StashState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/boxes", crud::routes(&crud::BOXES, gate))
        .nest("/cycle-counts", crud::routes(&crud::CYCLE_COUNTS, gate))
        .nest("/inventory", inventory::routes(gate))
        .nest(
            "/inventory-movements",
            crud::routes(&crud::INVENTORY_MOVEMENTS, gate),
        )
        .nest("/pick-lists", pick_lists::routes(gate))
        .nest("/pickers", pickers::routes(gate))
        .nest(
            "/purchase-orders",
            crud::routes(&crud::PURCHASE_ORDERS, gate),
        )
        .nest("/putaway", putaway::routes(gate))
        .nest(
            "/warehouse-locations",
            crud::routes(&crud::WAREHOUSE_LOCATIONS, gate),
        )
        .nest("/warehouses", crud::routes(&crud::WAREHOUSES, gate))
        .nest(
            "/warehouse-zones",
            crud::routes(&crud::WAREHOUSE_ZONES, gate),
        )
        .nest("/wms-suppliers", crud::routes(&crud::SUPPLIERS, gate))
        .nest("/wms-activity", activity::routes(gate))
        .nest("/stock-adjustments", stock_adjustments::routes(gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('clerkOrgId')`: the key of the workspace's
    /// `workspace_settings` row (the Sendcloud keys live there).
    pub(crate) clerk_org_id: String,
    pub(crate) events: EventContext,
    /// The test's env (conformance), read before the process's.
    pub(crate) env: Option<RequestEnv>,
    /// The test's fetch stub (conformance), before the state's client.
    pub(crate) http: Option<OutboundHttp>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &StashState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// Several `publishEntityEvent` calls in a row, kept in that order: each
    /// [`Caller::publish`] is its own task, and the runtime may run a later
    /// one first. Still fire and forget.
    pub(crate) fn publish_in_order(
        &self,
        state: &StashState,
        events: Vec<(EventName, String, Value)>,
    ) {
        let publisher = state.events.clone();
        let context = self.events.clone();
        state.events.tracker().spawn(async move {
            for (event, entity_id, data) in events {
                publisher
                    .publish_and_wait(
                        &context,
                        weldsuite_events::EntityEvent::new(event, entity_id, data),
                    )
                    .await;
            }
        });
    }

    /// `c.env.<name>`: the request's env first (conformance), then the
    /// process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        std::env::var(name).ok()
    }

    /// The HTTP client: the request's (conformance), else the state's.
    pub(crate) fn http(&self, state: &StashState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
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
        let caller = if let (Some(auth), Some(tenant), Some(_)) = (auth, tenant, permissions) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                clerk_org_id: tenant
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| tenant.workspace_id.clone()),
                events: EventContext::for_request(auth, tenant),
                env: parts.extensions.get::<RequestEnv>().cloned(),
                http: parts.extensions.get::<OutboundHttp>().cloned(),
            })
        } else {
            tracing::error!("stash: a route without the session, tenant or permission layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 404, 409, a validation failure), or a statement that failed, which
/// the route maps to its 500 with its own message.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
    Write(WriteError),
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<WriteError> for Refusal {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
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

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    /// The response; a failed statement is logged and answered with a 500
    /// carrying `fallback` (`error.internal(c, fallback)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => internal(&error, fallback),
            Self::Write(error) => internal(&error, fallback),
        }
    }
}

/// `error.internal(c, message)`, after logging what failed.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[stash-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp` (or `::timestamptz`).
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
