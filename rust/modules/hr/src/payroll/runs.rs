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

use serde_json::{Value, json};
use weldsuite_db::{Keyring, PgPool, js_row};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::components::{ComponentEntry, component_def};
use weldsuite_payroll_domain::periods::{period_containing, weekdays_between};

use super::common::{decimal2, decimal4, is_iso_date, num, ranges_overlap, sort_issues};
use super::employees::{EmployeePayrollData, compensation_on, load_employee_payroll_data};
use super::employers::{country_of, last_completed_periods, next_period_of, require_employer_row, require_schedule_row, spec_of};
use super::schema::{has, str_of};
use super::ytd::number_key;
use crate::employees::display_name_of;
use crate::{HrError, add_days, js_round, locale_compare, member_names, now, today_iso};

pub(crate) const COLLECTED_SOURCES: [&str; 4] = ["attendance", "leave", "absence", "declaration"];
const RUN_CHANGED: &str = "This pay run was approved, cancelled or changed by someone else. Reload it and try again.";

/// A payslip row with its numeric columns as the text Drizzle reads.
pub(crate) const PAYSLIP_ROW: &str = "to_jsonb(s) || jsonb_build_object(
    'gross_pay', s.gross_pay::text, 'taxable_wage', s.taxable_wage::text, 'employee_taxes', s.employee_taxes::text,
    'employee_deductions', s.employee_deductions::text, 'reimbursements', s.reimbursements::text,
    'net_pay', s.net_pay::text, 'employer_taxes', s.employer_taxes::text, 'employer_cost', s.employer_cost::text,
    'ytd_text', s.ytd::text, 'filing_data_text', s.filing_data::text, 'snapshot_text', s.snapshot::text)";

/// A pay run input row, numeric columns as text.
const INPUT_ROW: &str =
    "to_jsonb(i) || jsonb_build_object('quantity', i.quantity::text, 'rate', i.rate::text, 'amount', i.amount::text)";

pub(crate) fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

pub(crate) fn int_of(row: &Value, key: &str) -> i64 {
    row[key].as_i64().unwrap_or_else(|| row[key].as_f64().map_or(0, |f| f as i64))
}

/// Payslips matching `filter` (a `where` over alias `s`, binding `$1`…).
pub(crate) fn payslip_sql(filter: &str) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(format!("select {PAYSLIP_ROW} from hr_payslips s where {filter}"))
}

fn rows_of(values: Vec<Value>) -> Vec<Value> {
    values.into_iter().map(js_row).collect()
}

/// `requireRun(db, id)`.
pub(crate) async fn require_run(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_pay_runs t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Pay run", id))
}

/// `assertEditable(run)`.
pub(crate) fn assert_editable(run: &Value) -> Result<(), HrError> {
    let status = s(run, "status");
    if status != "draft" && status != "calculated" {
        return Err(HrError::conflict(format!("This pay run is {status} and can no longer be changed")));
    }
    Ok(())
}

/// `touchRun(db, runId)`: a calculated run goes back to draft; 409 when the
/// run is no longer open.
pub(crate) async fn touch_run(db: &PgPool, run_id: &str) -> Result<(), HrError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "update hr_pay_runs set status = case when status = 'calculated' then 'draft' else status end, updated_at = $2::timestamp
         where id = $1 and status in ('draft', 'calculated') returning id",
    )
    .bind(run_id)
    .bind(now())
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    Ok(())
}

/// `profileWindow(profile, employee)`.
pub(crate) fn profile_window(profile: &Value, employee: &Value) -> (Option<String>, Option<String>) {
    let pick = |key: &str| {
        profile[key].as_str().or_else(|| employee[key].as_str()).map(str::to_owned)
    };
    (pick("startDate"), pick("endDate"))
}

fn string_list(value: &Value) -> Vec<String> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// `candidateEmployeeIds(db, run)`.
pub(crate) async fn candidate_employee_ids(db: &PgPool, run: &Value) -> Result<Vec<String>, HrError> {
    if run["kind"] != "regular" {
        return Ok(string_list(&run["includedEmployeeIds"]));
    }
    let Some(schedule) = run["payScheduleId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(vec![]);
    };
    let rows: Vec<(String, Value, Value)> = sqlx::query_as(
        "select p.employee_id, to_jsonb(p), to_jsonb(e) from hr_payroll_profiles p
         join hr_employees e on e.id = p.employee_id
         where p.pay_schedule_id = $1 and p.status = 'active' and e.deleted_at is null",
    )
    .bind(schedule)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, profile, employee)| {
            let (start, end) = profile_window(&js_row(profile.clone()), &js_row(employee.clone()));
            ranges_overlap(
                start.as_deref().unwrap_or("0001-01-01"),
                end.as_deref(),
                s(run, "periodStart"),
                Some(s(run, "periodEnd")),
            )
        })
        .map(|(id, _, _)| id)
        .collect())
}

/// `includedEmployeeIds(db, run)`.
pub(crate) async fn included_employee_ids(db: &PgPool, run: &Value) -> Result<Vec<String>, HrError> {
    let excluded: HashSet<String> = string_list(&run["excludedEmployeeIds"]).into_iter().collect();
    Ok(candidate_employee_ids(db, run).await?.into_iter().filter(|id| !excluded.contains(id)).collect())
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
    let schedule_ids: Vec<String> =
        rows.iter().filter_map(|r| r["payScheduleId"].as_str().filter(|v| !v.is_empty()).map(str::to_owned)).collect();
    let employers: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("select id, name from hr_payroll_employers where id = any($1)")
            .bind(&employer_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let schedules: HashMap<String, String> = if schedule_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>("select id, name from hr_pay_schedules where id = any($1)")
            .bind(&schedule_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect()
    };
    let users: Vec<Option<&str>> = rows
        .iter()
        .flat_map(|r| [r["preparedBy"].as_str(), r["calculatedBy"].as_str(), r["approvedBy"].as_str()])
        .collect();
    let names = member_names(db, &users).await?;
    let name_of = |id: &Value| -> Value {
        id.as_str().filter(|v| !v.is_empty()).map_or(Value::Null, |id| names.get(id).map_or(Value::Null, |n| json!(n)))
    };
    Ok(rows
        .iter()
        .map(|row| {
            let (errors, warnings) = count_issues(&row["issues"]);
            let schedule = row["payScheduleId"].as_str().filter(|v| !v.is_empty());
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
                "journalError": row["journalError"],
                "createdAt": row["createdAt"],
                "updatedAt": row["updatedAt"],
            })
        })
        .collect())
}

/// `previousNetPay(db, run, employeeIds)`: net pay of each employee's
/// previous final payslip, for the variance column.
async fn previous_net_pay(db: &PgPool, run: &Value, employee_ids: &[String]) -> Result<HashMap<String, String>, HrError> {
    let mut out = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select employee_id, net_pay::text from hr_payslips
         where employee_id = any($1) and employer_id = $2 and status = 'final' and corrects_payslip_id is null
           and run_id <> $3 and period_end < $4::date
         order by period_end desc, pay_date desc",
    )
    .bind(employee_ids)
    .bind(s(run, "employerId"))
    .bind(s(run, "id"))
    .bind(s(run, "periodEnd"))
    .fetch_all(db)
    .await?;
    for (employee, net) in rows {
        out.entry(employee).or_insert(net);
    }
    Ok(out)
}

/// The display names of employees by id.
pub(crate) async fn employee_names(db: &PgPool, ids: &[String]) -> Result<HashMap<String, String>, HrError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
        .bind(ids)
        .fetch_all(db)
        .await?;
    Ok(rows_of(rows).iter().map(|e| (s(e, "id").to_owned(), display_name_of(e))).collect())
}

/// `payslipSummaries(db, run, rows)`.
pub(crate) async fn payslip_summaries(db: &PgPool, run: &Value, rows: &[Value]) -> Result<Vec<Value>, HrError> {
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
        && run["calculatedBy"].as_str().is_some_and(|by| !by.is_empty() && by == user_id)
}

/// `getRunDetail(db, id, { userId })`.
pub(crate) async fn get_run_detail(db: &PgPool, id: &str, user_id: &str) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    let mut dto = to_run_dtos(db, std::slice::from_ref(&run)).await?.remove(0);
    let employer = require_employer_row(db, s(&run, "employerId")).await.ok();
    let candidates = candidate_employee_ids(db, &run).await?;
    let people: Vec<Value> = if candidates.is_empty() {
        vec![]
    } else {
        rows_of(
            sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
                .bind(&candidates)
                .fetch_all(db)
                .await?,
        )
    };
    let excluded: HashSet<String> = string_list(&run["excludedEmployeeIds"]).into_iter().collect();
    let slips = rows_of(sqlx::query_scalar(payslip_sql("s.run_id = $1")).bind(id).fetch_all(db).await?);
    let blocks = four_eyes_blocks(employer.as_ref(), &run, user_id);
    let run_issues = issues_of(&run["issues"]);
    let mut employees: Vec<(String, Value)> = people
        .iter()
        .map(|p| {
            let name = display_name_of(p);
            let pid = s(p, "id");
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
        map.insert("employees".into(), Value::Array(employees.into_iter().map(|(_, v)| v).collect()));
        map.insert("payslips".into(), Value::Array(payslip_summaries(db, &run, &slips).await?));
        map.insert("canApprove".into(), json!(status == "calculated" && !has_error && !blocks));
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
pub(crate) async fn list_runs(db: &PgPool, employer_id: Option<&str>, status: Option<&str>, year: Option<f64>) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> =
        status.filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::to_owned).collect());
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_pay_runs t
         where ($1::text is null or t.employer_id = $1)
           and ($2::text[] is null or t.status = any($2))
           and ($3::int is null or t.tax_year = $3)
         order by t.period_start desc, t.created_at desc limit 500",
    )
    .bind(employer_id.filter(|v| !v.is_empty()))
    .bind(statuses)
    .bind(year.filter(|y| *y != 0.0).map(|y| y as i32))
    .fetch_all(db)
    .await?;
    to_run_dtos(db, &rows_of(rows)).await
}

// ── create / update / cancel ────────────────────────────────────────────────

async fn employees_with_profile(db: &PgPool, employer_id: &str, ids: &[String]) -> Result<Vec<Value>, HrError> {
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(p) from hr_payroll_profiles p
             where p.employee_id = any($1) and p.employer_id = $2 and p.status <> 'ended'",
        )
        .bind(ids)
        .bind(employer_id)
        .fetch_all(db)
        .await?,
    );
    let found: HashSet<&str> = rows.iter().map(|r| s(r, "employeeId")).collect();
    let missing: Vec<&String> = ids.iter().filter(|id| !found.contains(id.as_str())).collect();
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
fn us_numbering(schedule: &Value, natural_start: &str, natural_tax_year: i64, natural_number: i64, pay_date: &str) -> Result<(i64, i64), HrError> {
    let tax_year = year_of(pay_date);
    if tax_year == natural_tax_year {
        return Ok((tax_year, natural_number));
    }
    if tax_year > natural_tax_year {
        return Ok((tax_year, 1));
    }
    let previous = period_containing(&spec_of(schedule), country_of("US"), &add_days(natural_start, -1)).map_err(|e| engine(&e))?;
    Ok((tax_year, if previous.tax_year == tax_year { previous.period_number + 1 } else { 1 }))
}

fn assert_nl_paid_in_period_year(period_start: &str, pay_date: &str) -> Result<(), HrError> {
    if pay_date.get(0..4) != period_start.get(0..4) {
        return Err(HrError::validation("A Dutch pay run must be paid in the calendar year of its period"));
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
async fn numbering_for_pay_date(db: &PgPool, run: &Value, pay_date: &str) -> Result<(i64, i64), HrError> {
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
    let natural = period_containing(&spec_of(&schedule), country_of("US"), s(run, "periodStart")).map_err(|e| engine(&e))?;
    us_numbering(&schedule, &natural.start, natural.tax_year, natural.period_number, pay_date)
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error.as_database_error().and_then(|e| e.code()).is_some_and(|code| code == "23505")
}

/// `createRun(db, input, { userId })`.
pub(crate) async fn create_run(db: &PgPool, input: &Value, user_id: &str) -> Result<Value, HrError> {
    let employer = require_employer_row(db, str_of(input, "employerId").unwrap_or("")).await?;
    if employer["isActive"] != true {
        return Err(HrError::validation("This employer is not active"));
    }
    let kind = str_of(input, "kind").unwrap_or("regular");
    let country = s(&employer, "country").to_owned();
    if kind == "correction" {
        return create_correction_run(db, input, &employer, user_id).await;
    }
    let mut schedule: Option<Value> = None;
    let (period_start, period_end, pay_date, mut tax_year, mut period_number);
    let mut included: Option<Vec<String>> = None;
    if kind == "regular" {
        let row = require_schedule_row(db, str_of(input, "payScheduleId").unwrap_or("")).await?;
        if row["employerId"] != employer["id"] {
            return Err(HrError::validation("The pay schedule belongs to another employer"));
        }
        if row["isActive"] != true {
            return Err(HrError::validation("This pay schedule is not active"));
        }
        let period = if let Some(start) = str_of(input, "periodStart") {
            let period = period_containing(&spec_of(&row), country_of(&country), start).map_err(|e| engine(&e))?;
            if period.start != start {
                return Err(HrError::validation(format!(
                    "periodStart must be the first day of a pay period ({})",
                    period.start
                )));
            }
            if let Some(end) = str_of(input, "periodEnd") {
                if end != period.end {
                    return Err(HrError::validation(format!("periodEnd must be the last day of the pay period ({})", period.end)));
                }
            }
            weldsuite_payroll_domain::js::to_value(&period)
        } else {
            let last = last_completed_periods(db, &[s(&row, "id").to_owned()]).await?.remove(s(&row, "id"));
            next_period_of(&row, &country, last.as_ref()).ok_or_else(|| HrError::internal("no next pay period"))?
        };
        period_start = s(&period, "start").to_owned();
        period_end = s(&period, "end").to_owned();
        pay_date = str_of(input, "payDate").unwrap_or(s(&period, "payDate")).to_owned();
        tax_year = int_of(&period, "taxYear");
        period_number = int_of(&period, "periodNumber");
        if let Some(wanted) = str_of(input, "payDate") {
            if wanted != s(&period, "payDate") {
                if country == "NL" {
                    assert_nl_paid_in_period_year(&period_start, &pay_date)?;
                } else {
                    (tax_year, period_number) = us_numbering(&row, &period_start, tax_year, period_number, &pay_date)?;
                }
            }
        }
        schedule = Some(row);
    } else {
        let (Some(start), Some(end), Some(date)) = (str_of(input, "periodStart"), str_of(input, "periodEnd"), str_of(input, "payDate"))
        else {
            return Err(HrError::validation("An off-cycle run needs its period and pay date"));
        };
        let ids = super::common::string_array(&input["employeeIds"]);
        if ids.is_empty() {
            return Err(HrError::validation("An off-cycle run needs the employees it pays"));
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
            return Err(HrError::validation("A Dutch off-cycle run must be paid in the year of its period"));
        }
        let schedule_id = str_of(input, "payScheduleId")
            .map(str::to_owned)
            .or_else(|| profiles.iter().find_map(|p| p["payScheduleId"].as_str().filter(|v| !v.is_empty()).map(str::to_owned)));
        schedule = match schedule_id {
            Some(id) => require_schedule_row(db, &id).await.ok(),
            None => None,
        };
        if let Some(row) = &schedule {
            let period = period_containing(&spec_of(row), country_of(&country), &period_start).map_err(|e| engine(&e))?;
            (tax_year, period_number) = if country == "US" {
                us_numbering(row, &period.start, period.tax_year, period.period_number, &pay_date)?
            } else {
                (period.tax_year, period.period_number)
            };
        } else {
            tax_year = year_of(if country == "NL" { &period_start } else { &pay_date });
            period_number = if country == "NL" { period_start.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1) } else { 1 };
        }
    }
    let id = generate_id("hrpr");
    let inserted = sqlx::query(
        "insert into hr_pay_runs (id, employer_id, pay_schedule_id, country, currency, kind, period_start, period_end, pay_date,
         tax_year, period_number, status, included_employee_ids, notes, prepared_by)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::date, $10, $11, 'draft', $12, $13, $14)",
    )
    .bind(&id)
    .bind(s(&employer, "id"))
    .bind(schedule.as_ref().map(|r| s(r, "id")))
    .bind(&country)
    .bind(s(&employer, "currency"))
    .bind(kind)
    .bind(&period_start)
    .bind(&period_end)
    .bind(&pay_date)
    .bind(i32::try_from(tax_year).unwrap_or_default())
    .bind(i32::try_from(period_number).unwrap_or_default())
    .bind(included.as_ref().map(|ids| json!(ids)))
    .bind(str_of(input, "notes"))
    .bind(user_id)
    .execute(db)
    .await;
    if let Err(error) = inserted {
        if is_unique_violation(&error) {
            let existing: Option<String> = sqlx::query_scalar(
                "select id from hr_pay_runs where pay_schedule_id = $1 and period_start = $2::date and kind = 'regular'
                 and status <> 'cancelled' limit 1",
            )
            .bind(schedule.as_ref().map(|r| s(r, "id")))
            .bind(&period_start)
            .fetch_optional(db)
            .await?;
            let suffix = existing.map(|id| format!(" ({id})")).unwrap_or_default();
            return Err(HrError::conflict(format!("A pay run for {period_start} - {period_end} already exists{suffix}")));
        }
        return Err(error.into());
    }
    let run = require_run(db, &id).await?;
    let count = candidate_employee_ids(db, &run).await?.len();
    sqlx::query("update hr_pay_runs set employee_count = $2 where id = $1")
        .bind(&id)
        .bind(i32::try_from(count).unwrap_or_default())
        .execute(db)
        .await?;
    let mut run = run;
    run["employeeCount"] = json!(count);
    Ok(run)
}

async fn create_correction_run(db: &PgPool, input: &Value, employer: &Value, user_id: &str) -> Result<Value, HrError> {
    let corrected = require_run(db, str_of(input, "correctsRunId").unwrap_or("")).await?;
    if corrected["employerId"] != employer["id"] {
        return Err(HrError::validation("The corrected run belongs to another employer"));
    }
    if corrected["kind"] == "correction" {
        return Err(HrError::validation("Correct the original run, not a correction"));
    }
    if corrected["status"] != "approved" && corrected["status"] != "paid" {
        return Err(HrError::conflict("Only an approved or paid run can be corrected. Change a draft run directly."));
    }
    let corrected_id = s(&corrected, "id");
    let originals: Vec<String> =
        sqlx::query_scalar("select employee_id from hr_payslips where run_id = $1 and status = 'final'")
            .bind(corrected_id)
            .fetch_all(db)
            .await?;
    let eligible: HashSet<&String> = originals.iter().collect();
    let wanted = super::common::string_array(&input["employeeIds"]);
    let source: Vec<String> = if wanted.is_empty() { originals.clone() } else { wanted };
    let mut selected: Vec<String> = vec![];
    for id in source {
        if !selected.contains(&id) {
            selected.push(id);
        }
    }
    if selected.is_empty() {
        return Err(HrError::validation("There are no payslips to correct in that run"));
    }
    let not_in_run: Vec<&String> = selected.iter().filter(|id| !eligible.contains(id)).collect();
    if !not_in_run.is_empty() {
        return Err(HrError::Validation {
            message: "Some employees have no payslip in the corrected run".into(),
            details: Some(json!({ "employeeIds": not_in_run })),
        });
    }
    let open: Vec<Option<Value>> = sqlx::query_scalar(
        "select included_employee_ids from hr_pay_runs where corrects_run_id = $1 and status in ('draft', 'calculated')",
    )
    .bind(corrected_id)
    .fetch_all(db)
    .await?;
    let busy: HashSet<String> = open.iter().flatten().flat_map(string_list).collect();
    if selected.iter().any(|id| busy.contains(id)) {
        return Err(HrError::conflict("Another open correction run already covers some of these employees"));
    }
    let pay_date = str_of(input, "payDate").map_or_else(today_iso, str::to_owned);
    assert_correction_in_year(int_of(&corrected, "taxYear"), &pay_date)?;
    let id = generate_id("hrpr");
    sqlx::query(
        "insert into hr_pay_runs (id, employer_id, pay_schedule_id, country, currency, kind, corrects_run_id, period_start,
         period_end, pay_date, tax_year, period_number, status, employee_count, included_employee_ids, notes, prepared_by)
         values ($1, $2, $3, $4, $5, 'correction', $6, $7::date, $8::date, $9::date, $10, $11, 'draft', $12, $13, $14, $15)",
    )
    .bind(&id)
    .bind(s(employer, "id"))
    .bind(corrected["payScheduleId"].as_str())
    .bind(s(&corrected, "country"))
    .bind(s(&corrected, "currency"))
    .bind(corrected_id)
    .bind(s(&corrected, "periodStart"))
    .bind(s(&corrected, "periodEnd"))
    .bind(&pay_date)
    .bind(i32::try_from(int_of(&corrected, "taxYear")).unwrap_or_default())
    .bind(i32::try_from(int_of(&corrected, "periodNumber")).unwrap_or_default())
    .bind(i32::try_from(selected.len()).unwrap_or_default())
    .bind(json!(selected))
    .bind(str_of(input, "notes"))
    .bind(user_id)
    .execute(db)
    .await?;
    // Start from the inputs that produced each payslip as it stands.
    let original_slips: Vec<(String, String)> = sqlx::query_as(
        "select id, employee_id from hr_payslips where run_id = $1 and status = 'final' and employee_id = any($2)",
    )
    .bind(corrected_id)
    .bind(&selected)
    .fetch_all(db)
    .await?;
    let prior: Vec<(String, String, Option<String>)> = if original_slips.is_empty() {
        vec![]
    } else {
        let ids: Vec<&String> = original_slips.iter().map(|(id, _)| id).collect();
        sqlx::query_as(
            "select employee_id, run_id, number from hr_payslips where corrects_payslip_id = any($1) and status = 'final'",
        )
        .bind(ids)
        .fetch_all(db)
        .await?
    };
    let mut source_run_of: Vec<(String, String)> = vec![];
    for employee in &selected {
        let mut candidates: Vec<&(String, String, Option<String>)> = prior.iter().filter(|(e, _, _)| e == employee).collect();
        candidates.sort_by(|x, y| {
            let seq = |n: &Option<String>| number_key(n.as_deref()).map_or(0, |(_, s)| s);
            seq(&y.2).cmp(&seq(&x.2))
        });
        let source = candidates.first().map_or_else(|| corrected_id.to_owned(), |c| c.1.clone());
        source_run_of.push((employee.clone(), source));
    }
    let mut source_runs: Vec<String> = vec![];
    for (_, run) in &source_run_of {
        if !source_runs.contains(run) {
            source_runs.push(run.clone());
        }
    }
    let originals = rows_of(
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select {INPUT_ROW} from hr_pay_run_inputs i where i.run_id = any($1)")))
            .bind(&source_runs)
            .fetch_all(db)
            .await?,
    );
    let copies: Vec<&Value> = originals
        .iter()
        .filter(|row| source_run_of.iter().any(|(e, r)| e == s(row, "employeeId") && r == s(row, "runId")))
        .collect();
    if !copies.is_empty() {
        let mut tx = db.begin().await?;
        for row in copies {
            sqlx::query(
                "insert into hr_pay_run_inputs (id, run_id, employee_id, code, label, quantity, rate, amount, work_date, source,
                 source_ref, notes, created_by) values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::date,
                 'manual', null, $10, $11)",
            )
            .bind(generate_id("hrpi"))
            .bind(&id)
            .bind(s(row, "employeeId"))
            .bind(s(row, "code"))
            .bind(row["label"].as_str())
            .bind(row["quantity"].as_str())
            .bind(row["rate"].as_str())
            .bind(row["amount"].as_str())
            .bind(row["workDate"].as_str())
            .bind(row["notes"].as_str())
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }
    require_run(db, &id).await
}

/// `updateRun(db, id, input)`.
pub(crate) async fn update_run(db: &PgPool, id: &str, input: &Value) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    let pay_date = str_of(input, "payDate");
    let changed = pay_date.is_some_and(|d| d != s(&run, "payDate"));
    let dated = match pay_date {
        Some(date) if changed => Some(numbering_for_pay_date(db, &run, date).await?),
        _ => None,
    };
    let rows: Vec<String> = sqlx::query_scalar(
        "update hr_pay_runs set
           pay_date = coalesce($2::date, pay_date),
           tax_year = coalesce($3, tax_year),
           period_number = coalesce($4, period_number),
           notes = case when $5 then $6 else notes end,
           status = case when $7 and status = 'calculated' then 'draft' else status end,
           updated_at = $8::timestamp
         where id = $1 and status in ('draft', 'calculated') returning id",
    )
    .bind(id)
    .bind(pay_date)
    .bind(dated.map(|(y, _)| i32::try_from(y).unwrap_or_default()))
    .bind(dated.map(|(_, n)| i32::try_from(n).unwrap_or_default()))
    .bind(has(input, "notes"))
    .bind(str_of(input, "notes"))
    .bind(changed)
    .bind(now())
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    require_run(db, id).await
}

/// `cancelRun(db, id)`: its draft payslips go with it.
pub(crate) async fn cancel_run(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    let at = now();
    let rows: Vec<String> = sqlx::query_scalar(
        "update hr_pay_runs set status = 'cancelled', cancelled_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1 and status in ('draft', 'calculated') returning id",
    )
    .bind(id)
    .bind(&at)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    sqlx::query("delete from hr_payslips where run_id = $1 and status = 'draft'").bind(id).execute(db).await?;
    require_run(db, id).await
}

/// `setRunEmployee(db, id, employeeId, excluded)`.
pub(crate) async fn set_run_employee(db: &PgPool, id: &str, employee_id: &str, excluded: bool) -> Result<Value, HrError> {
    let run = require_run(db, id).await?;
    assert_editable(&run)?;
    if !candidate_employee_ids(db, &run).await?.iter().any(|c| c == employee_id) {
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
    let rows: Vec<String> = sqlx::query_scalar(
        "update hr_pay_runs set excluded_employee_ids = $2,
           status = case when status = 'calculated' then 'draft' else status end, updated_at = $3::timestamp
         where id = $1 and status in ('draft', 'calculated') returning id",
    )
    .bind(id)
    .bind(json!(next))
    .bind(now())
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    if excluded {
        sqlx::query("delete from hr_payslips where run_id = $1 and employee_id = $2 and status = 'draft'")
            .bind(id)
            .bind(employee_id)
            .execute(db)
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
pub(crate) async fn run_input_rows(db: &PgPool, run_id: &str, employee_ids: Option<&[String]>) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {INPUT_ROW} from hr_pay_run_inputs i where i.run_id = $1 and ($2::text[] is null or i.employee_id = any($2))"
    )))
    .bind(run_id)
    .bind(employee_ids)
    .fetch_all(db)
    .await?;
    Ok(rows_of(rows))
}

/// `listRunInputs(db, runId, { employeeId })`.
pub(crate) async fn list_run_inputs(db: &PgPool, run_id: &str, employee_id: Option<&str>) -> Result<Vec<Value>, HrError> {
    require_run(db, run_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {INPUT_ROW} from hr_pay_run_inputs i where i.run_id = $1 and ($2::text is null or i.employee_id = $2)
         order by i.employee_id asc, i.created_at asc"
    )))
    .bind(run_id)
    .bind(employee_id.filter(|e| !e.is_empty()))
    .fetch_all(db)
    .await?;
    Ok(rows_of(rows).iter().map(to_input_dto).collect())
}

fn validate_input(country: &str, code: &str, quantity: Option<f64>, amount: Option<f64>) -> Result<(), HrError> {
    let Some(def) = component_def(code) else {
        return Err(HrError::validation(format!("Unknown pay code '{code}'")));
    };
    if !def.countries.contains(&country_of(country)) {
        return Err(HrError::validation(format!("'{code}' is not available for {country} payroll")));
    }
    if !def.one_off {
        return Err(HrError::validation(format!("'{code}' is set up on the employee, not entered on a pay run")));
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
    let row: Option<Value> =
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select {INPUT_ROW} from hr_pay_run_inputs i where i.id = $1 limit 1")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// `createRunInput(db, runId, input, { userId })`.
pub(crate) async fn create_run_input(db: &PgPool, run_id: &str, input: &Value, user_id: &str) -> Result<Value, HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    let employee_id = str_of(input, "employeeId").unwrap_or("");
    if !candidate_employee_ids(db, &run).await?.iter().any(|c| c == employee_id) {
        return Err(HrError::validation("That employee is not part of this run"));
    }
    let code = str_of(input, "code").unwrap_or("");
    let number = |key: &str| input.get(key).and_then(Value::as_f64);
    validate_input(s(&run, "country"), code, number("quantity"), number("amount"))?;
    if let Some(date) = str_of(input, "workDate") {
        if !is_iso_date(date) {
            return Err(HrError::validation("workDate is not a date"));
        }
    }
    touch_run(db, run_id).await?;
    let id = generate_id("hrpi");
    sqlx::query(
        "insert into hr_pay_run_inputs (id, run_id, employee_id, code, label, quantity, rate, amount, work_date, source, notes,
         created_by) values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::date, 'manual', $10, $11)",
    )
    .bind(&id)
    .bind(run_id)
    .bind(employee_id)
    .bind(code)
    .bind(str_of(input, "label"))
    .bind(number("quantity").map(decimal4))
    .bind(number("rate").map(decimal4))
    .bind(number("amount").map(decimal2))
    .bind(str_of(input, "workDate"))
    .bind(str_of(input, "notes"))
    .bind(user_id)
    .execute(db)
    .await?;
    let row = input_row(db, &id).await?.ok_or_else(|| HrError::internal("input vanished"))?;
    Ok(to_input_dto(&row))
}

async fn require_input(db: &PgPool, run_id: &str, input_id: &str) -> Result<Value, HrError> {
    match input_row(db, input_id).await? {
        Some(row) if row["runId"] == run_id => Ok(row),
        _ => Err(HrError::not_found("Pay run input", input_id)),
    }
}

/// `updateRunInput(db, runId, inputId, input)`.
pub(crate) async fn update_run_input(db: &PgPool, run_id: &str, input_id: &str, input: &Value) -> Result<Value, HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    let row = require_input(db, run_id, input_id).await?;
    let pick = |key: &str| if has(input, key) { input[key].as_f64() } else { num(&row[key]) };
    validate_input(s(&run, "country"), s(&row, "code"), pick("quantity"), pick("amount"))?;
    let figures_changed = has(input, "quantity") || has(input, "rate") || has(input, "amount");
    touch_run(db, run_id).await?;
    let number = |key: &str, fixed: fn(f64) -> String| input.get(key).and_then(Value::as_f64).map(fixed);
    sqlx::query(
        "update hr_pay_run_inputs set
           label = case when $2 then $3 else label end,
           quantity = case when $4 then $5::numeric else quantity end,
           rate = case when $6 then $7::numeric else rate end,
           amount = case when $8 then $9::numeric else amount end,
           work_date = case when $10 then $11::date else work_date end,
           notes = case when $12 then $13 else notes end,
           source = case when $14 then 'manual' else source end,
           updated_at = $15::timestamp
         where id = $1",
    )
    .bind(input_id)
    .bind(has(input, "label"))
    .bind(str_of(input, "label"))
    .bind(has(input, "quantity"))
    .bind(number("quantity", decimal4))
    .bind(has(input, "rate"))
    .bind(number("rate", decimal4))
    .bind(has(input, "amount"))
    .bind(number("amount", decimal2))
    .bind(has(input, "workDate"))
    .bind(str_of(input, "workDate"))
    .bind(has(input, "notes"))
    .bind(str_of(input, "notes"))
    .bind(figures_changed && row["source"] != "manual")
    .bind(now())
    .execute(db)
    .await?;
    let row = input_row(db, input_id).await?.ok_or_else(|| HrError::internal("input vanished"))?;
    Ok(to_input_dto(&row))
}

/// `deleteRunInput(db, runId, inputId)`.
pub(crate) async fn delete_run_input(db: &PgPool, run_id: &str, input_id: &str) -> Result<(), HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    require_input(db, run_id, input_id).await?;
    touch_run(db, run_id).await?;
    sqlx::query("delete from hr_pay_run_inputs where id = $1").bind(input_id).execute(db).await?;
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
pub(crate) async fn collect_run_inputs(db: &PgPool, run_id: &str, keyring: &Keyring, user_id: &str) -> Result<CollectSummary, HrError> {
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
        sqlx::query("delete from hr_pay_run_inputs where run_id = $1 and source = any($2)")
            .bind(run_id)
            .bind(&collected)
            .execute(db)
            .await?;
        return Ok(summary);
    }
    let data = load_employee_payroll_data(db, &employee_ids, keyring).await?;
    let data_of = |id: &str| data.iter().find(|d| s(&d.employee, "id") == id);
    let country = s(&run, "country").to_owned();
    let (period_start, period_end) = (s(&run, "periodStart").to_owned(), s(&run, "periodEnd").to_owned());

    let taken_rows: Vec<(Option<String>, String, String)> = sqlx::query_as(
        "select i.source_ref, r.period_start::text, r.period_end::text from hr_pay_run_inputs i
         join hr_pay_runs r on r.id = i.run_id
         where i.employee_id = any($1) and i.source_ref is not null
           and i.source in ('attendance', 'leave', 'absence', 'manual') and i.run_id <> $2
           and r.status in ('draft', 'calculated', 'approved', 'paid')
           and r.period_start <= $3::date and r.period_end >= $4::date",
    )
    .bind(&employee_ids)
    .bind(run_id)
    .bind(&period_end)
    .bind(&period_start)
    .fetch_all(db)
    .await?;
    let mut taken: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (reference, start, end) in taken_rows {
        if let Some(reference) = reference.filter(|r| !r.is_empty()) {
            taken.entry(reference).or_default().push((start, end));
        }
    }
    let free_weekdays = |reference: &str, start: &str, end: &str| -> Vec<String> {
        let covered = taken.get(reference).map(Vec::as_slice).unwrap_or_default();
        let mut days = vec![];
        let mut day = start.to_owned();
        while day.as_str() <= end {
            let dow = weekday_of(&day);
            if dow != 0 && dow != 6 && !covered.iter().any(|(s, e)| day.as_str() >= s.as_str() && day.as_str() <= e.as_str()) {
                days.push(day.clone());
            }
            day = add_days(&day, 1);
        }
        days
    };

    let manual: Vec<(String, Option<String>)> =
        sqlx::query_as("select code, source_ref from hr_pay_run_inputs where run_id = $1 and source = 'manual'")
            .bind(run_id)
            .fetch_all(db)
            .await?;
    let manual_keys: HashSet<String> =
        manual.iter().filter_map(|(code, r)| r.as_ref().filter(|r| !r.is_empty()).map(|r| format!("{code}|{r}"))).collect();
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
        compensation_on(&d.compensations, &period_end).and_then(|c| c["payType"].as_str().map(str::to_owned))
    };
    let is_nonexempt = |d: &EmployeePayrollData| -> bool {
        if country != "US" {
            return false;
        }
        let status = d.profile.as_ref().and_then(|p| p["us"]["flsaStatus"].as_str().map(str::to_owned)).unwrap_or_else(|| {
            if pay_type_of(d).as_deref() == Some("hourly") { "nonexempt".into() } else { "exempt".into() }
        });
        status == "nonexempt"
    };
    let paid_by_hours = |d: &EmployeePayrollData| pay_type_of(d).as_deref() == Some("hourly");

    // Attendance
    let attendance: Vec<(String, String, String, Option<i32>)> = sqlx::query_as(
        "select id, employee_id, date::text, worked_minutes from hr_attendance_records
         where employee_id = any($1) and date >= $2::date and date <= $3::date
           and approved_at is not null and worked_minutes > 0
         order by date asc, created_at asc",
    )
    .bind(&employee_ids)
    .bind(&period_start)
    .bind(&period_end)
    .fetch_all(db)
    .await?;
    let mut per_day: Vec<(String, String, i64, String)> = vec![];
    for (id, employee_id, date, minutes) in attendance {
        let Some(d) = data_of(&employee_id) else { continue };
        if !paid_by_hours(d) && !is_nonexempt(d) {
            continue;
        }
        match per_day.iter_mut().find(|(e, day, _, _)| *e == employee_id && *day == date) {
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
    let leave: Vec<(String, String, String, String, f64, bool, String)> = sqlx::query_as(
        "select r.id, r.employee_id, r.start_date::text, r.end_date::text, r.days::float8, t.is_paid, t.name
         from hr_leave_requests r join hr_leave_types t on t.id = r.leave_type_id
         where r.employee_id = any($1) and r.status = 'approved' and r.start_date <= $2::date and r.end_date >= $3::date",
    )
    .bind(&employee_ids)
    .bind(&period_end)
    .bind(&period_start)
    .fetch_all(db)
    .await?;
    for (id, employee_id, start, end, days, is_paid, type_name) in leave {
        let Some(d) = data_of(&employee_id) else { continue };
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
        let absences: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, employee_id, start_date::text, end_date::text, first_day from hr_absences
             where employee_id = any($1) and start_date <= $2::date and (end_date is null or end_date >= $3::date)",
        )
        .bind(&employee_ids)
        .bind(&period_end)
        .bind(&period_start)
        .fetch_all(db)
        .await?;
        for (id, employee_id, start_date, end_date, first_day) in absences {
            let Some(d) = data_of(&employee_id) else { continue };
            if pay_type_of(d).as_deref() != Some("salary") {
                continue;
            }
            let start = max_date(&start_date, &period_start).to_owned();
            let end = min_date(end_date.as_deref().unwrap_or(&period_end), &period_end).to_owned();
            let free = free_weekdays(&id, &start, &end);
            let mut days = free.len() as f64;
            if first_day.as_deref() == Some("half") && start_date.as_str() >= period_start.as_str() && free.contains(&start_date) {
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
    let declarations: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "select id, employee_id, description, amount::text, expense_date::text from hr_declarations
         where employee_id = any($1) and status = 'approved' and currency = $2 and expense_date <= $3::date
           and paid_at is null",
    )
    .bind(&employee_ids)
    .bind(s(&run, "currency"))
    .bind(&period_end)
    .fetch_all(db)
    .await?;
    if !declarations.is_empty() {
        let ids: Vec<&String> = declarations.iter().map(|d| &d.0).collect();
        let taken_ids: HashSet<Option<String>> = sqlx::query_scalar::<_, Option<String>>(
            "select i.source_ref from hr_pay_run_inputs i join hr_pay_runs r on r.id = i.run_id
             where i.source_ref = any($1) and i.run_id <> $2 and r.status in ('draft', 'calculated', 'approved')",
        )
        .bind(ids)
        .bind(run_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .collect();
        for (id, employee_id, description, amount, expense_date) in declarations {
            if taken_ids.contains(&Some(id.clone())) {
                continue;
            }
            let label = String::from_utf16_lossy(&description.encode_utf16().take(160).collect::<Vec<u16>>());
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
    sqlx::query("delete from hr_pay_run_inputs where run_id = $1 and source = any($2)")
        .bind(run_id)
        .bind(&collected)
        .execute(&mut *tx)
        .await?;
    for row in fresh {
        sqlx::query(
            "insert into hr_pay_run_inputs (id, run_id, employee_id, code, label, quantity, rate, amount, work_date, source,
             source_ref, notes, created_by) values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::date, $10,
             $11, null, $12)",
        )
        .bind(generate_id("hrpi"))
        .bind(run_id)
        .bind(&row.employee_id)
        .bind(row.code)
        .bind(&row.label)
        .bind(&row.quantity)
        .bind(&row.rate)
        .bind(&row.amount)
        .bind(&row.work_date)
        .bind(row.source)
        .bind(&row.source_ref)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(summary)
}
