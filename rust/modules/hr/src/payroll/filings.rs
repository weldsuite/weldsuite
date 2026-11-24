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

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
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
use weldsuite_schema::tenant::{
    hr_payroll_employers, hr_payroll_filings, hr_payroll_profiles, hr_payslips,
};

use super::Deps;
use super::annual::{filing_kind, form_payslip, nl_filing_of, us_employer_for_forms};
use super::common::{
    address_lines, end_of_next_month, engine_error, file_safe, incomplete, invalid_with,
    month_bounds, quarter_bounds, safe_id,
};
use super::employees::{
    decrypt_sensitive, employee_rows, jsonb_row, jsonb_rows, pg_numeric,
    transition_income_relationship_number,
};
use super::employer_context::load_employer_for_payroll;
use super::files::{param_text, structured_issues};
use super::runs::{int_of, payslip_rows, s};
use crate::employees::{display_name_of, pg_date};
use crate::entity_scope::Scope;
use crate::{HrError, add_days, locale_compare, now};

/// The filings `filings` matches, as the services read them: the entity's
/// row, `amountDue` as its `numeric(14, 2)` text (what `amount_due::text`
/// read).
async fn filing_rows(
    db: &PgPool,
    filings: Select<hr_payroll_filings::Entity>,
) -> Result<Vec<Value>, HrError> {
    jsonb_rows(filings.all(&orm(db)).await?)
}

/// The final payslips of an employer paid between `from` and `to`
/// (`s.pay_date >= $2::date and s.pay_date <= $3::date`).
fn paid_between(
    employer_id: &str,
    from: &str,
    to: &str,
) -> Result<Select<hr_payslips::Entity>, HrError> {
    Ok(hr_payslips::Entity::find()
        .filter(hr_payslips::Column::EmployerId.eq(employer_id))
        .filter(hr_payslips::Column::Status.eq("final"))
        .filter(hr_payslips::Column::PayDate.gte(pg_date(from)?))
        .filter(hr_payslips::Column::PayDate.lte(pg_date(to)?)))
}

/// `now()` once: the history's ISO text and the `timestamp` written with it.
fn instant() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (iso_timestamp(at), utc_timestamp(at))
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
        hr_payroll_employers::Entity::find()
            .select_only()
            .columns([
                hr_payroll_employers::Column::Id,
                hr_payroll_employers::Column::Name,
                hr_payroll_employers::Column::Currency,
            ])
            .filter(hr_payroll_employers::Column::Id.is_in(ids))
            .into_tuple::<(String, String, String)>()
            .all(&orm(db))
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
    let row = hr_payroll_filings::Entity::find_by_id(id)
        .one(&orm(db))
        .await?;
    jsonb_row(row.ok_or_else(|| HrError::not_found("Payroll filing", id))?)
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
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    let mut filings = hr_payroll_filings::Entity::find()
        .filter(scope.employer_id_in(hr_payroll_filings::Column::EmployerId))
        .order_by_desc(hr_payroll_filings::Column::PeriodStart)
        .order_by_asc(hr_payroll_filings::Column::Kind)
        .limit(500);
    if let Some(employer_id) = employer_id.filter(|v| !v.is_empty()) {
        filings = filings.filter(hr_payroll_filings::Column::EmployerId.eq(employer_id));
    }
    if let Some(year) = year.filter(|y| *y != 0.0) {
        filings = filings.filter(hr_payroll_filings::Column::TaxYear.eq(year as i32));
    }
    if let Some(statuses) = split(status) {
        filings = filings.filter(hr_payroll_filings::Column::Status.is_in(statuses));
    }
    if let Some(kinds) = split(kind) {
        filings = filings.filter(hr_payroll_filings::Column::Kind.is_in(kinds));
    }
    let rows = filing_rows(db, filings).await?;
    to_filing_dtos(db, &rows).await
}

/// `filingsDueSoon(db, today, entity)`: open or ready, due within 45 days or
/// overdue, oldest due first; `scope` is the request's entity scope on the
/// employers.
pub(crate) async fn filings_due_soon(
    db: &PgPool,
    today: &str,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    let rows = filing_rows(
        db,
        hr_payroll_filings::Entity::find()
            .filter(hr_payroll_filings::Column::Status.is_in(["open", "ready"]))
            .filter(hr_payroll_filings::Column::DueDate.lte(pg_date(&add_days(today, 45))?))
            .filter(scope.employer_id_in(hr_payroll_filings::Column::EmployerId))
            .order_by_asc(hr_payroll_filings::Column::DueDate)
            .limit(50),
    )
    .await?;
    to_filing_dtos(db, &rows).await
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

/// `channel`, `external_reference`, `submitted_at` and `submitted_by` back
/// to null: a new version that has not been sent.
fn clear_submission(
    update: sea_orm::UpdateMany<hr_payroll_filings::Entity>,
) -> sea_orm::UpdateMany<hr_payroll_filings::Entity> {
    update
        .col_expr(
            hr_payroll_filings::Column::Channel,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            hr_payroll_filings::Column::ExternalReference,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            hr_payroll_filings::Column::SubmittedAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(
            hr_payroll_filings::Column::SubmittedBy,
            Expr::value(Option::<String>::None),
        )
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
    let (at, stamp) = instant();
    let orm = orm(db);
    let mut touched = vec![];
    for key in keys {
        let tax_year = i32::try_from(key.tax_year).unwrap_or_default();
        let period = i32::try_from(key.period).unwrap_or_default();
        // `($5::text is null and f.state is null) or f.state = $5`.
        let state = match key.state.as_deref() {
            Some(state) => hr_payroll_filings::Column::State.eq(state),
            None => hr_payroll_filings::Column::State.is_null(),
        };
        let existing = hr_payroll_filings::Entity::find()
            .filter(hr_payroll_filings::Column::EmployerId.eq(s(employer, "id")))
            .filter(hr_payroll_filings::Column::Kind.eq(key.kind))
            .filter(hr_payroll_filings::Column::TaxYear.eq(tax_year))
            .filter(hr_payroll_filings::Column::Period.eq(period))
            .filter(state)
            .one(&orm)
            .await?;
        match existing.map(jsonb_row).transpose()? {
            None => {
                let (start, end) = bounds_of(&key);
                let id = generate_id("hrpf");
                hr_payroll_filings::Entity::insert(hr_payroll_filings::ActiveModel {
                    id: Set(id.clone()),
                    employer_id: Set(s(employer, "id").to_owned()),
                    country: Set(s(employer, "country").to_owned()),
                    kind: Set(key.kind.to_owned()),
                    state: Set(key.state.clone()),
                    tax_year: Set(tax_year),
                    period: Set(period),
                    period_start: Set(pg_date(&start)?),
                    period_end: Set(pg_date(&end)?),
                    due_date: Set(Some(pg_date(&fallback_due_date(&key))?)),
                    status: Set("open".to_owned()),
                    history: Set(json!([history_event(
                        &at,
                        "open",
                        user_id,
                        Some("Created by an approved pay run".into()),
                        1
                    )])),
                    ..Default::default()
                })
                .exec_without_returning(&orm)
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
                    let mut reopen = hr_payroll_filings::Entity::update_many()
                        .col_expr(hr_payroll_filings::Column::Status, Expr::value("open"))
                        .col_expr(
                            hr_payroll_filings::Column::Version,
                            Expr::value(i32::try_from(version).unwrap_or_default()),
                        )
                        .col_expr(hr_payroll_filings::Column::History, Expr::value(history))
                        .col_expr(hr_payroll_filings::Column::UpdatedAt, Expr::value(stamp))
                        .filter(hr_payroll_filings::Column::Id.eq(s(&existing, "id")));
                    if sent {
                        reopen = clear_submission(reopen);
                    }
                    reopen.exec(&orm).await?;
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
    let returns = filing_rows(
        db,
        hr_payroll_filings::Entity::find()
            .filter(hr_payroll_filings::Column::EmployerId.eq(employer_id))
            .filter(hr_payroll_filings::Column::Kind.eq("nl_loonaangifte"))
            .filter(
                hr_payroll_filings::Column::TaxYear
                    .eq(i32::try_from(int_of(filing, "taxYear")).unwrap_or_default()),
            ),
    )
    .await?;
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
    let orm = orm(db);
    let slips = payslip_rows(
        &orm,
        paid_between(s(employer, "id"), &month_start, &month_end)?,
    )
    .await?;
    let mut original_ids: Vec<String> = vec![];
    for slip in &slips {
        if let Some(id) = slip["correctsPayslipId"].as_str().filter(|v| !v.is_empty()) {
            ensure_id(&mut original_ids, id);
        }
    }
    let originals: Vec<Value> = if original_ids.is_empty() {
        vec![]
    } else {
        payslip_rows(
            &orm,
            hr_payslips::Entity::find().filter(hr_payslips::Column::Id.is_in(&original_ids)),
        )
        .await?
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
        let paid = payslip_rows(
            &orm,
            paid_between(s(employer, "id"), &start, &end)?
                .filter(hr_payslips::Column::CorrectsPayslipId.is_null()),
        )
        .await?;
        let deltas: Vec<Value> = if paid.is_empty() {
            vec![]
        } else {
            let ids: Vec<&str> = paid.iter().map(|p| s(p, "id")).collect();
            payslip_rows(
                &orm,
                hr_payslips::Entity::find()
                    .filter(hr_payslips::Column::CorrectsPayslipId.is_in(ids))
                    .filter(hr_payslips::Column::Status.eq("final"))
                    .filter(hr_payslips::Column::PayDate.lte(pg_date(&month_end)?)),
            )
            .await?
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
        let people = employee_rows(db, &employee_ids).await?;
        let profiles = jsonb_rows(
            hr_payroll_profiles::Entity::find()
                .filter(hr_payroll_profiles::Column::EmployeeId.is_in(&employee_ids))
                .all(&orm)
                .await?,
        )?;
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
    let mut people = employee_rows(db, &ids).await?;
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
    let orm = orm(db);
    let in_quarter = payslip_rows(&orm, paid_between(s(employer, "id"), &q_start, &q_end)?).await?;
    let in_year = payslip_rows(
        &orm,
        hr_payslips::Entity::find()
            .filter(hr_payslips::Column::EmployerId.eq(s(employer, "id")))
            .filter(hr_payslips::Column::Status.eq("final"))
            .filter(hr_payslips::Column::TaxYear.eq(i32::try_from(tax_year).unwrap_or_default())),
    )
    .await?;
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
    let employer = load_employer_for_payroll(db, s(&filing, "employerId"), &deps.keyring)
        .await?
        .row;
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
                hr_payroll_filings::Entity::update_many()
                    .col_expr(
                        hr_payroll_filings::Column::Issues,
                        Expr::value(issues.clone()),
                    )
                    .col_expr(
                        hr_payroll_filings::Column::UpdatedAt,
                        Expr::value(weldsuite_db::utc_now()),
                    )
                    .filter(hr_payroll_filings::Column::Id.eq(id))
                    .exec(&orm(db))
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
    let (at, stamp) = instant();
    let message = if resubmission {
        format!("Regenerated (version {version})")
    } else {
        "Generated".to_owned()
    };
    let history = with_event(
        &filing,
        history_event(&at, "ready", Some(user_id), Some(message), version),
    );
    // `amount_due = $n::numeric` of `fromCents(amountDueCents)`: the exact decimal text.
    let amount_due = pg_numeric(&from_cents(built.amount_due_cents))?;
    let mut update = hr_payroll_filings::Entity::update_many()
        .col_expr(hr_payroll_filings::Column::Status, Expr::value("ready"))
        .col_expr(
            hr_payroll_filings::Column::Version,
            Expr::value(i32::try_from(version).unwrap_or_default()),
        )
        .col_expr(
            hr_payroll_filings::Column::Summary,
            Expr::value(built.summary.clone()),
        )
        .col_expr(
            hr_payroll_filings::Column::AmountDue,
            Expr::value(amount_due),
        )
        .col_expr(
            hr_payroll_filings::Column::PaymentReference,
            Expr::value(built.payment_reference.clone()),
        )
        .col_expr(hr_payroll_filings::Column::FileKey, Expr::value(file_key))
        .col_expr(
            hr_payroll_filings::Column::FileName,
            Expr::value(built.primary.file_name.clone()),
        )
        .col_expr(
            hr_payroll_filings::Column::ContentType,
            Expr::value(built.primary.content_type.clone()),
        )
        .col_expr(hr_payroll_filings::Column::GeneratedAt, Expr::value(stamp))
        .col_expr(hr_payroll_filings::Column::History, Expr::value(history))
        .col_expr(
            hr_payroll_filings::Column::Issues,
            Expr::value(Value::Array(built.issues)),
        )
        .col_expr(hr_payroll_filings::Column::UpdatedAt, Expr::value(stamp))
        .filter(hr_payroll_filings::Column::Id.eq(id));
    // `due_date = coalesce($5::date, due_date)`.
    if let Some(due) = built.due_date.as_deref() {
        update = update.col_expr(
            hr_payroll_filings::Column::DueDate,
            Expr::value(pg_date(due)?),
        );
    }
    if resubmission {
        update = clear_submission(update);
    }
    update.exec(&orm(db)).await?;
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
    let (at, stamp) = instant();
    // `${filedOn}T12:00:00.000Z` as a `timestamp`: noon of that day.
    let filed_at = match input["filedOn"].as_str().filter(|v| !v.is_empty()) {
        Some(day) => PrimitiveDateTime::new(pg_date(day)?, time::macros::time!(12:00)),
        None => stamp,
    };
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
    hr_payroll_filings::Entity::update_many()
        .col_expr(hr_payroll_filings::Column::Status, Expr::value("filed"))
        .col_expr(
            hr_payroll_filings::Column::Channel,
            Func::coalesce([
                Expr::col(hr_payroll_filings::Column::Channel),
                Expr::value("manual"),
            ])
            .into(),
        )
        .col_expr(
            hr_payroll_filings::Column::ExternalReference,
            Expr::value(external),
        )
        .col_expr(
            hr_payroll_filings::Column::SubmittedBy,
            Expr::value(user_id),
        )
        .col_expr(
            hr_payroll_filings::Column::SubmittedAt,
            Expr::value(filed_at),
        )
        .col_expr(hr_payroll_filings::Column::History, Expr::value(history))
        .col_expr(hr_payroll_filings::Column::UpdatedAt, Expr::value(stamp))
        .filter(hr_payroll_filings::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    require_filing_row(db, id).await
}
