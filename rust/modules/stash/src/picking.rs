//! Pick-list orchestration (`services/pick-lists.ts`): generate from an
//! unfulfilled order (allocating stock), scan-confirm lines, complete, pack
//! into a draft parcel, ship (no carrier is called) issuing the picked
//! stock from the ledger, and cancel.

use std::fmt::Write as _;

use sea_orm::sea_query::{Expr, Func, NullOrdering, Order};
use sea_orm::{
    ActiveValue, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_trim;
use weldsuite_schema::tenant::{
    inventory, order_items, orders, pick_list_items, pick_lists, product_variants, products,
    warehouse_locations, warehouses,
};

use crate::args::{millis, now_stamped, table_rows};
use crate::js::{int, text, time_number, truthy};
use crate::ledger::{
    Issue, LedgerError, allocate_stock, issue_allocated_stock, release_allocation,
};
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
    Database(DbErr),
    Write(WriteError),
}

impl std::fmt::Display for PickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pick { code, message } => write!(f, "{code}: {message}"),
            Self::Ledger(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
            Self::Write(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for PickError {
    fn from(error: DbErr) -> Self {
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
) -> Result<bool, DbErr> {
    let Some(order_id) = order_id else {
        return Ok(true);
    };
    let lines: Vec<Option<i32>> = order_items::Entity::find()
        .select_only()
        .column(order_items::Column::RequiresShipping)
        .filter(order_items::Column::OrderId.eq(order_id))
        .into_tuple()
        .all(&orm(db))
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
pub(crate) async fn load_pick_list(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    PICK_LISTS.find_live(db, id).await
}

/// `loadItems`: the lines, in pick order.
pub(crate) async fn load_items(db: &PgPool, pick_list_id: &str) -> Result<Vec<Value>, DbErr> {
    use pick_list_items::{Column, Entity};
    let mut select = PICK_LIST_ITEMS.entity.select();
    select
        .and_where(Column::PickListId.eq(pick_list_id))
        .order_by((Entity, Column::PickSequence), Order::Asc)
        .order_by((Entity, Column::CreatedAt), Order::Asc);
    table_rows(db, &PICK_LIST_ITEMS, &select).await
}

/// `getPickListWithItems`.
pub(crate) async fn with_items(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
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
    use warehouses::{Column, Entity};
    let db = &orm(db);
    let live = || {
        Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::DeletedAt.is_null())
    };
    let mut warehouse = requested.filter(|id| !id.is_empty()).map(str::to_owned);
    if warehouse.is_none() {
        warehouse = live()
            .filter(Column::IsDefault.eq(true))
            .into_tuple()
            .one(db)
            .await?;
    }
    if warehouse.is_none() {
        warehouse = live().into_tuple().one(db).await?;
    }
    let Some(warehouse) = warehouse.filter(|id| !id.is_empty()) else {
        return Err(pick("WAREHOUSE_NOT_FOUND", "No warehouse available"));
    };
    let found: Option<String> = live()
        .filter(Column::Id.eq(warehouse.as_str()))
        .into_tuple()
        .one(db)
        .await?;
    if found.is_none() {
        return Err(pick(
            "WAREHOUSE_NOT_FOUND",
            format!("Warehouse {warehouse} not found"),
        ));
    }
    Ok(warehouse)
}

/// An order line as `generatePickList` reads it.
type OrderLine = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i32,
    Option<i32>,
    Option<i32>,
);

/// The bucket a line picks from: its id, location and code, lot, batch,
/// expiry, and the location's picking sequence.
type Bucket = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<PrimitiveDateTime>,
    Option<i32>,
);

/// The order's fulfillment and approval status.
async fn order_statuses(
    db: &PgPool,
    order_id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, DbErr> {
    orders::Entity::find()
        .select_only()
        .columns([
            orders::Column::FulfillmentStatus,
            orders::Column::ApprovalStatus,
        ])
        .filter(orders::Column::Id.eq(order_id))
        .filter(orders::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// An open pick list (`pending` up to `packed`) of the order.
async fn open_pick_list(db: &PgPool, order_id: &str) -> Result<Option<String>, DbErr> {
    use pick_lists::{Column, Entity};
    Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.is_in(OPEN_STATUSES.iter().copied()))
        .filter(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col((Entity, Column::OrderIds)),
            Expr::val(json!([order_id])),
        ))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// The best bucket that can cover `remaining` units of the line: on a
/// primary pick location first, then by picking sequence (none last).
async fn best_bucket(
    db: &PgPool,
    product: &str,
    warehouse_id: &str,
    variant: Option<&str>,
    remaining: i64,
) -> Result<Option<Bucket>, DbErr> {
    use inventory::Column;
    use sea_orm::ExprTrait as _;
    let available = Column::QuantityOnHand.into_expr().sub(Func::coalesce([
        Column::QuantityAllocated.into_expr(),
        Expr::val(0),
    ]));
    inventory::Entity::find()
        .select_only()
        .columns([Column::Id, Column::LocationId])
        .column(warehouse_locations::Column::Code)
        .columns([Column::LotNumber, Column::BatchNumber, Column::ExpiryDate])
        .column(warehouse_locations::Column::PickingSequence)
        .join(
            JoinType::LeftJoin,
            inventory::Entity::belongs_to(warehouse_locations::Entity)
                .from(Column::LocationId)
                .to(warehouse_locations::Column::Id)
                .into(),
        )
        .filter(Column::ProductId.eq(product))
        .filter(Column::WarehouseId.eq(warehouse_id))
        .filter(Column::DeletedAt.is_null())
        .filter(available.gte(remaining))
        .filter(Column::VariantId.eq(variant))
        .order_by(
            Into::<Expr>::into(
                Expr::case(warehouse_locations::Column::IsPrimaryPick.eq(true), 0).finally(1),
            ),
            Order::Asc,
        )
        .order_by_with_nulls(
            warehouse_locations::Column::PickingSequence,
            Order::Asc,
            NullOrdering::Last,
        )
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `generatePickList`: one line per shippable order item, each from the
/// best bucket that can cover it; the stock is allocated.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn generate(db: &PgPool, params: &Generate) -> Result<Value, PickError> {
    let Some((fulfillment, approval)) = order_statuses(db, &params.order_id).await? else {
        return Err(pick(
            "ORDER_NOT_FOUND",
            format!("Order {} not found", params.order_id),
        ));
    };
    if fulfillment.as_deref() == Some("fulfilled") {
        return Err(pick("ALREADY_PICKING", "Order is already fulfilled"));
    }
    // A B2B order that waits for its company's approval (WeldCommerce, ADR
    // COM-012), or was refused, is not released to the warehouse.
    match approval.as_deref() {
        Some("pending") => {
            return Err(pick(
                "APPROVAL_PENDING",
                "Order is waiting for approval and is not released to the warehouse",
            ));
        }
        Some("rejected") => {
            return Err(pick(
                "APPROVAL_REJECTED",
                "Order was rejected and is not released to the warehouse",
            ));
        }
        _ => {}
    }
    let warehouse_id = resolve_warehouse(db, params.warehouse_id.as_deref()).await?;
    // Nothing is picked or allocated in a warehouse another system owns
    // (ADR STASH-010); refused before the pick list is written.
    if crate::ledger::warehouse_is_managed(db, &warehouse_id).await? {
        return Err(PickError::Ledger(crate::ledger::managed_warehouse()));
    }
    if let Some(open) = open_pick_list(db, &params.order_id).await? {
        return Err(pick(
            "ALREADY_PICKING",
            format!("Order already has an open pick list ({open})"),
        ));
    }
    let lines: Vec<OrderLine> = order_items::Entity::find()
        .select_only()
        .columns([
            order_items::Column::Id,
            order_items::Column::ProductId,
            order_items::Column::VariantId,
            order_items::Column::Sku,
            order_items::Column::Name,
            order_items::Column::Quantity,
            order_items::Column::FulfilledQuantity,
            order_items::Column::RequiresShipping,
        ])
        .filter(order_items::Column::OrderId.eq(params.order_id.as_str()))
        .into_tuple()
        .all(&orm(db))
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
    let (now, stamp) = now_stamped();
    let pick_list_id = generate_id("pl");
    let pick_list_number = time_number("PL");
    let assigned = params
        .assigned_to
        .as_deref()
        .is_some_and(|to| !to.is_empty());
    let status = if assigned { "assigned" } else { "pending" };
    let mut rows: Vec<(i64, pick_list_items::ActiveModel, String, i64)> = Vec::new();
    let mut sequence = 0_i64;
    let mut total_quantity = 0_i64;
    for (line_id, product, variant, sku, name, quantity, fulfilled, _) in &shippable {
        let remaining = i64::from(*quantity) - i64::from(fulfilled.unwrap_or(0));
        let product = product.clone().unwrap_or_default();
        let variant_key = variant.as_deref().filter(|variant| !variant.is_empty());
        let bucket = best_bucket(db, &product, &warehouse_id, variant_key, remaining).await?;
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
        let row = pick_list_items::ActiveModel {
            id: ActiveValue::Set(generate_id("pli")),
            pick_list_id: ActiveValue::Set(pick_list_id.clone()),
            order_id: ActiveValue::Set(Some(params.order_id.clone())),
            order_item_id: ActiveValue::Set(Some(line_id.clone())),
            product_id: ActiveValue::Set(product),
            variant_id: ActiveValue::Set(variant.clone()),
            sku: ActiveValue::Set(sku.clone()),
            name: ActiveValue::Set(name.clone()),
            location_id: ActiveValue::Set(location_id),
            location_code: ActiveValue::Set(location_code),
            inventory_id: ActiveValue::Set(Some(inventory_id.clone())),
            quantity_required: ActiveValue::Set(
                i32::try_from(remaining).map_err(|_| out_of_range("quantity_required"))?,
            ),
            quantity_picked: ActiveValue::Set(Some(0)),
            quantity_short: ActiveValue::Set(Some(0)),
            lot_number: ActiveValue::Set(lot),
            batch_number: ActiveValue::Set(batch),
            expiry_date: ActiveValue::Set(expiry.map(millis)),
            status: ActiveValue::Set(Some("pending".to_owned())),
            created_at: ActiveValue::Set(stamp),
            updated_at: ActiveValue::Set(stamp),
            ..Default::default()
        };
        rows.push((pick_sequence, row, inventory_id, remaining));
    }
    // A stable sort, as `Array.prototype.sort`, then renumbered.
    rows.sort_by_key(|(sequence, ..)| *sequence);
    let mut items = Vec::with_capacity(rows.len());
    let mut allocations = Vec::with_capacity(rows.len());
    for (i, (_, mut row, inventory_id, remaining)) in rows.into_iter().enumerate() {
        row.pick_sequence = ActiveValue::Set(Some(i32::try_from(i + 1).unwrap_or(i32::MAX)));
        items.push(row);
        allocations.push((inventory_id, remaining));
    }
    let item_count = items.len();
    let list = json!({
        "id": pick_list_id,
        "pickListNumber": pick_list_number,
        "warehouseId": warehouse_id,
        "status": status,
        "priority": params.priority.clone().unwrap_or_else(|| "normal".to_owned()),
        "assignedTo": params.assigned_to,
        "assignedToName": params.assigned_to_name,
        "assignedAt": if assigned { json!(now) } else { Value::Null },
        "totalItems": item_count,
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
    pick_list_items::Entity::insert_many(items)
        .exec_without_returning(&orm(db))
        .await?;
    for (inventory, quantity) in &allocations {
        if !inventory.is_empty() && *quantity != 0 {
            allocate_stock(db, inventory, *quantity).await?;
        }
    }
    if fulfillment.as_deref() == Some("unfulfilled") {
        orders::Entity::update_many()
            .col_expr(orders::Column::FulfillmentStatus, Expr::value("picking"))
            .col_expr(orders::Column::UpdatedAt, Expr::value(stamp))
            .filter(orders::Column::Id.eq(params.order_id.as_str()))
            .exec(&orm(db))
            .await?;
    }
    Ok(json!({
        "id": pick_list_id,
        "pickListNumber": pick_list_number,
        "status": status,
        "itemCount": item_count,
    }))
}

/// A value the column cannot take: Postgres's refusal, the route's 500.
fn out_of_range(what: &str) -> DbErr {
    DbErr::Type(format!("{what}: integer out of range"))
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
    let now = weldsuite_db::utc_now();
    let assigned = assigned_to.is_some_and(|to| !to.is_empty());
    let next = if assigned { "assigned" } else { "pending" };
    pick_lists::Entity::update_many()
        .col_expr(pick_lists::Column::AssignedTo, Expr::value(assigned_to))
        .col_expr(
            pick_lists::Column::AssignedToName,
            Expr::value(assigned_to_name),
        )
        .col_expr(
            pick_lists::Column::AssignedAt,
            Expr::value(assigned.then_some(now)),
        )
        .col_expr(pick_lists::Column::Status, Expr::value(next))
        .col_expr(pick_lists::Column::UpdatedAt, Expr::value(now))
        .filter(pick_lists::Column::Id.eq(id))
        .exec(&orm(db))
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
async fn mark_in_progress(db: &PgPool, id: &str) -> Result<(), DbErr> {
    use pick_lists::Column;
    let now = weldsuite_db::utc_now();
    pick_lists::Entity::update_many()
        .col_expr(Column::Status, Expr::value("in_progress"))
        .col_expr(
            Column::StartedAt,
            Func::coalesce([Column::StartedAt.into_expr(), Expr::val(now)]).into(),
        )
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

/// `normalizeScan`.
fn normalize_scan(value: &str) -> String {
    js_trim(value).to_lowercase()
}

/// A barcode and a code (sku), as scans compare them: set ones only.
fn scan_codes(codes: Option<(Option<String>, Option<String>)>) -> Vec<String> {
    let Some((barcode, code)) = codes else {
        return Vec::new();
    };
    [barcode, code]
        .into_iter()
        .flatten()
        .filter(|code| !code.is_empty())
        .map(|code| normalize_scan(&code))
        .collect()
}

/// `barcodesForItem`: the location and product codes a scan may match.
async fn barcodes_for_item(db: &PgPool, item: &Value) -> Result<(Vec<String>, Vec<String>), DbErr> {
    let db = &orm(db);
    let mut location = Vec::new();
    if let Some(code) = truthy(item, "locationCode") {
        location.push(normalize_scan(code));
    }
    if let Some(location_id) = truthy(item, "locationId") {
        let row = warehouse_locations::Entity::find()
            .select_only()
            .columns([
                warehouse_locations::Column::Barcode,
                warehouse_locations::Column::Code,
            ])
            .filter(warehouse_locations::Column::Id.eq(location_id))
            .into_tuple::<(Option<String>, Option<String>)>()
            .one(db)
            .await?;
        location.extend(scan_codes(row));
    }
    let mut product = Vec::new();
    if let Some(sku) = truthy(item, "sku") {
        product.push(normalize_scan(sku));
    }
    // `eq(products.id, item.productId)`: a line without a product matches
    // none.
    if let Some(product_id) = text(item, "productId") {
        let row = products::Entity::find()
            .select_only()
            .columns([products::Column::Barcode, products::Column::Sku])
            .filter(products::Column::Id.eq(product_id))
            .into_tuple::<(Option<String>, Option<String>)>()
            .one(db)
            .await?;
        product.extend(scan_codes(row));
    }
    if let Some(variant) = truthy(item, "variantId") {
        let row = product_variants::Entity::find()
            .select_only()
            .columns([
                product_variants::Column::Barcode,
                product_variants::Column::Sku,
            ])
            .filter(product_variants::Column::Id.eq(variant))
            .into_tuple::<(Option<String>, Option<String>)>()
            .one(db)
            .await?;
        product.extend(scan_codes(row));
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
    let item = {
        use pick_list_items::Column;
        let mut select = PICK_LIST_ITEMS.entity.select();
        select
            .and_where(Column::Id.eq(params.item_id.as_str()))
            .and_where(Column::PickListId.eq(params.pick_list_id.as_str()))
            .limit(1);
        table_rows(db, &PICK_LIST_ITEMS, &select).await?
    };
    let Some(item) = item.into_iter().next() else {
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
    let now = weldsuite_db::utc_now();
    {
        use pick_list_items::Column;
        pick_list_items::Entity::update_many()
            .col_expr(Column::QuantityPicked, Expr::value(qty))
            .col_expr(Column::QuantityShort, Expr::value(quantity_short))
            .col_expr(Column::Status, Expr::value(next))
            .col_expr(Column::PickedAt, Expr::value(now))
            .col_expr(Column::PickedBy, Expr::value(params.user_id.as_str()))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(item_id.as_str()))
            .exec(&orm(db))
            .await?;
    }
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
    pick_lists::Entity::update_many()
        .col_expr(
            pick_lists::Column::PickedItems,
            Expr::value(i64::try_from(picked_items).unwrap_or(0)),
        )
        .col_expr(
            pick_lists::Column::PickedQuantity,
            Expr::value(picked_quantity),
        )
        .col_expr(
            pick_lists::Column::UpdatedAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(pick_lists::Column::Id.eq(list_id.as_str()))
        .exec(&orm(db))
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
    let now = weldsuite_db::utc_now();
    pick_lists::Entity::update_many()
        .col_expr(pick_lists::Column::Status, Expr::value("completed"))
        .col_expr(pick_lists::Column::CompletedAt, Expr::value(now))
        .col_expr(pick_lists::Column::UpdatedAt, Expr::value(now))
        .filter(pick_lists::Column::Id.eq(id))
        .exec(&orm(db))
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

/// An order's contact and shipping fields, as the routes read them.
type Contact = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Value>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The order a pick list ships, as the routes read it: `{ orderNumber,
/// customerName, customerEmail, customerPhone, shippingAddress,
/// trackingNumber, trackingUrl, shippingCarrier }`.
pub(crate) async fn order_contact(db: &PgPool, order_id: &str) -> Result<Option<Value>, DbErr> {
    use orders::Column;
    let row: Option<Contact> = orders::Entity::find()
        .select_only()
        .columns([
            Column::OrderNumber,
            Column::CustomerName,
            Column::CustomerEmail,
            Column::CustomerPhone,
            Column::ShippingAddress,
            Column::TrackingNumber,
            Column::TrackingUrl,
            Column::ShippingCarrier,
        ])
        .filter(Column::Id.eq(order_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(
        |(number, name, email, phone, address, tracking, url, carrier)| {
            json!({
                "orderNumber": number,
                "customerName": name,
                "customerEmail": email,
                "customerPhone": phone,
                "shippingAddress": address,
                "trackingNumber": tracking,
                "trackingUrl": url,
                "shippingCarrier": carrier,
            })
        },
    ))
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
    let (now, stamp) = now_stamped();
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
    pick_lists::Entity::update_many()
        .col_expr(pick_lists::Column::Status, Expr::value("packed"))
        .col_expr(pick_lists::Column::PackedAt, Expr::value(stamp))
        .col_expr(pick_lists::Column::PackedBy, Expr::value(user_id))
        .col_expr(
            pick_lists::Column::ParcelId,
            Expr::value(parcel_id.as_str()),
        )
        .col_expr(pick_lists::Column::UpdatedAt, Expr::value(stamp))
        .filter(pick_lists::Column::Id.eq(id))
        .exec(&orm(db))
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

/// `shipPickList`: the shipment, the parcel, the stock issue, the order. No
/// carrier is called: carrier labels left with the shipping integration.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn ship(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, PickError> {
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
    let items = load_items(db, id).await?;
    let (now, stamp) = now_stamped();
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
        let change = json!({
            "shipmentId": shipment_id,
            "status": "shipped",
            "shippedAt": now,
            "updatedAt": now,
        });
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
            use sea_orm::ExprTrait as _;
            let fulfilled = Func::coalesce([
                order_items::Column::FulfilledQuantity.into_expr(),
                Expr::val(0),
            ]);
            order_items::Entity::update_many()
                .col_expr(
                    order_items::Column::FulfilledQuantity,
                    Expr::from(fulfilled).add(qty),
                )
                .filter(order_items::Column::Id.eq(order_item))
                .exec(&orm(db))
                .await?;
        }
    }
    if let Some(order_id) = &order_id {
        mark_order_shipped(db, order_id, &now).await?;
    }
    pick_lists::Entity::update_many()
        .col_expr(pick_lists::Column::Status, Expr::value("shipped"))
        .col_expr(pick_lists::Column::ShippedAt, Expr::value(stamp))
        .col_expr(
            pick_lists::Column::ShipmentId,
            Expr::value(shipment_id.as_str()),
        )
        .col_expr(pick_lists::Column::UpdatedAt, Expr::value(stamp))
        .filter(pick_lists::Column::Id.eq(id))
        .exec(&orm(db))
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
        })),
    )
    .await?;
    Ok(Some(json!({
        "id": id,
        "status": "shipped",
        "shipmentId": shipment_id,
        "parcelId": nullish(list.get("parcelId")),
    })))
}

/// `markOrderShipped`: partial or fulfilled. Tracking details already on the
/// order stay.
async fn mark_order_shipped(db: &PgPool, order_id: &str, now: &str) -> Result<(), PickError> {
    let lines: Vec<(i32, Option<i32>)> = order_items::Entity::find()
        .select_only()
        .columns([
            order_items::Column::Quantity,
            order_items::Column::FulfilledQuantity,
        ])
        .filter(order_items::Column::OrderId.eq(order_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let remaining = lines
        .iter()
        .any(|(quantity, fulfilled)| i64::from(*quantity) - i64::from(fulfilled.unwrap_or(0)) > 0);
    let change = json!({
        "fulfillmentStatus": if remaining { "partial" } else { "fulfilled" },
        "shippedAt": now,
        "updatedAt": now,
    });
    crate::tables::ORDERS
        .patch(
            db,
            order_id,
            crate::putaway::values_of(&crate::tables::ORDERS, &change),
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
            // A warehouse that became managed since keeps its allocations
            // for the owning system's sync to overwrite; the list still
            // cancels.
            Ok(())
            | Err(LedgerError::Stock {
                code: "INSUFFICIENT_ALLOCATION" | crate::ledger::WAREHOUSE_MANAGED,
                ..
            }) => {}
            Err(error) => return Err(error.into()),
        }
    }
    pick_lists::Entity::update_many()
        .col_expr(pick_lists::Column::Status, Expr::value("cancelled"))
        .col_expr(
            pick_lists::Column::UpdatedAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(pick_lists::Column::Id.eq(id))
        .exec(&orm(db))
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
