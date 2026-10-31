//! WeldSocial: social-api's routes (`apps/workers/social-api`): accounts
//! (and connecting them through PostPeer), posts (publish, schedule,
//! reschedule, cancel), campaigns, media, approvals, team members, settings
//! and analytics under `/api`, and PostPeer's delivery webhook at
//! `/public/social/postpeer/webhook`.
//!
//! The publishing service (PostPeer, credit metering, the post index) is
//! `weldsuite-social-domain`'s, which external-api and mcp-server share on
//! Global.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `social`
//! conformance suite (`rust/conformance/suites.json`).

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

/// The list statement of a table: `$1` skips the live-only condition, each
/// filter takes `(skip, value)`, the cursor `(skip, createdAt, id)`, then
/// the limit; and its count.
macro_rules! listing {
    ($table:literal; $($cond:literal),*; $a:literal, $b:literal, $c:literal; $limit:literal) => {
        (
            concat!(
                "select to_jsonb(t) from \"", $table, "\" t where ($1::boolean or t.deleted_at is null)",
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

mod accounts;
mod analytics;
mod approvals;
mod crud;
mod js;
mod objects;
mod posts;
mod settings;
mod table;
#[rustfmt::skip]
mod tables;
mod webhook;

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
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{
    BoxFuture, DynCache, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
    RequestCache,
};
use weldsuite_social_domain::publishing::Context;

pub use webhook::TenantDatabases;

/// What the WeldSocial handlers share.
#[derive(Clone)]
pub struct SocialState {
    pub events: EntityEventPublisher,
    /// The workspace cache (`WORKSPACE_CACHE`): the webhook's legacy post
    /// mapping. A request's `RequestCache` (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (credits, the PostPeer post index). A request's
    /// `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// PostPeer. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// A workspace's tenant database, by its Clerk org id, for the webhook.
    /// A request's `Tenant` (conformance) wins.
    pub tenants: Option<TenantDatabases>,
}

impl std::fmt::Debug for SocialState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SocialState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .finish_non_exhaustive()
    }
}

/// social-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers.
pub fn router<S, Q>(state: SocialState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/social-accounts", accounts::routes(gate))
        .nest("/social-analytics", analytics::routes(gate))
        .nest("/social-approvals", approvals::routes(gate))
        .nest("/social-campaigns", objects::campaigns(gate))
        .nest("/social-media", objects::media(gate))
        .nest("/social-posts", posts::routes(gate))
        .nest("/social-settings", settings::routes(gate))
        .nest("/social-team-members", objects::team_members(gate))
        .with_state(state)
}

/// PostPeer's delivery webhook, at its full path
/// (`/public/social/postpeer/webhook`), served ahead of the session: the
/// signature is its credential.
pub fn public_router<S>(state: SocialState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    webhook::router(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('clerkOrgId')`: the PostPeer profile and settings row key, and
    /// what credits resolve the workspace from.
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) events: EventContext,
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &SocialState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// `socialContext(c.env)`.
    pub(crate) fn context(&self, state: &SocialState) -> Context {
        let master = if self.env.is_some() {
            self.master.clone()
        } else {
            state.master.clone()
        };
        context(
            self.env.as_ref(),
            master,
            self.http.clone().or_else(|| state.http.clone()),
        )
    }

    #[allow(dead_code)]
    pub(crate) fn cache(&self, state: &SocialState) -> Option<Arc<dyn DynCache>> {
        if self.env.is_some() {
            return self.cache.clone();
        }
        state.cache.clone()
    }
}

/// `c.env.<name>`: the request's env (conformance), else the process's.
pub(crate) fn env_value(env: Option<&RequestEnv>, name: &str) -> Option<String> {
    match env {
        Some(env) => env.get(name).map(str::to_owned),
        None => std::env::var(name).ok(),
    }
    .filter(|value| !value.is_empty())
}

/// The publishing context from what a request has.
pub(crate) fn context(
    env: Option<&RequestEnv>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
) -> Context {
    Context {
        api_key: env_value(env, "POSTPEER_API_KEY"),
        base_url: env_value(env, "POSTPEER_BASE_URL"),
        app_ids: env_value(env, "POSTPEER_APP_IDS"),
        master,
        http: http.unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable))),
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
                user_id: auth.user_id.clone(),
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
            tracing::error!("social: a route without the session or tenant layer");
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

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[social-api] {message}");
    ApiError::internal().with_message(message).into_response()
}
