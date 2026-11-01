//! Brazil's monthly tax worksheet, the apuração (books-domain's
//! `jurisdictions/br/{apuracao,simples}`, books-api's `br-apuracao`): the
//! DAS of the Simples Nacional or MEI, the month's ISS, ICMS, IPI, PIS and
//! COFINS under Lucro Presumido / Real, the withholdings to pay over, and
//! IRPJ / CSLL at the end of a quarter; booking posts what the invoices did
//! not already post and keeps the worksheet as a `tax_returns` row.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::currency::to_base_currency;
use weldsuite_books_domain::fx::parse_rate;
use weldsuite_books_domain::js::{self, number_value as n, round_money};
use weldsuite_books_domain::jurisdictions::br::{profile_of, regime_of};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, account_for_role,
    load_entity_accounts, post_journal_entry,
};
use weldsuite_books_domain::guards::PostingLockKind;
use weldsuite_kit::generate_id;

/// Why the worksheet can't be made (`BrApuracaoError`): a 400.
#[derive(Debug)]
pub(crate) enum ApuracaoError {
    User(String),
    Post(PostError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for ApuracaoError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

fn round2(value: f64) -> f64 {
    round_money(value)
}

// ── Simples Nacional ────────────────────────────────────────────────────────

const LIMITS: [f64; 6] = [
    180_000.0,
    360_000.0,
    720_000.0,
    1_800_000.0,
    3_600_000.0,
    4_800_000.0,
];

/// A bracket's (nominal rate, deduction) and its split, in the TypeScript
/// literal's key order.
type Faixa = (f64, f64, &'static [(&'static str, f64)]);

const ANEXO_I: [Faixa; 6] = [
    (4.0, 0.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 12.74), ("pis", 2.76), ("cpp", 41.5), ("icms", 34.0)]),
    (7.3, 5_940.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 12.74), ("pis", 2.76), ("cpp", 41.5), ("icms", 34.0)]),
    (9.5, 13_860.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 12.74), ("pis", 2.76), ("cpp", 42.0), ("icms", 33.5)]),
    (10.7, 22_500.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 12.74), ("pis", 2.76), ("cpp", 42.0), ("icms", 33.5)]),
    (14.3, 87_300.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 12.74), ("pis", 2.76), ("cpp", 42.0), ("icms", 33.5)]),
    (19.0, 378_000.0, &[("irpj", 13.5), ("csll", 10.0), ("cofins", 28.27), ("pis", 6.13), ("cpp", 42.1), ("icms", 0.0)]),
];

const ANEXO_II: [Faixa; 6] = [
    (4.5, 0.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 11.51), ("pis", 2.49), ("cpp", 37.5), ("ipi", 7.5), ("icms", 32.0)]),
    (7.8, 5_940.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 11.51), ("pis", 2.49), ("cpp", 37.5), ("ipi", 7.5), ("icms", 32.0)]),
    (10.0, 13_860.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 11.51), ("pis", 2.49), ("cpp", 37.5), ("ipi", 7.5), ("icms", 32.0)]),
    (11.2, 22_500.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 11.51), ("pis", 2.49), ("cpp", 37.5), ("ipi", 7.5), ("icms", 32.0)]),
    (14.7, 85_500.0, &[("irpj", 5.5), ("csll", 3.5), ("cofins", 11.51), ("pis", 2.49), ("cpp", 37.5), ("ipi", 7.5), ("icms", 32.0)]),
    (30.0, 720_000.0, &[("irpj", 8.5), ("csll", 7.5), ("cofins", 20.96), ("pis", 4.54), ("cpp", 23.5), ("ipi", 35.0), ("icms", 0.0)]),
];

const ANEXO_III: [Faixa; 6] = [
    (6.0, 0.0, &[("irpj", 4.0), ("csll", 3.5), ("cofins", 12.82), ("pis", 2.78), ("cpp", 43.4), ("iss", 33.5)]),
    (11.2, 9_360.0, &[("irpj", 4.0), ("csll", 3.5), ("cofins", 14.05), ("pis", 3.05), ("cpp", 43.4), ("iss", 32.0)]),
    (13.5, 17_640.0, &[("irpj", 4.0), ("csll", 3.5), ("cofins", 13.64), ("pis", 2.96), ("cpp", 43.4), ("iss", 32.5)]),
    (16.0, 35_640.0, &[("irpj", 4.0), ("csll", 3.5), ("cofins", 13.64), ("pis", 2.96), ("cpp", 43.4), ("iss", 32.5)]),
    (21.0, 125_640.0, &[("irpj", 4.0), ("csll", 3.5), ("cofins", 12.82), ("pis", 2.78), ("cpp", 43.4), ("iss", 33.5)]),
    (33.0, 648_000.0, &[("irpj", 35.0), ("csll", 15.0), ("cofins", 16.03), ("pis", 3.47), ("cpp", 30.5), ("iss", 0.0)]),
];

const ANEXO_IV: [Faixa; 6] = [
    (4.5, 0.0, &[("irpj", 18.8), ("csll", 15.2), ("cofins", 17.67), ("pis", 3.83), ("iss", 44.5)]),
    (9.0, 8_100.0, &[("irpj", 19.8), ("csll", 15.2), ("cofins", 20.55), ("pis", 4.45), ("iss", 40.0)]),
    (10.2, 12_420.0, &[("irpj", 20.8), ("csll", 15.2), ("cofins", 19.73), ("pis", 4.27), ("iss", 40.0)]),
    (14.0, 39_780.0, &[("irpj", 17.8), ("csll", 19.2), ("cofins", 18.9), ("pis", 4.1), ("iss", 40.0)]),
    (22.0, 183_780.0, &[("irpj", 18.8), ("csll", 19.2), ("cofins", 18.08), ("pis", 3.92), ("iss", 40.0)]),
    (33.0, 828_000.0, &[("irpj", 53.5), ("csll", 21.5), ("cofins", 20.55), ("pis", 4.45), ("iss", 0.0)]),
];

const ANEXO_V: [Faixa; 6] = [
    (15.5, 0.0, &[("irpj", 25.0), ("csll", 15.0), ("cofins", 14.1), ("pis", 3.05), ("cpp", 28.85), ("iss", 14.0)]),
    (18.0, 4_500.0, &[("irpj", 23.0), ("csll", 15.0), ("cofins", 14.1), ("pis", 3.05), ("cpp", 27.85), ("iss", 17.0)]),
    (19.5, 9_900.0, &[("irpj", 24.0), ("csll", 15.0), ("cofins", 14.92), ("pis", 3.23), ("cpp", 23.85), ("iss", 19.0)]),
    (20.5, 17_100.0, &[("irpj", 21.0), ("csll", 15.0), ("cofins", 15.74), ("pis", 3.41), ("cpp", 23.85), ("iss", 21.0)]),
    (23.0, 62_100.0, &[("irpj", 23.0), ("csll", 12.5), ("cofins", 14.1), ("pis", 3.05), ("cpp", 23.85), ("iss", 23.5)]),
    (30.5, 540_000.0, &[("irpj", 35.0), ("csll", 15.5), ("cofins", 16.44), ("pis", 3.56), ("cpp", 29.5), ("iss", 0.0)]),
];

fn anexo_table(anexo: &str) -> &'static [Faixa; 6] {
    match anexo {
        "I" => &ANEXO_I,
        "II" => &ANEXO_II,
        "IV" => &ANEXO_IV,
        "V" => &ANEXO_V,
        _ => &ANEXO_III,
    }
}

const SIMPLES_REVENUE_LIMIT: f64 = 4_800_000.0;
const SIMPLES_SUBLIMIT: f64 = 3_600_000.0;
const FATOR_R_THRESHOLD: f64 = 0.28;
const SIMPLES_ISS_CAP: f64 = 5.0;

/// `simplesEffectiveRate(anexo, rbt12)`: (faixa, nominal, deduction,
/// effective rate, rate by tax in split order).
fn effective_rate(anexo: &str, rbt12: f64) -> (usize, f64, f64, f64, Vec<(&'static str, f64)>) {
    let table = anexo_table(anexo);
    let index = LIMITS.iter().position(|up_to| rbt12 <= *up_to).unwrap_or(5);
    let (rate, deduction, split) = table[index];
    let effective = if rbt12 > 0.0 {
        ((rbt12 * rate) / 100.0 - deduction) / rbt12 * 100.0
    } else {
        rate
    };
    let mut by_tax: Vec<(&'static str, f64)> = split
        .iter()
        .map(|(tax, share)| (*tax, (effective * share) / 100.0))
        .collect();
    let iss = by_tax
        .iter()
        .find(|(t, _)| *t == "iss")
        .map_or(0.0, |(_, v)| *v);
    if iss > SIMPLES_ISS_CAP {
        let excess = iss - SIMPLES_ISS_CAP;
        let other_share: f64 = split
            .iter()
            .filter(|(t, _)| *t != "iss")
            .fold(0.0, |sum, (_, share)| sum + share);
        for (tax, value) in &mut by_tax {
            if *tax == "iss" {
                *value = SIMPLES_ISS_CAP;
            } else {
                let share = split.iter().find(|(t, _)| t == tax).map_or(0.0, |(_, s)| *s);
                *value += (excess * share) / other_share;
            }
        }
    }
    (index + 1, rate, deduction, effective, by_tax)
}

/// One month's revenue in an annex (`SimplesRevenueSlice`).
#[derive(Debug, Clone)]
struct Slice {
    anexo: String,
    revenue: f64,
    iss_withheld: f64,
    exports: f64,
}

/// `computeSimplesDas({ rbt12, payroll12m, slices })`.
fn simples_das(rbt12: f64, payroll12m: f64, slices: &[Slice]) -> Map<String, Value> {
    let mut fator_r: Option<f64> = None;
    let mut by_anexo: Vec<Slice> = Vec::new();
    for slice in slices {
        let mut anexo = slice.anexo.clone();
        if anexo == "V" {
            let ratio = if rbt12 > 0.0 { payroll12m / rbt12 } else { 0.0 };
            fator_r = Some(ratio);
            if ratio >= FATOR_R_THRESHOLD {
                anexo = "III".into();
            }
        }
        if let Some(existing) = by_anexo.iter_mut().find(|s| s.anexo == anexo) {
            existing.revenue += slice.revenue;
            existing.iss_withheld += slice.iss_withheld;
            existing.exports += slice.exports;
        } else {
            by_anexo.push(Slice {
                anexo,
                revenue: slice.revenue,
                iss_withheld: slice.iss_withheld,
                exports: slice.exports,
            });
        }
    }
    let mut lines = Vec::new();
    let mut total = 0.0;
    for slice in &by_anexo {
        if slice.revenue == 0.0 {
            continue;
        }
        let (faixa, nominal, deduction, effective, by_tax) = effective_rate(&slice.anexo, rbt12);
        let mut taxes = Map::new();
        let mut amount = 0.0;
        for (tax, rate) in by_tax {
            let mut base = slice.revenue;
            if tax == "iss" {
                base -= slice.iss_withheld;
            }
            if matches!(tax, "cofins" | "pis" | "icms" | "ipi" | "iss") {
                base -= slice.exports;
            }
            let value = round2((base.max(0.0) * rate) / 100.0);
            amount += value;
            taxes.insert(tax.to_owned(), n(value));
        }
        let amount = round2(amount);
        total += amount;
        lines.push(json!({
            "anexo": slice.anexo,
            "revenue": n(round2(slice.revenue)),
            "faixa": faixa,
            "nominalRate": n(nominal),
            "deduction": n(deduction),
            "effectiveRate": n(js::math_round(effective * 10_000.0) / 10_000.0),
            "amount": n(amount),
            "byTax": taxes,
        }));
    }
    let mut out = Map::new();
    out.insert("rbt12".into(), n(round2(rbt12)));
    out.insert(
        "fatorR".into(),
        fator_r.map_or(Value::Null, |f| n(js::math_round(f * 10_000.0) / 10_000.0)),
    );
    out.insert("lines".into(), Value::Array(lines));
    out.insert("total".into(), n(round2(total)));
    out.insert("overSublimit".into(), json!(rbt12 > SIMPLES_SUBLIMIT));
    out.insert("overLimit".into(), json!(rbt12 > SIMPLES_REVENUE_LIMIT));
    out
}

// ── the worksheet ───────────────────────────────────────────────────────────

/// `BR_MINIMUM_WAGE`.
fn minimum_wage(year: i64) -> Option<f64> {
    match year {
        2025 => Some(1518.0),
        2026 => Some(1621.0),
        _ => None,
    }
}

const LC224_QUARTER_ALLOWANCE: f64 = 1_250_000.0;
const LC224_FACTOR: f64 = 1.1;

/// One ledger total (`BrTaxLedgerTotal`).
#[derive(Debug, Clone)]
struct LedgerTotal {
    component: String,
    sales: bool,
    taxable: f64,
    tax: f64,
}

/// `sum(ledger, direction, ...components)`: (base, tax).
fn sum(ledger: &[LedgerTotal], sales: bool, components: &[&str]) -> (f64, f64) {
    let mut base = 0.0;
    let mut tax = 0.0;
    for row in ledger {
        if row.sales == sales && components.contains(&row.component.as_str()) {
            base += row.taxable;
            tax += row.tax;
        }
    }
    (round2(base), round2(tax))
}

fn split_period(period: &str) -> (i64, i64) {
    let year = js::parse_int(&period[..4]).unwrap_or(0);
    let month = js::parse_int(&period[5..7]).unwrap_or(1);
    (year, month)
}

fn day_text(year: i64, month: i64, day: i64) -> String {
    format!("{year}-{month:02}-{day:02}")
}

/// `nextMonthDay(period, day)`.
fn next_month_day(period: &str, day: i64) -> String {
    let (y, m) = split_period(period);
    let (year, month) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    day_text(year, month, day)
}

/// The last day of a month (`new Date(Date.UTC(y, m, 0)).getUTCDate()`, `m` 1-based).
fn last_day(year: i64, month: i64) -> i64 {
    let first_next = js::days_from_civil(year + (month / 12), month % 12 + 1, 1);
    js::civil_from_days(first_next - 1).2
}

/// `lastDayOfNextMonth(period)`.
fn last_day_of_next_month(period: &str) -> String {
    let (y, m) = split_period(period);
    // `Date.UTC(y, m + 1, 0)`: the last day of month m + 1 (1-based).
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let last = last_day(ny, nm);
    day_text(ny, nm, last)
}

/// `lc224Excess(quarters)`.
fn lc224_excess(quarters: &[f64]) -> f64 {
    let q = quarters.len();
    let through: f64 = quarters.iter().fold(0.0, |a, b| a + b);
    let before = through - quarters.last().copied().unwrap_or(0.0);
    #[allow(clippy::cast_precision_loss)]
    let (qf, qb) = (q as f64, q.saturating_sub(1) as f64);
    let excess_through = (through - LC224_QUARTER_ALLOWANCE * qf).max(0.0);
    let excess_before = (before - LC224_QUARTER_ALLOWANCE * qb).max(0.0);
    (excess_through - excess_before).max(0.0)
}

fn presumed_base(services: f64, goods: f64, excess: f64, rates: (f64, f64)) -> f64 {
    let total = services + goods;
    let share = if total > 0.0 {
        (excess / total).min(1.0)
    } else {
        0.0
    };
    let part = |revenue: f64, rate: f64| {
        revenue * (1.0 - share) * rate + revenue * share * rate * LC224_FACTOR
    };
    part(services, rates.0) + part(goods, rates.1)
}

/// `BrQuarterRevenue`.
#[derive(Debug, Clone, Default)]
struct QuarterRevenue {
    services: Vec<f64>,
    goods: Vec<f64>,
    other_income: f64,
    profit_before_tax: f64,
}

struct ApuracaoInput {
    period: String,
    regime: String,
    mei_activity: &'static str,
    simples: Option<(Vec<Slice>, f64, f64)>,
    ledger: Vec<LedgerTotal>,
    quarter: Option<QuarterRevenue>,
    apply_lc224: bool,
}

fn tax_line(code: &str, debits: f64, credits: f64, offsets: f64, due: Option<String>) -> Value {
    json!({
        "code": code,
        "debits": n(debits),
        "credits": n(credits),
        "offsets": n(offsets),
        "payable": n(round2((debits - credits - offsets).max(0.0))),
        "dueDate": due,
    })
}

/// `computeBrApuracao(input)`.
#[allow(clippy::too_many_lines)] // the worksheet, as the TypeScript function
fn compute_apuracao(input: &ApuracaoInput) -> Map<String, Value> {
    let mut warnings: Vec<String> = Vec::new();
    let ledger = &input.ledger;
    let period = input.period.as_str();
    let (year, month) = split_period(period);

    let withheld = |component: &str| sum(ledger, true, &[component]).1;
    let withheld_by_customers = [
        ("irrf", withheld("irrf")),
        ("pis", withheld("pis_ret")),
        ("cofins", withheld("cofins_ret")),
        ("csll", withheld("csll_ret")),
        ("inss", withheld("inss_ret")),
        ("iss", withheld("iss_ret")),
    ];
    let wbc = |key: &str| {
        withheld_by_customers
            .iter()
            .find(|(k, _)| *k == key)
            .map_or(0.0, |(_, v)| *v)
    };

    // Withholdings kept back from suppliers.
    let mut to_pay: Vec<Value> = Vec::new();
    let irrf = sum(ledger, false, &["irrf"]);
    if irrf.1 != 0.0 {
        to_pay.push(json!({ "code": "irrf", "base": n(irrf.0), "amount": n(irrf.1), "dueDate": next_month_day(period, 20), "darfCode": "1708" }));
    }
    let csrf = sum(ledger, false, &["pis_ret", "cofins_ret", "csll_ret"]);
    if csrf.1 != 0.0 {
        to_pay.push(json!({ "code": "csrf", "base": n(sum(ledger, false, &["csll_ret"]).0), "amount": n(csrf.1), "dueDate": next_month_day(period, 20), "darfCode": "5952" }));
    }
    let inss = sum(ledger, false, &["inss_ret"]);
    if inss.1 != 0.0 {
        to_pay.push(json!({ "code": "inss", "base": n(inss.0), "amount": n(inss.1), "dueDate": next_month_day(period, 20) }));
    }
    let iss_ret = sum(ledger, false, &["iss_ret"]);
    if iss_ret.1 != 0.0 {
        to_pay.push(json!({ "code": "iss", "base": n(iss_ret.0), "amount": n(iss_ret.1), "dueDate": next_month_day(period, 10) }));
        warnings.push("ISS withheld from suppliers is due on the date of the municipality where the service was provided.".into());
    }

    let mut simples = Value::Null;
    let mut simples_total = 0.0;
    let mut mei = Value::Null;
    let mut mei_amount = 0.0;
    let mut taxes: Vec<Value> = Vec::new();
    let mut payable_sum = 0.0;
    if input.regime == "simples_nacional" {
        let (slices, rbt12, payroll) = input
            .simples
            .clone()
            .unwrap_or((Vec::new(), 0.0, 0.0));
        let mut das = simples_das(rbt12, payroll, &slices);
        simples_total = das["total"].as_f64().unwrap_or(0.0);
        let over_limit = das["overLimit"] == json!(true);
        let over_sublimit = das["overSublimit"] == json!(true);
        das.insert("dueDate".into(), json!(next_month_day(period, 20)));
        if over_limit {
            warnings.push("Revenue of the last 12 months is above R$ 4.8 million: the company has to leave the Simples Nacional.".into());
        } else if over_sublimit {
            warnings.push("Revenue of the last 12 months is above the R$ 3.6 million sublimit: ICMS and ISS are paid outside the DAS.".into());
        }
        if year >= 2027 {
            warnings.push("From 2027 the DAS also collects CBS (and IBS) with new annex percentages, which this worksheet does not yet apply.".into());
        }
        simples = Value::Object(das);
    } else if input.regime == "mei" {
        let wage = minimum_wage(year).unwrap_or(1621.0);
        if minimum_wage(year).is_none() {
            warnings.push(format!(
                "The minimum wage for {year} is not configured; the 2026 figure is used."
            ));
        }
        let inss_part = round2(wage * 0.05);
        let icms = if input.mei_activity == "services" { 0.0 } else { 1.0 };
        let iss = if input.mei_activity == "commerce" { 0.0 } else { 5.0 };
        mei_amount = round2(inss_part + icms + iss);
        mei = json!({ "amount": n(mei_amount), "inss": n(inss_part), "icms": n(icms), "iss": n(iss), "dueDate": next_month_day(period, 20) });
    } else {
        let mut rows: Vec<(String, f64, f64, f64)> = Vec::new();
        let mut dues: Vec<Option<String>> = Vec::new();
        let iss_debits = sum(ledger, true, &["iss"]).1;
        rows.push(("iss".into(), iss_debits, 0.0, wbc("iss")));
        dues.push(Some(next_month_day(period, 10)));
        let icms_debits = round2(sum(ledger, true, &["icms", "fcp"]).1);
        let icms_credits = sum(ledger, false, &["icms"]).1;
        if icms_debits != 0.0 || icms_credits != 0.0 {
            rows.push(("icms".into(), icms_debits, icms_credits, 0.0));
            dues.push(None);
        }
        let ipi_debits = sum(ledger, true, &["ipi"]).1;
        let ipi_credits = sum(ledger, false, &["ipi"]).1;
        if ipi_debits != 0.0 || ipi_credits != 0.0 {
            rows.push(("ipi".into(), ipi_debits, ipi_credits, 0.0));
            dues.push(Some(next_month_day(period, 25)));
        }
        if year < 2027 {
            rows.push((
                "pis".into(),
                sum(ledger, true, &["pis"]).1,
                sum(ledger, false, &["pis"]).1,
                wbc("pis"),
            ));
            dues.push(Some(next_month_day(period, 25)));
            rows.push((
                "cofins".into(),
                sum(ledger, true, &["cofins"]).1,
                sum(ledger, false, &["cofins"]).1,
                wbc("cofins"),
            ));
            dues.push(Some(next_month_day(period, 25)));
        } else {
            for code in ["cbs", "ibs"] {
                let debits = sum(ledger, true, &[code]).1;
                let credits = sum(ledger, false, &[code]).1;
                if debits != 0.0 || credits != 0.0 {
                    rows.push((code.into(), debits, credits, 0.0));
                    dues.push(Some(next_month_day(period, 25)));
                }
            }
        }
        for (code, debits, credits, offsets) in &rows {
            if debits - credits - offsets < -0.005 {
                warnings.push(format!(
                    "{}: credits and offsets exceed the debits by R$ {}; the balance carries over to the next month.",
                    code.to_uppercase(),
                    js::to_fixed(credits + offsets - debits, 2)
                ));
            }
        }
        if icms_debits != 0.0 || icms_credits != 0.0 {
            warnings.push(
                "ICMS is due on the date set by the state; ICMS-ST and DIFAL are not included."
                    .into(),
            );
        }
        for ((code, debits, credits, offsets), due) in rows.into_iter().zip(dues) {
            payable_sum += round2((debits - credits - offsets).max(0.0));
            taxes.push(tax_line(&code, debits, credits, offsets, due));
        }
    }

    // Quarterly IRPJ / CSLL.
    let mut quarterly = Value::Null;
    let mut quarterly_payable = 0.0;
    if month % 3 == 0
        && let Some(q) = &input.quarter
        && (input.regime == "lucro_presumido" || input.regime == "lucro_real")
    {
        let quarter = month / 3;
        let services = q.services.last().copied().unwrap_or(0.0);
        let goods = q.goods.last().copied().unwrap_or(0.0);
        let mut lc224_applied = false;
        let (irpj_base, csll_base) = if input.regime == "lucro_presumido" {
            let totals: Vec<f64> = q
                .services
                .iter()
                .enumerate()
                .map(|(i, s)| s + q.goods.get(i).copied().unwrap_or(0.0))
                .collect();
            let apply_irpj = input.apply_lc224 && year >= 2026;
            let apply_csll = apply_irpj && (year > 2026 || quarter >= 2);
            let irpj_excess = if apply_irpj {
                lc224_excess(&totals)
            } else {
                0.0
            };
            let csll_quarters: &[f64] = if year == 2026 {
                totals.get(1..).unwrap_or_default()
            } else {
                &totals
            };
            let csll_excess = if apply_csll {
                lc224_excess(csll_quarters)
            } else {
                0.0
            };
            lc224_applied = irpj_excess > 0.0 || csll_excess > 0.0;
            (
                presumed_base(services, goods, irpj_excess, (0.32, 0.08)) + q.other_income,
                presumed_base(services, goods, csll_excess, (0.32, 0.12)) + q.other_income,
            )
        } else {
            let profit = q.profit_before_tax;
            warnings.push("Lucro Real: IRPJ and CSLL are worked out on the book profit of the quarter, without LALUR adjustments or loss carry-forward. Have your accountant review it.".into());
            (profit.max(0.0), profit.max(0.0))
        };
        let irpj = round2(irpj_base * 0.15);
        let additional = round2((irpj_base - 60_000.0).max(0.0) * 0.1);
        let csll = round2(csll_base * 0.09);
        let irrf_offset = round2(wbc("irrf").min(irpj + additional));
        let csll_offset = round2(wbc("csll").min(csll));
        let irpj_payable = round2(irpj + additional - irrf_offset);
        let csll_payable = round2(csll - csll_offset);
        quarterly_payable = irpj_payable + csll_payable;
        quarterly = json!({
            "quarter": quarter,
            "irpjBase": n(round2(irpj_base)),
            "csllBase": n(round2(csll_base)),
            "irpj": n(irpj),
            "irpjAdditional": n(additional),
            "csll": n(csll),
            "irrfOffset": n(irrf_offset),
            "csllOffset": n(csll_offset),
            "irpjPayable": n(irpj_payable),
            "csllPayable": n(csll_payable),
            "dueDate": last_day_of_next_month(period),
            "lc224Applied": lc224_applied,
        });
    }

    let (cbs, ibs) = if year == 2026 {
        (sum(ledger, true, &["cbs"]).1, sum(ledger, true, &["ibs"]).1)
    } else {
        (0.0, 0.0)
    };
    let to_pay_sum = to_pay
        .iter()
        .fold(0.0, |s, w| s + w["amount"].as_f64().unwrap_or(0.0));
    let total = round2(simples_total + mei_amount + payable_sum + to_pay_sum + quarterly_payable);

    let mut out = Map::new();
    out.insert("period".into(), json!(period));
    out.insert("regime".into(), json!(input.regime));
    out.insert("simples".into(), simples);
    out.insert("mei".into(), mei);
    out.insert("taxes".into(), Value::Array(taxes));
    out.insert("withholdingsToPay".into(), Value::Array(to_pay));
    out.insert(
        "withheldByCustomers".into(),
        Value::Object(
            withheld_by_customers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), n(*v)))
                .collect(),
        ),
    );
    out.insert("quarterly".into(), quarterly);
    out.insert("informational".into(), json!({ "cbs": n(cbs), "ibs": n(ibs) }));
    out.insert("total".into(), n(total));
    out.insert("warnings".into(), json!(warnings));
    out
}

// ── loading ─────────────────────────────────────────────────────────────────

/// `monthRange(period)`: (from, to) as ISO instants, (start, end) as days.
pub(crate) fn month_range(period: &str) -> Option<(String, String, String, String)> {
    let b = period.as_bytes();
    let valid = b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && matches!(&period[5..7], "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12");
    if !valid {
        return None;
    }
    let (y, m) = split_period(period);
    let start = day_text(y, m, 1);
    let end = day_text(y, m, last_day(y, m));
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    Some((
        format!("{start}T00:00:00.000Z"),
        format!("{}T00:00:00.000Z", day_text(ny, nm, 1)),
        start,
        end,
    ))
}

/// `addMonths(date, months)` on the first of a month (`YYYY-MM-DDT…`).
fn add_months(iso: &str, months: i64) -> String {
    let y = js::parse_int(&iso[..4]).unwrap_or(0);
    let m = js::parse_int(&iso[5..7]).unwrap_or(1);
    let index = y * 12 + (m - 1) + months;
    let (year, month) = (index.div_euclid(12), index.rem_euclid(12) + 1);
    format!("{}T00:00:00.000Z", day_text(year, month, 1))
}

struct RevenueLine {
    amount: f64,
    anexo: String,
    kind: &'static str,
    invoice_id: String,
}

/// `revenueLines(db, entity, from, to)`.
async fn revenue_lines(
    db: &PgPool,
    entity: &Value,
    from: &str,
    to: &str,
) -> Result<(Vec<RevenueLine>, Vec<(String, f64)>), sqlx::Error> {
    let entity_id = entity["id"].as_str().unwrap_or_default();
    let base_currency = entity["baseCurrency"].as_str();
    let default_anexo = entity
        .get("jurisdictionSettings")
        .and_then(|s| s.get("simplesAnexo"))
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
        .map(str::to_owned);
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "select \"invoices\".\"id\", \"invoices\".\"type\", \"invoices\".\"currency\", \
         \"invoices\".\"exchange_rate\"::text, \"invoices\".\"tax_breakdown\", \
         \"invoice_items\".\"line_total\"::text, \"invoice_items\".\"tax_rate_id\" \
         from \"invoice_items\" inner join \"invoices\" on \"invoice_items\".\"invoice_id\" = \"invoices\".\"id\" \
         where (\"invoices\".\"entity_id\" = $1 and \"invoices\".\"deleted_at\" is null \
         and \"invoice_items\".\"deleted_at\" is null and \"invoices\".\"issue_date\" >= $2::timestamp \
         and \"invoices\".\"issue_date\" < $3::timestamp \
         and \"invoices\".\"status\" not in ('draft', 'cancelled') and \"invoices\".\"type\" not in ('proforma'))",
    )
    .bind(entity_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;

    let mut rate_ids: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(id) = row.6.as_deref().filter(|id| !id.is_empty())
            && !rate_ids.iter().any(|r| r == id)
        {
            rate_ids.push(id.to_owned());
        }
    }
    let profiles: HashMap<String, Option<Value>> = if rate_ids.is_empty() {
        HashMap::new()
    } else {
        let rates: Vec<(String, Option<Value>)> = sqlx::query_as(
            "select \"id\", \"jurisdiction_metadata\" from \"tax_rates\" where \"tax_rates\".\"id\" = any($1)",
        )
        .bind(&rate_ids)
        .fetch_all(db)
        .await?;
        rates
            .into_iter()
            .map(|(id, metadata)| (id, profile_of(metadata.as_ref()).cloned()))
            .collect()
    };
    let to_base = |amount: f64, currency: Option<&str>, rate: Option<&str>| {
        let Some(currency) = currency.filter(|c| !c.is_empty()) else {
            return amount;
        };
        if Some(currency) == base_currency {
            return amount;
        }
        match parse_rate(&rate.map_or(Value::Null, |r| json!(r))) {
            Some(parsed) => to_base_currency(amount, parsed),
            None => amount,
        }
    };

    let mut lines = Vec::new();
    let mut iss_withheld: Vec<(String, f64)> = Vec::new();
    for row in &rows {
        let sign = if row.1.as_deref() == Some("credit_note") {
            -1.0
        } else {
            1.0
        };
        let profile = row
            .6
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| profiles.get(id))
            .and_then(Option::as_ref);
        let profile_kind = profile.and_then(|p| p["kind"].as_str());
        let kind = match profile_kind {
            Some("export_goods" | "export_service") => "export",
            Some("goods_resale" | "goods_production") => "goods",
            _ => "service",
        };
        let anexo = profile
            .and_then(|p| p.get("simplesAnexo"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| default_anexo.clone())
            .unwrap_or_else(|| if kind == "goods" { "I".into() } else { "III".into() });
        let line_total = js::parse_float(row.5.as_deref().unwrap_or("0"));
        lines.push(RevenueLine {
            amount: sign * to_base(line_total, row.2.as_deref(), row.3.as_deref()),
            anexo,
            kind,
            invoice_id: row.0.clone(),
        });
        if !iss_withheld.iter().any(|(id, _)| *id == row.0) {
            let base = row
                .4
                .as_ref()
                .and_then(Value::as_array)
                .map_or(0.0, |rows| {
                    rows.iter()
                        .filter(|b| b.get("component").and_then(Value::as_str) == Some("iss_ret"))
                        .fold(0.0, |sum, b| {
                            sum + b.get("taxableAmount").and_then(Value::as_f64).unwrap_or(0.0)
                        })
                });
            iss_withheld.push((
                row.0.clone(),
                sign * to_base(base, row.2.as_deref(), row.3.as_deref()),
            ));
        }
    }
    Ok((lines, iss_withheld))
}

/// `simplesSlices(lines, issWithheld)`.
fn simples_slices(lines: &[RevenueLine], iss_withheld: &[(String, f64)]) -> Vec<Slice> {
    let mut service_total: Vec<(String, f64)> = Vec::new();
    for l in lines.iter().filter(|l| l.kind == "service") {
        if let Some(entry) = service_total.iter_mut().find(|(id, _)| *id == l.invoice_id) {
            entry.1 += l.amount;
        } else {
            service_total.push((l.invoice_id.clone(), l.amount));
        }
    }
    let mut slices: Vec<Slice> = Vec::new();
    for l in lines {
        let at = slices
            .iter()
            .position(|s| s.anexo == l.anexo)
            .unwrap_or_else(|| {
                slices.push(Slice {
                    anexo: l.anexo.clone(),
                    revenue: 0.0,
                    iss_withheld: 0.0,
                    exports: 0.0,
                });
                slices.len() - 1
            });
        let slice = &mut slices[at];
        slice.revenue += l.amount;
        if l.kind == "export" {
            slice.exports += l.amount;
        }
        let total = service_total
            .iter()
            .find(|(id, _)| *id == l.invoice_id)
            .map_or(0.0, |(_, t)| *t);
        if l.kind == "service" && total != 0.0 {
            let withheld = iss_withheld
                .iter()
                .find(|(id, _)| *id == l.invoice_id)
                .map_or(0.0, |(_, w)| *w);
            slice.iss_withheld += (withheld * l.amount) / total;
        }
    }
    slices
}

/// `accountMovement(db, entityId, accountIds, from, to)`: debit - credit.
async fn account_movement(
    db: &PgPool,
    entity_id: &str,
    account_ids: &[String],
    from: &str,
    to: &str,
) -> Result<f64, sqlx::Error> {
    if account_ids.is_empty() {
        return Ok(0.0);
    }
    let net: Option<String> = sqlx::query_scalar(
        "select (coalesce(sum(coalesce(\"journal_lines\".\"base_currency_debit\", \"journal_lines\".\"debit\") \
         - coalesce(\"journal_lines\".\"base_currency_credit\", \"journal_lines\".\"credit\")), 0))::text \
         from \"journal_lines\" inner join \"journal_entries\" on \"journal_lines\".\"journal_entry_id\" = \"journal_entries\".\"id\" \
         where (\"journal_lines\".\"entity_id\" = $1 and \"journal_lines\".\"account_id\" = any($2) \
         and \"journal_entries\".\"date\" >= $3::timestamp and \"journal_entries\".\"date\" < $4::timestamp \
         and \"journal_entries\".\"status\" = 'posted')",
    )
    .bind(entity_id)
    .bind(account_ids)
    .bind(from)
    .bind(to)
    .fetch_optional(db)
    .await?;
    Ok(js::parse_float(net.as_deref().unwrap_or("0")))
}

/// `taxLedger(db, entityId, start, end)`.
async fn tax_ledger(
    db: &PgPool,
    entity_id: &str,
    start: &str,
    end: &str,
) -> Result<Vec<LedgerTotal>, sqlx::Error> {
    let rows: Vec<(Option<String>, String, String, String)> = sqlx::query_as(
        "select \"component\", \"direction\", (coalesce(sum(\"base_taxable_amount\"), 0))::text, \
         (coalesce(sum(\"base_tax_amount\"), 0))::text from \"tax_lines\" \
         where (\"tax_lines\".\"entity_id\" = $1 and \"tax_lines\".\"tax_date\" >= $2::date \
         and \"tax_lines\".\"tax_date\" <= $3::date) group by \"tax_lines\".\"component\", \"tax_lines\".\"direction\"",
    )
    .bind(entity_id)
    .bind(start)
    .bind(end)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(component, direction, taxable, tax)| {
            let component = component.filter(|c| !c.is_empty())?;
            (direction == "sales" || direction == "purchase").then(|| LedgerTotal {
                component,
                sales: direction == "sales",
                taxable: js::parse_float(&taxable),
                tax: js::parse_float(&tax),
            })
        })
        .collect())
}

/// `quarterRevenue(db, entity, period)`.
async fn quarter_revenue(
    db: &PgPool,
    entity: &Value,
    period: &str,
) -> Result<Option<QuarterRevenue>, sqlx::Error> {
    let (year, month) = split_period(period);
    if month % 3 != 0 {
        return Ok(None);
    }
    let entity_id = entity["id"].as_str().unwrap_or_default();
    let mut out = QuarterRevenue::default();
    for q in 1..=month / 3 {
        let from = format!("{}T00:00:00.000Z", day_text(year, (q - 1) * 3 + 1, 1));
        let (lines, _) = revenue_lines(db, entity, &from, &add_months(&from, 3)).await?;
        out.services.push(round_money(
            lines
                .iter()
                .filter(|l| l.kind != "goods")
                .fold(0.0, |s, l| s + l.amount),
        ));
        out.goods.push(round_money(
            lines
                .iter()
                .filter(|l| l.kind == "goods")
                .fold(0.0, |s, l| s + l.amount),
        ));
    }
    let q_from = format!("{}T00:00:00.000Z", day_text(year, month - 2, 1));
    let q_to = add_months(&q_from, 3);
    let accounts: Vec<(String, String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select \"id\", \"type\", \"subtype\", \"metadata\" from \"accounts\" \
         where (\"accounts\".\"entity_id\" = $1 and \"accounts\".\"deleted_at\" is null)",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let role_of = |metadata: &Option<Value>| {
        metadata
            .as_ref()
            .and_then(|m| m.get("systemRole"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let other_ids: Vec<String> = accounts
        .iter()
        .filter(|a| a.2.as_deref() == Some("other_income"))
        .map(|a| a.0.clone())
        .collect();
    let result_ids: Vec<String> = accounts
        .iter()
        .filter(|a| {
            (a.1 == "revenue" || a.1 == "expense")
                && !matches!(
                    role_of(&a.3).as_deref(),
                    Some("income_tax_expense" | "social_contribution_expense")
                )
        })
        .map(|a| a.0.clone())
        .collect();
    let other = -account_movement(db, entity_id, &other_ids, &q_from, &q_to).await?;
    let profit = -account_movement(db, entity_id, &result_ids, &q_from, &q_to).await?;
    out.other_income = round_money(other);
    out.profit_before_tax = round_money(profit);
    Ok(Some(out))
}

/// `payroll12m(db, entity, from)`: salaries, pró-labore and charges of the
/// 12 months before, else the settings' figure.
async fn payroll_12m(db: &PgPool, entity: &Value, from: &str) -> Result<f64, sqlx::Error> {
    let entity_id = entity["id"].as_str().unwrap_or_default();
    let accounts = load_entity_accounts(db, entity_id).await?;
    let ids: Vec<String> = [
        account_for_role(&accounts, "payroll_wages_expense", &[]),
        account_for_role(&accounts, "payroll_tax_expense", &[]),
        accounts.by_code("4.2.1.03"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|a| a["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned))
    .collect();
    let from_ledger = account_movement(db, entity_id, &ids, &add_months(from, -12), from).await?;
    if from_ledger > 0.0 {
        return Ok(round_money(from_ledger));
    }
    Ok(entity
        .get("jurisdictionSettings")
        .and_then(|s| s.get("payroll12m"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0))
}

/// `computeEntityApuracao(db, entity, period)`.
pub(crate) async fn compute_entity_apuracao(
    db: &PgPool,
    entity: &Value,
    period: &str,
) -> Result<Map<String, Value>, ApuracaoError> {
    if entity["jurisdictionCode"].as_str() != Some("BR") {
        return Err(ApuracaoError::User(
            "The apuração is for Brazilian entities only".into(),
        ));
    }
    let regime = regime_of(entity["taxClassification"].as_str()).to_owned();
    let Some((from, to, start, end)) = month_range(period) else {
        return Err(ApuracaoError::User("period must be YYYY-MM".into()));
    };
    let (month_lines, month_withheld) = revenue_lines(db, entity, &from, &to).await?;

    let mut simples = None;
    if regime == "simples_nacional" {
        let previous_from = add_months(&from, -12);
        let opened = entity["createdAt"]
            .as_str()
            .filter(|c| c.len() >= 7)
            .map_or_else(
                || previous_from.clone(),
                |created| format!("{}-01T00:00:00.000Z", &created[..7]),
            );
        let active_from = if opened > previous_from {
            opened
        } else {
            previous_from.clone()
        };
        let (fy, fm) = split_period(&from);
        let (ay, am) = split_period(&active_from);
        let months_before = ((fy - ay) * 12 + fm - am).max(0);
        let (before, _) = revenue_lines(db, entity, &previous_from, &from).await?;
        let revenue_before = before.iter().fold(0.0, |s, l| s + l.amount);
        let current = month_lines.iter().fold(0.0, |s, l| s + l.amount);
        #[allow(clippy::cast_precision_loss)]
        let rbt12 = if months_before >= 12 {
            revenue_before
        } else if months_before <= 0 {
            current * 12.0
        } else {
            (revenue_before / months_before as f64) * 12.0
        };
        simples = Some((
            simples_slices(&month_lines, &month_withheld),
            round_money(rbt12),
            payroll_12m(db, entity, &from).await?,
        ));
    }

    let has = |kind: &str| month_lines.iter().any(|l| l.kind == kind);
    let mei_activity = if has("goods") {
        if has("service") { "both" } else { "commerce" }
    } else {
        "services"
    };
    let ledger = tax_ledger(db, entity["id"].as_str().unwrap_or_default(), &start, &end).await?;
    let quarter = if regime == "lucro_presumido" || regime == "lucro_real" {
        quarter_revenue(db, entity, period).await?
    } else {
        None
    };
    let apply_lc224 = entity
        .get("jurisdictionSettings")
        .and_then(|s| s.get("lc224Injunction"))
        != Some(&Value::Bool(true));
    Ok(compute_apuracao(&ApuracaoInput {
        period: period.to_owned(),
        regime,
        mei_activity,
        simples,
        ledger,
        quarter,
        apply_lc224,
    }))
}

/// `StoredApuracao`: whether the month is booked.
pub(crate) struct Stored {
    pub tax_return_id: Option<String>,
    pub journal_entry_id: Option<String>,
}

impl Stored {
    /// `{ status, taxReturnId?, journalEntryId? }`.
    pub(crate) fn fields(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert(
            "status".into(),
            json!(if self.tax_return_id.is_some() {
                "booked"
            } else {
                "open"
            }),
        );
        if let Some(id) = &self.tax_return_id {
            out.insert("taxReturnId".into(), json!(id));
        }
        if let Some(id) = &self.journal_entry_id {
            out.insert("journalEntryId".into(), json!(id));
        }
        out
    }
}

/// `storedApuracao(db, entityId, period)`; also the stored summary.
pub(crate) async fn stored_apuracao(
    db: &PgPool,
    entity_id: &str,
    period: &str,
) -> Result<(Stored, Option<Value>), ApuracaoError> {
    let Some((_, _, start, _)) = month_range(period) else {
        return Err(ApuracaoError::User("period must be YYYY-MM".into()));
    };
    let row: Option<(String, Option<Value>)> = sqlx::query_as(
        "select \"id\", \"summary\" from \"tax_returns\" where (\"tax_returns\".\"entity_id\" = $1 \
         and \"tax_returns\".\"jurisdiction_code\" = 'BR' and \"tax_returns\".\"period_start\" = $2::date \
         and \"tax_returns\".\"deleted_at\" is null) limit 1",
    )
    .bind(entity_id)
    .bind(&start)
    .fetch_optional(db)
    .await?;
    Ok(match row {
        None => (
            Stored {
                tax_return_id: None,
                journal_entry_id: None,
            },
            None,
        ),
        Some((id, summary)) => {
            let journal = summary
                .as_ref()
                .and_then(|s| s.get("journalEntryId"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            (
                Stored {
                    tax_return_id: Some(id),
                    journal_entry_id: journal,
                },
                summary.filter(|s| !s.is_null()),
            )
        }
    })
}

/// What booking a month wrote.
pub(crate) struct Booked {
    pub tax_return_id: String,
    pub journal_entry_id: Option<String>,
    pub total: f64,
}

/// `bookApuracao(db, entity, period, userId)`.
#[allow(clippy::too_many_lines)] // the posting, as the TypeScript function
pub(crate) async fn book_apuracao(
    db: &PgPool,
    entity: &Value,
    period: &str,
    user_id: Option<&str>,
) -> Result<Booked, ApuracaoError> {
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    let (existing, _) = stored_apuracao(db, &entity_id, period).await?;
    if existing.tax_return_id.is_some() {
        return Err(ApuracaoError::User(format!(
            "The apuração of {period} is already booked"
        )));
    }
    let apuracao = compute_entity_apuracao(db, entity, period).await?;
    let accounts = load_entity_accounts(db, &entity_id).await?;
    let mut lines: Vec<PostingLine> = Vec::new();
    let mut pair = |debit_role: &str, credit_role: &str, amount: f64, description: String| {
        let value = round_money(amount);
        if value <= 0.0 {
            return Ok(());
        }
        let role = |name: &str| {
            account_for_role(&accounts, name, &[])
                .and_then(|a| a["id"].as_str().map(str::to_owned))
                .ok_or_else(|| {
                    ApuracaoError::Post(PostError::Posting(format!(
                        "No account with the role {name}. Add it to the chart of accounts."
                    )))
                })
        };
        let debit_account = role(debit_role)?;
        let credit_account = role(credit_role)?;
        lines.push(PostingLine {
            account_id: debit_account,
            debit: value,
            description: Some(description.clone()),
            ..PostingLine::default()
        });
        lines.push(PostingLine {
            account_id: credit_account,
            credit: value,
            description: Some(description),
            ..PostingLine::default()
        });
        Ok::<(), ApuracaoError>(())
    };

    let f = |v: &Value, key: &str| v.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let das = apuracao
        .get("simples")
        .map_or(0.0, |s| f(s, "total"))
        + apuracao.get("mei").map_or(0.0, |m| f(m, "amount"));
    pair(
        "revenue_deduction_simples",
        "tax_payable_simples",
        das,
        format!("DAS {period}"),
    )?;
    for tax in apuracao
        .get("taxes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let offset = f(&tax, "offsets").min(f(&tax, "debits") - f(&tax, "credits"));
        match tax["code"].as_str() {
            Some("pis") => pair(
                "tax_payable_pis",
                "withheld_receivable_pis",
                offset,
                format!("PIS retido compensado {period}"),
            )?,
            Some("cofins") => pair(
                "tax_payable_cofins",
                "withheld_receivable_cofins",
                offset,
                format!("COFINS retida compensada {period}"),
            )?,
            _ => {}
        }
    }
    if let Some(q) = apuracao.get("quarterly").filter(|q| !q.is_null()) {
        let quarter = q["quarter"].as_i64().unwrap_or(0);
        pair(
            "income_tax_expense",
            "tax_payable_irpj",
            f(q, "irpj") + f(q, "irpjAdditional"),
            format!("IRPJ {quarter}º trimestre"),
        )?;
        pair(
            "social_contribution_expense",
            "tax_payable_csll",
            f(q, "csll"),
            format!("CSLL {quarter}º trimestre"),
        )?;
        pair(
            "tax_payable_irpj",
            "withheld_receivable_irrf",
            f(q, "irrfOffset"),
            format!("IRRF retido compensado {quarter}º trimestre"),
        )?;
        pair(
            "tax_payable_csll",
            "withheld_receivable_csll",
            f(q, "csllOffset"),
            format!("CSLL retida compensada {quarter}º trimestre"),
        )?;
    }

    let Some((_, _, start, end)) = month_range(period) else {
        return Err(ApuracaoError::User("period must be YYYY-MM".into()));
    };
    let tax_return_id = generate_id("txr");
    let now = weldsuite_books_domain::http::now();
    let total = f(&Value::Object(apuracao.clone()), "total");
    let total_due = js::to_fixed(total, 2);
    let summary = Value::Object(apuracao);

    if lines.is_empty() {
        insert_return(
            db,
            &tax_return_id,
            &entity_id,
            &start,
            &end,
            &total_due,
            &summary,
            &now,
        )
        .await?;
        return Ok(Booked {
            tax_return_id,
            journal_entry_id: None,
            total,
        });
    }

    let also: AlsoWrite = {
        let (id, entity_id, start, end, total_due, summary, now) = (
            tax_return_id.clone(),
            entity_id.clone(),
            start.clone(),
            end.clone(),
            total_due.clone(),
            summary.clone(),
            now.clone(),
        );
        Box::new(move |conn, posted| {
            Box::pin(async move {
                let mut summary = summary;
                if let Value::Object(map) = &mut summary {
                    map.insert("journalEntryId".into(), json!(posted.journal_entry_id));
                }
                insert_return(&mut *conn, &id, &entity_id, &start, &end, &total_due, &summary, &now)
                    .await
            })
        })
    };
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.clone(),
            date: format!("{end}T12:00:00.000Z"),
            description: format!("Apuração {period}"),
            source_type: "tax_return".into(),
            source_id: Some(tax_return_id.clone()),
            posting_key: Some(format!("br-apuracao:{period}")),
            lock_kind: Some(PostingLockKind::General),
            lines,
            created_by: user_id.map(str::to_owned),
            also_write: vec![also],
            ..PostJournalEntryInput::default()
        },
    )
    .await
    .map_err(|error| match error {
        PostError::Database(error) => ApuracaoError::Database(error),
        other => ApuracaoError::Post(other),
    })?;
    Ok(Booked {
        tax_return_id,
        journal_entry_id: posted.journal_entry_id,
        total,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_return<'e>(
    db: impl sqlx::PgExecutor<'e>,
    id: &str,
    entity_id: &str,
    start: &str,
    end: &str,
    total_due: &str,
    summary: &Value,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into tax_returns (id, entity_id, jurisdiction_code, period_start, period_end, status, \
         total_due, created_at, updated_at, summary) values ($1, $2, 'BR', $3::date, $4::date, 'calculated', \
         $5::numeric, $6::timestamp, $6::timestamp, $7)",
    )
    .bind(id)
    .bind(entity_id)
    .bind(start)
    .bind(end)
    .bind(total_due)
    .bind(now)
    .bind(summary)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simples_rates() {
        let (faixa, nominal, _, effective, _) = effective_rate("III", 0.0);
        assert_eq!((faixa, nominal, effective), (1, 6.0, 6.0));
        let das = simples_das(
            240_000.0,
            0.0,
            &[Slice {
                anexo: "III".into(),
                revenue: 20_000.0,
                iss_withheld: 0.0,
                exports: 0.0,
            }],
        );
        assert_eq!(das["lines"][0]["faixa"], json!(2));
        assert_eq!(das["overSublimit"], json!(false));
    }

    #[test]
    fn dates() {
        assert_eq!(next_month_day("2026-12", 20), "2027-01-20");
        assert_eq!(last_day_of_next_month("2026-01"), "2026-02-28");
        assert_eq!(last_day_of_next_month("2026-12"), "2027-01-31");
        assert_eq!(
            month_range("2026-02").map(|r| r.3),
            Some("2026-02-28".to_owned())
        );
        assert!(month_range("2026-13").is_none());
        assert_eq!(add_months("2026-01-01T00:00:00.000Z", -12), "2025-01-01T00:00:00.000Z");
        assert_eq!(lc224_excess(&[1_500_000.0]), 250_000.0);
    }
}
