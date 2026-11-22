//! Pay runs (`services/weldhr/payroll/runs.ts`): create, the people in them,
//! and the inputs that change pay (collected from attendance, leave,
//! absences and declarations, or typed).
//!
//!   draft → calculated → approved → paid
//!   draft | calculated → cancelled
//!
//! Any change to what a run pays (inputs, who is in it, the pay date) sends
//! a calculated run back to draft, so what was reviewed is what gets
//! approved.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Value, json};
use time::Date;
use weldsuite_db::{Keyring, OrmConn, PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::components::{ComponentEntry, component_def};
use weldsuite_payroll_domain::periods::{period_containing, weekdays_between};
use weldsuite_schema::tenant::{
    hr_absences, hr_attendance_records, hr_declarations, hr_employees, hr_leave_requests,
    hr_leave_types, hr_pay_run_inputs, hr_pay_runs, hr_pay_schedules, hr_payroll_employers,
    hr_payroll_profiles, hr_payslips,
};

use super::common::{
    BOOKS_NOT_ENABLED, decimal2, decimal4, is_iso_date, num, ranges_overlap, sort_issues,
};
use super::employees::{EmployeePayrollData, compensation_on, load_employee_payroll_data};
use super::employer_context::load_employer_for_payroll;
use super::employers::{
    country_of, last_completed_periods, next_period_of, require_employer_row, require_schedule_row,
    spec_of,
};
use super::schema::{has, str_of};
use super::ytd::number_key;
use crate::employees::display_name;
use crate::entity_scope::Scope;
use crate::shared::{iso_date, row_json, sql_date};
use crate::{HrError, add_days, js_round, locale_compare, member_names, today_iso};

pub(crate) const COLLECTED_SOURCES: [&str; 4] = ["attendance", "leave", "absence", "declaration"];
const RUN_CHANGED: &str =
    "This pay run was approved, cancelled or changed by someone else. Reload it and try again.";

/// A payslip as the payroll services read it: the entity's row (its money
/// columns as their `numeric(14, 2)` text, as Drizzle reads them) plus the
/// accumulators, filing data and snapshot as their stored `jsonb` text
/// (`ytdText`, `filingDataText`, `snapshotText`), which keeps the key order
/// JavaScript reads them in.
#[derive(FromQueryResult)]
struct PayslipRow {
    #[sea_orm(nested)]
    slip: hr_payslips::Model,
    ytd_text: String,
    filing_data_text: String,
    snapshot_text: String,
}

impl PayslipRow {
    fn json(self) -> Result<Value, DbErr> {
        let mut row = row_json(self.slip)?;
        if let Some(map) = row.as_object_mut() {
            map.insert("ytdText".to_owned(), Value::String(self.ytd_text));
            map.insert(
                "filingDataText".to_owned(),
                Value::String(self.filing_data_text),
            );
            map.insert("snapshotText".to_owned(), Value::String(self.snapshot_text));
        }
        Ok(row)
    }
}

/// `column::text`.
fn text_of(column: impl sea_orm::sea_query::IntoColumnRef) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::col(column).cast_as("text")
}

/// `payslips` (the entity's `find()` with its conditions and order) with the
/// `jsonb` text columns of [`PayslipRow`].
fn with_payslip_texts(payslips: Select<hr_payslips::Entity>) -> Select<hr_payslips::Entity> {
    use hr_payslips::{Column, Entity};
    payslips
        .column_as(text_of((Entity, Column::Ytd)), "ytd_text")
        .column_as(text_of((Entity, Column::FilingData)), "filing_data_text")
        .column_as(text_of((Entity, Column::Snapshot)), "snapshot_text")
}

/// The payslips `payslips` matches (`hr_payslips::Entity::find()` with its
/// conditions and order), as the payroll services read them: see
/// [`PayslipRow`].
pub(crate) async fn payslip_rows<C: ConnectionTrait>(
    db: &C,
    payslips: Select<hr_payslips::Entity>,
) -> Result<Vec<Value>, DbErr> {
    with_payslip_texts(payslips)
        .into_model::<PayslipRow>()
        .all(db)
        .await?
        .into_iter()
        .map(PayslipRow::json)
        .collect()
}

/// The first payslip `payslips` matches (`limit 1`), as [`payslip_rows`].
pub(crate) async fn payslip_row<C: ConnectionTrait>(
    db: &C,
    payslips: Select<hr_payslips::Entity>,
) -> Result<Option<Value>, DbErr> {
    with_payslip_texts(payslips)
        .into_model::<PayslipRow>()
        .one(db)
        .await?
        .map(PayslipRow::json)
        .transpose()
}

/// `$n::numeric` of a decimal text (`decimal2` / `decimal4`, or a column's
/// own text): what doesn't read as a number fails the statement, as Postgres
/// refused it.
fn sql_numeric(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text).map_err(|error| {
        DbErr::Type(format!(
            "invalid input syntax for type numeric: \"{text}\" ({error})"
        ))
    })
}

/// [`sql_numeric`] of an optional text (`null` stays NULL).
fn sql_numeric_opt(text: Option<&str>) -> Result<Option<BigDecimal>, DbErr> {
    text.map(sql_numeric).transpose()
}

/// [`sql_date`] of an optional text (`null` stays NULL).
fn sql_date_opt(text: Option<&str>) -> Result<Option<Date>, DbErr> {
    text.map(sql_date).transpose()
}

pub(crate) fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

pub(crate) fn int_of(row: &Value, key: &str) -> i64 {
    row[key]
        .as_i64()
        .unwrap_or_else(|| row[key].as_f64().map_or(0, |f| f as i64))
}

/// `requireRun(db, id)`.
pub(crate) async fn require_run(db: &PgPool, id: &str) -> Result<Value, HrError> {
    match hr_pay_runs::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
    {
        Some(row) => Ok(row_json(row)?),
        None => Err(HrError::not_found("Pay run", id)),
    }
}

/// `status in ('draft', 'calculated')`: the run is still open.
fn run_is_open() -> sea_orm::Condition {
    sea_orm::Condition::all().add(hr_pay_runs::Column::Status.is_in(["draft", "calculated"]))
}

/// `case when <also> and status = 'calculated' then 'draft' else status end`:
/// a calculated run goes back to draft.
fn back_to_draft() -> Expr {
    use hr_pay_runs::Column;
    Expr::case(Column::Status.eq("calculated"), "draft")
        .finally(Expr::col(Column::Status))
        .into()
}

/// `assertEditable(run)`.
pub(crate) fn assert_editable(run: &Value) -> Result<(), HrError> {
    let status = s(run, "status");
    if status != "draft" && status != "calculated" {
        return Err(HrError::conflict(format!(
            "This pay run is {status} and can no longer be changed"
        )));
    }
    Ok(())
}

/// `touchRun(db, runId)`: a calculated run goes back to draft; 409 when the
/// run is no longer open.
pub(crate) async fn touch_run(db: &PgPool, run_id: &str) -> Result<(), HrError> {
    let touched = hr_pay_runs::Entity::update_many()
        .col_expr(hr_pay_runs::Column::Status, back_to_draft())
        .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_pay_runs::Column::Id.eq(run_id))
        .filter(run_is_open())
        .exec(&orm(db))
        .await?;
    if touched.rows_affected == 0 {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    Ok(())
}

/// `profileWindow(profile, employee)`.
pub(crate) fn profile_window(
    profile: &Value,
    employee: &Value,
) -> (Option<String>, Option<String>) {
    let pick = |key: &str| {
        profile[key]
            .as_str()
            .or_else(|| employee[key].as_str())
            .map(str::to_owned)
    };
    (pick("startDate"), pick("endDate"))
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `candidateEmployeeIds(db, run)`.
pub(crate) async fn candidate_employee_ids(
    db: &PgPool,
    run: &Value,
) -> Result<Vec<String>, HrError> {
    if run["kind"] != "regular" {
        return Ok(string_list(&run["includedEmployeeIds"]));
    }
    let Some(schedule) = run["payScheduleId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(vec![]);
    };
    let rows: Vec<(
        String,
        Option<Date>,
        Option<Date>,
        Option<Date>,
        Option<Date>,
    )> = hr_payroll_profiles::Entity::find()
        .select_only()
        .columns([
            hr_payroll_profiles::Column::EmployeeId,
            hr_payroll_profiles::Column::StartDate,
            hr_payroll_profiles::Column::EndDate,
        ])
        .column(hr_employees::Column::StartDate)
        .column(hr_employees::Column::EndDate)
        .join(JoinType::InnerJoin, profile_employee())
        .filter(hr_payroll_profiles::Column::PayScheduleId.eq(schedule))
        .filter(hr_payroll_profiles::Column::Status.eq("active"))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, start, end, employee_start, employee_end)| {
            // `profileWindow(profile, employee)`.
            let start = start.or(*employee_start).map(iso_date);
            let end = end.or(*employee_end).map(iso_date);
            ranges_overlap(
                start.as_deref().unwrap_or("0001-01-01"),
                end.as_deref(),
                s(run, "periodStart"),
                Some(s(run, "periodEnd")),
            )
        })
        .map(|(id, ..)| id)
        .collect())
}

/// `join(hrEmployees, eq(hrEmployees.id, hrPayrollProfiles.employeeId))`.
fn profile_employee() -> sea_orm::RelationDef {
    hr_payroll_profiles::Entity::belongs_to(hr_employees::Entity)
        .from(hr_payroll_profiles::Column::EmployeeId)
        .to(hr_employees::Column::Id)
        .into()
}

/// `includedEmployeeIds(db, run)`.
pub(crate) async fn included_employee_ids(
    db: &PgPool,
    run: &Value,
) -> Result<Vec<String>, HrError> {
    let excluded: HashSet<String> = string_list(&run["excludedEmployeeIds"])
        .into_iter()
        .collect();
    Ok(candidate_employee_ids(db, run)
        .await?
        .into_iter()
        .filter(|id| !excluded.contains(id))
        .collect())
}

/// `countIssues(issues)`.
fn count_issues(issues: &Value) -> (usize, usize) {
    let list = issues.as_array().map(Vec::as_slice).unwrap_or_default();
    let errors = list.iter().filter(|i| i["severity"] == "error").count();
    (errors, list.len() - errors)
}

fn issues_of(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// `toRunDtos(db, rows)`.
pub(crate) async fn to_run_dtos(db: &PgPool, rows: &[Value]) -> Result<Vec<Value>, HrError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let employer_ids: Vec<String> = rows.iter().map(|r| s(r, "employerId").to_owned()).collect();
    let schedule_ids: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            r["payScheduleId"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        })
        .collect();
    let employers: HashMap<String, String> = hr_payroll_employers::Entity::find()
        .select_only()
        .columns([
            hr_payroll_employers::Column::Id,
            hr_payroll_employers::Column::Name,
        ])
        .filter(hr_payroll_employers::Column::Id.is_in(employer_ids))
        .into_tuple::<(String, String)>()
        .all(&orm(db))
        .await?
        .into_iter()
        .collect();
    let schedules: HashMap<String, String> = if schedule_ids.is_empty() {
        HashMap::new()
    } else {
        hr_pay_schedules::Entity::find()
            .select_only()
            .columns([hr_pay_schedules::Column::Id, hr_pay_schedules::Column::Name])
            .filter(hr_pay_schedules::Column::Id.is_in(schedule_ids))
            .into_tuple::<(String, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
            .collect()
    };
    let users: Vec<Option<&str>> = rows
        .iter()
        .flat_map(|r| {
            [
                r["preparedBy"].as_str(),
                r["calculatedBy"].as_str(),
                r["approvedBy"].as_str(),
            ]
        })
        .collect();
    let names = member_names(db, &users).await?;
    let name_of = |id: &Value| -> Value {
        id.as_str()
            .filter(|v| !v.is_empty())
            .map_or(Value::Null, |id| {
                names.get(id).map_or(Value::Null, |n| json!(n))
            })
    };
    Ok(rows
        .iter()
        .map(|row| {
            let (errors, warnings) = count_issues(&row["issues"]);
            let schedule = row["payScheduleId"].as_str().filter(|v| !v.is_empty());
            // A journal skipped because the legal entity has no WeldBooks: a reason, not an error.
            let books_not_enabled = row["journalError"] == BOOKS_NOT_ENABLED;
            json!({
                "id": row["id"],
                "employerId": row["employerId"],
                "employerName": employers.get(s(row, "employerId")).cloned().unwrap_or_default(),
                "payScheduleId": row["payScheduleId"],
                "payScheduleName": schedule.and_then(|id| schedules.get(id).cloned()),
                "country": row["country"],
                "currency": row["currency"],
                "kind": row["kind"],
                "correctsRunId": row["correctsRunId"],
                "periodStart": row["periodStart"],
                "periodEnd": row["periodEnd"],
                "payDate": row["payDate"],
                "taxYear": row["taxYear"],
                "periodNumber": row["periodNumber"],
                "status": row["status"],
                "employeeCount": row["employeeCount"],
                "totals": row["totals"],
                "issues": sort_issues(issues_of(&row["issues"])),
                "errorCount": errors,
                "warningCount": warnings,
                "notes": row["notes"],
                "preparedBy": row["preparedBy"],
                "preparedByName": name_of(&row["preparedBy"]),
                "calculatedAt": row["calculatedAt"],
                "calculatedByName": name_of(&row["calculatedBy"]),
                "approvedAt": row["approvedAt"],
                "approvedByName": name_of(&row["approvedBy"]),
                "paidAt": row["paidAt"],
                "journalStatus": row["journalStatus"],
                "journalEntryId": row["journalEntryId"],
                "journalError": if books_not_enabled { Value::Null } else { row["journalError"].clone() },
                "journalReason": if books_not_enabled { json!(BOOKS_NOT_ENABLED) } else { Value::Null },
                "createdAt": row["createdAt"],
                "updatedAt": row["updatedAt"],
            })
        })
        .collect())
}

/// `previousNetPay(db, run, employeeIds)`: net pay of each employee's
/// previous final payslip, for the variance column.
async fn previous_net_pay(
    db: &PgPool,
    run: &Value,
    employee_ids: &[String],
) -> Result<HashMap<String, String>, HrError> {
    use hr_payslips::{Column, Entity};
    let mut out = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String)> = Entity::find()
        .select_only()
        .column(Column::EmployeeId)
        .column_as(text_of((Entity, Column::NetPay)), "net_pay")
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::EmployerId.eq(s(run, "employerId")))
        .filter(Column::Status.eq("final"))
        .filter(Column::CorrectsPayslipId.is_null())
        .filter(Column::RunId.ne(s(run, "id")))
        .filter(Column::PeriodEnd.lt(sql_date(s(run, "periodEnd"))?))
        .order_by_desc(Column::PeriodEnd)
        .order_by_desc(Column::PayDate)
        .into_tuple()
        .all(&orm(db))
        .await?;
    for (employee, net) in rows {
        out.entry(employee).or_insert(net);
    }
    Ok(out)
}

/// The display names of employees by id.
pub(crate) async fn employee_names(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, String>, HrError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(employee_name_rows(db, ids).await?.into_iter().collect())
}

/// The employees `ids` with their display names, in the database's order.
async fn employee_name_rows(db: &PgPool, ids: &[String]) -> Result<Vec<(String, String)>, DbErr> {
    let rows: Vec<(String, String, String, Option<String>)> = hr_employees::Entity::find()
        .select_only()
        .columns([
            hr_employees::Column::Id,
            hr_employees::Column::FirstName,
            hr_employees::Column::LastName,
            hr_employees::Column::PreferredName,
        ])
        .filter(hr_employees::Column::Id.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, first, last, preferred)| {
            let name = display_name(&first, &last, preferred.as_deref());
            (id, name)
        })
        .collect())
}

/// `payslipSummaries(db, run, rows)`.
pub(crate) async fn payslip_summaries(
    db: &PgPool,
    run: &Value,
    rows: &[Value],
) -> Result<Vec<Value>, HrError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = rows.iter().map(|r| s(r, "employeeId").to_owned()).collect();
    let names = employee_names(db, &ids).await?;
    let previous = previous_net_pay(db, run, &ids).await?;
    let mut out: Vec<(String, Value)> = rows
        .iter()
        .map(|row| {
            let name = names.get(s(row, "employeeId")).cloned().unwrap_or_default();
            (
                name.clone(),
                json!({
                    "id": row["id"],
                    "employeeId": row["employeeId"],
                    "employeeName": name,
                    "status": row["status"],
                    "number": row["number"],
                    "grossPay": row["grossPay"],
                    "employeeTaxes": row["employeeTaxes"],
                    "netPay": row["netPay"],
                    "employerCost": row["employerCost"],
                    "issues": sort_issues(issues_of(&row["issues"])),
                    "previousNetPay": previous.get(s(row, "employeeId")),
                    "runId": row["runId"],
                    "periodStart": row["periodStart"],
                    "periodEnd": row["periodEnd"],
                    "payDate": row["payDate"],
                    "currency": row["currency"],
                    "employeeDeductions": row["employeeDeductions"],
                    "reimbursements": row["reimbursements"],
                }),
            )
        })
        .collect();
    out.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

/// `fourEyesBlocks(employer, run, userId)`.
pub(crate) fn four_eyes_blocks(employer: Option<&Value>, run: &Value, user_id: &str) -> bool {
    employer.is_some_and(|e| e["requireSeparateApprover"] == true)
        && run["calculatedBy"]
            .as_str()
            .is_some_and(|by| !by.is_empty() && by == user_id)
}

/// `getRunDetail(db, id, { userId })`.
pub(crate) async fn get_run_detail(db: &PgPool, id: &str, user_id: &str) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    let mut dto = to_run_dtos(db, std::slice::from_ref(&run)).await?.remove(0);
    let employer = require_employer_row(db, s(&run, "employerId")).await.ok();
    let candidates = candidate_employee_ids(db, &run).await?;
    let people: Vec<(String, String)> = if candidates.is_empty() {
        vec![]
    } else {
        employee_name_rows(db, &candidates).await?
    };
    let excluded: HashSet<String> = string_list(&run["excludedEmployeeIds"])
        .into_iter()
        .collect();
    let slips = payslip_rows(
        &orm(db),
        hr_payslips::Entity::find().filter(hr_payslips::Column::RunId.eq(id)),
    )
    .await?;
    let blocks = four_eyes_blocks(employer.as_ref(), &run, user_id);
    let run_issues = issues_of(&run["issues"]);
    let mut employees: Vec<(String, Value)> = people
        .iter()
        .map(|(pid, name)| {
            let pid = pid.as_str();
            let issues: Vec<&Value> = run_issues.iter().filter(|i| i["employeeId"] == pid).collect();
            (
                name.clone(),
                json!({ "employeeId": pid, "displayName": name, "excluded": excluded.contains(pid), "issues": issues }),
            )
        })
        .collect();
    employees.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let status = s(&run, "status");
    let has_error = run_issues.iter().any(|i| i["severity"] == "error");
    if let Some(map) = dto.as_object_mut() {
        map.insert(
            "employees".into(),
            Value::Array(employees.into_iter().map(|(_, v)| v).collect()),
        );
        map.insert(
            "payslips".into(),
            Value::Array(payslip_summaries(db, &run, &slips).await?),
        );
        map.insert(
            "canApprove".into(),
            json!(status == "calculated" && !has_error && !blocks),
        );
        map.insert(
            "paymentFile".into(),
            json!({
                "format": if run["country"] == "NL" { "sepa" } else { "nacha" },
                "available": status == "approved" || status == "paid",
            }),
        );
    }
    Ok(dto)
}

/// `listRuns(db, filters)`.
pub(crate) async fn list_runs(
    db: &PgPool,
    employer_id: Option<&str>,
    status: Option<&str>,
    year: Option<f64>,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    use hr_pay_runs::Column;
    let statuses: Option<Vec<String>> = status
        .filter(|v| !v.is_empty())
        .map(|v| v.split(',').map(str::to_owned).collect());
    let mut runs = hr_pay_runs::Entity::find().filter(scope.employer_id_in(Column::EmployerId));
    if let Some(employer_id) = employer_id.filter(|v| !v.is_empty()) {
        runs = runs.filter(Column::EmployerId.eq(employer_id));
    }
    if let Some(statuses) = statuses {
        runs = runs.filter(Column::Status.is_in(statuses));
    }
    if let Some(year) = year.filter(|y| *y != 0.0) {
        runs = runs.filter(Column::TaxYear.eq(year as i32));
    }
    let rows = runs
        .order_by_desc(Column::PeriodStart)
        .order_by_desc(Column::CreatedAt)
        .limit(500)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    to_run_dtos(db, &rows).await
}

// ── create / update / cancel ────────────────────────────────────────────────

async fn employees_with_profile(
    db: &PgPool,
    employer_id: &str,
    ids: &[String],
) -> Result<Vec<Value>, HrError> {
    let rows = hr_payroll_profiles::Entity::find()
        .filter(hr_payroll_profiles::Column::EmployeeId.is_in(ids.iter().map(String::as_str)))
        .filter(hr_payroll_profiles::Column::EmployerId.eq(employer_id))
        .filter(hr_payroll_profiles::Column::Status.ne("ended"))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    let found: HashSet<&str> = rows.iter().map(|r| s(r, "employeeId")).collect();
    let missing: Vec<&String> = ids
        .iter()
        .filter(|id| !found.contains(id.as_str()))
        .collect();
    if !missing.is_empty() {
        return Err(HrError::Validation {
            message: "Some employees are not on this employer's payroll".into(),
            details: Some(json!({ "employeeIds": missing })),
        });
    }
    Ok(rows)
}

fn engine(error: &weldsuite_payroll_domain::PayrollError) -> HrError {
    HrError::internal(error.to_string())
}

fn year_of(date: &str) -> i64 {
    date.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

/// `usNumbering(schedule, natural, payDate)`.
fn us_numbering(
    schedule: &Value,
    natural_start: &str,
    natural_tax_year: i64,
    natural_number: i64,
    pay_date: &str,
) -> Result<(i64, i64), HrError> {
    let tax_year = year_of(pay_date);
    if tax_year == natural_tax_year {
        return Ok((tax_year, natural_number));
    }
    if tax_year > natural_tax_year {
        return Ok((tax_year, 1));
    }
    let previous = period_containing(
        &spec_of(schedule),
        country_of("US"),
        &add_days(natural_start, -1),
    )
    .map_err(|e| engine(&e))?;
    Ok((
        tax_year,
        if previous.tax_year == tax_year {
            previous.period_number + 1
        } else {
            1
        },
    ))
}

fn assert_nl_paid_in_period_year(period_start: &str, pay_date: &str) -> Result<(), HrError> {
    if pay_date.get(0..4) != period_start.get(0..4) {
        return Err(HrError::validation(
            "A Dutch pay run must be paid in the calendar year of its period",
        ));
    }
    Ok(())
}

/// `assertCorrectionInYear(taxYear, payDate)`.
pub(crate) fn assert_correction_in_year(tax_year: i64, pay_date: &str) -> Result<(), HrError> {
    if year_of(pay_date) != tax_year {
        return Err(HrError::Payroll {
            code: "CORRECTION_CROSSES_YEAR".into(),
            message: format!(
                "A correction must be paid in the calendar year of the period it corrects ({tax_year}). Corrections across a year boundary are not supported yet; the earlier year's returns and statements have to be corrected outside WeldSuite."
            ),
            status: 409,
            details: Some(json!({ "taxYear": tax_year, "payDate": pay_date })),
        });
    }
    Ok(())
}

/// `numberingForPayDate(db, run, payDate)`.
async fn numbering_for_pay_date(
    db: &PgPool,
    run: &Value,
    pay_date: &str,
) -> Result<(i64, i64), HrError> {
    let (tax_year, number) = (int_of(run, "taxYear"), int_of(run, "periodNumber"));
    if run["kind"] == "correction" {
        assert_correction_in_year(tax_year, pay_date)?;
        return Ok((tax_year, number));
    }
    if run["country"] == "NL" {
        assert_nl_paid_in_period_year(s(run, "periodStart"), pay_date)?;
        return Ok((tax_year, number));
    }
    let schedule = match run["payScheduleId"].as_str().filter(|v| !v.is_empty()) {
        Some(id) => require_schedule_row(db, id).await.ok(),
        None => None,
    };
    let Some(schedule) = schedule else {
        let year = year_of(pay_date);
        return Ok((year, if year == tax_year { number } else { 1 }));
    };
    let natural = period_containing(&spec_of(&schedule), country_of("US"), s(run, "periodStart"))
        .map_err(|e| engine(&e))?;
    us_numbering(
        &schedule,
        &natural.start,
        natural.tax_year,
        natural.period_number,
        pay_date,
    )
}

/// `createRun(db, input, { userId })`.
pub(crate) async fn create_run(
    db: &PgPool,
    input: &Value,
    user_id: &str,
) -> Result<Value, HrError> {
    let employer_id = str_of(input, "employerId").unwrap_or("");
    require_employer_row(db, employer_id).await?;
    let employer = load_employer_for_payroll(db, employer_id, &Keyring::default())
        .await?
        .row;
    if employer["isActive"] != true {
        return Err(HrError::validation("This employer is not active"));
    }
    let kind = str_of(input, "kind").unwrap_or("regular");
    let country = s(&employer, "country").to_owned();
    if kind == "correction" {
        return create_correction_run(db, input, &employer, user_id).await;
    }
    let schedule: Option<Value>;
    let (period_start, period_end, pay_date, mut tax_year, mut period_number);
    let mut included: Option<Vec<String>> = None;
    if kind == "regular" {
        let row = require_schedule_row(db, str_of(input, "payScheduleId").unwrap_or("")).await?;
        if row["employerId"] != employer["id"] {
            return Err(HrError::validation(
                "The pay schedule belongs to another employer",
            ));
        }
        if row["isActive"] != true {
            return Err(HrError::validation("This pay schedule is not active"));
        }
        let period = if let Some(start) = str_of(input, "periodStart") {
            let period = period_containing(&spec_of(&row), country_of(&country), start)
                .map_err(|e| engine(&e))?;
            if period.start != start {
                return Err(HrError::validation(format!(
                    "periodStart must be the first day of a pay period ({})",
                    period.start
                )));
            }
            if let Some(end) = str_of(input, "periodEnd")
                && end != period.end
            {
                return Err(HrError::validation(format!(
                    "periodEnd must be the last day of the pay period ({})",
                    period.end
                )));
            }
            weldsuite_payroll_domain::js::to_value(&period)
        } else {
            let last = last_completed_periods(db, &[s(&row, "id").to_owned()])
                .await?
                .remove(s(&row, "id"));
            next_period_of(&row, &country, last.as_ref())
                .ok_or_else(|| HrError::internal("no next pay period"))?
        };
        period_start = s(&period, "start").to_owned();
        period_end = s(&period, "end").to_owned();
        pay_date = str_of(input, "payDate")
            .unwrap_or(s(&period, "payDate"))
            .to_owned();
        tax_year = int_of(&period, "taxYear");
        period_number = int_of(&period, "periodNumber");
        if let Some(wanted) = str_of(input, "payDate")
            && wanted != s(&period, "payDate")
        {
            if country == "NL" {
                assert_nl_paid_in_period_year(&period_start, &pay_date)?;
            } else {
                (tax_year, period_number) =
                    us_numbering(&row, &period_start, tax_year, period_number, &pay_date)?;
            }
        }
        schedule = Some(row);
    } else {
        let (Some(start), Some(end), Some(date)) = (
            str_of(input, "periodStart"),
            str_of(input, "periodEnd"),
            str_of(input, "payDate"),
        ) else {
            return Err(HrError::validation(
                "An off-cycle run needs its period and pay date",
            ));
        };
        let ids = super::common::string_array(&input["employeeIds"]);
        if ids.is_empty() {
            return Err(HrError::validation(
                "An off-cycle run needs the employees it pays",
            ));
        }
        if end < start {
            return Err(HrError::validation("The period ends before it starts"));
        }
        let profiles = employees_with_profile(db, s(&employer, "id"), &ids).await?;
        let mut unique: Vec<String> = vec![];
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        included = Some(unique);
        period_start = start.to_owned();
        period_end = end.to_owned();
        pay_date = date.to_owned();
        if country == "NL" && pay_date.get(0..4) != period_start.get(0..4) {
            return Err(HrError::validation(
                "A Dutch off-cycle run must be paid in the year of its period",
            ));
        }
        let schedule_id = str_of(input, "payScheduleId")
            .map(str::to_owned)
            .or_else(|| {
                profiles.iter().find_map(|p| {
                    p["payScheduleId"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned)
                })
            });
        schedule = match schedule_id {
            Some(id) => require_schedule_row(db, &id).await.ok(),
            None => None,
        };
        if let Some(row) = &schedule {
            let period = period_containing(&spec_of(row), country_of(&country), &period_start)
                .map_err(|e| engine(&e))?;
            (tax_year, period_number) = if country == "US" {
                us_numbering(
                    row,
                    &period.start,
                    period.tax_year,
                    period.period_number,
                    &pay_date,
                )?
            } else {
                (period.tax_year, period.period_number)
            };
        } else {
            tax_year = year_of(if country == "NL" {
                &period_start
            } else {
                &pay_date
            });
            period_number = if country == "NL" {
                period_start
                    .get(5..7)
                    .and_then(|m| m.parse().ok())
                    .unwrap_or(1)
            } else {
                1
            };
        }
    }
    let id = generate_id("hrpr");
    let schedule_id = schedule.as_ref().map(|r| s(r, "id").to_owned());
    let inserted = insert_run(
        db,
        hr_pay_runs::ActiveModel {
            id: Set(id.clone()),
            employer_id: Set(s(&employer, "id").to_owned()),
            pay_schedule_id: Set(schedule_id.clone()),
            country: Set(country.clone()),
            currency: Set(s(&employer, "currency").to_owned()),
            kind: Set(kind.to_owned()),
            tax_year: Set(i32::try_from(tax_year).unwrap_or_default()),
            period_number: Set(i32::try_from(period_number).unwrap_or_default()),
            status: Set("draft".to_owned()),
            included_employee_ids: Set(included.as_ref().map(|ids| json!(ids))),
            notes: Set(str_of(input, "notes").map(str::to_owned)),
            prepared_by: Set(Some(user_id.to_owned())),
            ..Default::default()
        },
        [&period_start, &period_end, &pay_date],
    )
    .await;
    if let Err(error) = inserted {
        if weldsuite_db::is_unique_violation(&error) {
            let existing = existing_regular_run(db, schedule_id.as_deref(), &period_start).await?;
            let suffix = existing.map(|id| format!(" ({id})")).unwrap_or_default();
            return Err(HrError::conflict(format!(
                "A pay run for {period_start} - {period_end} already exists{suffix}"
            )));
        }
        return Err(error.into());
    }
    let run = require_run(db, &id).await?;
    let count = candidate_employee_ids(db, &run).await?.len();
    hr_pay_runs::Entity::update_many()
        .col_expr(
            hr_pay_runs::Column::EmployeeCount,
            Expr::value(i32::try_from(count).unwrap_or_default()),
        )
        .filter(hr_pay_runs::Column::Id.eq(id.as_str()))
        .exec(&orm(db))
        .await?;
    let mut run = run;
    run["employeeCount"] = json!(count);
    Ok(run)
}

/// `insert into hr_pay_runs`, the period and pay date (`$n::date`) as
/// texts.
async fn insert_run(
    db: &PgPool,
    mut run: hr_pay_runs::ActiveModel,
    [period_start, period_end, pay_date]: [&str; 3],
) -> Result<(), DbErr> {
    run.period_start = Set(sql_date(period_start)?);
    run.period_end = Set(sql_date(period_end)?);
    run.pay_date = Set(sql_date(pay_date)?);
    hr_pay_runs::Entity::insert(run)
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// The open regular run of the schedule's period that refused a new one.
async fn existing_regular_run(
    db: &PgPool,
    schedule_id: Option<&str>,
    period_start: &str,
) -> Result<Option<String>, DbErr> {
    use hr_pay_runs::Column;
    // `pay_schedule_id = null` matches nothing.
    let Some(schedule_id) = schedule_id else {
        return Ok(None);
    };
    hr_pay_runs::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::PayScheduleId.eq(schedule_id))
        .filter(Column::PeriodStart.eq(sql_date(period_start)?))
        .filter(Column::Kind.eq("regular"))
        .filter(Column::Status.ne("cancelled"))
        .into_tuple()
        .one(&orm(db))
        .await
}

async fn create_correction_run(
    db: &PgPool,
    input: &Value,
    employer: &Value,
    user_id: &str,
) -> Result<Value, HrError> {
    let corrected = require_run(db, str_of(input, "correctsRunId").unwrap_or("")).await?;
    if corrected["employerId"] != employer["id"] {
        return Err(HrError::validation(
            "The corrected run belongs to another employer",
        ));
    }
    if corrected["kind"] == "correction" {
        return Err(HrError::validation(
            "Correct the original run, not a correction",
        ));
    }
    if corrected["status"] != "approved" && corrected["status"] != "paid" {
        return Err(HrError::conflict(
            "Only an approved or paid run can be corrected. Change a draft run directly.",
        ));
    }
    let corrected_id = s(&corrected, "id");
    let originals: Vec<String> = hr_payslips::Entity::find()
        .select_only()
        .column(hr_payslips::Column::EmployeeId)
        .filter(hr_payslips::Column::RunId.eq(corrected_id))
        .filter(hr_payslips::Column::Status.eq("final"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let eligible: HashSet<&String> = originals.iter().collect();
    let wanted = super::common::string_array(&input["employeeIds"]);
    let source: Vec<String> = if wanted.is_empty() {
        originals.clone()
    } else {
        wanted
    };
    let mut selected: Vec<String> = vec![];
    for id in source {
        if !selected.contains(&id) {
            selected.push(id);
        }
    }
    if selected.is_empty() {
        return Err(HrError::validation(
            "There are no payslips to correct in that run",
        ));
    }
    let not_in_run: Vec<&String> = selected
        .iter()
        .filter(|id| !eligible.contains(id))
        .collect();
    if !not_in_run.is_empty() {
        return Err(HrError::Validation {
            message: "Some employees have no payslip in the corrected run".into(),
            details: Some(json!({ "employeeIds": not_in_run })),
        });
    }
    let open: Vec<Option<Value>> = hr_pay_runs::Entity::find()
        .select_only()
        .column(hr_pay_runs::Column::IncludedEmployeeIds)
        .filter(hr_pay_runs::Column::CorrectsRunId.eq(corrected_id))
        .filter(run_is_open())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let busy: HashSet<String> = open.iter().flatten().flat_map(string_list).collect();
    if selected.iter().any(|id| busy.contains(id)) {
        return Err(HrError::conflict(
            "Another open correction run already covers some of these employees",
        ));
    }
    let pay_date = str_of(input, "payDate").map_or_else(today_iso, str::to_owned);
    assert_correction_in_year(int_of(&corrected, "taxYear"), &pay_date)?;
    let id = generate_id("hrpr");
    insert_run(
        db,
        hr_pay_runs::ActiveModel {
            id: Set(id.clone()),
            employer_id: Set(s(employer, "id").to_owned()),
            pay_schedule_id: Set(corrected["payScheduleId"].as_str().map(str::to_owned)),
            country: Set(s(&corrected, "country").to_owned()),
            currency: Set(s(&corrected, "currency").to_owned()),
            kind: Set("correction".to_owned()),
            corrects_run_id: Set(Some(corrected_id.to_owned())),
            tax_year: Set(i32::try_from(int_of(&corrected, "taxYear")).unwrap_or_default()),
            period_number: Set(
                i32::try_from(int_of(&corrected, "periodNumber")).unwrap_or_default()
            ),
            status: Set("draft".to_owned()),
            employee_count: Set(i32::try_from(selected.len()).unwrap_or_default()),
            included_employee_ids: Set(Some(json!(selected))),
            notes: Set(str_of(input, "notes").map(str::to_owned)),
            prepared_by: Set(Some(user_id.to_owned())),
            ..Default::default()
        },
        [
            s(&corrected, "periodStart"),
            s(&corrected, "periodEnd"),
            &pay_date,
        ],
    )
    .await?;
    // Start from the inputs that produced each payslip as it stands.
    let original_slips: Vec<(String, String)> = hr_payslips::Entity::find()
        .select_only()
        .columns([hr_payslips::Column::Id, hr_payslips::Column::EmployeeId])
        .filter(hr_payslips::Column::RunId.eq(corrected_id))
        .filter(hr_payslips::Column::Status.eq("final"))
        .filter(hr_payslips::Column::EmployeeId.is_in(selected.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let prior: Vec<(String, String, Option<String>)> = if original_slips.is_empty() {
        vec![]
    } else {
        hr_payslips::Entity::find()
            .select_only()
            .columns([
                hr_payslips::Column::EmployeeId,
                hr_payslips::Column::RunId,
                hr_payslips::Column::Number,
            ])
            .filter(
                hr_payslips::Column::CorrectsPayslipId
                    .is_in(original_slips.iter().map(|(id, _)| id.as_str())),
            )
            .filter(hr_payslips::Column::Status.eq("final"))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let mut source_run_of: Vec<(String, String)> = vec![];
    for employee in &selected {
        let mut candidates: Vec<&(String, String, Option<String>)> =
            prior.iter().filter(|(e, _, _)| e == employee).collect();
        candidates.sort_by(|x, y| {
            let seq = |n: &Option<String>| number_key(n.as_deref()).map_or(0, |(_, s)| s);
            seq(&y.2).cmp(&seq(&x.2))
        });
        let source = candidates
            .first()
            .map_or_else(|| corrected_id.to_owned(), |c| c.1.clone());
        source_run_of.push((employee.clone(), source));
    }
    let mut source_runs: Vec<String> = vec![];
    for (_, run) in &source_run_of {
        if !source_runs.contains(run) {
            source_runs.push(run.clone());
        }
    }
    let originals = hr_pay_run_inputs::Entity::find()
        .filter(hr_pay_run_inputs::Column::RunId.is_in(source_runs.iter().map(String::as_str)))
        .all(&orm(db))
        .await?;
    let copies: Vec<hr_pay_run_inputs::Model> = originals
        .into_iter()
        .filter(|row| {
            source_run_of
                .iter()
                .any(|(e, r)| *e == row.employee_id && *r == row.run_id)
        })
        .collect();
    if !copies.is_empty() {
        let mut tx = db.begin().await?;
        {
            let tx = OrmConn::new(&mut tx);
            for row in copies {
                hr_pay_run_inputs::Entity::insert(hr_pay_run_inputs::ActiveModel {
                    id: Set(generate_id("hrpi")),
                    run_id: Set(id.clone()),
                    employee_id: Set(row.employee_id),
                    code: Set(row.code),
                    label: Set(row.label),
                    quantity: Set(row.quantity),
                    rate: Set(row.rate),
                    amount: Set(row.amount),
                    work_date: Set(row.work_date),
                    source: Set("manual".to_owned()),
                    source_ref: Set(None),
                    notes: Set(row.notes),
                    created_by: Set(Some(user_id.to_owned())),
                    ..Default::default()
                })
                .exec_without_returning(&tx)
                .await?;
            }
        }
        tx.commit().await?;
    }
    require_run(db, &id).await
}

/// `updateRun(db, id, input)`.
pub(crate) async fn update_run(db: &PgPool, id: &str, input: &Value) -> Result<Value, HrError> {
    use hr_pay_runs::Column;
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    let pay_date = str_of(input, "payDate");
    let changed = pay_date.is_some_and(|d| d != s(&run, "payDate"));
    let dated = match pay_date {
        Some(date) if changed => Some(numbering_for_pay_date(db, &run, date).await?),
        _ => None,
    };
    let mut update = hr_pay_runs::Entity::update_many();
    if let Some(date) = pay_date {
        update = update.col_expr(Column::PayDate, Expr::value(sql_date(date)?));
    }
    if let Some((tax_year, period_number)) = dated {
        update = update
            .col_expr(
                Column::TaxYear,
                Expr::value(i32::try_from(tax_year).unwrap_or_default()),
            )
            .col_expr(
                Column::PeriodNumber,
                Expr::value(i32::try_from(period_number).unwrap_or_default()),
            );
    }
    if has(input, "notes") {
        update = update.col_expr(
            Column::Notes,
            Expr::value(str_of(input, "notes").map(str::to_owned)),
        );
    }
    if changed {
        update = update.col_expr(Column::Status, back_to_draft());
    }
    let updated = update
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(id))
        .filter(run_is_open())
        .exec(&orm(db))
        .await?;
    if updated.rows_affected == 0 {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    require_run(db, id).await
}

/// `cancelRun(db, id)`: its draft payslips go with it.
pub(crate) async fn cancel_run(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    let at = utc_now();
    let cancelled = hr_pay_runs::Entity::update_many()
        .col_expr(hr_pay_runs::Column::Status, Expr::value("cancelled"))
        .col_expr(hr_pay_runs::Column::CancelledAt, Expr::value(at))
        .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(at))
        .filter(hr_pay_runs::Column::Id.eq(id))
        .filter(run_is_open())
        .exec(&orm(db))
        .await?;
    if cancelled.rows_affected == 0 {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    hr_payslips::Entity::delete_many()
        .filter(hr_payslips::Column::RunId.eq(id))
        .filter(hr_payslips::Column::Status.eq("draft"))
        .exec(&orm(db))
        .await?;
    require_run(db, id).await
}

/// `setRunEmployee(db, id, employeeId, excluded)`.
pub(crate) async fn set_run_employee(
    db: &PgPool,
    id: &str,
    employee_id: &str,
    excluded: bool,
) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    if !candidate_employee_ids(db, &run)
        .await?
        .iter()
        .any(|c| c == employee_id)
    {
        return Err(HrError::validation("That employee is not part of this run"));
    }
    let mut next: Vec<String> = vec![];
    for current in string_list(&run["excludedEmployeeIds"]) {
        if !next.contains(&current) {
            next.push(current);
        }
    }
    if excluded {
        if !next.iter().any(|e| e == employee_id) {
            next.push(employee_id.to_owned());
        }
    } else {
        next.retain(|e| e != employee_id);
    }
    let updated = hr_pay_runs::Entity::update_many()
        .col_expr(
            hr_pay_runs::Column::ExcludedEmployeeIds,
            Expr::value(json!(next)),
        )
        .col_expr(hr_pay_runs::Column::Status, back_to_draft())
        .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_pay_runs::Column::Id.eq(id))
        .filter(run_is_open())
        .exec(&orm(db))
        .await?;
    if updated.rows_affected == 0 {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    if excluded {
        hr_payslips::Entity::delete_many()
            .filter(hr_payslips::Column::RunId.eq(id))
            .filter(hr_payslips::Column::EmployeeId.eq(employee_id))
            .filter(hr_payslips::Column::Status.eq("draft"))
            .exec(&orm(db))
            .await?;
    }
    require_run(db, id).await
}

// ── inputs ──────────────────────────────────────────────────────────────────

/// `toInputDto(row)`.
pub(crate) fn to_input_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "runId": row["runId"], "employeeId": row["employeeId"], "code": row["code"], "label": row["label"],
        "quantity": row["quantity"], "rate": row["rate"], "amount": row["amount"], "workDate": row["workDate"],
        "source": row["source"], "sourceRef": row["sourceRef"], "notes": row["notes"], "createdAt": row["createdAt"],
    })
}

/// The run's inputs, Drizzle-shaped.
pub(crate) async fn run_input_rows(
    db: &PgPool,
    run_id: &str,
    employee_ids: Option<&[String]>,
) -> Result<Vec<Value>, HrError> {
    let mut inputs =
        hr_pay_run_inputs::Entity::find().filter(hr_pay_run_inputs::Column::RunId.eq(run_id));
    if let Some(ids) = employee_ids {
        inputs = inputs
            .filter(hr_pay_run_inputs::Column::EmployeeId.is_in(ids.iter().map(String::as_str)));
    }
    let rows = inputs.all(&orm(db)).await?;
    Ok(rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?)
}

/// `listRunInputs(db, runId, { employeeId })`.
pub(crate) async fn list_run_inputs(
    db: &PgPool,
    run_id: &str,
    employee_id: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    use hr_pay_run_inputs::Column;
    require_run(db, run_id).await?;
    let mut inputs = hr_pay_run_inputs::Entity::find().filter(Column::RunId.eq(run_id));
    if let Some(employee_id) = employee_id.filter(|e| !e.is_empty()) {
        inputs = inputs.filter(Column::EmployeeId.eq(employee_id));
    }
    let rows = inputs
        .order_by_asc(Column::EmployeeId)
        .order_by_asc(Column::CreatedAt)
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| Ok(to_input_dto(&row_json(row)?)))
        .collect()
}

fn validate_input(
    country: &str,
    code: &str,
    quantity: Option<f64>,
    amount: Option<f64>,
) -> Result<(), HrError> {
    let Some(def) = component_def(code) else {
        return Err(HrError::validation(format!("Unknown pay code '{code}'")));
    };
    if !def.countries.contains(&country_of(country)) {
        return Err(HrError::validation(format!(
            "'{code}' is not available for {country} payroll"
        )));
    }
    if !def.one_off {
        return Err(HrError::validation(format!(
            "'{code}' is set up on the employee, not entered on a pay run"
        )));
    }
    if matches!(def.entry, ComponentEntry::Hours | ComponentEntry::Days) && quantity.is_none() {
        return Err(HrError::validation(format!("'{code}' needs a quantity")));
    }
    if def.entry == ComponentEntry::Amount && amount.is_none() {
        return Err(HrError::validation(format!("'{code}' needs an amount")));
    }
    Ok(())
}

async fn input_row(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    let row = hr_pay_run_inputs::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json).transpose()?)
}

/// `createRunInput(db, runId, input, { userId })`.
pub(crate) async fn create_run_input(
    db: &PgPool,
    run_id: &str,
    input: &Value,
    user_id: &str,
) -> Result<Value, HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    let employee_id = str_of(input, "employeeId").unwrap_or("");
    if !candidate_employee_ids(db, &run)
        .await?
        .iter()
        .any(|c| c == employee_id)
    {
        return Err(HrError::validation("That employee is not part of this run"));
    }
    let code = str_of(input, "code").unwrap_or("");
    let number = |key: &str| input.get(key).and_then(Value::as_f64);
    validate_input(
        s(&run, "country"),
        code,
        number("quantity"),
        number("amount"),
    )?;
    if let Some(date) = str_of(input, "workDate")
        && !is_iso_date(date)
    {
        return Err(HrError::validation("workDate is not a date"));
    }
    touch_run(db, run_id).await?;
    let id = generate_id("hrpi");
    let decimal =
        |key: &str, fixed: fn(f64) -> String| sql_numeric_opt(number(key).map(fixed).as_deref());
    hr_pay_run_inputs::Entity::insert(hr_pay_run_inputs::ActiveModel {
        id: Set(id.clone()),
        run_id: Set(run_id.to_owned()),
        employee_id: Set(employee_id.to_owned()),
        code: Set(code.to_owned()),
        label: Set(str_of(input, "label").map(str::to_owned)),
        quantity: Set(decimal("quantity", decimal4)?),
        rate: Set(decimal("rate", decimal4)?),
        amount: Set(decimal("amount", decimal2)?),
        work_date: Set(sql_date_opt(str_of(input, "workDate"))?),
        source: Set("manual".to_owned()),
        notes: Set(str_of(input, "notes").map(str::to_owned)),
        created_by: Set(Some(user_id.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    let row = input_row(db, &id)
        .await?
        .ok_or_else(|| HrError::internal("input vanished"))?;
    Ok(to_input_dto(&row))
}

async fn require_input(db: &PgPool, run_id: &str, input_id: &str) -> Result<Value, HrError> {
    match input_row(db, input_id).await? {
        Some(row) if row["runId"] == run_id => Ok(row),
        _ => Err(HrError::not_found("Pay run input", input_id)),
    }
}

/// `updateRunInput(db, runId, inputId, input)`.
pub(crate) async fn update_run_input(
    db: &PgPool,
    run_id: &str,
    input_id: &str,
    input: &Value,
) -> Result<Value, HrError> {
    use hr_pay_run_inputs::Column;
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    let row = require_input(db, run_id, input_id).await?;
    let pick = |key: &str| {
        if has(input, key) {
            input[key].as_f64()
        } else {
            num(&row[key])
        }
    };
    validate_input(
        s(&run, "country"),
        s(&row, "code"),
        pick("quantity"),
        pick("amount"),
    )?;
    let figures_changed = has(input, "quantity") || has(input, "rate") || has(input, "amount");
    touch_run(db, run_id).await?;
    let number = |key: &str, fixed: fn(f64) -> String| {
        sql_numeric_opt(input.get(key).and_then(Value::as_f64).map(fixed).as_deref())
    };
    let text = |key: &str| Expr::value(str_of(input, key).map(str::to_owned));
    let mut update = hr_pay_run_inputs::Entity::update_many();
    if has(input, "label") {
        update = update.col_expr(Column::Label, text("label"));
    }
    for (key, column, fixed) in [
        ("quantity", Column::Quantity, decimal4 as fn(f64) -> String),
        ("rate", Column::Rate, decimal4),
        ("amount", Column::Amount, decimal2),
    ] {
        if has(input, key) {
            update = update.col_expr(column, Expr::value(number(key, fixed)?));
        }
    }
    if has(input, "workDate") {
        update = update.col_expr(
            Column::WorkDate,
            Expr::value(sql_date_opt(str_of(input, "workDate"))?),
        );
    }
    if has(input, "notes") {
        update = update.col_expr(Column::Notes, text("notes"));
    }
    if figures_changed && row["source"] != "manual" {
        update = update.col_expr(Column::Source, Expr::value("manual"));
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(input_id))
        .exec(&orm(db))
        .await?;
    let row = input_row(db, input_id)
        .await?
        .ok_or_else(|| HrError::internal("input vanished"))?;
    Ok(to_input_dto(&row))
}

/// `deleteRunInput(db, runId, inputId)`.
pub(crate) async fn delete_run_input(
    db: &PgPool,
    run_id: &str,
    input_id: &str,
) -> Result<(), HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    require_input(db, run_id, input_id).await?;
    touch_run(db, run_id).await?;
    hr_pay_run_inputs::Entity::delete_by_id(input_id.to_owned())
        .exec(&orm(db))
        .await?;
    Ok(())
}

// ── collecting ──────────────────────────────────────────────────────────────

/// What `collectRunInputs` collected, per source.
#[derive(Default)]
pub(crate) struct CollectSummary {
    pub(crate) attendance: u32,
    pub(crate) leave: u32,
    pub(crate) absence: u32,
    pub(crate) declaration: u32,
}

struct Fresh {
    employee_id: String,
    code: &'static str,
    label: Option<String>,
    quantity: Option<String>,
    rate: Option<String>,
    amount: Option<String>,
    work_date: String,
    source: &'static str,
    source_ref: String,
}

fn round2(n: f64) -> f64 {
    js_round(n * 100.0) / 100.0
}

fn max_date<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a >= b { a } else { b }
}

fn min_date<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a <= b { a } else { b }
}

fn weekday_of(day: &str) -> i64 {
    weldsuite_payroll_domain::periods::weekday(day).unwrap_or(1)
}

/// `collectRunInputs(db, runId, keyring, { userId })`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn collect_run_inputs(
    db: &PgPool,
    run_id: &str,
    keyring: &Keyring,
    user_id: &str,
) -> Result<CollectSummary, HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    if run["kind"] == "correction" {
        return Err(HrError::conflict(
            "A correction starts from the original run's inputs; edit those instead of collecting",
        ));
    }
    let employee_ids = included_employee_ids(db, &run).await?;
    let mut summary = CollectSummary::default();
    let collected: Vec<&str> = COLLECTED_SOURCES.to_vec();
    if employee_ids.is_empty() {
        touch_run(db, run_id).await?;
        delete_collected(&orm(db), run_id, &collected).await?;
        return Ok(summary);
    }
    let data = load_employee_payroll_data(db, &employee_ids, keyring).await?;
    let data_of = |id: &str| data.iter().find(|d| s(&d.employee, "id") == id);
    let country = s(&run, "country").to_owned();
    let (period_start, period_end) = (
        s(&run, "periodStart").to_owned(),
        s(&run, "periodEnd").to_owned(),
    );

    let taken_rows =
        taken_in_other_runs(db, &employee_ids, run_id, &period_start, &period_end).await?;
    let mut taken: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (reference, start, end) in taken_rows {
        if let Some(reference) = reference.filter(|r| !r.is_empty()) {
            taken
                .entry(reference)
                .or_default()
                .push((iso_date(start), iso_date(end)));
        }
    }
    let free_weekdays = |reference: &str, start: &str, end: &str| -> Vec<String> {
        let covered = taken.get(reference).map(Vec::as_slice).unwrap_or_default();
        let mut days = vec![];
        let mut day = start.to_owned();
        while day.as_str() <= end {
            let dow = weekday_of(&day);
            if dow != 0
                && dow != 6
                && !covered
                    .iter()
                    .any(|(s, e)| day.as_str() >= s.as_str() && day.as_str() <= e.as_str())
            {
                days.push(day.clone());
            }
            day = add_days(&day, 1);
        }
        days
    };

    let manual: Vec<(String, Option<String>)> = hr_pay_run_inputs::Entity::find()
        .select_only()
        .columns([
            hr_pay_run_inputs::Column::Code,
            hr_pay_run_inputs::Column::SourceRef,
        ])
        .filter(hr_pay_run_inputs::Column::RunId.eq(run_id))
        .filter(hr_pay_run_inputs::Column::Source.eq("manual"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let manual_keys: HashSet<String> = manual
        .iter()
        .filter_map(|(code, r)| {
            r.as_ref()
                .filter(|r| !r.is_empty())
                .map(|r| format!("{code}|{r}"))
        })
        .collect();
    let mut fresh: Vec<Fresh> = vec![];
    let mut push = |row: Fresh, summary: &mut CollectSummary| {
        if manual_keys.contains(&format!("{}|{}", row.code, row.source_ref)) {
            return;
        }
        match row.source {
            "attendance" => summary.attendance += 1,
            "leave" => summary.leave += 1,
            "absence" => summary.absence += 1,
            _ => summary.declaration += 1,
        }
        fresh.push(row);
    };

    let contract_hours = |d: &EmployeePayrollData| -> f64 {
        let comp = compensation_on(&d.compensations, &period_end);
        d.profile
            .as_ref()
            .and_then(|p| p["nl"]["contractHoursPerWeek"].as_f64())
            .or_else(|| comp.and_then(|c| c["hoursPerWeek"].as_f64()))
            .or_else(|| d.employee["weeklyHours"].as_f64())
            .unwrap_or(40.0)
    };
    let pay_type_of = |d: &EmployeePayrollData| -> Option<String> {
        compensation_on(&d.compensations, &period_end)
            .and_then(|c| c["payType"].as_str().map(str::to_owned))
    };
    let is_nonexempt = |d: &EmployeePayrollData| -> bool {
        if country != "US" {
            return false;
        }
        let status = d
            .profile
            .as_ref()
            .and_then(|p| p["us"]["flsaStatus"].as_str().map(str::to_owned))
            .unwrap_or_else(|| {
                if pay_type_of(d).as_deref() == Some("hourly") {
                    "nonexempt".into()
                } else {
                    "exempt".into()
                }
            });
        status == "nonexempt"
    };
    let paid_by_hours = |d: &EmployeePayrollData| pay_type_of(d).as_deref() == Some("hourly");

    // Attendance
    let attendance = approved_attendance(db, &employee_ids, &period_start, &period_end).await?;
    let mut per_day: Vec<(String, String, i64, String)> = vec![];
    for (id, employee_id, date, minutes) in attendance {
        let date = iso_date(date);
        let Some(d) = data_of(&employee_id) else {
            continue;
        };
        if !paid_by_hours(d) && !is_nonexempt(d) {
            continue;
        }
        match per_day
            .iter_mut()
            .find(|(e, day, _, _)| *e == employee_id && *day == date)
        {
            Some(entry) => entry.2 += i64::from(minutes.unwrap_or(0)),
            None => per_day.push((employee_id, date, i64::from(minutes.unwrap_or(0)), id)),
        }
    }
    for (employee_id, date, minutes, first_id) in per_day {
        if taken.contains_key(&first_id) {
            continue;
        }
        push(
            Fresh {
                employee_id,
                code: "hours.regular",
                label: None,
                quantity: Some(decimal4(round2(minutes as f64 / 60.0))),
                rate: None,
                amount: None,
                work_date: date,
                source: "attendance",
                source_ref: first_id,
            },
            &mut summary,
        );
    }

    // Leave
    let leave = approved_leave(db, &employee_ids, &period_start, &period_end).await?;
    for (id, employee_id, start, end, days, is_paid, type_name) in leave {
        let (start, end) = (iso_date(start), iso_date(end));
        let Some(d) = data_of(&employee_id) else {
            continue;
        };
        let overlap_start = max_date(&start, &period_start).to_owned();
        let overlap_end = min_date(&end, &period_end).to_owned();
        let total = weekdays_between(&start, &end).unwrap_or(0);
        let in_period = free_weekdays(&id, &overlap_start, &overlap_end).len();
        if total == 0 || in_period == 0 {
            continue;
        }
        let share = days * (in_period as f64 / total as f64);
        let hours = round2(share * (contract_hours(d) / 5.0));
        if hours <= 0.0 {
            continue;
        }
        let pay_type = pay_type_of(d);
        let code = if !is_paid && pay_type.as_deref() == Some("salary") {
            "hours.unpaid_leave"
        } else if is_paid && country == "US" && paid_by_hours(d) {
            "hours.paid_leave"
        } else {
            continue;
        };
        push(
            Fresh {
                employee_id,
                code,
                label: Some(type_name),
                quantity: Some(decimal4(hours)),
                rate: None,
                amount: None,
                work_date: overlap_start,
                source: "leave",
                source_ref: id,
            },
            &mut summary,
        );
    }

    // Sick reports (NL salaried)
    if country == "NL" {
        let absences = absences_in(db, &employee_ids, &period_start, &period_end).await?;
        for (id, employee_id, start_date, end_date, first_day) in absences {
            let (start_date, end_date) = (iso_date(start_date), end_date.map(iso_date));
            let Some(d) = data_of(&employee_id) else {
                continue;
            };
            if pay_type_of(d).as_deref() != Some("salary") {
                continue;
            }
            let start = max_date(&start_date, &period_start).to_owned();
            let end = min_date(end_date.as_deref().unwrap_or(&period_end), &period_end).to_owned();
            let free = free_weekdays(&id, &start, &end);
            let mut days = free.len() as f64;
            if first_day == "half"
                && start_date.as_str() >= period_start.as_str()
                && free.contains(&start_date)
            {
                days -= 0.5;
            }
            if days <= 0.0 {
                continue;
            }
            push(
                Fresh {
                    employee_id,
                    code: "nl.sick_pay",
                    label: None,
                    quantity: Some(decimal4(round2(days * (contract_hours(d) / 5.0)))),
                    rate: Some(decimal4(100.0)),
                    amount: None,
                    work_date: start,
                    source: "absence",
                    source_ref: id,
                },
                &mut summary,
            );
        }
    }

    // Declarations
    let declarations =
        approved_declarations(db, &employee_ids, s(&run, "currency"), &period_end).await?;
    if !declarations.is_empty() {
        let ids: Vec<&str> = declarations.iter().map(|d| d.0.as_str()).collect();
        let taken_ids: HashSet<Option<String>> = declarations_taken(db, &ids, run_id)
            .await?
            .into_iter()
            .collect();
        for (id, employee_id, description, amount, expense_date) in declarations {
            // `amount::text`, read as a JavaScript number.
            let amount = amount.to_plain_string();
            let expense_date = iso_date(expense_date);
            if taken_ids.contains(&Some(id.clone())) {
                continue;
            }
            let label = String::from_utf16_lossy(
                &description.encode_utf16().take(160).collect::<Vec<u16>>(),
            );
            push(
                Fresh {
                    employee_id,
                    code: "reimbursement",
                    label: Some(label),
                    quantity: None,
                    rate: None,
                    amount: Some(decimal2(weldsuite_kit::validation::js_number(&amount))),
                    work_date: expense_date,
                    source: "declaration",
                    source_ref: id,
                },
                &mut summary,
            );
        }
    }

    touch_run(db, run_id).await?;
    let mut tx = db.begin().await?;
    {
        let tx = OrmConn::new(&mut tx);
        delete_collected(&tx, run_id, &collected).await?;
        for row in fresh {
            hr_pay_run_inputs::Entity::insert(hr_pay_run_inputs::ActiveModel {
                id: Set(generate_id("hrpi")),
                run_id: Set(run_id.to_owned()),
                employee_id: Set(row.employee_id),
                code: Set(row.code.to_owned()),
                label: Set(row.label),
                quantity: Set(sql_numeric_opt(row.quantity.as_deref())?),
                rate: Set(sql_numeric_opt(row.rate.as_deref())?),
                amount: Set(sql_numeric_opt(row.amount.as_deref())?),
                work_date: Set(Some(sql_date(&row.work_date)?)),
                source: Set(row.source.to_owned()),
                source_ref: Set(Some(row.source_ref)),
                notes: Set(None),
                created_by: Set(Some(user_id.to_owned())),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(summary)
}

/// `delete from hr_pay_run_inputs where run_id = $1 and source = any(collected)`.
async fn delete_collected<C: ConnectionTrait>(
    db: &C,
    run_id: &str,
    collected: &[&str],
) -> Result<(), DbErr> {
    hr_pay_run_inputs::Entity::delete_many()
        .filter(hr_pay_run_inputs::Column::RunId.eq(run_id))
        .filter(hr_pay_run_inputs::Column::Source.is_in(collected.iter().copied()))
        .exec(db)
        .await?;
    Ok(())
}

/// What other open or settled runs overlapping the period already pay:
/// `(source_ref, run period start, run period end)`.
async fn taken_in_other_runs(
    db: &PgPool,
    employee_ids: &[String],
    run_id: &str,
    period_start: &str,
    period_end: &str,
) -> Result<Vec<(Option<String>, Date, Date)>, DbErr> {
    use hr_pay_run_inputs::Column;
    hr_pay_run_inputs::Entity::find()
        .select_only()
        .column(Column::SourceRef)
        .column(hr_pay_runs::Column::PeriodStart)
        .column(hr_pay_runs::Column::PeriodEnd)
        .join(JoinType::InnerJoin, input_run())
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::SourceRef.is_not_null())
        .filter(Column::Source.is_in(["attendance", "leave", "absence", "manual"]))
        .filter(Column::RunId.ne(run_id))
        .filter(hr_pay_runs::Column::Status.is_in(["draft", "calculated", "approved", "paid"]))
        .filter(hr_pay_runs::Column::PeriodStart.lte(sql_date(period_end)?))
        .filter(hr_pay_runs::Column::PeriodEnd.gte(sql_date(period_start)?))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `join(hrPayRuns, eq(hrPayRuns.id, hrPayRunInputs.runId))`.
fn input_run() -> sea_orm::RelationDef {
    hr_pay_run_inputs::Entity::belongs_to(hr_pay_runs::Entity)
        .from(hr_pay_run_inputs::Column::RunId)
        .to(hr_pay_runs::Column::Id)
        .into()
}

/// Approved attendance with worked minutes in the period, oldest first:
/// `(id, employee_id, date, worked_minutes)`.
async fn approved_attendance(
    db: &PgPool,
    employee_ids: &[String],
    period_start: &str,
    period_end: &str,
) -> Result<Vec<(String, String, Date, Option<i32>)>, DbErr> {
    use hr_attendance_records::Column;
    hr_attendance_records::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::EmployeeId,
            Column::Date,
            Column::WorkedMinutes,
        ])
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::Date.gte(sql_date(period_start)?))
        .filter(Column::Date.lte(sql_date(period_end)?))
        .filter(Column::ApprovedAt.is_not_null())
        .filter(Column::WorkedMinutes.gt(0))
        .order_by_asc(Column::Date)
        .order_by_asc(Column::CreatedAt)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Approved leave overlapping the period with its type: `(id, employee_id,
/// start_date, end_date, days, is_paid, type name)`.
async fn approved_leave(
    db: &PgPool,
    employee_ids: &[String],
    period_start: &str,
    period_end: &str,
) -> Result<Vec<(String, String, Date, Date, f64, bool, String)>, DbErr> {
    use hr_leave_requests::Column;
    hr_leave_requests::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::EmployeeId,
            Column::StartDate,
            Column::EndDate,
            Column::Days,
        ])
        .column(hr_leave_types::Column::IsPaid)
        .column(hr_leave_types::Column::Name)
        .join(
            JoinType::InnerJoin,
            hr_leave_requests::Entity::belongs_to(hr_leave_types::Entity)
                .from(Column::LeaveTypeId)
                .to(hr_leave_types::Column::Id)
                .into(),
        )
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::Status.eq("approved"))
        .filter(Column::StartDate.lte(sql_date(period_end)?))
        .filter(Column::EndDate.gte(sql_date(period_start)?))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Sick reports overlapping the period: `(id, employee_id, start_date,
/// end_date, first_day)`.
async fn absences_in(
    db: &PgPool,
    employee_ids: &[String],
    period_start: &str,
    period_end: &str,
) -> Result<Vec<(String, String, Date, Option<Date>, String)>, DbErr> {
    use hr_absences::Column;
    hr_absences::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::EmployeeId,
            Column::StartDate,
            Column::EndDate,
            Column::FirstDay,
        ])
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::StartDate.lte(sql_date(period_end)?))
        .filter(
            sea_orm::Condition::any()
                .add(Column::EndDate.is_null())
                .add(Column::EndDate.gte(sql_date(period_start)?)),
        )
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Approved, unpaid declarations in the run's currency up to the period's
/// end: `(id, employee_id, description, amount, expense_date)`.
async fn approved_declarations(
    db: &PgPool,
    employee_ids: &[String],
    currency: &str,
    period_end: &str,
) -> Result<Vec<(String, String, String, BigDecimal, Date)>, DbErr> {
    use hr_declarations::Column;
    hr_declarations::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::EmployeeId,
            Column::Description,
            Column::Amount,
            Column::ExpenseDate,
        ])
        .filter(Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::Status.eq("approved"))
        .filter(Column::Currency.eq(currency))
        .filter(Column::ExpenseDate.lte(sql_date(period_end)?))
        .filter(Column::PaidAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// The declarations among `ids` another open or approved run already pays.
async fn declarations_taken(
    db: &PgPool,
    ids: &[&str],
    run_id: &str,
) -> Result<Vec<Option<String>>, DbErr> {
    use hr_pay_run_inputs::Column;
    hr_pay_run_inputs::Entity::find()
        .select_only()
        .column(Column::SourceRef)
        .join(JoinType::InnerJoin, input_run())
        .filter(Column::SourceRef.is_in(ids.iter().copied()))
        .filter(Column::RunId.ne(run_id))
        .filter(hr_pay_runs::Column::Status.is_in(["draft", "calculated", "approved"]))
        .into_tuple()
        .all(&orm(db))
        .await
}
