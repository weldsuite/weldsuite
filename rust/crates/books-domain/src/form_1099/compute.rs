//! The yearly 1099-NEC / 1099-MISC computation, cash basis
//! (`us-compliance/form-1099-compute`): what each vendor was paid in a
//! calendar year, by box, against the thresholds of that year. Card and
//! network payments, credit-card accounts and payroll are left out; a
//! payment is spread over the lines of the bills it paid (largest
//! remainder); a line's box is the line's, else the account's, else the
//! vendor's; corporations are left out except for legal and medical boxes
//! and tax withheld; backup withholding goes to box 4 of the form.

use serde_json::{Map, Value, json};

use super::{
    FORM_1099K_PAYMENT_METHODS, OMIT, ThresholdSet, form_1099_box, form_1099_thresholds,
    form_of_box, is_allocatable_box, meets_threshold, usd, withholding_box_for,
};
use crate::js::number_value;
use crate::vendor_tax::is_corporation_classification;

/// `Compute1099Vendor`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Vendor {
    pub party_id: String,
    pub name: Option<String>,
    pub is_1099_vendor: bool,
    pub default_form: Option<String>,
    pub default_box: Option<String>,
    pub tin_last4: Option<String>,
    pub federal_tax_classification: Option<String>,
    pub llc_tax_classification: Option<String>,
    pub is_attorney: bool,
    pub address_complete: bool,
    pub backup_withholding: bool,
}

/// `Compute1099BillLine`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BillLine {
    pub id: String,
    pub amount: f64,
    pub tax_amount: f64,
    pub account_id: Option<String>,
    pub form_1099_box: Option<String>,
}

/// `Compute1099Bill`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bill {
    pub id: String,
    pub lines: Vec<BillLine>,
}

/// `Compute1099Payment`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Payment {
    pub id: String,
    pub party_id: String,
    pub date: String,
    pub amount: f64,
    pub payment_method: Option<String>,
    pub from_credit_card_account: bool,
    pub paid_through_payroll: bool,
    pub voided: bool,
    pub backup_withholding_amount: f64,
    /// `(billId, amount)`.
    pub allocations: Vec<(String, f64)>,
}

/// `Compute1099BankTransaction`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BankTransaction {
    pub id: String,
    pub party_id: String,
    pub date: String,
    pub amount: f64,
    pub account_id: Option<String>,
    pub from_credit_card_account: bool,
    pub matched_payment_id: Option<String>,
}

/// `Compute1099Adjustment` (`by` and `at` are kept as they came).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Adjustment {
    pub party_id: String,
    pub box_code: String,
    pub amount: f64,
    pub reason: String,
    pub by: Option<String>,
}

/// `Compute1099Input`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Input {
    pub tax_year: i64,
    pub vendors: Vec<Vendor>,
    pub payments: Vec<Payment>,
    pub bills: Vec<Bill>,
    pub bank_transactions: Vec<BankTransaction>,
    /// `accounts.form1099Box` by account id.
    pub account_boxes: Vec<(String, String)>,
    pub adjustments: Vec<Adjustment>,
}

/// Where a contribution, exclusion or unmapped amount came from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Source {
    pub payment_id: Option<String>,
    pub bank_transaction_id: Option<String>,
    pub bill_id: Option<String>,
    pub bill_line_id: Option<String>,
}

/// `Form1099Contribution`.
#[derive(Debug, Clone, PartialEq)]
pub struct Contribution {
    pub box_code: &'static str,
    pub amount: f64,
    pub source: Source,
    /// `line`, `account`, `vendor`, `transaction`, `adjustment`, `withholding`.
    pub box_source: &'static str,
    pub unapplied: bool,
}

/// `Form1099Exclusion`.
#[derive(Debug, Clone, PartialEq)]
pub struct Exclusion {
    /// `card_or_network_method`, `credit_card_account`, `paid_through_payroll`, `omitted_box`.
    pub reason: &'static str,
    pub amount: f64,
    pub source: Source,
    pub payment_method: Option<String>,
}

/// `Form1099Unmapped`.
#[derive(Debug, Clone, PartialEq)]
pub struct Unmapped {
    pub amount: f64,
    pub source: Source,
    /// `no_box` or `invalid_box`.
    pub reason: &'static str,
}

/// `Form1099VendorResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct VendorResult {
    pub party_id: String,
    pub name: Option<String>,
    /// `included`, `below_threshold`, `excluded_corporation`, `needs_tin`,
    /// `needs_address`, `not_1099_vendor`.
    pub status: &'static str,
    pub reasons: Vec<String>,
    pub forms: Vec<&'static str>,
    /// Every box total, in cents, in the order the boxes first got money.
    pub totals: Vec<(&'static str, i64)>,
    /// The reportable boxes, in cents.
    pub boxes: Vec<(&'static str, i64)>,
    pub above_threshold: bool,
    pub is_corporation: bool,
    pub contributions: Vec<Contribution>,
    pub exclusions: Vec<Exclusion>,
    pub unmapped: Vec<Unmapped>,
    pub adjustments: Vec<Adjustment>,
    pub payment_ids: Vec<String>,
    pub bank_transaction_ids: Vec<String>,
}

#[allow(clippy::cast_precision_loss)]
fn dollars(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// `{ code: amount }` of box cents.
pub fn boxes_json(boxes: &[(&'static str, i64)]) -> Value {
    let mut out = Map::new();
    for (code, cents) in boxes {
        out.insert((*code).to_owned(), number_value(dollars(*cents)));
    }
    Value::Object(out)
}

impl VendorResult {
    /// A vendor with nothing in the year (`vendorDrillDown`'s stand-in).
    pub fn empty(party_id: &str, name: Option<String>, is_1099_vendor: bool) -> Self {
        Self {
            party_id: party_id.to_owned(),
            name,
            status: if is_1099_vendor {
                "below_threshold"
            } else {
                "not_1099_vendor"
            },
            reasons: vec!["No payments in the year.".to_owned()],
            forms: Vec::new(),
            totals: Vec::new(),
            boxes: Vec::new(),
            above_threshold: false,
            is_corporation: false,
            contributions: Vec::new(),
            exclusions: Vec::new(),
            unmapped: Vec::new(),
            adjustments: Vec::new(),
            payment_ids: Vec::new(),
            bank_transaction_ids: Vec::new(),
        }
    }
}

/// `Compute1099Result`.
#[derive(Debug, Clone, PartialEq)]
pub struct ComputeResult {
    pub tax_year: i64,
    pub thresholds: ThresholdSet,
    pub vendors: Vec<VendorResult>,
    pub warnings: Vec<String>,
    /// Status counts in TypeScript's key order.
    pub summary: [(&'static str, i64); 6],
}

impl ComputeResult {
    pub fn summary_json(&self) -> Value {
        let mut out = Map::new();
        for (status, count) in &self.summary {
            out.insert((*status).to_owned(), json!(count));
        }
        Value::Object(out)
    }
}

/// `toCents(amount)`: `Math.round(amount * 100)`.
#[allow(clippy::cast_possible_truncation)]
pub fn to_cents(amount: f64) -> i64 {
    crate::js::math_round(amount * 100.0) as i64
}

/// `splitProRata(totalCents, weights)`: whole cents pro rata, largest
/// remainder (ties to the earlier weight); `None` when the weights add up to
/// zero.
pub fn split_pro_rata(total_cents: i64, raw_weights: &[i64]) -> Option<Vec<i64>> {
    let raw_sum: i64 = raw_weights.iter().sum();
    if raw_weights.is_empty() || raw_sum == 0 {
        return None;
    }
    let flip: i128 = if raw_sum < 0 { -1 } else { 1 };
    let total = i128::from(total_cents);
    let denominator = i128::from(raw_sum) * flip;
    let mut floors = Vec::with_capacity(raw_weights.len());
    let mut remainders = Vec::with_capacity(raw_weights.len());
    for weight in raw_weights {
        let numerator = total * i128::from(*weight) * flip;
        let floor = numerator.div_euclid(denominator);
        floors.push(floor);
        remainders.push(numerator - floor * denominator);
    }
    let mut left = total - floors.iter().sum::<i128>();
    let mut order: Vec<usize> = (0..raw_weights.len()).collect();
    order.sort_by(|a, b| remainders[*b].cmp(&remainders[*a]).then(a.cmp(b)));
    let mut parts: Vec<i64> = floors
        .iter()
        .map(|f| i64::try_from(*f).unwrap_or(0))
        .collect();
    for index in order {
        if left <= 0 {
            break;
        }
        parts[index] += 1;
        left -= 1;
    }
    Some(parts)
}

/// A box code from a stored value: a full code, or a bare number with the
/// vendor's default form.
fn normalize_box(raw: Option<&str>, form: Option<&str>) -> Option<String> {
    let value = weldsuite_kit::validation::js_trim(raw.unwrap_or_default()).to_lowercase();
    if value.is_empty() {
        return None;
    }
    if value == OMIT {
        return Some(OMIT.to_owned());
    }
    if value.bytes().all(|b| b.is_ascii_digit())
        && let Some(form) = form.filter(|f| !f.is_empty())
    {
        return Some(format!("{form}_{value}"));
    }
    Some(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Resolution {
    Box(&'static str, &'static str),
    Omit,
    None,
    Invalid,
}

fn resolve_box(levels: &[(Option<&str>, &'static str)], default_form: Option<&str>) -> Resolution {
    for (raw, source) in levels {
        let Some(code) = normalize_box(*raw, default_form) else {
            continue;
        };
        if code == OMIT {
            return Resolution::Omit;
        }
        if !is_allocatable_box(&code) {
            return Resolution::Invalid;
        }
        return form_1099_box(&code)
            .map_or(Resolution::Invalid, |def| Resolution::Box(def.code, source));
    }
    Resolution::None
}

fn vendor_default_raw(vendor: &Vendor) -> Option<String> {
    let explicit =
        weldsuite_kit::validation::js_trim(vendor.default_box.as_deref().unwrap_or_default());
    if !explicit.is_empty() {
        return Some(explicit.to_owned());
    }
    (vendor.default_form.as_deref() == Some("nec")).then(|| "nec_1".to_owned())
}

struct Accumulator {
    vendor: Vendor,
    totals: Vec<(&'static str, i64)>,
    contributions: Vec<Contribution>,
    exclusions: Vec<Exclusion>,
    unmapped: Vec<Unmapped>,
    adjustments: Vec<Adjustment>,
    payment_ids: Vec<String>,
    bank_transaction_ids: Vec<String>,
}

impl Accumulator {
    fn add(&mut self, code: &'static str, cents: i64) {
        if let Some(entry) = self.totals.iter_mut().find(|(c, _)| *c == code) {
            entry.1 += cents;
        } else {
            self.totals.push((code, cents));
        }
    }

    fn total(&self, code: &str) -> i64 {
        self.totals
            .iter()
            .find(|(c, _)| *c == code)
            .map_or(0, |(_, v)| *v)
    }
}

fn push_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|x| x == id) {
        list.push(id.to_owned());
    }
}

struct Part {
    cents: i64,
    bill_id: Option<String>,
    bill_line_id: Option<String>,
    unapplied: bool,
    resolution: Resolution,
}

fn exclusion_for(
    payment_method: Option<&str>,
    from_credit_card: bool,
    payroll: bool,
) -> Option<(&'static str, Option<String>)> {
    let method =
        weldsuite_kit::validation::js_trim(payment_method.unwrap_or_default()).to_lowercase();
    if !method.is_empty() && FORM_1099K_PAYMENT_METHODS.contains(&method.as_str()) {
        return Some(("card_or_network_method", Some(method)));
    }
    if from_credit_card {
        return Some(("credit_card_account", None));
    }
    if payroll {
        return Some(("paid_through_payroll", None));
    }
    None
}

/// `compute1099Totals(input)`; `None` for a tax year before 2020.
#[allow(clippy::too_many_lines)] // payments, bank lines, adjustments, as TypeScript
pub fn compute_1099_totals(input: &Input) -> Option<ComputeResult> {
    let thresholds = form_1099_thresholds(input.tax_year)?;
    let mut warnings = Vec::new();
    let mut accumulators: Vec<Accumulator> = Vec::new();
    let vendor_of = |id: &str| input.vendors.iter().find(|v| v.party_id == id);
    let in_year = |date: &str| date.starts_with(&format!("{}-", input.tax_year));
    let account_box = |id: Option<&str>| {
        id.and_then(|id| input.account_boxes.iter().find(|(a, _)| a == id))
            .map(|(_, b)| b.as_str())
    };
    let line_resolution = |vendor: &Vendor, line_box: Option<&str>, account_id: Option<&str>| {
        let default = vendor_default_raw(vendor);
        resolve_box(
            &[
                (line_box, "line"),
                (account_box(account_id), "account"),
                (default.as_deref(), "vendor"),
            ],
            vendor.default_form.as_deref(),
        )
    };
    fn acc_index(accumulators: &mut Vec<Accumulator>, vendor: &Vendor) -> usize {
        if let Some(index) = accumulators
            .iter()
            .position(|a| a.vendor.party_id == vendor.party_id)
        {
            return index;
        }
        accumulators.push(Accumulator {
            vendor: vendor.clone(),
            totals: Vec::new(),
            contributions: Vec::new(),
            exclusions: Vec::new(),
            unmapped: Vec::new(),
            adjustments: Vec::new(),
            payment_ids: Vec::new(),
            bank_transaction_ids: Vec::new(),
        });
        accumulators.len() - 1
    }

    for payment in &input.payments {
        if !in_year(&payment.date) || payment.voided {
            continue;
        }
        let Some(vendor) = vendor_of(&payment.party_id) else {
            warnings.push(format!(
                "Payment {} is to a party that is not in the vendor list.",
                payment.id
            ));
            continue;
        };
        let index = acc_index(&mut accumulators, vendor);
        let gross = to_cents(payment.amount);
        if let Some((reason, method)) = exclusion_for(
            payment.payment_method.as_deref(),
            payment.from_credit_card_account,
            payment.paid_through_payroll,
        ) {
            accumulators[index].exclusions.push(Exclusion {
                reason,
                amount: dollars(gross),
                source: Source {
                    payment_id: Some(payment.id.clone()),
                    ..Source::default()
                },
                payment_method: method,
            });
            continue;
        }

        let mut parts: Vec<Part> = Vec::new();
        let mut allocated = 0;
        for (bill_id, amount) in &payment.allocations {
            let cents = to_cents(*amount);
            allocated += cents;
            let bill = input.bills.iter().find(|b| b.id == *bill_id);
            let Some(bill) = bill.filter(|b| !b.lines.is_empty()) else {
                warnings.push(format!(
                    "Payment {} pays bill {bill_id}, which has no lines; the amount uses the vendor default box.",
                    payment.id
                ));
                parts.push(Part {
                    cents,
                    bill_id: Some(bill_id.clone()),
                    bill_line_id: None,
                    unapplied: true,
                    resolution: line_resolution(vendor, None, None),
                });
                continue;
            };
            let weights: Vec<i64> = bill
                .lines
                .iter()
                .map(|line| to_cents(line.amount) + to_cents(line.tax_amount))
                .collect();
            let Some(shares) = split_pro_rata(cents, &weights) else {
                warnings.push(format!(
                    "Bill {} lines add up to zero; payment {} uses the vendor default box.",
                    bill.id, payment.id
                ));
                parts.push(Part {
                    cents,
                    bill_id: Some(bill.id.clone()),
                    bill_line_id: None,
                    unapplied: true,
                    resolution: line_resolution(vendor, None, None),
                });
                continue;
            };
            for (line, share) in bill.lines.iter().zip(shares) {
                if share == 0 {
                    continue;
                }
                parts.push(Part {
                    cents: share,
                    bill_id: Some(bill.id.clone()),
                    bill_line_id: Some(line.id.clone()),
                    unapplied: false,
                    resolution: line_resolution(
                        vendor,
                        line.form_1099_box.as_deref(),
                        line.account_id.as_deref(),
                    ),
                });
            }
        }
        let rest = gross - allocated;
        if rest != 0 && (allocated == 0 || rest > 0) {
            parts.push(Part {
                cents: rest,
                bill_id: None,
                bill_line_id: None,
                unapplied: true,
                resolution: line_resolution(vendor, None, None),
            });
        }

        let withheld = to_cents(payment.backup_withholding_amount);
        let positive: Vec<i64> = parts.iter().map(|p| p.cents.max(0)).collect();
        let withholding_shares = if withheld > 0 {
            if positive.iter().any(|w| *w > 0) {
                split_pro_rata(withheld, &positive)
            } else {
                split_pro_rata(withheld, &vec![1; parts.len()])
            }
        } else {
            None
        };

        for (i, part) in parts.into_iter().enumerate() {
            let source = Source {
                payment_id: Some(payment.id.clone()),
                bank_transaction_id: None,
                bill_id: part.bill_id.clone(),
                bill_line_id: part.bill_line_id.clone(),
            };
            let share = withholding_shares
                .as_ref()
                .and_then(|s| s.get(i).copied())
                .unwrap_or(0);
            let acc = &mut accumulators[index];
            match part.resolution {
                Resolution::Omit => {
                    acc.exclusions.push(Exclusion {
                        reason: "omitted_box",
                        amount: dollars(part.cents),
                        source,
                        payment_method: None,
                    });
                    if share > 0 {
                        warnings.push(format!(
                            "Backup withholding of {} on payment {} was on an amount left out of 1099 reporting.",
                            usd(dollars(share)),
                            payment.id
                        ));
                    }
                }
                Resolution::None | Resolution::Invalid => {
                    acc.unmapped.push(Unmapped {
                        amount: dollars(part.cents),
                        source,
                        reason: if part.resolution == Resolution::Invalid {
                            "invalid_box"
                        } else {
                            "no_box"
                        },
                    });
                    if share > 0 {
                        warnings.push(format!(
                            "Backup withholding of {} on payment {} could not be assigned to a form.",
                            usd(dollars(share)),
                            payment.id
                        ));
                    }
                }
                Resolution::Box(code, box_source) => {
                    push_unique(&mut acc.payment_ids, &payment.id);
                    acc.add(code, part.cents);
                    acc.contributions.push(Contribution {
                        box_code: code,
                        amount: dollars(part.cents),
                        source: source.clone(),
                        box_source,
                        unapplied: part.unapplied,
                    });
                    if share > 0 {
                        let withholding = withholding_box_for(form_of_box(code));
                        acc.add(withholding, share);
                        acc.contributions.push(Contribution {
                            box_code: withholding,
                            amount: dollars(share),
                            source,
                            box_source: "withholding",
                            unapplied: false,
                        });
                    }
                }
            }
        }
    }

    for txn in &input.bank_transactions {
        if !in_year(&txn.date) || txn.matched_payment_id.is_some() {
            continue;
        }
        let Some(vendor) = vendor_of(&txn.party_id) else {
            warnings.push(format!(
                "Bank transaction {} is categorized to a party that is not in the vendor list.",
                txn.id
            ));
            continue;
        };
        let index = acc_index(&mut accumulators, vendor);
        let cents = to_cents(txn.amount);
        let source = Source {
            bank_transaction_id: Some(txn.id.clone()),
            ..Source::default()
        };
        if let Some((reason, method)) = exclusion_for(None, txn.from_credit_card_account, false) {
            accumulators[index].exclusions.push(Exclusion {
                reason,
                amount: dollars(cents),
                source,
                payment_method: method,
            });
            continue;
        }
        let resolution = line_resolution(vendor, None, txn.account_id.as_deref());
        let acc = &mut accumulators[index];
        match resolution {
            Resolution::Omit => acc.exclusions.push(Exclusion {
                reason: "omitted_box",
                amount: dollars(cents),
                source,
                payment_method: None,
            }),
            Resolution::None | Resolution::Invalid => acc.unmapped.push(Unmapped {
                amount: dollars(cents),
                source,
                reason: if resolution == Resolution::Invalid {
                    "invalid_box"
                } else {
                    "no_box"
                },
            }),
            Resolution::Box(code, box_source) => {
                push_unique(&mut acc.bank_transaction_ids, &txn.id);
                acc.add(code, cents);
                acc.contributions.push(Contribution {
                    box_code: code,
                    amount: dollars(cents),
                    source,
                    box_source: if box_source == "line" {
                        "transaction"
                    } else {
                        box_source
                    },
                    unapplied: false,
                });
            }
        }
    }

    for adjustment in &input.adjustments {
        let vendor = vendor_of(&adjustment.party_id);
        let def = form_1099_box(&adjustment.box_code);
        let Some(vendor) = vendor else {
            warnings.push(format!(
                "Adjustment for {} ignored: the party is not in the vendor list.",
                adjustment.party_id
            ));
            continue;
        };
        let Some(def) = def.filter(|d| d.kind == "amount") else {
            warnings.push(format!(
                "Adjustment for {} ignored: {} is not an amount box.",
                adjustment.party_id, adjustment.box_code
            ));
            continue;
        };
        if weldsuite_kit::validation::js_trim(&adjustment.reason).is_empty() {
            warnings.push(format!(
                "Adjustment for {} ignored: a reason is required.",
                adjustment.party_id
            ));
            continue;
        }
        let index = acc_index(&mut accumulators, vendor);
        let cents = to_cents(adjustment.amount);
        let acc = &mut accumulators[index];
        acc.add(def.code, cents);
        acc.adjustments.push(adjustment.clone());
        acc.contributions.push(Contribution {
            box_code: def.code,
            amount: dollars(cents),
            source: Source::default(),
            box_source: "adjustment",
            unapplied: false,
        });
    }

    let mut seen: Vec<&str> = Vec::new();
    let mut results = Vec::new();
    for vendor in &input.vendors {
        if seen.contains(&vendor.party_id.as_str()) {
            continue;
        }
        seen.push(&vendor.party_id);
        if let Some(position) = accumulators
            .iter()
            .position(|a| a.vendor.party_id == vendor.party_id)
        {
            results.push(finish(&accumulators[position], &thresholds));
        }
    }
    let mut summary = [
        ("included", 0),
        ("below_threshold", 0),
        ("excluded_corporation", 0),
        ("needs_tin", 0),
        ("needs_address", 0),
        ("not_1099_vendor", 0),
    ];
    for result in &results {
        if let Some(entry) = summary.iter_mut().find(|(s, _)| *s == result.status) {
            entry.1 += 1;
        }
    }
    Some(ComputeResult {
        tax_year: input.tax_year,
        thresholds,
        vendors: results,
        warnings,
        summary,
    })
}

#[allow(clippy::too_many_lines)] // the status rules, as TypeScript
fn finish(acc: &Accumulator, thresholds: &ThresholdSet) -> VendorResult {
    let vendor = &acc.vendor;
    let is_corporation = is_corporation_classification(
        vendor.federal_tax_classification.as_deref(),
        vendor.llc_tax_classification.as_deref(),
    );
    let mut reasons = Vec::new();
    let withheld_forms: Vec<&str> = ["nec", "misc"]
        .into_iter()
        .filter(|form| acc.total(withholding_box_for(form)) > 0)
        .collect();

    let mut reportable: Vec<(&'static str, i64)> = Vec::new();
    let mut any_above = false;
    let mut any_met = false;
    let mut below_notes = Vec::new();
    let mut corp_notes = Vec::new();
    for (code, cents) in &acc.totals {
        let Some(def) = form_1099_box(code).filter(|d| d.kind == "amount") else {
            continue;
        };
        if *cents <= 0 {
            continue;
        }
        let threshold = thresholds.box_threshold(code);
        let meets = meets_threshold(dollars(*cents), threshold.flatten());
        if meets {
            any_above = true;
        }
        let waived = !meets
            && withheld_forms.contains(&def.form)
            && def.code != withholding_box_for(def.form);
        if !meets && !waived {
            if let Some(Some(threshold)) = threshold {
                below_notes.push(format!(
                    "{} box {} total {} is below the {} threshold for {}.",
                    def.form.to_uppercase(),
                    def.number,
                    usd(dollars(*cents)),
                    usd(dollars(to_cents(threshold))),
                    thresholds.tax_year
                ));
            }
            continue;
        }
        any_met = true;
        let corporation_ok = !is_corporation
            || def.corporation == "always"
            || (def.corporation == "attorney" && vendor.is_attorney);
        if !corporation_ok {
            corp_notes.push(format!(
                "{} box {} is paid to a corporation and is not reportable.",
                def.form.to_uppercase(),
                def.number
            ));
            continue;
        }
        reportable.push((def.code, *cents));
    }
    let forms: Vec<&'static str> = ["nec", "misc"]
        .into_iter()
        .filter(|form| {
            reportable
                .iter()
                .any(|(code, _)| form_of_box(code) == *form)
        })
        .collect();

    let status = if !vendor.is_1099_vendor {
        reasons.push("The vendor is not marked as a 1099 vendor.".to_owned());
        if any_above {
            reasons.push("Payments reach the reporting threshold; mark the vendor as a 1099 vendor if a form is needed.".to_owned());
        }
        "not_1099_vendor"
    } else if !any_met {
        if below_notes.is_empty() {
            reasons.push("No payments to report in the year.".to_owned());
        } else {
            reasons.extend(below_notes);
        }
        "below_threshold"
    } else if reportable.is_empty() {
        reasons.extend(corp_notes);
        "excluded_corporation"
    } else {
        reasons.extend(corp_notes);
        let has_tin = vendor
            .tin_last4
            .as_deref()
            .is_some_and(|t| t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit()));
        if !has_tin {
            reasons.push("No TIN on file; collect a W-9.".to_owned());
            if !vendor.address_complete {
                reasons.push("The address is incomplete.".to_owned());
            }
            "needs_tin"
        } else if !vendor.address_complete {
            reasons.push("The address is incomplete.".to_owned());
            "needs_address"
        } else {
            "included"
        }
    };

    if !acc.unmapped.is_empty() {
        let total: i64 = acc.unmapped.iter().map(|u| to_cents(u.amount)).sum();
        reasons.push(format!(
            "{} paid to this vendor has no 1099 box; set a default box on the vendor, the account or the bill line.",
            usd(dollars(total))
        ));
    }
    if vendor.backup_withholding && withheld_forms.is_empty() && !acc.contributions.is_empty() {
        reasons.push(
            "The vendor is subject to backup withholding but no tax was withheld on its payments."
                .to_owned(),
        );
    }
    let card_total: i64 = acc
        .exclusions
        .iter()
        .filter(|e| e.reason == "card_or_network_method" || e.reason == "credit_card_account")
        .map(|e| to_cents(e.amount))
        .sum();
    if card_total > 0 {
        reasons.push(format!(
            "{} paid by card or third-party network is reported by the processor on Form 1099-K.",
            usd(dollars(card_total))
        ));
    }
    let show_boxes = matches!(status, "included" | "needs_tin" | "needs_address");
    VendorResult {
        party_id: vendor.party_id.clone(),
        name: vendor.name.clone(),
        status,
        reasons,
        forms: if show_boxes { forms } else { Vec::new() },
        totals: acc.totals.clone(),
        boxes: if show_boxes { reportable } else { Vec::new() },
        above_threshold: any_above,
        is_corporation,
        contributions: acc.contributions.clone(),
        exclusions: acc.exclusions.clone(),
        unmapped: acc.unmapped.clone(),
        adjustments: acc.adjustments.clone(),
        payment_ids: acc.payment_ids.clone(),
        bank_transaction_ids: acc.bank_transaction_ids.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vendor(id: &str) -> Vendor {
        Vendor {
            party_id: id.to_owned(),
            is_1099_vendor: true,
            default_form: Some("nec".to_owned()),
            tin_last4: Some("6789".to_owned()),
            address_complete: true,
            ..Vendor::default()
        }
    }

    #[test]
    fn split_and_compute() {
        assert_eq!(split_pro_rata(100, &[1, 1, 1]), Some(vec![34, 33, 33]));
        assert_eq!(split_pro_rata(100, &[0, 0]), None);
        assert_eq!(split_pro_rata(10, &[-1, 3]), Some(vec![-5, 15]));
        let input = Input {
            tax_year: 2025,
            vendors: vec![vendor("a"), vendor("b")],
            payments: vec![
                Payment {
                    id: "p1".into(),
                    party_id: "a".into(),
                    date: "2025-03-01".into(),
                    amount: 700.0,
                    ..Payment::default()
                },
                Payment {
                    id: "p2".into(),
                    party_id: "b".into(),
                    date: "2025-03-01".into(),
                    amount: 100.0,
                    ..Payment::default()
                },
                Payment {
                    id: "p3".into(),
                    party_id: "b".into(),
                    date: "2025-03-01".into(),
                    amount: 50.0,
                    payment_method: Some("credit_card".into()),
                    ..Payment::default()
                },
            ],
            ..Input::default()
        };
        let result = compute_1099_totals(&input).expect("year");
        assert_eq!(result.vendors[0].status, "included");
        assert_eq!(result.vendors[0].boxes, vec![("nec_1", 70_000)]);
        assert_eq!(result.vendors[1].status, "below_threshold");
        assert!(
            result.vendors[1]
                .reasons
                .iter()
                .any(|r| r.contains("Form 1099-K"))
        );
    }
}
