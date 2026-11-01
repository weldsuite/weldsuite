//! US payroll (`us/`).

pub mod calculate;
pub mod dates;
pub mod federal_rules;
pub mod forms;
pub mod overtime;
pub mod states;
pub mod withholding;
pub mod ytd;

pub use calculate::{calculate_us_payslip, workweek_end};
pub use federal_rules::{federal_rules, futa_credit_reduction_percent, supported_federal_years};
pub use overtime::workweek_start;
pub use ytd::{US_OT_CARRY_PREFIX, US_YTD_KEYS};
