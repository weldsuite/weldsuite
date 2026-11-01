//! The public B2B commerce portal (`/public/commerce-portal`,
//! `commerce-api/src/routes/public-commerce-portal/index.ts`): no Clerk
//! session. The workspace comes from `?slug=` / `X-Workspace-Slug`
//! ([`resolve_workspace`], `commercePortalSlugMiddleware`), the buyer from a
//! hashed session token in the workspace cache ([`Buyer`],
//! `commercePortalAuthMiddleware`). Every buyer query is scoped to the
//! buyer's company party.
//!
//! Sign-in: `/auth/request` mails a magic link and a code (rate limited per
//! address and per workspace), `/auth/verify` redeems either (failed
//! attempts counted per address, per workspace and per challenge), and a
//! buyer with access to several companies picks one (`/auth/select-company`).

use std::future::Future;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, RawQuery, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_commerce_domain::portal_slug::normalize_portal_slug;
use weldsuite_commerce_domain::portal_tokens::{
    MAX_VERIFY_ATTEMPTS, OTP_TTL_SECONDS, PortalChallenge, PortalKv, PortalPicker, PortalSession, SESSION_TTL_SECONDS,
    TokenIndex, VERIFY_RATE_LIMIT_EMAIL_MAX, VERIFY_RATE_LIMIT_WORKSPACE_MAX, delete_challenge, kv_delete, kv_get_json,
    kv_put_json, normalize_email, otp_kv_key, picker_kv_key, random_token, session_kv_key, sha256_hex, store_challenge,
    token_kv_key,
};
use weldsuite_commerce_domain::rate_limit::{
    RATE_LIMIT_MAX, RATE_LIMIT_TTL_SECONDS, REQUEST_RATE_LIMIT_WORKSPACE_MAX, RateLimitOutcome, consume_rate_limit,
    release_rate_limit,
};
use weldsuite_db::Tenant;
use weldsuite_events::{EventContext, publish_entity_event};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_ports::PortError;

use crate::js::{js_limit, query_param, sql_limit};
use crate::portal::{
    PortalBrand, SignInContext, find_company_party, is_portal_enabled, load_portal_settings, new_challenge,
    send_magic_link,
};
use crate::tables;
use crate::{CommerceState, Overrides, all, now, validate};

pub(crate) fn routes() -> Router<CommerceState> {
    Router::new()
        .route("/config", get(config))
        .route("/auth/request", post(auth_request))
        .route("/auth/verify", post(auth_verify))
        .route("/auth/select-company", post(select_company))
        .route("/auth/logout", post(logout))
        .route("/me", get(me))
        .route("/products", get(products))
        .route("/products/{id}", get(product))
        .route("/categories", get(categories))
        .route("/orders", get(orders).post(place_order))
        .route("/orders/{id}", get(order))
        .route("/invoices", get(invoices))
        .route("/invoices/{id}/pdf", get(invoice_document))
        .route("/invoices/{id}", get(invoice))
        .route("/return-reasons", get(return_reasons))
        .route("/returns", get(returns).post(create_return))
        .route("/returns/{id}", get(return_detail))
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

fn unauthorized(message: &str) -> Response {
    ApiError::unauthorized().with_message(message).into_response()
}

fn internal(message: &str, error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "[app-api/public-commerce-portal] {message}");
    ApiError::internal().with_message(message).into_response()
}

// ---------------------------------------------------------------------------
// The workspace (`commercePortalSlugMiddleware`)
// ---------------------------------------------------------------------------

/// `cportal:slug:<slug>` in the workspace cache.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedSlug {
    workspace_id: String,
    clerk_org_id: String,
}

const SLUG_TTL_SECONDS: u64 = 300;

/// Resolves the workspace from the slug, unless the request already has its
/// tenant (conformance builds put the test's there, as the harness hands
/// the worker its tenant database).
pub(crate) async fn resolve_workspace(State(state): State<CommerceState>, mut request: Request, next: Next) -> Response {
    if request.extensions().get::<Tenant>().is_some() {
        return next.run(request).await;
    }
    let from_query = query_param(request.uri().query(), "slug").filter(|s| !s.is_empty());
    let from_header = request
        .headers()
        .get("x-workspace-slug")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let raw = from_query.or(from_header).unwrap_or_default();
    let raw = weldsuite_kit::validation::js_trim(&raw);
    if raw.is_empty() {
        return error(StatusCode::BAD_REQUEST, "BAD_REQUEST", "Missing workspace slug");
    }
    let Some(slug) = normalize_portal_slug(Some(raw)) else {
        return error(StatusCode::BAD_REQUEST, "BAD_REQUEST", "Invalid workspace slug");
    };
    let overrides = Overrides::from_extensions(request.extensions());
    match tenant_of_slug(&state, &overrides, &slug).await {
        Ok(Some(tenant)) => {
            request.extensions_mut().insert(tenant);
            next.run(request).await
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "NOT_FOUND", "Workspace not found"),
        Err(failure) => {
            tracing::error!(error = %failure, "[commerce-domain/portal-slug] resolution error");
            error(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Failed to resolve workspace")
        }
    }
}

async fn tenant_of_slug(state: &CommerceState, overrides: &Overrides, slug: &str) -> Result<Option<Tenant>, String> {
    let kv = overrides.kv(state);
    let key = format!("cportal:slug:{slug}");
    let mut entry: Option<CachedSlug> = kv_get_json(&kv, &key).await.map_err(|e| e.to_string())?;
    if entry.is_none() {
        let master = overrides.master(state).ok_or("no master database")?;
        let row: Option<(String, Option<String>, Option<bool>)> =
            sqlx::query_as("select id, clerk_org_id, is_active from workspaces where slug = $1 limit 1")
                .bind(slug)
                .fetch_optional(&master)
                .await
                .map_err(|e| e.to_string())?;
        let Some((id, Some(clerk_org_id), Some(true))) = row.map(|(id, org, active)| (id, org.filter(|o| !o.is_empty()), active))
        else {
            return Ok(None);
        };
        let found = CachedSlug {
            workspace_id: id,
            clerk_org_id,
        };
        kv_put_json(&kv, &key, &found, SLUG_TTL_SECONDS)
            .await
            .map_err(|e| e.to_string())?;
        entry = Some(found);
    }
    let entry = entry.ok_or("no workspace")?;
    let workspaces = state.workspaces.as_ref().ok_or("no workspace directory")?;
    let mut tenant = workspaces
        .tenant(&entry.clerk_org_id)
        .await
        .map_err(|e| e.to_string())?;
    tenant.workspace_id = entry.workspace_id;
    tenant.clerk_org_id = Some(entry.clerk_org_id);
    Ok(Some(tenant))
}

/// The workspace a public request is in, and what it shares.
pub(crate) struct Portal {
    pub(crate) db: PgPool,
    /// `c.get('workspaceId')`; empty when there is none.
    pub(crate) workspace_id: String,
    pub(crate) clerk_org_id: Option<String>,
    /// `c.get('userId')`: none on the public portal (`system`), the test's
    /// in conformance builds.
    pub(crate) user_id: String,
    pub(crate) overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Portal {
    type Rejection = ApiError;

    fn from_request_parts(parts: &mut Parts, _state: &S) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let portal = match parts.extensions.get::<Tenant>() {
            Some(tenant) => Ok(Self {
                db: tenant.db.clone(),
                workspace_id: tenant.workspace_id.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                user_id: parts
                    .extensions
                    .get::<AuthContext>()
                    .map_or_else(|| "system".to_owned(), |auth| auth.user_id.clone()),
                overrides: Overrides::from_parts(parts),
            }),
            None => {
                tracing::error!("commerce: a public portal route without the workspace layer");
                Err(ApiError::internal())
            }
        };
        std::future::ready(portal)
    }
}

impl Portal {
    fn publish(&self, state: &CommerceState, event: EventName, entity_id: &str, data: &Value) {
        let context = EventContext::from_ids(&self.workspace_id, self.clerk_org_id.as_deref(), &self.user_id);
        publish_entity_event(&state.events, &context, event, entity_id, data);
    }

    fn kv(&self, state: &CommerceState) -> PortalKv {
        self.overrides.kv(state)
    }
}

// ---------------------------------------------------------------------------
// The buyer (`commercePortalAuthMiddleware`)
// ---------------------------------------------------------------------------

/// A signed-in buyer: the session's person, company, party and access row.
pub(crate) struct Buyer {
    pub(crate) portal: Portal,
    pub(crate) session: PortalSession,
}

/// The session token: `Authorization: Bearer …`, else the `cportal_session` cookie.
fn read_bearer(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(http::header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if let Some(header) = header
        && header.to_lowercase().starts_with("bearer ")
    {
        return Some(weldsuite_kit::validation::js_trim(header.get(7..).unwrap_or_default()).to_owned());
    }
    let cookie = headers.get(http::header::COOKIE).and_then(|v| v.to_str().ok())?;
    // `/(?:^|;\s*)cportal_session=([^;]+)/`
    let mut rest = cookie;
    loop {
        if let Some(value) = rest.strip_prefix("cportal_session=") {
            let value = value.split(';').next().unwrap_or_default();
            if value.is_empty() {
                return None;
            }
            return Some(
                form_urlencoded::parse(format!("v={}", value.replace('+', "%2B")).as_bytes())
                    .next()
                    .map_or_else(|| value.to_owned(), |(_, v)| v.into_owned()),
            );
        }
        let next = rest.find(';')?;
        rest = rest[next + 1..].trim_start();
    }
}

impl FromRequestParts<CommerceState> for Buyer {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &CommerceState) -> Result<Self, Self::Rejection> {
        let portal = Portal::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Some(raw) = read_bearer(&parts.headers) else {
            return Err(unauthorized("Sign in required"));
        };
        let token_hash = sha256_hex(&raw);
        let session: Option<PortalSession> = kv_get_json(&portal.kv(state), &session_kv_key(&token_hash))
            .await
            .map_err(|e| internal("Internal server error", &e))?;
        let Some(session) = session else {
            return Err(unauthorized("Session expired"));
        };
        if !portal.workspace_id.is_empty() && session.workspace_id != portal.workspace_id {
            return Err(unauthorized("Session expired"));
        }
        let access: Option<String> = sqlx::query_scalar(
            "select id from commerce_portal_access where id = $1 and status = 'active' limit 1",
        )
        .bind(&session.access_id)
        .fetch_optional(&portal.db)
        .await
        .map_err(|e| internal("Internal server error", &e))?;
        if access.is_none() {
            return Err(unauthorized("Access revoked"));
        }
        Ok(Self { portal, session })
    }
}

// ---------------------------------------------------------------------------
// Config and sign-in
// ---------------------------------------------------------------------------

async fn require_enabled(db: &PgPool) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let settings = load_portal_settings(db).await?;
    Ok(settings.filter(|s| is_portal_enabled(Some(s))))
}

async fn config(portal: Portal) -> Response {
    match load_portal_settings(&portal.db).await {
        Ok(Some(settings)) if is_portal_enabled(Some(&settings)) => {
            let field = |key: &str| settings.get(key).cloned().unwrap_or(Value::Null);
            Data(json!({
                "displayName": field("displayName"),
                "logo": field("logo"),
                "primaryColor": field("primaryColor"),
                "accentColor": field("accentColor"),
            }))
            .into_response()
        }
        Ok(_) => error(StatusCode::NOT_FOUND, "NOT_FOUND", "Portal is not enabled"),
        Err(e) => internal("Failed to load portal config", &e),
    }
}

/// The counter behind the rate limits could not be reached: both sign-in
/// endpoints refuse rather than run without a limit.
fn sign_in_unavailable() -> Response {
    ApiError::unavailable("Sign-in is temporarily unavailable, try again shortly").into_response()
}

fn generic_ok() -> Response {
    Data(json!({ "ok": true })).into_response()
}

fn email_text(issues: &mut Issues, fields: &Map<String, Value>, key: &str, presence: Presence) -> Option<String> {
    issues
        .text_with(
            fields,
            key,
            presence,
            Text {
                format: Some(Format::Email),
                ..Text::default()
            },
        )
        .into_option()
}

/// `commercePortalAuthRequestSchema`: the email.
fn read_auth_request(issues: &mut Issues, fields: &Map<String, Value>) -> String {
    let email = email_text(issues, fields, "email", Presence::Required);
    issues.text_with(fields, "slug", Presence::Optional, Text::length(Some(1), None));
    email.unwrap_or_default()
}

async fn auth_request(State(state): State<CommerceState>, portal: Portal, RawQuery(query): RawQuery, headers: HeaderMap, body: Bytes) -> Response {
    let raw_email = match validate(&headers, &body, read_auth_request) {
        Ok(email) => email,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    let email = normalize_email(&raw_email);
    // The validated slug, never the raw one: it ends up in the mail's link.
    let slug = normalize_portal_slug(
        query_param(query.as_deref(), "slug")
            .filter(|s| !s.is_empty())
            .or_else(|| {
                headers
                    .get("x-workspace-slug")
                    .and_then(|v| v.to_str().ok())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .as_deref(),
    );
    match request_sign_in(&state, &portal, &email, slug.as_deref()).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[app-api/public-commerce-portal] auth request failed");
            generic_ok()
        }
    }
}

async fn request_sign_in(state: &CommerceState, portal: &Portal, email: &str, slug: Option<&str>) -> Result<Response, String> {
    let db = &portal.db;
    let settings = require_enabled(db).await.map_err(|e| e.to_string())?;
    let Some(settings) = settings.filter(|_| !portal.workspace_id.is_empty()) else {
        return Ok(generic_ok());
    };
    let ws = &portal.workspace_id;
    let ctx = SignInContext::of(&portal.overrides, state);
    // Per address first, then per workspace; over a limit looks like "no access".
    match consume_rate_limit(ctx.limiter.as_ref(), ws, &format!("e:{email}"), RATE_LIMIT_MAX, RATE_LIMIT_TTL_SECONDS).await {
        RateLimitOutcome::Unavailable => return Ok(sign_in_unavailable()),
        RateLimitOutcome::Limited => return Ok(generic_ok()),
        RateLimitOutcome::Allowed => {}
    }
    match consume_rate_limit(
        ctx.limiter.as_ref(),
        ws,
        "request-ws",
        REQUEST_RATE_LIMIT_WORKSPACE_MAX,
        RATE_LIMIT_TTL_SECONDS,
    )
    .await
    {
        RateLimitOutcome::Unavailable => return Ok(sign_in_unavailable()),
        RateLimitOutcome::Limited => return Ok(generic_ok()),
        RateLimitOutcome::Allowed => {}
    }

    let access: Vec<(String, String)> = sqlx::query_as(
        "select id, company_id from commerce_portal_access where email = $1 and status in ('invited', 'active')",
    )
    .bind(email)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if access.is_empty() {
        return Ok(generic_ok());
    }
    let (challenge, token, otp) = new_challenge(ws, email, access.iter().map(|a| a.0.clone()).collect());
    store_challenge(&ctx.kv, &challenge, email).await.map_err(|e| e.to_string())?;
    let company: Option<Option<String>> = sqlx::query_scalar("select display_name from companies where id = $1 limit 1")
        .bind(&access[0].1)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(slug) = slug {
        let brand = PortalBrand::of(&settings);
        send_magic_link(&ctx, email, slug, &token, &otp, company.flatten().as_deref(), Some(&brand)).await;
    }
    Ok(generic_ok())
}

/// `commercePortalAuthVerifySchema`.
#[derive(Default)]
struct VerifyBody {
    token: Option<String>,
    otp: Option<String>,
    email: Option<String>,
    access_id: Option<String>,
}

fn read_verify(issues: &mut Issues, fields: &Map<String, Value>) -> VerifyBody {
    let token = issues.text_with(fields, "token", Presence::Optional, Text::length(Some(1), None));
    let otp = issues.text_with(fields, "otp", Presence::Optional, Text::length(Some(4), Some(12)));
    let email = email_text(issues, fields, "email", Presence::Optional);
    let access_id = issues.text_with(fields, "accessId", Presence::Optional, Text::length(Some(1), None));
    let body = VerifyBody {
        token: token.into_option(),
        otp: otp.into_option(),
        email,
        access_id: access_id.into_option(),
    };
    // `.refine(...)`: only once the object parsed.
    if issues.is_empty() && !(body.token.is_some() || (body.otp.is_some() && body.email.is_some())) {
        issues.custom_root("token, or otp together with email, is required");
    }
    body
}

fn failed_code() -> Response {
    unauthorized("Invalid or expired code")
}

/// The verify budgets reserved up front (failed attempts only: released
/// once the sign-in succeeds).
struct Reservation<'a> {
    portal: &'a Portal,
    ctx: &'a SignInContext,
    keys: Vec<String>,
}

impl Reservation<'_> {
    async fn release(&self) {
        for key in &self.keys {
            release_rate_limit(self.ctx.limiter.as_ref(), &self.portal.workspace_id, key).await;
        }
    }
}

/// `reserveVerifyBudget`: the refusal to send (holding no slot), or the reservation.
async fn reserve_verify_budget<'a>(
    portal: &'a Portal,
    ctx: &'a SignInContext,
    body: &VerifyBody,
) -> Result<Reservation<'a>, Response> {
    let mut budgets: Vec<(String, u32)> = Vec::new();
    if let (Some(_), Some(email)) = (&body.otp, &body.email) {
        budgets.push((format!("verify-e:{}", normalize_email(email)), VERIFY_RATE_LIMIT_EMAIL_MAX));
    }
    budgets.push(("verify-ws".to_owned(), VERIFY_RATE_LIMIT_WORKSPACE_MAX));
    let mut reservation = Reservation {
        portal,
        ctx,
        keys: Vec::new(),
    };
    for (key, max) in budgets {
        let outcome = consume_rate_limit(ctx.limiter.as_ref(), &portal.workspace_id, &key, max, RATE_LIMIT_TTL_SECONDS).await;
        if outcome == RateLimitOutcome::Allowed {
            reservation.keys.push(key);
            continue;
        }
        reservation.release().await;
        if outcome == RateLimitOutcome::Unavailable {
            return Err(sign_in_unavailable());
        }
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED", "Too many attempts, try again later"));
    }
    Ok(reservation)
}

enum Matched {
    Challenge(PortalChallenge),
    Unavailable,
    None,
}

/// `loadMatchingChallenge`: the stored challenge when the token or code
/// matches it; every failed attempt counted, the challenge dropped after
/// [`MAX_VERIFY_ATTEMPTS`].
async fn load_matching_challenge(
    ctx: &SignInContext,
    workspace_id: &str,
    email: &str,
    presented_hash: &str,
    body: &VerifyBody,
) -> Result<Matched, PortError> {
    let key = otp_kv_key(workspace_id, email);
    let Some(challenge) = kv_get_json::<PortalChallenge>(&ctx.kv, &key).await? else {
        return Ok(Matched::None);
    };
    if challenge.attempts >= MAX_VERIFY_ATTEMPTS {
        delete_challenge(&ctx.kv, &challenge).await?;
        return Ok(Matched::None);
    }
    let budget = consume_rate_limit(
        ctx.limiter.as_ref(),
        workspace_id,
        &format!("verify-ch:{}", challenge.token_hash),
        MAX_VERIFY_ATTEMPTS,
        OTP_TTL_SECONDS,
    )
    .await;
    match budget {
        RateLimitOutcome::Unavailable => return Ok(Matched::Unavailable),
        RateLimitOutcome::Limited => {
            delete_challenge(&ctx.kv, &challenge).await?;
            return Ok(Matched::None);
        }
        RateLimitOutcome::Allowed => {}
    }
    let token_ok = body.token.is_some() && challenge.token_hash == presented_hash;
    let otp_ok = body.otp.is_some() && challenge.otp_hash == presented_hash;
    if !token_ok && !otp_ok {
        let attempts = challenge.attempts + 1;
        if attempts >= MAX_VERIFY_ATTEMPTS {
            delete_challenge(&ctx.kv, &challenge).await?;
        } else {
            let counted = PortalChallenge { attempts, ..challenge };
            kv_put_json(&ctx.kv, &key, &counted, OTP_TTL_SECONDS).await?;
        }
        return Ok(Matched::None);
    }
    Ok(Matched::Challenge(challenge))
}

/// An access row's fields the sign-in reads.
#[derive(Clone)]
struct AccessRow {
    id: String,
    person_id: String,
    company_id: String,
    email: String,
}

async fn live_access(db: &PgPool, ids: &[String], company_id: Option<&str>) -> Result<Vec<AccessRow>, sqlx::Error> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "select id, person_id, company_id, email from commerce_portal_access \
         where id = any($1) and ($2::text is null or company_id = $2) and status in ('invited', 'active')",
    )
    .bind(ids)
    .bind(company_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, person_id, company_id, email)| AccessRow {
            id,
            person_id,
            company_id,
            email,
        })
        .collect())
}

/// What a sign-in step can fail on after validation.
enum StepError {
    Database(sqlx::Error),
    Kv(PortError),
}

impl From<sqlx::Error> for StepError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PortError> for StepError {
    fn from(error: PortError) -> Self {
        Self::Kv(error)
    }
}

impl StepError {
    fn respond(self, message: &str) -> Response {
        match self {
            Self::Database(e) => internal(message, &e),
            Self::Kv(e) => internal(message, &e),
        }
    }
}

/// `accessToSession` + `activateAccess` + `mintSession`: the new session
/// token, or none when the company has no party.
async fn sign_in_access(db: &PgPool, kv: &PortalKv, workspace_id: &str, access: &AccessRow) -> Result<Option<String>, StepError> {
    let Some(party_id) = find_company_party(db, &access.company_id).await? else {
        return Ok(None);
    };
    let session = PortalSession {
        workspace_id: workspace_id.to_owned(),
        person_id: access.person_id.clone(),
        company_id: access.company_id.clone(),
        party_id,
        access_id: access.id.clone(),
        email: access.email.clone(),
    };
    let now = now();
    sqlx::query(
        "update commerce_portal_access set status = 'active', last_login_at = $1::timestamp, \
         updated_at = $1::timestamp where id = $2",
    )
    .bind(&now)
    .bind(&access.id)
    .execute(db)
    .await?;
    let token = random_token(32);
    kv_put_json(kv, &session_kv_key(&sha256_hex(&token)), &session, SESSION_TTL_SECONDS).await?;
    Ok(Some(token))
}

async fn auth_verify(State(state): State<CommerceState>, portal: Portal, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to verify sign-in";
    let body = match validate(&headers, &body, read_verify) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if portal.workspace_id.is_empty() {
        return failed_code();
    }
    let ctx = SignInContext::of(&portal.overrides, &state);
    match verify(&portal, &ctx, &body).await {
        Ok(response) => response,
        Err(error) => error.respond(FAILED),
    }
}

async fn verify(portal: &Portal, ctx: &SignInContext, body: &VerifyBody) -> Result<Response, StepError> {
    let db = &portal.db;
    let ws = &portal.workspace_id;
    let reservation = match reserve_verify_budget(portal, ctx, body).await {
        Ok(reservation) => reservation,
        Err(refusal) => return Ok(refusal),
    };
    if require_enabled(db).await?.is_none() {
        // A disabled portal is not a guess: nothing to count.
        reservation.release().await;
        return Ok(failed_code());
    }
    let Some(presented) = body.token.as_deref().or(body.otp.as_deref()) else {
        return Ok(failed_code());
    };
    let presented_hash = sha256_hex(presented);
    let email = if body.token.is_some() {
        kv_get_json::<TokenIndex>(&ctx.kv, &token_kv_key(&presented_hash))
            .await?
            .map(|index| index.email)
    } else {
        body.email.as_deref().map(normalize_email)
    };
    let Some(email) = email else {
        return Ok(failed_code());
    };
    let challenge = match load_matching_challenge(ctx, ws, &email, &presented_hash, body).await? {
        Matched::Challenge(challenge) => challenge,
        Matched::Unavailable => {
            reservation.release().await;
            return Ok(sign_in_unavailable());
        }
        Matched::None => return Ok(failed_code()),
    };
    let access = live_access(db, &challenge.access_ids, None).await?;
    if access.is_empty() {
        return Ok(failed_code());
    }
    delete_challenge(&ctx.kv, &challenge).await?;
    // The code was right: this attempt is not a failure, give its slots back.
    reservation.release().await;

    let chosen = match &body.access_id {
        Some(access_id) => match access.iter().find(|a| &a.id == access_id) {
            Some(chosen) => Some(chosen.clone()),
            None => return Ok(ApiError::bad_request("Unknown company").into_response()),
        },
        None if access.len() == 1 => Some(access[0].clone()),
        None => None,
    };
    if let Some(chosen) = chosen {
        return Ok(match sign_in_access(db, &ctx.kv, ws, &chosen).await? {
            Some(token) => Data(json!({ "token": token, "needsCompanyPicker": false, "companies": [] })).into_response(),
            None => ApiError::bad_request("Company has no commercial party record").into_response(),
        });
    }

    // Several companies for one email: a picker token and the list.
    let picker_token = random_token(32);
    let picker = PortalPicker {
        workspace_id: ws.clone(),
        email: email.clone(),
        access_ids: access.iter().map(|a| a.id.clone()).collect(),
    };
    kv_put_json(&ctx.kv, &picker_kv_key(&sha256_hex(&picker_token)), &picker, OTP_TTL_SECONDS).await?;
    let mut companies = Vec::with_capacity(access.len());
    for row in &access {
        let name: Option<Option<String>> = sqlx::query_scalar("select display_name from companies where id = $1 limit 1")
            .bind(&row.company_id)
            .fetch_optional(db)
            .await?;
        companies.push(json!({
            "accessId": row.id,
            "companyId": row.company_id,
            "name": name.flatten().unwrap_or_else(|| row.company_id.clone()),
        }));
    }
    Ok(Data(json!({
        "token": Value::Null,
        "pickerToken": picker_token,
        "needsCompanyPicker": true,
        "companies": companies,
    }))
    .into_response())
}

fn read_select_company(issues: &mut Issues, fields: &Map<String, Value>) -> (String, String) {
    let picker = issues.text_with(fields, "pickerToken", Presence::Required, Text::length(Some(1), None));
    let company = issues.text_with(fields, "companyId", Presence::Required, Text::length(Some(1), None));
    (
        picker.into_option().unwrap_or_default(),
        company.into_option().unwrap_or_default(),
    )
}

async fn select_company(State(state): State<CommerceState>, portal: Portal, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to select company";
    let (picker_token, company_id) = match validate(&headers, &body, read_select_company) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if portal.workspace_id.is_empty() {
        return failed_code();
    }
    let kv = portal.kv(&state);
    let run = async {
        let picker_hash = sha256_hex(&picker_token);
        let picker: Option<PortalPicker> = kv_get_json(&kv, &picker_kv_key(&picker_hash)).await?;
        let Some(picker) = picker.filter(|p| p.workspace_id == portal.workspace_id) else {
            return Ok(failed_code());
        };
        let access = live_access(&portal.db, &picker.access_ids, Some(&company_id)).await?;
        let Some(access) = access.into_iter().next() else {
            return Ok(ApiError::bad_request("Unknown company").into_response());
        };
        let Some(party_id) = find_company_party(&portal.db, &access.company_id).await? else {
            return Ok(ApiError::bad_request("Company has no commercial party record").into_response());
        };
        // Activates the access, then the picker goes, then the session is minted.
        let now = now();
        sqlx::query(
            "update commerce_portal_access set status = 'active', last_login_at = $1::timestamp, \
             updated_at = $1::timestamp where id = $2",
        )
        .bind(&now)
        .bind(&access.id)
        .execute(&portal.db)
        .await?;
        kv_delete(&kv, &picker_kv_key(&picker_hash)).await?;
        let session = PortalSession {
            workspace_id: portal.workspace_id.clone(),
            person_id: access.person_id.clone(),
            company_id: access.company_id.clone(),
            party_id,
            access_id: access.id.clone(),
            email: access.email.clone(),
        };
        let token = random_token(32);
        kv_put_json(&kv, &session_kv_key(&sha256_hex(&token)), &session, SESSION_TTL_SECONDS).await?;
        Ok::<_, StepError>(Data(json!({ "token": token })).into_response())
    };
    match run.await {
        Ok(response) => response,
        Err(error) => error.respond(FAILED),
    }
}

/// Logout reads the bearer header only, and always answers 204.
async fn logout(State(state): State<CommerceState>, portal: Portal, headers: HeaderMap) -> Response {
    let header = headers.get(http::header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let raw = header
        .filter(|h| h.to_lowercase().starts_with("bearer "))
        .map(|h| weldsuite_kit::validation::js_trim(h.get(7..).unwrap_or_default()).to_owned())
        .filter(|raw| !raw.is_empty());
    if let Some(raw) = raw
        && let Err(error) = kv_delete(&portal.kv(&state), &session_kv_key(&sha256_hex(&raw))).await
    {
        return internal("Internal server error", &error);
    }
    NoContent.into_response()
}

// ---------------------------------------------------------------------------
// The buyer's pages
// ---------------------------------------------------------------------------

async fn me(buyer: Buyer) -> Response {
    const FAILED: &str = "Failed to load profile";
    let db = &buyer.portal.db;
    let session = &buyer.session;
    let run = async {
        if require_enabled(db).await?.is_none() {
            return Ok(unauthorized("Portal is not enabled"));
        }
        let person: Option<(String, Option<String>, Option<String>)> =
            sqlx::query_as("select id, display_name, email from people where id = $1 limit 1")
                .bind(&session.person_id)
                .fetch_optional(db)
                .await?;
        let company: Option<(String, Option<String>)> =
            sqlx::query_as("select id, display_name from companies where id = $1 limit 1")
                .bind(&session.company_id)
                .fetch_optional(db)
                .await?;
        let party: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(parties),
            " from parties t where t.id = $1 limit 1"
        ))
        .bind(&session.party_id)
        .fetch_optional(db)
        .await?;
        let person = person.map_or_else(
            || json!({ "id": session.person_id, "displayName": session.email, "email": session.email }),
            |(id, name, email)| json!({ "id": id, "displayName": name, "email": email }),
        );
        let company = company.map_or_else(
            || json!({ "id": session.company_id, "displayName": Value::Null }),
            |(id, name)| json!({ "id": id, "displayName": name }),
        );
        let party = party.map_or(Value::Null, |row| {
            let row = tables::PARTIES.js(row);
            let mut out = Map::new();
            for key in [
                "id",
                "paymentTerms",
                "creditLimit",
                "outstandingBalance",
                "currency",
                "billingAddress",
                "shippingAddress",
            ] {
                out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
            }
            Value::Object(out)
        });
        Ok::<_, sqlx::Error>(Data(json!({ "person": person, "company": company, "party": party })).into_response())
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}

/// `list(c, data, cursorPagination(total, hasMore, cursor))` from a `limit + 1` page.
fn page(rows: Vec<Value>, limit: f64, total: Option<i64>) -> Response {
    let (data, has_more, cursor) = crate::crud::page_of(rows, limit, |row| crate::js::text(row, "id"));
    let total = total.unwrap_or_else(|| i64::try_from(data.len()).unwrap_or(0));
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// The keyset operands of `?cursor=` (any row of `table`), when it names one.
async fn cursor_of(db: &PgPool, table: &str, query: Option<&str>) -> Result<(bool, Option<(String, String)>), sqlx::Error> {
    match query_param(query, "cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => Ok((true, crate::crud::cursor_row(db, table, &cursor).await?)),
        None => Ok((false, None)),
    }
}

async fn products(buyer: Buyer, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list products";
    let db = &buyer.portal.db;
    let limit = js_limit(query_param(query.as_deref(), "limit").as_deref(), 25.0, 100.0);
    let search = query_param(query.as_deref(), "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let run = async {
        let (_, cursor) = cursor_of(db, "products", query.as_deref()).await?;
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(products),
            " from products t where t.deleted_at is null and t.status = 'active' \
             and (t.visibility = 'visible' or t.visibility is null) \
             and ($1::text is null or t.name like $1::text) \
             and ($2::text is null or t.created_at < $2::timestamp or (t.created_at = $2::timestamp and t.id < $3::text)) \
             order by t.created_at desc, t.id desc limit $4"
        ))
        .bind(search.as_deref())
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(sql_limit(limit))
        .fetch_all(db)
        .await?;
        // The count ignores the search and the cursor.
        let total: i64 = sqlx::query_scalar(
            "select count(*) from products t where t.deleted_at is null and t.status = 'active' \
             and (t.visibility = 'visible' or t.visibility is null)",
        )
        .fetch_one(db)
        .await?;
        Ok::<_, sqlx::Error>(page(
            rows.into_iter().map(|r| tables::PRODUCTS.js(r)).collect(),
            limit,
            Some(total),
        ))
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}

async fn product(buyer: Buyer, Path(id): Path<String>) -> Response {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(products),
        " from products t where t.id = $1 and t.deleted_at is null and t.status = 'active' limit 1"
    ))
    .bind(&id)
    .fetch_optional(&buyer.portal.db)
    .await;
    match row {
        Ok(Some(row)) => {
            let row = tables::PRODUCTS.js(row);
            match row.get("visibility").and_then(Value::as_str) {
                Some(visibility) if !visibility.is_empty() && visibility != "visible" => {
                    ApiError::not_found("Product", Some(&id)).into_response()
                }
                _ => Data(row).into_response(),
            }
        }
        Ok(None) => ApiError::not_found("Product", Some(&id)).into_response(),
        Err(e) => internal("Failed to fetch product", &e),
    }
}

async fn categories(buyer: Buyer) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(categories),
        " from categories t where t.deleted_at is null and t.is_active = 1 order by t.depth, t.position, t.name"
    ))
    .fetch_all(&buyer.portal.db)
    .await;
    match rows {
        Ok(rows) => all(rows.into_iter().map(|r| tables::CATEGORIES.js(r)).collect()),
        Err(e) => internal("Failed to list categories", &e),
    }
}

async fn orders(buyer: Buyer, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list orders";
    let db = &buyer.portal.db;
    let party = &buyer.session.party_id;
    let limit = js_limit(query_param(query.as_deref(), "limit").as_deref(), 25.0, 100.0);
    let run = async {
        let (given, cursor) = cursor_of(db, "orders", query.as_deref()).await?;
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(orders),
            " from orders t where t.deleted_at is null and t.counterparty_id = $1 \
             and ($2::text is null or t.created_at < $2::timestamp or (t.created_at = $2::timestamp and t.id < $3::text)) \
             order by t.created_at desc, t.id desc limit $4"
        ))
        .bind(party)
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(sql_limit(limit))
        .fetch_all(db)
        .await?;
        // `conditions.slice(0, -1)` with a cursor: the keyset condition, or
        // the party when the cursor row is gone.
        let skip_party = given && cursor.is_none();
        let total: i64 = sqlx::query_scalar(
            "select count(*) from orders t where t.deleted_at is null and ($1::boolean or t.counterparty_id = $2)",
        )
        .bind(skip_party)
        .bind(party)
        .fetch_one(db)
        .await?;
        Ok::<_, sqlx::Error>(page(
            rows.into_iter().map(|r| tables::ORDERS.js(r)).collect(),
            limit,
            Some(total),
        ))
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}

/// An order's items in `id` order.
async fn order_items(db: &PgPool, order_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(order_items),
        " from order_items t where t.order_id = $1 order by t.id"
    ))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| tables::ORDER_ITEMS.js(r)).collect())
}

fn with_items(row: Value, items: Vec<Value>) -> Value {
    let mut row = match row {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    row.insert("items".to_owned(), Value::Array(items));
    Value::Object(row)
}

async fn order(buyer: Buyer, Path(id): Path<String>) -> Response {
    let db = &buyer.portal.db;
    let run = async {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(orders),
            " from orders t where t.id = $1 and t.counterparty_id = $2 and t.deleted_at is null limit 1"
        ))
        .bind(&id)
        .bind(&buyer.session.party_id)
        .fetch_optional(db)
        .await?;
        let Some(row) = row else {
            return Ok(ApiError::not_found("Order", Some(&id)).into_response());
        };
        let items = order_items(db, &id).await?;
        Ok::<_, sqlx::Error>(Data(with_items(tables::ORDERS.js(row), items)).into_response())
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal("Failed to fetch order", &e),
    }
}

async fn place_order(State(state): State<CommerceState>, buyer: Buyer, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to place order";
    let input = match validate(&headers, &body, crate::portal_orders::read_order) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let db = &buyer.portal.db;
    let run = async {
        if require_enabled(db).await?.is_none() {
            return Ok(Err(unauthorized("Portal is not enabled")));
        }
        let person: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("select email, display_name from people where id = $1 limit 1")
                .bind(&buyer.session.person_id)
                .fetch_optional(db)
                .await?;
        let (email, name) = person.unwrap_or_default();
        let placed = crate::portal_orders::place(
            db,
            &crate::portal_orders::Buyer {
                person_id: &buyer.session.person_id,
                party_id: &buyer.session.party_id,
                email: Some(email.unwrap_or_else(|| buyer.session.email.clone())),
                name,
            },
            &input,
        )
        .await?;
        Ok::<_, crate::portal_orders::PlaceError>(Ok(placed))
    };
    match run.await {
        Ok(Ok((order, items))) => {
            let id = order.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            let field = |key: &str| order.get(key).cloned().unwrap_or(Value::Null);
            buyer.portal.publish(
                &state,
                ev::COMMERCE_ORDER_PLACED,
                &id,
                &json!({
                    "id": id,
                    "orderNumber": field("orderNumber"),
                    "status": field("status"),
                    "total": field("total"),
                    "currency": field("currency"),
                    "source": field("source"),
                }),
            );
            Created(with_items(Value::Object(order), items)).into_response()
        }
        Ok(Err(response)) => response,
        Err(crate::portal_orders::PlaceError::Refused(status, message)) => {
            let code = if status == StatusCode::NOT_FOUND { "NOT_FOUND" } else { "BAD_REQUEST" };
            error(status, code, &message)
        }
        Err(crate::portal_orders::PlaceError::Failed(message)) => internal(FAILED, &message),
    }
}

async fn invoices(buyer: Buyer, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list invoices";
    let db = &buyer.portal.db;
    let party = &buyer.session.party_id;
    let limit = js_limit(query_param(query.as_deref(), "limit").as_deref(), 25.0, 100.0);
    let run = async {
        let (given, cursor) = cursor_of(db, "invoices", query.as_deref()).await?;
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(invoices),
            " from invoices t where t.deleted_at is null and t.counterparty_id = $1 and t.status <> 'draft' \
             and ($2::text is null or t.created_at < $2::timestamp or (t.created_at = $2::timestamp and t.id < $3::text)) \
             order by t.created_at desc, t.id desc limit $4"
        ))
        .bind(party)
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(sql_limit(limit))
        .fetch_all(db)
        .await?;
        // `conditions.slice(0, -1)` with a cursor: the keyset condition, or
        // the draft filter when the cursor row is gone.
        let skip_draft = given && cursor.is_none();
        let total: i64 = sqlx::query_scalar(
            "select count(*) from invoices t where t.deleted_at is null and t.counterparty_id = $2 \
             and ($1::boolean or t.status <> 'draft')",
        )
        .bind(skip_draft)
        .bind(party)
        .fetch_one(db)
        .await?;
        Ok::<_, sqlx::Error>(page(
            rows.into_iter().map(|r| tables::INVOICES.js(r)).collect(),
            limit,
            Some(total),
        ))
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}

/// `loadPortalInvoice(db, invoiceId, partyId)`: the buyer's invoice, never a draft.
pub(crate) async fn load_portal_invoice(db: &PgPool, id: &str, party_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(invoices),
        " from invoices t where t.id = $1 and t.counterparty_id = $2 and t.status <> 'draft' \
         and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(party_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| tables::INVOICES.js(row)))
}

async fn invoice(buyer: Buyer, Path(id): Path<String>) -> Response {
    let db = &buyer.portal.db;
    let run = async {
        let Some(invoice) = load_portal_invoice(db, &id, &buyer.session.party_id).await? else {
            return Ok(ApiError::not_found("Invoice", Some(&id)).into_response());
        };
        let items: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(invoice_items),
            " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null order by t.sort_order"
        ))
        .bind(&id)
        .fetch_all(db)
        .await?;
        let items = items.into_iter().map(|r| tables::INVOICE_ITEMS.js(r)).collect();
        Ok::<_, sqlx::Error>(Data(with_items(invoice, items)).into_response())
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal("Failed to fetch invoice", &e),
    }
}

/// The invoice as printable HTML (`renderPortalInvoiceHtml`): its 404s as
/// the worker answers them; the document itself waits for the WeldBooks
/// invoice generator (see [`crate::invoice_html`]).
async fn invoice_document(buyer: Buyer, Path(id): Path<String>) -> Response {
    use crate::invoice_html::{InvoiceDocument, portal_invoice_document};
    match portal_invoice_document(&buyer.portal.db, &id, &buyer.session.party_id).await {
        Ok(InvoiceDocument::NotFound) => ApiError::not_found("Invoice", Some(&id)).into_response(),
        Ok(InvoiceDocument::Unavailable) => {
            ApiError::unavailable("Invoice documents are not available on this edition yet").into_response()
        }
        Err(error) => internal("Failed to generate invoice document", &error),
    }
}

async fn return_reasons(buyer: Buyer) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(return_reasons),
        " from return_reasons t where t.deleted_at is null order by t.display_order, t.label"
    ))
    .fetch_all(&buyer.portal.db)
    .await;
    match rows {
        Ok(rows) => all(rows.into_iter().map(|r| tables::RETURN_REASONS.js(r)).collect()),
        Err(e) => internal("Failed to list return reasons", &e),
    }
}

async fn returns(buyer: Buyer, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list returns";
    let db = &buyer.portal.db;
    let limit = js_limit(query_param(query.as_deref(), "limit").as_deref(), 25.0, 100.0);
    let run = async {
        let order_ids: Vec<String> =
            sqlx::query_scalar("select id from orders where counterparty_id = $1 and deleted_at is null")
                .bind(&buyer.session.party_id)
                .fetch_all(db)
                .await?;
        if order_ids.is_empty() {
            return Ok(all(Vec::new()));
        }
        let (_, cursor) = cursor_of(db, "returns", query.as_deref()).await?;
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(returns),
            " from returns t where t.deleted_at is null and t.original_order_id = any($1) \
             and ($2::text is null or t.created_at < $2::timestamp or (t.created_at = $2::timestamp and t.id < $3::text)) \
             order by t.created_at desc, t.id desc limit $4"
        ))
        .bind(&order_ids)
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(sql_limit(limit))
        .fetch_all(db)
        .await?;
        // `cursorPagination(data.length, …)`: the page's own length.
        Ok::<_, sqlx::Error>(page(rows.into_iter().map(|r| tables::RETURNS.js(r)).collect(), limit, None))
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}

async fn return_detail(buyer: Buyer, Path(id): Path<String>) -> Response {
    let db = &buyer.portal.db;
    let run = async {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(returns),
            " from returns t where t.id = $1 and t.deleted_at is null limit 1"
        ))
        .bind(&id)
        .fetch_optional(db)
        .await?;
        let row = row.map(|r| tables::RETURNS.js(r));
        let Some(original) = row
            .as_ref()
            .and_then(|r| r.get("originalOrderId"))
            .and_then(Value::as_str)
            .filter(|o| !o.is_empty())
            .map(str::to_owned)
        else {
            return Ok(ApiError::not_found("Return", Some(&id)).into_response());
        };
        let order: Option<String> =
            sqlx::query_scalar("select id from orders where id = $1 and counterparty_id = $2 limit 1")
                .bind(&original)
                .bind(&buyer.session.party_id)
                .fetch_optional(db)
                .await?;
        if order.is_none() {
            return Ok(ApiError::not_found("Return", Some(&id)).into_response());
        }
        Ok::<_, sqlx::Error>(Data(row.unwrap_or(Value::Null)).into_response())
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal("Failed to fetch return", &e),
    }
}

/// `commercePortalCreateReturnSchema`, items stripped to their schema.
struct ReturnBody {
    original_order_id: String,
    reason: Option<String>,
    reason_details: Option<String>,
    items: Vec<Map<String, Value>>,
    customer_notes: Option<String>,
}

/// `z.number().int().positive()` (`.max(max)` when given): Zod checks each in order.
pub(crate) fn positive_int(issues: &mut Issues, fields: &Map<String, Value>, key: &str, max: Option<f64>) -> Option<f64> {
    let before = issues.count();
    let number = issues
        .number(
            fields,
            key,
            Presence::Required,
            Number {
                int: true,
                ..Number::default()
            },
        )
        .into_option();
    if let Some(Value::Number(raw)) = fields.get(key) {
        let value = raw.as_f64().unwrap_or(0.0);
        if value <= 0.0 {
            issues.issue_at(
                key,
                json!({
                    "code": "too_small",
                    "minimum": 0,
                    "type": "number",
                    "inclusive": false,
                    "exact": false,
                    "message": "Number must be greater than 0",
                }),
            );
        }
        if let Some(max) = max
            && value > max
        {
            issues.number_too_big(key, max, &format!("Number must be less than or equal to {}", crate::js::number_text(max)));
        }
    }
    if issues.count() > before {
        return None;
    }
    number
}

fn read_return(issues: &mut Issues, fields: &Map<String, Value>) -> ReturnBody {
    let original = issues.text_with(fields, "originalOrderId", Presence::Required, Text::length(Some(1), None));
    let reason = issues.text_with(fields, "reason", Presence::Optional, Text::length(None, Some(100)));
    let details = issues.text_with(fields, "reasonDetails", Presence::Optional, Text::length(None, Some(4000)));
    let items = issues.list(fields, "items", Presence::Required, Some(1), None, |issues, item| {
        let line = issues.object(item)?;
        let before = issues.count();
        issues.text_with(line, "productId", Presence::Optional, Text::default());
        issues.text_with(line, "productName", Presence::Required, Text::length(Some(1), None));
        issues.text_with(line, "sku", Presence::Optional, Text::default());
        positive_int(issues, line, "quantity", None);
        issues.text_with(line, "reason", Presence::Optional, Text::default());
        issues.choice(line, "condition", Presence::Optional, &["new", "opened", "damaged", "defective"]);
        if issues.count() > before {
            return None;
        }
        let mut kept = Map::new();
        for key in ["productId", "productName", "sku", "quantity", "reason", "condition"] {
            if let Some(value) = line.get(key) {
                kept.insert(key.to_owned(), value.clone());
            }
        }
        Some(kept)
    });
    let notes = issues.text_with(fields, "customerNotes", Presence::Optional, Text::length(None, Some(4000)));
    ReturnBody {
        original_order_id: original.into_option().unwrap_or_default(),
        reason: reason.into_option(),
        reason_details: details.into_option(),
        items: match items {
            Field::Set(items) => items,
            _ => Vec::new(),
        },
        customer_notes: notes.into_option(),
    }
}

/// `RMA-<Date.now() base 36>-<4 random base-36 characters>`.
fn return_number() -> String {
    crate::orders::numbered("RMA")
}

async fn create_return(State(state): State<CommerceState>, buyer: Buyer, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create return";
    let body = match validate(&headers, &body, read_return) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let db = &buyer.portal.db;
    let party = &buyer.session.party_id;
    let run = async {
        let order: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(orders),
            " from orders t where t.id = $1 and t.counterparty_id = $2 and t.deleted_at is null limit 1"
        ))
        .bind(&body.original_order_id)
        .bind(party)
        .fetch_optional(db)
        .await?;
        let Some(order) = order.map(|o| tables::ORDERS.js(o)) else {
            return Ok(ApiError::not_found("Order", Some(&body.original_order_id)).into_response());
        };
        let order_id = order.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let items: Vec<(Option<String>, String, i32)> =
            sqlx::query_as("select product_id, name, quantity from order_items where order_id = $1")
                .bind(&order_id)
                .fetch_all(db)
                .await?;
        // `item.productId || item.name`: the quantity on the order per product.
        let mut allowed: Vec<(String, f64)> = Vec::new();
        for (product_id, name, quantity) in items {
            let key = product_id.filter(|p| !p.is_empty()).unwrap_or(name);
            match allowed.iter_mut().find(|(k, _)| *k == key) {
                Some((_, total)) => *total += f64::from(quantity),
                None => allowed.push((key, f64::from(quantity))),
            }
        }
        for line in &body.items {
            let text = |key: &str| line.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
            let key = text("productId").or_else(|| text("productName")).unwrap_or_default();
            let quantity = line.get("quantity").and_then(Value::as_f64).unwrap_or(0.0);
            match allowed.iter().find(|(k, _)| k == key) {
                Some((_, max)) if quantity <= *max => {}
                _ => return Ok(ApiError::bad_request("Return items must be a subset of the original order").into_response()),
            }
        }
        let person: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("select display_name, email from people where id = $1 limit 1")
                .bind(&buyer.session.person_id)
                .fetch_optional(db)
                .await?;
        let (person_name, person_email) = person.unwrap_or_default();
        let id = generate_id("ret");
        let number = return_number();
        let now = now();
        let field = |key: &str| order.get(key).and_then(Value::as_str).map(str::to_owned);
        sqlx::query(
            "insert into returns (id, created_at, updated_at, return_number, status, original_order_id, customer_id, \
             customer_name, customer_email, reason, reason_details, items, customer_notes, approval_status) \
             values ($1, $2::timestamp, $2::timestamp, $3, 'requested', $4, $5, $6, $7, $8, $9, $10, $11, 'pending')",
        )
        .bind(&id)
        .bind(&now)
        .bind(&number)
        .bind(&order_id)
        .bind(party)
        .bind(person_name.or_else(|| field("customerName")))
        .bind(person_email.or_else(|| field("customerEmail")))
        .bind(body.reason.as_deref())
        .bind(body.reason_details.as_deref())
        .bind(Value::Array(body.items.iter().cloned().map(Value::Object).collect()))
        .bind(body.customer_notes.as_deref())
        .execute(db)
        .await?;
        let created: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            row_of!(returns),
            " from returns t where t.id = $1 limit 1"
        ))
        .bind(&id)
        .fetch_optional(db)
        .await?;
        buyer.portal.publish(
            &state,
            ev::RETURN_CREATED,
            &id,
            &json!({ "id": id, "returnNumber": number, "originalOrderId": order_id, "status": "requested" }),
        );
        Ok::<_, sqlx::Error>(
            Created(created.map_or(Value::Null, |r| tables::RETURNS.js(r))).into_response(),
        )
    };
    match run.await {
        Ok(response) => response,
        Err(e) => internal(FAILED, &e),
    }
}
