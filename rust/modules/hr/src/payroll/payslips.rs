//! Payslips (`services/weldhr/payroll/payslips.ts`): the DTOs, the
//! printable view, the PDF (stored in R2 once final, rendered on the fly
//! with a watermark while draft) and the employee's own list.

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::{Date, PrimitiveDateTime};
use weldsuite_db::{Keyring, PgPool, orm, utc_now};
use weldsuite_payroll_domain::documents::Lang;
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::payslip_pdf::{
    PayslipView, PayslipYtdView, payslip_line_key, render_payslip_pdf,
};
use weldsuite_payroll_domain::types::PayslipLine;
use weldsuite_ports::PutOptions;
use weldsuite_schema::js;
use weldsuite_schema::tenant::{hr_employees, hr_payroll_employers, hr_payroll_profiles, hr_payslips};

use super::Deps;
use super::common::{address_lines, mask_iban, mask_national_id, sort_issues, truthy_str};
use super::corrections::{Totals, row_totals};
use super::employees::decrypt_sensitive;
use super::employer_context::find_employer_for_payroll;
use super::notifier::language_of;
use super::runs::{int_of, payslip_row, payslip_rows, s};
use super::ytd::approved_before;
use crate::HrError;
use crate::employees::{display_name, display_name_of};
use crate::shared::row_json;

/// `requirePayslip(db, id, onlyEmployeeId?)`: someone else's (or a draft)
/// reads as missing.
pub(crate) async fn require_payslip(
    db: &PgPool,
    id: &str,
    only_employee_id: Option<&str>,
) -> Result<Value, HrError> {
    let row = payslip_row(
        &orm(db),
        hr_payslips::Entity::find().filter(hr_payslips::Column::Id.eq(id)),
    )
    .await?;
    match row {
        Some(row)
            if only_employee_id
                .is_none_or(|only| row["employeeId"] == only && row["status"] == "final") =>
        {
            Ok(row)
        }
        _ => Err(HrError::not_found("Payslip", id)),
    }
}

pub(crate) async fn employer_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    let row = hr_payroll_employers::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json).transpose()?)
}

pub(crate) async fn employee_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    let row = hr_employees::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json).transpose()?)
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
pub(crate) async fn list_employee_payslips(
    db: &PgPool,
    employee_id: &str,
) -> Result<Vec<Value>, HrError> {
    let rows = payslip_rows(
        &orm(db),
        hr_payslips::Entity::find()
            .filter(hr_payslips::Column::EmployeeId.eq(employee_id))
            .filter(hr_payslips::Column::Status.eq("final"))
            .order_by_desc(hr_payslips::Column::PayDate)
            .order_by_desc(hr_payslips::Column::CreatedAt)
            .limit(200),
    )
    .await?;
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

/// A row of the employee's own payslip list (`myPayslips`).
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct MyPayslip {
    id: String,
    number: Option<String>,
    employer_name: String,
    currency: String,
    #[serde(with = "js::date")]
    period_start: Date,
    #[serde(with = "js::date")]
    period_end: Date,
    #[serde(with = "js::date")]
    pay_date: Date,
    #[serde(serialize_with = "js::Numeric::<2>::serialize")]
    gross_pay: BigDecimal,
    #[serde(serialize_with = "js::Numeric::<2>::serialize")]
    net_pay: BigDecimal,
    #[serde(with = "js::timestamp::option")]
    viewed_at: Option<PrimitiveDateTime>,
}

/// `myPayslips(db, employeeId)`: the employee's own final payslips.
pub(crate) async fn my_payslips(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    use hr_payslips::Column;
    let rows: Vec<MyPayslip> = hr_payslips::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Number,
            Column::Currency,
            Column::PeriodStart,
            Column::PeriodEnd,
            Column::PayDate,
            Column::GrossPay,
            Column::NetPay,
        ])
        .column_as(hr_payroll_employers::Column::Name, "employer_name")
        .column_as(Column::EmployeeViewedAt, "viewed_at")
        .join(
            JoinType::InnerJoin,
            hr_payslips::Entity::belongs_to(hr_payroll_employers::Entity)
                .from(Column::EmployerId)
                .to(hr_payroll_employers::Column::Id)
                .into(),
        )
        .filter(Column::EmployeeId.eq(employee_id))
        .filter(Column::Status.eq("final"))
        .order_by_desc(Column::PayDate)
        .order_by_desc(Column::CreatedAt)
        .limit(240)
        .into_model()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?)
}

/// `markPayslipViewed(db, id, at)`: the first time the employee opened it.
pub(crate) async fn mark_payslip_viewed(db: &PgPool, id: &str) -> Result<(), HrError> {
    let row = require_payslip(db, id, None).await?;
    if row["employeeViewedAt"].is_null() {
        hr_payslips::Entity::update_many()
            .col_expr(
                hr_payslips::Column::EmployeeViewedAt,
                Expr::value(utc_now()),
            )
            .filter(hr_payslips::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    }
    Ok(())
}

pub(crate) fn lines_of(row: &Value) -> Vec<PayslipLine> {
    row["lines"]
        .as_array()
        .map(|lines| {
            lines
                .iter()
                .filter_map(|l| serde_json::from_value(l.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn totals_view(t: Totals) -> Value {
    t.to_json()
}

/// `ytdViewOf(db, row)`: the year's final payslips approved before it,
/// plus itself.
async fn ytd_view_of(db: &PgPool, row: &Value) -> Result<PayslipYtdView, HrError> {
    use hr_payslips::Column;
    let others = payslip_rows(
        &orm(db),
        hr_payslips::Entity::find()
            .filter(Column::EmployeeId.eq(s(row, "employeeId")))
            .filter(Column::EmployerId.eq(s(row, "employerId")))
            .filter(Column::TaxYear.eq(i32::try_from(int_of(row, "taxYear")).unwrap_or_default()))
            .filter(Column::Status.eq("final")),
    )
    .await?;
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
    let totals = serde_json::from_value(totals_view(totals))
        .map_err(|e| HrError::internal(e.to_string()))?;
    Ok(PayslipYtdView { totals, by_line })
}

fn lang_of(text: &str) -> Lang {
    if text == "nl" { Lang::Nl } else { Lang::En }
}

/// `buildPayslipView(db, row, deps)`.
pub(crate) async fn build_payslip_view(
    db: &PgPool,
    row: &Value,
    keyring: &Keyring,
) -> Result<(PayslipView, Lang), HrError> {
    let employer = find_employer_for_payroll(db, s(row, "employerId"), keyring)
        .await?
        .map(|employer| employer.row);
    let employee = employee_by_id(db, s(row, "employeeId")).await?;
    let (Some(employer), Some(employee)) = (employer, employee) else {
        return Err(HrError::not_found("Payslip", s(row, "id")));
    };
    let profile = hr_payroll_profiles::Entity::find()
        .filter(hr_payroll_profiles::Column::EmployeeId.eq(s(row, "employeeId")))
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()?;
    let sensitive = decrypt_sensitive(&employee, keyring)?;
    let lang = language_of(&employer);
    let country = s(&employer, "country").to_owned();
    let nl = country == "NL";
    let correction = match row["correctsPayslipId"].as_str().filter(|v| !v.is_empty()) {
        Some(original) => {
            let number: Option<Option<String>> = hr_payslips::Entity::find()
                .select_only()
                .column(hr_payslips::Column::Number)
                .filter(hr_payslips::Column::Id.eq(original))
                .into_tuple()
                .one(&orm(db))
                .await?;
            json!({ "originalNumber": number.flatten() })
        }
        None => Value::Null,
    };
    let tax_id = if nl {
        truthy_str(&employer["nlSettings"], "loonheffingennummer").map_or(
            Value::Null,
            |v| json!({ "label": "Loonheffingennummer", "value": v }),
        )
    } else {
        truthy_str(&employer["usSettings"], "ein")
            .map_or(Value::Null, |v| json!({ "label": "EIN", "value": v }))
    };
    let home = sensitive.get("homeAddress").cloned().unwrap_or(Value::Null);
    let lines = row["lines"].clone();
    let profile_nl = profile.as_ref().map_or(Value::Null, |p| p["nl"].clone());
    let or_false = |key: &str| {
        profile_nl
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(false))
    };
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
    let mut view: PayslipView = serde_json::from_value(view)
        .map_err(|e| HrError::internal(format!("payslip view: {e}")))?;
    view.ytd = Some(ytd_view_of(db, row).await?);
    Ok((view, lang_of(lang)))
}

/// `payslipFileKey(workspaceKey, row)`.
pub(crate) fn payslip_file_key(workspace_key: &str, row: &Value) -> String {
    format!(
        "workspaces/{workspace_key}/hr/payslips/{}/{}.pdf",
        int_of(row, "taxYear"),
        s(row, "id")
    )
}

/// `renderAndStorePayslip(db, row, deps)`: once final, the PDF is kept in
/// R2; failing to store it is logged, never fatal.
pub(crate) async fn render_and_store_payslip(
    db: &PgPool,
    row: &Value,
    deps: &Deps,
) -> Result<Vec<u8>, HrError> {
    let (view, lang) = build_payslip_view(db, row, &deps.keyring).await?;
    let bytes = render_payslip_pdf(&view, lang);
    if row["status"] == "final"
        && let Some(bucket) = &deps.bucket
    {
        let key = payslip_file_key(&deps.workspace_key, row);
        let stored = bucket
            .put_boxed(
                &key,
                bytes.clone(),
                &PutOptions::content_type("application/pdf".to_owned()),
            )
            .await;
        match stored {
            Ok(_) => {
                hr_payslips::Entity::update_many()
                    .col_expr(hr_payslips::Column::FileKey, Expr::value(key))
                    .filter(hr_payslips::Column::Id.eq(s(row, "id")))
                    .exec(&orm(db))
                    .await?;
            }
            Err(error) => tracing::error!(%error, "[payroll] could not store the payslip PDF"),
        }
    }
    Ok(bytes)
}

/// `payslipPdf(db, row, deps)`: the stored file of a final payslip, else
/// rendered (and stored) again; a draft is rendered with a watermark.
pub(crate) async fn payslip_pdf(db: &PgPool, row: &Value, deps: &Deps) -> Result<Vec<u8>, HrError> {
    if row["status"] == "final"
        && let (Some(key), Some(bucket)) = (
            row["fileKey"].as_str().filter(|k| !k.is_empty()),
            &deps.bucket,
        )
        && key.starts_with(&format!("workspaces/{}/hr/payslips/", deps.workspace_key))
    {
        let object = bucket
            .get_boxed(key)
            .await
            .map_err(|e| HrError::internal(e.to_string()))?;
        if let Some(object) = object {
            return Ok(object.bytes);
        }
    }
    render_and_store_payslip(db, row, deps).await
}

/// `employeesToNotify(db, employeeIds)`: employees linked to a workspace
/// member (who can open My HR).
pub(crate) async fn employees_to_notify(
    db: &PgPool,
    employee_ids: &[String],
) -> Result<Vec<(String, String, String)>, HrError> {
    use hr_employees::Column;
    if employee_ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(String, String, String, String, Option<String>)> = hr_employees::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Email,
            Column::FirstName,
            Column::LastName,
            Column::PreferredName,
        ])
        .filter(Column::Id.is_in(employee_ids.iter().map(String::as_str)))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::UserId.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, email, first, last, preferred)| {
            let name = display_name(&first, &last, preferred.as_deref());
            (id, email, name)
        })
        .collect())
}
