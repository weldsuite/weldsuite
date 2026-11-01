//! Files a pay run produces for the employer (`services/weldhr/payroll/files.ts`):
//! the salary payment file (SEPA pain.001 for NL, NACHA for US; the
//! employer uploads it to its own bank) and a CSV of every payslip line.
//! Builder errors come back as a 422 with structured issues.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, decrypt_field, js_row};
use weldsuite_payroll_domain::documents::Lang;
use weldsuite_payroll_domain::labels::payslip_line_label;
use weldsuite_payroll_domain::money::{from_cents, to_cents_text};
use weldsuite_payroll_domain::nacha::{
    NachaCredit, NachaFileInput, NachaOriginator, build_nacha_file,
};
use weldsuite_payroll_domain::sepa::{
    SepaParty, SepaSalaryBatchInput, SepaSalaryPayment, SepaTaxPayment, build_sepa_salary_batch,
};
use weldsuite_payroll_domain::types::PayrollIssue;

use super::Deps;
use super::common::{
    csv_number, csv_text, engine_error, incomplete, invalid_with, num, safe_id, salary_remittance,
    sort_issues,
};
use super::employees::{bank_of, decrypt_sensitive, same_bank};
use super::employers::read_employer_bank;
use super::notifier::language_of;
use super::payslips::employer_by_id;
use super::runs::{payslip_sql, require_run, s};
use crate::employees::display_name_of;
use crate::{HrError, locale_compare, today_iso};

/// A generated file and the warnings the caller audits.
pub(crate) struct PaymentFile {
    pub(crate) file_name: String,
    pub(crate) content_type: String,
    pub(crate) content: String,
    pub(crate) warnings: Vec<Value>,
}

fn utf16_slice(text: &str, start: Option<usize>, len: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let from = start.unwrap_or(0).min(units.len());
    let to = (from + len).min(units.len());
    String::from_utf16_lossy(&units[from..to])
}

fn utf16_tail(text: &str, len: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[units.len().saturating_sub(len)..])
}

/// `missingBankAccounts(message, employeeIds)`: 409 per employee.
fn missing_bank_accounts(message: &str, employee_ids: &[String]) -> HrError {
    HrError::Payroll {
        code: "MISSING_BANK_ACCOUNT".into(),
        message: message.into(),
        status: 409,
        details: Some(json!({
            "employeeIds": employee_ids,
            "issues": employee_ids.iter().map(|id| json!({ "severity": "error", "code": "missing_bank_account", "employeeId": id })).collect::<Vec<_>>(),
        })),
    }
}

/// `structuredIssues(issues, attribute)`.
pub(crate) fn structured_issues(
    issues: &[PayrollIssue],
    attribute: &dyn Fn(&str, &Value) -> Option<String>,
) -> Vec<Value> {
    sort_issues(
        issues
            .iter()
            .map(|issue| {
                let mut employee = None;
                if let Some(params) = &issue.params {
                    for (key, value) in params {
                        employee = attribute(key, value);
                        if employee.is_some() {
                            break;
                        }
                    }
                }
                let mut out = serde_json::Map::new();
                out.insert(
                    "severity".into(),
                    weldsuite_payroll_domain::js::to_value(&issue.severity),
                );
                out.insert("code".into(), json!(issue.code));
                if let Some(employee) = employee {
                    out.insert("employeeId".into(), json!(employee));
                }
                if let Some(params) = &issue.params {
                    out.insert("params".into(), Value::Object(params.clone()));
                }
                Value::Object(out)
            })
            .collect(),
    )
}

/// `String(value)` of a param.
pub(crate) fn param_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => weldsuite_core_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// `buildPaymentFile(db, runId, deps)`.
pub(crate) async fn build_payment_file(
    db: &PgPool,
    run_id: &str,
    deps: &Deps,
) -> Result<PaymentFile, HrError> {
    let run = require_run(db, run_id).await?;
    let status = s(&run, "status");
    if status != "approved" && status != "paid" {
        return Err(HrError::payroll(
            "RUN_NOT_APPROVED",
            "The payment file is available once the run is approved",
            409,
        ));
    }
    let Some(employer) = employer_by_id(db, s(&run, "employerId")).await? else {
        return Err(HrError::not_found(
            "Payroll employer",
            s(&run, "employerId"),
        ));
    };
    let bank = read_employer_bank(&employer, &deps.keyring)?;
    let slips: Vec<Value> = sqlx::query_scalar(payslip_sql("s.run_id = $1 and s.status = 'final'"))
        .bind(run_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(js_row)
        .filter(|x| to_cents_text(x["netPay"].as_str()).unwrap_or(0.0) > 0.0)
        .collect();
    if slips.is_empty() {
        return Err(HrError::payroll(
            "NOTHING_TO_PAY",
            "This run has no payments to make",
            409,
        ));
    }
    let ids: Vec<&str> = slips.iter().map(|x| s(x, "employeeId")).collect();
    let people: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect();
    let person_of = |id: &str| people.iter().find(|p| p["id"] == id);
    let mut sensitive: HashMap<String, Value> = HashMap::new();
    let mut warnings = vec![];
    for slip in &slips {
        let employee_id = s(slip, "employeeId");
        let current = match person_of(employee_id) {
            Some(person) => bank_of(&decrypt_sensitive(person, &deps.keyring)?),
            None => None,
        };
        let sealed = slip["snapshot"]["bankEncrypted"]
            .as_str()
            .filter(|v| !v.is_empty());
        if let Some(sealed) = sealed {
            let plaintext = decrypt_field(sealed, &deps.keyring)
                .map_err(|e| HrError::internal(e.to_string()))?;
            let approved: Value =
                serde_json::from_str(&plaintext).map_err(|e| HrError::internal(e.to_string()))?;
            if !same_bank(Some(&approved), current.as_ref()) {
                warnings.push(json!({ "severity": "warning", "code": "bank_changed_after_approval", "employeeId": employee_id }));
                tracing::warn!(
                    employee_id,
                    run_id,
                    "[payroll] the bank details changed after the run was approved; the payment file uses the approved account"
                );
            }
            sensitive.insert(employee_id.to_owned(), approved);
        } else {
            sensitive.insert(employee_id.to_owned(), current.unwrap_or_else(|| json!({})));
        }
    }
    let (file_name, content_type, content) = if employer["country"] == "NL" {
        build_sepa(
            db,
            &run,
            &employer,
            bank.as_ref(),
            &slips,
            &people,
            &sensitive,
        )
        .await?
    } else {
        build_nacha(&run, &employer, bank.as_ref(), &slips, &people, &sensitive)?
    };
    Ok(PaymentFile {
        file_name,
        content_type,
        content,
        warnings,
    })
}

const CARRYING_STATUSES: [&str; 4] = ["ready", "submitted", "accepted", "filed"];

/// `taxPaymentFor(db, run, employer)`: the previous month's loonheffingen
/// ride along in exactly one run's file.
async fn tax_payment_for(
    db: &PgPool,
    run: &Value,
    employer: &Value,
) -> Result<Option<(f64, String)>, HrError> {
    if run["kind"] == "correction" {
        return Ok(None);
    }
    let pay_date = s(run, "payDate");
    let month: i32 = pay_date.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    let year: i32 = pay_date.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    let filing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) || jsonb_build_object('amount_due', f.amount_due::text) from hr_payroll_filings f
         where f.employer_id = $1 and f.kind = 'nl_loonaangifte' and f.tax_year = $2 and f.period = $3 limit 1",
    )
    .bind(s(employer, "id"))
    .bind(if month == 1 { year - 1 } else { year })
    .bind(if month == 1 { 12 } else { month - 1 })
    .fetch_optional(db)
    .await?;
    let Some(filing) = filing.map(js_row) else {
        return Ok(None);
    };
    let entries = filing["taxPayments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let cents_of = |e: &Value| e["cents"].as_f64().unwrap_or(0.0);
    let mine: Vec<&Value> = entries.iter().filter(|e| e["runId"] == run["id"]).collect();
    if let Some(first) = mine.first() {
        let total = mine.iter().fold(0.0, |n, e| n + cents_of(e));
        return Ok(Some((
            total,
            first["reference"].as_str().unwrap_or("").to_owned(),
        )));
    }
    let carrying = CARRYING_STATUSES.contains(&s(&filing, "status"));
    let reference = filing["paymentReference"]
        .as_str()
        .filter(|v| !v.is_empty());
    let (true, false, Some(reference)) = (carrying, filing["generatedAt"].is_null(), reference)
    else {
        return Ok(None);
    };
    let carried = entries.iter().fold(0.0, |n, e| n + cents_of(e));
    let amount = to_cents_text(filing["amountDue"].as_str()).unwrap_or(0.0) - carried;
    if amount <= 0.0 {
        return Ok(None);
    }
    let mut next = entries.clone();
    next.push(json!({
        "runId": run["id"], "version": filing["version"],
        "cents": weldsuite_core_domain::js::number_value(amount), "reference": reference,
    }));
    let claimed: Vec<String> = sqlx::query_scalar(
        "update hr_payroll_filings set tax_payments = $2
         where id = $1 and version = $3 and status = any($4) and tax_payments = $5 returning id",
    )
    .bind(s(&filing, "id"))
    .bind(Value::Array(next))
    .bind(
        filing["version"]
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or_default(),
    )
    .bind(CARRYING_STATUSES.to_vec())
    .bind(Value::Array(entries))
    .fetch_all(db)
    .await?;
    if claimed.is_empty() {
        return Ok(None);
    }
    Ok(Some((amount, reference.to_owned())))
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

async fn build_sepa(
    db: &PgPool,
    run: &Value,
    employer: &Value,
    bank: Option<&Value>,
    slips: &[Value],
    people: &[Value],
    sensitive: &HashMap<String, Value>,
) -> Result<(String, String, String), HrError> {
    let Some(iban) = bank.and_then(|b| text_of(b, "iban")) else {
        return Err(incomplete(
            "The employer has no bank account (IBAN) to pay salaries from",
            "bank_iban",
        ));
    };
    let bank = bank.cloned().unwrap_or(Value::Null);
    let nl = language_of(employer) == "nl";
    let missing: Vec<String> = slips
        .iter()
        .filter(|x| {
            sensitive
                .get(s(x, "employeeId"))
                .and_then(|b| text_of(b, "bankIban"))
                .is_none()
        })
        .map(|x| s(x, "employeeId").to_owned())
        .collect();
    if !missing.is_empty() {
        return Err(missing_bank_accounts(
            "Some employees have no IBAN",
            &missing,
        ));
    }
    let tax = tax_payment_for(db, run, employer).await?;
    let sepa_id = |id: &str| utf16_slice(&safe_id(id), None, 35);
    let employee_of: HashMap<String, String> = slips
        .iter()
        .map(|x| (sepa_id(s(x, "id")), s(x, "employeeId").to_owned()))
        .collect();
    let now = crate::now();
    let salaries = slips
        .iter()
        .map(|slip| {
            let person = people
                .iter()
                .find(|p| p["id"] == slip["employeeId"])
                .cloned()
                .unwrap_or(Value::Null);
            let sens = sensitive
                .get(s(slip, "employeeId"))
                .cloned()
                .unwrap_or(Value::Null);
            SepaSalaryPayment {
                end_to_end_id: sepa_id(s(slip, "id")),
                creditor: SepaParty {
                    name: sens["bankAccountHolder"]
                        .as_str()
                        .map_or_else(|| display_name_of(&person), str::to_owned),
                    iban: s(&sens, "bankIban").to_owned(),
                    bic: sens["bankBic"].as_str().map(str::to_owned),
                },
                amount_cents: to_cents_text(slip["netPay"].as_str()).unwrap_or(0.0),
                remittance: salary_remittance(s(run, "periodStart"), nl),
            }
        })
        .collect();
    let input = SepaSalaryBatchInput {
        message_id: utf16_slice(&format!("SAL-{}", safe_id(s(run, "id"))), None, 35),
        created_at: now,
        execution_date: execution_date(s(run, "payDate")),
        debtor: SepaParty {
            name: bank["accountHolder"]
                .as_str()
                .or_else(|| employer["legalName"].as_str())
                .unwrap_or("")
                .to_owned(),
            iban,
            bic: bank["bic"].as_str().map(str::to_owned),
        },
        salaries,
        tax: tax.map(|(amount_cents, betalingskenmerk)| SepaTaxPayment {
            amount_cents,
            betalingskenmerk,
            creditor: None,
        }),
    };
    let result = build_sepa_salary_batch(&input);
    let issues = structured_issues(&result.issues, &|_key, value| {
        employee_of.get(&param_text(value)).cloned()
    });
    if issues.iter().any(|i| i["severity"] == "error") {
        return Err(invalid_with(
            "PAYMENT_FILE_INVALID",
            "The salary file has errors and was not produced",
            issues,
        ));
    }
    Ok((
        result.file.file_name,
        result.file.content_type,
        result.file.content,
    ))
}

/// `executionDate(payDate, now)`: never in the past.
fn execution_date(pay_date: &str) -> String {
    let today = today_iso();
    if pay_date >= today.as_str() {
        pay_date.to_owned()
    } else {
        today
    }
}

fn build_nacha(
    run: &Value,
    employer: &Value,
    bank: Option<&Value>,
    slips: &[Value],
    people: &[Value],
    sensitive: &HashMap<String, Value>,
) -> Result<(String, String, String), HrError> {
    let routing = bank.and_then(|b| text_of(b, "routingNumber"));
    let account = bank.and_then(|b| text_of(b, "accountNumber"));
    let company = bank.and_then(|b| text_of(b, "nachaCompanyId"));
    let (Some(routing), Some(_), Some(company)) =
        (routing.clone(), account.clone(), company.clone())
    else {
        let field = if routing.is_none() {
            "bank_routing"
        } else if account.is_none() {
            "bank_account"
        } else {
            "nacha_company_id"
        };
        return Err(incomplete(
            "The employer needs a routing number, account number and NACHA company id to produce an ACH file",
            field,
        ));
    };
    let missing: Vec<String> = slips
        .iter()
        .filter(|x| {
            let sens = sensitive.get(s(x, "employeeId"));
            sens.and_then(|b| text_of(b, "bankRoutingNumber")).is_none()
                || sens.and_then(|b| text_of(b, "bankAccountNumber")).is_none()
        })
        .map(|x| s(x, "employeeId").to_owned())
        .collect();
    if !missing.is_empty() {
        return Err(missing_bank_accounts(
            "Some employees have no bank account",
            &missing,
        ));
    }
    let mut employee_of: HashMap<String, String> = HashMap::new();
    let credits: Vec<NachaCredit> = slips
        .iter()
        .map(|slip| {
            let person = people
                .iter()
                .find(|p| p["id"] == slip["employeeId"])
                .cloned()
                .unwrap_or(Value::Null);
            let sens = sensitive
                .get(s(slip, "employeeId"))
                .cloned()
                .unwrap_or(Value::Null);
            let base = person["employeeNumber"]
                .as_str()
                .map_or_else(|| utf16_tail(s(slip, "id"), 15), str::to_owned);
            let individual_id = utf16_slice(&base, None, 15);
            employee_of.insert(individual_id.clone(), s(slip, "employeeId").to_owned());
            NachaCredit {
                individual_id,
                individual_name: utf16_slice(&display_name_of(&person), None, 22),
                routing_number: s(&sens, "bankRoutingNumber").to_owned(),
                account_number: s(&sens, "bankAccountNumber").to_owned(),
                account_type: sens["bankAccountType"]
                    .as_str()
                    .unwrap_or("checking")
                    .to_owned(),
                amount_cents: to_cents_text(slip["netPay"].as_str()).unwrap_or(0.0),
            }
        })
        .collect();
    let bank = bank.cloned().unwrap_or(Value::Null);
    let input = NachaFileInput {
        originator: NachaOriginator {
            company_name: utf16_slice(s(employer, "name"), None, 16),
            company_id: company,
            odfi_routing: routing,
            odfi_name: utf16_slice(bank["bankName"].as_str().unwrap_or(""), None, 23),
        },
        effective_date: execution_date(s(run, "payDate")),
        created_at: crate::now(),
        file_id_modifier: None,
        entry_description: None,
        credits,
        balanced_offset: None,
    };
    let result =
        build_nacha_file(&input).map_err(|e| engine_error("The NACHA file builder", &e))?;
    let issues = structured_issues(&result.issues, &|_key, value| {
        employee_of.get(&param_text(value)).cloned()
    });
    if issues.iter().any(|i| i["severity"] == "error") {
        return Err(invalid_with(
            "PAYMENT_FILE_INVALID",
            "The ACH file has errors and was not produced",
            issues,
        ));
    }
    Ok((
        result.file.file_name,
        result.file.content_type,
        result.file.content,
    ))
}

/// `buildRunReport(db, runId)`: one CSV row per payslip line.
pub(crate) async fn build_run_report(
    db: &PgPool,
    run_id: &str,
) -> Result<(String, String, String), HrError> {
    let run = require_run(db, run_id).await?;
    let employer = employer_by_id(db, s(&run, "employerId")).await?;
    let lang = if employer.as_ref().is_some_and(|e| language_of(e) == "nl") {
        Lang::Nl
    } else {
        Lang::En
    };
    let slips: Vec<Value> = sqlx::query_scalar(payslip_sql("s.run_id = $1"))
        .bind(run_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(js_row)
        .collect();
    let ids: Vec<&str> = slips.iter().map(|x| s(x, "employeeId")).collect();
    let people: Vec<Value> = if ids.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect()
    };
    let name_of = |id: &str| {
        people
            .iter()
            .find(|p| p["id"] == id)
            .map(display_name_of)
            .unwrap_or_default()
    };
    let header = [
        "employee",
        "employee_id",
        "payslip_number",
        "status",
        "section",
        "code",
        "label",
        "quantity",
        "rate",
        "amount",
        "currency",
    ];
    let mut rows = vec![
        header
            .iter()
            .map(|h| csv_text(h))
            .collect::<Vec<_>>()
            .join(","),
    ];
    let mut ordered: Vec<&Value> = slips.iter().collect();
    ordered
        .sort_by(|a, b| locale_compare(&name_of(s(a, "employeeId")), &name_of(s(b, "employeeId"))));
    for slip in ordered {
        for line in slip["lines"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let opt_text = |v: &Value| v.as_str().map_or_else(String::new, csv_text);
            let opt_num = |v: &Value| num(v).map_or_else(String::new, csv_number);
            let label = payslip_line_label(
                line["labelKey"].as_str().unwrap_or(""),
                line["label"].as_str(),
                lang,
            );
            rows.push(
                [
                    csv_text(&name_of(s(slip, "employeeId"))),
                    csv_text(s(slip, "employeeId")),
                    opt_text(&slip["number"]),
                    csv_text(s(slip, "status")),
                    csv_text(line["section"].as_str().unwrap_or("")),
                    csv_text(line["code"].as_str().unwrap_or("")),
                    csv_text(&label),
                    opt_num(&line["quantity"]),
                    opt_num(&line["rate"]),
                    csv_text(&from_cents(line["amountCents"].as_f64().unwrap_or(0.0))),
                    csv_text(s(slip, "currency")),
                ]
                .join(","),
            );
        }
    }
    let file_name = format!(
        "payroll-{}-{}.csv",
        s(&run, "periodStart"),
        s(&run, "periodEnd")
    );
    Ok((
        file_name,
        "text/csv; charset=utf-8".into(),
        format!("{}\r\n", rows.join("\r\n")),
    ))
}
