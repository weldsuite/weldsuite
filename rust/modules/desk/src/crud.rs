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
use sea_orm::sea_query::{Expr, Order};
use sea_orm::{Condition, DbErr};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_kit::validation::Issues;
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, query_param, sql_limit};
use crate::table::{Table, WriteError};
use crate::{Caller, DeskState, Refusal, now, validate};

/// A list filter: `test` on `q[key]` when the query value is a non-empty
/// string, as `'%' + q[key] + '%'` for a `like` one. `test` is the
/// condition on the entity's columns (`eq(column, value)`, `like(…)`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Filter {
    pub(crate) query: &'static str,
    pub(crate) like: bool,
    pub(crate) test: fn(String) -> Condition,
}

impl Filter {
    pub(crate) const fn eq(query: &'static str, test: fn(String) -> Condition) -> Self {
        Self {
            query,
            like: false,
            test,
        }
    }

    pub(crate) const fn like(query: &'static str, test: fn(String) -> Condition) -> Self {
        Self {
            query,
            like: true,
            test,
        }
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
    /// The list's filters, after its live-only condition and before its
    /// cursor. The rows come newest first.
    pub(crate) filters: &'static [Filter],
    /// The count drops the last list condition on a `?cursor=`
    /// (`conditions.slice(0, -1)`); otherwise it counts the filters only.
    pub(crate) slice_count: bool,
    pub(crate) created: EventName,
    /// The fields of the created event's data, read from the body.
    pub(crate) created_fields: &'static [&'static str],
    pub(crate) updated: EventName,
    pub(crate) updated_fields: &'static [Changed],
    pub(crate) deleted: EventName,
    /// What else a write does once the row is stored.
    pub(crate) hook: Hook,
}

/// A route file's extra step after a create or an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hook {
    None,
    /// ticket-types: `syncTicketTypeDefinitions` with the body's `fields`
    /// (after a create; after an update only when the body has them).
    TicketTypeFields,
    /// helpdesk-departments: `recheckEscalations` after an update that
    /// changes the team's `escalationRules` or `isActive`.
    DepartmentEscalations,
    /// canned-responses: the caller owns what they create (`agentId`, never
    /// the body's), and an update that saves an ownerless response as
    /// `personal` makes it theirs. A personal response is visible in the
    /// picker to its owner only (`/search`).
    CannedResponseOwner,
}

type Handler = &'static Crud;

/// The five routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(crud: Handler, gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    item_routes(crud, gate).route(
        "/",
        get(
            move |state: State<DeskState>, caller: Caller, query: RawQuery| {
                list(crud, state, caller, query)
            },
        )
        .route_layer(gate.require([crud.gates.read.to_owned()])),
    )
}

/// Every route but the list (`POST /` and `/:id`), for a route file that
/// lists its own way.
pub(crate) fn item_routes<Q>(crud: Handler, gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
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

/// The keyset operands: the cursor row's `createdAt` as JavaScript read it
/// (milliseconds) and its id.
pub(crate) type CursorRow = (PrimitiveDateTime, String);

/// `select createdAt, id from t where id = cursor limit 1`.
pub(crate) async fn cursor_row(
    db: &weldsuite_db::PgPool,
    table: &Table,
    cursor: &str,
) -> Result<Option<CursorRow>, DbErr> {
    let row = table
        .entity
        .find(&weldsuite_db::orm(db), cursor, false)
        .await?;
    Ok(row.and_then(|row| {
        let created_at = row.get("createdAt").and_then(Value::as_str)?;
        let id = row.get("id").and_then(Value::as_str)?;
        Some((js_date_time(created_at)?, id.to_owned()))
    }))
}

/// A `toISOString()` (`2026-10-29T07:00:00.123Z`) as the `timestamp` it was
/// read from.
pub(crate) fn js_date_time(text: &str) -> Option<PrimitiveDateTime> {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]"
    );
    PrimitiveDateTime::parse(text.strip_suffix('Z')?, format).ok()
}

/// `t.<name>` of the table's entity.
pub(crate) fn column(table: &Table, name: &str) -> Result<Expr, DbErr> {
    table
        .entity
        .column(name)
        .ok_or_else(|| DbErr::Custom(format!("{} has no {name}", table.name)))
}

/// `or(lt(t.createdAt, at), and(eq(t.createdAt, at), lt(t.id, id)))`.
pub(crate) fn before(table: &Table, (at, id): &CursorRow) -> Result<Condition, DbErr> {
    use sea_orm::ExprTrait as _;
    let created_at = column(table, "created_at")?;
    Ok(Condition::any().add(created_at.clone().lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(column(table, "id")?.lt(id.as_str())),
    ))
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

/// A cursor-paged list: its table and filters (see [`Crud`]).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Listing {
    pub(crate) table: &'static Table,
    pub(crate) filters: &'static [Filter],
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
    Database(DbErr),
}

impl ListError {
    pub(crate) fn respond(self, message: &str) -> Response {
        match self {
            Self::Cursor => ApiError::internal().into_response(),
            Self::Database(error) => Refusal::from(error).respond(message),
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
        Some(cursor) => cursor_row(db, listing.table, cursor)
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
    let entity = &listing.table.entity;
    let conditions = |slots: &Slots| conditions(listing, slots, &values, cursor_row.as_ref());
    let mut select = entity.select();
    select
        .cond_where(conditions(&page).map_err(ListError::Database)?)
        .order_by_expr(
            column(listing.table, "created_at").map_err(ListError::Database)?,
            Order::Desc,
        )
        .order_by_expr(
            column(listing.table, "id").map_err(ListError::Database)?,
            Order::Desc,
        );
    if let Some(limit) = sql_limit(limit) {
        select.limit(u64::try_from(limit).unwrap_or(0));
    }
    let mut counted = entity.select();
    counted.cond_where(conditions(&count).map_err(ListError::Database)?);
    let db = weldsuite_db::orm(db);
    let rows = entity
        .rows(&db, &select)
        .await
        .map_err(ListError::Database)?;
    let total = entity
        .count(&db, &counted)
        .await
        .map_err(ListError::Database)?;
    Ok(Fetched { rows, limit, total })
}

/// The list's conditions the slots keep: `isNull(t.deletedAt)`, then each
/// filter on its value, then the cursor.
fn conditions(
    listing: Listing,
    slots: &Slots,
    values: &[Option<String>],
    cursor: Option<&CursorRow>,
) -> Result<Condition, DbErr> {
    use sea_orm::ExprTrait as _;
    let mut all = Condition::all();
    if !slots.skip[0] {
        all = all.add(column(listing.table, "deleted_at")?.is_null());
    }
    for (index, (filter, value)) in listing.filters.iter().zip(values).enumerate() {
        if !slots.skip[index + 1]
            && let Some(value) = value
        {
            all = all.add((filter.test)(value.clone()));
        }
    }
    if !slots.skip[values.len() + 1]
        && let Some(cursor) = cursor
    {
        all = all.add(before(listing.table, cursor)?);
    }
    Ok(all)
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
        slice_count: crud.slice_count,
    };
    match fetch(listing, &caller.db, query.as_deref()).await {
        Ok(fetched) => page_list(fetched.rows, fetched.limit, fetched.total),
        Err(error) => error.respond(crud.messages.list),
    }
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
        Err(error) => Refusal::from(error).respond(crud.messages.fetch),
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
    if crud.hook == Hook::CannedResponseOwner {
        table.set(&mut values, "agentId", json!(caller.user_id));
    }
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let mut trusted = vec!["createdAt", "updatedAt"];
    if !data.contains_key("id") {
        trusted.push("id");
    }
    if let Err(error) = table.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, crud.messages.create);
    }
    if crud.hook == Hook::TicketTypeFields {
        crate::ticket_types::sync_definitions(&caller.db, &id, data.get("fields")).await;
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
        Err(error) => return Refusal::from(error).respond(crud.messages.update),
    };
    let table = crud.table;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(&data));
    if crud.hook == Hook::CannedResponseOwner
        && data.get("scope").and_then(Value::as_str) == Some("personal")
        && existing
            .get("agentId")
            .is_none_or(|owner| owner.is_null() || owner.as_str() == Some(""))
    {
        table.set(&mut values, "agentId", json!(caller.user_id));
    }
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    if let Err(error) = table.patch(&caller.db, &id, values, true, trusted).await {
        return write_failed(&error, crud.messages.update);
    }
    if crud.hook == Hook::TicketTypeFields
        && let Some(fields) = data.get("fields")
    {
        crate::ticket_types::sync_definitions(&caller.db, &id, Some(fields)).await;
    }
    if crud.hook == Hook::DepartmentEscalations
        && (data.contains_key("escalationRules") || data.contains_key("isActive"))
        && let Err(error) = crate::departments::recheck_escalations(&state, &caller, &id).await
    {
        return write_failed(&WriteError::from(error), crud.messages.update);
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
        Err(error) => return Refusal::from(error).respond(crud.messages.delete),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every paged list orders and pages on `created_at` and `id`, and the
    /// live-only condition is `deleted_at`: columns found by name.
    #[test]
    fn the_lists_have_their_keyset_columns() {
        let cruds = [
            &crate::simple::FAQS,
            &crate::simple::NEWS,
            &crate::simple::ANNOUNCEMENTS,
            &crate::simple::FEEDBACK,
            &crate::simple::REVIEWS,
            &crate::simple::SLA,
            &crate::simple::TICKET_NOTES,
            &crate::simple::TICKET_MESSAGES,
            &crate::simple::SURVEYS,
            &crate::library::ARTICLE_FOLDERS,
            &crate::library::TICKET_TYPES,
            &crate::library::HELPDESK_AGENTS,
            &crate::library::CANNED_RESPONSES,
            &crate::library::WORKFLOWS,
            &crate::library::DEPARTMENTS_CRUD,
        ];
        let tables = cruds
            .iter()
            .map(|crud| crud.table)
            .chain([
                crate::tickets::LISTING.table,
                crate::kb::ARTICLE_LISTING.table,
            ])
            .chain([&crate::tables::HELPDESK_CONVERSATIONS]);
        for table in tables {
            for name in ["id", "created_at", "deleted_at"] {
                assert!(column(table, name).is_ok(), "{}.{name}", table.name);
            }
        }
    }

    #[test]
    fn a_cursor_stamp_reads_back_to_the_millisecond() {
        let at = js_date_time("2026-10-29T07:00:00.123Z");
        assert_eq!(
            at.map(|at| at.to_string()),
            Some("2026-10-29 7:00:00.123".to_owned())
        );
        assert_eq!(js_date_time("2026-10-29"), None);
    }
}
