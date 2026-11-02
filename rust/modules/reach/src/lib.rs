//! WeldReach (cold-email outreach): reach-api's routes
//! (`apps/workers/reach-api`): `/api/reach/*` (access, settings, billing,
//! domains, mailboxes, prospects, lists, campaigns, suppressions, overview,
//! the reply inbox) behind the `weldreach` app-access gate, and Mailpool's
//! webhook at `/public/reach/webhooks/mailpool`.
//!
//! The campaign, prospect and inbox logic is `weldsuite-reach-domain`'s,
//! which external-api and mcp-server share on Global. Mailpool (mailbox
//! provisioning) is a third-party API reached through the outbound HTTP
//! port. Billing is Global's billing-worker (Stripe); these editions have
//! none, so its calls answer as billing-worker does without Stripe (see
//! `billing.rs`).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `reach`
//! conformance suites (`rust/conformance/suites.json`).

#![allow(clippy::too_many_lines, clippy::type_complexity)]

mod account;
mod billing;
mod campaigns;
mod crm;
mod dnscheck;
mod domains;
mod effects;
mod inbox;
mod lists;
mod mailboxes;
mod mailpool;
mod prospects;
mod smtp;
mod suppressions;
mod webhook;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::{Keyring, MasterDb, PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_pipeline::Flags;
use weldsuite_pipeline::{AppAccess, AppAccessGate, app_access_gate};
use weldsuite_ports::{BoxFuture, FileStores, OutboundHttp, StorageBuckets};
use weldsuite_reach_domain::smtp::SmtpTransport;
use weldsuite_reach_domain::{DuePort, EventSink, ReachError, ReachEvent};

pub use smtp::LettreSmtp;
pub use weldsuite_reach_domain;

/// A workspace's tenant database by its Clerk org id (the webhook's
/// `openTenantDb`).
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The SMTP transport a request uses: the test's double in conformance
/// builds (a request extension), the app's otherwise.
#[derive(Clone)]
pub struct RequestSmtp(pub Arc<dyn SmtpTransport>);

impl std::fmt::Debug for RequestSmtp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestSmtp")
    }
}

/// What the WeldReach handlers share.
#[derive(Clone)]
pub struct ReachState {
    pub events: EntityEventPublisher,
    /// The master database (app access, routes, the warmup pool, the due
    /// index). A request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// Mailpool and DNS-over-HTTPS. A request's `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// `STORAGE` (raw inbound replies). A request's buckets win.
    pub files: Option<FileStores>,
    /// `DATABASE_ENCRYPTION_KEY(_V2)`: the mailbox logins.
    pub keyring: Keyring,
    /// Customer-mailbox SMTP. A request's [`RequestSmtp`] wins.
    pub smtp: Option<Arc<dyn SmtpTransport>>,
    /// The `weldreach` app-access gate (none in conformance builds, where the
    /// test hands the access in).
    pub access_gate: Option<Arc<AppAccessGate>>,
    /// The webhook's tenant lookup. A request's `Tenant` (conformance) wins.
    pub tenants: Option<TenantDatabases>,
}

impl std::fmt::Debug for ReachState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReachState")
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .field("smtp", &self.smtp.is_some())
            .finish_non_exhaustive()
    }
}

/// reach-api's `/api/reach` routes, relative to `/api/reach`, behind the
/// `weldreach` app-access gate.
pub fn router<S, Q>(state: ReachState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let access_gate = state.access_gate.clone();
    Router::new()
        .merge(account::routes(gate))
        .nest("/domains", domains::routes(gate))
        .nest("/mailboxes", mailboxes::routes(gate))
        .nest("/prospects", prospects::routes(gate))
        .nest("/lists", lists::routes(gate))
        .nest("/campaigns", campaigns::routes(gate))
        .nest("/suppressions", suppressions::routes(gate))
        .nest("/inbox", inbox::routes(gate))
        .layer(axum::middleware::from_fn_with_state(
            access_gate,
            reach_access,
        ))
        .with_state(state)
}

/// Mailpool's webhook at its full path (`/public/reach/webhooks/mailpool`),
/// served ahead of the session: the signature is its credential.
pub fn public_router<S>(state: ReachState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    webhook::router(state)
}

/// `appAccessGate('weldreach')`: the master read (cached a minute), unless
/// the request already carries the access (conformance hands the test's in).
async fn reach_access(
    State(gate): State<Option<Arc<AppAccessGate>>>,
    request: Request,
    next: Next,
) -> Response {
    if request.extensions().get::<AppAccess>().is_some() {
        return next.run(request).await;
    }
    match gate {
        Some(gate) => app_access_gate(State(gate), request, next).await,
        None => next.run(request).await,
    }
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: String,
    /// `c.get('workspaceId')` (`workspaces.id`): the due index's key.
    pub(crate) workspace_id: String,
    pub(crate) events: EventContext,
    pub(crate) permissions: Permissions,
    /// `c.get('appAccess')` (unset when a test skips the gate).
    pub(crate) access: Option<AppAccess>,
    flags: Option<Flags>,
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
    buckets: Option<StorageBuckets>,
    smtp: Option<RequestSmtp>,
    /// The caller's `Authorization` header (forwarded to billing-worker).
    pub(crate) authorization: Option<String>,
}

impl Caller {
    /// `c.env.<name>`: the request's env (conformance), else the process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        env_value(self.env.as_ref(), name)
    }

    /// Whether the request runs under conformance (it carries the test's env).
    pub(crate) fn conformance(&self) -> bool {
        self.env.is_some()
    }

    pub(crate) fn master(&self, state: &ReachState) -> Option<PgPool> {
        if self.env.is_some() {
            return self.master.clone();
        }
        self.master.clone().or_else(|| state.master.clone())
    }

    pub(crate) fn http(&self, state: &ReachState) -> OutboundHttp {
        self.http
            .clone()
            .or_else(|| {
                if self.env.is_some() {
                    None
                } else {
                    state.http.clone()
                }
            })
            .unwrap_or_else(unreachable_http)
    }

    pub(crate) fn keyring(&self, state: &ReachState) -> Keyring {
        match &self.env {
            Some(env) => Keyring {
                v1: env
                    .get("DATABASE_ENCRYPTION_KEY")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
                v2: env
                    .get("DATABASE_ENCRYPTION_KEY_V2")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
            },
            None => state.keyring.clone(),
        }
    }

    pub(crate) fn storage(
        &self,
        state: &ReachState,
    ) -> Option<Arc<dyn weldsuite_ports::DynFileStore>> {
        match &self.buckets {
            Some(buckets) => buckets.public.clone(),
            None if self.env.is_some() => None,
            None => state.files.as_ref().and_then(|f| f.public.clone()),
        }
    }

    pub(crate) fn smtp(&self, state: &ReachState) -> Option<Arc<dyn SmtpTransport>> {
        match &self.smtp {
            Some(smtp) => Some(Arc::clone(&smtp.0)),
            None if self.env.is_some() => None,
            None => state.smtp.clone(),
        }
    }

    /// `(await c.get('flags')?.isOn('weldreach-sending')) ?? true`.
    pub(crate) async fn sending_enabled(&self) -> bool {
        match &self.flags {
            Some(flags) => {
                flags
                    .is_on(weldsuite_catalogs::flags::WELDREACH_SENDING)
                    .await
            }
            None => true,
        }
    }

    /// The request's entity-event sink.
    pub(crate) fn sink<'a>(&'a self, state: &'a ReachState) -> RequestSink<'a> {
        RequestSink {
            publisher: &state.events,
            context: &self.events,
        }
    }

    /// The send sweep's due index (`markWorkspaceDue(SCHEDULE_INDEX, 'reach_send', …)`).
    pub(crate) fn due(&self, state: &ReachState) -> Option<Due> {
        self.master(state).map(|master| Due {
            master,
            workspace_id: self.workspace_id.clone(),
            kind: "reach_send",
        })
    }

    /// `CONFORMANCE_NOW` or now.
    pub(crate) fn now(&self) -> OffsetDateTime {
        weldsuite_reach_domain::now_or(self.env.as_ref().and_then(|e| e.get("CONFORMANCE_NOW")))
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

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
pub(crate) fn unreachable_http() -> OutboundHttp {
    struct Unreachable;
    impl weldsuite_ports::DynOutboundHttp for Unreachable {
        fn send(
            &self,
            _request: weldsuite_ports::HttpRequest,
        ) -> BoxFuture<'_, Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>>
        {
            Box::pin(std::future::ready(Err(
                weldsuite_ports::PortError::backend("no outbound HTTP client"),
            )))
        }
    }
    OutboundHttp(Arc::new(Unreachable))
}

/// Entity events of a request (`publishEntityEvent({ c, ... })`).
pub(crate) struct RequestSink<'a> {
    publisher: &'a EntityEventPublisher,
    context: &'a EventContext,
}

impl EventSink for RequestSink<'_> {
    fn emit(&self, event: ReachEvent) {
        let mut entity = EntityEvent::new(event.event, event.entity_id, event.data);
        if let Some(changes) = event.changes {
            entity = entity.with_changes(changes);
        }
        self.publisher.publish(self.context, entity);
    }
}

/// The due index, on the master database.
pub(crate) struct Due {
    master: PgPool,
    workspace_id: String,
    kind: &'static str,
}

impl DuePort for Due {
    fn due(&self, at: OffsetDateTime) -> BoxFuture<'_, ()> {
        Box::pin(weldsuite_db::due_index::mark_due(
            &self.master,
            self.kind,
            &self.workspace_id,
            at,
        ))
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        let caller = if let (Some(auth), Some(tenant), Some(permissions)) = (
            extensions.get::<AuthContext>(),
            extensions.get::<Tenant>(),
            extensions.get::<Permissions>(),
        ) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                clerk_org_id: tenant
                    .clerk_org_id
                    .clone()
                    .or_else(|| auth.org_id.clone())
                    .unwrap_or_default(),
                workspace_id: tenant.workspace_id.clone(),
                events: EventContext::for_request(auth, tenant),
                permissions: permissions.clone(),
                access: extensions.get::<AppAccess>().cloned(),
                flags: extensions.get::<Flags>().cloned(),
                env: extensions.get::<RequestEnv>().cloned(),
                master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
                http: extensions.get::<OutboundHttp>().cloned(),
                buckets: extensions.get::<StorageBuckets>().cloned().or_else(|| {
                    extensions
                        .get::<FileStores>()
                        .cloned()
                        .map(StorageBuckets::from)
                }),
                smtp: extensions.get::<RequestSmtp>().cloned(),
                authorization: parts
                    .headers
                    .get(http::header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned),
            })
        } else {
            tracing::error!("reach: a route without the session, tenant or permission layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A [`ReachError`] as the route answers it (`reachErrorHandler`).
pub(crate) fn error_response(error: &ReachError) -> Response {
    let status =
        http::StatusCode::from_u16(error.status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
    let mut api = ApiError::new(status, error.code.clone(), error.message.clone());
    if let Some(details) = &error.details {
        api = api.with_details(details.clone());
    }
    api.into_response()
}

/// A handler's result as a response.
pub(crate) fn respond(result: Result<Response, ReachError>) -> Response {
    result.unwrap_or_else(|error| error_response(&error))
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(IntoResponse::into_response)?;
    value.ok_or_else(|| ApiError::internal().into_response())
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    raw: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let fields = weldsuite_kit::validation::query_values(raw);
    let mut issues = Issues::default();
    let value = read(&mut issues, &fields);
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(value)
}

/// `c.get('appAccess')`, required (`accountContextOf`): a request that
/// skipped the gate fails as the worker does reading `undefined`.
pub(crate) fn access_of(caller: &Caller) -> Result<&AppAccess, ReachError> {
    caller
        .access
        .as_ref()
        .ok_or_else(|| ReachError::unexpected(&"appAccess is not set"))
}

/// `accountContextOf(c)`: the access with a workspace, else 403.
pub(crate) fn account_workspace(
    caller: &Caller,
) -> Result<(String, weldsuite_reach_domain::schemas::Limits), ReachError> {
    let access = access_of(caller)?;
    let Some(workspace_id) = access.workspace_id.clone() else {
        return Err(ReachError::new(
            403,
            "WORKSPACE_NOT_FOUND",
            "This workspace is not set up for WeldReach.",
        ));
    };
    Ok((
        workspace_id,
        weldsuite_reach_domain::schemas::resolve_limits(Some(&access.limits)),
    ))
}

/// `resolveWeldReachLimits(c.get('appAccess')?.limits)`.
pub(crate) fn limits_of(caller: &Caller) -> weldsuite_reach_domain::schemas::Limits {
    weldsuite_reach_domain::schemas::resolve_limits(caller.access.as_ref().map(|a| &a.limits))
}

/// The master database a handler needs: the worker reads `getMasterDb(c.env)`.
pub(crate) fn require_master(caller: &Caller, state: &ReachState) -> Result<PgPool, ReachError> {
    caller
        .master(state)
        .ok_or_else(|| ReachError::unexpected(&"no master database"))
}
