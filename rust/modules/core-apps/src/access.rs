//! What the handlers read from the request: the caller in a workspace
//! ([`Caller`]), a signed-in user without one ([`SignedIn`]), or nobody
//! ([`Public`]), each with the request's overrides of the app state's ports
//! (conformance mode); the errors the routes answer with ([`AppsError`]);
//! and body validation.

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
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{
    DynCache, DynFileStore, FileStores, Identity, IdentityProvider, RequestCache,
};

use crate::CoreAppsState;
use crate::http_transport::{AppsHttp, HttpTransport};

/// The request's overrides (conformance mode) of the app state's ports.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    master: Option<PgPool>,
    identity: Option<Arc<dyn Identity>>,
    files: Option<FileStores>,
    env: Option<RequestEnv>,
    cache: Option<Arc<dyn DynCache>>,
    http: Option<Arc<dyn HttpTransport>>,
}

impl Overrides {
    fn from_parts(parts: &Parts) -> Self {
        Self {
            master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
            identity: parts
                .extensions
                .get::<IdentityProvider>()
                .map(|p| Arc::clone(&p.0)),
            files: parts.extensions.get::<FileStores>().cloned(),
            env: parts.extensions.get::<RequestEnv>().cloned(),
            cache: parts
                .extensions
                .get::<RequestCache>()
                .map(|c| Arc::clone(&c.0)),
            http: parts.extensions.get::<AppsHttp>().map(|h| Arc::clone(&h.0)),
        }
    }

    pub(crate) fn master(&self, state: &CoreAppsState) -> PgPool {
        self.master.clone().unwrap_or_else(|| state.master.clone())
    }

    pub(crate) fn identity(&self, state: &CoreAppsState) -> Option<Arc<dyn Identity>> {
        self.identity.clone().or_else(|| state.identity.clone())
    }

    /// `c.env.STORAGE`: the public bucket.
    pub(crate) fn storage(&self, state: &CoreAppsState) -> Option<Arc<dyn DynFileStore>> {
        self.files
            .clone()
            .or_else(|| state.files.clone())
            .and_then(|stores| stores.public)
    }

    /// `c.env.WORKSPACE_CACHE`.
    pub(crate) fn cache(&self, state: &CoreAppsState) -> Result<Arc<dyn DynCache>, AppsError> {
        self.cache
            .clone()
            .or_else(|| state.cache.clone())
            .ok_or_else(|| AppsError::internal("The workspace cache is not configured", "no cache"))
    }

    pub(crate) fn http(&self, state: &CoreAppsState) -> Arc<dyn HttpTransport> {
        self.http.clone().unwrap_or_else(|| Arc::clone(&state.http))
    }

    /// `c.env.<name>`: the request's env (conformance mode) or the app's.
    pub(crate) fn env<'a>(&'a self, state: &'a CoreAppsState, name: &str) -> Option<&'a str> {
        match &self.env {
            Some(env) => env.get(name),
            None => state.env.get(name).map(String::as_str),
        }
    }
}

/// A signed-in member in a workspace: behind the session and tenant layers.
pub(crate) struct Caller {
    /// The tenant database.
    pub(crate) db: PgPool,
    /// `c.get('userId')`.
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the org of the session.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    pub(crate) permissions: Option<Permissions>,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    pub(crate) fn master(&self, state: &CoreAppsState) -> PgPool {
        self.overrides.master(state)
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CoreAppsState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }
}

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
                org_id: auth.org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                events: EventContext::for_request(auth, tenant),
                overrides: Overrides::from_parts(parts),
            })
        } else {
            tracing::error!("core-apps: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A signed-in user, with or without a workspace (`clerkMiddleware()`
/// only): `/api/auth-desktop`.
pub(crate) struct SignedIn {
    pub(crate) user_id: String,
    pub(crate) overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for SignedIn {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let caller = if let Some(auth) = parts.extensions.get::<AuthContext>() {
            Ok(Self {
                user_id: auth.user_id.clone(),
                overrides: Overrides::from_parts(parts),
            })
        } else {
            tracing::error!("core-apps: a signed-in route without the session layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// Anyone: the bundle host and the CLI's device login. Only the overrides.
pub(crate) struct Public {
    pub(crate) overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Public {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            overrides: Overrides::from_parts(parts),
        }))
    }
}

/// How a route fails. [`AppsError::respond`] writes the workers' envelope.
#[derive(Debug)]
pub(crate) enum AppsError {
    /// A response the route wrote itself (validation, a refusal).
    Response(Box<Response>),
    /// `error.internal(c, message)`: logged, answered with a 500.
    Internal(&'static str, String),
}

impl AppsError {
    pub(crate) fn api(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }

    /// `error.internal(c, message)` after `cause` (logged).
    pub(crate) fn internal(message: &'static str, cause: impl std::fmt::Display) -> Self {
        Self::Internal(message, cause.to_string())
    }

    pub(crate) fn respond(self) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Internal(message, cause) => {
                tracing::error!(cause, "core-apps: {message}");
                ApiError::internal().with_message(message).into_response()
            }
        }
    }
}

impl From<ApiError> for AppsError {
    fn from(error: ApiError) -> Self {
        Self::api(error)
    }
}

pub(crate) type AppsResult<T> = Result<T, AppsError>;

/// The route's answer, or its error as the API's envelope.
pub(crate) fn answer(result: AppsResult<Response>) -> Response {
    result.unwrap_or_else(AppsError::respond)
}

/// A database error inside a route's `try`: `error.internal(c, message)`.
pub(crate) trait OrInternal<T> {
    fn or_internal(self, message: &'static str) -> AppsResult<T>;
}

impl<T, E: std::fmt::Display> OrInternal<T> for Result<T, E> {
    fn or_internal(self, message: &'static str) -> AppsResult<T> {
        self.map_err(|error| AppsError::internal(message, error))
    }
}

/// `new Date()` as Drizzle writes it: bind as text, cast `::timestamptz`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> AppsResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| AppsError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| AppsError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| AppsError::Response(Box::new(ApiError::internal().into_response())))
}
