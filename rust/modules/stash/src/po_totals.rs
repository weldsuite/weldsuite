//! A purchase order's header totals, worked out from its lines (phase 1 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`). The CRUD routes never kept
//! them in step (the conformance suite pins that); the purchasing actions
//! and the replenishment routes recompute them with
//! [`recompute_po_totals`] whenever they change lines or a status.
//!
//! - `item_count`: the number of lines
//! - `total_quantity_ordered`, `total_quantity_received`: sums of the lines'
//!   `quantity_ordered` and `quantity_received`
//! - `tax_total`: the sum of the lines' `tax_amount`
//! - `subtotal`: the sum of the lines' `total − tax_amount` (net of the line
//!   discount, before tax)
//! - `total`: `subtotal + tax_total + shipping_total − discount_total`, the
//!   header's own shipping and discount kept as they are
//!
//! The line amounts are already whole cents (`lineAmounts`), so the sums are
//! exact in `numeric`.

use sea_orm::sea_query::{Asterisk, Expr, Func, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, UpdateMany};
use serde_json::Value;
use time::PrimitiveDateTime;
use weldsuite_schema::tenant::{purchase_order_items as items, purchase_orders as orders};

use crate::tables::PURCHASE_ORDERS;

/// `(select <aggregate> from purchase_order_items i where
/// i.purchase_order_id = id)`.
fn of_lines(purchase_order_id: &str, aggregate: Expr) -> Expr {
    Query::select()
        .expr(aggregate)
        .from(items::Entity)
        .and_where(items::Column::PurchaseOrderId.eq(purchase_order_id))
        .to_owned()
        .into()
}

/// `coalesce(sum(<value>), 0)`.
fn sum_of(value: Expr) -> Expr {
    Func::coalesce([Expr::from(Func::sum(value)), Expr::val(0)]).into()
}

/// `coalesce(i.<column>, 0)`.
fn or_zero(column: items::Column) -> Expr {
    Func::coalesce([column.into_expr(), Expr::val(0)]).into()
}

/// Recompute the header totals of the purchase order `purchase_order_id`
/// from its lines (see the module docs) and set `updated_at` to `now`, in
/// one statement: each total is a subquery over the lines, all of the
/// statement's one snapshot. Runs on the pool (`orm`) or inside a
/// transaction (`OrmConn`).
///
/// Returns the updated row as Drizzle returns it (numeric columns as
/// strings), or `None` when there is no live purchase order with that id.
pub(crate) async fn recompute_po_totals<C: ConnectionTrait>(
    db: &C,
    purchase_order_id: &str,
    now: PrimitiveDateTime,
) -> Result<Option<Value>, DbErr> {
    let rows = totals(purchase_order_id, now)
        .exec_with_returning(db)
        .await?;
    rows.into_iter()
        .next()
        .map(|row| {
            serde_json::to_value(row)
                .map(|row| PURCHASE_ORDERS.drizzle(row))
                .map_err(|error| DbErr::Json(error.to_string()))
        })
        .transpose()
}

/// The recompute statement of the live purchase order `purchase_order_id`.
fn totals(purchase_order_id: &str, now: PrimitiveDateTime) -> UpdateMany<orders::Entity> {
    use sea_orm::ExprTrait as _;
    let lines = |aggregate: Expr| of_lines(purchase_order_id, aggregate);
    let tax_total = || lines(sum_of(or_zero(items::Column::TaxAmount)));
    let subtotal = || {
        lines(sum_of(
            or_zero(items::Column::Total).sub(or_zero(items::Column::TaxAmount)),
        ))
    };
    let header = |column: orders::Column| Func::coalesce([column.into_expr(), Expr::val(0)]);
    orders::Entity::update_many()
        .col_expr(
            orders::Column::ItemCount,
            lines(Expr::from(Func::count(Expr::col(Asterisk))).cast_as("integer")),
        )
        .col_expr(
            orders::Column::TotalQuantityOrdered,
            lines(sum_of(or_zero(items::Column::QuantityOrdered)).cast_as("integer")),
        )
        .col_expr(
            orders::Column::TotalQuantityReceived,
            lines(sum_of(or_zero(items::Column::QuantityReceived)).cast_as("integer")),
        )
        .col_expr(orders::Column::TaxTotal, tax_total())
        .col_expr(orders::Column::Subtotal, subtotal())
        .col_expr(
            orders::Column::Total,
            subtotal()
                .add(tax_total())
                .add(header(orders::Column::ShippingTotal))
                .sub(header(orders::Column::DiscountTotal)),
        )
        .col_expr(orders::Column::UpdatedAt, Expr::value(now))
        .filter(orders::Column::Id.eq(purchase_order_id))
        .filter(orders::Column::DeletedAt.is_null())
}

#[cfg(test)]
mod tests {
    use sea_orm::{DbBackend, QueryTrait as _};

    use super::*;

    #[test]
    fn the_totals_are_summed_from_the_lines_in_the_update() {
        let sql = totals("po_1", time::macros::datetime!(2026-11-22 10:00:00))
            .build(DbBackend::Postgres)
            .to_string();
        let lines = r#"FROM "purchase_order_items" WHERE "purchase_order_items"."purchase_order_id" = 'po_1')"#;
        for set in [
            format!(r#""item_count" = (SELECT CAST(COUNT(*) AS integer) {lines}"#),
            format!(
                r#""tax_total" = (SELECT COALESCE(SUM(COALESCE("purchase_order_items"."tax_amount", 0)), 0) {lines}"#
            ),
            format!(
                r#""subtotal" = (SELECT COALESCE(SUM(COALESCE("purchase_order_items"."total", 0) - COALESCE("purchase_order_items"."tax_amount", 0)), 0) {lines}"#
            ),
        ] {
            assert!(sql.contains(&set), "{set}\n{sql}");
        }
        assert!(
            sql.contains(r#"+ COALESCE("purchase_orders"."shipping_total", 0)) - COALESCE("purchase_orders"."discount_total", 0)"#),
            "{sql}"
        );
        assert!(
            sql.ends_with(r#"WHERE "purchase_orders"."id" = 'po_1' AND "purchase_orders"."deleted_at" IS NULL"#),
            "{sql}"
        );
    }
}
