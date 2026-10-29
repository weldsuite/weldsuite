//! WeldCRM: the `/api` routes crm-api serves (`apps/workers/crm-api`), on
//! the CRM services of `weldsuite-crm-domain` (`@weldsuite/crm-domain`).
//!
//! Companies, people and their links, leads, opportunities, pipelines and
//! their stages and field visibility, activities, customer statuses, lists,
//! CRM analytics, company logos, sequences and customer sequences, and the
//! record chats it forwards to chat-api.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `crm`
//! conformance suites (`rust/conformance/suites.json`).

mod activities;
mod customer_statuses;
mod field_visibility;
mod leads;
mod lists;
mod opportunities;
mod person_companies;
mod pipeline_stages;
mod pipelines;
mod schema;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_catalogs::permission_keys as keys;
use weldsuite_crm_domain::events::OrderedEvents;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EventContext, iso_timestamp};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynCache, FileStores, RequestCache};

pub use weldsuite_crm_domain::CrmServices;

/// The settings crm-api reads off its `env`, from the process environment.
pub fn env_from_process() -> std::collections::HashMap<String, String> {
    [
        "R2_PUBLIC_URL",
        "ENVIRONMENT",
        "CF_ACCOUNT_ID",
        "R2_SQL_API_TOKEN",
        "R2_ANALYTICS_BUCKET",
    ]
    .iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| ((*name).to_owned(), value))
    })
    .collect()
}

/// What the CRM handlers share: the app's ports, which a conformance request
/// may override with its own (buckets, KV).
#[derive(Clone)]
pub struct CrmState {
    pub services: CrmServices,
}

/// Every crm-api route, at its full path under `/api` (`/companies`,
/// `/leads/{id}`, …), to merge into the `/api` router behind the session,
/// tenant database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
#[allow(clippy::too_many_lines)] // one block per object, as crm-api mounts them
pub fn router<S, Q>(state: CrmState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &'static str| gate.require([key]);
    Router::new()
        // Activities
        .route(
            "/activities",
            get(activities::list).route_layer(need(keys::ACTIVITIES_READ)),
        )
        .route(
            "/activities",
            post(activities::create).route_layer(need(keys::ACTIVITIES_CREATE)),
        )
        .route(
            "/activities/{id}",
            get(activities::detail).route_layer(need(keys::ACTIVITIES_READ)),
        )
        .route(
            "/activities/{id}",
            patch(activities::update).route_layer(need(keys::ACTIVITIES_UPDATE)),
        )
        .route(
            "/activities/{id}",
            delete(activities::remove).route_layer(need(keys::ACTIVITIES_DELETE)),
        )
        // Customer statuses
        .route(
            "/customer-statuses",
            get(customer_statuses::list).route_layer(need(keys::CUSTOMERS_READ)),
        )
        .route(
            "/customer-statuses",
            post(customer_statuses::create).route_layer(need(keys::SETTINGS_MANAGE)),
        )
        .route(
            "/customer-statuses/reorder",
            put(customer_statuses::reorder).route_layer(need(keys::SETTINGS_MANAGE)),
        )
        .route(
            "/customer-statuses/{id}",
            get(customer_statuses::detail).route_layer(need(keys::CUSTOMERS_READ)),
        )
        .route(
            "/customer-statuses/{id}",
            patch(customer_statuses::update)
                .delete(customer_statuses::remove)
                .route_layer(need(keys::SETTINGS_MANAGE)),
        )
        // Leads
        .route(
            "/leads",
            get(leads::list).route_layer(need(keys::LEADS_READ)),
        )
        .route(
            "/leads",
            post(leads::create).route_layer(need(keys::LEADS_CREATE)),
        )
        .route(
            "/leads/{id}",
            get(leads::detail).route_layer(need(keys::LEADS_READ)),
        )
        .route(
            "/leads/{id}",
            patch(leads::update).route_layer(need(keys::LEADS_UPDATE)),
        )
        .route(
            "/leads/{id}",
            delete(leads::remove).route_layer(need(keys::LEADS_DELETE)),
        )
        .route(
            "/leads/{id}/qualify",
            post(leads::qualify).route_layer(need(keys::LEADS_UPDATE)),
        )
        .route(
            "/leads/{id}/convert",
            post(leads::convert).route_layer(need(keys::LEADS_UPDATE)),
        )
        // Lists
        .route(
            "/lists",
            get(lists::list).route_layer(need(keys::COMPANIES_READ)),
        )
        .route(
            "/lists",
            post(lists::create).route_layer(need(keys::COMPANIES_CREATE)),
        )
        .route(
            "/lists/{id}",
            get(lists::detail).route_layer(need(keys::COMPANIES_READ)),
        )
        .route(
            "/lists/{id}",
            patch(lists::update).route_layer(need(keys::COMPANIES_UPDATE)),
        )
        .route(
            "/lists/{id}",
            delete(lists::remove).route_layer(need(keys::COMPANIES_DELETE)),
        )
        .route(
            "/lists/{id}/members",
            get(lists::members).route_layer(need(keys::COMPANIES_READ)),
        )
        .route(
            "/lists/{id}/members",
            post(lists::add_members).route_layer(need(keys::COMPANIES_UPDATE)),
        )
        .route(
            "/lists/{id}/members/{entity_id}",
            delete(lists::remove_member).route_layer(need(keys::COMPANIES_UPDATE)),
        )
        // Opportunities
        .route(
            "/opportunities",
            get(opportunities::list).route_layer(need(keys::OPPORTUNITIES_READ)),
        )
        .route(
            "/opportunities",
            post(opportunities::create).route_layer(need(keys::OPPORTUNITIES_CREATE)),
        )
        .route(
            "/opportunities/{id}",
            get(opportunities::detail).route_layer(need(keys::OPPORTUNITIES_READ)),
        )
        .route(
            "/opportunities/{id}",
            patch(opportunities::update).route_layer(need(keys::OPPORTUNITIES_UPDATE)),
        )
        .route(
            "/opportunities/{id}",
            delete(opportunities::remove).route_layer(need(keys::OPPORTUNITIES_DELETE)),
        )
        // Person ↔ company links
        .route(
            "/person-companies",
            post(person_companies::create).route_layer(need(keys::CONTACTS_UPDATE)),
        )
        .route(
            "/person-companies/{id}",
            patch(person_companies::update)
                .delete(person_companies::remove)
                .route_layer(need(keys::CONTACTS_UPDATE)),
        )
        // Pipeline field visibility
        .route(
            "/pipeline-field-visibility/{id}/field-visibility",
            get(field_visibility::detail).route_layer(need(keys::PIPELINES_READ)),
        )
        .route(
            "/pipeline-field-visibility/{id}/field-visibility",
            patch(field_visibility::update).route_layer(need(keys::PIPELINES_UPDATE)),
        )
        // Pipeline stages
        .route(
            "/pipeline-stages",
            get(pipeline_stages::list).route_layer(need(keys::PIPELINES_READ)),
        )
        .route(
            "/pipeline-stages",
            post(pipeline_stages::create).route_layer(need(keys::PIPELINES_CREATE)),
        )
        .route(
            "/pipeline-stages/reorder",
            post(pipeline_stages::reorder).route_layer(need(keys::PIPELINES_MANAGE)),
        )
        .route(
            "/pipeline-stages/{id}",
            get(pipeline_stages::detail).route_layer(need(keys::PIPELINES_READ)),
        )
        .route(
            "/pipeline-stages/{id}",
            patch(pipeline_stages::update).route_layer(need(keys::PIPELINES_UPDATE)),
        )
        .route(
            "/pipeline-stages/{id}",
            delete(pipeline_stages::remove).route_layer(need(keys::PIPELINES_DELETE)),
        )
        // Pipelines
        .route(
            "/pipelines",
            get(pipelines::list).route_layer(need(keys::PIPELINES_READ)),
        )
        .route(
            "/pipelines",
            post(pipelines::create).route_layer(need(keys::PIPELINES_CREATE)),
        )
        .route(
            "/pipelines/{id}",
            get(pipelines::detail).route_layer(need(keys::PIPELINES_READ)),
        )
        .route(
            "/pipelines/{id}",
            patch(pipelines::update).route_layer(need(keys::PIPELINES_UPDATE)),
        )
        .route(
            "/pipelines/{id}",
            delete(pipelines::remove).route_layer(need(keys::PIPELINES_DELETE)),
        )
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions, and the
/// request's own ports (conformance mode).
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// `c.get('clerkOrgId')`.
    pub(crate) clerk_org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    pub(crate) env: Option<RequestEnv>,
    pub(crate) files: Option<FileStores>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    /// This request's events, sent in publish order.
    outbox: std::sync::OnceLock<OrderedEvents>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// The owner scope: `undefined` with `<object>:scope:all`, else the
    /// caller's own id (`scopeFor`).
    pub(crate) fn scope(&self, scope_all: &str) -> Option<String> {
        if self.can(scope_all) {
            None
        } else {
            Some(self.user_id.clone())
        }
    }

    /// The request's ordered event sender.
    pub(crate) fn outbox(&self, state: &CrmState) -> &OrderedEvents {
        self.outbox
            .get_or_init(|| OrderedEvents::new(state.services.events.clone(), self.events.clone()))
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CrmState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        self.outbox(state).publish(event, entity_id, data.clone());
    }

    /// `publishEntityEvent({ ..., changes })`.
    pub(crate) fn publish_with_changes(
        &self,
        state: &CrmState,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        self.outbox(state)
            .publish_with_changes(event, entity_id, data, changes);
    }

    /// A value of `c.env`: the request's (conformance), else the app's.
    pub(crate) fn env(&self, state: &CrmState, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
            .or_else(|| state.services.env.get(name).cloned())
    }

    /// The services with the request's buckets and KV in place of the app's.
    pub(crate) fn services(&self, state: &CrmState) -> CrmServices {
        let mut services = state.services.clone();
        if let Some(files) = &self.files {
            services.files = Some(files.clone());
        }
        if let Some(cache) = &self.cache {
            services.cache = Some(Arc::clone(cache));
        }
        if let Some(env) = &self.env {
            let mut merged = (*services.env).clone();
            for (key, value) in env.0.iter() {
                merged.insert(key.clone(), value.clone());
            }
            services.env = Arc::new(merged);
        }
        services
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
        let caller =
            if let (Some(auth), Some(tenant), Some(permissions)) = (auth, tenant, permissions) {
                Ok(Self {
                    db: tenant.db.clone(),
                    user_id: auth.user_id.clone(),
                    permissions: permissions.clone(),
                    events: EventContext::for_request(auth, tenant),
                    clerk_org_id: tenant.clerk_org_id.clone(),
                    workspace_id: tenant.workspace_id.clone(),
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    files: parts.extensions.get::<FileStores>().cloned(),
                    outbox: std::sync::OnceLock::new(),
                    cache: parts
                        .extensions
                        .get::<RequestCache>()
                        .map(|cache| Arc::clone(&cache.0)),
                })
            } else {
                tracing::error!("crm: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response it writes itself, or a
/// failure answered with the route's own 500 message.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Failed(String),
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<weldsuite_crm_domain::DomainError> for Refusal {
    fn from(error: weldsuite_crm_domain::DomainError) -> Self {
        match error.into_api_error() {
            Ok(api) => api.into(),
            Err(message) => Self::Failed(message),
        }
    }
}

impl Refusal {
    /// The response; a failure is logged and answered with a 500 carrying
    /// `message` (`error.internal(c, message)`).
    pub(crate) fn respond(self, log: &str, message: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Failed(error) => {
                tracing::error!(%error, "[crm-api/{log}] {message}");
                ApiError::internal().with_message(message).into_response()
            }
        }
    }
}

pub(crate) type Answer<T = Response> = Result<T, Refusal>;

/// The handler's result, with failures answered as `error.internal(c, message)`.
pub(crate) fn answer(result: Answer, log: &str, message: &str) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond(log, message))
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds. Bound as text
/// and cast with `::timestamp`/`::timestamptz`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Answer<T> {
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

/// `zValidator('json', schema)` for a schema described by [`schema::Spec`]s.
pub(crate) fn validate_specs(
    headers: &HeaderMap,
    body: &Bytes,
    specs: &[schema::Spec],
) -> Answer<Map<String, Value>> {
    validate(headers, body, |issues, fields| {
        schema::read(issues, fields, specs)
    })
}

/// `c.req.query()`: the first value of each key, decoded.
pub(crate) fn query_map(raw: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Some(raw) = raw {
        for (key, value) in form_pairs(raw) {
            out.entry(key).or_insert(value);
        }
    }
    out
}

/// `application/x-www-form-urlencoded` pairs, as `URLSearchParams` reads them.
fn form_pairs(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_component(key), decode_component(value))
        })
        .collect()
}

fn decode_component(text: &str) -> String {
    let replaced = text.replace('+', " ");
    weldsuite_kit::cursor::decode_uri_component(&replaced).unwrap_or(replaced)
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : fallback, max)`;
/// `None` for `NaN`.
pub(crate) fn js_limit(raw: Option<&String>, fallback: i64, max: i64) -> Option<i64> {
    match raw.filter(|raw| !raw.is_empty()) {
        None => Some(fallback.min(max)),
        Some(raw) => weldsuite_crm_domain::js::parse_int(raw).map(|value| value.min(max)),
    }
}

/// `list(c, data, cursorPagination(totalCount, hasMore, cursor))`.
pub(crate) fn page(
    data: Vec<Value>,
    total: i64,
    has_more: bool,
    cursor: Option<String>,
) -> Response {
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// The page cut from a `limit + 1` probe: rows kept, whether there is more,
/// and the last kept row's id as the next cursor.
pub(crate) fn cut(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool, Option<String>) {
    let limit = usize::try_from(limit.max(0)).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// `(set, value)` for an `update … set col = case when set then value …`:
/// a key the parsed body left out keeps the column.
pub(crate) fn change<'a>(input: &'a Map<String, Value>, key: &str) -> (bool, Option<&'a Value>) {
    match input.get(key) {
        None => (false, None),
        Some(value) => (true, Some(value)),
    }
}

/// A string field of the parsed body (`data.key`), when set.
pub(crate) fn text<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}
