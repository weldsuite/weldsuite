//! `/public/project-portal`: the client portal API (FLOW-020), served without a
//! Clerk session (`routes/public-project-portal/index.ts`,
//! `lib/portal-session.ts`).
//!
//! The workspace comes from a slug (sign-in) or from the session (everything
//! after), the caller from a hashed session token in the workspace cache, like
//! the commerce portal (COM-007). Conformance builds put the test's tenant on
//! the request and skip the master lookup, as the worker's tests do.
//!
//! ```text
//! POST /auth/request-code      email a code; always 204
//! POST /auth/verify            code -> session token
//! POST /auth/sign-out          end the session
//! GET  /me                     the contact and the workspace
//! GET  /projects               the contact's projects
//! GET  /projects/:id           progress, milestones, next milestone, latest report
//! GET  /projects/:id/reports   published, client visible reports
//! GET  /projects/:id/files     client visible files           (+ /:fileId/download)
//! GET  /projects/:id/documents client visible documents       (+ /:documentId/download)
//! GET  /projects/:id/messages  the client visible thread
//! POST /projects/:id/messages  write to the project team
//! GET  /approvals              reviews waiting for the contact
//! POST /approvals/:id/decide   answer one
//! ```
//!
//! The checks run in a fixed order so every backend answers alike: the session
//! (401), then the object (404, also for one the contact may not see), then
//! the body (400), then the rules. Every shape is an allowlist
//! (`weldsuite_flow_domain::project_portal`).

// A refusal is the route's response, returned early from its helpers.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HeaderName,
};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{EventName, PROJECT_MESSAGE_CREATED};
use weldsuite_commerce_domain::portal_slug::normalize_portal_slug;
use weldsuite_commerce_domain::portal_tokens::{
    PortalKv, kv_delete, kv_get_json, kv_put_json, random_otp, random_token, sha256_hex,
};
use weldsuite_commerce_domain::rate_limit::{
    RateLimitCounters, RateLimitOutcome, RequestRateLimiter, consume_rate_limit, release_rate_limit,
};
use weldsuite_db::Tenant;
use weldsuite_emails::EmailLocale;
use weldsuite_events::{EntityEvent, EventContext};
use weldsuite_flow_domain::js::parse_int;
use weldsuite_flow_domain::project_portal::{
    PORTAL_CODE_LENGTH, PORTAL_CODE_TTL_SECONDS, PORTAL_DECISIONS, PORTAL_LOCALES,
    PORTAL_MAX_VERIFY_ATTEMPTS, PORTAL_REQUEST_LIMIT_EMAIL, PORTAL_REQUEST_LIMIT_WORKSPACE,
    PORTAL_REQUEST_WINDOW_SECONDS, PORTAL_SESSION_TTL_SECONDS, PORTAL_SLUG_TTL_SECONDS,
    PORTAL_VERIFY_LIMIT_EMAIL, PORTAL_VERIFY_LIMIT_WORKSPACE, PortalChallenge, PortalSessionRecord,
    PortalSlugEntry, attachment_disposition, is_portal_approval_subject,
    messages as portal_messages, normalize_portal_email, portal_code_input, portal_code_key,
    portal_message_metadata, portal_session_key, portal_slug_key, present_message,
    session_expires_at, session_needs_refresh,
};
use weldsuite_kit::validation::{Format, Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_ports::{
    DynCache, DynSystemMail, FileStore, FileStores, RequestCache, StorageBuckets, is_safe_key,
};

use weldsuite_flow_domain::approvals::{
    ApprovalActor, ApprovalRow, DecideApprovalResult, DecideRefusal,
};

use weldsuite_permissions::{Permissions, ResolvedPermissions};

use crate::approvals::decide_and_announce;
use crate::portal_mail::{PortalMail, send_portal_code_email};
use crate::portal_store::{
    self, contacts_of_session, contacts_with_access, find_portal_document, find_portal_file,
    get_portal_project, list_portal_documents, list_portal_files, list_portal_messages,
    list_portal_projects, list_portal_reports, pending_reviews, portal_project_rows,
    present_reviews,
};
use crate::raid_body::parse_body;
use crate::{Caller, FlowState, Query, Refusal, Reply, all_rows, now, now_ms, paged, reply};

/// What the portal shares beyond the flow state: the workspace cache (codes,
/// sessions, the slug lookup), system mail, the rate-limit counters
/// (`PORTAL_RATE_LIMITER`), the master database (workspace slugs) and the
/// directory that opens a workspace's tenant database. A request's own
/// (conformance) wins.
#[derive(Clone)]
pub struct PortalState {
    pub cache: Option<Arc<dyn DynCache>>,
    pub mail: Option<Arc<dyn DynSystemMail>>,
    pub limiter: Option<Arc<dyn RateLimitCounters>>,
    pub master: Option<PgPool>,
    pub workspaces: Option<Arc<weldsuite_db::Workspaces>>,
    /// The worker's env values (`ENVIRONMENT`).
    pub env: Arc<HashMap<String, String>>,
}

impl std::fmt::Debug for PortalState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortalState")
            .field("cache", &self.cache.is_some())
            .field("mail", &self.mail.is_some())
            .field("limiter", &self.limiter.is_some())
            .field("master", &self.master.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct App {
    flow: FlowState,
    portal: PortalState,
}

pub(crate) fn router<S>(state: FlowState, portal: PortalState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/auth/request-code", post(request_code))
        .route("/auth/verify", post(verify))
        .route("/auth/sign-out", post(sign_out))
        .route("/me", get(me))
        .route("/projects", get(projects))
        .route("/projects/{id}", get(project))
        .route("/projects/{id}/reports", get(reports))
        .route("/projects/{id}/files", get(files))
        .route(
            "/projects/{id}/files/{file_id}/download",
            get(download_file),
        )
        .route("/projects/{id}/documents", get(documents))
        .route(
            "/projects/{id}/documents/{document_id}/download",
            get(download_document),
        )
        .route("/projects/{id}/messages", get(messages).post(post_message))
        .route("/approvals", get(approvals))
        .route("/approvals/{id}/decide", post(decide))
        .with_state(App {
            flow: state,
            portal,
        })
}

// ── The request ─────────────────────────────────────────────────────────────

/// What a request brings: its tenant (conformance), and what it shares in
/// place of the state's.
struct Req {
    tenant: Option<Tenant>,
    kv: PortalKv,
    limiter: Option<Arc<dyn RateLimitCounters>>,
    master: Option<PgPool>,
    mail: PortalMail,
    buckets: StorageBuckets,
}

impl Req {
    fn of(parts: &Parts, app: &App) -> Self {
        let ext = &parts.extensions;
        let kv = ext
            .get::<RequestCache>()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| app.portal.cache.clone());
        let limiter = match ext.get::<RequestRateLimiter>() {
            Some(own) => own.0.clone(),
            None => app.portal.limiter.clone(),
        };
        let master = ext
            .get::<weldsuite_db::MasterDb>()
            .map(|master| master.0.clone())
            .or_else(|| app.portal.master.clone());
        let mail = match ext.get::<weldsuite_mail_domain::outbound::RequestOutbound>() {
            Some(outbound) => outbound
                .0
                .transport
                .clone()
                .map_or(PortalMail::None, PortalMail::Transport),
            None => app
                .portal
                .mail
                .clone()
                .map_or(PortalMail::None, PortalMail::System),
        };
        let buckets = ext
            .get::<StorageBuckets>()
            .cloned()
            .or_else(|| ext.get::<FileStores>().cloned().map(StorageBuckets::from))
            .or_else(|| app.flow.files.clone().map(StorageBuckets::from))
            .unwrap_or_default();
        Self {
            tenant: ext.get::<Tenant>().cloned(),
            kv,
            limiter,
            master,
            mail,
            buckets,
        }
    }
}

impl FromRequestParts<App> for Req {
    type Rejection = Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        app: &App,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self::of(parts, app)))
    }
}

fn unauthorized(message: &str) -> Response {
    ApiError::unauthorized()
        .with_message(message)
        .into_response()
}

fn internal(message: &str, error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "[flow-api/public-project-portal] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// The session token: `Authorization: Bearer <token>`.
fn read_bearer(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    if !header.to_lowercase().starts_with("bearer ") {
        return None;
    }
    let token = js_trim(header.get(7..)?).to_owned();
    (!token.is_empty()).then_some(token)
}

/// A signed-in contact: the session middleware's work (`portalSession`). A
/// request needs a live session token; the workspace is the session's own; and
/// at least one of the session's contacts must still hold portal access on a
/// live project, or the answer is 401 "Access revoked". A session used again
/// more than a day after it was last written gets a new TTL (sliding expiry).
struct Session {
    req: Req,
    db: PgPool,
    workspace_id: String,
    clerk_org_id: Option<String>,
    record: PortalSessionRecord,
    /// The projects the session's contacts may see, read on this request.
    rows: Vec<Value>,
}

impl FromRequestParts<App> for Session {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, Self::Rejection> {
        let req = Req::of(parts, app);
        let Some(token) = read_bearer(&parts.headers) else {
            return Err(unauthorized(portal_messages::SIGN_IN_REQUIRED));
        };
        let token_hash = sha256_hex(&token);
        let record: Option<PortalSessionRecord> =
            kv_get_json(&req.kv, &portal_session_key(&token_hash))
                .await
                .map_err(|e| internal("Internal server error", &e))?;
        let Some(record) = record else {
            return Err(unauthorized(portal_messages::SESSION_EXPIRED));
        };

        let (db, workspace_id, clerk_org_id) = if let Some(tenant) = &req.tenant {
            if record.workspace_id != tenant.workspace_id {
                return Err(unauthorized(portal_messages::SESSION_EXPIRED));
            }
            (
                tenant.db.clone(),
                tenant.workspace_id.clone(),
                tenant
                    .clerk_org_id
                    .clone()
                    .or_else(|| record.clerk_org_id.clone()),
            )
        } else {
            let Some(workspaces) = &app.portal.workspaces else {
                return Err(internal(
                    "Failed to resolve workspace",
                    &"no workspace directory",
                ));
            };
            let reference = record
                .clerk_org_id
                .as_deref()
                .filter(|org| !org.is_empty())
                .unwrap_or(&record.workspace_id);
            let tenant = workspaces
                .tenant(reference)
                .await
                .map_err(|e| internal("Failed to resolve workspace", &e))?;
            (
                tenant.db,
                record.workspace_id.clone(),
                record.clerk_org_id.clone(),
            )
        };

        // Revocation: the access is read from the tenant database on every request.
        let rows = portal_project_rows(&db, &record.contact_ids)
            .await
            .map_err(|e| internal("Internal server error", &e))?;
        if rows.is_empty() {
            return Err(unauthorized(portal_messages::ACCESS_REVOKED));
        }

        if session_needs_refresh(&record.last_seen_at, now_ms()) {
            let refreshed = PortalSessionRecord {
                last_seen_at: now(),
                ..record.clone()
            };
            let kv = req.kv.clone();
            let key = portal_session_key(&token_hash);
            tokio::spawn(async move {
                if let Err(error) =
                    kv_put_json(&kv, &key, &refreshed, PORTAL_SESSION_TTL_SECONDS).await
                {
                    tracing::error!(%error, "[flow-api/public-project-portal] could not refresh the session");
                }
            });
        }
        Ok(Self {
            req,
            db,
            workspace_id,
            clerk_org_id,
            record,
            rows,
        })
    }
}

impl Session {
    /// The contact ids of the session.
    fn contact_ids(&self) -> &[String] {
        &self.record.contact_ids
    }

    /// One of the contact's projects, or a 404 (the same for a project that
    /// does not exist and one they may not see).
    fn own_project(&self, id: &str) -> Result<&Value, Refusal> {
        self.rows
            .iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| Refusal::not_found("Project", id))
    }

    fn by_id(&self) -> HashMap<String, &Value> {
        self.rows
            .iter()
            .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), row)))
            .collect()
    }

    /// The session as the approvals core sees a caller (`c.set('userId',
    /// contactId)`): no permissions, the contact as the user, so the entity
    /// events and the aftermath of an answer are the ones a member's give.
    fn contact_caller(&self, contact_id: &str) -> Caller {
        let resolved = ResolvedPermissions {
            permissions: Vec::new(),
            denies: Vec::new(),
            role: String::new(),
            role_id: None,
            is_owner: false,
        };
        Caller {
            db: self.db.clone(),
            user_id: contact_id.to_owned(),
            permissions: Permissions::new(resolved, None, false, contact_id.to_owned()),
            events: EventContext::from_ids(
                &self.workspace_id,
                self.clerk_org_id.as_deref(),
                contact_id,
            ),
            clerk_org_id: self.clerk_org_id.clone(),
            org_id: None,
            workspace_id: self.workspace_id.clone(),
            env: None,
            buckets: None,
            master: None,
            flags: None,
            http: None,
            presence: None,
            outbox: std::sync::Mutex::default(),
        }
    }

    /// Entity events, in order, as the contact `user_id` (TypeScript's queue
    /// sends land in publish order, so one task sends them one after another).
    fn publish(&self, app: &App, user_id: &str, events: Vec<(EventName, String, Value)>) {
        let context =
            EventContext::from_ids(&self.workspace_id, self.clerk_org_id.as_deref(), user_id);
        let publisher = app.flow.events.clone();
        app.flow.events.tracker().spawn(async move {
            for (event, id, data) in events {
                publisher
                    .publish_and_wait(&context, EntityEvent::new(event, id, data))
                    .await;
            }
        });
    }
}

// ── Request bodies (Zod: `project-portal` schemas, all `.strict()`) ─────────

/// `.strict()`: one `unrecognized_keys` issue at the object's own path.
fn strict(issues: &mut Issues, fields: &Map<String, Value>, known: &[&str]) {
    let extra: Vec<&String> = fields
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .collect();
    if extra.is_empty() {
        return;
    }
    let listed = extra
        .iter()
        .map(|key| format!("'{key}'"))
        .collect::<Vec<_>>()
        .join(", ");
    issues.issue_here(json!({
        "code": "unrecognized_keys",
        "keys": extra,
        "message": format!("Unrecognized key(s) in object: {listed}"),
    }));
}

/// `workspaceSlug`: `z.string().trim().min(1).max(100)`.
const WORKSPACE_SLUG: Text = Text::trimmed(Some(1), Some(100));

/// `emailAddress`: `z.string().trim().email().max(255)`.
fn email_address() -> Text {
    Text {
        trim: true,
        format: Some(Format::Email),
        max: Some(255),
        ..Text::default()
    }
}

struct RequestCode {
    workspace: String,
    email: String,
    locale: Option<String>,
}

/// `requestPortalCodeSchema`.
fn read_request_code(issues: &mut Issues, body: &Value) -> Option<RequestCode> {
    let fields = issues.object(body)?;
    let workspace = issues.text_with(fields, "workspace", Presence::Required, WORKSPACE_SLUG);
    let email = issues.text_with(fields, "email", Presence::Required, email_address());
    let locale = issues.choice(fields, "locale", Presence::Optional, &PORTAL_LOCALES);
    strict(issues, fields, &["workspace", "email", "locale"]);
    Some(RequestCode {
        workspace: workspace.into_option().unwrap_or_default(),
        email: email.into_option().unwrap_or_default(),
        locale: locale.into_option(),
    })
}

struct VerifyCode {
    workspace: String,
    email: String,
    code: String,
}

/// `verifyPortalCodeSchema`.
fn read_verify(issues: &mut Issues, body: &Value) -> Option<VerifyCode> {
    let fields = issues.object(body)?;
    let workspace = issues.text_with(fields, "workspace", Presence::Required, WORKSPACE_SLUG);
    let email = issues.text_with(fields, "email", Presence::Required, email_address());
    let code = issues
        .text_with(
            fields,
            "code",
            Presence::Required,
            Text::trimmed(None, None),
        )
        .into_option();
    if let Some(code) = &code
        && !(code.len() == PORTAL_CODE_LENGTH && code.bytes().all(|b| b.is_ascii_digit()))
    {
        issues.issue_at(
            "code",
            json!({
                "validation": "regex",
                "code": "invalid_string",
                "message": format!("The code is {PORTAL_CODE_LENGTH} digits"),
            }),
        );
    }
    strict(issues, fields, &["workspace", "email", "code"]);
    Some(VerifyCode {
        workspace: workspace.into_option().unwrap_or_default(),
        email: email.into_option().unwrap_or_default(),
        code: code.unwrap_or_default(),
    })
}

/// `postPortalMessageSchema`: `message: z.string().trim().min(1).max(4000)`.
fn read_post_message(issues: &mut Issues, body: &Value) -> Option<String> {
    let fields = issues.object(body)?;
    let message = issues.text_with(
        fields,
        "message",
        Presence::Required,
        Text::trimmed(Some(1), Some(4000)),
    );
    strict(issues, fields, &["message"]);
    Some(message.into_option().unwrap_or_default())
}

/// `decidePortalApprovalSchema`.
fn read_decide(issues: &mut Issues, body: &Value) -> Option<(String, Option<String>)> {
    let fields = issues.object(body)?;
    let decision = issues.choice(fields, "decision", Presence::Required, &PORTAL_DECISIONS);
    let note = issues.text_with(
        fields,
        "note",
        Presence::Nullish,
        Text::trimmed(None, Some(2000)),
    );
    strict(issues, fields, &["decision", "note"]);
    Some((
        decision.into_option().unwrap_or_default(),
        note.into_option(),
    ))
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/// A workspace opened for a portal request.
struct Opened {
    db: PgPool,
    workspace_id: String,
    clerk_org_id: Option<String>,
    slug: String,
    name: String,
}

/// `openWorkspaceBySlug`: the workspace of a slug and its tenant database;
/// `None` for a slug that is not a workspace's (malformed, unknown or
/// inactive). The slug is matched exactly: there is no prefix fallback, so a
/// request cannot enumerate workspaces. A request that already has its tenant
/// (conformance) skips the master lookup.
async fn open_workspace(app: &App, req: &Req, raw_slug: &str) -> Result<Option<Opened>, String> {
    let Some(slug) = normalize_portal_slug(Some(raw_slug)) else {
        return Ok(None);
    };
    if let Some(tenant) = &req.tenant {
        return Ok(Some(Opened {
            db: tenant.db.clone(),
            workspace_id: tenant.workspace_id.clone(),
            clerk_org_id: tenant.clerk_org_id.clone(),
            name: slug.clone(),
            slug,
        }));
    }
    let key = portal_slug_key(&slug);
    let mut entry: Option<PortalSlugEntry> = kv_get_json(&req.kv, &key)
        .await
        .map_err(|e| e.to_string())?;
    if entry.is_none() {
        let master = req.master.clone().ok_or("no master database")?;
        let row: Option<(String, Option<String>, String, Option<bool>)> = sqlx::query_as(
            "select id, clerk_org_id, name, is_active from workspaces where slug = $1 limit 1",
        )
        .bind(&slug)
        .fetch_optional(&master)
        .await
        .map_err(|e| e.to_string())?;
        let Some((id, Some(clerk_org_id), name, Some(true))) = row else {
            return Ok(None);
        };
        if clerk_org_id.is_empty() {
            return Ok(None);
        }
        let found = PortalSlugEntry {
            workspace_id: id,
            clerk_org_id,
            name,
        };
        kv_put_json(&req.kv, &key, &found, PORTAL_SLUG_TTL_SECONDS)
            .await
            .map_err(|e| e.to_string())?;
        entry = Some(found);
    }
    let entry = entry.ok_or("no workspace")?;
    let workspaces = app
        .portal
        .workspaces
        .as_ref()
        .ok_or("no workspace directory")?;
    let tenant = workspaces
        .tenant(&entry.clerk_org_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(Opened {
        db: tenant.db,
        workspace_id: entry.workspace_id,
        clerk_org_id: Some(entry.clerk_org_id),
        slug,
        name: entry.name,
    }))
}

/// The counters behind the rate limits could not be reached. Both sign-in
/// endpoints refuse rather than run without a limit (fail closed): the answer
/// is the same for every address and workspace, so it reveals nothing about who
/// has access.
fn sign_in_unavailable() -> Response {
    ApiError::unavailable(portal_messages::SIGN_IN_UNAVAILABLE).into_response()
}

async fn request_code(State(app): State<App>, req: Req, body: Bytes) -> Response {
    let parsed = match parse_body(&body, read_request_code) {
        Ok(parsed) => parsed,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    let email = normalize_portal_email(&parsed.email);
    match run_request_code(&app, &req, &parsed, &email).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[flow-api/public-project-portal] request-code failed");
            NoContent.into_response()
        }
    }
}

async fn run_request_code(
    app: &App,
    req: &Req,
    body: &RequestCode,
    email: &str,
) -> Result<Response, String> {
    // An unknown workspace looks exactly like an address with no access.
    let Some(workspace) = open_workspace(app, req, &body.workspace).await? else {
        return Ok(NoContent.into_response());
    };
    let ws = workspace.workspace_id.as_str();

    // Per address first, so one bombarded address cannot drain the workspace's
    // budget, then per workspace across all addresses. Over a limit looks
    // exactly like "no access": the same 204.
    for (key, max) in [
        (format!("e:{email}"), PORTAL_REQUEST_LIMIT_EMAIL),
        ("request-ws".to_owned(), PORTAL_REQUEST_LIMIT_WORKSPACE),
    ] {
        match consume_rate_limit(
            req.limiter.as_ref(),
            ws,
            &key,
            max,
            PORTAL_REQUEST_WINDOW_SECONDS,
        )
        .await
        {
            RateLimitOutcome::Unavailable => return Ok(sign_in_unavailable()),
            RateLimitOutcome::Limited => return Ok(NoContent.into_response()),
            RateLimitOutcome::Allowed => {}
        }
    }

    let contacts = contacts_with_access(&workspace.db, email)
        .await
        .map_err(|e| e.to_string())?;
    if contacts.is_empty() {
        return Ok(NoContent.into_response());
    }

    let code = random_otp();
    let challenge = PortalChallenge {
        code_hash: sha256_hex(&portal_code_input(ws, email, &code)),
        email: email.to_owned(),
        workspace_id: ws.to_owned(),
        contact_ids: contacts.iter().map(|c| c.id.clone()).collect(),
        attempts: 0,
    };
    kv_put_json(
        &req.kv,
        &portal_code_key(ws, email),
        &challenge,
        PORTAL_CODE_TTL_SECONDS,
    )
    .await
    .map_err(|e| e.to_string())?;
    let locale = if body.locale.as_deref() == Some("nl") {
        EmailLocale::Nl
    } else {
        EmailLocale::En
    };
    send_portal_code_email(&req.mail, email, &code, &workspace.name, locale).await;
    Ok(NoContent.into_response())
}

/// The verify budgets reserved up front (failed attempts only: given back once
/// the sign-in succeeds, so a successful sign-in uses up nothing).
struct Reservation<'a> {
    limiter: Option<&'a Arc<dyn RateLimitCounters>>,
    workspace_id: &'a str,
    keys: Vec<String>,
}

impl Reservation<'_> {
    async fn release(&self) {
        for key in &self.keys {
            release_rate_limit(self.limiter, self.workspace_id, key).await;
        }
    }
}

/// `reserveVerifyBudget`: per address, then per workspace across all
/// addresses. Each is reserved atomically up front, so parallel guesses cannot
/// all slip past a check-then-count. The refusal to send (holding no slot), or
/// the reservation.
async fn reserve_verify_budget<'a>(
    req: &'a Req,
    workspace_id: &'a str,
    email: &str,
) -> Result<Reservation<'a>, Response> {
    let mut reservation = Reservation {
        limiter: req.limiter.as_ref(),
        workspace_id,
        keys: Vec::new(),
    };
    for (key, max) in [
        (format!("verify-e:{email}"), PORTAL_VERIFY_LIMIT_EMAIL),
        ("verify-ws".to_owned(), PORTAL_VERIFY_LIMIT_WORKSPACE),
    ] {
        let outcome = consume_rate_limit(
            req.limiter.as_ref(),
            workspace_id,
            &key,
            max,
            PORTAL_REQUEST_WINDOW_SECONDS,
        )
        .await;
        if outcome == RateLimitOutcome::Allowed {
            reservation.keys.push(key);
            continue;
        }
        reservation.release().await;
        if outcome == RateLimitOutcome::Unavailable {
            return Err(sign_in_unavailable());
        }
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(json!({
                "error": { "code": "RATE_LIMITED", "message": portal_messages::TOO_MANY_ATTEMPTS }
            })),
        )
            .into_response());
    }
    Ok(reservation)
}

async fn verify(State(app): State<App>, req: Req, body: Bytes) -> Response {
    let parsed = match parse_body(&body, read_verify) {
        Ok(parsed) => parsed,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    match run_verify(&app, &req, &parsed).await {
        Ok(response) => response,
        Err(error) => internal("Failed to verify sign-in", &error),
    }
}

fn failed_code() -> Response {
    unauthorized(portal_messages::INVALID_CODE)
}

async fn run_verify(app: &App, req: &Req, body: &VerifyCode) -> Result<Response, String> {
    let email = normalize_portal_email(&body.email);
    let Some(workspace) = open_workspace(app, req, &body.workspace).await? else {
        return Ok(failed_code());
    };
    let ws = workspace.workspace_id.as_str();

    let reservation = match reserve_verify_budget(req, ws, &email).await {
        Ok(reservation) => reservation,
        Err(refusal) => return Ok(refusal),
    };

    let key = portal_code_key(ws, &email);
    let challenge: Option<PortalChallenge> = kv_get_json(&req.kv, &key)
        .await
        .map_err(|e| e.to_string())?;
    let Some(challenge) = challenge else {
        return Ok(failed_code());
    };
    if challenge.attempts >= PORTAL_MAX_VERIFY_ATTEMPTS {
        kv_delete(&req.kv, &key).await.map_err(|e| e.to_string())?;
        return Ok(failed_code());
    }

    // `attempts` is a KV read-modify-write, so guesses sent in parallel all read
    // the same value and all get checked. This per-challenge counter is atomic
    // and is what really caps the guesses at PORTAL_MAX_VERIFY_ATTEMPTS.
    let budget = consume_rate_limit(
        req.limiter.as_ref(),
        ws,
        &format!("verify-ch:{}", challenge.code_hash),
        PORTAL_MAX_VERIFY_ATTEMPTS,
        PORTAL_CODE_TTL_SECONDS,
    )
    .await;
    match budget {
        RateLimitOutcome::Unavailable => {
            reservation.release().await;
            return Ok(sign_in_unavailable());
        }
        RateLimitOutcome::Limited => {
            kv_delete(&req.kv, &key).await.map_err(|e| e.to_string())?;
            return Ok(failed_code());
        }
        RateLimitOutcome::Allowed => {}
    }

    if sha256_hex(&portal_code_input(ws, &email, &body.code)) != challenge.code_hash {
        let attempts = challenge.attempts + 1;
        if attempts >= PORTAL_MAX_VERIFY_ATTEMPTS {
            kv_delete(&req.kv, &key).await.map_err(|e| e.to_string())?;
        } else {
            let counted = PortalChallenge {
                attempts,
                ..challenge
            };
            kv_put_json(&req.kv, &key, &counted, PORTAL_CODE_TTL_SECONDS)
                .await
                .map_err(|e| e.to_string())?;
        }
        return Ok(failed_code());
    }

    // The code was right: it is spent, and this attempt is not a failure.
    kv_delete(&req.kv, &key).await.map_err(|e| e.to_string())?;
    reservation.release().await;

    // Access is read again: it may have been switched off since the code was sent.
    let contacts = contacts_with_access(&workspace.db, &email)
        .await
        .map_err(|e| e.to_string())?;
    let Some(first) = contacts.first() else {
        return Ok(failed_code());
    };

    let created = now();
    let record = PortalSessionRecord {
        workspace_id: ws.to_owned(),
        clerk_org_id: workspace.clerk_org_id.clone(),
        workspace_slug: workspace.slug.clone(),
        workspace_name: workspace.name.clone(),
        email: email.clone(),
        contact_ids: contacts.iter().map(|c| c.id.clone()).collect(),
        created_at: created.clone(),
        last_seen_at: created.clone(),
    };
    let token = random_token(32);
    kv_put_json(
        &req.kv,
        &portal_session_key(&sha256_hex(&token)),
        &record,
        PORTAL_SESSION_TTL_SECONDS,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(Data(json!({
        "token": token,
        "expiresAt": session_expires_at(&created, now_ms()),
        "contact": { "id": first.id, "name": first.name, "email": email },
        "workspace": { "slug": workspace.slug, "name": workspace.name },
    }))
    .into_response())
}

async fn sign_out(req: Req, headers: HeaderMap) -> Response {
    if let Some(token) = read_bearer(&headers)
        && let Err(error) = kv_delete(&req.kv, &portal_session_key(&sha256_hex(&token))).await
    {
        tracing::error!(%error, "[flow-api/public-project-portal] sign-out failed");
    }
    NoContent.into_response()
}

// ── Account and projects ────────────────────────────────────────────────────

async fn me(session: Session) -> Response {
    reply(me_of(&session).await, "Failed to load the account")
}

async fn me_of(session: &Session) -> Reply {
    let contacts = contacts_of_session(&session.db, session.contact_ids()).await?;
    let record = &session.record;
    let (id, name) = match contacts.first() {
        Some(contact) => (contact.id.clone(), contact.name.clone()),
        None => (
            record.contact_ids.first().cloned().unwrap_or_default(),
            record.email.clone(),
        ),
    };
    Ok(Data(json!({
        "contact": { "id": id, "name": name, "email": record.email },
        "workspace": { "slug": record.workspace_slug, "name": record.workspace_name },
    }))
    .into_response())
}

/// `limit` and `cursor` of a paged list (`parseLimit(q.limit, 25, 100)`).
fn page_options(raw: Option<&str>) -> (i64, Option<String>) {
    let query = Query::parse(raw);
    let limit = match query.get("limit").and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(100),
        _ => 25,
    };
    (limit, query.present("cursor").map(str::to_owned))
}

fn page_response(page: portal_store::Page) -> Response {
    paged(page.items, page.total, page.has_more, page.cursor)
}

async fn projects(session: Session) -> Response {
    reply(projects_of(&session).await, "Failed to list projects")
}

async fn projects_of(session: &Session) -> Reply {
    let items = list_portal_projects(&session.db, &session.rows, session.contact_ids()).await?;
    Ok(all_rows(items))
}

async fn project(session: Session, Path(id): Path<String>) -> Response {
    reply(
        project_of(&session, &id).await,
        "Failed to load the project",
    )
}

async fn project_of(session: &Session, id: &str) -> Reply {
    let row = session.own_project(id)?;
    let data = get_portal_project(&session.db, row, session.contact_ids()).await?;
    Ok(Data(data).into_response())
}

/// The paged lists of a project's shared items.
#[derive(Clone, Copy)]
enum Shared {
    Reports,
    Files,
    Documents,
    Messages,
}

async fn shared_list(session: &Session, id: &str, query: Option<&str>, kind: Shared) -> Reply {
    let row = session.own_project(id)?;
    let (limit, cursor) = page_options(query);
    let cursor = cursor.as_deref();
    let project_id = row["id"].as_str().unwrap_or_default();
    let db = &session.db;
    let page = match kind {
        Shared::Reports => list_portal_reports(db, project_id, limit, cursor).await?,
        Shared::Files => list_portal_files(db, project_id, limit, cursor).await?,
        Shared::Documents => list_portal_documents(db, project_id, limit, cursor).await?,
        Shared::Messages => {
            list_portal_messages(db, project_id, session.contact_ids(), limit, cursor).await?
        }
    };
    Ok(page_response(page))
}

async fn reports(session: Session, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    reply(
        shared_list(&session, &id, query.as_deref(), Shared::Reports).await,
        "Failed to list reports",
    )
}

async fn files(session: Session, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    reply(
        shared_list(&session, &id, query.as_deref(), Shared::Files).await,
        "Failed to list files",
    )
}

async fn documents(
    session: Session,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    reply(
        shared_list(&session, &id, query.as_deref(), Shared::Documents).await,
        "Failed to list documents",
    )
}

async fn messages(session: Session, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    reply(
        shared_list(&session, &id, query.as_deref(), Shared::Messages).await,
        "Failed to list messages",
    )
}

// ── Downloads ───────────────────────────────────────────────────────────────

fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_bytes(text.as_bytes()).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// `workspaceOfKey(key)`: `workspaces/<id>/…`'s id.
fn workspace_of_key(key: &str) -> Option<&str> {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(id), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

/// `isWorkspaceObjectKey(key, clerkOrgId, workspaceId)`: a safe key under
/// `workspaces/<id>/` for one of the workspace's ids.
fn is_workspace_object_key(key: &str, ids: &[Option<&str>]) -> bool {
    is_safe_key(key) && workspace_of_key(key).is_some_and(|owner| ids.contains(&Some(owner)))
}

/// The bytes of a stored object as a download. The key is a client-supplied
/// column of the row, so it must be one of this workspace's own (TASK-620); it
/// is always an attachment, never rendered by the browser. `not_found` is the
/// resource and id of the 404 for a missing object.
async fn download(session: &Session, row: &Value, not_found: (&str, &str)) -> Reply {
    let buckets = &session.req.buckets;
    if buckets.private.is_none() && buckets.public.is_none() {
        return Err(ApiError::internal()
            .with_message("Storage is not configured")
            .into());
    }
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let key = text("fileKey")
        .or_else(|| text("storagePath"))
        .unwrap_or_default();
    let missing = || Refusal::not_found(not_found.0, not_found.1);
    let own_key = is_workspace_object_key(
        key,
        &[
            session.clerk_org_id.as_deref(),
            Some(session.workspace_id.as_str()),
        ],
    );
    if key.is_empty() || !own_key {
        return Err(missing());
    }
    let mut found = None;
    for bucket in [&buckets.private, &buckets.public].into_iter().flatten() {
        match bucket.get(key).await {
            Ok(Some(object)) => {
                found = Some(object);
                break;
            }
            Ok(None) => {}
            Err(error) => return Err(Refusal::Internal(error.to_string())),
        }
    }
    let Some(object) = found else {
        return Err(missing());
    };
    let content_type = text("mimeType")
        .map(str::to_owned)
        .or_else(|| object.info.content_type.clone().filter(|t| !t.is_empty()))
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let disposition = attachment_disposition(
        row.get("fileName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        row.get("id").and_then(Value::as_str).unwrap_or_default(),
    );
    let length = object.bytes.len().to_string();
    let mut response = (StatusCode::OK, object.bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, header_value(&content_type));
    headers.insert(CONTENT_LENGTH, header_value(&length));
    headers.insert(CONTENT_DISPOSITION, header_value(&disposition));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

async fn file_download(session: &Session, id: &str, file_id: &str) -> Reply {
    let project = session.own_project(id)?;
    let project_id = project["id"].as_str().unwrap_or_default();
    let Some(row) = find_portal_file(&session.db, project_id, file_id).await? else {
        return Err(Refusal::not_found("File", file_id));
    };
    download(session, &row, ("File content", file_id)).await
}

async fn download_file(session: Session, Path((id, file_id)): Path<(String, String)>) -> Response {
    reply(
        file_download(&session, &id, &file_id).await,
        "Failed to read the file",
    )
}

async fn document_download(session: &Session, id: &str, document_id: &str) -> Reply {
    let project = session.own_project(id)?;
    let project_id = project["id"].as_str().unwrap_or_default();
    let Some(row) = find_portal_document(&session.db, project_id, document_id).await? else {
        return Err(Refusal::not_found("Document", document_id));
    };
    download(session, &row, ("Document content", document_id)).await
}

async fn download_document(
    session: Session,
    Path((id, document_id)): Path<(String, String)>,
) -> Response {
    reply(
        document_download(&session, &id, &document_id).await,
        "Failed to read the document",
    )
}

// ── Messages ────────────────────────────────────────────────────────────────

async fn post_message(
    State(app): State<App>,
    session: Session,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    // The project (404) and the body (400) are checked outside the route's `try`.
    let project = match session.own_project(&id) {
        Ok(project) => project,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    let message = match parse_body(&body, read_post_message) {
        Ok(message) => message,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    reply(
        send_message(&app, &session, project, &message).await,
        "Failed to send the message",
    )
}

async fn send_message(app: &App, session: &Session, project: &Value, message: &str) -> Reply {
    let project_id = project["id"].as_str().unwrap_or_default();
    let contact_id = project["contactId"].as_str().unwrap_or_default();
    let contacts = contacts_of_session(&session.db, &[contact_id.to_owned()]).await?;
    let name = contacts
        .first()
        .map_or_else(|| session.record.email.clone(), |c| c.name.clone());
    let message_id = generate_id("pmsg");
    let created = now();
    let metadata = portal_message_metadata(contact_id, &name);
    // The thread is the project's chat (conversationId = projectId); a client's
    // message is client visible by definition and names its sender in `metadata`.
    sqlx::query(
        "insert into project_messages
           (id, project_id, conversation_id, sender_id, message, message_type, metadata,
            client_visible, is_read, created_at, updated_at)
         values ($1, $2, $2, $3, $4, 'text', $5::jsonb, true, false, $6::timestamp, $6::timestamp)",
    )
    .bind(&message_id)
    .bind(project_id)
    .bind(contact_id)
    .bind(message)
    .bind(metadata.to_string())
    .bind(&created)
    .execute(&session.db)
    .await?;
    session.publish(
        app,
        contact_id,
        vec![(
            PROJECT_MESSAGE_CREATED,
            message_id.clone(),
            json!({ "id": message_id, "projectId": project_id, "senderId": contact_id }),
        )],
    );
    let sent = present_message(
        &json!({
            "id": message_id,
            "projectId": project_id,
            "senderId": contact_id,
            "message": message,
            "metadata": metadata,
            "createdAt": created,
            "editedAt": null,
        }),
        &HashMap::new(),
        session.contact_ids(),
    );
    Ok(Created(sent).into_response())
}

// ── Approvals ───────────────────────────────────────────────────────────────

async fn approvals(session: Session) -> Response {
    reply(approvals_of(&session).await, "Failed to list approvals")
}

async fn approvals_of(session: &Session) -> Reply {
    let by_id = session.by_id();
    let ids: HashSet<String> = by_id.keys().cloned().collect();
    let reviews = pending_reviews(&session.db, session.contact_ids(), &ids).await?;
    let items = present_reviews(&session.db, &reviews, &by_id).await?;
    Ok(all_rows(items))
}

/// How the approvals core refuses an answer, as a response.
fn refusal(code: DecideRefusal, message: &str, id: &str) -> Refusal {
    match code {
        DecideRefusal::NotFound => Refusal::not_found("Approval", id),
        DecideRefusal::NotApprover => Refusal::forbidden(message),
        DecideRefusal::AlreadyDecided | DecideRefusal::StepNotActive => Refusal::conflict(message),
        DecideRefusal::InvalidDecision | DecideRefusal::NoteRequired => {
            Refusal::bad_request(message)
        }
    }
}

async fn decide(
    State(app): State<App>,
    session: Session,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    // Only a review addressed to one of the session's contacts, on a project
    // they may see. A failure before the route's `try` is the app's 500.
    let row = match find_review(&session, &id).await {
        Ok(row) => row,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    let (decision, note) = match parse_body(&body, read_decide) {
        Ok(parsed) => parsed,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    reply(
        answer(&app, &session, &row, &decision, note.as_deref()).await,
        "Failed to record the answer",
    )
}

/// The review `id` when it is addressed to one of the session's contacts, on a
/// project they may see, about a subject the portal shows; else a 404.
async fn find_review(session: &Session, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a
         where a.id = $1 and a.approver_kind = 'contact' and a.approver_id = any($2)
           and a.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(session.contact_ids())
    .fetch_optional(&session.db)
    .await?;
    let by_id = session.by_id();
    let row = row.map(weldsuite_db::js_row).filter(|row| {
        row.get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|project| by_id.contains_key(project))
            && is_portal_approval_subject(
                row.get("subjectType")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    row.ok_or_else(|| Refusal::not_found("Approval", id))
}

/// The answer, through the same service as `POST /api/approvals/{id}/decide`
/// (`decide_and_announce`) with the contact as the actor: the review's own
/// event, and, when it settled its subject, the subject's aftermath, are the
/// app's.
async fn answer(
    app: &App,
    session: &Session,
    row: &Value,
    decision: &str,
    note: Option<&str>,
) -> Reply {
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
    let Some(review) = ApprovalRow::from_json(row) else {
        return Err(Refusal::not_found("Approval", id));
    };
    let caller = session.contact_caller(&review.approver_id);
    let actor = ApprovalActor {
        kind: "contact".to_owned(),
        id: review.approver_id.clone(),
    };
    let decided = match decide_and_announce(
        &app.flow,
        &caller,
        &review,
        actor,
        decision,
        note.map(str::to_owned),
    )
    .await?
    {
        DecideApprovalResult::Decided(decided) => decided,
        DecideApprovalResult::Refused { code, message } => {
            return Err(refusal(code, message, id));
        }
    };

    let answered = &decided.approval;
    let timestamp = |ms: Option<i64>| {
        ms.and_then(weldsuite_flow_domain::js::iso_from_millis)
            .map_or(Value::Null, Value::String)
    };
    Ok(Data(json!({
        "id": answered.id,
        "decision": answered.decision,
        "note": answered.note,
        "decidedAt": timestamp(answered.decided_at),
        "outcome": decided.outcome.as_str(),
        "resolved": decided.resolved,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(value: &Value) -> Bytes {
        Bytes::from(value.to_string())
    }

    fn status(refusal: Refusal) -> StatusCode {
        match refusal {
            Refusal::Response(response) => response.status(),
            other => panic!("not a response: {other:?}"),
        }
    }

    #[test]
    fn the_bearer_token_is_read_like_the_worker_reads_it() {
        let mut headers = HeaderMap::new();
        assert_eq!(read_bearer(&headers), None);
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer  abc "));
        assert_eq!(read_bearer(&headers).as_deref(), Some("abc"));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("bearer xyz"));
        assert_eq!(read_bearer(&headers).as_deref(), Some("xyz"));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer "));
        assert_eq!(read_bearer(&headers), None);
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(read_bearer(&headers), None);
    }

    #[test]
    fn limits_fall_back_and_are_capped() {
        assert_eq!(page_options(None), (25, None));
        assert_eq!(page_options(Some("limit=abc")), (25, None));
        assert_eq!(page_options(Some("limit=0")), (25, None));
        assert_eq!(
            page_options(Some("limit=500&cursor=pf_1")),
            (100, Some("pf_1".into()))
        );
        assert_eq!(page_options(Some("limit=7&cursor=")), (7, None));
    }

    #[test]
    fn only_this_workspaces_objects_are_served() {
        let ids = [Some("org_1"), Some("ws_1")];
        assert!(is_workspace_object_key(
            "workspaces/org_1/projects/a.pdf",
            &ids
        ));
        assert!(is_workspace_object_key("workspaces/ws_1/a.pdf", &ids));
        assert!(!is_workspace_object_key("workspaces/org_2/a.pdf", &ids));
        assert!(!is_workspace_object_key(
            "workspaces/org_1/../org_2/a.pdf",
            &ids
        ));
        assert!(!is_workspace_object_key("k", &ids));
        assert!(!is_workspace_object_key("workspaces/org_1", &ids));
    }

    #[test]
    fn a_code_request_is_read_strictly() {
        let ok = parse_body(
            &bytes(&json!({"workspace":" Acme ","email":" Femke@Client.test ","locale":"nl"})),
            read_request_code,
        )
        .expect("valid");
        assert_eq!(ok.workspace, "Acme");
        assert_eq!(ok.email, "Femke@Client.test");
        assert_eq!(ok.locale.as_deref(), Some("nl"));
        for bad in [
            json!({"workspace":"acme","email":"not-an-email"}),
            json!({"workspace":"","email":"a@b.test"}),
            json!({"workspace":"acme","email":"a@b.test","locale":"de"}),
            json!({"workspace":"acme","email":"a@b.test","extra":1}),
            json!({"email":"a@b.test"}),
        ] {
            assert_eq!(
                status(
                    parse_body(&bytes(&bad), read_request_code)
                        .err()
                        .expect("refused")
                ),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            status(
                parse_body(&Bytes::from("nope"), read_request_code)
                    .err()
                    .expect("refused")
            ),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn a_code_is_six_digits() {
        let read = |code: &str| {
            parse_body(
                &bytes(&json!({"workspace":"acme","email":"a@b.test","code":code})),
                read_verify,
            )
        };
        assert_eq!(read(" 123456 ").expect("valid").code, "123456");
        assert!(read("12345").is_err());
        assert!(read("12345a").is_err());
        assert!(read("1234567").is_err());
    }

    #[test]
    fn messages_and_answers_are_read_strictly() {
        let message = |v: Value| parse_body(&bytes(&v), read_post_message);
        assert_eq!(
            message(json!({"message":"  Thanks! "})).expect("valid"),
            "Thanks!"
        );
        assert!(message(json!({"message":"  "})).is_err());
        assert!(message(json!({"message":"x".repeat(4001)})).is_err());
        assert!(message(json!({"message":"x","extra":true})).is_err());

        let decide = |v: Value| parse_body(&bytes(&v), read_decide);
        assert_eq!(
            decide(json!({"decision":"approved"})).expect("valid"),
            ("approved".to_owned(), None)
        );
        assert_eq!(
            decide(json!({"decision":"rejected","note":" too late "})).expect("valid"),
            ("rejected".to_owned(), Some("too late".to_owned()))
        );
        assert_eq!(
            decide(json!({"decision":"info_requested","note":null}))
                .expect("valid")
                .1,
            None
        );
        assert!(decide(json!({"decision":"approved_with_conditions"})).is_err());
        assert!(decide(json!({"note":"x"})).is_err());
    }

    #[test]
    fn records_the_worker_wrote_can_be_read() {
        let challenge: PortalChallenge = serde_json::from_str(
            r#"{"codeHash":"h","email":"femke@client.test","workspaceId":"ws","contactIds":["pe_femke"],"attempts":2}"#,
        )
        .expect("challenge");
        assert_eq!(challenge.attempts, 2);
        let session: PortalSessionRecord = serde_json::from_str(
            r#"{"workspaceId":"ws","clerkOrgId":null,"workspaceSlug":"acme","workspaceName":"Acme","email":"a@b.c","contactIds":["pe_1"],"createdAt":"2026-11-01T08:00:00.000Z","lastSeenAt":"2026-11-01T08:00:00.000Z"}"#,
        )
        .expect("session");
        assert_eq!(session.clerk_org_id, None);
    }
}
