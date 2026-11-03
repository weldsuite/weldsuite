//! `/api/inventory`: stock buckets (list with names, detail, create empty,
//! patch attributes, soft delete), the stock ledger (`GET /ledger`, read
//! from `stock_adjustments`), and the ledger writes (`POST /adjust`,
//! `POST /transfer`) through [`crate::ledger`].

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    INVENTORY_CREATED, INVENTORY_DELETED, INVENTORY_UPDATED, WMS_INVENTORY_MOVEMENT_CREATED,
};
use weldsuite_catalogs::permission_keys::{
    INVENTORY_CREATE, INVENTORY_DELETE, INVENTORY_READ, INVENTORY_UPDATE,
};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::args::{Arg, bind_scalar, created_cursor, cursor_sql, page_list};
use crate::crud::{cursor_failed, soft_delete, write_failed};
use crate::js::{js_limit, number_text, query_param, query_set, sql_limit};
use crate::ledger::{
    Endpoint, LedgerError, StockChange, Transfer, apply_stock_change, transfer_stock,
};
use crate::rows::inventory_row;
use crate::tables::{INVENTORY, STOCK_ADJUSTMENTS};
use crate::{Caller, Refusal, StashState, internal, now, validate};

type Body = Map<String, Value>;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([INVENTORY_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([INVENTORY_CREATE])),
        )
        .route("/ledger", get(ledger).route_layer(read()))
        .route(
            "/adjust",
            post(adjust).route_layer(gate.require([INVENTORY_UPDATE])),
        )
        .route(
            "/transfer",
            post(transfer).route_layer(gate.require([INVENTORY_UPDATE])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([INVENTORY_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([INVENTORY_DELETE])),
        )
}

/// The ledger's refusals (`ledgerError`): an unknown product is a 404,
/// insufficient stock a 409, the rest a 400 with the code; anything else the
/// route's 500.
pub(crate) fn ledger_error(error: LedgerError, fallback: &str) -> Response {
    match error {
        LedgerError::Stock {
            code: "PRODUCT_NOT_FOUND",
            ..
        } => ApiError::not_found("Product", None).into_response(),
        LedgerError::Stock {
            code: code @ "INSUFFICIENT_STOCK",
            message,
        } => ApiError::conflict(message)
            .with_details(json!({ "code": code }))
            .into_response(),
        LedgerError::Stock { code, message } => ApiError::bad_request(message)
            .with_details(json!({ "code": code }))
            .into_response(),
        LedgerError::Database(error) => internal(&error, fallback),
    }
}

/// A list row with its names: `{ ...row, productName, productSku, warehouseName, locationCode }`.
fn with_names(table: &crate::table::Table, joined: &Value) -> Value {
    let mut row = match table.js(joined.get("row").cloned().unwrap_or(Value::Null)) {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    for key in ["productName", "productSku", "warehouseName", "locationCode"] {
        row.insert(
            key.to_owned(),
            joined.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(row)
}

const LIST_SQL: &str = concat!(
    "select jsonb_build_object('row', ",
    inventory_row!(),
    ", 'productName', p.name, 'productSku', p.sku, ",
    "'warehouseName', w.name, 'locationCode', l.code) from inventory t ",
    "left join products p on t.product_id = p.id left join warehouses w on t.warehouse_id = w.id ",
    "left join warehouse_locations l on t.location_id = l.id ",
    "where t.deleted_at is null and (not $1::boolean or t.product_id = $2) ",
    "and (not $3::boolean or t.warehouse_id = $4) ",
    "and (not $5::boolean or t.quantity_on_hand <= coalesce(p.low_stock_threshold, 5)) ",
    "and (not $6::boolean or (t.created_at < $7::timestamp or (t.created_at = $7::timestamp and t.id < $8))) ",
    "order by t.created_at desc, t.id desc limit $9"
);

const COUNT_SQL: &str = concat!(
    "select count(*) from inventory t left join products p on t.product_id = p.id ",
    "where t.deleted_at is null and (not $1::boolean or t.product_id = $2) ",
    "and (not $3::boolean or t.warehouse_id = $4) ",
    "and (not $5::boolean or t.quantity_on_hand <= coalesce(p.low_stock_threshold, 5))"
);

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let product = query_set(query, "productId");
    let warehouse = query_set(query, "warehouseId");
    let low = query_param(query, "lowStockOnly").as_deref() == Some("true");
    let cursor = match query_set(query, "cursor") {
        Some(cursor) => match created_cursor(&caller.db, cursor_sql!("inventory"), &cursor).await {
            Ok(cursor) => cursor,
            Err(error) => return cursor_failed(&error),
        },
        None => None,
    };
    let filters = vec![
        Arg::Bool(product.is_some()),
        Arg::Text(product),
        Arg::Bool(warehouse.is_some()),
        Arg::Text(warehouse),
        Arg::Bool(low),
    ];
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
            rows.into_iter()
                .map(|row| with_names(&INVENTORY, &row))
                .collect(),
            limit,
            total,
        ),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list inventorys"),
    }
}

/// `stockAdjustmentTypeSchema`.
const ADJUSTMENT_TYPES: &[&str] = &[
    "increase",
    "decrease",
    "correction",
    "damage",
    "return",
    "transfer_in",
    "transfer_out",
    "received",
    "shipped",
    "cycle_count",
];

const LEDGER_SQL: &str = concat!(
    "select jsonb_build_object('row', to_jsonb(t), 'productName', p.name, 'productSku', p.sku, ",
    "'warehouseName', w.name, 'locationCode', l.code) from stock_adjustments t ",
    "left join products p on t.product_id = p.id left join warehouses w on t.warehouse_id = w.id ",
    "left join warehouse_locations l on t.location_id = l.id where ",
    "(not $1::boolean or t.product_id = $2) and (not $3::boolean or t.variant_id = $4) ",
    "and (not $5::boolean or t.warehouse_id = $6) and (not $7::boolean or t.location_id = $8) ",
    "and (not $9::boolean or t.lot_number = $10) and (not $11::boolean or t.type = $12) ",
    "and (not $13::boolean or t.source_type = $14) and (not $15::boolean or t.created_at >= $16::timestamp) ",
    "and (not $17::boolean or t.created_at <= $18::timestamp) ",
    "and (not $19::boolean or (t.created_at < $20::timestamp or (t.created_at = $20::timestamp and t.id < $21))) ",
    "order by t.created_at desc, t.id desc limit $22"
);

const LEDGER_COUNT_SQL: &str = concat!(
    "select count(*) from stock_adjustments t where ",
    "(not $1::boolean or t.product_id = $2) and (not $3::boolean or t.variant_id = $4) ",
    "and (not $5::boolean or t.warehouse_id = $6) and (not $7::boolean or t.location_id = $8) ",
    "and (not $9::boolean or t.lot_number = $10) and (not $11::boolean or t.type = $12) ",
    "and (not $13::boolean or t.source_type = $14) and (not $15::boolean or t.created_at >= $16::timestamp) ",
    "and (not $17::boolean or t.created_at <= $18::timestamp)"
);

/// `inventoryLedgerQuerySchema`, as `zValidator('query', …)` reads it.
struct LedgerQuery {
    filters: Vec<Option<String>>,
    cursor: Option<String>,
    limit: Option<f64>,
}

fn ledger_query(issues: &mut Issues, q: &Body) -> LedgerQuery {
    let text = |issues: &mut Issues, key: &str, max: usize| {
        issues
            .text_with(q, key, Presence::Optional, Text::length(None, Some(max)))
            .into_option()
    };
    let product = text(issues, "productId", 30);
    let variant = text(issues, "variantId", 30);
    let warehouse = text(issues, "warehouseId", 30);
    let location = text(issues, "locationId", 30);
    let lot = text(issues, "lotNumber", 100);
    let kind = issues
        .choice(q, "type", Presence::Optional, ADJUSTMENT_TYPES)
        .into_option();
    let source = text(issues, "sourceType", 30);
    let from = issues
        .coerce_date(q, "from", Presence::Optional)
        .into_option();
    let to = issues
        .coerce_date(q, "to", Presence::Optional)
        .into_option();
    let cursor = issues
        .text_with(q, "cursor", Presence::Optional, Text::default())
        .into_option();
    let limit = issues
        .number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        )
        .into_option();
    LedgerQuery {
        filters: vec![
            product, variant, warehouse, location, lot, kind, source, from, to,
        ],
        cursor,
        limit,
    }
}

async fn ledger(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let values = Value::Object(query_values(query.as_deref()));
    let mut issues = Issues::default();
    let read = issues.object(&values).map(|q| ledger_query(&mut issues, q));
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let Some(q) = read else {
        return ApiError::internal().into_response();
    };
    let limit = q.limit.unwrap_or(25.0);
    let cursor = match q.cursor.filter(|cursor| !cursor.is_empty()) {
        Some(cursor) => {
            match created_cursor(&caller.db, cursor_sql!("stock_adjustments"), &cursor).await {
                Ok(cursor) => cursor,
                Err(error) => return cursor_failed(&error),
            }
        }
        None => None,
    };
    let mut filters = Vec::new();
    for value in q.filters {
        // `if (q.x)`: an empty string is no filter.
        let value = value.filter(|value| !value.is_empty());
        filters.push(Arg::Bool(value.is_some()));
        filters.push(Arg::Text(value));
    }
    let mut page = filters.clone();
    page.push(Arg::Bool(cursor.is_some()));
    page.push(Arg::opt(cursor.as_ref().map(|(at, _)| at.as_str())));
    page.push(Arg::opt(cursor.as_ref().map(|(_, id)| id.as_str())));
    page.push(Arg::Int(sql_limit(limit)));
    let rows: Result<Vec<Value>, _> = bind_scalar(sqlx::query_scalar(LEDGER_SQL), page)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, _> = bind_scalar(sqlx::query_scalar(LEDGER_COUNT_SQL), filters)
        .fetch_one(&caller.db)
        .await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_list(
            rows.into_iter()
                .map(|row| with_names(&STOCK_ADJUSTMENTS, &row))
                .collect(),
            limit,
            total,
        ),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list stock ledger"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match INVENTORY.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Inventory", &id).respond("Failed to fetch inventory"),
        Err(error) => internal(&error, "Failed to fetch inventory"),
    }
}

/// `z.coerce.date()` with `presence`: `null` stays null under `.nullable()`
/// / `.nullish()` (Zod checks it before coercing).
pub(crate) fn date_field(
    issues: &mut Issues,
    body: &Body,
    key: &str,
    presence: Presence,
) -> Field<String> {
    if body.get(key).is_some_and(Value::is_null)
        && matches!(presence, Presence::Nullable | Presence::Nullish)
    {
        return Field::Null;
    }
    issues.coerce_date(body, key, presence)
}

/// A field as a JSON value for a row: set, null, or left out.
fn put(out: &mut Body, key: &str, field: Field<Value>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), value);
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

fn text_value(field: Field<String>) -> Field<Value> {
    match field {
        Field::Set(text) => Field::Set(Value::String(text)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

fn number_value(field: &Field<f64>, raw: Option<&Value>) -> Field<Value> {
    match field {
        Field::Set(_) => Field::Set(raw.cloned().unwrap_or(Value::Null)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `createInventoryBucketSchema` (`partial`: the update schema, without
/// `productId`/`warehouseId`, with the quarantine fields): the parsed body,
/// dates as `toISOString()`.
fn bucket_schema(issues: &mut Issues, body: &Body, partial: bool) -> Body {
    let mut out = Map::new();
    let opt = |nullish: bool| {
        if nullish {
            Presence::Nullish
        } else {
            Presence::Optional
        }
    };
    let len = |max: usize| Text::length(None, Some(max));
    if !partial {
        let field = issues.text_with(
            body,
            "productId",
            Presence::Required,
            Text::length(Some(1), Some(30)),
        );
        put(&mut out, "productId", text_value(field));
    }
    let field = issues.text_with(body, "variantId", Presence::Nullish, len(30));
    put(&mut out, "variantId", text_value(field));
    if !partial {
        let field = issues.text_with(
            body,
            "warehouseId",
            Presence::Required,
            Text::length(Some(1), Some(30)),
        );
        put(&mut out, "warehouseId", text_value(field));
    }
    for (key, max) in [
        ("locationId", 30),
        ("lotNumber", 100),
        ("batchNumber", 100),
        ("serialNumber", 100),
    ] {
        let field = issues.text_with(body, key, opt(true), len(max));
        put(&mut out, key, text_value(field));
    }
    for key in ["expiryDate", "manufactureDate"] {
        let field = date_field(issues, body, key, Presence::Nullish);
        put(&mut out, key, text_value(field));
    }
    let field = issues.number(
        body,
        "unitCost",
        Presence::Nullish,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    put(
        &mut out,
        "unitCost",
        number_value(&field, body.get("unitCost")),
    );
    let currency = issues.text_with(body, "currency", Presence::Optional, Text::default());
    if let Field::Set(text) = &currency {
        let before = issues.count();
        issues.string_length("currency", 3, text.encode_utf16().count());
        if issues.count() == before {
            out.insert("currency".to_owned(), Value::String(text.clone()));
        }
    }
    for key in ["status", "qualityStatus"] {
        let field = issues.text_with(body, key, Presence::Optional, len(30));
        put(&mut out, key, text_value(field));
    }
    if issues
        .nested(body, "metadata", Presence::Optional, |_, _| ())
        .as_set()
        .is_some()
    {
        out.insert(
            "metadata".to_owned(),
            body.get("metadata").cloned().unwrap_or(Value::Null),
        );
    }
    if partial {
        if let Field::Set(flag) = issues.boolean(body, "isQuarantined", Presence::Optional) {
            out.insert("isQuarantined".to_owned(), Value::Bool(flag));
        }
        let field = issues.text_with(body, "quarantineReason", Presence::Nullish, len(2000));
        put(&mut out, "quarantineReason", text_value(field));
        let field = date_field(issues, body, "lastInspectionDate", Presence::Nullish);
        put(&mut out, "lastInspectionDate", text_value(field));
    }
    out
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        bucket_schema(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create inventory"),
    };
    let id = generate_id("inv");
    let now = now();
    let get = |key: &str| data.get(key).cloned().unwrap_or(Value::Null);
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    for key in [
        "productId",
        "variantId",
        "warehouseId",
        "locationId",
        "lotNumber",
        "batchNumber",
        "serialNumber",
        "expiryDate",
        "manufactureDate",
    ] {
        props.insert(key.to_owned(), get(key));
    }
    props.insert(
        "unitCost".to_owned(),
        data.get("unitCost")
            .filter(|cost| !cost.is_null())
            .map_or(Value::Null, |cost| {
                Value::String(crate::js::json_number_text(cost))
            }),
    );
    if let Some(currency) = data.get("currency") {
        props.insert("currency".to_owned(), currency.clone());
    }
    props.insert(
        "status".to_owned(),
        data.get("status").cloned().unwrap_or(json!("available")),
    );
    for key in ["qualityStatus", "metadata"] {
        if let Some(value) = data.get(key) {
            props.insert(key.to_owned(), value.clone());
        }
    }
    for key in [
        "quantityOnHand",
        "quantityAllocated",
        "quantityAvailable",
        "quantityIncoming",
        "quantityOutgoing",
    ] {
        props.insert(key.to_owned(), json!(0));
    }
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    let mut values = Map::new();
    for (prop, value) in &props {
        INVENTORY.set(&mut values, prop, value.clone());
    }
    let trusted = ["expiryDate", "manufactureDate", "createdAt", "updatedAt"];
    if let Err(error) = INVENTORY.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, "Failed to create inventory");
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("productId".to_owned(), get("productId"));
    if let Some(location) = data.get("locationId") {
        event.insert("locationId".to_owned(), location.clone());
    }
    caller.publish(&state, INVENTORY_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

/// `adjustInventorySchema`.
struct Adjust {
    product_id: String,
    variant_id: Option<String>,
    warehouse_id: String,
    location_id: Field<String>,
    delta: i64,
    reason: String,
    kind: Option<String>,
    reason_code: Option<String>,
    notes: Option<String>,
    lot_number: Option<String>,
    batch_number: Option<String>,
    expiry_date: Option<String>,
    unit_cost: Option<f64>,
    source_type: Option<String>,
    source_id: Option<String>,
    source_number: Option<String>,
}

fn adjust_schema(issues: &mut Issues, body: &Body) -> Adjust {
    let len = |min: Option<usize>, max: usize| Text::length(min, Some(max));
    let product_id = issues.text_with(body, "productId", Presence::Required, len(Some(1), 30));
    let variant_id = issues.text_with(body, "variantId", Presence::Nullish, len(None, 30));
    let warehouse_id = issues.text_with(body, "warehouseId", Presence::Required, len(Some(1), 30));
    let location_id = issues.text_with(body, "locationId", Presence::Nullish, len(None, 30));
    let delta = issues.whole_number(body, "delta", Presence::Required, Number::default());
    let reason = issues.text_with(body, "reason", Presence::Required, len(Some(1), 500));
    let kind = issues.choice(body, "type", Presence::Optional, ADJUSTMENT_TYPES);
    let reason_code = issues.text_with(body, "reasonCode", Presence::Optional, len(None, 50));
    let notes = issues.text_with(body, "notes", Presence::Optional, len(None, 2000));
    let lot_number = issues.text_with(body, "lotNumber", Presence::Optional, len(None, 100));
    let batch_number = issues.text_with(body, "batchNumber", Presence::Optional, len(None, 100));
    let expiry_date = issues.coerce_date(body, "expiryDate", Presence::Optional);
    let unit_cost = issues.number(
        body,
        "unitCost",
        Presence::Optional,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );
    let source_type = issues.text_with(body, "sourceType", Presence::Optional, len(None, 30));
    let source_id = issues.text_with(body, "sourceId", Presence::Nullish, len(None, 30));
    let source_number = issues.text_with(body, "sourceNumber", Presence::Optional, len(None, 100));
    Adjust {
        product_id: product_id.into_option().unwrap_or_default(),
        variant_id: variant_id.into_option(),
        warehouse_id: warehouse_id.into_option().unwrap_or_default(),
        location_id,
        delta: delta.into_option().unwrap_or_default(),
        reason: reason.into_option().unwrap_or_default(),
        kind: kind.into_option(),
        reason_code: reason_code.into_option(),
        notes: notes.into_option(),
        lot_number: lot_number.into_option(),
        batch_number: batch_number.into_option(),
        expiry_date: expiry_date.into_option(),
        unit_cost: unit_cost.into_option(),
        source_type: source_type.into_option(),
        source_id: source_id.into_option(),
        source_number: source_number.into_option(),
    }
}

async fn adjust(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, adjust_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to adjust stock"),
    };
    let kind = data.kind.clone().unwrap_or_else(|| {
        if data.delta > 0 {
            "increase"
        } else {
            "decrease"
        }
        .to_owned()
    });
    let change = StockChange {
        product_id: data.product_id.clone(),
        variant_id: data.variant_id.clone(),
        warehouse_id: data.warehouse_id.clone(),
        location_id: data.location_id.as_set().cloned(),
        lot_number: data.lot_number.clone(),
        batch_number: data.batch_number.clone(),
        expiry_date: data.expiry_date.clone(),
        delta: data.delta,
        kind: kind.clone(),
        reason: Some(data.reason.clone()),
        reason_code: data.reason_code.clone(),
        notes: data.notes.clone(),
        unit_cost: data.unit_cost,
        source_type: Some(
            data.source_type
                .clone()
                .unwrap_or_else(|| "manual".to_owned()),
        ),
        source_id: data.source_id.clone(),
        source_number: data.source_number.clone(),
        performed_by: Some(caller.user_id.clone()),
    };
    let result = match apply_stock_change(&caller.db, &change).await {
        Ok(result) => result,
        Err(error) => return ledger_error(error, "Failed to adjust stock"),
    };
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(result.inventory_id));
    event.insert("productId".to_owned(), json!(data.product_id));
    match &data.location_id {
        Field::Set(location) => {
            event.insert("locationId".to_owned(), json!(location));
        }
        Field::Null => {
            event.insert("locationId".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    event.insert("quantity".to_owned(), json!(result.new_quantity));
    event.insert(
        "previousQuantity".to_owned(),
        json!(result.previous_quantity),
    );
    event.insert("adjustmentType".to_owned(), json!(kind));
    caller.publish(
        &state,
        INVENTORY_UPDATED,
        &result.inventory_id,
        &Value::Object(event),
    );
    Data(json!({
        "inventoryId": result.inventory_id,
        "adjustmentId": result.adjustment_id,
        "previousQuantity": result.previous_quantity,
        "quantityOnHand": result.new_quantity,
        "productQuantity": result.product_quantity,
    }))
    .into_response()
}

/// `transferEndpointSchema` at `key`.
fn endpoint(issues: &mut Issues, body: &Body, key: &str) -> Option<Endpoint> {
    issues
        .nested(body, key, Presence::Required, |issues, fields| {
            let warehouse = issues.text_with(
                fields,
                "warehouseId",
                Presence::Required,
                Text::length(Some(1), Some(30)),
            );
            let location = issues.text_with(
                fields,
                "locationId",
                Presence::Nullish,
                Text::length(None, Some(30)),
            );
            let lot = issues.text_with(
                fields,
                "lotNumber",
                Presence::Nullish,
                Text::length(None, Some(100)),
            );
            Endpoint {
                warehouse_id: warehouse.into_option().unwrap_or_default(),
                location_id: location.into_option(),
                lot_number: lot.into_option(),
            }
        })
        .into_option()
}

/// `transferInventorySchema`.
fn transfer_schema(issues: &mut Issues, body: &Body) -> Option<(Transfer, Value, Value)> {
    let product = issues.text_with(
        body,
        "productId",
        Presence::Required,
        Text::length(Some(1), Some(30)),
    );
    let variant = issues.text_with(
        body,
        "variantId",
        Presence::Nullish,
        Text::length(None, Some(30)),
    );
    let quantity = issues.whole_number(body, "quantity", Presence::Required, Number::default());
    // `.positive()`, after `.int()`.
    if let Some(number) = body.get("quantity").and_then(Value::as_f64)
        && number <= 0.0
    {
        issues.issue_at(
            "quantity",
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
    let from = endpoint(issues, body, "from");
    let to = endpoint(issues, body, "to");
    let reason = issues.text_with(
        body,
        "reason",
        Presence::Optional,
        Text::length(None, Some(500)),
    );
    let notes = issues.text_with(
        body,
        "notes",
        Presence::Optional,
        Text::length(None, Some(2000)),
    );
    let from_value = body.get("from").cloned().unwrap_or(Value::Null);
    let to_value = body.get("to").cloned().unwrap_or(Value::Null);
    Some((
        Transfer {
            product_id: product.into_option()?,
            variant_id: variant.into_option(),
            quantity: quantity.into_option()?,
            from: from?,
            to: to?,
            reason: reason.into_option(),
            notes: notes.into_option(),
            performed_by: None,
        },
        from_value,
        to_value,
    ))
}

async fn transfer(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (mut data, _, _) = match validate(&headers, &body, transfer_schema) {
        Ok(Some(data)) => data,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond("Failed to transfer stock"),
    };
    data.performed_by = Some(caller.user_id.clone());
    let result = match transfer_stock(&caller.db, &data).await {
        Ok(result) => result,
        Err(error) => return ledger_error(error, "Failed to transfer stock"),
    };
    caller.publish(
        &state,
        WMS_INVENTORY_MOVEMENT_CREATED,
        &result.movement_id,
        &json!({
            "id": result.movement_id,
            "movementNumber": result.movement_number,
            "movementType": "transfer",
            "productId": data.product_id,
            "quantity": data.quantity,
            "sourceWarehouseId": data.from.warehouse_id,
            "destWarehouseId": data.to.warehouse_id,
        }),
    );
    Created(json!({
        "movementId": result.movement_id,
        "movementNumber": result.movement_number,
        "from": { "inventoryId": result.out.inventory_id, "quantityOnHand": result.out.new_quantity },
        "to": { "inventoryId": result.into.inventory_id, "quantityOnHand": result.into.new_quantity },
    }))
    .into_response()
}

async fn update(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        bucket_schema(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update inventory"),
    };
    let existing = match INVENTORY.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Refusal::not_found("Inventory", &id).respond("Failed to update inventory");
        }
        Err(error) => return internal(&error, "Failed to update inventory"),
    };
    let mut props = Map::new();
    props.insert("updatedAt".to_owned(), json!(now()));
    for (key, value) in &data {
        // `unitCost` is numeric in Postgres and round-trips as a string.
        let value = if key == "unitCost" && value.is_number() {
            Value::String(number_text(value.as_f64().unwrap_or(f64::NAN)))
        } else {
            value.clone()
        };
        props.insert(key.clone(), value);
    }
    let mut values = Map::new();
    for (prop, value) in &props {
        INVENTORY.set(&mut values, prop, value.clone());
    }
    let trusted = [
        "updatedAt",
        "expiryDate",
        "manufactureDate",
        "lastInspectionDate",
    ];
    if let Err(error) = INVENTORY
        .patch(&caller.db, &id, values, true, &trusted)
        .await
    {
        return write_failed(&error, "Failed to update inventory");
    }
    let location = data
        .get("locationId")
        .filter(|location| !location.is_null())
        .cloned()
        .unwrap_or_else(|| existing.get("locationId").cloned().unwrap_or(Value::Null));
    caller.publish(
        &state,
        INVENTORY_UPDATED,
        &id,
        &json!({ "id": id, "productId": existing.get("productId"), "locationId": location }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match INVENTORY.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Refusal::not_found("Inventory", &id).respond("Failed to delete inventory");
        }
        Err(error) => return internal(&error, "Failed to delete inventory"),
    };
    if let Err(error) = soft_delete(&caller.db, &INVENTORY, &id).await {
        return write_failed(&error, "Failed to delete inventory");
    }
    caller.publish(
        &state,
        INVENTORY_DELETED,
        &id,
        &json!({ "id": id, "productId": existing.get("productId") }),
    );
    NoContent.into_response()
}
