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
//!   "env": { "PERMISSIONS_APP_ENFORCE": "true" } }
//! ```

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use axum::extract::{MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_kit::ApiError;
use weldsuite_permissions::{AppContext, Permissions, ResolvedPermissions};

use crate::server::AppEnforcedOverride;

pub(crate) const HEADER: &str = "x-weld-conformance";

/// The route that answered, written as Hono writes it (`/api/companies/:id`),
/// for the conformance report.
const ROUTE_HEADER: &str = "x-weld-route";

/// `/api/companies/{id}` → `/api/companies/:id`.
fn hono_pattern(axum_path: &str) -> String {
    axum_path
        .split('/')
        .map(|segment| {
            segment
                .strip_prefix('{')
                .and_then(|s| s.strip_suffix('}'))
                .map_or_else(|| segment.to_owned(), |name| format!(":{name}"))
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
    permissions: Option<TestPermissions>,
    #[serde(default)]
    env: HashMap<String, String>,
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
pub(crate) struct Pools(Mutex<HashMap<String, PgPool>>);

impl Pools {
    fn get(&self, url: &str) -> Result<PgPool, ApiError> {
        let mut pools = self.0.lock().unwrap_or_else(PoisonError::into_inner);
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
    let Some(context) = request
        .headers()
        .get(HEADER)
        .and_then(|value| STANDARD.decode(value.as_bytes()).ok())
        .and_then(|bytes| serde_json::from_slice::<TestContext>(&bytes).ok())
    else {
        return ApiError::unauthorized()
            .with_message("Missing or invalid Authorization header")
            .into_response();
    };
    let db = match pools.get(&context.database_url) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };

    let app_enforced = context
        .env
        .get("PERMISSIONS_APP_ENFORCE")
        .map(|value| value == "true");
    let extensions = request.extensions_mut();
    if let Some(enforced) = app_enforced {
        extensions.insert(AppEnforcedOverride(enforced));
    }
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
