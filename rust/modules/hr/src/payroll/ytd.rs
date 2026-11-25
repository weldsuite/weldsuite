//! Year-to-date chains (`services/weldhr/payroll/ytd.ts`). The accumulators
//! of an employee's payslips at one employer in one tax year form a chain:
//! each payslip starts from the accumulators of the one approved before it.
//! Approval order is the payslip number (`<year>-<seq>`), so the "latest"
//! payslip is the one with the highest number.
//!
//! Accumulators keep the key order JavaScript reads them in (the stored
//! `jsonb`'s): the US engine walks its open workweeks in that order.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::types::Ytd;
use weldsuite_payroll_domain::us::US_OT_CARRY_PREFIX;
use weldsuite_schema::tenant::hr_payslips;

use super::runs::payslip_rows;
use crate::HrError;

/// `numberKey(number)`: `2026-0007` → (2026, 7); `None` for a draft.
pub(crate) fn number_key(number: Option<&str>) -> Option<(i64, i64)> {
    let text = number?;
    let (year, seq) = text.split_once('-')?;
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    if year.len() != 4 || !digits(year) || !digits(seq) {
        return None;
    }
    Some((year.parse().ok()?, seq.parse().unwrap_or(i64::MAX)))
}

fn compare_numbers(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (number_key(a), number_key(b)) {
        (Some(ka), Some(kb)) => ka.cmp(&kb),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

fn number_of(row: &Value) -> Option<&str> {
    row["number"].as_str()
}

/// `compareNumberOrder(a, b)`: approval order, drafts last.
pub(crate) fn compare_number_order(a: &Value, b: &Value) -> Ordering {
    compare_numbers(number_of(a), number_of(b))
}

/// `latestByApproval(rows)`: the payslip approved last.
pub(crate) fn latest_by_approval(rows: &[Value]) -> Option<&Value> {
    let mut best: Option<&Value> = None;
    for row in rows {
        if best.is_none_or(|b| compare_numbers(number_of(row), number_of(b)) == Ordering::Greater) {
            best = Some(row);
        }
    }
    best
}

/// `approvedBefore(rows, number)`: oldest first.
pub(crate) fn approved_before(rows: &[Value], number: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = rows
        .iter()
        .filter(|r| compare_numbers(number_of(r), number) == Ordering::Less)
        .cloned()
        .collect();
    out.sort_by(compare_number_order);
    out
}

/// A stored accumulator object (`ytd_text`, …) in its stored key order.
pub(crate) fn ordered_ytd(text: Option<&str>) -> Ytd {
    text.and_then(|t| serde_json::from_str::<OrderedMap<f64>>(t).ok())
        .unwrap_or_default()
}

/// A payslip row's `ytd`, in stored key order.
pub(crate) fn ytd_of(row: &Value) -> Ytd {
    ordered_ytd(row["ytdText"].as_str())
}

/// `carriedOverYtd(previousYearTip)`: only the US engine's open workweeks
/// carry over into a new year.
pub(crate) fn carried_over_ytd(previous_year_tip: Option<&Value>) -> Ytd {
    let mut out = Ytd::new();
    if let Some(tip) = previous_year_tip {
        for (key, value) in ytd_of(tip).iter() {
            if key.starts_with(US_OT_CARRY_PREFIX) {
                out.insert(key.clone(), *value);
            }
        }
    }
    out
}

/// `finalPayslipsByEmployee(db, employeeIds, employerId, taxYear)`.
pub(crate) async fn final_payslips_by_employee(
    db: &PgPool,
    employee_ids: &[String],
    employer_id: &str,
    tax_year: i64,
) -> Result<HashMap<String, Vec<Value>>, HrError> {
    use hr_payslips::Column;
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let rows = payslip_rows(
        &orm(db),
        hr_payslips::Entity::find()
            .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
            .filter(Column::EmployerId.eq(employer_id))
            .filter(Column::TaxYear.eq(i32::try_from(tax_year).unwrap_or_default()))
            .filter(Column::Status.eq("final")),
    )
    .await?;
    for row in rows {
        let employee = row["employeeId"].as_str().unwrap_or("").to_owned();
        out.entry(employee).or_default().push(row);
    }
    Ok(out)
}

/// `employeesWithFinalPayslips(db, employeeIds, employerId)`.
pub(crate) async fn employees_with_final_payslips(
    db: &PgPool,
    employee_ids: &[String],
    employer_id: &str,
) -> Result<HashSet<String>, HrError> {
    use hr_payslips::Column;
    if employee_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = hr_payslips::Entity::find()
        .select_only()
        .column(Column::EmployeeId)
        .distinct()
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::EmployerId.eq(employer_id))
        .filter(Column::Status.eq("final"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}
