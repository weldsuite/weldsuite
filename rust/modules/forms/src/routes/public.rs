//! The respondent side (`routes/public/index.ts`), at `/public/forms`, called
//! only by the forms portal (ADR FORMS-002). Every request carries
//! `FORMS_PORTAL_SECRET` in `X-Forms-Portal-Key` (503 while it is unset, 403
//! when it is wrong) and the respondent's address in `X-Respondent-Ip`,
//! trusted only next to the key. An IP is only ever kept as a keyed hash.
//!
//! ```text
//! GET  /f/:publicId             the published form, state and bot-check settings (from the cache)
//! POST /f/:publicId/view        counts a view
//! POST /f/:publicId/sessions    starts or resumes a response
//! POST /f/:publicId/send-code   emails a 6-digit code (verified-email forms)
//! POST /f/:publicId/verify      checks the code, answers a verification token
//! POST /f/:publicId/report      an abuse report (master registry)
//! PUT  /sessions/progress       saves progress
//! POST /sessions/uploads        a file or a signature for one field
//! POST /sessions/submit         the final answers, validated by the engine
//! GET  /altcha/challenge        a proof-of-work challenge
//! ```

use axum::Router;
use axum::body::Bytes;
use axum::extract::{
    DefaultBodyLimit, FromRequestParts, OriginalUri, Path, RawQuery, Request, State,
};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::header::AUTHORIZATION;
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::Tenant;
use weldsuite_kit::{ApiError, Created, Data};

use crate::FormsState;
use crate::bot_check::{create_altcha_challenge, passes};
use crate::codes::{check_code, send_code};
use crate::common::{
    Ctx, Fail, FormsResult, Svc, answer, forms_error, not_found, object, one, opt_text, parse_ms,
    text,
};
use crate::counters::{Counters, rate_limited, today};
use crate::crypto::safe_equal;
use crate::input;
use crate::public_cache::PublicCacheEntry;
use crate::public_form::{
    Link, closed_error, load_entry, load_version, resolve_link, state_of, to_public_form,
};
use crate::respondent::{
    UploadTarget, UploadedFile, response_row, save_progress, start_session, upload_file,
};
use crate::sessions::{
    MIN_FILL_MS, RespondentSession, drop_seed, expired, issue_verification, keyed_hash, read_seed,
    require_session, session_secret,
};
use crate::submit::{Identity, Seed, SubmitArgs, submit_response};

/// Header carrying the portal's key.
pub const FORMS_PORTAL_KEY_HEADER: &str = "x-forms-portal-key";
/// Header carrying the respondent's IP; trusted only next to the key.
pub const RESPONDENT_IP_HEADER: &str = "x-respondent-ip";
const RESPONDENT_COUNTRY_HEADER: &str = "x-respondent-country";

/// Submissions one form takes per minute, over all respondents.
const SUBMITS_PER_FORM_PER_MINUTE: i64 = 120;
const CODES_PER_IP_PER_MINUTE: i64 = 5;
const REPORTS_PER_IP_PER_MINUTE: i64 = 5;

/// `/public/forms`, outside the member pipeline, behind the portal's key.
pub fn public_router<S>(state: FormsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/altcha/challenge", get(altcha_challenge))
        .route("/f/{publicId}", get(public_form))
        .route("/f/{publicId}/view", post(view))
        .route("/f/{publicId}/sessions", post(sessions))
        .route("/f/{publicId}/send-code", post(send_code_route))
        .route("/f/{publicId}/verify", post(verify))
        .route("/f/{publicId}/report", post(report))
        .route("/sessions/progress", put(progress))
        .route(
            "/sessions/uploads",
            post(uploads).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/sessions/submit", post(submit))
        .fallback(not_found_route)
        .method_not_allowed_fallback(not_found_route)
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn not_found_route(OriginalUri(uri): OriginalUri) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{} not found", uri.path()),
    )
}

/// Only the portal may call: 503 without `FORMS_PORTAL_SECRET`, 403 for a
/// missing or wrong key (`secretMatches`).
async fn guard(State(state): State<FormsState>, request: Request, next: Next) -> Response {
    let env = state.services(request.extensions()).env;
    let Some(secret) = env.non_empty("FORMS_PORTAL_SECRET") else {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "The forms portal is not configured on this deployment.",
        )
        .into_response();
    };
    let valid = request
        .headers()
        .get(FORMS_PORTAL_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|key| !key.is_empty() && safe_equal(key, &secret));
    if !valid {
        return ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", "Forbidden").into_response();
    }
    next.run(request).await
}

/// One portal call: the services, the master database, the respondent's
/// address and the session.
pub(crate) struct Portal {
    state: FormsState,
    svc: Svc,
    master: Option<PgPool>,
    /// The request's tenant database for every link (conformance).
    tenant: Option<PgPool>,
    ip: Option<String>,
    country: Option<String>,
    authorization: Option<String>,
}

impl FromRequestParts<FormsState> for Portal {
    type Rejection = Response;

    fn from_request_parts(
        parts: &mut Parts,
        state: &FormsState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let header = |name: &str| {
            parts
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(weldsuite_kit::validation::js_trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let country = header(RESPONDENT_COUNTRY_HEADER)
            .map(|c| crate::common::js_slice(&c.to_uppercase(), 2))
            .filter(|c| !c.is_empty());
        std::future::ready(Ok(Self {
            state: state.clone(),
            svc: state.services(&parts.extensions),
            master: state.master(&parts.extensions),
            tenant: parts
                .extensions
                .get::<Tenant>()
                .map(|tenant| tenant.db.clone()),
            ip: header(RESPONDENT_IP_HEADER),
            country,
            authorization: parts
                .headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
        }))
    }
}

impl Portal {
    fn master(&self) -> FormsResult<&PgPool> {
        self.master
            .as_ref()
            .ok_or_else(|| Fail::Internal("forms: no master database".to_owned()))
    }

    fn now_ms(&self) -> i64 {
        self.svc.env.now_ms()
    }

    fn counters(&self, form_id: &str) -> Counters {
        Counters::new(self.svc.cache.clone(), form_id, self.now_ms())
    }

    /// `openWorkspace(env, link)`: the tenant database of the link's
    /// workspace; a suspended or unknown workspace is a 404 to respondents.
    async fn open(&self, link: &Link) -> FormsResult<Ctx> {
        let db = if let Some(db) = &self.tenant {
            db.clone()
        } else {
            let Some(tenants) = &self.state.tenants else {
                return Err(not_found("Form"));
            };
            match tenants.tenant(&link.clerk_org_id).await {
                Ok(tenant) if !tenant.suspended => tenant.db,
                _ => return Err(not_found("Form")),
            }
        };
        Ok(Ctx {
            db,
            master: self.master.clone(),
            workspace_id: link.workspace_id.clone(),
            clerk_org_id: link.clerk_org_id.clone(),
            svc: self.svc.clone(),
        })
    }

    async fn entry(&self, link: &Link) -> FormsResult<(PublicCacheEntry, Option<Ctx>)> {
        load_entry(&self.svc, link, None, || self.open(link)).await
    }

    /// `ipHashOf(c)`.
    fn ip_hash(&self) -> FormsResult<Option<String>> {
        match &self.ip {
            Some(ip) => Ok(Some(keyed_hash(&self.svc.env, "ip", ip)?)),
            None => Ok(None),
        }
    }

    /// `sessionContext(c)`: a session's link and workspace; a form staff
    /// stopped ends its sessions too.
    async fn session_context(&self) -> FormsResult<(RespondentSession, Link, Ctx, Counters)> {
        let session = require_session(&self.svc.env, self.authorization.as_deref(), self.now_ms())?;
        let link = resolve_link(self.master()?, &session.public_id).await?;
        if link.form_id != session.form || link.workspace_id != session.ws {
            return Err(expired());
        }
        if link.suspended {
            return Err(closed_error("suspended"));
        }
        if link.held {
            return Err(closed_error("held"));
        }
        let ctx = self.open(&link).await?;
        let counters = self.counters(&link.form_id);
        Ok((session, link, ctx, counters))
    }
}

// ── Proof-of-work challenge ──────────────────────────────────────────────────

async fn altcha_challenge(portal: Portal) -> Response {
    match create_altcha_challenge(&portal.svc.env, portal.now_ms()) {
        Some(challenge) => axum::Json(challenge).into_response(),
        None => forms_error(
            503,
            "SERVICE_UNAVAILABLE",
            "The bot check is not configured.",
        )
        .respond(),
    }
}

// ── The form ─────────────────────────────────────────────────────────────────

async fn public_form(
    portal: Portal,
    Path(public_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        async {
            let link = resolve_link(portal.master()?, &public_id).await?;
            let (entry, opened) = portal.entry(&link).await?;
            // A respondent finishing an older version asks for it by id.
            let version_id = form_urlencoded::parse(query.unwrap_or_default().as_bytes())
                .find(|(name, _)| name == "versionId")
                .map(|(_, value)| value.into_owned())
                .filter(|id| !id.is_empty());
            let mut version: Option<Value> = None;
            if let Some(version_id) = version_id.filter(|id| Some(id) != entry.version_id.as_ref())
            {
                let ctx = match opened {
                    Some(ctx) => ctx,
                    None => portal.open(&link).await?,
                };
                version = Some(load_version(&ctx, &link.form_id, &version_id).await?);
            }
            let version = version.as_ref().map(|v| (text(v, "id"), &v["definition"]));
            Ok(Data(to_public_form(
                &portal.svc.env,
                &link,
                &entry,
                version,
                false,
                portal.now_ms(),
            ))
            .into_response())
        }
        .await,
    )
}

async fn view(
    portal: Portal,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let view_key = input::json(&headers, &body, input::record_view)?;
            let link = resolve_link(portal.master()?, &public_id).await?;
            let counted = portal
                .counters(&link.form_id)
                .record_view(&today(portal.now_ms()), &view_key)
                .await?;
            Ok(Data(json!({ "counted": counted })).into_response())
        }
        .await,
    )
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async fn sessions(
    portal: Portal,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::start_session)?;
            session_secret(&portal.svc.env)?;
            let link = resolve_link(portal.master()?, &public_id).await?;
            let (entry, opened) = portal.entry(&link).await?;
            let counters = portal.counters(&link.form_id);
            let result = start_session(
                crate::respondent::StartArgs {
                    svc: &portal.svc,
                    link: &link,
                    entry: &entry,
                    counters: &counters,
                    input: &input,
                    ip: portal.ip.as_deref(),
                    country: portal.country.as_deref(),
                    now_ms: portal.now_ms(),
                },
                || async {
                    match opened {
                        Some(ctx) => Ok(ctx),
                        None => portal.open(&link).await,
                    }
                },
            )
            .await?;
            Ok(Created(result).into_response())
        }
        .await,
    )
}

fn not_verified_email() -> Fail {
    forms_error(
        400,
        "BAD_REQUEST",
        "This form does not ask for a verified email.",
    )
}

async fn send_code_route(
    portal: Portal,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (email, bot_token) = input::json(&headers, &body, input::send_code)?;
            session_secret(&portal.svc.env)?;
            let link = resolve_link(portal.master()?, &public_id).await?;
            let (entry, _) = portal.entry(&link).await?;
            let state = state_of(&link, &entry, portal.now_ms());
            if state != "open" {
                return Err(closed_error(state));
            }
            if entry.settings.respondent_mode != "verified_email" {
                return Err(not_verified_email());
            }
            let counters = portal.counters(&link.form_id);
            let ip_hash = portal.ip_hash()?;
            rate_limited(
                &counters,
                &format!("code:{}", ip_hash.as_deref().unwrap_or("unknown")),
                CODES_PER_IP_PER_MINUTE,
            )
            .await?;
            // Without it anyone could make a workspace's form mail strangers.
            if !passes(
                &portal.svc,
                bot_token.as_deref(),
                portal.ip.as_deref(),
                portal.now_ms(),
            )
            .await?
            {
                return Err(forms_error(
                    403,
                    "BOT_CHECK_FAILED",
                    "The bot check failed. Reload the page and try again.",
                ));
            }
            let expires = send_code(
                &portal.svc,
                portal.master.clone(),
                &counters,
                &entry,
                &email,
                &link.clerk_org_id,
            )
            .await?;
            Ok(Data(json!({ "expiresInSeconds": expires })).into_response())
        }
        .await,
    )
}

async fn verify(
    portal: Portal,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (email, code) = input::json(&headers, &body, input::verify_code)?;
            session_secret(&portal.svc.env)?;
            let link = resolve_link(portal.master()?, &public_id).await?;
            let (entry, _) = portal.entry(&link).await?;
            if entry.settings.respondent_mode != "verified_email" {
                return Err(not_verified_email());
            }
            let counters = portal.counters(&link.form_id);
            check_code(&portal.svc, &counters, &link.form_id, &email, &code).await?;
            let verification = issue_verification(
                &portal.svc.env,
                &link.form_id,
                &weldsuite_kit::validation::js_trim(&email).to_lowercase(),
                portal.now_ms(),
            )?;
            Ok(Data(json!({ "verification": verification })).into_response())
        }
        .await,
    )
}

async fn report(
    portal: Portal,
    Path(public_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::report_abuse)?;
            let master = portal.master()?.clone();
            let link = resolve_link(&master, &public_id).await?;
            let ip_hash = portal.ip_hash().unwrap_or(None);
            rate_limited(
                &portal.counters(&link.form_id),
                &format!("report:{}", ip_hash.as_deref().unwrap_or("unknown")),
                REPORTS_PER_IP_PER_MINUTE,
            )
            .await?;
            sqlx::query(
                "insert into form_abuse_reports (id, public_id, workspace_id, form_id, reason, details, reporter_email, reporter_ip_hash) \
                 values ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(weldsuite_kit::generate_id("fab"))
            .bind(&link.public_id)
            .bind(&link.workspace_id)
            .bind(&link.form_id)
            .bind(&input.reason)
            .bind(&input.details)
            .bind(&input.email)
            .bind(&ip_hash)
            .execute(&master)
            .await?;
            Ok(Created(json!({ "received": true })).into_response())
        }
        .await,
    )
}

// ── Session routes ───────────────────────────────────────────────────────────

async fn progress(portal: Portal, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::save_progress)?;
            let (session, link, ctx, _) = portal.session_context().await?;
            let (entry, _) = load_entry(&portal.svc, &link, Some(ctx.clone()), || async {
                Err(not_found("Form"))
            })
            .await?;
            save_progress(&ctx, &session, &entry, &input).await?;
            Ok(Data(json!({ "saved": true })).into_response())
        }
        .await,
    )
}

async fn uploads(portal: Portal, request: Request) -> Response {
    answer(
        async {
            let (session, _, ctx, counters) = portal.session_context().await?;
            let Some(fields) = super::multipart_fields(request).await else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send the file as multipart form data.",
                ));
            };
            let block_id = fields
                .iter()
                .find(|(name, ..)| name == "blockId")
                .filter(|(_, file_name, ..)| file_name.is_none())
                .map(|(_, _, _, bytes)| String::from_utf8_lossy(bytes).into_owned());
            let file = fields
                .into_iter()
                .find(|(name, ..)| name == "file")
                .filter(|(_, file_name, ..)| file_name.is_some());
            let (Some(block_id), Some((_, file_name, content_type, bytes))) = (block_id, file)
            else {
                return Err(forms_error(
                    400,
                    "BAD_REQUEST",
                    "Send \"blockId\" and \"file\".",
                ));
            };
            let target = UploadTarget {
                response: &session.resp,
                form: &session.form,
                version: &session.ver,
            };
            let uploaded = upload_file(
                &ctx,
                &target,
                &counters,
                &block_id,
                UploadedFile {
                    name: file_name.unwrap_or_default(),
                    content_type,
                    bytes,
                },
            )
            .await?;
            Ok(Created(json!({ "file": uploaded })).into_response())
        }
        .await,
    )
}

async fn submit(portal: Portal, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, input::submit_session)?;
            let (session, _, ctx, counters) = portal.session_context().await?;
            rate_limited(&counters, "submit", SUBMITS_PER_FORM_PER_MINUTE).await?;
            // A hidden input real people leave empty.
            if input.website.as_deref().is_some_and(|w| !w.is_empty()) {
                return Err(rejected());
            }
            let form = one(
                &ctx.db,
                sqlx::query_scalar("select to_jsonb(f) from forms f where id = $1 limit 1")
                    .bind(&session.form),
            )
            .await?
            .ok_or_else(|| forms_error(404, "NOT_FOUND", "Form not found"))?;
            let existing = response_row(&ctx, &session.resp).await?;
            let seed = read_seed(&ctx.svc, &session.resp).await?;

            // Too quick to be a person: less than a moment between start and submit.
            let started_at = match &existing {
                Some(e) => parse_ms(text(e, "startedAt")),
                None => seed.as_ref().map(|s| s.started_at),
            };
            let min_fill = ctx
                .env()
                .get("FORMS_MIN_FILL_MS")
                .map_or(MIN_FILL_MS, |text| {
                    weldsuite_kit::validation::js_number(&text)
                });
            let completed = existing
                .as_ref()
                .is_some_and(|e| text(e, "status") == "completed");
            #[allow(clippy::cast_precision_loss)]
            let too_quick =
                started_at.is_some_and(|started| ((ctx.now_ms() - started) as f64) < min_fill);
            if !completed && too_quick {
                return Err(rejected());
            }

            let version = load_version(&ctx, text(&form, "id"), &session.ver).await?;
            let hidden: Map<String, Value> = match (&existing, &seed) {
                (Some(e), _) => object(&e["hidden"]),
                (None, Some(seed)) => seed.hidden.clone(),
                (None, None) => Map::new(),
            };
            let identity = Identity {
                email: session.email.clone(),
                user_id: None,
                hash: existing
                    .as_ref()
                    .and_then(|e| opt_text(e, "respondentHash"))
                    .or_else(|| seed.as_ref().and_then(|s| s.browser_hash.clone())),
                invitation_id: session
                    .inv
                    .clone()
                    .or_else(|| existing.as_ref().and_then(|e| opt_text(e, "invitationId"))),
            };
            let submit_seed = match (&seed, &existing) {
                (Some(seed), _) => Some(Seed {
                    metadata: seed.metadata.clone(),
                    ip_hash: seed.ip_hash.clone(),
                    started_at: seed.started_at,
                }),
                (None, Some(e)) => Some(Seed {
                    metadata: object(&e["metadata"]),
                    ip_hash: opt_text(e, "ipHash"),
                    started_at: parse_ms(text(e, "startedAt")).unwrap_or_default(),
                }),
                (None, None) => None,
            };
            let outcome = submit_response(
                &ctx,
                SubmitArgs {
                    form: &form,
                    version: &version,
                    response_id: &session.resp,
                    answers: &input.answers,
                    hidden: &hidden,
                    timings: input.timings.as_ref(),
                    identity,
                    seed: submit_seed,
                    actor: "respondent",
                },
            )
            .await?;
            let svc = ctx.svc.clone();
            let response_id = session.resp.clone();
            ctx.after(async move {
                if drop_seed(&svc, &response_id).await.is_err() {
                    tracing::warn!("forms: dropping a session seed failed");
                }
            });
            Ok(Data(outcome.result).into_response())
        }
        .await,
    )
}

fn rejected() -> Fail {
    forms_error(400, "SUBMISSION_REJECTED", "The submission was rejected.")
}

/// A response id's row, for the routes.
#[allow(dead_code)]
async fn response(ctx: &Ctx, id: &str) -> FormsResult<Option<Value>> {
    response_row(ctx, id).await
}

/// `not_found` re-exported for the session routes.
#[allow(dead_code)]
fn unknown(what: &str) -> Fail {
    not_found(what)
}
