//! The Dutch payroll tax return, the loonaangifte (`nl/loonaangifte.ts`):
//! the XML message, its totals, the payment reference and the summary
//! document.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::documents::{
    DocumentField, DocumentSection, GeneratedFile, Lang, PayrollDocument, euro_text,
};
use crate::js::{int_of, is_integer, last_day_of_month, math_round, number_text, slice, to_fixed};
use crate::money::from_cents;
use crate::nl::calculate::nl_aow_date;
use crate::nl::rules::nl_rules_for_year;
use crate::nl::xml::{XmlNode, el, el_children, el_num, serialize};
use crate::ordered::OrderedMap;
use crate::types::{NlAmounts, NlFilingData, PayrollIssue, RateLevel, Severity, ZvwKind};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlAddress {
    #[serde(default)]
    pub street: Option<String>,
    #[serde(default)]
    pub house_number: Option<String>,
    #[serde(default)]
    pub house_number_addition: Option<String>,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlEmployeeIdentity {
    pub bsn: Option<String>,
    pub initials: Option<String>,
    pub surname_prefix: Option<String>,
    pub surname: String,
    pub date_of_birth: Option<String>,
    pub nationality: Option<String>,
    pub gender: Option<i64>,
    #[serde(default)]
    pub address: Option<NlAddress>,
    #[serde(default)]
    pub personnel_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoonaangifteIkv {
    pub identity: NlEmployeeIdentity,
    pub income_relationship_number: f64,
    pub employment_start: String,
    pub employment_end: Option<String>,
    pub filing: NlFilingData,
    #[serde(default)]
    pub end_reason_code: Option<String>,
    #[serde(default)]
    pub cao_code: Option<f64>,
    #[serde(default)]
    pub transition_payment_income_relationship_number: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoonaangifteEmployer {
    pub loonheffingennummer: String,
    pub name: String,
    pub contact_name: Option<String>,
    pub contact_phone: Option<String>,
    #[serde(default)]
    pub sector_code: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Software {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub relation_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PeriodRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoonaangifteCorrection {
    pub period: PeriodRange,
    pub ikvs: Vec<LoonaangifteIkv>,
    #[serde(default)]
    pub previously_reported_tot_te_bet_cents: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoonaangifteInput {
    pub employer: LoonaangifteEmployer,
    pub software: Software,
    pub tax_year: i64,
    pub period: PeriodRange,
    pub ikvs: Vec<LoonaangifteIkv>,
    pub corrections: Vec<LoonaangifteCorrection>,
    pub created_at: String,
    pub message_id: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoonaangifteResult {
    pub file: GeneratedFile,
    pub summary: OrderedMap<f64>,
    pub amount_due_cents: f64,
    pub issues: Vec<PayrollIssue>,
}

/// `elfproef(nineDigits)`.
pub fn elfproef(nine_digits: &str) -> bool {
    if nine_digits.len() != 9 || !nine_digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let d: Vec<i64> = nine_digits.bytes().map(|b| i64::from(b - b'0')).collect();
    let sum: i64 = (0..8).map(|i| (9 - i as i64) * d[i]).sum();
    sum % 11 == d[8]
}

fn digits_only(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// `isValidBsn(bsn)`.
pub fn is_valid_bsn(bsn: Option<&str>) -> bool {
    let Some(bsn) = bsn.filter(|b| !b.is_empty()) else {
        return false;
    };
    let digits = format!("{:0>9}", digits_only(bsn));
    if digits.len() != 9
        || digits.starts_with("000")
        || digits.starts_with('8')
        || digits.starts_with('9')
    {
        return false;
    }
    elfproef(&digits)
}

/// `/^(\d{9})L(\d{2})$/` on a trimmed, upper-cased loonheffingennummer.
fn split_lhnr(lhnr: &str) -> Option<(String, String)> {
    let t = js_trim(lhnr).to_uppercase();
    let b = t.as_bytes();
    if b.len() != 12
        || b[9] != b'L'
        || !b[..9].iter().all(u8::is_ascii_digit)
        || !b[10..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    Some((t[..9].to_owned(), t[10..].to_owned()))
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `isValidLoonheffingennummer(lhnr)`.
pub fn is_valid_loonheffingennummer(lhnr: Option<&str>) -> bool {
    let Some(lhnr) = lhnr.filter(|l| !l.is_empty()) else {
        return false;
    };
    match split_lhnr(lhnr) {
        Some((nine, suffix)) if suffix != "00" && !nine.starts_with("000") => elfproef(&nine),
        _ => false,
    }
}

/// `betalingskenmerk({ loonheffingennummer, taxYear, month })`.
pub fn betalingskenmerk(loonheffingennummer: &str, tax_year: i64, month: i64) -> Option<String> {
    let (nine, suffix) = split_lhnr(loonheffingennummer)?;
    if !(1..=12).contains(&month) {
        return None;
    }
    let body = format!(
        "{}6{}{suffix}{month:02}0",
        &nine[..8],
        tax_year.rem_euclid(10)
    );
    let weights = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1];
    let digits: Vec<i64> = body.bytes().map(|b| i64::from(b - b'0')).collect();
    let sum: i64 = (0..digits.len())
        .map(|i| digits[digits.len() - 1 - i] * weights[i % weights.len()])
        .sum();
    let mut check = 11 - (sum % 11);
    if check == 10 {
        check = 1;
    }
    if check == 11 {
        check = 0;
    }
    Some(format!("{check}{body}"))
}

/// `loonaangifteDueDate(taxYear, month)`: the last day of the next month.
pub fn loonaangifte_due_date(tax_year: i64, month: i64) -> String {
    let y = if month == 12 { tax_year + 1 } else { tax_year };
    let m = if month == 12 { 1 } else { month + 1 };
    format!("{y}-{m:02}-{:02}", last_day_of_month(y, m))
}

/// `sumNlFilingData(items)`: one filing for several payslips of a period.
pub fn sum_nl_filing_data(items: &[NlFilingData]) -> Option<NlFilingData> {
    let last = items.last()?;
    let mut amounts = last.amounts.clone();
    let total = |f: fn(&NlAmounts) -> f64| items.iter().fold(0.0, |s, i| s + f(&i.amounts));
    amounts.loon_lb_ph = total(|a| a.loon_lb_ph);
    amounts.loon_sv = total(|a| a.loon_sv);
    amounts.premieloon_awf = total(|a| a.premieloon_awf);
    amounts.premieloon_aof = total(|a| a.premieloon_aof);
    amounts.premieloon_whk = total(|a| a.premieloon_whk);
    amounts.loon_zvw = total(|a| a.loon_zvw);
    amounts.loon_tabel_bijzondere_beloningen = total(|a| a.loon_tabel_bijzondere_beloningen);
    amounts.wage_tax = total(|a| a.wage_tax);
    amounts.labour_credit = total(|a| a.labour_credit);
    amounts.awf_premium = total(|a| a.awf_premium);
    amounts.aof_premium = total(|a| a.aof_premium);
    amounts.wko_premium = total(|a| a.wko_premium);
    amounts.whk_premium = total(|a| a.whk_premium);
    amounts.zvw_employer_levy = total(|a| a.zvw_employer_levy);
    amounts.zvw_withheld = total(|a| a.zvw_withheld);
    amounts.holiday_allowance_paid = total(|a| a.holiday_allowance_paid);
    amounts.holiday_allowance_accrued = total(|a| a.holiday_allowance_accrued);
    amounts.company_car_value = total(|a| a.company_car_value);
    amounts.company_car_employee_contribution = total(|a| a.company_car_employee_contribution);
    amounts.pension_employee = total(|a| a.pension_employee);
    amounts.tax_free_allowances = total(|a| a.tax_free_allowances);
    let optional = |f: fn(&NlAmounts) -> Option<f64>| -> Option<f64> {
        items.iter().any(|i| f(&i.amounts).is_some()).then(|| {
            items
                .iter()
                .fold(0.0, |s, i| s + f(&i.amounts).unwrap_or(0.0))
        })
    };
    let keep = |current: Option<f64>, summed: Option<f64>| summed.or(current);
    amounts.cash_wage = keep(amounts.cash_wage, optional(|a| a.cash_wage));
    amounts.in_kind_wage = keep(amounts.in_kind_wage, optional(|a| a.in_kind_wage));
    amounts.overtime_wage = keep(amounts.overtime_wage, optional(|a| a.overtime_wage));
    amounts.travel_allowance_tax_free = keep(
        amounts.travel_allowance_tax_free,
        optional(|a| a.travel_allowance_tax_free),
    );
    amounts.transition_payment = keep(
        amounts.transition_payment,
        optional(|a| a.transition_payment),
    );
    amounts.transition_payment_wage_tax = keep(
        amounts.transition_payment_wage_tax,
        optional(|a| a.transition_payment_wage_tax),
    );
    amounts.transition_payment_loon_zvw = keep(
        amounts.transition_payment_loon_zvw,
        optional(|a| a.transition_payment_loon_zvw),
    );
    amounts.transition_payment_zvw = keep(
        amounts.transition_payment_zvw,
        optional(|a| a.transition_payment_zvw),
    );
    let with_period_table = items.iter().rev().find(|i| i.table_code != "010");
    let incidental = items.iter().rev().find_map(|i| {
        i.incidental_income_reduction
            .clone()
            .flatten()
            .filter(|v| !v.is_empty())
    });
    Some(NlFilingData {
        table_code: with_period_table
            .map_or_else(|| last.table_code.clone(), |i| i.table_code.clone()),
        amounts,
        hours_paid: items.iter().fold(0.0, |s, i| s + i.hours_paid),
        sv_days: items.iter().fold(0.0, |s, i| s + i.sv_days),
        incidental_income_reduction: Some(incidental),
        ..last.clone()
    })
}

fn amt(cents: f64) -> String {
    let c = math_round(cents);
    if c % 100.0 == 0.0 {
        number_text(c / 100.0)
    } else {
        from_cents(c)
    }
}

fn euros(cents: f64) -> f64 {
    (cents / 100.0).trunc()
}

fn hours_text(h: f64) -> String {
    if is_integer(h) {
        number_text(h)
    } else {
        to_fixed(h, 2)
    }
}

const WG_FIELDS: [&str; 37] = [
    "LnLbPh",
    "LnSV",
    "PrlnAofAnwLg",
    "PrlnAofAnwHg",
    "PrlnAofAnwUit",
    "PrlnWhkAnw",
    "PrlnAwfAnwLg",
    "PrlnAwfAnwHg",
    "PrlnAwfAnwHz",
    "PrlnAwfAnwUit",
    "PrLnUfo",
    "LnTabBB",
    "VakBsl",
    "OpgRchtVakBsl",
    "OpnAvwb",
    "OpbAvwb",
    "LnInGld",
    "WrdLn",
    "LnOwrk",
    "VerstrAanv",
    "IngLbPh",
    "PrAofLg",
    "PrAofHg",
    "PrAofUit",
    "OpslWko",
    "PrGediffWhk",
    "PrAwfLg",
    "PrAwfHg",
    "PrAwfHz",
    "PrAwfUit",
    "PrUFO",
    "BijdrZvw",
    "WghZvw",
    "WrdPrGebrAut",
    "WrknBijdrAut",
    "Reisk",
    "VerrArbKrt",
];

type WgAmounts = BTreeMap<&'static str, f64>;

fn regular_amounts(f: &NlFilingData) -> WgAmounts {
    let a = &f.amounts;
    let tp = a.transition_payment.unwrap_or(0.0);
    let tp_tax = a.transition_payment_wage_tax.unwrap_or(0.0);
    let tp_zvw = a.transition_payment_zvw.unwrap_or(0.0);
    let in_kind = a
        .in_kind_wage
        .unwrap_or(a.company_car_value - a.company_car_employee_contribution);
    let loon_lb = a.loon_lb_ph - tp;
    let cash = match a.cash_wage {
        Some(c) => c - tp,
        None => loon_lb - in_kind + a.pension_employee,
    };
    let low = |rate: RateLevel, v: f64| if rate == RateLevel::Low { v } else { 0.0 };
    let high = |rate: RateLevel, v: f64| if rate == RateLevel::High { v } else { 0.0 };
    let dga = f.is_dga.unwrap_or(false);
    BTreeMap::from([
        ("LnLbPh", loon_lb),
        ("LnSV", a.loon_sv),
        ("PrlnAofAnwLg", low(f.aof_rate, a.premieloon_aof)),
        ("PrlnAofAnwHg", high(f.aof_rate, a.premieloon_aof)),
        ("PrlnAofAnwUit", 0.0),
        ("PrlnWhkAnw", a.premieloon_whk),
        ("PrlnAwfAnwLg", low(f.awf_rate, a.premieloon_awf)),
        ("PrlnAwfAnwHg", high(f.awf_rate, a.premieloon_awf)),
        ("PrlnAwfAnwHz", 0.0),
        ("PrlnAwfAnwUit", 0.0),
        ("PrLnUfo", 0.0),
        ("LnTabBB", a.loon_tabel_bijzondere_beloningen - tp),
        ("VakBsl", a.holiday_allowance_paid),
        ("OpgRchtVakBsl", a.holiday_allowance_accrued),
        ("OpnAvwb", 0.0),
        ("OpbAvwb", 0.0),
        ("LnInGld", cash),
        ("WrdLn", in_kind),
        ("LnOwrk", a.overtime_wage.unwrap_or(0.0)),
        ("VerstrAanv", 0.0),
        ("IngLbPh", a.wage_tax - tp_tax),
        ("PrAofLg", low(f.aof_rate, a.aof_premium)),
        ("PrAofHg", high(f.aof_rate, a.aof_premium)),
        ("PrAofUit", 0.0),
        ("OpslWko", a.wko_premium),
        ("PrGediffWhk", a.whk_premium),
        ("PrAwfLg", low(f.awf_rate, a.awf_premium)),
        ("PrAwfHg", high(f.awf_rate, a.awf_premium)),
        ("PrAwfHz", 0.0),
        ("PrAwfUit", 0.0),
        ("PrUFO", 0.0),
        ("BijdrZvw", a.zvw_withheld - if dga { tp_zvw } else { 0.0 }),
        (
            "WghZvw",
            a.zvw_employer_levy - if dga { 0.0 } else { tp_zvw },
        ),
        ("WrdPrGebrAut", a.company_car_value),
        ("WrknBijdrAut", a.company_car_employee_contribution),
        ("Reisk", a.travel_allowance_tax_free.unwrap_or(0.0)),
        ("VerrArbKrt", a.labour_credit),
    ])
}

fn transition_amounts(f: &NlFilingData) -> WgAmounts {
    let a = &f.amounts;
    let tp = a.transition_payment.unwrap_or(0.0);
    let dga = f.is_dga.unwrap_or(false);
    let mut out: WgAmounts = WG_FIELDS.iter().map(|k| (*k, 0.0)).collect();
    out.insert("LnLbPh", tp);
    out.insert("LnTabBB", tp);
    out.insert("LnInGld", tp);
    out.insert("IngLbPh", a.transition_payment_wage_tax.unwrap_or(0.0));
    out.insert(
        "BijdrZvw",
        if dga {
            a.transition_payment_zvw.unwrap_or(0.0)
        } else {
            0.0
        },
    );
    out.insert(
        "WghZvw",
        if dga {
            0.0
        } else {
            a.transition_payment_zvw.unwrap_or(0.0)
        },
    );
    out
}

struct InkPeriod {
    start: String,
    ww: bool,
    wao: bool,
    zw: bool,
}

struct IkvFigures {
    num_iv: f64,
    srt_iv: &'static str,
    dat_aanv: String,
    dat_eind: Option<String>,
    end_reason: Option<String>,
    periods: Vec<InkPeriod>,
    amounts: WgAmounts,
}

const COLLECTIVE_ORDER: [&str; 25] = [
    "TotLnLbPh",
    "TotLnSV",
    "TotPrlnAofAnwLg",
    "TotPrlnAofAnwHg",
    "TotPrlnAofAnwUit",
    "TotPrlnWhkAnw",
    "TotPrlnAwfAnwLg",
    "TotPrlnAwfAnwHg",
    "TotPrlnAwfAnwHz",
    "TotPrlnAwfAnwUit",
    "PrLnUFO",
    "IngLbPh",
    "TotPrAofLg",
    "TotPrAofHg",
    "TotPrAofUit",
    "TotOpslWko",
    "TotPrGediffWhk",
    "TotPrAwfLg",
    "TotPrAwfHg",
    "TotPrAwfHz",
    "TotPrAwfUit",
    "PrUFO",
    "IngBijdrZvw",
    "TotWghZvw",
    "TotTeBet",
];

const COLLECTIVE_SOURCES: [(&str, &str); 24] = [
    ("TotLnLbPh", "LnLbPh"),
    ("TotLnSV", "LnSV"),
    ("TotPrlnAofAnwLg", "PrlnAofAnwLg"),
    ("TotPrlnAofAnwHg", "PrlnAofAnwHg"),
    ("TotPrlnAofAnwUit", "PrlnAofAnwUit"),
    ("TotPrlnWhkAnw", "PrlnWhkAnw"),
    ("TotPrlnAwfAnwLg", "PrlnAwfAnwLg"),
    ("TotPrlnAwfAnwHg", "PrlnAwfAnwHg"),
    ("TotPrlnAwfAnwHz", "PrlnAwfAnwHz"),
    ("TotPrlnAwfAnwUit", "PrlnAwfAnwUit"),
    ("PrLnUFO", "PrLnUfo"),
    ("IngLbPh", "IngLbPh"),
    ("TotPrAofLg", "PrAofLg"),
    ("TotPrAofHg", "PrAofHg"),
    ("TotPrAofUit", "PrAofUit"),
    ("TotOpslWko", "OpslWko"),
    ("TotPrGediffWhk", "PrGediffWhk"),
    ("TotPrAwfLg", "PrAwfLg"),
    ("TotPrAwfHg", "PrAwfHg"),
    ("TotPrAwfHz", "PrAwfHz"),
    ("TotPrAwfUit", "PrAwfUit"),
    ("PrUFO", "PrUFO"),
    ("IngBijdrZvw", "BijdrZvw"),
    ("TotWghZvw", "WghZvw"),
];

const PAYABLE: [&str; 13] = [
    "IngLbPh",
    "TotWghZvw",
    "IngBijdrZvw",
    "TotPrAofLg",
    "TotPrAofHg",
    "TotPrAofUit",
    "TotOpslWko",
    "TotPrGediffWhk",
    "TotPrAwfLg",
    "TotPrAwfHg",
    "TotPrAwfHz",
    "TotPrAwfUit",
    "PrUFO",
];

const OPTIONAL_COLLECTIVE: [&str; 10] = [
    "TotPrAofLg",
    "TotPrAofHg",
    "TotPrAofUit",
    "TotOpslWko",
    "TotPrGediffWhk",
    "TotPrAwfLg",
    "TotPrAwfHg",
    "TotPrAwfHz",
    "TotPrAwfUit",
    "PrUFO",
];

struct BuiltPeriod {
    ikv_nodes: Vec<XmlNode>,
    totals: OrderedMap<f64>,
}

fn month_end(start: &str) -> String {
    let y = int_of(slice(start, 0, 4));
    let m = int_of(slice(start, 5, 7));
    format!("{}-{:02}", slice(start, 0, 7), last_day_of_month(y, m))
}

/// `text.slice(0, n)` by UTF-16 code units.
pub(crate) fn slice_utf16(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

struct Issues(Vec<PayrollIssue>);

impl Issues {
    fn err(&mut self, code: &str, params: Option<&[(&str, Value)]>) {
        let issue = PayrollIssue::error(code);
        self.0.push(match params {
            Some(p) => issue.with(p),
            None => issue,
        });
    }

    fn warn(&mut self, code: &str, params: &[(&str, Value)]) {
        self.0.push(PayrollIssue::warning(code).with(params));
    }
}

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

/// `buildLoonaangifte(input)`.
#[allow(clippy::too_many_lines)]
pub fn build_loonaangifte(input: &LoonaangifteInput) -> LoonaangifteResult {
    let mut issues = Issues(vec![]);
    let year = input.tax_year;
    let rules = nl_rules_for_year(year);
    if rules.is_none() || ![2026, 2027].contains(&year) {
        issues.err("unsupported_tax_year", Some(&[("year", json!(year))]));
    }
    let lhnr = js_trim(&input.employer.loonheffingennummer).to_uppercase();
    if !is_valid_loonheffingennummer(Some(&lhnr)) {
        issues.err(
            "invalid_loonheffingennummer",
            Some(&[(
                "loonheffingennummer",
                json!(input.employer.loonheffingennummer),
            )]),
        );
    }
    if input
        .employer
        .contact_name
        .as_deref()
        .is_none_or(str::is_empty)
    {
        issues.err(
            "employer_incomplete",
            Some(&[("field", json!("contactName"))]),
        );
    }
    let raw_phone = input.employer.contact_phone.clone().unwrap_or_default();
    let raw_phone = match raw_phone.strip_prefix("00") {
        Some(rest) => format!("+{rest}"),
        None => raw_phone,
    };
    let phone: String = raw_phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    if phone.is_empty() {
        issues.err(
            "employer_incomplete",
            Some(&[("field", json!("contactPhone"))]),
        );
    }
    let rel_nr = js_trim(input.software.relation_number.as_deref().unwrap_or("")).to_uppercase();
    let rel_ok = rel_nr.len() == 8
        && rel_nr.starts_with("SWO")
        && rel_nr[3..].bytes().all(|b| b.is_ascii_digit());
    if !rel_ok {
        issues.err("missing_software_relation_number", None);
    }
    if input.corrections.len() > 13 {
        issues.err(
            "too_many_corrections",
            Some(&[("count", json!(input.corrections.len()))]),
        );
    }
    let check_period = |issues: &mut Issues, p: &PeriodRange| {
        let ok = slice(&p.start, 0, 4) == year.to_string()
            && p.start.ends_with("-01")
            && p.end == month_end(&p.start);
        if !ok {
            issues.err(
                "invalid_period",
                Some(&[("start", json!(p.start)), ("end", json!(p.end))]),
            );
        }
    };
    check_period(&mut issues, &input.period);

    let build_period = |issues: &mut Issues,
                        period: &PeriodRange,
                        ikvs: &[LoonaangifteIkv]|
     -> BuiltPeriod {
        check_period(issues, period);
        let mut rows: Vec<(&LoonaangifteIkv, IkvFigures)> = vec![];
        for ikv in ikvs {
            let f = &ikv.filing;
            let id = &ikv.identity;
            let irn = n(ikv.income_relationship_number);
            let anonymous = f.anonymous || f.table_code == "940";
            let bsn_present = id.bsn.as_deref().is_some_and(|b| !b.is_empty());
            if !anonymous && !is_valid_bsn(id.bsn.as_deref()) {
                if bsn_present {
                    issues.err("invalid_bsn", Some(&[("incomeRelationship", irn.clone())]));
                } else {
                    issues.err(
                        "missing_tax_id",
                        Some(&[("incomeRelationship", irn.clone())]),
                    );
                }
            }
            if anonymous && !bsn_present && id.personnel_number.as_deref().is_none_or(str::is_empty)
            {
                issues.err(
                    "missing_personnel_number",
                    Some(&[("incomeRelationship", irn.clone())]),
                );
            }
            let address_ok = id.address.as_ref().is_some_and(|a| {
                a.street.as_deref().is_some_and(|s| !s.is_empty())
                    && a.city.as_deref().is_some_and(|c| !c.is_empty())
            });
            if !anonymous && !address_ok {
                issues.err(
                    "missing_address",
                    Some(&[("incomeRelationship", irn.clone())]),
                );
            }
            let ended = ikv
                .employment_end
                .as_deref()
                .is_some_and(|e| !e.is_empty() && e <= period.end.as_str());
            let mut end_reason = None;
            if ended {
                end_reason = ikv.end_reason_code.clone().filter(|r| !r.is_empty());
                if end_reason.is_none() {
                    end_reason = Some("99".to_owned());
                    issues.warn(
                        "end_reason_defaulted",
                        &[("incomeRelationship", irn.clone())],
                    );
                }
            }
            let start_in_period = if ikv.employment_start.as_str() > period.start.as_str() {
                ikv.employment_start.clone()
            } else {
                period.start.clone()
            };
            let mut periods = vec![InkPeriod {
                start: start_in_period.clone(),
                ww: f.insured.ww,
                wao: f.insured.wao,
                zw: f.insured.zw,
            }];
            if let (Some(rules), Some(dob)) =
                (rules, id.date_of_birth.as_deref().filter(|d| !d.is_empty()))
            {
                if f.insured.ww || f.insured.wao {
                    let aow = nl_aow_date(dob, rules);
                    if aow.as_str() > start_in_period.as_str()
                        && aow.as_str() <= period.end.as_str()
                    {
                        periods.push(InkPeriod {
                            start: aow,
                            ww: false,
                            wao: false,
                            zw: f.insured.zw,
                        });
                    }
                }
            }
            rows.push((
                ikv,
                IkvFigures {
                    num_iv: ikv.income_relationship_number,
                    srt_iv: if f.is_dga.unwrap_or(false) {
                        "17"
                    } else {
                        "15"
                    },
                    dat_aanv: ikv.employment_start.clone(),
                    dat_eind: if ended {
                        ikv.employment_end.clone()
                    } else {
                        None
                    },
                    end_reason,
                    periods,
                    amounts: regular_amounts(f),
                },
            ));
            let tp = f.amounts.transition_payment.unwrap_or(0.0);
            if tp != 0.0 {
                match ikv.transition_payment_income_relationship_number {
                    None => issues.err(
                        "missing_income_relationship_number",
                        Some(&[
                            ("incomeRelationship", irn.clone()),
                            ("reason", json!("transition_payment")),
                        ]),
                    ),
                    Some(number) => rows.push((
                        ikv,
                        IkvFigures {
                            num_iv: number,
                            srt_iv: "62",
                            dat_aanv: start_in_period.clone(),
                            dat_eind: None,
                            end_reason: None,
                            periods: vec![InkPeriod {
                                start: start_in_period.clone(),
                                ww: false,
                                wao: false,
                                zw: false,
                            }],
                            amounts: transition_amounts(f),
                        },
                    )),
                }
            }
        }
        let nodes = rows
            .iter()
            .map(|(ikv, fig)| ikv_node(ikv, fig, input, period, issues))
            .collect();
        let mut totals = OrderedMap::new();
        for (total, field) in COLLECTIVE_SOURCES {
            totals.insert(
                total,
                euros(rows.iter().fold(0.0, |s, (_, fig)| s + fig.amounts[field])),
            );
        }
        let payable = PAYABLE
            .iter()
            .fold(0.0, |s, k| s + totals.get(k).copied().unwrap_or(0.0));
        totals.insert("TotTeBet", payable);
        BuiltPeriod {
            ikv_nodes: nodes,
            totals,
        }
    };

    let current = build_period(&mut issues, &input.period, &input.ikvs);
    let mut corrections: Vec<(&LoonaangifteCorrection, BuiltPeriod, f64)> = vec![];
    for c in &input.corrections {
        if c.period.start.as_str() >= input.period.start.as_str() {
            issues.err(
                "invalid_correction_period",
                Some(&[("start", json!(c.period.start))]),
            );
        }
        let built = build_period(&mut issues, &c.period, &c.ikvs);
        let mut saldo = 0.0;
        match c.previously_reported_tot_te_bet_cents {
            None => issues.err(
                "correction_saldo_unknown",
                Some(&[("start", json!(c.period.start))]),
            ),
            Some(previous) => {
                saldo = built.totals.get("TotTeBet").copied().unwrap_or(0.0)
                    - (previous / 100.0).trunc();
            }
        }
        corrections.push((c, built, saldo));
    }
    let mut seen: Vec<&str> = vec![];
    for (c, _, _) in &corrections {
        if seen.contains(&c.period.start.as_str()) {
            issues.err(
                "duplicate_correction_period",
                Some(&[("start", json!(c.period.start))]),
            );
        }
        seen.push(&c.period.start);
    }

    let collective = |totals: &OrderedMap<f64>, extra: Vec<XmlNode>| -> Vec<XmlNode> {
        let mut out = vec![];
        for key in COLLECTIVE_ORDER {
            let v = totals.get(key).copied().unwrap_or(0.0);
            if OPTIONAL_COLLECTIVE.contains(&key) && v == 0.0 {
                continue;
            }
            out.push(el_num(key, v));
        }
        out.extend(extra);
        out
    };
    let saldo_nodes: Vec<XmlNode> = corrections
        .iter()
        .map(|(c, _, saldo)| {
            el_children(
                "SaldoCorrectiesVoorgaandTijdvak",
                vec![
                    el("DatAanvTv", c.period.start.clone()),
                    el("DatEindTv", c.period.end.clone()),
                    el_num("Saldo", *saldo),
                ],
            )
        })
        .collect();
    let tot_gen = current.totals.get("TotTeBet").copied().unwrap_or(0.0)
        + corrections.iter().fold(0.0, |s, x| s + x.2);
    let wrapper = if input.kind.as_deref() == Some("aanvullend") {
        "AanvullendeAangifte"
    } else {
        "VolledigeAangifte"
    };
    let mut collective_extra = saldo_nodes;
    collective_extra.push(el_num("TotGen", tot_gen));
    let mut wrapper_children = vec![el_children(
        "CollectieveAangifte",
        collective(&current.totals, collective_extra),
    )];
    wrapper_children.extend(current.ikv_nodes.iter().cloned());
    let tijdvak_aangifte = el_children(
        "TijdvakAangifte",
        vec![
            el("DatAanvTv", input.period.start.clone()),
            el("DatEindTv", input.period.end.clone()),
            el_children(wrapper, wrapper_children),
        ],
    );
    let mut eenheid = vec![
        el("LhNr", lhnr.clone()),
        el("NmIP", slice_utf16(&input.employer.name, 200)),
        tijdvak_aangifte,
    ];
    for (c, built, _) in &corrections {
        let mut children = vec![
            el("DatAanvTv", c.period.start.clone()),
            el("DatEindTv", c.period.end.clone()),
            el_children("CollectieveAangifte", collective(&built.totals, vec![])),
        ];
        children.extend(built.ikv_nodes.iter().cloned());
        eenheid.push(el_children("TijdvakCorrectie", children));
    }
    let software = js_trim(&format!(
        "{} {}",
        input.software.name, input.software.version
    ))
    .to_owned();
    let mut root = el_children(
        "Loonaangifte",
        vec![
            el_children(
                "Bericht",
                vec![
                    el("IdBer", slice_utf16(&input.message_id, 32)),
                    el("DatTdAanm", slice_utf16(&input.created_at, 19)),
                    el(
                        "ContPers",
                        slice_utf16(input.employer.contact_name.as_deref().unwrap_or(""), 35),
                    ),
                    el("TelNr", slice_utf16(&phone, 25)),
                    el("RelNr", rel_nr.clone()),
                    el("GebrSwPakket", slice_utf16(&software, 27)),
                ],
            ),
            el_children("AdministratieveEenheid", eenheid),
        ],
    );
    root.attrs = vec![
        (
            "xmlns".into(),
            format!("http://xml.belastingdienst.nl/schemas/Loonaangifte/{year}/01"),
        ),
        ("version".into(), "2.0".into()),
    ];
    let content = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{}\n",
        serialize(&root, "  ", 0)
    );
    let mut summary = OrderedMap::new();
    for (k, v) in current.totals.iter() {
        summary.insert(k.clone(), v * 100.0);
    }
    for (c, _, saldo) in &corrections {
        summary.insert(format!("Saldo:{}", c.period.start), saldo * 100.0);
    }
    summary.insert("TotGen", tot_gen * 100.0);
    let month = int_of(slice(&input.period.start, 5, 7));
    LoonaangifteResult {
        file: GeneratedFile {
            file_name: format!("loonaangifte-{lhnr}-{year}-{month:02}.xml"),
            content_type: "application/xml".into(),
            content,
        },
        summary,
        amount_due_cents: tot_gen * 100.0,
        issues: issues.0,
    }
}

static BRP_NATIONALITY: LazyLock<BTreeMap<String, f64>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/nl-nationality.json")).unwrap_or_default()
});

/// `brpNationalityCode(nationality)`.
pub fn brp_nationality_code(nationality: Option<&str>) -> (String, bool) {
    let Some(nationality) = nationality.filter(|n| !n.is_empty()) else {
        return ("0000".into(), false);
    };
    let trimmed = js_trim(nationality).to_uppercase();
    if (1..=4).contains(&trimmed.len()) && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return (format!("{trimmed:0>4}"), true);
    }
    match BRP_NATIONALITY.get(&trimmed) {
        Some(code) => (format!("{:0>4}", number_text(*code)), true),
        None => ("0000".into(), false),
    }
}

/// `/^(\d+)\s*(.*)$/` on a house number: the digits and the rest.
fn split_house_number(text: &str) -> Option<(String, String)> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let rest =
        text[digits.len()..].trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((digits, rest.to_owned()))
}

#[allow(clippy::too_many_lines)]
fn ikv_node(
    ikv: &LoonaangifteIkv,
    fig: &IkvFigures,
    input: &LoonaangifteInput,
    period: &PeriodRange,
    issues: &mut Issues,
) -> XmlNode {
    let f = &ikv.filing;
    let id = &ikv.identity;
    let anonymous = f.anonymous || f.table_code == "940";
    let yn = |b: bool| if b { "J" } else { "N" };
    let mut person = vec![];
    let bsn = id
        .bsn
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(|b| format!("{:0>9}", digits_only(b)));
    if let Some(bsn) = &bsn {
        person.push(el("SofiNr", bsn.clone()));
    }
    let initials: String = id
        .initials
        .as_deref()
        .unwrap_or("")
        .to_uppercase()
        .chars()
        .filter(char::is_ascii_uppercase)
        .take(6)
        .collect();
    if !initials.is_empty() {
        person.push(el("Voorl", initials));
    }
    if let Some(prefix) = id.surname_prefix.as_deref().filter(|p| !p.is_empty()) {
        person.push(el("Voorv", slice_utf16(prefix, 10)));
    }
    if !id.surname.is_empty() {
        person.push(el("SignNm", slice_utf16(&id.surname, 200)));
    }
    if let Some(dob) = id.date_of_birth.as_deref().filter(|d| !d.is_empty()) {
        person.push(el("Gebdat", dob));
    }
    if !anonymous || bsn.is_some() {
        let (code, known) = brp_nationality_code(id.nationality.as_deref());
        if !known {
            issues.warn(
                "nationality_unknown",
                &[
                    ("incomeRelationship", n(ikv.income_relationship_number)),
                    (
                        "nationality",
                        json!(id.nationality.clone().unwrap_or_default()),
                    ),
                ],
            );
        }
        person.push(el("Nat", code));
        person.push(el("Gesl", id.gender.unwrap_or(9).to_string()));
    }
    if let Some(a) = id.address.as_ref() {
        if let (Some(street), Some(city)) = (
            a.street.as_deref().filter(|s| !s.is_empty()),
            a.city.as_deref().filter(|c| !c.is_empty()),
        ) {
            let country = a
                .country
                .clone()
                .unwrap_or_else(|| "NL".into())
                .to_uppercase();
            let m = split_house_number(js_trim(a.house_number.as_deref().unwrap_or("")));
            if country == "NL" {
                let pc: String = a
                    .postal_code
                    .as_deref()
                    .unwrap_or("")
                    .to_uppercase()
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                let b = pc.as_bytes();
                let pc_ok = b.len() == 6
                    && (b'1'..=b'9').contains(&b[0])
                    && b[1..4].iter().all(u8::is_ascii_digit)
                    && b[4..].iter().all(u8::is_ascii_uppercase);
                if !pc_ok {
                    issues.err(
                        "invalid_postal_code",
                        Some(&[("incomeRelationship", n(ikv.income_relationship_number))]),
                    );
                }
                let addition_source = match &a.house_number_addition {
                    Some(add) => add.clone(),
                    None => m.as_ref().map(|(_, rest)| rest.clone()).unwrap_or_default(),
                };
                let addition = js_trim(&addition_source).to_owned();
                let mut nodes = vec![el("Str", slice_utf16(street, 24))];
                if let Some((digits, _)) = &m {
                    nodes.push(el("HuisNr", number_text(crate::js::number_of(digits))));
                    if !addition.is_empty() {
                        nodes.push(el("HuisNrToev", slice_utf16(&addition, 4)));
                    }
                }
                nodes.push(el("Pc", pc));
                nodes.push(el("Woonpl", slice_utf16(city, 24)));
                person.push(el_children("AdresBinnenland", nodes));
            } else {
                let mut nodes = vec![el("Str", slice_utf16(street, 24))];
                if let Some(number) = a.house_number.as_deref().filter(|h| !h.is_empty()) {
                    let addition = a.house_number_addition.as_deref().filter(|x| !x.is_empty());
                    let text = format!(
                        "{number}{}",
                        addition.map(|x| format!(" {x}")).unwrap_or_default()
                    );
                    nodes.push(el("HuisNr", slice_utf16(&text, 9)));
                }
                if let Some(pc) = a.postal_code.as_deref().filter(|p| !p.is_empty()) {
                    nodes.push(el("Pc", slice_utf16(pc, 9)));
                }
                nodes.push(el("Woonpl", slice_utf16(city, 24)));
                nodes.push(el("LandCd", country));
                person.push(el_children("AdresBuitenland", nodes));
            }
        }
    }
    let regular = fig.srt_iv == "15";
    let insured_any = f.insured.ww || f.insured.zw || f.insured.wao;
    let periods: Vec<XmlNode> = fig
        .periods
        .iter()
        .map(|p| {
            let mut nodes = vec![el("DatAanv", p.start.clone()), el("SrtIV", fig.srt_iv)];
            if regular {
                nodes.push(el("CdAard", "1"));
            }
            if fig.srt_iv != "62" {
                nodes.push(el_num("CAO", ikv.cao_code.unwrap_or(9999.0)));
            }
            if regular {
                nodes.push(el("IndArbovOnbepTd", yn(f.contract.indefinite)));
                nodes.push(el("IndSchriftArbov", yn(f.contract.written)));
                nodes.push(el("IndOprov", yn(f.contract.on_call)));
            }
            nodes.push(el("IndLhKort", yn(f.apply_loonheffingskorting)));
            nodes.push(el(
                "LbTab",
                if fig.srt_iv == "62" {
                    "020".to_owned()
                } else {
                    f.table_code.clone()
                },
            ));
            nodes.push(el("IndWAO", yn(p.wao)));
            nodes.push(el("IndWW", yn(p.ww)));
            nodes.push(el("IndZW", yn(p.zw)));
            nodes.push(el(
                "CdZvw",
                if f.is_dga.unwrap_or(false) || f.zvw == ZvwKind::Withheld {
                    "M"
                } else {
                    "K"
                },
            ));
            if fig.srt_iv != "62" {
                if let Some(code) = f
                    .incidental_income_reduction
                    .clone()
                    .flatten()
                    .filter(|c| !c.is_empty())
                {
                    nodes.push(el("CdIncInkVerm", code));
                }
            }
            el_children("Inkomstenperiode", nodes)
        })
        .collect();
    let mut wg: Vec<XmlNode> = WG_FIELDS
        .iter()
        .map(|k| el(k, amt(fig.amounts[k])))
        .collect();
    let verl_u = if fig.srt_iv == "62" {
        0.0
    } else {
        math_round(f.hours_paid)
    };
    wg.push(el_num("AantVerlU", verl_u));
    if fig.srt_iv != "62" {
        wg.push(el("Ctrctln", amt(f.amounts.contract_wage.unwrap_or(0.0))));
        wg.push(el(
            "AantCtrcturenPWk",
            hours_text(f.contract_hours_per_week.flatten().unwrap_or(0.0)),
        ));
    }
    wg.push(el("BedrRntKstvPersl", "0"));
    let mut sector = vec![];
    if insured_any && fig.srt_iv == "15" {
        match input.employer.sector_code {
            None => issues.err(
                "employer_incomplete",
                Some(&[("field", json!("sectorCode"))]),
            ),
            Some(sect) => {
                let start = if ikv.employment_start.as_str() > period.start.as_str() {
                    ikv.employment_start.clone()
                } else {
                    period.start.clone()
                };
                let mut nodes = vec![el("DatAanvSect", start)];
                if let Some(end) = fig
                    .dat_eind
                    .as_deref()
                    .filter(|e| !e.is_empty() && *e < period.end.as_str())
                {
                    nodes.push(el("DatEindSect", end));
                }
                nodes.push(el_num("Sect", sect));
                sector.push(el_children("Sector", nodes));
            }
        }
    }
    let mut children = vec![
        el_num("NumIV", fig.num_iv),
        el("DatAanv", fig.dat_aanv.clone()),
    ];
    if let Some(end) = fig.dat_eind.as_deref().filter(|e| !e.is_empty()) {
        children.push(el("DatEind", end));
    }
    if let Some(reason) = fig.end_reason.as_deref().filter(|r| !r.is_empty()) {
        children.push(el("CdRdnEindArbov", reason));
    }
    if let Some(nr) = id.personnel_number.as_deref().filter(|p| !p.is_empty()) {
        children.push(el("PersNr", slice_utf16(nr, 35)));
    }
    children.push(el_children("NatuurlijkPersoon", person));
    children.extend(periods);
    children.push(el_children("Werknemersgegevens", wg));
    children.extend(sector);
    el_children("InkomstenverhoudingInitieel", children)
}

const SUMMARY_LABELS: [(&str, &str, &str); 17] = [
    ("TotLnLbPh", "Total wage for wage tax", "Totaal loon LB/PH"),
    (
        "TotLnSV",
        "Total wage for employee insurances",
        "Totaal loon SV",
    ),
    (
        "TotPrlnAwfAnwLg",
        "Premium wage AWf low",
        "Aanwas premieloon AWf laag",
    ),
    (
        "TotPrlnAwfAnwHg",
        "Premium wage AWf high",
        "Aanwas premieloon AWf hoog",
    ),
    (
        "TotPrlnAofAnwLg",
        "Premium wage Aof low",
        "Aanwas premieloon Aof laag",
    ),
    (
        "TotPrlnAofAnwHg",
        "Premium wage Aof high",
        "Aanwas premieloon Aof hoog",
    ),
    ("TotPrlnWhkAnw", "Premium wage Whk", "Aanwas premieloon Whk"),
    (
        "IngLbPh",
        "Wage tax withheld",
        "Ingehouden loonbelasting/premie volksverzekeringen",
    ),
    ("TotPrAwfLg", "AWf premium low", "Premie AWf laag"),
    ("TotPrAwfHg", "AWf premium high", "Premie AWf hoog"),
    ("TotPrAofLg", "Aof premium low", "Premie Aof laag"),
    ("TotPrAofHg", "Aof premium high", "Premie Aof hoog"),
    ("TotOpslWko", "Wko surcharge", "Opslag Wko"),
    (
        "TotPrGediffWhk",
        "Whk premium",
        "Gedifferentieerde premie Whk",
    ),
    (
        "IngBijdrZvw",
        "Zvw contribution withheld",
        "Ingehouden bijdrage Zvw",
    ),
    ("TotWghZvw", "Employer Zvw levy", "Werkgeversheffing Zvw"),
    (
        "TotTeBet",
        "Total payable for the period",
        "Totaal te betalen over tijdvak",
    ),
];

/// `loonaangifteSummaryDocument(result, input, lang)`.
pub fn loonaangifte_summary_document(
    result: &LoonaangifteResult,
    input: &LoonaangifteInput,
    lang: Lang,
) -> PayrollDocument {
    let nl = lang.is_nl();
    let pick = |a: &str, b: &str| if nl { a.to_owned() } else { b.to_owned() };
    let month = int_of(slice(&input.period.start, 5, 7));
    let due = loonaangifte_due_date(input.tax_year, month);
    let kenmerk = betalingskenmerk(&input.employer.loonheffingennummer, input.tax_year, month);
    let s = &result.summary;
    let mut rows: Vec<Vec<String>> = SUMMARY_LABELS
        .iter()
        .filter(|(k, _, _)| s.get(k).copied().unwrap_or(0.0) != 0.0 || *k == "TotTeBet")
        .map(|(k, en, nl_label)| {
            vec![
                if nl {
                    (*nl_label).to_owned()
                } else {
                    (*en).to_owned()
                },
                (*k).to_owned(),
                euro_text(s.get(k).copied().unwrap_or(0.0), lang),
            ]
        })
        .collect();
    for (k, v) in s.iter().filter(|(k, _)| k.starts_with("Saldo:")) {
        let month_text = slice(k, 6, 13);
        rows.push(vec![
            if nl {
                format!("Saldo correctie {month_text}")
            } else {
                format!("Correction balance {month_text}")
            },
            "Saldo".into(),
            euro_text(*v, lang),
        ]);
    }
    let period_text = format!("{} – {}", input.period.start, input.period.end);
    let has_error = result.issues.iter().any(|i| i.severity == Severity::Error);
    PayrollDocument {
        title: pick("Aangifte loonheffingen", "Payroll tax return"),
        subtitle: Some(period_text.clone()),
        language: lang,
        from: Some(vec![
            input.employer.name.clone(),
            format!(
                "{}: {}",
                pick("Loonheffingennummer", "Payroll tax number"),
                input.employer.loonheffingennummer
            ),
        ]),
        to: None,
        sections: vec![
            DocumentSection::Fields {
                title: None,
                fields: vec![
                    DocumentField::new(pick("Aangiftetijdvak", "Period"), period_text),
                    DocumentField::new(
                        pick("Inkomstenverhoudingen", "Income relationships"),
                        input.ikvs.len().to_string(),
                    ),
                    DocumentField::new(
                        pick("Correcties", "Corrections"),
                        input.corrections.len().to_string(),
                    ),
                    DocumentField::new(
                        pick(
                            "Uiterste aangifte- en betaaldatum",
                            "Filing and payment deadline",
                        ),
                        due,
                    ),
                    DocumentField::new(
                        pick("Betalingskenmerk", "Payment reference"),
                        kenmerk.unwrap_or_else(|| "—".into()),
                    ),
                    DocumentField::new(
                        pick("Te betalen (totaal generaal)", "Amount due (total)"),
                        euro_text(result.amount_due_cents, lang),
                    )
                    .emphasised(),
                ],
            },
            DocumentSection::Table {
                title: Some(pick("Collectieve aangifte", "Totals")),
                columns: vec![
                    pick("Rubriek", "Item"),
                    pick("Code", "Element"),
                    pick("Bedrag", "Amount"),
                ],
                align_right: Some(vec![2]),
                rows,
                totals: Some(vec![
                    pick("Totaal generaal", "Total"),
                    "TotGen".into(),
                    euro_text(result.amount_due_cents, lang),
                ]),
            },
        ],
        footer: Some(vec![pick(
            "Bedragen in hele euro’s zoals aangegeven.",
            "Amounts in whole euros as filed.",
        )]),
        watermark: Some(has_error.then(|| pick("CONCEPT", "DRAFT"))),
    }
}
