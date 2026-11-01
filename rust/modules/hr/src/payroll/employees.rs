//! Employees on payroll: profiles, compensation, recurring components, tax
//! elections and payment details (`services/weldhr/payroll/employees.ts`).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, decrypt_field, js_row};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::components::{ComponentEntry, ParamType, component_def};
use weldsuite_payroll_domain::us::states::state_module;

use super::common::{
    age_on_date, decimal2, decimal4, employee_issue, is_iso_date, is_valid_iban, is_valid_routing_number, js_json,
    mask_account_number, mask_iban, mask_national_id, normalize_bic, normalize_bsn, normalize_iban, normalize_ssn, ranges_overlap,
    sort_issues, truthy_str,
};
use super::employers::{employer_issues, read_employer_bank, work_states_of};
use super::schema::{has, str_of};
use crate::employees::{display_name_of, encrypt_sensitive, require_employee};
use crate::{HrError, add_days, assert_date_order, locale_compare, now, today_iso};

/// What a payslip needs to know about one employee
/// (`EmployeePayrollData`). Rows are Drizzle-shaped JSON.
#[derive(Debug, Clone)]
pub(crate) struct EmployeePayrollData {
    pub(crate) employee: Value,
    pub(crate) profile: Option<Value>,
    pub(crate) employer: Option<Value>,
    pub(crate) sensitive: Value,
    pub(crate) compensations: Vec<Value>,
    pub(crate) components: Vec<Value>,
    pub(crate) elections: Vec<Value>,
}

/// `decryptSensitive(row, keyring)`.
pub(crate) fn decrypt_sensitive(row: &Value, keyring: &Keyring) -> Result<Value, HrError> {
    let Some(sealed) = truthy_str(row, "sensitiveEncrypted") else {
        return Ok(json!({}));
    };
    let plaintext = decrypt_field(sealed, keyring).map_err(|e| HrError::internal(e.to_string()))?;
    serde_json::from_str(&plaintext).map_err(|e| HrError::internal(e.to_string()))
}

pub(crate) const BANK_FIELDS: [&str; 6] =
    ["bankAccountHolder", "bankIban", "bankBic", "bankRoutingNumber", "bankAccountNumber", "bankAccountType"];
const IDENTITY_FIELDS: [&str; 5] = ["nationalId", "dateOfBirth", "idDocumentType", "idDocumentNumber", "idDocumentExpiresOn"];

/// `bankOf(sensitive)`: the set bank fields, `None` when there are none.
pub(crate) fn bank_of(sensitive: &Value) -> Option<Value> {
    let mut bank = Map::new();
    for key in BANK_FIELDS {
        match sensitive.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(v) => {
                bank.insert(key.to_owned(), v.clone());
            }
        }
    }
    (!bank.is_empty()).then_some(Value::Object(bank))
}

/// `sameBank(a, b)`.
pub(crate) fn same_bank(a: Option<&Value>, b: Option<&Value>) -> bool {
    let norm = |bank: Option<&Value>| -> Vec<Value> {
        BANK_FIELDS.iter().map(|k| bank.and_then(|b| b.get(*k)).cloned().unwrap_or(Value::Null)).collect()
    };
    norm(a) == norm(b)
}

/// The rows of the payroll tables for `ids`, Drizzle-shaped, with numeric
/// columns as the text Drizzle reads.
async fn rows(db: &PgPool, sql: &'static str, ids: &[String]) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(ids).fetch_all(db).await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `loadEmployeePayrollData(db, employeeIds, keyring)`, in the order the
/// employees come from the database.
pub(crate) async fn load_employee_payroll_data(
    db: &PgPool,
    employee_ids: &[String],
    keyring: &Keyring,
) -> Result<Vec<EmployeePayrollData>, HrError> {
    if employee_ids.is_empty() {
        return Ok(vec![]);
    }
    let employees = rows(db, "select to_jsonb(t) from hr_employees t where t.id = any($1) and t.deleted_at is null", employee_ids).await?;
    let profiles = rows(db, "select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = any($1)", employee_ids).await?;
    let compensations = rows(
        db,
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_compensations t
         where t.employee_id = any($1) order by t.effective_from desc",
        employee_ids,
    )
    .await?;
    let components = rows(
        db,
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_pay_components t
         where t.employee_id = any($1) and t.deleted_at is null order by t.effective_from asc",
        employee_ids,
    )
    .await?;
    let elections = rows(
        db,
        "select to_jsonb(t) from hr_tax_elections t where t.employee_id = any($1)
         order by t.effective_from desc, t.created_at desc",
        employee_ids,
    )
    .await?;
    let employer_ids: Vec<String> = profiles.iter().filter_map(|p| p["employerId"].as_str().map(str::to_owned)).collect();
    let employers = if employer_ids.is_empty() {
        vec![]
    } else {
        rows(db, "select to_jsonb(t) from hr_payroll_employers t where t.id = any($1)", &employer_ids).await?
    };
    let mut out = vec![];
    for employee in employees {
        let id = employee["id"].as_str().unwrap_or("").to_owned();
        let profile = profiles.iter().find(|p| p["employeeId"] == id.as_str()).cloned();
        let employer = profile
            .as_ref()
            .and_then(|p| employers.iter().find(|e| e["id"] == p["employerId"]).cloned());
        let sensitive = if profile.is_some() { decrypt_sensitive(&employee, keyring)? } else { json!({}) };
        let of = |list: &[Value]| list.iter().filter(|r| r["employeeId"] == id.as_str()).cloned().collect::<Vec<_>>();
        out.push(EmployeePayrollData {
            compensations: of(&compensations),
            components: of(&components),
            elections: of(&elections),
            employee,
            profile,
            employer,
            sensitive,
        });
    }
    Ok(out)
}

/// `loadOneEmployeePayrollData(db, employeeId, keyring)`.
pub(crate) async fn load_one(db: &PgPool, employee_id: &str, keyring: &Keyring) -> Result<EmployeePayrollData, HrError> {
    let mut data = load_employee_payroll_data(db, &[employee_id.to_owned()], keyring)
        .await?
        .pop()
        .ok_or_else(|| HrError::not_found("Employee", employee_id))?;
    if data.profile.is_none() {
        data.sensitive = decrypt_sensitive(&data.employee, keyring)?;
    }
    Ok(data)
}

fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

/// `compensationOn(rows, date)`.
pub(crate) fn compensation_on<'a>(rows: &'a [Value], date: &str) -> Option<&'a Value> {
    let mut sorted: Vec<&Value> = rows.iter().collect();
    sorted.sort_by(|a, b| s(b, "effectiveFrom").cmp(s(a, "effectiveFrom")));
    sorted.into_iter().find(|row| {
        s(row, "effectiveFrom") <= date && row["effectiveTo"].as_str().is_none_or(|to| to >= date)
    })
}

/// `componentsOverlapping(rows, start, end)`.
pub(crate) fn components_overlapping(rows: &[Value], start: &str, end: &str) -> Vec<Value> {
    rows.iter()
        .filter(|row| ranges_overlap(s(row, "effectiveFrom"), row["effectiveTo"].as_str(), start, Some(end)))
        .cloned()
        .collect()
}

/// `electionsInForce(rows, date)`: the newest election per kind and state.
pub(crate) fn elections_in_force(rows: &[Value], date: &str) -> Vec<Value> {
    let mut best: Vec<(String, Value)> = vec![];
    for row in rows {
        if s(row, "effectiveFrom") > date {
            continue;
        }
        let key = format!("{}|{}", s(row, "kind"), row["state"].as_str().unwrap_or(""));
        match best.iter_mut().find(|(k, _)| *k == key) {
            None => best.push((key, row.clone())),
            Some((_, current)) => {
                let newer = s(row, "effectiveFrom") > s(current, "effectiveFrom")
                    || (s(row, "effectiveFrom") == s(current, "effectiveFrom") && s(row, "createdAt") > s(current, "createdAt"));
                if newer {
                    *current = row.clone();
                }
            }
        }
    }
    best.into_iter().map(|(_, v)| v).collect()
}

/// `electionOf(rows, date, kind, state)`.
pub(crate) fn election_of(rows: &[Value], date: &str, kind: &str, state: Option<&str>) -> Option<Value> {
    let wanted = state.filter(|s| !s.is_empty()).map(str::to_uppercase);
    elections_in_force(rows, date).into_iter().find(|r| {
        r["kind"] == kind && r["state"].as_str().filter(|s| !s.is_empty()).map(str::to_uppercase) == wanted
    })
}

/// `stateCertificateRequired(state)`.
pub(crate) fn state_certificate_required(state: Option<&str>) -> bool {
    state_module(state).is_some_and(|m| m.certificate.is_some())
}

/// `readinessIssues(data, opts)`.
pub(crate) fn readiness_issues(data: &EmployeePayrollData, on_date: &str, list: bool, employer_issues: &[Value]) -> Vec<Value> {
    let (Some(profile), Some(employer)) = (&data.profile, &data.employer) else {
        return vec![];
    };
    if profile["status"] == "ended" {
        return vec![];
    }
    let id = s(&data.employee, "id");
    let sensitive = &data.sensitive;
    let mut issues = vec![];
    let mut add = |severity: &str, code: &str, params: Option<Value>| issues.push(employee_issue(severity, code, id, params));
    if compensation_on(&data.compensations, on_date).is_none() {
        add("error", "missing_compensation", None);
    }
    if truthy_str(sensitive, "nationalId").is_none() {
        add("error", "missing_tax_id", None);
    }
    if employer["country"] == "NL" {
        if truthy_str(sensitive, "dateOfBirth").is_none() {
            add("error", "missing_date_of_birth", None);
        }
        if truthy_str(sensitive, "bankIban").is_none() {
            add("error", "missing_bank_account", None);
        }
        if list && truthy_str(sensitive, "nationalId").is_some() && truthy_str(sensitive, "idVerifiedAt").is_none() {
            add("warning", "anonymous_rate", Some(json!({ "reason": "id_not_verified" })));
        }
        if election_of(&data.elections, on_date, "nl_loonheffingskorting", None).is_none() {
            add("warning", "missing_tax_election", Some(json!({ "kind": "nl_loonheffingskorting" })));
        }
    } else {
        if truthy_str(sensitive, "bankRoutingNumber").is_none() || truthy_str(sensitive, "bankAccountNumber").is_none() {
            add("error", "missing_bank_account", None);
        }
        let work_state = truthy_str(&profile["us"], "workState");
        if work_state.is_none() {
            add("error", "missing_work_state", None);
        }
        if list && election_of(&data.elections, on_date, "us_w4", None).is_none() {
            add("warning", "missing_tax_election", Some(json!({ "kind": "us_w4" })));
        }
        if let Some(state) = work_state {
            if state_certificate_required(Some(state))
                && election_of(&data.elections, on_date, "us_state_certificate", Some(state)).is_none()
            {
                add("warning", "missing_tax_election", Some(json!({ "kind": "us_state_certificate", "state": state })));
            }
        }
    }
    if list {
        if let Some(blocking) = employer_issues.iter().find(|i| i["severity"] == "error") {
            add("error", "employer_incomplete", blocking.get("params").cloned());
        }
    }
    sort_issues(issues)
}

/// `toProfileDto(row)`.
pub(crate) fn to_profile_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "employeeId": row["employeeId"], "employerId": row["employerId"], "payScheduleId": row["payScheduleId"],
        "status": row["status"], "startDate": row["startDate"], "endDate": row["endDate"], "nl": row["nl"], "us": row["us"],
        "createdAt": row["createdAt"], "updatedAt": row["updatedAt"],
    })
}

/// `toCompensationDto(row)`.
pub(crate) fn to_compensation_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "employeeId": row["employeeId"], "effectiveFrom": row["effectiveFrom"], "effectiveTo": row["effectiveTo"],
        "payType": row["payType"], "amount": row["amount"], "period": row["period"], "currency": row["currency"],
        "hoursPerWeek": row["hoursPerWeek"], "reason": row["reason"], "createdBy": row["createdBy"], "createdAt": row["createdAt"],
    })
}

/// `toComponentDto(row)`.
pub(crate) fn to_component_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "employeeId": row["employeeId"], "code": row["code"], "label": row["label"], "amount": row["amount"],
        "params": row["params"], "effectiveFrom": row["effectiveFrom"], "effectiveTo": row["effectiveTo"],
        "createdAt": row["createdAt"], "updatedAt": row["updatedAt"],
    })
}

/// `toElectionDto(row)`.
pub(crate) fn to_election_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "employeeId": row["employeeId"], "kind": row["kind"],
        "state": row["state"].as_str().filter(|s| !s.is_empty()).map(str::to_uppercase),
        "effectiveFrom": row["effectiveFrom"], "data": row["data"], "signedBy": row["signedBy"],
        "signatureName": row["signatureName"], "signedAt": row["signedAt"], "source": row["source"], "createdAt": row["createdAt"],
    })
}

fn field_or_null(s: &Value, key: &str) -> Value {
    s.get(key).cloned().unwrap_or(Value::Null)
}

/// `maskPaymentDetails(sensitive)`.
pub(crate) fn mask_payment_details(s: &Value) -> Value {
    json!({
        "hasNationalId": truthy_str(s, "nationalId").is_some(),
        "nationalIdMasked": mask_national_id(s.get("nationalId").and_then(Value::as_str)),
        "dateOfBirth": field_or_null(s, "dateOfBirth"),
        "bankAccountHolder": field_or_null(s, "bankAccountHolder"),
        "bankIbanMasked": mask_iban(s.get("bankIban").and_then(Value::as_str)),
        "bankBic": field_or_null(s, "bankBic"),
        "bankRoutingNumber": field_or_null(s, "bankRoutingNumber"),
        "bankAccountNumberMasked": mask_account_number(s.get("bankAccountNumber").and_then(Value::as_str)),
        "bankAccountType": field_or_null(s, "bankAccountType"),
        "homeAddress": field_or_null(s, "homeAddress"),
        "idDocumentType": field_or_null(s, "idDocumentType"),
        "idDocumentExpiresOn": field_or_null(s, "idDocumentExpiresOn"),
        "idVerifiedAt": field_or_null(s, "idVerifiedAt"),
    })
}

/// `employerIssueMap(db, employers, keyring, today)`.
async fn employer_issue_map(db: &PgPool, employers: &[Value], keyring: &Keyring, today: &str) -> Result<HashMap<String, Vec<Value>>, HrError> {
    let mut out = HashMap::new();
    if employers.is_empty() {
        return Ok(out);
    }
    let ids: Vec<String> = employers.iter().filter_map(|e| e["id"].as_str().map(str::to_owned)).collect();
    let profiles = rows(
        db,
        "select to_jsonb(t) from hr_payroll_profiles t where t.employer_id = any($1) and t.status = 'active'",
        &ids,
    )
    .await?;
    for employer in employers {
        let bank = read_employer_bank(employer, keyring)?;
        let mine: Vec<Value> = profiles.iter().filter(|p| p["employerId"] == employer["id"]).cloned().collect();
        let issues = employer_issues(employer, bank.as_ref(), &work_states_of(&mine), super::common::year_of_date(today));
        out.insert(s(employer, "id").to_owned(), issues);
    }
    Ok(out)
}

/// `listPayrollEmployees(db, filters, keyring, today)`, by name.
pub(crate) async fn list_payroll_employees(
    db: &PgPool,
    employer_id: Option<&str>,
    on_payroll: Option<bool>,
    keyring: &Keyring,
    today: &str,
) -> Result<Vec<Value>, HrError> {
    let mut ids: Vec<String> = sqlx::query_scalar(
        "select id from hr_employees where deleted_at is null and status <> 'terminated'",
    )
    .fetch_all(db)
    .await?;
    let still_paid: Vec<String> = sqlx::query_scalar(
        "select e.id from hr_employees e join hr_payroll_profiles p on p.employee_id = e.id
         where e.deleted_at is null and e.status = 'terminated' and p.status <> 'ended'",
    )
    .fetch_all(db)
    .await?;
    for id in still_paid {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let data = load_employee_payroll_data(db, &ids, keyring).await?;
    let mut employers: Vec<Value> = vec![];
    for d in &data {
        if let Some(e) = &d.employer {
            match employers.iter_mut().find(|x| x["id"] == e["id"]) {
                Some(slot) => *slot = e.clone(),
                None => employers.push(e.clone()),
            }
        }
    }
    let employer_issues_by_id = employer_issue_map(db, &employers, keyring, today).await?;
    let schedule_ids: Vec<String> =
        data.iter().filter_map(|d| d.profile.as_ref().and_then(|p| truthy_str(p, "payScheduleId")).map(str::to_owned)).collect();
    let schedule_names: HashMap<String, String> = if schedule_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>("select id, name from hr_pay_schedules where id = any($1)")
            .bind(&schedule_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect()
    };
    let mut items: Vec<(String, Value)> = vec![];
    for d in &data {
        let on = d.profile.as_ref().is_some_and(|p| p["status"] != "ended");
        if on_payroll == Some(true) && !on {
            continue;
        }
        if on_payroll == Some(false) && on {
            continue;
        }
        if let Some(employer_id) = employer_id.filter(|e| !e.is_empty()) {
            if d.profile.as_ref().map(|p| s(p, "employerId")) != Some(employer_id) {
                continue;
            }
        }
        let start = d.profile.as_ref().and_then(|p| truthy_str(p, "startDate"));
        let ref_date = match start {
            Some(start) if start > today => start.to_owned(),
            _ => today.to_owned(),
        };
        let comp = compensation_on(&d.compensations, &ref_date).or_else(|| compensation_on(&d.compensations, today));
        let empty = vec![];
        let employer_issues =
            d.employer.as_ref().and_then(|e| employer_issues_by_id.get(s(e, "id"))).unwrap_or(&empty);
        let name = display_name_of(&d.employee);
        let schedule = d.profile.as_ref().and_then(|p| truthy_str(p, "payScheduleId"));
        items.push((
            name.clone(),
            json!({
                "employeeId": d.employee["id"],
                "displayName": name,
                "jobTitle": d.employee["jobTitle"],
                "avatarUrl": d.employee["avatarUrl"],
                "employeeStatus": d.employee["status"],
                "profile": d.profile.as_ref().map(|p| json!({ "employerId": p["employerId"], "payScheduleId": p["payScheduleId"], "status": p["status"] })),
                "employerName": d.employer.as_ref().map(|e| e["name"].clone()),
                "payScheduleName": schedule.and_then(|id| schedule_names.get(id)).cloned(),
                "country": d.employer.as_ref().map(|e| e["country"].clone()),
                "currentCompensation": comp.map(to_compensation_dto),
                "issues": readiness_issues(d, &ref_date, true, employer_issues),
            }),
        ));
    }
    items.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(items.into_iter().map(|(_, v)| v).collect())
}

/// `getPayrollEmployee(db, employeeId, keyring, today)`.
pub(crate) async fn get_payroll_employee(db: &PgPool, employee_id: &str, keyring: &Keyring, today: &str) -> Result<Value, HrError> {
    let d = load_one(db, employee_id, keyring).await?;
    let employer_issues = match &d.employer {
        Some(e) => employer_issue_map(db, &[e.clone()], keyring, today).await?.remove(s(e, "id")).unwrap_or_default(),
        None => vec![],
    };
    let e = &d.employee;
    Ok(json!({
        "employee": {
            "id": e["id"], "displayName": display_name_of(e), "email": e["email"], "status": e["status"],
            "startDate": e["startDate"], "endDate": e["endDate"], "weeklyHours": e["weeklyHours"],
        },
        "profile": d.profile.as_ref().map(to_profile_dto),
        "employer": d.employer.as_ref().map(|r| json!({ "id": r["id"], "name": r["name"], "country": r["country"], "currency": r["currency"] })),
        "compensations": d.compensations.iter().map(to_compensation_dto).collect::<Vec<_>>(),
        "components": d.components.iter().map(to_component_dto).collect::<Vec<_>>(),
        "currentElections": elections_in_force(&d.elections, today).iter().map(to_election_dto).collect::<Vec<_>>(),
        "paymentDetails": mask_payment_details(&d.sensitive),
        "issues": readiness_issues(&d, today, true, &employer_issues),
    }))
}

async fn profiles_of_employer(db: &PgPool, employer_id: &str) -> Result<Vec<(String, Value)>, HrError> {
    Ok(sqlx::query_as::<_, (String, Value)>("select employee_id, nl from hr_payroll_profiles where employer_id = $1")
        .bind(employer_id)
        .fetch_all(db)
        .await?)
}

/// `nextIncomeRelationshipNumber(db, employerId, exceptEmployeeId)`.
async fn next_income_relationship_number(db: &PgPool, employer_id: &str, except: &str) -> Result<f64, HrError> {
    let mut max: f64 = 0.0;
    for (employee, nl) in profiles_of_employer(db, employer_id).await? {
        if employee == except {
            continue;
        }
        let a = nl["incomeRelationshipNumber"].as_f64().unwrap_or(0.0);
        let b = nl["transitionIncomeRelationshipNumber"].as_f64().unwrap_or(0.0);
        max = max.max(a).max(b);
    }
    Ok(max + 1.0)
}

/// `transitionIncomeRelationshipNumber(db, employeeId)`.
pub(crate) async fn transition_income_relationship_number(db: &PgPool, employee_id: &str) -> Result<Option<f64>, HrError> {
    let profile: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = $1 limit 1")
            .bind(employee_id)
            .fetch_optional(db)
            .await?;
    let Some(profile) = profile.map(js_row) else {
        return Ok(None);
    };
    if let Some(n) = profile["nl"]["transitionIncomeRelationshipNumber"].as_f64().filter(|n| *n != 0.0) {
        return Ok(Some(n));
    }
    let next = next_income_relationship_number(db, s(&profile, "employerId"), employee_id).await?;
    let number = next.max(profile["nl"]["incomeRelationshipNumber"].as_f64().unwrap_or(0.0) + 1.0);
    let mut nl = profile["nl"].as_object().cloned().unwrap_or_default();
    nl.insert("transitionIncomeRelationshipNumber".into(), weldsuite_core_domain::js::number_value(number));
    sqlx::query("update hr_payroll_profiles set nl = $2, updated_at = $3::timestamp where id = $1")
        .bind(s(&profile, "id"))
        .bind(Value::Object(nl))
        .bind(now())
        .execute(db)
        .await?;
    Ok(Some(number))
}

/// `upsertProfile(db, employeeId, input)`.
pub(crate) async fn upsert_profile(db: &PgPool, employee_id: &str, input: &Value) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let employer_id = str_of(input, "employerId").unwrap_or("");
    let employer: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_payroll_employers t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(employer_id)
    .fetch_optional(db)
    .await?;
    let Some(employer) = employer.map(js_row) else {
        return Err(HrError::not_found("Payroll employer", employer_id));
    };
    if employer["isActive"] != true {
        return Err(HrError::validation("This employer is not active"));
    }
    if let Some(schedule_id) = truthy_str(input, "payScheduleId") {
        let schedule: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from hr_pay_schedules t where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(schedule_id)
        .fetch_optional(db)
        .await?;
        match schedule.map(js_row) {
            Some(schedule) if schedule["employerId"] == employer["id"] => {
                if schedule["isActive"] != true {
                    return Err(HrError::validation("This pay schedule is not active"));
                }
            }
            _ => return Err(HrError::validation("The pay schedule does not belong to this employer")),
        }
    }
    assert_date_order(str_of(input, "startDate"), str_of(input, "endDate"), "Payroll")?;
    let existing: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = $1 limit 1")
            .bind(employee_id)
            .fetch_optional(db)
            .await?;
    let existing = existing.map(js_row);
    if let Some(existing) = &existing {
        if existing["employerId"] != employer["id"] {
            let finals: i64 = sqlx::query_scalar(
                "select count(*) from hr_payslips where employee_id = $1 and status = 'final'",
            )
            .bind(employee_id)
            .fetch_one(db)
            .await?;
            if finals > 0 {
                return Err(HrError::conflict(
                    "This employee has payslips under another employer. End that payroll and start a new one.",
                ));
            }
        }
    }
    let merge = |key: &str| -> Map<String, Value> {
        let mut out = existing.as_ref().and_then(|e| e[key].as_object().cloned()).unwrap_or_default();
        if let Some(patch) = input.get(key).and_then(Value::as_object) {
            for (k, v) in patch {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    };
    let mut nl = merge("nl");
    let us = merge("us");
    if employer["country"] == "NL" {
        let wanted = nl.get("incomeRelationshipNumber").and_then(Value::as_f64).filter(|n| *n != 0.0);
        if let Some(number) = wanted {
            let clash = profiles_of_employer(db, s(&employer, "id")).await?.into_iter().any(|(emp, other)| {
                emp != employee_id && other["incomeRelationshipNumber"].as_f64() == Some(number)
            });
            if clash {
                return Err(HrError::conflict(format!(
                    "Income relationship number {} is already used at this employer",
                    weldsuite_core_domain::js::number_text(number)
                )));
            }
        } else if existing.as_ref().is_none_or(|e| {
            e["employerId"] != employer["id"] || e["nl"]["incomeRelationshipNumber"].as_f64().is_none_or(|n| n == 0.0)
        }) {
            let next = next_income_relationship_number(db, s(&employer, "id"), employee_id).await?;
            nl.insert("incomeRelationshipNumber".into(), weldsuite_core_domain::js::number_value(next));
        }
        if nl.get("contractHoursPerWeek").is_none_or(Value::is_null) {
            nl.insert("contractHoursPerWeek".into(), employee["weeklyHours"].clone());
        }
    }
    let pick = |key: &str, fallback: Value| if has(input, key) { input[key].clone() } else { fallback };
    let previous = |key: &str| existing.as_ref().map_or(Value::Null, |e| e[key].clone());
    let schedule = pick("payScheduleId", previous("payScheduleId"));
    let status = input.get("status").cloned().or_else(|| existing.as_ref().map(|e| e["status"].clone())).unwrap_or(json!("active"));
    let start = pick("startDate", previous("startDate"));
    let end = pick("endDate", previous("endDate"));
    let at = now();
    let id = match &existing {
        Some(existing) => {
            sqlx::query(
                "update hr_payroll_profiles set employer_id = $2, pay_schedule_id = $3, status = $4, start_date = $5::date,
                 end_date = $6::date, nl = $7, us = $8, updated_at = $9::timestamp where id = $1",
            )
            .bind(s(existing, "id"))
            .bind(s(&employer, "id"))
            .bind(schedule.as_str())
            .bind(status.as_str())
            .bind(start.as_str())
            .bind(end.as_str())
            .bind(Value::Object(nl))
            .bind(Value::Object(us))
            .bind(&at)
            .execute(db)
            .await?;
            s(existing, "id").to_owned()
        }
        None => {
            let id = generate_id("hrpp");
            sqlx::query(
                "insert into hr_payroll_profiles (id, employee_id, employer_id, pay_schedule_id, status, start_date, end_date,
                 nl, us, updated_at) values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::timestamp)",
            )
            .bind(&id)
            .bind(employee_id)
            .bind(s(&employer, "id"))
            .bind(schedule.as_str())
            .bind(status.as_str())
            .bind(start.as_str())
            .bind(end.as_str())
            .bind(Value::Object(nl))
            .bind(Value::Object(us))
            .bind(&at)
            .execute(db)
            .await?;
            id
        }
    };
    let row: Value = sqlx::query_scalar("select to_jsonb(t) from hr_payroll_profiles t where t.id = $1")
        .bind(&id)
        .fetch_one(db)
        .await?;
    Ok(to_profile_dto(&js_row(row)))
}

/// `lastApprovedPeriodEnd(db, employeeId)`.
pub(crate) async fn last_approved_period_end(db: &PgPool, employee_id: &str) -> Result<Option<String>, HrError> {
    Ok(sqlx::query_scalar::<_, Option<String>>(
        "select max(period_end)::text from hr_payslips where employee_id = $1 and status = 'final'",
    )
    .bind(employee_id)
    .fetch_one(db)
    .await?)
}

async fn compensation_row(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_compensations t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn compensations_of(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_compensations t
         where t.employee_id = $1 order by t.effective_from desc",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `createCompensation(db, employeeId, input, ctx)`.
pub(crate) async fn create_compensation(db: &PgPool, employee_id: &str, input: &Value, created_by: &str) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let currency_of_employer: Option<String> = sqlx::query_scalar(
        "select e.currency from hr_payroll_profiles p join hr_payroll_employers e on e.id = p.employer_id
         where p.employee_id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let pay_type = str_of(input, "payType").unwrap_or("");
    let period = str_of(input, "period").unwrap_or("");
    if pay_type == "hourly" && period != "hour" {
        return Err(HrError::validation("Hourly pay is an amount per hour"));
    }
    if pay_type == "salary" && period == "hour" {
        return Err(HrError::validation("A salary is an amount per week, month or year"));
    }
    let existing = compensations_of(db, employee_id).await?;
    let from = str_of(input, "effectiveFrom").unwrap_or("");
    if let Some(latest) = existing.first() {
        if from <= s(latest, "effectiveFrom") {
            return Err(HrError::validation(format!(
                "A compensation effective from {} already exists; the new one must start after it",
                s(latest, "effectiveFrom")
            )));
        }
    }
    let allow_retroactive = input.get("allowRetroactive").and_then(Value::as_bool).unwrap_or(false);
    if let Some(last_end) = last_approved_period_end(db, employee_id).await? {
        if from <= last_end.as_str() && !allow_retroactive {
            return Err(HrError::payroll(
                "RETROACTIVE_COMPENSATION",
                format!(
                    "Pay was already approved up to {last_end}. Start the new compensation after that date, or confirm it is retroactive and correct the affected pay runs."
                ),
                409,
            ));
        }
    }
    let at = now();
    let id = generate_id("hrcmp");
    let currency = str_of(input, "currency").map(str::to_owned).or(currency_of_employer).unwrap_or_else(|| "EUR".into()).to_uppercase();
    let hours = match input.get("hoursPerWeek") {
        Some(Value::Number(n)) => n.as_f64(),
        _ => employee["weeklyHours"].as_f64(),
    };
    let mut tx = db.begin().await?;
    if let Some(latest) = existing.first().filter(|l| l["effectiveTo"].is_null()) {
        sqlx::query("update hr_compensations set effective_to = $2::date, updated_at = $3::timestamp where id = $1")
            .bind(s(latest, "id"))
            .bind(add_days(from, -1))
            .bind(&at)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "insert into hr_compensations (id, employee_id, effective_from, effective_to, pay_type, amount, period, currency,
         hours_per_week, reason, created_by) values ($1, $2, $3::date, null, $4, $5::numeric, $6, $7, $8, $9, $10)",
    )
    .bind(&id)
    .bind(employee_id)
    .bind(from)
    .bind(pay_type)
    .bind(decimal4(input["amount"].as_f64().unwrap_or(0.0)))
    .bind(period)
    .bind(&currency)
    .bind(hours)
    .bind(str_of(input, "reason"))
    .bind(created_by)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let row = compensation_row(db, &id).await?.ok_or_else(|| HrError::internal("compensation vanished"))?;
    Ok(to_compensation_dto(&row))
}

/// `deleteCompensation(db, id)`: the employee it belonged to.
pub(crate) async fn delete_compensation(db: &PgPool, id: &str) -> Result<String, HrError> {
    let Some(row) = compensation_row(db, id).await? else {
        return Err(HrError::not_found("Compensation", id));
    };
    if !row["effectiveTo"].is_null() {
        return Err(HrError::conflict("Only the newest compensation can be removed"));
    }
    let employee_id = s(&row, "employeeId").to_owned();
    if let Some(last_end) = last_approved_period_end(db, &employee_id).await? {
        if s(&row, "effectiveFrom") <= last_end.as_str() {
            return Err(HrError::conflict("Pay approved under this compensation depends on it, so it cannot be removed"));
        }
    }
    let day_before = add_days(s(&row, "effectiveFrom"), -1);
    let previous = compensations_of(db, &employee_id)
        .await?
        .into_iter()
        .find(|r| r["id"] != id && r["effectiveTo"].as_str() == Some(day_before.as_str()));
    let mut tx = db.begin().await?;
    sqlx::query("delete from hr_compensations where id = $1").bind(id).execute(&mut *tx).await?;
    if let Some(previous) = previous {
        sqlx::query("update hr_compensations set effective_to = null, updated_at = $2::timestamp where id = $1")
            .bind(s(&previous, "id"))
            .bind(now())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(employee_id)
}

/// `employerCountryOf(db, employeeId)`.
async fn employer_country_of(db: &PgPool, employee_id: &str) -> Result<String, HrError> {
    let profile: Option<String> =
        sqlx::query_scalar("select employer_id from hr_payroll_profiles where employee_id = $1 limit 1")
            .bind(employee_id)
            .fetch_optional(db)
            .await?;
    let Some(employer_id) = profile else {
        return Err(HrError::validation("Put the employee on payroll first"));
    };
    let country: Option<String> = sqlx::query_scalar("select country from hr_payroll_employers where id = $1 limit 1")
        .bind(employer_id)
        .fetch_optional(db)
        .await?;
    country.ok_or_else(|| HrError::validation("The employee's employer no longer exists"))
}

fn validate_component(country: &str, code: &str, amount: Option<f64>, params: &Value) -> Result<(), HrError> {
    let Some(def) = component_def(code) else {
        return Err(HrError::validation(format!("Unknown pay component '{code}'")));
    };
    let wanted = super::employers::country_of(country);
    if !def.countries.contains(&wanted) {
        return Err(HrError::validation(format!("'{code}' is not available for {country} payroll")));
    }
    if !def.recurring {
        return Err(HrError::validation(format!("'{code}' is entered on a pay run, not as a recurring component")));
    }
    let empty = Map::new();
    let params = params.as_object().unwrap_or(&empty);
    for (key, value) in params {
        let Some(spec) = def.params.iter().find(|p| p.key == key) else {
            return Err(HrError::validation(format!("'{code}' has no parameter '{key}'")));
        };
        if value.is_null() {
            continue;
        }
        let wrong = match spec.kind {
            ParamType::Boolean => !value.is_boolean(),
            ParamType::Date => !value.as_str().is_some_and(is_iso_date),
            _ => !value.is_number(),
        };
        if wrong {
            return Err(HrError::validation(format!("Parameter '{key}' of '{code}' has the wrong type")));
        }
    }
    for spec in def.params {
        if spec.required && params.get(spec.key).is_none_or(Value::is_null) {
            return Err(HrError::validation(format!("'{code}' needs the parameter '{}'", spec.key)));
        }
    }
    if def.entry != ComponentEntry::Params && amount.is_none() && params.values().all(Value::is_null) {
        let tail = if def.params.is_empty() { "" } else { " or its parameters" };
        return Err(HrError::validation(format!("'{code}' needs an amount{tail}")));
    }
    Ok(())
}

async fn component_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, HrError> {
    let sql = if live {
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_pay_components t
         where t.id = $1 and t.deleted_at is null limit 1"
    } else {
        "select to_jsonb(t) || jsonb_build_object('amount', t.amount::text) from hr_pay_components t where t.id = $1 limit 1"
    };
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(js_row))
}

/// `createComponent(db, employeeId, input, ctx)`.
pub(crate) async fn create_component(db: &PgPool, employee_id: &str, input: &Value, created_by: &str) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let country = employer_country_of(db, employee_id).await?;
    let code = str_of(input, "code").unwrap_or("");
    let amount = input.get("amount").and_then(Value::as_f64);
    validate_component(&country, code, amount, input.get("params").unwrap_or(&Value::Null))?;
    assert_date_order(str_of(input, "effectiveFrom"), str_of(input, "effectiveTo"), "Component")?;
    let id = generate_id("hrpc");
    sqlx::query(
        "insert into hr_pay_components (id, employee_id, code, label, amount, params, effective_from, effective_to, created_by)
         values ($1, $2, $3, $4, $5::numeric, $6, $7::date, $8::date, $9)",
    )
    .bind(&id)
    .bind(employee_id)
    .bind(code)
    .bind(str_of(input, "label"))
    .bind(amount.map(decimal2))
    .bind(input.get("params").cloned().unwrap_or_else(|| json!({})))
    .bind(str_of(input, "effectiveFrom"))
    .bind(str_of(input, "effectiveTo"))
    .bind(created_by)
    .execute(db)
    .await?;
    let row = component_row(db, &id, false).await?.ok_or_else(|| HrError::internal("component vanished"))?;
    Ok(to_component_dto(&row))
}

/// `requireComponent(db, id)`.
pub(crate) async fn require_component(db: &PgPool, id: &str) -> Result<Value, HrError> {
    component_row(db, id, true).await?.ok_or_else(|| HrError::not_found("Pay component", id))
}

/// `updateComponent(db, id, input)`.
pub(crate) async fn update_component(db: &PgPool, id: &str, input: &Value) -> Result<Value, HrError> {
    let row = require_component(db, id).await?;
    let country = employer_country_of(db, s(&row, "employeeId")).await?;
    let amount = if has(input, "amount") {
        input["amount"].as_f64()
    } else {
        row["amount"].as_str().map(weldsuite_kit::validation::js_number)
    };
    let params = input.get("params").unwrap_or(&row["params"]);
    validate_component(&country, s(&row, "code"), amount, params)?;
    let from = str_of(input, "effectiveFrom").unwrap_or(s(&row, "effectiveFrom"));
    let to = if has(input, "effectiveTo") { str_of(input, "effectiveTo") } else { row["effectiveTo"].as_str() };
    assert_date_order(Some(from), to, "Component")?;
    sqlx::query(
        "update hr_pay_components set
           label = case when $2 then $3 else label end,
           amount = case when $4 then $5::numeric else amount end,
           params = coalesce($6, params),
           effective_from = coalesce($7::date, effective_from),
           effective_to = case when $8 then $9::date else effective_to end,
           updated_at = $10::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(has(input, "label"))
    .bind(str_of(input, "label"))
    .bind(has(input, "amount"))
    .bind(input.get("amount").and_then(Value::as_f64).map(decimal2))
    .bind(input.get("params"))
    .bind(str_of(input, "effectiveFrom"))
    .bind(has(input, "effectiveTo"))
    .bind(str_of(input, "effectiveTo"))
    .bind(now())
    .execute(db)
    .await?;
    let row = component_row(db, id, false).await?.ok_or_else(|| HrError::internal("component vanished"))?;
    Ok(to_component_dto(&row))
}

/// `deleteComponent(db, id)`: the employee it belonged to.
pub(crate) async fn delete_component(db: &PgPool, id: &str) -> Result<String, HrError> {
    let row = require_component(db, id).await?;
    let at = now();
    sqlx::query("update hr_pay_components set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    Ok(s(&row, "employeeId").to_owned())
}

/// `listElections(db, employeeId)`.
pub(crate) async fn list_elections(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    require_employee(db, employee_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_tax_elections t where t.employee_id = $1 order by t.effective_from desc, t.created_at desc",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).map(|r| to_election_dto(&r)).collect())
}

/// `createElection(db, employeeId, input, ctx)`.
pub(crate) async fn create_election(
    db: &PgPool,
    employee_id: &str,
    input: &Value,
    signed_by: &str,
    source: &str,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let country = employer_country_of(db, employee_id).await?;
    let kind = str_of(input, "kind").unwrap_or("");
    if kind == "nl_loonheffingskorting" && country != "NL" {
        return Err(HrError::validation("The loonheffingskorting is a Dutch election"));
    }
    if kind != "nl_loonheffingskorting" && country != "US" {
        return Err(HrError::validation("W-4 and state certificates are US elections"));
    }
    let state = if kind == "us_state_certificate" { str_of(input, "state") } else { None };
    if let Some(state) = state.filter(|s| !s.is_empty()) {
        if state_module(Some(state)).is_some_and(|m| m.certificate.is_none()) {
            return Err(HrError::validation(format!("{state} has no withholding certificate")));
        }
    }
    let signature = weldsuite_kit::validation::js_trim(str_of(input, "signatureName").unwrap_or(""));
    if signature.is_empty() {
        return Err(HrError::validation("The signature name is required"));
    }
    let at = now();
    let id = generate_id("hrte");
    sqlx::query(
        "insert into hr_tax_elections (id, employee_id, kind, state, effective_from, data, signed_by, signature_name, signed_at,
         source, created_at) values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::timestamp, $10, $9::timestamp)",
    )
    .bind(&id)
    .bind(employee_id)
    .bind(kind)
    .bind(state)
    .bind(str_of(input, "effectiveFrom"))
    .bind(&input["data"])
    .bind(signed_by)
    .bind(signature)
    .bind(&at)
    .bind(source)
    .execute(db)
    .await?;
    let row: Value = sqlx::query_scalar("select to_jsonb(t) from hr_tax_elections t where t.id = $1")
        .bind(&id)
        .fetch_one(db)
        .await?;
    Ok(to_election_dto(&js_row(row)))
}

/// `writeSensitive(db, id, patch, keyring)`: the fields that changed.
pub(crate) async fn write_sensitive(
    db: &PgPool,
    id: &str,
    patch: &[(String, Value)],
    keyring: &Keyring,
) -> Result<Vec<String>, HrError> {
    let employee = require_employee(db, id).await?;
    let current = decrypt_sensitive(&employee, keyring)?;
    let mut next = current.as_object().cloned().unwrap_or_default();
    let mut changed = vec![];
    for (key, value) in patch {
        let before = current.get(key).cloned().unwrap_or(Value::Null);
        if js_json(&before) != js_json(value) {
            changed.push(key.clone());
        }
        next.insert(key.clone(), value.clone());
    }
    if changed.is_empty() {
        return Ok(changed);
    }
    let sealed = encrypt_sensitive(&Value::Object(next), keyring)?;
    sqlx::query("update hr_employees set sensitive_encrypted = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(sealed)
        .bind(now())
        .execute(db)
        .await?;
    Ok(changed)
}

/// What `setPaymentDetails` changed.
pub(crate) struct PaymentDetailsResult {
    pub(crate) details: Value,
    pub(crate) changed_fields: Vec<String>,
    pub(crate) bank_changed: bool,
    pub(crate) id_verification_cleared: bool,
}

/// `setPaymentDetails(db, employeeId, input, ctx)`.
pub(crate) async fn set_payment_details(
    db: &PgPool,
    employee_id: &str,
    input: &Value,
    keyring: &Keyring,
    self_service: bool,
) -> Result<PaymentDetailsResult, HrError> {
    require_employee(db, employee_id).await?;
    let country: Option<String> = sqlx::query_scalar(
        "select e.country from hr_payroll_profiles p left join hr_payroll_employers e on e.id = p.employer_id
         where p.employee_id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?
    .flatten();
    let today = today_iso();
    let mut patch: Vec<(String, Value)> = vec![];
    let mut set = |key: &str, value: Value| patch.push((key.to_owned(), value));
    let blank = |v: &Value| v.is_null() || v.as_str().is_some_and(|s| weldsuite_kit::validation::js_trim(s).is_empty());
    if let Some(v) = input.get("nationalId") {
        if blank(v) {
            set("nationalId", Value::Null);
        } else {
            let raw = v.as_str().unwrap_or("");
            let (bsn, ssn) = (normalize_bsn(raw), normalize_ssn(raw));
            let valid = match country.as_deref() {
                Some("NL") => bsn,
                Some("US") => ssn,
                _ => bsn.or(ssn),
            };
            let Some(valid) = valid else {
                return Err(HrError::validation(match country.as_deref() {
                    Some("NL") => "The BSN is not valid",
                    Some("US") => "The SSN is not valid",
                    _ => "The BSN or SSN is not valid",
                }));
            };
            set("nationalId", json!(valid));
        }
    }
    if let Some(v) = input.get("dateOfBirth") {
        if let Some(dob) = v.as_str() {
            if !is_iso_date(dob) || dob > today.as_str() {
                return Err(HrError::validation("The date of birth is not valid"));
            }
            let age = age_on_date(dob, &today);
            if !(12..=110).contains(&age) {
                return Err(HrError::validation("The date of birth is not plausible"));
            }
        }
        set("dateOfBirth", v.clone());
    }
    if let Some(v) = input.get("bankIban") {
        if blank(v) {
            set("bankIban", Value::Null);
        } else {
            let iban = normalize_iban(v.as_str().unwrap_or(""));
            if !is_valid_iban(&iban) {
                return Err(HrError::validation("The IBAN is not valid"));
            }
            set("bankIban", json!(iban));
        }
    }
    if let Some(v) = input.get("bankBic") {
        if blank(v) {
            set("bankBic", Value::Null);
        } else {
            let Some(bic) = normalize_bic(v.as_str().unwrap_or("")) else {
                return Err(HrError::validation("The BIC is not valid"));
            };
            set("bankBic", json!(bic));
        }
    }
    if let Some(v) = input.get("bankRoutingNumber") {
        if let Some(r) = v.as_str() {
            if !is_valid_routing_number(r) {
                return Err(HrError::validation("The routing number is not valid (checksum)"));
            }
        }
        set("bankRoutingNumber", v.clone());
    }
    if let Some(v) = input.get("bankAccountNumber") {
        set("bankAccountNumber", v.clone());
    }
    if let Some(v) = input.get("bankAccountType") {
        set("bankAccountType", v.clone());
    }
    if let Some(v) = input.get("bankAccountHolder") {
        let holder = v.as_str().map(|h| weldsuite_kit::validation::js_trim(h).to_owned()).filter(|h| !h.is_empty());
        set("bankAccountHolder", holder.map_or(Value::Null, Value::String));
    }
    for key in ["homeAddress", "idDocumentType", "idDocumentNumber", "idDocumentExpiresOn"] {
        if let Some(v) = input.get(key) {
            set(key, v.clone());
        }
    }
    if !self_service {
        if let Some(v) = input.get("idVerifiedAt") {
            set("idVerifiedAt", v.clone());
        }
    }
    let mut id_verification_cleared = false;
    if self_service {
        let current = load_one(db, employee_id, keyring).await?.sensitive;
        let identity_changed = IDENTITY_FIELDS.iter().any(|key| {
            patch.iter().any(|(k, v)| {
                k == key && js_json(&current.get(*key).cloned().unwrap_or(Value::Null)) != js_json(v)
            })
        });
        if identity_changed && truthy_str(&current, "idVerifiedAt").is_some() {
            patch.push(("idVerifiedAt".into(), Value::Null));
            id_verification_cleared = true;
        }
    }
    let changed = write_sensitive(db, employee_id, &patch, keyring).await?;
    let details = mask_payment_details(&load_one(db, employee_id, keyring).await?.sensitive);
    let bank_changed = changed.iter().any(|f| BANK_FIELDS.contains(&f.as_str()));
    Ok(PaymentDetailsResult { details, changed_fields: changed, bank_changed, id_verification_cleared })
}

/// `stateCertificateDefinition(state)`.
pub(crate) fn state_certificate_definition(state: &str) -> Value {
    let Some(certificate) = state_module(Some(state)).and_then(|m| m.certificate.as_ref()) else {
        return Value::Null;
    };
    let mut def = Map::new();
    def.insert("formName".into(), json!(certificate.form_name));
    if let Some(statuses) = &certificate.filing_statuses {
        def.insert("filingStatuses".into(), json!(statuses));
    }
    def.insert("usesAllowances".into(), json!(certificate.uses_allowances));
    let fields: Vec<Value> = certificate
        .fields
        .iter()
        .map(|f| {
            let mut field = Map::new();
            field.insert("key".into(), json!(f.key));
            field.insert("type".into(), json!(f.kind));
            if let Some(options) = &f.options {
                field.insert("options".into(), json!(options));
            }
            if let Some(required) = f.required {
                field.insert("required".into(), json!(required));
            }
            field.insert("labelKey".into(), json!(f.label_key));
            Value::Object(field)
        })
        .collect();
    def.insert("fields".into(), Value::Array(fields));
    Value::Object(def)
}

/// `myPayrollDetails(db, employeeId, keyring, today)`.
pub(crate) async fn my_payroll_details(db: &PgPool, employee_id: &str, keyring: &Keyring, today: &str) -> Result<Value, HrError> {
    let d = load_one(db, employee_id, keyring).await?;
    let on_payroll = d.profile.as_ref().is_some_and(|p| p["status"] != "ended") && d.employer.is_some();
    let country = if on_payroll { d.employer.as_ref().and_then(|e| e["country"].as_str()) } else { None };
    let in_force = elections_in_force(&d.elections, today);
    let mut required = vec![];
    let mut missing: Vec<&str> = vec![];
    let sensitive = &d.sensitive;
    let t = |k: &str| truthy_str(sensitive, k).is_some();
    match country {
        Some("NL") => {
            if election_of(&d.elections, today, "nl_loonheffingskorting", None).is_none() {
                required.push(json!({ "kind": "nl_loonheffingskorting", "state": null }));
            }
            if !t("nationalId") {
                missing.push("nationalId");
            }
            if !t("dateOfBirth") {
                missing.push("dateOfBirth");
            }
            if !t("bankIban") {
                missing.push("bankIban");
            }
            if !t("idVerifiedAt") && !t("idDocumentType") && !t("idDocumentNumber") {
                missing.push("idDocument");
            }
        }
        Some("US") => {
            if election_of(&d.elections, today, "us_w4", None).is_none() {
                required.push(json!({ "kind": "us_w4", "state": null }));
            }
            let work_state =
                d.profile.as_ref().and_then(|p| truthy_str(&p["us"], "workState")).map(str::to_uppercase);
            if let Some(state) = &work_state {
                if state_certificate_required(Some(state))
                    && election_of(&d.elections, today, "us_state_certificate", Some(state)).is_none()
                {
                    required.push(json!({ "kind": "us_state_certificate", "state": state, "certificate": state_certificate_definition(state) }));
                }
            }
            if !t("nationalId") {
                missing.push("nationalId");
            }
            if !t("bankRoutingNumber") {
                missing.push("bankRoutingNumber");
            }
            if !t("bankAccountNumber") {
                missing.push("bankAccountNumber");
            }
            if !t("bankAccountType") {
                missing.push("bankAccountType");
            }
            let address = &sensitive["homeAddress"];
            if truthy_str(address, "line1").is_none() || truthy_str(address, "postalCode").is_none() {
                missing.push("homeAddress");
            }
        }
        _ => {}
    }
    Ok(json!({
        "country": country,
        "employerName": if on_payroll { d.employer.as_ref().map(|e| e["name"].clone()) } else { None },
        "paymentDetails": mask_payment_details(sensitive),
        "elections": in_force.iter().map(to_election_dto).collect::<Vec<_>>(),
        "requiredElections": required,
        "missing": missing,
    }))
}
