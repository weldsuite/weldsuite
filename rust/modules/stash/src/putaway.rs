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
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    PUTAWAY_COMPLETED, PUTAWAY_CREATED, PUTAWAY_DELETED, PUTAWAY_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    INVENTORY_CREATE, INVENTORY_DELETE, INVENTORY_READ, INVENTORY_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    inventory, inventory_movements as movements, products, warehouse_locations,
};

use crate::args::{CursorRow, before, cursor_row, page_body};
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

/// `putawaySelection`: the task with its product's name and SKU and its
/// destination location's code.
#[derive(Debug, FromQueryResult)]
struct Task {
    id: String,
    movement_number: String,
    product_id: String,
    product_name: Option<String>,
    product_sku: Option<String>,
    quantity: i32,
    source_location_id: Option<String>,
    dest_location_id: Option<String>,
    dest_location_code: Option<String>,
    status: String,
    priority: Option<String>,
    assigned_to: Option<String>,
    assigned_to_name: Option<String>,
    notes: Option<String>,
    created_at: PrimitiveDateTime,
    completed_at: Option<PrimitiveDateTime>,
}

impl Task {
    /// The selection as JSON, `Date`s as `toISOString()`.
    fn json(self) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("id".to_owned(), json!(self.id));
        row.insert("movementNumber".to_owned(), json!(self.movement_number));
        row.insert("productId".to_owned(), json!(self.product_id));
        row.insert("productName".to_owned(), json!(self.product_name));
        row.insert("productSku".to_owned(), json!(self.product_sku));
        row.insert("quantity".to_owned(), json!(self.quantity));
        row.insert("sourceLocationId".to_owned(), json!(self.source_location_id));
        row.insert("destLocationId".to_owned(), json!(self.dest_location_id));
        row.insert("destLocationCode".to_owned(), json!(self.dest_location_code));
        row.insert("status".to_owned(), json!(self.status));
        row.insert("priority".to_owned(), json!(self.priority));
        row.insert("assignedTo".to_owned(), json!(self.assigned_to));
        row.insert("assignedToName".to_owned(), json!(self.assigned_to_name));
        row.insert("notes".to_owned(), json!(self.notes));
        row.insert("createdAt".to_owned(), js_stamp(Some(self.created_at)));
        row.insert("completedAt".to_owned(), js_stamp(self.completed_at));
        row
    }
}

/// The detail: `putawaySelection` with `sourceType`, `sourceId` and
/// `startedAt`.
#[derive(Debug, FromQueryResult)]
struct TaskDetail {
    #[sea_orm(nested)]
    task: Task,
    source_type: Option<String>,
    source_id: Option<String>,
    started_at: Option<PrimitiveDateTime>,
}

impl TaskDetail {
    fn json(self) -> Value {
        let mut row = self.task.json();
        row.insert("sourceType".to_owned(), json!(self.source_type));
        row.insert("sourceId".to_owned(), json!(self.source_id));
        row.insert("startedAt".to_owned(), js_stamp(self.started_at));
        Value::Object(row)
    }
}

/// A `timestamp` as `toISOString()`, as the entities write it.
fn js_stamp(at: Option<PrimitiveDateTime>) -> Value {
    weldsuite_schema::js::timestamp::option::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

/// `leftJoin(products, eq(t.productId, products.id))`.
fn product() -> RelationDef {
    movements::Entity::belongs_to(products::Entity)
        .from(movements::Column::ProductId)
        .to(products::Column::Id)
        .into()
}

/// `leftJoin(warehouseLocations, eq(t.destLocationId, warehouseLocations.id))`.
fn dest_location() -> RelationDef {
    movements::Entity::belongs_to(warehouse_locations::Entity)
        .from(movements::Column::DestLocationId)
        .to(warehouse_locations::Column::Id)
        .into()
}

/// `select(putawaySelection)` with its joins.
fn selection() -> Select<movements::Entity> {
    movements::Entity::find()
        .select_only()
        .columns([
            movements::Column::Id,
            movements::Column::MovementNumber,
            movements::Column::ProductId,
        ])
        .column_as(products::Column::Name, "product_name")
        .column_as(products::Column::Sku, "product_sku")
        .columns([
            movements::Column::Quantity,
            movements::Column::SourceLocationId,
            movements::Column::DestLocationId,
        ])
        .column_as(warehouse_locations::Column::Code, "dest_location_code")
        .columns([
            movements::Column::Status,
            movements::Column::Priority,
            movements::Column::AssignedTo,
            movements::Column::AssignedToName,
            movements::Column::Notes,
            movements::Column::CreatedAt,
            movements::Column::CompletedAt,
        ])
        .join(JoinType::LeftJoin, product())
        .join(JoinType::LeftJoin, dest_location())
}

/// `eq(t.movementType, 'putaway')`.
fn putaway() -> Condition {
    Condition::all().add(movements::Column::MovementType.eq("putaway"))
}

/// A filter that is set and not `all`.
fn set_not_all(query: Option<&str>, name: &str) -> Option<String> {
    query_set(query, name).filter(|value| value != "all")
}

/// The list's conditions: putaway rows, `like(movementNumber | notes,
/// %search%)`, the status (cancelled ones hidden without one), the
/// warehouse, the assignee and the priority.
fn filters(query: Option<&str>) -> Condition {
    let mut condition = putaway();
    if let Some(search) = query_set(query, "search") {
        let pattern = format!("%{search}%");
        condition = condition.add(
            Condition::any()
                .add(movements::Column::MovementNumber.like(pattern.as_str()))
                .add(movements::Column::Notes.like(pattern.as_str())),
        );
    }
    let status = query_set(query, "status");
    if let Some(status) = status.as_deref().filter(|status| *status != "all") {
        condition = condition.add(movements::Column::Status.eq(status));
    }
    if status.is_none() {
        condition = condition.add(movements::Column::Status.ne("cancelled"));
    }
    if let Some(warehouse) = set_not_all(query, "warehouseId") {
        condition = condition.add(movements::Column::DestWarehouseId.eq(warehouse));
    }
    if let Some(assigned) = query_set(query, "assignedTo") {
        condition = condition.add(movements::Column::AssignedTo.eq(assigned));
    }
    if let Some(priority) = set_not_all(query, "priority") {
        condition = condition.add(movements::Column::Priority.eq(priority));
    }
    condition
}

/// The status counts of every putaway task.
#[derive(Debug, FromQueryResult)]
struct Counts {
    total: i64,
    pending: i64,
    in_progress: i64,
    completed: i64,
    cancelled: i64,
}

/// The page (`limit + 1` tasks, newest first, after the cursor), the
/// number of tasks the filters match and the status counts, in that order.
async fn page(
    db: &PgPool,
    query: Option<&str>,
    cursor: Option<CursorRow>,
    limit: f64,
) -> Result<(Vec<Value>, i64, Value), DbErr> {
    let db = orm(db);
    let mut rows = selection().filter(filters(query));
    if let Some(cursor) = &cursor {
        rows = rows.filter(before(
            movements::Column::CreatedAt,
            movements::Column::Id,
            cursor,
        ));
    }
    let rows = rows
        .order_by(movements::Column::CreatedAt, Order::Desc)
        .order_by(movements::Column::Id, Order::Desc)
        .limit(sql_limit(limit).and_then(|limit| u64::try_from(limit).ok()))
        .into_model::<Task>()
        .all(&db)
        .await?
        .into_iter()
        .map(|task| Value::Object(task.json()))
        .collect();
    let total = movements::Entity::find()
        .filter(filters(query))
        .count(&db)
        .await?;
    // `count(*) filter (where status = …)`: the rows the case keeps (it is
    // null otherwise).
    let count = |status: &str| {
        Expr::from(Func::count(Expr::case(
            movements::Column::Status.eq(status),
            1,
        )))
    };
    let counts = movements::Entity::find()
        .select_only()
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total")
        .column_as(count("pending"), "pending")
        .column_as(count("in_progress"), "in_progress")
        .column_as(count("completed"), "completed")
        .column_as(count("cancelled"), "cancelled")
        .filter(putaway())
        .into_model::<Counts>()
        .one(&db)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("putaway counts".to_owned()))?;
    let counts = json!({
        "total": counts.total,
        "pending": counts.pending,
        "in_progress": counts.in_progress,
        "completed": counts.completed,
        "cancelled": counts.cancelled,
    });
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX), counts))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    // The cursor lookup runs before the route's `try`: a failure is the
    // app's 500.
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => match cursor_row::<movements::Entity>(
            &caller.db,
            movements::Column::CreatedAt,
            movements::Column::Id,
            &cursor,
        )
        .await
        {
            Ok(cursor) => cursor,
            Err(error) => return cursor_failed(&error),
        },
        None => None,
    };
    match page(&caller.db, query, cursor, limit).await {
        Ok((rows, total, counts)) => page_body(rows, limit, total, "counts", counts),
        Err(error) => internal(&error, "Failed to fetch putaway tasks"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let row = selection()
        .columns([movements::Column::SourceType, movements::Column::SourceId])
        .column(movements::Column::StartedAt)
        .filter(movements::Column::Id.eq(&id))
        .filter(putaway())
        .into_model::<TaskDetail>()
        .one(&orm(&caller.db))
        .await
        .map(|row| row.map(TaskDetail::json));
    match row {
        Ok(Some(row)) => Data(row).into_response(),
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
    let now = utc_now();
    let updated = movements::Entity::update_many()
        .col_expr(movements::Column::Status, Expr::value("in_progress"))
        .col_expr(movements::Column::StartedAt, Expr::value(now))
        .col_expr(movements::Column::UpdatedAt, Expr::value(now))
        .filter(movements::Column::Id.eq(&id))
        .filter(putaway())
        .filter(movements::Column::Status.ne("cancelled"))
        .exec(&orm(&caller.db))
        .await;
    match updated {
        Ok(done) if done.rows_affected > 0 => {}
        Ok(_) => {
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
    let conn = orm(db);
    let task: Option<(Option<String>, String, Option<String>, i32)> = movements::Entity::find()
        .select_only()
        .columns([
            movements::Column::DestWarehouseId,
            movements::Column::ProductId,
            movements::Column::MovementNumber,
            movements::Column::Quantity,
        ])
        .filter(movements::Column::Id.eq(id))
        .filter(putaway())
        .filter(movements::Column::Status.ne("cancelled"))
        .into_tuple()
        .one(&conn)
        .await?;
    let Some((warehouse, product_id, movement_number, task_quantity)) = task else {
        return Err(Refusal::not_found("Putaway Task", id));
    };
    let Some(warehouse) = warehouse.filter(|warehouse| !warehouse.is_empty()) else {
        return Err(Refusal::bad_request(
            "Putaway task has no destination warehouse",
        ));
    };
    // A warehouse another system owns takes no stock from here (ADR STASH-010).
    if crate::ledger::warehouse_is_managed(db, &warehouse).await? {
        return Err(Refusal::Response(Box::new(crate::inventory::ledger_error(
            crate::ledger::managed_warehouse(),
            "Failed to complete putaway task",
        ))));
    }
    let at = OffsetDateTime::now_utc();
    let (now, stamp) = (iso_timestamp(at), utc_timestamp(at));
    let quantity = quantity.unwrap_or_else(|| i64::from(task_quantity));
    let existing: Option<(String, Option<i32>, Option<i32>)> = inventory::Entity::find()
        .select_only()
        .columns([
            inventory::Column::Id,
            inventory::Column::QuantityOnHand,
            inventory::Column::QuantityAllocated,
        ])
        .filter(inventory::Column::WarehouseId.eq(&warehouse))
        .filter(inventory::Column::ProductId.eq(&product_id))
        .filter(inventory::Column::LocationId.eq(location_id))
        .filter(inventory::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let (previous, new) = if let Some((bucket, on_hand, allocated)) = existing {
        let previous = i64::from(on_hand.unwrap_or(0));
        let new = previous + quantity;
        inventory::Entity::update_many()
            .col_expr(inventory::Column::QuantityOnHand, Expr::value(new))
            .col_expr(
                inventory::Column::QuantityAvailable,
                Expr::value(new - i64::from(allocated.unwrap_or(0))),
            )
            .col_expr(inventory::Column::UpdatedAt, Expr::value(stamp))
            .filter(inventory::Column::Id.eq(&bucket))
            .exec(&conn)
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
    movements::Entity::update_many()
        .col_expr(movements::Column::DestLocationId, Expr::value(location_id))
        .col_expr(movements::Column::Status, Expr::value("completed"))
        .col_expr(movements::Column::CompletedAt, Expr::value(stamp))
        .col_expr(movements::Column::CompletedBy, Expr::value(caller.user_id.as_str()))
        .col_expr(movements::Column::UpdatedAt, Expr::value(stamp))
        .filter(movements::Column::Id.eq(id))
        .exec(&conn)
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
    let mut update = movements::Entity::update_many();
    if !to.is_absent() {
        update = update.col_expr(
            movements::Column::AssignedTo,
            Expr::value(to.as_set().cloned()),
        );
    }
    if !name.is_absent() {
        update = update.col_expr(
            movements::Column::AssignedToName,
            Expr::value(name.as_set().cloned()),
        );
    }
    let updated = update
        .col_expr(movements::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(movements::Column::Id.eq(&id))
        .filter(putaway())
        .filter(movements::Column::Status.ne("cancelled"))
        .exec(&orm(&caller.db))
        .await;
    match updated {
        Ok(done) if done.rows_affected > 0 => {}
        Ok(_) => return Refusal::not_found("Putaway Task", &id).respond(message),
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
    let updated = movements::Entity::update_many()
        .col_expr(movements::Column::Status, Expr::value("cancelled"))
        .col_expr(movements::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(movements::Column::Id.eq(&id))
        .filter(putaway())
        .exec(&orm(&caller.db))
        .await;
    match updated {
        Ok(done) if done.rows_affected > 0 => {}
        Ok(_) => {
            return Refusal::not_found("Putaway Task", &id)
                .respond("Failed to cancel putaway task");
        }
        Err(error) => return internal(&error, "Failed to cancel putaway task"),
    }
    caller.publish(&state, PUTAWAY_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
