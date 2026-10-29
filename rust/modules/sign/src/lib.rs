//! WeldSign, electronic signatures: `/api/sign` as sign-api serves it to
//! members (`apps/workers/sign-api/src/routes/`), with the domain rules of
//! `@weldsuite/sign-domain`.
//!
//! Ported: drafts and their settings, documents, recipients, fields, the
//! activity trail, templates and their roles, sending and a sent request's
//! lifecycle (void, reminders, new links, corrections, "sign now"), the
//! signed PDF with its certificate (the `sign.finalize` job) and the
//! lifecycle sweep (`weldsuite cron sign-lifecycle`). The signer portal's
//! endpoints are the next stage.
//!
//! Who sees what: without `sign_envelopes:manage` a member sees the envelopes
//! they sent and the sent requests they are a recipient of (by email); one
//! they may not see is a 404. Only the owner changes an envelope, and only a
//! draft (409 otherwise). Templates belong to the workspace.

mod documents;
mod envelopes;
mod fields;
mod filing;
mod finalize;
mod hash;
mod lifecycle;
mod links;
mod mail;
mod outbound;
pub mod pdf_render;
mod recipients;
mod schedule;
mod sending;
mod sources;
#[rustfmt::skip]
mod standard_fonts;
mod sweep;
mod templates;

pub use finalize::{
    BuiltPdf, FINALIZE_JOB, FinalizeJob, FinalizeParams, TenantRef, TenantResolver,
    finalize_request, start_finalize,
};
pub use sweep::{LIFECYCLE_SEED_KEY, LifecycleSweepResult, run_lifecycle_sweep};

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys::{
    SIGN_ENVELOPES_CREATE, SIGN_ENVELOPES_DELETE, SIGN_ENVELOPES_READ, SIGN_ENVELOPES_SEND,
    SIGN_ENVELOPES_UPDATE, SIGN_ENVELOPES_VOID, SIGN_TEMPLATES_CREATE, SIGN_TEMPLATES_DELETE,
    SIGN_TEMPLATES_READ, SIGN_TEMPLATES_UPDATE,
};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynCache, DynFlagSource, DynJobs, DynSystemMail, FileStores};

use crate::documents::Scope;

/// What the sign handlers share.
#[derive(Clone)]
pub struct SignState {
    pub events: EntityEventPublisher,
    /// `SIGN_SESSION_SECRET`: keys the stored hash of access codes. Without
    /// it a recipient cannot get an access code.
    pub session_secret: Option<Arc<str>>,
    /// The private bucket (and the legacy public one), when configured.
    pub files: Option<FileStores>,
    /// The master database (link registry, due index, workspace names). A
    /// request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// System mail (`SEND_EMAIL`); without it signing emails are skipped,
    /// as the workers do without the binding.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Valkey: the outbound mail guard's counters. Without it the guard
    /// fails open, as the TypeScript guard does without its Durable Objects.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Feature flags (`weldmail-outbound-guard`).
    pub flags: Arc<dyn DynFlagSource>,
    /// Starts durable jobs: `sign.finalize` once the last signer signs (the
    /// signer portal, next stage, through [`start_finalize`]).
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// `SIGN_PORTAL_URL`: signing links are `<portal>/r/<token>`.
    pub portal_url: Option<Arc<str>>,
    /// `ENVIRONMENT`: which platform URL emails link to.
    pub environment: Option<Arc<str>>,
}

impl SignState {
    /// The services outside a request (jobs, the sweep).
    pub fn services(&self) -> Services {
        Services {
            events: self.events.clone(),
            files: self.files.clone(),
            mail: self.mail.clone(),
            cache: self.cache.clone(),
            flags: Arc::clone(&self.flags),
            portal_url: self.portal_url.as_deref().map(str::to_owned),
            environment: self.environment.as_deref().map(str::to_owned),
        }
    }
}

impl std::fmt::Debug for SignState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignState")
            .field("files", &self.files.is_some())
            .field("master", &self.master.is_some())
            .field("mail", &self.mail.is_some())
            .field("cache", &self.cache.is_some())
            .field("jobs", &self.jobs.is_some())
            .field("portal_url", &self.portal_url)
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}

/// `/api/sign`, to nest under `/api` behind the session, tenant database,
/// licence and flag layers. Each route carries its `requirePermission`.
pub fn router<S, Q>(state: SignState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    let envelopes = Router::new()
        .route(
            "/",
            get(envelopes::list).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/",
            post(envelopes::create).route_layer(need(SIGN_ENVELOPES_CREATE)),
        )
        .route(
            "/{id}",
            get(envelopes::detail).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/{id}",
            patch(envelopes::update).route_layer(need(SIGN_ENVELOPES_UPDATE)),
        )
        .route(
            "/{id}",
            axum::routing::delete(envelopes::remove).route_layer(need(SIGN_ENVELOPES_DELETE)),
        )
        .route(
            "/{id}/events",
            get(envelopes::events).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/{id}/recipients",
            post(recipients::create).route_layer(need(SIGN_ENVELOPES_UPDATE)),
        )
        .route(
            "/{id}/recipients/suggestions",
            get(recipients::suggestions).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/{id}/recipients/{recipient_id}",
            patch(recipients::update)
                .delete(recipients::remove)
                .route_layer(need(SIGN_ENVELOPES_UPDATE)),
        )
        .route(
            "/{id}/fields",
            put(fields::replace_envelope_fields).route_layer(need(SIGN_ENVELOPES_UPDATE)),
        )
        .merge(lifecycle_routes(gate))
        .merge(document_routes(Scope::Envelope, gate));
    let templates = Router::new()
        .route(
            "/",
            get(templates::list).route_layer(need(SIGN_TEMPLATES_READ)),
        )
        .route(
            "/",
            post(templates::create).route_layer(need(SIGN_TEMPLATES_CREATE)),
        )
        .route(
            "/{id}",
            get(templates::detail).route_layer(need(SIGN_TEMPLATES_READ)),
        )
        .route(
            "/{id}",
            patch(templates::update).route_layer(need(SIGN_TEMPLATES_UPDATE)),
        )
        .route(
            "/{id}",
            axum::routing::delete(templates::remove).route_layer(need(SIGN_TEMPLATES_DELETE)),
        )
        .route(
            "/{id}/use",
            post(templates::use_template)
                .route_layer(need(SIGN_TEMPLATES_READ))
                .route_layer(need(SIGN_ENVELOPES_CREATE)),
        )
        .route(
            "/{id}/roles",
            post(templates::add_role).route_layer(need(SIGN_TEMPLATES_UPDATE)),
        )
        .route(
            "/{id}/roles/{role_id}",
            patch(templates::update_role)
                .delete(templates::remove_role)
                .route_layer(need(SIGN_TEMPLATES_UPDATE)),
        )
        .route(
            "/{id}/fields",
            put(fields::replace_template_fields).route_layer(need(SIGN_TEMPLATES_UPDATE)),
        )
        .merge(document_routes(Scope::Template, gate));
    Router::new()
        .nest("/envelopes", envelopes)
        .nest("/templates", templates)
        .with_state(state)
}

/// Sending and a sent request (`lifecycle.ts`, resend and correct).
fn lifecycle_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<SignState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{id}/send",
            post(lifecycle::send).route_layer(need(SIGN_ENVELOPES_SEND)),
        )
        .route(
            "/{id}/download",
            get(lifecycle::download).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/{id}/void",
            post(lifecycle::void).route_layer(need(SIGN_ENVELOPES_VOID)),
        )
        .route(
            "/{id}/remind",
            post(lifecycle::remind).route_layer(need(SIGN_ENVELOPES_SEND)),
        )
        .route(
            "/{id}/signing-link",
            post(lifecycle::signing_link_route).route_layer(need(SIGN_ENVELOPES_READ)),
        )
        .route(
            "/{id}/recipients/{recipient_id}/resend",
            post(lifecycle::resend).route_layer(need(SIGN_ENVELOPES_SEND)),
        )
        .route(
            "/{id}/recipients/{recipient_id}/correct",
            post(lifecycle::correct).route_layer(need(SIGN_ENVELOPES_SEND)),
        )
}

/// `/:id/documents/*` of a draft or a template.
fn document_routes<Q>(scope: Scope, gate: &Arc<PermissionGate<Q>>) -> Router<SignState>
where
    Q: PermissionQueries + 'static,
{
    use axum::extract::DefaultBodyLimit;
    let update = scope_permission(scope, true);
    let read = scope_permission(scope, false);
    let need = |key: &str| gate.require([key.to_owned()]);
    let (upload, from_drive, order, content, remove) = match scope {
        Scope::Envelope => (
            post(documents::upload_envelope),
            post(documents::from_drive_envelope),
            put(documents::reorder_envelope),
            get(documents::content_envelope),
            axum::routing::delete(documents::remove_envelope),
        ),
        Scope::Template => (
            post(documents::upload_template),
            post(documents::from_drive_template),
            put(documents::reorder_template),
            get(documents::content_template),
            axum::routing::delete(documents::remove_template),
        ),
    };
    Router::new()
        .route(
            "/{id}/documents",
            // Above the 25 MB a PDF may have, so the route says why it refuses.
            upload
                .route_layer(need(update))
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/{id}/documents/from-drive",
            from_drive
                .route_layer(need(weldsuite_catalogs::permission_keys::FILES_READ))
                .route_layer(need(update)),
        )
        .route("/{id}/documents/order", order.route_layer(need(update)))
        .route(
            "/{id}/documents/{document_id}/content",
            content.route_layer(need(read)),
        )
        .route(
            "/{id}/documents/{document_id}",
            remove.route_layer(need(update)),
        )
}

fn scope_permission(scope: Scope, update: bool) -> &'static str {
    match (scope, update) {
        (Scope::Envelope, true) => SIGN_ENVELOPES_UPDATE,
        (Scope::Envelope, false) => SIGN_ENVELOPES_READ,
        (Scope::Template, true) => SIGN_TEMPLATES_UPDATE,
        (Scope::Template, false) => SIGN_TEMPLATES_READ,
    }
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// The workspace is read-only (`c.get('readOnly')`): reads only.
    pub(crate) read_only: bool,
    /// `c.get('clerkOrgId')`: storage keys are `workspaces/<org>/…`.
    pub(crate) clerk_org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id` (link registry, due index).
    pub(crate) workspace_id: String,
    env: Option<RequestEnv>,
    files: Option<FileStores>,
    /// The request's master database (conformance), else the app's.
    master: Option<PgPool>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &SignState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }

    /// The request's buckets (conformance mode), else the app's.
    pub(crate) fn files(&self, state: &SignState) -> Option<FileStores> {
        self.files.clone().or_else(|| state.files.clone())
    }

    /// `c.env.SIGN_SESSION_SECRET`.
    pub(crate) fn session_secret(&self, state: &SignState) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get("SIGN_SESSION_SECRET"))
            .map(str::to_owned)
            .or_else(|| state.session_secret.as_deref().map(str::to_owned))
            .filter(|secret| !secret.is_empty())
    }

    /// A value of `c.env`: the request's (conformance), else the state's.
    fn env_value(&self, name: &str, fallback: Option<&Arc<str>>) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
            .or_else(|| fallback.map(ToString::to_string))
    }

    /// The services the domain code reaches, with the request's overrides.
    pub(crate) fn services(&self, state: &SignState) -> Services {
        Services {
            events: state.events.clone(),
            files: self.files(state),
            mail: state.mail.clone(),
            cache: state.cache.clone(),
            flags: Arc::clone(&state.flags),
            portal_url: self.env_value("SIGN_PORTAL_URL", state.portal_url.as_ref()),
            environment: self.env_value("ENVIRONMENT", state.environment.as_ref()),
        }
    }

    /// `sendContextOf(c)`: the tenant and master databases and both
    /// workspace ids.
    pub(crate) fn send_context(&self, state: &SignState) -> SignResult<SendContext> {
        let (Some(clerk_org_id), false) = (
            self.clerk_org_id.clone().filter(|id| !id.is_empty()),
            self.workspace_id.is_empty(),
        ) else {
            return Err(SignError::invalid("No workspace selected"));
        };
        let master = self
            .master
            .clone()
            .or_else(|| state.master.clone())
            .ok_or_else(|| SignError::Internal("sign: no master database".to_owned()))?;
        Ok(SendContext {
            db: self.db.clone(),
            master,
            clerk_org_id,
            workspace_id: self.workspace_id.clone(),
            services: self.services(state),
        })
    }
}

/// What the domain code reaches outside the databases: the workers' `env`.
#[derive(Clone)]
pub struct Services {
    pub events: EntityEventPublisher,
    pub files: Option<FileStores>,
    pub mail: Option<Arc<dyn DynSystemMail>>,
    pub cache: Option<Arc<dyn DynCache>>,
    pub flags: Arc<dyn DynFlagSource>,
    pub portal_url: Option<String>,
    pub environment: Option<String>,
}

/// What sending, the lifecycle, the sweep and the finalize job work in
/// (`SendContext`): one workspace's tenant database, the master database,
/// both workspace ids and the services.
#[derive(Clone)]
pub(crate) struct SendContext {
    pub(crate) db: PgPool,
    pub(crate) master: PgPool,
    /// Clerk org id: storage prefix, events.
    pub(crate) clerk_org_id: String,
    /// `workspaces.id`: link registry, due index.
    pub(crate) workspace_id: String,
    pub(crate) services: Services,
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
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    read_only: tenant.read_only_reason().is_some(),
                    clerk_org_id: tenant.clerk_org_id.clone(),
                    workspace_id: tenant.workspace_id.clone(),
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    files: parts.extensions.get::<FileStores>().cloned(),
                    master: parts
                        .extensions
                        .get::<weldsuite_db::MasterDb>()
                        .map(|master| master.0.clone()),
                })
            } else {
                tracing::error!("sign: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// What the domain refuses with (`SignError`), and database failures.
/// [`SignError::respond`] is `respondToSignError`.
#[derive(Debug)]
pub(crate) enum SignError {
    /// 404 `<resource> not found` (the id stays out of the message).
    NotFound(&'static str),
    /// 409 with the message.
    Conflict(String),
    /// 400 with the message.
    Invalid(String),
    /// A response the route wrote itself (validation, 401).
    Response(Box<Response>),
    Database(sqlx::Error),
    /// Anything else that fails (the file store); logged, answered with a 500.
    Internal(String),
}

impl SignError {
    /// `notADraft()`: everything after sending is fixed evidence.
    pub(crate) fn not_a_draft() -> Self {
        Self::Conflict("Only a draft can be changed".to_owned())
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub(crate) fn respond(self) -> Response {
        match self {
            Self::NotFound(resource) => ApiError::not_found(resource, None).into_response(),
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Invalid(message) => ApiError::bad_request(message).into_response(),
            Self::Response(response) => *response,
            // Anything else reaches the app's error handler.
            Self::Database(error) => {
                tracing::error!(%error, "sign: database error");
                ApiError::internal().into_response()
            }
            Self::Internal(error) => {
                tracing::error!(error, "sign: request failed");
                ApiError::internal().into_response()
            }
        }
    }
}

impl From<sqlx::Error> for SignError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub(crate) type SignResult<T> = Result<T, SignError>;

/// `handle(c, fn)`: the route's answer, or its error as the API's envelope.
pub(crate) fn answer(result: SignResult<Response>) -> Response {
    result.unwrap_or_else(SignError::respond)
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamptz`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> SignResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| SignError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| SignError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| SignError::Response(Box::new(ApiError::internal().into_response())))
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> SignResult<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| SignError::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// A string column of a row, `""` when null.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// `a || b`: JavaScript's falsy strings (empty, null) fall through.
pub(crate) fn or_else(a: &Value, b: &Value) -> Value {
    match a {
        Value::String(s) if !s.is_empty() => a.clone(),
        _ => match b {
            Value::String(s) if !s.is_empty() => b.clone(),
            _ => Value::Null,
        },
    }
}

/// A list's pagination from an offset cursor: `{ totalCount, hasMore, cursor }`.
pub(crate) fn offset_page(rows: Vec<Value>, total: i64, offset: i64) -> Response {
    let next = offset + i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let has_more = next < total;
    let cursor = has_more.then(|| next.to_string());
    weldsuite_kit::List::new(
        rows,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// `ilike(col, '%…%')` with `%`, `_` and `\` escaped (`escapeLike`).
pub(crate) fn like_pattern(search: &str) -> String {
    let mut out = String::with_capacity(search.len() + 2);
    out.push('%');
    for c in search.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}
