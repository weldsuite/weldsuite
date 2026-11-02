//! WeldMeet: meet-api's routes (`apps/workers/meet-api`): meetings, meeting
//! sessions (start, join, leave, end, remove a participant), the session
//! recording, transcript and summary routes and their per-meeting aliases,
//! meeting chat messages, the waiting room, transcriptions, the tokenized
//! recording stream at `/public/meeting-recordings`, `RealtimeKit`'s webhook
//! at `/api/webhooks/cloudflare-realtime` and, on Kubernetes, `LiveKit`'s at
//! `/api/webhooks/livekit`.
//!
//! The video provider is the `VideoRooms` port (`weldsuite-video-rooms`):
//! `RealtimeKit` on Global and in conformance (its calls go through the
//! test's `fetch` stub), `LiveKit` on Kubernetes. What is RealtimeKit-only
//! (its recorder, its post-meeting transcript and summary, the Workers AI
//! transcription and summaries) answers as the worker does without the
//! bindings it needs; see `README.md` in `rust/` for the details.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `meet`
//! conformance suite (`rust/conformance/suites.json`).
// Route handlers follow the worker's handlers step by step, row tuples are
// sqlx's, names follow the worker's, and a PATCH field can be absent or null.
#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::similar_names,
    clippy::option_option
)]

mod attendees;
mod billing;
mod invitations;
mod js;
mod lifecycle;
mod livekit_webhook;
mod meetings;
mod messages;
mod participants;
mod publish;
mod recording;
mod recordings_public;
mod sessions;
mod table;
#[rustfmt::skip]
mod tables;
mod transcriptions;
mod waitlist;
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
use weldsuite_events::{
    EntityEvent, EntityEventPublisher, EventContext, EventSource, iso_timestamp,
    publish_entity_event,
};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_mail_domain::outbound::{OutboundBindings, RequestOutbound};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{
    BoxFuture, DynCache, DynFileStore, DynOutboundHttp, DynRealtimePublisher, FileStores,
    HttpRequest, HttpResponse, ObjectInfo, OutboundHttp, PortError, RequestCache, StorageBuckets,
};
use weldsuite_video_rooms::{DynVideoRooms, RealtimeKit, RealtimeKitConfig};

/// A workspace's tenant database, by the id a webhook mapping carries (the
/// Clerk org id; `getTenantDbForWorkspace`).
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// One page of a recordings bucket listing (`bucket.list({ prefix, cursor })`).
#[derive(Debug, Clone, Default)]
pub struct Listed {
    pub keys: Vec<String>,
    /// The next page's cursor when the listing was truncated.
    pub cursor: Option<String>,
}

/// The private `MEETING_RECORDINGS` bucket: what the recording routes do
/// with it (stream a range, list and delete a session's objects).
pub trait RecordingsBucket: Send + Sync {
    fn head<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<ObjectInfo>, PortError>>;
    /// The object's bytes, or the `(offset, length)` slice of them.
    fn get<'a>(
        &'a self,
        key: &'a str,
        range: Option<(u64, u64)>,
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, PortError>>;
    fn list<'a>(
        &'a self,
        prefix: &'a str,
        cursor: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Listed, PortError>>;
    fn delete_many<'a>(&'a self, keys: &'a [String]) -> BoxFuture<'a, Result<(), PortError>>;
}

/// A request's `MEETING_RECORDINGS` (conformance: the test's, or none).
#[derive(Clone)]
pub struct RequestRecordings(pub Option<Arc<dyn RecordingsBucket>>);

/// A Workflow binding the routes start instances on (`binding.create({ id,
/// params })`); `Err` with the binding's message when it threw.
pub trait MeetWorkflow: Send + Sync {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// meet-api's three Workflow bindings. The Kubernetes editions run none of
/// them (the copy and backfill read `RealtimeKit`'s recorder, the AI one
/// Workers AI), so their routes answer as the worker does without them.
#[derive(Clone, Default)]
pub struct MeetWorkflows {
    /// `MEETING_RECORDING_COPY`.
    pub copy: Option<Arc<dyn MeetWorkflow>>,
    /// `MEETING_AI`.
    pub ai: Option<Arc<dyn MeetWorkflow>>,
    /// `MEETING_RECORDING_BACKFILL`.
    pub backfill: Option<Arc<dyn MeetWorkflow>>,
}

/// A request's Workflow bindings (conformance: the test's fakes).
#[derive(Clone)]
pub struct RequestMeetWorkflows(pub MeetWorkflows);

/// Workspaces' tenant databases by the reference a webhook resolves them
/// with (conformance: the test's `tenantDbs`); a workspace missing from a
/// non-empty map has no database.
#[derive(Clone, Default)]
pub struct RequestTenants(pub Arc<std::collections::HashMap<String, PgPool>>);

/// The `LiveKit` API key pair its webhook deliveries are signed with.
#[derive(Debug, Clone)]
pub struct LiveKitKeys {
    pub api_key: String,
    pub api_secret: String,
}

/// What the WeldMeet handlers share.
#[derive(Clone)]
pub struct MeetState {
    pub events: EntityEventPublisher,
    /// `WORKSPACE_CACHE` (webhook mappings, recording tokens, member
    /// display, presets marker). A request's `RequestCache` wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database (credits, the AI price list, the backfill's
    /// workspace list). A request's `MasterDb` wins.
    pub master: Option<PgPool>,
    /// The realtime publisher (`REALTIME`).
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The video provider. Conformance builds use `RealtimeKit` over the
    /// request's outbound bridge instead.
    pub video: Option<Arc<dyn DynVideoRooms>>,
    /// Third-party HTTP (the `RealtimeKit` webhook key). A request's wins.
    pub http: Option<OutboundHttp>,
    /// `SEND_EMAIL` and the outbound guard's ledgers. A request's wins.
    pub outbound: OutboundBindings,
    /// `STORAGE` (participant avatars). A request's `FileStores` wins.
    pub files: Option<FileStores>,
    /// `MEETING_RECORDINGS`. A request's `RequestRecordings` wins.
    pub recordings: Option<Arc<dyn RecordingsBucket>>,
    /// The Workflow bindings. A request's `RequestMeetWorkflows` wins.
    pub workflows: MeetWorkflows,
    /// A workspace's tenant database for the webhooks. A request's `Tenant`
    /// (conformance) wins.
    pub tenants: Option<TenantDatabases>,
    /// `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, for `LiveKit`'s webhook.
    pub livekit: Option<LiveKitKeys>,
}

impl std::fmt::Debug for MeetState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeetState")
            .field("events", &self.events)
            .field("cache", &self.cache.is_some())
            .field("master", &self.master.is_some())
            .field("video", &self.video.is_some())
            .finish_non_exhaustive()
    }
}

/// meet-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers.
pub fn router<S, Q>(state: MeetState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/meeting-messages", messages::routes(gate))
        .nest("/meeting-sessions", sessions::routes(gate))
        .nest("/meeting-waitlist", waitlist::routes(gate))
        .nest("/meetings", meetings::routes(gate))
        .nest("/transcriptions", transcriptions::routes(gate))
        .with_state(state)
}

/// The routes served ahead of the session, at their full paths:
/// `/api/webhooks/cloudflare-realtime` (each delivery's signature is its
/// credential, the admin routes take an operator token),
/// `/api/webhooks/livekit` (`LiveKit`'s signed deliveries) and
/// `/public/meeting-recordings/:token` (the token is the credential).
pub fn public_router<S>(state: MeetState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .nest("/api/webhooks/cloudflare-realtime", webhook::routes())
        .nest("/api/webhooks/livekit", livekit_webhook::routes())
        .nest("/public/meeting-recordings", recordings_public::routes())
        .with_state(state)
}

/// Who is asking, in which workspace, with what the request brings.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization.
    pub(crate) org_id: Option<String>,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    pub(crate) origin: String,
    pub(crate) parts: RequestParts,
}

/// What a request brings beyond the session (conformance overrides), shared
/// by the signed-in and the public routes.
#[derive(Clone, Default)]
pub(crate) struct RequestParts {
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
    files: Option<FileStores>,
    buckets: Option<StorageBuckets>,
    outbound: Option<RequestOutbound>,
    recordings: Option<RequestRecordings>,
    workflows: Option<RequestMeetWorkflows>,
    tenant: Option<PgPool>,
    tenants: Option<RequestTenants>,
}

impl RequestParts {
    pub(crate) fn of(parts: &Parts) -> Self {
        let extensions = &parts.extensions;
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            http: extensions.get::<OutboundHttp>().cloned(),
            files: extensions.get::<FileStores>().cloned(),
            buckets: extensions.get::<StorageBuckets>().cloned(),
            outbound: extensions.get::<RequestOutbound>().cloned(),
            recordings: extensions.get::<RequestRecordings>().cloned(),
            workflows: extensions.get::<RequestMeetWorkflows>().cloned(),
            tenant: extensions.get::<Tenant>().map(|tenant| tenant.db.clone()),
            tenants: extensions.get::<RequestTenants>().cloned(),
        }
    }

    /// Whether the request carries the test's env (conformance): then only
    /// what the test shares counts, never the process's.
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    /// `c.env.<name>`: the request's env (conformance), else the process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => std::env::var(name).ok(),
        }
        .filter(|value| !value.is_empty())
    }

    pub(crate) fn cache(&self, state: &MeetState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        self.cache.clone().or_else(|| state.cache.clone())
    }

    pub(crate) fn master(&self, state: &MeetState) -> Option<PgPool> {
        if self.conformance() {
            return self.master.clone();
        }
        self.master.clone().or_else(|| state.master.clone())
    }

    pub(crate) fn http(&self, state: &MeetState) -> OutboundHttp {
        self.http
            .clone()
            .or_else(|| (!self.conformance()).then(|| state.http.clone()).flatten())
            .unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable)))
    }

    /// `STORAGE` (the public bucket): the request's, else the state's.
    pub(crate) fn public_bucket(&self, state: &MeetState) -> Option<Arc<dyn DynFileStore>> {
        if let Some(buckets) = &self.buckets {
            return buckets.public.clone();
        }
        if let Some(files) = &self.files {
            return files.public.clone();
        }
        if self.conformance() {
            return None;
        }
        state.files.as_ref().and_then(|files| files.public.clone())
    }

    pub(crate) fn outbound(&self, state: &MeetState) -> OutboundBindings {
        self.outbound
            .as_ref()
            .map_or_else(|| state.outbound.clone(), |outbound| outbound.0.clone())
    }

    pub(crate) fn recordings(&self, state: &MeetState) -> Option<Arc<dyn RecordingsBucket>> {
        match &self.recordings {
            Some(recordings) => recordings.0.clone(),
            None if self.conformance() => None,
            None => state.recordings.clone(),
        }
    }

    pub(crate) fn workflows(&self, state: &MeetState) -> MeetWorkflows {
        match &self.workflows {
            Some(workflows) => workflows.0.clone(),
            None if self.conformance() => MeetWorkflows::default(),
            None => state.workflows.clone(),
        }
    }

    /// The video provider: in conformance `RealtimeKit` with the test's
    /// credentials, its calls through the test's `fetch` stub.
    pub(crate) fn video(&self, state: &MeetState) -> Arc<dyn DynVideoRooms> {
        if let Some(env) = &self.env {
            let config = RealtimeKitConfig::from_env(|name| env.get(name).map(str::to_owned));
            return Arc::new(RealtimeKit::new(config, self.http(state)));
        }
        state.video.clone().unwrap_or_else(|| {
            Arc::new(weldsuite_video_rooms::UnconfiguredVideoRooms(
                "No video provider is configured".to_owned(),
            ))
        })
    }

    /// The tenant database of a workspace (`getTenantDbForWorkspace`): the
    /// request's (conformance), else the state's resolver.
    pub(crate) async fn tenant(&self, state: &MeetState, org_id: &str) -> Result<PgPool, String> {
        if let Some(tenants) = self.tenants.as_ref().filter(|t| !t.0.is_empty()) {
            return tenants
                .0
                .get(org_id)
                .cloned()
                .ok_or_else(|| format!("no tenant database for {org_id}"));
        }
        if let Some(db) = &self.tenant {
            return Ok(db.clone());
        }
        match &state.tenants {
            Some(tenants) => tenants(org_id.to_owned()).await,
            None => Err(format!("no tenant database for {org_id}")),
        }
    }
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(&self, state: &MeetState, event: EventName, id: &str, data: &Value) {
        publish_entity_event(&state.events, &self.events, event, id, data);
    }

    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }
}

/// `publishEntityEventRaw({ workspaceId, userId, entityType, action, entityId,
/// data, source: 'system' })`.
pub(crate) fn publish_system(
    state: &MeetState,
    workspace_id: &str,
    user_id: &str,
    event: EventName,
    id: &str,
    data: Value,
) {
    let context = EventContext::new(workspace_id, user_id, EventSource::System);
    state
        .events
        .publish(&context, EntityEvent::new(event, id.to_owned(), data));
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
        let caller = if let (Some(auth), Some(tenant), Some(permissions)) = (
            extensions.get::<AuthContext>(),
            extensions.get::<Tenant>(),
            extensions.get::<Permissions>(),
        ) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                org_id: auth.org_id.clone().filter(|org| !org.is_empty()),
                clerk_org_id: tenant.clerk_org_id.clone(),
                permissions: permissions.clone(),
                events: EventContext::for_request(auth, tenant),
                origin: js::request_origin(&parts.headers),
                parts: RequestParts::of(parts),
            })
        } else {
            tracing::error!("meet: a route without the session or tenant layer");
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

/// `await c.req.json()` with a fallback: a missing or unreadable body is
/// `{}` (the routes whose body is optional).
pub(crate) fn optional_json(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[meet-api] {message}");
    ApiError::internal().with_message(message).into_response()
}
