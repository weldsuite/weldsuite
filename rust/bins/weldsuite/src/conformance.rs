//! Conformance mode (phase P2): the TypeScript worker tests drive this server
//! over HTTP and compare its answers with the Hono app's.
//!
//! Compiled only with the `conformance` Cargo feature, which no release image
//! has (CI checks `weldsuite version` of the image). With it, `/api` does not
//! verify session tokens or read the master database. Each request carries
//! the test's context in `X-Weld-Conformance`, base64 JSON written by
//! `packages/core/worker-kit/src/testing/conformance.ts`:
//!
//! ```json
//! { "userId": "...", "orgId": "...", "workspaceId": "...", "clerkOrgId": "...",
//!   "sessionId": "...", "factorVerificationAge": [0, 0],
//!   "databaseUrl": "postgres://...",   // the test's pglite, over pglite-socket
//!   "permissions": { ... },            // pre-resolved, like `context.permissions`
//!   "flags": { "upgrade-button": true }, // what the test's `context.flags` answers
//!   "env": { "PERMISSIONS_APP_ENFORCE": "true" },
//!   "files": { "PRIVATE_STORAGE": "http://127.0.0.1:..." }, // the test's buckets, over HTTP
//!   "kv": { "WORKSPACE_CACHE": "http://127.0.0.1:..." },     // the test's KV, over HTTP
//!   "outbound": "http://127.0.0.1:..." }  // third-party calls, through the test's fetch stub
//! ```
//!
//! The routes that run before authentication (`/api/storage/upload/:token`,
//! `/api/storage/private/*`) take only what the test shares (env, buckets,
//! KV, and a verifier for its `CLERK_JWT_KEY`), not a session ([`public`]).
//!
//! Side effects are recorded instead of published (`Recorders`), and
//! `GET /__conformance/side-effects` hands them over and clears them, in the
//! shape the TypeScript bindings saw: queue messages, and realtime POSTs as
//! `{ path, body }`. The suite runs one test file at a time, so the effects
//! read after a request are that request's.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_auth::{AuthContext, ClerkVerifier, SessionVerifier};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::ApiError;
use weldsuite_permissions::{AppContext, Permissions, ResolvedPermissions};
use weldsuite_pipeline::Flags;
use weldsuite_ports::{
    DefaultFlags, FlagContext, Mailbox, MemoryCache, MemoryFileStore, OutgoingMail,
    RecordingEventBus, RecordingRealtime, RecordingSystemMail, StaticFlags,
};

use crate::infra::Infra;
use crate::server::{AppEnforcedOverride, AppState};

/// The doubles a conformance build publishes to.
#[derive(Clone, Default)]
pub(crate) struct Recorders {
    events: Arc<RecordingEventBus>,
    realtime: Arc<RecordingRealtime>,
    mail: Arc<RecordingSystemMail>,
}

/// Infrastructure that records instead of publishing.
pub(crate) fn infra(tracker: TaskTracker) -> (Infra, Recorders) {
    let recorders = Recorders::default();
    let job_registry = crate::infra::job_registry();
    let infra = Infra {
        // Jobs run in the process, as the workers run them in `waitUntil`
        // without a Workflow binding in their tests.
        jobs: Arc::new(weldsuite_ports::InProcessJobs::new(
            job_registry.clone(),
            tracker.clone(),
        )),
        job_registry,
        events: EntityEventPublisher::new(Some(recorders.events.clone()), tracker),
        realtime: Some(recorders.realtime.clone()),
        cache: Some(Arc::new(MemoryCache::default())),
        flags: Arc::new(DefaultFlags),
        files: Some(Arc::new(MemoryFileStore::default())),
        public_files: Some(Arc::new(MemoryFileStore::default())),
        mail: Some(recorders.mail.clone()),
    };
    (infra, recorders)
}

/// `/publish/workspace`, `/publish/support/<id>`, …: the realtime-worker route
/// the TypeScript publisher would have sent its POST to.
fn realtime_path(channel: &str) -> String {
    match channel.split_once(':') {
        Some(("workspace", _)) => "/publish/workspace".to_owned(),
        Some((room, id)) => format!("/publish/{room}/{id}"),
        None => format!("/publish/{channel}"),
    }
}

/// `GET /__conformance/side-effects`: everything recorded since the last call,
/// after in-flight publishes finish.
pub(crate) async fn side_effects(State(state): State<AppState>) -> axum::Json<Value> {
    let tracker = state.infra.events.tracker();
    for _ in 0..100 {
        if tracker.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let events = state.recorders.events.payloads();
    state.recorders.events.clear();
    let realtime: Vec<Value> = state
        .recorders
        .realtime
        .messages()
        .into_iter()
        .map(|message| json!({ "path": realtime_path(&message.channel), "body": message.payload }))
        .collect();
    state.recorders.realtime.clear();
    let mail: Vec<Value> = state
        .recorders
        .mail
        .sent()
        .iter()
        .map(outgoing_email)
        .collect();
    state.recorders.mail.clear();
    axum::Json(json!({ "events": events, "realtime": realtime, "mail": mail }))
}

fn mailbox(mailbox: &Mailbox) -> Value {
    match &mailbox.name {
        Some(name) => json!({ "email": mailbox.email, "name": name }),
        None => json!({ "email": mailbox.email }),
    }
}

/// A sent email as `@weldsuite/emails` hands it to a transport
/// (`OutgoingEmail`), attachments in base64: the harness compares it with
/// the TypeScript run's and gives it to the test in place of that one.
fn outgoing_email(mail: &OutgoingMail) -> Value {
    json!({
        "from": mailbox(&mail.from),
        "to": mail.to.iter().map(mailbox).collect::<Vec<_>>(),
        "cc": mail.cc.iter().map(mailbox).collect::<Vec<_>>(),
        "bcc": mail.bcc.iter().map(mailbox).collect::<Vec<_>>(),
        "replyTo": mail.reply_to.as_ref().map(mailbox),
        "subject": mail.subject,
        "html": mail.html,
        "text": mail.text,
        "attachments": mail.attachments.iter().map(|a| json!({
            "filename": a.filename,
            "contentType": a.content_type,
            "contentBase64": STANDARD.encode(&a.content),
        })).collect::<Vec<_>>(),
        "headers": mail.headers.iter().map(|(k, v)| (k.clone(), Value::from(v.as_str()))).collect::<serde_json::Map<String, Value>>(),
    })
}

pub(crate) const HEADER: &str = "x-weld-conformance";

/// The route that answered, written as Hono writes it (`/api/companies/:id`),
/// for the conformance report.
const ROUTE_HEADER: &str = "x-weld-route";

/// `/api/companies/{id}` → `/api/companies/:id`.
fn hono_pattern(axum_path: &str) -> String {
    axum_path
        .split('/')
        .map(|segment| {
            match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                // A catch-all is Hono's `*`.
                Some(name) if name.starts_with('*') => "*".to_owned(),
                Some(name) => format!(":{name}"),
                None => segment.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestContext {
    user_id: String,
    org_id: Option<String>,
    workspace_id: String,
    clerk_org_id: Option<String>,
    #[serde(default)]
    session_id: String,
    factor_verification_age: Option<[f64; 2]>,
    database_url: String,
    /// The test's master database, when its routes use one.
    #[serde(default)]
    master_database_url: Option<String>,
    permissions: Option<TestPermissions>,
    /// Flag values the test's `context.flags` answers; `None` = no evaluator.
    flags: Option<HashMap<String, Value>>,
    #[serde(default)]
    env: HashMap<String, String>,
    /// The test's R2 bindings served over HTTP (`{ PRIVATE_STORAGE: url }`).
    #[serde(default)]
    files: HashMap<String, String>,
    /// The test's KV namespace served over HTTP (`{ WORKSPACE_CACHE: url }`).
    #[serde(default)]
    kv: HashMap<String, String>,
    /// The harness's outbound bridge: third-party calls (Clerk, …) go
    /// through the test's own fetch stub (`conformance_outbound`).
    #[serde(default)]
    outbound: Option<String>,
}

impl TestContext {
    fn from_headers(headers: &http::HeaderMap) -> Option<Self> {
        headers
            .get(HEADER)
            .and_then(|value| STANDARD.decode(value.as_bytes()).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestPermissions {
    permissions: Vec<String>,
    #[serde(default)]
    denies: Vec<String>,
    role: String,
    role_id: Option<String>,
    is_owner: bool,
}

/// One pool per test database, with one connection that is never recycled.
/// pglite is a single Postgres session shared by every socket connection,
/// and sqlx names prepared statements per connection (`sqlx_s_1`, …): a
/// second or a reopened connection would collide with the first one's names.
#[derive(Default)]
pub(crate) struct Pools {
    databases: Mutex<HashMap<String, PgPool>>,
    /// A cache per test KV namespace (`seedScope`), for what a cron job
    /// remembers between ticks: a new namespace starts empty, as in the test.
    caches: Mutex<HashMap<String, Arc<MemoryCache>>>,
    /// The test buckets' HTTP stores, by URL.
    buckets: crate::conformance_files::BucketBridges,
    /// The test KV namespaces' HTTP caches, by URL.
    kv: crate::conformance_kv::KvBridges,
    /// Session verifiers for the tests' own `CLERK_JWT_KEY`, by key.
    verifiers: Mutex<HashMap<String, Arc<SessionVerifier>>>,
    /// The bridged third-party providers, by bridge URL.
    outbound: crate::conformance_outbound::OutboundBridges,
}

impl Pools {
    /// A verifier for the test's `CLERK_JWT_KEY` (and
    /// `CLERK_AUTHORIZED_PARTIES`), so a session token the test signed is
    /// checked as the worker's `verifyToken({ jwtKey })` checks it.
    fn verifier(&self, env: &HashMap<String, String>) -> Option<Arc<SessionVerifier>> {
        let pem = env.get("CLERK_JWT_KEY").filter(|pem| !pem.is_empty())?;
        let parties = env.get("CLERK_AUTHORIZED_PARTIES").map(String::as_str);
        let cache_key = format!("{pem}\n{}", parties.unwrap_or_default());
        let mut verifiers = self
            .verifiers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(verifier) = verifiers.get(&cache_key) {
            return Some(Arc::clone(verifier));
        }
        let verifier = Arc::new(SessionVerifier::from(
            ClerkVerifier::from_pem(pem, parties).ok()?,
        ));
        verifiers.insert(cache_key, Arc::clone(&verifier));
        Some(verifier)
    }

    /// What the test shares with Rust beyond the session: its env, buckets,
    /// KV, session key and outbound bridge.
    fn insert_shared(&self, extensions: &mut http::Extensions, context: &TestContext) {
        extensions.insert(weldsuite_kit::RequestEnv(std::sync::Arc::new(
            context.env.clone(),
        )));
        // The test's buckets; without them a module keeps the app state's stores.
        if let Some(stores) = self.buckets.file_stores(&context.files) {
            extensions.insert(stores);
        }
        if let Some(buckets) = self.buckets.storage_buckets(&context.files) {
            extensions.insert(buckets);
        }
        if let Some(cache) = self.kv.request_cache(&context.kv) {
            extensions.insert(cache);
        }
        if let Some(verifier) = self.verifier(&context.env) {
            extensions.insert(verifier);
        }
        // The identity provider and the other third parties answer from the
        // test's fetch stub.
        if let Some(bridge) = context.outbound.as_deref() {
            self.outbound.extend(extensions, bridge);
        }
    }

    fn get(&self, url: &str) -> Result<PgPool, ApiError> {
        let mut pools = self
            .databases
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(pool) = pools.get(url) {
            return Ok(pool.clone());
        }
        let options: PgConnectOptions = url
            .parse()
            .map_err(|_| ApiError::bad_request("conformance: databaseUrl is not a Postgres URL"))?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_lazy_with(options);
        pools.insert(url.to_owned(), pool.clone());
        Ok(pool)
    }
}

/// Middleware in place of `clerk_auth` + `workspace_db`.
pub(crate) async fn auth(
    State(pools): State<Arc<Pools>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(context) = TestContext::from_headers(request.headers()) else {
        return ApiError::unauthorized()
            .with_message("Missing or invalid Authorization header")
            .into_response();
    };
    let db = match pools.get(&context.database_url) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };

    let master = match context
        .master_database_url
        .as_deref()
        .map(|url| pools.get(url))
    {
        Some(Ok(pool)) => Some(pool),
        Some(Err(error)) => return error.into_response(),
        None => None,
    };

    let app_enforced = context
        .env
        .get("PERMISSIONS_APP_ENFORCE")
        .map(|value| value == "true");
    let extensions = request.extensions_mut();
    if let Some(enforced) = app_enforced {
        extensions.insert(AppEnforcedOverride(enforced));
    }
    if let Some(master) = master {
        extensions.insert(weldsuite_db::MasterDb(master));
    }
    pools.insert_shared(extensions, &context);
    if let Some(permissions) = context.permissions {
        let app = extensions.get::<AppContext>().map(|app| app.0);
        extensions.insert(Permissions::new(
            ResolvedPermissions {
                permissions: permissions.permissions,
                denies: permissions.denies,
                role: permissions.role,
                role_id: permissions.role_id,
                is_owner: permissions.is_owner,
            },
            app,
            app_enforced.unwrap_or(false),
            context.user_id.clone(),
        ));
    }
    if let Some(values) = context.flags {
        let source = values
            .into_iter()
            .fold(StaticFlags::new(), |flags, (key, value)| {
                flags.with(&key, value)
            });
        extensions.insert(Flags::new(
            Arc::new(source),
            FlagContext {
                workspace_id: context.workspace_id.clone(),
                clerk_org_id: context.clerk_org_id.clone(),
                user_id: context.user_id.clone(),
            },
        ));
    }
    extensions.insert(Tenant {
        workspace_id: context.workspace_id,
        clerk_org_id: context.clerk_org_id,
        db,
        suspended: false,
        restrictions: WorkspaceRestrictions::default(),
    });
    extensions.insert(AuthContext {
        user_id: context.user_id,
        org_id: context.org_id,
        session_id: context.session_id,
        factor_verification_age: context.factor_verification_age,
    });
    run_reporting_route(request, next).await
}

/// The rest of the request, with the route that answered in
/// `X-Weld-Route`.
async fn run_reporting_route(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| hono_pattern(path.as_str()));
    let mut response = next.run(request).await;
    if let Some(value) = route.and_then(|route| http::HeaderValue::from_str(&route).ok()) {
        response.headers_mut().insert(ROUTE_HEADER, value);
    }
    response
}

/// Middleware for the routes that run before authentication (the upload
/// PUT, the private-object read, the WeldApps bundle host, the CLI's device
/// login): no session from the test, only what it shares (master database,
/// env, buckets, KV, its session key). A request without the header goes on
/// with the app's own.
pub(crate) async fn public(
    State(pools): State<Arc<Pools>>,
    mut request: Request,
    next: Next,
) -> Response {
    if let Some(context) = TestContext::from_headers(request.headers()) {
        // The master database too: the WeldApps bundle host and the CLI's
        // device login read it before any session.
        if let Some(url) = context.master_database_url.as_deref() {
            match pools.get(url) {
                Ok(master) => {
                    request
                        .extensions_mut()
                        .insert(weldsuite_db::MasterDb(master));
                }
                Err(error) => return error.into_response(),
            }
        }
        pools.insert_shared(request.extensions_mut(), &context);
    }
    run_reporting_route(request, next).await
}

// ── Cron jobs ───────────────────────────────────────────────────────────────

/// `POST /__conformance/cron/sign-lifecycle`: one tick of the WeldSign
/// lifecycle sweep against the test's databases, as `runLifecycleSweep(env,
/// now)` runs it there (`packages/core/worker-kit/src/testing/conformance-cron.ts`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepRequest {
    /// The tick's time (ISO).
    now: String,
    database_url: String,
    master_database_url: String,
    #[serde(default)]
    env: HashMap<String, String>,
    /// `workspaces.id` → Clerk org id: what the test's `getWorkspaceForOrg`
    /// answers, read the other way.
    #[serde(default)]
    workspaces: HashMap<String, String>,
    /// The test's KV namespace (its seed flag lives there).
    seed_scope: String,
}

/// Every workspace opens the test's tenant database.
struct TestTenants {
    db: PgPool,
    orgs: HashMap<String, String>,
}

impl weldsuite_sign::TenantResolver for TestTenants {
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> weldsuite_ports::BoxFuture<'a, Result<weldsuite_sign::TenantRef, String>> {
        let tenant = weldsuite_sign::TenantRef {
            db: self.db.clone(),
            workspace_id: reference.to_owned(),
            clerk_org_id: self.orgs.get(reference).cloned(),
        };
        Box::pin(std::future::ready(Ok(tenant)))
    }
}

pub(crate) async fn sign_lifecycle_sweep(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<SweepRequest>,
) -> Response {
    let pools = &state.conformance_pools;
    let (db, master) = match (
        pools.get(&request.database_url),
        pools.get(&request.master_database_url),
    ) {
        (Ok(db), Ok(master)) => (db, master),
        (Err(error), _) | (_, Err(error)) => return error.into_response(),
    };
    let Ok(now) =
        time::OffsetDateTime::parse(&request.now, &time::format_description::well_known::Rfc3339)
    else {
        return ApiError::bad_request("conformance: now is not an ISO time").into_response();
    };
    let cache = Arc::clone(
        pools
            .caches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(request.seed_scope)
            .or_default(),
    );
    let services = weldsuite_sign::Services {
        events: state.infra.events.clone(),
        files: None,
        mail: Some(state.recorders.mail.clone()),
        cache: Some(cache),
        flags: Arc::clone(&state.infra.flags),
        portal_url: request.env.get("SIGN_PORTAL_URL").cloned(),
        environment: request.env.get("ENVIRONMENT").cloned(),
    };
    let tenants: Arc<dyn weldsuite_sign::TenantResolver> = Arc::new(TestTenants {
        db,
        orgs: request.workspaces,
    });
    let result = weldsuite_sign::run_lifecycle_sweep(&master, &tenants, &services, now).await;
    axum::Json(json!({
        "due": result.due,
        "processed": result.processed,
        "failed": result.failed,
        "seeded": result.seeded,
        "reminded": result.reminded,
        "expired": result.expired,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::hono_pattern;

    #[test]
    fn route_patterns_use_hono_syntax() {
        assert_eq!(hono_pattern("/api/me/permissions"), "/api/me/permissions");
        assert_eq!(
            hono_pattern("/api/companies/{id}/notes/{noteId}"),
            "/api/companies/:id/notes/:noteId"
        );
    }
}
