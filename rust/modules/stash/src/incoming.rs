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

use serde_json::{Value, json};
use sqlx::PgExecutor;
use time::{Date, Month};

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

/// The open-line conditions, at `$1`–`$5`: statuses, product ids (or
/// null), the variant mode (`any` | `none` | `only`), the variant, the
/// warehouse (or null).
macro_rules! open_lines {
    () => {
        "from purchase_order_items i join purchase_orders o on o.id = i.purchase_order_id \
         where o.deleted_at is null and o.status = any($1) \
         and coalesce(i.product_id, '') <> '' and coalesce(o.warehouse_id, '') <> '' \
         and i.quantity_ordered - coalesce(i.quantity_received, 0) - coalesce(i.quantity_rejected, 0) > 0 \
         and ($2::text[] is null or i.product_id = any($2)) \
         and ($3::text = 'any' \
              or ($3::text = 'none' and coalesce(i.variant_id, '') = '') \
              or ($3::text = 'only' and i.variant_id = $4)) \
         and ($5::text is null or o.warehouse_id = $5)"
    };
}

const INCOMING: &str = concat!(
    "select i.product_id, nullif(i.variant_id, ''), o.warehouse_id, ",
    "sum(i.quantity_ordered - coalesce(i.quantity_received, 0) - coalesce(i.quantity_rejected, 0))::bigint, ",
    "to_jsonb(min(o.expected_date)) #>> '{}' ",
    open_lines!(),
    " group by i.product_id, nullif(i.variant_id, ''), o.warehouse_id",
    " order by i.product_id, nullif(i.variant_id, '') nulls first, o.warehouse_id"
);

const LINES: &str = concat!(
    "select o.id, i.id, i.product_id, nullif(i.variant_id, ''), o.warehouse_id, ",
    "(i.quantity_ordered - coalesce(i.quantity_received, 0) - coalesce(i.quantity_rejected, 0))::bigint, ",
    "to_char(o.expected_date, 'YYYY-MM-DD') ",
    open_lines!(),
    " order by i.product_id, nullif(i.variant_id, '') nulls first, o.warehouse_id, ",
    "o.expected_date nulls last, o.id, i.id"
);

fn variant_mode(filter: &VariantFilter) -> (&'static str, Option<&str>) {
    match filter {
        VariantFilter::Any => ("any", None),
        VariantFilter::None => ("none", None),
        VariantFilter::Only(id) => ("only", Some(id.as_str())),
    }
}

type IncomingRow = (String, Option<String>, String, i64, Option<String>);
type LineRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    i64,
    Option<String>,
);

/// Incoming stock per item (product, variant, destination warehouse) for
/// the items `query` selects, ordered by product, variant (none first) and
/// warehouse. Items with nothing to come are not listed.
pub(crate) async fn incoming<'e>(
    db: impl PgExecutor<'e>,
    query: &IncomingQuery,
) -> Result<Vec<Incoming>, sqlx::Error> {
    let (mode, variant) = variant_mode(&query.variant);
    let rows: Vec<IncomingRow> = sqlx::query_as(INCOMING)
        .bind(&INCOMING_STATUSES[..])
        .bind(query.product_ids.as_deref())
        .bind(mode)
        .bind(variant)
        .bind(query.warehouse_id.as_deref())
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(product_id, variant_id, warehouse_id, quantity, next)| Incoming {
                product_id,
                variant_id,
                warehouse_id,
                quantity,
                next_expected_date: next
                    .map(|text| weldsuite_db::js_timestamp(&text).unwrap_or(text)),
            },
        )
        .collect())
}

/// The open purchase order lines `query` selects, one by one, ordered by
/// item, then expected date (none last).
pub(crate) async fn incoming_lines<'e>(
    db: impl PgExecutor<'e>,
    query: &IncomingQuery,
) -> Result<Vec<IncomingLine>, sqlx::Error> {
    let (mode, variant) = variant_mode(&query.variant);
    let rows: Vec<LineRow> = sqlx::query_as(LINES)
        .bind(&INCOMING_STATUSES[..])
        .bind(query.product_ids.as_deref())
        .bind(mode)
        .bind(variant)
        .bind(query.warehouse_id.as_deref())
        .fetch_all(db)
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
                    expected_date: date.as_deref().and_then(parse_date),
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

    #[test]
    fn the_variant_filter_binds_a_mode() {
        assert_eq!(variant_mode(&VariantFilter::Any), ("any", None));
        assert_eq!(variant_mode(&VariantFilter::None), ("none", None));
        assert_eq!(
            variant_mode(&VariantFilter::Only("var_1".to_owned())),
            ("only", Some("var_1"))
        );
    }
}
