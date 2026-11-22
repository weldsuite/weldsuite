//! The planner's inputs, per item (a product or variant in one warehouse):
//! the daily demand series, the stock position, the expected receipts, the
//! supplier and the lead time; then the engine's plan for each
//! (`weldsuite-documentation/plans/weldstash-replenishment.md`, "Demand
//! series").
//!
//! **Demand** is read for [`SERIES_DAYS`] up to yesterday (UTC days), one
//! grouped statement per chunk of products that returns only the days
//! with demand:
//!
//! - WeldCommerce orders (`order_items` on orders that are not deleted and
//!   not cancelled or failed: WeldCommerce's own `cancelled`, the
//!   connectors' `cancelled`/`canceled`/`failed`, or a `cancelled_at`),
//!   dated by `orders.created_at`. An order counts in the warehouse of the
//!   pick list it is on (the oldest live, not cancelled one), else in the
//!   demand warehouse ([`super::settings::demand_warehouse`]).
//! - `stash_sales_history` by `date`; a row without a warehouse counts in
//!   the demand warehouse. Imported rows (`source = 'import'`) count once
//!   their import is completed (`done`, not deleted: an import still taking
//!   rows, or one left unfinished, counts nothing), and only before
//!   `history_cutover_date` when it is set, so an import and live orders
//!   don't count the same sales twice; synced rows (Odoo) are a live source
//!   and always count.
//!
//! The engine gets the item's lookback (`lookback_days`), or the whole
//! series once the item is a year old, so its seasonality can show.
//!
//! **Position**: on hand and allocated from the warehouse's buckets, without
//! quarantined, damaged or expired stock; incoming from open purchase order
//! lines ([`crate::incoming`]); open demand, the unfulfilled quantity of
//! open orders (`pending`, `processing`, `on_hold`, created within the
//! lookback) that are on no pick list yet, in the demand warehouse.
//!
//! **Supplier**: the rule's product supplier, else the item's preferred one,
//! else (for a variant) the product's preferred one. **Lead time**: the
//! rule's override, else the product supplier's, else the supplier's
//! default, else the settings' default.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, FromQueryResult, JoinType,
    Order, QueryFilter, QueryOrder, QuerySelect, Select,
};
use time::{Date, Duration, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, orm_error};
use weldsuite_schema::tenant::{
    inventory, product_suppliers, product_variants, products, stash_reorder_rules, suppliers,
};

use super::engine::{
    EngineInput, EngineOutput, ExpectedReceipt, MAX_QUANTITY, Position, RuleMethod, SupplierTerms,
    plan_item,
};
use super::settings::Settings;
use crate::incoming::{IncomingQuery, VariantFilter, incoming_lines, parse_date};

/// Days of demand read per item: two years, for seasonality.
pub(crate) const SERIES_DAYS: i64 = 730;

/// An item at least this many days old gets the whole series.
const SEASONAL_AGE_DAYS: i64 = 365;

/// Order statuses that are no demand.
pub(crate) const NOT_DEMAND: [&str; 3] = ["cancelled", "canceled", "failed"];

/// Order statuses whose unfulfilled lines are still to be picked.
const OPEN_ORDER: [&str; 3] = ["pending", "processing", "on_hold"];

/// A product (or one of its variants) in a warehouse.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[allow(clippy::struct_field_names)] // the ids of the plan's key
pub(crate) struct Item {
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) warehouse_id: String,
}

impl Item {
    /// `stash_item_plans.item_key` / `stash_reorder_rules.item_key`.
    pub(crate) fn key(&self) -> String {
        item_key(
            &self.product_id,
            self.variant_id.as_deref(),
            &self.warehouse_id,
        )
    }
}

/// `<productId>|<variantId or ''>|<warehouseId>`.
pub(crate) fn item_key(product_id: &str, variant_id: Option<&str>, warehouse_id: &str) -> String {
    format!("{product_id}|{}|{warehouse_id}", variant_id.unwrap_or(""))
}

/// What every item of a run shares.
#[derive(Debug, Clone)]
pub(crate) struct Planning {
    pub(crate) today: Date,
    pub(crate) settings: Settings,
    /// Where orders without a pick list count; `None` without warehouses.
    pub(crate) demand_warehouse: Option<String>,
}

impl Planning {
    /// The first day of the series.
    pub(crate) fn series_start(&self) -> Date {
        self.today - Duration::days(SERIES_DAYS)
    }
}

/// One item's inputs and plan.
#[derive(Debug, Clone)]
pub(crate) struct ItemPlan {
    pub(crate) item: Item,
    pub(crate) key: String,
    pub(crate) input: EngineInput,
    pub(crate) output: EngineOutput,
    /// The whole series read, `series[0]` is [`Planning::series_start`],
    /// the last entry yesterday (the demand chart's history).
    pub(crate) series: Vec<i64>,
    pub(crate) product_supplier_id: Option<String>,
    pub(crate) supplier_id: Option<String>,
    /// The item's rule is `off`: no plan.
    pub(crate) rule_off: bool,
    /// Demand, stock, incoming, open demand or a rule: worth a plan.
    pub(crate) active: bool,
}

/// A live product supplier with its supplier's default lead time.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Link {
    pub(crate) id: String,
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) supplier_id: String,
    pub(crate) unit_cost: Option<f64>,
    pub(crate) lead_time_days: Option<i64>,
    pub(crate) min_order_qty: Option<i64>,
    pub(crate) order_multiple: i64,
    pub(crate) supplier_lead_time_days: Option<i64>,
}

/// A live product supplier as [`link_query`] reads it.
#[derive(Debug, FromQueryResult)]
pub(crate) struct LinkRow {
    pub(crate) id: String,
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) supplier_id: String,
    pub(crate) unit_cost: Option<f64>,
    pub(crate) lead_time_days: Option<i32>,
    pub(crate) min_order_qty: Option<i32>,
    pub(crate) order_multiple: Option<i32>,
    pub(crate) supplier_lead_time_days: Option<i32>,
}

impl LinkRow {
    pub(crate) fn link(self) -> Link {
        Link {
            id: self.id,
            product_id: self.product_id,
            // `nullif(variant_id, '')`.
            variant_id: self.variant_id.filter(|variant| !variant.is_empty()),
            supplier_id: self.supplier_id,
            unit_cost: self.unit_cost,
            lead_time_days: self.lead_time_days.map(i64::from),
            min_order_qty: self.min_order_qty.map(i64::from),
            order_multiple: self.order_multiple.map_or(1, i64::from).max(1),
            supplier_lead_time_days: self.supplier_lead_time_days.map(i64::from),
        }
    }
}

/// The live product suppliers of `products` with a live supplier, preferred
/// first, then oldest, as [`LinkRow`]s (`unit_cost` as a float, as the
/// planner reads it).
pub(crate) fn link_query(products: &[String]) -> Select<product_suppliers::Entity> {
    use sea_orm::ExprTrait as _;
    let supplier = product_suppliers::Entity::belongs_to(suppliers::Entity)
        .from(product_suppliers::Column::SupplierId)
        .to(suppliers::Column::Id)
        .on_condition(|_, right| {
            Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
                right,
                suppliers::Column::DeletedAt,
            ))))
        })
        .into();
    product_suppliers::Entity::find()
        .select_only()
        .columns([
            product_suppliers::Column::Id,
            product_suppliers::Column::ProductId,
            product_suppliers::Column::VariantId,
            product_suppliers::Column::SupplierId,
        ])
        .column_as(
            Expr::col((
                product_suppliers::Entity,
                product_suppliers::Column::UnitCost,
            ))
            .cast_as("float8"),
            "unit_cost",
        )
        .columns([
            product_suppliers::Column::LeadTimeDays,
            product_suppliers::Column::MinOrderQty,
            product_suppliers::Column::OrderMultiple,
        ])
        .column_as(
            suppliers::Column::DefaultLeadTimeDays,
            "supplier_lead_time_days",
        )
        .join(JoinType::InnerJoin, supplier)
        .filter(product_suppliers::Column::DeletedAt.is_null())
        .filter(product_suppliers::Column::ProductId.is_in(products.iter().map(String::as_str)))
        .order_by(product_suppliers::Column::ProductId, Order::Asc)
        .order_by(product_suppliers::Column::IsPreferred, Order::Desc)
        .order_by(product_suppliers::Column::CreatedAt, Order::Asc)
        .order_by(product_suppliers::Column::Id, Order::Asc)
}

/// A reorder rule.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Rule {
    pub(crate) method: String,
    pub(crate) min_qty: Option<i64>,
    pub(crate) max_qty: Option<i64>,
    pub(crate) service_level: Option<f64>,
    pub(crate) review_period_days: Option<i64>,
    pub(crate) lead_time_days_override: Option<i64>,
    pub(crate) product_supplier_id: Option<String>,
}

impl Rule {
    pub(crate) fn engine_method(&self) -> RuleMethod {
        match (self.method.as_str(), self.min_qty, self.max_qty) {
            ("off", _, _) => RuleMethod::Off,
            ("min_max", Some(min), Some(max)) => RuleMethod::MinMax { min, max },
            _ => RuleMethod::Auto,
        }
    }
}

/// The product supplier an item is bought from: the rule's choice when it
/// is one of the product's live links (the item's own, or the product's for
/// a variant), else the item's preferred link, else, for a variant, the
/// product's. `links` are ordered preferred first, then oldest.
pub(crate) fn choose_link<'a>(
    links: &'a [Link],
    product_id: &str,
    variant_id: Option<&str>,
    rule_pick: Option<&str>,
) -> Option<&'a Link> {
    let fits = |link: &Link| {
        link.product_id == product_id
            && (link.variant_id.is_none() || link.variant_id.as_deref() == variant_id)
    };
    if let Some(picked) = rule_pick
        && let Some(link) = links.iter().find(|link| link.id == picked && fits(link))
    {
        return Some(link);
    }
    links
        .iter()
        .find(|link| link.product_id == product_id && link.variant_id.as_deref() == variant_id)
        .or_else(|| {
            variant_id?;
            links
                .iter()
                .find(|link| link.product_id == product_id && link.variant_id.is_none())
        })
}

/// The lead time: the rule's override, the product supplier's, its
/// supplier's default, the settings' default.
pub(crate) fn lead_time_days(rule: Option<&Rule>, link: Option<&Link>, default: i64) -> i64 {
    rule.and_then(|rule| rule.lead_time_days_override)
        .or_else(|| link.and_then(|link| link.lead_time_days.or(link.supplier_lead_time_days)))
        .unwrap_or(default)
}

/// Where the engine's history starts: `lookback_days` back, or the whole
/// series for an item first seen at least a year ago.
pub(crate) fn history_start(
    today: Date,
    series_start: Date,
    lookback_days: i64,
    first_seen: Option<Date>,
) -> Date {
    let seasonal = first_seen.is_some_and(|seen| seen <= today - Duration::days(SEASONAL_AGE_DAYS));
    if seasonal {
        return series_start;
    }
    (today - Duration::days(lookback_days.clamp(1, SERIES_DAYS))).max(series_start)
}

/// `YYYY-MM-DD`.
pub(crate) fn ymd(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// Days from `earlier` to `later`.
fn days_between(later: Date, earlier: Date) -> i64 {
    (later - earlier).whole_days()
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// Non-zero demand per item and day, at `$1`–`$6`: the products, the first
/// day, the day after the last, the demand warehouse (or null), the
/// cut-over date (or null), the statuses that are no demand.
const DEMAND: &str = "with picked as ( \
       select distinct on (x.order_id) x.order_id, pl.warehouse_id \
       from pick_lists pl \
       cross join lateral jsonb_array_elements_text(case when jsonb_typeof(pl.order_ids) = 'array' \
         then pl.order_ids else '[]'::jsonb end) as x(order_id) \
       where pl.deleted_at is null and coalesce(pl.status, '') <> 'cancelled' \
         and pl.created_at >= $2::date::timestamp \
       order by x.order_id, pl.created_at, pl.id), \
     days as ( \
       select i.product_id, nullif(i.variant_id, '') as variant_id, \
         coalesce(pk.warehouse_id, $4::text) as warehouse_id, o.created_at::date as day, \
         sum(i.quantity)::bigint as quantity \
       from order_items i join orders o on o.id = i.order_id \
       left join picked pk on pk.order_id = o.id \
       where i.product_id = any($1) and o.deleted_at is null and o.cancelled_at is null \
         and coalesce(o.status, '') <> all($6) \
         and o.created_at >= $2::date::timestamp and o.created_at < $3::date::timestamp \
       group by 1, 2, 3, 4 \
       union all \
       select h.product_id, nullif(h.variant_id, ''), coalesce(nullif(h.warehouse_id, ''), $4::text), \
         h.date, sum(h.quantity)::bigint \
       from stash_sales_history h \
       where h.product_id = any($1) and h.date >= $2::date and h.date < $3::date \
         and (h.source <> 'import' or (($5::date is null or h.date < $5::date) \
           and exists (select 1 from stash_sales_history_imports im where im.id = h.import_id \
             and im.status = 'done' and im.deleted_at is null))) \
       group by 1, 2, 3, 4) \
     select product_id, variant_id, warehouse_id, to_char(day, 'YYYY-MM-DD'), sum(quantity)::bigint \
     from days where warehouse_id is not null \
     group by 1, 2, 3, 4 having sum(quantity) <> 0 \
     order by 1, 2, 3, 4";

/// Unfulfilled quantity of open orders on no pick list, per product and
/// variant, at `$1`–`$3`: the products, the open statuses, the first day.
/// (A pick list for such an order is made after it, so only the pick lists
/// since the first day are looked at, once.)
const OPEN_DEMAND: &str = "with picked as ( \
       select distinct x.order_id from pick_lists pl \
       cross join lateral jsonb_array_elements_text(case when jsonb_typeof(pl.order_ids) = 'array' \
         then pl.order_ids else '[]'::jsonb end) as x(order_id) \
       where pl.deleted_at is null and coalesce(pl.status, '') <> 'cancelled' \
         and pl.created_at >= $3::date::timestamp) \
     select i.product_id, nullif(i.variant_id, ''), \
     sum(greatest(i.quantity - coalesce(i.fulfilled_quantity, 0), 0))::bigint \
     from order_items i join orders o on o.id = i.order_id \
     where i.product_id = any($1) and o.deleted_at is null and o.cancelled_at is null \
     and o.status = any($2) and coalesce(o.fulfillment_status, 'unfulfilled') <> 'fulfilled' \
     and o.created_at >= $3::date::timestamp \
     and not exists (select 1 from picked p where p.order_id = o.id) \
     group by 1, 2 \
     having sum(greatest(i.quantity - coalesce(i.fulfilled_quantity, 0), 0)) > 0";

type DemandRow = (String, Option<String>, String, String, i64);
type RuleRow = (
    String,
    String,
    Option<i32>,
    Option<i32>,
    Option<f64>,
    Option<i32>,
    Option<i32>,
    Option<String>,
);

/// The demand days of `products` in `[from, to)`, per item key.
#[allow(
    clippy::disallowed_methods,
    reason = "a report over sales history: CTEs, `distinct on`, pick lists' jsonb order ids \
              expanded with `jsonb_array_elements_text`, a `union all` grouped again"
)]
pub(crate) async fn demand_days(
    db: &PgPool,
    products: &[String],
    from: Date,
    to: Date,
    demand_warehouse: Option<&str>,
    cutover: Option<Date>,
) -> Result<HashMap<String, Vec<(Date, i64)>>, DbErr> {
    let rows: Vec<DemandRow> = sqlx::query_as(DEMAND)
        .bind(products)
        .bind(ymd(from))
        .bind(ymd(to))
        .bind(demand_warehouse)
        .bind(cutover.map(ymd))
        .bind(&NOT_DEMAND[..])
        .fetch_all(db)
        .await
        .map_err(orm_error)?;
    let mut out: HashMap<String, Vec<(Date, i64)>> = HashMap::new();
    for (product, variant, warehouse, day, quantity) in rows {
        if let Some(day) = parse_date(&day) {
            out.entry(item_key(&product, variant.as_deref(), &warehouse))
                .or_default()
                .push((day, quantity));
        }
    }
    Ok(out)
}

/// On hand and allocated per item key, sellable buckets only: not
/// quarantined, damaged or expired. Grouped by `variant_id` as stored, the
/// `null` and `''` groups (`nullif(variant_id, '')`, the product itself)
/// added up here.
async fn stock(
    db: &DatabaseConnection,
    products: &[String],
) -> Result<HashMap<String, (i64, i64)>, DbErr> {
    use sea_orm::ExprTrait as _;
    // `coalesce(sum(<expr>), 0)::bigint`.
    let total = |expr: Expr| {
        Expr::from(Func::coalesce([Expr::from(Func::sum(expr)), Expr::val(0)])).cast_as("bigint")
    };
    let rows: Vec<(String, Option<String>, String, i64, i64)> = inventory::Entity::find()
        .select_only()
        .columns([
            inventory::Column::ProductId,
            inventory::Column::VariantId,
            inventory::Column::WarehouseId,
        ])
        .column_as(
            total(Expr::col(inventory::Column::QuantityOnHand)),
            "on_hand",
        )
        .column_as(
            total(
                Func::coalesce([
                    Expr::col(inventory::Column::QuantityAllocated),
                    Expr::val(0),
                ])
                .into(),
            ),
            "allocated",
        )
        .filter(inventory::Column::DeletedAt.is_null())
        .filter(inventory::Column::ProductId.is_in(products.iter().map(String::as_str)))
        // `not coalesce(is_quarantined, false)`.
        .filter(
            Condition::any()
                .add(inventory::Column::IsQuarantined.is_null())
                .add(inventory::Column::IsQuarantined.eq(false)),
        )
        // `coalesce(status, 'available') not in (…)`.
        .filter(
            Condition::any()
                .add(inventory::Column::Status.is_null())
                .add(inventory::Column::Status.is_not_in(["quarantine", "damaged", "expired"])),
        )
        .group_by(inventory::Column::ProductId)
        .group_by(inventory::Column::VariantId)
        .group_by(inventory::Column::WarehouseId)
        .into_tuple()
        .all(db)
        .await?;
    let mut out: HashMap<String, (i64, i64)> = HashMap::new();
    for (product, variant, warehouse, on_hand, allocated) in rows {
        let variant = variant.filter(|variant| !variant.is_empty());
        let sums = out
            .entry(item_key(&product, variant.as_deref(), &warehouse))
            .or_default();
        sums.0 = sums.0.saturating_add(on_hand);
        sums.1 = sums.1.saturating_add(allocated);
    }
    Ok(out)
}

/// Open demand per `(product, variant)`.
#[allow(
    clippy::disallowed_methods,
    reason = "orders on no pick list: a CTE over pick lists' jsonb order ids expanded with \
              `jsonb_array_elements_text`, `not exists` against it, a grouped sum"
)]
async fn open_demand(
    db: &PgPool,
    products: &[String],
    since: Date,
) -> Result<HashMap<(String, Option<String>), i64>, DbErr> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(OPEN_DEMAND)
        .bind(products)
        .bind(&OPEN_ORDER[..])
        .bind(ymd(since))
        .fetch_all(db)
        .await
        .map_err(orm_error)?;
    Ok(rows
        .into_iter()
        .map(|(product, variant, quantity)| ((product, variant), quantity))
        .collect())
}

/// The rules of `products`, per item key (`service_level` as a float).
pub(crate) async fn rules(
    db: &DatabaseConnection,
    products: &[String],
) -> Result<HashMap<String, Rule>, DbErr> {
    use sea_orm::ExprTrait as _;
    let rows: Vec<RuleRow> = stash_reorder_rules::Entity::find()
        .select_only()
        .columns([
            stash_reorder_rules::Column::ItemKey,
            stash_reorder_rules::Column::Method,
            stash_reorder_rules::Column::MinQty,
            stash_reorder_rules::Column::MaxQty,
        ])
        .column_as(
            Expr::col(stash_reorder_rules::Column::ServiceLevel).cast_as("float8"),
            "service_level",
        )
        .columns([
            stash_reorder_rules::Column::ReviewPeriodDays,
            stash_reorder_rules::Column::LeadTimeDaysOverride,
            stash_reorder_rules::Column::ProductSupplierId,
        ])
        .filter(stash_reorder_rules::Column::ProductId.is_in(products.iter().map(String::as_str)))
        .into_tuple()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(key, method, min_qty, max_qty, service_level, review, lead, product_supplier_id)| {
                (
                    key,
                    Rule {
                        method,
                        min_qty: min_qty.map(i64::from),
                        max_qty: max_qty.map(i64::from),
                        service_level,
                        review_period_days: review.map(i64::from),
                        lead_time_days_override: lead.map(i64::from),
                        product_supplier_id,
                    },
                )
            },
        )
        .collect())
}

/// The live product suppliers of `products` (live suppliers only),
/// preferred first, then oldest.
pub(crate) async fn links(
    db: &DatabaseConnection,
    products: &[String],
) -> Result<Vec<Link>, DbErr> {
    let rows = link_query(products).into_model::<LinkRow>().all(db).await?;
    Ok(rows.into_iter().map(LinkRow::link).collect())
}

/// Creation day and cost price per `(product, variant)`: the products',
/// then their variants' (a variant's own cost price, else the product's).
async fn facts(
    db: &DatabaseConnection,
    products: &[String],
) -> Result<HashMap<(String, Option<String>), (Option<Date>, Option<f64>)>, DbErr> {
    use sea_orm::ExprTrait as _;
    let own: Vec<(String, PrimitiveDateTime, Option<f64>)> = products::Entity::find()
        .select_only()
        .columns([products::Column::Id, products::Column::CreatedAt])
        .column_as(
            Expr::col(products::Column::CostPrice).cast_as("float8"),
            "cost_price",
        )
        .filter(products::Column::Id.is_in(products.iter().map(String::as_str)))
        .into_tuple()
        .all(db)
        .await?;
    let cost = Func::coalesce([
        Expr::col((
            product_variants::Entity,
            product_variants::Column::CostPrice,
        )),
        Expr::col((products::Entity, products::Column::CostPrice)),
    ]);
    let variants: Vec<(String, String, PrimitiveDateTime, Option<f64>)> =
        product_variants::Entity::find()
            .select_only()
            .columns([
                product_variants::Column::ProductId,
                product_variants::Column::Id,
                product_variants::Column::CreatedAt,
            ])
            .column_as(Expr::from(cost).cast_as("float8"), "cost_price")
            .join(
                JoinType::InnerJoin,
                product_variants::Entity::belongs_to(products::Entity)
                    .from(product_variants::Column::ProductId)
                    .to(products::Column::Id)
                    .into(),
            )
            .filter(product_variants::Column::ProductId.is_in(products.iter().map(String::as_str)))
            .into_tuple()
            .all(db)
            .await?;
    let own = own
        .into_iter()
        .map(|(product, created, cost)| ((product, None), (Some(created.date()), cost)));
    let variants = variants
        .into_iter()
        .map(|(product, variant, created, cost)| {
            ((product, Some(variant)), (Some(created.date()), cost))
        });
    Ok(own.chain(variants).collect())
}

// ── Planning ────────────────────────────────────────────────────────────────

/// The inputs and plan of each of `items` (their products' rows are read
/// once), in the order given.
#[allow(clippy::too_many_lines)] // one pass over the inputs
pub(crate) async fn plan_items(
    db: &PgPool,
    planning: &Planning,
    items: Vec<Item>,
) -> Result<Vec<ItemPlan>, DbErr> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    let products: Vec<String> = items
        .iter()
        .filter(|item| seen.insert(item.product_id.clone()))
        .map(|item| item.product_id.clone())
        .collect();
    let today = planning.today;
    let series_start = planning.series_start();
    let settings = &planning.settings;
    let demand_warehouse = planning.demand_warehouse.as_deref();

    let demand = demand_days(
        db,
        &products,
        series_start,
        today,
        demand_warehouse,
        settings.cutover,
    )
    .await?;
    let conn = orm(db);
    let stock = stock(&conn, &products).await?;
    let open_since = today - Duration::days(settings.lookback_days.clamp(1, SERIES_DAYS));
    let open = open_demand(db, &products, open_since).await?;
    let rules = rules(&conn, &products).await?;
    let links = links(&conn, &products).await?;
    let facts = facts(&conn, &products).await?;
    let open_lines = incoming_lines(
        db,
        &IncomingQuery {
            product_ids: Some(products.clone()),
            variant: VariantFilter::Any,
            warehouse_id: None,
        },
    )
    .await?;
    let mut receipts: HashMap<String, Vec<(Option<Date>, i64)>> = HashMap::new();
    for line in open_lines {
        receipts
            .entry(item_key(
                &line.product_id,
                line.variant_id.as_deref(),
                &line.warehouse_id,
            ))
            .or_default()
            .push((line.expected_date, line.quantity));
    }

    let series_len = usize::try_from(SERIES_DAYS).unwrap_or(0);
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let key = item.key();
        let mut series = vec![0_i64; series_len];
        let mut first_demand = None;
        for (day, quantity) in demand.get(&key).map(Vec::as_slice).unwrap_or_default() {
            let Ok(index) = usize::try_from(days_between(*day, series_start)) else {
                continue;
            };
            if let Some(slot) = series.get_mut(index) {
                *slot = slot
                    .saturating_add(*quantity)
                    .clamp(-MAX_QUANTITY, MAX_QUANTITY);
                if *quantity > 0 && first_demand.is_none_or(|first| *day < first) {
                    first_demand = Some(*day);
                }
            }
        }
        let has_demand = series.iter().any(|quantity| *quantity != 0);
        let (created, cost) = facts
            .get(&(item.product_id.clone(), item.variant_id.clone()))
            .copied()
            .unwrap_or((None, None));
        let first_seen = match (created, first_demand) {
            (Some(created), Some(sold)) => Some(created.min(sold)),
            (created, sold) => created.or(sold),
        };
        let start = history_start(today, series_start, settings.lookback_days, first_seen);
        let skip = usize::try_from(days_between(start, series_start)).unwrap_or(0);
        let daily_demand = series.get(skip..).unwrap_or_default().to_vec();

        let rule = rules.get(&key);
        let link = choose_link(
            &links,
            &item.product_id,
            item.variant_id.as_deref(),
            rule.and_then(|rule| rule.product_supplier_id.as_deref()),
        );
        let lead = lead_time_days(rule, link, settings.lead_time_days);
        let (on_hand, allocated) = stock.get(&key).copied().unwrap_or((0, 0));
        let item_receipts: Vec<ExpectedReceipt> = receipts
            .get(&key)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|(date, quantity)| ExpectedReceipt {
                date: date.unwrap_or_else(|| today + Duration::days(lead.clamp(0, 3650))),
                quantity: *quantity,
            })
            .collect();
        let incoming: i64 = item_receipts
            .iter()
            .map(|receipt| receipt.quantity)
            .fold(0, i64::saturating_add);
        let open_demand = if demand_warehouse == Some(item.warehouse_id.as_str()) {
            open.get(&(item.product_id.clone(), item.variant_id.clone()))
                .copied()
                .unwrap_or(0)
        } else {
            0
        };
        let rule_method = rule.map_or(RuleMethod::Auto, Rule::engine_method);
        let unit_cost = link.and_then(|link| link.unit_cost).or(cost);
        let supplier = match link {
            Some(link) => Some(SupplierTerms {
                min_order_qty: link.min_order_qty,
                order_multiple: link.order_multiple,
                unit_cost,
            }),
            None => unit_cost.map(|unit_cost| SupplierTerms {
                min_order_qty: None,
                order_multiple: 1,
                unit_cost: Some(unit_cost),
            }),
        };
        let input = EngineInput {
            today,
            history_start: start,
            daily_demand,
            first_activity: created,
            lead_time_days: lead,
            review_period_days: rule
                .and_then(|rule| rule.review_period_days)
                .unwrap_or(settings.review_period_days),
            service_level: rule
                .and_then(|rule| rule.service_level)
                .unwrap_or(settings.service_level),
            rule: rule_method,
            supplier,
            position: Position {
                on_hand,
                allocated,
                incoming,
                open_demand,
            },
            receipts: item_receipts,
        };
        let output = plan_item(&input);
        let active = has_demand
            || on_hand != 0
            || allocated != 0
            || incoming > 0
            || open_demand > 0
            || matches!(rule_method, RuleMethod::MinMax { .. })
            || rule.is_some_and(|rule| rule.method == "auto");
        out.push(ItemPlan {
            key,
            input,
            output,
            series,
            product_supplier_id: link.map(|link| link.id.clone()),
            supplier_id: link.map(|link| link.supplier_id.clone()),
            rule_off: rule_method == RuleMethod::Off,
            active,
            item,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use time::Month;

    use super::*;

    fn date(year: i32, month: Month, day: u8) -> Date {
        Date::from_calendar_date(year, month, day).expect("date")
    }

    fn link(id: &str, product: &str, variant: Option<&str>) -> Link {
        Link {
            id: id.to_owned(),
            product_id: product.to_owned(),
            variant_id: variant.map(str::to_owned),
            supplier_id: format!("sup_{id}"),
            unit_cost: None,
            lead_time_days: None,
            min_order_qty: None,
            order_multiple: 1,
            supplier_lead_time_days: None,
        }
    }

    #[test]
    fn the_item_key_joins_the_ids() {
        assert_eq!(item_key("p", None, "w"), "p||w");
        assert_eq!(item_key("p", Some("v"), "w"), "p|v|w");
    }

    #[test]
    fn the_rule_picks_the_supplier_then_the_preferred_link() {
        // Preferred first, as the statement orders them.
        let links = vec![
            link("a", "p1", None),
            link("b", "p1", None),
            link("c", "p1", Some("v1")),
            link("d", "p2", None),
        ];
        assert_eq!(
            choose_link(&links, "p1", None, None).map(|l| &l.id[..]),
            Some("a")
        );
        assert_eq!(
            choose_link(&links, "p1", None, Some("b")).map(|l| &l.id[..]),
            Some("b")
        );
        // Another product's link is no choice.
        assert_eq!(
            choose_link(&links, "p1", None, Some("d")).map(|l| &l.id[..]),
            Some("a")
        );
        // A variant's own link first, the product's as the fallback.
        assert_eq!(
            choose_link(&links, "p1", Some("v1"), None).map(|l| &l.id[..]),
            Some("c")
        );
        assert_eq!(
            choose_link(&links, "p1", Some("v2"), None).map(|l| &l.id[..]),
            Some("a")
        );
        // The product's item never takes a variant's link.
        assert_eq!(
            choose_link(&links, "p1", None, Some("c")).map(|l| &l.id[..]),
            Some("a")
        );
        assert!(choose_link(&links, "p3", None, None).is_none());
    }

    #[test]
    fn the_lead_time_falls_back_in_order() {
        let rule = Rule {
            method: "auto".to_owned(),
            min_qty: None,
            max_qty: None,
            service_level: None,
            review_period_days: None,
            lead_time_days_override: Some(3),
            product_supplier_id: None,
        };
        let mut supplier = link("a", "p", None);
        supplier.lead_time_days = Some(9);
        supplier.supplier_lead_time_days = Some(20);
        assert_eq!(lead_time_days(Some(&rule), Some(&supplier), 14), 3);
        assert_eq!(lead_time_days(None, Some(&supplier), 14), 9);
        supplier.lead_time_days = None;
        assert_eq!(lead_time_days(None, Some(&supplier), 14), 20);
        supplier.supplier_lead_time_days = None;
        assert_eq!(lead_time_days(None, Some(&supplier), 14), 14);
        assert_eq!(lead_time_days(None, None, 14), 14);
    }

    #[test]
    fn a_year_old_item_reads_the_whole_series() {
        let today = date(2026, Month::November, 18);
        let start = today - Duration::days(SERIES_DAYS);
        let old = Some(today - Duration::days(400));
        let young = Some(today - Duration::days(100));
        assert_eq!(history_start(today, start, 90, old), start);
        assert_eq!(
            history_start(today, start, 90, young),
            today - Duration::days(90)
        );
        assert_eq!(
            history_start(today, start, 90, None),
            today - Duration::days(90)
        );
        // Never before the series.
        assert_eq!(history_start(today, start, 5000, young), start);
    }

    #[test]
    fn a_rule_reads_as_the_engine_method() {
        let mut rule = Rule {
            method: "min_max".to_owned(),
            min_qty: Some(5),
            max_qty: Some(20),
            service_level: None,
            review_period_days: None,
            lead_time_days_override: None,
            product_supplier_id: None,
        };
        assert_eq!(rule.engine_method(), RuleMethod::MinMax { min: 5, max: 20 });
        rule.max_qty = None;
        assert_eq!(rule.engine_method(), RuleMethod::Auto);
        rule.method = "off".to_owned();
        assert_eq!(rule.engine_method(), RuleMethod::Off);
    }

    #[test]
    fn dates_print_as_iso_days() {
        assert_eq!(ymd(date(2026, Month::March, 4)), "2026-03-04");
    }
}
