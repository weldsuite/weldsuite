//! WeldCommerce (`weldsuite-commerce`): the rebuilt catalogue and order book,
//! a Rust-only module on the EU edition (ADR COM-009; design in
//! `weldsuite-documentation/design/modules/weldcommerce.md`, plan in
//! `weldsuite-documentation/plans/weldcommerce-rebuild.md`).
//!
//! Phase 0 serves the module overview (`/api/commerce/overview`). Phase 1 is
//! the catalogue:
//!
//! - `/api/products` ([`products`]): moved here from `weldsuite-stash` with
//!   its behaviour unchanged. The prefix stays the `stash` module's in
//!   `@weldsuite/api-modules` while Global's stash-api serves it, and the
//!   "stash: products" conformance suite still runs against this crate.
//! - `/api/products/:id/variants` ([`variants`]): the option matrix, SKUs and
//!   barcodes unique among live products and variants.
//! - `/api/categories` ([`categories`]): the tree, manual members and
//!   automated categories evaluated on read ([`rules`]; ADR COM-010
//!   re-adopting COM-001 and COM-002).
//!
//! Phase 2 is the order book: `/api/orders` ([`orders`]), `/api/discounts`
//! ([`discounts`]) and `/api/commerce-settings` ([`settings`]). Every order
//! write goes through `weldsuite-commerce-domain` (ADR COM-010).
//!
//! Phase 4 (staff side): sales channels `/api/commerce-channels` ([`channels`]:
//! keys, shipping rates), a product's prices per currency
//! `/api/products/:id/prices` ([`prices`]) and the master key registry they
//! write ([`StorefrontRegistry`]).
//!
//! Phase 5 is payments (Mollie, ADR COM-013): the workspace's connection
//! `/api/commerce-payments`, the payments, refunds and invoice of an order
//! (`/api/orders/:id/payments` …), Mollie's webhook and the OAuth callback
//! ([`payments_public_router`]) and Mollie at storefront checkout.
//!
//! Everything but the products route is Rust only, with no TypeScript worker
//! to compare it with and so no conformance suite: those routes have their
//! own tests in `tests/`.

#[macro_use]
#[rustfmt::skip]
mod tables;
mod args;
mod buyers;
mod categories;
mod channels;
mod config;
mod decide;
mod discounts;
mod js;
mod mail;
mod orders;
mod overview;
mod payments;
mod prices;
mod products;
mod rules;
mod settings;
pub mod storefront;
mod table;
mod variants;
mod wire;

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
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::OutboundHttp;

pub use config::PaymentsConfig;
pub use payments::{PaymentsPublicState, public_router as payments_public_router};

use crate::table::WriteError;

/// The master database, where the storefront key registry lives
/// (`storefront_key_registry`). The server adds it to the commerce routes as
/// a request extension; without it the key routes answer 503.
#[derive(Clone, Debug)]
pub struct StorefrontRegistry(pub PgPool);

/// What the commerce handlers share.
#[derive(Clone)]
pub struct CommerceState {
    /// Entity events (`publishEntityEvent`).
    pub events: EntityEventPublisher,
    /// Third-party HTTP, for VIES (the buyer's VAT number). Without it VIES
    /// reads as unavailable: the buyer is charged as a consumer and the
    /// order is flagged.
    pub http: Option<OutboundHttp>,
    /// Payments (phase 5): credentials, public URLs, Mollie Connect, WeldBooks.
    pub payments: PaymentsConfig,
    /// System mail (buyer invitations, approval decisions); without it
    /// nothing is sent.
    pub mail: mail::Mail,
}

impl std::fmt::Debug for CommerceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommerceState")
            .field("mail", &self.mail.is_some())
            .finish_non_exhaustive()
    }
}

/// WeldCommerce's routes, relative to `/api` (`/commerce/overview`,
/// `/products`, `/categories`, …), to merge under `/api` behind the session,
/// tenant database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: CommerceState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/commerce", overview::routes(gate))
        .nest("/products", products::routes(gate))
        .nest("/categories", categories::routes(gate))
        .nest("/orders", orders::routes(gate))
        .nest("/discounts", discounts::routes(gate))
        .nest("/commerce-settings", settings::routes(gate))
        .nest("/commerce-buyers", buyers::routes(gate))
        .nest("/commerce-channels", channels::routes(gate))
        .nest("/commerce-company-settings", buyers::settings_routes(gate))
        .nest("/commerce-payments", payments::routes(gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    /// `workspaces.id` (`ws_...`, ADR SEC-011).
    pub(crate) workspace_id: String,
    /// The master database, when the server provides one.
    pub(crate) registry: Option<PgPool>,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CommerceState,
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
        let caller = if let (Some(auth), Some(tenant), Some(permissions)) =
            (auth, tenant, permissions)
        {
            Ok(Self {
                db: tenant.db.clone(),
                workspace_id: tenant.workspace_id.clone(),
                registry: parts
                    .extensions
                    .get::<StorefrontRegistry>()
                    .map(|registry| registry.0.clone()),
                user_id: auth.user_id.clone(),
                permissions: permissions.clone(),
                events: EventContext::for_request(auth, tenant),
            })
        } else {
            tracing::error!("commerce: a route without the session, tenant or permission layer");
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

/// A 500 with `message`, after logging what failed.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[commerce] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp`.
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

/// `zValidator('query', schema)`: the query string read by `read`, or the
/// 400 with the schema's issues.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let fields = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &fields);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}
