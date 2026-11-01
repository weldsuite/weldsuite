//! Payroll filings (`services/weldhr/payroll/filings.ts`): the Dutch
//! loonaangifte per month, the US 941 per quarter, 940 and W-2/W-3 per
//! year, and the state withholding and unemployment reports per quarter,
//! built from FINAL payslips only.
//!
//! Sending the loonaangifte over Digipoort needs the `PKIoverheid`
//! certificate binding of the Cloudflare worker; this edition has no
//! Digipoort connection, so submitting and refreshing answer as the worker
//! does without one (`DIGIPOORT_NOT_CONFIGURED`), and the file is filed by
//! hand and marked as filed.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::documents::Lang;
use weldsuite_payroll_domain::money::from_cents;
use weldsuite_payroll_domain::nl::loonaangifte::{
    LoonaangifteCorrection, LoonaangifteEmployer, LoonaangifteIkv, LoonaangifteInput, NlAddress,
    NlEmployeeIdentity, PeriodRange, Software, betalingskenmerk, build_loonaangifte,
    loonaangifte_due_date, loonaangifte_summary_document, sum_nl_filing_data,
};
use weldsuite_payroll_domain::payslip_pdf::render_document_pdf;
use weldsuite_payroll_domain::types::NlFilingData;
use weldsuite_payroll_domain::us::forms::{
    EmployeePayslips, Form941Input, UsEmployeeForForms, UsFormResult, form_w3, form940, form941,
    state_unemployment_report, state_withholding_report,
};
use weldsuite_ports::PutOptions;

use super::Deps;
use super::annual::{filing_kind, form_payslip, nl_filing_of, us_employer_for_forms};
use super::common::{
    address_lines, end_of_next_month, engine_error, file_safe, incomplete, invalid_with,
    month_bounds, quarter_bounds, safe_id,
};
use super::employees::{decrypt_sensitive, transition_income_relationship_number};
use super::files::{param_text, structured_issues};
use super::payslips::employer_by_id;
use super::runs::{int_of, payslip_sql, s};
use crate::employees::display_name_of;
use crate::{HrError, add_days, locale_compare, now};

const FILING_ROW: &str = "select to_jsonb(f) || jsonb_build_object('amount_due', f.amount_due::text) from hr_payroll_filings f";

fn filing_sql(filter: &str) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(format!("{FILING_ROW} where {filter}"))
}

/// `quarterOfDate(iso)`.
pub(crate) fn quarter_of_date(iso: &str) -> i64 {
    let month: i64 = iso.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    (month - 1) / 3 + 1
}

/// `toFilingDto(row, ctx)`. `canSubmit` needs Digipoort, which this edition
/// does not have.
pub(crate) fn to_filing_dto(row: &Value, employer_name: &str, currency: Option<&str>) -> Value {
    let currency = currency.map_or_else(
        || if row["country"] == "NL" { "EUR" } else { "USD" }.to_owned(),
        str::to_owned,
    );
    json!({
        "id": row["id"], "employerId": row["employerId"], "employerName": employer_name, "country": row["country"],
        "kind": row["kind"], "state": row["state"], "taxYear": row["taxYear"], "period": row["period"],
        "periodStart": row["periodStart"], "periodEnd": row["periodEnd"], "dueDate": row["dueDate"], "status": row["status"],
        "version": row["version"], "summary": row["summary"], "amountDue": row["amountDue"], "currency": currency,
        "issues": row["issues"], "paymentReference": row["paymentReference"], "fileName": row["fileName"],
        "generatedAt": row["generatedAt"], "channel": row["channel"], "externalReference": row["externalReference"],
        "submittedAt": row["submittedAt"], "history": row["history"], "canSubmit": false,
    })
}

/// `toFilingDtos(db, rows, digipoortAvailable)`.
pub(crate) async fn to_filing_dtos(db: &PgPool, rows: &[Value]) -> Result<Vec<Value>, HrError> {
    let ids: Vec<&str> = rows.iter().map(|r| s(r, "employerId")).collect();
    let employers: HashMap<String, (String, String)> = if ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String, String)>(
            "select id, name, currency from hr_payroll_employers where id = any($1)",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(id, name, currency)| (id, (name, currency)))
        .collect()
    };
    Ok(rows
        .iter()
        .map(|row| {
            let employer = employers.get(s(row, "employerId"));
            to_filing_dto(
                row,
                employer.map_or("", |e| e.0.as_str()),
                employer.map(|e| e.1.as_str()),
            )
        })
        .collect())
}

/// `requireFilingRow(db, id)`.
pub(crate) async fn require_filing_row(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(filing_sql("f.id = $1 limit 1"))
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Payroll filing", id))
}

/// `getFiling(db, id)`.
pub(crate) async fn get_filing(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = require_filing_row(db, id).await?;
    Ok(to_filing_dtos(db, &[row]).await?.remove(0))
}

fn split(value: Option<&str>) -> Option<Vec<String>> {
    value
        .filter(|v| !v.is_empty())
        .map(|v| v.split(',').map(str::to_owned).collect())
}

/// `listFilings(db, filters)`.
pub(crate) async fn list_filings(
    db: &PgPool,
    employer_id: Option<&str>,
    year: Option<f64>,
    status: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(filing_sql(
        "($1::text is null or f.employer_id = $1) and ($2::int is null or f.tax_year = $2)
         and ($3::text[] is null or f.status = any($3)) and ($4::text[] is null or f.kind = any($4))
         order by f.period_start desc, f.kind asc limit 500",
    ))
    .bind(employer_id.filter(|v| !v.is_empty()))
    .bind(year.filter(|y| *y != 0.0).map(|y| y as i32))
    .bind(split(status))
    .bind(split(kind))
    .fetch_all(db)
    .await?;
    to_filing_dtos(db, &rows.into_iter().map(js_row).collect::<Vec<_>>()).await
}

/// `filingsDueSoon(db, today)`: open or ready, due within 45 days or
/// overdue, oldest due first.
pub(crate) async fn filings_due_soon(db: &PgPool, today: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(filing_sql(
        "f.status in ('open', 'ready') and f.due_date <= $1::date order by f.due_date asc limit 50",
    ))
    .bind(add_days(today, 45))
    .fetch_all(db)
    .await?;
    to_filing_dtos(db, &rows.into_iter().map(js_row).collect::<Vec<_>>()).await
}

// ── which filings a payslip belongs to ──────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct FilingKey {
    kind: &'static str,
    state: Option<String>,
    tax_year: i64,
    period: i64,
}

fn filing_keys_for(country: &str, slip: &Value) -> Vec<FilingKey> {
    let pay_date = s(slip, "payDate");
    let pay_year: i64 = pay_date.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    if country == "NL" {
        let month = pay_date.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
        return vec![FilingKey {
            kind: "nl_loonaangifte",
            state: None,
            tax_year: pay_year,
            period: month,
        }];
    }
    let quarter = quarter_of_date(pay_date);
    let tax_year = int_of(slip, "taxYear");
    let mut keys = vec![
        FilingKey {
            kind: "us_941",
            state: None,
            tax_year: pay_year,
            period: quarter,
        },
        FilingKey {
            kind: "us_940",
            state: None,
            tax_year,
            period: 0,
        },
        FilingKey {
            kind: "us_w2",
            state: None,
            tax_year,
            period: 0,
        },
    ];
    if let Some(states) = slip["filingData"]["states"].as_object() {
        for state in states.keys() {
            keys.push(FilingKey {
                kind: "us_state_withholding",
                state: Some(state.clone()),
                tax_year: pay_year,
                period: quarter,
            });
            keys.push(FilingKey {
                kind: "us_state_unemployment",
                state: Some(state.clone()),
                tax_year: pay_year,
                period: quarter,
            });
        }
    }
    keys
}

fn bounds_of(key: &FilingKey) -> (String, String) {
    if key.kind == "nl_loonaangifte" {
        return month_bounds(key.tax_year, key.period);
    }
    if key.period == 0 {
        return (
            format!("{}-01-01", key.tax_year),
            format!("{}-12-31", key.tax_year),
        );
    }
    quarter_bounds(key.tax_year, key.period)
}

fn fallback_due_date(key: &FilingKey) -> String {
    let (_, end) = bounds_of(key);
    if key.kind == "nl_loonaangifte" {
        return loonaangifte_due_date(key.tax_year, key.period);
    }
    if key.kind == "us_940" || key.kind == "us_w2" {
        return format!("{}-01-31", key.tax_year + 1);
    }
    end_of_next_month(&end)
}

const SENT_STATUSES: [&str; 4] = ["submitted", "accepted", "rejected", "filed"];

/// `wasSent(filing)`: the current version went out (by status or history).
pub(crate) fn was_sent(filing: &Value) -> bool {
    let version = filing["version"].as_i64().unwrap_or(1);
    SENT_STATUSES.contains(&s(filing, "status"))
        || filing["history"].as_array().is_some_and(|history| {
            history.iter().any(|e| {
                SENT_STATUSES.contains(&e["status"].as_str().unwrap_or(""))
                    && e["version"].as_i64().unwrap_or(1) == version
            })
        })
}

fn history_event(
    at: &str,
    status: &str,
    by: Option<&str>,
    message: Option<String>,
    version: i64,
) -> Value {
    json!({ "at": at, "status": status, "by": by, "message": message, "version": version })
}

fn with_event(filing: &Value, event: Value) -> Value {
    let mut history = filing["history"].as_array().cloned().unwrap_or_default();
    history.push(event);
    Value::Array(history)
}

/// `ensureFilingsForRun(db, employer, payslips, deps, { userId })`: the
/// filings an approved run feeds; existing ones go back to `open`.
pub(crate) async fn ensure_filings_for_run(
    db: &PgPool,
    employer: &Value,
    payslips: &[Value],
    user_id: Option<&str>,
) -> Result<Vec<(String, bool)>, HrError> {
    let mut keys: Vec<FilingKey> = vec![];
    for slip in payslips {
        for key in filing_keys_for(s(employer, "country"), slip) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let at = now();
    let mut touched = vec![];
    for key in keys {
        let existing: Option<Value> = sqlx::query_scalar(filing_sql(
            "f.employer_id = $1 and f.kind = $2 and f.tax_year = $3 and f.period = $4
             and (($5::text is null and f.state is null) or f.state = $5) limit 1",
        ))
        .bind(s(employer, "id"))
        .bind(key.kind)
        .bind(i32::try_from(key.tax_year).unwrap_or_default())
        .bind(i32::try_from(key.period).unwrap_or_default())
        .bind(key.state.as_deref())
        .fetch_optional(db)
        .await?;
        match existing.map(js_row) {
            None => {
                let (start, end) = bounds_of(&key);
                let id = generate_id("hrpf");
                sqlx::query(
                    "insert into hr_payroll_filings (id, employer_id, country, kind, state, tax_year, period, period_start,
                       period_end, due_date, status, history)
                     values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10::date, 'open', $11)",
                )
                .bind(&id)
                .bind(s(employer, "id"))
                .bind(s(employer, "country"))
                .bind(key.kind)
                .bind(key.state.as_deref())
                .bind(i32::try_from(key.tax_year).unwrap_or_default())
                .bind(i32::try_from(key.period).unwrap_or_default())
                .bind(&start)
                .bind(&end)
                .bind(fallback_due_date(&key))
                .bind(json!([history_event(&at, "open", user_id, Some("Created by an approved pay run".into()), 1)]))
                .execute(db)
                .await?;
                touched.push((id, true));
            }
            Some(existing) => {
                if existing["status"] != "open" {
                    let sent = was_sent(&existing);
                    let current = existing["version"].as_i64().unwrap_or(1);
                    let version = if sent { current + 1 } else { current };
                    let message = if sent {
                        format!(
                            "Reopened as version {version}: new payslips were approved for this period"
                        )
                    } else {
                        "Reopened: new payslips were approved for this period".to_owned()
                    };
                    let history = with_event(
                        &existing,
                        history_event(&at, "open", user_id, Some(message), version),
                    );
                    sqlx::query(
                        "update hr_payroll_filings set status = 'open', version = $2, history = $3,
                           channel = case when $4 then null else channel end,
                           external_reference = case when $4 then null else external_reference end,
                           submitted_at = case when $4 then null else submitted_at end,
                           submitted_by = case when $4 then null else submitted_by end,
                           updated_at = $5::timestamp
                         where id = $1",
                    )
                    .bind(s(&existing, "id"))
                    .bind(i32::try_from(version).unwrap_or_default())
                    .bind(history)
                    .bind(sent)
                    .bind(&at)
                    .execute(db)
                    .await?;
                }
                touched.push((s(&existing, "id").to_owned(), false));
            }
        }
    }
    Ok(touched)
}

// ── generating ──────────────────────────────────────────────────────────────

struct BuiltFile {
    file_name: String,
    content_type: String,
    body: Vec<u8>,
}

struct BuiltFiling {
    primary: BuiltFile,
    extras: Vec<BuiltFile>,
    summary: Value,
    amount_due_cents: f64,
    due_date: Option<String>,
    payment_reference: Option<String>,
    issues: Vec<Value>,
}

/// `initialsOf(firstName)`.
fn initials_of(first_name: &str) -> String {
    let mut out = String::new();
    for part in first_name
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|p| !p.is_empty())
    {
        let first: Vec<u16> = part.encode_utf16().take(1).collect();
        out.push_str(&String::from_utf16_lossy(&first).to_uppercase());
        out.push('.');
    }
    out
}

/// `previouslyReportedTotTeBet(db, employerId, filing, months)`.
async fn previously_reported(
    db: &PgPool,
    employer_id: &str,
    filing: &Value,
    months: &[String],
) -> Result<HashMap<String, f64>, HrError> {
    let mut out = HashMap::new();
    if months.is_empty() {
        return Ok(out);
    }
    let returns: Vec<Value> = sqlx::query_scalar(filing_sql(
        "f.employer_id = $1 and f.kind = 'nl_loonaangifte' and f.tax_year = $2",
    ))
    .bind(employer_id)
    .bind(i32::try_from(int_of(filing, "taxYear")).unwrap_or_default())
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let period = int_of(filing, "period");
    for month in months {
        let month_number: i64 = month.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(0);
        let Some(original) = returns.iter().find(|r| int_of(r, "period") == month_number) else {
            continue;
        };
        let Some(base) = original["summary"]["TotTeBet"]
            .as_f64()
            .filter(|_| !original["generatedAt"].is_null())
        else {
            continue;
        };
        let mut reported = base;
        for other in &returns {
            if int_of(other, "period") >= period || other["id"] == original["id"] {
                continue;
            }
            if let Some(saldo) = other["summary"][format!("Saldo:{month}-01")].as_f64() {
                reported += saldo;
            }
        }
        out.insert(month.clone(), reported);
    }
    Ok(out)
}

fn opt(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn ensure_id(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|x| x == id) {
        list.push(id.to_owned());
    }
}

#[allow(clippy::too_many_lines)]
async fn build_nl(
    db: &PgPool,
    filing: &Value,
    version: i64,
    employer: &Value,
    deps: &Deps,
) -> Result<BuiltFiling, HrError> {
    let settings = &employer["nlSettings"];
    let Some(lhn) = settings["loonheffingennummer"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
    else {
        return Err(incomplete(
            "The employer has no loonheffingennummer",
            "loonheffingennummer",
        ));
    };
    let tax_year = int_of(filing, "taxYear");
    let period = int_of(filing, "period");
    let (month_start, month_end) = month_bounds(tax_year, period);
    let slips: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employer_id = $1 and s.status = 'final' and s.pay_date >= $2::date and s.pay_date <= $3::date",
    ))
    .bind(s(employer, "id"))
    .bind(&month_start)
    .bind(&month_end)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let mut original_ids: Vec<String> = vec![];
    for slip in &slips {
        if let Some(id) = slip["correctsPayslipId"].as_str().filter(|v| !v.is_empty()) {
            ensure_id(&mut original_ids, id);
        }
    }
    let originals: Vec<Value> = if original_ids.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar(payslip_sql("s.id = any($1)"))
            .bind(&original_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect()
    };
    let month_of = |iso: &str| iso.get(0..7).unwrap_or("").to_owned();
    let mut main: Vec<Value> = vec![];
    let mut earlier: Vec<Value> = vec![];
    for slip in &slips {
        let original = slip["correctsPayslipId"]
            .as_str()
            .and_then(|id| originals.iter().find(|o| o["id"] == id));
        match original {
            Some(original) if month_of(s(original, "payDate")) != month_of(s(slip, "payDate")) => {
                if !earlier.iter().any(|e| e["id"] == original["id"]) {
                    earlier.push(original.clone());
                }
            }
            _ => main.push(slip.clone()),
        }
    }
    let mut employee_ids: Vec<String> = vec![];
    for slip in &main {
        ensure_id(&mut employee_ids, s(slip, "employeeId"));
    }
    let mut correction_months: Vec<String> = vec![];
    for original in &earlier {
        let key = month_of(s(original, "payDate"));
        if !correction_months.contains(&key) {
            correction_months.push(key);
        }
    }
    let mut correction_sets: Vec<(String, Vec<Value>)> = vec![];
    for month in &correction_months {
        let year: i64 = month.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
        let m: i64 = month.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
        let (start, end) = month_bounds(year, m);
        let paid: Vec<Value> = sqlx::query_scalar(payslip_sql(
            "s.employer_id = $1 and s.status = 'final' and s.pay_date >= $2::date and s.pay_date <= $3::date
             and s.corrects_payslip_id is null",
        ))
        .bind(s(employer, "id"))
        .bind(&start)
        .bind(&end)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(js_row)
        .collect();
        let deltas: Vec<Value> = if paid.is_empty() {
            vec![]
        } else {
            let ids: Vec<&str> = paid.iter().map(|p| s(p, "id")).collect();
            sqlx::query_scalar(payslip_sql(
                "s.corrects_payslip_id = any($1) and s.status = 'final' and s.pay_date <= $2::date",
            ))
            .bind(ids)
            .bind(&month_end)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect()
        };
        let mut set = paid;
        set.extend(deltas);
        for x in &set {
            ensure_id(&mut employee_ids, s(x, "employeeId"));
        }
        correction_sets.push((month.clone(), set));
    }
    let (people, profiles): (Vec<Value>, Vec<Value>) = if employee_ids.is_empty() {
        (vec![], vec![])
    } else {
        let people: Vec<Value> =
            sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
                .bind(&employee_ids)
                .fetch_all(db)
                .await?
                .into_iter()
                .map(js_row)
                .collect();
        let profiles: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(p) from hr_payroll_profiles p where p.employee_id = any($1)",
        )
        .bind(&employee_ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(js_row)
        .collect();
        (people, profiles)
    };
    let mut sensitive: HashMap<String, Value> = HashMap::new();
    for person in &people {
        sensitive.insert(
            s(person, "id").to_owned(),
            decrypt_sensitive(person, &deps.keyring)?,
        );
    }
    let pays_transition = |row: &Value| {
        row["lines"].as_array().is_some_and(|lines| {
            lines.iter().any(|l| {
                l["code"] == "nl.transition_payment"
                    && l["amountCents"].as_f64().unwrap_or(0.0) != 0.0
            })
        })
    };
    let mut transition: HashMap<String, f64> = HashMap::new();
    for row in main
        .iter()
        .chain(correction_sets.iter().flat_map(|(_, set)| set.iter()))
    {
        let employee_id = s(row, "employeeId");
        if !pays_transition(row) || transition.contains_key(employee_id) {
            continue;
        }
        if let Some(number) = transition_income_relationship_number(db, employee_id)
            .await?
            .filter(|n| *n != 0.0)
        {
            transition.insert(employee_id.to_owned(), number);
        }
    }

    let ikvs_for = |rows: &[Value]| -> Result<Vec<LoonaangifteIkv>, HrError> {
        let mut by_employee: Vec<(String, Vec<&Value>)> = vec![];
        for row in rows {
            if filing_kind(row) != "nl" {
                continue;
            }
            let id = s(row, "employeeId");
            match by_employee.iter_mut().find(|(e, _)| e == id) {
                Some((_, list)) => list.push(row),
                None => by_employee.push((id.to_owned(), vec![row])),
            }
        }
        let mut ikvs = vec![];
        for (employee_id, items) in by_employee {
            let person = people.iter().find(|p| p["id"] == employee_id.as_str());
            let profile = profiles
                .iter()
                .find(|p| p["employeeId"] == employee_id.as_str());
            let (Some(person), Some(profile)) = (person, profile) else {
                continue;
            };
            let empty = json!({});
            let sens = sensitive.get(&employee_id).unwrap_or(&empty);
            let nl = &profile["nl"];
            let address = sens
                .get("homeAddress")
                .filter(|a| !a.is_null())
                .map(|a| NlAddress {
                    street: opt(&a["line1"]),
                    house_number: opt(&a["houseNumber"]),
                    house_number_addition: opt(&a["houseNumberAddition"]),
                    postal_code: opt(&a["postalCode"]),
                    city: opt(&a["city"]),
                    country: opt(&a["country"]),
                });
            let mut filings: Vec<NlFilingData> = vec![];
            for item in &items {
                filings.push(
                    nl_filing_of(item)
                        .map_err(|e| HrError::internal(format!("filing data: {e}")))?,
                );
            }
            let Some(filing) = sum_nl_filing_data(&filings) else {
                continue;
            };
            let start = profile["startDate"]
                .as_str()
                .or_else(|| person["startDate"].as_str())
                .unwrap_or_else(|| s(items[0], "periodStart"))
                .to_owned();
            ikvs.push(LoonaangifteIkv {
                identity: NlEmployeeIdentity {
                    bsn: opt(&sens["nationalId"]),
                    initials: Some(
                        nl["initials"]
                            .as_str()
                            .map_or_else(|| initials_of(s(person, "firstName")), str::to_owned),
                    ),
                    surname_prefix: opt(&nl["surnamePrefix"]),
                    surname: s(person, "lastName").to_owned(),
                    date_of_birth: opt(&sens["dateOfBirth"]),
                    nationality: opt(&nl["nationality"]),
                    gender: nl["gender"].as_i64(),
                    address,
                    personnel_number: opt(&person["employeeNumber"]),
                },
                income_relationship_number: nl["incomeRelationshipNumber"].as_f64().unwrap_or(0.0),
                employment_start: start,
                employment_end: profile["endDate"]
                    .as_str()
                    .or_else(|| person["endDate"].as_str())
                    .map(str::to_owned),
                filing,
                end_reason_code: opt(&nl["endReasonCode"]),
                cao_code: nl["caoCode"].as_f64(),
                transition_payment_income_relationship_number: if items
                    .iter()
                    .any(|i| pays_transition(i))
                {
                    transition.get(&employee_id).copied()
                } else {
                    None
                },
            });
        }
        ikvs.sort_by(|a, b| {
            a.income_relationship_number
                .total_cmp(&b.income_relationship_number)
        });
        Ok(ikvs)
    };

    let previously = previously_reported(db, s(employer, "id"), filing, &correction_months).await?;
    let mut corrections = vec![];
    for (month, set) in &correction_sets {
        let year: i64 = month.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
        let m: i64 = month.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
        let (start, end) = month_bounds(year, m);
        corrections.push(LoonaangifteCorrection {
            period: PeriodRange { start, end },
            ikvs: ikvs_for(set)?,
            previously_reported_tot_te_bet_cents: previously.get(month).copied(),
        });
    }
    let message_id: String = format!("WS-{}-v{version}", safe_id(s(filing, "id")))
        .chars()
        .take(35)
        .collect();
    let input = LoonaangifteInput {
        employer: LoonaangifteEmployer {
            loonheffingennummer: lhn.clone(),
            name: s(employer, "legalName").to_owned(),
            contact_name: opt(&settings["contactName"]),
            contact_phone: opt(&settings["contactPhone"]),
            sector_code: settings["sectorCode"].as_f64(),
        },
        software: Software {
            name: "WeldSuite".into(),
            version: "1.0".into(),
            relation_number: deps.software_relation_number.clone(),
        },
        tax_year,
        period: PeriodRange {
            start: month_start.clone(),
            end: month_end.clone(),
        },
        ikvs: ikvs_for(&main)?,
        corrections,
        created_at: now(),
        message_id,
        kind: None,
    };
    if input
        .ikvs
        .iter()
        .any(|ikv| ikv.income_relationship_number == 0.0 || ikv.income_relationship_number.is_nan())
    {
        return Err(incomplete(
            "An employee on this return has no income relationship number",
            "income_relationship_number",
        ));
    }
    let result = build_loonaangifte(&input);
    let mut relationship_of: HashMap<String, String> = HashMap::new();
    for profile in &profiles {
        if let Some(number) = profile["nl"]["incomeRelationshipNumber"]
            .as_f64()
            .filter(|n| *n != 0.0)
        {
            relationship_of.insert(
                weldsuite_core_domain::js::number_text(number),
                s(profile, "employeeId").to_owned(),
            );
        }
    }
    let issues = structured_issues(&result.issues, &|key, value| {
        if key == "incomeRelationship" {
            relationship_of.get(&param_text(value)).cloned()
        } else {
            None
        }
    });
    if issues.iter().any(|i| i["severity"] == "error") {
        return Err(invalid_with(
            "FILING_INVALID",
            "The loonaangifte has errors and was not stored",
            issues,
        ));
    }
    let lang = if settings["payslipLanguage"] == "en" {
        Lang::En
    } else {
        Lang::Nl
    };
    let summary_doc = loonaangifte_summary_document(&result, &input, lang);
    let extras = vec![BuiltFile {
        file_name: format!("loonaangifte-{tax_year}-{period:02}-summary.pdf"),
        content_type: "application/pdf".into(),
        body: render_document_pdf(&summary_doc),
    }];
    Ok(BuiltFiling {
        primary: BuiltFile {
            file_name: result.file.file_name.clone(),
            content_type: result.file.content_type.clone(),
            body: result.file.content.clone().into_bytes(),
        },
        extras,
        summary: weldsuite_payroll_domain::js::to_value(&result.summary),
        amount_due_cents: result.amount_due_cents,
        due_date: Some(loonaangifte_due_date(tax_year, period)),
        payment_reference: betalingskenmerk(&lhn, tax_year, period),
        issues: issues
            .into_iter()
            .filter(|i| i["severity"] != "error")
            .collect(),
    })
}

/// `usEmployeesForForms(db, rows, deps, { fullSsn })`.
async fn us_employees_for_forms(
    db: &PgPool,
    rows: &[&Value],
    deps: &Deps,
    full_ssn: bool,
) -> Result<Vec<EmployeePayslips>, HrError> {
    let mut by_employee: Vec<(String, Vec<&Value>)> = vec![];
    for row in rows {
        if filing_kind(row) != "us" {
            continue;
        }
        let id = s(row, "employeeId");
        match by_employee.iter_mut().find(|(e, _)| e == id) {
            Some((_, list)) => list.push(row),
            None => by_employee.push((id.to_owned(), vec![row])),
        }
    }
    if by_employee.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<&String> = by_employee.iter().map(|(id, _)| id).collect();
    let mut people: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
            .bind(ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect();
    people.sort_by(|a, b| locale_compare(&display_name_of(a), &display_name_of(b)));
    let mut out = vec![];
    for person in &people {
        let sens = decrypt_sensitive(person, &deps.keyring)?;
        let ssn = sens["nationalId"].as_str().filter(|v| !v.is_empty());
        let ssn = if full_ssn {
            sens["nationalId"].as_str().map(str::to_owned)
        } else {
            ssn.map(|v| {
                let units: Vec<u16> = v.encode_utf16().collect();
                format!(
                    "***-**-{}",
                    String::from_utf16_lossy(&units[units.len().saturating_sub(4)..])
                )
            })
        };
        let home = sens.get("homeAddress").cloned().unwrap_or(Value::Null);
        let mut payslips = vec![];
        if let Some((_, rows)) = by_employee.iter().find(|(id, _)| id == s(person, "id")) {
            for row in rows {
                payslips.push(
                    form_payslip(row, true)
                        .map_err(|e| HrError::internal(format!("filing data: {e}")))?,
                );
            }
        }
        out.push(EmployeePayslips {
            employee: UsEmployeeForForms {
                employee_id: s(person, "id").to_owned(),
                name: display_name_of(person),
                ssn,
                address: address_lines(&home, "US"),
            },
            payslips,
        });
    }
    Ok(out)
}

#[allow(clippy::too_many_lines)]
async fn build_us(
    db: &PgPool,
    filing: &Value,
    employer: &Value,
    deps: &Deps,
) -> Result<BuiltFiling, HrError> {
    let employer_forms = us_employer_for_forms(db, employer).await?;
    let tax_year = int_of(filing, "taxYear");
    let quarter = int_of(filing, "period");
    let (q_start, q_end) = quarter_bounds(tax_year, if quarter == 0 { 1 } else { quarter });
    let in_quarter: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employer_id = $1 and s.status = 'final' and s.pay_date >= $2::date and s.pay_date <= $3::date",
    ))
    .bind(s(employer, "id"))
    .bind(&q_start)
    .bind(&q_end)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let in_year: Vec<Value> = sqlx::query_scalar(payslip_sql(
        "s.employer_id = $1 and s.status = 'final' and s.tax_year = $2",
    ))
    .bind(s(employer, "id"))
    .bind(i32::try_from(tax_year).unwrap_or_default())
    .fetch_all(db)
    .await?
    .into_iter()
    .map(js_row)
    .collect();
    let us_payslips = |rows: &[Value]| -> Result<Vec<_>, HrError> {
        rows.iter()
            .filter(|x| filing_kind(x) == "us")
            .map(|x| {
                form_payslip(x, true).map_err(|e| HrError::internal(format!("filing data: {e}")))
            })
            .collect()
    };
    let kind = s(filing, "kind").to_owned();
    let result: UsFormResult = match kind.as_str() {
        "us_941" => {
            let payslips = us_payslips(&in_quarter)?;
            form941(&Form941Input {
                employer: &employer_forms,
                tax_year,
                quarter,
                payslips: &payslips,
                deposits_cents: None,
                prior_quarter_line12_cents: None,
            })
            .map_err(|e| engine_error("Form 941", &e))?
        }
        "us_940" => {
            let payslips = us_payslips(&in_year)?;
            form940(&employer_forms, tax_year, &payslips, None)
                .map_err(|e| engine_error("Form 940", &e))?
        }
        "us_w2" => {
            let rows: Vec<&Value> = in_year.iter().collect();
            let employees = us_employees_for_forms(db, &rows, deps, true).await?;
            form_w3(&employer_forms, tax_year, &employees)
                .map_err(|e| engine_error("Form W-3", &e))?
        }
        "us_state_withholding" | "us_state_unemployment" => {
            let state = s(filing, "state").to_owned();
            let with_state: Vec<&Value> = in_quarter
                .iter()
                .filter(|x| super::common::truthy(x["filingData"]["states"].get(&state)))
                .collect();
            let employees = us_employees_for_forms(db, &with_state, deps, true).await?;
            if kind == "us_state_withholding" {
                state_withholding_report(&employer_forms, &state, tax_year, quarter, &employees)
                    .map_err(|e| engine_error(&format!("The {state} withholding report"), &e))?
            } else {
                state_unemployment_report(&employer_forms, &state, tax_year, quarter, &employees)
                    .map_err(|e| engine_error(&format!("The {state} unemployment report"), &e))?
            }
        }
        _ => return Err(HrError::conflict("This is not a US filing")),
    };
    let state_suffix = filing["state"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(|st| format!("-{st}"))
        .unwrap_or_default();
    let label = format!(
        "{}{state_suffix}",
        kind.replacen("us_", "", 1).replacen("state_", "state-", 1)
    );
    let quarter_suffix = if quarter == 0 {
        String::new()
    } else {
        format!("-q{quarter}")
    };
    let pdf = BuiltFile {
        file_name: format!("{label}-{tax_year}{quarter_suffix}.pdf"),
        content_type: "application/pdf".into(),
        body: render_document_pdf(&result.document),
    };
    let files: Vec<BuiltFile> = result
        .files
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|f| BuiltFile {
            file_name: f.file_name,
            content_type: f.content_type,
            body: f.content.into_bytes(),
        })
        .collect();
    let state_report = kind == "us_state_withholding" || kind == "us_state_unemployment";
    let (primary, extras) = if state_report && !files.is_empty() {
        let mut files = files.into_iter();
        let first = files.next().unwrap_or(BuiltFile {
            file_name: String::new(),
            content_type: String::new(),
            body: vec![],
        });
        let mut extras = vec![pdf];
        extras.extend(files);
        (first, extras)
    } else {
        (pdf, files)
    };
    Ok(BuiltFiling {
        primary,
        extras,
        summary: weldsuite_payroll_domain::js::to_value(&result.summary),
        amount_due_cents: result.amount_due_cents,
        due_date: Some(result.due_date.clone()).filter(|d| !d.is_empty()),
        payment_reference: None,
        issues: vec![],
    })
}

fn filing_storage_key(deps: &Deps, filing: &Value, version: i64, file_name: &str) -> String {
    format!(
        "workspaces/{}/hr/filings/{}/{}/{}/v{version}/{}",
        deps.workspace_key,
        s(filing, "employerId"),
        int_of(filing, "taxYear"),
        s(filing, "id"),
        file_safe(file_name)
    )
}

fn filing_folder(deps: &Deps, filing: &Value) -> String {
    format!(
        "workspaces/{}/hr/filings/{}/{}/{}/",
        deps.workspace_key,
        s(filing, "employerId"),
        int_of(filing, "taxYear"),
        s(filing, "id")
    )
}

/// `generateFiling(db, id, deps, { userId })`: rebuild from final payslips
/// and store the files.
pub(crate) async fn generate_filing(
    db: &PgPool,
    id: &str,
    deps: &Deps,
    user_id: &str,
) -> Result<Value, HrError> {
    let filing = require_filing_row(db, id).await?;
    let Some(employer) = employer_by_id(db, s(&filing, "employerId")).await? else {
        return Err(HrError::not_found(
            "Payroll employer",
            s(&filing, "employerId"),
        ));
    };
    let Some(bucket) = deps.bucket.clone() else {
        return Err(HrError::payroll(
            "STORAGE_UNAVAILABLE",
            "File storage is not available on this worker",
            503,
        ));
    };
    let resubmission = was_sent(&filing);
    let current = filing["version"].as_i64().unwrap_or(1);
    let version = if resubmission { current + 1 } else { current };
    let built = if filing["country"] == "NL" {
        build_nl(db, &filing, version, &employer, deps).await
    } else {
        build_us(db, &filing, &employer, deps).await
    };
    let built = match built {
        Ok(built) => built,
        Err(error) => {
            if let HrError::Payroll {
                details: Some(details),
                ..
            } = &error
                && let Some(issues) = details.get("issues")
            {
                sqlx::query("update hr_payroll_filings set issues = $2, updated_at = $3::timestamp where id = $1")
                        .bind(id)
                        .bind(issues)
                        .bind(now())
                        .execute(db)
                        .await?;
            }
            return Err(error);
        }
    };
    let mut file_key = String::new();
    for (index, file) in std::iter::once(&built.primary)
        .chain(built.extras.iter())
        .enumerate()
    {
        let key = filing_storage_key(deps, &filing, version, &file.file_name);
        bucket
            .put_boxed(
                &key,
                file.body.clone(),
                &PutOptions::content_type(file.content_type.clone()),
            )
            .await
            .map_err(|e| HrError::internal(e.to_string()))?;
        if index == 0 {
            file_key = key;
        }
    }
    let at = now();
    let message = if resubmission {
        format!("Regenerated (version {version})")
    } else {
        "Generated".to_owned()
    };
    let history = with_event(
        &filing,
        history_event(&at, "ready", Some(user_id), Some(message), version),
    );
    sqlx::query(
        "update hr_payroll_filings set status = 'ready', version = $2, summary = $3, amount_due = $4::numeric,
           due_date = coalesce($5::date, due_date), payment_reference = $6, file_key = $7, file_name = $8, content_type = $9,
           generated_at = $10::timestamp,
           channel = case when $11 then null else channel end,
           external_reference = case when $11 then null else external_reference end,
           submitted_at = case when $11 then null else submitted_at end,
           submitted_by = case when $11 then null else submitted_by end,
           history = $12, issues = $13, updated_at = $10::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(i32::try_from(version).unwrap_or_default())
    .bind(&built.summary)
    .bind(from_cents(built.amount_due_cents))
    .bind(built.due_date.as_deref())
    .bind(built.payment_reference.as_deref())
    .bind(&file_key)
    .bind(&built.primary.file_name)
    .bind(&built.primary.content_type)
    .bind(&at)
    .bind(resubmission)
    .bind(history)
    .bind(Value::Array(built.issues))
    .execute(db)
    .await?;
    require_filing_row(db, id).await
}

/// `filingFile(db, id, deps, name)`: the stored file of a filing; `name`
/// picks one of the extra files beside it.
pub(crate) async fn filing_file(
    db: &PgPool,
    id: &str,
    deps: &Deps,
    name: Option<&str>,
) -> Result<(Vec<u8>, String, String), HrError> {
    let filing = require_filing_row(db, id).await?;
    let missing = || HrError::not_found("Filing file", id);
    let (Some(key), Some(bucket)) = (
        filing["fileKey"].as_str().filter(|k| !k.is_empty()),
        &deps.bucket,
    ) else {
        return Err(missing());
    };
    let folder = &key[..key.rfind('/').map_or(0, |i| i + 1)];
    if !folder.starts_with(&filing_folder(deps, &filing)) {
        return Err(missing());
    }
    let name = name.filter(|n| !n.is_empty());
    let object_key = name.map_or_else(|| key.to_owned(), |n| format!("{folder}{}", file_safe(n)));
    let object = bucket
        .get_boxed(&object_key)
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    let Some(object) = object else {
        return Err(missing());
    };
    let content_type = match name {
        Some(n) if n.ends_with(".pdf") => "application/pdf".to_owned(),
        Some(n) if n.ends_with(".csv") => "text/csv".to_owned(),
        Some(n) if n.ends_with(".xml") => "application/xml".to_owned(),
        Some(_) => "application/octet-stream".to_owned(),
        None => filing["contentType"]
            .as_str()
            .unwrap_or("application/octet-stream")
            .to_owned(),
    };
    let file_name = name.map_or_else(
        || filing["fileName"].as_str().unwrap_or("filing").to_owned(),
        file_safe,
    );
    Ok((object.bytes, file_name, content_type))
}

fn not_configured() -> HrError {
    HrError::payroll(
        "DIGIPOORT_NOT_CONFIGURED",
        "Sending over Digipoort is not set up (it needs the PKIoverheid certificate and the Digipoort connection). Download the file and file it yourself, then mark it as filed.",
        409,
    )
}

/// `submitFiling(db, id, deps, ctx)`: without a Digipoort connection.
pub(crate) async fn submit_filing(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let filing = require_filing_row(db, id).await?;
    if filing["kind"] != "nl_loonaangifte" {
        return Err(HrError::conflict(
            "Only the Dutch loonaangifte can be sent from WeldSuite",
        ));
    }
    Err(not_configured())
}

/// `refreshFilingStatus(db, id, deps, ctx)`: without a Digipoort connection.
pub(crate) async fn refresh_filing_status(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let filing = require_filing_row(db, id).await?;
    if filing["channel"] != "digipoort"
        || filing["externalReference"]
            .as_str()
            .is_none_or(str::is_empty)
    {
        return Err(HrError::conflict("This filing was not sent over Digipoort"));
    }
    Err(not_configured())
}

/// `markFilingFiled(db, id, input, ctx)`.
pub(crate) async fn mark_filing_filed(
    db: &PgPool,
    id: &str,
    input: &Value,
    user_id: &str,
) -> Result<Value, HrError> {
    let filing = require_filing_row(db, id).await?;
    let status = s(&filing, "status");
    if !["ready", "submitted", "rejected"].contains(&status) {
        return Err(HrError::conflict(if status == "open" {
            "Generate the filing before marking it as filed".to_owned()
        } else {
            format!("This filing is already {status}")
        }));
    }
    let at = now();
    let filed_at = input["filedOn"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map_or_else(|| at.clone(), |d| format!("{d}T12:00:00.000Z"));
    let reference = input["externalReference"]
        .as_str()
        .filter(|v| !v.is_empty());
    let message = reference.map_or_else(
        || "Filed by the employer".to_owned(),
        |r| format!("Filed by the employer ({r})"),
    );
    let history = with_event(
        &filing,
        history_event(
            &at,
            "filed",
            Some(user_id),
            Some(message),
            filing["version"].as_i64().unwrap_or(1),
        ),
    );
    let external = match input.get("externalReference") {
        Some(Value::String(r)) => Some(r.clone()),
        _ => filing["externalReference"].as_str().map(str::to_owned),
    };
    sqlx::query(
        "update hr_payroll_filings set status = 'filed', channel = coalesce(channel, 'manual'), external_reference = $2,
           submitted_by = $3, submitted_at = $4::timestamp, history = $5, updated_at = $6::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(external)
    .bind(user_id)
    .bind(&filed_at)
    .bind(history)
    .bind(&at)
    .execute(db)
    .await?;
    require_filing_row(db, id).await
}
