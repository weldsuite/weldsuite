//! Payroll employers and pay schedules (`services/weldhr/payroll/
//! {employers,schedules}.ts`).

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, decrypt_field, encrypt_field, js_row};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::periods::{PayDateRule, PayScheduleSpec, next_period_to_run};
use weldsuite_payroll_domain::{PayFrequency, PayrollCountry};

use super::common::{
    is_iso_date, is_valid_iban, is_valid_routing_number, issue, mask_account_number, mask_iban, normalize_bic, normalize_iban,
    sort_issues, truthy_str, year_of_date,
};
use super::schema::str_of;
use crate::{HrError, now, today_iso};

// ── employers ───────────────────────────────────────────────────────────────

/// `requireEmployerRow(db, id)`.
pub(crate) async fn require_employer_row(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_payroll_employers t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Payroll employer", id))
}

/// `readEmployerBank(row, keyring)`.
pub(crate) fn read_employer_bank(row: &Value, keyring: &Keyring) -> Result<Option<Value>, HrError> {
    let Some(sealed) = truthy_str(row, "bankEncrypted") else {
        return Ok(None);
    };
    let plaintext = decrypt_field(sealed, keyring).map_err(|e| HrError::internal(e.to_string()))?;
    serde_json::from_str(&plaintext).map(Some).map_err(|e| HrError::internal(e.to_string()))
}

fn mask_bank(bank: Option<&Value>) -> Value {
    let Some(bank) = bank else {
        return Value::Null;
    };
    let field = |k: &str| bank.get(k).cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null);
    json!({
        "accountHolder": field("accountHolder"),
        "ibanMasked": mask_iban(bank.get("iban").and_then(Value::as_str)),
        "bic": field("bic"),
        "routingNumber": field("routingNumber"),
        "accountNumberMasked": mask_account_number(bank.get("accountNumber").and_then(Value::as_str)),
        "accountType": field("accountType"),
        "nachaCompanyId": field("nachaCompanyId"),
        "bankName": field("bankName"),
    })
}

/// `workStatesOf(profiles)`: the active profiles' work states, sorted.
pub(crate) fn work_states_of(profiles: &[Value]) -> Vec<String> {
    let states: BTreeSet<String> = profiles
        .iter()
        .filter_map(|p| p["us"]["workState"].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .collect();
    let mut out: Vec<String> = states.into_iter().collect();
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out
}

fn truthy_number(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan())
}

/// `employerIssues(row, bank, workStates, year)`.
pub(crate) fn employer_issues(row: &Value, bank: Option<&Value>, work_states: &[String], year: i64) -> Vec<Value> {
    let mut issues = vec![];
    let bank_has = |k: &str| bank.and_then(|b| b.get(k)).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if row["country"] == "NL" {
        let nl = &row["nlSettings"];
        if truthy_str(nl, "loonheffingennummer").is_none() {
            issues.push(issue("error", "employer_incomplete", Some(json!({ "field": "loonheffingennummer" }))));
        }
        if !truthy_number(&nl["sectorCode"]) {
            issues.push(issue("error", "employer_incomplete", Some(json!({ "field": "sectorCode" }))));
        }
        let whk = &nl["years"][year.to_string()]["whkRate"];
        if whk.is_null() {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "whk_rate", "year": year }))));
        }
        if truthy_str(nl, "contactName").is_none() {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "contactName" }))));
        }
        if truthy_str(nl, "contactPhone").is_none() {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "contactPhone" }))));
        }
        if !bank_has("iban") {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "bank_iban" }))));
        }
    } else {
        let us = &row["usSettings"];
        if truthy_str(us, "ein").is_none() {
            issues.push(issue("error", "employer_incomplete", Some(json!({ "field": "ein" }))));
        }
        for state in work_states {
            if us["states"][state]["suiRates"][year.to_string()].is_null() {
                issues.push(issue(
                    "error",
                    "employer_incomplete",
                    Some(json!({ "field": "sui_rate", "state": state, "year": year })),
                ));
            }
        }
        if !bank_has("routingNumber") {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "bank_routing" }))));
        }
        if !bank_has("accountNumber") {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "bank_account" }))));
        }
        if !bank_has("nachaCompanyId") {
            issues.push(issue("warning", "employer_incomplete", Some(json!({ "field": "nacha_company_id" }))));
        }
    }
    sort_issues(issues)
}

async fn entity_names(db: &PgPool, ids: &[String]) -> Result<HashMap<String, String>, HrError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id, name from entities where id = any($1) and deleted_at is null")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// `profilesByEmployer(db, employerIds)`: the active profiles.
pub(crate) async fn profiles_by_employer(db: &PgPool, employer_ids: &[String]) -> Result<HashMap<String, Vec<Value>>, HrError> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if employer_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_payroll_profiles t where t.employer_id = any($1) and t.status = 'active'",
    )
    .bind(employer_ids)
    .fetch_all(db)
    .await?;
    for row in rows.into_iter().map(js_row) {
        let employer = row["employerId"].as_str().unwrap_or("").to_owned();
        out.entry(employer).or_default().push(row);
    }
    Ok(out)
}

/// `toEmployerDtos(db, rows, keyring, today)`.
pub(crate) async fn to_employer_dtos(db: &PgPool, rows: Vec<Value>, keyring: &Keyring, today: &str) -> Result<Vec<Value>, HrError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let entity_ids: Vec<String> =
        rows.iter().filter_map(|r| r["accountingEntityId"].as_str().filter(|s| !s.is_empty()).map(str::to_owned)).collect();
    let ids: Vec<String> = rows.iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let names = entity_names(db, &entity_ids).await?;
    let profiles = profiles_by_employer(db, &ids).await?;
    let year = year_of_date(today);
    let mut out = vec![];
    for row in rows {
        let bank = read_employer_bank(&row, keyring)?;
        let id = row["id"].as_str().unwrap_or("").to_owned();
        let active = profiles.get(&id).cloned().unwrap_or_default();
        let entity = row["accountingEntityId"].as_str().filter(|s| !s.is_empty());
        out.push(json!({
            "id": row["id"],
            "name": row["name"],
            "legalName": row["legalName"],
            "country": row["country"],
            "currency": row["currency"],
            "accountingEntityId": row["accountingEntityId"],
            "accountingEntityName": entity.and_then(|e| names.get(e)).cloned(),
            "address": row["address"],
            "nlSettings": row["nlSettings"],
            "usSettings": row["usSettings"],
            "requireSeparateApprover": row["requireSeparateApprover"],
            "isActive": row["isActive"],
            "bank": mask_bank(bank.as_ref()),
            "employeeCount": active.len(),
            "issues": employer_issues(&row, bank.as_ref(), &work_states_of(&active), year),
            "createdAt": row["createdAt"],
            "updatedAt": row["updatedAt"],
        }));
    }
    Ok(out)
}

/// `listEmployers(db, keyring)`, by name.
pub(crate) async fn list_employers(db: &PgPool, keyring: &Keyring) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_payroll_employers t where t.deleted_at is null order by t.name")
            .fetch_all(db)
            .await?;
    to_employer_dtos(db, rows.into_iter().map(js_row).collect(), keyring, &today_iso()).await
}

/// `getEmployer(db, id, keyring)`.
pub(crate) async fn get_employer(db: &PgPool, id: &str, keyring: &Keyring) -> Result<Value, HrError> {
    let row = require_employer_row(db, id).await?;
    Ok(to_employer_dtos(db, vec![row], keyring, &today_iso()).await?.remove(0))
}

async fn assert_accounting_entity(db: &PgPool, entity_id: &str, country: &str) -> Result<(), HrError> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, jurisdiction_code from entities where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((_, jurisdiction)) = row else {
        return Err(HrError::validation("The accounting entity does not exist"));
    };
    if jurisdiction.as_deref() != Some(country) {
        return Err(HrError::validation(format!(
            "The accounting entity is registered in {}; this employer is in {country}",
            jurisdiction.unwrap_or_else(|| "null".into())
        )));
    }
    Ok(())
}

/// `createEmployer(db, input, ctx)`.
pub(crate) async fn create_employer(db: &PgPool, input: &Value, created_by: &str, keyring: &Keyring) -> Result<Value, HrError> {
    let country = str_of(input, "country").unwrap_or("NL");
    if let Some(entity) = truthy_str(input, "accountingEntityId") {
        assert_accounting_entity(db, entity, country).await?;
    }
    let currency = str_of(input, "currency").unwrap_or(if country == "NL" { "EUR" } else { "USD" }).to_uppercase();
    let id = generate_id("hrpe");
    let settings = |key: &str, wanted: &str| {
        if country == wanted { input.get(key).cloned().unwrap_or_else(|| json!({})) } else { json!({}) }
    };
    sqlx::query(
        "insert into hr_payroll_employers (id, name, legal_name, country, currency, accounting_entity_id, address,
         nl_settings, us_settings, require_separate_approver, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(str_of(input, "name").unwrap_or(""))
    .bind(str_of(input, "legalName").unwrap_or(""))
    .bind(country)
    .bind(&currency)
    .bind(str_of(input, "accountingEntityId"))
    .bind(input.get("address").cloned().unwrap_or_else(|| json!({})))
    .bind(settings("nlSettings", "NL"))
    .bind(settings("usSettings", "US"))
    .bind(input.get("requireSeparateApprover").and_then(Value::as_bool).unwrap_or(false))
    .bind(created_by)
    .execute(db)
    .await?;
    get_employer(db, &id, keyring).await
}

/// `mergeSettings(current, patch, mapKeys)`: shallow, with the map keys
/// merged one level down.
fn merge_settings(current: &Value, patch: &Value, map_keys: &[&str]) -> Value {
    let mut next: Map<String, Value> = current.as_object().cloned().unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (k, v) in patch {
            next.insert(k.clone(), v.clone());
        }
        for key in map_keys {
            if let Some(Value::Object(incoming)) = patch.get(*key) {
                let mut merged = current.get(*key).and_then(Value::as_object).cloned().unwrap_or_default();
                for (k, v) in incoming {
                    merged.insert(k.clone(), v.clone());
                }
                next.insert((*key).to_owned(), Value::Object(merged));
            }
        }
    }
    Value::Object(next)
}

/// `updateEmployer(db, id, input, keyring)`.
pub(crate) async fn update_employer(db: &PgPool, id: &str, input: &Value, keyring: &Keyring) -> Result<Value, HrError> {
    let row = require_employer_row(db, id).await?;
    let country = row["country"].as_str().unwrap_or("");
    if let Some(entity) = truthy_str(input, "accountingEntityId") {
        assert_accounting_entity(db, entity, country).await?;
    }
    let has = |k: &str| input.get(k).is_some();
    let address = has("address").then(|| {
        let mut merged = row["address"].as_object().cloned().unwrap_or_default();
        if let Some(patch) = input["address"].as_object() {
            for (k, v) in patch {
                merged.insert(k.clone(), v.clone());
            }
        }
        Value::Object(merged)
    });
    let nl = (has("nlSettings") && country == "NL").then(|| merge_settings(&row["nlSettings"], &input["nlSettings"], &["years"]));
    let us = (has("usSettings") && country == "US").then(|| merge_settings(&row["usSettings"], &input["usSettings"], &["states"]));
    sqlx::query(
        "update hr_payroll_employers set
           name = case when $2 then $3 else name end,
           legal_name = case when $4 then $5 else legal_name end,
           accounting_entity_id = case when $6 then $7 else accounting_entity_id end,
           address = coalesce($8, address),
           nl_settings = coalesce($9, nl_settings),
           us_settings = coalesce($10, us_settings),
           require_separate_approver = coalesce($11, require_separate_approver),
           is_active = coalesce($12, is_active),
           updated_at = $13::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(has("name"))
    .bind(str_of(input, "name"))
    .bind(has("legalName"))
    .bind(str_of(input, "legalName"))
    .bind(has("accountingEntityId"))
    .bind(str_of(input, "accountingEntityId"))
    .bind(address)
    .bind(nl)
    .bind(us)
    .bind(input.get("requireSeparateApprover").and_then(Value::as_bool))
    .bind(input.get("isActive").and_then(Value::as_bool))
    .bind(now())
    .execute(db)
    .await?;
    get_employer(db, id, keyring).await
}

/// `setEmployerBank(db, id, input, keyring)`: the employer and the fields
/// that changed.
pub(crate) async fn set_employer_bank(
    db: &PgPool,
    id: &str,
    input: &Value,
    keyring: &Keyring,
) -> Result<(Value, Vec<String>), HrError> {
    let row = require_employer_row(db, id).await?;
    if keyring.is_empty() {
        return Err(HrError::validation("Bank details cannot be stored: the worker has no encryption key"));
    }
    let current = read_employer_bank(&row, keyring)?.unwrap_or_else(|| json!({}));
    let mut next = current.as_object().cloned().unwrap_or_default();
    let mut changed: Vec<String> = vec![];
    let mut apply = |key: &str, value: Option<Value>| {
        let Some(value) = value else { return };
        let before = current.get(key).cloned().unwrap_or(Value::Null);
        if before != value {
            changed.push(key.to_owned());
        }
        next.insert(key.to_owned(), value);
    };
    let text_or_blank = |key: &str| match input.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if weldsuite_kit::validation::js_trim(s).is_empty() => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    };
    if let Some(iban) = text_or_blank("iban") {
        match iban {
            None => apply("iban", Some(Value::Null)),
            Some(raw) => {
                let iban = normalize_iban(&raw);
                if !is_valid_iban(&iban) {
                    return Err(HrError::validation("The IBAN is not valid"));
                }
                apply("iban", Some(json!(iban)));
            }
        }
    }
    if let Some(bic) = text_or_blank("bic") {
        match bic {
            None => apply("bic", Some(Value::Null)),
            Some(raw) => {
                let Some(bic) = normalize_bic(&raw) else {
                    return Err(HrError::validation("The BIC is not valid"));
                };
                apply("bic", Some(json!(bic)));
            }
        }
    }
    if let Some(routing) = input.get("routingNumber") {
        if let Some(r) = routing.as_str() {
            if !is_valid_routing_number(r) {
                return Err(HrError::validation("The routing number is not valid (checksum)"));
            }
        }
        apply("routingNumber", Some(routing.clone()));
    }
    for key in ["accountHolder", "accountNumber", "accountType", "nachaCompanyId", "bankName"] {
        apply(key, input.get(key).cloned());
    }
    if !changed.is_empty() {
        let sealed = encrypt_field(&super::common::js_json(&Value::Object(next)), keyring)
            .map_err(|e| HrError::internal(e.to_string()))?;
        sqlx::query("update hr_payroll_employers set bank_encrypted = $2, updated_at = $3::timestamp where id = $1")
            .bind(id)
            .bind(sealed)
            .bind(now())
            .execute(db)
            .await?;
    }
    Ok((get_employer(db, id, keyring).await?, changed))
}

async fn count(db: &PgPool, sql: &'static str, id: &str) -> Result<i64, HrError> {
    Ok(sqlx::query_scalar::<_, i64>(sql).bind(id).fetch_one(db).await?)
}

/// `deleteEmployer(db, id)`: soft, with its schedules.
pub(crate) async fn delete_employer(db: &PgPool, id: &str) -> Result<(), HrError> {
    require_employer_row(db, id).await?;
    if count(db, "select count(*) from hr_pay_runs where employer_id = $1", id).await? > 0 {
        return Err(HrError::conflict("This employer has pay runs and cannot be deleted. Deactivate it instead."));
    }
    if count(db, "select count(*) from hr_payroll_profiles where employer_id = $1 and status <> 'ended'", id).await? > 0 {
        return Err(HrError::conflict("Employees are still on this employer's payroll. Move or end them first."));
    }
    let at = now();
    sqlx::query("update hr_payroll_employers set deleted_at = $2::timestamp, updated_at = $2::timestamp, is_active = false where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    sqlx::query(
        "update hr_pay_schedules set deleted_at = $2::timestamp, updated_at = $2::timestamp, is_active = false
         where employer_id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(&at)
    .execute(db)
    .await?;
    Ok(())
}

// ── schedules ───────────────────────────────────────────────────────────────

/// `specOf(row)`.
pub(crate) fn spec_of(row: &Value) -> PayScheduleSpec {
    let rule = &row["payDateRule"];
    PayScheduleSpec {
        frequency: PayFrequency::parse(row["frequency"].as_str().unwrap_or("")).unwrap_or(PayFrequency::Monthly),
        anchor_date: row["anchorDate"].as_str().unwrap_or("").to_owned(),
        pay_date_rule: match rule["kind"].as_str() {
            Some("day_of_month") => PayDateRule::DayOfMonth { day: rule["day"].as_f64().unwrap_or(f64::NAN) },
            Some("offset_after_end") => PayDateRule::OffsetAfterEnd { days: rule["days"].as_f64().unwrap_or(f64::NAN) },
            _ => PayDateRule::LastBusinessDay,
        },
    }
}

pub(crate) fn country_of(text: &str) -> PayrollCountry {
    if text == "US" { PayrollCountry::Us } else { PayrollCountry::Nl }
}

/// `requireScheduleRow(db, id)`.
pub(crate) async fn require_schedule_row(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_pay_schedules t where t.id = $1 and t.deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Pay schedule", id))
}

fn assert_rule_allowed(country: &str, frequency: &str, rule: &Value) -> Result<(), HrError> {
    let kind = rule["kind"].as_str().unwrap_or("");
    if country == "NL" {
        if frequency != "monthly" {
            return Err(HrError::validation("Dutch payroll runs monthly in this version"));
        }
        if kind == "offset_after_end" {
            return Err(HrError::validation("Dutch payroll pays on a day of the month or on the last business day"));
        }
    }
    if kind == "last_business_day" && frequency != "monthly" && frequency != "semimonthly" {
        return Err(HrError::validation("The last business day only fits monthly and semi-monthly schedules"));
    }
    Ok(())
}

/// `createSchedule(db, input)`.
pub(crate) async fn create_schedule(db: &PgPool, input: &Value) -> Result<Value, HrError> {
    let employer = require_employer_row(db, str_of(input, "employerId").unwrap_or("")).await?;
    let anchor = str_of(input, "anchorDate").unwrap_or("");
    if !is_iso_date(anchor) {
        return Err(HrError::validation("anchorDate is not a date"));
    }
    let frequency = str_of(input, "frequency").unwrap_or("");
    assert_rule_allowed(employer["country"].as_str().unwrap_or(""), frequency, &input["payDateRule"])?;
    let id = generate_id("hrps");
    sqlx::query(
        "insert into hr_pay_schedules (id, employer_id, name, frequency, anchor_date, pay_date_rule)
         values ($1, $2, $3, $4, $5::date, $6)",
    )
    .bind(&id)
    .bind(str_of(input, "employerId"))
    .bind(weldsuite_kit::validation::js_trim(str_of(input, "name").unwrap_or("")))
    .bind(frequency)
    .bind(anchor)
    .bind(&input["payDateRule"])
    .execute(db)
    .await?;
    get_schedule(db, &id).await
}

/// `updateSchedule(db, id, input)`.
pub(crate) async fn update_schedule(db: &PgPool, id: &str, input: &Value) -> Result<Value, HrError> {
    let row = require_schedule_row(db, id).await?;
    if let Some(rule) = input.get("payDateRule") {
        let employer = require_employer_row(db, row["employerId"].as_str().unwrap_or("")).await?;
        assert_rule_allowed(employer["country"].as_str().unwrap_or(""), row["frequency"].as_str().unwrap_or(""), rule)?;
    }
    sqlx::query(
        "update hr_pay_schedules set
           name = coalesce($2, name),
           pay_date_rule = coalesce($3, pay_date_rule),
           is_active = coalesce($4, is_active),
           updated_at = $5::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(str_of(input, "name").map(|n| weldsuite_kit::validation::js_trim(n).to_owned()))
    .bind(input.get("payDateRule"))
    .bind(input.get("isActive").and_then(Value::as_bool))
    .bind(now())
    .execute(db)
    .await?;
    get_schedule(db, id).await
}

/// `deleteSchedule(db, id)`.
pub(crate) async fn delete_schedule(db: &PgPool, id: &str) -> Result<(), HrError> {
    require_schedule_row(db, id).await?;
    if count(db, "select count(*) from hr_pay_runs where pay_schedule_id = $1", id).await? > 0 {
        return Err(HrError::conflict("This schedule has pay runs and cannot be deleted. Deactivate it instead."));
    }
    if count(db, "select count(*) from hr_payroll_profiles where pay_schedule_id = $1 and status <> 'ended'", id).await? > 0 {
        return Err(HrError::conflict("Employees are still on this schedule. Move them first."));
    }
    sqlx::query(
        "update hr_pay_schedules set deleted_at = $2::timestamp, updated_at = $2::timestamp, is_active = false where id = $1",
    )
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `lastCompletedPeriods(db, scheduleIds)`.
pub(crate) async fn last_completed_periods(db: &PgPool, schedule_ids: &[String]) -> Result<HashMap<String, (String, String)>, HrError> {
    let mut out = HashMap::new();
    if schedule_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(Option<String>, String, String)> = sqlx::query_as(
        "select pay_schedule_id, period_start::text, period_end::text from hr_pay_runs
         where pay_schedule_id = any($1) and kind = 'regular' and status in ('approved', 'paid')
         order by period_start desc",
    )
    .bind(schedule_ids)
    .fetch_all(db)
    .await?;
    for (schedule, start, end) in rows {
        if let Some(schedule) = schedule {
            out.entry(schedule).or_insert((start, end));
        }
    }
    Ok(out)
}

/// `nextPeriodOf(schedule, country, last)`, `None` when the schedule can't
/// produce one.
pub(crate) fn next_period_of(schedule: &Value, country: &str, last: Option<&(String, String)>) -> Option<Value> {
    let period = next_period_to_run(&spec_of(schedule), country_of(country), last.map(|(s, e)| (s.as_str(), e.as_str()))).ok()?;
    Some(weldsuite_payroll_domain::js::to_value(&period))
}

/// `toScheduleDtos(db, rows)`.
pub(crate) async fn to_schedule_dtos(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, HrError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let employer_ids: Vec<String> = rows.iter().filter_map(|r| r["employerId"].as_str().map(str::to_owned)).collect();
    let countries: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("select id, country from hr_payroll_employers where id = any($1)")
            .bind(&employer_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let ids: Vec<String> = rows.iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let counts: HashMap<String, i64> = sqlx::query_as::<_, (Option<String>, i64)>(
        "select pay_schedule_id, count(*) from hr_payroll_profiles
         where pay_schedule_id = any($1) and status = 'active' group by pay_schedule_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    .into_iter()
    .filter_map(|(id, n)| id.map(|id| (id, n)))
    .collect();
    let last = last_completed_periods(db, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row["id"].as_str().unwrap_or("").to_owned();
            let country = countries.get(row["employerId"].as_str().unwrap_or("")).map_or("NL", String::as_str);
            json!({
                "id": row["id"],
                "employerId": row["employerId"],
                "name": row["name"],
                "frequency": row["frequency"],
                "anchorDate": row["anchorDate"],
                "payDateRule": row["payDateRule"],
                "isActive": row["isActive"],
                "employeeCount": counts.get(&id).copied().unwrap_or(0),
                "nextPeriod": next_period_of(&row, country, last.get(&id)),
                "createdAt": row["createdAt"],
                "updatedAt": row["updatedAt"],
            })
        })
        .collect())
}

/// `listSchedules(db, filters)`, by name.
pub(crate) async fn list_schedules(db: &PgPool, employer_id: Option<&str>) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_pay_schedules t
         where t.deleted_at is null and ($1::text is null or t.employer_id = $1) order by t.name",
    )
    .bind(employer_id.filter(|e| !e.is_empty()))
    .fetch_all(db)
    .await?;
    to_schedule_dtos(db, rows.into_iter().map(js_row).collect()).await
}

/// `getSchedule(db, id)`.
pub(crate) async fn get_schedule(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = require_schedule_row(db, id).await?;
    Ok(to_schedule_dtos(db, vec![row]).await?.remove(0))
}
