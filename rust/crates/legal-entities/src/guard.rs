//! Per-entity record checks (books-api `lib/entity-access.ts`, hr-api
//! `routes/weldhr/entity-scope.ts`).
//!
//! [`legal_entity_context`](crate::legal_entity_context) decides which entity
//! a request is scoped to. A route that loads a record by an id (path or
//! body) must also make sure the record belongs to an entity the request may
//! touch: a member who is not uniformly allowed (a restricted entity, or an
//! entity role) may only reach records of the entity the request is scoped
//! to, and a record of another entity answers 404, so its existence is never
//! confirmed.
//!
//! - [`EntityRecordGuard`] (`guardEntityRecords` / `guardRecord`) does that
//!   for every route of a router whose path names the record after a prefix
//!   (`/:id` and everything under it), as one layer: it looks the row up and
//!   asks [`record_in_request_entity`]. An id that names no record passes (the
//!   route answers its own 404). Members whose access is the same everywhere
//!   cost nothing: no query is made.
//! - [`records_in_entity`] (`recordsInEntity`) is the same check for ids that
//!   arrive in a body or query.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use sqlx::{AssertSqlSafe, PgPool};
use tower::{Layer, Service};
use weldsuite_auth::AuthContext;
use weldsuite_db::Tenant;
use weldsuite_kit::ApiError;

use crate::extensions::LegalEntityApp;
use crate::middleware::{RequestEntity, default_entity_id_for, record_in_request_entity};

/// A table whose rows belong to one entity (`EntityScopedTable`): its name
/// and its id and entity columns. The names are interpolated into SQL, so
/// they must be constants of the code, never input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntityTable {
    pub table: &'static str,
    pub id_column: &'static str,
    pub entity_column: &'static str,
}

impl EntityTable {
    /// A WeldBooks table: `id` and `entity_id`.
    pub const fn new(table: &'static str) -> Self {
        Self {
            table,
            id_column: "id",
            entity_column: "entity_id",
        }
    }

    /// A table whose entity column has another name (`legal_entity_id`).
    #[must_use]
    pub const fn entity_column(mut self, column: &'static str) -> Self {
        self.entity_column = column;
        self
    }

    fn lookup_sql(&self) -> String {
        format!(
            "select {entity} from {table} where {id} = any($1)",
            entity = self.entity_column,
            table = self.table,
            id = self.id_column,
        )
    }
}

/// Whether every record (by id) of `table` belongs to an entity the request
/// may touch (`recordsInEntity`). Unknown ids pass (the handler answers its
/// own 404); a record without an entity passes.
pub async fn records_in_entity(
    db: &PgPool,
    request: &RequestEntity,
    table: &EntityTable,
    ids: &[&str],
) -> Result<bool, sqlx::Error> {
    let mut wanted: Vec<String> = Vec::new();
    for id in ids.iter().filter(|id| !id.is_empty()) {
        if !wanted.iter().any(|seen| seen == id) {
            wanted.push((*id).to_owned());
        }
    }
    if wanted.is_empty() || request.access().uniform {
        return Ok(true);
    }
    let rows: Vec<Option<String>> = sqlx::query_scalar(AssertSqlSafe(table.lookup_sql()))
        .bind(&wanted)
        .fetch_all(db)
        .await?;
    Ok(rows
        .iter()
        .all(|entity| record_in_request_entity(request, entity.as_deref())))
}

/// How a guard finds a record's entity.
#[derive(Debug, Clone)]
enum Lookup {
    Table(EntityTable),
    /// A query with the id as `$1`, answering one row whose first column is
    /// the record's entity (null for none): hr-api's `viaEmployee` /
    /// `viaEmployer` resolvers.
    Query(&'static str),
}

/// What a record without an entity counts as.
#[derive(Debug, Clone, Copy)]
enum Unassigned {
    /// It passes (WeldBooks: `recordInRequestEntity(c, null)`).
    Pass,
    /// It is the default entity's (WeldHR's `entityAllowed`).
    Default(Option<LegalEntityApp>),
}

/// `guardEntityRecords(app, table, { param, prefix, label })` (books-api) and
/// `guardRecord(router, param, resource, resolve, prefix)` (hr-api): a 404
/// for any route under `<prefix>/<id>` whose record belongs to an entity the
/// request may not touch.
///
/// The id is the path segment after `prefix`, as the TypeScript middleware
/// (`<prefix>/:param` and `<prefix>/:param/*`) reads it, on the path the
/// layer sees (inside a nested router, relative to the nest). Add it to the
/// router of the records with `route_layer`, behind
/// [`legal_entity_context`](crate::legal_entity_context):
///
/// ```ignore
/// invoices_router.route_layer(
///     EntityRecordGuard::table(EntityTable::new("invoices"), "Invoice").layer(),
/// )
/// ```
#[derive(Debug, Clone)]
pub struct EntityRecordGuard {
    lookup: Lookup,
    prefix: &'static str,
    label: &'static str,
    unassigned: Unassigned,
}

impl EntityRecordGuard {
    /// Records of `table`; `label` names them in the 404 ("Invoice with ID
    /// 'x' not found"). A record without an entity passes.
    pub fn table(table: EntityTable, label: &'static str) -> Self {
        Self {
            lookup: Lookup::Table(table),
            prefix: "",
            label,
            unassigned: Unassigned::Pass,
        }
    }

    /// Records whose entity `sql` finds (the id is `$1`; the first column of
    /// its row is the entity), e.g. through the record's employee:
    /// `select e.legal_entity_id from hr_leave_requests t join hr_employees e
    /// on e.id = t.employee_id where t.id = $1 limit 1`.
    pub fn query(sql: &'static str, label: &'static str) -> Self {
        Self {
            lookup: Lookup::Query(sql),
            prefix: "",
            label,
            unassigned: Unassigned::Pass,
        }
    }

    /// Guard `<prefix>/<id>` instead of `/<id>` (`{ prefix: '/import-batches' }`).
    #[must_use]
    pub fn prefix(mut self, prefix: &'static str) -> Self {
        self.prefix = prefix;
        self
    }

    /// A record without an entity counts as the default entity's for `app`
    /// (hr-api's `entityAllowed`), instead of passing.
    #[must_use]
    pub fn unassigned_as_default(mut self, app: Option<LegalEntityApp>) -> Self {
        self.unassigned = Unassigned::Default(app);
        self
    }

    /// The record's entity: `None` when no record has this id, `Some(None)`
    /// when it has no entity.
    async fn record_entity(
        &self,
        db: &PgPool,
        id: &str,
    ) -> Result<Option<Option<String>>, sqlx::Error> {
        match &self.lookup {
            Lookup::Table(table) => {
                let sql = format!(
                    "select {entity} from {table} where {id_column} = $1 limit 1",
                    entity = table.entity_column,
                    table = table.table,
                    id_column = table.id_column,
                );
                sqlx::query_scalar(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(db)
                    .await
            }
            Lookup::Query(sql) => sqlx::query_scalar(*sql).bind(id).fetch_optional(db).await,
        }
    }

    /// May the request touch the record `id`? True for an id that names no
    /// record, and for members whose access is the same everywhere.
    pub async fn allows(
        &self,
        db: &PgPool,
        request: &RequestEntity,
        id: &str,
    ) -> Result<bool, sqlx::Error> {
        if id.is_empty() || request.access().uniform {
            return Ok(true);
        }
        let Some(entity) = self.record_entity(db, id).await? else {
            return Ok(true);
        };
        let effective = match (entity, self.unassigned) {
            (Some(entity), _) => Some(entity),
            (None, Unassigned::Pass) => None,
            (None, Unassigned::Default(app)) => default_entity_id_for(db, app).await?,
        };
        Ok(record_in_request_entity(request, effective.as_deref()))
    }

    /// The id this guard reads from `path`: the (percent-decoded) segment
    /// after the prefix, or `None` when the path is not under it.
    pub fn id_in_path(&self, path: &str) -> Option<String> {
        let rest = path.strip_prefix(self.prefix)?;
        let rest = rest.strip_prefix('/')?;
        let segment = rest.split('/').next().unwrap_or_default();
        (!segment.is_empty()).then(|| percent_decode(segment))
    }

    /// The layer: add it with `route_layer` (or `layer`) on the records' router.
    pub fn layer(self) -> EntityRecordGuardLayer {
        EntityRecordGuardLayer {
            guard: Arc::new(self),
        }
    }

    /// The 404 the guard answers.
    pub fn not_found(&self, id: &str) -> ApiError {
        ApiError::not_found(self.label, Some(id))
    }
}

/// `decodeURIComponent` as Hono applies it to a path parameter, keeping the
/// raw text when it is not valid percent-encoded UTF-8.
fn percent_decode(segment: &str) -> String {
    if !segment.contains('%') {
        return segment.to_owned();
    }
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes
                .get(at + 1..at + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok());
            match hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
                Some(byte) => {
                    out.push(byte);
                    at += 3;
                }
                None => return segment.to_owned(),
            }
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_owned())
}

/// The layer [`EntityRecordGuard::layer`] returns.
#[derive(Debug, Clone)]
pub struct EntityRecordGuardLayer {
    guard: Arc<EntityRecordGuard>,
}

impl<S> Layer<S> for EntityRecordGuardLayer {
    type Service = EntityRecordGuardService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        EntityRecordGuardService {
            inner,
            guard: Arc::clone(&self.guard),
        }
    }
}

/// The service behind [`EntityRecordGuardLayer`].
#[derive(Debug, Clone)]
pub struct EntityRecordGuardService<S> {
    inner: S,
    guard: Arc<EntityRecordGuard>,
}

impl<S> Service<Request> for EntityRecordGuardService<S>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let guard = Arc::clone(&self.guard);
        Box::pin(async move {
            match pending_check(&guard, &request) {
                Pending::Pass => {}
                Pending::Stop(response) => return Ok(*response),
                Pending::Check { db, entity, id } => {
                    if let Some(response) = check(&guard, &db, &entity, &id).await {
                        return Ok(response);
                    }
                }
            }
            inner.call(request).await
        })
    }
}

/// What a request needs from the guard, read before anything is awaited
/// (the request is not `Sync`).
enum Pending {
    Pass,
    Stop(Box<Response>),
    Check {
        db: PgPool,
        entity: RequestEntity,
        id: String,
    },
}

fn pending_check(guard: &EntityRecordGuard, request: &Request) -> Pending {
    let Some(id) = guard.id_in_path(request.uri().path()) else {
        return Pending::Pass;
    };
    let extensions = request.extensions();
    let Some(entity) = RequestEntity::of(extensions) else {
        // No member, nothing to check (`accessIsUniform`: no userId or tenant).
        let member = extensions
            .get::<AuthContext>()
            .is_some_and(|auth| !auth.user_id.is_empty());
        if member && extensions.get::<Tenant>().is_some() {
            tracing::error!(
                "legal entities: a record guard without legal_entity_context in front of it"
            );
            return Pending::Stop(Box::new(ApiError::internal().into_response()));
        }
        return Pending::Pass;
    };
    if entity.access().uniform {
        return Pending::Pass;
    }
    match extensions.get::<Tenant>() {
        Some(tenant) => Pending::Check {
            db: tenant.db.clone(),
            entity: entity.clone(),
            id,
        },
        None => Pending::Pass,
    }
}

/// `Some(response)` when the request must stop here.
async fn check(
    guard: &EntityRecordGuard,
    db: &PgPool,
    entity: &RequestEntity,
    id: &str,
) -> Option<Response> {
    match guard.allows(db, entity, id).await {
        Ok(true) => None,
        Ok(false) => Some(guard.not_found(id).into_response()),
        Err(error) => {
            tracing::error!(%error, "legal entities: checking a record's entity failed");
            Some(ApiError::internal().into_response())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guarded_id_is_the_segment_after_the_prefix() {
        let guard = EntityRecordGuard::table(EntityTable::new("invoices"), "Invoice");
        assert_eq!(guard.id_in_path("/inv_1").as_deref(), Some("inv_1"));
        assert_eq!(
            guard.id_in_path("/inv_1/lines/line_2").as_deref(),
            Some("inv_1")
        );
        assert_eq!(guard.id_in_path("/"), None);
        assert_eq!(guard.id_in_path(""), None);
        assert_eq!(guard.id_in_path("/a%20b").as_deref(), Some("a b"));
        assert_eq!(guard.id_in_path("/bad%zz").as_deref(), Some("bad%zz"));

        let batches =
            EntityRecordGuard::table(EntityTable::new("bank_import_batches"), "Import batch")
                .prefix("/import-batches");
        assert_eq!(
            batches.id_in_path("/import-batches/b_1/undo").as_deref(),
            Some("b_1")
        );
        assert_eq!(batches.id_in_path("/import-batches"), None);
        assert_eq!(batches.id_in_path("/tx_1"), None);
        assert_eq!(batches.id_in_path("/import-batchesx/b_1"), None);
    }

    #[test]
    fn the_404_names_the_record() {
        let guard = EntityRecordGuard::table(EntityTable::new("invoices"), "Invoice");
        let error = guard.not_found("inv_1");
        assert_eq!(error.message(), "Invoice with ID 'inv_1' not found");
        assert_eq!(error.code(), "NOT_FOUND");
    }

    #[test]
    fn table_lookups_read_the_entity_column() {
        let employees = EntityTable::new("hr_employees").entity_column("legal_entity_id");
        assert_eq!(
            employees.lookup_sql(),
            "select legal_entity_id from hr_employees where id = any($1)"
        );
    }
}
