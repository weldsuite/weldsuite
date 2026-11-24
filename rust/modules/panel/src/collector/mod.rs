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
//!   GET  /rec.js      its recording plugin (`PANEL_RECORDER_FILE`)
//!   GET  /v.js        its web vitals plugin (`PANEL_VITALS_FILE`)
//!   GET  /c/:token    the client config
//!   POST /e           an event batch → the events stream
//!   POST /r           a recording chunk → the panel bucket, its row → the chunk index
//!   POST /snap        a heatmap page snapshot → the panel bucket
//!   POST /v1/track    server-side events (secret key)
//!   POST /v1/import   historical events (secret key)
//!
//! The server serves these under `/public/panel` and, so that the script
//! tag's own origin is a collector, at the root of every host.

mod bundles;
mod ip_filter;
mod limits;
mod project;
mod proxy;
mod recordings;
mod replays_store;
mod rows;
mod server;
mod url;
mod user_agent;
mod visitor;
mod wire;
mod wire_server;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
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
use http_body_util::BodyExt;
use sea_orm::{ColumnTrait, EntityTrait, JoinType, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{MasterDb, PgPool, orm};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{
    BoxFuture, BusMessage, Cache, DynCache, DynEventBus, DynFileStore, EventBus, PortError,
    RequestCache,
};
use weldsuite_schema::master::{panel_project_registry as registry, plans, workspaces};

pub use bundles::{Bundles, ScriptBundle};
pub use limits::{CacheRateLimiter, Limit, RateLimiter};
pub use replays_store::PanelBucketReplays;
pub use visitor::{CacheSalt, CacheUsage};

use crate::domain::{
    ProjectRecord, is_allowed_origin, is_project_token, parse_quota_state, parse_snapshot_request,
    project_key, quota_key, seen_key, snapshot_request_key,
};
use crate::js::{Js, number_value};
use crate::project_state::{PanelProjectState, ProjectRef};
use limits::rate_limited;
use project::ProjectCaches;
use proxy::{Addresses, Edge, request_addresses};
use rows::{Geo, RowSource, build_event_rows, consented_anon_id, iso_millis, parse_millis};
use visitor::{cookieless_visitor_id, utc_date};
use wire::{EventBatch, MAX_BATCH_BYTES, parse_event_batch};

/// `PanelSalt.today()`: today's (UTC) salt of the cookieless visitor hash.
pub trait SaltSource: Send + Sync {
    fn today(&self, now_ms: i64) -> BoxFuture<'_, Result<String, PortError>>;
}

/// `PanelUsage.add(day, events)` and `PanelUsage.addRecordings(day,
/// recordings)` of one workspace.
pub trait UsageCounter: Send + Sync {
    fn add<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        events: u64,
    ) -> BoxFuture<'a, Result<(), PortError>>;

    fn add_recordings<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        recordings: u64,
    ) -> BoxFuture<'a, Result<(), PortError>>;
}

/// `<stream>.send(rows)`: the `events_v1` stream (`PANEL_EVENTS`), or the
/// `replay_chunks_v1` one (`PANEL_REPLAY_CHUNKS`).
pub trait EventSink: Send + Sync {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>>;
}

/// A stream on the event bus (a NATS `JetStream` stream): one message per
/// row on `<prefix>.<workspace>`, with an id the row decides, so a row sent
/// again inside the stream's duplicate window is not stored twice.
pub struct BusSink {
    bus: Arc<dyn DynEventBus>,
    subject_prefix: String,
    id: fn(&Value) -> String,
}

fn row_text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

impl BusSink {
    /// The events stream (`panel.events.v1`): ids `<project>:<event_id>`.
    pub fn new(bus: Arc<dyn DynEventBus>, subject_prefix: impl Into<String>) -> Self {
        Self {
            bus,
            subject_prefix: subject_prefix.into(),
            id: |row| {
                format!(
                    "{}:{}",
                    row_text(row, "project_id"),
                    row_text(row, "event_id")
                )
            },
        }
    }

    /// The recording chunk index (`panel.replays.v1`, `PANEL_STATE`): ids
    /// are the chunk's object key, one per session and sequence number.
    pub fn replay_chunks(bus: Arc<dyn DynEventBus>, subject_prefix: impl Into<String>) -> Self {
        Self {
            bus,
            subject_prefix: subject_prefix.into(),
            id: |row| row_text(row, "r2_key").to_owned(),
        }
    }
}

impl EventSink for BusSink {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let messages = rows
                .iter()
                .map(|row| {
                    BusMessage::json(
                        format!("{}.{}", self.subject_prefix, row_text(row, "workspace_id")),
                        (self.id)(row),
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

/// What the collector writes to and counts on, each one optional, as the
/// worker runs without the bindings it lacks: the app state's on this
/// install, the test's in conformance (a request extension, which wins).
#[derive(Clone, Default)]
pub struct RequestCollector {
    /// `PANEL_SALT`.
    pub salt: Option<Arc<dyn SaltSource>>,
    /// `PANEL_USAGE`.
    pub usage: Option<Arc<dyn UsageCounter>>,
    /// `PANEL_EVENTS`.
    pub sink: Option<Arc<dyn EventSink>>,
    /// `PANEL_REPLAY_CHUNKS`: the `replay_chunks_v1` rows of `POST /r`.
    pub chunks: Option<Arc<dyn EventSink>>,
    /// `PANEL_REPLAYS`: the bucket recording chunks and heatmap snapshots
    /// go to (the panel bucket here).
    pub replays: Option<Arc<dyn DynFileStore>>,
    /// The per-IP rate limits (`EVENTS_RATE_LIMIT`, …).
    pub limits: Option<Arc<dyn RateLimiter>>,
    /// `PANEL_PROJECT`: the project's people, identities, groups and live
    /// view. Here the collector's adapter, which never opens a tenant
    /// database (ADR DATA-008).
    pub project_state: Option<Arc<dyn PanelProjectState>>,
}

/// What the collector shares.
#[derive(Clone)]
pub struct CollectorState {
    /// Background work runs on its tracker, as `waitUntil` does.
    pub events: EntityEventPublisher,
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master registry, read when the cache has no record for a token
    /// or a secret key.
    pub master: Option<PgPool>,
    /// The streams, objects, bucket and limits of this install.
    pub ports: RequestCollector,
    pub environment: String,
    pub bundles: Bundles,
    /// How many proxies in front append to `X-Forwarded-For`: the hop that
    /// many from the right is the address that connected to them (the
    /// connecting address of a request a customer's proxy forwarded). The
    /// visitor's address is the first hop, which a site's own proxy sets
    /// (`proxy::request_addresses`).
    pub trusted_proxies: usize,
    seen: Arc<SeenThrottle>,
    /// The group types and live view touches this process keeps.
    project_caches: Arc<ProjectCaches>,
}

impl CollectorState {
    pub fn new(
        events: EntityEventPublisher,
        cache: Option<Arc<dyn DynCache>>,
        master: Option<PgPool>,
        ports: RequestCollector,
        environment: String,
        bundles: Bundles,
        trusted_proxies: usize,
    ) -> Self {
        Self {
            events,
            cache,
            master,
            ports,
            environment,
            bundles,
            trusted_proxies,
            seen: Arc::new(SeenThrottle::default()),
            project_caches: Arc::new(ProjectCaches::default()),
        }
    }
}

impl std::fmt::Debug for CollectorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollectorState")
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("sink", &self.ports.sink.is_some())
            .field("chunks", &self.ports.chunks.is_some())
            .field("replays", &self.ports.replays.is_some())
            .field("limits", &self.ports.limits.is_some())
            .field("project_state", &self.ports.project_state.is_some())
            .field("bundles", &self.bundles)
            .finish_non_exhaustive()
    }
}

/// The collector's routes, with its CORS and its 404, to nest under
/// `/public/panel`.
pub fn router(state: CollectorState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/s.js", get(bundles::sdk))
        .route("/rec.js", get(bundles::recorder))
        .route("/v.js", get(bundles::vitals))
        .route("/c/{token}", get(config))
        .route("/e", post(events))
        .route("/r", post(recordings::chunk))
        .route("/snap", post(recordings::snapshot))
        .route("/v1/track", post(server::track))
        .route("/v1/import", post(server::import))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn(cors))
        .with_state(state)
}

/// The same routes (but `/health`) at the root of every host: the
/// snippet's script tag makes its own origin the collector, and the server
/// SDK posts to that origin too.
pub fn root_router(state: CollectorState) -> Router {
    Router::new()
        .route("/s.js", get(bundles::sdk).options(preflight))
        .route("/rec.js", get(bundles::recorder).options(preflight))
        .route("/v.js", get(bundles::vitals).options(preflight))
        .route("/c/{token}", get(config).options(preflight))
        .route("/e", post(events).options(preflight))
        .route("/r", post(recordings::chunk).options(preflight))
        .route("/snap", post(recordings::snapshot).options(preflight))
        .route("/v1/track", post(server::track).options(preflight))
        .route("/v1/import", post(server::import).options(preflight))
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
        state.ports.clone()
    }

    /// Who sent the request: in conformance the harness plays Cloudflare's
    /// edge (`CF-Connecting-IP`), here the trusted proxies in front.
    fn addresses(&self, state: &CollectorState, headers: &HeaderMap) -> Addresses {
        let edge = if self.conformance() {
            Edge::Cloudflare
        } else {
            Edge::TrustedProxies(state.trusted_proxies)
        };
        request_addresses(headers, edge)
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

/// Over a per-IP limit: 429, try again in ten seconds.
fn too_many() -> Response {
    let mut response = reject(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "Too many requests",
    );
    response
        .headers_mut()
        .insert("retry-after", HeaderValue::from_static("10"));
    response
}

/// `warnOnce(key, message)`: one log line per problem per process, so a
/// missing optional binding is visible without a line per request.
fn warn_once(key: &str, message: &str) {
    static WARNED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);
    if WARNED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key.to_owned())
    {
        tracing::warn!("[panel-ingest] {message}");
    }
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

/// `loadProject(env, token)`: the project a token names, settings filled
/// in; `None` for a malformed, unknown or deleted token. A record missing
/// from the cache is read from the master registry and put back for ten
/// minutes (only ten: a deletion racing the read must not keep a dead token
/// alive), with the replay tier of the workspace's plan as the project
/// routes write it.
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
    let row: Option<(String, String, String, Value, Value, Option<String>)> =
        registry::Entity::find()
            .select_only()
            .columns([
                registry::Column::ProjectId,
                registry::Column::WorkspaceId,
                registry::Column::Status,
                registry::Column::AllowedDomains,
                registry::Column::Settings,
            ])
            .column(plans::Column::Slug)
            .join(
                JoinType::LeftJoin,
                registry::Entity::belongs_to(workspaces::Entity)
                    .from(registry::Column::WorkspaceId)
                    .to(workspaces::Column::Id)
                    .into(),
            )
            .join(
                JoinType::LeftJoin,
                workspaces::Entity::belongs_to(plans::Entity)
                    .from(workspaces::Column::PlanId)
                    .to(plans::Column::Id)
                    .into(),
            )
            .filter(registry::Column::Token.eq(token))
            .filter(registry::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&master))
            .await
            .map_err(PortError::backend)?;
    let Some((project_id, workspace_id, status, allowed_domains, settings, plan)) = row else {
        return Ok(None);
    };
    let record = crate::domain::with_replay_tier(
        crate::domain::project_record(
            &project_id,
            &workspace_id,
            &Value::String(status),
            &allowed_domains,
            &settings,
        ),
        crate::domain::plan_replay_tier(plan.as_deref()),
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

/// The workspace's quota state (`panel:quota:<workspace>`); missing,
/// unreadable or unknown is `ok`, so a cache hiccup never drops events.
async fn quota_state(ctx: &Ctx, state: &CollectorState, workspace_id: &str) -> &'static str {
    let Some(cache) = ctx.cache(state) else {
        return "ok";
    };
    match cache.get(&quota_key(workspace_id)).await {
        Ok(raw) => parse_quota_state(raw.as_deref()),
        Err(error) => {
            tracing::error!(%error, "[panel-ingest] Quota lookup failed for workspace {workspace_id}");
            "ok"
        }
    }
}

/// The heatmap snapshot the project waits for
/// (`panel:snapshot-request:<project>`), or null.
async fn snapshot_request(
    ctx: &Ctx,
    state: &CollectorState,
    project_id: &str,
) -> Result<Value, PortError> {
    let Some(cache) = ctx.cache(state) else {
        return Ok(Value::Null);
    };
    let raw = cache.get(&snapshot_request_key(project_id)).await?;
    Ok(parse_snapshot_request(raw.as_deref()).unwrap_or(Value::Null))
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
    // `Math.min(Math.max(Number(x) || 0, 0), 1)`.
    let rate = match project.settings.get("recordingSampleRate") {
        Some(Value::Number(rate)) => rate.as_f64().unwrap_or(0.0),
        Some(value @ (Value::String(_) | Value::Array(_))) => {
            weldsuite_kit::validation::js_number(&crate::domain::js_string(value))
        }
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    let sample_rate = if rate.is_nan() {
        0.0
    } else {
        rate.clamp(0.0, 1.0)
    };
    // The snapshot the project waits for, for a heatmap background.
    let (quota, snapshot) = futures_util::join!(
        quota_state(&ctx, &state, &project.workspace_id),
        snapshot_request(&ctx, &state, &project.project_id),
    );
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) => return went_wrong(&error, "GET /c"),
    };
    let mut response = axum::Json(json!({
        "autocapture": setting("autocapture"),
        "consentMode": setting("consentMode"),
        "maskingLevel": setting("maskingLevel"),
        "excludedUrls": setting("excludedUrls"),
        "recordingSampleRate": number_value(sample_rate),
        // Recordings are off by setting (rate 0) or by quota (any blocked
        // state: events_blocked blocks them too).
        "recordingBlocked": sample_rate == 0.0 || quota != "ok",
        "snapshot": snapshot,
    }))
    .into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=300"),
    );
    response
}

/// The request body, at most `limit` bytes (`readBytesLimited`); `None`
/// when larger, or when its `Content-Length` says so.
async fn read_bytes_limited(headers: &HeaderMap, body: Body, limit: usize) -> Option<Vec<u8>> {
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .map(weldsuite_kit::validation::js_number);
    #[allow(clippy::cast_precision_loss)]
    let too_large =
        declared.is_some_and(|declared| declared.is_finite() && declared > limit as f64);
    let mut body = body;
    let mut bytes: Vec<u8> = Vec::new();
    let mut seen = 0usize;
    // Past the limit the rest is read and dropped, up to a cap, so the 413
    // reaches a client still sending (closing on it resets the connection);
    // beyond the cap the connection is given up.
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return None;
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        seen += data.len();
        if too_large || seen > limit {
            if seen > limit.saturating_add(DRAIN_CAP) {
                break;
            }
            continue;
        }
        bytes.extend_from_slice(&data);
    }
    if too_large || seen > limit {
        return None;
    }
    Some(bytes)
}

/// The request body as text, at most `limit` bytes (`readTextLimited`);
/// `None` when larger.
async fn read_text_limited(headers: &HeaderMap, body: Body, limit: usize) -> Option<String> {
    let bytes = read_bytes_limited(headers, body, limit).await?;
    // `TextDecoder` drops a byte order mark and replaces what isn't UTF-8.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// How much more than the limit is read and dropped before the 413.
const DRAIN_CAP: usize = 1024 * 1024;

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
    // The per-IP limits come first, before the body is read and the cache
    // is asked, so a flood costs as little as possible.
    let ports = ctx.ports(&state);
    let addresses = ctx.addresses(&state, &headers);
    if events_limited(&ports, &addresses).await {
        return too_many();
    }

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

    let ip = addresses.client;
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
    // Past the plan's allowance with no wallet to pay for more: accepted, not counted.
    if quota_state(&ctx, &state, &project.workspace_id).await == "events_blocked" {
        return StatusCode::NO_CONTENT.into_response();
    }

    let accepted = Accepted {
        project,
        batch,
        received_at: ctx.now_ms(),
        ip,
        user_agent,
        geo: proxy::request_geo(&headers),
    };
    let cache = ctx.cache(&state);
    let seen = Arc::clone(&state.seen);
    let caches = Arc::clone(&state.project_caches);
    state.events.tracker().spawn(async move {
        collect_in_background(accepted, ports, cache, seen, caches).await;
    });
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /e`'s limits: per client address, and behind a proxy (or with a
/// forged `X-Forwarded-For`, where the client address is not the connecting
/// one) per connecting address too, with a 50 times higher ceiling.
async fn events_limited(ports: &RequestCollector, addresses: &Addresses) -> bool {
    let limits = ports.limits.as_ref();
    rate_limited(limits, Limit::Events, &addresses.client).await
        || (addresses.connecting != addresses.client
            && rate_limited(limits, Limit::EventsProxy, &addresses.connecting).await)
}

/// An accepted batch (`AcceptedBatch`).
struct Accepted {
    project: ProjectRecord,
    batch: EventBatch,
    received_at: i64,
    /// Used for the cookieless hash and the IP filter only, never stored.
    ip: String,
    user_agent: String,
    geo: Geo,
}

/// Failures are logged with ids and counts only, never request data.
fn log_failure(what: &str, project: &ProjectRecord, error: &dyn std::fmt::Display) {
    log_failure_for(what, &project.project_id, error);
}

/// [`log_failure`] by the project's id.
fn log_failure_for(what: &str, project_id: &str, error: &dyn std::fmt::Display) {
    tracing::error!(
        project = %project_id,
        "[panel-ingest] {what} failed for project {project_id}: {error}",
    );
}

/// `collectInBackground(env, accepted)`: the group operations first (they
/// may give a type its slot, which decides the events' `$group_`
/// properties; applied only from a batch sent with consent, ADR PANEL-006),
/// then the events and the people side by side: a stream that refuses the
/// rows must not lose an identify, and the other way round.
async fn collect_in_background(
    mut accepted: Accepted,
    ports: RequestCollector,
    cache: Option<Arc<dyn DynCache>>,
    seen: Arc<SeenThrottle>,
    caches: Arc<ProjectCaches>,
) {
    let state = ports.project_state.clone();
    let batch = &mut accepted.batch;
    let group_ops = if batch.consent {
        batch.groups.as_slice()
    } else {
        &[]
    };
    project::limit_groups(
        state.as_ref(),
        ProjectRef {
            workspace_id: &accepted.project.workspace_id,
            project_id: &accepted.project.project_id,
        },
        batch
            .events
            .iter_mut()
            .map(|event| &mut event.props)
            .collect(),
        group_ops,
        accepted.received_at,
        &caches,
    )
    .await;
    let project = ProjectRef {
        workspace_id: &accepted.project.workspace_id,
        project_id: &accepted.project.project_id,
    };
    futures_util::join!(
        collect(&accepted, &ports, cache, &seen, &caches),
        project::apply_batch_people(
            state.as_ref(),
            project,
            &accepted.batch,
            accepted.received_at
        ),
    );
}

/// `collectEvents(env, accepted)`: the rows to the stream, then the day's
/// count, the install-check stamp and the live view, which never fail the
/// write that already happened.
async fn collect(
    accepted: &Accepted,
    ports: &RequestCollector,
    cache: Option<Arc<dyn DynCache>>,
    seen: &SeenThrottle,
    caches: &ProjectCaches,
) {
    let Accepted {
        project,
        batch,
        received_at,
        ip,
        user_agent,
        geo,
    } = accepted;
    let received_at = *received_at;
    // Events that need a cookieless id are left out when the salt is
    // unavailable: an id built without it would be stable across days.
    let mut cookieless_id = None;
    if batch
        .events
        .iter()
        .any(|event| consented_anon_id(batch, event).is_none())
    {
        match &ports.salt {
            Some(salt) => match salt.today(received_at).await {
                Ok(salt) => {
                    cookieless_id = Some(cookieless_visitor_id(
                        &salt,
                        &project.project_id,
                        ip,
                        user_agent,
                    ));
                }
                Err(error) => log_failure("Salt lookup", project, &error),
            },
            None => log_failure("Salt lookup", project, &"no salt source"),
        }
    }
    let rows = build_event_rows(&RowSource {
        record: project,
        batch,
        received_at,
        user_agent: user_agent::parse_user_agent(user_agent),
        geo: geo.clone(),
        cookieless_id,
    });
    if rows.is_empty() {
        return;
    }
    let Some(sink) = &ports.sink else {
        log_failure("Event write", project, &"no events stream");
        return;
    };
    if let Err(error) = sink.send(&rows).await {
        log_failure("Event write", project, &error);
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
    let live = project::track_live(
        ports.project_state.as_ref(),
        ProjectRef {
            workspace_id: &project.workspace_id,
            project_id: &project.project_id,
        },
        &rows,
        received_at,
        caches,
    );
    let (usage, stamp, ()) = futures_util::join!(usage, stamp, live);
    for result in [usage, stamp] {
        if let Err(error) = result {
            log_failure("Usage count, seen marker or live view", project, &error);
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
