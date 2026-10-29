//! What every handler of the crate reads from the request: the caller
//! ([`Caller`]), the errors the routes answer with ([`PlatformError`]), and
//! body and query validation.
//!
//! The same shape as `weldsuite-core-team`'s, which this crate may not depend
//! on (module crates never depend on each other).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{Identity, IdentityProvider};

use crate::CorePlatformState;

/// The request's overrides (conformance mode) of the app state's ports.
#[derive(Clone, Default)]
struct Overrides {
    master: Option<PgPool>,
    identity: Option<Arc<dyn Identity>>,
    env: Option<RequestEnv>,
}

impl Overrides {
    fn from_parts(parts: &Parts) -> Self {
        Self {
            master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
            identity: parts
                .extensions
                .get::<IdentityProvider>()
                .map(|p| Arc::clone(&p.0)),
            env: parts.extensions.get::<RequestEnv>().cloned(),
        }
    }
}

/// A signed-in member in a workspace: behind the session and tenant layers.
pub struct Caller {
    /// The tenant database.
    pub db: PgPool,
    /// `c.get('userId')`.
    pub user_id: String,
    /// `c.get('sessionId')`: the session token's `sid` (empty without one).
    pub session_id: String,
    /// `c.get('orgId')`: the org of the session, when it has one.
    pub org_id: Option<String>,
    /// `c.get('clerkOrgId')`: the workspace's Clerk org id.
    pub clerk_org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub workspace_id: String,
    /// The caller's permissions, when a gate layer resolved them (routes
    /// that check inside the handler carry `gate.resolve()`).
    pub permissions: Option<Permissions>,
    pub events: EventContext,
    overrides: Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`; false when nothing resolved them.
    pub fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// The master database (the test's in conformance mode).
    pub fn master(&self, state: &CorePlatformState) -> PgPool {
        self.overrides
            .master
            .clone()
            .unwrap_or_else(|| state.master.clone())
    }

    /// The identity provider, if any.
    pub fn identity(&self, state: &CorePlatformState) -> Option<Arc<dyn Identity>> {
        self.overrides
            .identity
            .clone()
            .or_else(|| state.identity.clone())
    }

    /// A per-request env value (conformance mode forwards a few).
    pub fn env(&self, name: &str) -> Option<&str> {
        self.overrides.env.as_ref().and_then(|env| env.get(name))
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub fn publish(
        &self,
        state: &CorePlatformState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }
}

/// Behind the session and tenant layers; without them it is a routing
/// mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let caller = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                session_id: auth.session_id.clone(),
                org_id: auth.org_id.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                events: EventContext::for_request(auth, tenant),
                overrides: Overrides::from_parts(parts),
            })
        } else {
            tracing::error!("core-platform: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// How a route fails. [`PlatformError::respond`] writes the workers' envelope.
#[derive(Debug)]
pub enum PlatformError {
    /// A response the route wrote itself (validation, a refusal).
    Response(Box<Response>),
    /// `error.internal(c, message)`: logged, answered with a 500.
    Internal(&'static str, String),
    Database(sqlx::Error),
}

impl PlatformError {
    /// A refusal or answer the route writes as is.
    pub fn api(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }

    /// `error.internal(c, message)` after `cause` (logged).
    pub fn internal(message: &'static str, cause: impl std::fmt::Display) -> Self {
        Self::Internal(message, cause.to_string())
    }

    pub fn respond(self) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Internal(message, cause) => {
                tracing::error!(cause, "core-platform: {message}");
                ApiError::internal().with_message(message).into_response()
            }
            Self::Database(error) => {
                tracing::error!(%error, "core-platform: database error");
                ApiError::internal().into_response()
            }
        }
    }
}

impl From<sqlx::Error> for PlatformError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for PlatformError {
    fn from(error: ApiError) -> Self {
        Self::api(error)
    }
}

pub type PlatformResult<T> = Result<T, PlatformError>;

/// The route's answer, or its error as the API's envelope.
pub fn answer(result: PlatformResult<Response>) -> Response {
    result.unwrap_or_else(PlatformError::respond)
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bind as text
/// and cast with `::timestamptz` (or `::timestamp`).
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> PlatformResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| PlatformError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| PlatformError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| PlatformError::Response(Box::new(ApiError::internal().into_response())))
}

/// `zValidator('query', schema)`.
pub fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> PlatformResult<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| PlatformError::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}
