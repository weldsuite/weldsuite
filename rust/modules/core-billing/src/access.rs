//! What every handler reads from the request: the caller ([`Caller`]), the
//! errors the routes answer with ([`BillingError`]), and body validation.
//! The same shape as `weldsuite-core-platform`'s, which this crate may not
//! depend on (module crates never depend on each other).

use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_permissions::Permissions;
use weldsuite_ports::OutboundHttp;

use crate::BillingState;

/// A signed-in member in a workspace: behind the session and tenant layers.
pub struct Caller {
    /// The tenant database.
    pub db: PgPool,
    pub user_id: String,
    /// The session's org, when it has one.
    pub org_id: Option<String>,
    /// The workspace's Clerk org id (the identity provider's organization).
    pub clerk_org_id: Option<String>,
    /// `workspaces.id`.
    pub workspace_id: String,
    pub permissions: Option<Permissions>,
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl Caller {
    /// The master database (the test's in conformance mode).
    pub fn master(&self, state: &BillingState) -> PgPool {
        self.master.clone().unwrap_or_else(|| state.master.clone())
    }

    /// The request's outbound client (conformance) or the process's.
    pub fn http(&self, state: &BillingState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// Whether the resolved permissions hold `key`.
    pub fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// The organization the identity provider knows the workspace by.
    pub fn organization(&self) -> &str {
        self.clerk_org_id
            .as_deref()
            .or(self.org_id.as_deref())
            .unwrap_or(&self.workspace_id)
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
                clerk_org_id: tenant.clerk_org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
                http: parts.extensions.get::<OutboundHttp>().cloned(),
            })
        } else {
            tracing::error!("core-billing: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// How a route fails. [`BillingError::respond`] writes the API's envelope.
#[derive(Debug)]
pub enum BillingError {
    /// A refusal the route wrote itself.
    Api(ApiError),
    /// A response written as is (a validation 400).
    Response(Box<Response>),
    /// Logged, answered with a 500 and the message.
    Internal(&'static str, String),
    Database(sqlx::Error),
}

impl BillingError {
    /// `error.internal(c, message)` after `cause` (logged).
    pub fn internal(message: &'static str, cause: impl std::fmt::Display) -> Self {
        Self::Internal(message, cause.to_string())
    }

    pub fn respond(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Response(response) => *response,
            Self::Internal(message, cause) => {
                tracing::error!(cause, "core-billing: {message}");
                ApiError::internal().with_message(message).into_response()
            }
            Self::Database(error) => {
                tracing::error!(%error, "core-billing: database error");
                ApiError::internal().into_response()
            }
        }
    }
}

impl From<sqlx::Error> for BillingError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for BillingError {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

pub type BillingResult<T> = Result<T, BillingError>;

/// The route's answer, or its error as the API's envelope.
pub(crate) fn answer(result: BillingResult<Response>) -> Response {
    result.unwrap_or_else(BillingError::respond)
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> BillingResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| BillingError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| BillingError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| BillingError::Api(ApiError::internal()))
}
