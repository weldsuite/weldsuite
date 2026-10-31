//! WeldCommerce: commerce-api's routes (`apps/workers/commerce-api`), at the
//! paths it serves under `/api` (products and their sales channels,
//! categories, orders with their sales tax, parcels, shipments, pickups,
//! returns, return reasons and rules, shipping rules and prices, carriers,
//! parcel analytics, notifications, rates, settings and wallet, Sendcloud,
//! PrintNode, the commerce portal's staff side), and its public routes: the
//! B2B commerce portal (`/public/commerce-portal`) and the WooCommerce auth
//! callback (`/webhooks/woocommerce`).
//!
//! What the helpdesk widget API also needs (portal tokens, the atomic rate
//! limits) lives in `weldsuite-commerce-domain`. Pieces of WeldBooks (the
//! sales tax engines, the invoice HTML) and of WeldConnect (the connector
//! product clients, credentials) that commerce-api imports are ported here as
//! private modules, until those modules have their own crates.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `commerce`
//! conformance suites (`rust/conformance/suites.json`).

/// The keyset condition at parameters `$a` (skip), `$b` (createdAt), `$c` (id).
macro_rules! cursor {
    ($a:literal, $b:literal, $c:literal) => {
        concat!(
            "($",
            $a,
            "::boolean or (t.created_at < $",
            $b,
            "::timestamp or (t.created_at = $",
            $b,
            "::timestamp and t.id < $",
            $c,
            "::text)))"
        )
    };
}

/// The list statement of a table with filter slots: `$1` skips the
/// live-only condition, each filter takes `(skip, value)`, the cursor
/// `(skip, createdAt, id)`, then the limit. `$row` is the row expression.
macro_rules! listing_as {
    ($row:expr; $table:literal; $($cond:literal),*; $a:literal, $b:literal, $c:literal; $limit:literal) => {
        (
            concat!(
                "select ", $row, " from \"", $table, "\" t where ($1::boolean or t.deleted_at is null)",
                $(" and ", $cond,)*
                " and ", cursor!($a, $b, $c),
                " order by t.created_at desc, t.id desc limit ", $limit
            ),
            concat!(
                "select count(*) from \"", $table, "\" t where ($1::boolean or t.deleted_at is null)",
                $(" and ", $cond,)*
                " and ", cursor!($a, $b, $c)
            ),
        )
    };
}

#[macro_use]
#[rustfmt::skip]
mod tables;
mod crud;
mod invoice_html;
mod js;
mod orders;
mod products;
mod sales_tax;
mod sendcloud;
mod simple;
mod table;

use std::collections::HashMap;
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
use weldsuite_commerce_domain::rate_limit::{RateLimitCounters, RequestRateLimiter};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynCache, DynSystemMail, OutboundHttp, RequestCache};

/// What the commerce handlers share.
#[derive(Clone)]
pub struct CommerceState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): portal challenges and
    /// sessions, the portal's slug cache. A request's `RequestCache`
    /// (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// System mail (the portal's sign-in emails); without it they are
    /// skipped, as the worker does without `SEND_EMAIL`.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Third-party HTTP (the stores of a sales channel, Sendcloud, the sales
    /// tax engines, a webhook's test delivery). A request's `OutboundHttp`
    /// (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// The portal's rate-limit counters (`PORTAL_RATE_LIMITER`). A request's
    /// `RequestRateLimiter` (conformance) wins.
    pub limiter: Option<Arc<dyn RateLimitCounters>>,
    /// The master database (workspace slugs). A request's `MasterDb`
    /// (conformance) wins.
    pub master: Option<PgPool>,
    /// Opens a workspace's tenant database for the public portal.
    pub workspaces: Option<Arc<weldsuite_db::Workspaces>>,
    /// The worker's env values this crate reads (`ENVIRONMENT`,
    /// `COMMERCE_PORTAL_URL`, `DATABASE_ENCRYPTION_KEY(_V2)`,
    /// `INTERNAL_API_SECRET`, …). A request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
}

impl std::fmt::Debug for CommerceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommerceState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("mail", &self.mail.is_some())
            .field("http", &self.http.is_some())
            .field("limiter", &self.limiter.is_some())
            .finish_non_exhaustive()
    }
}

/// The env names [`CommerceState::env`] holds, read from the process.
pub const ENV_NAMES: &[&str] = &[
    "ENVIRONMENT",
    "COMMERCE_PORTAL_URL",
    "DATABASE_ENCRYPTION_KEY",
    "DATABASE_ENCRYPTION_KEY_V2",
    "INTERNAL_API_SECRET",
    "CONNECTOR_WEBHOOK_BASE_URL",
];

/// [`ENV_NAMES`] from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    ENV_NAMES
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_owned(), v)))
        .collect()
}

/// commerce-api's authenticated routes, relative to `/api` (`/carriers`,
/// `/products`, …), to merge under `/api` behind the session, tenant
/// database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: CommerceState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/carriers", crud::routes(&simple::CARRIERS, gate))
        .nest("/orders", orders::routes(gate))
        .nest("/parcels", crud::routes(&simple::PARCELS, gate))
        .nest("/products", products::routes(gate))
        .nest("/sendcloud", sendcloud::routes(gate))
        .nest("/pickups", crud::routes(&simple::PICKUPS, gate))
        .nest("/return-reasons", crud::routes(&simple::RETURN_REASONS, gate))
        .nest("/return-rules", crud::routes(&simple::RETURN_RULES, gate))
        .nest("/returns", crud::routes(&simple::RETURNS, gate))
        .nest("/shipments", crud::routes(&simple::SHIPMENTS, gate))
        .nest("/shipping-prices", crud::routes(&simple::SHIPPING_PRICES, gate))
        .nest("/shipping-rules", crud::routes(&simple::SHIPPING_RULES, gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
#[allow(dead_code)] // filled in route group by route group
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

/// What conformance builds hand a request in place of the state's.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) cache: Option<RequestCache>,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) limiter: Option<RequestRateLimiter>,
    pub(crate) master: Option<weldsuite_db::MasterDb>,
}

impl Overrides {
    pub(crate) fn from_parts(parts: &Parts) -> Self {
        Self {
            env: parts.extensions.get::<RequestEnv>().cloned(),
            cache: parts.extensions.get::<RequestCache>().cloned(),
            http: parts.extensions.get::<OutboundHttp>().cloned(),
            limiter: parts.extensions.get::<RequestRateLimiter>().cloned(),
            master: parts.extensions.get::<weldsuite_db::MasterDb>().cloned(),
        }
    }

    /// `c.env.<name>`: the request's env first (conformance), then the state's.
    pub(crate) fn env(&self, state: &CommerceState, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        state.env.get(name).cloned()
    }

    /// The workspace cache: the request's (conformance), else the state's.
    pub(crate) fn kv(&self, state: &CommerceState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| state.cache.clone())
    }

    /// Third-party HTTP: the request's (conformance), else the state's.
    pub(crate) fn http(&self, state: &CommerceState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// The portal's rate-limit counters: the request's (conformance, which
    /// may be none), else the state's.
    pub(crate) fn limiter(&self, state: &CommerceState) -> Option<Arc<dyn RateLimitCounters>> {
        match &self.limiter {
            Some(own) => own.0.clone(),
            None => state.limiter.clone(),
        }
    }

    /// The master database: the request's (conformance), else the state's.
    pub(crate) fn master(&self, state: &CommerceState) -> Option<PgPool> {
        self.master
            .as_ref()
            .map(|master| master.0.clone())
            .or_else(|| state.master.clone())
    }

    /// `keyringFromEnv(env)`.
    pub(crate) fn keyring(&self, state: &CommerceState) -> weldsuite_db::Keyring {
        let key = |name: &str| self.env(state, name).filter(|v| !v.is_empty());
        weldsuite_db::Keyring {
            v1: key("DATABASE_ENCRYPTION_KEY"),
            v2: key("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }
}

#[allow(dead_code)] // filled in route group by route group
impl Caller {
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

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
        let caller =
            if let (Some(auth), Some(tenant), Some(permissions)) = (auth, tenant, permissions) {
                Ok(Self {
                    db: tenant.db.clone(),
                    user_id: auth.user_id.clone(),
                    workspace_id: tenant.workspace_id.clone(),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .unwrap_or_else(|| tenant.workspace_id.clone()),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    overrides: Overrides::from_parts(parts),
                })
            } else {
                tracing::error!("commerce: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 404, a validation failure), or a database error the route maps to
/// its 500 with its own message.
#[allow(dead_code)] // filled in route group by route group
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

impl From<Response> for Refusal {
    fn from(response: Response) -> Self {
        Self::Response(Box::new(response))
    }
}

#[allow(dead_code)] // filled in route group by route group
impl Refusal {
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    /// The response; a database error is logged and answered with a 500
    /// carrying `fallback` (`error.internal(c, fallback)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[commerce-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
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

/// A list without paging: `list(c, rows, cursorPagination(rows.length, false, null))`.
#[allow(dead_code)] // filled in route group by route group
pub(crate) fn all(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}
