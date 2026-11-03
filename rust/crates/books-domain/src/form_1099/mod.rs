//! Forms 1099-NEC and 1099-MISC (`@weldsuite/books-domain/jurisdictions/us/form-1099`
//! and `us-compliance/{form-1099-compute,form-1099-pdf-data,iris-csv,tin-matching}`,
//! and the Form 945 summary of `us-compliance/backup-withholding`): the boxes,
//! the thresholds by tax year, due dates, the state filing rules, the yearly
//! computation ([`compute`]), the IRIS upload files ([`iris`]), the layout data
//! of the recipient copies ([`pdf`]) and the IRS TIN Matching files
//! ([`tin_matching`]).

pub mod compute;
pub mod iris;
pub mod pdf;
pub mod tin_matching;

use serde_json::{Map, Value, json};

use crate::dates::{add_days, format_iso, parse_iso};
use crate::js::number_value;
use crate::tax_calendar::roll_to_business_day;

/// `Form1099BoxDef`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxDef {
    pub code: &'static str,
    /// `nec` or `misc`.
    pub form: &'static str,
    pub number: &'static str,
    pub label: &'static str,
    /// `amount`, `checkbox`, `state_amount` or `state_text`.
    pub kind: &'static str,
    /// `general`, `royalty`, `fixed_600`, `any_amount`; `None` = not compared.
    pub threshold_group: Option<&'static str>,
    /// `never`, `attorney` or `always`.
    pub corporation: &'static str,
}

const fn b(
    code: &'static str,
    form: &'static str,
    number: &'static str,
    label: &'static str,
    kind: &'static str,
    threshold_group: Option<&'static str>,
    corporation: &'static str,
) -> BoxDef {
    BoxDef {
        code,
        form,
        number,
        label,
        kind,
        threshold_group,
        corporation,
    }
}

const DIRECT_SALES: &str =
    "Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale";

/// `FORM_1099_BOXES`.
pub const BOXES: [BoxDef; 24] = [
    b(
        "nec_1",
        "nec",
        "1",
        "Nonemployee compensation",
        "amount",
        Some("general"),
        "attorney",
    ),
    b("nec_2", "nec", "2", DIRECT_SALES, "checkbox", None, "never"),
    b(
        "nec_3",
        "nec",
        "3",
        "Excess golden parachute payments",
        "amount",
        Some("any_amount"),
        "never",
    ),
    b(
        "nec_4",
        "nec",
        "4",
        "Federal income tax withheld",
        "amount",
        Some("any_amount"),
        "always",
    ),
    b(
        "nec_5",
        "nec",
        "5",
        "State tax withheld",
        "state_amount",
        None,
        "never",
    ),
    b(
        "nec_6",
        "nec",
        "6",
        "State/Payer's state no.",
        "state_text",
        None,
        "never",
    ),
    b(
        "nec_7",
        "nec",
        "7",
        "State income",
        "state_amount",
        None,
        "never",
    ),
    b(
        "misc_1",
        "misc",
        "1",
        "Rents",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_2",
        "misc",
        "2",
        "Royalties",
        "amount",
        Some("royalty"),
        "never",
    ),
    b(
        "misc_3",
        "misc",
        "3",
        "Other income",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_4",
        "misc",
        "4",
        "Federal income tax withheld",
        "amount",
        Some("any_amount"),
        "always",
    ),
    b(
        "misc_5",
        "misc",
        "5",
        "Fishing boat proceeds",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_6",
        "misc",
        "6",
        "Medical and health care payments",
        "amount",
        Some("general"),
        "always",
    ),
    b(
        "misc_7",
        "misc",
        "7",
        DIRECT_SALES,
        "checkbox",
        None,
        "never",
    ),
    b(
        "misc_8",
        "misc",
        "8",
        "Substitute payments in lieu of dividends or interest",
        "amount",
        Some("royalty"),
        "never",
    ),
    b(
        "misc_9",
        "misc",
        "9",
        "Crop insurance proceeds",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_10",
        "misc",
        "10",
        "Gross proceeds paid to an attorney",
        "amount",
        Some("fixed_600"),
        "always",
    ),
    b(
        "misc_11",
        "misc",
        "11",
        "Fish purchased for resale",
        "amount",
        Some("fixed_600"),
        "never",
    ),
    b(
        "misc_12",
        "misc",
        "12",
        "Section 409A deferrals",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_13",
        "misc",
        "13",
        "FATCA filing requirement",
        "checkbox",
        None,
        "never",
    ),
    b(
        "misc_14",
        "misc",
        "14",
        "Nonqualified deferred compensation",
        "amount",
        Some("general"),
        "never",
    ),
    b(
        "misc_15",
        "misc",
        "15",
        "State tax withheld",
        "state_amount",
        None,
        "never",
    ),
    b(
        "misc_16",
        "misc",
        "16",
        "State/Payer's state no.",
        "state_text",
        None,
        "never",
    ),
    b(
        "misc_17",
        "misc",
        "17",
        "State income",
        "state_amount",
        None,
        "never",
    ),
];

/// `FORM_1099_OMIT`: a stored box that leaves an amount out of reporting.
pub const OMIT: &str = "omit";

/// `form1099Box(code)`.
pub fn form_1099_box(code: &str) -> Option<&'static BoxDef> {
    BOXES.iter().find(|def| def.code == code)
}

/// `withholdingBoxFor(form)`.
pub fn withholding_box_for(form: &str) -> &'static str {
    if form == "nec" { "nec_4" } else { "misc_4" }
}

/// `isAllocatableBox(code)`: an amount box other than tax withheld.
pub fn is_allocatable_box(code: &str) -> bool {
    form_1099_box(code)
        .is_some_and(|def| def.kind == "amount" && def.code != "nec_4" && def.code != "misc_4")
}

/// `formOfBox(code)`.
pub fn form_of_box(code: &str) -> &'static str {
    if code.starts_with("nec_") {
        "nec"
    } else {
        "misc"
    }
}

/// `LAST_PUBLISHED_THRESHOLD_YEAR`.
pub const LAST_PUBLISHED_THRESHOLD_YEAR: i64 = 2026;

/// `Form1099ThresholdSet`.
#[derive(Debug, Clone, PartialEq)]
pub struct ThresholdSet {
    pub tax_year: i64,
    pub published: bool,
    /// `general`, `royalty`, `fixed_600`, `any_amount`.
    pub groups: [(&'static str, Option<f64>); 4],
    /// The amount per compared box (`None` = any positive amount).
    pub boxes: Vec<(&'static str, Option<f64>)>,
}

impl ThresholdSet {
    pub fn group(&self, name: &str) -> Option<f64> {
        self.groups
            .iter()
            .find(|(g, _)| *g == name)
            .and_then(|(_, v)| *v)
    }

    /// `thresholds.boxes[code]`: `None` when the box is not compared.
    pub fn box_threshold(&self, code: &str) -> Option<Option<f64>> {
        self.boxes.iter().find(|(c, _)| *c == code).map(|(_, v)| *v)
    }

    pub fn boxes_json(&self) -> Value {
        let mut out = Map::new();
        for (code, value) in &self.boxes {
            out.insert((*code).to_owned(), value.map_or(Value::Null, number_value));
        }
        Value::Object(out)
    }
}

/// `form1099Thresholds(taxYear)`: `None` before 2020 (TypeScript throws).
pub fn form_1099_thresholds(tax_year: i64) -> Option<ThresholdSet> {
    if tax_year < 2020 {
        return None;
    }
    let general = if tax_year >= 2026 { 2000.0 } else { 600.0 };
    let groups = [
        ("general", Some(general)),
        ("royalty", Some(10.0)),
        ("fixed_600", Some(600.0)),
        ("any_amount", None),
    ];
    let boxes = BOXES
        .iter()
        .filter_map(|def| {
            let group = def.threshold_group?;
            Some((
                def.code,
                groups
                    .iter()
                    .find(|(g, _)| *g == group)
                    .and_then(|(_, v)| *v),
            ))
        })
        .collect();
    Some(ThresholdSet {
        tax_year,
        published: tax_year <= LAST_PUBLISHED_THRESHOLD_YEAR,
        groups,
        boxes,
    })
}

#[allow(clippy::cast_possible_truncation)]
fn round_cents(value: f64) -> i64 {
    crate::js::math_round(value * 100.0) as i64
}

/// `meetsThreshold(amount, threshold)`, compared in cents.
pub fn meets_threshold(amount: f64, threshold: Option<f64>) -> bool {
    let cents = round_cents(amount);
    match threshold {
        None => cents > 0,
        Some(threshold) => cents >= round_cents(threshold),
    }
}

/// `form1099Deadlines(taxYear)`.
pub fn form_1099_deadlines(tax_year: i64) -> Value {
    let next = tax_year + 1;
    let jan31 = roll_to_business_day(&format_iso(next, 1, 31));
    json!({
        "taxYear": tax_year,
        "nec": { "recipient": jan31, "irs": jan31 },
        "misc": {
            "recipient": jan31,
            "recipientBoxes8And10": roll_to_business_day(&format_iso(next, 2, 15)),
            "irsPaper": roll_to_business_day(&format_iso(next, 2, 28)),
            "irsElectronic": roll_to_business_day(&format_iso(next, 3, 31)),
        },
        "form945": jan31,
    })
}

/// `FORM_1099_EFILE_THRESHOLD`.
pub const EFILE_THRESHOLD: i64 = 10;
/// `FORM_8508_LEAD_DAYS`.
pub const FORM_8508_LEAD_DAYS: i64 = 45;

/// `form8508Deadline(dueDate)`.
pub fn form_8508_deadline(due_date: &str) -> String {
    add_days(due_date, -FORM_8508_LEAD_DAYS).unwrap_or_default()
}

/// `FORM_1099K_PAYMENT_METHODS`.
pub const FORM_1099K_PAYMENT_METHODS: [&str; 3] =
    ["credit_card", "debit_card", "third_party_network"];

// ---------------------------------------------------------------------------
// State filing

/// `Form1099StateRule`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StateRule {
    pub state: &'static str,
    pub cfsf_code: Option<&'static str>,
    /// `none`, `state_withholding`, `state_source` or `unknown`.
    pub direct: &'static str,
    pub verified: bool,
    pub note: &'static str,
}

const CFSF_CODES: [(&str, &str); 32] = [
    ("AL", "01"),
    ("AZ", "04"),
    ("AR", "05"),
    ("CA", "06"),
    ("CO", "07"),
    ("CT", "08"),
    ("DE", "10"),
    ("DC", "11"),
    ("GA", "13"),
    ("HI", "15"),
    ("ID", "16"),
    ("IN", "18"),
    ("KS", "20"),
    ("LA", "22"),
    ("ME", "23"),
    ("MD", "24"),
    ("MA", "25"),
    ("MI", "26"),
    ("MN", "27"),
    ("MS", "28"),
    ("MT", "30"),
    ("NE", "31"),
    ("NJ", "34"),
    ("NM", "35"),
    ("NC", "37"),
    ("ND", "38"),
    ("OH", "39"),
    ("OK", "40"),
    ("PA", "42"),
    ("RI", "44"),
    ("SC", "45"),
    ("WI", "55"),
];

const NO_INCOME_TAX: [&str; 9] = ["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"];

const DIRECT_FILING: [(&str, &str, &str); 13] = [
    (
        "AL",
        "state_withholding",
        "Direct filing when Alabama tax was withheld.",
    ),
    (
        "DE",
        "state_source",
        "Division of Revenue wants the 1099-NEC in addition to the IRS copy for residents and for work done in Delaware.",
    ),
    (
        "GA",
        "state_withholding",
        "Direct filing when Georgia tax was withheld.",
    ),
    ("HI", "none", "One guide says CF/SF satisfies Hawaii."),
    (
        "KY",
        "state_withholding",
        "Not in CF/SF; direct filing only when Kentucky tax was withheld.",
    ),
    (
        "MD",
        "state_withholding",
        "Direct filing when Maryland tax was withheld.",
    ),
    (
        "MA",
        "state_source",
        "Department of Revenue wants direct filing despite CF/SF; one guide says NEC does not go through CF/SF.",
    ),
    (
        "MI",
        "state_source",
        "Residents or Michigan withholding; the MISC rule is broader than the NEC one.",
    ),
    (
        "MO",
        "state_source",
        "Removed from CF/SF; one guide says NEC is filed directly for Missouri-source payments of $1,200 or more.",
    ),
    (
        "NY",
        "unknown",
        "Guides disagree on whether New York needs a separate filing.",
    ),
    (
        "OR",
        "state_source",
        "One guide says all 1099s with Oregon withholding or an Oregon address go through iWire.",
    ),
    (
        "PA",
        "state_withholding",
        "myPATH filing plus REV-1667 when Pennsylvania tax was withheld. CF/SF status of PA is disputed.",
    ),
    (
        "WI",
        "state_withholding",
        "Separate file to the department of revenue when Wisconsin tax was withheld; some guides list broader triggers.",
    ),
];

const VENDOR_FLAGGED: [&str; 12] = [
    "AZ", "CT", "IN", "KS", "LA", "MN", "MS", "MT", "NC", "ND", "OH", "SC",
];

const ALL_STATES: [&str; 51] = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
    "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
    "WV", "WI", "WY",
];

/// `form1099StateRule(state)`.
pub fn form_1099_state_rule(state: &str) -> Option<StateRule> {
    let upper = state.to_uppercase();
    let state = *ALL_STATES.iter().find(|s| **s == upper)?;
    let cfsf_code = CFSF_CODES
        .iter()
        .find(|(s, _)| *s == state)
        .map(|(_, c)| *c);
    let rule = |direct, note| StateRule {
        state,
        cfsf_code,
        direct,
        verified: false,
        note,
    };
    if let Some((_, direct, note)) = DIRECT_FILING.iter().find(|(s, _, _)| *s == state) {
        return Some(rule(direct, note));
    }
    if NO_INCOME_TAX.contains(&state) {
        return Some(rule(
            "none",
            "No state income tax, so no state 1099 filing is expected.",
        ));
    }
    if VENDOR_FLAGGED.contains(&state) {
        return Some(rule(
            "unknown",
            "One vendor lists state-specific requirements that CF/SF does not satisfy; check the state.",
        ));
    }
    Some(rule(
        "unknown",
        "Not researched; check the state revenue department.",
    ))
}

/// `stateNeedsDirectFiling(state, { stateWithheld, stateSource })`.
pub fn state_needs_direct_filing(state: &str, state_withheld: bool, state_source: bool) -> bool {
    match form_1099_state_rule(state).map(|r| r.direct) {
        None | Some("none") => false,
        Some("state_withholding") => state_withheld,
        Some(_) => state_withheld || state_source,
    }
}

// ---------------------------------------------------------------------------
// Form 945

/// `Form945Payment`.
#[derive(Debug, Clone, PartialEq)]
pub struct Form945Payment {
    pub id: String,
    pub party_id: String,
    pub date: String,
    pub backup_withholding_amount: f64,
    pub voided: bool,
}

/// `form945Summary(taxYear, payments)`: backup withholding by month (with
/// the deposit due dates) and by vendor, in payment order.
#[allow(clippy::cast_precision_loss)]
pub fn form_945_summary(tax_year: i64, payments: &[Form945Payment]) -> Value {
    let mut month_cents = [0_i64; 12];
    let mut vendors: Vec<(String, i64, Vec<String>)> = Vec::new();
    let mut total = 0_i64;
    for payment in payments {
        let cents = round_cents(payment.backup_withholding_amount);
        if cents == 0 || payment.voided {
            continue;
        }
        let Some(date) = parse_iso(&payment.date) else {
            continue;
        };
        if date.y != tax_year {
            continue;
        }
        if let Some(slot) = usize::try_from(date.m - 1)
            .ok()
            .and_then(|m| month_cents.get_mut(m))
        {
            *slot += cents;
        }
        total += cents;
        if let Some(entry) = vendors
            .iter_mut()
            .find(|(id, _, _)| *id == payment.party_id)
        {
            entry.1 += cents;
            entry.2.push(payment.id.clone());
        } else {
            vendors.push((payment.party_id.clone(), cents, vec![payment.id.clone()]));
        }
    }
    let months: Vec<Value> = month_cents
        .iter()
        .enumerate()
        .map(|(index, cents)| {
            let index = i64::try_from(index).unwrap_or(0);
            let due = if index == 11 {
                format_iso(tax_year + 1, 1, 15)
            } else {
                format_iso(tax_year, index + 2, 15)
            };
            json!({
                "month": index + 1,
                "amount": number_value(*cents as f64 / 100.0),
                "depositDue": roll_to_business_day(&due),
            })
        })
        .collect();
    let deadlines = form_1099_deadlines(tax_year);
    json!({
        "taxYear": tax_year,
        "backupWithholding": number_value(total as f64 / 100.0),
        "totalTaxes": number_value(total as f64 / 100.0),
        "months": months,
        "byVendor": vendors.iter().map(|(id, cents, ids)| json!({
            "partyId": id,
            "amount": number_value(*cents as f64 / 100.0),
            "paymentIds": ids,
        })).collect::<Vec<_>>(),
        "dueDate": deadlines["form945"],
    })
}

/// `$1,234.50`: `toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` of dollars.
pub fn usd(value: f64) -> String {
    let fixed = crate::js::to_fixed(value, 2);
    let (negative, fixed) = fixed
        .strip_prefix('-')
        .map_or((false, fixed.as_str()), |rest| (true, rest));
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed, "00"));
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let sign = if negative && (whole != "0" || fraction != "00") {
        "-"
    } else {
        ""
    };
    format!("${sign}{grouped}.{fraction}")
}

/// [`usd`] without the dollar sign (`formatMoney` of the PDF data).
pub fn grouped_money(value: f64) -> String {
    usd(value).replacen('$', "", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_thresholds_and_deadlines() {
        assert!(is_allocatable_box("nec_1"));
        assert!(!is_allocatable_box("nec_4"));
        assert!(!is_allocatable_box("misc_7"));
        let t = form_1099_thresholds(2026).expect("year");
        assert_eq!(t.box_threshold("nec_1"), Some(Some(2000.0)));
        assert_eq!(t.box_threshold("nec_3"), Some(None));
        assert_eq!(t.box_threshold("nec_5"), None);
        assert!(form_1099_thresholds(2019).is_none());
        assert!(meets_threshold(600.0, Some(600.0)));
        assert!(!meets_threshold(599.99, Some(600.0)));
        assert_eq!(form_1099_deadlines(2026)["nec"]["irs"], "2027-02-01");
        assert_eq!(form_8508_deadline("2027-02-01"), "2026-12-18");
    }

    #[test]
    fn state_rules_and_money() {
        assert_eq!(
            form_1099_state_rule("ca").map(|r| r.cfsf_code),
            Some(Some("06"))
        );
        assert_eq!(form_1099_state_rule("TX").map(|r| r.direct), Some("none"));
        assert!(form_1099_state_rule("PR").is_none());
        assert!(state_needs_direct_filing("AL", true, false));
        assert!(!state_needs_direct_filing("AL", false, true));
        assert_eq!(usd(1234.5), "$1,234.50");
        assert_eq!(usd(0.0), "$0.00");
        assert_eq!(grouped_money(1_000_000.0), "1,000,000.00");
    }
}
