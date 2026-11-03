//! The state modules (`us/states/*.ts`): income tax withholding, SUI and
//! the state programs per work state. The modules' descriptions (name,
//! certificate fields, employer rate codes) are the TypeScript's, written
//! to `data/us-states.json` by `pnpm rust:payroll-fixtures`.

// The tables are the TypeScript's literals, copied as they are.
#![allow(
    clippy::unnecessary_cast,
    clippy::cast_lossless,
    clippy::unreadable_literal
)]

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::money::{js_max, percent_of};
use crate::types::{FilingStatus, PayrollIssue};

pub mod ca;
pub mod common;
pub mod nj;
pub mod ny;

use common::{
    FEDERAL_INCOME_TAX_LIKE, FICA_LIKE, NO_EXCLUSIONS, PretaxExclusions, ProgramSpec,
    SharedProgramSpec, StateCalcInput, StateCalcResult, StateProgramResult, SuiEmployee, SuiRules,
    SuiSurcharge, YtdWriter, cert_allowances, cert_boolean, cert_extra_cents, cert_number,
    cert_string, compute_program, compute_shared_program, compute_sui, d, income_tax_result,
    nominal_periods, period_type_of, provisional_issue, read_ytd, record_income_tax,
    residence_issue, round_cents, round_to_dollar, taxable_wages, unsupported_frequency_result,
    unsupported_year_result,
};

/// `(over, base)` pairs from the TypeScript's `[over, base]` literals.
macro_rules! pairs {
    ($([$a:expr, $b:expr]),* $(,)?) => { &[$(($a as f64, $b as f64)),*] };
}
pub(crate) use pairs;

// ── module descriptions ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateFieldDef {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub required: Option<bool>,
    pub label_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateDef {
    pub form_name: String,
    #[serde(default)]
    pub filing_statuses: Option<Vec<String>>,
    pub uses_allowances: bool,
    pub fields: Vec<CertificateFieldDef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployerRateCode {
    pub code: String,
    pub label_key: String,
    #[serde(default)]
    pub default_percent: Option<f64>,
}

/// A `StateModule` without its `calculate`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateModule {
    pub code: String,
    pub name: String,
    pub has_income_tax: bool,
    pub supported_years: Vec<i64>,
    pub certificate: Option<CertificateDef>,
    #[serde(default)]
    pub employer_rate_codes: Option<Vec<EmployerRateCode>>,
}

static MODULES: LazyLock<BTreeMap<String, StateModule>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../data/us-states.json")).unwrap_or_default()
});

/// `SUPPORTED_STATES`, sorted.
pub fn supported_states() -> Vec<String> {
    MODULES.keys().cloned().collect()
}

/// `stateModule(code)`.
pub fn state_module(code: Option<&str>) -> Option<&'static StateModule> {
    MODULES.get(&code.filter(|c| !c.is_empty())?.to_uppercase())
}

/// `stateModule(code).calculate(input)`; `None` for a state without a module.
pub fn calculate_state(code: &str, input: &StateCalcInput<'_>) -> Option<StateCalcResult> {
    Some(match code.to_uppercase().as_str() {
        "AK" => no_income_tax(input, &AK),
        "FL" => no_income_tax(input, &FL),
        "NH" => no_income_tax(input, &NH),
        "NV" => no_income_tax(input, &NV),
        "SD" => no_income_tax(input, &SD),
        "TN" => no_income_tax(input, &TN),
        "TX" => no_income_tax(input, &TX),
        "WY" => no_income_tax(input, &WY),
        "WA" => no_income_tax(input, &WA),
        "AZ" => az(input),
        "CA" => ca::calculate(input),
        "CO" => co(input),
        "GA" => ga(input),
        "IL" => il(input),
        "MA" => ma(input),
        "NC" => nc(input),
        "NJ" => nj::calculate(input),
        "NY" => ny::calculate(input),
        "PA" => pa(input),
        _ => return None,
    })
}

/// `stateIncomeTaxLabelKey(state)`.
pub fn state_income_tax_label_key(state: &str) -> String {
    format!("us.state_income_tax.{}", state.to_uppercase())
}

/// `stateSuiEmployerLabelKey(state)`.
pub fn state_sui_employer_label_key(state: &str) -> String {
    format!("us.state_sui_employer.{}", state.to_uppercase())
}

/// `stateSuiEmployeeLabelKey(state)`.
pub fn state_sui_employee_label_key(state: &str) -> String {
    format!("us.state_sui_employee.{}", state.to_uppercase())
}

/// `CERTIFICATE_TOP_LEVEL_KEYS`.
pub const CERTIFICATE_TOP_LEVEL_KEYS: [&str; 4] =
    ["filingStatus", "allowances", "extraWithholding", "exempt"];

/// `isCertificateTopLevelKey(key)`.
pub fn is_certificate_top_level_key(key: &str) -> bool {
    CERTIFICATE_TOP_LEVEL_KEYS.contains(&key)
}

// ── states without an income tax (`no-income-tax.ts`) ───────────────────────

/// A state's own programs next to SUI, and the issues they raise.
type ProgramsFn =
    fn(&StateCalcInput<'_>, &mut YtdWriter<'_>) -> (Vec<StateProgramResult>, Vec<PayrollIssue>);

struct NoIncomeTaxDef {
    code: &'static str,
    rule_set: &'static str,
    sui: fn(&StateCalcInput<'_>) -> SuiRules,
    provisional: Option<fn(&StateCalcInput<'_>) -> Vec<&'static str>>,
    programs: Option<ProgramsFn>,
}

fn sui_rules(wage_base: f64, new_employer: Option<f64>) -> SuiRules {
    SuiRules {
        wage_base_cents: d(wage_base),
        new_employer_rate_percent: new_employer,
        exclusions: FICA_LIKE,
        employee: None,
        surcharges: vec![],
    }
}

fn no_income_tax(input: &StateCalcInput<'_>, def: &NoIncomeTaxDef) -> StateCalcResult {
    if input.tax_year != 2026 {
        return unsupported_year_result(input, def.code);
    }
    let mut ytd = YtdWriter::new(input, def.code);
    let mut issues = residence_issue(input, def.code);
    issues.extend(provisional_issue(
        def.code,
        &def.provisional.map(|f| f(input)).unwrap_or_default(),
    ));
    let mut rules = (def.sui)(input);
    rules.exclusions = FICA_LIKE;
    let sui = compute_sui(input, def.code, &rules, &mut ytd);
    issues.extend(sui.issues);
    let (mut programs, extra_issues) = match def.programs {
        Some(f) => f(input, &mut ytd),
        None => (vec![], vec![]),
    };
    issues.extend(extra_issues);
    programs.extend(sui.programs);
    StateCalcResult {
        state_wages_cents: 0.0,
        income_tax_cents: 0.0,
        sui: sui.sui,
        programs,
        ytd_updates: ytd.updates,
        issues,
        rule_set: def.rule_set.to_owned(),
    }
}

const AK: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "AK",
    rule_set: "us-ak-2026.1",
    sui: |_| SuiRules {
        employee: Some(SuiEmployee {
            rate_percent: 0.5,
            wage_base_cents: Some(d(54200.0)),
        }),
        ..sui_rules(54200.0, Some(1.0))
    },
    provisional: None,
    programs: None,
};

const FL: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "FL",
    rule_set: "us-fl-2026.1",
    sui: |_| sui_rules(7000.0, Some(2.7)),
    provisional: None,
    programs: None,
};

const NH: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "NH",
    rule_set: "us-nh-2026.1",
    sui: |_| sui_rules(14000.0, Some(1.7)),
    provisional: Some(|input| {
        if input.sui_rate_percent.is_none() && input.pay_date >= "2026-07-01" {
            vec!["new employer rate after 2026-Q2"]
        } else {
            vec![]
        }
    }),
    programs: None,
};

const NV: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "NV",
    rule_set: "us-nv-2026.1",
    sui: |input| SuiRules {
        surcharges: vec![SuiSurcharge {
            code: "nv_cep",
            label_key: "us.state_program.nv_cep",
            rate_key: "nv_cep",
            default_rate_percent: if input.sui_rate_percent.unwrap_or(0.0) >= 5.4 {
                0.0
            } else {
                0.05
            },
        }],
        ..sui_rules(43700.0, Some(2.95))
    },
    provisional: None,
    programs: None,
};

const SD: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "SD",
    rule_set: "us-sd-2026.1",
    sui: |input| SuiRules {
        surcharges: vec![
            SuiSurcharge {
                code: "sd_investment_fee",
                label_key: "us.state_program.sd_investment_fee",
                rate_key: "sd_investment_fee",
                default_rate_percent: 0.55,
            },
            SuiSurcharge {
                code: "sd_admin_fee",
                label_key: "us.state_program.sd_admin_fee",
                rate_key: "sd_admin_fee",
                default_rate_percent: if input.sui_rate_percent.is_none() {
                    0.0
                } else {
                    0.08
                },
            },
        ],
        ..sui_rules(15000.0, Some(1.2))
    },
    provisional: None,
    programs: None,
};

const TN: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "TN",
    rule_set: "us-tn-2026.1",
    sui: |_| sui_rules(7000.0, Some(2.7)),
    provisional: None,
    programs: None,
};

const TX: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "TX",
    rule_set: "us-tx-2026.1",
    sui: |_| sui_rules(9000.0, Some(2.7)),
    provisional: None,
    programs: None,
};

const WY: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "WY",
    rule_set: "us-wy-2026.1",
    sui: |_| sui_rules(33800.0, None),
    provisional: None,
    programs: None,
};

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

fn headcount_issue(state: &str) -> PayrollIssue {
    PayrollIssue::warning("employer_incomplete").with(&[
        ("state", json!(state)),
        ("field", json!("employeeCountEstimate")),
    ])
}

const WA: NoIncomeTaxDef = NoIncomeTaxDef {
    code: "WA",
    rule_set: "us-wa-2026.1",
    sui: |_| SuiRules {
        surcharges: vec![SuiSurcharge {
            code: "wa_eaf",
            label_key: "us.state_program.wa_eaf",
            rate_key: "wa_eaf",
            default_rate_percent: 0.03,
        }],
        ..sui_rules(78200.0, None)
    },
    provisional: Some(|input| {
        let p = input.pretax;
        if p.retirement401k_cents + p.section125_cents + p.hsa_cents + p.dependent_care_cents > 0.0
        {
            vec!["Paid Leave and WA Cares wages of pre-tax deductions"]
        } else {
            vec![]
        }
    }),
    programs: Some(|input, ytd| {
        const PFML_RATE_PERCENT: f64 = 1.13;
        const PFML_EMPLOYEE_SHARE: f64 = 0.7143;
        let mut issues = vec![];
        let wages = taxable_wages(input, NO_EXCLUSIONS).total;
        let headcount = input.employee_count_estimate;
        if headcount.is_none() {
            issues.push(headcount_issue("WA"));
        }
        let employer_owes = headcount.is_none_or(|h| h >= 50.0);
        let pfml = compute_shared_program(
            input,
            "WA",
            &SharedProgramSpec {
                code: "wa_pfml",
                label_key: "us.state_program.wa_pfml",
                wages_cents: wages,
                wage_base_cents: Some(d(184500.0)),
                total_rate_percent: PFML_RATE_PERCENT,
                employee_max_rate_percent: PFML_RATE_PERCENT * PFML_EMPLOYEE_SHARE,
                employee_rate_percent: input.extra_rate("wa_pfml_employee"),
                employer_owes_share: employer_owes,
            },
            ytd,
        );
        let cares = compute_program(
            input,
            "WA",
            &ProgramSpec {
                code: "wa_cares",
                label_key: "us.state_program.wa_cares",
                wages_cents: if cert_boolean(input, "wa_cares_exempt") {
                    0.0
                } else {
                    wages
                },
                wage_base_cents: None,
                employee_rate_percent: 0.58,
                employer_rate_percent: 0.0,
                employee_annual_max_cents: None,
                employee_period_max_cents: None,
            },
            ytd,
        );
        (vec![pfml, cares], issues)
    }),
};

// ── flat and simple income taxes ────────────────────────────────────────────

fn simple_sui(wage_base: f64, new_employer: f64) -> SuiRules {
    sui_rules(wage_base, Some(new_employer))
}

/// Arizona: the A-4 percentage of the federal-like wages.
fn az(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "AZ";
    const PERCENTAGES: [&str; 7] = ["0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5"];
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let mut ytd = YtdWriter::new(input, STATE);
    let issues = residence_issue(input, STATE);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let mut income_tax = 0.0;
    if !input.certificate_exempt() {
        let elected = match cert_string(input, "withholding_percent") {
            Some(chosen) if PERCENTAGES.contains(&chosen) => crate::js::number_of(chosen),
            _ => 2.0,
        };
        income_tax = percent_of(wages.total, elected);
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let sui = compute_sui(input, STATE, &simple_sui(8000.0, 2.0), &mut ytd);
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![],
        ytd,
        issues,
        "us-az-2026.1",
    )
}

/// `ilWithholding(wagesCents, basicAllowances, additionalAllowances, periodsPerYear)`.
pub fn il_withholding(wages_cents: f64, basic: f64, additional: f64, periods_per_year: f64) -> f64 {
    let exemptions = round_cents((basic * d(2925.0) + additional * d(1000.0)) / periods_per_year);
    let taxable = js_max(0.0, wages_cents - exemptions);
    percent_of(taxable, 4.95)
}

fn il(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "IL";
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let mut ytd = YtdWriter::new(input, STATE);
    let issues = residence_issue(input, STATE);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let cert = input.certificate;
    let mut income_tax = 0.0;
    if !input.certificate_exempt() {
        let basic = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        let additional = if cert.is_some() {
            js_max(0.0, cert_number(input, "additional_allowances").trunc())
        } else {
            0.0
        };
        income_tax = (if wages.regular > 0.0 {
            il_withholding(wages.regular, basic, additional, input.periods_per_year)
        } else {
            0.0
        }) + percent_of(wages.supplemental, 4.95);
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let sui = compute_sui(input, STATE, &simple_sui(14250.0, 3.35), &mut ytd);
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![],
        ytd,
        issues,
        "us-il-2026.1",
    )
}

fn pa(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "PA";
    const PIT_EXCLUSIONS: PretaxExclusions = PretaxExclusions {
        retirement401k: false,
        section125: true,
        hsa: true,
        dependent_care: false,
    };
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let mut ytd = YtdWriter::new(input, STATE);
    let p = input.pretax;
    let uc_unverified =
        p.section125_cents > 0.0 || p.hsa_cents > 0.0 || p.dependent_care_cents > 0.0;
    let mut issues = residence_issue(input, STATE);
    issues.extend(provisional_issue(
        STATE,
        if uc_unverified {
            &["UC wages of Section 125, HSA and dependent care salary reductions"]
        } else {
            &[]
        },
    ));
    let wages = taxable_wages(input, PIT_EXCLUSIONS);
    let income_tax = if input.certificate_exempt() {
        0.0
    } else {
        percent_of(wages.total, 3.07)
    };
    record_income_tax(&mut ytd, wages.total, income_tax);
    let rules = SuiRules {
        employee: Some(SuiEmployee {
            rate_percent: 0.07,
            wage_base_cents: None,
        }),
        ..simple_sui(10000.0, 3.822)
    };
    let sui = compute_sui(input, STATE, &rules, &mut ytd);
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![],
        ytd,
        issues,
        "us-pa-2026.1",
    )
}

/// `coWithholding(wagesCents, annualAllowanceCents, periodsPerYear)`.
pub fn co_withholding(wages_cents: f64, annual_allowance_cents: f64, periods_per_year: f64) -> f64 {
    let annual = js_max(0.0, wages_cents * periods_per_year - annual_allowance_cents);
    (annual * 4.4) / 100.0 / periods_per_year
}

fn co(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "CO";
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let mut ytd = YtdWriter::new(input, STATE);
    let mut issues = residence_issue(input, STATE);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let has_dr0004 = input.certificate.is_some();
    let w4_exempt = !has_dr0004 && input.federal_w4.is_some_and(|w| w.exempt);
    let mut income_tax = 0.0;
    if !w4_exempt && !input.certificate_exempt() && wages.total > 0.0 {
        let annual_allowance = {
            let line2 = input
                .certificate
                .and_then(|c| c.values.get("withholding_allowance"));
            let numeric = match line2 {
                Some(Value::Number(v)) => v.as_f64().filter(|x| x.is_finite()),
                Some(Value::String(s)) if !crate::js::js_trim(s).is_empty() => {
                    Some(crate::js::number_of(s)).filter(|x| x.is_finite())
                }
                _ => None,
            };
            match numeric {
                Some(v) => js_max(0.0, d(v)),
                None if input
                    .federal_w4
                    .is_some_and(|w| w.filing_status == FilingStatus::MarriedJointly) =>
                {
                    d(11000.0)
                }
                None => d(5500.0),
            }
        };
        income_tax = round_cents(co_withholding(
            wages.total,
            annual_allowance,
            input.periods_per_year,
        )) + cert_extra_cents(input);
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let sui = compute_sui(input, STATE, &simple_sui(30600.0, 3.05), &mut ytd);
    issues.extend(sui.issues);
    let headcount = input.employee_count_estimate;
    if headcount.is_none() {
        issues.push(headcount_issue(STATE));
    }
    let famli = compute_shared_program(
        input,
        STATE,
        &SharedProgramSpec {
            code: "co_famli",
            label_key: "us.state_program.co_famli",
            wages_cents: if input.exempt_from_sui {
                0.0
            } else {
                taxable_wages(input, FICA_LIKE).total
            },
            wage_base_cents: Some(d(184500.0)),
            total_rate_percent: 0.88,
            employee_max_rate_percent: 0.88 / 2.0,
            employee_rate_percent: input.extra_rate("co_famli_employee"),
            employer_owes_share: headcount.is_none_or(|h| h >= 10.0),
        },
        &mut ytd,
    );
    let mut programs = vec![famli];
    programs.extend(sui.programs);
    StateCalcResult {
        state_wages_cents: wages.total,
        income_tax_cents: income_tax,
        sui: sui.sui,
        programs,
        ytd_updates: ytd.updates,
        issues,
        rule_set: "us-co-2026.1".into(),
    }
}

/// `ncWithholding(wagesCents, status, allowances, periodsPerYear)`; `hoh`
/// is the head-of-household status.
pub fn nc_withholding(wages_cents: f64, hoh: bool, allowances: f64, periods_per_year: f64) -> f64 {
    const RATE: f64 = 4.09;
    let table: Option<([f64; 2], f64)> = match nominal_periods(periods_per_year) {
        52.0 => Some(([245.19, 367.79], 48.08)),
        26.0 => Some(([490.38, 735.58], 96.15)),
        24.0 => Some(([531.25, 796.88], 104.17)),
        12.0 => Some(([1062.5, 1593.75], 208.33)),
        _ => None,
    };
    if let Some((deduction, allowance)) = table {
        let net = wages_cents - d(deduction[usize::from(hoh)]) - allowances * d(allowance);
        return if net > 0.0 {
            round_to_dollar((net * RATE) / 100.0)
        } else {
            0.0
        };
    }
    let standard = if hoh { d(19125.0) } else { d(12750.0) };
    let annual = wages_cents * periods_per_year - standard - allowances * d(2500.0);
    if annual > 0.0 {
        round_to_dollar((annual * RATE) / 100.0 / periods_per_year)
    } else {
        0.0
    }
}

fn nc(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "NC";
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let mut ytd = YtdWriter::new(input, STATE);
    let issues = residence_issue(input, STATE);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let cert = input.certificate;
    let mut income_tax = 0.0;
    let exempt = input.certificate_exempt() || cert_boolean(input, "military_spouse_exempt");
    if !exempt {
        let hoh = cert.and_then(|c| c.filing_status.as_deref()) == Some("head_of_household");
        let allowances = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        let regular_tax = if wages.regular > 0.0 {
            nc_withholding(wages.regular, hoh, allowances, input.periods_per_year)
        } else {
            0.0
        };
        let mut supplemental_tax = 0.0;
        if wages.supplemental > 0.0 {
            supplemental_tax = if wages.regular > 0.0 && regular_tax == 0.0 {
                nc_withholding(
                    wages.regular + wages.supplemental,
                    hoh,
                    allowances,
                    input.periods_per_year,
                ) - regular_tax
            } else {
                percent_of(wages.supplemental, 4.09)
            };
        }
        income_tax = regular_tax + supplemental_tax;
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let sui = compute_sui(input, STATE, &simple_sui(34200.0, 1.0), &mut ytd);
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![],
        ytd,
        issues,
        "us-nc-2026.1",
    )
}

/// Georgia's Table E and rate, before or after HB 463.
pub struct GaParams {
    pub rate_percent: f64,
    /// Per period type: [married one working, single/HoH, married both working, allowance].
    pub table_e: [[f64; 4]; 7],
}

const GA_BEFORE: GaParams = GaParams {
    rate_percent: 5.19,
    table_e: [
        [461.54, 230.77, 230.77, 76.92],
        [923.08, 461.54, 461.54, 153.85],
        [1000.0, 500.0, 500.0, 166.67],
        [2000.0, 1000.0, 1000.0, 333.33],
        [6000.0, 3000.0, 3000.0, 1000.0],
        [12000.0, 6000.0, 6000.0, 2000.0],
        [24000.0, 12000.0, 12000.0, 4000.0],
    ],
};

const GA_AFTER: GaParams = GaParams {
    rate_percent: 4.99,
    table_e: [
        [576.92, 288.46, 288.46, 96.15],
        [1153.85, 576.92, 576.92, 192.31],
        [1250.0, 625.0, 625.0, 208.33],
        [2500.0, 1250.0, 1250.0, 416.67],
        [7500.0, 3750.0, 3750.0, 1250.0],
        [15000.0, 7500.0, 7500.0, 2500.0],
        [30000.0, 15000.0, 15000.0, 5000.0],
    ],
};

/// `gaParams(payDate)`.
pub fn ga_params(pay_date: &str) -> &'static GaParams {
    if pay_date >= "2026-05-11" {
        &GA_AFTER
    } else {
        &GA_BEFORE
    }
}

fn ga(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "GA";
    const RULE_SET: &str = "us-ga-2026.2";
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let Some(period) = period_type_of(input.periods_per_year) else {
        return unsupported_frequency_result(input, STATE, RULE_SET);
    };
    let mut ytd = YtdWriter::new(input, STATE);
    let issues = residence_issue(input, STATE);
    let params = ga_params(input.pay_date);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let cert = input.certificate;
    let mut income_tax = 0.0;
    let exempt = input.certificate_exempt() || cert_boolean(input, "military_spouse_exempt");
    if !exempt {
        let column = match cert.and_then(|c| c.filing_status.as_deref()) {
            Some("married_one_working") => 0,
            Some("married_both_working") => 2,
            _ => 1,
        };
        let allowances = if cert.is_some() {
            js_max(
                0.0,
                cert_number(input, "dependent_allowances").trunc()
                    + cert_number(input, "adjustment_allowances").trunc(),
            )
        } else {
            0.0
        };
        let regular = if wages.regular > 0.0 {
            let row = params.table_e[period.index()];
            let subject = wages.regular - d(row[column]) - allowances * d(row[3]);
            round_cents(if subject > 0.0 {
                (subject * params.rate_percent) / 100.0
            } else {
                0.0
            })
        } else {
            0.0
        };
        income_tax = regular + percent_of(wages.supplemental, params.rate_percent);
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let rules = SuiRules {
        surcharges: vec![SuiSurcharge {
            code: "ga_admin_assessment",
            label_key: "us.state_program.ga_admin_assessment",
            rate_key: "ga_admin_assessment",
            default_rate_percent: 0.06,
        }],
        ..simple_sui(9500.0, 2.64)
    };
    let sui = compute_sui(input, STATE, &rules, &mut ytd);
    income_tax_result(wages.total, income_tax, sui, vec![], ytd, issues, RULE_SET)
}

// ── Massachusetts ───────────────────────────────────────────────────────────

const MA_SURTAX_THRESHOLD: f64 = 1_107_750.0;
const MA_EXEMPTION_FACTOR: [(f64, f64); 7] = [
    (19.0, 66.0),
    (38.0, 131.0),
    (42.0, 141.0),
    (83.0, 284.0),
    (250.0, 850.0),
    (500.0, 1700.0),
    (1000.0, 3400.0),
];
const MA_HOH_TAX_VALUE: [f64; 7] = [2.31, 4.62, 5.0, 10.0, 30.0, 60.0, 120.0];
const MA_BLIND_TAX_VALUE: [f64; 7] = [2.12, 4.23, 4.58, 9.17, 27.5, 55.0, 110.0];
const MA_LOW_WAGE: [f64; 7] = [154.0, 308.0, 333.0, 667.0, 2000.0, 4000.0, 8000.0];
const MA_COVID_RECOVERY_BY_UI_RATE: [(&str, f64); 45] = [
    ("0.94", 0.178),
    ("1.08", 0.204),
    ("1.21", 0.229),
    ("1.34", 0.253),
    ("1.61", 0.304),
    ("1.75", 0.331),
    ("1.89", 0.357),
    ("2.01", 0.38),
    ("2.15", 0.406),
    ("2.29", 0.433),
    ("2.42", 0.457),
    ("2.56", 0.484),
    ("2.69", 0.508),
    ("2.82", 0.533),
    ("2.96", 0.559),
    ("3.09", 0.584),
    ("3.23", 0.61),
    ("3.37", 0.637),
    ("3.5", 0.662),
    ("3.63", 0.686),
    ("3.76", 0.711),
    ("3.9", 0.737),
    ("4.04", 0.764),
    ("4.17", 0.788),
    ("4.3", 0.813),
    ("4.44", 0.839),
    ("4.57", 0.864),
    ("4.71", 0.89),
    ("4.84", 0.915),
    ("4.98", 0.941),
    ("5.11", 0.966),
    ("5.24", 0.99),
    ("7.03", 1.329),
    ("7.64", 1.444),
    ("8.26", 1.561),
    ("8.86", 1.675),
    ("9.48", 1.792),
    ("10.09", 1.907),
    ("10.7", 2.022),
    ("11.31", 2.138),
    ("11.93", 2.255),
    ("12.53", 2.368),
    ("13.15", 2.485),
    ("13.76", 2.601),
    ("14.37", 2.716),
];

fn ma_exemption_factor(period: usize, exemptions: f64) -> f64 {
    if exemptions <= 0.0 {
        return 0.0;
    }
    let (per, base) = MA_EXEMPTION_FACTOR[period];
    d(per * exemptions + base)
}

fn ma_annual_tax(annual_cents: f64) -> f64 {
    if annual_cents <= 0.0 {
        return 0.0;
    }
    let surtaxed = js_max(0.0, annual_cents - d(MA_SURTAX_THRESHOLD));
    ((annual_cents - surtaxed) * 5.0 + surtaxed * 9.0) / 100.0
}

/// `maRegularWithholding(input)`.
pub fn ma_regular_withholding(
    period: usize,
    periods_per_year: f64,
    wages_cents: f64,
    fica_deduction_cents: f64,
    exemptions: f64,
    head_of_household: bool,
    blind_count: f64,
) -> f64 {
    if exemptions > 0.0 && wages_cents < d(MA_LOW_WAGE[period]) {
        return 0.0;
    }
    let net = wages_cents - fica_deduction_cents - ma_exemption_factor(period, exemptions);
    let mut tax = ma_annual_tax(net * periods_per_year) / periods_per_year;
    if head_of_household {
        tax -= d(MA_HOH_TAX_VALUE[period]);
    }
    tax -= blind_count * d(MA_BLIND_TAX_VALUE[period]);
    js_max(0.0, tax)
}

/// `maSupplementalWithholding(supplementalCents, annualizedNetRegularCents, priorSupplementalCents)`.
pub fn ma_supplemental_withholding(
    supplemental: f64,
    annualized_net_regular: f64,
    prior: f64,
) -> f64 {
    if supplemental <= 0.0 {
        return 0.0;
    }
    let threshold = d(MA_SURTAX_THRESHOLD);
    let total = supplemental + js_max(0.0, annualized_net_regular) + prior;
    if total <= threshold {
        return (supplemental * 5.0) / 100.0;
    }
    let excess = crate::money::js_min(supplemental, total - threshold);
    crate::money::js_min(
        (supplemental * 9.0) / 100.0,
        (excess * 9.0 + (supplemental - excess) * 5.0) / 100.0,
    )
}

fn ma(input: &StateCalcInput<'_>) -> StateCalcResult {
    const STATE: &str = "MA";
    const RULE_SET: &str = "us-ma-2026.1";
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let Some(period) = period_type_of(input.periods_per_year) else {
        return unsupported_frequency_result(input, STATE, RULE_SET);
    };
    let period = period.index();
    let mut ytd = YtdWriter::new(input, STATE);
    let mut issues = residence_issue(input, STATE);
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let cert = input.certificate;
    let fica_this_period = input
        .fica_employee_cents
        .unwrap_or_else(|| percent_of(taxable_wages(input, FICA_LIKE).total, 7.65));
    let fica_deduction = js_max(
        0.0,
        crate::money::js_min(
            fica_this_period,
            d(2000.0) - read_ytd(input, STATE, "fica_deduction"),
        ),
    );
    ytd.add("fica_deduction", fica_deduction);
    let mut income_tax = 0.0;
    let no_withholding = input.certificate_exempt()
        || cert_boolean(input, "full_time_student")
        || cert_boolean(input, "military_spouse_exempt");
    if !no_withholding {
        let exemptions = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        let regular = if wages.regular > 0.0 {
            round_cents(ma_regular_withholding(
                period,
                input.periods_per_year,
                wages.regular,
                fica_deduction,
                exemptions,
                cert_boolean(input, "head_of_household"),
                f64::from(u8::from(cert_boolean(input, "blind")))
                    + f64::from(u8::from(cert_boolean(input, "spouse_blind"))),
            ))
        } else {
            0.0
        };
        let annualized_net_regular =
            wages.regular * input.periods_per_year - d(2000.0) - ma_exemption_factor(6, exemptions);
        let supplemental = round_cents(ma_supplemental_withholding(
            wages.supplemental,
            if wages.regular > 0.0 {
                annualized_net_regular
            } else {
                0.0
            },
            read_ytd(input, STATE, "supplemental_wages"),
        ));
        income_tax = regular + supplemental;
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    ytd.add("supplemental_wages", wages.supplemental);
    record_income_tax(&mut ytd, wages.total, income_tax);
    let covid_rate = match input.extra_rate("ma_covid_recovery") {
        Some(rate) => Some(rate),
        None => match input.sui_rate_percent {
            None => Some(0.0),
            Some(ui) => {
                let key = crate::js::number_text(ui);
                MA_COVID_RECOVERY_BY_UI_RATE
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| *v)
            }
        },
    };
    if covid_rate.is_none() {
        issues.push(PayrollIssue::warning("employer_incomplete").with(&[
            ("state", json!(STATE)),
            ("field", json!("ma_covid_recovery")),
        ]));
    }
    let headcount = input.employee_count_estimate;
    let mut emac_rate = match input.extra_rate("ma_emac") {
        Some(rate) => rate,
        None if input.sui_rate_percent.is_none() => 0.0,
        None => {
            issues.push(PayrollIssue::warning("employer_incomplete").with(&[
                ("state", json!(STATE)),
                ("field", json!("ma_emac")),
                ("fallbackRatePercent", n(0.34)),
            ]));
            0.34
        }
    };
    if headcount.is_some_and(|h| h < 6.0) {
        emac_rate = 0.0;
    }
    let rules = SuiRules {
        surcharges: vec![
            SuiSurcharge {
                code: "ma_covid_recovery",
                label_key: "us.state_program.ma_covid_recovery",
                rate_key: "ma_covid_recovery",
                default_rate_percent: covid_rate.unwrap_or(0.0),
            },
            SuiSurcharge {
                code: "ma_wtf",
                label_key: "us.state_program.ma_wtf",
                rate_key: "ma_wtf",
                default_rate_percent: 0.056,
            },
            SuiSurcharge {
                code: "ma_emac",
                label_key: "us.state_program.ma_emac",
                rate_key: "ma_emac_effective",
                default_rate_percent: emac_rate,
            },
        ],
        ..simple_sui(15000.0, 2.42)
    };
    let sui = compute_sui(input, STATE, &rules, &mut ytd);
    issues.extend(sui.issues);
    if headcount.is_none() {
        issues.push(headcount_issue(STATE));
    }
    let pfml = compute_shared_program(
        input,
        STATE,
        &SharedProgramSpec {
            code: "ma_pfml",
            label_key: "us.state_program.ma_pfml",
            wages_cents: if input.exempt_from_sui {
                0.0
            } else {
                taxable_wages(input, NO_EXCLUSIONS).total
            },
            wage_base_cents: Some(d(184500.0)),
            total_rate_percent: 0.88,
            employee_max_rate_percent: 0.46,
            employee_rate_percent: input.extra_rate("ma_pfml_employee"),
            employer_owes_share: headcount.is_none_or(|h| h >= 25.0),
        },
        &mut ytd,
    );
    let mut programs = vec![pfml];
    programs.extend(sui.programs);
    StateCalcResult {
        state_wages_cents: wages.total,
        income_tax_cents: income_tax,
        sui: sui.sui,
        programs,
        ytd_updates: ytd.updates,
        issues,
        rule_set: RULE_SET.into(),
    }
}

/// The certificate's values as a JSON object, for callers that show it.
pub fn certificate_values(values: &Map<String, Value>) -> Value {
    Value::Object(values.clone())
}
