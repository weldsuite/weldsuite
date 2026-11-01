//! The B2B commerce portal's staff side (`/api/commerce-portal`,
//! `commerce-api/src/routes/commerce-portal/index.ts`): the portal settings,
//! who has access for a company, invites, revokes and resent invites. And
//! what the public side ([`crate::portal_public`]) shares with it: the
//! settings row, the company's party, sign-in challenges and the sign-in
//! mail (`services/commerce-portal.ts`, `services/commerce-portal-mail.ts`).
//!
//! Permissions: `companies:read` for reads, `companies:update` for the rest.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_commerce_domain::portal_tokens::{
    PortalChallenge, PortalKv, commerce_portal_origin, random_otp, random_token, sha256_hex,
    store_challenge,
};
use weldsuite_commerce_domain::rate_limit::{
    RATE_LIMIT_MAX, RATE_LIMIT_TTL_SECONDS, RateLimitCounters, RateLimitOutcome, consume_rate_limit,
};
use weldsuite_emails::portal::{PortalSignIn, sign_in};
use weldsuite_emails::{
    EmailBrand, EmailLocale, SYSTEM_FROM_ADDRESS, SystemEmail, send_system_email,
};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_mail_domain::outbound::mime::MailAddress;
use weldsuite_mail_domain::outbound::transmit::{SendEmailParams, send_email};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynSystemMail, MailTransport};

use crate::js::query_param;
use crate::tables;
use crate::{Caller, CommerceState, Overrides, Refusal, all, now, validate};

// ---------------------------------------------------------------------------
// Shared with the public portal
// ---------------------------------------------------------------------------

/// `loadPortalSettings(db)`: the live settings row, as Drizzle returns it.
pub(crate) async fn load_portal_settings(
    db: &PgPool,
) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(commerce_portal_settings),
        " from commerce_portal_settings t where t.deleted_at is null limit 1"
    ))
    .fetch_optional(db)
    .await?;
    Ok(
        row.and_then(|row| match tables::COMMERCE_PORTAL_SETTINGS.js(row) {
            Value::Object(map) => Some(map),
            _ => None,
        }),
    )
}

/// `isPortalEnabled(settings)`: `isEnabled === 1`.
pub(crate) fn is_portal_enabled(settings: Option<&Map<String, Value>>) -> bool {
    settings.is_some_and(|s| s.get("isEnabled").and_then(Value::as_f64) == Some(1.0))
}

/// `findCompanyParty(db, companyId)`: the company's live party, its id.
pub(crate) async fn find_company_party(
    db: &PgPool,
    company_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from parties where company_id = $1 and kind = 'company' and deleted_at is null limit 1",
    )
    .bind(company_id)
    .fetch_optional(db)
    .await
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// Where the portal's mail goes: the test's `SEND_EMAIL` (conformance; none
/// when it has none), else the deployment's system mail.
pub(crate) enum PortalMail {
    Transport(Arc<dyn MailTransport>),
    System(Arc<dyn DynSystemMail>),
    None,
}

impl PortalMail {
    pub(crate) fn of(overrides: &Overrides, state: &CommerceState) -> Self {
        if let Some(outbound) = &overrides.outbound {
            return outbound
                .0
                .transport
                .clone()
                .map_or(Self::None, Self::Transport);
        }
        state.mail.clone().map_or(Self::None, Self::System)
    }
}

/// What a sign-in mail and challenge need of the request.
pub(crate) struct SignInContext {
    pub(crate) kv: PortalKv,
    pub(crate) limiter: Option<Arc<dyn RateLimitCounters>>,
    pub(crate) mail: PortalMail,
    /// `commercePortalOrigin(env)`.
    pub(crate) origin: String,
}

impl SignInContext {
    pub(crate) fn of(overrides: &Overrides, state: &CommerceState) -> Self {
        Self {
            kv: overrides.kv(state),
            limiter: overrides.limiter(state),
            mail: PortalMail::of(overrides, state),
            origin: commerce_portal_origin(
                overrides.env(state, "COMMERCE_PORTAL_URL").as_deref(),
                overrides.env(state, "ENVIRONMENT").as_deref(),
            ),
        }
    }
}

/// The portal's brand fields of its settings (`CommercePortalBrand`).
pub(crate) struct PortalBrand {
    pub(crate) display_name: Option<String>,
    pub(crate) logo: Option<String>,
    pub(crate) accent_color: Option<String>,
}

impl PortalBrand {
    pub(crate) fn of(settings: &Map<String, Value>) -> Self {
        let text = |key: &str| settings.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            display_name: text("displayName"),
            logo: text("logo"),
            accent_color: text("accentColor"),
        }
    }
}

/// `sendPortalMagicLinkEmail(env, params)`: false when there is no
/// transport or the send failed (logged; the sign-in still goes on).
pub(crate) async fn send_magic_link(
    ctx: &SignInContext,
    to: &str,
    workspace_slug: &str,
    token: &str,
    otp: &str,
    company_name: Option<&str>,
    settings: Option<&PortalBrand>,
) -> bool {
    if matches!(ctx.mail, PortalMail::None) {
        return false;
    }
    let url = format!(
        "{}/{}/auth/callback?token={}",
        ctx.origin,
        encode_uri_component(workspace_slug),
        encode_uri_component(token)
    );
    let display_name = settings
        .and_then(|s| s.display_name.as_deref())
        .map(weldsuite_kit::validation::js_trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let portal_name = display_name.clone().unwrap_or_else(|| match company_name {
        Some(company) if !company.is_empty() => format!("{company} order portal"),
        _ => "Order portal".to_owned(),
    });
    let brand = match &display_name {
        Some(name) => EmailBrand::Workspace {
            name: name.clone(),
            logo_url: settings.and_then(|s| s.logo.clone()),
            accent_color: settings.and_then(|s| s.accent_color.clone()),
        },
        None => EmailBrand::weldsuite("WeldCommerce"),
    };
    let rendered = match sign_in(
        EmailLocale::En,
        &brand,
        &PortalSignIn {
            portal_name,
            code: otp.to_owned(),
            url: Some(url),
            expires_in_minutes: Some(15),
        },
    ) {
        Ok(rendered) => rendered,
        Err(error) => {
            tracing::warn!(%error, "[app-api/commerce-portal] magic-link email skipped");
            return false;
        }
    };
    let recipient = weldsuite_kit::validation::js_trim(to).to_owned();
    let from_name = display_name.unwrap_or_else(|| brand.sender_name().to_owned());
    let sent = match &ctx.mail {
        PortalMail::System(system) => {
            let mut email = SystemEmail::to(rendered, brand, &recipient);
            email.from_name = Some(from_name);
            send_system_email(system.as_ref(), email)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        PortalMail::Transport(transport) => {
            if recipient.is_empty() {
                Err("sendSystemEmail(portal.sign-in): no recipients".to_owned())
            } else {
                let from = MailAddress {
                    email: SYSTEM_FROM_ADDRESS.to_owned(),
                    name: Some(from_name),
                };
                let params = SendEmailParams {
                    from: from.formatted(),
                    to: vec![recipient],
                    cc: Vec::new(),
                    bcc: Vec::new(),
                    subject: rendered.subject,
                    text: Some(rendered.text),
                    html: Some(rendered.html),
                    reply_to: None,
                    headers: Vec::new(),
                    attachments: Vec::new(),
                };
                send_email(transport.as_ref(), &params)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }
        PortalMail::None => return false,
    };
    match sent {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, "[app-api/commerce-portal] magic-link email skipped");
            false
        }
    }
}

/// A new sign-in challenge for `email` (its link token and code, hashed).
pub(crate) fn new_challenge(
    workspace_id: &str,
    email: &str,
    access_ids: Vec<String>,
) -> (PortalChallenge, String, String) {
    let token = random_token(32);
    let otp = random_otp();
    let challenge = PortalChallenge {
        token_hash: sha256_hex(&token),
        otp_hash: sha256_hex(&otp),
        email: weldsuite_kit::validation::js_trim(email).to_lowercase(),
        workspace_id: workspace_id.to_owned(),
        access_ids,
        attempts: 0,
    };
    (challenge, token, otp)
}

// ---------------------------------------------------------------------------
// Staff routes
// ---------------------------------------------------------------------------

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::COMPANIES_READ]);
    let update = || gate.require([perm::COMPANIES_UPDATE]);
    Router::new()
        .route("/settings", get(get_settings).route_layer(read()))
        .route(
            "/settings",
            axum::routing::patch(patch_settings).route_layer(update()),
        )
        .route("/access", get(list_access).route_layer(read()))
        .route("/access/invite", post(invite).route_layer(update()))
        .route("/access/{id}/revoke", post(revoke).route_layer(update()))
        .route("/access/{id}/resend", post(resend).route_layer(update()))
}

/// `workspaceSlug(env, workspaceId)`: the master database's slug, or none
/// (a failed lookup is logged and reads as none).
async fn workspace_slug(caller: &Caller, state: &CommerceState) -> Option<String> {
    if caller.workspace_id.is_empty() {
        return None;
    }
    let Some(master) = caller.overrides.master(state) else {
        tracing::warn!(
            "[app-api/commerce-portal] workspace slug lookup failed: no master database"
        );
        return None;
    };
    let row: Result<Option<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select slug from workspaces where id = $1 limit 1")
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await;
    match row {
        Ok(slug) => slug.flatten(),
        Err(error) => {
            tracing::warn!(%error, "[app-api/commerce-portal] workspace slug lookup failed");
            None
        }
    }
}

/// `${commercePortalOrigin(env)}/${encodeURIComponent(slug)}`.
fn portal_url(caller: &Caller, state: &CommerceState, slug: Option<&str>) -> Value {
    let origin = commerce_portal_origin(
        caller
            .overrides
            .env(state, "COMMERCE_PORTAL_URL")
            .as_deref(),
        caller.overrides.env(state, "ENVIRONMENT").as_deref(),
    );
    slug.filter(|s| !s.is_empty()).map_or(Value::Null, |slug| {
        json!(format!("{origin}/{}", encode_uri_component(slug)))
    })
}

/// `settingsPayload(row, { portalUrl, workspaceSlug })`.
fn settings_payload(
    row: Option<&Map<String, Value>>,
    portal_url: &Value,
    slug: Option<&str>,
) -> Value {
    let field = |key: &str| row.and_then(|r| r.get(key)).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "isEnabled": is_portal_enabled(row),
        "displayName": field("displayName"),
        "logo": field("logo"),
        "primaryColor": field("primaryColor"),
        "accentColor": field("accentColor"),
        "portalUrl": portal_url,
        "workspaceSlug": slug,
    })
}

async fn get_settings(State(state): State<CommerceState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to load portal settings";
    let row = match load_portal_settings(&caller.db).await {
        Ok(row) => row,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let slug = workspace_slug(&caller, &state).await;
    let url = portal_url(&caller, &state, slug.as_deref());
    Data(settings_payload(row.as_ref(), &url, slug.as_deref())).into_response()
}

/// `updateCommercePortalSettingsSchema`: the fields the body sets (a
/// `null` clears one).
fn read_settings(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    issues.boolean(fields, "isEnabled", Presence::Optional);
    for (key, max) in [
        ("displayName", 255),
        ("logo", 500),
        ("primaryColor", 20),
        ("accentColor", 20),
    ] {
        issues.text_with(
            fields,
            key,
            Presence::Nullish,
            Text::length(None, Some(max)),
        );
    }
    let mut body = Map::new();
    for key in [
        "isEnabled",
        "displayName",
        "logo",
        "primaryColor",
        "accentColor",
    ] {
        if let Some(value) = fields.get(key) {
            body.insert(key.to_owned(), value.clone());
        }
    }
    body
}

async fn find_settings_by_id(
    db: &PgPool,
    id: &str,
) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(commerce_portal_settings),
        " from commerce_portal_settings t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(
        row.and_then(|row| match tables::COMMERCE_PORTAL_SETTINGS.js(row) {
            Value::Object(map) => Some(map),
            _ => None,
        }),
    )
}

async fn patch_settings(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update portal settings";
    let body = match validate(&headers, &body, read_settings) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let now = now();
    let t = &tables::COMMERCE_PORTAL_SETTINGS;
    let enabled = |value: Option<&Value>| json!(i32::from(value == Some(&Value::Bool(true))));
    let written = async {
        let existing = load_portal_settings(&caller.db)
            .await
            .map_err(crate::table::WriteError::Database)?;
        if let Some(existing) = existing {
            let id = existing
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let mut values = Map::new();
            t.set(&mut values, "updatedAt", json!(now));
            if body.contains_key("isEnabled") {
                t.set(&mut values, "isEnabled", enabled(body.get("isEnabled")));
            }
            for key in ["displayName", "logo", "primaryColor", "accentColor"] {
                if let Some(value) = body.get(key) {
                    t.set(&mut values, key, value.clone());
                }
            }
            t.patch(&caller.db, &id, values, false, &["updatedAt"])
                .await?;
            return find_settings_by_id(&caller.db, &id)
                .await
                .map_err(crate::table::WriteError::Database);
        }
        let id = generate_id("cps");
        let mut values = Map::new();
        t.set(&mut values, "id", json!(id));
        t.set(&mut values, "createdAt", json!(now));
        t.set(&mut values, "updatedAt", json!(now));
        t.set(&mut values, "isEnabled", enabled(body.get("isEnabled")));
        // `body.x ?? undefined`: a null leaves the column to its default.
        for key in ["displayName", "logo", "primaryColor", "accentColor"] {
            if let Some(value) = body.get(key).filter(|v| !v.is_null()) {
                t.set(&mut values, key, value.clone());
            }
        }
        t.insert(&caller.db, values, &["createdAt", "updatedAt"])
            .await?;
        find_settings_by_id(&caller.db, &id)
            .await
            .map_err(crate::table::WriteError::Database)
    }
    .await;
    let row = match written {
        Ok(row) => row,
        Err(error) => return crate::crud::write_failed(&error, FAILED),
    };
    let slug = workspace_slug(&caller, &state).await;
    let url = portal_url(&caller, &state, slug.as_deref());
    Data(settings_payload(row.as_ref(), &url, slug.as_deref())).into_response()
}

async fn list_access(
    State(_state): State<CommerceState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to list portal access";
    let Some(company_id) = query_param(query.as_deref(), "companyId").filter(|c| !c.is_empty())
    else {
        return ApiError::bad_request("companyId is required").into_response();
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(commerce_portal_access),
        " from commerce_portal_access t where t.company_id = $1 order by t.updated_at desc"
    ))
    .bind(&company_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => all(rows
            .into_iter()
            .map(|row| tables::COMMERCE_PORTAL_ACCESS.js(row))
            .collect()),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

/// An access row by id, as Drizzle returns it.
pub(crate) async fn find_access(
    db: &PgPool,
    id: &str,
) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(commerce_portal_access),
        " from commerce_portal_access t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(
        row.and_then(|row| match tables::COMMERCE_PORTAL_ACCESS.js(row) {
            Value::Object(map) => Some(map),
            _ => None,
        }),
    )
}

/// `issueChallengeAndEmail(opts)`: staff-triggered, so a refused or
/// unreachable limit only skips the challenge and the mail.
#[allow(clippy::too_many_arguments)]
async fn issue_challenge_and_email(
    ctx: &SignInContext,
    workspace_id: &str,
    slug: Option<&str>,
    email: &str,
    access_ids: Vec<String>,
    company_name: Option<&str>,
    settings: Option<&PortalBrand>,
) -> Result<(), weldsuite_ports::PortError> {
    let outcome = consume_rate_limit(
        ctx.limiter.as_ref(),
        workspace_id,
        &format!("invite:{email}"),
        RATE_LIMIT_MAX,
        RATE_LIMIT_TTL_SECONDS,
    )
    .await;
    if outcome != RateLimitOutcome::Allowed {
        return Ok(());
    }
    let (challenge, token, otp) = new_challenge(workspace_id, email, access_ids);
    store_challenge(&ctx.kv, &challenge, email).await?;
    if let Some(slug) = slug {
        send_magic_link(ctx, email, slug, &token, &otp, company_name, settings).await;
    }
    Ok(())
}

/// `inviteCommercePortalAccessSchema`.
fn read_invite(issues: &mut Issues, fields: &Map<String, Value>) -> (String, String) {
    let person = issues.text_with(
        fields,
        "personId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    let company = issues.text_with(
        fields,
        "companyId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    (
        person.into_option().unwrap_or_default(),
        company.into_option().unwrap_or_default(),
    )
}

/// What can go wrong after validation: a refusal, a statement or the KV.
enum Failure {
    Refusal(Refusal),
    Kv(weldsuite_ports::PortError),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<Refusal> for Failure {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

impl Failure {
    fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Refusal(refusal) => refusal.respond(fallback),
            Self::Kv(error) => {
                tracing::error!(%error, "[app-api/commerce-portal] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

async fn invite(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to invite portal user";
    let (person_id, company_id) = match validate(&headers, &body, read_invite) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match invite_access(&state, &caller, &person_id, &company_id).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

#[allow(clippy::too_many_lines)] // the TypeScript route, step by step
async fn invite_access(
    state: &CommerceState,
    caller: &Caller,
    person_id: &str,
    company_id: &str,
) -> Result<Response, Failure> {
    let db = &caller.db;
    let person: Option<Option<String>> =
        sqlx::query_scalar("select email from people where id = $1 and deleted_at is null limit 1")
            .bind(person_id)
            .fetch_optional(db)
            .await?;
    let Some(email) = person else {
        return Err(Refusal::not_found("Person", person_id).into());
    };
    let email = email
        .map(|e| weldsuite_kit::validation::js_trim(&e).to_lowercase())
        .filter(|e| !e.is_empty());
    let Some(email) = email else {
        return Err(Refusal::bad_request("Person must have an email address").into());
    };
    let company: Option<Option<String>> = sqlx::query_scalar(
        "select display_name from companies where id = $1 and deleted_at is null limit 1",
    )
    .bind(company_id)
    .fetch_optional(db)
    .await?;
    let Some(company_name) = company else {
        return Err(Refusal::not_found("Company", company_id).into());
    };
    let link: Option<Option<String>> = sqlx::query_scalar(
        "select ended_at::text from person_companies where person_id = $1 and company_id = $2 limit 1",
    )
    .bind(person_id)
    .bind(company_id)
    .fetch_optional(db)
    .await?;
    if !matches!(link, Some(None)) {
        return Err(Refusal::bad_request("Person is not an active contact at this company").into());
    }
    if find_company_party(db, company_id).await?.is_none() {
        return Err(Refusal::bad_request("Company has no commercial party record").into());
    }

    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, status from commerce_portal_access where person_id = $1 and company_id = $2 limit 1",
    )
    .bind(person_id)
    .bind(company_id)
    .fetch_optional(db)
    .await?;
    let now = now();
    let access_id = if let Some((id, status)) = &existing {
        sqlx::query(
            "update commerce_portal_access set email = $1, status = $2, invited_by = $3, \
             invited_at = $4::timestamp, updated_at = $4::timestamp where id = $5",
        )
        .bind(&email)
        .bind(if status == "active" {
            "active"
        } else {
            "invited"
        })
        .bind(&caller.user_id)
        .bind(&now)
        .bind(id)
        .execute(db)
        .await?;
        id.clone()
    } else {
        let id = generate_id("cpa");
        sqlx::query(
            "insert into commerce_portal_access (id, created_at, updated_at, person_id, company_id, email, status, \
             invited_by, invited_at) values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, 'invited', $6, $2::timestamp)",
        )
        .bind(&id)
        .bind(&now)
        .bind(person_id)
        .bind(company_id)
        .bind(&email)
        .bind(&caller.user_id)
        .execute(db)
        .await?;
        id
    };

    let slug = workspace_slug(caller, state).await;
    if !caller.workspace_id.is_empty() {
        let settings = load_portal_settings(db).await?;
        let brand = settings.as_ref().map(PortalBrand::of);
        let ctx = SignInContext::of(&caller.overrides, state);
        issue_challenge_and_email(
            &ctx,
            &caller.workspace_id,
            slug.as_deref(),
            &email,
            vec![access_id.clone()],
            company_name.as_deref(),
            brand.as_ref(),
        )
        .await
        .map_err(Failure::Kv)?;
    }

    let row = find_access(db, &access_id).await?;
    let row = row.map_or(Value::Null, Value::Object);
    Ok(if existing.is_some() {
        Data(row).into_response()
    } else {
        (StatusCode::CREATED, axum::Json(json!({ "data": row }))).into_response()
    })
}

async fn revoke(
    State(_state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to revoke portal access";
    let run = async {
        if find_access(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Portal access", &id));
        }
        sqlx::query("update commerce_portal_access set status = 'revoked', updated_at = $1::timestamp where id = $2")
            .bind(now())
            .bind(&id)
            .execute(&caller.db)
            .await?;
        Ok(find_access(&caller.db, &id).await?)
    };
    match run.await {
        Ok(row) => Data(row.map_or(Value::Null, Value::Object)).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn resend(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to resend invite";
    let run = async {
        let Some(existing) = find_access(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Portal access", &id).into());
        };
        let text = |key: &str| {
            existing
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        if text("status") == "revoked" {
            return Err(Refusal::bad_request("Access is revoked").into());
        }
        let company: Option<Option<String>> =
            sqlx::query_scalar("select display_name from companies where id = $1 limit 1")
                .bind(text("companyId"))
                .fetch_optional(&caller.db)
                .await?;
        let slug = workspace_slug(&caller, &state).await;
        if !caller.workspace_id.is_empty() {
            let ctx = SignInContext::of(&caller.overrides, &state);
            issue_challenge_and_email(
                &ctx,
                &caller.workspace_id,
                slug.as_deref(),
                &text("email"),
                vec![text("id")],
                company.flatten().as_deref(),
                None,
            )
            .await
            .map_err(Failure::Kv)?;
        }
        Ok::<_, Failure>(())
    };
    match run.await {
        Ok(()) => Data(json!({ "ok": true })).into_response(),
        Err(failure) => failure.respond(FAILED),
    }
}
