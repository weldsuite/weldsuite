//! `/api/putaway`: putaway tasks, the `inventory_movements` rows of type
//! `putaway` (list with status counts, detail, create, start, complete,
//! assign, cancel). Completing a task lands its stock at the chosen
//! location, with an audit row; cancelled rows are the deleted ones.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PUTAWAY_COMPLETED, PUTAWAY_CREATED, PUTAWAY_DELETED, PUTAWAY_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    INVENTORY_CREATE, INVENTORY_DELETE, INVENTORY_READ, INVENTORY_UPDATE,
};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_body};
use crate::crud::cursor_failed;
use crate::js::{js_limit, query_param, query_set, sql_limit, time_number};
use crate::tables::{INVENTORY, INVENTORY_MOVEMENTS, STOCK_ADJUSTMENTS};
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([INVENTORY_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(gate.require([INVENTORY_READ])))
        .route(
            "/",
            post(create).route_layer(gate.require([INVENTORY_CREATE])),
        )
        .route(
            "/{id}",
            get(detail).route_layer(gate.require([INVENTORY_READ])),
        )
        .route(
            "/{id}",
            axum::routing::delete(cancel).route_layer(gate.require([INVENTORY_DELETE])),
        )
        .route("/{id}/start", patch(start).route_layer(update()))
        .route("/{id}/complete", patch(complete).route_layer(update()))
        .route("/{id}/assign", patch(assign).route_layer(update()))
}

/// `putawaySelection` as JSON (timestamps fixed up by [`task`]).
macro_rules! selection {
    () => {
        "jsonb_build_object('id', t.id, 'movementNumber', t.movement_number, 'productId', t.product_id, \
         'productName', p.name, 'productSku', p.sku, 'quantity', t.quantity, \
         'sourceLocationId', t.source_location_id, 'destLocationId', t.dest_location_id, \
         'destLocationCode', l.code, 'status', t.status, 'priority', t.priority, \
         'assignedTo', t.assigned_to, 'assignedToName', t.assigned_to_name, 'notes', t.notes, \
         'createdAt', t.created_at, 'completedAt', t.completed_at"
    };
}

/// A selected task, its `Date`s as `toISOString()`.
fn task(mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        for key in ["createdAt", "completedAt", "startedAt"] {
            if let Some(Value::String(stamp)) = fields.get(key)
                && let Some(js) = weldsuite_db::js_timestamp(stamp)
            {
                fields.insert(key.to_owned(), Value::String(js));
            }
        }
    }
    row
}

macro_rules! filters {
    () => {
        "t.movement_type = 'putaway' and (not $1::boolean or (t.movement_number like $2 or t.notes like $2)) \
         and (not $3::boolean or t.status = $4) and (not $5::boolean or t.status <> 'cancelled') \
         and (not $6::boolean or t.dest_warehouse_id = $7) and (not $8::boolean or t.assigned_to = $9) \
         and (not $10::boolean or t.priority = $11)"
    };
}

const LIST_SQL: &str = concat!(
    "select ",
    selection!(),
    ") from inventory_movements t left join products p on t.product_id = p.id ",
    "left join warehouse_locations l on t.dest_location_id = l.id where ",
    filters!(),
    " and (not $12::boolean or (t.created_at < $13::timestamp or (t.created_at = $13::timestamp and t.id < $14))) ",
    "order by t.created_at desc, t.id desc limit $15"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from inventory_movements t where ",
    filters!()
);

const COUNTS_SQL: &str = "select jsonb_build_object('total', count(*)::int, \
    'pending', count(*) filter (where t.status = 'pending')::int, \
    'in_progress', count(*) filter (where t.status = 'in_progress')::int, \
    'completed', count(*) filter (where t.status = 'completed')::int, \
    'cancelled', count(*) filter (where t.status = 'cancelled')::int) \
    from inventory_movements t where t.movement_type = 'putaway'";

/// A filter that is set and not `all`.
fn set_not_all(query: Option<&str>, name: &str) -> Option<String> {
    query_set(query, name).filter(|value| value != "all")
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let search = query_set(query, "search").map(|search| format!("%{search}%"));
    let status = query_set(query, "status");
    let by_status = status.clone().filter(|status| status != "all");
    let hide_cancelled = status.is_none();
    let warehouse = set_not_all(query, "warehouseId");
    let assigned = query_set(query, "assignedTo");
    let priority = set_not_all(query, "priority");
    let filters = vec![
        Arg::Bool(search.is_some()),
        Arg::Text(search),
        Arg::Bool(by_status.is_some()),
        Arg::Text(by_status),
        Arg::Bool(hide_cancelled),
        Arg::Bool(warehouse.is_some()),
        Arg::Text(warehouse),
        Arg::Bool(assigned.is_some()),
        Arg::Text(assigned),
        Arg::Bool(priority.is_some()),
        Arg::Text(priority),
    ];
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("inventory_movements"), &cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let mut page = filters.clone();
    page.push(Arg::Bool(cursor.is_some()));
    page.push(Arg::opt(cursor.as_ref().map(|(at, _)| at.as_str())));
    page.push(Arg::opt(cursor.as_ref().map(|(_, id)| id.as_str())));
    page.push(Arg::Int(sql_limit(limit)));
    let message = "Failed to fetch putaway tasks";
    let rows: Vec<Value> = match bind_scalar(sqlx::query_scalar(LIST_SQL), page)
        .fetch_all(&caller.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return internal(&error, message),
    };
    let total: i64 = match bind_scalar(sqlx::query_scalar(COUNT_SQL), filters)
        .fetch_one(&caller.db)
        .await
    {
        Ok(total) => total,
        Err(error) => return internal(&error, message),
    };
    let counts: Value = match sqlx::query_scalar(COUNTS_SQL).fetch_one(&caller.db).await {
        Ok(counts) => counts,
        Err(error) => return internal(&error, message),
    };
    page_body(
        rows.into_iter().map(task).collect(),
        limit,
        total,
        "counts",
        counts,
    )
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let row: Result<Option<Value>, _> = sqlx::query_scalar(concat!(
        "select ", selection!(), ", 'sourceType', t.source_type, 'sourceId', t.source_id, ",
        "'startedAt', t.started_at) from inventory_movements t left join products p on t.product_id = p.id ",
        "left join warehouse_locations l on t.dest_location_id = l.id ",
        "where t.id = $1 and t.movement_type = 'putaway' limit 1"
    ))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => Data(task(row)).into_response(),
        Ok(None) => Refusal::not_found("Putaway Task", &id).respond("Failed to fetch putaway task"),
        Err(error) => internal(&error, "Failed to fetch putaway task"),
    }
}

/// `createPutawaySchema`: the parsed body (`priority` defaults to `normal`).
fn create_schema(issues: &mut Issues, body: &Body) -> Body {
    let mut out = Map::new();
    let keep = |out: &mut Body, key: &str, field: Field<String>| {
        if let Field::Set(text) = field {
            out.insert(key.to_owned(), Value::String(text));
        }
    };
    let field = issues.text_with(
        body,
        "warehouseId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    keep(&mut out, "warehouseId", field);
    let field = issues.text_with(
        body,
        "productId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    keep(&mut out, "productId", field);
    if let Field::Set(quantity) = issues.whole_number(
        body,
        "quantity",
        Presence::Required,
        Number {
            min: Some(1.0),
            ..Number::default()
        },
    ) {
        out.insert("quantity".to_owned(), json!(quantity));
    }
    for key in ["sourceLocationId", "targetLocationId"] {
        let field = issues.text_with(body, key, Presence::Optional, Text::default());
        keep(&mut out, key, field);
    }
    let priority = issues.choice(
        body,
        "priority",
        Presence::Optional,
        &["low", "normal", "high", "urgent"],
    );
    out.insert(
        "priority".to_owned(),
        Value::String(
            priority
                .into_option()
                .unwrap_or_else(|| "normal".to_owned()),
        ),
    );
    for key in [
        "assignedTo",
        "assignedToName",
        "notes",
        "sourceType",
        "sourceId",
    ] {
        let field = issues.text_with(body, key, Presence::Optional, Text::default());
        keep(&mut out, key, field);
    }
    out
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, create_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create putaway task"),
    };
    let id = generate_id("put");
    let movement_number = time_number("PUT");
    let now = now();
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    props.insert("movementNumber".to_owned(), json!(movement_number));
    props.insert("movementType".to_owned(), json!("putaway"));
    let copy = |props: &mut Body, prop: &str, key: &str| {
        if let Some(value) = data.get(key) {
            props.insert(prop.to_owned(), value.clone());
        }
    };
    copy(&mut props, "productId", "productId");
    copy(&mut props, "quantity", "quantity");
    copy(&mut props, "sourceLocationId", "sourceLocationId");
    copy(&mut props, "destWarehouseId", "warehouseId");
    copy(&mut props, "destLocationId", "targetLocationId");
    props.insert("status".to_owned(), json!("pending"));
    for key in [
        "priority",
        "assignedTo",
        "assignedToName",
        "notes",
        "sourceType",
        "sourceId",
    ] {
        copy(&mut props, key, key);
    }
    props.insert("createdBy".to_owned(), json!(caller.user_id));
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    let mut values = Map::new();
    for (prop, value) in &props {
        INVENTORY_MOVEMENTS.set(&mut values, prop, value.clone());
    }
    if let Err(error) = INVENTORY_MOVEMENTS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return internal(&error, "Failed to create putaway task");
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("movementNumber".to_owned(), json!(movement_number));
    event.extend(data);
    caller.publish(&state, PUTAWAY_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id, "movementNumber": movement_number })).into_response()
}

async fn start(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let now = now();
    let updated: Result<Option<String>, _> = sqlx::query_scalar(
        "update inventory_movements set status = 'in_progress', started_at = $2::timestamp, \
         updated_at = $2::timestamp where id = $1 and movement_type = 'putaway' and status <> 'cancelled' \
         returning id",
    )
    .bind(&id)
    .bind(&now)
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Refusal::not_found("Putaway Task", &id).respond("Failed to start putaway task");
        }
        Err(error) => return internal(&error, "Failed to start putaway task"),
    }
    caller.publish(
        &state,
        PUTAWAY_UPDATED,
        &id,
        &json!({ "id": id, "status": "in_progress" }),
    );
    Data(json!({ "id": id, "status": "in_progress" })).into_response()
}

/// `completePutawaySchema`.
fn complete_schema(issues: &mut Issues, body: &Body) -> (String, Option<i64>) {
    let location = issues.text_with(
        body,
        "locationId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    let quantity = issues.whole_number(
        body,
        "quantity",
        Presence::Optional,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    (
        location.into_option().unwrap_or_default(),
        quantity.into_option(),
    )
}

async fn complete(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to complete putaway task";
    let (location_id, quantity) = match validate(&headers, &body, complete_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    match complete_task(&caller, &id, &location_id, quantity).await {
        Ok(()) => {}
        Err(refusal) => return refusal.respond(message),
    }
    caller.publish(
        &state,
        PUTAWAY_COMPLETED,
        &id,
        &json!({ "id": id, "status": "completed", "locationId": location_id }),
    );
    Data(json!({ "id": id, "status": "completed", "locationId": location_id })).into_response()
}

#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
async fn complete_task(
    caller: &Caller,
    id: &str,
    location_id: &str,
    quantity: Option<i64>,
) -> Result<(), Refusal> {
    let db = &caller.db;
    let task: Option<(Option<String>, String, Option<String>, i32)> = sqlx::query_as(
        "select dest_warehouse_id, product_id, movement_number, quantity from inventory_movements \
         where id = $1 and movement_type = 'putaway' and status <> 'cancelled' limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((warehouse, product_id, movement_number, task_quantity)) = task else {
        return Err(Refusal::not_found("Putaway Task", id));
    };
    let Some(warehouse) = warehouse.filter(|warehouse| !warehouse.is_empty()) else {
        return Err(Refusal::bad_request(
            "Putaway task has no destination warehouse",
        ));
    };
    let now = now();
    let quantity = quantity.unwrap_or_else(|| i64::from(task_quantity));
    let existing: Option<(String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "select id, quantity_on_hand, quantity_allocated from inventory where warehouse_id = $1 \
         and product_id = $2 and location_id = $3 and deleted_at is null limit 1",
    )
    .bind(&warehouse)
    .bind(&product_id)
    .bind(location_id)
    .fetch_optional(db)
    .await?;
    let (previous, new) = if let Some((bucket, on_hand, allocated)) = existing {
        let previous = i64::from(on_hand.unwrap_or(0));
        let new = previous + quantity;
        sqlx::query(
            "update inventory set quantity_on_hand = $2, quantity_available = $3, \
             updated_at = $4::timestamp where id = $1",
        )
        .bind(&bucket)
        .bind(new)
        .bind(new - i64::from(allocated.unwrap_or(0)))
        .bind(&now)
        .execute(db)
        .await?;
        (previous, new)
    } else {
        let row = json!({
            "id": generate_id("inv"),
            "warehouseId": warehouse,
            "locationId": location_id,
            "productId": product_id,
            "quantityOnHand": quantity,
            "quantityAllocated": 0,
            "quantityAvailable": quantity,
            "quantityIncoming": 0,
            "quantityOutgoing": 0,
            "status": "available",
            "isQuarantined": false,
            "qualityStatus": "passed",
            "currency": "USD",
            "receivedDate": now,
            "createdAt": now,
            "updatedAt": now,
        });
        INVENTORY
            .insert(
                db,
                values_of(&INVENTORY, &row),
                &["receivedDate", "createdAt", "updatedAt"],
            )
            .await?;
        (0, quantity)
    };
    let adjustment = json!({
        "id": generate_id("adj"),
        "productId": product_id,
        "warehouseId": warehouse,
        "locationId": location_id,
        "type": "increase",
        "previousQuantity": previous,
        "adjustmentQuantity": quantity,
        "newQuantity": new,
        "reason": format!("Putaway {}", movement_number.as_deref().unwrap_or("undefined")),
        "sourceType": "putaway",
        "sourceId": id,
        "performedBy": caller.user_id,
        "createdAt": now,
    });
    STOCK_ADJUSTMENTS
        .insert(
            db,
            values_of(&STOCK_ADJUSTMENTS, &adjustment),
            &["createdAt"],
        )
        .await?;
    sqlx::query(
        "update inventory_movements set dest_location_id = $2, status = 'completed', \
         completed_at = $3::timestamp, completed_by = $4, updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(location_id)
    .bind(&now)
    .bind(&caller.user_id)
    .execute(db)
    .await?;
    Ok(())
}

/// `{ prop: value }` as the table's `{ column: value }`.
pub(crate) fn values_of(table: &crate::table::Table, row: &Value) -> Map<String, Value> {
    let mut values = Map::new();
    if let Value::Object(props) = row {
        for (prop, value) in props {
            table.set(&mut values, prop, value.clone());
        }
    }
    values
}

/// `assignPutawaySchema`.
fn assign_schema(issues: &mut Issues, body: &Body) -> (Field<String>, Field<String>) {
    let to = issues.text_with(body, "assignedTo", Presence::Nullish, Text::default());
    let name = issues.text_with(body, "assignedToName", Presence::Nullish, Text::default());
    (to, name)
}

async fn assign(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to assign putaway task";
    let (to, name) = match validate(&headers, &body, assign_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let updated: Result<Option<String>, _> = sqlx::query_scalar(
        "update inventory_movements set \
         assigned_to = case when $2::boolean then $3 else assigned_to end, \
         assigned_to_name = case when $4::boolean then $5 else assigned_to_name end, \
         updated_at = $6::timestamp where id = $1 and movement_type = 'putaway' \
         and status <> 'cancelled' returning id",
    )
    .bind(&id)
    .bind(!to.is_absent())
    .bind(to.as_set())
    .bind(!name.is_absent())
    .bind(name.as_set())
    .bind(now())
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Putaway Task", &id).respond(message),
        Err(error) => return internal(&error, message),
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    if let Some(to) = to.as_set() {
        event.insert("assignedTo".to_owned(), json!(to));
    }
    if let Some(name) = name.as_set() {
        event.insert("assignedToName".to_owned(), json!(name));
    }
    caller.publish(&state, PUTAWAY_UPDATED, &id, &Value::Object(event));
    let mut answer = Map::new();
    answer.insert("id".to_owned(), json!(id));
    match to {
        Field::Set(to) => {
            answer.insert("assignedTo".to_owned(), json!(to));
        }
        Field::Null => {
            answer.insert("assignedTo".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    Data(Value::Object(answer)).into_response()
}

async fn cancel(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let updated: Result<Option<String>, _> = sqlx::query_scalar(
        "update inventory_movements set status = 'cancelled', updated_at = $2::timestamp \
         where id = $1 and movement_type = 'putaway' returning id",
    )
    .bind(&id)
    .bind(now())
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Refusal::not_found("Putaway Task", &id)
                .respond("Failed to cancel putaway task");
        }
        Err(error) => return internal(&error, "Failed to cancel putaway task"),
    }
    caller.publish(&state, PUTAWAY_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
