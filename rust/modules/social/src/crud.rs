//! The flat CRUD surface the social-api object routes share (accounts,
//! posts, campaigns, media, approvals, team members): `GET /` (cursor-paged,
//! newest first, a few filters), `GET /:id`, `POST /`, `PATCH /:id`,
//! `DELETE /:id` (soft). Every route file is the same code with a different
//! table, schema, filters, messages and event payloads; [`Crud`] is that
//! difference, and a route file adds or replaces what it does its own way.
//!
//! The TypeScript quirks are kept: a `?cursor=` makes most counts drop the
//! last condition of the list, which is a filter when the cursor row is gone;
//! a client `id` in a passthrough body wins over the generated one in the row
//! (the response and the event still carry the generated id); a body key
//! that names a `date` timestamp makes Drizzle throw (the route's 500).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, js_slice, query_param, sql_limit, text};
use crate::table::{Table, WriteError};
use crate::{Caller, SocialState, now, validate};

/// A list filter: `eq(column, q[key])` or `like(column, '%' + q[key] + '%')`
/// when the query value is a non-empty string.
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

/// Whether the schema is the create schema or its `.partial()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Partial(pub(crate) bool);

impl Partial {
    /// A required field becomes optional under `.partial()`.
    pub(crate) fn required(self) -> Presence {
        if self.0 {
            Presence::Optional
        } else {
            Presence::Required
        }
    }
}

/// The schema of `POST /` (`partial` for `PATCH /:id`'s `.partial()`).
pub(crate) type Schema = fn(&mut Issues, &Map<String, Value>, Partial);

/// What a create writes beyond the body (server-owned defaults): changes
/// `data` in place and names the `Date` properties it set itself; `Err`
/// when a value it builds can't be written (an Invalid Date).
pub(crate) type Prepare =
    fn(&Caller, &str, &mut Map<String, Value>) -> Result<Vec<&'static str>, ()>;

/// The created event's `data`: from the new id and the written body.
pub(crate) type CreatedEvent = fn(&str, &Map<String, Value>) -> Value;

/// The updated event's `data`: from the id, the body and the row before.
pub(crate) type UpdatedEvent = fn(&str, &Map<String, Value>, &Value) -> Value;

/// A refusal an update makes before writing (`error.badRequest`).
pub(crate) type Guard = fn(&Map<String, Value>, &Value) -> Option<&'static str>;

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
    /// Properties never shown (`accessToken`).
    pub(crate) hidden: &'static [&'static str],
    pub(crate) prepare: Prepare,
    pub(crate) created: EventName,
    pub(crate) created_event: CreatedEvent,
    pub(crate) updated: EventName,
    pub(crate) updated_event: UpdatedEvent,
    pub(crate) guard: Option<Guard>,
    pub(crate) deleted: EventName,
}

type Handler = &'static Crud;

/// Which of the standard routes a file takes as they are.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Standard {
    pub(crate) create: bool,
    pub(crate) remove: bool,
}

/// The standard routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(
    crud: Handler,
    gate: &Arc<PermissionGate<Q>>,
    standard: Standard,
) -> Router<SocialState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    let mut router = Router::new()
        .route(
            "/",
            get(move |caller: Caller, query: RawQuery| list(crud, caller, query))
                .route_layer(need(crud.gates.read)),
        )
        .route(
            "/{id}",
            get(move |caller: Caller, id: Path<String>| detail(crud, caller, id))
                .route_layer(need(crud.gates.read)),
        )
        .route(
            "/{id}",
            patch(
                move |state: State<SocialState>,
                      caller: Caller,
                      id: Path<String>,
                      headers: HeaderMap,
                      body: Bytes| {
                    update(crud, state, caller, id, headers, body)
                },
            )
            .route_layer(need(crud.gates.update)),
        );
    if standard.create {
        router = router.route(
            "/",
            post(
                move |state: State<SocialState>,
                      caller: Caller,
                      headers: HeaderMap,
                      body: Bytes| { create(crud, state, caller, headers, body) },
            )
            .route_layer(need(crud.gates.create)),
        );
    }
    if standard.remove {
        router = router.route(
            "/{id}",
            delete(
                move |state: State<SocialState>, caller: Caller, id: Path<String>| {
                    remove(crud, state, caller, id)
                },
            )
            .route_layer(need(crud.gates.delete)),
        );
    }
    router
}

/// The keyset condition's operands: the cursor row's `createdAt` as
/// JavaScript read it (milliseconds) and its id.
async fn cursor_row(
    db: &weldsuite_db::PgPool,
    table: &str,
    cursor: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
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
        "social_accounts",
        "social_campaigns",
        "social_posts",
        "social_media",
        "social_approvals",
        "social_team_members",
    )
}

/// The skipped slots of the page and of its count: with a `?cursor=` and
/// `slice_count`, TypeScript counts with `conditions.slice(0, -1)`, which
/// drops the cursor condition, or the last filter when the cursor row is
/// gone; without it, the count takes the filters only.
fn slots(active: &[bool], cursor_given: bool, slice_count: bool) -> (Vec<bool>, Vec<bool>) {
    let page: Vec<bool> = active.iter().map(|a| !a).collect();
    let mut count = page.clone();
    if slice_count {
        if cursor_given && let Some(last) = count.iter().rposition(|skip| !skip) {
            count[last] = true;
        }
    } else if let Some(last) = count.last_mut() {
        *last = true;
    }
    (page, count)
}

/// Why a list could not be read: the app's 500 (the cursor lookup runs
/// before the route's `try`) or a statement inside it (the route's 500).
enum ListError {
    Cursor,
    Database(sqlx::Error),
}

async fn list(crud: Handler, caller: Caller, RawQuery(query): RawQuery) -> Response {
    match fetch(crud, &caller, query.as_deref()).await {
        Ok(response) => response,
        Err(ListError::Cursor) => ApiError::internal().into_response(),
        Err(ListError::Database(error)) => crate::internal(&error, crud.messages.list),
    }
}

async fn fetch(crud: Handler, caller: &Caller, query: Option<&str>) -> Result<Response, ListError> {
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let values: Vec<Option<String>> = crud
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
        Some(cursor) => cursor_row(db, crud.table.name, cursor)
            .await
            .map_err(|error| {
                tracing::error!(%error, "social: cursor lookup failed");
                ListError::Cursor
            })?,
        None => None,
    };
    let mut active = vec![true];
    active.extend(values.iter().map(Option::is_some));
    active.push(cursor_row.is_some());
    let (page, count) = slots(&active, cursor.is_some(), crud.slice_count);
    let rows: Vec<Value> = bind_slots(
        sqlx::query_scalar(crud.list_sql),
        &page,
        &values,
        cursor_row.as_ref(),
    )
    .bind(sql_limit(limit))
    .fetch_all(db)
    .await
    .map_err(ListError::Database)?;
    let total: i64 = bind_slots(
        sqlx::query_scalar(crud.count_sql),
        &count,
        &values,
        cursor_row.as_ref(),
    )
    .fetch_one(db)
    .await
    .map_err(ListError::Database)?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| show(crud, crud.table.js(row)))
        .collect();
    // `rows.length > limit` is false for a NaN limit.
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data = if has_more {
        #[allow(clippy::cast_possible_truncation)]
        js_slice(rows, limit as i64)
    } else {
        rows
    };
    let next = if has_more {
        data.last()
            .and_then(|row| text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    Ok(weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, next),
    )
    .into_response())
}

/// Bind the slots: `$1` live-only skip, then `(skip, value)` per filter,
/// then the cursor's `(skip, created_at, id)`.
fn bind_slots<'q, O>(
    query: sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments>,
    skip: &[bool],
    values: &'q [Option<String>],
    cursor: Option<&'q (String, String)>,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments> {
    let mut query = query.bind(skip[0]);
    for (index, value) in values.iter().enumerate() {
        query = query.bind(skip[index + 1]).bind(value.as_deref());
    }
    query
        .bind(skip[values.len() + 1])
        .bind(cursor.map(|(created_at, _)| created_at.as_str()))
        .bind(cursor.map(|(_, id)| id.as_str()))
}

/// The row without its hidden properties.
fn show(crud: Handler, mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        for hidden in crud.hidden {
            fields.remove(*hidden);
        }
    }
    row
}

async fn detail(crud: Handler, caller: Caller, Path(id): Path<String>) -> Response {
    match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(show(crud, row)).into_response(),
        Ok(None) => ApiError::not_found(crud.resource, Some(&id)).into_response(),
        Err(error) => crate::internal(&error, crud.messages.fetch),
    }
}

/// The body as the schema let it through (`c.req.valid('json')`).
pub(crate) fn read_body(
    crud: Handler,
    headers: &HeaderMap,
    body: &Bytes,
    partial: bool,
) -> Result<Map<String, Value>, Box<Response>> {
    validate(headers, body, |issues, fields| {
        (crud.schema)(issues, fields, Partial(partial));
        fields.clone()
    })
}

/// A failed write: the route's 500.
pub(crate) fn write_failed(error: &WriteError, message: &str) -> Response {
    crate::internal(error, message)
}

/// `insert(t).values({ id, ...data, createdAt: now, updatedAt: now })`.
pub(crate) async fn insert_row(
    caller: &Caller,
    table: &Table,
    id: &str,
    data: &Map<String, Value>,
    trusted_dates: &[&'static str],
) -> Result<Value, WriteError> {
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    values.extend(table.values(data));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let mut trusted = vec!["createdAt", "updatedAt"];
    trusted.extend(trusted_dates);
    if !data.contains_key("id") {
        trusted.push("id");
    }
    table.insert(&caller.db, values, &trusted).await
}

async fn create(
    crud: Handler,
    State(state): State<SocialState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut data = match read_body(crud, &headers, &body, false) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let id = generate_id(crud.id_prefix);
    let Ok(trusted) = (crud.prepare)(&caller, &id, &mut data) else {
        return crate::internal(&"Invalid time value", crud.messages.create);
    };
    if let Err(error) = insert_row(&caller, crud.table, &id, &data, &trusted).await {
        return write_failed(&error, crud.messages.create);
    }
    caller.publish(&state, crud.created, &id, &(crud.created_event)(&id, &data));
    Created(json!({ "id": id })).into_response()
}

/// `update(t).set({ updatedAt: new Date(), ...data })` on the live row.
pub(crate) async fn patch_row(
    caller: &Caller,
    table: &Table,
    id: &str,
    data: &Map<String, Value>,
) -> Result<Option<Value>, WriteError> {
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(data));
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    table.patch(&caller.db, id, values, true, trusted).await
}

async fn update(
    crud: Handler,
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_body(crud, &headers, &body, true) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let existing = match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found(crud.resource, Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, crud.messages.update),
    };
    if let Some(message) = crud.guard.and_then(|guard| guard(&data, &existing)) {
        return ApiError::bad_request(message).into_response();
    }
    if let Err(error) = patch_row(&caller, crud.table, &id, &data).await {
        return write_failed(&error, crud.messages.update);
    }
    caller.publish(
        &state,
        crud.updated,
        &id,
        &(crud.updated_event)(&id, &data, &existing),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    crud: Handler,
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found(crud.resource, Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, crud.messages.delete),
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

// ── event payload helpers ───────────────────────────────────────────────────

/// `{ ...fields }` with only the present ones (JSON drops `undefined`).
pub(crate) fn event(fields: &[(&str, Option<Value>)]) -> Value {
    let mut out = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `data[key]` when present (`undefined` otherwise).
pub(crate) fn field(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).cloned()
}

/// `data[key] ?? fallback`.
#[allow(clippy::unnecessary_wraps)] // an event field
pub(crate) fn or_default(data: &Map<String, Value>, key: &str, fallback: &str) -> Option<Value> {
    Some(
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(fallback)),
    )
}

/// `(update[key] ?? existing[key])`.
pub(crate) fn update_or_existing(
    data: &Map<String, Value>,
    existing: &Value,
    key: &str,
) -> Option<Value> {
    match data.get(key).filter(|v| !v.is_null()) {
        Some(value) => Some(value.clone()),
        None => existing.get(key).cloned(),
    }
}

/// `(update[key] ?? existing[key]) || fallback`.
pub(crate) fn update_or_existing_or(
    data: &Map<String, Value>,
    existing: &Value,
    key: &str,
    fallback: &str,
) -> Option<Value> {
    let value = update_or_existing(data, existing, key);
    let falsy = match &value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Bool(flag)) => !flag,
        Some(Value::Number(n)) => n.as_f64().is_none_or(|n| n == 0.0),
        Some(_) => false,
    };
    if falsy { Some(json!(fallback)) } else { value }
}

/// The router's prepare for tables without server-owned defaults.
#[allow(clippy::unnecessary_wraps)] // a Prepare
pub(crate) fn no_prepare(
    _: &Caller,
    _: &str,
    _: &mut Map<String, Value>,
) -> Result<Vec<&'static str>, ()> {
    Ok(Vec::new())
}
