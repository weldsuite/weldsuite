//! `/api/pick-lists`: list, create, generate from an order, assign, start,
//! scan-confirm a line, complete, pack, ship (through Sendcloud when the
//! order needs a carrier), the packing slip, detail, patch and delete. The
//! work is [`crate::picking`]'s; stock moves through [`crate::ledger`].

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PARCEL_UPDATED, PICKLIST_COMPLETED, PICKLIST_CREATED, PICKLIST_DELETED, PICKLIST_UPDATED,
    SHIPMENT_SHIPPED,
};
use weldsuite_catalogs::permission_keys::{
    PICKLISTS_CREATE, PICKLISTS_DELETE, PICKLISTS_READ, PICKLISTS_UPDATE,
};
use weldsuite_db::Keyring;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_list};
use crate::crud::{cursor_failed, soft_delete, write_failed};
use crate::js::{js_limit, query_param, query_set, sql_limit, text, time_number};
use crate::ledger::LedgerError;
use crate::picking::{self, Confirm, Generate, PickError, ShipOptions};
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
            if [
                "ALREADY_PICKING",
                "SHIPPING_NOT_CONFIGURED",
                "SENDCLOUD_FAILED",
            ]
            .contains(&code)
            {
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

const LIST_SQL: &str = concat!(
    "select to_jsonb(t) from pick_lists t where t.deleted_at is null ",
    "and (not $1::boolean or t.warehouse_id = $2) and (not $3::boolean or t.status = $4) ",
    "and (not $5::boolean or t.assigned_to = $6) ",
    "and (not $7::boolean or (t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9))) ",
    "order by t.created_at desc, t.id desc limit $10"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from pick_lists t where t.deleted_at is null ",
    "and (not $1::boolean or t.warehouse_id = $2) and (not $3::boolean or t.status = $4) ",
    "and (not $5::boolean or t.assigned_to = $6)"
);

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let mut filters = Vec::new();
    for key in ["warehouseId", "status", "assignedTo"] {
        let value = query_set(query, key);
        filters.push(Arg::Bool(value.is_some()));
        filters.push(Arg::Text(value));
    }
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("pick_lists"), &cursor).await {
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
    let rows: Result<Vec<Value>, _> = bind_scalar(sqlx::query_scalar(LIST_SQL), page)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, _> = bind_scalar(sqlx::query_scalar(COUNT_SQL), filters)
        .fetch_one(&caller.db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_list(
            rows.into_iter().map(|row| PICK_LISTS.js(row)).collect(),
            limit,
            total,
        ),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list pick lists"),
    }
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
    let warehouse: Result<Option<String>, _> =
        sqlx::query_scalar("select name from warehouses where id = $1 limit 1")
            .bind(text(&row, "warehouseId"))
            .fetch_optional(&caller.db)
            .await;
    let warehouse = match warehouse {
        Ok(warehouse) => warehouse,
        Err(error) => return internal(&error, fallback),
    };
    let mut order_number = None;
    if let Some(order_id) = picking::first_order_id(&row) {
        let order: Result<Option<Option<String>>, _> =
            sqlx::query_scalar("select order_number from orders where id = $1 limit 1")
                .bind(order_id)
                .fetch_optional(&caller.db)
                .await;
        match order {
            Ok(order) => order_number = order.flatten(),
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

/// A `.positive()` failing on the number at `key` (after its type check).
fn positive(issues: &mut Issues, body: &Body, key: &str) {
    if let Some(number) = body.get(key).and_then(Value::as_f64)
        && number <= 0.0
    {
        issues.issue_at(
            key,
            json!({
                "code": "too_small",
                "minimum": 0,
                "type": "number",
                "inclusive": false,
                "exact": false,
                "message": "Number must be greater than 0",
            }),
        );
    }
}

/// `shipPickListSchema.partial()`.
fn ship_schema(issues: &mut Issues, body: &Body) -> (Option<f64>, Option<String>, Option<f64>) {
    #[allow(clippy::cast_precision_loss)]
    let sender = issues
        .whole_number(body, "senderId", Presence::Optional, Number::default())
        .into_option()
        .map(|sender| sender as f64);
    positive(issues, body, "senderId");
    let code = issues
        .text_with(
            body,
            "shippingOptionCode",
            Presence::Optional,
            Text::length(Some(1), None),
        )
        .into_option();
    let weight = issues
        .number(body, "weightKg", Presence::Optional, Number::default())
        .into_option();
    positive(issues, body, "weightKg");
    let positive_or = |value: Option<f64>| value.filter(|value| *value > 0.0);
    (positive_or(sender), code, positive_or(weight))
}

async fn ship(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let fallback = "Failed to ship pick list";
    // `await c.req.json()`: a body that does not parse is an empty payload.
    let (sender_id, code, weight) = match serde_json::from_slice::<Value>(&body) {
        Ok(json) => {
            let mut issues = Issues::default();
            let read = issues
                .object(&json)
                .map(|fields| ship_schema(&mut issues, fields));
            match issues.finish() {
                Ok(()) => read.unwrap_or((None, None, None)),
                Err(invalid) => {
                    return ApiError::bad_request("Invalid ship payload")
                        .with_details(invalid.flatten())
                        .into_response();
                }
            }
        }
        Err(_) => (None, None, None),
    };
    let nonempty = |name: &str| caller.env(name).filter(|value| !value.is_empty());
    let options = ShipOptions {
        sender_id,
        shipping_option_code: code,
        weight_kg: weight,
        clerk_org_id: caller.clerk_org_id.clone(),
        keyring: Keyring {
            v1: nonempty("DATABASE_ENCRYPTION_KEY"),
            v2: nonempty("DATABASE_ENCRYPTION_KEY_V2"),
        },
        http: caller.http(&state),
    };
    let result = match picking::ship(&caller.db, &id, &caller.user_id, &options).await {
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
