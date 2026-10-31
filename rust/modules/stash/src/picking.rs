//! Pick-list orchestration (`services/pick-lists.ts`): generate from an
//! unfulfilled order (allocating stock), scan-confirm lines, complete, pack
//! into a draft parcel, ship (through Sendcloud when the order needs a
//! carrier) issuing the picked stock from the ledger, and cancel.

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;
use weldsuite_ports::OutboundHttp;

use crate::js::{int, text, time_number, truthy};
use crate::ledger::{
    Issue, LedgerError, allocate_stock, issue_allocated_stock, release_allocation,
};
use crate::sendcloud::{self, AnnounceError, Shipment};
use crate::table::WriteError;
use crate::tables::{ACTIVITY_LOGS, PARCELS, PICK_LIST_ITEMS, PICK_LISTS, SHIPMENTS};

const OPEN_STATUSES: &[&str] = &["pending", "assigned", "in_progress", "completed", "packed"];
const TERMINAL_ITEM: &[&str] = &["picked", "partial", "short", "skipped"];

/// What a pick-list action refuses with, or fails on.
#[derive(Debug)]
pub(crate) enum PickError {
    /// `PickListError`.
    Pick {
        code: &'static str,
        message: String,
    },
    /// `StockLedgerError`.
    Ledger(LedgerError),
    Database(sqlx::Error),
    Write(WriteError),
    /// The Sendcloud call itself failed (the fetch threw): the route's 500.
    Transport(String),
}

impl std::fmt::Display for PickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pick { code, message } => write!(f, "{code}: {message}"),
            Self::Ledger(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
            Self::Write(error) => error.fmt(f),
            Self::Transport(error) => f.write_str(error),
        }
    }
}

impl From<sqlx::Error> for PickError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<WriteError> for PickError {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl From<LedgerError> for PickError {
    fn from(error: LedgerError) -> Self {
        match error {
            LedgerError::Database(error) => Self::Database(error),
            error @ LedgerError::Stock { .. } => Self::Ledger(error),
        }
    }
}

fn pick(code: &'static str, message: impl Into<String>) -> PickError {
    PickError::Pick {
        code,
        message: message.into(),
    }
}

/// `status` of a row, `''` when null (`row.status ?? ''`).
fn status_of(row: &Value) -> &str {
    text(row, "status").unwrap_or("")
}

/// `${row.status}`: a null status prints as `null`.
fn status_text(row: &Value) -> String {
    text(row, "status").map_or_else(|| "null".to_owned(), str::to_owned)
}

/// `list.orderIds?.[0]`, when it is something to look up.
pub(crate) fn first_order_id(row: &Value) -> Option<String> {
    match row.get("orderIds").and_then(|ids| ids.get(0)) {
        Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
        Some(Value::Number(id)) => Some(id.to_string()),
        _ => None,
    }
}

/// `lineRequiresCarrier`: order items own `requires_shipping` (an integer).
fn line_requires_carrier(value: Option<i32>) -> bool {
    value.is_none_or(|value| value != 0)
}

/// `orderRequiresCarrier`.
pub(crate) async fn order_requires_carrier(
    db: &PgPool,
    order_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let Some(order_id) = order_id else {
        return Ok(true);
    };
    let lines: Vec<Option<i32>> =
        sqlx::query_scalar("select requires_shipping from order_items where order_id = $1")
            .bind(order_id)
            .fetch_all(db)
            .await?;
    if lines.is_empty() {
        return Ok(true);
    }
    Ok(lines.into_iter().any(line_requires_carrier))
}

/// `writeActivity`.
async fn write_activity(
    db: &PgPool,
    activity_type: &str,
    entity_id: &str,
    user_id: Option<&str>,
    warehouse_id: Option<&str>,
    description: &str,
    metadata: Option<Value>,
) -> Result<(), PickError> {
    let row = json!({
        "id": generate_id("act"),
        "activityType": activity_type,
        "entityType": "pick_list",
        "entityId": entity_id,
        "userId": user_id,
        "warehouseId": warehouse_id,
        "description": description,
        "metadata": metadata,
        "createdAt": crate::now(),
    });
    ACTIVITY_LOGS
        .insert(
            db,
            crate::putaway::values_of(&ACTIVITY_LOGS, &row),
            &["createdAt"],
        )
        .await?;
    Ok(())
}

/// `loadPickList`: the live row.
pub(crate) async fn load_pick_list(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    PICK_LISTS.find_live(db, id).await
}

/// `loadItems`: the lines, in pick order.
pub(crate) async fn load_items(db: &PgPool, pick_list_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from pick_list_items t where t.pick_list_id = $1 \
         order by t.pick_sequence asc, t.created_at asc",
    )
    .bind(pick_list_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PICK_LIST_ITEMS.js(row))
        .collect())
}

/// `getPickListWithItems`.
pub(crate) async fn with_items(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    let items = load_items(db, id).await?;
    let mut row = match row {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    row.insert("items".to_owned(), Value::Array(items));
    Ok(Some(Value::Object(row)))
}

/// What `generatePickList` takes.
pub(crate) struct Generate {
    pub(crate) order_id: String,
    pub(crate) warehouse_id: Option<String>,
    pub(crate) assigned_to: Option<String>,
    pub(crate) assigned_to_name: Option<String>,
    pub(crate) priority: Option<String>,
    pub(crate) created_by: String,
}

/// Requested warehouse, else the default one, else any live warehouse.
async fn resolve_warehouse(db: &PgPool, requested: Option<&str>) -> Result<String, PickError> {
    let mut warehouse = requested.filter(|id| !id.is_empty()).map(str::to_owned);
    if warehouse.is_none() {
        warehouse = sqlx::query_scalar(
            "select id from warehouses where is_default = true and deleted_at is null limit 1",
        )
        .fetch_optional(db)
        .await?;
    }
    if warehouse.is_none() {
        warehouse =
            sqlx::query_scalar("select id from warehouses where deleted_at is null limit 1")
                .fetch_optional(db)
                .await?;
    }
    let Some(warehouse) = warehouse.filter(|id| !id.is_empty()) else {
        return Err(pick("WAREHOUSE_NOT_FOUND", "No warehouse available"));
    };
    let found: Option<String> = sqlx::query_scalar(
        "select id from warehouses where id = $1 and deleted_at is null limit 1",
    )
    .bind(&warehouse)
    .fetch_optional(db)
    .await?;
    if found.is_none() {
        return Err(pick(
            "WAREHOUSE_NOT_FOUND",
            format!("Warehouse {warehouse} not found"),
        ));
    }
    Ok(warehouse)
}

/// `generatePickList`: one line per shippable order item, each from the
/// best bucket that can cover it; the stock is allocated.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn generate(db: &PgPool, params: &Generate) -> Result<Value, PickError> {
    let order: Option<(Option<String>,)> = sqlx::query_as(
        "select fulfillment_status from orders where id = $1 and deleted_at is null limit 1",
    )
    .bind(&params.order_id)
    .fetch_optional(db)
    .await?;
    let Some((fulfillment,)) = order else {
        return Err(pick(
            "ORDER_NOT_FOUND",
            format!("Order {} not found", params.order_id),
        ));
    };
    if fulfillment.as_deref() == Some("fulfilled") {
        return Err(pick("ALREADY_PICKING", "Order is already fulfilled"));
    }
    let warehouse_id = resolve_warehouse(db, params.warehouse_id.as_deref()).await?;
    let open: Option<String> = sqlx::query_scalar(
        "select id from pick_lists where deleted_at is null and status = any($1) \
         and order_ids @> $2::jsonb limit 1",
    )
    .bind(OPEN_STATUSES)
    .bind(json!([params.order_id]))
    .fetch_optional(db)
    .await?;
    if let Some(open) = open {
        return Err(pick(
            "ALREADY_PICKING",
            format!("Order already has an open pick list ({open})"),
        ));
    }
    #[allow(clippy::type_complexity)]
    let lines: Vec<(String, Option<String>, Option<String>, Option<String>, String, i32, Option<i32>, Option<i32>)> =
        sqlx::query_as(
            "select id, product_id, variant_id, sku, name, quantity, fulfilled_quantity, requires_shipping \
             from order_items where order_id = $1",
        )
        .bind(&params.order_id)
        .fetch_all(db)
        .await?;
    let shippable: Vec<_> = lines
        .into_iter()
        .filter(|(_, product, _, _, _, quantity, fulfilled, requires)| {
            product
                .as_deref()
                .is_some_and(|product| !product.is_empty())
                && line_requires_carrier(*requires)
                && i64::from(*quantity) - i64::from(fulfilled.unwrap_or(0)) > 0
        })
        .collect();
    if shippable.is_empty() {
        return Err(pick(
            "NO_SHIPPABLE_ITEMS",
            "Order has no remaining shippable items",
        ));
    }
    let now = crate::now();
    let pick_list_id = generate_id("pl");
    let pick_list_number = time_number("PL");
    let assigned = params
        .assigned_to
        .as_deref()
        .is_some_and(|to| !to.is_empty());
    let status = if assigned { "assigned" } else { "pending" };
    let mut rows: Vec<(i64, Map<String, Value>)> = Vec::new();
    let mut sequence = 0_i64;
    let mut total_quantity = 0_i64;
    for (line_id, product, variant, sku, name, quantity, fulfilled, _) in &shippable {
        let remaining = i64::from(*quantity) - i64::from(fulfilled.unwrap_or(0));
        let product = product.clone().unwrap_or_default();
        let variant_key = variant.as_deref().filter(|variant| !variant.is_empty());
        #[allow(clippy::type_complexity)]
        let bucket: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i32>)> =
            sqlx::query_as(
                "select i.id, i.location_id, l.code, i.lot_number, i.batch_number, \
                 to_jsonb(i.expiry_date)#>>'{}', l.picking_sequence from inventory i \
                 left join warehouse_locations l on i.location_id = l.id \
                 where i.product_id = $1 and i.warehouse_id = $2 and i.deleted_at is null \
                 and i.quantity_on_hand - coalesce(i.quantity_allocated, 0) >= $3 \
                 and (case when $4::text is null then i.variant_id is null else i.variant_id = $4 end) \
                 order by case when l.is_primary_pick = true then 0 else 1 end, \
                 l.picking_sequence asc nulls last limit 1",
            )
            .bind(&product)
            .bind(&warehouse_id)
            .bind(remaining)
            .bind(variant_key)
            .fetch_optional(db)
            .await?;
        let Some((inventory_id, location_id, location_code, lot, batch, expiry, picking_sequence)) =
            bucket
        else {
            let label = sku.as_deref().filter(|sku| !sku.is_empty()).unwrap_or(name);
            return Err(pick(
                "NO_SHIPPABLE_ITEMS",
                format!("Insufficient available stock for {label}"),
            ));
        };
        sequence += 1;
        total_quantity += remaining;
        let pick_sequence = picking_sequence.map_or(sequence, i64::from);
        let mut row = Map::new();
        row.insert("id".to_owned(), json!(generate_id("pli")));
        row.insert("pick_list_id".to_owned(), json!(pick_list_id));
        row.insert("order_id".to_owned(), json!(params.order_id));
        row.insert("order_item_id".to_owned(), json!(line_id));
        row.insert("product_id".to_owned(), json!(product));
        row.insert("variant_id".to_owned(), json!(variant));
        row.insert("sku".to_owned(), json!(sku));
        row.insert("name".to_owned(), json!(name));
        row.insert("location_id".to_owned(), json!(location_id));
        row.insert("location_code".to_owned(), json!(location_code));
        row.insert("inventory_id".to_owned(), json!(inventory_id));
        row.insert("quantity_required".to_owned(), json!(remaining));
        row.insert("quantity_picked".to_owned(), json!(0));
        row.insert("quantity_short".to_owned(), json!(0));
        row.insert("lot_number".to_owned(), json!(lot));
        row.insert("batch_number".to_owned(), json!(batch));
        row.insert(
            "expiry_date".to_owned(),
            json!(expiry.and_then(|stamp| weldsuite_db::js_timestamp(&stamp))),
        );
        row.insert("status".to_owned(), json!("pending"));
        row.insert("created_at".to_owned(), json!(now));
        row.insert("updated_at".to_owned(), json!(now));
        rows.push((pick_sequence, row));
    }
    // A stable sort, as `Array.prototype.sort`, then renumbered.
    rows.sort_by_key(|(sequence, _)| *sequence);
    let items: Vec<Value> = rows
        .into_iter()
        .enumerate()
        .map(|(i, (_, mut row))| {
            row.insert("pick_sequence".to_owned(), json!(i + 1));
            Value::Object(row)
        })
        .collect();
    let list = json!({
        "id": pick_list_id,
        "pickListNumber": pick_list_number,
        "warehouseId": warehouse_id,
        "status": status,
        "priority": params.priority.clone().unwrap_or_else(|| "normal".to_owned()),
        "assignedTo": params.assigned_to,
        "assignedToName": params.assigned_to_name,
        "assignedAt": if assigned { json!(now) } else { Value::Null },
        "totalItems": items.len(),
        "pickedItems": 0,
        "totalQuantity": total_quantity,
        "pickedQuantity": 0,
        "orderIds": [params.order_id],
        "orderCount": 1,
        "pickType": "order",
        "createdBy": params.created_by,
        "createdAt": now,
        "updatedAt": now,
    });
    PICK_LISTS
        .insert(
            db,
            crate::putaway::values_of(&PICK_LISTS, &list),
            &["assignedAt", "createdAt", "updatedAt"],
        )
        .await?;
    sqlx::query(
        "insert into pick_list_items (id, pick_list_id, order_id, order_item_id, product_id, variant_id, \
         sku, name, location_id, location_code, inventory_id, quantity_required, quantity_picked, \
         quantity_short, lot_number, batch_number, expiry_date, status, pick_sequence, created_at, \
         updated_at) select r.id, r.pick_list_id, r.order_id, r.order_item_id, r.product_id, \
         r.variant_id, r.sku, r.name, r.location_id, r.location_code, r.inventory_id, \
         r.quantity_required, r.quantity_picked, r.quantity_short, r.lot_number, r.batch_number, \
         r.expiry_date, r.status, r.pick_sequence, r.created_at, r.updated_at \
         from jsonb_populate_recordset(null::pick_list_items, $1::jsonb) r",
    )
    .bind(Value::Array(items.clone()))
    .execute(db)
    .await?;
    for item in &items {
        let inventory = item
            .get("inventory_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let quantity = item
            .get("quantity_required")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if let Some(inventory) = inventory
            && quantity != 0
        {
            allocate_stock(db, inventory, quantity).await?;
        }
    }
    if fulfillment.as_deref() == Some("unfulfilled") {
        sqlx::query("update orders set fulfillment_status = 'picking', updated_at = $2::timestamp where id = $1")
            .bind(&params.order_id)
            .bind(&now)
            .execute(db)
            .await?;
    }
    Ok(json!({
        "id": pick_list_id,
        "pickListNumber": pick_list_number,
        "status": status,
        "itemCount": items.len(),
    }))
}

/// `assignPickList`.
pub(crate) async fn assign(
    db: &PgPool,
    id: &str,
    assigned_to: Option<&str>,
    assigned_to_name: Option<&str>,
) -> Result<Option<Value>, PickError> {
    let Some(row) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    if !["pending", "assigned"].contains(&status_of(&row)) {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot assign a pick list in status {}", status_text(&row)),
        ));
    }
    let now = crate::now();
    let assigned = assigned_to.is_some_and(|to| !to.is_empty());
    let next = if assigned { "assigned" } else { "pending" };
    sqlx::query(
        "update pick_lists set assigned_to = $2, assigned_to_name = $3, assigned_at = $4::timestamp, \
         status = $5, updated_at = $6::timestamp where id = $1",
    )
    .bind(id)
    .bind(assigned_to)
    .bind(assigned_to_name)
    .bind(assigned.then_some(now.as_str()))
    .bind(next)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(Some(json!({ "id": id, "status": next })))
}

/// `startPickList`.
pub(crate) async fn start(db: &PgPool, id: &str) -> Result<Option<Value>, PickError> {
    let Some(row) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    let status = status_of(&row);
    if !["pending", "assigned", "in_progress"].contains(&status) {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot start a pick list in status {}", status_text(&row)),
        ));
    }
    if status == "in_progress" {
        return Ok(Some(json!({ "id": id, "status": status })));
    }
    mark_in_progress(db, id).await?;
    Ok(Some(json!({ "id": id, "status": "in_progress" })))
}

/// `status: 'in_progress', startedAt: row.startedAt ?? now`.
async fn mark_in_progress(db: &PgPool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update pick_lists set status = 'in_progress', started_at = coalesce(started_at, $2::timestamp), \
         updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(crate::now())
    .execute(db)
    .await
    .map(|_| ())
}

/// `normalizeScan`.
fn normalize_scan(value: &str) -> String {
    js_trim(value).to_lowercase()
}

/// `barcodesForItem`: the location and product codes a scan may match.
async fn barcodes_for_item(
    db: &PgPool,
    item: &Value,
) -> Result<(Vec<String>, Vec<String>), sqlx::Error> {
    let mut location = Vec::new();
    if let Some(code) = truthy(item, "locationCode") {
        location.push(normalize_scan(code));
    }
    if let Some(location_id) = truthy(item, "locationId") {
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("select barcode, code from warehouse_locations where id = $1 limit 1")
                .bind(location_id)
                .fetch_optional(db)
                .await?;
        if let Some((barcode, code)) = row {
            location.extend(
                barcode
                    .filter(|b| !b.is_empty())
                    .map(|b| normalize_scan(&b)),
            );
            location.extend(code.filter(|c| !c.is_empty()).map(|c| normalize_scan(&c)));
        }
    }
    let mut product = Vec::new();
    if let Some(sku) = truthy(item, "sku") {
        product.push(normalize_scan(sku));
    }
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select barcode, sku from products where id = $1 limit 1")
            .bind(text(item, "productId"))
            .fetch_optional(db)
            .await?;
    if let Some((barcode, sku)) = row {
        product.extend(
            barcode
                .filter(|b| !b.is_empty())
                .map(|b| normalize_scan(&b)),
        );
        product.extend(sku.filter(|s| !s.is_empty()).map(|s| normalize_scan(&s)));
    }
    if let Some(variant) = truthy(item, "variantId") {
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("select barcode, sku from product_variants where id = $1 limit 1")
                .bind(variant)
                .fetch_optional(db)
                .await?;
        if let Some((barcode, sku)) = row {
            product.extend(
                barcode
                    .filter(|b| !b.is_empty())
                    .map(|b| normalize_scan(&b)),
            );
            product.extend(sku.filter(|s| !s.is_empty()).map(|s| normalize_scan(&s)));
        }
    }
    Ok((location, product))
}

/// What `confirmPickItem` takes.
pub(crate) struct Confirm {
    pub(crate) pick_list_id: String,
    pub(crate) item_id: String,
    pub(crate) quantity: i64,
    pub(crate) product_barcode: String,
    pub(crate) location_barcode: Option<String>,
    pub(crate) short: bool,
    pub(crate) user_id: String,
}

/// `confirmPickItem`: a scan-confirmed line; a short pick releases the rest.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn confirm(db: &PgPool, params: &Confirm) -> Result<Option<Value>, PickError> {
    let Some(list) = load_pick_list(db, &params.pick_list_id).await? else {
        return Ok(None);
    };
    if !["pending", "assigned", "in_progress"].contains(&status_of(&list)) {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot pick a list in status {}", status_text(&list)),
        ));
    }
    let item: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from pick_list_items t where t.id = $1 and t.pick_list_id = $2 limit 1",
    )
    .bind(&params.item_id)
    .bind(&params.pick_list_id)
    .fetch_optional(db)
    .await?;
    let Some(item) = item.map(|item| PICK_LIST_ITEMS.js(item)) else {
        return Err(pick("ITEM_NOT_FOUND", "Pick list item not found"));
    };
    if TERMINAL_ITEM.contains(&status_of(&item)) {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot pick a line in status {}", status_text(&item)),
        ));
    }
    let (expected_location, expected_product) = barcodes_for_item(db, &item).await?;
    if !expected_product.contains(&normalize_scan(&params.product_barcode)) {
        return Err(pick(
            "SCAN_MISMATCH",
            "Scanned product does not match this pick line",
        ));
    }
    if truthy(&item, "locationId").is_some() {
        let scanned = params
            .location_barcode
            .as_deref()
            .filter(|scan| !scan.is_empty())
            .map(normalize_scan)
            .unwrap_or_default();
        if scanned.is_empty() || !expected_location.contains(&scanned) {
            return Err(pick(
                "SCAN_MISMATCH",
                "Scanned location does not match this pick line",
            ));
        }
    }
    let required = int(&item, "quantityRequired");
    let qty = params.quantity.min(required);
    let is_short = params.short || qty < required;
    let next = if qty <= 0 {
        "short"
    } else if is_short {
        "partial"
    } else {
        "picked"
    };
    let quantity_short = (required - qty).max(0);
    let item_id = text(&item, "id").unwrap_or_default().to_owned();
    let now = crate::now();
    sqlx::query(
        "update pick_list_items set quantity_picked = $2, quantity_short = $3, status = $4, \
         picked_at = $5::timestamp, picked_by = $6, updated_at = $5::timestamp where id = $1",
    )
    .bind(&item_id)
    .bind(qty)
    .bind(quantity_short)
    .bind(next)
    .bind(&now)
    .bind(&params.user_id)
    .execute(db)
    .await?;
    if let Some(inventory) = truthy(&item, "inventoryId")
        && quantity_short > 0
    {
        release_allocation(db, inventory, quantity_short).await?;
    }
    let list_id = text(&list, "id").unwrap_or_default().to_owned();
    if status_of(&list) != "in_progress" {
        mark_in_progress(db, &list_id).await?;
    }
    let items = load_items(db, &list_id).await?;
    let picked_items = items
        .iter()
        .filter(|i| TERMINAL_ITEM.contains(&status_of(i)))
        .count();
    let picked_quantity: i64 = items.iter().map(|i| int(i, "quantityPicked")).sum();
    sqlx::query(
        "update pick_lists set picked_items = $2, picked_quantity = $3, updated_at = $4::timestamp where id = $1",
    )
    .bind(&list_id)
    .bind(i64::try_from(picked_items).unwrap_or(0))
    .bind(picked_quantity)
    .bind(crate::now())
    .execute(db)
    .await?;
    let label = truthy(&item, "sku")
        .or_else(|| text(&item, "name"))
        .unwrap_or("undefined");
    write_activity(
        db,
        "pick",
        &list_id,
        Some(&params.user_id),
        text(&list, "warehouseId"),
        &format!("Picked {qty}/{required} of {label}"),
        Some(json!({ "itemId": item_id, "status": next })),
    )
    .await?;
    Ok(Some(json!({
        "id": item_id,
        "status": next,
        "quantityPicked": qty,
        "quantityShort": quantity_short,
    })))
}

/// `completePickList`.
pub(crate) async fn complete(
    db: &PgPool,
    id: &str,
    user_id: &str,
) -> Result<Option<Value>, PickError> {
    let Some(list) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    if !["pending", "assigned", "in_progress"].contains(&status_of(&list)) {
        return Err(pick(
            "INVALID_STATUS",
            format!(
                "Cannot complete a pick list in status {}",
                status_text(&list)
            ),
        ));
    }
    let items = load_items(db, id).await?;
    let unfinished = items
        .iter()
        .filter(|i| !TERMINAL_ITEM.contains(&status_of(i)))
        .count();
    if unfinished > 0 {
        return Err(pick(
            "INCOMPLETE_LINES",
            format!("{unfinished} line(s) still pending — pick, short, or skip them first"),
        ));
    }
    let now = crate::now();
    sqlx::query(
        "update pick_lists set status = 'completed', completed_at = $2::timestamp, \
         updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&now)
    .execute(db)
    .await?;
    write_activity(
        db,
        "pick",
        id,
        Some(user_id),
        text(&list, "warehouseId"),
        &format!(
            "Completed pick list {}",
            text(&list, "pickListNumber").unwrap_or("undefined")
        ),
        None,
    )
    .await?;
    Ok(Some(json!({ "id": id, "status": "completed" })))
}

/// The recipient fields of an order (`shipping?.name || order?.customerName || null`).
fn or_null(first: Option<&Value>, second: Option<&Value>) -> Value {
    fn truthy(value: Option<&Value>) -> Option<&Value> {
        value.filter(|value| match value {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
            Value::String(text) => !text.is_empty(),
            _ => true,
        })
    }
    truthy(first)
        .or_else(|| truthy(second))
        .cloned()
        .unwrap_or(Value::Null)
}

/// `value ?? null`.
fn nullish(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// The order a pick list ships, as the routes read it.
pub(crate) async fn order_contact(
    db: &PgPool,
    order_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select jsonb_build_object('orderNumber', order_number, 'customerName', customer_name, \
         'customerEmail', customer_email, 'customerPhone', customer_phone, \
         'shippingAddress', shipping_address, 'trackingNumber', tracking_number, \
         'trackingUrl', tracking_url, 'shippingCarrier', shipping_carrier) \
         from orders where id = $1 limit 1",
    )
    .bind(order_id)
    .fetch_optional(db)
    .await
}

/// The recipient `GET /api/pick-lists/:id` answers.
pub(crate) fn recipient(order: Option<&Value>) -> Value {
    let field = |key: &str| {
        order
            .and_then(|order| order.get(key))
            .filter(|v| !v.is_null())
    };
    let shipping = field("shippingAddress");
    let ship = |key: &str| {
        shipping
            .and_then(|shipping| shipping.get(key))
            .filter(|v| !v.is_null())
    };
    json!({
        "name": or_null(ship("name"), field("customerName")),
        "email": nullish(field("customerEmail")),
        "phone": or_null(ship("phone"), field("customerPhone")),
        "line1": nullish(ship("line1")),
        "line2": nullish(ship("line2")),
        "city": nullish(ship("city")),
        "postalCode": nullish(ship("postalCode")),
        "country": nullish(ship("country")),
    })
}

/// `packPickList`: a draft parcel for the order's recipient.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn pack(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, PickError> {
    let Some(list) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    if status_of(&list) == "packed"
        && let Some(parcel) = truthy(&list, "parcelId")
    {
        return Ok(Some(
            json!({ "id": id, "status": "packed", "parcelId": parcel }),
        ));
    }
    if status_of(&list) != "completed" {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot pack a pick list in status {}", status_text(&list)),
        ));
    }
    let order_id = first_order_id(&list);
    let mut order_number = Value::Null;
    let mut recipient_name = Value::Null;
    let mut recipient_email = Value::Null;
    let mut recipient_phone = Value::Null;
    let mut recipient_address = Value::Null;
    if let Some(order_id) = &order_id {
        let order = order_contact(db, order_id).await?;
        let field = |key: &str| {
            order
                .as_ref()
                .and_then(|order| order.get(key))
                .filter(|v| !v.is_null())
        };
        order_number = nullish(field("orderNumber"));
        let shipping = field("shippingAddress");
        let ship = |key: &str| {
            shipping
                .and_then(|shipping| shipping.get(key))
                .filter(|v| !v.is_null())
        };
        recipient_name = or_null(ship("name"), field("customerName"));
        recipient_email = nullish(field("customerEmail"));
        recipient_phone = or_null(ship("phone"), field("customerPhone"));
        if shipping.is_some() {
            let mut address = Map::new();
            address.insert(
                "line1".to_owned(),
                ship("line1").cloned().unwrap_or(json!("")),
            );
            // `shipping.line2`: kept when the address has it, null included.
            if let Some(line2) = shipping.and_then(|shipping| shipping.get("line2")) {
                address.insert("line2".to_owned(), line2.clone());
            }
            address.insert(
                "city".to_owned(),
                ship("city").cloned().unwrap_or(json!("")),
            );
            if let Some(state) = shipping.and_then(|shipping| shipping.get("state")) {
                address.insert("state".to_owned(), state.clone());
            }
            address.insert(
                "postalCode".to_owned(),
                ship("postalCode").cloned().unwrap_or(json!("")),
            );
            address.insert(
                "country".to_owned(),
                ship("country").cloned().unwrap_or(json!("")),
            );
            recipient_address = Value::Object(address);
        }
    }
    let now = crate::now();
    let parcel_id = generate_id("par");
    let number = text(&list, "pickListNumber").unwrap_or_default();
    let parcel = json!({
        "id": parcel_id,
        "status": "draft",
        "orderId": order_id,
        "orderNumber": order_number,
        "referenceNumber": number,
        "contents": format!("Pick list {number}"),
        "recipientName": recipient_name,
        "recipientEmail": recipient_email,
        "recipientPhone": recipient_phone,
        "recipientAddress": recipient_address,
        "createdAt": now,
        "updatedAt": now,
    });
    PARCELS
        .insert(
            db,
            crate::putaway::values_of(&PARCELS, &parcel),
            &["createdAt", "updatedAt"],
        )
        .await?;
    sqlx::query(
        "update pick_lists set status = 'packed', packed_at = $2::timestamp, packed_by = $3, \
         parcel_id = $4, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(user_id)
    .bind(&parcel_id)
    .execute(db)
    .await?;
    write_activity(
        db,
        "pack",
        id,
        Some(user_id),
        text(&list, "warehouseId"),
        &format!("Packed pick list {number}"),
        Some(json!({ "parcelId": parcel_id })),
    )
    .await?;
    Ok(Some(
        json!({ "id": id, "status": "packed", "parcelId": parcel_id }),
    ))
}

/// The ship action's options (`ShipPickListOptions`).
pub(crate) struct ShipOptions {
    pub(crate) sender_id: Option<f64>,
    pub(crate) shipping_option_code: Option<String>,
    pub(crate) weight_kg: Option<f64>,
    pub(crate) clerk_org_id: String,
    pub(crate) keyring: Keyring,
    pub(crate) http: Option<OutboundHttp>,
}

/// What the announcement gave back.
struct Carrier {
    tracking_number: Value,
    tracking_url: Value,
    label_url: Value,
    label_pdf_base64: Value,
    name: Value,
    shipping_option_code: Value,
    sendcloud_parcel_id: Value,
    sendcloud_shipment_id: Value,
}

/// `announceSendcloudParcel`.
async fn announce(
    db: &PgPool,
    list: &Value,
    order: Option<&Value>,
    options: &ShipOptions,
) -> Result<Carrier, PickError> {
    let (Some(sender_id), Some(code), Some(weight)) = (
        options.sender_id.filter(|id| *id != 0.0),
        options
            .shipping_option_code
            .as_deref()
            .filter(|code| !code.is_empty()),
        options.weight_kg.filter(|weight| *weight != 0.0),
    ) else {
        return Err(pick(
            "SHIPPING_NOT_CONFIGURED",
            "Sender, parcel type, and weight are required to ship this order",
        ));
    };
    // `resolveSendcloudClient`.
    let stored = sendcloud::settings(db, &options.clerk_org_id).await?;
    let secret = sendcloud::decrypt_secret(stored.secret_key.as_deref(), &options.keyring);
    let (Some(public_key), Some(secret)) = (
        stored.public_key.as_deref().filter(|key| !key.is_empty()),
        secret.filter(|secret| !secret.is_empty()),
    ) else {
        return Err(pick(
            "SHIPPING_NOT_CONFIGURED",
            "Sendcloud is not connected",
        ));
    };
    let enabled = |row: Option<&Value>| {
        row.and_then(|row| row.get("enabled"))
            .is_some_and(|enabled| match enabled {
                Value::Bool(flag) => *flag,
                Value::Null => false,
                Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
                Value::String(text) => !text.is_empty(),
                _ => true,
            })
    };
    let sender = stored
        .senders
        .iter()
        .find(|row| row.get("id").and_then(Value::as_f64) == Some(sender_id));
    let method = stored
        .methods
        .iter()
        .find(|row| row.get("code").and_then(Value::as_str) == Some(code));
    if !enabled(sender) || !enabled(method) {
        return Err(pick(
            "SHIPPING_NOT_CONFIGURED",
            "Selected sender or parcel type is not enabled",
        ));
    }
    let to_address =
        sendcloud::to_address(order).map_err(|message| pick("MISSING_ADDRESS", message))?;
    let order_number = order
        .and_then(|order| order.get("orderNumber"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| text(list, "pickListNumber").map(str::to_owned));
    let announced = sendcloud::announce(
        options.http.as_ref(),
        public_key,
        &secret,
        &Shipment {
            sender_address_id: sender_id,
            to_address,
            shipping_option_code: code,
            weight_kg: weight,
            order_number: order_number.as_deref(),
        },
    )
    .await
    .map_err(|error| match error {
        AnnounceError::Sendcloud(message) => pick("SENDCLOUD_FAILED", message),
        AnnounceError::Transport(error) => PickError::Transport(error),
    })?;
    let tracking = announced
        .parcel
        .as_ref()
        .and_then(|parcel| parcel.tracking_number.clone());
    if !announced.errors.is_empty() || tracking.as_deref().is_none_or(str::is_empty) {
        let message = announced
            .errors
            .first()
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("Sendcloud did not announce the shipment");
        return Err(pick("SENDCLOUD_FAILED", message));
    }
    let parcel = announced.parcel.unwrap_or_else(unreachable_parcel);
    Ok(Carrier {
        tracking_number: json!(parcel.tracking_number),
        tracking_url: json!(parcel.tracking_url),
        label_url: parcel.label_document_url,
        label_pdf_base64: json!(parcel.label_pdf_base64),
        name: json!(announced.carrier_name),
        shipping_option_code: announced.shipping_option_code,
        sendcloud_parcel_id: parcel.id,
        sendcloud_shipment_id: announced.id,
    })
}

/// Never reached: a missing parcel has no tracking number, refused above.
fn unreachable_parcel() -> sendcloud::Parcel {
    sendcloud::Parcel {
        id: Value::Null,
        tracking_number: None,
        tracking_url: None,
        label_pdf_base64: None,
        label_document_url: Value::Null,
    }
}

/// `shipPickList`: announce through Sendcloud when the order needs a
/// carrier, then the shipment, the parcel, the stock issue, the order.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn ship(
    db: &PgPool,
    id: &str,
    user_id: &str,
    options: &ShipOptions,
) -> Result<Option<Value>, PickError> {
    let Some(list) = load_pick_list(db, id).await? else {
        return Ok(None);
    };
    if status_of(&list) == "shipped" {
        return Ok(Some(json!({
            "id": id,
            "status": "shipped",
            "shipmentId": nullish(list.get("shipmentId")),
            "parcelId": nullish(list.get("parcelId")),
        })));
    }
    if status_of(&list) != "packed" {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot ship a pick list in status {}", status_text(&list)),
        ));
    }
    let order_id = first_order_id(&list);
    let order = match &order_id {
        Some(order_id) => order_contact(db, order_id).await?,
        None => None,
    };
    let requires_shipping = order_requires_carrier(db, order_id.as_deref()).await?;
    let mut carrier = Carrier {
        tracking_number: Value::Null,
        tracking_url: Value::Null,
        label_url: Value::Null,
        label_pdf_base64: Value::Null,
        name: Value::Null,
        shipping_option_code: json!(options.shipping_option_code),
        sendcloud_parcel_id: Value::Null,
        sendcloud_shipment_id: Value::Null,
    };
    if requires_shipping {
        carrier = announce(db, &list, order.as_ref(), options).await?;
    }
    let items = load_items(db, id).await?;
    let now = crate::now();
    let existing_shipment = truthy(&list, "shipmentId").map(str::to_owned);
    let shipment_id = existing_shipment
        .clone()
        .unwrap_or_else(|| generate_id("shp"));
    let parcel_id = truthy(&list, "parcelId").map(str::to_owned);
    if existing_shipment.is_none() {
        let shipment = json!({
            "id": shipment_id,
            "shipmentNumber": time_number("SHP"),
            "status": "shipped",
            "type": "outbound",
            "parcelIds": parcel_id.iter().collect::<Vec<_>>(),
            "totalParcels": i32::from(parcel_id.is_some()),
            "carrierName": carrier.name,
            "shippedAt": now,
            "createdAt": now,
            "updatedAt": now,
        });
        SHIPMENTS
            .insert(
                db,
                crate::putaway::values_of(&SHIPMENTS, &shipment),
                &["shippedAt", "createdAt", "updatedAt"],
            )
            .await?;
    }
    if let Some(parcel_id) = &parcel_id {
        let labelled = !carrier.label_url.is_null() && carrier.label_url != json!("")
            || carrier
                .label_pdf_base64
                .as_str()
                .is_some_and(|label| !label.is_empty());
        let mut change = json!({
            "shipmentId": shipment_id,
            "status": "shipped",
            "shippedAt": now,
            "trackingNumber": carrier.tracking_number,
            "carrierName": carrier.name,
            "serviceType": carrier.shipping_option_code,
            "labelUrl": carrier.label_url,
            "customFields": {
                "sendcloudShipmentId": carrier.sendcloud_shipment_id,
                "sendcloudParcelId": carrier.sendcloud_parcel_id,
                "shippingOptionCode": carrier.shipping_option_code,
            },
            "updatedAt": now,
        });
        if labelled && let Value::Object(fields) = &mut change {
            fields.insert("labelFormat".to_owned(), json!("PDF"));
        }
        PARCELS
            .patch(
                db,
                parcel_id,
                crate::putaway::values_of(&PARCELS, &change),
                false,
                &["shippedAt", "updatedAt"],
            )
            .await?;
    }
    let number = text(&list, "pickListNumber").unwrap_or_default().to_owned();
    for item in &items {
        let qty = int(item, "quantityPicked");
        if qty <= 0 {
            continue;
        }
        if let Some(inventory) = truthy(item, "inventoryId") {
            issue_allocated_stock(
                db,
                &Issue {
                    inventory_id: inventory,
                    quantity: qty,
                    source_id: id,
                    source_number: &number,
                    reason: format!("Shipped from {number}"),
                    performed_by: Some(user_id),
                },
            )
            .await?;
        }
        if let Some(order_item) = truthy(item, "orderItemId") {
            sqlx::query(
                "update order_items set fulfilled_quantity = coalesce(fulfilled_quantity, 0) + $2 where id = $1",
            )
            .bind(order_item)
            .bind(qty)
            .execute(db)
            .await?;
        }
    }
    if let Some(order_id) = &order_id {
        mark_order_shipped(db, order_id, order.as_ref(), &carrier, &now).await?;
    }
    sqlx::query(
        "update pick_lists set status = 'shipped', shipped_at = $2::timestamp, shipment_id = $3, \
         updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(&shipment_id)
    .execute(db)
    .await?;
    write_activity(
        db,
        "ship",
        id,
        Some(user_id),
        text(&list, "warehouseId"),
        &format!("Shipped pick list {number}"),
        Some(json!({
            "shipmentId": shipment_id,
            "parcelId": parcel_id,
            "trackingNumber": carrier.tracking_number,
            "shippingOptionCode": carrier.shipping_option_code,
        })),
    )
    .await?;
    Ok(Some(json!({
        "id": id,
        "status": "shipped",
        "shipmentId": shipment_id,
        "parcelId": nullish(list.get("parcelId")),
        "trackingNumber": carrier.tracking_number,
        "trackingUrl": carrier.tracking_url,
        "labelUrl": carrier.label_url,
        "labelPdfBase64": carrier.label_pdf_base64,
        "carrierName": carrier.name,
        "shippingOptionCode": carrier.shipping_option_code,
    })))
}

/// `markOrderShipped`: partial or fulfilled, with the carrier's details.
async fn mark_order_shipped(
    db: &PgPool,
    order_id: &str,
    order: Option<&Value>,
    carrier: &Carrier,
    now: &str,
) -> Result<(), PickError> {
    let lines: Vec<(i32, Option<i32>)> =
        sqlx::query_as("select quantity, fulfilled_quantity from order_items where order_id = $1")
            .bind(order_id)
            .fetch_all(db)
            .await?;
    let remaining = lines
        .iter()
        .any(|(quantity, fulfilled)| i64::from(*quantity) - i64::from(fulfilled.unwrap_or(0)) > 0);
    // `carrier.x ?? order?.x`: left out of the statement when both are
    // missing (no order row), as Drizzle leaves out `undefined`.
    let pick_value = |value: &Value, key: &str| -> Option<Value> {
        if !value.is_null() {
            return Some(value.clone());
        }
        order.map(|order| order.get(key).cloned().unwrap_or(Value::Null))
    };
    let mut change = Map::new();
    change.insert(
        "fulfillmentStatus".to_owned(),
        json!(if remaining { "partial" } else { "fulfilled" }),
    );
    if let Some(value) = pick_value(&carrier.tracking_number, "trackingNumber") {
        change.insert("trackingNumber".to_owned(), value);
    }
    if let Some(value) = pick_value(&carrier.tracking_url, "trackingUrl") {
        change.insert("trackingUrl".to_owned(), value);
    }
    if let Some(value) = pick_value(&carrier.name, "shippingCarrier") {
        change.insert("shippingCarrier".to_owned(), value);
    }
    change.insert("shippedAt".to_owned(), json!(now));
    change.insert("updatedAt".to_owned(), json!(now));
    crate::tables::ORDERS
        .patch(
            db,
            order_id,
            crate::putaway::values_of(&crate::tables::ORDERS, &Value::Object(change)),
            false,
            &["shippedAt", "updatedAt"],
        )
        .await?;
    Ok(())
}

/// `cancelPickList`: give back the stock its lines still hold.
pub(crate) async fn cancel(db: &PgPool, id: &str) -> Result<(), PickError> {
    let Some(list) = load_pick_list(db, id).await? else {
        return Ok(());
    };
    if ["shipped", "cancelled"].contains(&status_of(&list)) {
        return Err(pick(
            "INVALID_STATUS",
            format!("Cannot cancel a pick list in status {}", status_text(&list)),
        ));
    }
    for item in load_items(db, id).await? {
        let hold = if ["pending", "skipped"].contains(&status_of(&item)) {
            int(&item, "quantityRequired")
        } else {
            int(&item, "quantityPicked")
        };
        let Some(inventory) = truthy(&item, "inventoryId") else {
            continue;
        };
        if hold <= 0 {
            continue;
        }
        match release_allocation(db, inventory, hold).await {
            Ok(())
            | Err(LedgerError::Stock {
                code: "INSUFFICIENT_ALLOCATION",
                ..
            }) => {}
            Err(error) => return Err(error.into()),
        }
    }
    sqlx::query(
        "update pick_lists set status = 'cancelled', updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(crate::now())
    .execute(db)
    .await?;
    Ok(())
}

/// `escapeHtml`.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `renderPackingSlipHtml`.
pub(crate) fn packing_slip(
    pick_list_number: &str,
    order_number: Option<&str>,
    warehouse_name: Option<&str>,
    packed_at: Option<&str>,
    items: &[Value],
) -> String {
    let rows = items
        .iter()
        .filter(|item| int(item, "quantityPicked") > 0)
        .fold(String::new(), |mut rows, item| {
            let _ = write!(
                rows,
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                escape_html(text(item, "sku").unwrap_or("")),
                escape_html(text(item, "name").unwrap_or("")),
                int(item, "quantityPicked"),
                escape_html(text(item, "locationCode").unwrap_or("")),
            );
            rows
        });
    let number = escape_html(pick_list_number);
    let order = order_number
        .filter(|order| !order.is_empty())
        .map(|order| format!("Order {}<br>", escape_html(order)))
        .unwrap_or_default();
    let warehouse = warehouse_name
        .filter(|name| !name.is_empty())
        .map(|name| format!("Warehouse {}<br>", escape_html(name)))
        .unwrap_or_default();
    let packed = packed_at
        .map(|at| format!("Packed {at}"))
        .unwrap_or_default();
    format!(
        "<!doctype html>
<html><head><meta charset=\"utf-8\"><title>Packing slip {number}</title>
<style>
  body {{ font-family: system-ui, sans-serif; padding: 32px; color: #111; }}
  h1 {{ font-size: 20px; margin: 0 0 8px; }}
  .meta {{ color: #555; margin-bottom: 24px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 14px; }}
  th {{ text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; color: #666; }}
</style></head>
<body>
  <h1>Packing slip {number}</h1>
  <div class=\"meta\">
    {order}
    {warehouse}
    {packed}
  </div>
  <table>
    <thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Location</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
</body></html>"
    )
}
