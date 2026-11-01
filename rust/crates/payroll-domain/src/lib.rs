//! WeldSuite's payroll engines (NL and US), pay periods, payment files and
//! payslip documents: `@weldsuite/payroll-domain` (`packages/domains/payroll`).
//! Pure functions; no database.
//!
//! hr-api's payroll services (`weldsuite-hr`) use it. Every calculation
//! answers exactly as the TypeScript package does: amounts are JavaScript
//! numbers there, so they are `f64` here and each operation mirrors the
//! JavaScript one (`Math.round`, `toFixed`, `Date` arithmetic). The tests
//! run vectors the TypeScript code wrote (`tests/fixtures`), and the rule
//! and label tables are the TypeScript's own (`data/`), both written by
//! `pnpm rust:payroll-fixtures`.

// The engines are JavaScript arithmetic on doubles: casts between f64 and
// integers, exact float comparisons and long straight-line functions are
// the point, not an accident.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::float_cmp,
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::many_single_char_names,
    clippy::struct_excessive_bools,
    clippy::fn_params_excessive_bools,
    clippy::too_many_arguments,
    clippy::option_option,
    clippy::collapsible_if,
    clippy::single_match_else,
    clippy::if_not_else
)]

use std::fmt;

pub mod components;
pub mod documents;
pub mod js;
pub mod labels;
pub mod money;
pub mod nacha;
pub mod nl;
pub mod ordered;
pub mod payslip_pdf;
pub mod periods;
pub mod sepa;
pub mod types;
pub mod us;

pub use types::*;

/// What the TypeScript throws: an `Error` with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollError(pub String);

impl PayrollError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for PayrollError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PayrollError {}

/// `calculatePayslip(input)`.
pub fn calculate_payslip(input: &PayslipInput) -> Result<PayslipResult, PayrollError> {
    match input {
        PayslipInput::Nl(nl) => nl::calculate_nl_payslip(nl),
        PayslipInput::Us(us) => us::calculate_us_payslip(us),
    }
}
