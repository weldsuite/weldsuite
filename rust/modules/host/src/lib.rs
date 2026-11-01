//! WeldHost: host-api's routes (`apps/workers/host-api`): domains (search,
//! availability, checkout, registration polling, external domains and their
//! ownership check, registrar toggles, sync, auth codes), DNS zones, DNS
//! records (Cloudflare is their source of truth), domain transfers and
//! email forwards under `/api`, and Realtime Register's process webhook at
//! `/public/webhooks/realtime-register`.
//!
//! Providers, all reached over the outbound HTTP port (the test's fetch stub
//! in conformance):
//!
//! - registration, transfers and registrar state: Realtime Register's REST
//!   API and its ADAC availability checker ([`registrar`]);
//! - DNS hosting: Cloudflare's zones and DNS records API, behind
//!   [`dns_host::DnsHost`] so another provider can be plugged in; the
//!   legacy Cloudflare Registrar only for `registrar = 'cloudflare'` rows
//!   ([`cloudflare`]);
//! - DNS lookups (ownership TXT records, the record scan): DNS over HTTPS
//!   ([`doh`]).
//!
//! Billing is Global's: Stripe is never configured here, so the checkout
//! and renewal routes answer what the worker answers without
//! `STRIPE_SECRET_KEY`, abandoning a checkout expires no session, and
//! turning auto-renew off voids no invoice (feature `domain-purchase`).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `host`
//! conformance suite (`rust/conformance/suites.json`).

mod cloudflare;
mod cron;
mod dns_host;
mod dns_records;
mod dns_sync;
mod dns_zones;
mod doh;
mod domains;
mod email_forwards;
mod js;
mod listing;
mod registrar;
mod renew_due;
mod rows;
mod transfers;
mod webhook;
mod weldreach;

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
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{
    BoxFuture, DynCache, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
    RequestCache,
};

pub use cron::{AutoRenewResult, run_domain_auto_renew};

/// A workspace's tenant database, by its Clerk org id or `workspaces.id`
/// (`getTenantDbForWorkspace`), with the workspace's `workspaces.id`.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<(PgPool, String), String>> + Send + Sync>;

/// What the WeldHost handlers share.
#[derive(Clone)]
pub struct HostState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): Realtime Register process
    /// mappings. A request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database: TLD pricing and the auto-renew due index. A
    /// request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// Realtime Register, Cloudflare and DNS over HTTPS. A request's
    /// `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// A workspace's tenant database, for the webhook. A request's `Tenant`
    /// (conformance) wins.
    pub tenants: Option<TenantDatabases>,
}

impl std::fmt::Debug for HostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .finish_non_exhaustive()
    }
}

/// host-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers. Writes to `/domains` and
/// `/domain-transfers` mark the workspace due for the auto-renew sweep.
pub fn router<S, Q>(state: HostState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let due = axum::middleware::from_fn_with_state(state.clone(), renew_due::mark);
    Router::new()
        .nest("/dns-records", dns_records::routes(gate))
        .nest("/dns-zones", dns_zones::routes(gate))
        .nest(
            "/domain-transfers",
            transfers::routes(gate).layer(due.clone()),
        )
        .nest("/domains", domains::routes(gate).layer(due))
        .nest("/email-forwards", email_forwards::routes(gate))
        .with_state(state)
}

/// Realtime Register's process webhook, at its full path
/// (`/public/webhooks/realtime-register`), served ahead of the session: the
/// shared `?token=` is its credential.
pub fn public_router<S>(state: HostState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    webhook::router(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    /// `c.get('clerkOrgId')`: the key of the process mapping the webhook reads.
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) events: EventContext,
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(&self, state: &HostState, event: EventName, entity_id: &str, data: &Value) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// The request's providers and settings.
    pub(crate) fn providers(&self, state: &HostState) -> Providers {
        Providers::new(
            self.env.as_ref(),
            self.http.clone().or_else(|| state.http.clone()),
        )
    }

    /// The master database (`getMasterDb(c.env)`): the test's in
    /// conformance, else the app's.
    pub(crate) fn master(&self, state: &HostState) -> Option<PgPool> {
        if self.env.is_some() {
            return self.master.clone();
        }
        state.master.clone()
    }

    /// `c.env.WORKSPACE_CACHE`: the test's in conformance, else the app's.
    pub(crate) fn cache(&self, state: &HostState) -> Option<Arc<dyn DynCache>> {
        if self.env.is_some() {
            return self.cache.clone();
        }
        state.cache.clone()
    }
}

/// `c.env.<name>`: the request's env (conformance), else the process's.
/// An empty value reads as unset.
pub(crate) fn env_value(env: Option<&RequestEnv>, name: &str) -> Option<String> {
    match env {
        Some(env) => env.get(name).map(str::to_owned),
        None => std::env::var(name).ok(),
    }
    .filter(|value| !value.is_empty())
}

/// The third parties a request reaches, configured from its env.
#[derive(Clone)]
pub(crate) struct Providers {
    pub(crate) http: OutboundHttp,
    /// `getRealtimeRegistrar(c.env)`.
    pub(crate) rtr: Option<registrar::RealtimeRegistrar>,
    /// `CLOUDFLARE_API_TOKEN`.
    pub(crate) cf_token: Option<String>,
    /// `CLOUDFLARE_ACCOUNT_ID ?? CF_ACCOUNT_ID`.
    pub(crate) cf_account: Option<String>,
    /// The platform contact handles (`REALTIME_REGISTER_CONTACT_*`).
    pub(crate) contacts: registrar::ContactEnv,
}

impl Providers {
    pub(crate) fn new(env: Option<&RequestEnv>, http: Option<OutboundHttp>) -> Self {
        let http = http.unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable)));
        let value = |name: &str| env_value(env, name);
        Self {
            rtr: registrar::RealtimeRegistrar::from_env(&value, http.clone()),
            cf_token: value("CLOUDFLARE_API_TOKEN"),
            cf_account: value("CLOUDFLARE_ACCOUNT_ID").or_else(|| value("CF_ACCOUNT_ID")),
            contacts: registrar::ContactEnv {
                admin: value("REALTIME_REGISTER_CONTACT_ADMIN"),
                tech: value("REALTIME_REGISTER_CONTACT_TECH"),
                billing: value("REALTIME_REGISTER_CONTACT_BILLING"),
            },
            http,
        }
    }

    /// The DNS host (Cloudflare) with the configured token.
    pub(crate) fn dns(&self, token: &str) -> dns_host::Dns {
        Arc::new(cloudflare::CloudflareDns::new(self.http.clone(), token))
    }

    /// `getCloudflareRegistrar(c.env)`: the legacy registrar, for
    /// `registrar = 'cloudflare'` rows only.
    pub(crate) fn cf_registrar(&self) -> Option<cloudflare::CloudflareRegistrar> {
        let token = self.cf_token.clone()?;
        let account = self.cf_account.clone()?;
        Some(cloudflare::CloudflareRegistrar::new(
            self.http.clone(),
            &token,
            &account,
        ))
    }
}

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
struct Unreachable;

impl DynOutboundHttp for Unreachable {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend(
            "no outbound HTTP client",
        ))))
    }
}

/// Behind the session and tenant database layers; without them it is a
/// routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        let caller = if let (Some(auth), Some(tenant)) =
            (extensions.get::<AuthContext>(), extensions.get::<Tenant>())
        {
            Ok(Self {
                db: tenant.db.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                events: EventContext::for_request(auth, tenant),
                env: extensions.get::<RequestEnv>().cloned(),
                cache: extensions
                    .get::<RequestCache>()
                    .map(|cache| Arc::clone(&cache.0)),
                master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
                http: extensions.get::<OutboundHttp>().cloned(),
            })
        } else {
            tracing::error!("host: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// `new Date()` as Drizzle writes it.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Box<Response>> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| Box::new(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    value.ok_or_else(|| Box::new(ApiError::internal().into_response()))
}

/// `zValidator('query', schema)`: the query read by `read`, or the 400.
pub(crate) fn validate_query<T>(
    raw: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Box<Response>> {
    let query = query_values(raw);
    let mut issues = Issues::default();
    let value = read(&mut issues, &query);
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    Ok(value)
}

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[host-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// An error envelope with any status and code.
pub(crate) fn error_response(status: http::StatusCode, code: &str, message: &str) -> Response {
    ApiError::new(status, code.to_owned(), message).into_response()
}

/// A body answered as it is (`c.json(body, status)`).
pub(crate) fn json_response(status: http::StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}
