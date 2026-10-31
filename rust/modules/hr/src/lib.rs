//! WeldHR: hr-api's `/api/weldhr` (`apps/workers/hr-api`), the employee
//! directory, departments and the org chart, client assignments, on- and
//! offboarding checklists, shifts, attendance, leave, open shifts and shift
//! requests, work locations, expense declarations, sick reports,
//! announcements, coaching, evaluations, KPIs and milestones, the My HR
//! self-service routes (`/me`), and payroll (`/payroll`, behind the
//! `weldhr-payroll` flag) with its engines in `weldsuite-payroll-domain`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `hr`
//! conformance suites (`rust/conformance/suites.json`).
//!
//! The router mirrors `routes/weldhr/index.ts`: one error boundary
//! ([`HrError`], `toHrErrorResponse` plus the router's `onError`), the
//! starter data seeded on a workspace's first request ([`defaults`]), and
//! the readable 400s of `hrJson` ([`validation`]).

mod defaults;
mod fields;
mod shared;
mod validation;

pub mod books;

// Directory, lifecycle, declarations, absences, announcements, My HR (core).
mod absences;
mod announcements;
mod assignments;
mod dashboard;
mod declarations;
mod employees;
mod lifecycle;
mod me;
mod self_service;
mod settings;

// Time and performance, and their My HR routes.
mod me_time;
mod open_shifts;
mod performance;
mod shift_requests;
mod timekeeping;
mod work_locations;

// Payroll (`/payroll` and the payroll routes of My HR).
mod payroll;

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::EMPLOYEES_SELF;
use weldsuite_db::{Keyring, PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{
    DynRealtimePublisher, DynSystemMail, FileStores, OutboundHttp, PresenceReader, StorageBuckets,
};

pub use books::{BooksInternal, BooksRequest, BooksResponse, RequestBooksInternal};
pub(crate) use shared::*;
pub(crate) use validation::{hr_json, query_values, zod_json, zod_query};

/// What the hr handlers share.
#[derive(Clone)]
pub struct HrState {
    pub events: EntityEventPublisher,
    /// Realtime fan-out (`REALTIME`), for the notifications announcements
    /// send; without it they are skipped.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The buckets: hr-api's `STORAGE` is the public one (receipts, payslip
    /// PDFs, filings). A request's `StorageBuckets` (conformance) wins.
    pub files: Option<FileStores>,
    /// System mail (`SEND_EMAIL`: payslip ready, bank details changed);
    /// without it nothing is sent, as `workerTransport(env)` without the
    /// binding.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Push delivery (Expo) for announcement notifications. A request's
    /// `OutboundHttp` (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// The master database (the payroll billing ledger,
    /// `payroll_usage_events`). A request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// books-api's `BooksInternal` entrypoint (`BOOKS_INTERNAL`): an approved
    /// pay run's journal. `None`: the journal is skipped, as the worker does
    /// without the binding. A request's `RequestBooksInternal` (conformance)
    /// wins.
    pub books: Option<Arc<dyn BooksInternal>>,
}

impl std::fmt::Debug for HrState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HrState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("files", &self.files.is_some())
            .field("mail", &self.mail.is_some())
            .field("master", &self.master.is_some())
            .field("books", &self.books.is_some())
            .finish_non_exhaustive()
    }
}

/// `/api/weldhr`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission` from
/// `gate`; every `/me` route also `employees:self`.
pub fn router<S, Q>(state: HrState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    // `meRoutes.use('*', requirePermission('employees:self'))`: ahead of
    // every /me route's own middleware (the payroll flag).
    let me = me::routes(gate)
        .merge(me_time::routes(gate))
        .merge(payroll::me_routes(gate))
        .layer(gate.require([EMPLOYEES_SELF]));
    Router::new()
        .merge(dashboard::routes(gate))
        .merge(employees::routes(gate))
        .merge(assignments::routes(gate))
        .merge(lifecycle::routes(gate))
        .merge(settings::routes(gate))
        .merge(declarations::routes(gate))
        .merge(absences::routes(gate))
        .merge(announcements::routes(gate))
        .merge(timekeeping::routes(gate))
        .merge(open_shifts::routes(gate))
        .merge(shift_requests::routes(gate))
        .merge(work_locations::routes(gate))
        .merge(performance::routes(gate))
        .nest("/payroll", payroll::routes(gate))
        .nest("/me", me)
        .layer(axum::middleware::from_fn(defaults::ensure_hr_defaults))
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
#[allow(dead_code)] // filled in route group by route group
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    /// `c.get('userId')`: the actor of audits and writes.
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization (payroll mail links).
    pub(crate) org_id: Option<String>,
    /// `c.get('clerkOrgId')`: R2 keys (`workspaces/<org>/hr/…`) and the
    /// notification scope are keyed by it.
    pub(crate) clerk_org_id: String,
    /// `c.get('workspaceId')`: `workspaces.id` (the payroll billing ledger).
    pub(crate) workspace_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// `CF-Connecting-IP`, else the first `X-Forwarded-For` entry (`clientIp`).
    pub(crate) ip: Option<String>,
    env: Option<RequestEnv>,
    buckets: Option<StorageBuckets>,
    master: Option<PgPool>,
    flags: Option<weldsuite_pipeline::Flags>,
    http: Option<OutboundHttp>,
    presence: Option<PresenceReader>,
    books: Option<RequestBooksInternal>,
    /// This request's events, sent in order.
    outbox: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<EntityEvent>>>,
}

#[allow(dead_code)] // filled in route group by route group
impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `flags.isOn(key)`: off without an evaluator.
    pub(crate) async fn flag_on(&self, flag: weldsuite_catalogs::flags::BoolFlag) -> bool {
        match &self.flags {
            Some(flags) => flags.is_on(flag).await,
            None => false,
        }
    }

    /// `c.env.<name>`: the request's env (conformance) when there is one,
    /// else the process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        std::env::var(name).ok()
    }

    /// `keyringFromEnv(c.env)`: `DATABASE_ENCRYPTION_KEY` (v1) and
    /// `DATABASE_ENCRYPTION_KEY_V2`, empty values left out.
    pub(crate) fn keyring(&self) -> Keyring {
        let key = |name: &str| self.env(name).filter(|value| !value.trim().is_empty());
        Keyring {
            v1: key("DATABASE_ENCRYPTION_KEY"),
            v2: key("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }

    /// hr-api's `STORAGE` bucket: the request's (conformance), else the
    /// app's public bucket.
    pub(crate) fn storage(
        &self,
        state: &HrState,
    ) -> Option<Arc<dyn weldsuite_ports::DynFileStore>> {
        match &self.buckets {
            Some(buckets) => buckets.public.clone(),
            None => state.files.as_ref().and_then(|files| files.public.clone()),
        }
    }

    /// The master database: the request's (conformance), else the app's.
    pub(crate) fn master(&self, state: &HrState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// `BOOKS_INTERNAL`: the request's (conformance), else the app's.
    pub(crate) fn books(&self, state: &HrState) -> Option<Arc<dyn BooksInternal>> {
        self.books
            .as_ref()
            .map(|books| Arc::clone(&books.0))
            .or_else(|| state.books.clone())
    }

    /// Where notifications go out (`NotificationEnv`): the realtime hub,
    /// presence and push. Announcements exclude email.
    pub(crate) fn notifier(&self, state: &HrState) -> weldsuite_notifications::Notifier {
        weldsuite_notifications::Notifier {
            realtime: state.realtime.clone(),
            presence: self.presence.clone(),
            mail: None,
            http: self.http.clone().or_else(|| state.http.clone()),
            apns: None,
        }
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`, in
    /// publish order.
    pub(crate) fn publish(&self, state: &HrState, event: EventName, entity_id: &str, data: Value) {
        self.send(state, EntityEvent::new(event, entity_id, data));
    }

    /// `emit(c, entityType, action, entityId, data)` (helpers.ts): the data
    /// is `{ id: entityId, ...data }`, where `data` holds only the keys the
    /// route set (`Some(Value::Null)` for an explicit null, `None` for a key
    /// it left out).
    pub(crate) fn emit(
        &self,
        state: &HrState,
        event: EventName,
        entity_id: &str,
        fields: &[(&str, Option<Value>)],
    ) {
        let mut data = Map::new();
        data.insert("id".to_owned(), Value::String(entity_id.to_owned()));
        for (key, value) in fields {
            if let Some(value) = value {
                data.insert((*key).to_owned(), value.clone());
            }
        }
        self.publish(state, event, entity_id, Value::Object(data));
    }

    fn send(&self, state: &HrState, event: EntityEvent) {
        let mut outbox = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = outbox.get_or_insert_with(|| {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<EntityEvent>();
            let publisher = state.events.clone();
            let context = self.events.clone();
            state.events.tracker().spawn(async move {
                while let Some(event) = receiver.recv().await {
                    publisher.publish_and_wait(&context, event).await;
                }
            });
            sender
        });
        if sender.send(event).is_err() {
            tracing::error!("hr: the event outbox closed early");
        }
    }

    /// `recordHrAudit(db, { actorId: actor(c), …, ip: clientIp(c) })`.
    pub(crate) async fn audit(
        &self,
        action: &str,
        employee_id: Option<&str>,
        metadata: Value,
    ) -> Result<(), HrError> {
        shared::record_hr_audit(
            &self.db,
            &self.user_id,
            action,
            employee_id,
            metadata,
            self.ip.as_deref(),
        )
        .await
    }
}

/// `clientIp(c)`: `CF-Connecting-IP`, else the first `X-Forwarded-For`
/// entry, trimmed; `None` when both are empty.
fn client_ip(headers: &http::HeaderMap) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    if let Some(ip) = header("cf-connecting-ip").filter(|ip| !ip.is_empty()) {
        return Some(ip);
    }
    header("x-forwarded-for")
        .and_then(|list| list.split(',').next().map(|first| first.trim().to_owned()))
        .filter(|ip| !ip.is_empty())
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
                    org_id: auth.org_id.clone().filter(|id| !id.is_empty()),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| tenant.workspace_id.clone()),
                    workspace_id: tenant.workspace_id.clone(),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    ip: client_ip(&parts.headers),
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    buckets: parts
                        .extensions
                        .get::<StorageBuckets>()
                        .cloned()
                        .or_else(|| {
                            parts
                                .extensions
                                .get::<FileStores>()
                                .cloned()
                                .map(StorageBuckets::from)
                        }),
                    master: parts
                        .extensions
                        .get::<weldsuite_db::MasterDb>()
                        .map(|master| master.0.clone()),
                    flags: parts.extensions.get::<weldsuite_pipeline::Flags>().cloned(),
                    http: parts.extensions.get::<OutboundHttp>().cloned(),
                    presence: parts.extensions.get::<PresenceReader>().cloned(),
                    books: parts.extensions.get::<RequestBooksInternal>().cloned(),
                    outbox: std::sync::Mutex::default(),
                })
            } else {
                tracing::error!("hr: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// What the services throw and the routes refuse with, answered as
/// `toHrErrorResponse` and the router's `onError` answer it.
#[derive(Debug)]
#[allow(dead_code)] // filled in route group by route group
pub(crate) enum HrError {
    /// `HrNotFoundError(resource, id, userMessage?)`: 404 with
    /// `<resource> with ID '<id>' not found`, or the message for people.
    NotFound {
        resource: String,
        id: String,
        user_message: Option<String>,
    },
    /// `HrValidationError(message, details?)`: 400 `BAD_REQUEST`.
    Validation {
        message: String,
        details: Option<Value>,
    },
    /// `HrConflictError(message)`: 409 `CONFLICT`.
    Conflict(String),
    /// `HrPayrollError(code, message, status = 409, details?)`.
    Payroll {
        code: String,
        message: String,
        status: u16,
        details: Option<Value>,
    },
    /// A response the route writes itself (403, a validation failure, …).
    Response(Box<Response>),
    /// A failing statement: the router's `onError` (500 `INTERNAL_ERROR`).
    Database(sqlx::Error),
    /// Anything else unexpected, logged with its reason: also a 500.
    Internal(String),
}

#[allow(dead_code)] // filled in route group by route group
impl HrError {
    /// `new HrNotFoundError(resource, id)`.
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        Self::NotFound {
            resource: resource.to_owned(),
            id: id.to_owned(),
            user_message: None,
        }
    }

    /// `new HrNotFoundError(resource, id, userMessage)`.
    pub(crate) fn not_found_message(resource: &str, id: &str, message: &str) -> Self {
        Self::NotFound {
            resource: resource.to_owned(),
            id: id.to_owned(),
            user_message: Some(message.to_owned()),
        }
    }

    /// `new HrValidationError(message)`.
    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::Validation {
            message: message.into(),
            details: None,
        }
    }

    /// `new HrConflictError(message)`.
    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    /// `new HrPayrollError(code, message, status)`.
    pub(crate) fn payroll(code: &str, message: impl Into<String>, status: u16) -> Self {
        Self::Payroll {
            code: code.to_owned(),
            message: message.into(),
            status,
            details: None,
        }
    }

    /// `error.forbidden(c, message)`.
    pub(crate) fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    /// `error.badRequest(c, message)`.
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn internal(reason: impl Into<String>) -> Self {
        Self::Internal(reason.into())
    }

    /// The response.
    pub(crate) fn respond(self) -> Response {
        match self {
            Self::NotFound {
                user_message: Some(message),
                ..
            } => ApiError::new(http::StatusCode::NOT_FOUND, "NOT_FOUND", message).into_response(),
            Self::NotFound { resource, id, .. } => {
                ApiError::not_found(&resource, Some(&id)).into_response()
            }
            Self::Validation { message, details } => {
                let error = ApiError::bad_request(message);
                match details {
                    Some(details) => error.with_details(details),
                    None => error,
                }
                .into_response()
            }
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Payroll {
                code,
                message,
                status,
                details,
            } => {
                let status =
                    http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::CONFLICT);
                let error = ApiError::new(status, code, message);
                match details {
                    Some(details) => error.with_details(details),
                    None => error,
                }
                .into_response()
            }
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[weldhr] unhandled error");
                unexpected()
            }
            Self::Internal(reason) => {
                tracing::error!(%reason, "[weldhr] unhandled error");
                unexpected()
            }
        }
    }
}

/// The router's `onError` for anything not an hr error.
fn unexpected() -> Response {
    ApiError::new(
        http::StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "An unexpected error occurred",
    )
    .into_response()
}

impl From<sqlx::Error> for HrError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for HrError {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl From<Response> for HrError {
    fn from(response: Response) -> Self {
        Self::Response(Box::new(response))
    }
}

impl IntoResponse for HrError {
    fn into_response(self) -> Response {
        self.respond()
    }
}

/// A handler's result: `Ok` is the answer, `Err` the error boundary's.
pub(crate) type HrResult<T = Response> = Result<T, HrError>;
