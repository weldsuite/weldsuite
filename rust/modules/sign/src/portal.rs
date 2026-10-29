//! The signer portal's operations over HTTP (ADR FE-017): on Kubernetes
//! `apps/web/sign-portal` calls these instead of running
//! `createSignPortal()` (`packages/domains/sign/src/portal.ts`) itself.
//! Same operations, same answers (status, JSON body or PDF bytes, and the
//! headers the portal passes on); the portal's client is
//! `packages/domains/sign/src/portal-client.ts`.
//!
//! ```text
//! POST /session      { token }          → ready (session) | code_required | closed; 404 unknown link
//! POST /verify       { token, code }    → ready; 400 INVALID_CODE, 429 LOCKED
//! POST /resend-code  { token }          → a new emailed code; 429 when asked too often
//! GET  /envelope                        → what this signer sees
//! GET  /documents/:documentId           → the PDF with earlier signers' values drawn in
//! POST /consent      { disclosureVersion }
//! POST /complete     { values, signature, initials, timeZone }
//!                                       → 503 when the last signature could not start finalizing
//! POST /decline      { reason }
//! GET  /download                        → the signed PDF (completed requests)
//! ```
//!
//! Outside the member pipeline, like every `/public` route. Only the portal
//! may call: each request carries `SIGN_PORTAL_SECRET` in
//! `X-Sign-Portal-Key` (403 without it, 503 when the backend has none).
//! With the key, `X-Signer-Ip` is the signer's address for the evidence
//! trail (none without it: the caller is the portal, so the address the
//! backend sees is the portal's, not the signer's), and `User-Agent` their
//! browser. The signer session (from `/session` or `/verify`) travels as
//! `Authorization: Bearer <session>`.

mod codes;
mod session;

use std::sync::Arc;

use aws_lc_rs::constant_time;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, OriginalUri, Path, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, USER_AGENT,
    X_CONTENT_TYPE_OPTIONS,
};
use http::request::Parts;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{SIGN_ENVELOPE_DECLINED, SIGN_ENVELOPE_SIGNED};
use weldsuite_db::{MasterDb, Workspaces};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_ports::{BoxFuture, DynCache, DynFileStore, DynJobs, FileStores, Jobs, MemoryCache};

use crate::finalize::{FinalizeJob, FinalizeParams, TenantRef, TenantResolver, finalize_request};
use crate::hash::code_hash;
use crate::links::{ResolvedLink, resolve_link, resolve_link_by_hash, revoke_envelope_links};
use crate::mail::{pdf_file_name, send_code, send_declined, workspace_brand};
use crate::sending::{Advance, advance_after_signing};
use crate::signing::{
    CompleteContext, PortalBrand, Signature, SignerMeta, SignerRef, Submission, closed_reason,
    complete_signing, decline_signing, load_signer, mark_opened, now_ms, portal_mode, portal_view,
    record_code_check, record_consent, signer_document,
};
use crate::{SendContext, Services, SignError, SignResult, SignState, text};

use self::codes::{
    CodeCheck, check_code, email_code_hash, email_hint, is_locked, issue_email_code, new_email_code,
};
use self::session::{SignerSession, sign_session, verify_session};

/// Header carrying the shared portal secret.
pub const SIGN_PORTAL_KEY_HEADER: &str = "x-sign-portal-key";
/// Header carrying the signer's IP; trusted only next to the key.
pub const SIGNER_IP_HEADER: &str = "x-signer-ip";

/// The portal's handle on the app.
#[derive(Clone)]
pub struct PortalState {
    sign: SignState,
    /// Resolves a link's workspace (Clerk org id) to its tenant database.
    workspaces: Option<Arc<Workspaces>>,
    /// `SIGN_PORTAL_SECRET`: the key only the portal has.
    portal_secret: Option<Arc<str>>,
    /// Where codes live without Valkey: this replica's memory, enough for a
    /// single replica.
    local_cache: Arc<MemoryCache>,
}

impl PortalState {
    pub fn new(
        sign: SignState,
        workspaces: Option<Arc<Workspaces>>,
        portal_secret: Option<Arc<str>>,
    ) -> Self {
        Self {
            sign,
            workspaces,
            portal_secret,
            local_cache: Arc::default(),
        }
    }
}

impl std::fmt::Debug for PortalState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortalState")
            .field("sign", &self.sign)
            .field("workspaces", &self.workspaces.is_some())
            .field("portal_secret", &self.portal_secret.is_some())
            .finish_non_exhaustive()
    }
}

/// Per-request stand-ins for the portal's services, which conformance
/// builds insert from the test's context: every link opens the test's tenant
/// database, codes live in the test's KV namespace, and finalizing starts
/// through the test's Workflow binding (`None`: there is none, so it runs
/// in the request's background work, as the workers do without one).
#[derive(Clone, Default)]
pub struct PortalOverrides {
    /// The tenant database and `workspaces.id` every link resolves to.
    pub tenant: Option<(PgPool, String)>,
    pub cache: Option<Arc<dyn DynCache>>,
    pub jobs: Option<Arc<dyn DynJobs>>,
}

/// `/public/sign-portal`, outside the member pipeline.
pub fn portal_router<S>(state: PortalState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/session", post(open_session))
        .route("/verify", post(verify))
        .route("/resend-code", post(resend_code))
        .route("/envelope", get(envelope))
        .route("/documents/{document_id}", get(document))
        .route("/consent", post(consent))
        .route("/complete", post(complete))
        .route("/decline", post(decline))
        .route("/download", get(download))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_portal_key,
        ))
        .with_state(state)
}

async fn not_found(OriginalUri(uri): OriginalUri) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{} not found", uri.path()),
    )
}

/// A value of `env`: the request's (conformance), else the process's.
fn env_value(
    request_env: Option<&RequestEnv>,
    name: &str,
    fallback: Option<&Arc<str>>,
) -> Option<String> {
    request_env
        .and_then(|env| env.get(name))
        .map(str::to_owned)
        .or_else(|| fallback.map(ToString::to_string))
        .filter(|value| !value.is_empty())
}

/// Only the portal may call: 503 when this backend has no
/// `SIGN_PORTAL_SECRET` (no key can be right), 403 for a missing or wrong
/// key. 401 stays the signer session's answer, so the portal can tell the
/// two apart.
async fn require_portal_key(
    State(state): State<PortalState>,
    request: Request,
    next: Next,
) -> Response {
    let secret = env_value(
        request.extensions().get::<RequestEnv>(),
        "SIGN_PORTAL_SECRET",
        state.portal_secret.as_ref(),
    );
    let Some(secret) = secret else {
        tracing::error!("sign portal: SIGN_PORTAL_SECRET is not set; refusing the portal's calls");
        return ApiError::unavailable("The signer portal is not configured").into_response();
    };
    let valid = request
        .headers()
        .get(SIGN_PORTAL_KEY_HEADER)
        .is_some_and(|key| {
            constant_time::verify_slices_are_equal(key.as_bytes(), secret.as_bytes()).is_ok()
        });
    if !valid {
        return ApiError::forbidden().into_response();
    }
    next.run(request).await
}

/// What `forwardedClientIp` lets through: an IPv4 or IPv6 address.
fn looks_like_ip(value: &str) -> bool {
    (2..=45).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'.' || b == b':')
}

/// The signer's IP the portal reported (`X-Signer-Ip`), trusted because the
/// key was checked first (`require_portal_key`). `None` without one, or for
/// anything that is no address, as TypeScript records `null` without an IP:
/// never the connection's address, which is the portal's own.
fn signer_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SIGNER_IP_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| looks_like_ip(value))
        .map(str::to_owned)
}

/// `request.headers.get('user-agent')?.slice(0, 500)`: 500 UTF-16 units.
fn user_agent(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(USER_AGENT)?;
    let text = String::from_utf8_lossy(value.as_bytes());
    let mut units = 0;
    let cut: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 500
        })
        .collect();
    Some(cut)
}

/// One portal call: who is asking, and the services it reaches (the
/// request's stand-ins first).
struct Portal {
    state: PortalState,
    master: Option<PgPool>,
    env: Option<RequestEnv>,
    files: Option<FileStores>,
    overrides: Option<PortalOverrides>,
    meta: SignerMeta,
    /// The bearer token.
    session: Option<String>,
}

impl FromRequestParts<PortalState> for Portal {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &PortalState,
    ) -> impl Future<Output = Result<Self, ApiError>> + Send {
        let session = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_owned);
        std::future::ready(Ok(Self {
            state: state.clone(),
            master: parts
                .extensions
                .get::<MasterDb>()
                .map(|master| master.0.clone())
                .or_else(|| state.sign.master.clone()),
            env: parts.extensions.get::<RequestEnv>().cloned(),
            files: parts.extensions.get::<FileStores>().cloned(),
            overrides: parts.extensions.get::<PortalOverrides>().cloned(),
            meta: SignerMeta {
                ip: signer_ip(&parts.headers),
                user_agent: user_agent(&parts.headers),
            },
            session,
        }))
    }
}

/// A workspace a link points at (`PortalWorkspace`).
struct Workspace {
    /// `workspaces.id`.
    id: String,
    db: PgPool,
    suspended: bool,
}

/// What [`Portal::open`] found (`Opened`).
struct Opened {
    link: ResolvedLink,
    workspace: Workspace,
    signer: SignerRef,
}

/// A valid session and its workspace (`Signer`).
struct Signer {
    session: SignerSession,
    workspace: Workspace,
}

// ── Responses ──────────────────────────────────────────────────────────────

fn ok(data: Value) -> Response {
    let mut body = Map::new();
    body.insert("data".to_owned(), data);
    axum::Json(Value::Object(body)).into_response()
}

fn fail(status: StatusCode, code: &'static str, message: &str) -> ApiError {
    ApiError::new(status, code, message)
}

fn unconfigured() -> Response {
    ApiError::unavailable("Signing is not configured").into_response()
}

fn locked() -> Response {
    fail(
        StatusCode::TOO_MANY_REQUESTS,
        "LOCKED",
        "Too many wrong codes. Try again later.",
    )
    .into_response()
}

fn expired_session() -> Response {
    ApiError::unauthorized()
        .with_message("Your session has expired. Open the link again.")
        .into_response()
}

/// `fail(400, 'BAD_REQUEST', 'Invalid request', error.flatten())`.
fn invalid_request(details: &Value) -> ApiError {
    ApiError::bad_request("Invalid request").with_details(details)
}

/// `parse(schema, input)`: the body read by `read`, or the 400. A missing or
/// unreadable body is `undefined` to Zod ("Required").
fn parse<T>(
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, ApiError> {
    let value: Option<Value> = if body.is_empty() {
        None
    } else {
        serde_json::from_slice(body).ok()
    };
    let Some(value) = value else {
        return Err(invalid_request(
            &json!({ "formErrors": ["Required"], "fieldErrors": {} }),
        ));
    };
    let mut issues = Issues::default();
    let read = issues
        .object(&value)
        .map(|fields| read(&mut issues, fields));
    match (issues.finish(), read) {
        (Err(invalid), _) => Err(invalid_request(&invalid.flatten())),
        (Ok(()), Some(read)) => Ok(read),
        (Ok(()), None) => Err(ApiError::internal()),
    }
}

/// `portalSessionSchema`: `{ token }`.
fn read_token(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "token", Presence::Required, Some(20), Some(200))
        .into_option()
        .unwrap_or_default()
}

/// The PDF headers both runtimes send (`PDF_HEADERS`).
fn pdf(bytes: Vec<u8>, disposition: Option<HeaderValue>) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(disposition) = disposition {
        headers.insert(CONTENT_DISPOSITION, disposition);
    }
    response
}

/// Every link resolves to one tenant database (conformance).
struct FixedTenant {
    db: PgPool,
    workspace_id: String,
}

impl TenantResolver for FixedTenant {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<TenantRef, String>> {
        Box::pin(std::future::ready(Ok(TenantRef {
            db: self.db.clone(),
            workspace_id: self.workspace_id.clone(),
            clerk_org_id: Some(reference.to_owned()),
        })))
    }
}

impl Portal {
    /// `ctx.env.SIGN_SESSION_SECRET`.
    fn session_secret(&self) -> Option<String> {
        env_value(
            self.env.as_ref(),
            "SIGN_SESSION_SECRET",
            self.state.sign.session_secret.as_ref(),
        )
    }

    fn master(&self) -> SignResult<PgPool> {
        self.master
            .clone()
            .ok_or_else(|| SignError::Internal("sign portal: no master database".to_owned()))
    }

    /// Where codes and wrong answers are kept (`WORKSPACE_CACHE`).
    fn codes(&self) -> Arc<dyn DynCache> {
        self.overrides
            .as_ref()
            .and_then(|o| o.cache.clone())
            .or_else(|| self.state.sign.cache.clone())
            .unwrap_or_else(|| self.state.local_cache.clone())
    }

    fn files(&self) -> SignResult<FileStores> {
        self.files
            .clone()
            .or_else(|| self.state.sign.files.clone())
            .ok_or_else(|| SignError::Internal("sign portal: no file storage".to_owned()))
    }

    fn private_bucket(&self) -> SignResult<Arc<dyn DynFileStore>> {
        Ok(self.files()?.private)
    }

    /// The services the domain code reaches (`ctx.env`).
    fn services(&self) -> Services {
        let state = &self.state.sign;
        Services {
            events: state.events.clone(),
            files: self.files.clone().or_else(|| state.files.clone()),
            mail: state.mail.clone(),
            cache: state.cache.clone(),
            flags: Arc::clone(&state.flags),
            portal_url: env_value(
                self.env.as_ref(),
                "SIGN_PORTAL_URL",
                state.portal_url.as_ref(),
            ),
            environment: env_value(self.env.as_ref(), "ENVIRONMENT", state.environment.as_ref()),
        }
    }

    fn send_context(&self, workspace: &Workspace, clerk_org_id: &str) -> SignResult<SendContext> {
        Ok(SendContext {
            db: workspace.db.clone(),
            master: self.master()?,
            clerk_org_id: clerk_org_id.to_owned(),
            workspace_id: workspace.id.clone(),
            services: self.services(),
        })
    }

    /// `deps.workspace(env, clerkOrgId)`.
    async fn workspace(&self, clerk_org_id: &str) -> Result<Workspace, String> {
        if let Some((db, id)) = self.overrides.as_ref().and_then(|o| o.tenant.clone()) {
            return Ok(Workspace {
                id,
                db,
                suspended: false,
            });
        }
        let workspaces = self
            .state
            .workspaces
            .as_ref()
            .ok_or_else(|| "sign portal: no workspaces".to_owned())?;
        let tenant = workspaces
            .tenant(clerk_org_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Workspace {
            id: tenant.workspace_id,
            db: tenant.db,
            suspended: tenant.suspended,
        })
    }

    /// `open`: the workspace and signer a link points at; `None` for
    /// anything a signer must not learn more about.
    async fn open(&self, token: &str) -> SignResult<Option<Opened>> {
        let Some(link) =
            resolve_link(&self.master()?, token, time::OffsetDateTime::now_utc()).await?
        else {
            return Ok(None);
        };
        let Ok(workspace) = self.workspace(&link.clerk_org_id).await else {
            return Ok(None);
        };
        if workspace.suspended {
            return Ok(None);
        }
        match load_signer(&workspace.db, &link.envelope_id, &link.recipient_id).await {
            Ok(signer) => Ok(Some(Opened {
                link,
                workspace,
                signer,
            })),
            Err(SignError::NotFound(_) | SignError::Conflict(_) | SignError::Invalid(_)) => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Where finalizing starts: the jobs adapter, or, without one, the
    /// request's background work.
    fn jobs(&self) -> Option<Arc<dyn DynJobs>> {
        match &self.overrides {
            Some(overrides) => overrides.jobs.clone(),
            None => self.state.sign.jobs.clone(),
        }
    }

    /// `startFinalizing`: start the job that builds the signed PDF. One run
    /// per request; a run still going or done is left alone, a failed one is
    /// started again. `Err` when it could not start.
    async fn start_finalizing(
        &self,
        workspace: &Workspace,
        params: &FinalizeParams,
    ) -> Result<(), String> {
        if let Some(jobs) = self.jobs() {
            let request = crate::finalize::start_finalize(params).map_err(|e| e.to_string())?;
            return jobs.start(request).await.map_err(|e| e.to_string());
        }
        let job = FinalizeJob {
            tenants: Arc::new(FixedTenant {
                db: workspace.db.clone(),
                workspace_id: workspace.id.clone(),
            }),
            master: self.master().map_err(|e| format!("{e:?}"))?,
            services: self.services(),
        };
        let params = params.clone();
        self.state.sign.events.tracker().spawn(async move {
            if let Err(error) = finalize_request(&job, &params).await {
                tracing::error!(%error, envelope_id = params.envelope_id, "sign portal: finalizing failed");
            }
        });
        Ok(())
    }

    /// `ready`: the signer is in; their session.
    async fn ready(&self, opened: Opened) -> SignResult<Response> {
        let Opened {
            link,
            workspace,
            signer,
        } = opened;
        mark_opened(&workspace.db, &signer, &self.meta).await?;
        // Everyone signed but finalizing never got going: reopening any
        // link of the request starts it again.
        if crate::sending::awaiting_finalize(&workspace.db, &signer.envelope).await? {
            let params = FinalizeParams {
                clerk_org_id: link.clerk_org_id.clone(),
                workspace_id: workspace.id.clone(),
                envelope_id: link.envelope_id.clone(),
            };
            let this = self.clone_for_background();
            let workspace = Workspace {
                id: workspace.id.clone(),
                db: workspace.db.clone(),
                suspended: false,
            };
            self.state.sign.events.tracker().spawn(async move {
                if let Err(error) = this.start_finalizing(&workspace, &params).await {
                    tracing::error!(
                        error,
                        envelope_id = params.envelope_id,
                        "sign portal: could not start finalizing"
                    );
                }
            });
        }
        let secret = self.session_secret().unwrap_or_default();
        let session = SignerSession {
            org_id: link.clerk_org_id,
            envelope_id: link.envelope_id,
            recipient_id: link.recipient_id,
            token_hash: link.token_hash,
        };
        let now = now_ms();
        let (token, exp) = sign_session(
            &secret,
            &session,
            i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0),
        );
        let expires_at =
            time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(exp) * 1_000_000)
                .map(weldsuite_events::iso_timestamp)
                .unwrap_or_default();
        Ok(ok(
            json!({ "state": "ready", "session": token, "expiresAt": expires_at }),
        ))
    }

    fn clone_for_background(&self) -> Self {
        Self {
            state: self.state.clone(),
            master: self.master.clone(),
            env: self.env.clone(),
            files: self.files.clone(),
            overrides: self.overrides.clone(),
            meta: self.meta.clone(),
            session: None,
        }
    }

    /// `withSigner`: runs `run` for a valid signer session; 503 without the
    /// secret, 401 for a bad or expired session or a link no longer live.
    async fn with_signer<F, Fut>(&self, run: F) -> Response
    where
        F: FnOnce(Signer) -> Fut,
        Fut: Future<Output = SignResult<Response>>,
    {
        let Some(secret) = self.session_secret() else {
            return unconfigured();
        };
        let now = now_ms();
        let session = self.session.as_deref().and_then(|token| {
            verify_session(
                &secret,
                token,
                i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0),
            )
        });
        let Some(session) = session else {
            return expired_session();
        };
        let result = async {
            // A session lasts only as long as its link: a corrected email,
            // void or decline revokes the link.
            let link = resolve_link_by_hash(
                &self.master()?,
                &session.token_hash,
                time::OffsetDateTime::now_utc(),
            )
            .await?;
            let live = link.is_some_and(|link| {
                link.envelope_id == session.envelope_id
                    && link.recipient_id == session.recipient_id
                    && link.clerk_org_id == session.org_id
            });
            if !live {
                return Ok(expired_session());
            }
            let Ok(workspace) = self.workspace(&session.org_id).await else {
                return Ok(ApiError::not_found("Envelope", None).into_response());
            };
            if workspace.suspended {
                return Ok(ApiError::not_found("Envelope", None).into_response());
            }
            run(Signer { session, workspace }).await
        }
        .await;
        result.unwrap_or_else(SignError::respond)
    }

    /// `current`: the signer as they stand now.
    async fn current(signer: &Signer) -> SignResult<SignerRef> {
        load_signer(
            &signer.workspace.db,
            &signer.session.envelope_id,
            &signer.session.recipient_id,
        )
        .await
    }

    /// `view`: what the signer sees, branded.
    async fn view(&self, signer: &Signer, current: &SignerRef) -> SignResult<Value> {
        let db = &signer.workspace.db;
        let brand: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "select brand_name, brand_color, brand_logo_url from sign_settings limit 1",
        )
        .fetch_optional(db)
        .await?;
        let (name, color, logo_url) = brand.unwrap_or_default();
        // `brand.name ?? workspaceBrand(…).name`.
        let name = if let Some(name) = name {
            name
        } else {
            let ctx = self.send_context(&signer.workspace, &signer.session.org_id)?;
            workspace_brand(&ctx).await?.1
        };
        portal_view(
            db,
            current,
            PortalBrand {
                name,
                color,
                logo_url,
            },
        )
        .await
    }

    /// `finish`: after the last signature, start finalizing. When it cannot
    /// start, the signer hears so (503) while their signature stays saved,
    /// and finishing again retries the start.
    async fn finish(&self, signer: &Signer, params: &FinalizeParams) -> SignResult<Response> {
        if let Err(error) = self.start_finalizing(&signer.workspace, params).await {
            tracing::error!(
                error,
                envelope_id = params.envelope_id,
                "sign portal: could not start finalizing"
            );
            return Ok(ApiError::unavailable(
                "Your signature is saved, but the request could not be completed yet. Try again in a moment.",
            )
            .into_response());
        }
        let current = Self::current(signer).await?;
        Ok(ok(self.view(signer, &current).await?))
    }

    /// `sendCode` with this link's workspace.
    async fn mail_code(&self, opened: &Opened, code: &str) -> SignResult<()> {
        let ctx = self.send_context(&opened.workspace, &opened.link.clerk_org_id)?;
        send_code(
            &ctx,
            &opened.signer.envelope,
            &opened.signer.recipient,
            code,
            codes::CODE_TTL_SECONDS / 60,
        )
        .await
    }
}

// ── Handlers ───────────────────────────────────────────────────────────────

/// `POST /session` (`openSession`).
async fn open_session(portal: Portal, body: Bytes) -> Response {
    let Some(secret) = portal.session_secret() else {
        return unconfigured();
    };
    let token = match parse(&body, read_token) {
        Ok(token) => token,
        Err(invalid) => return invalid.into_response(),
    };
    let result = async {
        let Some(opened) = portal.open(&token).await? else {
            return Ok(ApiError::not_found("Signing link", None).into_response());
        };
        if let Some(reason) = closed_reason(&opened.signer.envelope, now_ms()) {
            return Ok(ok(json!({ "state": "closed", "reason": reason })));
        }
        let recipient = &opened.signer.recipient;
        let auth_mode = text(recipient, "authMode").to_owned();
        if auth_mode == "link" || recipient["role"] == "cc" {
            return portal.ready(opened).await;
        }
        let codes = portal.codes();
        if is_locked(codes.as_ref(), &opened.link.token_hash).await? {
            return Ok(locked());
        }
        if auth_mode == "email_code" {
            let code = new_email_code();
            let hash = code_hash(&secret, text(recipient, "id"), &code);
            if issue_email_code(codes.as_ref(), &opened.link.token_hash, &hash).await? {
                portal.mail_code(&opened, &code).await?;
            }
        }
        let email_code = auth_mode == "email_code";
        Ok(ok(json!({
            "state": "code_required",
            "method": if email_code { "email_code" } else { "access_code" },
            "emailHint": if email_code { email_hint(recipient["email"].as_str()) } else { None },
        })))
    }
    .await;
    result.unwrap_or_else(SignError::respond)
}

/// `POST /verify` (`verify`).
async fn verify(portal: Portal, body: Bytes) -> Response {
    let Some(secret) = portal.session_secret() else {
        return unconfigured();
    };
    // `portalVerifySchema`: `{ token, code }`, the code trimmed.
    let read = parse(&body, |issues, body| {
        let token = read_token(issues, body);
        let code = issues
            .text_with(
                body,
                "code",
                Presence::Required,
                Text::trimmed(Some(4), Some(64)),
            )
            .into_option()
            .unwrap_or_default();
        (token, code)
    });
    let (token, code) = match read {
        Ok(read) => read,
        Err(invalid) => return invalid.into_response(),
    };
    let result = async {
        let Some(opened) = portal.open(&token).await? else {
            return Ok(ApiError::not_found("Signing link", None).into_response());
        };
        if let Some(reason) = closed_reason(&opened.signer.envelope, now_ms()) {
            return Ok(ok(json!({ "state": "closed", "reason": reason })));
        }
        let recipient = &opened.signer.recipient;
        if recipient["authMode"] == "link" {
            return portal.ready(opened).await;
        }
        let codes = portal.codes();
        let token_hash = &opened.link.token_hash;
        let expected = if recipient["authMode"] == "email_code" {
            email_code_hash(codes.as_ref(), token_hash).await?
        } else {
            recipient["accessCodeHash"].as_str().map(str::to_owned)
        };
        let answer = code_hash(&secret, text(recipient, "id"), &code);
        let check = check_code(codes.as_ref(), token_hash, expected.as_deref(), &answer).await?;
        record_code_check(
            &opened.workspace.db,
            &opened.signer,
            check == CodeCheck::Passed,
            &portal.meta,
        )
        .await?;
        match check {
            CodeCheck::Passed => portal.ready(opened).await,
            CodeCheck::Failed { locked: true, .. } => Ok(locked()),
            CodeCheck::Failed { attempts_left, .. } => Ok(fail(
                StatusCode::BAD_REQUEST,
                "INVALID_CODE",
                "That code is not correct",
            )
            .with_details(json!({ "attemptsLeft": attempts_left }))
            .into_response()),
        }
    }
    .await;
    result.unwrap_or_else(SignError::respond)
}

/// `POST /resend-code` (`resendCode`).
async fn resend_code(portal: Portal, body: Bytes) -> Response {
    let Some(secret) = portal.session_secret() else {
        return unconfigured();
    };
    let token = match parse(&body, read_token) {
        Ok(token) => token,
        Err(invalid) => return invalid.into_response(),
    };
    let result = async {
        let Some(opened) = portal.open(&token).await? else {
            return Ok(ApiError::not_found("Signing link", None).into_response());
        };
        let recipient = &opened.signer.recipient;
        if recipient["authMode"] != "email_code"
            || closed_reason(&opened.signer.envelope, now_ms()).is_some()
        {
            return Ok(ApiError::conflict("No code to send").into_response());
        }
        let codes = portal.codes();
        if is_locked(codes.as_ref(), &opened.link.token_hash).await? {
            return Ok(locked());
        }
        let code = new_email_code();
        let hash = code_hash(&secret, text(recipient, "id"), &code);
        if !issue_email_code(codes.as_ref(), &opened.link.token_hash, &hash).await? {
            return Ok(fail(
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_SOON",
                "A code was sent a moment ago",
            )
            .into_response());
        }
        portal.mail_code(&opened, &code).await?;
        Ok(ok(json!({ "sent": true })))
    }
    .await;
    result.unwrap_or_else(SignError::respond)
}

/// `GET /envelope` (`envelope`).
async fn envelope(portal: Portal) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let current = Portal::current(&signer).await?;
            Ok(ok(portal.view(&signer, &current).await?))
        })
        .await
}

/// `GET /documents/:documentId` (`document`).
async fn document(portal: Portal, Path(document_id): Path<String>) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let current = Portal::current(&signer).await?;
            if portal_mode(&current.envelope, &current.recipient, now_ms()) == "closed" {
                return Err(SignError::Conflict("This request is closed".to_owned()));
            }
            let bucket = portal.private_bucket()?;
            let bytes = signer_document(
                &signer.workspace.db,
                bucket.as_ref(),
                text(&current.envelope, "id"),
                &document_id,
            )
            .await?;
            Ok(pdf(bytes, None))
        })
        .await
}

/// `POST /consent` (`consent`).
async fn consent(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            // `portalConsentSchema`.
            let version = match parse(&body, |issues, body| {
                issues
                    .text(
                        body,
                        "disclosureVersion",
                        Presence::Required,
                        Some(1),
                        Some(40),
                    )
                    .into_option()
                    .unwrap_or_default()
            }) {
                Ok(version) => version,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let current = Portal::current(&signer).await?;
            record_consent(&signer.workspace.db, &current, &version, &portal.meta).await?;
            Ok(ok(json!({ "consented": true })))
        })
        .await
}

/// `portalSignatureSchema` at `key`, `.nullish()`.
fn read_signature(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<Signature> {
    issues
        .nested(body, key, Presence::Nullish, |issues, fields| {
            let kind = issues.choice(
                fields,
                "kind",
                Presence::Required,
                &["drawn", "typed", "uploaded"],
            );
            // `z.string().max(700_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)`.
            let image = issues.pattern(
                fields,
                "image",
                Presence::Required,
                None,
                Some(700_000),
                |text| {
                    text.strip_prefix("data:image/png;base64,")
                        .is_some_and(|data| {
                            !data.is_empty()
                                && data.bytes().all(|b| {
                                    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')
                                })
                        })
                },
                "Expected a PNG data URL",
            );
            match (kind.into_option(), image.into_option()) {
                (Some(kind), Some(image)) => Some(Signature { kind, image }),
                _ => None,
            }
        })
        .into_option()
        .flatten()
}

/// `portalCompleteSchema`.
fn read_submission(issues: &mut Issues, body: &Map<String, Value>) -> Submission {
    let values = issues
        .list(
            body,
            "values",
            Presence::Required,
            None,
            Some(1000),
            |issues, item| {
                let fields = issues.object(item)?;
                let field_id =
                    issues.text(fields, "fieldId", Presence::Required, Some(1), Some(30));
                let value = issues.text(fields, "value", Presence::Required, None, Some(1000));
                Some((field_id.into_option()?, value.into_option()?))
            },
        )
        .into_option()
        .unwrap_or_default();
    let signature = read_signature(issues, body, "signature");
    let initials = read_signature(issues, body, "initials");
    let time_zone = issues
        .text(body, "timeZone", Presence::Nullish, None, Some(64))
        .into_option();
    Submission {
        values,
        signature,
        initials,
        time_zone,
    }
}

/// `POST /complete` (`complete`).
async fn complete(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let input = match parse(&body, read_submission) {
                Ok(input) => input,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let org_id = signer.session.org_id.clone();
            let db = signer.workspace.db.clone();
            let current = Portal::current(&signer).await?;
            let envelope_id = text(&current.envelope, "id").to_owned();
            let params = FinalizeParams {
                clerk_org_id: org_id.clone(),
                workspace_id: signer.workspace.id.clone(),
                envelope_id: envelope_id.clone(),
            };
            // A retry after finalizing could not start: the signature is already saved.
            if current.recipient["status"] == "signed"
                && crate::sending::awaiting_finalize(&db, &current.envelope).await?
            {
                return portal.finish(&signer, &params).await;
            }
            let bucket = portal.private_bucket()?;
            complete_signing(
                &CompleteContext {
                    db: &db,
                    bucket: bucket.as_ref(),
                    workspace_id: &org_id,
                    meta: &portal.meta,
                },
                &current,
                &input,
            )
            .await?;
            let envelope = &current.envelope;
            portal.state.sign.events.publish(
                &EventContext::new(&org_id, "system", EventSource::Api),
                EntityEvent::new(
                    SIGN_ENVELOPE_SIGNED,
                    &envelope_id,
                    json!({ "id": envelope["id"], "title": envelope["title"], "status": envelope["status"] }),
                ),
            );
            let ctx = portal.send_context(&signer.workspace, &org_id)?;
            if advance_after_signing(&ctx, envelope).await? == Advance::AllSigned {
                return portal.finish(&signer, &params).await;
            }
            let current = Portal::current(&signer).await?;
            Ok(ok(portal.view(&signer, &current).await?))
        })
        .await
}

/// `POST /decline` (`decline`).
async fn decline(portal: Portal, body: Bytes) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            // `portalDeclineSchema`: `{ reason }`, trimmed.
            let reason = match parse(&body, |issues, body| {
                issues
                    .text_with(
                        body,
                        "reason",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(1000)),
                    )
                    .into_option()
                    .unwrap_or_default()
            }) {
                Ok(reason) => reason,
                Err(invalid) => return Ok(invalid.into_response()),
            };
            let org_id = signer.session.org_id.clone();
            let current = Portal::current(&signer).await?;
            decline_signing(&signer.workspace.db, &current, &reason, &portal.meta).await?;
            let envelope_id = text(&current.envelope, "id").to_owned();
            revoke_envelope_links(&portal.master()?, &signer.workspace.id, &envelope_id).await?;
            // The sender hears about it, and the event goes out, after the answer.
            let ctx = portal.send_context(&signer.workspace, &org_id)?;
            let envelope = current.envelope.clone();
            let recipient = &current.recipient;
            let declined_by = crate::or_else(&recipient["name"], &recipient["email"])
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let events = portal.state.sign.events.clone();
            let title = envelope["title"].clone();
            portal.state.sign.events.tracker().spawn(async move {
                send_declined(&ctx, &envelope, &declined_by, &reason).await;
                events.publish(
                    &EventContext::new(&org_id, "system", EventSource::Api),
                    EntityEvent::new(
                        SIGN_ENVELOPE_DECLINED,
                        &envelope_id,
                        json!({ "id": envelope_id, "title": title, "status": "declined" }),
                    ),
                );
            });
            let current = Portal::current(&signer).await?;
            Ok(ok(portal.view(&signer, &current).await?))
        })
        .await
}

/// `GET /download` (`download`).
async fn download(portal: Portal) -> Response {
    let portal = &portal;
    portal
        .with_signer(|signer| async move {
            let current = Portal::current(&signer).await?;
            let envelope = &current.envelope;
            let key = text(envelope, "finalStorageKey");
            if envelope["status"] != "completed" || key.is_empty() {
                return Err(SignError::Conflict(
                    "Not everyone has signed yet".to_owned(),
                ));
            }
            let bucket = portal.private_bucket()?;
            let object = bucket
                .get_boxed(key)
                .await
                .map_err(|error| SignError::Internal(error.to_string()))?;
            let Some(object) = object else {
                return Ok(
                    ApiError::not_found("Signed document", Some(text(envelope, "id")))
                        .into_response(),
                );
            };
            let filename = pdf_file_name(text(envelope, "title")).replace('"', "");
            let disposition =
                HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
                    .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
            Ok(pdf(object.bytes, Some(disposition)))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_addresses_pass_as_the_signer_ip() {
        assert!(looks_like_ip("203.0.113.9"));
        assert!(looks_like_ip("2001:db8::1"));
        assert!(!looks_like_ip("1"));
        assert!(!looks_like_ip("203.0.113.9, 10.0.0.1"));
        assert!(!looks_like_ip("evil<script>"));
    }

    /// No usable `X-Signer-Ip`: no IP at all, never the connection's address.
    #[tokio::test]
    async fn without_the_header_the_signer_has_no_ip() {
        let ip = async |header: Option<&str>| {
            let mut request = http::Request::builder().uri("/envelope");
            if let Some(header) = header {
                request = request.header(SIGNER_IP_HEADER, header);
            }
            let (mut parts, ()) = request.body(()).expect("request").into_parts();
            // What a server with connect info adds: never read.
            parts
                .extensions
                .insert(std::net::SocketAddr::from(([10, 0, 0, 7], 443)));
            Portal::from_request_parts(&mut parts, &state(Some("k")))
                .await
                .map(|portal| portal.meta.ip)
                .expect("portal")
        };
        assert_eq!(
            ip(Some("198.51.100.7")).await.as_deref(),
            Some("198.51.100.7")
        );
        assert_eq!(ip(None).await, None);
        assert_eq!(ip(Some("")).await, None);
        assert_eq!(ip(Some("not an address")).await, None);
    }

    #[test]
    fn user_agents_are_cut_at_500_utf16_units() {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("FlowTest/1.0"));
        assert_eq!(user_agent(&headers).as_deref(), Some("FlowTest/1.0"));
        let long = "a".repeat(600);
        headers.insert(USER_AGENT, HeaderValue::from_str(&long).expect("header"));
        assert_eq!(user_agent(&headers).map(|ua| ua.len()), Some(500));
        assert_eq!(user_agent(&HeaderMap::new()), None);
    }

    #[test]
    fn bodies_parse_like_zod_with_flatten() {
        let details = |result: Result<String, ApiError>| {
            result
                .err()
                .and_then(|error| error.details().cloned())
                .unwrap_or_default()
        };
        let bad = parse(&Bytes::from_static(b"{\"token\":\"short\"}"), read_token);
        assert_eq!(
            details(bad),
            json!({ "formErrors": [], "fieldErrors": { "token": ["String must contain at least 20 character(s)"] } })
        );
        assert_eq!(
            details(parse(&Bytes::new(), read_token)),
            json!({ "formErrors": ["Required"], "fieldErrors": {} })
        );
        assert_eq!(
            details(parse(&Bytes::from_static(b"null"), read_token)),
            json!({ "formErrors": ["Expected object, received null"], "fieldErrors": {} })
        );
        let token = parse(
            &Bytes::from(format!("{{\"token\":\"{}\"}}", "x".repeat(43))),
            read_token,
        );
        assert_eq!(token.ok().map(|t| t.len()), Some(43));
    }

    fn state(secret: Option<&str>) -> PortalState {
        let sign = SignState {
            events: weldsuite_events::EntityEventPublisher::new(
                None,
                weldsuite_events::TaskTracker::new(),
            ),
            session_secret: Some(Arc::from("session-secret")),
            files: None,
            master: None,
            mail: None,
            cache: None,
            flags: Arc::new(weldsuite_ports::DefaultFlags),
            jobs: None,
            portal_url: None,
            environment: None,
        };
        PortalState::new(sign, None, secret.map(Arc::from))
    }

    async fn status(state: PortalState, key: Option<&str>, path: &str) -> StatusCode {
        use tower::ServiceExt;
        let mut request = http::Request::builder().uri(path);
        if let Some(key) = key {
            request = request.header(SIGN_PORTAL_KEY_HEADER, key);
        }
        let request = request.body(axum::body::Body::empty()).expect("request");
        portal_router::<()>(state)
            .oneshot(request)
            .await
            .expect("response")
            .status()
    }

    /// Only the portal may call: 403 without its key or with another, 503
    /// when this backend has none; with it, the signer session decides (401).
    #[tokio::test]
    async fn the_portal_key_comes_first() {
        let with_secret = || state(Some("portal-key"));
        assert_eq!(
            status(with_secret(), None, "/envelope").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(with_secret(), Some("portal-kez"), "/envelope").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(with_secret(), Some("portal-key"), "/envelope").await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(with_secret(), Some("portal-key"), "/nothing").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(state(None), Some("portal-key"), "/envelope").await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
