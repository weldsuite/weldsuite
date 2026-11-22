//! The plain CRUD route files of stash-api (boxes, warehouses, warehouse
//! zones and locations, suppliers, cycle counts, purchase orders, inventory
//! movements): `GET /` (cursor-paged, a few filters), `GET /:id`, `POST /`,
//! `PATCH /:id`, `DELETE /:id` (soft, except movements).
//!
//! Each file is the same code with a different table, schema, filters,
//! ordering, messages and event payloads; [`Crud`] is that difference. The
//! TypeScript quirks are kept: a `?cursor=` makes the count drop the last
//! condition of the list, which is a filter (or the live-only condition)
//! when the cursor row is gone; a passthrough body's `id` wins over the
//! generated one in the row (the response and the event still carry the
//! generated id); a body key that names a `date` timestamp makes Drizzle
//! throw (the route's 500).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Alias, Expr, Order};
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, DbBackend, DbErr, EntityTrait};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PARCEL_BOX_CREATED, PARCEL_BOX_DELETED, PARCEL_BOX_UPDATED, PURCHASE_ORDER_CREATED,
    PURCHASE_ORDER_DELETED, PURCHASE_ORDER_UPDATED, SUPPLIER_CREATED, SUPPLIER_DELETED,
    SUPPLIER_UPDATED, WAREHOUSE_CREATED, WAREHOUSE_DELETED, WAREHOUSE_UPDATED,
    WAREHOUSE_ZONE_CREATED, WAREHOUSE_ZONE_DELETED, WAREHOUSE_ZONE_UPDATED,
    WMS_CYCLE_COUNT_CREATED, WMS_CYCLE_COUNT_DELETED, WMS_CYCLE_COUNT_UPDATED,
    WMS_INVENTORY_MOVEMENT_CREATED, WMS_INVENTORY_MOVEMENT_DELETED, WMS_INVENTORY_MOVEMENT_UPDATED,
    WMS_LOCATION_CREATED, WMS_LOCATION_DELETED, WMS_LOCATION_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    boxes, cycle_counts, inventory_movements, purchase_orders, suppliers, warehouse_locations,
    warehouse_zones, warehouses,
};

use crate::args::{all_on, limit_plus_one, millis, page_list, pushed, sliced, table_count, table_rows};
use crate::js::{js_limit, number_text, query_param, query_set};
use crate::table::{Table, WriteError};
use crate::{Caller, Refusal, StashState, internal, now, validate};

/// The `requirePermission` keys of a route file.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Gates {
    pub(crate) read: &'static str,
    pub(crate) create: &'static str,
    pub(crate) update: &'static str,
    pub(crate) delete: &'static str,
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

/// How the list resumes after its cursor row.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Cursor {
    /// `(createdAt, id)` descending, pushed when the row has a `createdAt`.
    Created,
    /// `(pickingSequence, id)` ascending, pushed whenever the row exists
    /// (its sequence may be null, which matches nothing).
    Sequence,
}

type Body = Map<String, Value>;

/// A created event: its name and its data from `(id, data)`.
type CreatedEvent = (EventName, fn(&str, &Body) -> Value);
/// An updated event: its name and its data from `(id, data, existing)`.
type UpdatedEvent = (EventName, fn(&str, &Body, &Value) -> Value);
/// A deleted event: its name and its data from `(id, existing)`.
type DeletedEvent = (EventName, fn(&str, &Value) -> Value);
/// The list's filter slots read from the query: a condition each, when it
/// is pushed.
type Filters = fn(Option<&str>) -> Vec<Option<Condition>>;

/// One CRUD route file.
#[derive(Clone, Copy)]
pub(crate) struct Crud {
    pub(crate) table: &'static Table,
    /// `error.notFound(c, '<resource>', id)`.
    pub(crate) resource: &'static str,
    pub(crate) id_prefix: &'static str,
    pub(crate) gates: Gates,
    pub(crate) messages: Messages,
    /// The create schema, or its `.partial()` for `PATCH /:id`: the body as
    /// `c.req.valid('json')` holds it.
    pub(crate) schema: fn(&mut Issues, &Body, bool) -> Body,
    /// The list's conditions after the live-only one, in push order.
    pub(crate) filters: Filters,
    /// Whether the table has `deleted_at` (the list's first slot, and a
    /// soft delete).
    pub(crate) live: bool,
    pub(crate) cursor: Cursor,
    /// The list's order: columns and directions.
    pub(crate) order: &'static [(&'static str, Order)],
    /// `db.insert(t).values(...)` of `POST /`: the `{ prop: value }` object.
    pub(crate) create: fn(&Body, &str, &str) -> Body,
    /// `db.update(t).set(update)` of `PATCH /:id`, `updatedAt` aside.
    pub(crate) update: fn(&Body) -> Body,
    pub(crate) created: CreatedEvent,
    pub(crate) updated: UpdatedEvent,
    pub(crate) deleted: DeletedEvent,
}

/// `orderBy(desc(t.createdAt), desc(t.id))`.
const NEWEST_FIRST: &[(&str, Order)] = &[("created_at", Order::Desc), ("id", Order::Desc)];

type Handler = &'static Crud;

/// The five routes, each with its `requirePermission`.
pub(crate) fn routes<Q>(crud: Handler, gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/",
            get(move |caller: Caller, query: RawQuery| list(crud, caller, query))
                .route_layer(need(crud.gates.read)),
        )
        .route(
            "/",
            post(
                move |state: State<StashState>, caller: Caller, headers: HeaderMap, body: Bytes| {
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
            patch(
                move |state: State<StashState>,
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
            delete(
                move |state: State<StashState>, caller: Caller, id: Path<String>| {
                    remove(crud, state, caller, id)
                },
            )
            .route_layer(need(crud.gates.delete)),
        )
}

async fn list(crud: Handler, caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let cursor = query_set(query, "cursor");
    // The cursor lookup runs before the route's `try`: a failure is the
    // app's 500.
    let cursor_slot = match &cursor {
        Some(cursor) => match cursor_condition(&caller.db, crud, cursor).await {
            Ok(slot) => slot,
            Err(error) => return cursor_failed(&error),
        },
        None => None,
    };
    match fetch(crud, &caller.db, query, cursor.is_some(), cursor_slot, limit).await {
        Ok((rows, total)) => page_list(rows, limit, total),
        Err(error) => internal(&error, crud.messages.list),
    }
}

/// The page (`limit + 1` rows) and the count of a list.
async fn fetch(
    crud: Handler,
    db: &PgPool,
    query: Option<&str>,
    cursor_given: bool,
    cursor_slot: Option<Condition>,
    limit: f64,
) -> Result<(Vec<Value>, i64), DbErr> {
    use sea_orm::ExprTrait as _;
    let table = crud.table;
    let mut slots: Vec<Option<Condition>> = Vec::new();
    if crud.live {
        slots.push(Some(
            Condition::all().add(column(table, "deleted_at")?.is_null()),
        ));
    }
    slots.extend((crud.filters)(query));
    slots.push(cursor_slot);
    let on = pushed(&slots);
    let count_on = sliced(on.clone(), cursor_given);
    let mut page = table.entity.select();
    page.cond_where(all_on(&slots, &on));
    for (name, order) in crud.order {
        page.order_by_expr(column(table, name)?, order.clone());
    }
    limit_plus_one(&mut page, limit);
    let mut counted = table.entity.select();
    counted.cond_where(all_on(&slots, &count_on));
    let rows = table_rows(db, table, &page).await?;
    let total = table_count(db, table, &counted).await?;
    Ok((rows, total))
}

/// `t.<name>` of the table's entity.
fn column(table: &Table, name: &str) -> Result<Expr, DbErr> {
    table
        .entity
        .column(name)
        .ok_or_else(|| DbErr::Custom(format!("{} has no {name}", table.name)))
}

/// The cursor row's keyset condition: `(createdAt, id)` before it, or
/// `(pickingSequence, id)` after it. `None` when the row is gone (or has no
/// `createdAt`).
async fn cursor_condition(
    db: &PgPool,
    crud: Handler,
    cursor: &str,
) -> Result<Option<Condition>, DbErr> {
    use sea_orm::ExprTrait as _;
    let table = crud.table;
    let key = match crud.cursor {
        Cursor::Created => "created_at",
        Cursor::Sequence => "picking_sequence",
    };
    let mut select = table.entity.select();
    select
        .clear_selects()
        .expr_as(column(table, key)?, Alias::new("key"))
        .expr_as(column(table, "id")?, Alias::new("id"))
        .and_where(column(table, "id")?.eq(cursor))
        .limit(1);
    let Some(row) = orm(db)
        .query_one_raw(DbBackend::Postgres.build(&select))
        .await?
    else {
        return Ok(None);
    };
    let id: String = row.try_get("", "id")?;
    let (keyed, ids) = (column(table, key)?, column(table, "id")?);
    Ok(match crud.cursor {
        Cursor::Created => {
            let at: Option<PrimitiveDateTime> = row.try_get("", "key")?;
            at.map(millis).map(|at| {
                Condition::any()
                    .add(keyed.clone().lt(at))
                    .add(Condition::all().add(keyed.eq(at)).add(ids.lt(id)))
            })
        }
        Cursor::Sequence => {
            let sequence: Option<i32> = row.try_get("", "key")?;
            Some(
                Condition::any()
                    .add(keyed.clone().gt(sequence))
                    .add(Condition::all().add(keyed.eq(sequence)).add(ids.gt(id))),
            )
        }
    })
}

/// A failed cursor lookup: it runs outside the route's `try`.
pub(crate) fn cursor_failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "stash: cursor lookup failed");
    ApiError::internal().into_response()
}

async fn detail(crud: Handler, caller: Caller, Path(id): Path<String>) -> Response {
    match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found(crud.resource, &id).respond(crud.messages.fetch),
        Err(error) => internal(&error, crud.messages.fetch),
    }
}

async fn create(
    crud: Handler,
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        (crud.schema)(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(crud.messages.create),
    };
    let id = generate_id(crud.id_prefix);
    let now = now();
    let props = (crud.create)(&data, &id, &now);
    let table = crud.table;
    let mut values = Map::new();
    for (prop, value) in &props {
        table.set(&mut values, prop, value.clone());
    }
    // What the route set itself is a JavaScript value (it sets the
    // timestamps after the body); what came from the body is checked as
    // Drizzle would.
    let trusted = ["id", "createdAt", "updatedAt"];
    if let Err(error) = table.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, crud.messages.create);
    }
    caller.publish(&state, crud.created.0, &id, &(crud.created.1)(&id, &data));
    Created(json!({ "id": id })).into_response()
}

/// The properties of `props` the route set itself: those in `own` the body
/// did not override.
fn trusted_props(props: &Body, data: &Body, own: &[&'static str]) -> Vec<&'static str> {
    own.iter()
        .copied()
        .filter(|prop| props.contains_key(*prop) && !data.contains_key(*prop))
        .collect()
}

/// A failed write: the route's 500.
pub(crate) fn write_failed(error: &WriteError, message: &str) -> Response {
    internal(error, message)
}

async fn update(
    crud: Handler,
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        (crud.schema)(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(crud.messages.update),
    };
    let existing = match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found(crud.resource, &id).respond(crud.messages.update),
        Err(error) => return internal(&error, crud.messages.update),
    };
    let table = crud.table;
    let mut props = Map::new();
    props.insert("updatedAt".to_owned(), json!(now()));
    props.extend((crud.update)(&data));
    let mut values = Map::new();
    for (prop, value) in &props {
        table.set(&mut values, prop, value.clone());
    }
    let trusted = trusted_props(&props, &data, &["updatedAt"]);
    if let Err(error) = table
        .patch(&caller.db, &id, values, crud.live, &trusted)
        .await
    {
        return write_failed(&error, crud.messages.update);
    }
    caller.publish(
        &state,
        crud.updated.0,
        &id,
        &(crud.updated.1)(&id, &data, &existing),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    crud: Handler,
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match crud.table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found(crud.resource, &id).respond(crud.messages.delete),
        Err(error) => return internal(&error, crud.messages.delete),
    };
    let removed = if crud.live {
        soft_delete(&caller.db, crud.table, &id).await
    } else {
        inventory_movements::Entity::delete_by_id(id.clone())
            .exec(&orm(&caller.db))
            .await
            .map(|_| ())
            .map_err(WriteError::from)
    };
    if let Err(error) = removed {
        return write_failed(&error, crud.messages.delete);
    }
    caller.publish(
        &state,
        crud.deleted.0,
        &id,
        &(crud.deleted.1)(&id, &existing),
    );
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

// ── shared pieces of the route files ────────────────────────────────────────

/// `{ id, ...data, createdAt: now, updatedAt: now }`.
pub(crate) fn spread_create(data: &Body, id: &str, now: &str) -> Body {
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    props.extend(data.clone());
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    props
}

/// `for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v`.
pub(crate) fn spread_update(data: &Body) -> Body {
    data.clone()
}

/// `{ id }`.
fn only_id(id: &str, _: &Value) -> Value {
    json!({ "id": id })
}

/// `data.<key>` into an event object, left out when undefined.
pub(crate) fn put_from(event: &mut Body, data: &Body, key: &str) {
    if let Some(value) = data.get(key) {
        event.insert(key.to_owned(), value.clone());
    }
}

/// `(update.<key>) ?? existing.<key>`.
pub(crate) fn update_or_existing(data: &Body, existing: &Value, key: &str) -> Value {
    data.get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| existing.get(key).cloned().unwrap_or(Value::Null))
}

/// `existing.<key>`.
fn existing_of(existing: &Value, key: &str) -> Value {
    existing.get(key).cloned().unwrap_or(Value::Null)
}

/// `{ id, ...picked from data }`.
fn event_from(id: &str, data: &Body, keys: &[&str]) -> Value {
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for key in keys {
        put_from(&mut event, data, key);
    }
    Value::Object(event)
}

/// A filter slot: `eq(column, value)` when `value` is set and not empty.
pub(crate) fn eq_slot<C: ColumnTrait>(query: Option<&str>, name: &str, column: C) -> Option<Condition> {
    query_set(query, name).map(|value| Condition::all().add(column.eq(value)))
}

/// `or(like(a, term), like(b, term)…)` on `%search%`, when `search` is set.
pub(crate) fn search_slot<C: ColumnTrait>(query: Option<&str>, columns: &[C]) -> Option<Condition> {
    let term = format!("%{}%", query_set(query, "search")?);
    Some(
        columns
            .iter()
            .fold(Condition::any(), |any, column| any.add(column.like(term.as_str()))),
    )
}

/// `eq(column, q.<name> === 'true')` whenever the parameter is there.
fn bool_slot<C: ColumnTrait>(query: Option<&str>, name: &str, column: C) -> Option<Condition> {
    query_param(query, name).map(|value| Condition::all().add(column.eq(value == "true")))
}

/// `String(value)` of a number the schema let through, else the value.
fn numeric_string(value: &Value) -> Value {
    if value.is_number() {
        Value::String(number_text(value.as_f64().unwrap_or(f64::NAN)))
    } else {
        value.clone()
    }
}

/// Copies the keys of `data` in `keys` that are set (`!== undefined`).
fn pick(data: &Body, keys: &[&str]) -> Body {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = data.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    out
}

/// A schema's `presence` for a required field, `.partial()` aside.
fn required(partial: bool) -> Presence {
    if partial {
        Presence::Optional
    } else {
        Presence::Required
    }
}

/// `z.record(z.unknown())` at `key`, with `presence`.
fn record(issues: &mut Issues, body: &Body, key: &str, presence: Presence) {
    issues.nested(body, key, presence, |_, _| ());
}

/// `z.string()` with `rules` at `key`, kept in `out` when set or null.
fn keep_text(
    issues: &mut Issues,
    body: &Body,
    out: &mut Body,
    key: &str,
    presence: Presence,
    rules: Text,
) {
    match issues.text_with(body, key, presence, rules) {
        weldsuite_kit::validation::Field::Set(text) => {
            out.insert(key.to_owned(), Value::String(text));
        }
        weldsuite_kit::validation::Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        weldsuite_kit::validation::Field::Absent => {}
    }
}

/// Keeps `body[key]` in `out` when the body has it.
fn keep(body: &Body, out: &mut Body, key: &str) {
    if let Some(value) = body.get(key) {
        out.insert(key.to_owned(), value.clone());
    }
}

/// A `.default(value)` the create schema fills in (not under `.partial()`).
fn default(out: &mut Body, partial: bool, key: &str, value: Value) {
    if !partial && !out.contains_key(key) {
        out.insert(key.to_owned(), value);
    }
}

const fn len(min: Option<usize>, max: Option<usize>) -> Text {
    Text::length(min, max)
}

// ── boxes ──────────────────────────────────────────────────────────────────

/// `createBoxSchema` (`.passthrough()`; `.partial()` for updates).
fn box_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    issues.text_with(body, "name", required(partial), len(Some(1), Some(255)));
    issues.text_with(body, "code", required(partial), len(Some(1), Some(50)));
    for key in ["length", "width", "height", "weight"] {
        issues.string_or_number(body, key, Presence::Optional);
    }
    issues.text_with(body, "unit", Presence::Optional, len(None, Some(10)));
    body.clone()
}


pub(crate) static BOXES: Crud = Crud {
    table: &crate::tables::BOXES,
    resource: "Box",
    id_prefix: "box",
    gates: Gates {
        read: "boxes:read",
        create: "boxes:create",
        update: "boxes:update",
        delete: "boxes:delete",
    },
    messages: Messages {
        list: "Failed to list boxs",
        fetch: "Failed to fetch box",
        create: "Failed to create box",
        update: "Failed to update box",
        delete: "Failed to delete box",
    },
    schema: box_schema,
    filters: |query| vec![search_slot(query, &[boxes::Column::Name, boxes::Column::Code])],
    live: true,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: spread_create,
    update: spread_update,
    created: (PARCEL_BOX_CREATED, |id, data| {
        event_from(id, data, &["name", "code"])
    }),
    updated: (PARCEL_BOX_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "name": update_or_existing(data, existing, "name"),
            "code": update_or_existing(data, existing, "code"),
        })
    }),
    deleted: (PARCEL_BOX_DELETED, only_id),
};

// ── warehouses ─────────────────────────────────────────────────────────────

/// `createWarehouseSchema` (`.passthrough()`).
fn warehouse_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    issues.text_with(body, "name", required(partial), len(Some(1), Some(255)));
    issues.text_with(body, "code", Presence::Optional, len(None, Some(50)));
    issues.boolean(body, "isActive", Presence::Optional);
    body.clone()
}

pub(crate) static WAREHOUSES: Crud = Crud {
    table: &crate::tables::WAREHOUSES,
    resource: "Warehouse",
    id_prefix: "wh",
    gates: Gates {
        read: "warehouses:read",
        create: "warehouses:create",
        update: "warehouses:update",
        delete: "warehouses:delete",
    },
    messages: Messages {
        list: "Failed to list warehouses",
        fetch: "Failed to fetch warehouse",
        create: "Failed to create warehouse",
        update: "Failed to update warehouse",
        delete: "Failed to delete warehouse",
    },
    schema: warehouse_schema,
    filters: |query| {
        vec![search_slot(
            query,
            &[warehouses::Column::Name, warehouses::Column::Code],
        )]
    },
    live: true,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: spread_create,
    update: spread_update,
    created: (WAREHOUSE_CREATED, |id, data| {
        event_from(id, data, &["name", "code"])
    }),
    updated: (WAREHOUSE_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "name": update_or_existing(data, existing, "name"),
            "code": update_or_existing(data, existing, "code"),
        })
    }),
    deleted: (WAREHOUSE_DELETED, only_id),
};

// ── cycle counts ───────────────────────────────────────────────────────────

/// `createCycleCountSchema` (`.passthrough()`).
fn cycle_count_schema(issues: &mut Issues, body: &Body, _partial: bool) -> Body {
    issues.text_with(body, "warehouseId", Presence::Nullish, len(None, None));
    issues.text_with(body, "status", Presence::Optional, len(None, Some(30)));
    issues.text_with(body, "scheduledDate", Presence::Optional, len(None, None));
    issues.text_with(body, "countedBy", Presence::Optional, len(None, None));
    issues.text_with(body, "notes", Presence::Optional, len(None, None));
    body.clone()
}

pub(crate) static CYCLE_COUNTS: Crud = Crud {
    table: &crate::tables::CYCLE_COUNTS,
    resource: "Cycle count",
    id_prefix: "cc",
    gates: Gates {
        read: "inventory:read",
        create: "inventory:create",
        update: "inventory:update",
        delete: "inventory:delete",
    },
    messages: Messages {
        list: "Failed to list cycle counts",
        fetch: "Failed to fetch cycle count",
        create: "Failed to create cycle count",
        update: "Failed to update cycle count",
        delete: "Failed to delete cycle count",
    },
    schema: cycle_count_schema,
    filters: |query| {
        vec![
            eq_slot(query, "warehouseId", cycle_counts::Column::WarehouseId),
            eq_slot(query, "status", cycle_counts::Column::Status),
        ]
    },
    live: true,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: spread_create,
    update: spread_update,
    created: (WMS_CYCLE_COUNT_CREATED, |id, data| {
        event_from(id, data, &["warehouseId", "status"])
    }),
    updated: (WMS_CYCLE_COUNT_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "warehouseId": existing_of(existing, "warehouseId"),
            "status": update_or_existing(data, existing, "status"),
        })
    }),
    deleted: (WMS_CYCLE_COUNT_DELETED, only_id),
};

// ── purchase orders ────────────────────────────────────────────────────────

/// `createPurchaseOrderSchema` (`.passthrough()`).
fn purchase_order_schema(issues: &mut Issues, body: &Body, _partial: bool) -> Body {
    issues.text_with(body, "poNumber", Presence::Optional, len(None, Some(100)));
    issues.text_with(body, "supplierId", Presence::Nullish, len(None, None));
    issues.text_with(body, "warehouseId", Presence::Nullish, len(None, None));
    issues.text_with(body, "status", Presence::Optional, len(None, Some(30)));
    issues.text_with(body, "orderDate", Presence::Optional, len(None, None));
    issues.text_with(body, "expectedDate", Presence::Optional, len(None, None));
    issues.string_or_number(body, "total", Presence::Optional);
    issues.text_with(body, "currency", Presence::Optional, len(None, Some(10)));
    issues.text_with(body, "notes", Presence::Optional, len(None, None));
    body.clone()
}

pub(crate) static PURCHASE_ORDERS: Crud = Crud {
    table: &crate::tables::PURCHASE_ORDERS,
    resource: "Purchase order",
    id_prefix: "po",
    gates: Gates {
        read: "purchase_orders:read",
        create: "purchase_orders:create",
        update: "purchase_orders:update",
        delete: "purchase_orders:delete",
    },
    messages: Messages {
        list: "Failed to list purchase orders",
        fetch: "Failed to fetch purchase order",
        create: "Failed to create purchase order",
        update: "Failed to update purchase order",
        delete: "Failed to delete purchase order",
    },
    schema: purchase_order_schema,
    filters: |query| {
        vec![
            eq_slot(query, "supplierId", purchase_orders::Column::SupplierId),
            eq_slot(query, "warehouseId", purchase_orders::Column::WarehouseId),
            eq_slot(query, "status", purchase_orders::Column::Status),
            search_slot(query, &[purchase_orders::Column::PoNumber]),
        ]
    },
    live: true,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: spread_create,
    update: spread_update,
    created: (PURCHASE_ORDER_CREATED, |id, data| {
        event_from(id, data, &["poNumber", "status", "supplierId"])
    }),
    updated: (PURCHASE_ORDER_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "poNumber": update_or_existing(data, existing, "poNumber"),
            "status": update_or_existing(data, existing, "status"),
            "supplierId": update_or_existing(data, existing, "supplierId"),
        })
    }),
    deleted: (PURCHASE_ORDER_DELETED, only_id),
};

// ── inventory movements ────────────────────────────────────────────────────

/// `createInventoryMovementSchema` (`.passthrough()`).
fn movement_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    issues.text_with(body, "productId", Presence::Nullish, len(None, None));
    issues.text_with(body, "warehouseId", Presence::Nullish, len(None, None));
    issues.text_with(body, "type", Presence::Optional, len(None, Some(30)));
    issues.whole_number(
        body,
        "quantity",
        required(partial),
        weldsuite_kit::validation::Number::default(),
    );
    issues.text_with(body, "reference", Presence::Optional, len(None, Some(255)));
    issues.text_with(body, "notes", Presence::Optional, len(None, None));
    body.clone()
}

pub(crate) static INVENTORY_MOVEMENTS: Crud = Crud {
    table: &crate::tables::INVENTORY_MOVEMENTS,
    resource: "Inventory movement",
    id_prefix: "imv",
    gates: Gates {
        read: "inventory:read",
        create: "inventory:create",
        update: "inventory:update",
        delete: "inventory:delete",
    },
    messages: Messages {
        list: "Failed to list inventory movements",
        fetch: "Failed to fetch inventory movement",
        create: "Failed to create inventory movement",
        update: "Failed to update inventory movement",
        delete: "Failed to delete inventory movement",
    },
    schema: movement_schema,
    filters: |query| {
        use inventory_movements::Column;
        vec![
            eq_slot(query, "productId", Column::ProductId),
            query_set(query, "warehouseId").map(|warehouse| {
                Condition::any()
                    .add(Column::SourceWarehouseId.eq(warehouse.as_str()))
                    .add(Column::DestWarehouseId.eq(warehouse.as_str()))
            }),
        ]
    },
    live: false,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: spread_create,
    update: spread_update,
    created: (WMS_INVENTORY_MOVEMENT_CREATED, |id, data| {
        event_from(id, data, &["productId", "movementType", "quantity"])
    }),
    updated: (WMS_INVENTORY_MOVEMENT_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "productId": existing_of(existing, "productId"),
            "movementType": update_or_existing(data, existing, "movementType"),
            "quantity": update_or_existing(data, existing, "quantity"),
        })
    }),
    deleted: (WMS_INVENTORY_MOVEMENT_DELETED, only_id),
};

// ── warehouse zones ────────────────────────────────────────────────────────

/// `createWarehouseZoneSchema` (strips unknown keys, fills its defaults);
/// `.partial().omit({ warehouseId })` for updates.
fn zone_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    let mut out = Map::new();
    if !partial {
        keep_text(
            issues,
            body,
            &mut out,
            "warehouseId",
            Presence::Required,
            len(Some(1), Some(30)),
        );
    }
    keep_text(
        issues,
        body,
        &mut out,
        "name",
        required(partial),
        len(Some(1), Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "code",
        Presence::Optional,
        len(None, Some(50)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "description",
        Presence::Optional,
        len(None, None),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "zoneType",
        Presence::Optional,
        len(None, Some(50)),
    );
    default(&mut out, partial, "zoneType", json!("storage"));
    let int = weldsuite_kit::validation::Number::default();
    issues.boolean(body, "isActive", Presence::Optional);
    keep(body, &mut out, "isActive");
    default(&mut out, partial, "isActive", json!(true));
    issues.whole_number(body, "priority", Presence::Optional, int);
    keep(body, &mut out, "priority");
    default(&mut out, partial, "priority", json!(0));
    issues.boolean(body, "temperatureControlled", Presence::Optional);
    keep(body, &mut out, "temperatureControlled");
    default(&mut out, partial, "temperatureControlled", json!(false));
    issues.whole_number(body, "minTemperature", Presence::Optional, int);
    keep(body, &mut out, "minTemperature");
    issues.whole_number(body, "maxTemperature", Presence::Optional, int);
    keep(body, &mut out, "maxTemperature");
    keep_text(
        issues,
        body,
        &mut out,
        "temperatureUnit",
        Presence::Optional,
        len(None, Some(5)),
    );
    default(&mut out, partial, "temperatureUnit", json!("C"));
    issues.whole_number(body, "pickingSequence", Presence::Optional, int);
    keep(body, &mut out, "pickingSequence");
    default(&mut out, partial, "pickingSequence", json!(0));
    record(issues, body, "metadata", Presence::Optional);
    keep(body, &mut out, "metadata");
    out
}

pub(crate) static WAREHOUSE_ZONES: Crud = Crud {
    table: &crate::tables::WAREHOUSE_ZONES,
    resource: "Warehouse zone",
    id_prefix: "zone",
    gates: Gates {
        read: "warehouses:read",
        create: "warehouses:create",
        update: "warehouses:update",
        delete: "warehouses:delete",
    },
    messages: Messages {
        list: "Failed to list warehouse zones",
        fetch: "Failed to fetch warehouse zone",
        create: "Failed to create warehouse zone",
        update: "Failed to update warehouse zone",
        delete: "Failed to delete warehouse zone",
    },
    schema: zone_schema,
    filters: |query| {
        use warehouse_zones::Column;
        vec![
            search_slot(query, &[Column::Name, Column::Code]),
            eq_slot(query, "warehouseId", Column::WarehouseId),
            eq_slot(query, "zoneType", Column::ZoneType),
            bool_slot(query, "isActive", Column::IsActive),
        ]
    },
    live: true,
    cursor: Cursor::Sequence,
    order: &[("picking_sequence", Order::Asc), ("id", Order::Asc)],
    create: |data, id, now| {
        let mut props = Map::new();
        props.insert("id".to_owned(), json!(id));
        props.extend(data.clone());
        props.insert("totalLocations".to_owned(), json!(0));
        props.insert("createdAt".to_owned(), json!(now));
        props.insert("updatedAt".to_owned(), json!(now));
        props
    },
    update: spread_update,
    created: (WAREHOUSE_ZONE_CREATED, |id, data| {
        event_from(id, data, &["name", "warehouseId"])
    }),
    updated: (WAREHOUSE_ZONE_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "name": update_or_existing(data, existing, "name"),
            "warehouseId": existing_of(existing, "warehouseId"),
        })
    }),
    deleted: (WAREHOUSE_ZONE_DELETED, only_id),
};

// ── warehouse locations ────────────────────────────────────────────────────

/// `createWarehouseLocationSchema` (strips unknown keys, fills its
/// defaults); `.partial().omit({ warehouseId })` for updates.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
fn location_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    let mut out = Map::new();
    let int = weldsuite_kit::validation::Number::default();
    let number = weldsuite_kit::validation::Number::default();
    if !partial {
        keep_text(
            issues,
            body,
            &mut out,
            "warehouseId",
            Presence::Required,
            len(Some(1), Some(30)),
        );
    }
    keep_text(
        issues,
        body,
        &mut out,
        "zoneId",
        Presence::Nullish,
        len(None, Some(30)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "name",
        required(partial),
        len(Some(1), Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "code",
        required(partial),
        len(Some(1), Some(50)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "barcode",
        Presence::Optional,
        len(None, Some(100)),
    );
    for key in ["aisle", "rack", "shelf", "bin"] {
        keep_text(
            issues,
            body,
            &mut out,
            key,
            Presence::Optional,
            len(None, Some(20)),
        );
    }
    issues.whole_number(body, "level", Presence::Optional, int);
    keep(body, &mut out, "level");
    keep_text(
        issues,
        body,
        &mut out,
        "locationType",
        Presence::Optional,
        len(None, Some(50)),
    );
    default(&mut out, partial, "locationType", json!("storage"));
    for key in ["length", "width", "height"] {
        issues.number(body, key, Presence::Optional, number);
        keep(body, &mut out, key);
    }
    keep_text(
        issues,
        body,
        &mut out,
        "dimensionUnit",
        Presence::Optional,
        len(None, Some(10)),
    );
    default(&mut out, partial, "dimensionUnit", json!("cm"));
    issues.number(body, "maxWeight", Presence::Optional, number);
    keep(body, &mut out, "maxWeight");
    keep_text(
        issues,
        body,
        &mut out,
        "weightUnit",
        Presence::Optional,
        len(None, Some(10)),
    );
    default(&mut out, partial, "weightUnit", json!("kg"));
    issues.whole_number(body, "maxItems", Presence::Optional, int);
    keep(body, &mut out, "maxItems");
    issues.boolean(body, "isActive", Presence::Optional);
    keep(body, &mut out, "isActive");
    default(&mut out, partial, "isActive", json!(true));
    issues.whole_number(body, "pickingSequence", Presence::Optional, int);
    keep(body, &mut out, "pickingSequence");
    default(&mut out, partial, "pickingSequence", json!(0));
    issues.boolean(body, "isPrimaryPick", Presence::Optional);
    keep(body, &mut out, "isPrimaryPick");
    default(&mut out, partial, "isPrimaryPick", json!(false));
    keep_text(
        issues,
        body,
        &mut out,
        "abcClass",
        Presence::Optional,
        len(None, Some(1)),
    );
    record(issues, body, "metadata", Presence::Optional);
    keep(body, &mut out, "metadata");
    out
}

/// The row `POST /api/warehouse-locations` writes.
fn location_create(data: &Body, id: &str, now: &str) -> Body {
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    props.extend(pick(
        data,
        &[
            "warehouseId",
            "zoneId",
            "name",
            "code",
            "barcode",
            "aisle",
            "rack",
            "shelf",
            "bin",
            "level",
        ],
    ));
    props.insert(
        "locationType".to_owned(),
        data.get("locationType")
            .cloned()
            .unwrap_or_else(|| json!("storage")),
    );
    for key in ["length", "width", "height"] {
        if let Some(value) = data.get(key) {
            props.insert(key.to_owned(), numeric_string(value));
        }
    }
    props.insert(
        "dimensionUnit".to_owned(),
        data.get("dimensionUnit")
            .cloned()
            .unwrap_or_else(|| json!("cm")),
    );
    if let Some(value) = data.get("maxWeight") {
        props.insert("maxWeight".to_owned(), numeric_string(value));
    }
    props.insert(
        "weightUnit".to_owned(),
        data.get("weightUnit")
            .cloned()
            .unwrap_or_else(|| json!("kg")),
    );
    props.extend(pick(data, &["maxItems"]));
    props.insert("currentItems".to_owned(), json!(0));
    props.insert(
        "isActive".to_owned(),
        data.get("isActive").cloned().unwrap_or(json!(true)),
    );
    props.insert("isEmpty".to_owned(), json!(true));
    props.insert("isBlocked".to_owned(), json!(false));
    props.insert(
        "pickingSequence".to_owned(),
        data.get("pickingSequence").cloned().unwrap_or(json!(0)),
    );
    props.insert(
        "isPrimaryPick".to_owned(),
        data.get("isPrimaryPick").cloned().unwrap_or(json!(false)),
    );
    props.extend(pick(data, &["abcClass", "metadata"]));
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    props
}

/// The change `PATCH /api/warehouse-locations/:id` writes.
fn location_update(data: &Body) -> Body {
    let mut props = pick(
        data,
        &[
            "zoneId",
            "name",
            "code",
            "barcode",
            "aisle",
            "rack",
            "shelf",
            "bin",
            "level",
            "locationType",
            "dimensionUnit",
            "weightUnit",
            "maxItems",
            "isActive",
            "pickingSequence",
            "isPrimaryPick",
            "abcClass",
            "metadata",
        ],
    );
    for key in ["length", "width", "height", "maxWeight"] {
        if let Some(value) = data.get(key) {
            props.insert(key.to_owned(), numeric_string(value));
        }
    }
    props
}

pub(crate) static WAREHOUSE_LOCATIONS: Crud = Crud {
    table: &crate::tables::WAREHOUSE_LOCATIONS,
    resource: "Warehouse location",
    id_prefix: "loc",
    gates: Gates {
        read: "locations:read",
        create: "locations:create",
        update: "locations:update",
        delete: "locations:delete",
    },
    messages: Messages {
        list: "Failed to list warehouse locations",
        fetch: "Failed to fetch warehouse location",
        create: "Failed to create warehouse location",
        update: "Failed to update warehouse location",
        delete: "Failed to delete warehouse location",
    },
    schema: location_schema,
    filters: |query| {
        use warehouse_locations::Column;
        vec![
            search_slot(query, &[Column::Name, Column::Code, Column::Barcode]),
            eq_slot(query, "warehouseId", Column::WarehouseId),
            eq_slot(query, "zoneId", Column::ZoneId),
            eq_slot(query, "locationType", Column::LocationType),
            bool_slot(query, "isActive", Column::IsActive),
            bool_slot(query, "isEmpty", Column::IsEmpty),
            bool_slot(query, "isBlocked", Column::IsBlocked),
            eq_slot(query, "abcClass", Column::AbcClass),
            eq_slot(query, "barcode", Column::Barcode),
        ]
    },
    live: true,
    cursor: Cursor::Sequence,
    order: &[("picking_sequence", Order::Asc), ("code", Order::Asc)],
    create: location_create,
    update: location_update,
    created: (WMS_LOCATION_CREATED, |id, data| {
        event_from(id, data, &["name", "code", "warehouseId"])
    }),
    updated: (WMS_LOCATION_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "name": update_or_existing(data, existing, "name"),
            "code": update_or_existing(data, existing, "code"),
            "warehouseId": existing_of(existing, "warehouseId"),
        })
    }),
    deleted: (WMS_LOCATION_DELETED, only_id),
};

// ── suppliers ──────────────────────────────────────────────────────────────

/// `createWmsSupplierSchema` (strips unknown keys, fills its defaults);
/// `.partial()` for updates.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
fn supplier_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    let mut out = Map::new();
    let int = weldsuite_kit::validation::Number::default();
    keep_text(
        issues,
        body,
        &mut out,
        "name",
        required(partial),
        len(Some(1), Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "code",
        Presence::Optional,
        len(None, Some(50)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "description",
        Presence::Optional,
        len(None, None),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "contactName",
        Presence::Optional,
        len(None, Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "email",
        Presence::Optional,
        Text {
            format: Some(weldsuite_kit::validation::Format::Email),
            ..len(None, Some(255))
        },
    );
    keep_text(
        issues,
        body,
        &mut out,
        "phone",
        Presence::Optional,
        len(None, Some(50)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "website",
        Presence::Optional,
        len(None, Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "addressLine1",
        Presence::Optional,
        len(None, Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "addressLine2",
        Presence::Optional,
        len(None, Some(255)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "city",
        Presence::Optional,
        len(None, Some(100)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "state",
        Presence::Optional,
        len(None, Some(100)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "postalCode",
        Presence::Optional,
        len(None, Some(20)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "country",
        Presence::Optional,
        len(None, Some(100)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "paymentTerms",
        Presence::Optional,
        len(None, Some(100)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "currency",
        Presence::Optional,
        len(None, Some(3)),
    );
    default(&mut out, partial, "currency", json!("USD"));
    keep_text(
        issues,
        body,
        &mut out,
        "taxId",
        Presence::Nullish,
        len(None, Some(50)),
    );
    issues.whole_number(body, "defaultLeadTimeDays", Presence::Optional, int);
    keep(body, &mut out, "defaultLeadTimeDays");
    issues.boolean(body, "isActive", Presence::Optional);
    keep(body, &mut out, "isActive");
    default(&mut out, partial, "isActive", json!(true));
    issues.whole_number(
        body,
        "rating",
        Presence::Optional,
        weldsuite_kit::validation::Number {
            min: Some(1.0),
            max: Some(5.0),
            ..int
        },
    );
    keep(body, &mut out, "rating");
    keep_text(
        issues,
        body,
        &mut out,
        "notes",
        Presence::Optional,
        len(None, None),
    );
    record(issues, body, "metadata", Presence::Optional);
    keep(body, &mut out, "metadata");
    issues.list(
        body,
        "tags",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, len(None, None)),
    );
    keep(body, &mut out, "tags");
    out
}

/// The row `POST /api/wms-suppliers` writes.
fn supplier_create(data: &Body, id: &str, now: &str) -> Body {
    let is_active = data
        .get("isActive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    props.extend(pick(
        data,
        &[
            "name",
            "code",
            "description",
            "contactName",
            "email",
            "phone",
            "website",
            "addressLine1",
            "addressLine2",
            "city",
            "state",
            "postalCode",
            "country",
            "paymentTerms",
        ],
    ));
    props.insert(
        "currency".to_owned(),
        data.get("currency").cloned().unwrap_or(json!("USD")),
    );
    props.extend(pick(data, &["taxId", "defaultLeadTimeDays"]));
    props.insert("isActive".to_owned(), json!(is_active));
    props.insert(
        "status".to_owned(),
        json!(if is_active { "active" } else { "inactive" }),
    );
    props.extend(pick(data, &["rating", "notes", "metadata", "tags"]));
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    props
}

/// The change `PATCH /api/wms-suppliers/:id` writes.
fn supplier_update(data: &Body) -> Body {
    let mut props = data.clone();
    if let Some(active) = data.get("isActive") {
        let active = active.as_bool().unwrap_or(false);
        props.insert(
            "status".to_owned(),
            json!(if active { "active" } else { "inactive" }),
        );
    }
    props
}

/// `q.status === 'active'` / `'inactive'`: the only statuses the list filters by.
fn supplier_status_slot(query: Option<&str>) -> Option<Condition> {
    let status =
        query_param(query, "status").filter(|status| status == "active" || status == "inactive")?;
    Some(Condition::all().add(suppliers::Column::Status.eq(status)))
}

pub(crate) static SUPPLIERS: Crud = Crud {
    table: &crate::tables::SUPPLIERS,
    resource: "Supplier",
    id_prefix: "sup",
    gates: Gates {
        read: "suppliers:read",
        create: "suppliers:create",
        update: "suppliers:update",
        delete: "suppliers:delete",
    },
    messages: Messages {
        list: "Failed to list suppliers",
        fetch: "Failed to fetch supplier",
        create: "Failed to create supplier",
        update: "Failed to update supplier",
        delete: "Failed to delete supplier",
    },
    schema: supplier_schema,
    filters: |query| {
        use suppliers::Column;
        vec![
            search_slot(query, &[Column::Name, Column::Code, Column::Email]),
            supplier_status_slot(query),
            bool_slot(query, "isActive", Column::IsActive),
        ]
    },
    live: true,
    cursor: Cursor::Created,
    order: NEWEST_FIRST,
    create: supplier_create,
    update: supplier_update,
    created: (SUPPLIER_CREATED, |id, data| event_from(id, data, &["name"])),
    updated: (
        SUPPLIER_UPDATED,
        |id, data, existing| json!({ "id": id, "name": update_or_existing(data, existing, "name") }),
    ),
    deleted: (
        SUPPLIER_DELETED,
        |id, existing| json!({ "id": id, "name": existing_of(existing, "name") }),
    ),
};
