//! What every handler reads from the request ([`Caller`]), how routes fail
//! ([`ChatError`]), and body and query validation.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_chat_domain::{Can, Realtime};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EventContext, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_notifications::{ApnsConfig, Notifier};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{
    DynCache, DynFileStore, FileStores, OutboundHttp, PresenceReader, RequestCache, StorageBuckets,
};

use crate::ChatState;

/// The request's overrides (conformance mode) of the app state's ports.
#[derive(Clone, Default)]
struct Overrides {
    env: Option<RequestEnv>,
    cache: Option<RequestCache>,
    files: Option<FileStores>,
    buckets: Option<StorageBuckets>,
    http: Option<OutboundHttp>,
    presence: Option<PresenceReader>,
}

/// A signed-in member in a workspace.
pub struct Caller {
    pub db: PgPool,
    /// `c.get('userId')`.
    pub user_id: String,
    /// `c.get('orgId')`: the session's org.
    pub org_id: Option<String>,
    /// `c.get('clerkOrgId')`.
    pub clerk_org_id: Option<String>,
    /// `c.get('workspaceId')`.
    pub workspace_id: String,
    pub permissions: Option<Permissions>,
    pub events: EventContext,
    overrides: Overrides,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// The request's permissions as a [`Can`] (`{ can: (p) => hasContextPermission(c, p) }`).
    /// Without resolved permissions every check fails, as TypeScript's does.
    pub fn context_can(&self) -> Option<Can<'_>> {
        self.permissions.as_ref().map(Can::Context)
    }

    /// `orgId` or the 400 `error.orgRequired(c)`.
    pub fn org(&self) -> ChatResult<&str> {
        self.org_id
            .as_deref()
            .filter(|org| !org.is_empty())
            .ok_or_else(|| ChatError::api(ApiError::org_required()))
    }

    /// A per-request env value (conformance forwards a few), else the app's.
    pub fn env<'a>(&'a self, state: &'a ChatState, name: &str) -> Option<&'a str> {
        match &self.overrides.env {
            Some(env) => env.get(name),
            None => state.env.get(name).map(String::as_str),
        }
    }

    /// `WORKSPACE_CACHE`: the request's (the test's KV), else the app's.
    pub fn cache(&self, state: &ChatState) -> Option<Arc<dyn DynCache>> {
        self.overrides
            .cache
            .as_ref()
            .map(|RequestCache(cache)| Arc::clone(cache))
            .or_else(|| state.cache.clone())
    }

    /// The `STORAGE` bucket.
    pub fn files(&self, state: &ChatState) -> Option<FileStores> {
        self.overrides.files.clone().or_else(|| state.files.clone())
    }

    /// The `STORAGE` bucket (the public store): the test's in conformance
    /// mode, else the app's.
    pub fn public_store(&self, state: &ChatState) -> Option<Arc<dyn DynFileStore>> {
        match &self.overrides.buckets {
            Some(buckets) => buckets.public.clone(),
            None => state.files.as_ref().and_then(|files| files.public.clone()),
        }
    }

    /// Live presence.
    pub fn presence(&self, state: &ChatState) -> Option<PresenceReader> {
        self.overrides
            .presence
            .clone()
            .or_else(|| state.presence.clone())
    }

    /// The realtime publisher.
    pub fn realtime(state: &ChatState) -> Realtime {
        Realtime::new(state.realtime.clone())
    }

    /// Where notifications go out.
    pub fn notifier(&self, state: &ChatState) -> Notifier {
        Notifier {
            realtime: state.realtime.clone(),
            http: self.overrides.http.clone().or_else(|| state.http.clone()),
            apns: ApnsConfig::from_values(
                self.env(state, "APNS_KEY_ID"),
                self.env(state, "APNS_TEAM_ID"),
                self.env(state, "APNS_PRIVATE_KEY"),
            ),
        }
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub fn publish(&self, state: &ChatState, event: EventName, entity_id: &str, data: &Value) {
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
                clerk_org_id: tenant.clerk_org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                events: EventContext::for_request(auth, tenant),
                overrides: Overrides {
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    cache: parts.extensions.get::<RequestCache>().cloned(),
                    files: parts.extensions.get::<FileStores>().cloned(),
                    buckets: parts.extensions.get::<StorageBuckets>().cloned(),
                    http: parts.extensions.get::<OutboundHttp>().cloned(),
                    presence: parts.extensions.get::<PresenceReader>().cloned(),
                },
            })
        } else {
            tracing::error!("chat: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// How a route fails.
#[derive(Debug)]
pub enum ChatError {
    /// A response the route wrote itself.
    Response(Box<Response>),
    Database(sqlx::Error),
}

impl ChatError {
    pub fn api(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::api(ApiError::bad_request(message))
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::api(ApiError::forbidden().with_message(message))
    }

    pub fn not_found(resource: &str, id: Option<&str>) -> Self {
        Self::api(ApiError::not_found(resource, id))
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::api(ApiError::conflict(message))
    }

    /// The answer; a database error is the route's 500 with `fallback`.
    pub fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[chat-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for ChatError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for ChatError {
    fn from(error: ApiError) -> Self {
        Self::api(error)
    }
}

pub type ChatResult<T> = Result<T, ChatError>;

/// The route's answer, or its failure with `fallback` as the 500's message.
pub fn answer(result: ChatResult<Response>, fallback: &str) -> Response {
    result.unwrap_or_else(|error| error.respond(fallback))
}

/// A database error outside the route's own try/catch: Hono's error
/// handler answers 500 with its default message.
pub fn unhandled(error: ChatError) -> Response {
    match error {
        ChatError::Response(response) => *response,
        ChatError::Database(error) => {
            tracing::error!(%error, "[chat-api] unhandled");
            ApiError::internal().into_response()
        }
    }
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> ChatResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| ChatError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| ChatError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| ChatError::api(ApiError::internal()))
}

/// `zValidator('query', schema)`.
pub fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> ChatResult<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| ChatError::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}
