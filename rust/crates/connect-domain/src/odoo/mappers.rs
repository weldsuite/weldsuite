//! Odoo records as WeldStash values: pure functions, no database and no
//! HTTP, so each sync's mapping is tested on its own.
//!
//! What `search_read` returns: a many2one is `[id, "display name"]` or
//! `false`, an empty char field is `false`, a datetime is UTC text
//! `YYYY-MM-DD HH:MM:SS` (seconds; Odoo stores microseconds), a date
//! `YYYY-MM-DD`.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

// ── Odoo values ──────────────────────────────────────────────────────────────

/// A many2one's id (`[7, "WH"]` or `7`); `false` is none.
pub fn m2o_id(value: &Value) -> Option<i64> {
    match value {
        Value::Array(pair) => pair.first().and_then(Value::as_i64),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
    .filter(|id| *id > 0)
}

/// A many2one's display name.
pub fn m2o_name(value: &Value) -> Option<String> {
    value
        .as_array()
        .and_then(|pair| pair.get(1))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A char field: trimmed text, `false` and `""` as none.
pub fn odoo_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A float or integer field (`false` as none).
pub fn odoo_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// A many2many / one2many: its ids.
pub fn odoo_ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// A record's `id`.
pub fn record_id(record: &Value) -> Option<i64> {
    record.get("id").and_then(Value::as_i64)
}

/// `Math.round` for a quantity, as an integer column takes it.
pub fn round_quantity(value: f64) -> i64 {
    if value.is_finite() {
        (value + 0.5).floor() as i64
    } else {
        0
    }
}

// ── datetimes and watermarks ─────────────────────────────────────────────────

/// `YYYY-MM-DD HH:MM:SS` (or a bare date) as a UTC datetime.
pub fn parse_odoo_datetime(text: &str) -> Option<PrimitiveDateTime> {
    let text = text.trim();
    let (date, time) = text.split_once(' ').unwrap_or((text, "00:00:00"));
    let mut d = date.split('-').map(str::parse::<i64>);
    let (Some(Ok(year)), Some(Ok(month)), Some(Ok(day))) = (d.next(), d.next(), d.next()) else {
        return None;
    };
    let mut t = time
        .split(':')
        .map(|p| p.split('.').next().unwrap_or(p).parse::<u8>());
    let hour = t.next().and_then(Result::ok).unwrap_or(0);
    let minute = t.next().and_then(Result::ok).unwrap_or(0);
    let second = t.next().and_then(Result::ok).unwrap_or(0);
    let date = Date::from_calendar_date(
        i32::try_from(year).ok()?,
        Month::try_from(u8::try_from(month).ok()?).ok()?,
        u8::try_from(day).ok()?,
    )
    .ok()?;
    Some(PrimitiveDateTime::new(
        date,
        Time::from_hms(hour, minute, second).ok()?,
    ))
}

/// The other way: Odoo's datetime text.
pub fn format_odoo_datetime(at: PrimitiveDateTime) -> String {
    format!(
        "{} {:02}:{:02}:{:02}",
        format_date(at.date()),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// `YYYY-MM-DD`.
pub fn format_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// The date part of an Odoo datetime (UTC).
pub fn odoo_date(value: &Value) -> Option<String> {
    parse_odoo_datetime(value.as_str()?).map(|at| format_date(at.date()))
}

/// The later of two Odoo datetimes (same format, so text order is time order).
pub fn later(current: Option<String>, candidate: Option<&str>) -> Option<String> {
    match (
        current,
        candidate.filter(|c| parse_odoo_datetime(c).is_some()),
    ) {
        (Some(current), Some(candidate)) if candidate > current.as_str() => {
            Some(candidate.to_owned())
        }
        (None, Some(candidate)) => Some(candidate.to_owned()),
        (current, _) => current,
    }
}

/// How far behind the server's clock a watermark stays, for transactions
/// that started before a scan and committed after it read their rows (Odoo
/// stamps `write_date` with the transaction's start).
pub const WATERMARK_LAG_SECONDS: i64 = 60;

/// The watermark after a completed scan that ran with `write_date > since`.
///
/// Odoo returns `write_date` in whole seconds but stores microseconds, so
/// `write_date > '12:00:00'` also matches a row written at 12:00:00.4: the
/// newest change seen plus one second is the tightest mark that does not
/// re-read it. The mark also stays [`WATERMARK_LAG_SECONDS`] behind the
/// server's clock at the scan's start (`started`, from the first answer's
/// `Date` header), so a change committed while the scan ran is read on the
/// next pass even when its stamp is older than the newest row seen. It
/// never moves back past `since`.
pub fn next_watermark(
    since: Option<&str>,
    max_seen: Option<&str>,
    started: Option<&str>,
) -> Option<String> {
    let Some(max_seen) = max_seen.and_then(parse_odoo_datetime) else {
        return since.map(str::to_owned);
    };
    let mut mark = max_seen + time::Duration::seconds(1);
    if let Some(started) = started.and_then(parse_odoo_datetime) {
        let lagged = started - time::Duration::seconds(WATERMARK_LAG_SECONDS);
        if lagged < mark {
            mark = lagged;
        }
    }
    if let Some(since) = since.and_then(parse_odoo_datetime)
        && since > mark
    {
        mark = since;
    }
    Some(format_odoo_datetime(mark))
}

/// A server instant as Odoo datetime text.
pub fn odoo_instant(at: OffsetDateTime) -> String {
    let utc = at.to_offset(time::UtcOffset::UTC);
    format_odoo_datetime(PrimitiveDateTime::new(utc.date(), utc.time()))
}

// ── domains (Polish notation) ────────────────────────────────────────────────

/// One domain expression: its tokens.
pub type Expr = Vec<Value>;

/// `[field, op, value]`.
pub fn term(field: &str, op: &str, value: Value) -> Expr {
    vec![Value::Array(vec![json!(field), json!(op), value])]
}

/// Every expression (`&` prefixes); empty ones are left out.
pub fn all_of(parts: Vec<Expr>) -> Expr {
    combine("&", parts)
}

/// Any expression (`|` prefixes); empty ones are left out.
pub fn any_of(parts: Vec<Expr>) -> Expr {
    combine("|", parts)
}

fn combine(op: &str, parts: Vec<Expr>) -> Expr {
    let parts: Vec<Expr> = parts.into_iter().filter(|p| !p.is_empty()).collect();
    let mut out = Vec::new();
    for _ in 1..parts.len() {
        out.push(json!(op));
    }
    for part in parts {
        out.extend(part);
    }
    out
}

/// `field > since` for any of `fields` (none without a watermark).
pub fn changed_since(fields: &[&str], since: Option<&str>) -> Expr {
    let Some(since) = since else {
        return Vec::new();
    };
    any_of(fields.iter().map(|f| term(f, ">", json!(since))).collect())
}

/// The domain value.
pub fn domain(expr: Expr) -> Value {
    Value::Array(expr)
}

// ── units of measure ─────────────────────────────────────────────────────────

/// Units of measure by id (`uom.uom.factor`).
///
/// Odoo 16–18: `factor` is how many of the unit make one reference unit
/// (a dozen: 1/12), `_compute_quantity` is `qty / from.factor * to.factor`.
/// Odoo 19 reworked units: `factor` is how many reference units one of
/// the unit is (a dozen: 12), `qty * from.factor / to.factor`. Which one
/// a server has is told by `relative_factor`, a field only 19 has.
#[derive(Debug, Clone, Default)]
pub struct Uoms {
    pub factors: HashMap<i64, f64>,
    /// Odoo 19's absolute factors.
    pub absolute: bool,
}

impl Uoms {
    /// `qty` in unit `from` as units `to`; unchanged when either is unknown.
    pub fn convert(&self, qty: f64, from: Option<i64>, to: Option<i64>) -> f64 {
        let (Some(from), Some(to)) = (from, to) else {
            return qty;
        };
        if from == to {
            return qty;
        }
        let (Some(f), Some(t)) = (
            self.factors.get(&from).copied().filter(|f| *f > 0.0),
            self.factors.get(&to).copied().filter(|t| *t > 0.0),
        ) else {
            return qty;
        };
        if self.absolute {
            qty * f / t
        } else {
            qty / f * t
        }
    }
}

// ── warehouses ───────────────────────────────────────────────────────────────

/// A `stock.warehouse` as a WeldStash warehouse.
#[derive(Debug, Clone, PartialEq)]
pub struct WarehouseValues {
    pub odoo_id: i64,
    pub name: String,
    pub code: Option<String>,
    pub active: bool,
    pub metadata: Value,
}

pub fn map_warehouse(record: &Value) -> Option<WarehouseValues> {
    let odoo_id = record_id(record)?;
    let code = odoo_text(&record["code"]);
    let name = odoo_text(&record["name"])
        .or_else(|| code.clone())
        .unwrap_or_else(|| format!("Odoo warehouse {odoo_id}"));
    Some(WarehouseValues {
        odoo_id,
        name,
        code,
        // Archived warehouses are read too (`active_test: false`).
        active: record["active"].as_bool().unwrap_or(true),
        metadata: json!({
            "source": "odoo",
            "odoo": {
                "id": odoo_id,
                "lotStockId": m2o_id(&record["lot_stock_id"]),
                "inTypeId": m2o_id(&record["in_type_id"]),
            },
        }),
    })
}

// ── products ─────────────────────────────────────────────────────────────────

/// A `product.product` as a WeldStash product, or a variant of one when its
/// template has more than one variant.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductValues {
    pub odoo_id: i64,
    pub template_id: Option<i64>,
    /// The template's name (`name` is delegated to the template).
    pub name: String,
    /// The attribute values (`Red, L`), for a variant.
    pub variant_name: String,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub cost: Option<f64>,
    pub price: Option<f64>,
    pub weight: Option<f64>,
    pub active: bool,
    /// The template has more than one variant.
    pub multi: bool,
    pub uom_id: Option<i64>,
}

/// `attribute_names`: `product.template.attribute.value` names by id.
pub fn map_product<S: std::hash::BuildHasher>(
    record: &Value,
    attribute_names: &HashMap<i64, String, S>,
) -> Option<ProductValues> {
    let odoo_id = record_id(record)?;
    let sku = odoo_text(&record["default_code"]);
    let name = odoo_text(&record["name"])
        .or_else(|| m2o_name(&record["product_tmpl_id"]))
        .or_else(|| sku.clone())
        .unwrap_or_else(|| format!("Odoo product {odoo_id}"));
    let values: Vec<String> = odoo_ids(&record["product_template_attribute_value_ids"])
        .iter()
        .filter_map(|id| attribute_names.get(id).cloned())
        .collect();
    let variant_name = if values.is_empty() {
        variant_from_display(record, &name).unwrap_or_else(|| name.clone())
    } else {
        values.join(", ")
    };
    Some(ProductValues {
        odoo_id,
        template_id: m2o_id(&record["product_tmpl_id"]),
        name,
        variant_name,
        sku,
        barcode: odoo_text(&record["barcode"]),
        cost: odoo_number(&record["standard_price"]),
        // `lst_price` is the variant's sales price (list price plus the
        // attribute extras); `list_price` the template's.
        price: odoo_number(&record["lst_price"]).or_else(|| odoo_number(&record["list_price"])),
        weight: odoo_number(&record["weight"]).filter(|w| *w > 0.0),
        active: record["active"].as_bool().unwrap_or(true),
        multi: record["product_variant_count"].as_i64().unwrap_or(1) > 1,
        uom_id: m2o_id(&record["uom_id"]),
    })
}

/// `display_name` is `[CODE] Name (Red, L)`: the part in parentheses.
fn variant_from_display(record: &Value, name: &str) -> Option<String> {
    let display = odoo_text(&record["display_name"])?;
    let rest = display
        .find(name)
        .map_or(display.as_str(), |at| &display[at + name.len()..]);
    let inner = rest.trim().strip_prefix('(')?.strip_suffix(')')?;
    Some(inner.trim().to_owned()).filter(|s| !s.is_empty())
}

/// The product types that keep stock: `is_storable` from Odoo 18, the
/// `product` type before.
pub fn storable_domain(has_is_storable: bool, prefix: &str) -> Expr {
    if has_is_storable {
        term(&format!("{prefix}is_storable"), "=", json!(true))
    } else {
        term(&format!("{prefix}type"), "=", json!("product"))
    }
}

// ── suppliers ────────────────────────────────────────────────────────────────

/// A vendor (`res.partner` with `supplier_rank > 0`) as a supplier.
#[derive(Debug, Clone, PartialEq)]
pub struct SupplierValues {
    pub odoo_id: i64,
    pub name: String,
    pub code: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub website: Option<String>,
    pub address_line_1: Option<String>,
    pub address_line_2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub tax_id: Option<String>,
    pub payment_terms: Option<String>,
    pub currency: Option<String>,
    pub active: bool,
    pub metadata: Value,
}

pub fn map_supplier(record: &Value) -> Option<SupplierValues> {
    let odoo_id = record_id(record)?;
    let name = odoo_text(&record["name"])
        .or_else(|| odoo_text(&record["display_name"]))
        .unwrap_or_else(|| format!("Odoo vendor {odoo_id}"));
    let currency = m2o_name(&record["property_purchase_currency_id"])
        .filter(|c| c.len() == 3)
        .map(|c| c.to_uppercase());
    Some(SupplierValues {
        odoo_id,
        name,
        code: odoo_text(&record["ref"]),
        email: odoo_text(&record["email"]),
        phone: odoo_text(&record["phone"]).or_else(|| odoo_text(&record["mobile"])),
        website: odoo_text(&record["website"]),
        address_line_1: odoo_text(&record["street"]),
        address_line_2: odoo_text(&record["street2"]),
        city: odoo_text(&record["city"]),
        state: m2o_name(&record["state_id"]),
        postal_code: odoo_text(&record["zip"]),
        country: odoo_text(&record["country_code"]).or_else(|| m2o_name(&record["country_id"])),
        tax_id: odoo_text(&record["vat"]),
        payment_terms: m2o_name(&record["property_supplier_payment_term_id"]),
        currency,
        active: record["active"].as_bool().unwrap_or(true),
        metadata: json!({ "source": "odoo", "odoo": { "id": odoo_id } }),
    })
}

// ── product suppliers ────────────────────────────────────────────────────────

/// A `product.supplierinfo` (a vendor price line).
#[derive(Debug, Clone, PartialEq)]
pub struct SupplierInfoValues {
    pub odoo_id: i64,
    pub partner_id: i64,
    /// `product_id`: the line is for one variant.
    pub variant: Option<i64>,
    pub template: Option<i64>,
    pub supplier_sku: Option<String>,
    pub supplier_product_name: Option<String>,
    /// Per `uom_id` (the vendor's unit).
    pub price: Option<f64>,
    pub currency: Option<String>,
    /// In `uom_id`.
    pub min_qty: f64,
    pub delay: Option<i64>,
    pub sequence: i64,
    /// `product_uom` (16–18) / `product_uom_id` (19).
    pub uom_id: Option<i64>,
    /// `date_end` is before `today`.
    pub expired: bool,
}

pub fn map_supplierinfo(record: &Value, today: Date) -> Option<SupplierInfoValues> {
    let odoo_id = record_id(record)?;
    let partner_id = m2o_id(&record["partner_id"])?;
    let expired = record["date_end"]
        .as_str()
        .and_then(parse_odoo_datetime)
        .is_some_and(|end| end.date() < today);
    Some(SupplierInfoValues {
        odoo_id,
        partner_id,
        variant: m2o_id(&record["product_id"]),
        template: m2o_id(&record["product_tmpl_id"]),
        supplier_sku: odoo_text(&record["product_code"]),
        supplier_product_name: odoo_text(&record["product_name"]),
        price: odoo_number(&record["price"]),
        currency: m2o_name(&record["currency_id"])
            .filter(|c| c.len() == 3)
            .map(|c| c.to_uppercase()),
        min_qty: odoo_number(&record["min_qty"]).unwrap_or(0.0),
        delay: record["delay"].as_i64().filter(|d| *d >= 0),
        sequence: record["sequence"].as_i64().unwrap_or(1),
        uom_id: m2o_id(&record["product_uom_id"]).or_else(|| m2o_id(&record["product_uom"])),
        expired,
    })
}

/// Which of several vendor lines for one product and vendor WeldStash keeps
/// (`product_suppliers` holds one per product, variant and supplier): Odoo's
/// own order, lowest `sequence`, then the smallest minimum quantity (the
/// base price, not a quantity break), then the oldest line.
pub fn supplierinfo_rank(sequence: i64, min_qty: f64, odoo_id: i64) -> (i64, i64, i64) {
    (sequence, (min_qty * 1000.0).round() as i64, odoo_id)
}

// ── stock ────────────────────────────────────────────────────────────────────

/// On hand and reserved per (Odoo product, Odoo warehouse), summed over
/// the internal locations' quants.
pub type StockTotals = BTreeMap<(i64, i64), (f64, f64)>;

/// Adds one `stock.quant` (quantities in the product's unit).
pub fn add_quant(totals: &mut StockTotals, record: &Value) -> bool {
    let (Some(product), Some(warehouse)) = (
        m2o_id(&record["product_id"]),
        m2o_id(&record["warehouse_id"]),
    ) else {
        return false;
    };
    let entry = totals.entry((product, warehouse)).or_insert((0.0, 0.0));
    entry.0 += odoo_number(&record["quantity"]).unwrap_or(0.0);
    entry.1 += odoo_number(&record["reserved_quantity"]).unwrap_or(0.0);
    true
}

// ── purchase orders ──────────────────────────────────────────────────────────

/// A `purchase.order.line`, in the product's unit.
#[derive(Debug, Clone, PartialEq)]
pub struct PoLineValues {
    pub odoo_id: i64,
    pub product: Option<i64>,
    pub name: String,
    pub ordered: i64,
    pub received: i64,
    /// Per product unit, before discount and tax.
    pub unit_price: f64,
    pub discount_percent: f64,
    pub tax_amount: f64,
    /// Including tax (`price_total`).
    pub total: f64,
}

/// `None` for a section or note line.
pub fn map_po_line(record: &Value) -> Option<PoLineValues> {
    if record["display_type"]
        .as_str()
        .is_some_and(|t| !t.is_empty())
    {
        return None;
    }
    let odoo_id = record_id(record)?;
    let line_qty = odoo_number(&record["product_qty"]).unwrap_or(0.0);
    // `product_uom_qty` is the stored quantity in the product's unit
    // (16–19); the line's own unit can be a pack. Its ratio converts the
    // received quantity and the unit price, which are per line unit.
    let base_qty = odoo_number(&record["product_uom_qty"]).unwrap_or(line_qty);
    let ratio = if line_qty > 0.0 && base_qty > 0.0 {
        base_qty / line_qty
    } else {
        1.0
    };
    let received = odoo_number(&record["qty_received"]).unwrap_or(0.0) * ratio;
    let price_unit = odoo_number(&record["price_unit"]).unwrap_or(0.0);
    let name = odoo_text(&record["name"])
        .map(|n| n.lines().next().unwrap_or_default().trim().to_owned())
        .filter(|n| !n.is_empty())
        .or_else(|| m2o_name(&record["product_id"]))
        .unwrap_or_else(|| format!("Odoo line {odoo_id}"));
    Some(PoLineValues {
        odoo_id,
        product: m2o_id(&record["product_id"]),
        name,
        ordered: round_quantity(base_qty),
        received: round_quantity(received),
        unit_price: price_unit / ratio,
        discount_percent: odoo_number(&record["discount"]).unwrap_or(0.0),
        tax_amount: odoo_number(&record["price_tax"]).unwrap_or(0.0),
        total: odoo_number(&record["price_total"]).unwrap_or(0.0),
    })
}

/// A purchase order's WeldStash status from Odoo's state and what arrived.
///
/// `draft`, `sent` and `to approve` are RFQs (`pending`); a confirmed order
/// (`purchase`) is `ordered`, `partial` once something arrived and
/// `received` once everything did; `cancel` is `cancelled`. Odoo 16–18's
/// `done` ("Locked") is a confirmed order too: with "Lock confirmed orders"
/// on, an order is locked right at confirmation, so `done` alone does not
/// mean received (Odoo 19 has no `done`, only a `locked` flag).
///
/// `receipt_status` (`purchase.order`, stored by `purchase_stock` in 16–19:
/// `full` once every receipt is done or cancelled) settles the rest: an
/// order received short and validated with "No backorder" stays
/// `purchase`/`done` with less received than ordered, and Odoo calls it
/// `full`. It becomes `received`, not `closed`: `closed` is WeldStash's own
/// action on its own orders, and `received` already leaves the statuses
/// incoming stock counts (`approved`, `ordered`, `partial`), so the units
/// that never came stop counting as on their way.
pub fn po_status(
    state: &str,
    receipt_status: Option<&str>,
    lines: &[PoLineValues],
) -> &'static str {
    match state {
        "cancel" => "cancelled",
        "purchase" | "done" if receipt_status == Some("full") => "received",
        "purchase" | "done" => {
            let ordered: i64 = lines.iter().map(|l| l.ordered).sum();
            let received: i64 = lines.iter().map(|l| l.received.min(l.ordered)).sum();
            if ordered > 0 && received >= ordered {
                "received"
            } else if lines.iter().any(|l| l.received > 0) {
                "partial"
            } else {
                "ordered"
            }
        }
        _ => "pending",
    }
}

// ── sales ────────────────────────────────────────────────────────────────────

/// A `sale.order.line` as demand.
#[derive(Debug, Clone, PartialEq)]
pub struct SaleLineValues {
    pub odoo_id: i64,
    pub order_id: Option<i64>,
    pub product: Option<i64>,
    /// In `uom_id`.
    pub quantity: f64,
    pub uom_id: Option<i64>,
    pub warehouse: Option<i64>,
    /// The order is confirmed (`sale`, or 16's `done`) and the line is a
    /// product line: it counts as demand. Anything else is removed.
    pub counts: bool,
}

pub fn map_sale_line(record: &Value) -> Option<SaleLineValues> {
    let odoo_id = record_id(record)?;
    let product_line = record["display_type"].as_str().is_none_or(str::is_empty)
        && !record["is_downpayment"].as_bool().unwrap_or(false);
    let confirmed = matches!(record["state"].as_str(), Some("sale" | "done"));
    Some(SaleLineValues {
        odoo_id,
        order_id: m2o_id(&record["order_id"]),
        product: m2o_id(&record["product_id"]),
        quantity: odoo_number(&record["product_uom_qty"]).unwrap_or(0.0),
        // `product_uom` (16–18) / `product_uom_id` (19).
        uom_id: m2o_id(&record["product_uom_id"]).or_else(|| m2o_id(&record["product_uom"])),
        warehouse: m2o_id(&record["warehouse_id"]),
        counts: product_line && confirmed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_read_as_odoo_writes_them() {
        assert_eq!(m2o_id(&json!([7, "WH"])), Some(7));
        assert_eq!(m2o_id(&json!(false)), None);
        assert_eq!(m2o_name(&json!([7, " WH "])), Some("WH".to_owned()));
        assert_eq!(odoo_text(&json!(false)), None);
        assert_eq!(odoo_text(&json!("  ")), None);
        assert_eq!(odoo_ids(&json!([1, 2])), vec![1, 2]);
        assert_eq!(round_quantity(2.5), 3);
        assert_eq!(round_quantity(-2.5), -2);
        assert_eq!(round_quantity(f64::NAN), 0);
    }

    #[test]
    fn watermarks_stay_behind_the_server_clock() {
        // Quiet: the newest change plus a second.
        assert_eq!(
            next_watermark(
                None,
                Some("2026-11-18 10:00:00"),
                Some("2026-11-18 11:00:00")
            ),
            Some("2026-11-18 10:00:01".to_owned())
        );
        // Busy: a minute behind the scan's start.
        assert_eq!(
            next_watermark(
                None,
                Some("2026-11-18 10:59:59"),
                Some("2026-11-18 11:00:00")
            ),
            Some("2026-11-18 10:59:00".to_owned())
        );
        // Nothing seen: unchanged.
        assert_eq!(
            next_watermark(
                Some("2026-11-18 09:00:00"),
                None,
                Some("2026-11-18 11:00:00")
            ),
            Some("2026-11-18 09:00:00".to_owned())
        );
        // Never backwards.
        assert_eq!(
            next_watermark(
                Some("2026-11-18 10:59:30"),
                Some("2026-11-18 10:59:40"),
                Some("2026-11-18 11:00:00")
            ),
            Some("2026-11-18 10:59:30".to_owned())
        );
        // No server clock: the newest change plus a second.
        assert_eq!(
            next_watermark(None, Some("2026-12-31 23:59:59"), None),
            Some("2027-01-01 00:00:00".to_owned())
        );
        assert_eq!(
            later(
                Some("2026-01-02 00:00:00".to_owned()),
                Some("2026-01-01 00:00:00")
            )
            .as_deref(),
            Some("2026-01-02 00:00:00")
        );
        assert_eq!(later(None, Some("x")), None);
        assert_eq!(
            odoo_date(&json!("2026-03-04 23:10:00")),
            Some("2026-03-04".to_owned())
        );
    }

    #[test]
    fn domains_are_polish() {
        let d = domain(all_of(vec![
            term("a", "=", json!(1)),
            changed_since(
                &["write_date", "order_id.write_date"],
                Some("2026-01-01 00:00:00"),
            ),
            Vec::new(),
            term("id", ">", json!(5)),
        ]));
        assert_eq!(
            d,
            json!([
                "&",
                "&",
                ["a", "=", 1],
                "|",
                ["write_date", ">", "2026-01-01 00:00:00"],
                ["order_id.write_date", ">", "2026-01-01 00:00:00"],
                ["id", ">", 5]
            ])
        );
        assert_eq!(
            domain(all_of(vec![changed_since(&["write_date"], None)])),
            json!([])
        );
        assert_eq!(
            storable_domain(true, "product_id."),
            vec![json!(["product_id.is_storable", "=", true])]
        );
        assert_eq!(
            storable_domain(false, ""),
            vec![json!(["type", "=", "product"])]
        );
    }

    #[test]
    fn units_convert_both_ways() {
        // Odoo 17: Units factor 1, Dozens 1/12.
        let old = Uoms {
            factors: HashMap::from([(1, 1.0), (2, 1.0 / 12.0)]),
            absolute: false,
        };
        assert!((old.convert(2.0, Some(2), Some(1)) - 24.0).abs() < 1e-9);
        // Odoo 19: Dozens factor 12.
        let new = Uoms {
            factors: HashMap::from([(1, 1.0), (2, 12.0)]),
            absolute: true,
        };
        assert!((new.convert(2.0, Some(2), Some(1)) - 24.0).abs() < 1e-9);
        assert!((new.convert(2.0, Some(9), Some(1)) - 2.0).abs() < 1e-9);
        assert!((new.convert(2.0, None, Some(1)) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn warehouses_map() {
        let w = map_warehouse(&json!({
            "id": 1, "name": "San Francisco", "code": "WH", "active": true,
            "lot_stock_id": [8, "WH/Stock"], "in_type_id": [1, "San Francisco: Receipts"],
        }))
        .expect("warehouse");
        assert_eq!(w.name, "San Francisco");
        assert_eq!(w.code.as_deref(), Some("WH"));
        assert!(w.active);
        assert_eq!(w.metadata["odoo"]["inTypeId"], json!(1));
        let archived =
            map_warehouse(&json!({ "id": 2, "name": false, "code": "OLD", "active": false }))
                .expect("w");
        assert_eq!(archived.name, "OLD");
        assert!(!archived.active);
    }

    #[test]
    fn products_map() {
        let single = map_product(
            &json!({
                "id": 10, "name": "Desk lamp", "default_code": "LAMP-1", "barcode": false,
                "product_tmpl_id": [5, "Desk lamp"], "product_variant_count": 1,
                "standard_price": 12.5, "lst_price": 39.0, "weight": 0, "active": true,
                "uom_id": [1, "Units"], "product_template_attribute_value_ids": [],
            }),
            &HashMap::new(),
        )
        .expect("product");
        assert!(!single.multi);
        assert_eq!(single.sku.as_deref(), Some("LAMP-1"));
        assert_eq!(single.cost, Some(12.5));
        assert_eq!(single.weight, None);
        assert_eq!(single.template_id, Some(5));
        let variant = map_product(
            &json!({
                "id": 11, "name": "Shade", "default_code": "SHADE-R", "display_name": "[SHADE-R] Shade (Red)",
                "product_tmpl_id": [6, "Shade"], "product_variant_count": 2, "list_price": 20.0,
                "product_template_attribute_value_ids": [3, 4],
            }),
            &HashMap::from([(3, "Red".to_owned()), (4, "Large".to_owned())]),
        )
        .expect("variant");
        assert!(variant.multi);
        assert_eq!(variant.variant_name, "Red, Large");
        assert_eq!(variant.price, Some(20.0));
        let from_display = map_product(
            &json!({ "id": 12, "name": "Shade", "display_name": "[SHADE-B] Shade (Blue)", "product_variant_count": 2 }),
            &HashMap::new(),
        )
        .expect("variant");
        assert_eq!(from_display.variant_name, "Blue");
    }

    #[test]
    fn suppliers_map() {
        let s = map_supplier(&json!({
            "id": 14, "name": "Azure Interior", "ref": "AZ", "email": "info@azure.example",
            "phone": false, "mobile": "+32 1", "street": "4557 De Silva St", "city": "Fremont",
            "state_id": [13, "California (US)"], "zip": "94538", "country_id": [233, "United States"],
            "country_code": "US", "vat": false, "active": true, "supplier_rank": 3,
            "property_purchase_currency_id": [1, "EUR"], "property_supplier_payment_term_id": [2, "30 Days"],
        }))
        .expect("supplier");
        assert_eq!(s.code.as_deref(), Some("AZ"));
        assert_eq!(s.phone.as_deref(), Some("+32 1"));
        assert_eq!(s.country.as_deref(), Some("US"));
        assert_eq!(s.currency.as_deref(), Some("EUR"));
        assert_eq!(s.payment_terms.as_deref(), Some("30 Days"));
        assert_eq!(s.tax_id, None);
    }

    #[test]
    fn supplierinfo_maps() {
        let today = Date::from_calendar_date(2026, Month::November, 18).expect("date");
        let line = map_supplierinfo(
            &json!({
                "id": 3, "partner_id": [14, "Azure"], "product_tmpl_id": [5, "Lamp"], "product_id": false,
                "product_code": "AZ-L", "product_name": false, "price": 10.0, "currency_id": [1, "EUR"],
                "min_qty": 12.0, "delay": 7, "sequence": 1, "product_uom": [2, "Dozens"], "date_end": false,
            }),
            today,
        )
        .expect("line");
        assert_eq!(line.template, Some(5));
        assert_eq!(line.variant, None);
        assert_eq!(line.uom_id, Some(2));
        assert_eq!(line.delay, Some(7));
        assert!(!line.expired);
        let expired = map_supplierinfo(
            &json!({ "id": 4, "partner_id": [14, "Azure"], "date_end": "2026-11-17", "product_uom_id": [1, "Units"] }),
            today,
        )
        .expect("line");
        assert!(expired.expired);
        assert_eq!(expired.uom_id, Some(1));
        assert!(map_supplierinfo(&json!({ "id": 5, "partner_id": false }), today).is_none());
        assert!(supplierinfo_rank(1, 0.0, 9) < supplierinfo_rank(1, 10.0, 2));
        assert!(supplierinfo_rank(1, 10.0, 2) < supplierinfo_rank(2, 0.0, 1));
    }

    #[test]
    fn quants_sum_per_product_and_warehouse() {
        let mut totals = StockTotals::new();
        assert!(add_quant(
            &mut totals,
            &json!({ "product_id": [10, "Lamp"], "warehouse_id": [1, "WH"], "quantity": 5.0, "reserved_quantity": 1.0 })
        ));
        assert!(add_quant(
            &mut totals,
            &json!({ "product_id": [10, "Lamp"], "warehouse_id": [1, "WH"], "quantity": 2.5, "reserved_quantity": 0.0 })
        ));
        assert!(!add_quant(
            &mut totals,
            &json!({ "product_id": [10, "Lamp"], "warehouse_id": false, "quantity": 9.0 })
        ));
        assert_eq!(totals.get(&(10, 1)), Some(&(7.5, 1.0)));
    }

    #[test]
    fn purchase_lines_and_statuses() {
        let line = map_po_line(&json!({
            "id": 40, "product_id": [10, "[LAMP-1] Desk lamp"], "name": "[LAMP-1] Desk lamp\nwarm white",
            "product_qty": 2.0, "product_uom_qty": 24.0, "qty_received": 1.0, "price_unit": 120.0,
            "discount": 0.0, "price_tax": 50.4, "price_total": 290.4, "display_type": false,
        }))
        .expect("line");
        assert_eq!(line.name, "[LAMP-1] Desk lamp");
        assert_eq!(line.ordered, 24);
        assert_eq!(line.received, 12);
        assert!((line.unit_price - 10.0).abs() < 1e-9);
        assert!(
            map_po_line(&json!({ "id": 41, "display_type": "line_section", "name": "Lamps" }))
                .is_none()
        );

        let open = vec![PoLineValues {
            received: 0,
            ..line.clone()
        }];
        let part = vec![line.clone()];
        let full = vec![PoLineValues {
            received: 24,
            ..line.clone()
        }];
        assert_eq!(po_status("draft", None, &open), "pending");
        assert_eq!(po_status("sent", None, &open), "pending");
        assert_eq!(po_status("to approve", None, &open), "pending");
        assert_eq!(po_status("purchase", None, &open), "ordered");
        assert_eq!(po_status("purchase", None, &part), "partial");
        assert_eq!(po_status("purchase", None, &full), "received");
        assert_eq!(po_status("done", None, &open), "ordered");
        assert_eq!(po_status("done", None, &full), "received");
        assert_eq!(po_status("cancel", None, &full), "cancelled");
        // Received short, validated without a backorder: Odoo says `full`.
        assert_eq!(po_status("purchase", Some("full"), &part), "received");
        assert_eq!(po_status("done", Some("full"), &part), "received");
        assert_eq!(po_status("purchase", Some("partial"), &part), "partial");
        assert_eq!(po_status("purchase", Some("pending"), &open), "ordered");
        assert_eq!(po_status("cancel", Some("full"), &part), "cancelled");
        assert_eq!(po_status("draft", Some("full"), &open), "pending");
    }

    #[test]
    fn the_generic_ingest_leaves_odoo_entities_alone() {
        for entity in ["product_supplier", "sales_history"] {
            assert!(
                crate::mappers::map_connector_record(entity, &json!({ "id": 1 }), "odoo").is_none()
            );
        }
    }

    #[test]
    fn sale_lines_map() {
        let line = map_sale_line(&json!({
            "id": 70, "order_id": [9, "S00009"], "product_id": [10, "Lamp"], "product_uom_qty": 3.0,
            "product_uom": [1, "Units"], "state": "sale", "display_type": false, "warehouse_id": [1, "WH"],
        }))
        .expect("line");
        assert!(line.counts);
        assert_eq!(line.uom_id, Some(1));
        assert_eq!(line.warehouse, Some(1));
        let v19 = map_sale_line(&json!({ "id": 71, "state": "sale", "product_uom_id": [2, "Dozens"], "display_type": false })).expect("line");
        assert_eq!(v19.uom_id, Some(2));
        let cancelled =
            map_sale_line(&json!({ "id": 72, "state": "cancel", "display_type": false }))
                .expect("line");
        assert!(!cancelled.counts);
        let note =
            map_sale_line(&json!({ "id": 73, "state": "sale", "display_type": "line_note" }))
                .expect("line");
        assert!(!note.counts);
        let done16 = map_sale_line(&json!({ "id": 74, "state": "done", "display_type": false }))
            .expect("line");
        assert!(done16.counts);
    }
}
