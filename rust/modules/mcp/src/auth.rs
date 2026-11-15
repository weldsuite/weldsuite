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
//! The discovery documents follow the sign-in ([`Discovery`]): with Clerk
//! they are Global's, field for field; with an OIDC provider they name its
//! endpoints and the scopes its tokens need, and the authorization server's
//! metadata is the provider's `openid-configuration`.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderValue, StatusCode, header};
use serde_json::{Value, json};
use weldsuite_auth::SessionVerifier;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_db::{Tenant, WorkspaceError};
use weldsuite_permissions::resolve_effective_permissions;
use weldsuite_ports::{HttpRequest, OutboundHttp};

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
}

impl std::fmt::Debug for McpAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpAuth")
            .field("issuer", &self.issuer)
            .field("server_url", &self.server_url)
            .field("discovery", &self.discovery)
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

fn metadata_url(server_url: &str) -> String {
    format!(
        "{}{PROTECTED_RESOURCE_PATH}",
        server_url.trim_end_matches('/')
    )
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
    let unauthorized = |message: &str, diagnostic: &str| {
        tracing::warn!(diagnostic, "mcp auth: 401");
        let mut response = jsonrpc_error(StatusCode::UNAUTHORIZED, -32001, message);
        if let Ok(value) = HeaderValue::from_str(&format!(
            "Bearer resource_metadata=\"{}\"",
            metadata_url(&auth.server_url)
        )) {
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
    let Some(org) = context.org_id.clone() else {
        return unauthorized(
            auth.discovery.no_organization_message(),
            "no organization claim",
        );
    };
    let tenant = match state.workspaces.tenant(&org).await {
        Ok(tenant) => tenant,
        Err(WorkspaceError::NotFound | WorkspaceError::NoDatabase) => {
            return jsonrpc_error(
                StatusCode::FORBIDDEN,
                -32003,
                "No WeldSuite workspace is linked to the selected organization.",
            );
        }
        Err(error) => {
            tracing::error!(%error, "mcp auth: workspace lookup failed");
            return jsonrpc_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                -32603,
                "Could not resolve workspace.",
            );
        }
    };
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
        return jsonrpc_error(
            StatusCode::FORBIDDEN,
            -32003,
            "You are not a member of this workspace.",
        );
    }
    if resolved.permissions.is_empty() {
        return jsonrpc_error(
            StatusCode::FORBIDDEN,
            -32003,
            &format!(
                "Your workspace role ({}) grants no permissions, so no tools are available. Expected one of OWNER, ADMIN, MEMBER or VIEWER, or a custom role with permissions assigned.",
                resolved.role
            ),
        );
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
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select w.name, p.slug from workspaces w left join plans p on p.id = w.plan_id where w.id = $1 limit 1",
    )
    .bind(&tenant.workspace_id)
    .fetch_optional(&state.master)
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

/// RFC 9728's document for `{server_url}{resource_path}`.
fn protected_resource_document(
    issuer: &str,
    server_url: &str,
    resource_path: &str,
    discovery: &Discovery,
) -> Value {
    let resource = format!("{}{resource_path}", server_url.trim_end_matches('/'));
    match discovery {
        Discovery::Clerk => json!({
            "resource": resource,
            "authorization_servers": [issuer],
            "token_types_supported": ["urn:ietf:params:oauth:token-type:access_token"],
            "token_introspection_endpoint": format!("{issuer}/oauth/token"),
            "token_introspection_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
            "jwks_uri": format!("{issuer}/.well-known/jwks.json"),
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

fn protected_resource(auth: &McpAuth, resource_path: &str) -> Response {
    let Some(issuer) = &auth.issuer else {
        return metadata_cors(
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({ "error": "server_error", "error_description": "Protected resource metadata unavailable" })),
            )
                .into_response(),
        );
    };
    metadata_cors(
        axum::Json(protected_resource_document(
            issuer,
            &auth.server_url,
            resource_path,
            &auth.discovery,
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
    let metadata = match (&auth.issuer, &auth.outbound) {
        (Some(issuer), Some(outbound)) => {
            authorization_server_metadata(issuer, outbound, &auth.discovery).await
        }
        _ => None,
    };
    match metadata {
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

/// The discovery documents, unauthenticated, at their root paths.
pub fn well_known_router(auth: Arc<McpAuth>) -> Router {
    let preflight = || async { metadata_cors(StatusCode::NO_CONTENT.into_response()) };
    let (a, b, c) = (Arc::clone(&auth), Arc::clone(&auth), auth);
    Router::new()
        .route(
            PROTECTED_RESOURCE_PATH,
            get(move || async move { protected_resource(&a, "") }).options(preflight),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(move || async move { protected_resource(&b, "/mcp") }).options(preflight),
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
        let document = protected_resource_document(
            "https://auth.example.eu",
            "https://app.example.eu/",
            "/mcp",
            &discovery,
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
        let clerk = protected_resource_document(
            "https://clerk.example.org",
            "https://mcp.example.org",
            "",
            &Discovery::Clerk,
        );
        assert_eq!(clerk["resource"], "https://mcp.example.org");
        assert_eq!(
            clerk["jwks_uri"],
            "https://clerk.example.org/.well-known/jwks.json"
        );
        assert_eq!(clerk["scopes_supported"], json!(CLERK_SCOPES));
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
