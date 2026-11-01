//! Correction runs store the DIFFERENCE (`services/weldhr/payroll/corrections.ts`).
//!
//! A correction payslip holds, as lines, totals, filing data and
//! year-to-date, what the recalculated payslip has more or less than the
//! payslip as it stands today (the original plus the corrections already
//! approved for it). Summing every final payslip of an employee, originals
//! and corrections, gives the right year totals. Totals can be negative.

use serde::Deserialize;
use serde_json::{Map, Value, json};
use weldsuite_payroll_domain::money::{from_cents, to_cents_text};
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::types::{PayslipResult, Ytd};

use super::ytd::ytd_of;

/// `TotalsCents`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Totals {
    pub(crate) gross: f64,
    pub(crate) taxable_wage: f64,
    pub(crate) employee_taxes: f64,
    pub(crate) employee_deductions: f64,
    pub(crate) reimbursements: f64,
    pub(crate) net: f64,
    pub(crate) employer_taxes: f64,
    pub(crate) employer_cost: f64,
}

impl Totals {
    /// `addTotals(a, b, sign)`.
    pub(crate) fn add(self, b: Totals, sign: f64) -> Totals {
        Totals {
            gross: self.gross + sign * b.gross,
            taxable_wage: self.taxable_wage + sign * b.taxable_wage,
            employee_taxes: self.employee_taxes + sign * b.employee_taxes,
            employee_deductions: self.employee_deductions + sign * b.employee_deductions,
            reimbursements: self.reimbursements + sign * b.reimbursements,
            net: self.net + sign * b.net,
            employer_taxes: self.employer_taxes + sign * b.employer_taxes,
            employer_cost: self.employer_cost + sign * b.employer_cost,
        }
    }

    /// The `TotalsCents` object.
    pub(crate) fn to_json(self) -> Value {
        let n = weldsuite_core_domain::js::number_value;
        json!({
            "grossCents": n(self.gross), "taxableWageCents": n(self.taxable_wage),
            "employeeTaxesCents": n(self.employee_taxes), "employeeDeductionsCents": n(self.employee_deductions),
            "reimbursementsCents": n(self.reimbursements), "netCents": n(self.net),
            "employerTaxesCents": n(self.employer_taxes), "employerCostCents": n(self.employer_cost),
        })
    }

    /// `totalsToColumns(t)`: the numeric columns, as text.
    pub(crate) fn columns(self) -> [String; 8] {
        [
            from_cents(self.gross),
            from_cents(self.taxable_wage),
            from_cents(self.employee_taxes),
            from_cents(self.employee_deductions),
            from_cents(self.reimbursements),
            from_cents(self.net),
            from_cents(self.employer_taxes),
            from_cents(self.employer_cost),
        ]
    }
}

fn cents(row: &Value, key: &str) -> f64 {
    to_cents_text(row[key].as_str()).unwrap_or(f64::NAN)
}

/// `rowTotals(row)`.
pub(crate) fn row_totals(row: &Value) -> Totals {
    Totals {
        gross: cents(row, "grossPay"),
        taxable_wage: cents(row, "taxableWage"),
        employee_taxes: cents(row, "employeeTaxes"),
        employee_deductions: cents(row, "employeeDeductions"),
        reimbursements: cents(row, "reimbursements"),
        net: cents(row, "netPay"),
        employer_taxes: cents(row, "employerTaxes"),
        employer_cost: cents(row, "employerCost"),
    }
}

/// `resultTotals(result)`.
pub(crate) fn result_totals(result: &PayslipResult) -> Totals {
    Totals {
        gross: result.gross_cents,
        taxable_wage: result.taxable_wage_cents,
        employee_taxes: result.employee_taxes_cents,
        employee_deductions: result.employee_deductions_cents,
        reimbursements: result.reimbursements_cents,
        net: result.net_cents,
        employer_taxes: result.employer_taxes_cents,
        employer_cost: result.employer_cost_cents,
    }
}

// ── lines ───────────────────────────────────────────────────────────────────

fn opt_text(line: &Value, key: &str) -> String {
    line.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn line_key(line: &Value) -> String {
    format!("{}|{}|{}|{}", opt_text(line, "section"), opt_text(line, "code"), opt_text(line, "jurisdiction"), opt_text(line, "label"))
}

fn amount_of(line: &Value) -> f64 {
    line["amountCents"].as_f64().unwrap_or(0.0)
}

fn with_amount(line: &Value, amount: f64) -> Value {
    let mut out = line.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert("amountCents".into(), weldsuite_core_domain::js::number_value(amount));
    }
    out
}

/// `sumLines(sets)`: added by (section, code, jurisdiction, label); zero
/// lines drop out.
pub(crate) fn sum_lines(sets: &[&[Value]]) -> Vec<Value> {
    let mut by_key: Vec<(String, Value)> = vec![];
    for set in sets {
        for line in *set {
            let key = line_key(line);
            match by_key.iter_mut().find(|(k, _)| *k == key) {
                Some((_, current)) => {
                    let total = amount_of(current) + amount_of(line);
                    *current = with_amount(line, total);
                }
                None => by_key.push((key, line.clone())),
            }
        }
    }
    by_key.into_iter().map(|(_, l)| l).filter(|l| amount_of(l) != 0.0).collect()
}

/// `diffLines(after, before)`: quantity and rate are the recalculated ones.
pub(crate) fn diff_lines(after: &[Value], before: &[Value]) -> Vec<Value> {
    let after_by_key: Vec<(String, Value)> = sum_lines(&[after]).into_iter().map(|l| (line_key(&l), l)).collect();
    let before_by_key: Vec<(String, Value)> = sum_lines(&[before]).into_iter().map(|l| (line_key(&l), l)).collect();
    let mut keys: Vec<&String> = vec![];
    for (key, _) in after_by_key.iter().chain(before_by_key.iter()) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let find = |list: &[(String, Value)], key: &str| list.iter().find(|(k, _)| k == key).map(|(_, l)| l.clone());
    let mut out = vec![];
    for key in keys {
        let a = find(&after_by_key, key);
        let b = find(&before_by_key, key);
        let amount = a.as_ref().map_or(0.0, amount_of) - b.as_ref().map_or(0.0, amount_of);
        if amount == 0.0 {
            continue;
        }
        let Some(base) = a.clone().or(b) else { continue };
        let mut line = with_amount(&base, amount);
        if let Some(map) = line.as_object_mut() {
            let field = |k: &str| a.as_ref().and_then(|a| a.get(k)).cloned().unwrap_or(Value::Null);
            map.insert("quantity".into(), field("quantity"));
            map.insert("rate".into(), field("rate"));
        }
        out.push(line);
    }
    out
}

// ── numbers nested in JSON ──────────────────────────────────────────────────

/// `combineNumeric(a, b, sign)`: `a` plus `sign` × `b` on every number
/// leaf; objects merged key by key; anything else from `a`, else `b`.
/// `None` is `undefined`.
pub(crate) fn combine_numeric(a: Option<&Value>, b: Option<&Value>, sign: f64) -> Option<Value> {
    let num = |v: Option<&Value>| v.and_then(|v| if v.is_number() { v.as_f64() } else { None });
    if a.is_some_and(Value::is_number) || b.is_some_and(Value::is_number) {
        let total = num(a).unwrap_or(0.0) + sign * num(b).unwrap_or(0.0);
        return Some(weldsuite_core_domain::js::number_value(total));
    }
    if a.is_some_and(Value::is_object) || b.is_some_and(Value::is_object) {
        let empty = Map::new();
        let left = a.and_then(Value::as_object).unwrap_or(&empty);
        let right = b.and_then(Value::as_object).unwrap_or(&empty);
        let mut out = Map::new();
        for key in left.keys().chain(right.keys()) {
            if out.contains_key(key) {
                continue;
            }
            if let Some(value) = combine_numeric(left.get(key), right.get(key), sign) {
                out.insert(key.clone(), value);
            }
        }
        return Some(Value::Object(out));
    }
    a.or(b).cloned()
}

/// `addYtd(a, b, sign)`: key-wise, `a`'s keys first.
pub(crate) fn add_ytd(a: &Ytd, b: &Ytd, sign: f64) -> Ytd {
    let mut out = a.clone();
    for (key, value) in b.iter() {
        let current = out.get(key).copied().unwrap_or(0.0);
        out.insert(key.clone(), current + sign * value);
    }
    out
}

/// What a stored snapshot says about accumulators.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotYtd {
    #[serde(default)]
    pub(crate) input: Option<SnapshotInput>,
    #[serde(default)]
    pub(crate) ytd_delta: Option<OrderedMap<f64>>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct SnapshotInput {
    #[serde(default)]
    pub(crate) ytd: Option<OrderedMap<f64>>,
}

/// A payslip row's snapshot accumulators, in stored key order.
pub(crate) fn snapshot_ytd(row: &Value) -> SnapshotYtd {
    row["snapshotText"].as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default()
}

/// `CorrectionBase`: the original payslip and its final corrections, oldest
/// first.
pub(crate) struct CorrectionBase<'a> {
    pub(crate) original: &'a Value,
    pub(crate) corrections: Vec<&'a Value>,
}

struct Effective {
    totals: Totals,
    lines: Vec<Value>,
    filing_data: Value,
    contribution: Ytd,
}

fn lines_of(row: &Value) -> Vec<Value> {
    row["lines"].as_array().cloned().unwrap_or_default()
}

/// `effectiveOf(base)`: what the original plus its corrections add up to.
fn effective_of(base: &CorrectionBase<'_>) -> Effective {
    let mut rows = vec![base.original];
    rows.extend(base.corrections.iter().copied());
    let mut totals = Totals::default();
    for row in &rows {
        totals = totals.add(row_totals(row), 1.0);
    }
    let line_sets: Vec<Vec<Value>> = rows.iter().map(|r| lines_of(r)).collect();
    let refs: Vec<&[Value]> = line_sets.iter().map(Vec::as_slice).collect();
    let lines = sum_lines(&refs);
    let mut filing_data = base.original["filingData"].clone();
    for row in rows.iter().skip(1) {
        filing_data = combine_numeric(Some(&filing_data), Some(&row["filingData"]), 1.0).unwrap_or(Value::Null);
    }
    let before = snapshot_ytd(base.original).input.and_then(|i| i.ytd).unwrap_or_default();
    let mut contribution = add_ytd(&ytd_of(base.original), &before, -1.0);
    for row in &base.corrections {
        let delta = snapshot_ytd(row).ytd_delta.unwrap_or_default();
        contribution = add_ytd(&contribution, &delta, 1.0);
    }
    Effective { totals, lines, filing_data, contribution }
}

/// `CorrectionResult`.
pub(crate) struct CorrectionResult {
    pub(crate) totals: Totals,
    pub(crate) lines: Vec<Value>,
    pub(crate) filing_data: Value,
    pub(crate) ytd_delta: Ytd,
}

/// What the engine produced for the recalculated payslip.
pub(crate) struct Recalculated<'a> {
    pub(crate) lines: &'a [Value],
    pub(crate) totals: Totals,
    pub(crate) ytd: &'a Ytd,
    pub(crate) filing_data: &'a Value,
}

/// `correctionFrom(result, ytdBefore, base)`.
pub(crate) fn correction_from(result: &Recalculated<'_>, ytd_before: &Ytd, base: &CorrectionBase<'_>) -> CorrectionResult {
    let effective = effective_of(base);
    let recalculated = add_ytd(result.ytd, ytd_before, -1.0);
    CorrectionResult {
        totals: result.totals.add(effective.totals, -1.0),
        lines: diff_lines(result.lines, &effective.lines),
        filing_data: combine_numeric(Some(result.filing_data), Some(&effective.filing_data), -1.0).unwrap_or(Value::Null),
        ytd_delta: add_ytd(&recalculated, &effective.contribution, -1.0),
    }
}
