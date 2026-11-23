//! Who is calling `/mcp` (`middleware/auth.ts`, `middleware/rate-limit.ts`)
//! and the OAuth discovery documents (`lib/well-known.ts`).
//!
//! The bearer token is checked by the server's own session verifier: with
//! `AUTH_PROVIDER=oidc` (Zitadel) an access token of the issuer, the
//! organization from `OIDC_ORG_CLAIM`. Its organization picks the workspace;
//! the member's effective permissions in it are the authority, never the
//! token. A request then counts against the workspace's per-minute limit on
//! the cache's counters (the worker's `RateLimiter` Durable Object).
//!
//! In membership mode (`OIDC_WORKSPACE_SOURCE=header`, WeldID) the token
//! names no workspace, and an MCP client can't send the platform's
//! `X-Weld-Workspace` header, so the server URL names it instead:
//! `/mcp/w/<workspace>` (its `workspaces.id`, slug or organization id),
//! checked against WeldSuite's own `user_workspaces` like the header
//! ([`McpAuth::membership`]). A plain `/mcp` takes the user's only
//! workspace; someone in several gets the workspace picker
//! ([`crate::picker`]): connected, with one tool that lists their
//! workspaces and the URL of each, never a workspace they didn't choose.
//! With a token that names its workspace (claim mode, Clerk) a workspace
//! URL must name that same one.
//!
//! Every refusal is logged with its reason (`mcp auth: 401`, `mcp auth:
//! 403`): an MCP client shows the person only that it couldn't connect.
//!
//! RFC 9728: every URL the endpoint answers on is its own resource, so the
//! 401's `WWW-Authenticate` points at the metadata for the URL the client
//! called (`/.well-known/oauth-protected-resource/mcp/w/<workspace>` for
//! `/mcp/w/<workspace>`), whose `resource` is exactly that URL.
//!
//! The discovery documents follow the sign-in ([`Discovery`]): with Clerk
//! they are Global's, field for field; with an OIDC provider they name its
//! endpoints and the scopes its tokens need, and the authorization server's
//! metadata is the provider's `openid-configuration`. Whatever names one of
//! the issuer's endpoints (Clerk's `token_introspection_endpoint` and
//! `jwks_uri`, the authorization server document) comes from the issuer's
//! own metadata, fetched once and reused ([`IssuerMetadata`]), never from a
//! path built after one provider's layout.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderValue, StatusCode, header};
use sea_orm::{ColumnTrait, EntityTrait, JoinType, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_auth::SessionVerifier;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_db::{SoleWorkspace, Tenant, WorkspaceError, WorkspaceSelector, orm};
use weldsuite_permissions::resolve_effective_permissions;
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_schema::master::{plans, workspaces};

use crate::picker::{self, WorkspaceChoice};
use crate::{McpSession, McpState};

/// The scopes Global's discovery advertises (Clerk's).
const CLERK_SCOPES: [&str; 4] = ["openid", "profile", "email", "user:org:read"];
/// The scopes every OIDC sign-in asks for (the platform's
/// `DEFAULT_OIDC_SCOPES`, less Zitadel's roles scope).
const OIDC_SCOPES: [&str; 4] = ["openid", "profile", "email", "offline_access"];
/// Zitadel's scope for the project roles claim, which names the
/// organizations the user has roles in.
const ZITADEL_ROLES_SCOPE: &str = "urn:zitadel:iam:org:projects:roles";
const SERVICE_DOCUMENTATION: &str = "https://help.weldsuite.org/settings/mcp-server";
const PROTECTED_RESOURCE_PATH: &str = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_PATH: &str = "/.well-known/oauth-authorization-server";
const OPENID_CONFIGURATION_PATH: &str = "/.well-known/openid-configuration";
const RATE_WINDOW_SECONDS: u64 = 60;
/// The endpoint (`lib.rs`'s router); `/mcp/w/<workspace>` names a workspace.
pub const MCP_PATH: &str = "/mcp";
/// What follows [`MCP_PATH`] when the URL names a workspace.
pub(crate) const WORKSPACE_PREFIX: &str = "/w/";
/// The longest workspace reference (the columns are 255 wide).
const MAX_WORKSPACE_REFERENCE: usize = 255;

/// A workspace path segment as it may appear in the endpoint's URL: a
/// `workspaces.id`, slug or organization id, in URL-unreserved characters
/// only, so it needs no decoding and the resource echoes it exactly.
pub(crate) fn is_workspace_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_WORKSPACE_REFERENCE
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// The workspace a request path names: `Ok(None)` for `/mcp`,
/// `Ok(Some(..))` for `/mcp/w/<workspace>`, `Err(())` for any other path.
fn path_workspace(path: &str) -> Result<Option<&str>, ()> {
    let rest = path.strip_prefix(MCP_PATH).ok_or(())?;
    if rest.is_empty() {
        return Ok(None);
    }
    let segment = rest.strip_prefix(WORKSPACE_PREFIX).ok_or(())?;
    if is_workspace_segment(segment) {
        Ok(Some(segment))
    } else {
        Err(())
    }
}

/// The resource a request path is for, as the path RFC 9728 puts after the
/// well-known suffix: `/mcp`, or `/mcp/w/<workspace>`.
fn resource_path(path: &str) -> String {
    match path_workspace(path) {
        Ok(Some(workspace)) => format!("{MCP_PATH}{WORKSPACE_PREFIX}{workspace}"),
        _ => MCP_PATH.to_owned(),
    }
}

/// Who signs MCP clients in, which shapes the discovery documents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discovery {
    /// Clerk: Global's documents, as the worker writes them.
    Clerk,
    /// An OIDC provider (`AUTH_PROVIDER=oidc`; Zitadel on EU): RFC 9728's
    /// fields only, with the scopes a client must ask for to get a token
    /// this server takes. The authorization server's metadata is the
    /// provider's `openid-configuration`, since Zitadel serves no RFC 8414
    /// document.
    Oidc { scopes: Vec<String> },
}

impl Discovery {
    /// The OIDC sign-in for a provider whose tokens name the organization in
    /// `org_claim` and must have `audience` in `aud`. With a Zitadel claim,
    /// Zitadel's scopes as the platform asks for them
    /// (`lib/auth/oidc/session.ts`): the project roles, which carry the
    /// organization, and the project in `aud`.
    pub fn oidc(audience: Option<&str>, org_claim: &str) -> Self {
        let mut scopes: Vec<String> = OIDC_SCOPES.iter().map(|&scope| scope.to_owned()).collect();
        if org_claim.starts_with("urn:zitadel:") {
            scopes.push(ZITADEL_ROLES_SCOPE.to_owned());
            if let Some(audience) = audience.filter(|audience| !audience.is_empty()) {
                scopes.push(format!("urn:zitadel:iam:org:project:id:{audience}:aud"));
            }
        }
        Self::Oidc { scopes }
    }

    /// The 401 for a token that names no single organization.
    fn no_organization_message(&self) -> &'static str {
        match self {
            Self::Clerk => {
                "Token is not scoped to an organization. Re-authorize requesting the \"user:org:read\" scope and select a workspace."
            }
            Self::Oidc { .. } => {
                "Token names no single workspace. Sign in again with the scopes in this server's OAuth metadata; an account that belongs to several workspaces can't use MCP here yet."
            }
        }
    }
}

/// How long the issuer's metadata is reused, and how long a failed fetch
/// waits before the next.
const METADATA_TTL: Duration = Duration::from_secs(3600);
const METADATA_RETRY: Duration = Duration::from_secs(60);

/// The issuer's metadata, as last fetched: reused for [`METADATA_TTL`]; a
/// failed fetch is tried again after [`METADATA_RETRY`].
#[derive(Debug, Default)]
pub struct IssuerMetadata {
    fetched: Mutex<Option<(Instant, Fetched)>>,
}

/// What the last fetch gave.
#[derive(Debug, Clone)]
enum Fetched {
    Document(Value),
    Failed,
}

impl IssuerMetadata {
    /// The last fetch's outcome while it is fresh.
    fn cached(&self) -> Option<Fetched> {
        let fetched = self.fetched.lock().unwrap_or_else(PoisonError::into_inner);
        let (at, outcome) = fetched.as_ref()?;
        let ttl = match outcome {
            Fetched::Document(_) => METADATA_TTL,
            Fetched::Failed => METADATA_RETRY,
        };
        (at.elapsed() < ttl).then(|| outcome.clone())
    }

    fn store(&self, metadata: Option<&Value>) {
        let outcome = metadata.map_or(Fetched::Failed, |document| {
            Fetched::Document(document.clone())
        });
        *self.fetched.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((Instant::now(), outcome));
    }
}

/// The verifier and what discovery names.
pub struct McpAuth {
    pub verifier: Arc<SessionVerifier>,
    /// The authorization server's issuer (`OIDC_ISSUER`, or Clerk's Frontend
    /// API).
    pub issuer: Option<String>,
    /// This server's public origin (`MCP_SERVER_URL`).
    pub server_url: String,
    pub outbound: Option<OutboundHttp>,
    pub discovery: Discovery,
    /// The issuer's metadata, cached.
    pub metadata: IssuerMetadata,
    /// Membership mode (`OIDC_WORKSPACE_SOURCE=header`): the platform's
    /// workspace check, which the URL's workspace goes through instead of a
    /// token claim. `None` when the token names the workspace.
    pub membership: Option<WorkspaceSelector>,
}

impl McpAuth {
    /// The issuer's metadata ([`authorization_server_metadata`]), from the
    /// cache when it is fresh.
    async fn issuer_metadata(&self) -> Option<Value> {
        match self.metadata.cached() {
            Some(Fetched::Document(document)) => return Some(document),
            Some(Fetched::Failed) => return None,
            None => {}
        }
        let (Some(issuer), Some(outbound)) = (&self.issuer, &self.outbound) else {
            return None;
        };
        let fetched = authorization_server_metadata(issuer, outbound, &self.discovery).await;
        self.metadata.store(fetched.as_ref());
        fetched
    }
}

impl std::fmt::Debug for McpAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpAuth")
            .field("issuer", &self.issuer)
            .field("server_url", &self.server_url)
            .field("discovery", &self.discovery)
            .field("membership", &self.membership.is_some())
            .finish_non_exhaustive()
    }
}

/// `clerkFrontendApiUrl(publishableKey)`.
pub fn clerk_frontend_api_url(publishable_key: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = publishable_key
        .strip_prefix("pk_test_")
        .or_else(|| publishable_key.strip_prefix("pk_live_"))?;
    let decoded = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(
            payload
                .trim_end_matches('=')
                .replace('-', "+")
                .replace('_', "/"),
        )
        .ok()?;
    let host = String::from_utf8(decoded).ok()?;
    Some(format!("https://{}", host.trim_end_matches('$')))
}

fn jsonrpc_error(status: StatusCode, code: i64, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null })
            .to_string(),
    )
        .into_response()
}

/// The protected-resource metadata of the resource at `resource_path`
/// (RFC 9728 §3.1: the well-known suffix goes between the host and the path).
fn metadata_url(server_url: &str, resource_path: &str) -> String {
    format!(
        "{}{PROTECTED_RESOURCE_PATH}{resource_path}",
        server_url.trim_end_matches('/')
    )
}

/// The 401's challenge for a request to `path`: where its resource's
/// metadata is.
pub fn bearer_challenge(server_url: &str, path: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(&format!(
        "Bearer resource_metadata=\"{}\"",
        metadata_url(server_url, &resource_path(path))
    ))
    .ok()
}

/// A 403, logged: the client shows the person only that it couldn't
/// connect, so the log is where the reason is found. The messages name no
/// person or workspace.
fn forbidden(message: &str) -> Response {
    tracing::warn!(diagnostic = message, "mcp auth: 403");
    jsonrpc_error(StatusCode::FORBIDDEN, -32003, message)
}

fn workspace_lookup_failed(error: &WorkspaceError) -> Response {
    tracing::error!(%error, "mcp auth: workspace lookup failed");
    jsonrpc_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        -32603,
        "Could not resolve workspace.",
    )
}

/// Whether a workspace URL's reference is `tenant`, by its id or
/// organization id (claim mode; the slug is not at hand there).
fn names_tenant(reference: &str, tenant: &Tenant) -> bool {
    reference == tenant.workspace_id || tenant.clerk_org_id.as_deref() == Some(reference)
}

/// What membership mode selected for a request.
enum Selected {
    /// A workspace: the organization reference its tenant is found by.
    Workspace(String),
    /// None: a plain `/mcp` for someone in several workspaces, who gets the
    /// picker ([`crate::picker`]).
    Choice,
}

/// Membership mode: the workspace the URL names, or the user's only one,
/// checked against WeldSuite's memberships like the platform's
/// `X-Weld-Workspace`.
async fn membership_workspace(
    selector: &WorkspaceSelector,
    user_id: &str,
    named: Option<&str>,
) -> Result<Selected, Response> {
    if let Some(reference) = named {
        return match selector.resolve(user_id, reference).await {
            Ok(Some(org)) => Ok(Selected::Workspace(org)),
            Ok(None) => Err(forbidden("You are not a member of this workspace.")),
            Err(error) => Err(workspace_lookup_failed(&error)),
        };
    }
    match selector.sole_workspace(user_id).await {
        Ok(SoleWorkspace::One(org)) => Ok(Selected::Workspace(org)),
        Ok(SoleWorkspace::Several) => Ok(Selected::Choice),
        Ok(SoleWorkspace::None) => Err(forbidden(
            "You are not a member of any workspace yet. Create or join one in WeldSuite first.",
        )),
        Err(error) => Err(workspace_lookup_failed(&error)),
    }
}

/// `authMiddleware` then `rateLimitMiddleware`.
#[allow(clippy::too_many_lines)] // the worker's refusals, in its order
pub async fn authenticate(
    State(state): State<McpState>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(auth) = state.auth.clone() else {
        return jsonrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            -32603,
            "MCP sign-in is not configured.",
        );
    };
    let path = request.uri().path().to_owned();
    let Ok(named_workspace) = path_workspace(&path).map(|named| named.map(str::to_owned)) else {
        return jsonrpc_error(
            StatusCode::NOT_FOUND,
            -32600,
            "Not found. The MCP endpoint is /mcp, or /mcp/w/<workspace> for one workspace.",
        );
    };
    let unauthorized = |message: &str, diagnostic: &str| {
        tracing::warn!(diagnostic, "mcp auth: 401");
        let mut response = jsonrpc_error(StatusCode::UNAUTHORIZED, -32001, message);
        if let Some(value) = bearer_challenge(&auth.server_url, &path) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, value);
        }
        response
    };
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim().to_owned());
    let Some(token) = token else {
        return unauthorized(
            "Missing bearer token. Authenticate with OAuth to use this MCP server.",
            "no bearer token",
        );
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let context = match auth.verifier.verify(&token, now).await {
        Ok(context) => context,
        Err(error) => {
            return unauthorized("Invalid or expired access token.", &error.to_string());
        }
    };
    let org = if let Some(selector) = &auth.membership {
        match membership_workspace(selector, &context.user_id, named_workspace.as_deref()).await {
            Ok(Selected::Workspace(org)) => org,
            Ok(Selected::Choice) => {
                // No workspace, so no tenant, permissions or rate limit: the
                // picker only lists the user's own workspaces.
                return match selector
                    .member_workspace_list(&context.user_id, picker::MAX_LISTED)
                    .await
                {
                    Ok(workspaces) => {
                        request
                            .extensions_mut()
                            .insert(WorkspaceChoice::new(&auth.server_url, &workspaces));
                        next.run(request).await
                    }
                    Err(error) => workspace_lookup_failed(&error),
                };
            }
            Err(refused) => return refused,
        }
    } else {
        let Some(org) = context.org_id.clone() else {
            return unauthorized(
                auth.discovery.no_organization_message(),
                "no organization claim",
            );
        };
        org
    };
    let tenant = match state.workspaces.tenant(&org).await {
        Ok(tenant) => tenant,
        Err(WorkspaceError::NotFound | WorkspaceError::NoDatabase) => {
            return forbidden("No WeldSuite workspace is linked to the selected organization.");
        }
        Err(error) => return workspace_lookup_failed(&error),
    };
    // A token that names its workspace: a workspace URL must name that one.
    if auth.membership.is_none()
        && let Some(named) = named_workspace.as_deref()
        && !names_tenant(named, &tenant)
    {
        return forbidden(
            "This token is for another workspace than the one this address names. Connect to /mcp, or sign in again for this workspace.",
        );
    }
    let queries = TenantPermissionQueries::new(tenant.db.clone());
    let resolved = match resolve_effective_permissions(&queries, &context.user_id).await {
        Ok(resolved) => resolved,
        Err(error) => {
            if weldsuite_db::pg_errors::classify_moved_database_error(&error).is_some() {
                let mut response = (
                    StatusCode::SERVICE_UNAVAILABLE,
                    [(header::CONTENT_TYPE, "application/json")],
                    json!({
                        "jsonrpc": "2.0",
                        "error": {
                            "code": -32603,
                            "message": "This workspace is being moved. Try again in a minute.",
                            "data": { "code": "WORKSPACE_MOVING" },
                        },
                        "id": null,
                    })
                    .to_string(),
                )
                    .into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
                return response;
            }
            tracing::error!(%error, "mcp auth: permission resolution failed");
            return jsonrpc_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                -32603,
                "Could not resolve permissions.",
            );
        }
    };
    if resolved.role.is_empty() {
        return forbidden("You are not a member of this workspace.");
    }
    if resolved.permissions.is_empty() {
        return forbidden(&format!(
            "Your workspace role ({}) grants no permissions, so no tools are available. Expected one of OWNER, ADMIN, MEMBER or VIEWER, or a custom role with permissions assigned.",
            resolved.role
        ));
    }
    let (name, tier) = workspace_name_and_tier(&state, &tenant).await;
    let session = McpSession {
        token_id: context.session_id.clone(),
        user_id: context.user_id.clone(),
        clerk_org_id: org,
        workspace_id: tenant.workspace_id.clone(),
        workspace_name: name,
        tier,
        database_url: None,
        permissions: resolved.permissions,
        permission_denies: resolved.denies,
        role: resolved.role,
        client_id: None,
        licensed_apps: tenant.licensed_apps().map(<[String]>::to_vec),
        read_only: tenant.restrictions.read_only,
        read_only_reason: tenant
            .read_only_reason()
            .map(|reason| reason.as_str().to_owned()),
    };
    if let Some(refused) = rate_limit(&state, &session).await {
        return refused;
    }
    request.extensions_mut().insert(tenant);
    request.extensions_mut().insert(session);
    next.run(request).await
}

/// The workspace's name and plan tier (`getTierFromPlan`).
async fn workspace_name_and_tier(state: &McpState, tenant: &Tenant) -> (String, String) {
    let row: Option<(String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Name)
        .column(plans::Column::Slug)
        .join(
            JoinType::LeftJoin,
            workspaces::Entity::belongs_to(plans::Entity)
                .from(workspaces::Column::PlanId)
                .to(plans::Column::Id)
                .into(),
        )
        .filter(workspaces::Column::Id.eq(&tenant.workspace_id))
        .into_tuple()
        .one(&orm(&state.master))
        .await
        .unwrap_or_default();
    let (name, slug) = row.unwrap_or_default();
    let tier = match slug.as_deref() {
        Some(tier @ ("free" | "business" | "scale" | "enterprise")) => tier.to_owned(),
        _ => "free".to_owned(),
    };
    (name, tier)
}

/// `RATE_LIMITS`: the table names `starter` and `professional`, so
/// `business` and `scale` get `free`'s 60.
fn tier_limit(tier: &str) -> i64 {
    match tier {
        "starter" => 300,
        "professional" => 1000,
        "enterprise" => 5000,
        _ => 60,
    }
}

async fn rate_limit(state: &McpState, session: &McpSession) -> Option<Response> {
    let cache = state.cache.as_ref()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let window = now.as_secs() / RATE_WINDOW_SECONDS;
    let key = format!("mcp:rl:{}:{window}", session.workspace_id);
    let count = match cache
        .increment_boxed(&key, 1, Some(Duration::from_secs(RATE_WINDOW_SECONDS * 2)))
        .await
    {
        Ok(count) => count,
        Err(error) => {
            tracing::warn!(%error, "mcp: rate limit counter unavailable");
            return None;
        }
    };
    let limit = tier_limit(&session.tier);
    if count <= limit {
        return None;
    }
    let reset = (window + 1) * RATE_WINDOW_SECONDS;
    let retry_after = reset.saturating_sub(now.as_secs()).max(1);
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::CONTENT_TYPE, "application/json")],
        json!({
            "jsonrpc": "2.0",
            "error": {
                "code": -32429,
                "message": format!("Rate limit exceeded. Retry after {retry_after} seconds."),
                "data": { "retryAfter": retry_after },
            },
            "id": null,
        })
        .to_string(),
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert("x-ratelimit-limit", HeaderValue::from(limit));
    headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
    headers.insert("x-ratelimit-reset", HeaderValue::from(reset));
    headers.insert(header::RETRY_AFTER, HeaderValue::from(retry_after));
    Some(response)
}

fn metadata_cors(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    response
}

/// One of the issuer's endpoints from its metadata, else where Clerk keeps
/// it (`fallback`, under the issuer).
fn issuer_endpoint(metadata: Option<&Value>, field: &str, issuer: &str, fallback: &str) -> String {
    metadata
        .and_then(|metadata| metadata.get(field))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map_or_else(
            || format!("{}{fallback}", issuer.trim_end_matches('/')),
            str::to_owned,
        )
}

/// RFC 9728's document for `{server_url}{resource_path}`. With Clerk it
/// names the issuer's token endpoint and keys as Clerk's MCP tooling does,
/// taken from the issuer's `metadata` (Clerk's own paths until it has
/// answered); an OIDC provider's document names neither, as RFC 9728 means
/// those fields for the resource's own.
fn protected_resource_document(
    issuer: &str,
    server_url: &str,
    resource_path: &str,
    discovery: &Discovery,
    metadata: Option<&Value>,
) -> Value {
    let resource = format!("{}{resource_path}", server_url.trim_end_matches('/'));
    match discovery {
        Discovery::Clerk => json!({
            "resource": resource,
            "authorization_servers": [issuer],
            "token_types_supported": ["urn:ietf:params:oauth:token-type:access_token"],
            "token_introspection_endpoint": issuer_endpoint(metadata, "token_endpoint", issuer, "/oauth/token"),
            "token_introspection_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
            "jwks_uri": issuer_endpoint(metadata, "jwks_uri", issuer, "/.well-known/jwks.json"),
            "authorization_data_types_supported": ["oauth_scope"],
            "authorization_data_locations_supported": ["header", "body"],
            "key_challenges_supported": [{ "challenge_type": "urn:ietf:params:oauth:pkce:code_challenge", "challenge_algs": ["S256"] }],
            "scopes_supported": CLERK_SCOPES,
            "bearer_methods_supported": ["header"],
            "service_documentation": SERVICE_DOCUMENTATION,
        }),
        Discovery::Oidc { scopes } => json!({
            "resource": resource,
            "authorization_servers": [issuer],
            "scopes_supported": scopes,
            "bearer_methods_supported": ["header"],
        }),
    }
}

async fn protected_resource(auth: &McpAuth, resource_path: &str) -> Response {
    let Some(issuer) = &auth.issuer else {
        return metadata_cors(
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({ "error": "server_error", "error_description": "Protected resource metadata unavailable" })),
            )
                .into_response(),
        );
    };
    // Only Clerk's document names the issuer's endpoints.
    let metadata = match auth.discovery {
        Discovery::Clerk => auth.issuer_metadata().await,
        Discovery::Oidc { .. } => None,
    };
    metadata_cors(
        axum::Json(protected_resource_document(
            issuer,
            &auth.server_url,
            resource_path,
            &auth.discovery,
            metadata.as_ref(),
        ))
        .into_response(),
    )
}

/// The issuer's metadata: RFC 8414's document from Clerk, the
/// `openid-configuration` from an OIDC provider (RFC 8414 §5 makes it the same
/// document). `None` when it can't be fetched or has no `issuer`.
async fn authorization_server_metadata(
    issuer: &str,
    outbound: &OutboundHttp,
    discovery: &Discovery,
) -> Option<Value> {
    let path = match discovery {
        Discovery::Clerk => AUTHORIZATION_SERVER_PATH,
        Discovery::Oidc { .. } => OPENID_CONFIGURATION_PATH,
    };
    let request = HttpRequest {
        method: "GET".to_owned(),
        url: format!("{}{path}", issuer.trim_end_matches('/')),
        headers: vec![("accept".to_owned(), "application/json".to_owned())],
        body: None,
    };
    let response = outbound.0.send(request).await.ok()?;
    let metadata = serde_json::from_slice::<Value>(&response.body).ok()?;
    ((200..300).contains(&response.status) && metadata.get("issuer").is_some_and(Value::is_string))
        .then_some(metadata)
}

async fn authorization_server(auth: &McpAuth) -> Response {
    match auth.issuer_metadata().await {
        Some(metadata) => metadata_cors(axum::Json(metadata).into_response()),
        None => metadata_cors(
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({ "error": "server_error", "error_description": "Authorization server metadata unavailable" })),
            )
                .into_response(),
        ),
    }
}

/// The discovery documents, unauthenticated, at their root paths. Each
/// protected-resource document answers for the URL it was looked up for
/// (RFC 9728 §3.3): the bare one for the origin, `…/mcp` for the endpoint,
/// `…/mcp/w/<workspace>` for one workspace's endpoint.
pub fn well_known_router(auth: Arc<McpAuth>) -> Router {
    let preflight = || async { metadata_cors(StatusCode::NO_CONTENT.into_response()) };
    let (a, b, c, d) = (
        Arc::clone(&auth),
        Arc::clone(&auth),
        Arc::clone(&auth),
        auth,
    );
    Router::new()
        .route(
            PROTECTED_RESOURCE_PATH,
            get(move || async move { protected_resource(&a, "").await }).options(preflight),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(move || async move { protected_resource(&b, MCP_PATH).await }).options(preflight),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp/w/{workspace}",
            get(
                move |axum::extract::Path(workspace): axum::extract::Path<String>| async move {
                    if !is_workspace_segment(&workspace) {
                        return metadata_cors(StatusCode::NOT_FOUND.into_response());
                    }
                    let path = format!("{MCP_PATH}{WORKSPACE_PREFIX}{workspace}");
                    protected_resource(&d, &path).await
                },
            )
            .options(preflight),
        )
        .route(
            AUTHORIZATION_SERVER_PATH,
            get(move || async move { authorization_server(&c).await }).options(preflight),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishable_keys_name_the_frontend_api() {
        assert_eq!(
            clerk_frontend_api_url("pk_test_ZGVmaW5pdGUtZWFnbGUtMy5jbGVyay5hY2NvdW50cy5kZXYk")
                .as_deref(),
            Some("https://definite-eagle-3.clerk.accounts.dev")
        );
        assert_eq!(tier_limit("business"), 60);
    }

    #[test]
    fn oidc_scopes_follow_the_org_claim() {
        let zitadel = Discovery::oidc(Some("397"), "urn:zitadel:iam:org:project:397:roles");
        assert_eq!(
            zitadel,
            Discovery::Oidc {
                scopes: [
                    "openid",
                    "profile",
                    "email",
                    "offline_access",
                    "urn:zitadel:iam:org:projects:roles",
                    "urn:zitadel:iam:org:project:id:397:aud",
                ]
                .map(str::to_owned)
                .to_vec()
            }
        );
        let no_audience = Discovery::oidc(Some(""), "urn:zitadel:iam:org:id");
        let Discovery::Oidc { scopes } = &no_audience else {
            panic!("oidc");
        };
        assert_eq!(scopes.last().map(String::as_str), Some(ZITADEL_ROLES_SCOPE));
        assert_eq!(
            Discovery::oidc(Some("api"), "org_id"),
            Discovery::Oidc {
                scopes: OIDC_SCOPES.map(str::to_owned).to_vec()
            }
        );
    }

    #[test]
    fn protected_resource_names_the_oidc_provider_only() {
        let discovery = Discovery::oidc(Some("397"), "urn:zitadel:iam:org:project:397:roles");
        let metadata = json!({
            "issuer": "https://auth.example.eu",
            "token_endpoint": "https://auth.example.eu/oauth/token",
            "jwks_uri": "https://auth.example.eu/oauth/jwks",
        });
        let document = protected_resource_document(
            "https://auth.example.eu",
            "https://app.example.eu/",
            "/mcp",
            &discovery,
            Some(&metadata),
        );
        assert_eq!(
            document,
            json!({
                "resource": "https://app.example.eu/mcp",
                "authorization_servers": ["https://auth.example.eu"],
                "scopes_supported": [
                    "openid", "profile", "email", "offline_access",
                    "urn:zitadel:iam:org:projects:roles",
                    "urn:zitadel:iam:org:project:id:397:aud",
                ],
                "bearer_methods_supported": ["header"],
            })
        );
        // Clerk's document, before Clerk's metadata has been read: Clerk's paths.
        let clerk = protected_resource_document(
            "https://clerk.example.org",
            "https://mcp.example.org",
            "",
            &Discovery::Clerk,
            None,
        );
        assert_eq!(clerk["resource"], "https://mcp.example.org");
        assert_eq!(
            clerk["jwks_uri"],
            "https://clerk.example.org/.well-known/jwks.json"
        );
        assert_eq!(
            clerk["token_introspection_endpoint"],
            "https://clerk.example.org/oauth/token"
        );
        assert_eq!(clerk["scopes_supported"], json!(CLERK_SCOPES));
    }

    #[test]
    fn the_issuers_endpoints_come_from_its_metadata() {
        let metadata = json!({
            "issuer": "https://clerk.example.org",
            "token_endpoint": "https://clerk.example.org/v2/oauth/token",
            "jwks_uri": "https://keys.example.org/jwks.json",
        });
        let clerk = protected_resource_document(
            "https://clerk.example.org",
            "https://mcp.example.org",
            "/mcp",
            &Discovery::Clerk,
            Some(&metadata),
        );
        assert_eq!(
            clerk["token_introspection_endpoint"],
            "https://clerk.example.org/v2/oauth/token"
        );
        assert_eq!(clerk["jwks_uri"], "https://keys.example.org/jwks.json");
        // A field the metadata lacks keeps Clerk's path.
        let partial = json!({ "issuer": "https://clerk.example.org", "jwks_uri": "" });
        assert_eq!(
            issuer_endpoint(
                Some(&partial),
                "jwks_uri",
                "https://clerk.example.org/",
                "/.well-known/jwks.json"
            ),
            "https://clerk.example.org/.well-known/jwks.json"
        );
    }

    /// Counts its calls; answers the discovery document with `issuer`, or
    /// fails while `down`.
    struct Counting {
        calls: std::sync::atomic::AtomicUsize,
        down: std::sync::atomic::AtomicBool,
    }

    impl weldsuite_ports::DynOutboundHttp for Counting {
        fn send(
            &self,
            request: HttpRequest,
        ) -> weldsuite_ports::BoxFuture<
            '_,
            Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>,
        > {
            use std::sync::atomic::Ordering;
            self.calls.fetch_add(1, Ordering::SeqCst);
            let response = if self.down.load(Ordering::SeqCst) {
                weldsuite_ports::HttpResponse::new(503, b"down".to_vec())
            } else {
                assert_eq!(
                    request.url,
                    "https://auth.example.eu/.well-known/openid-configuration"
                );
                weldsuite_ports::HttpResponse::new(
                    200,
                    br#"{"issuer":"https://auth.example.eu","token_endpoint":"https://auth.example.eu/oauth/token","jwks_uri":"https://auth.example.eu/oauth/jwks"}"#.to_vec(),
                )
            };
            Box::pin(std::future::ready(Ok(response)))
        }
    }

    #[tokio::test]
    async fn the_issuers_metadata_is_fetched_once_and_a_failure_retried_later() {
        use std::sync::atomic::Ordering;
        let counting = Arc::new(Counting {
            calls: std::sync::atomic::AtomicUsize::new(0),
            down: std::sync::atomic::AtomicBool::new(true),
        });
        let auth = McpAuth {
            verifier: Arc::new(
                SessionVerifier::oidc(weldsuite_auth::OidcSettings::new(
                    "https://auth.example.eu",
                    vec!["weldsuite-api".to_owned()],
                ))
                .expect("verifier"),
            ),
            issuer: Some("https://auth.example.eu".to_owned()),
            server_url: "https://app.example.eu".to_owned(),
            outbound: Some(OutboundHttp(counting.clone())),
            discovery: Discovery::oidc(Some("weldsuite-api"), ""),
            metadata: IssuerMetadata::default(),
            membership: None,
        };
        // Down: no document, and no new fetch until the retry is due.
        assert_eq!(auth.issuer_metadata().await, None);
        assert_eq!(auth.issuer_metadata().await, None);
        assert_eq!(counting.calls.load(Ordering::SeqCst), 1);
        // Once the retry is due, it is fetched and then reused.
        counting.down.store(false, Ordering::SeqCst);
        *auth.metadata.fetched.lock().expect("lock") = Some((
            Instant::now().checked_sub(METADATA_RETRY).expect("past"),
            Fetched::Failed,
        ));
        let metadata = auth.issuer_metadata().await.expect("metadata");
        assert_eq!(metadata["jwks_uri"], "https://auth.example.eu/oauth/jwks");
        auth.issuer_metadata().await.expect("cached");
        assert_eq!(counting.calls.load(Ordering::SeqCst), 2);
    }

    /// Answers `openid-configuration` only, as Zitadel does.
    struct OpenIdOnly;

    impl weldsuite_ports::DynOutboundHttp for OpenIdOnly {
        fn send(
            &self,
            request: HttpRequest,
        ) -> weldsuite_ports::BoxFuture<
            '_,
            Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>,
        > {
            let response = if request.url
                == "https://auth.example.eu/.well-known/openid-configuration"
            {
                weldsuite_ports::HttpResponse::new(
                    200,
                    br#"{"issuer":"https://auth.example.eu","token_endpoint":"https://auth.example.eu/oauth/v2/token"}"#.to_vec(),
                )
            } else {
                weldsuite_ports::HttpResponse::new(404, b"not found".to_vec())
            };
            Box::pin(std::future::ready(Ok(response)))
        }
    }

    #[tokio::test]
    async fn authorization_server_metadata_is_the_oidc_configuration() {
        let outbound = OutboundHttp(Arc::new(OpenIdOnly));
        let oidc = Discovery::oidc(None, "org_id");
        let metadata = authorization_server_metadata("https://auth.example.eu/", &outbound, &oidc)
            .await
            .expect("metadata");
        assert_eq!(
            metadata["token_endpoint"],
            "https://auth.example.eu/oauth/v2/token"
        );
        // Clerk's RFC 8414 path, which this provider doesn't serve.
        assert_eq!(
            authorization_server_metadata("https://auth.example.eu", &outbound, &Discovery::Clerk)
                .await,
            None
        );
    }
}

/// What a client sees before and while it picks a workspace in membership
/// mode: the 401's challenge for the URL it called, that URL's metadata, and
/// the workspace the URL (or the user's only membership) selects.
#[cfg(test)]
mod workspace_tests {
    use std::collections::HashMap;

    use axum::body::{Body, to_bytes};
    use http::Request;
    use tower::ServiceExt;
    use weldsuite_db::{
        Keyring, MemberWorkspace, MemberWorkspacesFuture, MembershipFuture, MembershipLookup,
        MembershipsFuture, WorkspaceConfig, Workspaces,
    };

    use super::*;

    const SERVER: &str = "https://app.example.eu";

    /// The auth crate's OIDC fixture: its issuer, keys and a token valid until 2096.
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../crates/auth/tests/fixtures/oidc-tokens.json"
        ))
        .expect("fixture")
    }

    /// `(user, reference, org)` memberships; fails every lookup when `down`.
    #[derive(Default)]
    struct Memberships {
        granted: Vec<(String, &'static str, &'static str)>,
        down: bool,
    }

    impl MembershipLookup for Memberships {
        fn member_workspace<'a>(
            &'a self,
            user_id: &'a str,
            reference: &'a str,
        ) -> MembershipFuture<'a> {
            let result = if self.down {
                Err(WorkspaceError::NoDatabase)
            } else {
                Ok(self
                    .granted
                    .iter()
                    .find(|(user, r, _)| user == user_id && *r == reference)
                    .map(|(_, _, org)| (*org).to_owned()))
            };
            Box::pin(std::future::ready(result))
        }

        fn member_workspaces<'a>(&'a self, user_id: &'a str, limit: u8) -> MembershipsFuture<'a> {
            let result = if self.down {
                Err(WorkspaceError::NoDatabase)
            } else {
                let mut orgs: Vec<String> = Vec::new();
                for (user, _, org) in &self.granted {
                    if user == user_id && !orgs.iter().any(|known| known == org) {
                        orgs.push((*org).to_owned());
                    }
                }
                orgs.truncate(usize::from(limit));
                Ok(orgs)
            };
            Box::pin(std::future::ready(result))
        }

        /// One workspace per org, its first reference as slug and name.
        fn member_workspace_list<'a>(
            &'a self,
            user_id: &'a str,
            limit: u64,
        ) -> MemberWorkspacesFuture<'a> {
            let result = if self.down {
                Err(WorkspaceError::NoDatabase)
            } else {
                let mut listed: Vec<MemberWorkspace> = Vec::new();
                for (user, reference, org) in &self.granted {
                    if user == user_id && !listed.iter().any(|known| known.id == *org) {
                        listed.push(MemberWorkspace {
                            id: (*org).to_owned(),
                            slug: (*reference).to_owned(),
                            name: reference.to_uppercase(),
                        });
                    }
                }
                listed.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
                Ok(listed)
            };
            Box::pin(std::future::ready(result))
        }
    }

    fn selector(granted: &[(&str, &'static str, &'static str)]) -> WorkspaceSelector {
        WorkspaceSelector::new(Arc::new(Memberships {
            granted: granted
                .iter()
                .map(|(user, reference, org)| ((*user).to_owned(), *reference, *org))
                .collect(),
            down: false,
        }))
    }

    /// The endpoint and its discovery documents, in membership mode on a
    /// WeldID-shaped issuer, with a master database nobody listens on.
    fn app(membership: WorkspaceSelector) -> Router {
        let fixture = fixture();
        let settings = weldsuite_auth::OidcSettings {
            workspace_source: weldsuite_auth::WorkspaceSource::Header,
            ..weldsuite_auth::OidcSettings::new(
                fixture["issuer"].as_str().expect("issuer"),
                vec![fixture["project"].as_str().expect("project").to_owned()],
            )
        };
        let verifier =
            SessionVerifier::oidc_with_jwks(settings, &fixture["jwks"].to_string()).expect("jwks");
        let auth = Arc::new(McpAuth {
            verifier: Arc::new(verifier),
            issuer: Some(fixture["issuer"].as_str().expect("issuer").to_owned()),
            server_url: format!("{SERVER}/"),
            outbound: None,
            discovery: Discovery::oidc(Some("weldsuite-api"), ""),
            metadata: IssuerMetadata::default(),
            membership: Some(membership),
        });
        let master = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy("postgres://weldsuite:x@127.0.0.1:1/master")
            .expect("valid url");
        let workspaces = Arc::new(Workspaces::new(
            master.clone(),
            Keyring::default(),
            WorkspaceConfig::default(),
        ));
        let state = McpState::new(
            Router::new(),
            master,
            workspaces,
            None,
            Some(Arc::clone(&auth)),
            Arc::new(HashMap::new()),
        );
        crate::router::<()>(state.clone())
            .layer(axum::middleware::from_fn_with_state(state, authenticate))
            .merge(well_known_router(auth))
    }

    /// A ping to `path`.
    async fn send(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
    ) -> (StatusCode, Option<String>, String) {
        send_body(
            app,
            method,
            path,
            token,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        )
        .await
    }

    async fn send_body(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: &str,
    ) -> (StatusCode, Option<String>, String) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(body.to_owned())).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let challenge = response
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            challenge,
            String::from_utf8(body.to_vec()).expect("utf-8"),
        )
    }

    #[test]
    fn a_workspace_url_names_one_workspace_in_unreserved_characters() {
        assert_eq!(path_workspace("/mcp"), Ok(None));
        assert_eq!(path_workspace("/mcp/w/ws_01HX"), Ok(Some("ws_01HX")));
        assert_eq!(path_workspace("/mcp/w/acme-bv"), Ok(Some("acme-bv")));
        for path in [
            "/mcp/",
            "/mcp/w/",
            "/mcp/x/ws_1",
            "/mcp/w/a b",
            "/mcp/w/a%20b",
            "/mcpx",
            "/other",
        ] {
            assert_eq!(path_workspace(path), Err(()), "{path}");
        }
        assert_eq!(
            path_workspace(&format!("/mcp/w/{}", "x".repeat(256))),
            Err(())
        );
    }

    #[tokio::test]
    async fn the_401_points_at_the_metadata_of_the_url_the_client_called() {
        let app = app(selector(&[]));
        let (status, challenge, _) = send(&app, "POST", "/mcp", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            challenge.as_deref(),
            Some(
                "Bearer resource_metadata=\"https://app.example.eu/.well-known/oauth-protected-resource/mcp\""
            )
        );
        let (status, challenge, body) =
            send(&app, "POST", "/mcp/w/ws_acme", Some("not-a-jwt")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(
            challenge.as_deref(),
            Some(
                "Bearer resource_metadata=\"https://app.example.eu/.well-known/oauth-protected-resource/mcp/w/ws_acme\""
            )
        );
        // A path that names no usable workspace is no endpoint at all.
        let (status, _, _) = send(&app, "POST", "/mcp/w/a%20b", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn each_metadata_document_names_the_url_it_was_looked_up_for_and_the_issuer() {
        let app = app(selector(&[]));
        let issuer = fixture()["issuer"].as_str().expect("issuer").to_owned();
        for (path, resource) in [
            ("/.well-known/oauth-protected-resource", SERVER.to_owned()),
            (
                "/.well-known/oauth-protected-resource/mcp",
                format!("{SERVER}/mcp"),
            ),
            (
                "/.well-known/oauth-protected-resource/mcp/w/ws_acme",
                format!("{SERVER}/mcp/w/ws_acme"),
            ),
        ] {
            let (status, _, body) = send(&app, "GET", path, None).await;
            assert_eq!(status, StatusCode::OK, "{path}: {body}");
            let document: Value = serde_json::from_str(&body).expect("json");
            assert_eq!(document["resource"], resource, "{path}");
            assert_eq!(document["authorization_servers"], json!([issuer]), "{path}");
            // WeldID's tokens name no workspace: plain OIDC scopes only.
            assert_eq!(document["scopes_supported"], json!(OIDC_SCOPES), "{path}");
        }
        let (status, _, _) = send(
            &app,
            "GET",
            "/.well-known/oauth-protected-resource/mcp/w/a%20b",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_url_names_the_workspace_and_memberships_decide() {
        let fixture = fixture();
        let user = fixture["user"].as_str().expect("user");
        let token = fixture["tokens"]["longLived"].as_str().expect("token");
        let app = app(selector(&[
            (user, "ws_member", "org_member"),
            (user, "member-co", "org_member"),
        ]));

        // A workspace the user belongs to: on to its tenant database (none
        // here, so that lookup fails), past the membership check.
        for path in ["/mcp/w/ws_member", "/mcp/w/member-co"] {
            let (status, _, body) = send(&app, "POST", path, Some(token)).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}: {body}");
            assert!(body.contains("Could not resolve workspace"), "{body}");
        }
        // One they don't: refused before any lookup, unknown and foreign alike.
        for path in ["/mcp/w/ws_other", "/mcp/w/nope"] {
            let (status, _, body) = send(&app, "POST", path, Some(token)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
            assert!(body.contains("not a member of this workspace"), "{body}");
        }
        // No workspace in the URL: their only one.
        let (status, _, body) = send(&app, "POST", "/mcp", Some(token)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body.contains("Could not resolve workspace"), "{body}");
    }

    #[tokio::test]
    async fn without_a_workspace_in_the_url_several_memberships_get_the_picker() {
        let fixture = fixture();
        let user = fixture["user"].as_str().expect("user");
        let token = fixture["tokens"]["longLived"].as_str().expect("token");

        let several = app(selector(&[(user, "acme", "ws_a"), (user, "beta", "ws_b")]));
        // Connected, though no workspace (and no tenant database, which this
        // app hasn't got) is looked up.
        let (status, _, body) = send(&several, "POST", "/mcp", Some(token)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, _, body) = send_body(
            &several,
            "POST",
            "/mcp",
            Some(token),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let tools: Value = serde_json::from_str(&body).expect("json");
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(names, ["list_workspaces"]);
        // Its one tool names each workspace with the address that selects it.
        let (status, _, body) = send_body(
            &several,
            "POST",
            "/mcp",
            Some(token),
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_workspaces","arguments":{}}}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body.contains("ACME: https://app.example.eu/mcp/w/acme"),
            "{body}"
        );
        assert!(
            body.contains("BETA: https://app.example.eu/mcp/w/beta"),
            "{body}"
        );
        // Naming one of them works: on to its tenant database.
        let (status, _, body) = send(&several, "POST", "/mcp/w/beta", Some(token)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body.contains("Could not resolve workspace"), "{body}");

        let none = app(selector(&[]));
        let (status, _, body) = send(&none, "POST", "/mcp", Some(token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("not a member of any workspace"), "{body}");
    }

    #[tokio::test]
    async fn a_failed_membership_lookup_is_an_error_not_a_refusal() {
        let token = fixture()["tokens"]["longLived"]
            .as_str()
            .expect("token")
            .to_owned();
        let down = app(WorkspaceSelector::new(Arc::new(Memberships {
            down: true,
            ..Memberships::default()
        })));
        for path in ["/mcp", "/mcp/w/ws_member"] {
            let (status, _, body) = send(&down, "POST", path, Some(&token)).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{path}: {body}");
        }
    }
}
