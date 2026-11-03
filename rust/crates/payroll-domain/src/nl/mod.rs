//! Dutch payroll (`nl/`).

pub mod annual_statement;
pub mod calculate;
pub mod loonaangifte;
pub mod rules;
pub mod wage_tax;
pub mod xml;
pub mod ytd;

pub use calculate::{calculate_nl_payslip, nl_age_column, nl_aow_date};
pub use rules::{NlRuleSet, nl_rules_for_year, supported_nl_tax_years};
pub use ytd::{nl_annual_wage_for_special_rewards, nl_holiday_allowance_balance, ytd_value};
