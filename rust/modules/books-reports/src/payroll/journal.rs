//! The journal entry of one payroll (`services/payroll/journal.ts`): a CSV
//! row's or a Gusto payroll's totals as debits (wages, employer taxes and
//! benefits, reimbursements, owner's draw) and credits (withholdings,
//! deductions, liabilities, net pay), or a general-ledger export's rows. It
//! balances exactly when gross wages = net pay + employee taxes + employee
//! deductions; anything else is refused with the difference, never plugged.

use serde_json::{Value, json};
use weldsuite_books_domain::js::{math_round, number_value, to_fixed};
use weldsuite_books_domain::payroll::{AccountMapping, Resolver, category_label};
use weldsuite_books_domain::posting::{EntityAccounts, PostError, PostingLine};

/// `PayrollImportError`: the caller's data; a 400 like a posting error.
pub(crate) fn payroll_error(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

/// `PayrollTotals`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Totals {
    pub(crate) gross_wages: f64,
    pub(crate) employer_taxes: f64,
    pub(crate) employer_benefits: f64,
    pub(crate) reimbursements: f64,
    pub(crate) owners_draw: f64,
    pub(crate) employee_taxes: f64,
    pub(crate) employee_deductions: f64,
    pub(crate) net_pay: f64,
}

impl Totals {
    /// The fields in `emptyTotals()` order, by their TypeScript names.
    fn named(&self) -> [(&'static str, f64); 8] {
        [
            ("grossWages", self.gross_wages),
            ("employerTaxes", self.employer_taxes),
            ("employerBenefits", self.employer_benefits),
            ("reimbursements", self.reimbursements),
            ("ownersDraw", self.owners_draw),
            ("employeeTaxes", self.employee_taxes),
            ("employeeDeductions", self.employee_deductions),
            ("netPay", self.net_pay),
        ]
    }

    /// `summaryOf(totals)`: the category → amount record, in its key order.
    pub(crate) fn summary(&self) -> Vec<(&'static str, f64)> {
        vec![
            ("gross_wages", self.gross_wages),
            ("employer_taxes", self.employer_taxes),
            ("employer_benefits", self.employer_benefits),
            ("reimbursements", self.reimbursements),
            ("owners_draw", self.owners_draw),
            ("employee_taxes", self.employee_taxes),
            ("employee_deductions", self.employee_deductions),
            ("net_pay", self.net_pay),
        ]
    }

    pub(crate) fn summary_json(&self) -> Value {
        Value::Object(
            self.summary()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), number_value(v)))
                .collect(),
        )
    }
}

/// `cents(value)`: `Math.round(value * 100 ± 1e-9)`.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn cents(value: f64) -> i64 {
    math_round(value * 100.0 + if value >= 0.0 { 1e-9 } else { -1e-9 }) as i64
}

#[allow(clippy::cast_precision_loss)]
pub(crate) fn amount(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// `validateTotals(totals)`: numbers, not negative, balanced, not empty.
fn validate_totals(totals: &Totals) -> Result<(), PostError> {
    for (name, value) in totals.named() {
        if !value.is_finite() {
            return Err(payroll_error(format!("{name} is not a number")));
        }
        if value < 0.0 {
            return Err(payroll_error(format!("{name} cannot be negative")));
        }
    }
    let gross = cents(totals.gross_wages);
    let paid_out =
        cents(totals.net_pay) + cents(totals.employee_taxes) + cents(totals.employee_deductions);
    if gross != paid_out {
        return Err(payroll_error(format!(
            "The payroll does not balance: gross wages {} must equal net pay + employee taxes + employee deductions ({}); off by {}.",
            to_fixed(amount(gross), 2),
            to_fixed(amount(paid_out), 2),
            to_fixed(amount(gross - paid_out), 2)
        )));
    }
    if gross == 0 && cents(totals.owners_draw) == 0 {
        return Err(payroll_error("The payroll has no amounts"));
    }
    Ok(())
}

/// `LineBook`: lines per side and account, labels collected.
#[derive(Default)]
struct LineBook {
    entries: Vec<(bool, String, i64, Vec<&'static str>)>,
}

impl LineBook {
    fn add(&mut self, debit: bool, account_id: String, value: i64, label: &'static str) {
        if value == 0 {
            return;
        }
        match self
            .entries
            .iter_mut()
            .find(|(side, id, _, _)| *side == debit && *id == account_id)
        {
            Some(entry) => {
                entry.2 += value;
                if !entry.3.contains(&label) {
                    entry.3.push(label);
                }
            }
            None => self.entries.push((debit, account_id, value, vec![label])),
        }
    }

    fn lines(self, prefix: &str) -> Vec<PostingLine> {
        let mut lines: Vec<PostingLine> = self
            .entries
            .into_iter()
            .map(|(debit, account_id, value, labels)| PostingLine {
                account_id,
                debit: if debit { amount(value) } else { 0.0 },
                credit: if debit { 0.0 } else { amount(value) },
                description: Some(format!("{prefix}: {}", labels.join(", "))),
                ..PostingLine::default()
            })
            .collect();
        // Debits first, then credits (a stable sort).
        lines.sort_by_key(|line| line.debit <= 0.0);
        lines
    }
}

/// `buildPayrollLines(totals, accounts, mapping, label)`.
pub(crate) fn build_payroll_lines(
    totals: &Totals,
    accounts: &EntityAccounts,
    mapping: &AccountMapping,
    label: &str,
) -> Result<Vec<PostingLine>, PostError> {
    validate_totals(totals)?;
    let resolve = Resolver::new(accounts, mapping);
    let mut book = LineBook::default();
    // Accounts are only looked up for amounts that exist.
    for (category, value) in [
        ("gross_wages", totals.gross_wages),
        ("employer_taxes", totals.employer_taxes),
        ("employer_benefits", totals.employer_benefits),
        ("reimbursements", totals.reimbursements),
        ("owners_draw", totals.owners_draw),
    ] {
        if cents(value) != 0 {
            book.add(
                true,
                resolve.expense(category)?,
                cents(value),
                category_label(category),
            );
        }
    }
    for (category, liability, value) in [
        ("employee_taxes", "employee_taxes", totals.employee_taxes),
        (
            "employee_deductions",
            "employee_deductions",
            totals.employee_deductions,
        ),
        (
            "employer_taxes",
            "payroll_liabilities",
            totals.employer_taxes,
        ),
        (
            "employer_benefits",
            "payroll_liabilities",
            totals.employer_benefits,
        ),
    ] {
        if cents(value) != 0 {
            book.add(
                false,
                resolve.liability(liability)?,
                cents(value),
                category_label(category),
            );
        }
    }
    let cash = cents(totals.net_pay) + cents(totals.reimbursements) + cents(totals.owners_draw);
    if cash != 0 {
        book.add(false, resolve.cash()?, cash, category_label("net_pay"));
    }
    Ok(book.lines(label))
}

/// One row of a general-ledger export, its account resolved (`GlLine`).
#[derive(Debug, Clone)]
pub(crate) struct GlLine {
    pub(crate) account_id: String,
    pub(crate) debit: f64,
    pub(crate) credit: f64,
    pub(crate) memo: Option<String>,
    pub(crate) label: String,
}

/// `buildGlLines(rows, label)`: one payroll's rows, checked for balance.
pub(crate) fn build_gl_lines(rows: &[GlLine], label: &str) -> Result<Vec<PostingLine>, PostError> {
    let mut debit = 0;
    let mut credit = 0;
    let mut lines = Vec::new();
    for row in rows {
        let d = cents(row.debit);
        let c = cents(row.credit);
        if d < 0 || c < 0 {
            return Err(payroll_error("Debit and credit amounts cannot be negative"));
        }
        if d == 0 && c == 0 {
            continue;
        }
        debit += d;
        credit += c;
        lines.push(PostingLine {
            account_id: row.account_id.clone(),
            debit: if d > 0 { amount(d) } else { 0.0 },
            credit: if c > 0 { amount(c) } else { 0.0 },
            description: Some(match row.memo.as_deref().filter(|m| !m.is_empty()) {
                Some(memo) => format!("{label}: {memo}"),
                None => label.to_owned(),
            }),
            ..PostingLine::default()
        });
    }
    if lines.is_empty() {
        return Err(payroll_error("The payroll has no amounts"));
    }
    if debit != credit {
        return Err(payroll_error(format!(
            "The payroll does not balance: debits {}, credits {} (off by {})",
            to_fixed(amount(debit), 2),
            to_fixed(amount(credit), 2),
            to_fixed(amount(debit - credit), 2)
        )));
    }
    Ok(lines)
}

/// A line as the import result lists it: `{ accountId, debit, credit, description }`.
pub(crate) fn line_json(line: &PostingLine) -> Value {
    json!({
        "accountId": line.account_id,
        "debit": number_value(line.debit),
        "credit": number_value(line.credit),
        "description": line.description,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unbalanced_totals_are_refused_with_the_difference() {
        let totals = Totals {
            gross_wages: 100.0,
            net_pay: 90.0,
            ..Totals::default()
        };
        let error = validate_totals(&totals).expect_err("unbalanced");
        assert_eq!(
            error.to_string(),
            "The payroll does not balance: gross wages 100.00 must equal net pay + employee taxes + employee deductions (90.00); off by 10.00."
        );
    }
}
