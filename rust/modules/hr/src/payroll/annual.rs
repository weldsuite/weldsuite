//! Annual statements (`services/weldhr/payroll/annual.ts`): the Dutch
//! jaaropgaaf and the US W-2 (employee copy), built from the year's final
//! payslips and rendered to PDF on request.

use std::collections::HashSet;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_payroll_domain::documents::Lang;
use weldsuite_payroll_domain::nl::annual_statement::{
    AnnualEmployee, AnnualEmployer, AnnualPayslip, NlAnnualStatementInput, nl_annual_statement,
};
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::payslip_pdf::render_document_pdf;
use weldsuite_payroll_domain::types::{NlFilingData, UsFilingData};
use weldsuite_payroll_domain::us::forms::{
    UsEmployeeForForms, UsEmployerForForms, UsEmployerStateAccounts, UsPayslipForForms, form_w2,
};

use super::Deps;
use super::common::{address_lines, annual_statement_file_name, engine_error, mask_ssn};
use super::employees::decrypt_sensitive;
use super::notifier::language_of;
use super::payslips::{employee_by_id, employer_by_id};
use super::runs::{payslip_sql, s};
use super::ytd::{compare_number_order, ytd_of};
use crate::employees::display_name_of;
use crate::{HrError, locale_compare};

/// `listAnnualStatements(db, employeeId)`: one per year and employer.
pub(crate) async fn list_annual_statements(
    db: &PgPool,
    employee_id: &str,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<(i32, String, String, String)> = sqlx::query_as(
        "select s.tax_year, s.employer_id, e.name, e.country from hr_payslips s
         join hr_payroll_employers e on e.id = s.employer_id
         where s.employee_id = $1 and s.status = 'final'",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<(i32, String, Value)> = vec![];
    for (year, employer_id, name, country) in rows {
        if seen.insert(format!("{year}|{employer_id}")) {
            out.push((
                year,
                name.clone(),
                json!({
                    "year": year, "employerId": employer_id, "employerName": name,
                    "kind": if country == "NL" { "jaaropgaaf" } else { "w2" },
                }),
            ));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_compare(&a.1, &b.1)));
    Ok(out.into_iter().map(|(_, _, v)| v).collect())
}

fn opt(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The employer's US state accounts (`Object.fromEntries(...)`), in stored
/// key order.
pub(crate) async fn us_employer_for_forms(
    db: &PgPool,
    employer: &Value,
) -> Result<UsEmployerForForms, HrError> {
    let text: Option<String> = sqlx::query_scalar(
        "select (us_settings -> 'states')::text from hr_payroll_employers where id = $1",
    )
    .bind(s(employer, "id"))
    .fetch_optional(db)
    .await?
    .flatten();
    let states: OrderedMap<Value> = text
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let us = &employer["usSettings"];
    Ok(UsEmployerForForms {
        name: s(employer, "legalName").to_owned(),
        ein: opt(&us["ein"]),
        address: address_lines(&employer["address"], "US"),
        deposit_schedule: us["depositSchedule"]
            .as_str()
            .unwrap_or("monthly")
            .to_owned(),
        states: states
            .iter()
            .map(|(state, cfg)| {
                (
                    state.clone(),
                    UsEmployerStateAccounts {
                        withholding_account_number: opt(&cfg["withholdingAccountNumber"]),
                        sui_account_number: opt(&cfg["suiAccountNumber"]),
                    },
                )
            })
            .collect(),
    })
}

/// A payslip's filing data, read in stored key order.
pub(crate) fn us_filing_of(row: &Value) -> Result<UsFilingData, String> {
    serde_json::from_str(row["filingDataText"].as_str().unwrap_or("{}")).map_err(|e| e.to_string())
}

pub(crate) fn nl_filing_of(row: &Value) -> Result<NlFilingData, String> {
    serde_json::from_str(row["filingDataText"].as_str().unwrap_or("{}")).map_err(|e| e.to_string())
}

pub(crate) fn filing_kind(row: &Value) -> &str {
    row["filingData"]["kind"].as_str().unwrap_or("")
}

/// `formPayslip(row)` without the period (the W-2 copy).
pub(crate) fn form_payslip(row: &Value, with_period: bool) -> Result<UsPayslipForForms, String> {
    Ok(UsPayslipForForms {
        payslip_id: s(row, "id").to_owned(),
        employee_id: s(row, "employeeId").to_owned(),
        pay_date: s(row, "payDate").to_owned(),
        filing_data: us_filing_of(row)?,
        period_start: with_period.then(|| s(row, "periodStart").to_owned()),
        period_end: with_period.then(|| s(row, "periodEnd").to_owned()),
    })
}

/// `annualStatementPdf(db, employeeId, year, employerId, deps)`.
pub(crate) async fn annual_statement_pdf(
    db: &PgPool,
    employee_id: &str,
    year: i64,
    employer_id: &str,
    deps: &Deps,
) -> Result<(Vec<u8>, String), HrError> {
    let employer = employer_by_id(db, employer_id).await?;
    let employee = employee_by_id(db, employee_id).await?;
    let not_found = || HrError::not_found("Annual statement", &format!("{employer_id}/{year}"));
    let (Some(employer), Some(employee)) = (employer, employee) else {
        return Err(not_found());
    };
    let mut slips: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employee_id = $1 and s.employer_id = $2 and s.tax_year = $3 and s.status = 'final' order by s.pay_date asc",
    ))
    .bind(employee_id)
    .bind(employer_id)
    .bind(i32::try_from(year).unwrap_or_default())
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    slips.sort_by(compare_number_order);
    if slips.is_empty() {
        return Err(not_found());
    }
    let sensitive = decrypt_sensitive(&employee, &deps.keyring)?;
    let profile: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let profile = profile.map(js_row);
    let lang = if language_of(&employer) == "nl" {
        Lang::Nl
    } else {
        Lang::En
    };
    let country = s(&employer, "country");
    let file_name = annual_statement_file_name(country, year);
    let home = sensitive.get("homeAddress").cloned().unwrap_or(Value::Null);

    if country == "NL" {
        let pick = |key: &str| {
            profile
                .as_ref()
                .and_then(|p| p[key].as_str())
                .or_else(|| employee[key].as_str())
                .map(str::to_owned)
        };
        let mut payslips = vec![];
        for slip in slips.iter().filter(|x| filing_kind(x) == "nl") {
            let filing_data = nl_filing_of(slip).map_err(|e| {
                engine_error(
                    "The jaaropgaaf builder",
                    &weldsuite_payroll_domain::PayrollError(e),
                )
            })?;
            payslips.push(AnnualPayslip {
                pay_date: s(slip, "payDate").to_owned(),
                filing_data,
                ytd: ytd_of(slip),
            });
        }
        let input = NlAnnualStatementInput {
            lang,
            year,
            employer: AnnualEmployer {
                name: s(&employer, "legalName").to_owned(),
                loonheffingennummer: opt(&employer["nlSettings"]["loonheffingennummer"]),
                address: address_lines(&employer["address"], "NL"),
            },
            employee: AnnualEmployee {
                name: display_name_of(&employee),
                bsn: opt(&sensitive["nationalId"]),
                date_of_birth: opt(&sensitive["dateOfBirth"]),
                address: address_lines(&home, "NL"),
                employment_start: pick("startDate"),
                employment_end: pick("endDate"),
                personnel_number: opt(&employee["employeeNumber"]),
            },
            payslips,
        };
        let doc = nl_annual_statement(&input);
        return Ok((render_document_pdf(&doc), file_name));
    }

    let employer_forms = us_employer_for_forms(db, &employer).await?;
    let mut payslips = vec![];
    for slip in slips.iter().filter(|x| filing_kind(x) == "us") {
        payslips.push(form_payslip(slip, false).map_err(|e| {
            engine_error(
                "The W-2 builder",
                &weldsuite_payroll_domain::PayrollError(e),
            )
        })?);
    }
    let employee_forms = UsEmployeeForForms {
        employee_id: employee_id.to_owned(),
        name: display_name_of(&employee),
        ssn: mask_ssn(sensitive.get("nationalId").and_then(Value::as_str)),
        address: address_lines(&home, "US"),
    };
    let result = form_w2(&employer_forms, &employee_forms, year, &payslips)
        .map_err(|e| engine_error("The W-2 builder", &e))?;
    Ok((render_document_pdf(&result.document), file_name))
}
