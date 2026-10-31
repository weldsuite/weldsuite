//! A document's US tax breakdown rows as tax-ledger columns
//! (`sales-tax/to-tax-lines.ts`, `breakdownToTaxLineFields`).

use serde_json::{Map, Value, json};

use crate::js::{js_number_value, slice_utf16, to_fixed, utf16_len};

/// `TaxLineFieldsContext`.
#[derive(Debug, Clone, Default)]
pub struct TaxLineFieldsContext {
    /// -1 writes a credit memo's rows as negative amounts (default 1).
    pub sign: f64,
    /// `sales` or `use`.
    pub direction: Option<String>,
    pub marketplace_facilitated: bool,
    pub ship_to_state: Option<String>,
    pub ship_to_postal_code: Option<String>,
    pub engine: Option<String>,
    pub engine_ref: Option<String>,
}

/// `row.key` as a number (`undefined` is `NaN`, `null` 0).
fn number(row: &Value, key: &str) -> f64 {
    js_number_value(row.get(key))
}

/// `row.key ?? 0`.
fn number_or_zero(row: &Value, key: &str) -> f64 {
    match row.get(key) {
        None | Some(Value::Null) => 0.0,
        value => js_number_value(value),
    }
}

/// `amount(value, sign)`: two decimals, a rounding remnant as 0.
fn amount(value: f64, sign: f64) -> Value {
    let signed = value * sign;
    json!(to_fixed(if signed.abs() < 0.005 { 0.0 } else { signed }, 2))
}

/// `clip(value, length)`: `null` for an empty value, cut to `length`.
fn clip(value: Option<&str>, length: usize) -> Value {
    match value {
        None | Some("") => Value::Null,
        Some(text) if utf16_len(text) > length => json!(slice_utf16(text, length)),
        Some(text) => json!(text),
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `breakdownToTaxLineFields(rows, ctx)`: one map of `tax_lines` properties
/// per row, in the worker's key order.
pub fn breakdown_to_tax_line_fields(
    rows: &[Value],
    ctx: &TaxLineFieldsContext,
) -> Vec<Map<String, Value>> {
    let sign = if ctx.sign == 0.0 { 1.0 } else { ctx.sign };
    rows.iter()
        .map(|row| {
            let taxable = number(row, "taxableAmount");
            let exempt = number_or_zero(row, "exemptAmount");
            let non_taxable = number_or_zero(row, "nonTaxableAmount");
            let unrounded = match row.get("unroundedTaxAmount") {
                None | Some(Value::Null) => number(row, "taxAmount"),
                value => js_number_value(value),
            };
            let using = ctx.direction.as_deref() == Some("use") || text(row, "kind") == Some("use");
            let unrounded_signed = unrounded * sign;
            let mut out = Map::new();
            for (key, value) in [
                ("direction", json!(if using { "use" } else { "sales" })),
                ("sourceLineId", clip(text(row, "lineId"), 30)),
                ("taxRateName", clip(text(row, "taxRateName"), 100)),
                ("rate", json!(to_fixed(number(row, "taxRate"), 4))),
                ("jurisdictionCode", clip(text(row, "jurisdictionCode"), 30)),
                ("jurisdictionName", clip(text(row, "jurisdictionName"), 255)),
                (
                    "jurisdictionLevel",
                    row.get("jurisdictionLevel").cloned().unwrap_or(Value::Null),
                ),
                ("reportingCode", clip(text(row, "reportingCode"), 30)),
                ("stateCode", clip(text(row, "stateCode"), 10)),
                (
                    "agencyId",
                    row.get("agencyId").cloned().unwrap_or(Value::Null),
                ),
                ("grossAmount", amount(taxable + exempt + non_taxable, sign)),
                ("taxableAmount", amount(taxable, sign)),
                ("exemptAmount", amount(exempt, sign)),
                ("nonTaxableAmount", amount(non_taxable, sign)),
                ("exemptReason", clip(text(row, "exemptReason"), 30)),
                ("certificateId", clip(text(row, "certificateId"), 30)),
                (
                    "shipToState",
                    clip(
                        ctx.ship_to_state
                            .as_deref()
                            .or_else(|| text(row, "stateCode")),
                        10,
                    ),
                ),
                (
                    "shipToPostalCode",
                    clip(ctx.ship_to_postal_code.as_deref(), 10),
                ),
                ("taxCode", clip(text(row, "taxCode"), 30)),
                ("marketplaceFacilitated", json!(ctx.marketplace_facilitated)),
                (
                    "unroundedTaxAmount",
                    json!(to_fixed(
                        if unrounded_signed.abs() < 0.000_000_5 {
                            0.0
                        } else {
                            unrounded_signed
                        },
                        6
                    )),
                ),
                ("engine", clip(ctx.engine.as_deref(), 30)),
                ("engineRef", clip(ctx.engine_ref.as_deref(), 255)),
                ("taxAmount", amount(number(row, "taxAmount"), sign)),
            ] {
                out.insert(key.to_owned(), value);
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credit_memo_row_is_negated_and_clipped() {
        let rows = [json!({
            "taxRateId": "", "taxRateName": "CA State", "taxRate": 7.25, "taxableAmount": 100,
            "taxAmount": 7.25, "exemptAmount": 20, "lineId": "ii_1", "stateCode": "CA",
            "jurisdictionLevel": "state", "agencyId": "sta_ca",
        })];
        let fields = breakdown_to_tax_line_fields(
            &rows,
            &TaxLineFieldsContext {
                sign: -1.0,
                ship_to_postal_code: Some("941050000000".to_owned()),
                ..TaxLineFieldsContext::default()
            },
        );
        let f = &fields[0];
        assert_eq!(f["direction"], "sales");
        assert_eq!(f["grossAmount"], "-120.00");
        assert_eq!(f["taxAmount"], "-7.25");
        assert_eq!(f["exemptAmount"], "-20.00");
        assert_eq!(f["nonTaxableAmount"], "0.00");
        assert_eq!(f["unroundedTaxAmount"], "-7.250000");
        assert_eq!(f["rate"], "7.2500");
        assert_eq!(f["shipToState"], "CA");
        assert_eq!(f["shipToPostalCode"], "9410500000");
        assert_eq!(f["engine"], Value::Null);
    }
}
