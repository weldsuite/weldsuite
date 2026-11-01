//! The engines' inputs and outputs (`types.ts`). Field names, optional keys
//! and `null`s are the TypeScript's: these values are stored as JSON and
//! answered to clients.
//!
//! `Option<Option<T>>` is a key the TypeScript may leave out (`None`) or
//! set to `null` (`Some(None)`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::money::Cents;
use crate::ordered::{OrderedMap, double_option};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PayrollCountry {
    #[serde(rename = "NL")]
    Nl,
    #[serde(rename = "US")]
    Us,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayFrequency {
    Monthly,
    FourWeekly,
    Semimonthly,
    Biweekly,
    Weekly,
}

impl PayFrequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::FourWeekly => "four_weekly",
            Self::Semimonthly => "semimonthly",
            Self::Biweekly => "biweekly",
            Self::Weekly => "weekly",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "monthly" => Self::Monthly,
            "four_weekly" => Self::FourWeekly,
            "semimonthly" => Self::Semimonthly,
            "biweekly" => Self::Biweekly,
            "weekly" => Self::Weekly,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayPeriod {
    pub start: String,
    pub end: String,
    pub pay_date: String,
    pub frequency: PayFrequency,
    pub tax_year: i64,
    pub period_number: i64,
    pub periods_per_year: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayrollIssue {
    pub severity: Severity,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Map<String, Value>>,
}

impl PayrollIssue {
    pub fn error(code: &str) -> Self {
        Self {
            severity: Severity::Error,
            code: code.to_owned(),
            params: None,
        }
    }

    pub fn warning(code: &str) -> Self {
        Self {
            severity: Severity::Warning,
            code: code.to_owned(),
            params: None,
        }
    }

    /// With `params` (string or number values).
    #[must_use]
    pub fn with(mut self, params: &[(&str, Value)]) -> Self {
        let map = params
            .iter()
            .map(|(k, v)| ((*k).to_owned(), crate::js::whole_numbers(v.clone())))
            .collect();
        self.params = Some(map);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Section {
    Earning,
    Deduction,
    Tax,
    Reimbursement,
    Employer,
    Info,
}

impl Section {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Earning => "earning",
            Self::Deduction => "deduction",
            Self::Tax => "tax",
            Self::Reimbursement => "reimbursement",
            Self::Employer => "employer",
            Self::Info => "info",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipLine {
    pub code: String,
    pub section: Section,
    pub label_key: String,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub quantity: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub rate: Option<Option<f64>>,
    pub amount_cents: Cents,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bases: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub jurisdiction: Option<Option<String>>,
}

impl PayslipLine {
    pub fn new(code: &str, section: Section, label_key: &str, amount_cents: Cents) -> Self {
        Self {
            code: code.to_owned(),
            section,
            label_key: label_key.to_owned(),
            label: None,
            quantity: None,
            rate: None,
            amount_cents,
            bases: None,
            jurisdiction: None,
        }
    }

    pub fn has_base(&self, base: &str) -> bool {
        self.bases
            .as_ref()
            .is_some_and(|b| b.iter().any(|x| x == base))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayType {
    Salary,
    Hourly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompensationPeriod {
    Hour,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompensationInput {
    pub pay_type: PayType,
    pub amount: f64,
    pub period: CompensationPeriod,
    pub hours_per_week: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInput {
    pub code: String,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<Option<String>>,
    pub amount_cents: Option<Cents>,
    #[serde(default)]
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub code: String,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<Option<String>>,
    pub quantity: Option<f64>,
    pub rate: Option<f64>,
    pub amount_cents: Option<Cents>,
    pub work_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployeeDates {
    pub date_of_birth: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

pub type Ytd = OrderedMap<f64>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlEmployerInput {
    pub whk_rate_percent: Option<f64>,
    pub sector_code: Option<i64>,
    pub aof_small_employer: bool,
    pub holiday_allowance_percent: f64,
    pub holiday_allowance_payout_month: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlEmployeeInput {
    pub apply_loonheffingskorting: bool,
    pub anonymous: bool,
    pub is_dga: bool,
    pub insured_ww: bool,
    pub insured_zw: bool,
    pub insured_wao: bool,
    pub written_contract: bool,
    pub indefinite_contract: bool,
    pub on_call: bool,
    pub contract_hours_per_week: Option<f64>,
    pub expat_ruling_percent: Option<f64>,
    pub previous_year_annual_wage_cents: Option<Cents>,
    #[serde(default)]
    pub holiday_allowance_opening_balance_cents: Option<Cents>,
    #[serde(default)]
    pub usual_work_days_per_week: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlPayslipInput {
    pub period: PayPeriod,
    pub employee: EmployeeDates,
    pub compensation: Option<CompensationInput>,
    pub components: Vec<ComponentInput>,
    pub inputs: Vec<RunInput>,
    pub ytd: Ytd,
    pub employer: NlEmployerInput,
    pub nl: NlEmployeeInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilingStatus {
    Single,
    MarriedJointly,
    HeadOfHousehold,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsW4Input {
    pub form_year: i64,
    pub filing_status: FilingStatus,
    pub multiple_jobs: bool,
    pub dependents_amount: f64,
    pub other_income: f64,
    pub deductions: f64,
    pub extra_withholding: f64,
    pub exempt: bool,
    pub allowances: Option<f64>,
    pub nonresident_alien: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsStateCertificateInput {
    pub filing_status: Option<String>,
    pub allowances: Option<f64>,
    pub values: Map<String, Value>,
    pub extra_withholding: Option<f64>,
    pub exempt: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsEmployerInput {
    pub workweek_start_day: i64,
    pub sui_rate_percent: OrderedMap<Option<f64>>,
    pub extra_rates: OrderedMap<OrderedMap<f64>>,
    pub employee_count_estimate: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlsaStatus {
    Exempt,
    Nonexempt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsEmployeeInput {
    pub work_state: Option<String>,
    pub residence_state: Option<String>,
    pub flsa_status: FlsaStatus,
    pub w4: Option<UsW4Input>,
    pub state_certificates: OrderedMap<UsStateCertificateInput>,
    pub exempt_fica: bool,
    pub exempt_futa: bool,
    #[serde(default)]
    pub exempt_sui: Option<bool>,
    pub statutory_employee: bool,
    pub retirement_plan: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsPayslipInput {
    pub period: PayPeriod,
    pub employee: EmployeeDates,
    pub compensation: Option<CompensationInput>,
    pub components: Vec<ComponentInput>,
    pub inputs: Vec<RunInput>,
    pub ytd: Ytd,
    pub employer: UsEmployerInput,
    pub us: UsEmployeeInput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "country")]
pub enum PayslipInput {
    #[serde(rename = "NL")]
    Nl(Box<NlPayslipInput>),
    #[serde(rename = "US")]
    Us(Box<UsPayslipInput>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipResult {
    pub lines: Vec<PayslipLine>,
    pub gross_cents: Cents,
    pub taxable_wage_cents: Cents,
    pub employee_taxes_cents: Cents,
    pub employee_deductions_cents: Cents,
    pub reimbursements_cents: Cents,
    pub net_cents: Cents,
    pub employer_taxes_cents: Cents,
    pub employer_cost_cents: Cents,
    pub ytd: Ytd,
    pub filing_data: FilingData,
    pub issues: Vec<PayrollIssue>,
    pub rule_set: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FilingData {
    #[serde(rename = "nl")]
    Nl(Box<NlFilingData>),
    #[serde(rename = "us")]
    Us(Box<UsFilingData>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RateLevel {
    Low,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZvwKind {
    EmployerLevy,
    Withheld,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Insured {
    pub ww: bool,
    pub zw: bool,
    pub wao: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contract {
    pub written: bool,
    pub indefinite: bool,
    #[serde(rename = "onCall")]
    pub on_call: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlAmounts {
    pub loon_lb_ph: Cents,
    pub loon_sv: Cents,
    pub premieloon_awf: Cents,
    pub premieloon_aof: Cents,
    pub premieloon_whk: Cents,
    pub loon_zvw: Cents,
    pub loon_tabel_bijzondere_beloningen: Cents,
    pub wage_tax: Cents,
    pub labour_credit: Cents,
    pub awf_premium: Cents,
    pub aof_premium: Cents,
    pub wko_premium: Cents,
    pub whk_premium: Cents,
    pub zvw_employer_levy: Cents,
    pub zvw_withheld: Cents,
    pub holiday_allowance_paid: Cents,
    pub holiday_allowance_accrued: Cents,
    pub company_car_value: Cents,
    pub company_car_employee_contribution: Cents,
    pub pension_employee: Cents,
    pub tax_free_allowances: Cents,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cash_wage: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_kind_wage: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overtime_wage: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub travel_allowance_tax_free: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_wage: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_payment: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_payment_wage_tax: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_payment_loon_zvw: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_payment_zvw: Option<Cents>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlFilingData {
    pub table_code: String,
    pub apply_loonheffingskorting: bool,
    pub anonymous: bool,
    pub insured: Insured,
    pub awf_rate: RateLevel,
    pub aof_rate: RateLevel,
    pub zvw: ZvwKind,
    pub contract: Contract,
    pub amounts: NlAmounts,
    pub hours_paid: f64,
    pub sv_days: f64,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub contract_hours_per_week: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_dga: Option<bool>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub incidental_income_reduction: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsFederalFiling {
    pub fit_wages: Cents,
    pub federal_income_tax: Cents,
    pub ss_wages: Cents,
    pub ss_tax_employee: Cents,
    pub ss_tax_employer: Cents,
    pub medicare_wages: Cents,
    pub medicare_tax_employee: Cents,
    pub medicare_tax_employer: Cents,
    pub additional_medicare_wages: Cents,
    pub additional_medicare_tax: Cents,
    pub futa_gross_wages: Cents,
    pub futa_wages: Cents,
    pub futa_tax: Cents,
    pub ss_tips: Cents,
    pub box12: OrderedMap<Cents>,
    pub dependent_care: Cents,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub futa_exempt_wages: Option<Cents>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub futa_state: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub futa_credit_reduction: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplemental_wages: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statutory_employee: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retirement_plan: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProgramFiling {
    pub wages: Cents,
    pub employee: Cents,
    pub employer: Cents,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsStateFiling {
    pub state_wages: Cents,
    pub state_income_tax: Cents,
    pub sui_wages: Cents,
    pub sui_gross_wages: Cents,
    pub sui_employer_tax: Cents,
    pub sui_employee_tax: Cents,
    pub programs: OrderedMap<ProgramFiling>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsFilingData {
    pub federal: UsFederalFiling,
    pub states: OrderedMap<UsStateFiling>,
    pub qualified_overtime_premium: Cents,
    pub hours_worked: f64,
}
