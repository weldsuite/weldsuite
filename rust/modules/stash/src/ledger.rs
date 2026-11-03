//! The inventory ledger (`services/inventory-ledger.ts`): the single write
//! path for stock quantities. Every change to `inventory.quantity_on_hand`
//! is an increment inside the database (no lost updates), leaves an audit
//! row in `stock_adjustments`, and recomputes the `products` and
//! `product_variants` roll-ups. The statements are the TypeScript ones, in
//! the same order, so the same races resolve the same way: a first receipt
//! that loses `inventory_bucket_unique` re-runs its increment.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::js::{base36_upper, number_text, to_fixed_2};

/// A condition the caller can fix (`StockLedgerError`): routes answer 404,
/// 409 or 400 with its message and code.
#[derive(Debug)]
pub(crate) enum LedgerError {
    Stock { code: &'static str, message: String },
    Database(sqlx::Error),
}

impl From<sqlx::Error> for LedgerError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for LedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stock { code, message } => write!(f, "{code}: {message}"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

fn stock(code: &'static str, message: impl Into<String>) -> LedgerError {
    LedgerError::Stock {
        code,
        message: message.into(),
    }
}

fn insufficient_stock(on_hand: i64, delta: i64) -> LedgerError {
    stock(
        "INSUFFICIENT_STOCK",
        format!(
            "Insufficient stock: {on_hand} on hand, {} requested",
            -delta
        ),
    )
}

/// A signed stock change to one bucket (`StockChangeParams`). Optional
/// strings are as the caller passed them: `None` is `undefined`/`null`.
#[derive(Debug, Clone, Default)]
pub(crate) struct StockChange {
    pub(crate) product_id: String,
    pub(crate) warehouse_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) location_id: Option<String>,
    pub(crate) lot_number: Option<String>,
    pub(crate) delta: i64,
    pub(crate) kind: String,
    pub(crate) reason: Option<String>,
    pub(crate) reason_code: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) unit_cost: Option<f64>,
    pub(crate) batch_number: Option<String>,
    /// `toISOString()` of the expiry `Date`.
    pub(crate) expiry_date: Option<String>,
    pub(crate) source_type: Option<String>,
    pub(crate) source_id: Option<String>,
    pub(crate) source_number: Option<String>,
    pub(crate) performed_by: Option<String>,
}

/// `StockChangeResult`.
#[derive(Debug, Clone)]
pub(crate) struct StockResult {
    pub(crate) inventory_id: String,
    pub(crate) adjustment_id: String,
    pub(crate) previous_quantity: i64,
    pub(crate) new_quantity: i64,
    pub(crate) product_quantity: i64,
}

/// A key part as the bucket match reads it: `key.x ? eq(x) : isNull(x)`.
fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|value| !value.is_empty())
}

/// A product row as the ledger reads it: sku and the three flags.
type ProductRow = (Option<String>, Option<bool>, Option<bool>, Option<bool>);

struct Product {
    sku: Option<String>,
    track_lots: bool,
    track_expiry: bool,
    allow_backorder: bool,
}

async fn load_product(db: &PgPool, product_id: &str) -> Result<Product, LedgerError> {
    let row: Option<ProductRow> = sqlx::query_as(
        "select sku, track_lots, track_expiry, allow_backorder from products \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(product_id)
    .fetch_optional(db)
    .await?;
    let Some((sku, track_lots, track_expiry, allow_backorder)) = row else {
        return Err(stock(
            "PRODUCT_NOT_FOUND",
            format!("Product {product_id} not found"),
        ));
    };
    Ok(Product {
        sku,
        track_lots: track_lots.unwrap_or(false),
        track_expiry: track_expiry.unwrap_or(false),
        allow_backorder: allow_backorder.unwrap_or(false),
    })
}

/// Traceability is enforced only on receipt.
fn assert_receipt_traceability(
    product: &Product,
    product_id: &str,
    change: &StockChange,
) -> Result<(), LedgerError> {
    if change.delta <= 0 {
        return Ok(());
    }
    let label = product.sku.as_deref().unwrap_or(product_id);
    if product.track_lots && truthy(change.lot_number.as_ref()).is_none() {
        return Err(stock(
            "LOT_REQUIRED",
            format!("Product {label} is lot-tracked — lotNumber is required when receiving stock"),
        ));
    }
    if product.track_expiry && change.expiry_date.is_none() {
        return Err(stock(
            "EXPIRY_REQUIRED",
            format!(
                "Product {label} is expiry-tracked — expiryDate is required when receiving stock"
            ),
        ));
    }
    Ok(())
}

/// The bucket match (`matchStockKey`) at `$1`–`$5`.
macro_rules! bucket {
    () => {
        "t.product_id = $1 and t.warehouse_id = $2 \
         and (case when $3::text is null then t.variant_id is null else t.variant_id = $3 end) \
         and (case when $4::text is null then t.location_id is null else t.location_id = $4 end) \
         and (case when $5::text is null then t.lot_number is null else t.lot_number = $5 end) \
         and t.deleted_at is null"
    };
}

/// The moving-average cost (`movingAverageCost`): `$7` whether it applies,
/// `$8` the incoming unit cost, `$9` their value, `$6` the delta.
macro_rules! cost {
    () => {
        "(case when $7::boolean then round((greatest(t.quantity_on_hand, 0) * coalesce(t.unit_cost, $8::numeric) + $9::numeric) / nullif(greatest(t.quantity_on_hand, 0) + $6::numeric, 0), 2) else t.unit_cost end)"
    };
}

/// The increment: `$10` the expiry, `$11` whether it is a receipt, `$12`
/// now, `$13` whether the oversell guard applies, `$14` the units it needs.
const INCREMENT: &str = concat!(
    "update inventory t set quantity_on_hand = t.quantity_on_hand + $6, ",
    "quantity_available = t.quantity_on_hand + $6 - coalesce(t.quantity_allocated, 0), ",
    "unit_cost = ",
    cost!(),
    ", total_value = round(coalesce(",
    cost!(),
    ", 0) * (t.quantity_on_hand + $6::numeric), 2), ",
    "expiry_date = coalesce($10::timestamp, t.expiry_date), ",
    "received_date = case when $11::boolean then $12::timestamp else t.received_date end, ",
    "updated_at = $12::timestamp where ",
    bucket!(),
    " and (not $13::boolean or t.quantity_on_hand >= $14) returning t.id, t.quantity_on_hand"
);

const FIND_BUCKET: &str = concat!(
    "select t.id, t.quantity_on_hand from inventory t where ",
    bucket!(),
    " and $6::bigint is not null limit 1"
);

struct Keys<'a> {
    product_id: &'a str,
    warehouse_id: &'a str,
    variant: Option<&'a str>,
    location: Option<&'a str>,
    lot: Option<&'a str>,
}

/// The increment's parameters.
struct Increment {
    delta: i64,
    averaged: bool,
    unit_cost: Option<String>,
    receipt_value: Option<String>,
    expiry: Option<String>,
    now: String,
    guarded: bool,
}

async fn increment(
    db: &PgPool,
    keys: &Keys<'_>,
    inc: &Increment,
) -> Result<Option<(String, i64)>, sqlx::Error> {
    let row: Option<(String, i32)> = sqlx::query_as(INCREMENT)
        .bind(keys.product_id)
        .bind(keys.warehouse_id)
        .bind(keys.variant)
        .bind(keys.location)
        .bind(keys.lot)
        .bind(inc.delta)
        .bind(inc.averaged)
        .bind(inc.unit_cost.as_deref())
        .bind(inc.receipt_value.as_deref())
        .bind(inc.expiry.as_deref())
        .bind(inc.delta > 0)
        .bind(&inc.now)
        .bind(inc.guarded)
        .bind(-inc.delta)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(id, quantity)| (id, i64::from(quantity))))
}

async fn find_bucket(
    db: &PgPool,
    keys: &Keys<'_>,
) -> Result<Option<(String, Option<i32>)>, sqlx::Error> {
    sqlx::query_as(FIND_BUCKET)
        .bind(keys.product_id)
        .bind(keys.warehouse_id)
        .bind(keys.variant)
        .bind(keys.location)
        .bind(keys.lot)
        .bind(0_i64)
        .fetch_optional(db)
        .await
}

/// Insert a fresh bucket for a first receipt; `None` when a concurrent
/// creator won `inventory_bucket_unique`.
async fn insert_bucket(
    db: &PgPool,
    change: &StockChange,
    now: &str,
) -> Result<Option<(String, i64)>, sqlx::Error> {
    let unit_cost = change.unit_cost;
    let row: Option<(String, i32)> = sqlx::query_as(
        "insert into inventory as t (id, product_id, variant_id, warehouse_id, location_id, lot_number, \
         batch_number, expiry_date, quantity_on_hand, quantity_allocated, quantity_available, \
         quantity_incoming, quantity_outgoing, unit_cost, total_value, status, received_date, \
         created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9, 0, $9, 0, 0, \
         $10::numeric, $11::numeric, 'available', $12::timestamp, $13::timestamp, $13::timestamp) \
         on conflict (product_id, warehouse_id, variant_id, location_id, lot_number) \
         where deleted_at is null do nothing returning t.id, t.quantity_on_hand",
    )
    .bind(generate_id("inv"))
    .bind(&change.product_id)
    .bind(change.variant_id.as_deref())
    .bind(&change.warehouse_id)
    .bind(change.location_id.as_deref())
    .bind(change.lot_number.as_deref())
    .bind(change.batch_number.as_deref())
    .bind(change.expiry_date.as_deref())
    .bind(change.delta)
    .bind(unit_cost.map(number_text))
    .bind(unit_cost.map(|cost| {
        #[allow(clippy::cast_precision_loss)]
        let value = cost * change.delta as f64;
        to_fixed_2(value)
    }))
    .bind((change.delta > 0).then_some(now))
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, quantity)| (id, i64::from(quantity))))
}

/// The audit row and the roll-ups, in one transaction (`atomically`).
#[allow(clippy::too_many_arguments)]
async fn audit_and_roll_up(
    db: &PgPool,
    adjustment_id: &str,
    inventory_id: &str,
    product_id: &str,
    variant_id: Option<&str>,
    warehouse_id: &str,
    location_id: Option<&str>,
    lot_number: Option<&str>,
    audit: &Audit<'_>,
    now: &str,
) -> Result<(), sqlx::Error> {
    let insert = sqlx::query(
        "insert into stock_adjustments (id, product_id, variant_id, warehouse_id, location_id, \
         inventory_id, type, previous_quantity, adjustment_quantity, new_quantity, lot_number, \
         batch_number, reason, reason_code, notes, performed_by, performed_by_name, source_type, \
         source_id, source_number, requires_approval, approval_status, created_at) values \
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, \
         $20, 0, 'approved', $21::timestamp)",
    )
    .bind(adjustment_id)
    .bind(product_id)
    .bind(variant_id)
    .bind(warehouse_id)
    .bind(location_id)
    .bind(inventory_id)
    .bind(audit.kind)
    .bind(audit.previous)
    .bind(audit.adjustment)
    .bind(audit.new)
    .bind(lot_number)
    .bind(audit.batch_number)
    .bind(audit.reason)
    .bind(audit.reason_code)
    .bind(audit.notes)
    .bind(audit.performed_by)
    .bind(None::<&str>)
    .bind(audit.source_type)
    .bind(audit.source_id)
    .bind(audit.source_number)
    .bind(now);
    let products = sqlx::query(
        "update products set inventory_quantity = (select coalesce(sum(i.quantity_on_hand), 0) \
         from inventory i where i.product_id = $1 and i.deleted_at is null), \
         updated_at = $2::timestamp where id = $1",
    )
    .bind(product_id)
    .bind(now);
    let mut statements = vec![insert, products];
    if let Some(variant) = variant_id.filter(|variant| !variant.is_empty()) {
        statements.push(
            sqlx::query(
                "update product_variants set inventory_quantity = (select coalesce(sum(i.quantity_on_hand), 0) \
                 from inventory i where i.variant_id = $1 and i.deleted_at is null), \
                 updated_at = $2::timestamp where id = $1",
            )
            .bind(variant)
            .bind(now),
        );
    }
    weldsuite_db::atomically(db, statements).await.map(|_| ())
}

/// What the audit row records besides the bucket.
struct Audit<'a> {
    kind: &'a str,
    previous: i64,
    adjustment: i64,
    new: i64,
    batch_number: Option<&'a str>,
    reason: Option<&'a str>,
    reason_code: Option<&'a str>,
    notes: Option<&'a str>,
    performed_by: Option<&'a str>,
    source_type: &'a str,
    source_id: Option<&'a str>,
    source_number: Option<&'a str>,
}

async fn product_quantity(db: &PgPool, product_id: &str) -> Result<i64, sqlx::Error> {
    let row: Option<(Option<i32>,)> =
        sqlx::query_as("select inventory_quantity from products where id = $1 limit 1")
            .bind(product_id)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|(quantity,)| quantity).map_or(0, i64::from))
}

/// `applyStockChange`: apply a signed change to one bucket, write the audit
/// row and refresh the roll-ups.
pub(crate) async fn apply_stock_change(
    db: &PgPool,
    change: &StockChange,
) -> Result<StockResult, LedgerError> {
    if change.delta == 0 {
        return Err(stock("INVALID_DELTA", "Adjustment delta must not be zero"));
    }
    let now = crate::now();
    let product = load_product(db, &change.product_id).await?;
    assert_receipt_traceability(&product, &change.product_id, change)?;
    let keys = Keys {
        product_id: &change.product_id,
        warehouse_id: &change.warehouse_id,
        variant: truthy(change.variant_id.as_ref()),
        location: truthy(change.location_id.as_ref()),
        lot: truthy(change.lot_number.as_ref()),
    };
    let averaged = change.delta > 0 && change.unit_cost.is_some();
    #[allow(clippy::cast_precision_loss)]
    let inc = Increment {
        delta: change.delta,
        averaged,
        unit_cost: change.unit_cost.filter(|_| averaged).map(number_text),
        receipt_value: change
            .unit_cost
            .filter(|_| averaged)
            .map(|cost| number_text(change.delta as f64 * cost)),
        expiry: change.expiry_date.clone(),
        now: now.clone(),
        guarded: change.delta < 0 && !product.allow_backorder,
    };
    let (inventory_id, new_quantity) = match increment(db, &keys, &inc).await? {
        Some(updated) => updated,
        None => resolve_missing_bucket(db, change, &product, &keys, &inc, &now).await?,
    };
    let previous_quantity = new_quantity - change.delta;
    let adjustment_id = generate_id("adj");
    audit_and_roll_up(
        db,
        &adjustment_id,
        &inventory_id,
        &change.product_id,
        change.variant_id.as_deref(),
        &change.warehouse_id,
        change.location_id.as_deref(),
        change.lot_number.as_deref(),
        &Audit {
            kind: &change.kind,
            previous: previous_quantity,
            adjustment: change.delta,
            new: new_quantity,
            batch_number: change.batch_number.as_deref(),
            reason: change.reason.as_deref(),
            reason_code: change.reason_code.as_deref(),
            notes: change.notes.as_deref(),
            performed_by: change.performed_by.as_deref(),
            source_type: change.source_type.as_deref().unwrap_or("manual"),
            source_id: change.source_id.as_deref(),
            source_number: change.source_number.as_deref(),
        },
        &now,
    )
    .await?;
    let product_quantity = product_quantity(db, &change.product_id).await?;
    Ok(StockResult {
        inventory_id,
        adjustment_id,
        previous_quantity,
        new_quantity,
        product_quantity,
    })
}

/// The increment matched nothing: a missing bucket (create it), or one the
/// oversell guard refused.
async fn resolve_missing_bucket(
    db: &PgPool,
    change: &StockChange,
    product: &Product,
    keys: &Keys<'_>,
    inc: &Increment,
    now: &str,
) -> Result<(String, i64), LedgerError> {
    if let Some((_, on_hand)) = find_bucket(db, keys).await? {
        return Err(insufficient_stock(
            on_hand.map_or(0, i64::from),
            change.delta,
        ));
    }
    if change.delta < 0 && !product.allow_backorder {
        return Err(insufficient_stock(0, change.delta));
    }
    if let Some(created) = insert_bucket(db, change, now).await? {
        return Ok(created);
    }
    if let Some(retried) = increment(db, keys, inc).await? {
        return Ok(retried);
    }
    let raced = find_bucket(db, keys).await?;
    let on_hand = raced.and_then(|(_, on_hand)| on_hand).map_or(0, i64::from);
    Err(insufficient_stock(on_hand, change.delta))
}

/// One end of a transfer.
#[derive(Debug, Clone)]
pub(crate) struct Endpoint {
    pub(crate) warehouse_id: String,
    pub(crate) location_id: Option<String>,
    pub(crate) lot_number: Option<String>,
}

/// `TransferParams`.
#[derive(Debug, Clone)]
pub(crate) struct Transfer {
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) quantity: i64,
    pub(crate) from: Endpoint,
    pub(crate) to: Endpoint,
    pub(crate) reason: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) performed_by: Option<String>,
}

/// `TransferResult`.
pub(crate) struct TransferResult {
    pub(crate) movement_id: String,
    pub(crate) movement_number: String,
    pub(crate) out: StockResult,
    pub(crate) into: StockResult,
}

/// `transferStock`: debit the source, credit the destination (compensating
/// the debit if the credit fails), and record one `inventory_movements` row.
#[allow(clippy::too_many_lines)] // one statement per step, as the TypeScript
pub(crate) async fn transfer_stock(
    db: &PgPool,
    transfer: &Transfer,
) -> Result<TransferResult, LedgerError> {
    if transfer.quantity <= 0 {
        return Err(stock("INVALID_DELTA", "Transfer quantity must be positive"));
    }
    let to_lot = transfer
        .to
        .lot_number
        .clone()
        .or_else(|| transfer.from.lot_number.clone());
    let same_bucket = transfer.from.warehouse_id == transfer.to.warehouse_id
        && transfer.from.location_id == transfer.to.location_id
        && transfer.from.lot_number == to_lot;
    if same_bucket {
        return Err(stock(
            "SAME_LOCATION",
            "Source and destination are the same location",
        ));
    }
    let now = crate::now();
    let now_ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let movement_id = generate_id("mov");
    let suffix: String = {
        let chars: Vec<char> = movement_id.chars().collect();
        chars[chars.len().saturating_sub(6)..]
            .iter()
            .collect::<String>()
            .to_uppercase()
    };
    let movement_number = format!(
        "TRF-{}-{suffix}",
        base36_upper(u128::try_from(now_ms).unwrap_or(0))
    );
    let leg = |warehouse: &Endpoint, lot: Option<String>, delta: i64, kind: &str| StockChange {
        product_id: transfer.product_id.clone(),
        variant_id: transfer.variant_id.clone(),
        warehouse_id: warehouse.warehouse_id.clone(),
        location_id: warehouse.location_id.clone(),
        lot_number: lot,
        delta,
        kind: kind.to_owned(),
        reason: transfer.reason.clone(),
        notes: transfer.notes.clone(),
        source_type: Some("transfer".to_owned()),
        source_id: Some(movement_id.clone()),
        source_number: Some(movement_number.clone()),
        performed_by: transfer.performed_by.clone(),
        ..StockChange::default()
    };
    let out = apply_stock_change(
        db,
        &leg(
            &transfer.from,
            transfer.from.lot_number.clone(),
            -transfer.quantity,
            "transfer_out",
        ),
    )
    .await?;
    let into = match apply_stock_change(
        db,
        &leg(&transfer.to, to_lot, transfer.quantity, "transfer_in"),
    )
    .await
    {
        Ok(into) => into,
        Err(error) => {
            let mut compensation = leg(
                &transfer.from,
                transfer.from.lot_number.clone(),
                transfer.quantity,
                "correction",
            );
            compensation.reason = Some(format!(
                "Compensating reversal for failed transfer {movement_number}"
            ));
            compensation.notes = None;
            if let Err(compensation_error) = apply_stock_change(db, &compensation).await {
                tracing::error!(
                    error = %compensation_error,
                    "[inventory-ledger] transfer {movement_number} failed AND compensation failed — \
                     {} units of {} are debited from {}/{} with no matching credit",
                    transfer.quantity,
                    weldsuite_kit::log_safe(&transfer.product_id),
                    weldsuite_kit::log_safe(&transfer.from.warehouse_id),
                    weldsuite_kit::log_safe(transfer.from.location_id.as_deref().unwrap_or("unlocated")),
                );
            }
            return Err(error);
        }
    };
    let product: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, sku from products where id = $1 limit 1")
            .bind(&transfer.product_id)
            .fetch_optional(db)
            .await?;
    let (name, sku) = product.unwrap_or((None, None));
    sqlx::query(
        "insert into inventory_movements (id, movement_number, movement_type, status, \
         source_warehouse_id, source_location_id, dest_warehouse_id, dest_location_id, product_id, \
         variant_id, sku, name, quantity, lot_number, source_type, reason, notes, created_by, \
         completed_by, started_at, completed_at, created_at, updated_at) values ($1, $2, 'transfer', \
         'completed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'manual', $13, $14, $15, $15, \
         $16::timestamp, $16::timestamp, $16::timestamp, $16::timestamp)",
    )
    .bind(&movement_id)
    .bind(&movement_number)
    .bind(&transfer.from.warehouse_id)
    .bind(transfer.from.location_id.as_deref())
    .bind(&transfer.to.warehouse_id)
    .bind(transfer.to.location_id.as_deref())
    .bind(&transfer.product_id)
    .bind(transfer.variant_id.as_deref())
    .bind(sku)
    .bind(name)
    .bind(transfer.quantity)
    .bind(transfer.from.lot_number.as_deref())
    .bind(transfer.reason.as_deref())
    .bind(transfer.notes.as_deref())
    .bind(transfer.performed_by.as_deref())
    .bind(&now)
    .execute(db)
    .await?;
    Ok(TransferResult {
        movement_id,
        movement_number,
        out,
        into,
    })
}

/// `allocateStock`: reserve units on a bucket.
pub(crate) async fn allocate_stock(
    db: &PgPool,
    inventory_id: &str,
    quantity: i64,
) -> Result<(), LedgerError> {
    if quantity <= 0 {
        return Err(stock(
            "INVALID_DELTA",
            "Allocation quantity must be positive",
        ));
    }
    let updated: Option<(String,)> = sqlx::query_as(
        "update inventory t set quantity_allocated = coalesce(t.quantity_allocated, 0) + $2, \
         quantity_available = t.quantity_on_hand - (coalesce(t.quantity_allocated, 0) + $2), \
         updated_at = $3::timestamp where t.id = $1 and t.deleted_at is null \
         and t.quantity_on_hand - coalesce(t.quantity_allocated, 0) >= $2 returning t.id",
    )
    .bind(inventory_id)
    .bind(quantity)
    .bind(crate::now())
    .fetch_optional(db)
    .await?;
    if updated.is_some() {
        return Ok(());
    }
    let existing: Option<(Option<i32>, Option<i32>)> = sqlx::query_as(
        "select quantity_on_hand, quantity_allocated from inventory where id = $1 and deleted_at is null limit 1",
    )
    .bind(inventory_id)
    .fetch_optional(db)
    .await?;
    let Some((on_hand, allocated)) = existing else {
        return Err(stock(
            "PRODUCT_NOT_FOUND",
            format!("Inventory {inventory_id} not found"),
        ));
    };
    let available = i64::from(on_hand.unwrap_or(0)) - i64::from(allocated.unwrap_or(0));
    Err(stock(
        "INSUFFICIENT_AVAILABLE",
        format!("Insufficient available stock: {available} available, {quantity} requested"),
    ))
}

/// `releaseAllocation`: give back a reservation.
pub(crate) async fn release_allocation(
    db: &PgPool,
    inventory_id: &str,
    quantity: i64,
) -> Result<(), LedgerError> {
    if quantity <= 0 {
        return Err(stock("INVALID_DELTA", "Release quantity must be positive"));
    }
    let updated: Option<(String,)> = sqlx::query_as(
        "update inventory t set quantity_allocated = coalesce(t.quantity_allocated, 0) - $2, \
         quantity_available = t.quantity_on_hand - (coalesce(t.quantity_allocated, 0) - $2), \
         updated_at = $3::timestamp where t.id = $1 and t.deleted_at is null \
         and coalesce(t.quantity_allocated, 0) >= $2 returning t.id",
    )
    .bind(inventory_id)
    .bind(quantity)
    .bind(crate::now())
    .fetch_optional(db)
    .await?;
    if updated.is_some() {
        return Ok(());
    }
    let existing: Option<(Option<i32>,)> = sqlx::query_as(
        "select quantity_allocated from inventory where id = $1 and deleted_at is null limit 1",
    )
    .bind(inventory_id)
    .fetch_optional(db)
    .await?;
    let allocated = existing.and_then(|(allocated,)| allocated).unwrap_or(0);
    Err(stock(
        "INSUFFICIENT_ALLOCATION",
        format!("Insufficient allocation: {allocated} allocated, {quantity} to release"),
    ))
}

/// What a shipped line records (`IssueAllocatedParams`).
pub(crate) struct Issue<'a> {
    pub(crate) inventory_id: &'a str,
    pub(crate) quantity: i64,
    pub(crate) source_id: &'a str,
    pub(crate) source_number: &'a str,
    pub(crate) reason: String,
    pub(crate) performed_by: Option<&'a str>,
}

/// `issueAllocatedStock`: turn a reservation into a shipment.
pub(crate) async fn issue_allocated_stock(
    db: &PgPool,
    issue: &Issue<'_>,
) -> Result<(), LedgerError> {
    if issue.quantity <= 0 {
        return Err(stock("INVALID_DELTA", "Issue quantity must be positive"));
    }
    let now = crate::now();
    let row: Option<Value> = sqlx::query_scalar(
        "update inventory t set quantity_on_hand = t.quantity_on_hand - $2, \
         quantity_allocated = coalesce(t.quantity_allocated, 0) - $2, \
         quantity_available = (t.quantity_on_hand - $2) - (coalesce(t.quantity_allocated, 0) - $2), \
         total_value = round(coalesce(t.unit_cost, 0) * (t.quantity_on_hand - $2::numeric), 2), \
         updated_at = $3::timestamp where t.id = $1 and t.deleted_at is null \
         and t.quantity_on_hand >= $2 and coalesce(t.quantity_allocated, 0) >= $2 \
         returning jsonb_build_object('id', t.id, 'productId', t.product_id, 'variantId', t.variant_id, \
         'warehouseId', t.warehouse_id, 'locationId', t.location_id, 'lotNumber', t.lot_number, \
         'quantityOnHand', t.quantity_on_hand)",
    )
    .bind(issue.inventory_id)
    .bind(issue.quantity)
    .bind(&now)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        let existing: Option<(Option<i32>, Option<i32>)> = sqlx::query_as(
            "select quantity_on_hand, quantity_allocated from inventory where id = $1 and deleted_at is null limit 1",
        )
        .bind(issue.inventory_id)
        .fetch_optional(db)
        .await?;
        let Some((on_hand, allocated)) = existing else {
            return Err(stock(
                "PRODUCT_NOT_FOUND",
                format!("Inventory {} not found", issue.inventory_id),
            ));
        };
        let allocated = i64::from(allocated.unwrap_or(0));
        if allocated < issue.quantity {
            return Err(stock(
                "INSUFFICIENT_ALLOCATION",
                format!(
                    "Insufficient allocation: {allocated} allocated, {} to ship",
                    issue.quantity
                ),
            ));
        }
        return Err(stock(
            "INSUFFICIENT_STOCK",
            format!(
                "Insufficient stock: {} on hand, {} requested",
                on_hand.unwrap_or(0),
                issue.quantity
            ),
        ));
    };
    let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    let new_quantity = row
        .get("quantityOnHand")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let product_id = text("productId").unwrap_or_default();
    let variant_id = text("variantId");
    let location_id = text("locationId");
    let lot_number = text("lotNumber");
    audit_and_roll_up(
        db,
        &generate_id("adj"),
        issue.inventory_id,
        &product_id,
        variant_id.as_deref(),
        &text("warehouseId").unwrap_or_default(),
        location_id.as_deref(),
        lot_number.as_deref(),
        &Audit {
            kind: "shipped",
            previous: new_quantity + issue.quantity,
            adjustment: -issue.quantity,
            new: new_quantity,
            batch_number: None,
            reason: Some(&issue.reason),
            reason_code: None,
            notes: None,
            performed_by: issue.performed_by,
            source_type: "pick_list",
            source_id: Some(issue.source_id),
            source_number: Some(issue.source_number),
        },
        &now,
    )
    .await?;
    Ok(())
}
