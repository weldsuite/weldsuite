//! What the state modules share (`us/states/common.ts`, `types.ts`).

use serde_json::{Value, json};

use crate::js::number_of;
use crate::money::{Cents, js_max, js_min, percent_of, round_half_away_from_zero, to_cents};
use crate::ordered::OrderedMap;
use crate::types::{PayrollIssue, UsStateCertificateInput, UsW4Input, Ytd};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pretax {
    pub retirement401k_cents: Cents,
    pub section125_cents: Cents,
    pub hsa_cents: Cents,
    pub dependent_care_cents: Cents,
}

/// `StateCalcInput`.
#[derive(Debug, Clone)]
pub struct StateCalcInput<'a> {
    pub state: String,
    pub tax_year: i64,
    pub pay_date: &'a str,
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub periods_per_year: f64,
    pub regular_wages_cents: Cents,
    pub supplemental_wages_cents: Cents,
    pub pretax: Pretax,
    pub certificate: Option<&'a UsStateCertificateInput>,
    pub federal_w4: Option<&'a UsW4Input>,
    pub sui_rate_percent: Option<f64>,
    pub extra_rates: Option<&'a OrderedMap<f64>>,
    pub employee_count_estimate: Option<f64>,
    pub ytd: &'a Ytd,
    pub residence_state: Option<&'a str>,
    pub exempt_from_sui: bool,
    pub fica_employee_cents: Option<Cents>,
}

impl StateCalcInput<'_> {
    /// `input.extraRates[key]` (undefined when not set).
    pub fn extra_rate(&self, key: &str) -> Option<f64> {
        self.extra_rates.and_then(|rates| rates.get(key).copied())
    }

    /// `input.certificate?.exempt` is truthy.
    pub fn certificate_exempt(&self) -> bool {
        self.certificate.is_some_and(|c| c.exempt)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StateProgramResult {
    pub code: String,
    pub label_key: String,
    pub wages_cents: Cents,
    pub employee_cents: Cents,
    pub employer_cents: Cents,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SuiResult {
    pub taxable_wages_cents: Cents,
    pub gross_wages_cents: Cents,
    pub employer_cents: Cents,
    pub employee_cents: Cents,
}

/// `StateCalcResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct StateCalcResult {
    pub state_wages_cents: Cents,
    pub income_tax_cents: Cents,
    pub sui: SuiResult,
    pub programs: Vec<StateProgramResult>,
    pub ytd_updates: OrderedMap<f64>,
    pub issues: Vec<PayrollIssue>,
    pub rule_set: String,
}

/// `ytdKey(state, name)`.
pub fn ytd_key(state: &str, name: &str) -> String {
    format!("us.state.{state}.{name}")
}

/// `readYtd(input, state, name)`.
pub fn read_ytd(input: &StateCalcInput<'_>, state: &str, name: &str) -> Cents {
    input.ytd.get(&ytd_key(state, name)).copied().unwrap_or(0.0)
}

/// `YtdWriter`.
pub struct YtdWriter<'a> {
    pub updates: OrderedMap<f64>,
    ytd: &'a Ytd,
    state: String,
}

impl<'a> YtdWriter<'a> {
    pub fn new(input: &StateCalcInput<'a>, state: &str) -> Self {
        Self {
            updates: OrderedMap::new(),
            ytd: input.ytd,
            state: state.to_owned(),
        }
    }

    pub fn add(&mut self, name: &str, cents: Cents) {
        let key = ytd_key(&self.state, name);
        let base = match self.updates.get(&key) {
            Some(v) => *v,
            None => self.ytd.get(&key).copied().unwrap_or(0.0),
        };
        self.updates.insert(key, base + cents);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PretaxExclusions {
    pub retirement401k: bool,
    pub section125: bool,
    pub hsa: bool,
    pub dependent_care: bool,
}

pub const FICA_LIKE: PretaxExclusions = PretaxExclusions {
    retirement401k: false,
    section125: true,
    hsa: true,
    dependent_care: true,
};
pub const NO_EXCLUSIONS: PretaxExclusions = PretaxExclusions {
    retirement401k: false,
    section125: false,
    hsa: false,
    dependent_care: false,
};
pub const FEDERAL_INCOME_TAX_LIKE: PretaxExclusions = PretaxExclusions {
    retirement401k: true,
    section125: true,
    hsa: true,
    dependent_care: true,
};

/// `grossWages(input)`.
pub fn gross_wages(input: &StateCalcInput<'_>) -> Cents {
    input.regular_wages_cents + input.supplemental_wages_cents
}

/// `excludedPretax(input, exclusions)`.
pub fn excluded_pretax(input: &StateCalcInput<'_>, e: PretaxExclusions) -> Cents {
    let p = input.pretax;
    (if e.retirement401k {
        p.retirement401k_cents
    } else {
        0.0
    }) + (if e.section125 {
        p.section125_cents
    } else {
        0.0
    }) + (if e.hsa { p.hsa_cents } else { 0.0 })
        + (if e.dependent_care {
            p.dependent_care_cents
        } else {
            0.0
        })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Wages {
    pub regular: Cents,
    pub supplemental: Cents,
    pub total: Cents,
}

/// `taxableWages(input, exclusions)`.
pub fn taxable_wages(input: &StateCalcInput<'_>, e: PretaxExclusions) -> Wages {
    let excluded = excluded_pretax(input, e);
    let regular = js_max(0.0, input.regular_wages_cents - excluded);
    let overflow = js_max(0.0, excluded - input.regular_wages_cents);
    let supplemental = js_max(0.0, input.supplemental_wages_cents - overflow);
    Wages {
        regular,
        supplemental,
        total: regular + supplemental,
    }
}

/// `underBase(wages, ytdTaxed, base)`.
pub fn under_base(wages: Cents, ytd_taxed: Cents, base: Option<Cents>) -> Cents {
    if wages <= 0.0 {
        return 0.0;
    }
    match base {
        None => wages,
        Some(base) => js_max(0.0, js_min(wages, base - ytd_taxed)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodType {
    Weekly,
    Biweekly,
    Semimonthly,
    Monthly,
    Quarterly,
    Semiannual,
    Annual,
}

impl PeriodType {
    /// The index into the per-period tables, in `PeriodType`'s order.
    pub fn index(self) -> usize {
        self as usize
    }
}

/// `periodTypeOf(periodsPerYear)`.
pub fn period_type_of(periods_per_year: f64) -> Option<PeriodType> {
    Some(match periods_per_year {
        52.0 | 53.0 => PeriodType::Weekly,
        26.0 | 27.0 => PeriodType::Biweekly,
        24.0 => PeriodType::Semimonthly,
        12.0 => PeriodType::Monthly,
        4.0 => PeriodType::Quarterly,
        2.0 => PeriodType::Semiannual,
        1.0 => PeriodType::Annual,
        _ => return None,
    })
}

/// `nominalPeriods(periodsPerYear)`.
pub fn nominal_periods(periods_per_year: f64) -> f64 {
    crate::us::withholding::nominal_periods_per_year(periods_per_year)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScheduleRow {
    pub over: Cents,
    pub base_cents: f64,
    pub rate_percent: f64,
}

/// `scheduleTax(amount, rows, boundary)`; `at_least` is `'atLeast'`.
pub fn schedule_tax(amount: Cents, rows: &[ScheduleRow], at_least: bool) -> f64 {
    if amount <= 0.0 {
        return 0.0;
    }
    let mut row = None;
    for r in rows {
        let hit = if at_least {
            amount >= r.over
        } else {
            amount > r.over
        };
        if hit {
            row = Some(r);
        } else {
            break;
        }
    }
    row.map_or(0.0, |r| {
        r.base_cents + ((amount - r.over) * r.rate_percent) / 100.0
    })
}

/// `d(dollars)`.
pub fn d(dollars: f64) -> Cents {
    to_cents(dollars)
}

/// `roundCents(n)`.
pub fn round_cents(n: f64) -> Cents {
    round_half_away_from_zero(n)
}

/// `roundToDollar(cents)`.
pub fn round_to_dollar(cents: f64) -> Cents {
    round_half_away_from_zero(cents / 100.0) * 100.0
}

fn cert_value<'a>(input: &'a StateCalcInput<'_>, key: &str) -> Option<&'a Value> {
    input.certificate.and_then(|c| c.values.get(key))
}

/// `certNumber(input, key)`.
pub fn cert_number(input: &StateCalcInput<'_>, key: &str) -> f64 {
    match cert_value(input, key) {
        Some(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()).unwrap_or(0.0),
        Some(Value::String(s)) if !crate::js::js_trim(s).is_empty() => {
            let n = number_of(s);
            if n.is_finite() { n } else { 0.0 }
        }
        _ => 0.0,
    }
}

/// `certBoolean(input, key)`.
pub fn cert_boolean(input: &StateCalcInput<'_>, key: &str) -> bool {
    match cert_value(input, key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        _ => false,
    }
}

/// `certString(input, key)`.
pub fn cert_string<'a>(input: &'a StateCalcInput<'_>, key: &str) -> Option<&'a str> {
    match cert_value(input, key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// `certAllowances(input)`.
pub fn cert_allowances(input: &StateCalcInput<'_>) -> f64 {
    let a = input.certificate.and_then(|c| c.allowances).unwrap_or(0.0);
    if a.is_finite() {
        js_max(0.0, a.trunc())
    } else {
        0.0
    }
}

/// `certExtraCents(input)`.
pub fn cert_extra_cents(input: &StateCalcInput<'_>) -> Cents {
    let extra = input
        .certificate
        .and_then(|c| c.extra_withholding)
        .unwrap_or(0.0);
    if extra > 0.0 { to_cents(extra) } else { 0.0 }
}

pub struct SuiSurcharge {
    pub code: &'static str,
    pub label_key: &'static str,
    pub rate_key: &'static str,
    pub default_rate_percent: f64,
}

pub struct SuiEmployee {
    pub rate_percent: f64,
    pub wage_base_cents: Option<Cents>,
}

pub struct SuiRules {
    pub wage_base_cents: Cents,
    pub new_employer_rate_percent: Option<f64>,
    pub exclusions: PretaxExclusions,
    pub employee: Option<SuiEmployee>,
    pub surcharges: Vec<SuiSurcharge>,
}

pub struct SuiOutcome {
    pub sui: SuiResult,
    pub programs: Vec<StateProgramResult>,
    pub issues: Vec<PayrollIssue>,
}

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

/// `computeSui(input, state, rules, ytd)`.
pub fn compute_sui(
    input: &StateCalcInput<'_>,
    state: &str,
    rules: &SuiRules,
    ytd: &mut YtdWriter<'_>,
) -> SuiOutcome {
    let mut issues = vec![];
    if input.exempt_from_sui {
        return SuiOutcome {
            sui: SuiResult::default(),
            programs: vec![],
            issues,
        };
    }
    let gross = taxable_wages(input, rules.exclusions).total;
    let taxable = under_base(
        gross,
        read_ytd(input, state, "sui_wages"),
        Some(rules.wage_base_cents),
    );
    let rate = match input.sui_rate_percent.filter(|r| r.is_finite()) {
        Some(rate) => rate,
        None => match rules.new_employer_rate_percent {
            None => {
                issues.push(
                    PayrollIssue::error("employer_incomplete")
                        .with(&[("state", json!(state)), ("field", json!("suiRate"))]),
                );
                0.0
            }
            Some(rate) => {
                issues.push(PayrollIssue::warning("employer_incomplete").with(&[
                    ("state", json!(state)),
                    ("field", json!("suiRate")),
                    ("fallbackRatePercent", n(rate)),
                ]));
                rate
            }
        },
    };
    let employer_cents = percent_of(taxable, rate);
    let mut employee_cents = 0.0;
    if let Some(employee) = &rules.employee {
        let same_base = employee.wage_base_cents == Some(rules.wage_base_cents);
        let employee_taxable = if same_base {
            taxable
        } else {
            under_base(
                gross,
                read_ytd(input, state, "sui_employee_wages"),
                employee.wage_base_cents,
            )
        };
        employee_cents = percent_of(employee_taxable, employee.rate_percent);
        if !same_base {
            ytd.add("sui_employee_wages", employee_taxable);
        }
    }
    let programs = rules
        .surcharges
        .iter()
        .map(|s| {
            let r = input
                .extra_rate(s.rate_key)
                .unwrap_or(s.default_rate_percent);
            StateProgramResult {
                code: s.code.to_owned(),
                label_key: s.label_key.to_owned(),
                wages_cents: taxable,
                employee_cents: 0.0,
                employer_cents: percent_of(taxable, r),
            }
        })
        .collect();
    ytd.add("sui_wages", taxable);
    ytd.add("sui_gross_wages", gross);
    SuiOutcome {
        sui: SuiResult {
            taxable_wages_cents: taxable,
            gross_wages_cents: gross,
            employer_cents,
            employee_cents,
        },
        programs,
        issues,
    }
}

pub struct ProgramSpec {
    pub code: &'static str,
    pub label_key: &'static str,
    pub wages_cents: Cents,
    pub wage_base_cents: Option<Cents>,
    pub employee_rate_percent: f64,
    pub employer_rate_percent: f64,
    pub employee_annual_max_cents: Option<Cents>,
    pub employee_period_max_cents: Option<Cents>,
}

/// `computeProgram(input, state, spec, ytd)`.
pub fn compute_program(
    input: &StateCalcInput<'_>,
    state: &str,
    spec: &ProgramSpec,
    ytd: &mut YtdWriter<'_>,
) -> StateProgramResult {
    let wages = under_base(
        spec.wages_cents,
        read_ytd(input, state, &format!("{}_wages", spec.code)),
        spec.wage_base_cents,
    );
    let mut employee = percent_of(wages, spec.employee_rate_percent);
    if let Some(max) = spec.employee_period_max_cents {
        employee = js_min(employee, max);
    }
    if let Some(max) = spec.employee_annual_max_cents {
        let before = read_ytd(input, state, &format!("{}_employee", spec.code));
        employee = js_max(0.0, js_min(employee, max - before));
        ytd.add(&format!("{}_employee", spec.code), employee);
    }
    let employer = percent_of(wages, spec.employer_rate_percent);
    ytd.add(&format!("{}_wages", spec.code), wages);
    StateProgramResult {
        code: spec.code.to_owned(),
        label_key: spec.label_key.to_owned(),
        wages_cents: wages,
        employee_cents: employee,
        employer_cents: employer,
    }
}

pub struct SharedProgramSpec {
    pub code: &'static str,
    pub label_key: &'static str,
    pub wages_cents: Cents,
    pub wage_base_cents: Option<Cents>,
    pub total_rate_percent: f64,
    pub employee_max_rate_percent: f64,
    pub employee_rate_percent: Option<f64>,
    pub employer_owes_share: bool,
}

/// `computeSharedProgram(input, state, spec, ytd)`.
pub fn compute_shared_program(
    input: &StateCalcInput<'_>,
    state: &str,
    spec: &SharedProgramSpec,
    ytd: &mut YtdWriter<'_>,
) -> StateProgramResult {
    let wages = under_base(
        spec.wages_cents,
        read_ytd(input, state, &format!("{}_wages", spec.code)),
        spec.wage_base_cents,
    );
    let employee_max = percent_of(wages, spec.employee_max_rate_percent);
    let due = if spec.employer_owes_share {
        percent_of(wages, spec.total_rate_percent)
    } else {
        employee_max
    };
    let rate = js_max(
        0.0,
        js_min(
            spec.employee_rate_percent
                .unwrap_or(spec.employee_max_rate_percent),
            spec.employee_max_rate_percent,
        ),
    );
    let employee = js_min(percent_of(wages, rate), employee_max);
    ytd.add(&format!("{}_wages", spec.code), wages);
    StateProgramResult {
        code: spec.code.to_owned(),
        label_key: spec.label_key.to_owned(),
        wages_cents: wages,
        employee_cents: employee,
        employer_cents: js_max(0.0, due - employee),
    }
}

/// `residenceIssue(input, state)`.
pub fn residence_issue(input: &StateCalcInput<'_>, state: &str) -> Vec<PayrollIssue> {
    let Some(residence) = input
        .residence_state
        .map(str::to_uppercase)
        .filter(|r| !r.is_empty())
    else {
        return vec![];
    };
    if residence == state {
        return vec![];
    }
    vec![PayrollIssue::warning("residence_state_differs").with(&[
        ("state", json!(state)),
        ("residenceState", json!(residence)),
    ])]
}

/// `provisionalIssue(state, items)`.
pub fn provisional_issue(state: &str, items: &[&str]) -> Vec<PayrollIssue> {
    if items.is_empty() {
        return vec![];
    }
    vec![
        PayrollIssue::warning("provisional_rules")
            .with(&[("state", json!(state)), ("items", json!(items.join(", ")))]),
    ]
}

/// `unsupportedYearResult(input, state)`.
pub fn unsupported_year_result(input: &StateCalcInput<'_>, state: &str) -> StateCalcResult {
    StateCalcResult {
        state_wages_cents: 0.0,
        income_tax_cents: 0.0,
        sui: SuiResult::default(),
        programs: vec![],
        ytd_updates: OrderedMap::new(),
        issues: vec![
            PayrollIssue::error("unsupported_tax_year")
                .with(&[("year", json!(input.tax_year)), ("state", json!(state))]),
        ],
        rule_set: format!("us-{}-none", state.to_lowercase()),
    }
}

/// `unsupportedFrequencyResult(input, state, ruleSet)`.
pub fn unsupported_frequency_result(
    input: &StateCalcInput<'_>,
    state: &str,
    rule_set: &str,
) -> StateCalcResult {
    StateCalcResult {
        state_wages_cents: 0.0,
        income_tax_cents: 0.0,
        sui: SuiResult::default(),
        programs: vec![],
        ytd_updates: OrderedMap::new(),
        issues: vec![PayrollIssue::error("unsupported_frequency").with(&[
            ("periodsPerYear", n(input.periods_per_year)),
            ("state", json!(state)),
        ])],
        rule_set: rule_set.to_owned(),
    }
}

/// `recordIncomeTax(ytd, stateWagesCents, incomeTaxCents)`.
pub fn record_income_tax(
    ytd: &mut YtdWriter<'_>,
    state_wages_cents: Cents,
    income_tax_cents: Cents,
) {
    ytd.add("wages", state_wages_cents);
    ytd.add("tax", income_tax_cents);
}

/// The common tail: an income-tax state's result with its SUI.
pub fn income_tax_result(
    wages_total: Cents,
    income_tax: Cents,
    sui: SuiOutcome,
    programs_before_sui: Vec<StateProgramResult>,
    ytd: YtdWriter<'_>,
    mut issues: Vec<PayrollIssue>,
    rule_set: &str,
) -> StateCalcResult {
    issues.extend(sui.issues);
    let mut programs = programs_before_sui;
    programs.extend(sui.programs);
    StateCalcResult {
        state_wages_cents: wages_total,
        income_tax_cents: income_tax,
        sui: sui.sui,
        programs,
        ytd_updates: ytd.updates,
        issues,
        rule_set: rule_set.to_owned(),
    }
}
