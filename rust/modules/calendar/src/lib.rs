//! WeldCalendar: calendar-api's routes (`apps/workers/calendar-api/src/routes/`)
//! and its nightly re-plan (`src/cron/calendar-replan.ts`).
//!
//! - `/api/calendars`: the caller's calendars and the ones shared with them,
//!   sharing, the default calendar, and deleting a calendar with its events.
//! - `/api/calendar-events`: events of the calendars the caller can see
//!   (list, range, upcoming, CRUD, cancel, reschedule, unpin), with the
//!   linked WeldMeet meetings kept in step and every mutation pushed to the
//!   workspace's Google calendars.
//! - `/api/booking-pages`, `/api/bookings`: booking pages with their slot
//!   availability, and bookings, owner-scoped unless `bookings:scope:all`.
//! - `/api/working-hours`: per-user working hours on `user_preferences`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `calendar`
//! conformance suite (`rust/conformance/suites.json`).

mod access;
mod booking_pages;
mod bookings;
mod calendars;
mod event_input;
mod events;
pub mod google;
mod js;
mod mail;
mod meetings;
mod passthrough;
mod replan;
mod slots;
mod working_hours;

pub use google::{CalendarHttp, GoogleHttp, HttpRequest, HttpResponse, ReqwestGoogle};
pub use replan::{CALENDAR_REPLAN_SEED_KEY, ReplanResult, TenantDatabases, run_replan_sweep};

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
use weldsuite_catalogs::permission_keys::{
    BOOKINGS_CREATE, BOOKINGS_DELETE, BOOKINGS_READ, BOOKINGS_UPDATE, CALENDARS_CREATE,
    CALENDARS_DELETE, CALENDARS_READ, CALENDARS_UPDATE, EVENTS_CREATE, EVENTS_DELETE, EVENTS_READ,
    EVENTS_UPDATE, GENERAL_READ, TEAM_READ, TEAM_UPDATE, WORKING_HOURS_EDIT_SELF,
};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, iso_timestamp};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

/// What the calendar handlers share.
#[derive(Clone)]
pub struct CalendarState {
    pub events: EntityEventPublisher,
    /// Outbound HTTP to Google Calendar (the outbound sync). A request's
    /// [`CalendarHttp`] (conformance) wins.
    pub google: Option<Arc<dyn GoogleHttp>>,
    /// The master database: the re-plan due index. A request's `MasterDb`
    /// (conformance) wins; without either the index is not touched, as the
    /// worker does without its `SCHEDULE_INDEX` binding.
    pub master: Option<PgPool>,
    /// The worker's env (`GOOGLE_CALENDAR_CLIENT_ID`, `…_SECRET`,
    /// `ENVIRONMENT`, `APP_URL`); a request's [`RequestEnv`] wins.
    pub env: Arc<std::collections::HashMap<String, String>>,
    /// `SEND_EMAIL` and the outbound guard's ledgers; a request's
    /// `RequestOutbound` (conformance) wins. Without a transport no attendee
    /// mail goes out, as the worker sends none without `SEND_EMAIL`.
    pub outbound: weldsuite_mail_domain::outbound::OutboundBindings,
    /// The guard's ownership cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn weldsuite_ports::DynCache>>,
}

impl std::fmt::Debug for CalendarState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CalendarState")
            .field("google", &self.google.is_some())
            .field("master", &self.master.is_some())
            .finish_non_exhaustive()
    }
}

/// calendar-api's routes, relative to `/api`, to merge behind the session,
/// tenant database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
pub fn router<S, Q>(state: CalendarState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    let calendars = Router::new()
        .route("/", get(calendars::list).route_layer(need(CALENDARS_READ)))
        .route(
            "/ensure-default",
            post(calendars::ensure_default).route_layer(need(CALENDARS_CREATE)),
        )
        .route(
            "/",
            post(calendars::create).route_layer(need(CALENDARS_CREATE)),
        )
        .route(
            "/{id}",
            get(calendars::detail).route_layer(need(CALENDARS_READ)),
        )
        .route(
            "/{id}",
            patch(calendars::update).route_layer(need(CALENDARS_UPDATE)),
        )
        .route(
            "/{id}/delete-impact",
            get(calendars::delete_impact).route_layer(need(CALENDARS_DELETE)),
        )
        .route(
            "/{id}",
            delete(calendars::remove).route_layer(need(CALENDARS_DELETE)),
        )
        .route(
            "/{id}/shares",
            get(calendars::shares).route_layer(need(CALENDARS_READ)),
        )
        .route(
            "/{id}/share",
            post(calendars::share).route_layer(need(CALENDARS_UPDATE)),
        )
        .route(
            "/{id}/share/{share_id}",
            delete(calendars::unshare).route_layer(need(CALENDARS_UPDATE)),
        );
    let events = Router::new()
        .route("/", get(events::list).route_layer(need(EVENTS_READ)))
        .route("/range", get(events::range).route_layer(need(EVENTS_READ)))
        .route(
            "/upcoming",
            get(events::upcoming).route_layer(need(EVENTS_READ)),
        )
        .route("/{id}", get(events::detail).route_layer(need(EVENTS_READ)))
        .route("/", post(events::create).route_layer(need(EVENTS_CREATE)))
        .route(
            "/{id}",
            patch(events::update).route_layer(need(EVENTS_UPDATE)),
        )
        .route(
            "/{id}",
            delete(events::remove).route_layer(need(EVENTS_DELETE)),
        )
        .route(
            "/{id}/cancel",
            patch(events::cancel).route_layer(need(EVENTS_UPDATE)),
        )
        .route(
            "/{id}/reschedule",
            patch(events::reschedule).route_layer(need(EVENTS_UPDATE)),
        )
        .route(
            "/{id}/unpin",
            post(events::unpin).route_layer(need(EVENTS_UPDATE)),
        );
    let booking_pages = Router::new()
        .route(
            "/",
            get(booking_pages::list).route_layer(need(BOOKINGS_READ)),
        )
        .route(
            "/{id}",
            get(booking_pages::detail).route_layer(need(BOOKINGS_READ)),
        )
        .route(
            "/",
            post(booking_pages::create).route_layer(need(BOOKINGS_CREATE)),
        )
        .route(
            "/{id}",
            patch(booking_pages::update).route_layer(need(BOOKINGS_UPDATE)),
        )
        .route(
            "/{id}/delete-impact",
            get(booking_pages::delete_impact).route_layer(need(BOOKINGS_DELETE)),
        )
        .route(
            "/{id}",
            delete(booking_pages::remove).route_layer(need(BOOKINGS_DELETE)),
        )
        .route(
            "/{id}/toggle",
            patch(booking_pages::toggle).route_layer(need(BOOKINGS_UPDATE)),
        )
        .route(
            "/{id}/available-slots",
            get(booking_pages::available_slots).route_layer(need(BOOKINGS_READ)),
        );
    let bookings = Router::new()
        .route("/", get(bookings::list).route_layer(need(BOOKINGS_READ)))
        .route(
            "/{id}",
            get(bookings::detail).route_layer(need(BOOKINGS_READ)),
        )
        .route(
            "/",
            post(bookings::create).route_layer(need(BOOKINGS_CREATE)),
        )
        .route(
            "/{id}",
            patch(bookings::update).route_layer(need(BOOKINGS_UPDATE)),
        )
        .route(
            "/{id}",
            delete(bookings::remove).route_layer(need(BOOKINGS_DELETE)),
        );
    let working_hours = Router::new()
        .route(
            "/",
            get(working_hours::mine).route_layer(need(GENERAL_READ)),
        )
        .route(
            "/",
            put(working_hours::update_mine)
                .route_layer(gate.require([WORKING_HOURS_EDIT_SELF, TEAM_UPDATE])),
        )
        .route(
            "/team",
            get(working_hours::team).route_layer(need(TEAM_READ)),
        )
        .route(
            "/members/{member_id}",
            get(working_hours::member_hours).route_layer(need(TEAM_READ)),
        )
        .route(
            "/members/{member_id}",
            put(working_hours::update_member).route_layer(need(TEAM_UPDATE)),
        );
    // app-api's mount order.
    Router::new()
        .nest("/booking-pages", booking_pages)
        .nest("/bookings", bookings)
        .nest("/calendar-events", events)
        .nest("/calendars", calendars)
        .nest("/working-hours", working_hours)
        .with_state(state)
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// `c.get('orgId')`.
    pub(crate) org_id: Option<String>,
    /// `c.get('clerkOrgId')`: the outbound guard and the app links.
    pub(crate) clerk_org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id` (the due index).
    pub(crate) workspace_id: String,
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    http: Option<CalendarHttp>,
    outbound: Option<weldsuite_mail_domain::outbound::RequestOutbound>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &CalendarState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        state.events.publish(
            &self.events,
            EntityEvent::new(event, entity_id, data.clone()),
        );
    }

    /// Several events in one go, in this order (the publisher's sends would
    /// otherwise race on the runtime's threads).
    pub(crate) fn publish_all(&self, state: &CalendarState, events: Vec<EntityEvent>) {
        if events.is_empty() {
            return;
        }
        let publisher = state.events.clone();
        let context = self.events.clone();
        state.events.tracker().spawn(async move {
            for event in events {
                publisher.publish_and_wait(&context, event).await;
            }
        });
    }

    /// A value of `c.env`: the request's (conformance), else the state's.
    pub(crate) fn env(&self, state: &CalendarState, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
            .or_else(|| state.env.get(name).cloned())
    }

    /// The master database: the request's (conformance), else the app's.
    pub(crate) fn master(&self, state: &CalendarState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// The outbound bindings (`SEND_EMAIL`, the guard's ledgers): the
    /// request's (conformance), else the app's.
    pub(crate) fn outbound(
        &self,
        state: &CalendarState,
    ) -> weldsuite_mail_domain::outbound::OutboundBindings {
        self.outbound
            .as_ref()
            .map_or_else(|| state.outbound.clone(), |request| request.0.clone())
    }

    /// Outbound HTTP to Google: the request's (conformance), else the app's.
    pub(crate) fn google(&self, state: &CalendarState) -> Option<Arc<dyn GoogleHttp>> {
        self.http
            .as_ref()
            .map(|http| Arc::clone(&http.0))
            .or_else(|| state.google.clone())
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
        let caller = if let (Some(auth), Some(tenant), Some(permissions)) =
            (auth, tenant, permissions)
        {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                permissions: permissions.clone(),
                events: EventContext::for_request(auth, tenant),
                org_id: auth.org_id.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                env: parts.extensions.get::<RequestEnv>().cloned(),
                master: parts
                    .extensions
                    .get::<weldsuite_db::MasterDb>()
                    .map(|master| master.0.clone()),
                http: parts.extensions.get::<CalendarHttp>().cloned(),
                outbound: parts
                    .extensions
                    .get::<weldsuite_mail_domain::outbound::RequestOutbound>()
                    .cloned(),
            })
        } else {
            tracing::error!("calendar: a route without the session, tenant or permission layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response it writes itself (a
/// validation failure, 403, 404), or a database failure answered with the
/// route's 500 message.
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
    /// A failure outside the database (an invalid date the driver would
    /// refuse), answered with the route's 500 message.
    Internal(String),
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for Refusal {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

impl Refusal {
    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn forbidden() -> Self {
        ApiError::forbidden().into()
    }

    pub(crate) fn bad_request(message: &str) -> Self {
        ApiError::bad_request(message).into()
    }

    /// The response; a failure is logged and answered with a 500 carrying
    /// `fallback` (`error.internal(c, fallback)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[calendar-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
            Self::Internal(error) => {
                tracing::error!(error, "[calendar-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

pub(crate) type Outcome<T> = Result<T, Refusal>;

/// `new Date()` as Drizzle writes it to a `timestamp` column: UTC with
/// milliseconds. Bound as text and cast with `::timestamp`.
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// The body as JSON, or zod-validator's 400 for one that doesn't parse.
fn body_json(headers: &HeaderMap, body: &Bytes) -> Outcome<Value> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| Refusal::Response(Box::new(bad.into_response())))
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Outcome<T> {
    let body = body_json(headers, body)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('json', schema, validationHook)`: the 400 is the API's error
/// envelope, `{ code: 'BAD_REQUEST', message: 'a.b: …; …', details: { issues } }`
/// (`lib/validation.ts`).
pub(crate) fn validate_hooked<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Outcome<T> {
    let body = body_json(headers, body)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(|invalid| hooked(&invalid))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `zValidator('query', schema, validationHook)`.
pub(crate) fn validate_query_hooked<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Outcome<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues.finish().map_err(|invalid| hooked(&invalid))?;
    Ok(value)
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Outcome<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// `validationHook`: Zod's issues as `{ path: 'a.0.b', message }` and one
/// message joining them.
fn hooked(invalid: &weldsuite_kit::validation::Invalid) -> Refusal {
    let issues: Vec<Value> = invalid
        .issues()
        .iter()
        .map(|issue| {
            let path = issue["path"]
                .as_array()
                .map(|segments| {
                    segments
                        .iter()
                        .map(|segment| match segment {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            serde_json::json!({ "path": path, "message": issue["message"] })
        })
        .collect();
    let message = issues
        .iter()
        .map(|issue| {
            let path = issue["path"].as_str().unwrap_or_default();
            let text = issue["message"].as_str().unwrap_or_default();
            if path.is_empty() {
                text.to_owned()
            } else {
                format!("{path}: {text}")
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let message = if message.is_empty() {
        "Invalid request".to_owned()
    } else {
        message
    };
    ApiError::bad_request(message)
        .with_details(serde_json::json!({ "issues": issues }))
        .into()
}

/// A list without paging: `list(c, rows, cursorPagination(rows.length, false, null))`.
pub(crate) fn all(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}

/// A paged list: `list(c, data, cursorPagination(total, hasMore, cursor))`.
pub(crate) fn page(
    rows: Vec<Value>,
    total: i64,
    has_more: bool,
    cursor: Option<String>,
) -> Response {
    weldsuite_kit::List::new(
        rows,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// A string field of a row, `""` when null.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// `c.req.query(name)`: the first value of `name`, decoded.
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}
