//! The request glue every books area crate shares: the state the routes get
//! ([`BooksState`]), who is asking ([`Caller`]), a route's refusals and
//! failures ([`Refusal`], [`reply`]), body and query reading ([`validate`],
//! [`Query`]) and the list envelope ([`paged`], [`all_rows`]).
//!
//! Paths, bodies, status codes and messages are books-api's; the helpers
//! here only carry what its middleware puts on the Hono context (`tenantDb`,
//! `userId`, `permissions`, the env) and its response helpers
//! (`@weldsuite/worker-kit/response`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use tokio::sync::OnceCell;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{Keyring, PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, iso_timestamp};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{
    DynCache, DynJobs, DynRealtimePublisher, FileStores, OutboundHttp, RequestCache, StorageBuckets,
};

use crate::currency::RateCache;

/// What the books routes share: the ports books-api's bindings become.
/// Every area crate takes the one state; a field it doesn't use costs
/// nothing.
#[derive(Clone)]
pub struct BooksState {
    pub events: EntityEventPublisher,
    /// The private bucket and the legacy public one (`PRIVATE_STORAGE`,
    /// `STORAGE`), when configured.
    pub files: Option<FileStores>,
    /// The master database (the accounting inbox registry, the due index).
    /// A request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// Outbound HTTP to third parties (ECB rates, VIES, tax and bank-feed
    /// providers). A request's own (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// Ponto's client, with the client certificate Ponto requires (mTLS;
    /// `PONTO_MTLS_CERT` and `PONTO_MTLS_KEY`). Without one Ponto is called
    /// through [`BooksState::http`], as the worker does without its
    /// `PONTO_CERT` binding.
    pub ponto_http: Option<OutboundHttp>,
    /// The workspace cache (`WORKSPACE_CACHE`). A request's (conformance) wins.
    pub cache: Option<Arc<dyn DynCache>>,
    /// In-app notifications (`REALTIME`), when configured.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Durable jobs, when a books Workflow needs one.
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// `DATABASE_ENCRYPTION_KEY` / `_V2`: sealed SSNs, TINs, bank numbers and
    /// provider credentials (`encryptField`).
    pub keyring: Keyring,
    /// The worker's other settings by their binding name (`DIGIPOORT_MODE`,
    /// `PLAID_ENV`, `BANK_FEED_PROVIDERS`, provider keys, …), from the
    /// process environment. A request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
    /// The live ECB rates, kept an hour (`accounting-currency`'s module cache).
    pub rates: Arc<RateCache>,
}

impl std::fmt::Debug for BooksState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BooksState")
            .field("files", &self.files.is_some())
            .field("master", &self.master.is_some())
            .field("http", &self.http.is_some())
            .field("cache", &self.cache.is_some())
            .field("realtime", &self.realtime.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

impl BooksState {
    /// A state with only the event publisher (tests, tools).
    pub fn new(events: EntityEventPublisher) -> Self {
        Self {
            events,
            files: None,
            master: None,
            http: None,
            ponto_http: None,
            cache: None,
            realtime: None,
            jobs: None,
            keyring: Keyring::default(),
            env: Arc::default(),
            rates: Arc::default(),
        }
    }
}

/// Who is asking, in which workspace, with what permissions: what
/// books-api's middleware puts on the Hono context.
pub struct Caller {
    /// `c.get('tenantDb')`.
    pub db: PgPool,
    /// `c.get('userId')`.
    pub user_id: String,
    pub permissions: Permissions,
    pub events: EventContext,
    /// `c.get('clerkOrgId') || c.get('orgId')`.
    pub clerk_org_id: Option<String>,
    /// `c.get('orgId')`: the session's organization.
    pub org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub workspace_id: String,
    headers: HeaderMap,
    raw_query: Option<String>,
    env: Option<RequestEnv>,
    buckets: Option<StorageBuckets>,
    master: Option<PgPool>,
    flags: Option<weldsuite_pipeline::Flags>,
    http: Option<OutboundHttp>,
    cache: Option<RequestCache>,
    /// `resolveEntityId(c, db)`, once per request (books-api keeps it in a
    /// `WeakMap` keyed by the context).
    pub(crate) entity: OnceCell<Option<String>>,
    /// This request's events, sent in order.
    outbox: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<EntityEvent>>>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `c.get('userId')`, `None` when empty (`c.get('userId') ?? null` reads
    /// an empty id as itself; use [`Caller::user_id`] for that).
    pub fn user(&self) -> Option<&str> {
        Some(self.user_id.as_str()).filter(|id| !id.is_empty())
    }

    /// `c.req.header(name)`.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The raw query string.
    pub fn raw_query(&self) -> Option<&str> {
        self.raw_query.as_deref()
    }

    /// `c.req.query()`.
    pub fn query(&self) -> Query {
        Query::parse(self.raw_query.as_deref())
    }

    /// `flags && await flags.isOn(flag)`: off without an evaluator.
    pub async fn flag_on(&self, flag: weldsuite_catalogs::flags::BoolFlag) -> bool {
        match &self.flags {
            Some(flags) => flags.is_on(flag).await,
            None => false,
        }
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub fn publish(&self, state: &BooksState, event: EventName, entity_id: &str, data: Value) {
        self.send(state, EntityEvent::new(event, entity_id, data));
    }

    /// `publishEntityEvent({ …, changes })`.
    pub fn publish_changes(
        &self,
        state: &BooksState,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Map<String, Value>,
    ) {
        self.send(
            state,
            EntityEvent::new(event, entity_id, data).with_changes(changes),
        );
    }

    /// `publishEntityEvent({ …, source: 'system' })`.
    pub fn publish_system(
        &self,
        state: &BooksState,
        event: EventName,
        entity_id: &str,
        data: Value,
    ) {
        let event = EntityEvent::new(event, entity_id, data);
        let publisher = state.events.clone();
        let context = self
            .events
            .clone()
            .with_source(weldsuite_events::EventSource::System);
        state.events.tracker().spawn(async move {
            publisher.publish_and_wait(&context, event).await;
        });
    }

    /// Queue an event behind the ones this request published before it:
    /// TypeScript's queue sends land in publish order, so Rust keeps it.
    pub fn send(&self, state: &BooksState, event: EntityEvent) {
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
            tracing::error!("books: the event outbox closed early");
        }
    }

    /// `Date.now()` as the request sees it: the test's faked clock in
    /// conformance (`CONFORMANCE_NOW`, which only the harness sets, in the
    /// request's env), else the real one.
    pub fn now_ms(&self) -> i64 {
        self.env
            .as_ref()
            .and_then(|env| env.get("CONFORMANCE_NOW"))
            .and_then(crate::js::millis_of)
            .unwrap_or_else(now_ms)
    }

    /// A value of `c.env`: the request's (conformance), else the process's.
    pub fn env<'a>(&'a self, state: &'a BooksState, name: &str) -> Option<&'a str> {
        match &self.env {
            Some(env) => env.get(name),
            None => state.env.get(name).map(String::as_str),
        }
    }

    /// `keyringFromEnv(c.env)`: the test's keys in conformance, else the
    /// server's.
    pub fn keyring(&self, state: &BooksState) -> Keyring {
        match &self.env {
            Some(env) => Keyring {
                v1: env
                    .get("DATABASE_ENCRYPTION_KEY")
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned),
                v2: env
                    .get("DATABASE_ENCRYPTION_KEY_V2")
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned),
            },
            None => state.keyring.clone(),
        }
    }

    /// The request's buckets (conformance), else the app's: `STORAGE` is
    /// `public`, `PRIVATE_STORAGE` `private`.
    pub fn buckets(&self, state: &BooksState) -> StorageBuckets {
        self.buckets
            .clone()
            .or_else(|| state.files.clone().map(StorageBuckets::from))
            .unwrap_or_default()
    }

    /// The request's master database (conformance), else the app's.
    pub fn master(&self, state: &BooksState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// The request's outbound HTTP (conformance: the test's `fetch`), else
    /// the app's.
    pub fn http(&self, state: &BooksState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// Which exchange-rate cache this request reads ([`crate::currency::RateCache`]).
    /// books-api keeps the ECB rates in a module variable, one per Worker
    /// isolate: the app shares one cache. Under conformance (the request
    /// brings the test's `fetch`) each test file is its own module, so its
    /// tenant database names the cache.
    pub fn rate_scope(&self) -> String {
        if self.http.is_none() {
            return String::new();
        }
        let options = self.db.connect_options();
        format!(
            "{}:{}/{}",
            options.get_host(),
            options.get_port(),
            options.get_database().unwrap_or_default()
        )
    }

    /// The request's workspace cache (conformance: the test's KV), else the
    /// app's.
    pub fn cache(&self, state: &BooksState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| state.cache.clone())
    }

    /// The client address the accounting audit trail records:
    /// `cf-connecting-ip ?? x-forwarded-for ?? null`.
    pub fn ip_address(&self) -> Option<String> {
        self.header("cf-connecting-ip")
            .or_else(|| self.header("x-forwarded-for"))
            .map(str::to_owned)
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
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    org_id: auth.org_id.clone().filter(|id| !id.is_empty()),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .or_else(|| auth.org_id.clone().filter(|id| !id.is_empty())),
                    workspace_id: tenant.workspace_id.clone(),
                    headers: parts.headers.clone(),
                    raw_query: parts.uri.query().map(str::to_owned),
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
                    cache: parts.extensions.get::<RequestCache>().cloned(),
                    entity: OnceCell::new(),
                    outbox: std::sync::Mutex::default(),
                })
            } else {
                tracing::error!("books: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response it writes itself (400,
/// 403, 404, 409, a validation failure), or a failure for its `catch` (500
/// with the route's message).
#[derive(Debug)]
pub enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
    Internal(String),
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

impl From<crate::table::WriteError> for Refusal {
    fn from(error: crate::table::WriteError) -> Self {
        match error {
            crate::table::WriteError::Database(error) => Self::Database(error),
            other @ crate::table::WriteError::NotADate(_) => Self::Internal(other.to_string()),
        }
    }
}

impl Refusal {
    /// `error.badRequest(c, message)`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    /// `error.badRequest(c, message, details)`.
    pub fn bad_request_with(message: impl Into<String>, details: Value) -> Self {
        ApiError::bad_request(message).with_details(details).into()
    }

    /// `error.forbidden(c, message)`.
    pub fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    /// `error.notFound(c, resource, id)`.
    pub fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    /// `error.conflict(c, message)`.
    pub fn conflict(message: impl Into<String>) -> Self {
        ApiError::conflict(message).into()
    }

    /// `error.conflict(c, message, details)`.
    pub fn conflict_with(message: impl Into<String>, details: Value) -> Self {
        ApiError::conflict(message).with_details(details).into()
    }

    /// `error.unavailable(c, message)`.
    pub fn unavailable(message: impl Into<String>) -> Self {
        ApiError::unavailable(message).into()
    }

    /// The response; a failure is logged and answered with a 500 carrying
    /// `fallback` (the route's `error.internal(c, …)`).
    pub fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[books-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
            Self::Internal(error) => {
                tracing::error!(error, "[books-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

/// A handler's result: the response, or a [`Refusal`].
pub type Reply = Result<Response, Refusal>;

/// The reply, with a failure answered as the route's `catch` does.
pub fn reply(result: Reply, fallback: &str) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond(fallback))
}

/// A failure outside the route's `try`: the app's error handler answers a
/// 500 with its generic message.
pub fn outside(result: Reply) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond("Internal server error"))
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds, bound as text
/// and cast (`::timestamp` / `::timestamptz`).
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let body = json_of(headers, body)?;
    validate_value(&body, read)
}

/// The JSON body (`c.req.json()` as `zValidator` reads it), or the 400.
pub fn json_of(headers: &HeaderMap, body: &Bytes) -> Result<Value, Refusal> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| Refusal::Response(Box::new(bad.into_response())))
}

/// A parsed body against a schema.
pub fn validate_value<T>(
    body: &Value,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let mut issues = Issues::default();
    let value = issues.object(body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `c.req.query()`: each key's first value.
#[derive(Debug, Clone)]
pub struct Query(Map<String, Value>);

impl Query {
    pub fn parse(raw: Option<&str>) -> Self {
        Self(query_values(raw))
    }

    /// `c.req.query(key)`.
    pub fn get(&self, key: &str) -> Option<&str> {
        match self.0.get(key) {
            Some(Value::String(text)) => Some(text.as_str()),
            Some(Value::Array(values)) => values.first().and_then(Value::as_str),
            _ => None,
        }
    }

    /// A present, non-empty value (`if (q.x)`).
    pub fn present(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    /// The values `zValidator('query', …)` sees.
    pub fn values(&self) -> &Map<String, Value> {
        &self.0
    }
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : fallback, max)`;
/// `None` is NaN (the statement then fails: the route's 500).
pub fn list_limit(q: &Query, fallback: i64, max: i64) -> Option<i64> {
    match q.present("limit") {
        Some(raw) => crate::js::parse_int(raw).map(|n| n.min(max)),
        None => Some(fallback.min(max)),
    }
}

/// A page of `limit + 1` rows: `(rows, hasMore, nextCursor)` with the last
/// kept row's id as the cursor.
pub fn page(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool, Option<String>) {
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// `list(c, rows, cursorPagination(totalCount, hasMore, cursor))`.
pub fn paged(rows: Vec<Value>, total: i64, has_more: bool, cursor: Option<String>) -> Response {
    weldsuite_kit::List::new(
        rows,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// A list without paging: `list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null })`.
pub fn all_rows(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}

/// `success(c, data)`.
pub fn ok(data: Value) -> Response {
    weldsuite_kit::Data(data).into_response()
}

/// `success(c, data, 201)`.
pub fn created(data: Value) -> Response {
    weldsuite_kit::Created(data).into_response()
}

/// `noContent(c)`.
pub fn no_content() -> Response {
    weldsuite_kit::NoContent.into_response()
}
