//! What every integration handler shares: who is asking ([`Caller`]), what
//! conformance builds hand a request in place of the state's
//! ([`Overrides`]), a route's answer off the happy path ([`Refusal`]) and
//! the body and query validation (`zValidator`). The same as WeldConnect's
//! (`weldsuite-connect`), whose crate these routes were served from until
//! they became core platform functionality: module crates never share code,
//! so each keeps its own.

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
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EventContext, iso_timestamp, publish_entity_event};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{DynCache, OutboundHttp, RequestCache};

use crate::IntegrationsState;

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
pub(crate) struct Unreachable;

impl weldsuite_ports::DynOutboundHttp for Unreachable {
    fn send(
        &self,
        _request: weldsuite_ports::HttpRequest,
    ) -> weldsuite_ports::BoxFuture<
        '_,
        Result<weldsuite_ports::HttpResponse, weldsuite_ports::PortError>,
    > {
        Box::pin(std::future::ready(Err(
            weldsuite_ports::PortError::backend("no outbound HTTP client"),
        )))
    }
}

/// What conformance builds hand a request in place of the state's.
#[derive(Clone, Default)]
pub(crate) struct Overrides {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) cache: Option<RequestCache>,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) master: Option<weldsuite_db::MasterDb>,
    pub(crate) buckets: Option<weldsuite_ports::StorageBuckets>,
}

impl Overrides {
    pub(crate) fn from_extensions(extensions: &http::Extensions) -> Self {
        Self {
            env: extensions.get::<RequestEnv>().cloned(),
            cache: extensions.get::<RequestCache>().cloned(),
            http: extensions.get::<OutboundHttp>().cloned(),
            master: extensions.get::<weldsuite_db::MasterDb>().cloned(),
            buckets: extensions.get::<weldsuite_ports::StorageBuckets>().cloned(),
        }
    }

    /// `c.env.<name>`: the request's env first (conformance), then the state's.
    pub(crate) fn env(&self, state: &IntegrationsState, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        state.env.get(name).cloned()
    }

    /// `c.env.STORAGE`: the request's bucket (conformance, which may have
    /// none), else the state's.
    pub(crate) fn storage(
        &self,
        state: &IntegrationsState,
    ) -> Option<Arc<dyn weldsuite_ports::DynFileStore>> {
        match &self.buckets {
            Some(buckets) => buckets.public.clone(),
            None if self.env.is_some() => None,
            None => state.storage.clone(),
        }
    }

    /// The workspace cache: the request's (conformance), else the state's.
    pub(crate) fn kv(&self, state: &IntegrationsState) -> Option<Arc<dyn DynCache>> {
        match &self.cache {
            Some(cache) => Some(Arc::clone(&cache.0)),
            None if self.env.is_some() => None,
            None => state.cache.clone(),
        }
    }

    /// Third-party HTTP: the request's (conformance), else the state's.
    pub(crate) fn http(&self, state: &IntegrationsState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    /// Outbound webhook deliveries: through the request's outbound HTTP
    /// (conformance), else the state's client; without either every attempt
    /// fails as a `fetch` that cannot connect.
    pub(crate) fn webhook_attempts(
        &self,
        state: &IntegrationsState,
    ) -> Arc<dyn weldsuite_subscribers::DeliveryAttempts> {
        if let Some(http) = &self.http {
            return Arc::new(weldsuite_subscribers::OutboundAttempts(http.clone()));
        }
        match &state.webhooks {
            Some(webhooks) if self.env.is_none() => Arc::clone(webhooks),
            _ => Arc::new(weldsuite_subscribers::OutboundAttempts(OutboundHttp(
                Arc::new(Unreachable),
            ))),
        }
    }

    /// The master database: the request's (conformance), else the state's.
    pub(crate) fn master(&self, state: &IntegrationsState) -> Option<PgPool> {
        self.master
            .as_ref()
            .map(|master| master.0.clone())
            .or_else(|| state.master.clone())
    }
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`: the session's organization.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: String,
    pub(crate) events: EventContext,
    pub(crate) overrides: Overrides,
}

impl Caller {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &IntegrationsState,
        event: impl Into<weldsuite_events::EventType>,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }
}

/// Behind the session, tenant database and permission layers; without them
/// it is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let permissions = parts.extensions.get::<Permissions>();
        let caller = if let (Some(auth), Some(tenant), Some(_)) = (auth, tenant, permissions) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                org_id: auth.org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                clerk_org_id: tenant
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| tenant.workspace_id.clone()),
                events: EventContext::for_request(auth, tenant),
                overrides: Overrides::from_extensions(&parts.extensions),
            })
        } else {
            tracing::error!(
                "integrations: a route without the session, tenant or permission layer"
            );
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response the route writes itself
/// (400, 404, a validation failure), or a database error the route maps to
/// its 500 with its own message.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sea_orm::DbErr),
}

impl From<sea_orm::DbErr> for Refusal {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Database(error)
    }
}

/// SQL that stays SQL, through [`weldsuite_db::orm_error`].
impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(weldsuite_db::orm_error(error))
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl From<Response> for Refusal {
    fn from(response: Response) -> Self {
        Self::Response(Box::new(response))
    }
}

impl Refusal {
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    /// The response; a database error is logged and answered with a 500
    /// carrying `fallback` (`error.internal(c, fallback)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => internal(&error, fallback),
        }
    }
}

/// A 500 carrying the route's message, after logging what went wrong.
pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[connect-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let rejected = |response: Response| Refusal::Response(Box::new(response));
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(|bad| rejected(bad.into_response()))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| rejected(invalid.into_response()))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('query', schema)`: the query string read by `read`, or the
/// 400 with the schema's issues.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let fields = weldsuite_kit::validation::query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &fields);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}
