//! Payslips (`services/weldhr/payroll/payslips.ts`): the DTOs, the
//! printable view, the PDF (stored in R2 once final, rendered on the fly
//! with a watermark while draft) and the employee's own list.

use serde_json::{Value, json};
use weldsuite_db::{Keyring, PgPool, js_row};
use weldsuite_payroll_domain::documents::Lang;
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::payslip_pdf::{PayslipView, PayslipYtdView, payslip_line_key, render_payslip_pdf};
use weldsuite_payroll_domain::types::PayslipLine;
use weldsuite_ports::PutOptions;

use super::Deps;
use super::common::{address_lines, mask_iban, mask_national_id, sort_issues, truthy_str};
use super::corrections::{Totals, row_totals};
use super::employees::decrypt_sensitive;
use super::notifier::language_of;
use super::runs::{int_of, payslip_sql, s};
use super::ytd::approved_before;
use crate::HrError;
use crate::employees::display_name_of;

/// `requirePayslip(db, id, onlyEmployeeId?)`: someone else's (or a draft)
/// reads as missing.
pub(crate) async fn require_payslip(db: &PgPool, id: &str, only_employee_id: Option<&str>) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(payslip_sql("s.id = $1 limit 1")).bind(id).fetch_optional(db).await?;
    match row.map(js_row) {
        Some(row) if only_employee_id.is_none_or(|only| row["employeeId"] == only && row["status"] == "final") => Ok(row),
        _ => Err(HrError::not_found("Payslip", id)),
    }
}

async fn row_by_id(db: &PgPool, table: &'static str, id: &str) -> Result<Option<Value>, HrError> {
    let sql = match table {
        "employer" => "select to_jsonb(t) from hr_payroll_employers t where t.id = $1 limit 1",
        _ => "select to_jsonb(t) from hr_employees t where t.id = $1 limit 1",
    };
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(js_row))
}

pub(crate) async fn employer_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    row_by_id(db, "employer", id).await
}

pub(crate) async fn employee_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    row_by_id(db, "employee", id).await
}

fn issues_of(row: &Value) -> Vec<Value> {
    sort_issues(row["issues"].as_array().cloned().unwrap_or_default())
}

/// `getPayslip(db, id)`.
pub(crate) async fn get_payslip(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = require_payslip(db, id, None).await?;
    let employee = employee_by_id(db, s(&row, "employeeId")).await?;
    let employer = employer_by_id(db, s(&row, "employerId")).await?;
    Ok(json!({
        "id": row["id"], "runId": row["runId"], "employeeId": row["employeeId"],
        "employeeName": employee.as_ref().map(display_name_of).unwrap_or_default(),
        "employerId": row["employerId"],
        "employerName": employer.as_ref().and_then(|e| e["name"].as_str()).unwrap_or(""),
        "country": row["country"], "currency": row["currency"], "status": row["status"], "number": row["number"],
        "periodStart": row["periodStart"], "periodEnd": row["periodEnd"], "payDate": row["payDate"],
        "taxYear": row["taxYear"], "periodNumber": row["periodNumber"], "grossPay": row["grossPay"],
        "taxableWage": row["taxableWage"], "employeeTaxes": row["employeeTaxes"],
        "employeeDeductions": row["employeeDeductions"], "reimbursements": row["reimbursements"],
        "netPay": row["netPay"], "employerTaxes": row["employerTaxes"], "employerCost": row["employerCost"],
        "lines": row["lines"], "ytd": row["ytd"], "issues": issues_of(&row),
        "correctsPayslipId": row["correctsPayslipId"], "createdAt": row["createdAt"],
    }))
}

/// `listEmployeePayslips(db, employeeId)`: newest first (back office).
pub(crate) async fn list_employee_payslips(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employee_id = $1 and s.status = 'final' order by s.pay_date desc, s.created_at desc limit 200",
    ))
    .bind(employee_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let Some(employee) = employee_by_id(db, employee_id).await? else {
        return Err(HrError::not_found("Employee", employee_id));
    };
    let name = display_name_of(&employee);
    Ok(rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            json!({
                "id": row["id"], "employeeId": row["employeeId"], "employeeName": name, "status": row["status"],
                "number": row["number"], "grossPay": row["grossPay"], "employeeTaxes": row["employeeTaxes"],
                "netPay": row["netPay"], "employerCost": row["employerCost"], "issues": issues_of(row),
                "previousNetPay": rows.get(index + 1).map_or(Value::Null, |next| next["netPay"].clone()),
                "runId": row["runId"], "periodStart": row["periodStart"], "periodEnd": row["periodEnd"],
                "payDate": row["payDate"], "currency": row["currency"], "employeeDeductions": row["employeeDeductions"],
                "reimbursements": row["reimbursements"],
            })
        })
        .collect())
}

/// `myPayslips(db, employeeId)`: the employee's own final payslips.
pub(crate) async fn my_payslips(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', s.id, 'number', s.number, 'employerName', e.name, 'currency', s.currency,
           'periodStart', s.period_start, 'periodEnd', s.period_end, 'payDate', s.pay_date, 'grossPay', s.gross_pay::text,
           'netPay', s.net_pay::text, 'viewedAt', s.employee_viewed_at)
         from hr_payslips s join hr_payroll_employers e on e.id = s.employer_id
         where s.employee_id = $1 and s.status = 'final'
         order by s.pay_date desc, s.created_at desc limit 240",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `markPayslipViewed(db, id, at)`: the first time the employee opened it.
pub(crate) async fn mark_payslip_viewed(db: &PgPool, id: &str) -> Result<(), HrError> {
    let row = require_payslip(db, id, None).await?;
    if row["employeeViewedAt"].is_null() {
        sqlx::query("update hr_payslips set employee_viewed_at = $2::timestamp where id = $1")
            .bind(id)
            .bind(crate::now())
            .execute(db)
            .await?;
    }
    Ok(())
}

pub(crate) fn lines_of(row: &Value) -> Vec<PayslipLine> {
    row["lines"]
        .as_array()
        .map(|lines| lines.iter().filter_map(|l| serde_json::from_value(l.clone()).ok()).collect())
        .unwrap_or_default()
}

fn totals_view(t: Totals) -> Value {
    t.to_json()
}

/// `ytdViewOf(db, row)`: the year's final payslips approved before it,
/// plus itself.
async fn ytd_view_of(db: &PgPool, row: &Value) -> Result<PayslipYtdView, HrError> {
    let others: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employee_id = $1 and s.employer_id = $2 and s.tax_year = $3 and s.status = 'final'",
    ))
    .bind(s(row, "employeeId"))
    .bind(s(row, "employerId"))
    .bind(i32::try_from(int_of(row, "taxYear")).unwrap_or_default())
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let id = s(row, "id");
    let earlier: Vec<Value> = match row["number"].as_str() {
        Some(number) => approved_before(&others, Some(number)),
        None => others.iter().filter(|o| o["id"] != id).cloned().collect(),
    };
    let mut items: Vec<&Value> = earlier.iter().filter(|o| o["id"] != id).collect();
    items.push(row);
    let mut totals = Totals::default();
    let mut by_line: OrderedMap<f64> = OrderedMap::new();
    for item in items {
        totals = totals.add(row_totals(item), 1.0);
        for line in lines_of(item) {
            let key = payslip_line_key(&line);
            let current = by_line.get(&key).copied().unwrap_or(0.0);
            by_line.insert(key, current + line.amount_cents);
        }
    }
    let totals = serde_json::from_value(totals_view(totals)).map_err(|e| HrError::internal(e.to_string()))?;
    Ok(PayslipYtdView { totals, by_line })
}

fn lang_of(text: &str) -> Lang {
    if text == "nl" { Lang::Nl } else { Lang::En }
}

/// `buildPayslipView(db, row, deps)`.
pub(crate) async fn build_payslip_view(db: &PgPool, row: &Value, keyring: &Keyring) -> Result<(PayslipView, Lang), HrError> {
    let employer = employer_by_id(db, s(row, "employerId")).await?;
    let employee = employee_by_id(db, s(row, "employeeId")).await?;
    let (Some(employer), Some(employee)) = (employer, employee) else {
        return Err(HrError::not_found("Payslip", s(row, "id")));
    };
    let profile: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = $1 limit 1")
            .bind(s(row, "employeeId"))
            .fetch_optional(db)
            .await?;
    let profile = profile.map(js_row);
    let sensitive = decrypt_sensitive(&employee, keyring)?;
    let lang = language_of(&employer);
    let country = s(&employer, "country").to_owned();
    let nl = country == "NL";
    let correction = match row["correctsPayslipId"].as_str().filter(|v| !v.is_empty()) {
        Some(original) => {
            let number: Option<Option<String>> =
                sqlx::query_scalar("select number from hr_payslips where id = $1 limit 1")
                    .bind(original)
                    .fetch_optional(db)
                    .await?;
            json!({ "originalNumber": number.flatten() })
        }
        None => Value::Null,
    };
    let tax_id = if nl {
        truthy_str(&employer["nlSettings"], "loonheffingennummer")
            .map_or(Value::Null, |v| json!({ "label": "Loonheffingennummer", "value": v }))
    } else {
        truthy_str(&employer["usSettings"], "ein").map_or(Value::Null, |v| json!({ "label": "EIN", "value": v }))
    };
    let home = sensitive.get("homeAddress").cloned().unwrap_or(Value::Null);
    let lines = row["lines"].clone();
    let profile_nl = profile.as_ref().map_or(Value::Null, |p| p["nl"].clone());
    let or_false = |key: &str| profile_nl.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(json!(false));
    let minimum = lines
        .as_array()
        .and_then(|l| l.iter().find(|line| line["code"] == "nl.minimum_wage"))
        .map_or(Value::Null, |l| l["amountCents"].clone());
    let pay_to = if nl {
        json!(mask_iban(sensitive.get("bankIban").and_then(Value::as_str)))
    } else {
        match truthy_str(&sensitive, "bankAccountNumber") {
            Some(account) => {
                let units: Vec<u16> = account.encode_utf16().collect();
                let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(4)..]);
                json!(format!("•••• {tail}"))
            }
            None => Value::Null,
        }
    };
    let view = json!({
        "country": country,
        "currency": row["currency"],
        "number": row["number"],
        "employer": {
            "name": employer["name"], "legalName": employer["legalName"],
            "address": address_lines(&employer["address"], &country), "taxId": tax_id,
        },
        "employee": {
            "name": display_name_of(&employee),
            "address": address_lines(&home, &country),
            "employeeNumber": employee["employeeNumber"],
            "jobTitle": employee["jobTitle"],
            "taxIdMasked": mask_national_id(sensitive.get("nationalId").and_then(Value::as_str)),
            "dateOfBirth": if nl { sensitive.get("dateOfBirth").cloned().unwrap_or(Value::Null) } else { Value::Null },
        },
        "period": {
            "start": row["periodStart"], "end": row["periodEnd"], "payDate": row["payDate"],
            "periodNumber": row["periodNumber"], "taxYear": row["taxYear"],
        },
        "lines": lines,
        "totals": totals_view(row_totals(row)),
        "nl": if nl {
            json!({
                "contractHoursPerWeek": profile_nl.get("contractHoursPerWeek").filter(|v| !v.is_null()).cloned()
                    .unwrap_or_else(|| employee["weeklyHours"].clone()),
                "writtenContract": or_false("writtenContract"),
                "indefiniteContract": or_false("indefiniteContract"),
                "onCall": or_false("onCall"),
                "minimumHourlyWageCents": minimum,
            })
        } else { Value::Null },
        "us": if nl { Value::Null } else {
            json!({ "workState": profile.as_ref().and_then(|p| p["us"].get("workState")).cloned().unwrap_or(Value::Null) })
        },
        "payTo": pay_to,
        "correction": correction,
        "watermark": if row["status"] == "final" { Value::Null } else { json!(if lang == "nl" { "CONCEPT" } else { "DRAFT" }) },
    });
    let mut view: PayslipView = serde_json::from_value(view).map_err(|e| HrError::internal(format!("payslip view: {e}")))?;
    view.ytd = Some(ytd_view_of(db, row).await?);
    Ok((view, lang_of(lang)))
}

/// `payslipFileKey(workspaceKey, row)`.
pub(crate) fn payslip_file_key(workspace_key: &str, row: &Value) -> String {
    format!("workspaces/{workspace_key}/hr/payslips/{}/{}.pdf", int_of(row, "taxYear"), s(row, "id"))
}

/// `renderAndStorePayslip(db, row, deps)`: once final, the PDF is kept in
/// R2; failing to store it is logged, never fatal.
pub(crate) async fn render_and_store_payslip(db: &PgPool, row: &Value, deps: &Deps) -> Result<Vec<u8>, HrError> {
    let (view, lang) = build_payslip_view(db, row, &deps.keyring).await?;
    let bytes = render_payslip_pdf(&view, lang);
    if row["status"] == "final" {
        if let Some(bucket) = &deps.bucket {
            let key = payslip_file_key(&deps.workspace_key, row);
            let stored = bucket.put_boxed(&key, bytes.clone(), &PutOptions::content_type("application/pdf".to_owned())).await;
            match stored {
                Ok(_) => {
                    sqlx::query("update hr_payslips set file_key = $2 where id = $1")
                        .bind(s(row, "id"))
                        .bind(&key)
                        .execute(db)
                        .await?;
                }
                Err(error) => tracing::error!(%error, "[payroll] could not store the payslip PDF"),
            }
        }
    }
    Ok(bytes)
}

/// `payslipPdf(db, row, deps)`: the stored file of a final payslip, else
/// rendered (and stored) again; a draft is rendered with a watermark.
pub(crate) async fn payslip_pdf(db: &PgPool, row: &Value, deps: &Deps) -> Result<Vec<u8>, HrError> {
    if row["status"] == "final" {
        if let (Some(key), Some(bucket)) = (row["fileKey"].as_str().filter(|k| !k.is_empty()), &deps.bucket) {
            if key.starts_with(&format!("workspaces/{}/hr/payslips/", deps.workspace_key)) {
                let object = bucket.get_boxed(key).await.map_err(|e| HrError::internal(e.to_string()))?;
                if let Some(object) = object {
                    return Ok(object.bytes);
                }
            }
        }
    }
    render_and_store_payslip(db, row, deps).await
}

/// `employeesToNotify(db, employeeIds)`: employees linked to a workspace
/// member (who can open My HR).
pub(crate) async fn employees_to_notify(db: &PgPool, employee_ids: &[String]) -> Result<Vec<(String, String, String)>, HrError> {
    if employee_ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from hr_employees e where e.id = any($1) and e.deleted_at is null and e.user_id is not null",
    )
    .bind(employee_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).map(|e| (s(&e, "id").to_owned(), s(&e, "email").to_owned(), display_name_of(&e))).collect())
}
