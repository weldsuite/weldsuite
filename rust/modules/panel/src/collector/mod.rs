//! The public collector: panel-ingest's routes (`apps/workers/panel-ingest`).
//!
//! Tracked websites and apps send here: no session, the project token in
//! the request names the project. It never opens a tenant database; the
//! project comes from the cache record the project routes keep
//! (`panel:project:<token>`), and here, where the cache is not durable
//! storage, from the master registry when the record is missing.
//!
//!   GET  /health      the worker's health answer (under `/public/panel` only)
//!   GET  /s.js        the browser SDK bundle (`PANEL_SDK_FILE`)
//!   GET  /c/:token    the client config
//!   POST /e           an event batch → the events stream
//!
//! The server serves these under `/public/panel` and, so that the script
//! tag's own origin is a collector, at the root of every host.

mod ip_filter;
mod rows;
mod url;
mod user_agent;
mod visitor;
mod wire;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use http_body_util::{BodyExt, Limited};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use weldsuite_db::{MasterDb, PgPool};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{
    BoxFuture, BusMessage, Cache, DynCache, DynEventBus, EventBus, PortError, RequestCache,
};

pub use visitor::{CacheSalt, CacheUsage};

use crate::domain::{ProjectRecord, is_allowed_origin, is_project_token, project_key, seen_key};
use crate::js::Js;
use rows::{Geo, RowSource, build_event_rows, consented_anon_id, iso_millis, parse_millis};
use visitor::{cookieless_visitor_id, utc_date};
use wire::{EventBatch, MAX_BATCH_BYTES, parse_event_batch};

/// `PanelSalt.today()`: today's (UTC) salt of the cookieless visitor hash.
pub trait SaltSource: Send + Sync {
    fn today(&self, now_ms: i64) -> BoxFuture<'_, Result<String, PortError>>;
}

/// `PanelUsage.add(day, events)` of one workspace.
pub trait UsageCounter: Send + Sync {
    fn add<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        events: u64,
    ) -> BoxFuture<'a, Result<(), PortError>>;
}

/// `PANEL_EVENTS.send(rows)`: the `events_v1` stream.
pub trait EventSink: Send + Sync {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>>;
}

/// The events stream on the event bus (a NATS `JetStream` stream): one message per
/// row on `<prefix>.<workspace>`, its id `<project>:<event_id>`, so a batch
/// the SDK sends again inside the stream's duplicate window is not stored
/// twice.
pub struct BusSink {
    bus: Arc<dyn DynEventBus>,
    subject_prefix: String,
}

impl BusSink {
    pub fn new(bus: Arc<dyn DynEventBus>, subject_prefix: impl Into<String>) -> Self {
        Self {
            bus,
            subject_prefix: subject_prefix.into(),
        }
    }
}

impl EventSink for BusSink {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let messages = rows
                .iter()
                .map(|row| {
                    let field =
                        |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default();
                    BusMessage::json(
                        format!("{}.{}", self.subject_prefix, field("workspace_id")),
                        format!("{}:{}", field("project_id"), field("event_id")),
                        row,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let sent = futures_util::future::join_all(
                messages
                    .into_iter()
                    .map(|message| self.bus.publish(message)),
            )
            .await;
            sent.into_iter().collect::<Result<Vec<()>, _>>().map(|_| ())
        })
    }
}

/// The test's stream and Durable Objects (conformance): each one the test
/// binds, or none, as the worker runs without the bindings it lacks.
#[derive(Clone, Default)]
pub struct RequestCollector {
    pub salt: Option<Arc<dyn SaltSource>>,
    pub usage: Option<Arc<dyn UsageCounter>>,
    pub sink: Option<Arc<dyn EventSink>>,
}

/// The browser SDK bundle and its strong validator.
#[derive(Debug, Clone)]
pub struct SdkBundle {
    text: String,
    etag: String,
}

impl SdkBundle {
    /// The bundle at `path` (`pnpm --filter @weldsuite/panel-sdk build`'s
    /// `dist/panel.global.js`), or `None` when it can't be read.
    pub fn load(path: &str) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        let digest = hex::encode(Sha256::digest(text.as_bytes()));
        Some(Self {
            etag: format!("\"{}\"", &digest[..32]),
            text,
        })
    }
}

/// What the collector shares.
#[derive(Clone)]
pub struct CollectorState {
    /// Background work runs on its tracker, as `waitUntil` does.
    pub events: EntityEventPublisher,
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master registry, read when the cache has no record for a token.
    pub master: Option<PgPool>,
    pub salt: Option<Arc<dyn SaltSource>>,
    pub usage: Option<Arc<dyn UsageCounter>>,
    pub sink: Option<Arc<dyn EventSink>>,
    pub environment: String,
    pub sdk: Option<Arc<SdkBundle>>,
    /// How many proxies in front append to `X-Forwarded-For`.
    pub trusted_proxies: usize,
    seen: Arc<SeenThrottle>,
}

impl CollectorState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        events: EntityEventPublisher,
        cache: Option<Arc<dyn DynCache>>,
        master: Option<PgPool>,
        salt: Option<Arc<dyn SaltSource>>,
        usage: Option<Arc<dyn UsageCounter>>,
        sink: Option<Arc<dyn EventSink>>,
        environment: String,
        sdk: Option<Arc<SdkBundle>>,
        trusted_proxies: usize,
    ) -> Self {
        Self {
            events,
            cache,
            master,
            salt,
            usage,
            sink,
            environment,
            sdk,
            trusted_proxies,
            seen: Arc::new(SeenThrottle::default()),
        }
    }
}

impl std::fmt::Debug for CollectorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollectorState")
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("sink", &self.sink.is_some())
            .field("sdk", &self.sdk.is_some())
            .finish_non_exhaustive()
    }
}

/// `/health`, `/s.js`, `/c/{token}` and `/e`, with the collector's CORS and
/// its 404, to nest under `/public/panel`.
pub fn router(state: CollectorState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/s.js", get(script))
        .route("/c/{token}", get(config))
        .route("/e", post(events))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn(cors))
        .with_state(state)
}

/// `/s.js`, `/c/{token}` and `/e` at the root of every host: the snippet's
/// script tag makes its own origin the collector.
pub fn root_router(state: CollectorState) -> Router {
    Router::new()
        .route("/s.js", get(script).options(preflight))
        .route("/c/{token}", get(config).options(preflight))
        .route("/e", post(events).options(preflight))
        .layer(axum::middleware::from_fn(cors))
        .with_state(state)
}

/// What the request brings (conformance): the test's env, KV, master
/// database and bindings.
struct Ctx {
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    ports: Option<RequestCollector>,
}

impl Ctx {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    fn env(&self, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name).map(str::to_owned))
            .filter(|value| !value.is_empty())
    }

    fn cache(&self, state: &CollectorState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    fn master(&self, state: &CollectorState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        state.master.clone()
    }

    fn ports(&self, state: &CollectorState) -> RequestCollector {
        if self.conformance() {
            return self.ports.clone().unwrap_or_default();
        }
        RequestCollector {
            salt: state.salt.clone(),
            usage: state.usage.clone(),
            sink: state.sink.clone(),
        }
    }

    /// Now, or the test's clock (`CONFORMANCE_NOW`).
    fn now_ms(&self) -> i64 {
        self.env("CONFORMANCE_NOW")
            .and_then(|now| parse_millis(&now))
            .unwrap_or_else(|| {
                i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
                    .unwrap_or_default()
            })
    }
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
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            ports: extensions.get::<RequestCollector>().cloned(),
        }))
    }
}

/// The collector answers any site: the request's own `Origin` is echoed
/// back (`*` without one), never with credentials. A preflight is 204.
async fn cors(request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get("origin")
        .filter(|value| !value.is_empty())
        .cloned();
    let mut response = if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("Content-Type"),
        );
        headers.insert("access-control-max-age", HeaderValue::from_static("86400"));
        response
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin);
        headers.insert("vary", HeaderValue::from_static("Origin"));
    } else {
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    }
    response
}

/// Answered by [`cors`] before it gets here.
async fn preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// Hono's own 404.
async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "404 Not Found",
    )
        .into_response()
}

fn reject(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// The worker's `onError`.
fn went_wrong(error: &dyn std::fmt::Display, what: &str) -> Response {
    tracing::error!(%error, "[panel-ingest] {what} failed");
    reject(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "Something went wrong",
    )
}

/// `GET /health`.
async fn health(State(state): State<CollectorState>, ctx: Ctx) -> Response {
    let environment = if ctx.conformance() {
        ctx.env("ENVIRONMENT").unwrap_or_default()
    } else {
        state.environment.clone()
    };
    axum::Json(json!({ "ok": true, "service": "panel-ingest", "environment": environment }))
        .into_response()
}

/// `If-None-Match` is a list of validators or `*`; weak ones compare equal for GET.
fn matches_etag(header: Option<&str>, current: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    if header.trim() == "*" {
        return true;
    }
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate.strip_prefix("W/").unwrap_or(candidate) == current
    })
}

/// `GET /s.js`: the same bundle for every project, cacheable for an hour.
async fn script(State(state): State<CollectorState>, ctx: Ctx, headers: HeaderMap) -> Response {
    let bundle = if ctx.conformance() {
        ctx.env("PANEL_SDK_FILE")
            .and_then(|path| SdkBundle::load(&path))
            .map(Arc::new)
    } else {
        state.sdk.clone()
    };
    let Some(bundle) = bundle else {
        return reject(
            StatusCode::NOT_FOUND,
            "not_found",
            "The WeldPanel SDK bundle is not installed on this server",
        );
    };
    let cache_headers = [
        ("cache-control", "public, max-age=3600".to_owned()),
        ("etag", bundle.etag.clone()),
    ];
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok());
    if matches_etag(if_none_match, &bundle.etag) {
        return (StatusCode::NOT_MODIFIED, cache_headers).into_response();
    }
    (
        StatusCode::OK,
        cache_headers,
        [(CONTENT_TYPE, "application/javascript; charset=utf-8")],
        bundle.text.clone(),
    )
        .into_response()
}

/// `loadProject(env, token)`: the project a token names, settings filled
/// in; `None` for a malformed, unknown or deleted token. A record missing
/// from the cache is read from the master registry and put back for ten
/// minutes (only ten: a deletion racing the read must not keep a dead token
/// alive).
async fn load_project(
    ctx: &Ctx,
    state: &CollectorState,
    token: &str,
) -> Result<Option<ProjectRecord>, PortError> {
    if !is_project_token(token) {
        return Ok(None);
    }
    let cache = ctx.cache(state);
    if let Some(cache) = &cache
        && let Some(record) = ProjectRecord::parse(cache.get(&project_key(token)).await?.as_deref())
    {
        return Ok(Some(record));
    }
    let Some(master) = ctx.master(state) else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from panel_project_registry r
         where r.token = $1 and r.deleted_at is null limit 1",
    )
    .bind(token)
    .fetch_optional(&master)
    .await
    .map_err(PortError::backend)?;
    let Some(row) = row.map(weldsuite_db::js_row) else {
        return Ok(None);
    };
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let record = crate::domain::project_record(
        row.get("projectId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        row.get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &field("status"),
        &field("allowedDomains"),
        &field("settings"),
    )
    .to_string();
    if let Some(cache) = &cache
        && let Err(error) = cache
            .put(&project_key(token), &record, Some(Duration::from_secs(600)))
            .await
    {
        tracing::warn!(%error, "[panel-ingest] could not cache a project record");
    }
    Ok(ProjectRecord::parse(Some(&record)))
}

/// `GET /c/:token`: what the SDK needs before it collects anything.
async fn config(
    State(state): State<CollectorState>,
    ctx: Ctx,
    Path(token): Path<String>,
) -> Response {
    let project = match load_project(&ctx, &state, &token).await {
        Ok(project) => project,
        Err(error) => return went_wrong(&error, "GET /c"),
    };
    let Some(project) = project else {
        // Not cached: a project created a moment ago must not stay unknown for minutes.
        let mut response = reject(
            StatusCode::NOT_FOUND,
            "unknown_project",
            "Unknown project token",
        );
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        return response;
    };
    let setting = |key: &str| project.settings.get(key).cloned().unwrap_or(Value::Null);
    let mut response = axum::Json(json!({
        "autocapture": setting("autocapture"),
        "consentMode": setting("consentMode"),
        "maskingLevel": setting("maskingLevel"),
        "excludedUrls": setting("excludedUrls"),
    }))
    .into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=300"),
    );
    response
}

/// The client's address: the `X-Forwarded-For` entry the ingress appended
/// (`trusted_proxies` from the right). On Global, Cloudflare sets
/// `CF-Connecting-IP`; nothing in front of this server does, so a client
/// could send any, and it is ignored. Empty when there is none.
fn client_ip(headers: &HeaderMap, trusted_proxies: usize) -> String {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .map(|ip| (*ip).to_owned())
        .unwrap_or_default()
}

/// The request body as text, at most `limit` bytes (`readTextLimited`);
/// `None` when larger.
async fn read_text_limited(headers: &HeaderMap, body: Body, limit: usize) -> Option<String> {
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .map(weldsuite_kit::validation::js_number);
    #[allow(clippy::cast_precision_loss)]
    if declared.is_some_and(|declared| declared.is_finite() && declared > limit as f64) {
        return None;
    }
    let bytes = Limited::new(body, limit).collect().await.ok()?.to_bytes();
    // `TextDecoder` drops a byte order mark and replaces what isn't UTF-8.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// `POST /e`: a batch of events. Everything that can be decided from the
/// request is decided before the answer; what we choose not to count
/// (paused project, bot, filtered IP) is accepted with 204 and dropped. The
/// rows are written in the background, after the 204.
async fn events(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !content_type.is_empty()
        && content_type != "text/plain"
        && content_type != "application/json"
    {
        return reject(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Send the batch as text/plain or application/json",
        );
    }
    let Some(text) = read_text_limited(&headers, body, MAX_BATCH_BYTES).await else {
        return reject(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            &format!("A batch is at most {MAX_BATCH_BYTES} bytes"),
        );
    };
    let Ok(body) = serde_json::from_str::<Js>(&text) else {
        return reject(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "The body is not valid JSON",
        );
    };
    let batch = match parse_event_batch(&body) {
        Ok(batch) => batch,
        Err(message) => return reject(StatusCode::BAD_REQUEST, "invalid_batch", &message),
    };
    let project = match load_project(&ctx, &state, &batch.token).await {
        Ok(Some(project)) => project,
        Ok(None) => {
            return reject(
                StatusCode::NOT_FOUND,
                "unknown_project",
                "Unknown project token",
            );
        }
        Err(error) => return went_wrong(&error, "POST /e"),
    };
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    if !is_allowed_origin(origin, &project.allowed_domains) {
        return reject(
            StatusCode::FORBIDDEN,
            "origin_not_allowed",
            "This site is not an allowed domain of the project",
        );
    }

    let ip = client_ip(&headers, state.trusted_proxies);
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let dropped = project.status == "paused"
        || user_agent::is_bot_user_agent(&user_agent)
        || ip_filter::matches_ip_filter(&ip, &project.setting_strings("ipFilters"));
    if dropped {
        return StatusCode::NO_CONTENT.into_response();
    }

    let accepted = Accepted {
        project,
        batch,
        received_at: ctx.now_ms(),
        ip,
        user_agent,
    };
    let ports = ctx.ports(&state);
    let cache = ctx.cache(&state);
    let seen = Arc::clone(&state.seen);
    state
        .events
        .tracker()
        .spawn(async move { collect(accepted, ports, cache, seen).await });
    StatusCode::NO_CONTENT.into_response()
}

/// An accepted batch (`AcceptedBatch`).
struct Accepted {
    project: ProjectRecord,
    batch: EventBatch,
    received_at: i64,
    /// Used for the cookieless hash only, never stored.
    ip: String,
    user_agent: String,
}

/// Failures are logged with ids and counts only, never request data.
fn log_failure(what: &str, project: &ProjectRecord, error: &dyn std::fmt::Display) {
    tracing::error!(
        project = %project.project_id,
        "[panel-ingest] {what} failed for project {}: {error}",
        project.project_id
    );
}

/// `collectEvents(env, accepted)`: the rows to the stream, then the day's
/// count and the install-check stamp, which never fail the write that
/// already happened.
async fn collect(
    accepted: Accepted,
    ports: RequestCollector,
    cache: Option<Arc<dyn DynCache>>,
    seen: Arc<SeenThrottle>,
) {
    let Accepted {
        project,
        batch,
        received_at,
        ip,
        user_agent,
    } = accepted;
    // Events that need a cookieless id are left out when the salt is
    // unavailable: an id built without it would be stable across days.
    let mut cookieless_id = None;
    if batch
        .events
        .iter()
        .any(|event| consented_anon_id(&batch, event).is_none())
    {
        match &ports.salt {
            Some(salt) => match salt.today(received_at).await {
                Ok(salt) => {
                    cookieless_id = Some(cookieless_visitor_id(
                        &salt,
                        &project.project_id,
                        &ip,
                        &user_agent,
                    ));
                }
                Err(error) => log_failure("Salt lookup", &project, &error),
            },
            None => log_failure("Salt lookup", &project, &"no salt source"),
        }
    }
    let rows = build_event_rows(&RowSource {
        record: &project,
        batch: &batch,
        received_at,
        user_agent: user_agent::parse_user_agent(&user_agent),
        geo: Geo::default(),
        cookieless_id,
    });
    if rows.is_empty() {
        return;
    }
    let Some(sink) = &ports.sink else {
        log_failure("Event write", &project, &"no events stream");
        return;
    };
    if let Err(error) = sink.send(&rows).await {
        log_failure("Event write", &project, &error);
        return;
    }
    let day = utc_date(received_at);
    let count = rows.len() as u64;
    let usage = async {
        match &ports.usage {
            Some(usage) => usage.add(&project.workspace_id, &day, count).await,
            None => Err(PortError::backend("no usage counter")),
        }
    };
    let stamp = async {
        match &cache {
            Some(cache) => seen.touch(cache, &project.project_id, received_at).await,
            None => Err(PortError::backend("no cache")),
        }
    };
    let (usage, stamp) = futures_util::join!(usage, stamp);
    for result in [usage, stamp] {
        if let Err(error) = result {
            log_failure("Usage count or seen marker", &project, &error);
        }
    }
}

/// `lib/seen.ts`: `panel:seen:<project>` written at most once per five
/// minutes per process and project, kept 90 days.
#[derive(Default)]
struct SeenThrottle(Mutex<HashMap<String, i64>>);

const SEEN_INTERVAL_MS: i64 = 5 * 60 * 1000;
const SEEN_TTL: Duration = Duration::from_hours(90 * 24);
const SEEN_MAX_REMEMBERED: usize = 2000;

impl SeenThrottle {
    async fn touch(
        &self,
        cache: &Arc<dyn DynCache>,
        project_id: &str,
        now: i64,
    ) -> Result<(), PortError> {
        {
            let mut written = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(last) = written.get(project_id)
                && now - last < SEEN_INTERVAL_MS
            {
                return Ok(());
            }
            if written.len() >= SEEN_MAX_REMEMBERED {
                written.clear();
            }
            written.insert(project_id.to_owned(), now);
        }
        let result = cache
            .put(&seen_key(project_id), &iso_millis(now), Some(SEEN_TTL))
            .await;
        if result.is_err() {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(project_id);
        }
        result
    }
}
