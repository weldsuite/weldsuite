//! Line totals and the tax breakdown of a document
//! (`services/accounting-tax-totals.ts`): the rate-table calculation (VAT,
//! GST with India's CGST/SGST/IGST split) and the totals of a jurisdiction
//! whose hook calculates the whole document at once (Brazil).

use serde_json::{Map, Value};

use super::Direction;
use crate::js;
use crate::jurisdictions::india::{self, GstExpansion};
use crate::jurisdictions::js_trim;

/// One line as the totals read it (`TaxTotalsItemInput`).
#[derive(Debug, Clone, Default)]
pub struct TaxTotalsItem {
    pub quantity: String,
    pub unit_price: String,
    pub discount_percent: String,
    pub tax_rate: Option<String>,
    pub tax_rate_id: Option<String>,
    pub tax_rate_name: Option<String>,
    pub tax_category_code: Option<String>,
    pub jurisdiction_metadata: Option<Value>,
    /// Brazil: NCM, CFOP and the line's rate overrides.
    pub fiscal_data: Option<Value>,
}

/// `PlaceOfSupplyContext`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaceOfSupply {
    pub jurisdiction_code: Option<String>,
    pub seller_state_code: Option<String>,
    pub buyer_state_code: Option<String>,
    pub buyer_country: Option<String>,
    pub direction: Option<Direction>,
}

/// A line's totals (`lineTotal`, `lineTotalWithTax`, `taxAmount`, two
/// decimals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineTotals {
    pub line_total: String,
    pub line_total_with_tax: String,
    pub tax_amount: String,
}

/// A document's totals.
#[derive(Debug, Clone, PartialEq)]
pub struct Totals {
    pub subtotal: String,
    pub discount_total: String,
    pub tax_total: String,
    pub total: String,
    pub balance_due: String,
    /// `TaxBreakdownRow`s.
    pub tax_breakdown: Vec<Value>,
    pub processed_items: Vec<LineTotals>,
    /// The hook's notes (`calculateHookTaxTotals` only).
    pub tax_warnings: Option<Vec<String>>,
}

/// `SELF_ASSESSED_PURCHASE_CATEGORIES`: EU acquisitions and services,
/// imports and domestic reverse charge; the supplier charges no tax.
const SELF_ASSESSED_PURCHASE_CATEGORIES: [&str; 3] =
    ["eu_b2b_service", "import_goods", "reverse_charge"];

/// `parseQuantity(raw)`: 1 when it does not parse.
fn parse_quantity(raw: &str) -> f64 {
    let parsed = js::parse_float(raw);
    if parsed.is_finite() { parsed } else { 1.0 }
}

/// `parseAmount(raw, 0)`.
fn parse_amount(raw: Option<&str>) -> f64 {
    let parsed = js::parse_float(raw.unwrap_or_default());
    if parsed.is_finite() { parsed } else { 0.0 }
}

/// `roundMoney(n)`: `Math.round(n * 100) / 100`.
fn round_money(n: f64) -> f64 {
    js::round_cents(n)
}

/// A number property of a row (`row.taxAmount`).
fn amount(row: &Map<String, Value>, key: &str) -> f64 {
    row.get(key).map_or(0.0, |v| js::js_number_value(Some(v)))
}

fn set_amount(row: &mut Map<String, Value>, key: &str, value: f64) {
    row.insert(key.to_owned(), js::number_value(value));
}

/// `String(value)` inside a template literal (`undefined` when absent).
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `row.component ?? ''`.
fn or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

fn is_self_assessed(row: &Map<String, Value>) -> bool {
    js::truthy(row.get("selfAssessed"))
}

/// `allocateRoundedTax(rows, targetTax)`: each component to the cent, the
/// remainder on the last row so they add up to `target`.
fn allocate_rounded_tax(rows: Vec<Map<String, Value>>, target: f64) -> Vec<Map<String, Value>> {
    if rows.is_empty() {
        return rows;
    }
    let mut rounded: Vec<Map<String, Value>> = rows
        .into_iter()
        .map(|mut row| {
            let taxable = round_money(amount(&row, "taxableAmount"));
            let tax = round_money(amount(&row, "taxAmount"));
            set_amount(&mut row, "taxableAmount", taxable);
            set_amount(&mut row, "taxAmount", tax);
            row
        })
        .collect();
    let sum: f64 = rounded.iter().map(|r| amount(r, "taxAmount")).sum();
    let remainder = round_money(target - sum);
    if remainder.abs() >= 0.01
        && let Some(last) = rounded.last_mut()
    {
        let tax = round_money(amount(last, "taxAmount") + remainder);
        set_amount(last, "taxAmount", tax);
    }
    rounded
}

/// Rows merged by key, in first-seen order (`new Map()`).
#[derive(Default)]
struct Breakdown(Vec<(String, Map<String, Value>)>);

impl Breakdown {
    fn add(&mut self, key: String, row: &Map<String, Value>) {
        if let Some((_, existing)) = self.0.iter_mut().find(|(k, _)| *k == key) {
            let taxable =
                round_money(amount(existing, "taxableAmount") + amount(row, "taxableAmount"));
            let tax = round_money(amount(existing, "taxAmount") + amount(row, "taxAmount"));
            set_amount(existing, "taxableAmount", taxable);
            set_amount(existing, "taxAmount", tax);
        } else {
            self.0.push((key, row.clone()));
        }
    }

    fn rows(self) -> Vec<Map<String, Value>> {
        self.0.into_iter().map(|(_, row)| row).collect()
    }
}

/// `calculateLineTaxTotals(items, place)`: line totals and the breakdown;
/// an Indian line under a seeded GST slab splits by place of supply.
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the lines, as calculateLineTaxTotals is written"
)]
pub fn calculate_line_tax_totals(items: &[TaxTotalsItem], place: Option<&PlaceOfSupply>) -> Totals {
    let mut subtotal = 0.0;
    let mut discount_total = 0.0;
    let mut tax_total = 0.0;
    let mut breakdown = Breakdown::default();
    let indian = place
        .and_then(|p| p.jurisdiction_code.as_deref())
        .is_some_and(|code| code.to_uppercase() == "IN");
    let purchase = place.and_then(|p| p.direction) == Some(Direction::Purchase);

    let mut processed_items = Vec::with_capacity(items.len());
    for item in items {
        let qty = parse_quantity(&item.quantity);
        let price = parse_amount(Some(&item.unit_price));
        let discount = parse_amount(Some(&item.discount_percent));
        let rate = parse_amount(item.tax_rate.as_deref());

        let line_gross = qty * price;
        let line_discount = line_gross * (discount / 100.0);
        let line_total = round_money(line_gross - line_discount);
        let target_tax = round_money(line_total * (rate / 100.0));
        let rate_id = item.tax_rate_id.clone().unwrap_or_default();
        let rate_name = item
            .tax_rate_name
            .clone()
            .unwrap_or_else(|| format!("{}%", js::number_text(rate)));

        let mut rows = if indian && india::has_slab_components(item.jurisdiction_metadata.as_ref())
        {
            let place = place.cloned().unwrap_or_default();
            let expanded = india::expand_gst_tax_breakdown(&GstExpansion {
                taxable_amount: line_total,
                tax_rate_id: &rate_id,
                tax_rate_name: &rate_name,
                slab_rate: rate,
                jurisdiction_metadata: item.jurisdiction_metadata.as_ref(),
                seller_state_code: place.seller_state_code.as_deref(),
                buyer_state_code: place.buyer_state_code.as_deref(),
                buyer_country: place.buyer_country.as_deref(),
                purchase,
            });
            let all_export = !expanded.is_empty()
                && expanded
                    .iter()
                    .all(|r| r.get("component").and_then(Value::as_str) == Some("export"));
            allocate_rounded_tax(expanded, if all_export { 0.0 } else { target_tax })
        } else {
            let mut row = Map::new();
            row.insert("taxRateId".into(), Value::String(rate_id.clone()));
            row.insert("taxRateName".into(), Value::String(rate_name.clone()));
            row.insert("taxRate".into(), js::number_value(rate));
            row.insert("taxableAmount".into(), js::number_value(line_total));
            row.insert("taxAmount".into(), js::number_value(target_tax));
            vec![row]
        };

        let self_assessed = purchase
            && item
                .tax_category_code
                .as_deref()
                .is_some_and(|code| SELF_ASSESSED_PURCHASE_CATEGORIES.contains(&code));
        for row in &mut rows {
            if let Some(code) = item.tax_category_code.as_deref().filter(|c| !c.is_empty()) {
                row.insert("taxCategoryCode".into(), Value::String(code.into()));
            }
            if self_assessed {
                row.insert("selfAssessed".into(), Value::Bool(true));
            }
        }

        // Only tax the counterparty charges counts toward the total.
        let line_tax = round_money(
            rows.iter()
                .map(|r| {
                    if is_self_assessed(r) {
                        0.0
                    } else {
                        amount(r, "taxAmount")
                    }
                })
                .sum(),
        );
        for row in &rows {
            let key = format!(
                "{}:{}:{}:{}:{}",
                js_string(row.get("taxRateId")),
                js_string(row.get("taxRateName")),
                js_string(row.get("taxRate")),
                or_empty(row.get("component")),
                if is_self_assessed(row) { "sa" } else { "" },
            );
            breakdown.add(key, row);
        }

        subtotal = round_money(subtotal + line_total);
        discount_total = round_money(discount_total + line_discount);
        tax_total = round_money(tax_total + line_tax);

        processed_items.push(LineTotals {
            line_total: js::to_fixed(line_total, 2),
            line_total_with_tax: js::to_fixed(round_money(line_total + line_tax), 2),
            tax_amount: js::to_fixed(line_tax, 2),
        });
    }

    let rows = breakdown.rows();
    let breakdown_tax_sum = round_money(
        rows.iter()
            .map(|r| {
                if is_self_assessed(r) {
                    0.0
                } else {
                    amount(r, "taxAmount")
                }
            })
            .sum(),
    );
    // The header matches both the line taxes and the (per line allocated) breakdown.
    let reconciled = if rows.is_empty() {
        tax_total
    } else {
        breakdown_tax_sum
    };
    let total = js::to_fixed(round_money(subtotal + reconciled), 2);
    Totals {
        subtotal: js::to_fixed(subtotal, 2),
        discount_total: js::to_fixed(discount_total, 2),
        tax_total: js::to_fixed(reconciled, 2),
        total: total.clone(),
        balance_due: total,
        tax_breakdown: rows.into_iter().map(Value::Object).collect(),
        processed_items,
        tax_warnings: None,
    }
}

/// `getEntityStateCode(entity)`: the Indian state of the entity, from its
/// settings (`stateCode`) or its GSTIN.
pub fn entity_state_code(
    tax_identifiers: Option<&Value>,
    jurisdiction_settings: Option<&Value>,
) -> Option<String> {
    if let Some(Value::String(from_settings)) =
        jurisdiction_settings.and_then(|s| s.get("stateCode"))
    {
        let trimmed = js_trim(from_settings);
        if trimmed.len() == 2 && trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return Some(trimmed.to_owned());
        }
    }
    let gstin = tax_identifiers
        .and_then(|t| t.get("vatNumber"))
        .filter(|v| js::truthy(Some(v)))?;
    let text = gstin.as_str()?;
    let normalized = crate::jurisdictions::strip(text, &['-']).to_uppercase();
    let head: String = normalized.chars().take(2).collect();
    (head.len() == 2 && head.bytes().all(|b| b.is_ascii_digit())).then_some(head)
}

/// One line as a document tax hook sees it (`DocumentTaxLineInput`).
#[derive(Debug, Clone, PartialEq)]
pub struct HookLine {
    /// Quantity x price less the line discount.
    pub line_total: f64,
    pub tax_rate_id: Option<String>,
    pub tax_rate_name: Option<String>,
    pub tax_category_code: Option<String>,
    /// The line's rate (percent).
    pub rate: f64,
    pub jurisdiction_metadata: Option<Value>,
    pub fiscal_data: Option<Value>,
}

/// The other party (`DocumentTaxContext.counterparty`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Counterparty {
    pub country: Option<String>,
    pub state_code: Option<String>,
    pub tax_id: Option<String>,
    pub fiscal: Option<Value>,
}

/// `DocumentTaxContext`.
#[derive(Debug, Clone, PartialEq)]
pub struct HookContext {
    pub direction: Direction,
    /// `yyyy-mm-dd`.
    pub issue_date: Option<String>,
    pub entity_settings: Option<Value>,
    pub entity_tax_classification: Option<String>,
    pub counterparty: Counterparty,
    pub document_fiscal: Option<Value>,
}

/// `DocumentTaxResult`: rows per line (in line order), rows on the whole
/// document, notes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HookResult {
    pub lines: Vec<Vec<Map<String, Value>>>,
    pub document_rows: Vec<Map<String, Value>>,
    pub warnings: Vec<String>,
}

/// `totalEffect(row)`: added +, withheld -, embedded / informational /
/// self-assessed 0.
fn total_effect(row: &Map<String, Value>) -> f64 {
    if is_self_assessed(row) {
        return 0.0;
    }
    match row.get("treatment").and_then(Value::as_str) {
        Some("withheld") => -amount(row, "taxAmount"),
        Some("embedded" | "informational") => 0.0,
        _ => amount(row, "taxAmount"),
    }
}

fn hook_key(row: &Map<String, Value>) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}",
        js_string(row.get("taxRateId")),
        js_string(row.get("taxRateName")),
        js_string(row.get("taxRate")),
        or_empty(row.get("component")),
        or_empty(row.get("treatment")),
        if is_self_assessed(row) { "sa" } else { "" },
    )
}

/// The lines a hook is given (`calculateHookTaxTotals`'s inputs), with the
/// subtotal and discount total.
pub fn hook_inputs(items: &[TaxTotalsItem]) -> (Vec<HookLine>, f64, f64) {
    let mut subtotal = 0.0;
    let mut discount_total = 0.0;
    let lines = items
        .iter()
        .map(|item| {
            let qty = parse_quantity(&item.quantity);
            let price = parse_amount(Some(&item.unit_price));
            let discount = parse_amount(Some(&item.discount_percent));
            let line_gross = qty * price;
            let line_discount = line_gross * (discount / 100.0);
            let line_total = round_money(line_gross - line_discount);
            subtotal = round_money(subtotal + line_total);
            discount_total = round_money(discount_total + line_discount);
            HookLine {
                line_total,
                tax_rate_id: item.tax_rate_id.clone(),
                tax_rate_name: item.tax_rate_name.clone(),
                tax_category_code: item.tax_category_code.clone(),
                rate: parse_amount(item.tax_rate.as_deref()),
                jurisdiction_metadata: item.jurisdiction_metadata.clone(),
                fiscal_data: item.fiscal_data.clone(),
            }
        })
        .collect();
    (lines, subtotal, discount_total)
}

/// `calculateHookTaxTotals(items, compute, ctx)` once the hook answered
/// `result` for [`hook_inputs`]: taxes on top of the price raise the line,
/// taxes inside it leave the total alone, withholdings come off the total
/// (`taxTotal` = added - withheld, possibly negative).
pub fn hook_tax_totals(
    lines: &[HookLine],
    subtotal: f64,
    discount_total: f64,
    result: HookResult,
) -> Totals {
    let mut breakdown = Breakdown::default();
    let processed_items = lines
        .iter()
        .enumerate()
        .map(|(idx, input)| {
            let rows = result.lines.get(idx).cloned().unwrap_or_default();
            for row in &rows {
                breakdown.add(hook_key(row), row);
            }
            let line_tax = round_money(rows.iter().map(|r| total_effect(r).max(0.0)).sum());
            LineTotals {
                line_total: js::to_fixed(input.line_total, 2),
                line_total_with_tax: js::to_fixed(round_money(input.line_total + line_tax), 2),
                tax_amount: js::to_fixed(line_tax, 2),
            }
        })
        .collect();
    for row in &result.document_rows {
        breakdown.add(hook_key(row), row);
    }
    let rows = breakdown.rows();
    let tax_total = round_money(rows.iter().map(total_effect).sum());
    let total = js::to_fixed(round_money(subtotal + tax_total), 2);
    Totals {
        subtotal: js::to_fixed(subtotal, 2),
        discount_total: js::to_fixed(discount_total, 2),
        tax_total: js::to_fixed(tax_total, 2),
        total: total.clone(),
        balance_due: total,
        tax_breakdown: rows.into_iter().map(Value::Object).collect(),
        processed_items,
        tax_warnings: Some(result.warnings),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn line(quantity: &str, price: &str, discount: &str, rate: &str) -> TaxTotalsItem {
        TaxTotalsItem {
            quantity: quantity.into(),
            unit_price: price.into(),
            discount_percent: discount.into(),
            tax_rate: Some(rate.into()),
            ..TaxTotalsItem::default()
        }
    }

    #[test]
    fn vat_lines_round_per_line_and_merge_by_rate() {
        let mut first = line("1", "100", "0", "21.00");
        first.tax_rate_id = Some("tr_21".into());
        first.tax_rate_name = Some("BTW 21%".into());
        let mut second = line("3", "9.99", "10", "21.00");
        second.tax_rate_id = Some("tr_21".into());
        second.tax_rate_name = Some("BTW 21%".into());
        let totals = calculate_line_tax_totals(&[first, second, line("", "5", "", "0")], None);
        assert_eq!(totals.subtotal, "131.97");
        assert_eq!(totals.discount_total, "3.00");
        assert_eq!(totals.tax_total, "26.66");
        assert_eq!(totals.total, "158.63");
        assert_eq!(totals.tax_breakdown.len(), 2);
        assert_eq!(totals.tax_breakdown[0]["taxableAmount"], json!(126.97));
        assert_eq!(totals.tax_breakdown[0]["taxAmount"], json!(26.66));
        assert_eq!(totals.tax_breakdown[1]["taxRateName"], "0%");
        assert_eq!(totals.processed_items[1].line_total_with_tax, "32.63");
    }

    #[test]
    fn self_assessed_purchase_tax_stays_out_of_the_total() {
        let mut item = line("1", "100", "0", "21");
        item.tax_category_code = Some("eu_b2b_service".into());
        let place = PlaceOfSupply {
            direction: Some(Direction::Purchase),
            ..PlaceOfSupply::default()
        };
        let totals = calculate_line_tax_totals(&[item], Some(&place));
        assert_eq!(totals.tax_total, "0.00");
        assert_eq!(totals.total, "100.00");
        assert_eq!(totals.tax_breakdown[0]["selfAssessed"], json!(true));
        assert_eq!(totals.tax_breakdown[0]["taxAmount"], json!(21));
    }

    #[test]
    fn indian_slabs_split_and_reconcile() {
        let mut item = line("1", "999.99", "0", "18.00");
        item.tax_rate_id = Some("tr_gst18".into());
        item.jurisdiction_metadata = Some(json!({
            "gstSlab": "18",
            "components": {
                "intrastate": [
                    { "code": "cgst", "rate": "9", "accountRole": "tax_output_cgst" },
                    { "code": "sgst", "rate": "9", "accountRole": "tax_output_sgst" },
                ],
                "interstate": [{ "code": "igst", "rate": "18", "accountRole": "tax_output_igst" }],
            },
        }));
        let place = PlaceOfSupply {
            jurisdiction_code: Some("IN".into()),
            seller_state_code: Some("27".into()),
            buyer_state_code: Some("27".into()),
            buyer_country: Some("IN".into()),
            direction: Some(Direction::Sales),
        };
        let totals = calculate_line_tax_totals(&[item], Some(&place));
        assert_eq!(totals.tax_total, "180.00");
        assert_eq!(totals.tax_breakdown[0]["taxAmount"], json!(90));
        assert_eq!(totals.tax_breakdown[1]["taxAmount"], json!(90));
    }

    #[test]
    fn state_code_from_settings_or_gstin() {
        assert_eq!(
            entity_state_code(None, Some(&json!({ "stateCode": " 29 " }))).as_deref(),
            Some("29")
        );
        assert_eq!(
            entity_state_code(Some(&json!({ "vatNumber": "27-aapfu0939f1zv" })), None).as_deref(),
            Some("27")
        );
        assert_eq!(
            entity_state_code(Some(&json!({ "vatNumber": "" })), None),
            None
        );
    }

    #[test]
    fn hook_totals_add_withhold_and_embed() {
        let (lines, subtotal, discount) = hook_inputs(&[line("2", "50", "0", "0")]);
        let row = |treatment: &str, tax: f64| {
            let mut row = Map::new();
            row.insert("taxRateId".into(), json!("tr"));
            row.insert("taxRateName".into(), json!(treatment));
            row.insert("taxRate".into(), json!(1));
            row.insert("taxableAmount".into(), json!(100));
            row.insert("taxAmount".into(), js::number_value(tax));
            row.insert("treatment".into(), json!(treatment));
            row
        };
        let totals = hook_tax_totals(
            &lines,
            subtotal,
            discount,
            HookResult {
                lines: vec![vec![row("added", 5.0), row("embedded", 3.0)]],
                document_rows: vec![row("withheld", 1.5)],
                warnings: vec!["note".into()],
            },
        );
        assert_eq!(totals.processed_items[0].tax_amount, "5.00");
        assert_eq!(totals.tax_total, "3.50");
        assert_eq!(totals.total, "103.50");
        assert_eq!(totals.tax_warnings, Some(vec!["note".to_owned()]));
    }
}
