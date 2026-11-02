//! A document's US tax breakdown rows as tax-ledger columns
//! (`sales-tax/to-tax-lines.ts`, `breakdownToTaxLineFields`).

use serde_json::{Map, Value, json};

use super::common::active_registrations;
use super::dates::iso_day;
use super::rounding::{
    TaxCell, from_cents, round_half_up, round_tax_cells, rounding_for, snap6, to_cents,
};
use super::types::{Registration, SalesTaxResult};
use crate::js::{js_number_value, number_value, slice_utf16, to_fixed, utf16_len};
use crate::jurisdictions::us;

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

/// `TaxLineContext`.
#[derive(Debug, Clone, Default)]
pub struct TaxLineContext<'a> {
    /// The tax code of each document line.
    pub lines: Vec<(String, Option<String>)>,
    /// `use` for a bill's use tax accrual.
    pub use_tax: bool,
    pub marketplace_facilitated: bool,
    /// Lets a line without jurisdiction detail carry its ship-to state's agency.
    pub registrations: &'a [Registration],
    /// Tax point for the registration lookup; default the calculation's day.
    pub document_date: Option<String>,
}

fn put(row: &mut Map<String, Value>, key: &str, value: Value) {
    row.insert(key.to_owned(), value);
}

/// `salesTaxResultToBreakdown(result, ctx)`: one `tax_breakdown` row per
/// line per jurisdiction. A line the engine charged nothing on becomes one
/// zero-tax row in its ship-to state, so the sale counts toward gross sales
/// and nexus.
#[allow(
    clippy::too_many_lines,
    reason = "one row shape per branch, as to-tax-lines.ts writes them"
)]
pub fn sales_tax_result_to_breakdown(
    result: &SalesTaxResult,
    ctx: &TaxLineContext<'_>,
) -> Vec<Value> {
    let kind = if ctx.use_tax { "use" } else { "tax" };
    // `new Map(ctx.lines.map(...))`: the last line with an id wins.
    let tax_code_of = |line_id: &str| {
        ctx.lines
            .iter()
            .rev()
            .find(|(id, _)| id == line_id)
            .and_then(|(_, code)| code.clone())
            .filter(|c| !c.is_empty())
    };
    let state = result.ship_to_state.as_deref();
    let state_name = state.map(|s| {
        us::state(Some(s))
            .and_then(|info| info["name"].as_str())
            .unwrap_or(s)
            .to_owned()
    });
    let synthetic_agency = state.and_then(|s| {
        let date = ctx
            .document_date
            .clone()
            .unwrap_or_else(|| iso_day(&result.calculated_at));
        let mut active = active_registrations(ctx.registrations, s, &date);
        active.sort_by_key(|r| u8::from(r.level == "local"));
        active.first().map(|r| r.agency_id.clone())
    });
    let mut rows = Vec::new();
    for line in &result.lines {
        let tax_code = tax_code_of(&line.line_id);
        if line.details.is_empty() {
            let (Some(state), Some(state_name)) = (state, state_name.as_deref()) else {
                continue;
            };
            let mut row = Map::new();
            put(&mut row, "taxRateId", json!(""));
            put(&mut row, "taxRateName", json!(state_name));
            put(&mut row, "taxRate", json!(0));
            put(&mut row, "taxableAmount", json!(0));
            put(&mut row, "taxAmount", json!(0));
            if ctx.use_tax {
                put(&mut row, "selfAssessed", json!(true));
            }
            put(&mut row, "lineId", json!(line.line_id));
            put(&mut row, "jurisdictionCode", json!(state));
            put(&mut row, "jurisdictionName", json!(state_name));
            put(&mut row, "jurisdictionLevel", json!("state"));
            put(&mut row, "stateCode", json!(state));
            if let Some(agency) = synthetic_agency.as_deref().filter(|a| !a.is_empty()) {
                put(&mut row, "agencyId", json!(agency));
            }
            put(&mut row, "exemptAmount", number_value(line.exempt_amount));
            put(
                &mut row,
                "nonTaxableAmount",
                number_value(from_cents(
                    to_cents(line.gross_amount) - to_cents(line.exempt_amount),
                )),
            );
            put(&mut row, "unroundedTaxAmount", json!(0));
            if let Some(code) = &tax_code {
                put(&mut row, "taxCode", json!(code));
            }
            put(&mut row, "kind", json!(kind));
            rows.push(Value::Object(row));
            continue;
        }
        for d in &line.details {
            let mut row = Map::new();
            put(&mut row, "taxRateId", json!(""));
            put(&mut row, "taxRateName", json!(d.jurisdiction_name));
            put(&mut row, "taxRate", number_value(d.rate));
            put(&mut row, "taxableAmount", number_value(d.taxable_amount));
            put(&mut row, "taxAmount", number_value(d.tax));
            if ctx.use_tax {
                put(&mut row, "selfAssessed", json!(true));
            }
            put(&mut row, "lineId", json!(line.line_id));
            put(&mut row, "jurisdictionCode", json!(d.jurisdiction_code));
            put(&mut row, "jurisdictionName", json!(d.jurisdiction_name));
            put(&mut row, "jurisdictionLevel", json!(d.level.as_str()));
            put(&mut row, "stateCode", json!(d.state_code));
            if let Some(agency) = d.agency_id.as_deref().filter(|a| !a.is_empty()) {
                put(&mut row, "agencyId", json!(agency));
            }
            if let Some(code) = d.reporting_code.as_deref().filter(|c| !c.is_empty()) {
                put(&mut row, "reportingCode", json!(code));
            }
            put(&mut row, "exemptAmount", number_value(d.exempt_amount));
            put(
                &mut row,
                "nonTaxableAmount",
                number_value(d.non_taxable_amount),
            );
            if let Some(reason) = d.exempt_reason.as_deref().filter(|r| !r.is_empty()) {
                put(&mut row, "exemptReason", json!(reason));
            }
            if let Some(id) = d.certificate_id.as_deref().filter(|c| !c.is_empty()) {
                put(&mut row, "certificateId", json!(id));
            }
            put(
                &mut row,
                "unroundedTaxAmount",
                number_value(d.unrounded_tax),
            );
            if let Some(code) = &tax_code {
                put(&mut row, "taxCode", json!(code));
            }
            put(&mut row, "kind", json!(kind));
            rows.push(Value::Object(row));
        }
    }
    rows
}

/// `salesTaxResultToTaxLines(result, ctx)`: breakdown rows and their ledger
/// columns.
pub fn sales_tax_result_to_tax_lines(
    result: &SalesTaxResult,
    ctx: &TaxLineContext<'_>,
) -> (Vec<Value>, Vec<Map<String, Value>>) {
    let breakdown = sales_tax_result_to_breakdown(result, ctx);
    let tax_lines = breakdown_to_tax_line_fields(
        &breakdown,
        &TaxLineFieldsContext {
            sign: 1.0,
            direction: Some(if ctx.use_tax { "use" } else { "sales" }.to_owned()),
            marketplace_facilitated: ctx.marketplace_facilitated,
            ship_to_state: result.ship_to_state.clone(),
            ship_to_postal_code: result.ship_to_postal_code.clone(),
            engine: Some(result.engine.clone()),
            engine_ref: result.engine_ref.clone(),
        },
    );
    (breakdown, tax_lines)
}

/// `breakdownTaxTotal(rows)`: whole cents of `taxAmount`.
pub fn breakdown_tax_total(rows: &[Value]) -> f64 {
    from_cents(
        rows.iter()
            .map(|r| to_cents(number_or_zero(r, "taxAmount")))
            .sum(),
    )
}

/// `lineGross(row)`: taxable + exempt + non-taxable.
pub fn line_gross(row: &Value) -> f64 {
    number(row, "taxableAmount")
        + number_or_zero(row, "exemptAmount")
        + number_or_zero(row, "nonTaxableAmount")
}

/// `reverseResultForCreditMemo(original, creditLines)`: a credit memo's
/// breakdown from the original invoice's rows, for the credited share of
/// each line: a full credit copies the rows, a partial one scales the bases
/// and recomputes the tax at the original rates, rounded per the state's
/// rule over the memo.
pub fn reverse_result_for_credit_memo(
    original: &[Value],
    credit_lines: &[(String, f64)],
) -> Vec<Value> {
    let rows_of = |line_id: &str| -> Vec<&Value> {
        original
            .iter()
            .filter(|r| text(r, "lineId").is_some_and(|id| !id.is_empty() && id == line_id))
            .collect()
    };
    let mut out: Vec<Value> = Vec::new();
    let mut partial: Vec<usize> = Vec::new();
    let mut cells: Vec<TaxCell> = Vec::new();
    for (line_id, amount) in credit_lines {
        let rows = rows_of(line_id);
        if rows.is_empty() {
            continue;
        }
        let gross = line_gross(rows[0]);
        let ratio = if gross == 0.0 { 0.0 } else { amount / gross };
        let full = (ratio - 1.0).abs() < 1e-9;
        for row in rows {
            if full {
                out.push(row.clone());
                continue;
            }
            let taxable = round_half_up(number(row, "taxableAmount") * ratio, 2);
            let exempt = round_half_up(number_or_zero(row, "exemptAmount") * ratio, 2);
            let unrounded = snap6((taxable * number(row, "taxRate")) / 100.0);
            let mut copy = row.as_object().cloned().unwrap_or_default();
            put(&mut copy, "taxableAmount", number_value(taxable));
            put(&mut copy, "exemptAmount", number_value(exempt));
            put(
                &mut copy,
                "nonTaxableAmount",
                number_value(from_cents(
                    to_cents(*amount) - to_cents(taxable) - to_cents(exempt),
                )),
            );
            put(&mut copy, "taxAmount", json!(0));
            put(&mut copy, "unroundedTaxAmount", number_value(unrounded));
            out.push(Value::Object(copy));
            partial.push(out.len() - 1);
            cells.push(TaxCell {
                line_id: line_id.clone(),
                jurisdiction_key: format!(
                    "{}|{}",
                    text(row, "agencyId").unwrap_or(""),
                    text(row, "jurisdictionCode").unwrap_or("")
                ),
                unrounded,
            });
        }
    }
    if !cells.is_empty() {
        let state = text(&out[partial[0]], "stateCode").map(str::to_owned);
        let rounded = round_tax_cells(&cells, rounding_for(state.as_deref()));
        for (k, index) in partial.iter().enumerate() {
            if let Some(row) = out[*index].as_object_mut() {
                row.insert("taxAmount".into(), number_value(from_cents(rounded[k])));
            }
        }
    }
    out
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
