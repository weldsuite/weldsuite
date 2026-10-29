//! The flat CRUD surface most desk-api objects share (helpdesk-faqs, -news,
//! -announcements, -feedback, -reviews, slas, ticket-notes, ticket-messages,
//! satisfaction-surveys): `GET /` (cursor-paged, newest first, a few
//! filters), `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (soft).
//!
//! Every one of those route files is the same code with a different table,
//! schema, filters, messages and event payloads; [`Crud`] is that difference.
//! The TypeScript quirks are kept: a `?cursor=` makes the count drop the last
//! condition of the list, which is a filter when the cursor row is gone; a
//! client `id` in a passthrough body wins over the generated one in the row
//! (the response and the event still carry the generated id); a body key
//! that names a `date` timestamp makes Drizzle throw (the route's 500).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_kit::validation::Issues;
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, query_param, sql_limit};
use crate::table::{Table, WriteError};
use crate::{Caller, DeskState, Refusal, now, validate};

/// A list filter: `eq(column, q[key])` or `like(column, '%' + q[key] + '%')`
/// when the query value is a non-empty string. The list statement has one
/// slot per filter, in this order (see [`Crud::list_sql`]).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Filter {
    pub(crate) query: &'static str,
    pub(crate) like: bool,
}

impl Filter {
    pub(crate) const fn eq(query: &'static str) -> Self {
        Self { query, like: false }
    }

    pub(crate) const fn like(query: &'static str) -> Self {
        Self { query, like: true }
    }
}

/// Where an updated event's field comes from.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Changed {
    /// `(update.f as T | undefined) ?? existing.f`.
    UpdateOrExisting(&'static str),
    /// `existing.f`.
    Existing(&'static str),
}

/// The `error.internal(c, …)` messages of a route file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Messages {
    pub(crate) list: &'static str,
    pub(crate) fetch: &'static str,
    pub(crate) create: &'static str,
    pub(crate) update: &'static str,
    pub(crate) delete: &'static str,
}

/// The `requirePermission` keys of a route file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Gates {
    pub(crate) read: &'static str,
    pub(crate) create: &'static str,
    pub(crate) update: &'static str,
    pub(crate) delete: &'static str,
}

/// The schema of `POST /` (`partial` is `PATCH /:id`'s `.partial()`): reads
/// the fields in the schema's order. Passthrough schemas keep every other
/// key of the body.
pub(crate) type Schema = fn(&mut Issues, &Map<String, Value>, Partial);

/// Whether the schema is the create schema or its `.partial()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Partial(pub(crate) bool);

impl Partial {
    /// A required field becomes optional under `.partial()`.
    pub(crate) fn required(self) -> weldsuite_kit::validation::Presence {
        if self.0 {
            weldsuite_kit::validation::Presence::Optional
        } else {
            weldsuite_kit::validation::Presence::Required
        }
    }
}

/// One CRUD route file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Crud {
    pub(crate) table: &'static Table,
    /// `error.notFound(c, '<resource>', id)`.
    pub(crate) resource: &'static str,
    pub(crate) id_prefix: &'static str,
    pub(crate) gates: Gates,
    pub(crate) messages: Messages,
    pub(crate) schema: Schema,
    pub(crate) filters: &'static [Filter],
    /// `$1` live-only skip, then per filter `(skip, value)`, then the cursor
    /// `(skip, created_at, id)`, then `limit`. The rows, newest first.
    pub(crate) list_sql: &'static str,
    /// The same conditions without the limit: `count(*)`.
    pub(crate) count_sql: &'static str,
    /// The count drops the last list condition on a `?cursor=`
    /// (`conditions.slice(0, -1)`); otherwise it counts the filters only.
    pub(crate) slice_count: bool,
    pub(crate) created: EventName,
    /// The fields of the created event's data, read from the body.
    pub(crate) created_fields: &'static [&'static str],
    pub(crate) updated: EventName,
    pub(crate) updated_fields: &'static [Changed],
    pub(crate) deleted: EventName,
}

type Handler = &'static Crud;

/// The five routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(crud: Handler, gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/",
            get(
                move |state: State<DeskState>, caller: Caller, query: RawQuery| {
                    list(crud, state, caller, query)
                },
            )
            .route_layer(need(crud.gates.read)),
        )
        .route(
            "/",
            axum::routing::post(
                move |state: State<DeskState>, caller: Caller, headers: HeaderMap, body: Bytes| {
                    create(crud, state, caller, headers, body)
                },
            )
            .route_layer(need(crud.gates.create)),
        )
        .route(
            "/{id}",
            get(move |caller: Caller, id: Path<String>| detail(crud, caller, id))
                .route_layer(need(crud.gates.read)),
        )
        .route(
            "/{id}",
            axum::routing::patch(
                move |state: State<DeskState>,
                      caller: Caller,
                      id: Path<String>,
                      headers: HeaderMap,
                      body: Bytes| {
                    update(crud, state, caller, id, headers, body)
                },
            )
            .route_layer(need(crud.gates.update)),
        )
        .route(
            "/{id}",
            axum::routing::delete(
                move |state: State<DeskState>, caller: Caller, id: Path<String>| {
                    remove(crud, state, caller, id)
                },
            )
            .route_layer(need(crud.gates.delete)),
        )
}

/// The keyset condition's operands: the cursor row's `createdAt` as
/// JavaScript read it (milliseconds) and its id.
pub(crate) async fn cursor_row(
    db: &weldsuite_db::PgPool,
    table: &str,
    cursor: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    // One statement per table: sqlx takes literal SQL only.
    let sql = cursor_sql(table);
    let row: Option<(Option<String>, String)> =
        sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?;
    Ok(row.and_then(|(created_at, id)| {
        created_at
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .map(|stamp| (stamp, id))
    }))
}

/// `select createdAt, id from t where id = $1 limit 1`, per table.
fn cursor_sql(table: &str) -> &'static str {
    macro_rules! cursor {
        ($($table:literal),* $(,)?) => {
            match table {
                $($table => concat!(
                    "select to_jsonb(t.created_at)#>>'{}', t.id from \"", $table,
                    "\" t where t.id = $1 limit 1"
                ),)*
                _ => "select null::text, null::text where false",
            }
        };
    }
    cursor!(
        "helpdesk_faqs",
        "helpdesk_news",
        "helpdesk_announcements",
        "helpdesk_feedback",
        "helpdesk_reviews",
        "helpdesk_slas",
        "helpdesk_ticket_notes",
        "helpdesk_ticket_messages",
        "helpdesk_satisfaction_surveys",
        "helpdesk_tickets",
        "helpdesk_conversations",
        "helpdesk_article_folders",
        "helpdesk_articles",
        "helpdesk_canned_responses",
        "helpdesk_ticket_types",
        "helpdesk_agents",
        "helpdesk_departments",
        "helpdesk_workflows",
    )
}

/// The list's conditions as statement slots: which are skipped.
#[derive(Debug, Clone)]
pub(crate) struct Slots {
    /// The live-only condition, then one per filter, then the cursor.
    pub(crate) skip: Vec<bool>,
}

impl Slots {
    /// The slots of the page query, and those of its count: with a
    /// `?cursor=`, TypeScript counts with `conditions.slice(0, -1)`, which
    /// drops the cursor condition, or the last filter when the cursor row is
    /// gone.
    pub(crate) fn page_and_count(active: &[bool], cursor_given: bool) -> (Self, Self) {
        let page = Self {
            skip: active.iter().map(|a| !a).collect(),
        };
        let mut count = page.clone();
        if cursor_given && let Some(last) = count.skip.iter().rposition(|skip| !skip) {
            count.skip[last] = true;
        }
        (page, count)
    }
}

/// A cursor-paged list statement pair and its filters (see [`Crud`]).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Listing {
    pub(crate) table: &'static Table,
    pub(crate) filters: &'static [Filter],
    pub(crate) list_sql: &'static str,
    pub(crate) count_sql: &'static str,
    pub(crate) slice_count: bool,
}

/// A fetched page: the rows (`limit + 1` of them at most), the limit as
/// JavaScript holds it, and the count.
pub(crate) struct Fetched {
    pub(crate) rows: Vec<Value>,
    pub(crate) limit: f64,
    pub(crate) total: i64,
}

/// Why a list could not be read: the app's 500 (the cursor lookup runs
/// before the route's `try`) or a statement inside it (the route's 500).
pub(crate) enum ListError {
    Cursor,
    Database(sqlx::Error),
}

impl ListError {
    pub(crate) fn respond(self, message: &str) -> Response {
        match self {
            Self::Cursor => ApiError::internal().into_response(),
            Self::Database(error) => Refusal::Database(error).respond(message),
        }
    }
}

/// Read a list as the route files do (see the module docs).
pub(crate) async fn fetch(
    listing: Listing,
    db: &weldsuite_db::PgPool,
    query: Option<&str>,
) -> Result<Fetched, ListError> {
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let values: Vec<Option<String>> = listing
        .filters
        .iter()
        .map(|filter| {
            query_param(query, filter.query)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    if filter.like {
                        format!("%{value}%")
                    } else {
                        value
                    }
                })
        })
        .collect();
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row = match &cursor {
        Some(cursor) => cursor_row(db, listing.table.name, cursor)
            .await
            .map_err(|error| {
                tracing::error!(%error, "desk: cursor lookup failed");
                ListError::Cursor
            })?,
        None => None,
    };
    let mut active = vec![true];
    active.extend(values.iter().map(Option::is_some));
    active.push(cursor_row.is_some());
    let (page, mut count) = Slots::page_and_count(&active, listing.slice_count && cursor.is_some());
    if !listing.slice_count {
        let last = count.skip.len() - 1;
        count.skip[last] = true;
    }
    let rows = bind_slots(
        sqlx::query_scalar(listing.list_sql),
        &page,
        &values,
        cursor_row.as_ref(),
    )
    .bind(sql_limit(limit))
    .fetch_all(db);
    let total = bind_slots(
        sqlx::query_scalar(listing.count_sql),
        &count,
        &values,
        cursor_row.as_ref(),
    )
    .fetch_one(db);
    let (rows, total): (Result<Vec<Value>, _>, Result<i64, _>) = futures_join(rows, total).await;
    let rows = rows.map_err(ListError::Database)?;
    let total = total.map_err(ListError::Database)?;
    Ok(Fetched {
        rows: rows.into_iter().map(|row| listing.table.js(row)).collect(),
        limit,
        total,
    })
}

async fn list(
    crud: Handler,
    State(_state): State<DeskState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let listing = Listing {
        table: crud.table,
        filters: crud.filters,
        list_sql: crud.list_sql,
        count_sql: crud.count_sql,
        slice_count: crud.slice_count,
    };
    match fetch(listing, &caller.db, query.as_deref()).await {
        Ok(fetched) => page_list(fetched.rows, fetched.limit, fetched.total),
        Err(error) => error.respond(crud.messages.list),
    }
}

/// Both queries, as `Promise.all` runs them.
async fn futures_join<A, B>(a: impl Future<Output = A>, b: impl Future<Output = B>) -> (A, B) {
    let a = a.await;
    let b = b.await;
    (a, b)
}

/// Bind the slots: `$1` live-only skip, then `(skip, value)` per filter,
/// then the cursor's `(skip, created_at, id)`.
pub(crate) fn bind_slots<'q, O>(
    query: sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments>,
    slots: &Slots,
    values: &'q [Option<String>],
    cursor: Option<&'q (String, String)>,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments> {
    let mut query = query.bind(slots.skip[0]);
    for (index, value) in values.iter().enumerate() {
        query = query.bind(slots.skip[index + 1]).bind(value.as_deref());
    }
    let cursor_skip = slots.skip[values.len() + 1];
    query
        .bind(cursor_skip)
        .bind(cursor.map(|(created_at, _)| created_at.as_str()))
        .bind(cursor.map(|(_, id)| id.as_str()))
}

/// `list(c, data, cursorPagination(totalCount, hasMore, nextCursor))` from a
/// `limit + 1` page.
pub(crate) fn page_list(rows: Vec<Value>, limit: f64, total: i64) -> Response {
    let (data, has_more, cursor) = page_of(rows, limit, |row| crate::js::text(row, "id"));
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// `hasMore = rows.length > limit`, `data = hasMore ? rows.slice(0, limit) :
/// rows`, `nextCursor = hasMore && data.length > 0 ? last.id : null`.
pub(crate) fn page_of<T>(
    rows: Vec<T>,
    limit: f64,
    id: impl Fn(&T) -> Option<&str>,
) -> (Vec<T>, bool, Option<String>) {
    // `rows.length > limit` is false for a NaN limit.
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data = if has_more {
        #[allow(clippy::cast_possible_truncation)]
        crate::js::js_slice(rows, limit as i64)
    } else {
        rows
    };
    let cursor = if has_more {
        data.last().and_then(&id).map(str::to_owned)
    } else {
        None
    };
    (data, has_more, cursor)
}

async fn detail(crud: Handler, caller: Caller, Path(id): Path<String>) -> Response {
    match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found(crud.resource, &id).respond(crud.messages.fetch),
        Err(error) => Refusal::Database(error).respond(crud.messages.fetch),
    }
}

/// The body as the schema let it through (`c.req.valid('json')`).
fn read_body(
    crud: Handler,
    headers: &HeaderMap,
    body: &Bytes,
    partial: bool,
) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        (crud.schema)(issues, fields, Partial(partial));
        fields.clone()
    })
}

async fn create(
    crud: Handler,
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_body(crud, &headers, &body, false) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(crud.messages.create),
    };
    let id = generate_id(crud.id_prefix);
    let now = now();
    let table = crud.table;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    values.extend(table.values(&data));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let mut trusted = vec!["createdAt", "updatedAt"];
    if !data.contains_key("id") {
        trusted.push("id");
    }
    if let Err(error) = table.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, crud.messages.create);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for field in crud.created_fields {
        if let Some(value) = data.get(*field) {
            event.insert((*field).to_owned(), value.clone());
        }
    }
    caller.publish(&state, crud.created, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

/// A failed write: the route's 500.
pub(crate) fn write_failed(error: &WriteError, message: &str) -> Response {
    tracing::error!(%error, "[desk-api] {message}");
    ApiError::internal().with_message(message).into_response()
}

async fn update(
    crud: Handler,
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_body(crud, &headers, &body, true) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(crud.messages.update),
    };
    let existing = match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found(crud.resource, &id).respond(crud.messages.update),
        Err(error) => return Refusal::Database(error).respond(crud.messages.update),
    };
    let table = crud.table;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(&data));
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    if let Err(error) = table.patch(&caller.db, &id, values, true, trusted).await {
        return write_failed(&error, crud.messages.update);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for field in crud.updated_fields {
        let (name, value) = match *field {
            Changed::UpdateOrExisting(name) => (
                name,
                data.get(name)
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or_else(|| existing[name].clone()),
            ),
            Changed::Existing(name) => (name, existing[name].clone()),
        };
        event.insert(name.to_owned(), value);
    }
    caller.publish(&state, crud.updated, &id, &Value::Object(event));
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    crud: Handler,
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found(crud.resource, &id).respond(crud.messages.delete),
        Err(error) => return Refusal::Database(error).respond(crud.messages.delete),
    }
    if let Err(error) = soft_delete(&caller.db, crud.table, &id).await {
        return write_failed(&error, crud.messages.delete);
    }
    caller.publish(&state, crud.deleted, &id, &json!({ "id": id }));
    NoContent.into_response()
}

/// `update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id))`.
pub(crate) async fn soft_delete(
    db: &weldsuite_db::PgPool,
    table: &Table,
    id: &str,
) -> Result<(), WriteError> {
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "deletedAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    table
        .patch(db, id, values, false, &["deletedAt", "updatedAt"])
        .await
        .map(|_| ())
}
