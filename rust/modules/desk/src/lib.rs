//! WeldDesk, the helpdesk: desk-api's routes (`apps/workers/desk-api`), at
//! the paths it serves under `/api` (tickets, conversations, the webchat
//! inbox, agents, departments, SLAs, macros, workflows config, knowledge
//! articles, satisfaction, channels, help center settings) and its public
//! help-center feed and OAuth callbacks.
//!
//! What the helpdesk widget API and the workflow engine also need lives in
//! `weldsuite-desk-domain`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `desk`
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

/// The list statement of a table with `$filters` filter slots: `$1` skips
/// the live-only condition, each filter takes `(skip, value)`, the cursor
/// `(skip, createdAt, id)`, then the limit.
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

mod assignment;
mod conversations;
mod crud;
mod custom_fields;
mod discord;
mod dispatch;
mod js;
mod link;
mod notify;
mod simple;
mod table;
#[rustfmt::skip]
mod tables;
mod tickets;

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
use weldsuite_desk_domain::http::{DynDeskHttp, RequestHttp};
use weldsuite_desk_domain::workflow::DynWorkflowEngine;
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_mail_domain::outbound::{OutboundBindings, RequestOutbound};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynCache, DynRealtimePublisher, DynSystemMail, FileStores};

/// What the desk handlers share.
#[derive(Clone)]
pub struct DeskState {
    pub events: EntityEventPublisher,
    /// Realtime fan-out (`REALTIME`); without it publishes are skipped, as
    /// the worker does without the binding.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The buckets: inbox attachments go to the public one (`STORAGE`). A
    /// request's `FileStores` (conformance) wins.
    pub files: Option<FileStores>,
    /// The workspace cache (`WORKSPACE_CACHE`). A request's `RequestCache`
    /// (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// System mail (notification emails); without it they are skipped.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// The helpdesk workflow engine (`HELPDESK_WORKFLOW`).
    pub workflow: DynWorkflowEngine,
    /// Discord and Slack calls. A request's `RequestHttp` (conformance) wins.
    pub http: Option<DynDeskHttp>,
    /// Customer mail (email replies) and the outbound ledgers. A request's
    /// `RequestOutbound` (conformance) wins.
    pub outbound: OutboundBindings,
    /// The master database (the outbound guard's sender ownership). A
    /// request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
}

impl std::fmt::Debug for DeskState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeskState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("files", &self.files.is_some())
            .field("cache", &self.cache.is_some())
            .field("mail", &self.mail.is_some())
            .finish_non_exhaustive()
    }
}

/// desk-api's authenticated routes, relative to `/api`
/// (`/tickets`, `/conversations`, `/desk/conversations`, …), to merge under
/// `/api` behind the session, tenant database, licence and flag layers.
/// Each route carries its `requirePermission` from `gate`.
pub fn router<S, Q>(state: DeskState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/helpdesk-faqs", crud::routes(&simple::FAQS, gate))
        .nest("/helpdesk-news", crud::routes(&simple::NEWS, gate))
        .nest(
            "/helpdesk-announcements",
            crud::routes(&simple::ANNOUNCEMENTS, gate),
        )
        .nest("/helpdesk-feedback", crud::routes(&simple::FEEDBACK, gate))
        .nest("/helpdesk-reviews", crud::routes(&simple::REVIEWS, gate))
        .nest("/slas", crud::routes(&simple::SLA, gate))
        .nest("/ticket-notes", crud::routes(&simple::TICKET_NOTES, gate))
        .nest(
            "/ticket-messages",
            crud::routes(&simple::TICKET_MESSAGES, gate),
        )
        .nest(
            "/satisfaction-surveys",
            crud::routes(&simple::SURVEYS, gate),
        )
        .nest("/tickets", tickets::routes(gate))
        .nest("/conversations", conversations::routes(gate))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
#[allow(dead_code)] // filled in route group by route group
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('clerkOrgId')`: realtime topics and notification links.
    pub(crate) clerk_org_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// The test's env (conformance), read before the process's.
    pub(crate) env: Option<RequestEnv>,
    /// The test's buckets (conformance), before the state's.
    pub(crate) files: Option<FileStores>,
    /// The test's fetch stub (conformance), before the state's client.
    pub(crate) http: Option<RequestHttp>,
    /// The test's mail bindings (conformance), before the state's.
    pub(crate) outbound: Option<RequestOutbound>,
    /// The test's master database (conformance), before the state's.
    pub(crate) master: Option<weldsuite_db::MasterDb>,
}

#[allow(dead_code)] // filled in route group by route group
impl Caller {
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &DeskState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
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
    pub(crate) fn http(&self, state: &DeskState) -> Option<DynDeskHttp> {
        self.http
            .as_ref()
            .map(|http| std::sync::Arc::clone(&http.0))
            .or_else(|| state.http.clone())
    }

    /// The outbound guard and transport for a customer reply: the
    /// request's bindings first, then the state's.
    pub(crate) fn outbound(&self, state: &DeskState) -> dispatch::Outbound {
        let bindings = self
            .outbound
            .as_ref()
            .map_or_else(|| state.outbound.clone(), |own| own.0.clone());
        let master = self
            .master
            .as_ref()
            .map(|master| master.0.clone())
            .or_else(|| state.master.clone());
        dispatch::Outbound {
            guard: bindings.guard(master, state.cache.clone()),
            transport: bindings.transport.clone(),
        }
    }

    /// The buckets: the request's (conformance), else the state's.
    pub(crate) fn files(&self, state: &DeskState) -> Option<FileStores> {
        self.files.clone().or_else(|| state.files.clone())
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
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .unwrap_or_else(|| tenant.workspace_id.clone()),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    files: parts.extensions.get::<FileStores>().cloned(),
                    http: parts.extensions.get::<RequestHttp>().cloned(),
                    outbound: parts.extensions.get::<RequestOutbound>().cloned(),
                    master: parts.extensions.get::<weldsuite_db::MasterDb>().cloned(),
                })
            } else {
                tracing::error!("desk: a route without the session, tenant or permission layer");
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
                tracing::error!(%error, "[desk-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp` (or `::timestamptz`).
#[allow(dead_code)] // filled in route group by route group
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
#[allow(dead_code)] // filled in route group by route group
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
