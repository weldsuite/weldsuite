//! The 13 `/api/onboarding` routes, as app-api answers them.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header::CONTENT_TYPE;
use http::{HeaderMap, StatusCode};
use serde::Serialize;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Issues, Presence, Text, js_trim, json_body};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_ports::{
    Identity, IdentityError, IdentityResult, NewInvitation, UserChanges, UserProfile, with_identity,
};

use crate::caller::OnboardingCaller;
use crate::territory::{
    RequestError, RequestNotice, WorkspaceRequest, create_workspace_request, is_country_code,
    normalize_country_code, partner_admin_emails, request_country, territory_partner,
    territory_refusal,
};
use crate::{OnboardingState, WorkspaceService};

/// `DEFAULT_WORKSPACE_APPS`: the "New workspace" dialog's default set.
const DEFAULT_WORKSPACE_APPS: [&str; 5] = ["crm", "projects", "weldconnect", "mail", "helpdesk"];

pub(crate) fn router() -> Router<OnboardingState> {
    Router::new()
        .route("/create-workspace", post(create_workspace))
        .route("/partner-request", post(partner_request))
        .route("/status", get(status))
        .route("/database-status", get(database_status))
        .route("/user-info", get(user_info))
        .route("/available-apps", get(available_apps))
        .route("/profile", post(profile))
        .route("/workspace", post(workspace))
        .route("/role", post(role))
        .route("/invitations", post(invitations))
        .route("/complete", post(complete))
        .route("/retry", post(retry))
        .route("/finalize", post(finalize))
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn ok(value: Value) -> Response {
    Data(value).into_response()
}

fn not_authenticated() -> Response {
    ApiError::unauthorized()
        .with_message("Not authenticated")
        .into_response()
}

fn internal(message: &str) -> Response {
    ApiError::internal().with_message(message).into_response()
}

fn no_workspace_service() -> Response {
    tracing::error!("onboarding: no workspace service is configured");
    internal("Workspace service not configured")
}

/// `zValidator('json', schema)`: the fields read by `read`, or the 400.
fn validate<T>(
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

/// `fetchClerkUser`: the basics, empty when the provider refuses; `Err`
/// when it cannot be reached (the workers' `fetch` throwing).
#[derive(Debug, Default)]
struct UserBasics {
    email: String,
    picture: String,
    first_name: String,
    last_name: String,
}

impl UserBasics {
    fn of(profile: &UserProfile) -> Self {
        Self {
            email: profile.first_email().unwrap_or_default().to_owned(),
            picture: profile.image_url.clone().unwrap_or_default(),
            first_name: profile.first_name.clone().unwrap_or_default(),
            last_name: profile.last_name.clone().unwrap_or_default(),
        }
    }

    /// `[firstName, lastName].filter(Boolean).join(' ')`.
    fn full_name(&self) -> String {
        [self.first_name.as_str(), self.last_name.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

async fn user_basics(
    identity: Option<&Arc<dyn Identity>>,
    user_id: &str,
) -> Result<UserBasics, IdentityError> {
    match with_identity(identity, |i| i.user_profile(user_id)).await {
        Ok(profile) => Ok(UserBasics::of(&profile)),
        Err(IdentityError::Rejected { .. }) => Ok(UserBasics::default()),
        Err(error) => Err(error),
    }
}

/// A call whose refusal is ignored (`await fetch(…)` without a look at
/// `res.ok`); `Err` only when the provider cannot be reached.
fn ignore_refusal(result: IdentityResult<()>) -> Result<(), IdentityError> {
    match result {
        Ok(()) | Err(IdentityError::Rejected { .. }) => Ok(()),
        Err(error) => Err(error),
    }
}

/// The workspace service's answer, as the routes that create a workspace
/// write it (`{ success, organizationId, workspaceId, ready }`).
fn created_workspace(outcome: &crate::OnboardOutcome) -> Response {
    ok(json!({
        "success": true,
        "organizationId": outcome.clerk_org_id,
        "workspaceId": outcome.workspace_id,
        "ready": outcome.ready,
    }))
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(value)` for what `[a, b].filter(Boolean).join(' ')` meets.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => String::new(),
        other => other.to_string(),
    }
}

// ── POST /create-workspace ──────────────────────────────────────────────────

struct CreateWorkspace {
    name: String,
    region: Option<String>,
    country: Option<String>,
    selected_apps: Option<Vec<String>>,
}

async fn create_workspace(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| CreateWorkspace {
        name: issues
            .text(fields, "name", Presence::Required, Some(1), Some(255))
            .into_option()
            .unwrap_or_default(),
        region: issues
            .text(fields, "region", Presence::Optional, None, None)
            .into_option(),
        country: issues
            .text(fields, "country", Presence::Optional, None, Some(64))
            .into_option(),
        selected_apps: issues
            .list(
                fields,
                "selectedApps",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option(),
    }) {
        Ok(input) => input,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let name = js_trim(&input.name).to_owned();
    if name.is_empty() {
        return ApiError::bad_request("Workspace name is required").into_response();
    }
    let master = caller.master(&state);
    match territory_refusal(&master, &headers).await {
        Ok(Some(refusal)) => return refusal,
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "onboarding: territory lookup failed");
            return ApiError::internal().into_response();
        }
    }
    let apps: Vec<String> = match input.selected_apps {
        Some(apps) if !apps.is_empty() => apps,
        _ => DEFAULT_WORKSPACE_APPS
            .iter()
            .map(|a| (*a).to_owned())
            .collect(),
    };
    let Some(service) = state.workspace_service.clone() else {
        return no_workspace_service();
    };
    let identity = caller.identity(&state);
    let user = match user_basics(identity.as_ref(), &user_id).await {
        Ok(user) => user,
        Err(error) => {
            tracing::error!(%error, "onboarding: error creating an additional workspace");
            return internal("Failed to create workspace");
        }
    };
    let mut request = json!({
        "clerkUserId": user_id,
        "workspaceName": name,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "selectedApps": apps,
        "createNewOrg": true,
        "seedSampleData": false,
        "initialMember": { "email": user.email, "name": user.full_name(), "picture": user.picture },
    });
    if let Some(region) = input.region {
        request["region"] = json!(region);
    }
    if let Some(country) = normalize_country_code(input.country.as_deref()) {
        request["country"] = json!(country);
    }
    let outcome = service.onboard(&request).await;
    if !outcome.success {
        tracing::warn!(error = ?outcome.error, "onboarding: create-workspace failed");
        return internal(
            outcome
                .error
                .as_deref()
                .unwrap_or("Failed to create workspace"),
        );
    }
    created_workspace(&outcome)
}

// ── POST /partner-request ───────────────────────────────────────────────────

struct PartnerRequestInput {
    company_name: String,
    selected_apps: Vec<String>,
    message: Option<String>,
}

/// `appCodeSchema`: trimmed, `^[a-z][a-z0-9-]{1,49}$`.
fn is_app_code(code: &str) -> bool {
    let code = js_trim(code);
    let bytes = code.as_bytes();
    (2..=50).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

#[allow(clippy::too_many_lines)] // one route, in the order TypeScript checks
async fn partner_request(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let company_name = issues
            .text_with(
                fields,
                "companyName",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option()
            .unwrap_or_default();
        // `countryCodeSchema`: trimmed, exactly two characters, upper-cased,
        // then a refinement (settled after the other fields).
        let country = issues
            .text_with(
                fields,
                "country",
                Presence::Required,
                Text::trimmed(None, None),
            )
            .into_option();
        let mut country_refused = false;
        if let Some(country) = &country {
            let length = country.encode_utf16().count();
            if length == 2 {
                country_refused = !is_country_code(&country.to_uppercase());
            } else {
                issues.string_length("country", 2, length);
            }
        }
        let selected_apps = issues
            .list(
                fields,
                "selectedApps",
                Presence::Optional,
                None,
                Some(50),
                |issues, item| {
                    issues
                        .item_pattern(item, Text::trimmed(None, None), is_app_code, "App code")
                        .map(|code| js_trim(&code).to_owned())
                },
            )
            .into_option()
            .unwrap_or_default();
        let message = issues
            .text_with(
                fields,
                "message",
                Presence::Optional,
                Text::trimmed(None, Some(2000)),
            )
            .into_option();
        if country_refused {
            issues.custom("country", "ISO 3166-1 alpha-2 country code");
        }
        PartnerRequestInput {
            company_name,
            selected_apps,
            message,
        }
    }) {
        Ok(input) => input,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let master = caller.master(&state);
    let country = request_country(&headers);
    let partner = match territory_partner(&master, country.as_deref()).await {
        Ok(partner) => partner,
        Err(error) => {
            tracing::error!(%error, "onboarding: territory lookup failed");
            return ApiError::internal().into_response();
        }
    };
    let (Some(partner), Some(country)) = (partner, country) else {
        return ApiError::not_found("Partner for this country", None).into_response();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error creating a partner request");
        internal("Failed to send your request")
    };
    let identity = caller.identity(&state);
    let user = match user_basics(identity.as_ref(), &user_id).await {
        Ok(user) => user,
        Err(error) => return failed(&error),
    };
    if user.email.is_empty() {
        return ApiError::bad_request("Your account has no email address").into_response();
    }
    let requester_name = Some(user.full_name()).filter(|name| !name.is_empty());
    let request = WorkspaceRequest {
        partner_id: &partner.id,
        requester_user_id: &user_id,
        requester_email: &user.email,
        requester_name: requester_name.as_deref(),
        company_name: &input.company_name,
        country_code: &country,
        selected_apps: &input.selected_apps,
        message: input.message.as_deref(),
    };
    let id = match create_workspace_request(&master, &request).await {
        Ok(id) => id,
        Err(RequestError::RateLimited) => {
            return ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests today. Try again tomorrow.",
            )
            .into_response();
        }
        Err(RequestError::Database(error)) => return failed(&error),
    };
    if let Some(mail) = state.mail.clone() {
        let notice = RequestNotice {
            to: Vec::new(),
            partner_name: partner.name.clone(),
            company_name: input.company_name.clone(),
            country_code: country.clone(),
            requester_email: user.email.clone(),
            requester_name,
            selected_apps: input.selected_apps.clone(),
            message: input.message.clone(),
            portal_url: caller
                .setting("PARTNER_PORTAL_URL")
                .unwrap_or_else(|| "https://partner.weldsuite.org".to_owned()),
            from: caller
                .setting("SYSTEM_EMAIL_FROM")
                .unwrap_or_else(|| "notifications@mail.weldsuite.org".to_owned()),
        };
        let partner_id = partner.id.clone();
        state.events.tracker().spawn(async move {
            match partner_admin_emails(&master, &partner_id).await {
                Ok(to) => RequestNotice { to, ..notice }.send(mail.as_ref()).await,
                Err(error) => {
                    tracing::error!(%error, "onboarding: partner request notification failed");
                }
            }
        });
    }
    Created(json!({ "id": id })).into_response()
}

// ── GET /status ─────────────────────────────────────────────────────────────

async fn status(State(state): State<OnboardingState>, caller: OnboardingCaller) -> Response {
    let none = || ok(json!({ "completed": false, "hasOrganization": false }));
    let (Some(_), Some(org)) = (&caller.user_id, &caller.org_id) else {
        return none();
    };
    let completed: Result<Option<bool>, sqlx::Error> = sqlx::query_scalar(
        "select onboarding_completed_at is not null from workspaces where clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(&caller.master(&state))
    .await;
    match completed {
        Ok(completed) => ok(json!({
            "completed": completed.unwrap_or(false),
            "hasOrganization": true,
        })),
        Err(error) => {
            tracing::error!(%error, "onboarding: error checking status");
            none()
        }
    }
}

// ── GET /database-status ────────────────────────────────────────────────────

async fn database_status(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
) -> Response {
    let pending = || {
        ok(json!({ "provisioned": false, "migrated": false, "status": "pending", "failed": false }))
    };
    let Some(org) = &caller.org_id else {
        return pending();
    };
    let row: Result<Option<(bool, bool, Option<String>)>, sqlx::Error> = sqlx::query_as(
        "select neon_project_id is not null and neon_project_id <> '',
                database_provisioned_at is not null, provisioning_status
           from workspaces where clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(&caller.master(&state))
    .await;
    match row {
        Ok(Some((project, provisioned_at, status))) => {
            let provisioned = project && provisioned_at;
            let failed = !provisioned && status.as_deref() == Some("failed");
            let status = if provisioned {
                "ready".to_owned()
            } else {
                status.unwrap_or_else(|| "pending".to_owned())
            };
            ok(json!({
                "provisioned": provisioned,
                "migrated": provisioned,
                "status": status,
                "failed": failed,
            }))
        }
        Ok(None) => pending(),
        Err(error) => {
            tracing::error!(%error, "onboarding: error checking the database status");
            pending()
        }
    }
}

// ── GET /user-info ──────────────────────────────────────────────────────────

/// The wizard's prefill; `imageUrl` is left out when the provider has none.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserInfo {
    first_name: String,
    last_name: String,
    email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<String>,
}

async fn user_info(State(state): State<OnboardingState>, caller: OnboardingCaller) -> Response {
    let empty = || ok(json!({ "user": UserInfo::default(), "organization": null }));
    let Some(user_id) = &caller.user_id else {
        return empty();
    };
    let identity = caller.identity(&state);
    let user = match with_identity(identity.as_ref(), |i| i.user_profile(user_id)).await {
        Ok(profile) => UserInfo {
            first_name: profile.first_name.clone().unwrap_or_default(),
            last_name: profile.last_name.clone().unwrap_or_default(),
            email: profile.first_email().unwrap_or_default().to_owned(),
            image_url: profile.image_url.clone(),
        },
        Err(IdentityError::Rejected { .. }) => UserInfo::default(),
        Err(error) => {
            tracing::error!(%error, "onboarding: error getting user info");
            return empty();
        }
    };
    let mut organization = Value::Null;
    if let Some(org) = &caller.org_id {
        let name: Result<Option<String>, sqlx::Error> =
            sqlx::query_scalar("select name from workspaces where clerk_org_id = $1 limit 1")
                .bind(org)
                .fetch_optional(&caller.master(&state))
                .await;
        match name {
            Ok(Some(name)) => organization = json!({ "id": org, "name": name }),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "onboarding: error getting user info");
                return empty();
            }
        }
    }
    ok(json!({ "user": user, "organization": organization }))
}

// ── GET /available-apps ─────────────────────────────────────────────────────

/// A static catalog entry (`FALLBACK_CATALOG`), in the workers' key order.
#[derive(Serialize)]
struct FallbackApp {
    code: &'static str,
    name: &'static str,
    description: &'static str,
    icon: &'static str,
    category: &'static str,
    path: &'static str,
}

const fn app(
    code: &'static str,
    name: &'static str,
    description: &'static str,
    icon: &'static str,
    category: &'static str,
    path: &'static str,
) -> FallbackApp {
    FallbackApp {
        code,
        name,
        description,
        icon,
        category,
        path,
    }
}

/// `FALLBACK_CATALOG`, copied from the workers.
const FALLBACK_CATALOG: [FallbackApp; 12] = [
    app(
        "commerce",
        "Commerce",
        "Comprehensive e-commerce platform for online selling, product management, and order processing",
        "ShoppingCart",
        "Sales & Marketing",
        "/commerce",
    ),
    app(
        "crm",
        "CRM",
        "Manage leads, contacts, and sales pipelines",
        "Users",
        "Sales & Marketing",
        "/crm",
    ),
    app(
        "projects",
        "Projects",
        "Project management and collaboration tools for teams, tasks, timelines, and deliverables",
        "ClipboardList",
        "Productivity",
        "/projects",
    ),
    app(
        "weldconnect",
        "WeldConnect",
        "Workspace workflow automation — triggers, actions, integrations, and execution monitoring",
        "Zap",
        "Productivity",
        "/weldconnect",
    ),
    app(
        "helpdesk",
        "Helpdesk",
        "Customer support ticketing system for managing customer inquiries and support requests",
        "Headphones",
        "Customer Support",
        "/helpdesk",
    ),
    app(
        "mail",
        "Mail",
        "Email management and communication platform for team collaboration and customer outreach",
        "Mail",
        "Communication",
        "/mail",
    ),
    app(
        "parcel",
        "Parcel",
        "Parcel tracking and shipping management for deliveries, returns, and carrier integrations",
        "Package",
        "Operations",
        "/parcel",
    ),
    app(
        "host",
        "Host",
        "Domain management and hosting services for websites and online presence",
        "Globe",
        "Infrastructure",
        "/host",
    ),
    app(
        "weldsheets",
        "WeldSheets",
        "Spreadsheets with Excel-compatible formulas, number formats and multiple sheets",
        "FileSpreadsheet",
        "Productivity",
        "/weldsheets",
    ),
    app(
        "welddocs",
        "WeldDocs",
        "Documents with rich formatting, pages, headers and footers, tables and live co-editing",
        "FileText",
        "Productivity",
        "/welddocs",
    ),
    app(
        "weldpass",
        "WeldPass",
        "Team password manager with shared vaults, plus encrypted secret vaults for your apps synced to Cloudflare and Vercel",
        "KeyRound",
        "Infrastructure",
        "/weldpass",
    ),
    app(
        "weldhr",
        "WeldHR",
        "Employee records, onboarding, attendance, leave, coaching and evaluations, with a branded portal for your employees and clients",
        "UsersRound",
        "Operations",
        "/weldhr",
    ),
];

/// A published catalog row, mapped as the route maps it.
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct CatalogApp {
    code: String,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    path: Option<String>,
    overview: Option<String>,
    features: Option<Value>,
    how_it_works: Option<Value>,
    version: Option<String>,
    provider: Option<String>,
}

async fn available_apps(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
) -> Response {
    let rows: Result<Vec<CatalogApp>, sqlx::Error> = sqlx::query_as(
        "select code, name, description, icon, category, path, overview, features,
                how_it_works, version, provider
           from app_catalog where is_active = true and is_published = true",
    )
    .fetch_all(&caller.master(&state))
    .await;
    match rows {
        Ok(rows) if !rows.is_empty() => {
            let mapped: Vec<CatalogApp> = rows
                .into_iter()
                .map(|row| CatalogApp {
                    version: Some(
                        row.version
                            .clone()
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| "1.0.0".to_owned()),
                    ),
                    ..row
                })
                .collect();
            Data(mapped).into_response()
        }
        Ok(_) => Data(FALLBACK_CATALOG).into_response(),
        Err(error) => {
            tracing::error!(%error, "onboarding: error getting available apps");
            Data(FALLBACK_CATALOG).into_response()
        }
    }
}

// ── POST /profile ───────────────────────────────────────────────────────────

struct ProfileInput {
    first_name: Option<String>,
    last_name: Option<String>,
    phone: Option<String>,
    job_title: Option<String>,
    product_updates: Option<bool>,
}

async fn profile(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| ProfileInput {
        first_name: issues
            .text(fields, "firstName", Presence::Optional, None, None)
            .into_option(),
        last_name: issues
            .text(fields, "lastName", Presence::Optional, None, None)
            .into_option(),
        phone: issues
            .text(fields, "phone", Presence::Optional, None, None)
            .into_option(),
        job_title: issues
            .text(fields, "jobTitle", Presence::Optional, None, None)
            .into_option(),
        product_updates: issues
            .boolean(fields, "productUpdates", Presence::Optional)
            .into_option(),
    }) {
        Ok(input) => input,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error saving the profile");
        internal("Failed to save profile")
    };
    let identity = caller.identity(&state);
    let changes = UserChanges {
        first_name: input.first_name,
        last_name: input.last_name,
    };
    match with_identity(identity.as_ref(), |i| i.update_user(&user_id, &changes)).await {
        Ok(()) => {}
        Err(error @ IdentityError::Rejected { .. }) => {
            tracing::error!(%error, "onboarding: the provider refused the profile");
            return internal("Failed to update profile");
        }
        Err(error) => return failed(&error),
    }
    let mut metadata = Map::new();
    if let Some(updates) = input.product_updates {
        metadata.insert("productUpdates".to_owned(), json!(updates));
    }
    if let Some(phone) = input.phone.filter(|p| !p.is_empty()) {
        metadata.insert("phone".to_owned(), json!(phone));
    }
    if let Some(title) = input.job_title.filter(|t| !t.is_empty()) {
        metadata.insert("jobTitle".to_owned(), json!(title));
    }
    if !metadata.is_empty() {
        let metadata = Value::Object(metadata);
        let saved = with_identity(identity.as_ref(), |i| {
            i.update_user_metadata(&user_id, &metadata)
        })
        .await;
        if let Err(error) = ignore_refusal(saved) {
            return failed(&error);
        }
    }
    ok(json!({ "success": true }))
}

// ── POST /workspace ─────────────────────────────────────────────────────────

struct WorkspaceInput {
    name: String,
    country: Option<String>,
    referral_source: Option<String>,
}

async fn workspace(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| WorkspaceInput {
        name: issues
            .text(fields, "name", Presence::Required, Some(1), Some(255))
            .into_option()
            .unwrap_or_default(),
        country: issues
            .text(fields, "country", Presence::Optional, None, None)
            .into_option(),
        referral_source: issues
            .text(fields, "referralSource", Presence::Optional, None, None)
            .into_option(),
    }) {
        Ok(input) => input,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let Some(service) = state.workspace_service.clone() else {
        return no_workspace_service();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error creating the workspace");
        internal("Failed to create workspace")
    };
    match territory_refusal(&caller.master(&state), &headers).await {
        Ok(Some(refusal)) => return refusal,
        Ok(None) => {}
        Err(error) => return failed(&error),
    }
    let identity = caller.identity(&state);
    let user = match user_basics(identity.as_ref(), &user_id).await {
        Ok(user) => user,
        Err(error) => return failed(&error),
    };
    let mut request = json!({
        "clerkUserId": user_id,
        "workspaceName": input.name,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "initialMember": { "email": user.email, "name": user.full_name(), "picture": user.picture },
    });
    if let Some(country) = input.country {
        request["country"] = json!(country);
    }
    if let Some(source) = input.referral_source {
        request["referralSource"] = json!(source);
    }
    run_onboard(&service, &request).await
}

/// `onboard()` for `/workspace`: the created workspace, or the 500.
async fn run_onboard(service: &WorkspaceService, request: &Value) -> Response {
    let outcome = service.onboard(request).await;
    if !outcome.success {
        tracing::warn!(error = ?outcome.error, "onboarding: the workspace service failed");
        return internal(
            outcome
                .error
                .as_deref()
                .unwrap_or("Failed to create workspace"),
        );
    }
    created_workspace(&outcome)
}

// ── POST /role ──────────────────────────────────────────────────────────────

async fn role(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let role = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "role", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(role) => role,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let identity = caller.identity(&state);
    let metadata = json!({ "primaryRole": role });
    let saved = with_identity(identity.as_ref(), |i| {
        i.update_user_metadata(&user_id, &metadata)
    })
    .await;
    if let Err(error) = ignore_refusal(saved) {
        tracing::error!(%error, "onboarding: error saving the role");
        return internal("Failed to save role");
    }
    ok(json!({ "success": true }))
}

// ── POST /invitations ───────────────────────────────────────────────────────

struct Invite {
    email: String,
    role: String,
}

#[derive(Serialize)]
struct FailedInvite {
    email: String,
    error: String,
}

/// `invitationRedirectUrl`: the platform's `/invite?org_id=…`
/// (`PUBLIC_APP_URL`, else by `ENVIRONMENT`).
fn invitation_redirect_url(caller: &OnboardingCaller, org_id: &str) -> String {
    let configured = caller
        .setting("PUBLIC_APP_URL")
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty());
    let base = configured.unwrap_or_else(|| {
        match caller.setting("ENVIRONMENT").as_deref() {
            Some("test") => "https://app-test.weldsuite.org",
            Some("production") => "https://app.weldsuite.org",
            _ => "http://localhost:3000",
        }
        .to_owned()
    });
    let origin = base
        .find("://")
        .and_then(|scheme| {
            base[scheme + 3..]
                .find('/')
                .map(|path| base[..scheme + 3 + path].to_owned())
        })
        .unwrap_or(base);
    let encoded: String = org_id
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'*') {
                char::from(b).to_string()
            } else if b == b' ' {
                "+".to_owned()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("{origin}/invite?org_id={encoded}")
}

async fn invitations(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (organization_id, invites) = match validate(&headers, &body, |issues, fields| {
        let organization_id = issues
            .text(fields, "organizationId", Presence::Optional, None, None)
            .into_option();
        let invites = issues
            .list(
                fields,
                "invites",
                Presence::Optional,
                None,
                None,
                |issues, item| {
                    let fields = issues.object(item)?;
                    let email = issues.text(fields, "email", Presence::Required, None, None);
                    let role = issues.text(fields, "role", Presence::Required, None, None);
                    Some(Invite {
                        email: email.into_option()?,
                        role: role.into_option()?,
                    })
                },
            )
            .into_option();
        (organization_id, invites)
    }) {
        Ok(input) => input,
        Err(refusal) => return *refusal,
    };
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let (Some(org), Some(invites)) = (
        organization_id.filter(|org| !org.is_empty()),
        invites.filter(|invites| !invites.is_empty()),
    ) else {
        return ok(json!({ "success": true, "sent": 0, "failed": [] }));
    };
    let identity = caller.identity(&state);
    let redirect = invitation_redirect_url(&caller, &org);
    let mut sent = 0;
    let mut failed = Vec::new();
    for invite in invites {
        let invitation = NewInvitation {
            email_address: invite.email.clone(),
            role: if invite.role == "admin" {
                "org:admin"
            } else {
                "org:member"
            }
            .to_owned(),
            redirect_url: Some(redirect.clone()),
            public_metadata: None,
            inviter_user_id: Some(user_id.clone()),
        };
        match with_identity(identity.as_ref(), |i| i.invite(&org, &invitation)).await {
            Ok(_) => sent += 1,
            Err(IdentityError::Rejected { body, .. }) => failed.push(FailedInvite {
                email: invite.email,
                error: body.unwrap_or_default(),
            }),
            Err(_) => failed.push(FailedInvite {
                email: invite.email,
                error: "Failed to send invitation".to_owned(),
            }),
        }
    }
    ok(json!({ "success": true, "sent": sent, "failed": failed }))
}

// ── POST /complete ──────────────────────────────────────────────────────────

/// `COMPLETE_ORG_METADATA_KEYS`.
const COMPLETE_ORG_METADATA_KEYS: [&str; 6] = [
    "country",
    "referralSource",
    "organizationType",
    "organizationSize",
    "region",
    "selectedApps",
];

#[allow(clippy::too_many_lines)] // one route, in the order TypeScript checks
async fn complete(
    State(state): State<OnboardingState>,
    caller: OnboardingCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error completing onboarding");
        internal("Failed to complete onboarding")
    };
    // `await c.req.json()`, an unreadable body counting as `{}`; JSON
    // `null` makes the first property read throw.
    let data = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Null) => return failed(&"the body is null"),
        Ok(Value::Object(fields)) => fields,
        Ok(_) | Err(_) => Map::new(),
    };
    let identity = caller.identity(&state);

    if truthy(data.get("role")) || data.contains_key("productUpdates") {
        let mut metadata = Map::new();
        if let Some(updates) = data.get("productUpdates") {
            metadata.insert("productUpdates".to_owned(), updates.clone());
        }
        if truthy(data.get("role")) {
            metadata.insert("primaryRole".to_owned(), data["role"].clone());
        }
        let metadata = Value::Object(metadata);
        let saved = with_identity(identity.as_ref(), |i| {
            i.update_user_metadata(&user_id, &metadata)
        })
        .await;
        if let Err(error) = ignore_refusal(saved) {
            return failed(&error);
        }
    }

    if let Some(org) = &caller.org_id {
        let mut metadata = Map::new();
        for key in COMPLETE_ORG_METADATA_KEYS {
            if truthy(data.get(key)) {
                metadata.insert(key.to_owned(), data[key].clone());
            }
        }
        if !metadata.is_empty() {
            let metadata = Value::Object(metadata);
            let saved = with_identity(identity.as_ref(), |i| {
                i.update_organization_metadata(org, Some(&metadata), None)
            })
            .await;
            match saved {
                Ok(()) => {}
                Err(error @ IdentityError::Rejected { .. }) => {
                    tracing::error!(%error, "onboarding: failed to patch the org metadata");
                }
                Err(error) => return failed(&error),
            }
        }
        return ok(json!({ "success": true, "clerkOrgId": org }));
    }

    match territory_refusal(&caller.master(&state), &headers).await {
        Ok(Some(refusal)) => return refusal,
        Ok(None) => {}
        Err(error) => return failed(&error),
    }
    let Some(service) = state.workspace_service.clone() else {
        return no_workspace_service();
    };
    let user = match user_basics(identity.as_ref(), &user_id).await {
        Ok(user) => user,
        Err(error) => return failed(&error),
    };
    let name = ["firstName", "lastName"]
        .into_iter()
        .filter(|key| truthy(data.get(*key)))
        .map(|key| js_text(&data[key]))
        .collect::<Vec<_>>()
        .join(" ");
    let mut request = Map::new();
    request.insert("clerkUserId".to_owned(), json!(user_id));
    for (to, from) in [
        ("workspaceName", "organizationName"),
        ("firstName", "firstName"),
        ("lastName", "lastName"),
        ("country", "country"),
        ("referralSource", "referralSource"),
        ("region", "region"),
        ("organizationType", "organizationType"),
        ("organizationSize", "organizationSize"),
        ("selectedApps", "selectedApps"),
        ("productUpdates", "productUpdates"),
        ("role", "role"),
    ] {
        if let Some(value) = data.get(from) {
            request.insert(to.to_owned(), value.clone());
        }
    }
    request.insert(
        "initialMember".to_owned(),
        json!({ "email": user.email, "name": name, "picture": user.picture }),
    );
    let outcome = service.onboard(&Value::Object(request)).await;
    if !outcome.success {
        tracing::warn!(error = ?outcome.error, "onboarding: the workspace service failed");
        return internal(
            outcome
                .error
                .as_deref()
                .unwrap_or("Failed to create workspace"),
        );
    }
    ok(json!({
        "success": true,
        "clerkOrgId": outcome.clerk_org_id,
        "workspaceId": outcome.workspace_id,
    }))
}

// ── POST /retry ─────────────────────────────────────────────────────────────

async fn retry(State(state): State<OnboardingState>, caller: OnboardingCaller) -> Response {
    let (Some(user_id), Some(org)) = (caller.user_id.clone(), caller.org_id.clone()) else {
        return not_authenticated();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error in retry provisioning");
        internal("Failed to provision")
    };
    let master = caller.master(&state);
    let provisioned: Result<Option<bool>, sqlx::Error> = sqlx::query_scalar(
        "select database_provisioned_at is not null from workspaces where clerk_org_id = $1 limit 1",
    )
    .bind(&org)
    .fetch_optional(&master)
    .await;
    match provisioned {
        Ok(Some(true)) => return ok(json!({ "success": true })),
        Ok(_) => {}
        Err(error) => return failed(&error),
    }
    let Some(service) = state.workspace_service.clone() else {
        return no_workspace_service();
    };
    let reset = sqlx::query(
        "update workspaces set provisioning_status = 'provisioning', provisioning_error = null,
                updated_at = now() where clerk_org_id = $1",
    )
    .bind(&org)
    .execute(&master)
    .await;
    if let Err(error) = reset {
        return failed(&error);
    }
    let identity = caller.identity(&state);
    let (organization, user) = tokio::join!(
        with_identity(identity.as_ref(), |i| i.organization(&org)),
        user_basics(identity.as_ref(), &user_id),
    );
    let org_name = match organization {
        Ok(organization) => organization.name,
        Err(IdentityError::Rejected { .. }) => String::new(),
        Err(error) => return failed(&error),
    };
    let user = match user {
        Ok(user) => user,
        Err(error) => return failed(&error),
    };
    let request = json!({
        "clerkUserId": user_id,
        "workspaceName": org_name,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "initialMember": { "email": user.email, "name": user.full_name(), "picture": user.picture },
    });
    let outcome = service.onboard(&request).await;
    if outcome.success {
        return ok(json!({ "success": true }));
    }
    tracing::warn!(error = ?outcome.error, "onboarding: retry provisioning failed");
    internal("Failed to provision")
}

// ── POST /finalize ──────────────────────────────────────────────────────────

async fn finalize(State(state): State<OnboardingState>, caller: OnboardingCaller) -> Response {
    let Some(user_id) = caller.user_id.clone() else {
        return not_authenticated();
    };
    let Some(org) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let failed = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "onboarding: error finalizing onboarding");
        internal("Failed to finalize onboarding")
    };
    let master = caller.master(&state);
    let identity = caller.identity(&state);
    let selected: Vec<String> =
        match with_identity(identity.as_ref(), |i| i.organization(&org)).await {
            Ok(organization) => organization.public_metadata["selectedApps"]
                .as_array()
                .map(|apps| {
                    apps.iter()
                        .filter_map(|a| a.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            Err(IdentityError::Rejected { .. }) => Vec::new(),
            Err(error) => return failed(&error),
        };
    let marked = sqlx::query(
        "update workspaces set onboarding_completed_at = now(), updated_at = now()
          where clerk_org_id = $1",
    )
    .bind(&org)
    .execute(&master)
    .await;
    if let Err(error) = marked {
        return failed(&error);
    }
    if !selected.is_empty() {
        install_selected_apps(&state, &caller, &master, &org, &user_id, &selected).await;
    }
    ok(json!({ "success": true }))
}

/// Best effort per app: onboarding stays complete if an install fails. Apps
/// on request only are never installed from metadata.
async fn install_selected_apps(
    state: &OnboardingState,
    caller: &OnboardingCaller,
    master: &weldsuite_db::PgPool,
    org: &str,
    user_id: &str,
    apps: &[String],
) {
    let tenant = match caller.tenant_db(state, org).await {
        Ok(tenant) => tenant,
        Err(error) => {
            tracing::error!(%error, "onboarding: no tenant database for the app installs");
            return;
        }
    };
    let on_request: Vec<String> =
        match sqlx::query_scalar("select code from app_catalog where requires_approval = true")
            .fetch_all(master)
            .await
        {
            Ok(codes) => codes,
            Err(error) => {
                tracing::error!(%error, "onboarding: could not read the apps on request");
                return;
            }
        };
    for app in apps.iter().filter(|app| !on_request.contains(app)) {
        let installed = async {
            sqlx::query(
                "insert into workspace_installed_apps
                   (id, app_code, installed_by, is_active, installed_at, created_at, updated_at)
                 values ($1, $2, $3, true, now(), now(), now())
                 on conflict do nothing",
            )
            .bind(weldsuite_kit::generate_id("wia"))
            .bind(app)
            .bind(user_id)
            .execute(&tenant)
            .await?;
            sqlx::query(
                "insert into user_app_assignments (id, user_id, app_code, is_active, created_at, updated_at)
                 values ($1, $2, $3, true, now(), now())
                 on conflict do nothing",
            )
            .bind(weldsuite_kit::generate_id("uaa"))
            .bind(user_id)
            .bind(app)
            .execute(&tenant)
            .await
        };
        if let Err(error) = installed.await {
            tracing::error!(%error, app, "onboarding: failed to install an app");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_codes_and_truthiness() {
        assert!(is_app_code("welddesk"));
        assert!(is_app_code(" crm "));
        assert!(!is_app_code("Bad App"));
        assert!(!is_app_code("c"));
        assert!(truthy(Some(&json!([]))));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(None));
        assert_eq!(js_text(&json!(5)), "5");
    }
}
