//! Incoming stock, derived from open purchase order lines (ADR STASH-007;
//! `inventory.quantity_incoming` is not used and stays 0).
//!
//! A line is open when its purchase order is live, in `approved`,
//! `ordered` or `partial`, has a destination warehouse, and the line has a
//! product and units still to come:
//! `quantity_ordered − quantity_received − quantity_rejected > 0` (the
//! `greatest(…, 0)` of the plan, with the zero lines left out). Incoming per
//! item is the sum of that over the lines, grouped by product, variant and
//! destination warehouse, with the earliest `expected_date` among them.
//!
//! [`incoming`] is the per-item sum (the `GET /replenishment/incoming`
//! route, the planner's position); [`incoming_lines`] the open lines one by
//! one with their dates (the planner's expected receipts). An empty
//! `variant_id` counts as no variant.

use sea_orm::sea_query::{Alias, Expr, Func, NullOrdering, Order};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
    Select,
};
use serde_json::{Value, json};
use time::{Date, Month, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{purchase_order_items as items, purchase_orders as orders};

use crate::args::{iso, millis};

/// The purchase order statuses whose lines are on their way.
pub(crate) const INCOMING_STATUSES: [&str; 3] = ["approved", "ordered", "partial"];

/// Which variant rows to count.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum VariantFilter {
    /// Every line, with or without a variant.
    #[default]
    Any,
    /// Only lines without a variant (`variantId=none`).
    None,
    /// Only lines of this variant.
    Only(String),
}

/// The filters: all `None`/`Any` is every open line of the workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IncomingQuery {
    /// Only these products (the planner's chunk, or the route's one product).
    pub(crate) product_ids: Option<Vec<String>>,
    pub(crate) variant: VariantFilter,
    /// Only purchase orders into this warehouse.
    pub(crate) warehouse_id: Option<String>,
}

/// Incoming stock of one item: product, variant, destination warehouse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Incoming {
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) warehouse_id: String,
    /// Units still to come, always > 0.
    pub(crate) quantity: i64,
    /// The earliest `expected_date` of those lines' purchase orders, as
    /// `toISOString()`; `None` when none of them has one.
    pub(crate) next_expected_date: Option<String>,
}

impl Incoming {
    /// `{ productId, variantId, warehouseId, quantity, nextExpectedDate }`,
    /// an item of `GET /replenishment/incoming`.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "productId": self.product_id,
            "variantId": self.variant_id,
            "warehouseId": self.warehouse_id,
            "quantity": self.quantity,
            "nextExpectedDate": self.next_expected_date,
        })
    }
}

/// One open purchase order line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IncomingLine {
    pub(crate) purchase_order_id: String,
    /// `purchase_order_items.id`.
    pub(crate) item_id: String,
    pub(crate) product_id: String,
    pub(crate) variant_id: Option<String>,
    pub(crate) warehouse_id: String,
    /// Units still to come, always > 0.
    pub(crate) quantity: i64,
    /// The purchase order's `expected_date`, as a UTC date; `None` when it
    /// has none (the planner then assumes today + lead time).
    pub(crate) expected_date: Option<Date>,
}

/// `coalesce(x, '')` of a column that may be null.
fn or_empty(column: impl ColumnTrait) -> Expr {
    Func::coalesce([column.into_expr(), Expr::val("")]).into()
}

/// `coalesce(x, '') <> ''`.
fn set(column: impl ColumnTrait) -> Expr {
    use sea_orm::ExprTrait as _;
    or_empty(column).ne("")
}

/// `nullif(i.variant_id, '')`, selected as `variant_key`: grouped and
/// ordered by that name.
fn variant_key() -> Expr {
    Func::cust("nullif")
        .arg(items::Column::VariantId.into_expr())
        .arg("")
        .into()
}

/// The name [`variant_key`] is selected as.
const VARIANT_KEY: &str = "variant_key";

/// `i.quantity_ordered - coalesce(i.quantity_received, 0) -
/// coalesce(i.quantity_rejected, 0)`: what is still to come.
fn still_to_come() -> Expr {
    use sea_orm::ExprTrait as _;
    let or_zero = |column: items::Column| Func::coalesce([column.into_expr(), Expr::val(0)]);
    items::Column::QuantityOrdered
        .into_expr()
        .sub(or_zero(items::Column::QuantityReceived))
        .sub(or_zero(items::Column::QuantityRejected))
}

/// The open lines `query` selects: purchase order lines joined to their
/// live purchase order in an incoming status, with a product, a
/// destination warehouse and units still to come.
fn open_lines(query: &IncomingQuery) -> Select<items::Entity> {
    use sea_orm::ExprTrait as _;
    let mut condition = Condition::all()
        .add(orders::Column::DeletedAt.is_null())
        .add(orders::Column::Status.is_in(INCOMING_STATUSES))
        .add(set(items::Column::ProductId))
        .add(set(orders::Column::WarehouseId))
        .add(still_to_come().gt(0));
    if let Some(products) = &query.product_ids {
        // `= any('{}')`: an empty list matches nothing.
        condition = condition.add(items::Column::ProductId.is_in(products.iter().map(String::as_str)));
    }
    match &query.variant {
        VariantFilter::Any => {}
        VariantFilter::None => {
            use sea_orm::ExprTrait as _;
            condition = condition.add(or_empty(items::Column::VariantId).eq(""));
        }
        VariantFilter::Only(variant) => {
            condition = condition.add(items::Column::VariantId.eq(variant.as_str()));
        }
    }
    if let Some(warehouse) = &query.warehouse_id {
        condition = condition.add(orders::Column::WarehouseId.eq(warehouse.as_str()));
    }
    items::Entity::find()
        .select_only()
        .join(
            JoinType::InnerJoin,
            items::Entity::belongs_to(orders::Entity)
                .from(items::Column::PurchaseOrderId)
                .to(orders::Column::Id)
                .into(),
        )
        .filter(condition)
}

type IncomingRow = (String, Option<String>, String, i64, Option<PrimitiveDateTime>);
type LineRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    i64,
    Option<PrimitiveDateTime>,
);

/// Incoming stock per item (product, variant, destination warehouse) for
/// the items `query` selects, ordered by product, variant (none first) and
/// warehouse. Items with nothing to come are not listed.
pub(crate) async fn incoming(
    db: &PgPool,
    query: &IncomingQuery,
) -> Result<Vec<Incoming>, DbErr> {
    let rows: Vec<IncomingRow> = per_item(query).into_tuple().all(&orm(db)).await?;
    Ok(rows
        .into_iter()
        .map(
            |(product_id, variant_id, warehouse_id, quantity, next)| Incoming {
                product_id,
                variant_id,
                warehouse_id,
                quantity,
                next_expected_date: next.map(|at| iso(millis(at))),
            },
        )
        .collect())
}

/// The per-item sums: grouped by product, variant and warehouse, and
/// ordered so (variant none first). The variant is grouped and ordered by
/// its name in the select list, which stays one expression with its bound
/// `''`.
fn per_item(query: &IncomingQuery) -> Select<items::Entity> {
    use sea_orm::ExprTrait as _;
    open_lines(query)
        .column(items::Column::ProductId)
        .expr_as(variant_key(), VARIANT_KEY)
        .column(orders::Column::WarehouseId)
        .expr(Func::sum(still_to_come()).cast_as("bigint"))
        .expr(Func::min(orders::Column::ExpectedDate.into_expr()))
        .group_by(items::Column::ProductId)
        .group_by(Expr::col(Alias::new(VARIANT_KEY)))
        .group_by(orders::Column::WarehouseId)
        .order_by_asc(items::Column::ProductId)
        .order_by_with_nulls(
            Expr::col(Alias::new(VARIANT_KEY)),
            Order::Asc,
            NullOrdering::First,
        )
        .order_by_asc(orders::Column::WarehouseId)
}

/// The open purchase order lines `query` selects, one by one, ordered by
/// item, then expected date (none last).
pub(crate) async fn incoming_lines(
    db: &PgPool,
    query: &IncomingQuery,
) -> Result<Vec<IncomingLine>, DbErr> {
    use sea_orm::ExprTrait as _;
    let rows: Vec<LineRow> = open_lines(query)
        .column(orders::Column::Id)
        .column(items::Column::Id)
        .column(items::Column::ProductId)
        .expr_as(variant_key(), VARIANT_KEY)
        .column(orders::Column::WarehouseId)
        .expr(still_to_come().cast_as("bigint"))
        .column(orders::Column::ExpectedDate)
        .order_by_asc(items::Column::ProductId)
        .order_by_with_nulls(
            Expr::col(Alias::new(VARIANT_KEY)),
            Order::Asc,
            NullOrdering::First,
        )
        .order_by_asc(orders::Column::WarehouseId)
        .order_by_with_nulls(orders::Column::ExpectedDate, Order::Asc, NullOrdering::Last)
        .order_by_asc(orders::Column::Id)
        .order_by_asc(items::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(purchase_order_id, item_id, product_id, variant_id, warehouse_id, quantity, date)| {
                IncomingLine {
                    purchase_order_id,
                    item_id,
                    product_id,
                    variant_id,
                    warehouse_id,
                    quantity,
                    expected_date: date.map(PrimitiveDateTime::date),
                }
            },
        )
        .collect())
}

/// `YYYY-MM-DD` as a date.
pub(crate) fn parse_date(text: &str) -> Option<Date> {
    let mut parts = text.splitn(3, '-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u8>().ok()?;
    let day = parts.next()?.parse::<u8>().ok()?;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_calendar_dates() {
        assert_eq!(
            parse_date("2026-11-30"),
            Date::from_calendar_date(2026, Month::November, 30).ok()
        );
        assert_eq!(parse_date("2026-02-30"), None);
        assert_eq!(parse_date("2026-11"), None);
        assert_eq!(parse_date("soon"), None);
    }

    #[test]
    fn an_item_reads_as_the_route_item() {
        let item = Incoming {
            product_id: "prod_1".to_owned(),
            variant_id: None,
            warehouse_id: "wh_1".to_owned(),
            quantity: 12,
            next_expected_date: Some("2026-12-01T00:00:00.000Z".to_owned()),
        };
        assert_eq!(
            item.to_json(),
            json!({
                "productId": "prod_1",
                "variantId": null,
                "warehouseId": "wh_1",
                "quantity": 12,
                "nextExpectedDate": "2026-12-01T00:00:00.000Z",
            })
        );
    }

    fn sql(query: &IncomingQuery) -> String {
        use sea_orm::QueryTrait as _;
        per_item(query).build(sea_orm::DbBackend::Postgres).sql
    }

    #[test]
    fn the_variant_filter_picks_the_lines() {
        let any = sql(&IncomingQuery::default());
        assert!(!any.contains("variant_id\" ="), "{any}");
        let none = sql(&IncomingQuery {
            variant: VariantFilter::None,
            ..IncomingQuery::default()
        });
        assert!(
            none.contains(r#"COALESCE("purchase_order_items"."variant_id", $"#),
            "{none}"
        );
        let only = sql(&IncomingQuery {
            variant: VariantFilter::Only("var_1".to_owned()),
            ..IncomingQuery::default()
        });
        assert!(
            only.contains(r#""purchase_order_items"."variant_id" = $"#),
            "{only}"
        );
    }

    #[test]
    fn the_sums_group_and_order_by_the_selected_variant() {
        let sums = sql(&IncomingQuery::default());
        assert!(
            sums.contains(r#"GROUP BY "purchase_order_items"."product_id", "variant_key", "purchase_orders"."warehouse_id""#),
            "{sums}"
        );
        assert!(sums.contains(r#""variant_key" ASC NULLS FIRST"#), "{sums}");
    }

    #[test]
    fn an_empty_product_list_matches_nothing() {
        let none = sql(&IncomingQuery {
            product_ids: Some(Vec::new()),
            ..IncomingQuery::default()
        });
        assert!(none.contains("1 = 2"), "{none}");
    }
}
