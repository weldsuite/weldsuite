//! The pay component catalogue (`components.ts`).

use crate::types::PayrollCountry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentKind {
    Earning,
    Deduction,
    Reimbursement,
    Employer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentEntry {
    Hours,
    Amount,
    Days,
    Params,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamType {
    Number,
    Percent,
    Money,
    Boolean,
    Date,
}

#[derive(Debug, Clone, Copy)]
pub struct ComponentParamDef {
    pub key: &'static str,
    pub kind: ParamType,
    pub required: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ComponentDef {
    pub code: &'static str,
    pub countries: &'static [PayrollCountry],
    pub kind: ComponentKind,
    pub entry: ComponentEntry,
    pub recurring: bool,
    pub one_off: bool,
    pub collected: bool,
    pub params: &'static [ComponentParamDef],
    pub label_key: &'static str,
}

use ComponentEntry as E;
use ComponentKind as K;
use ParamType as P;
use PayrollCountry::{Nl, Us};

const BOTH: &[PayrollCountry] = &[Nl, Us];
const NL: &[PayrollCountry] = &[Nl];
const US: &[PayrollCountry] = &[Us];

const fn p(key: &'static str, kind: ParamType) -> ComponentParamDef {
    ComponentParamDef {
        key,
        kind,
        required: false,
    }
}

const fn req(key: &'static str, kind: ParamType) -> ComponentParamDef {
    ComponentParamDef {
        key,
        kind,
        required: true,
    }
}

#[allow(clippy::too_many_arguments, clippy::fn_params_excessive_bools)]
const fn def(
    code: &'static str,
    countries: &'static [PayrollCountry],
    kind: ComponentKind,
    entry: ComponentEntry,
    recurring: bool,
    one_off: bool,
    collected: bool,
    params: &'static [ComponentParamDef],
    label_key: &'static str,
) -> ComponentDef {
    ComponentDef {
        code,
        countries,
        kind,
        entry,
        recurring,
        one_off,
        collected,
        params,
        label_key,
    }
}

pub const PAY_COMPONENTS: &[ComponentDef] = &[
    def(
        "hours.regular",
        BOTH,
        K::Earning,
        E::Hours,
        false,
        true,
        true,
        &[],
        "hoursRegular",
    ),
    def(
        "hours.overtime",
        BOTH,
        K::Earning,
        E::Hours,
        false,
        true,
        false,
        &[],
        "hoursOvertime",
    ),
    def(
        "hours.unpaid_leave",
        BOTH,
        K::Deduction,
        E::Hours,
        false,
        true,
        true,
        &[],
        "hoursUnpaidLeave",
    ),
    def(
        "hours.paid_leave",
        US,
        K::Earning,
        E::Hours,
        false,
        true,
        true,
        &[],
        "hoursPaidLeave",
    ),
    def(
        "bonus",
        BOTH,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "bonus",
    ),
    def(
        "commission",
        BOTH,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "commission",
    ),
    def(
        "allowance.taxable",
        BOTH,
        K::Earning,
        E::Amount,
        true,
        true,
        false,
        &[],
        "allowanceTaxable",
    ),
    def(
        "reimbursement",
        BOTH,
        K::Reimbursement,
        E::Amount,
        true,
        true,
        true,
        &[],
        "reimbursement",
    ),
    def(
        "deduction.net",
        BOTH,
        K::Deduction,
        E::Amount,
        true,
        true,
        false,
        &[],
        "deductionNet",
    ),
    def(
        "advance",
        BOTH,
        K::Reimbursement,
        E::Amount,
        false,
        true,
        false,
        &[],
        "advance",
    ),
    def(
        "nl.travel_allowance",
        NL,
        K::Reimbursement,
        E::Amount,
        true,
        true,
        false,
        &[p("km_per_day", P::Number), p("days_per_month", P::Number)],
        "nlTravelAllowance",
    ),
    def(
        "nl.home_working_allowance",
        NL,
        K::Reimbursement,
        E::Days,
        true,
        true,
        false,
        &[],
        "nlHomeWorkingAllowance",
    ),
    def(
        "nl.company_car",
        NL,
        K::Earning,
        E::Params,
        true,
        false,
        false,
        &[
            req("list_price", P::Money),
            req("percent", P::Percent),
            p("zero_emission_cap", P::Money),
            p("zero_emission_percent", P::Percent),
            p("employee_contribution", P::Money),
        ],
        "nlCompanyCar",
    ),
    def(
        "nl.pension_employee",
        NL,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[p("percent", P::Percent), p("franchise_per_year", P::Money)],
        "nlPensionEmployee",
    ),
    def(
        "nl.pension_employer",
        NL,
        K::Employer,
        E::Amount,
        true,
        false,
        false,
        &[p("percent", P::Percent), p("franchise_per_year", P::Money)],
        "nlPensionEmployer",
    ),
    def(
        "nl.thirteenth_month",
        NL,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "nlThirteenthMonth",
    ),
    def(
        "nl.leave_payout",
        NL,
        K::Earning,
        E::Hours,
        false,
        true,
        false,
        &[],
        "nlLeavePayout",
    ),
    def(
        "nl.holiday_allowance_payout",
        NL,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "nlHolidayAllowancePayout",
    ),
    def(
        "nl.sick_pay",
        NL,
        K::Deduction,
        E::Hours,
        false,
        true,
        true,
        &[],
        "nlSickPay",
    ),
    def(
        "nl.transition_payment",
        NL,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "nlTransitionPayment",
    ),
    def(
        "us.tips_cash",
        US,
        K::Earning,
        E::Amount,
        false,
        true,
        false,
        &[],
        "usTipsCash",
    ),
    def(
        "us.401k",
        US,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[p("percent", P::Percent)],
        "us401k",
    ),
    def(
        "us.roth_401k",
        US,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[p("percent", P::Percent)],
        "usRoth401k",
    ),
    def(
        "us.401k_employer_match",
        US,
        K::Employer,
        E::Amount,
        true,
        false,
        false,
        &[
            p("match_percent", P::Percent),
            p("match_limit_percent", P::Percent),
        ],
        "us401kEmployerMatch",
    ),
    def(
        "us.section125_health",
        US,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[],
        "usSection125Health",
    ),
    def(
        "us.employer_health",
        US,
        K::Employer,
        E::Amount,
        true,
        false,
        false,
        &[],
        "usEmployerHealth",
    ),
    def(
        "us.hsa",
        US,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[],
        "usHsa",
    ),
    def(
        "us.dependent_care",
        US,
        K::Deduction,
        E::Amount,
        true,
        false,
        false,
        &[],
        "usDependentCare",
    ),
];

/// `componentDef(code)`.
pub fn component_def(code: &str) -> Option<&'static ComponentDef> {
    PAY_COMPONENTS.iter().find(|c| c.code == code)
}

/// `componentsFor(country, use)`: recurring (`true`) or one-off.
pub fn components_for(country: PayrollCountry, recurring: bool) -> Vec<&'static ComponentDef> {
    PAY_COMPONENTS
        .iter()
        .filter(|c| {
            c.countries.contains(&country) && if recurring { c.recurring } else { c.one_off }
        })
        .collect()
}
