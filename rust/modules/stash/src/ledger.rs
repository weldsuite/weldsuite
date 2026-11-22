//! The inventory ledger (`services/inventory-ledger.ts`): the single write
//! path for stock quantities. Every change to `inventory.quantity_on_hand`
//! is an increment inside the database (no lost updates), leaves an audit
//! row in `stock_adjustments`, and recomputes the `products` and
//! `product_variants` roll-ups. The statements are the TypeScript ones, in
//! the same order, so the same races resolve the same way: a first receipt
//! that loses `inventory_bucket_unique` re-runs its increment.
//!
//! A warehouse another system owns (`warehouses.managed_by_connection_id`,
//! an Odoo connection's, ADR STASH-010) is read-only here: every write path
//! refuses it with [`WAREHOUSE_MANAGED`] before it changes anything. That
//! connection's sync writes those buckets itself. A warehouse without the
//! column set goes through exactly as before.

use std::str::FromStr;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, OnConflict, Query, SelectStatement};
use sea_orm::{
    ActiveValue, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, JoinType,
    QueryFilter, QuerySelect,
};
use sqlx::{Acquire, PgConnection, Postgres};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    inventory, inventory_movements, product_variants, products, stock_adjustments, warehouses,
};

use crate::args::timestamp_of;
use crate::js::{base36_upper, number_text, to_fixed_2};

/// A condition the caller can fix (`StockLedgerError`): routes answer 404,
/// 409 or 400 with its message and code.
#[derive(Debug)]
pub(crate) enum LedgerError {
    Stock { code: &'static str, message: String },
    Database(DbErr),
}

impl From<DbErr> for LedgerError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// A transaction that fails to begin or commit (`atomically_with`).
impl From<sqlx::Error> for LedgerError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(weldsuite_db::orm_error(error))
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

/// A value the statement could not take (an integer column given more than
/// it holds): Postgres's refusal, the route's 500.
fn out_of_range(what: &str) -> DbErr {
    DbErr::Type(format!("{what}: integer out of range"))
}

/// The code of a refused change to a warehouse another system owns.
pub(crate) const WAREHOUSE_MANAGED: &str = "WAREHOUSE_MANAGED";

/// Its message, which the routes answer with (400).
pub(crate) const WAREHOUSE_MANAGED_MESSAGE: &str =
    "This warehouse's stock is managed by another system";

/// The refusal for a warehouse another system owns.
pub(crate) fn managed_warehouse() -> LedgerError {
    stock(WAREHOUSE_MANAGED, WAREHOUSE_MANAGED_MESSAGE)
}

/// Whether `warehouse_id` is owned by a connection
/// (`managed_by_connection_id` set and not empty). An unknown warehouse is
/// not: the ledger has never checked that a warehouse exists.
pub(crate) async fn warehouse_is_managed(db: &PgPool, warehouse_id: &str) -> Result<bool, DbErr> {
    warehouse_managed_on(&orm(db), warehouse_id).await
}

/// [`warehouse_is_managed`] on a SeaORM connection.
async fn warehouse_managed_on<C: ConnectionTrait>(
    db: &C,
    warehouse_id: &str,
) -> Result<bool, DbErr> {
    let owner: Option<Option<String>> = warehouses::Entity::find()
        .select_only()
        .column(warehouses::Column::ManagedByConnectionId)
        .filter(warehouses::Column::Id.eq(warehouse_id))
        .into_tuple()
        .one(db)
        .await?;
    Ok(owned(owner.flatten()))
}

/// `coalesce(managed_by_connection_id, '') <> ''`, false without a row.
fn owned(owner: Option<String>) -> bool {
    owner.is_some_and(|owner| !owner.is_empty())
}

/// Whether the warehouse of the bucket `inventory_id` is owned by a
/// connection. An unknown bucket is not (the caller's own lookup answers it).
pub(crate) async fn bucket_is_managed(db: &PgPool, inventory_id: &str) -> Result<bool, DbErr> {
    let owner: Option<Option<String>> = inventory::Entity::find()
        .select_only()
        .column(warehouses::Column::ManagedByConnectionId)
        .join(
            JoinType::InnerJoin,
            inventory::Entity::belongs_to(warehouses::Entity)
                .from(inventory::Column::WarehouseId)
                .to(warehouses::Column::Id)
                .into(),
        )
        .filter(inventory::Column::Id.eq(inventory_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(owned(owner.flatten()))
}

async fn refuse_managed<C: ConnectionTrait>(
    db: &C,
    warehouse_id: &str,
) -> Result<(), LedgerError> {
    if warehouse_managed_on(db, warehouse_id).await? {
        return Err(managed_warehouse());
    }
    Ok(())
}

async fn refuse_managed_bucket(db: &PgPool, inventory_id: &str) -> Result<(), LedgerError> {
    if bucket_is_managed(db, inventory_id).await? {
        return Err(managed_warehouse());
    }
    Ok(())
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

async fn load_product<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
) -> Result<Product, LedgerError> {
    use products::Column;
    let row: Option<ProductRow> = products::Entity::find()
        .select_only()
        .columns([
            Column::Sku,
            Column::TrackLots,
            Column::TrackExpiry,
            Column::AllowBackorder,
        ])
        .filter(Column::Id.eq(product_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
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

struct Keys<'a> {
    product_id: &'a str,
    warehouse_id: &'a str,
    variant: Option<&'a str>,
    location: Option<&'a str>,
    lot: Option<&'a str>,
}

impl Keys<'_> {
    /// The bucket match (`matchStockKey`): `key.x ? eq(x) : isNull(x)` for
    /// the variant, location and lot, on a live row.
    fn bucket(&self) -> Condition {
        use inventory::Column;
        Condition::all()
            .add(Column::ProductId.eq(self.product_id))
            .add(Column::WarehouseId.eq(self.warehouse_id))
            .add(Column::VariantId.eq(self.variant))
            .add(Column::LocationId.eq(self.location))
            .add(Column::LotNumber.eq(self.lot))
            .add(Column::DeletedAt.is_null())
    }
}

/// The increment's parameters.
struct Increment {
    delta: i64,
    /// The incoming unit cost and the receipt's value (`delta × cost`), as
    /// JavaScript prints them, when the moving average applies.
    averaged: Option<(String, String)>,
    /// The expiry the change brings, if any.
    expiry: Option<PrimitiveDateTime>,
    now: PrimitiveDateTime,
    guarded: bool,
}

/// `$n::numeric` of the text JavaScript printed a number as.
fn numeric(text: &str) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::val(text).cast_as("numeric")
}

/// The moving-average cost (`movingAverageCost`) when the receipt carries a
/// cost, else the bucket's own:
/// `round((greatest(onHand, 0) × coalesce(unitCost, cost) + value) /
/// nullif(greatest(onHand, 0) + delta, 0), 2)`.
fn moving_cost(inc: &Increment) -> Expr {
    use sea_orm::ExprTrait as _;
    let Some((cost, value)) = &inc.averaged else {
        return inventory::Column::UnitCost.into_expr();
    };
    let held = || {
        Expr::from(Func::greatest([
            inventory::Column::QuantityOnHand.into_expr(),
            Expr::val(0),
        ]))
    };
    let units = held().add(Expr::val(inc.delta).cast_as("numeric"));
    Func::round_with_precision(
        held()
            .mul(Func::coalesce([
                inventory::Column::UnitCost.into_expr(),
                numeric(cost),
            ]))
            .add(numeric(value))
            .div(Func::cust("nullif").arg(units).arg(0)),
        2,
    )
    .into()
}

async fn increment<C: ConnectionTrait>(
    db: &C,
    keys: &Keys<'_>,
    inc: &Increment,
) -> Result<Option<(String, i64)>, DbErr> {
    use inventory::Column;
    use sea_orm::ExprTrait as _;
    let on_hand = || Column::QuantityOnHand.into_expr();
    let allocated = Func::coalesce([Column::QuantityAllocated.into_expr(), Expr::val(0)]);
    let cost = moving_cost(inc);
    let mut update = inventory::Entity::update_many()
        .col_expr(Column::QuantityOnHand, on_hand().add(inc.delta))
        .col_expr(
            Column::QuantityAvailable,
            on_hand().add(inc.delta).sub(allocated),
        );
    if inc.averaged.is_some() {
        update = update.col_expr(Column::UnitCost, cost.clone());
    }
    update = update.col_expr(
        Column::TotalValue,
        Func::round_with_precision(
            Expr::from(Func::coalesce([cost, Expr::val(0)]))
                .mul(on_hand().add(Expr::val(inc.delta).cast_as("numeric"))),
            2,
        )
        .into(),
    );
    if let Some(expiry) = inc.expiry {
        update = update.col_expr(Column::ExpiryDate, Expr::value(expiry));
    }
    if inc.delta > 0 {
        update = update.col_expr(Column::ReceivedDate, Expr::value(inc.now));
    }
    let mut filter = keys.bucket();
    if inc.guarded {
        filter = filter.add(Column::QuantityOnHand.gte(-inc.delta));
    }
    let rows = update
        .col_expr(Column::UpdatedAt, Expr::value(inc.now))
        .filter(filter)
        .exec_with_returning(db)
        .await?;
    Ok(rows
        .into_iter()
        .next()
        .map(|row| (row.id, i64::from(row.quantity_on_hand))))
}

async fn find_bucket<C: ConnectionTrait>(
    db: &C,
    keys: &Keys<'_>,
) -> Result<Option<(String, Option<i32>)>, DbErr> {
    inventory::Entity::find()
        .select_only()
        .columns([inventory::Column::Id, inventory::Column::QuantityOnHand])
        .filter(keys.bucket())
        .into_tuple()
        .one(db)
        .await
}

/// Insert a fresh bucket for a first receipt; `None` when a concurrent
/// creator won `inventory_bucket_unique`.
async fn insert_bucket<C: ConnectionTrait>(
    db: &C,
    change: &StockChange,
    now: PrimitiveDateTime,
) -> Result<Option<(String, i64)>, DbErr> {
    use inventory::Column;
    use sea_orm::ExprTrait as _;
    let units = i32::try_from(change.delta).map_err(|_| out_of_range("quantity_on_hand"))?;
    let expiry = change.expiry_date.as_deref().map(timestamp_of).transpose()?;
    let decimal = |text: String| {
        BigDecimal::from_str(&text)
            .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: \"{text}\"")))
    };
    let unit_cost = change.unit_cost.map(number_text).map(decimal).transpose()?;
    let total_value = change
        .unit_cost
        .map(|cost| {
            #[allow(clippy::cast_precision_loss)]
            let value = cost * change.delta as f64;
            decimal(to_fixed_2(value))
        })
        .transpose()?;
    let bucket = inventory::ActiveModel {
        id: ActiveValue::Set(generate_id("inv")),
        product_id: ActiveValue::Set(change.product_id.clone()),
        variant_id: ActiveValue::Set(change.variant_id.clone()),
        warehouse_id: ActiveValue::Set(change.warehouse_id.clone()),
        location_id: ActiveValue::Set(change.location_id.clone()),
        lot_number: ActiveValue::Set(change.lot_number.clone()),
        batch_number: ActiveValue::Set(change.batch_number.clone()),
        expiry_date: ActiveValue::Set(expiry),
        quantity_on_hand: ActiveValue::Set(units),
        quantity_allocated: ActiveValue::Set(Some(0)),
        quantity_available: ActiveValue::Set(Some(units)),
        quantity_incoming: ActiveValue::Set(Some(0)),
        quantity_outgoing: ActiveValue::Set(Some(0)),
        unit_cost: ActiveValue::Set(unit_cost),
        total_value: ActiveValue::Set(total_value),
        status: ActiveValue::Set(Some("available".to_owned())),
        received_date: ActiveValue::Set((change.delta > 0).then_some(now)),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    let inserted = inventory::Entity::insert(bucket)
        .on_conflict(
            OnConflict::columns([
                Column::ProductId,
                Column::WarehouseId,
                Column::VariantId,
                Column::LocationId,
                Column::LotNumber,
            ])
            .target_and_where(Expr::col(Column::DeletedAt).is_null())
            .do_nothing()
            .to_owned(),
        )
        .try_insert()
        .exec_with_returning(db)
        .await?;
    Ok(match inserted {
        sea_orm::TryInsertResult::Inserted(row) => {
            Some((row.id, i64::from(row.quantity_on_hand)))
        }
        sea_orm::TryInsertResult::Empty | sea_orm::TryInsertResult::Conflicted => None,
    })
}

/// `(select coalesce(sum(i.quantity_on_hand), 0) from inventory i where
/// i.<column> = id and i.deleted_at is null)`.
fn on_hand_of(column: inventory::Column, id: &str) -> SelectStatement {
    Query::select()
        .expr(Func::coalesce([
            Expr::from(Func::sum(inventory::Column::QuantityOnHand.into_expr())),
            Expr::val(0),
        ]))
        .from(inventory::Entity)
        .and_where(column.eq(id))
        .and_where(inventory::Column::DeletedAt.is_null())
        .to_owned()
}

/// The audit row and the roll-ups, in one transaction (`atomically`): the
/// statements run in this order.
async fn audit_and_roll_up<'a>(
    db: impl Acquire<'a, Database = Postgres> + Send,
    adjustment: stock_adjustments::ActiveModel,
    product_id: String,
    variant_id: Option<String>,
    now: PrimitiveDateTime,
) -> Result<(), LedgerError> {
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            stock_adjustments::Entity::insert(adjustment)
                .exec_without_returning(&db)
                .await?;
            products::Entity::update_many()
                .col_expr(
                    products::Column::InventoryQuantity,
                    Expr::from(on_hand_of(inventory::Column::ProductId, &product_id)),
                )
                .col_expr(products::Column::UpdatedAt, Expr::value(now))
                .filter(products::Column::Id.eq(product_id.as_str()))
                .exec(&db)
                .await?;
            if let Some(variant) = variant_id.filter(|variant| !variant.is_empty()) {
                product_variants::Entity::update_many()
                    .col_expr(
                        product_variants::Column::InventoryQuantity,
                        Expr::from(on_hand_of(inventory::Column::VariantId, &variant)),
                    )
                    .col_expr(product_variants::Column::UpdatedAt, Expr::value(now))
                    .filter(product_variants::Column::Id.eq(variant.as_str()))
                    .exec(&db)
                    .await?;
            }
            Ok::<_, LedgerError>(())
        })
    })
    .await
}

/// What the audit row records.
struct Audit<'a> {
    inventory_id: &'a str,
    product_id: &'a str,
    variant_id: Option<&'a str>,
    warehouse_id: &'a str,
    location_id: Option<&'a str>,
    lot_number: Option<&'a str>,
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

impl Audit<'_> {
    /// The `stock_adjustments` row `id`, approved, at `now`.
    fn row(
        &self,
        id: &str,
        now: PrimitiveDateTime,
    ) -> Result<stock_adjustments::ActiveModel, DbErr> {
        let int = |value: i64, what: &str| i32::try_from(value).map_err(|_| out_of_range(what));
        let text = |value: Option<&str>| ActiveValue::Set(value.map(str::to_owned));
        Ok(stock_adjustments::ActiveModel {
            id: ActiveValue::Set(id.to_owned()),
            product_id: ActiveValue::Set(self.product_id.to_owned()),
            variant_id: text(self.variant_id),
            warehouse_id: ActiveValue::Set(Some(self.warehouse_id.to_owned())),
            location_id: text(self.location_id),
            inventory_id: ActiveValue::Set(Some(self.inventory_id.to_owned())),
            type_: ActiveValue::Set(self.kind.to_owned()),
            previous_quantity: ActiveValue::Set(int(self.previous, "previous_quantity")?),
            adjustment_quantity: ActiveValue::Set(int(self.adjustment, "adjustment_quantity")?),
            new_quantity: ActiveValue::Set(int(self.new, "new_quantity")?),
            lot_number: text(self.lot_number),
            batch_number: text(self.batch_number),
            reason: text(self.reason),
            reason_code: text(self.reason_code),
            notes: text(self.notes),
            performed_by: text(self.performed_by),
            performed_by_name: ActiveValue::Set(None),
            source_type: ActiveValue::Set(Some(self.source_type.to_owned())),
            source_id: text(self.source_id),
            source_number: text(self.source_number),
            requires_approval: ActiveValue::Set(Some(0)),
            approval_status: ActiveValue::Set(Some("approved".to_owned())),
            created_at: ActiveValue::Set(now),
            ..Default::default()
        })
    }
}

async fn product_quantity<C: ConnectionTrait>(db: &C, product_id: &str) -> Result<i64, DbErr> {
    let row: Option<Option<i32>> = products::Entity::find()
        .select_only()
        .column(products::Column::InventoryQuantity)
        .filter(products::Column::Id.eq(product_id))
        .into_tuple()
        .one(db)
        .await?;
    Ok(row.flatten().map_or(0, i64::from))
}

/// Where the ledger's statements run. On the pool ([`apply_stock_change`])
/// each statement runs on its own, as it always has, and the audit row and
/// roll-ups commit together in their own transaction. On a connection inside
/// the caller's transaction ([`apply_stock_change_in`]) everything is part
/// of that transaction, the audit row and roll-ups in a savepoint, so the
/// caller's commit or rollback takes the whole change with it.
pub(crate) trait LedgerDb: Send {
    /// The connection of the next statement.
    fn statement(&mut self) -> impl ConnectionTrait + Send + '_;
    /// Where the audit row and roll-ups commit together.
    fn unit(&mut self) -> impl Acquire<'_, Database = Postgres> + Send;
}

impl LedgerDb for &PgPool {
    fn statement(&mut self) -> impl ConnectionTrait + Send + '_ {
        orm(self)
    }

    fn unit(&mut self) -> impl Acquire<'_, Database = Postgres> + Send {
        *self
    }
}

impl LedgerDb for &mut PgConnection {
    fn statement(&mut self) -> impl ConnectionTrait + Send + '_ {
        OrmConn::new(self)
    }

    fn unit(&mut self) -> impl Acquire<'_, Database = Postgres> + Send {
        &mut **self
    }
}

/// `applyStockChange`: apply a signed change to one bucket, write the audit
/// row and refresh the roll-ups. Each statement runs on the pool on its own.
pub(crate) async fn apply_stock_change(
    db: &PgPool,
    change: &StockChange,
) -> Result<StockResult, LedgerError> {
    apply_on(db, change).await
}

/// [`apply_stock_change`] inside the caller's transaction (`conn` is the
/// transaction's connection): the same statements in the same order, none
/// committed until the caller commits. A refusal or a failed statement
/// leaves the rollback to the caller.
pub(crate) async fn apply_stock_change_in(
    conn: &mut PgConnection,
    change: &StockChange,
) -> Result<StockResult, LedgerError> {
    apply_on(conn, change).await
}

async fn apply_on<D: LedgerDb>(
    mut db: D,
    change: &StockChange,
) -> Result<StockResult, LedgerError> {
    if change.delta == 0 {
        return Err(stock("INVALID_DELTA", "Adjustment delta must not be zero"));
    }
    refuse_managed(&db.statement(), &change.warehouse_id).await?;
    let now = weldsuite_db::utc_now();
    let product = load_product(&db.statement(), &change.product_id).await?;
    assert_receipt_traceability(&product, &change.product_id, change)?;
    let keys = Keys {
        product_id: &change.product_id,
        warehouse_id: &change.warehouse_id,
        variant: truthy(change.variant_id.as_ref()),
        location: truthy(change.location_id.as_ref()),
        lot: truthy(change.lot_number.as_ref()),
    };
    let averaged = change.unit_cost.filter(|_| change.delta > 0).map(|cost| {
        #[allow(clippy::cast_precision_loss)]
        let value = change.delta as f64 * cost;
        (number_text(cost), number_text(value))
    });
    let inc = Increment {
        delta: change.delta,
        averaged,
        expiry: change
            .expiry_date
            .as_deref()
            .map(timestamp_of)
            .transpose()?,
        now,
        guarded: change.delta < 0 && !product.allow_backorder,
    };
    let incremented = increment(&db.statement(), &keys, &inc).await?;
    let (inventory_id, new_quantity) = match incremented {
        Some(updated) => updated,
        None => resolve_missing_bucket(&mut db, change, &product, &keys, &inc).await?,
    };
    let previous_quantity = new_quantity - change.delta;
    let adjustment_id = generate_id("adj");
    let adjustment = Audit {
        inventory_id: &inventory_id,
        product_id: &change.product_id,
        variant_id: change.variant_id.as_deref(),
        warehouse_id: &change.warehouse_id,
        location_id: change.location_id.as_deref(),
        lot_number: change.lot_number.as_deref(),
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
    }
    .row(&adjustment_id, now)?;
    audit_and_roll_up(
        db.unit(),
        adjustment,
        change.product_id.clone(),
        change.variant_id.clone(),
        now,
    )
    .await?;
    let product_quantity = product_quantity(&db.statement(), &change.product_id).await?;
    Ok(StockResult {
        inventory_id,
        adjustment_id,
        previous_quantity,
        new_quantity,
        product_quantity,
    })
}

/// What [`apply_stock_change`] would refuse for the receipt `change` (a
/// positive delta), checked without writing anything: a warehouse another
/// system owns, an unknown product, a missing lot or expiry date. A receive
/// that posts several lines checks them all first, so a refusal leaves no
/// line half posted.
pub(crate) async fn check_receipt(db: &PgPool, change: &StockChange) -> Result<(), LedgerError> {
    let db = orm(db);
    refuse_managed(&db, &change.warehouse_id).await?;
    let product = load_product(&db, &change.product_id).await?;
    assert_receipt_traceability(&product, &change.product_id, change)
}

/// The increment matched nothing: a missing bucket (create it), or one the
/// oversell guard refused.
async fn resolve_missing_bucket<D: LedgerDb>(
    db: &mut D,
    change: &StockChange,
    product: &Product,
    keys: &Keys<'_>,
    inc: &Increment,
) -> Result<(String, i64), LedgerError> {
    if let Some((_, on_hand)) = find_bucket(&db.statement(), keys).await? {
        return Err(insufficient_stock(
            on_hand.map_or(0, i64::from),
            change.delta,
        ));
    }
    if change.delta < 0 && !product.allow_backorder {
        return Err(insufficient_stock(0, change.delta));
    }
    if let Some(created) = insert_bucket(&db.statement(), change, inc.now).await? {
        return Ok(created);
    }
    if let Some(retried) = increment(&db.statement(), keys, inc).await? {
        return Ok(retried);
    }
    let raced = find_bucket(&db.statement(), keys).await?;
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
    // Both ends before the debit, so a managed destination doesn't leave a
    // debit and its compensation behind.
    refuse_managed(&orm(db), &transfer.from.warehouse_id).await?;
    refuse_managed(&orm(db), &transfer.to.warehouse_id).await?;
    let now = weldsuite_db::utc_now();
    let now_ms = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
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
    let db = orm(db);
    let product: Option<(String, Option<String>)> = products::Entity::find()
        .select_only()
        .columns([products::Column::Name, products::Column::Sku])
        .filter(products::Column::Id.eq(transfer.product_id.as_str()))
        .into_tuple()
        .one(&db)
        .await?;
    let (name, sku) = product.map_or((None, None), |(name, sku)| (Some(name), sku));
    let text = |value: Option<&String>| ActiveValue::Set(value.cloned());
    let movement = inventory_movements::ActiveModel {
        id: ActiveValue::Set(movement_id.clone()),
        movement_number: ActiveValue::Set(movement_number.clone()),
        movement_type: ActiveValue::Set("transfer".to_owned()),
        status: ActiveValue::Set("completed".to_owned()),
        source_warehouse_id: ActiveValue::Set(Some(transfer.from.warehouse_id.clone())),
        source_location_id: text(transfer.from.location_id.as_ref()),
        dest_warehouse_id: ActiveValue::Set(Some(transfer.to.warehouse_id.clone())),
        dest_location_id: text(transfer.to.location_id.as_ref()),
        product_id: ActiveValue::Set(transfer.product_id.clone()),
        variant_id: text(transfer.variant_id.as_ref()),
        sku: ActiveValue::Set(sku),
        name: ActiveValue::Set(name),
        quantity: ActiveValue::Set(
            i32::try_from(transfer.quantity).map_err(|_| out_of_range("quantity"))?,
        ),
        lot_number: text(transfer.from.lot_number.as_ref()),
        source_type: ActiveValue::Set(Some("manual".to_owned())),
        reason: text(transfer.reason.as_ref()),
        notes: text(transfer.notes.as_ref()),
        created_by: text(transfer.performed_by.as_ref()),
        completed_by: text(transfer.performed_by.as_ref()),
        started_at: ActiveValue::Set(Some(now)),
        completed_at: ActiveValue::Set(Some(now)),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    inventory_movements::Entity::insert(movement)
        .exec_without_returning(&db)
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
    refuse_managed_bucket(db, inventory_id).await?;
    let db = orm(db);
    let allocated = || Expr::from(Func::coalesce([inventory::Column::QuantityAllocated.into_expr(), Expr::val(0)]));
    let updated = {
        use sea_orm::ExprTrait as _;
        inventory::Entity::update_many()
            .col_expr(inventory::Column::QuantityAllocated, allocated().add(quantity))
            .col_expr(
                inventory::Column::QuantityAvailable,
                inventory::Column::QuantityOnHand
                    .into_expr()
                    .sub(allocated().add(quantity)),
            )
            .col_expr(inventory::Column::UpdatedAt, Expr::value(weldsuite_db::utc_now()))
            .filter(inventory::Column::Id.eq(inventory_id))
            .filter(inventory::Column::DeletedAt.is_null())
            .filter(
                inventory::Column::QuantityOnHand
                    .into_expr()
                    .sub(allocated())
                    .gte(quantity),
            )
            .exec(&db)
            .await?
    };
    if updated.rows_affected > 0 {
        return Ok(());
    }
    let Some((on_hand, allocated)) = bucket_quantities(&db, inventory_id).await? else {
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

/// The live bucket's on-hand and allocated units.
async fn bucket_quantities<C: ConnectionTrait>(
    db: &C,
    inventory_id: &str,
) -> Result<Option<(Option<i32>, Option<i32>)>, DbErr> {
    inventory::Entity::find()
        .select_only()
        .columns([
            inventory::Column::QuantityOnHand,
            inventory::Column::QuantityAllocated,
        ])
        .filter(inventory::Column::Id.eq(inventory_id))
        .filter(inventory::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await
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
    refuse_managed_bucket(db, inventory_id).await?;
    let db = orm(db);
    let allocated = || Expr::from(Func::coalesce([inventory::Column::QuantityAllocated.into_expr(), Expr::val(0)]));
    let updated = {
        use sea_orm::ExprTrait as _;
        inventory::Entity::update_many()
            .col_expr(inventory::Column::QuantityAllocated, allocated().sub(quantity))
            .col_expr(
                inventory::Column::QuantityAvailable,
                inventory::Column::QuantityOnHand
                    .into_expr()
                    .sub(allocated().sub(quantity)),
            )
            .col_expr(inventory::Column::UpdatedAt, Expr::value(weldsuite_db::utc_now()))
            .filter(inventory::Column::Id.eq(inventory_id))
            .filter(inventory::Column::DeletedAt.is_null())
            .filter(allocated().gte(quantity))
            .exec(&db)
            .await?
    };
    if updated.rows_affected > 0 {
        return Ok(());
    }
    let allocated = bucket_quantities(&db, inventory_id)
        .await?
        .and_then(|(_, allocated)| allocated)
        .unwrap_or(0);
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
    refuse_managed_bucket(db, issue.inventory_id).await?;
    let now = weldsuite_db::utc_now();
    let conn = orm(db);
    let rows = {
        use inventory::Column;
        use sea_orm::ExprTrait as _;
        let on_hand = || Column::QuantityOnHand.into_expr();
        let allocated =
            || Expr::from(Func::coalesce([Column::QuantityAllocated.into_expr(), Expr::val(0)]));
        let quantity = issue.quantity;
        inventory::Entity::update_many()
            .col_expr(Column::QuantityOnHand, on_hand().sub(quantity))
            .col_expr(Column::QuantityAllocated, allocated().sub(quantity))
            .col_expr(
                Column::QuantityAvailable,
                on_hand().sub(quantity).sub(allocated().sub(quantity)),
            )
            .col_expr(
                Column::TotalValue,
                Func::round_with_precision(
                    Expr::from(Func::coalesce([Column::UnitCost.into_expr(), Expr::val(0)]))
                        .mul(on_hand().sub(Expr::val(quantity).cast_as("numeric"))),
                    2,
                )
                .into(),
            )
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(issue.inventory_id))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::QuantityOnHand.gte(quantity))
            .filter(allocated().gte(quantity))
            .exec_with_returning(&conn)
            .await?
    };
    let Some(row) = rows.into_iter().next() else {
        let Some((on_hand, allocated)) = bucket_quantities(&conn, issue.inventory_id).await? else {
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
    let new_quantity = i64::from(row.quantity_on_hand);
    let adjustment = Audit {
        inventory_id: issue.inventory_id,
        product_id: &row.product_id,
        variant_id: row.variant_id.as_deref(),
        warehouse_id: &row.warehouse_id,
        location_id: row.location_id.as_deref(),
        lot_number: row.lot_number.as_deref(),
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
    }
    .row(&generate_id("adj"), now)?;
    audit_and_roll_up(
        db,
        adjustment,
        row.product_id.clone(),
        row.variant_id.clone(),
        now,
    )
    .await
}
