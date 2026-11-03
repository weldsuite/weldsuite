//! WeldCall: call-api's routes (`apps/workers/call-api`): calls
//! (`/api/calls`), call intelligence (`/api/call-intelligence`: phone
//! numbers, the WebRTC token, statistics, call transcriptions), the WeldDesk
//! phone channel (`/api/desk/phone`: voice agents and inbound routes), number
//! porting (`/api/porting`), telephony (`/api/telephony`: searching, syncing
//! and pricing numbers, addresses, regulatory requirements), billing-worker's
//! phone-number fulfilment (`/api/internal/telephony`) and the Telnyx Call
//! Control webhook with its AI assistant tool (`/public/webhooks/telnyx`).
//!
//! Telnyx is a third-party API that answers from anywhere: every call goes
//! through the outbound HTTP port, and its webhook signatures (Ed25519) are
//! checked as the worker checks them. Buying a number and submitting a port
//! are Stripe checkouts through Global's billing-worker, which the
//! Kubernetes editions don't have: those steps answer as the worker does
//! when billing-worker cannot be reached (and fulfilment as it does without
//! Stripe), and `/config.json` lists `phone-number-purchase` as unavailable.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `call`
//! conformance suites (`rust/conformance/suites.json`).

mod calls;
mod credits;
mod crm;
mod desk_phone;
mod intelligence;
mod internal;
mod js;
mod numbers;
mod porting;
mod registry;
mod telephony;
mod telnyx;
mod tool_auth;
mod webhook;

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
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    ACTIVITIES_CREATE, ACTIVITIES_DELETE, ACTIVITIES_READ, ACTIVITIES_UPDATE, CONVERSATIONS_READ,
    CONVERSATIONS_UPDATE, SETTINGS_MANAGE, TELEPHONY_MANAGE, TELEPHONY_READ,
};
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{
    BoxFuture, DynFileStore, DynOutboundHttp, DynRealtimePublisher, HttpRequest, HttpResponse,
    OutboundHttp, PortError, StorageBuckets,
};

/// A workspace's tenant database, by its Clerk org id
/// (`getTenantDbForWorkspace`), for the routes that find the workspace
/// themselves (the Telnyx webhook and its tool).
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// What the WeldCall handlers share.
#[derive(Clone)]
pub struct CallState {
    pub events: EntityEventPublisher,
    /// The master database: credits, the phone number registry, the Telnyx
    /// porting index and the telephony price list. A request's `MasterDb`
    /// (conformance) wins.
    pub master: Option<PgPool>,
    /// Telnyx's API. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// The `STORAGE` bucket (porting documents). A request's
    /// `StorageBuckets` (conformance) wins.
    pub storage: Option<Arc<dyn DynFileStore>>,
    /// Realtime fan-out of the phone channel's desk messages (`REALTIME`).
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Workspaces' tenant databases for the webhook. A request's `Tenant`
    /// (conformance) wins.
    pub tenants: Option<TenantDatabases>,
}

impl std::fmt::Debug for CallState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallState")
            .field("events", &self.events)
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .field("storage", &self.storage.is_some())
            .field("realtime", &self.realtime.is_some())
            .finish_non_exhaustive()
    }
}

/// call-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
#[allow(clippy::too_many_lines)] // one route per line, as the worker registers them
pub fn router<S, Q>(state: CallState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let activities_read = || gate.require([ACTIVITIES_READ]);
    let activities_create = || gate.require([ACTIVITIES_CREATE]);
    let activities_update = || gate.require([ACTIVITIES_UPDATE]);
    let activities_delete = || gate.require([ACTIVITIES_DELETE]);
    let telephony_read = || gate.require([TELEPHONY_READ]);
    let telephony_manage = || gate.require([TELEPHONY_MANAGE]);
    let settings_manage = || gate.require([SETTINGS_MANAGE]);
    let conversations_read = || gate.require([CONVERSATIONS_READ]);
    let calls = Router::new()
        .route("/", get(calls::list).route_layer(activities_read()))
        .route("/", post(calls::create).route_layer(activities_create()))
        .route(
            "/contact-stats",
            get(calls::contact_stats).route_layer(activities_read()),
        )
        .route("/{id}", get(calls::detail).route_layer(activities_read()))
        .route("/{id}", put(calls::update).route_layer(activities_update()))
        .route(
            "/{id}",
            delete(calls::remove).route_layer(activities_delete()),
        );
    let intelligence = Router::new()
        .route(
            "/phone-numbers",
            get(intelligence::list_numbers).route_layer(activities_read()),
        )
        .route(
            "/phone-numbers",
            post(intelligence::create_number).route_layer(activities_create()),
        )
        .route(
            "/phone-numbers/{id}",
            patch(intelligence::update_number).route_layer(activities_update()),
        )
        .route(
            "/phone-numbers/{id}",
            delete(intelligence::delete_number).route_layer(activities_delete()),
        )
        .route(
            "/token",
            post(intelligence::token).route_layer(activities_read()),
        )
        .route(
            "/stats",
            get(intelligence::stats).route_layer(activities_read()),
        )
        .route(
            "/calls/{id}/transcription",
            get(intelligence::transcription).route_layer(activities_read()),
        )
        .route(
            "/calls/{id}/transcription",
            post(intelligence::create_transcription).route_layer(activities_create()),
        )
        .route(
            "/calls/{id}/transcription/status",
            get(intelligence::transcription_status).route_layer(activities_read()),
        );
    let desk_phone = Router::new()
        .route(
            "/agents",
            get(desk_phone::list_agents).route_layer(conversations_read()),
        )
        .route(
            "/agents",
            post(desk_phone::create_agent).route_layer(settings_manage()),
        )
        .route(
            "/agents/{id}",
            get(desk_phone::agent).route_layer(conversations_read()),
        )
        .route(
            "/agents/{id}",
            patch(desk_phone::update_agent).route_layer(settings_manage()),
        )
        .route(
            "/agents/{id}",
            delete(desk_phone::delete_agent).route_layer(settings_manage()),
        )
        .route(
            "/routes",
            get(desk_phone::list_routes).route_layer(conversations_read()),
        )
        .route(
            "/routes",
            put(desk_phone::upsert_route).route_layer(settings_manage()),
        )
        .route(
            "/forward-live",
            post(desk_phone::forward_live).route_layer(gate.require([CONVERSATIONS_UPDATE])),
        );
    let porting = Router::new()
        .route("/preflight", post(porting::preflight))
        .route("/", post(porting::create).get(porting::list))
        .route(
            "/{id}",
            patch(porting::update)
                .get(porting::detail)
                .delete(porting::cancel),
        )
        .route("/{id}/loa-template", post(porting::loa_template))
        .route(
            "/{id}/loa",
            post(porting::upload_loa).layer(porting::upload_limit()),
        )
        .route(
            "/{id}/bill-copy",
            post(porting::upload_bill_copy).layer(porting::upload_limit()),
        )
        .route("/{id}/submit", post(porting::submit))
        .route("/{id}/refresh", post(porting::refresh))
        .route_layer(telephony_manage());
    let telephony = Router::new()
        .route(
            "/configured",
            get(telephony::configured).route_layer(telephony_read()),
        )
        .route(
            "/phone-numbers/search",
            post(telephony::search).route_layer(telephony_manage()),
        )
        .route(
            "/phone-numbers/provision",
            post(telephony::provision).route_layer(telephony_manage()),
        )
        .route(
            "/phone-numbers/sync",
            post(telephony::sync).route_layer(telephony_manage()),
        )
        .route(
            "/phone-numbers/{id}",
            put(telephony::update_number)
                .delete(telephony::delete_number)
                .route_layer(telephony_manage()),
        )
        .route(
            "/phone-numbers/{id}/set-default",
            post(telephony::set_default).route_layer(telephony_manage()),
        )
        .route(
            "/phone-numbers/{id}/regulatory-requirements",
            get(telephony::order_requirements).route_layer(telephony_read()),
        )
        .route(
            "/phone-numbers/{id}/regulatory-requirements",
            post(telephony::submit_order_requirements).route_layer(telephony_manage()),
        )
        .route(
            "/addresses",
            get(telephony::addresses).route_layer(telephony_read()),
        )
        .route(
            "/addresses",
            post(telephony::create_address).route_layer(telephony_manage()),
        )
        .route(
            "/bundles",
            get(telephony::bundles).route_layer(telephony_read()),
        )
        .route(
            "/requirements",
            get(telephony::requirements).route_layer(telephony_read()),
        )
        .route(
            "/documents",
            post(telephony::upload_document)
                .layer(porting::upload_limit())
                .route_layer(telephony_manage()),
        )
        .route(
            "/pricing",
            get(telephony::pricing).route_layer(telephony_read()),
        )
        .route(
            "/service-rates",
            get(telephony::service_rates).route_layer(telephony_read()),
        )
        .route(
            "/address-required/{country_code}",
            get(telephony::address_required_for).route_layer(telephony_read()),
        );
    Router::new()
        .nest("/calls", calls)
        .nest("/call-intelligence", intelligence)
        .nest("/desk/phone", desk_phone)
        .nest("/porting", porting)
        .nest("/telephony", telephony)
        .with_state(state)
}

/// The routes call-api mounts ahead of Clerk, at their full paths:
/// billing-worker's phone-number fulfilment (`/api/internal/telephony`,
/// behind `INTERNAL_API_SECRET`) and the Telnyx webhook
/// (`/public/webhooks/telnyx`, behind Telnyx's signature, and its tool
/// behind the tool token).
pub fn public_router<S>(state: CallState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route(
            "/api/internal/telephony/fulfill-number",
            post(internal::fulfill_number),
        )
        .route(
            "/public/webhooks/telnyx",
            post(webhook::receive).get(webhook::health),
        )
        .route("/public/webhooks/telnyx/tools/{tool}", post(webhook::tool))
        .with_state(state)
}

/// `c.env.<name>`: the request's env (conformance), else the process's.
/// Empty reads as unset, as every check here is `if (!env.X)`.
pub(crate) fn env_value(env: Option<&RequestEnv>, name: &str) -> Option<String> {
    match env {
        Some(env) => env.get(name).map(str::to_owned),
        None => std::env::var(name).ok(),
    }
    .filter(|value| !value.is_empty())
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: Option<String>,
    permissions: Option<Permissions>,
    pub(crate) events: EventContext,
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
    buckets: Option<StorageBuckets>,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CallState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// The owner scope (`scopeFor`): none with `activities:scope:all`, else
    /// the caller's own id.
    pub(crate) fn scope(&self) -> Option<&str> {
        if self.can("activities:scope:all") {
            None
        } else {
            Some(&self.user_id)
        }
    }

    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    /// `c.env.<name>`.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        env_value(self.env.as_ref(), name)
    }

    /// `getMasterDb(c.env)`: the test's (conformance), else the state's.
    pub(crate) fn master(&self, state: &CallState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    /// Telnyx, with this request's key and HTTP client.
    pub(crate) fn telnyx(&self, state: &CallState) -> telnyx::Telnyx {
        telnyx::Telnyx::new(
            self.env("TELNYX_API_KEY"),
            self.http.clone().or_else(|| state.http.clone()),
        )
    }

    /// `c.env.STORAGE`: the test's bucket (conformance), else the state's.
    pub(crate) fn storage(&self, state: &CallState) -> Option<Arc<dyn DynFileStore>> {
        if self.conformance() {
            return self.buckets.as_ref().and_then(|b| b.public.clone());
        }
        state.storage.clone()
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
                org_id: auth.org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                permissions: extensions.get::<Permissions>().cloned(),
                events: EventContext::for_request(auth, tenant),
                env: extensions.get::<RequestEnv>().cloned(),
                master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
                http: extensions.get::<OutboundHttp>().cloned(),
                buckets: extensions.get::<StorageBuckets>().cloned(),
            })
        } else {
            tracing::error!("call: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// What a public route reads off its request: the test's env, databases
/// and HTTP client in conformance builds.
pub(crate) struct PublicCtx {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    tenant: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl<S: Send + Sync> FromRequestParts<S> for PublicCtx {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            env: extensions.get::<RequestEnv>().cloned(),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            tenant: extensions.get::<Tenant>().map(|tenant| tenant.db.clone()),
            http: extensions.get::<OutboundHttp>().cloned(),
        }))
    }
}

impl PublicCtx {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    pub(crate) fn env(&self, name: &str) -> Option<String> {
        env_value(self.env.as_ref(), name)
    }

    pub(crate) fn master(&self, state: &CallState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    pub(crate) fn telnyx(&self, state: &CallState) -> telnyx::Telnyx {
        telnyx::Telnyx::new(
            self.env("TELNYX_API_KEY"),
            self.http.clone().or_else(|| state.http.clone()),
        )
    }

    /// `getTenantDbForWorkspace(env, clerkOrgId)`: the test's tenant
    /// database for every workspace (conformance), else the workspace's.
    pub(crate) async fn tenant(&self, state: &CallState, org_id: &str) -> Result<PgPool, String> {
        if self.conformance() {
            return self
                .tenant
                .clone()
                .ok_or_else(|| "no tenant database".to_owned());
        }
        match &state.tenants {
            Some(tenants) => tenants(org_id.to_owned()).await,
            None => Err("no tenant resolver".to_owned()),
        }
    }
}

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
pub(crate) struct Unreachable;

impl DynOutboundHttp for Unreachable {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend("fetch failed"))))
    }
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
    tracing::error!(%error, "[call-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `select to_jsonb(t)` rows as Drizzle returns them.
pub(crate) fn rows(values: Vec<Value>) -> Vec<Value> {
    values.into_iter().map(weldsuite_db::js_row).collect()
}

/// `new Date()` as Drizzle writes it.
pub(crate) fn now() -> String {
    weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())
}
