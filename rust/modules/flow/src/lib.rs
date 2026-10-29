//! WeldFlow, projects and tasks: the `/api/<object>` routes flow-api serves
//! (`apps/workers/flow-api/src/routes/`), with the domain rules of
//! `@weldsuite/flow-domain` (shared ones in `weldsuite-flow-domain`).
//!
//! Two layers of access, both required: the workspace permissions
//! (`projects:*`, `tasks:*`, …) gate the feature, and project membership
//! gates the row (`projects:scope:all` bypasses membership). See
//! [`weldsuite_flow_domain::access`].
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `flow`
//! conformance suites (`rust/conformance/suites.json`).

#[macro_use]
mod rows;

mod custom_values;
mod digest_settings;
mod documents;
mod goals;
mod import_jobs;
mod import_tasks;
mod js;
mod labels;
mod members;
mod messages;
mod milestones;
mod personal;
mod project_files;
mod projects;
pub mod purge;
mod sprints;
mod stages;
mod whiteboards;

pub use import_tasks::{IMPORT_TASKS_JOB, ImportParams, ImportTasksJob, TenantDatabases};

use std::sync::Arc;

use axum::Router;
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
use weldsuite_catalogs::permission_keys::PROJECTS_SCOPE_ALL;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, iso_timestamp};
use weldsuite_flow_domain::access::{ProjectAccess, member_project_ids, resolve_project_access};
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{DynJobs, FileStores, StorageBuckets};

/// What the flow handlers share.
#[derive(Clone)]
pub struct FlowState {
    pub events: EntityEventPublisher,
    /// The private bucket and the legacy public one (`PRIVATE_STORAGE`,
    /// `STORAGE`), when configured.
    pub files: Option<FileStores>,
    /// The master database (due index, digest settings). A request's
    /// `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// Starts durable jobs (`flow.import-tasks`).
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// The public bucket's own URL (`R2_PUBLIC_URL`), for new documents' links.
    pub public_files_url: Option<Arc<str>>,
}

impl std::fmt::Debug for FlowState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlowState")
            .field("files", &self.files.is_some())
            .field("master", &self.master.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

/// The routers, by `/api` prefix (`app.route(prefix, routes)` in flow-api's
/// `src/index.ts`), to nest under `/api` behind the session, tenant
/// database, licence and flag layers.
pub fn routers<S, Q>(
    state: &FlowState,
    gate: &Arc<PermissionGate<Q>>,
) -> Vec<(&'static str, Router<S>)>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    vec![
        (
            "/digest-settings",
            digest_settings::router(state.clone(), gate),
        ),
        (
            "/documents",
            documents::documents_router(state.clone(), gate),
        ),
        ("/goals", goals::router(state.clone(), gate)),
        ("/milestones", milestones::router(state.clone(), gate)),
        ("/project-files", project_files::router(state.clone(), gate)),
        ("/project-labels", labels::router(state.clone(), gate)),
        (
            "/project-documents",
            documents::project_documents_router(state.clone(), gate),
        ),
        ("/project-members", members::router(state.clone(), gate)),
        ("/project-messages", messages::router(state.clone(), gate)),
        (
            "/project-pipeline-stages",
            stages::router(state.clone(), gate),
        ),
        (
            "/project-sheets",
            documents::project_sheets_router(state.clone(), gate),
        ),
        ("/projects", projects::router(state.clone(), gate)),
        ("/sprints", sprints::router(state.clone(), gate)),
        (
            "/task-projects",
            personal::router(state.clone(), personal::Kind::Projects, gate),
        ),
        (
            "/task-tags",
            personal::router(state.clone(), personal::Kind::Tags, gate),
        ),
        ("/whiteboards", whiteboards::router(state.clone(), gate)),
    ]
}

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) permissions: Permissions,
    pub(crate) events: EventContext,
    /// `c.get('clerkOrgId') || c.get('orgId')`.
    pub(crate) clerk_org_id: Option<String>,
    /// `c.get('orgId')`: the session's organization.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    #[allow(dead_code)]
    env: Option<RequestEnv>,
    buckets: Option<StorageBuckets>,
    master: Option<PgPool>,
    /// This request's events, sent in order.
    outbox: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<EntityEvent>>>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions.has_any(&[key])
    }

    /// `hasContextPermission(c, 'projects:scope:all')`.
    pub(crate) fn scope_all(&self) -> bool {
        self.can(PROJECTS_SCOPE_ALL)
    }

    /// `resolveProjectAccess(c, projectId)`.
    pub(crate) async fn access(&self, project_id: &str) -> Result<ProjectAccess, sqlx::Error> {
        resolve_project_access(&self.db, self.user(), self.scope_all(), project_id).await
    }

    /// `canAccessProject`.
    pub(crate) async fn can_access(&self, project_id: &str) -> Result<bool, sqlx::Error> {
        Ok(self.access(project_id).await?.may_access())
    }

    /// `canWriteProject`.
    pub(crate) async fn can_write(&self, project_id: &str) -> Result<bool, sqlx::Error> {
        Ok(self.access(project_id).await?.can_write)
    }

    /// `canManageProject`.
    pub(crate) async fn can_manage(&self, project_id: &str) -> Result<bool, sqlx::Error> {
        Ok(self.access(project_id).await?.is_admin)
    }

    /// `canChangeOwners`.
    pub(crate) async fn can_change_owners(&self, project_id: &str) -> Result<bool, sqlx::Error> {
        Ok(self.access(project_id).await?.can_change_owners())
    }

    /// `accessibleProjectIds(c)`: `None` for scope:all holders.
    pub(crate) async fn accessible_project_ids(&self) -> Result<Option<Vec<String>>, sqlx::Error> {
        if self.scope_all() {
            return Ok(None);
        }
        let Some(user) = self.user() else {
            return Ok(Some(Vec::new()));
        };
        member_project_ids(&self.db, user).await.map(Some)
    }

    /// `c.get('userId')`, `None` when empty.
    pub(crate) fn user(&self) -> Option<&str> {
        Some(self.user_id.as_str()).filter(|id| !id.is_empty())
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &FlowState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        self.send(state, EntityEvent::new(event, entity_id, data.clone()));
    }

    /// Queue an event behind the ones this request published before it:
    /// TypeScript's queue sends land in publish order, so Rust keeps it.
    pub(crate) fn send(&self, state: &FlowState, event: EntityEvent) {
        let mut outbox = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sender = outbox.get_or_insert_with(|| {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<EntityEvent>();
            let publisher = state.events.clone();
            let context = self.events.clone();
            state.events.tracker().spawn(async move {
                while let Some(event) = receiver.recv().await {
                    publisher.publish_and_wait(&context, event).await;
                }
            });
            sender
        });
        if sender.send(event).is_err() {
            tracing::error!("flow: the event outbox closed early");
        }
    }

    /// `publishEntityEvent` with `accessUserIds`.
    pub(crate) fn publish_to(
        &self,
        state: &FlowState,
        event: EventName,
        entity_id: &str,
        data: Value,
        access_user_ids: Vec<String>,
    ) {
        let event = EntityEvent::new(event, entity_id, data).with_access_user_ids(access_user_ids);
        self.send(state, event);
    }

    /// `publishEntityEvent` with `changes`.
    pub(crate) fn publish_changes(
        &self,
        state: &FlowState,
        event: EventName,
        entity_id: &str,
        data: Value,
        changes: Option<Map<String, Value>>,
    ) {
        let mut event = EntityEvent::new(event, entity_id, data);
        if let Some(changes) = changes {
            event = event.with_changes(changes);
        }
        self.send(state, event);
    }

    /// The request's buckets (conformance mode), else the app's: `STORAGE`
    /// is `public`, `PRIVATE_STORAGE` `private`.
    pub(crate) fn buckets(&self, state: &FlowState) -> StorageBuckets {
        self.buckets
            .clone()
            .or_else(|| state.files.clone().map(StorageBuckets::from))
            .unwrap_or_default()
    }

    /// The request's master database (conformance), else the app's.
    pub(crate) fn master(&self, state: &FlowState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.master.clone())
    }

    /// A value of `c.env` (conformance), if the test set it.
    #[allow(dead_code)]
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
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
                    org_id: auth.org_id.clone().filter(|id| !id.is_empty()),
                    clerk_org_id: tenant
                        .clerk_org_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .or_else(|| auth.org_id.clone().filter(|id| !id.is_empty())),
                    workspace_id: tenant.workspace_id.clone(),
                    env: parts.extensions.get::<RequestEnv>().cloned(),
                    buckets: parts
                        .extensions
                        .get::<StorageBuckets>()
                        .cloned()
                        .or_else(|| {
                            parts
                                .extensions
                                .get::<FileStores>()
                                .cloned()
                                .map(StorageBuckets::from)
                        }),
                    master: parts
                        .extensions
                        .get::<weldsuite_db::MasterDb>()
                        .map(|master| master.0.clone()),
                    outbox: std::sync::Mutex::default(),
                })
            } else {
                tracing::error!("flow: a route without the session, tenant or permission layer");
                Err(ApiError::internal())
            };
        std::future::ready(caller)
    }
}

/// A route's answer off the happy path: a response it writes itself (400,
/// 403, 404, a validation failure), or a failure for its `catch` (500 with
/// the route's message).
#[derive(Debug)]
pub(crate) enum Refusal {
    Response(Box<Response>),
    Database(sqlx::Error),
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
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiError::bad_request(message).into()
    }

    pub(crate) fn forbidden(message: &str) -> Self {
        ApiError::forbidden().with_message(message).into()
    }

    pub(crate) fn not_found(resource: &str, id: &str) -> Self {
        ApiError::not_found(resource, Some(id)).into()
    }

    pub(crate) fn conflict(message: &str) -> Self {
        ApiError::conflict(message).into()
    }

    /// The response; a failure is logged and answered with a 500 carrying
    /// `fallback` (the route's `error.internal(c, …)`).
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[flow-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
            Self::Internal(error) => {
                tracing::error!(error, "[flow-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

/// A handler's result: the response, or a [`Refusal`].
pub(crate) type Reply = Result<Response, Refusal>;

/// The reply, with a failure answered as the route's `catch` does.
pub(crate) fn reply(result: Reply, fallback: &str) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond(fallback))
}

/// A failure outside the route's `try` (an access check): the app's error
/// handler answers a 500.
pub(crate) fn outside(result: Reply) -> Response {
    result.unwrap_or_else(|refusal| refusal.respond("Internal server error"))
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds, bound as text
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
    let body = json_of(headers, body)?;
    validate_value(&body, read)
}

/// The JSON body (`c.req.json()` as `zValidator` reads it), or the 400.
pub(crate) fn json_of(headers: &HeaderMap, body: &Bytes) -> Result<Value, Refusal> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| Refusal::Response(Box::new(bad.into_response())))
}

/// A parsed body against a schema.
pub(crate) fn validate_value<T>(
    body: &Value,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Refusal> {
    let mut issues = Issues::default();
    let value = issues.object(body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Refusal::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| ApiError::internal().into())
}

/// `c.req.query()`: each key's first value.
pub(crate) struct Query(Map<String, Value>);

impl Query {
    pub(crate) fn parse(raw: Option<&str>) -> Self {
        Self(query_values(raw))
    }

    /// `c.req.query(key)`.
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        match self.0.get(key) {
            Some(Value::String(text)) => Some(text.as_str()),
            Some(Value::Array(values)) => values.first().and_then(Value::as_str),
            _ => None,
        }
    }

    /// A present, non-empty value (`isPresent`, `if (q.x)`).
    pub(crate) fn present(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    /// The values `zValidator('query', …)` sees.
    #[allow(dead_code)]
    pub(crate) fn values(&self) -> &Map<String, Value> {
        &self.0
    }
}

/// `accessibleProjectIds(c)` as the SQL of [`in_accessible!`] binds it:
/// `(true, [])` for scope:all, else `(false, ids)` with `['']` for none
/// (`inArray(col, [''])` matches nothing).
pub(crate) async fn access_scope(caller: &Caller) -> Result<(bool, Vec<String>), sqlx::Error> {
    Ok(match caller.accessible_project_ids().await? {
        None => (true, Vec::new()),
        Some(ids) if ids.is_empty() => (false, vec![String::new()]),
        Some(ids) => (false, ids),
    })
}

/// The keyset cursor row (`select createdAt, id where id = cursor`):
/// `created_at` as Drizzle reads it back (milliseconds), and the id.
/// `sql` selects `id` and `to_jsonb(created_at) #>> '{}'` by `$1`.
pub(crate) async fn keyset_cursor(
    db: &PgPool,
    sql: &'static str,
    cursor: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?;
    Ok(row.and_then(|(id, created)| {
        created
            .as_deref()
            .and_then(weldsuite_db::js_timestamp)
            .map(|at| (at, id))
    }))
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100)`; `None`
/// is NaN (the query then fails, a 500).
pub(crate) fn list_limit(q: &Query, fallback: i64, max: i64) -> Option<i64> {
    match q.present("limit") {
        Some(raw) => weldsuite_flow_domain::js::parse_int(raw).map(|n| n.min(max)),
        None => Some(fallback.min(max)),
    }
}

/// A page of `limit + 1` rows: `(rows, hasMore, nextCursor)` with the last
/// row's id as the cursor.
pub(crate) fn page(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool, Option<String>) {
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// `list(c, rows, cursorPagination(totalCount, hasMore, cursor))`.
pub(crate) fn paged(
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

/// `error.forbidden(c, message)`.
pub(crate) fn forbidden(message: &str) -> Response {
    ApiError::forbidden().with_message(message).into_response()
}

/// A list without paging: `list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null })`.
pub(crate) fn all_rows(rows: Vec<Value>) -> Response {
    let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    weldsuite_kit::List::new(rows, weldsuite_kit::Pagination::new(total, false, None))
        .into_response()
}
