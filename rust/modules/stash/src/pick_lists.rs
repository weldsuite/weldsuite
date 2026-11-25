//! `/api/pick-lists`: list, create, generate from an order, assign, start,
//! scan-confirm a line, complete, pack, ship (recording the shipment; no
//! carrier is called), the packing slip, detail, patch and delete. The
//! work is [`crate::picking`]'s; stock moves through [`crate::ledger`].

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use sea_orm::sea_query::Order;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PARCEL_SHIPPED, PARCEL_UPDATED, PICKLIST_COMPLETED, PICKLIST_CREATED, PICKLIST_DELETED,
    PICKLIST_UPDATED, SHIPMENT_SHIPPED,
};
use weldsuite_catalogs::permission_keys::{
    PICKLISTS_CREATE, PICKLISTS_DELETE, PICKLISTS_READ, PICKLISTS_UPDATE,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::pick_lists::{Column, Entity};
use weldsuite_schema::tenant::{orders, warehouses};

use crate::args::{
    CursorRow, before, cursor_row, limit_plus_one, page_list, table_count, table_rows,
};
use crate::crud::{cursor_failed, soft_delete, write_failed};
use crate::js::{js_limit, query_param, query_set, text, time_number};
use crate::ledger::LedgerError;
use crate::picking::{self, Confirm, Generate, PickError};
use crate::tables::PICK_LISTS;
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PICKLISTS_READ]);
    let update = || gate.require([PICKLISTS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([PICKLISTS_CREATE])),
        )
        .route(
            "/generate",
            post(generate).route_layer(gate.require([PICKLISTS_CREATE])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_list).route_layer(update()))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([PICKLISTS_DELETE])),
        )
        .route("/{id}/packing-slip", get(packing_slip).route_layer(read()))
        .route("/{id}/assign", patch(assign).route_layer(update()))
        .route("/{id}/start", patch(start).route_layer(update()))
        .route("/{id}/complete", patch(complete).route_layer(update()))
        .route("/{id}/pack", post(pack).route_layer(update()))
        .route("/{id}/ship", post(ship).route_layer(update()))
        .route(
            "/{id}/items/{item_id}/pick",
            post(pick_item).route_layer(update()),
        )
}

/// `mapPickError`.
fn pick_error(error: PickError, fallback: &str) -> Response {
    match error {
        PickError::Pick { code, message } => {
            let label = match code {
                "ORDER_NOT_FOUND" => Some("Order"),
                "WAREHOUSE_NOT_FOUND" => Some("Warehouse"),
                "ITEM_NOT_FOUND" => Some("Pick list item"),
                _ => None,
            };
            if let Some(label) = label {
                return ApiError::not_found(label, None).into_response();
            }
            if matches!(
                code,
                "ALREADY_PICKING" | "APPROVAL_PENDING" | "APPROVAL_REJECTED"
            ) {
                return ApiError::conflict(message)
                    .with_details(json!({ "code": code }))
                    .into_response();
            }
            ApiError::bad_request(message)
                .with_details(json!({ "code": code }))
                .into_response()
        }
        PickError::Ledger(LedgerError::Stock { code, message }) => {
            if code == "PRODUCT_NOT_FOUND" {
                return ApiError::not_found("Product", None).into_response();
            }
            if ["INSUFFICIENT_STOCK", "INSUFFICIENT_AVAILABLE"].contains(&code) {
                return ApiError::conflict(message)
                    .with_details(json!({ "code": code }))
                    .into_response();
            }
            ApiError::bad_request(message)
                .with_details(json!({ "code": code }))
                .into_response()
        }
        error => internal(&error, fallback),
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => {
            match cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, &cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    match fetch(&caller.db, query, cursor.as_ref(), limit).await {
        Ok((rows, total)) => page_list(rows, limit, total),
        Err(error) => internal(&error, "Failed to list pick lists"),
    }
}

/// The page (live lists, the filters, the cursor) and the count (live
/// lists and the filters).
async fn fetch(
    db: &PgPool,
    query: Option<&str>,
    cursor: Option<&CursorRow>,
    limit: f64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    for (key, column) in [
        ("warehouseId", Column::WarehouseId),
        ("status", Column::Status),
        ("assignedTo", Column::AssignedTo),
    ] {
        if let Some(value) = query_set(query, key) {
            filters = filters.add(column.eq(value));
        }
    }
    let mut page = PICK_LISTS.entity.select();
    page.cond_where(filters.clone());
    if let Some(cursor) = cursor {
        page.cond_where(before(Column::CreatedAt, Column::Id, cursor));
    }
    page.order_by((Entity, Column::CreatedAt), Order::Desc)
        .order_by((Entity, Column::Id), Order::Desc);
    limit_plus_one(&mut page, limit);
    let mut counted = PICK_LISTS.entity.select();
    counted.cond_where(filters);
    let rows = table_rows(db, &PICK_LISTS, &page).await?;
    let total = table_count(db, &PICK_LISTS, &counted).await?;
    Ok((rows, total))
}

/// A string field into `out` (set or null).
fn keep_text(
    issues: &mut Issues,
    body: &Body,
    out: &mut Body,
    key: &str,
    presence: Presence,
    rules: Text,
) {
    match issues.text_with(body, key, presence, rules) {
        Field::Set(value) => {
            out.insert(key.to_owned(), Value::String(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `generatePickListSchema`.
fn generate_schema(issues: &mut Issues, body: &Body) -> Body {
    let mut out = Map::new();
    keep_text(
        issues,
        body,
        &mut out,
        "orderId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "warehouseId",
        Presence::Optional,
        Text::length(Some(1), None),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "assignedTo",
        Presence::Optional,
        Text::default(),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "assignedToName",
        Presence::Optional,
        Text::default(),
    );
    if let Field::Set(priority) = issues.choice(
        body,
        "priority",
        Presence::Optional,
        &["low", "normal", "high", "urgent"],
    ) {
        out.insert("priority".to_owned(), Value::String(priority));
    }
    out
}

async fn generate(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to generate pick list";
    let data = match validate(&headers, &body, generate_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(fallback),
    };
    let owned = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let params = Generate {
        order_id: owned("orderId").unwrap_or_default(),
        warehouse_id: owned("warehouseId"),
        assigned_to: owned("assignedTo"),
        assigned_to_name: owned("assignedToName"),
        priority: owned("priority"),
        created_by: caller.user_id.clone(),
    };
    match picking::generate(&caller.db, &params).await {
        Ok(result) => {
            let id = text(&result, "id").unwrap_or_default().to_owned();
            caller.publish(&state, PICKLIST_CREATED, &id, &result);
            Created(result).into_response()
        }
        Err(error) => pick_error(error, fallback),
    }
}

async fn packing_slip(caller: Caller, Path(id): Path<String>) -> Response {
    let fallback = "Failed to generate packing slip";
    let row = match picking::with_items(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => return internal(&error, fallback),
    };
    let warehouse = match warehouse_name(&caller.db, text(&row, "warehouseId")).await {
        Ok(warehouse) => warehouse,
        Err(error) => return internal(&error, fallback),
    };
    let mut order_number = None;
    if let Some(order_id) = picking::first_order_id(&row) {
        match order_number_of(&caller.db, &order_id).await {
            Ok(order) => order_number = order,
            Err(error) => return internal(&error, fallback),
        }
    }
    let number = text(&row, "pickListNumber").unwrap_or_default().to_owned();
    let items = row
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let html = picking::packing_slip(
        &number,
        order_number.as_deref(),
        warehouse.as_deref(),
        text(&row, "packedAt"),
        &items,
    );
    (
        [
            (CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
            (
                CONTENT_DISPOSITION,
                format!("inline; filename=\"{number}-packing-slip.html\""),
            ),
        ],
        html,
    )
        .into_response()
}

/// `select name from warehouses where id = …`: no warehouse id matches
/// nothing.
async fn warehouse_name(db: &PgPool, id: Option<&str>) -> Result<Option<String>, DbErr> {
    let Some(id) = id else {
        return Ok(None);
    };
    warehouses::Entity::find()
        .select_only()
        .column(warehouses::Column::Name)
        .filter(warehouses::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// The order's number.
async fn order_number_of(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    orders::Entity::find()
        .select_only()
        .column(orders::Column::OrderNumber)
        .filter(orders::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `assignPickListSchema`.
fn assign_schema(issues: &mut Issues, body: &Body) -> (Option<String>, Option<String>) {
    let to = issues.text_with(body, "assignedTo", Presence::Nullish, Text::default());
    let name = issues.text_with(body, "assignedToName", Presence::Nullish, Text::default());
    (to.into_option(), name.into_option())
}

async fn assign(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to assign pick list";
    let (to, name) = match validate(&headers, &body, assign_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(fallback),
    };
    match picking::assign(&caller.db, &id, to.as_deref(), name.as_deref()).await {
        Ok(Some(result)) => {
            caller.publish(&state, PICKLIST_UPDATED, &id, &result);
            Data(result).into_response()
        }
        Ok(None) => Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => pick_error(error, fallback),
    }
}

async fn start(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let fallback = "Failed to start pick list";
    match picking::start(&caller.db, &id).await {
        Ok(Some(result)) => {
            caller.publish(&state, PICKLIST_UPDATED, &id, &result);
            Data(result).into_response()
        }
        Ok(None) => Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => pick_error(error, fallback),
    }
}

async fn complete(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let fallback = "Failed to complete pick list";
    match picking::complete(&caller.db, &id, &caller.user_id).await {
        Ok(Some(result)) => {
            caller.publish(&state, PICKLIST_COMPLETED, &id, &result);
            Data(result).into_response()
        }
        Ok(None) => Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => pick_error(error, fallback),
    }
}

async fn pack(State(state): State<StashState>, caller: Caller, Path(id): Path<String>) -> Response {
    let fallback = "Failed to pack pick list";
    match picking::pack(&caller.db, &id, &caller.user_id).await {
        Ok(Some(result)) => {
            caller.publish(&state, PICKLIST_UPDATED, &id, &result);
            Data(result).into_response()
        }
        Ok(None) => Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => pick_error(error, fallback),
    }
}

/// Ship: as stash-api does, and (Rust only, ADR STASH-011) every labelled
/// piece of the pick list ships with it, publishes `parcel:shipped`, and the
/// workspace is marked due for tracking. Without labels the answer and the
/// events are stash-api's.
async fn ship(
    State(state): State<StashState>,
    ctx: crate::shipping::Ctx,
    Path(id): Path<String>,
) -> Response {
    let fallback = "Failed to ship pick list";
    let caller = &ctx.caller;
    let result = match picking::ship(&caller.db, &id, &caller.user_id).await {
        Ok(Some(result)) => result,
        Ok(None) => return Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => return pick_error(error, fallback),
    };
    let mut events = vec![(PICKLIST_UPDATED, id.clone(), result.clone())];
    if let Some(shipment) = crate::js::truthy(&result, "shipmentId") {
        events.push((SHIPMENT_SHIPPED, shipment.to_owned(), result.clone()));
    }
    if let Some(parcel) = crate::js::truthy(&result, "parcelId") {
        events.push((PARCEL_UPDATED, parcel.to_owned(), result.clone()));
    }
    match crate::shipping::labels::shipped_pieces(&caller.db, &id).await {
        Ok(pieces) => {
            for piece in &pieces {
                events.push((
                    PARCEL_SHIPPED,
                    piece.id.clone(),
                    crate::shipping::parcels::view(piece),
                ));
            }
            if let (Some(master), Some(first)) = (&ctx.master, pieces.first()) {
                crate::shipping::tracking::mark_due(master, &ctx.workspace_id, first).await;
            }
        }
        Err(error) => tracing::error!(%error, "[stash] reading the shipped pieces"),
    }
    caller.publish_in_order(&state, events);
    Data(result).into_response()
}

/// `pickItemSchema`.
fn pick_schema(issues: &mut Issues, body: &Body) -> (i64, Option<String>, String, bool) {
    let quantity = issues.whole_number(
        body,
        "quantity",
        Presence::Required,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    let location = issues.text_with(
        body,
        "locationBarcode",
        Presence::Optional,
        Text::length(Some(1), None),
    );
    let product = issues.text_with(
        body,
        "productBarcode",
        Presence::Required,
        Text::length(Some(1), None),
    );
    let short = issues.boolean(body, "short", Presence::Optional);
    (
        quantity.into_option().unwrap_or_default(),
        location.into_option(),
        product.into_option().unwrap_or_default(),
        short.into_option().unwrap_or(false),
    )
}

async fn pick_item(
    State(state): State<StashState>,
    caller: Caller,
    Path((id, item_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to confirm pick";
    let (quantity, location_barcode, product_barcode, short) =
        match validate(&headers, &body, pick_schema) {
            Ok(data) => data,
            Err(refusal) => return refusal.respond(fallback),
        };
    let params = Confirm {
        pick_list_id: id.clone(),
        item_id,
        quantity,
        product_barcode,
        location_barcode,
        short,
        user_id: caller.user_id.clone(),
    };
    match picking::confirm(&caller.db, &params).await {
        Ok(Some(result)) => {
            caller.publish(&state, PICKLIST_UPDATED, &id, &result);
            Data(result).into_response()
        }
        Ok(None) => Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => pick_error(error, fallback),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let fallback = "Failed to fetch pick list";
    let row = match picking::with_items(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => return internal(&error, fallback),
    };
    let mut recipient = Value::Null;
    let mut requires_shipping = true;
    if let Some(order_id) = picking::first_order_id(&row) {
        let order = match picking::order_contact(&caller.db, &order_id).await {
            Ok(order) => order,
            Err(error) => return internal(&error, fallback),
        };
        requires_shipping = match picking::order_requires_carrier(&caller.db, Some(&order_id)).await
        {
            Ok(requires) => requires,
            Err(error) => return internal(&error, fallback),
        };
        recipient = picking::recipient(order.as_ref());
    }
    let mut body = match row {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    body.insert("recipient".to_owned(), recipient);
    body.insert(
        "requiresShipping".to_owned(),
        Value::Bool(requires_shipping),
    );
    Data(Value::Object(body)).into_response()
}

/// `createPickListSchema`.
fn create_schema(issues: &mut Issues, body: &Body) -> Body {
    let mut out = Map::new();
    keep_text(
        issues,
        body,
        &mut out,
        "warehouseId",
        Presence::Required,
        Text::length(Some(1), None),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "assignedTo",
        Presence::Nullish,
        Text::default(),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "assignedToName",
        Presence::Nullish,
        Text::default(),
    );
    if let Field::Set(ids) = issues.list(
        body,
        "orderIds",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    ) {
        out.insert("orderIds".to_owned(), json!(ids));
    }
    keep_text(
        issues,
        body,
        &mut out,
        "pickType",
        Presence::Optional,
        Text::length(None, Some(30)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "priority",
        Presence::Optional,
        Text::length(None, Some(20)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "notes",
        Presence::Optional,
        Text::default(),
    );
    out
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to create pick list";
    let data = match validate(&headers, &body, create_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(fallback),
    };
    let id = generate_id("pl");
    let now = now();
    let pick_list_number = time_number("PL");
    let or = |key: &str, fallback: Value| {
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(fallback)
    };
    let row = json!({
        "id": id,
        "pickListNumber": pick_list_number,
        "warehouseId": data.get("warehouseId"),
        "status": "pending",
        "assignedTo": or("assignedTo", Value::Null),
        "assignedToName": or("assignedToName", Value::Null),
        "orderIds": or("orderIds", Value::Null),
        "pickType": or("pickType", json!("order")),
        "priority": or("priority", json!("normal")),
        "notes": or("notes", Value::Null),
        "createdBy": caller.user_id,
        "createdAt": now,
        "updatedAt": now,
    });
    if let Err(error) = PICK_LISTS
        .insert(
            &caller.db,
            crate::putaway::values_of(&PICK_LISTS, &row),
            &["createdAt", "updatedAt"],
        )
        .await
    {
        return write_failed(&error, fallback);
    }
    caller.publish(
        &state,
        PICKLIST_CREATED,
        &id,
        &json!({ "id": id, "warehouseId": data.get("warehouseId"), "status": "pending" }),
    );
    Created(json!({ "id": id, "pickListNumber": pick_list_number })).into_response()
}

/// `updatePickListSchema`.
fn update_schema(issues: &mut Issues, body: &Body) -> Body {
    let mut out = Map::new();
    keep_text(
        issues,
        body,
        &mut out,
        "assignedTo",
        Presence::Nullish,
        Text::default(),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "assignedToName",
        Presence::Nullish,
        Text::default(),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "priority",
        Presence::Optional,
        Text::length(None, Some(20)),
    );
    keep_text(
        issues,
        body,
        &mut out,
        "notes",
        Presence::Optional,
        Text::default(),
    );
    if let Some(metadata) = body.get("metadata") {
        out.insert("metadata".to_owned(), metadata.clone());
    }
    out
}

async fn update_list(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let fallback = "Failed to update pick list";
    let data = match validate(&headers, &body, update_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(fallback),
    };
    let existing = match PICK_LISTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => return internal(&error, fallback),
    };
    let mut change = data.clone();
    change.insert("updatedAt".to_owned(), json!(now()));
    if let Err(error) = PICK_LISTS
        .patch(
            &caller.db,
            &id,
            crate::putaway::values_of(&PICK_LISTS, &Value::Object(change)),
            true,
            &["updatedAt"],
        )
        .await
    {
        return write_failed(&error, fallback);
    }
    caller.publish(
        &state,
        PICKLIST_UPDATED,
        &id,
        &json!({ "id": id, "status": existing.get("status") }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let fallback = "Failed to delete pick list";
    let existing = match PICK_LISTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Pick list", &id).respond(fallback),
        Err(error) => return internal(&error, fallback),
    };
    let status = text(&existing, "status").unwrap_or("");
    if status != "shipped"
        && status != "cancelled"
        && let Err(error) = picking::cancel(&caller.db, &id).await
    {
        return pick_error(error, fallback);
    }
    if let Err(error) = soft_delete(&caller.db, &PICK_LISTS, &id).await {
        return write_failed(&error, fallback);
    }
    caller.publish(&state, PICKLIST_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
