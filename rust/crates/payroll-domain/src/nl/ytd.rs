//! Dutch year-to-date keys (`nl/ytd.ts`).

use crate::js::math_round;
use crate::money::Cents;
use crate::types::Ytd;

pub mod keys {
    pub const LOON_LB_PH: &str = "nl.loon_lb";
    pub const LOON_BB: &str = "nl.loon_bb";
    pub const LOON_SV: &str = "nl.loon_sv";
    pub const LOON_ZVW: &str = "nl.loon_zvw";
    pub const CASH_WAGE: &str = "nl.cash_wage";
    pub const IN_KIND_WAGE: &str = "nl.in_kind_wage";
    pub const GROSS: &str = "nl.gross";
    pub const NET: &str = "nl.net";
    pub const WAGE_TAX: &str = "nl.wage_tax";
    pub const LABOUR_CREDIT: &str = "nl.labour_credit";
    pub const ZVW_WITHHELD: &str = "nl.zvw_withheld";
    pub const ZVW_EMPLOYER_LEVY: &str = "nl.zvw_employer_levy";
    pub const AWF_PREMIUM: &str = "nl.awf_premium";
    pub const AOF_PREMIUM: &str = "nl.aof_premium";
    pub const WKO_PREMIUM: &str = "nl.wko_premium";
    pub const WHK_PREMIUM: &str = "nl.whk_premium";
    pub const AWF_CUM_WAGE: &str = "nl.awf_cum_wage";
    pub const AWF_CUM_MAX: &str = "nl.awf_cum_max";
    pub const AWF_CUM_BASE: &str = "nl.awf_cum_base";
    pub const AOF_CUM_WAGE: &str = "nl.aof_cum_wage";
    pub const AOF_CUM_MAX: &str = "nl.aof_cum_max";
    pub const AOF_CUM_BASE: &str = "nl.aof_cum_base";
    pub const WHK_CUM_WAGE: &str = "nl.whk_cum_wage";
    pub const WHK_CUM_MAX: &str = "nl.whk_cum_max";
    pub const WHK_CUM_BASE: &str = "nl.whk_cum_base";
    pub const ZVW_CUM_WAGE: &str = "nl.zvw_cum_wage";
    pub const ZVW_CUM_MAX: &str = "nl.zvw_cum_max";
    pub const ZVW_CUM_BASE: &str = "nl.zvw_cum_base";
    pub const HOLIDAY_ALLOWANCE_OPENING: &str = "nl.holiday_allowance_opening";
    pub const HOLIDAY_ALLOWANCE_ACCRUED: &str = "nl.holiday_allowance_accrued";
    pub const HOLIDAY_ALLOWANCE_PAID: &str = "nl.holiday_allowance_paid";
    pub const SPECIAL_REWARDS: &str = "nl.special_rewards";
    pub const TRANSITION_PAYMENT: &str = "nl.transition_payment";
    pub const PENSION_EMPLOYEE: &str = "nl.pension_employee";
    pub const PENSION_EMPLOYER: &str = "nl.pension_employer";
    pub const COMPANY_CAR_VALUE: &str = "nl.company_car_value";
    pub const COMPANY_CAR_CONTRIBUTION: &str = "nl.company_car_contribution";
    pub const TAX_FREE_ALLOWANCES: &str = "nl.tax_free_allowances";
    pub const EXPAT_ALLOWANCE: &str = "nl.expat_allowance";
    pub const TRAVEL_ALLOWANCE_TAX_FREE: &str = "nl.travel_allowance_tax_free";
    pub const OVERTIME_WAGE: &str = "nl.overtime_wage";
    pub const HOURS_PAID_X100: &str = "nl.hours_paid_x100";
    pub const SV_DAYS: &str = "nl.sv_days";
    pub const MONTHS_EMPLOYED_X10000: &str = "nl.months_employed_x10000";
    pub const EMPLOYER_COST: &str = "nl.employer_cost";
}

/// `ytdValue(ytd, key)`: 0 unless a finite number.
pub fn ytd_value(ytd: &Ytd, key: &str) -> f64 {
    ytd.get(key)
        .copied()
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

/// `nlHolidayAllowanceBalance(ytd)`.
pub fn nl_holiday_allowance_balance(ytd: &Ytd) -> Cents {
    ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_OPENING)
        + ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_ACCRUED)
        - ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_PAID)
}

/// `nlAnnualWageForSpecialRewards(previousYearYtd)`.
pub fn nl_annual_wage_for_special_rewards(previous_year_ytd: &Ytd) -> Option<Cents> {
    let wage = ytd_value(previous_year_ytd, keys::LOON_LB_PH);
    let months = ytd_value(previous_year_ytd, keys::MONTHS_EMPLOYED_X10000) / 10_000.0;
    if months <= 0.0 {
        return None;
    }
    if months >= 12.0 {
        return Some(wage);
    }
    Some(math_round((wage / months) * 12.0))
}
