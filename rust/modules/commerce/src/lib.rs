//! WeldCommerce (`weldsuite-commerce`): the rebuilt catalogue and order book,
//! a Rust-only module on the EU edition (ADR COM-009; design in
//! `weldsuite-documentation/design/modules/weldcommerce.md`, plan in
//! `weldsuite-documentation/plans/weldcommerce-rebuild.md`).
//!
//! There is no TypeScript worker to compare it with, so no conformance
//! suite: every route has its own tests in `tests/`.
//!
//! Phase 0 serves the module overview (`/api/commerce/overview`). The
//! catalogue, orders, storefront and payments follow in later phases.

#![allow(
    clippy::disallowed_methods,
    reason = "not converted to the ORM yet (ADR DATA-019)"
)]

mod overview;

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::ApiError;
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

/// What the commerce handlers share.
#[derive(Clone, Debug)]
pub struct CommerceState {
    /// Entity events (`publishEntityEvent`); the overview publishes none,
    /// the writes of the next phases do.
    pub events: EntityEventPublisher,
}

/// WeldCommerce's routes, relative to `/api` (`/commerce/overview`, …), to
/// merge under `/api` behind the session, tenant database, licence and flag
/// layers. Each route carries its `requirePermission` from `gate`.
pub fn router<S, Q>(state: CommerceState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/commerce", overview::routes(gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) permissions: Permissions,
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
        let caller = if let (Some(_), Some(tenant), Some(permissions)) = (auth, tenant, permissions)
        {
            Ok(Self {
                db: tenant.db.clone(),
                permissions: permissions.clone(),
            })
        } else {
            tracing::error!("commerce: a route without the session, tenant or permission layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A 500 with `message`, after logging what failed.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[commerce] {message}");
    ApiError::internal().with_message(message).into_response()
}
