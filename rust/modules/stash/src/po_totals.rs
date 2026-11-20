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

use serde_json::Value;
use sqlx::PgExecutor;

use crate::rows::purchase_order_row;
use crate::tables::PURCHASE_ORDERS;

const RECOMPUTE: &str = concat!(
    "update purchase_orders t set item_count = s.item_count, ",
    "total_quantity_ordered = s.quantity_ordered, total_quantity_received = s.quantity_received, ",
    "tax_total = s.tax_total, subtotal = s.subtotal, ",
    "total = s.subtotal + s.tax_total + coalesce(t.shipping_total, 0) - coalesce(t.discount_total, 0), ",
    "updated_at = $2::timestamp ",
    "from (select count(*)::integer as item_count, ",
    "coalesce(sum(coalesce(i.quantity_ordered, 0)), 0)::integer as quantity_ordered, ",
    "coalesce(sum(coalesce(i.quantity_received, 0)), 0)::integer as quantity_received, ",
    "coalesce(sum(coalesce(i.tax_amount, 0)), 0) as tax_total, ",
    "coalesce(sum(coalesce(i.total, 0) - coalesce(i.tax_amount, 0)), 0) as subtotal ",
    "from purchase_order_items i where i.purchase_order_id = $1) s ",
    "where t.id = $1 and t.deleted_at is null returning ",
    purchase_order_row!()
);

/// Recompute the header totals of the purchase order `purchase_order_id`
/// from its lines (see the module docs) and set `updated_at` to `now`
/// ([`crate::now`]). Runs on a pool, a connection or inside a transaction.
///
/// Returns the updated row as Drizzle returns it (numeric columns as
/// strings), or `None` when there is no live purchase order with that id.
pub(crate) async fn recompute_po_totals<'e>(
    db: impl PgExecutor<'e>,
    purchase_order_id: &str,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(RECOMPUTE)
        .bind(purchase_order_id)
        .bind(now)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|row| PURCHASE_ORDERS.js(row)))
}
