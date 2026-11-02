//! WeldDesk's helpdesk widget API (`apps/workers/helpdesk-widget-api`): the
//! public webchat API a website's widget calls, authenticated by its widget
//! id (`x-widget-id`) instead of a session, and the visitor by the visitor
//! token `POST /api/visitor` issues (`Authorization: Bearer`, ADR DESK-010).
//! The Global worker answers at its own host (`/api/config`); the Rust
//! server serves it under `/public/helpdesk-widget`
//! (`/public/helpdesk-widget/api/config`), and the widget finds it there
//! through its API URL.
//!
//! One module per TypeScript source, named in each module's docs. Paths,
//! bodies, status codes, messages and side effects are the worker's; its
//! tests run against this crate in the `desk: helpdesk widget` conformance
//! suite (`rust/conformance/suites.json`). Its envelope is its own
//! (`src/lib/response.ts`: `{ success, data }`, `{ success, error }`), not
//! the kit's.
//!
//! The Discord bot ingest (`/webhook/discord/*`) is not here: only
//! `discord-bot-worker` calls it, and that worker runs on Global only.
//! Neither is the signed-in help center (`/api/portal/*`): only the help
//! center's server calls it, over a service binding, and the help center
//! has no Kubernetes deployment.

mod attachments;
mod auth;
mod config;
mod conversations;
mod live;
mod office_hours;
mod rate_limit;
mod realtime_token;
mod tokens;
mod visitor;
mod visitor_auth;
mod visitor_identity;

use std::sync::Arc;

use axum::Router;
use axum::extract::{FromRequestParts, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, middleware};
use http::request::Parts;
use serde_json::{Value, json};
use weldsuite_db::{MasterDb, PgPool, Tenant, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{
    DynCache, DynFileStore, DynRealtimePublisher, DynSystemMail, FileStores, RequestCache,
    StorageBuckets,
};

/// `REALTIME_PUBLIC_URL` as the server works it out for a request: the
/// configured URL, else the request's own origin with `/ws`; `None` without
/// a realtime gateway.
pub type RealtimeUrl = Arc<dyn Fn(&HeaderMap) -> Option<String> + Send + Sync>;

/// What the widget API needs from the server.
#[derive(Clone)]
pub struct WidgetState {
    pub events: EntityEventPublisher,
    /// Realtime fan-out (`REALTIME`); without it publishes are skipped, as
    /// the worker does without the binding.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The buckets: visitor uploads go to the public one (`STORAGE`).
    pub files: Option<FileStores>,
    /// The rate limiter's counters (`WORKSPACE_CACHE`); without it nothing
    /// is limited, as the worker does without the binding.
    pub cache: Option<Arc<dyn DynCache>>,
    /// System mail (notification emails); without it they are skipped.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// The master database (`widget_registry`, `workspaces`, `plans`).
    pub master: Option<PgPool>,
    /// Opens a workspace's tenant database by its Clerk org id.
    pub workspaces: Option<Arc<Workspaces>>,
    pub settings: Arc<Settings>,
}

impl std::fmt::Debug for WidgetState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WidgetState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("files", &self.files.is_some())
            .field("cache", &self.cache.is_some())
            .field("mail", &self.mail.is_some())
            .field("master", &self.master.is_some())
            .finish_non_exhaustive()
    }
}

/// The worker's env vars, as this deployment sets them.
#[derive(Clone)]
pub struct Settings {
    /// `ENVIRONMENT`: `production` leaves error messages out of a 500.
    pub environment: String,
    /// `WIDGET_TOKEN_SECRET`: signs the visitor's realtime token (the
    /// realtime gateway verifies it with the same value), and, under a key
    /// derived from it, the visitor tokens (`POST /api/visitor`).
    pub token_secret: Option<String>,
    /// `R2_PUBLIC_URL`: the public bucket's own URL (`S3_PUBLIC_URL`).
    pub public_storage_url: Option<String>,
    /// `REALTIME_PUBLIC_URL`, handed to the widget in `/api/config`.
    pub realtime_url: RealtimeUrl,
    /// `TRUSTED_PROXIES`: the rate limit keys on the `X-Forwarded-For`
    /// entry this many from the right, the one the ingress appended.
    pub trusted_proxies: usize,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("environment", &self.environment)
            .field("token_secret", &self.token_secret.is_some())
            .field("public_storage_url", &self.public_storage_url)
            .field("trusted_proxies", &self.trusted_proxies)
            .finish_non_exhaustive()
    }
}

/// The widget API at its own paths (`/health`, `/api/config`, …), to nest at
/// `/public/helpdesk-widget`. It answers CORS for any origin itself, as the
/// worker does (`cors({ origin: '*' })`): a widget is embedded on the
/// customer's sites, so the server's first-party CORS must not wrap it.
pub fn router(state: WidgetState) -> Router {
    let api = Router::new()
        .route("/config", get(config::get_config))
        .route("/visitor", post(visitor::session))
        .nest("/conversations", conversations::routes())
        .route("/realtime/token", post(realtime_token::token))
        .route(
            "/attachments/upload",
            post(attachments::upload).layer(attachments::body_limit()),
        )
        .fallback(api_not_found)
        // Innermost: the visitor routes need the widget the auth found.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            visitor_auth::visitor_auth,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::widget_auth,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::rate_limit,
        ));
    Router::new()
        .route("/robots.txt", get(robots))
        .route("/health", get(health))
        .nest("/api", api)
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(state)
        .layer(middleware::from_fn(cors))
}

/// `cors({ origin: '*', allowMethods, allowHeaders: ['Content-Type', 'x-widget-id', 'Authorization'], credentials: false })`,
/// as Hono answers it: every `OPTIONS` request is a preflight, answered 204
/// before any other middleware, and every other response gets
/// `Access-Control-Allow-Origin: *`, refusals included.
async fn cors(request: Request, next: Next) -> Response {
    let any = HeaderValue::from_static("*");
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, any);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type,x-widget-id,Authorization"),
        );
        return response;
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, any);
    response
}

async fn robots() -> &'static str {
    "User-agent: *\nDisallow: /\n"
}

async fn health(
    ctx: Ctx,
    axum::extract::State(state): axum::extract::State<WidgetState>,
) -> Response {
    Json(json!({
        "status": "ok",
        "environment": ctx.environment(&state),
        "timestamp": weldsuite_desk_domain::webchat::now(),
    }))
    .into_response()
}

/// `app.notFound`: `{ error: 'Not Found', path }`, the path on the
/// worker's own host.
async fn not_found(uri: Uri) -> Response {
    not_found_at(uri.path())
}

/// [`not_found`] under `/api`, whose router sees the path without it.
async fn api_not_found(uri: Uri) -> Response {
    not_found_at(&format!("/api{}", uri.path()))
}

fn not_found_at(path: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Not Found", "path": path })),
    )
        .into_response()
}

// ── the envelope (`src/lib/response.ts`) ─────────────────────────────────────

/// `success(c, data, status)`.
pub(crate) fn success(status: StatusCode, data: Value) -> Response {
    let mut body = serde_json::Map::new();
    body.insert("success".to_owned(), Value::Bool(true));
    body.insert("data".to_owned(), data);
    (status, Json(Value::Object(body))).into_response()
}

/// `error.<kind>(c, message)`: `{ success: false, error: { code, message } }`.
pub(crate) fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "success": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// `error.badRequest(c, message)`.
pub(crate) fn bad_request(message: &str) -> Response {
    failure(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
}

/// `error.notFound(c, resource, id)`.
pub(crate) fn not_found_error(resource: &str, id: &str) -> Response {
    failure(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        &format!("{resource} with ID '{id}' not found"),
    )
}

/// `error.internal(c, message)`.
pub(crate) fn internal(message: &str) -> Response {
    failure(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", message)
}

/// `app.onError`: an error no route caught. Production leaves the message
/// out, as `JSON.stringify` drops `message: undefined`.
pub(crate) fn uncaught(ctx: &Ctx, state: &WidgetState, message: &str) -> Response {
    let body = if ctx.environment(state) == "production" {
        json!({ "error": "Internal Server Error" })
    } else {
        json!({ "error": "Internal Server Error", "message": message })
    };
    (StatusCode::INTERNAL_SERVER_ERROR, Json(body)).into_response()
}

// ── the request's context ───────────────────────────────────────────────────

/// What a widget route reads off its request: in conformance builds the
/// test's env, master and tenant databases, KV namespace and buckets stand
/// in for the state's, and a binding the test left out is missing.
pub(crate) struct Ctx {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    tenant: Option<PgPool>,
    cache: Option<Arc<dyn DynCache>>,
    buckets: Option<StorageBuckets>,
    headers: HeaderMap,
}

impl<S: Send + Sync> FromRequestParts<S> for Ctx {
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
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            buckets: extensions.get::<StorageBuckets>().cloned(),
            headers: parts.headers.clone(),
        }))
    }
}

impl Ctx {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    /// The test's `env.<name>` (conformance builds).
    fn test_env(&self, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
    }

    /// `c.env.ENVIRONMENT`.
    pub(crate) fn environment(&self, state: &WidgetState) -> String {
        if self.conformance() {
            return self.test_env("ENVIRONMENT").unwrap_or_default();
        }
        state.settings.environment.clone()
    }

    /// `c.env.WIDGET_TOKEN_SECRET`.
    pub(crate) fn token_secret(&self, state: &WidgetState) -> Option<String> {
        if self.conformance() {
            return self.test_env("WIDGET_TOKEN_SECRET");
        }
        state.settings.token_secret.clone()
    }

    /// `c.env.R2_PUBLIC_URL`.
    pub(crate) fn public_storage_url(&self, state: &WidgetState) -> Option<String> {
        if self.conformance() {
            return self.test_env("R2_PUBLIC_URL");
        }
        state.settings.public_storage_url.clone()
    }

    /// `c.env.REALTIME_PUBLIC_URL`.
    pub(crate) fn realtime_url(&self, state: &WidgetState) -> Option<String> {
        if self.conformance() {
            return self.test_env("REALTIME_PUBLIC_URL");
        }
        (state.settings.realtime_url)(&self.headers)
    }

    pub(crate) fn master(&self, state: &WidgetState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// `c.env.WORKSPACE_CACHE`.
    pub(crate) fn kv(&self, state: &WidgetState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    /// `c.env.STORAGE`: the public bucket.
    pub(crate) fn public_bucket(&self, state: &WidgetState) -> Option<Arc<dyn DynFileStore>> {
        if self.conformance() {
            return self.buckets.as_ref().and_then(|b| b.public.clone());
        }
        state.files.as_ref().and_then(|files| files.public.clone())
    }

    /// `getTenantDbForWorkspace(env, ref)`: the test's tenant database in
    /// conformance builds (every workspace opens it), else the workspace's.
    pub(crate) async fn tenant_db(
        &self,
        state: &WidgetState,
        reference: &str,
    ) -> Result<PgPool, String> {
        if let Some(db) = &self.tenant {
            return Ok(db.clone());
        }
        let Some(workspaces) = &state.workspaces else {
            return Err("no workspace resolver".to_owned());
        };
        workspaces
            .tenant(reference)
            .await
            .map(|tenant| tenant.db)
            .map_err(|error| error.to_string())
    }
}
