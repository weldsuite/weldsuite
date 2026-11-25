//! Employees on payroll: profiles, compensation, recurring components, tax
//! elections and payment details (`services/weldhr/payroll/employees.ts`).

use std::collections::HashMap;
use std::str::FromStr as _;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, OrmConn, PgPool, atomically_with, decrypt_field, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::components::{ComponentEntry, ParamType, component_def};
use weldsuite_payroll_domain::us::states::state_module;
use weldsuite_schema::tenant::{
    hr_compensations, hr_employees, hr_pay_components, hr_pay_schedules, hr_payroll_employers,
    hr_payroll_profiles, hr_payslips, hr_tax_elections,
};

use super::common::{
    age_on_date, decimal2, decimal4, employee_issue, is_iso_date, is_valid_iban,
    is_valid_routing_number, js_json, mask_account_number, mask_iban, mask_national_id,
    normalize_bic, normalize_bsn, normalize_iban, normalize_ssn, ranges_overlap, sort_issues,
    truthy_str,
};
use super::employer_context::{find_employer_for_payroll, resolve_employers};
use super::employers::{employer_issues, read_employer_bank, work_states_of};
use super::schema::{has, str_of};
use crate::employees::{
    display_name_of, encrypt_sensitive, pg_date, pg_date_opt, require_employee, to_json,
};
use crate::entity_scope::Scope;
use crate::{HrError, add_days, assert_date_order, locale_compare, today_iso};

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

pub(crate) const BANK_FIELDS: [&str; 6] = [
    "bankAccountHolder",
    "bankIban",
    "bankBic",
    "bankRoutingNumber",
    "bankAccountNumber",
    "bankAccountType",
];
const IDENTITY_FIELDS: [&str; 5] = [
    "nationalId",
    "dateOfBirth",
    "idDocumentType",
    "idDocumentNumber",
    "idDocumentExpiresOn",
];

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
        BANK_FIELDS
            .iter()
            .map(|k| bank.and_then(|b| b.get(*k)).cloned().unwrap_or(Value::Null))
            .collect()
    };
    norm(a) == norm(b)
}

/// A row as `to_jsonb(t)` and `js_row` read it, from the entity: numeric
/// columns as the text Drizzle reads (the entity's serializers, what the
/// SQL's `amount::text` gave), and a whole `double precision`
/// (`weekly_hours`, `hours_per_week`) as an integer, as `to_jsonb` writes
/// `40` where the model has `40.0`.
pub(crate) fn jsonb_row<T: Serialize>(model: T) -> Result<Value, HrError> {
    let mut row = to_json(model)?;
    if let Some(columns) = row.as_object_mut() {
        for value in columns.values_mut() {
            if let Some(number) = value.as_f64().filter(|_| value.is_f64()) {
                *value = weldsuite_core_domain::js::number_value(number);
            }
        }
    }
    Ok(row)
}

/// [`jsonb_row`] of every model.
pub(crate) fn jsonb_rows<T: Serialize>(models: Vec<T>) -> Result<Vec<Value>, HrError> {
    models.into_iter().map(jsonb_row).collect()
}

/// `select to_jsonb(e) from hr_employees e where e.id = any($1)`: deleted
/// employees too, in the database's order.
pub(crate) async fn employee_rows(
    db: &PgPool,
    ids: &[impl AsRef<str>],
) -> Result<Vec<Value>, HrError> {
    jsonb_rows(
        hr_employees::Entity::find()
            .filter(hr_employees::Column::Id.is_in(ids.iter().map(AsRef::as_ref)))
            .all(&orm(db))
            .await?,
    )
}

/// A money amount the SQL bound as text for `$n::numeric`: a text Postgres
/// can't read fails the statement, as it did (the router's 500).
pub(crate) fn pg_numeric(text: &str) -> Result<BigDecimal, HrError> {
    BigDecimal::from_str(text).map_err(|_| {
        HrError::Database(DbErr::Custom(format!(
            "invalid input syntax for type numeric: \"{text}\""
        )))
    })
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
    let orm = orm(db);
    let employees = jsonb_rows(
        hr_employees::Entity::find()
            .filter(hr_employees::Column::Id.is_in(employee_ids))
            .filter(hr_employees::Column::DeletedAt.is_null())
            .all(&orm)
            .await?,
    )?;
    let profiles = jsonb_rows(
        hr_payroll_profiles::Entity::find()
            .filter(hr_payroll_profiles::Column::EmployeeId.is_in(employee_ids))
            .all(&orm)
            .await?,
    )?;
    let compensations = jsonb_rows(
        hr_compensations::Entity::find()
            .filter(hr_compensations::Column::EmployeeId.is_in(employee_ids))
            .order_by_desc(hr_compensations::Column::EffectiveFrom)
            .all(&orm)
            .await?,
    )?;
    let components = jsonb_rows(
        hr_pay_components::Entity::find()
            .filter(hr_pay_components::Column::EmployeeId.is_in(employee_ids))
            .filter(hr_pay_components::Column::DeletedAt.is_null())
            .order_by_asc(hr_pay_components::Column::EffectiveFrom)
            .all(&orm)
            .await?,
    )?;
    let elections = jsonb_rows(
        hr_tax_elections::Entity::find()
            .filter(hr_tax_elections::Column::EmployeeId.is_in(employee_ids))
            .order_by_desc(hr_tax_elections::Column::EffectiveFrom)
            .order_by_desc(hr_tax_elections::Column::CreatedAt)
            .all(&orm)
            .await?,
    )?;
    let employer_ids: Vec<String> = profiles
        .iter()
        .filter_map(|p| p["employerId"].as_str().map(str::to_owned))
        .collect();
    let employers: Vec<Value> = if employer_ids.is_empty() {
        vec![]
    } else {
        let raw = jsonb_rows(
            hr_payroll_employers::Entity::find()
                .filter(hr_payroll_employers::Column::Id.is_in(&employer_ids))
                .all(&orm)
                .await?,
        )?;
        resolve_employers(db, raw, keyring)
            .await?
            .into_iter()
            .map(|employer| employer.row)
            .collect()
    };
    let mut out = vec![];
    for employee in employees {
        let id = employee["id"].as_str().unwrap_or("").to_owned();
        let profile = profiles
            .iter()
            .find(|p| p["employeeId"] == id.as_str())
            .cloned();
        let employer = profile.as_ref().and_then(|p| {
            employers
                .iter()
                .find(|e| e["id"] == p["employerId"])
                .cloned()
        });
        let sensitive = if profile.is_some() {
            decrypt_sensitive(&employee, keyring)?
        } else {
            json!({})
        };
        let of = |list: &[Value]| {
            list.iter()
                .filter(|r| r["employeeId"] == id.as_str())
                .cloned()
                .collect::<Vec<_>>()
        };
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
pub(crate) async fn load_one(
    db: &PgPool,
    employee_id: &str,
    keyring: &Keyring,
) -> Result<EmployeePayrollData, HrError> {
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

/// `select to_jsonb(t) from hr_payroll_profiles t where t.employee_id = $1
/// limit 1`.
pub(crate) async fn profile_of(db: &PgPool, employee_id: &str) -> Result<Option<Value>, HrError> {
    hr_payroll_profiles::Entity::find()
        .filter(hr_payroll_profiles::Column::EmployeeId.eq(employee_id))
        .one(&orm(db))
        .await?
        .map(jsonb_row)
        .transpose()
}

/// `select employer_id from hr_payroll_profiles where employee_id = $1 limit 1`.
async fn profile_employer_id(db: &PgPool, employee_id: &str) -> Result<Option<String>, HrError> {
    Ok(hr_payroll_profiles::Entity::find()
        .select_only()
        .column(hr_payroll_profiles::Column::EmployerId)
        .filter(hr_payroll_profiles::Column::EmployeeId.eq(employee_id))
        .into_tuple()
        .one(&orm(db))
        .await?)
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
        .filter(|row| {
            ranges_overlap(
                s(row, "effectiveFrom"),
                row["effectiveTo"].as_str(),
                start,
                Some(end),
            )
        })
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
                    || (s(row, "effectiveFrom") == s(current, "effectiveFrom")
                        && s(row, "createdAt") > s(current, "createdAt"));
                if newer {
                    *current = row.clone();
                }
            }
        }
    }
    best.into_iter().map(|(_, v)| v).collect()
}

/// `electionOf(rows, date, kind, state)`.
pub(crate) fn election_of(
    rows: &[Value],
    date: &str,
    kind: &str,
    state: Option<&str>,
) -> Option<Value> {
    let wanted = state.filter(|s| !s.is_empty()).map(str::to_uppercase);
    elections_in_force(rows, date).into_iter().find(|r| {
        r["kind"] == kind
            && r["state"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_uppercase)
                == wanted
    })
}

/// `stateCertificateRequired(state)`.
pub(crate) fn state_certificate_required(state: Option<&str>) -> bool {
    state_module(state).is_some_and(|m| m.certificate.is_some())
}

/// `readinessIssues(data, opts)`.
pub(crate) fn readiness_issues(
    data: &EmployeePayrollData,
    on_date: &str,
    list: bool,
    employer_issues: &[Value],
) -> Vec<Value> {
    let (Some(profile), Some(employer)) = (&data.profile, &data.employer) else {
        return vec![];
    };
    if profile["status"] == "ended" {
        return vec![];
    }
    let id = s(&data.employee, "id");
    let sensitive = &data.sensitive;
    let mut issues = vec![];
    let mut add = |severity: &str, code: &str, params: Option<Value>| {
        issues.push(employee_issue(severity, code, id, params));
    };
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
        if list
            && truthy_str(sensitive, "nationalId").is_some()
            && truthy_str(sensitive, "idVerifiedAt").is_none()
        {
            add(
                "warning",
                "anonymous_rate",
                Some(json!({ "reason": "id_not_verified" })),
            );
        }
        if election_of(&data.elections, on_date, "nl_loonheffingskorting", None).is_none() {
            add(
                "warning",
                "missing_tax_election",
                Some(json!({ "kind": "nl_loonheffingskorting" })),
            );
        }
    } else {
        if truthy_str(sensitive, "bankRoutingNumber").is_none()
            || truthy_str(sensitive, "bankAccountNumber").is_none()
        {
            add("error", "missing_bank_account", None);
        }
        let work_state = truthy_str(&profile["us"], "workState");
        if work_state.is_none() {
            add("error", "missing_work_state", None);
        }
        if list && election_of(&data.elections, on_date, "us_w4", None).is_none() {
            add(
                "warning",
                "missing_tax_election",
                Some(json!({ "kind": "us_w4" })),
            );
        }
        if let Some(state) = work_state
            && state_certificate_required(Some(state))
            && election_of(
                &data.elections,
                on_date,
                "us_state_certificate",
                Some(state),
            )
            .is_none()
        {
            add(
                "warning",
                "missing_tax_election",
                Some(json!({ "kind": "us_state_certificate", "state": state })),
            );
        }
    }
    if list && let Some(blocking) = employer_issues.iter().find(|i| i["severity"] == "error") {
        add(
            "error",
            "employer_incomplete",
            blocking.get("params").cloned(),
        );
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
async fn employer_issue_map(
    db: &PgPool,
    employers: &[Value],
    keyring: &Keyring,
    today: &str,
) -> Result<HashMap<String, Vec<Value>>, HrError> {
    let mut out = HashMap::new();
    if employers.is_empty() {
        return Ok(out);
    }
    let ids: Vec<String> = employers
        .iter()
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect();
    let profiles = jsonb_rows(
        hr_payroll_profiles::Entity::find()
            .filter(hr_payroll_profiles::Column::EmployerId.is_in(&ids))
            .filter(hr_payroll_profiles::Column::Status.eq("active"))
            .all(&orm(db))
            .await?,
    )?;
    for employer in employers {
        let bank = read_employer_bank(employer, keyring)?;
        let mine: Vec<Value> = profiles
            .iter()
            .filter(|p| p["employerId"] == employer["id"])
            .cloned()
            .collect();
        let issues = employer_issues(
            employer,
            bank.as_ref(),
            &work_states_of(&mine),
            super::common::year_of_date(today),
        );
        out.insert(s(employer, "id").to_owned(), issues);
    }
    Ok(out)
}

/// `listPayrollEmployees(db, filters, keyring, today)`, by name; `scope` is
/// the request's entity scope on the employees.
pub(crate) async fn list_payroll_employees(
    db: &PgPool,
    employer_id: Option<&str>,
    on_payroll: Option<bool>,
    scope: &Scope,
    keyring: &Keyring,
    today: &str,
) -> Result<Vec<Value>, HrError> {
    let orm = orm(db);
    let mut ids: Vec<String> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::Id)
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(hr_employees::Column::Status.ne("terminated"))
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .into_tuple()
        .all(&orm)
        .await?;
    let still_paid: Vec<String> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::Id)
        .join(
            JoinType::InnerJoin,
            hr_employees::Entity::belongs_to(hr_payroll_profiles::Entity)
                .from(hr_employees::Column::Id)
                .to(hr_payroll_profiles::Column::EmployeeId)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(hr_employees::Column::Status.eq("terminated"))
        .filter(hr_payroll_profiles::Column::Status.ne("ended"))
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .into_tuple()
        .all(&orm)
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
    let schedule_ids: Vec<String> = data
        .iter()
        .filter_map(|d| {
            d.profile
                .as_ref()
                .and_then(|p| truthy_str(p, "payScheduleId"))
                .map(str::to_owned)
        })
        .collect();
    let schedule_names: HashMap<String, String> = if schedule_ids.is_empty() {
        HashMap::new()
    } else {
        hr_pay_schedules::Entity::find()
            .select_only()
            .columns([hr_pay_schedules::Column::Id, hr_pay_schedules::Column::Name])
            .filter(hr_pay_schedules::Column::Id.is_in(&schedule_ids))
            .into_tuple::<(String, String)>()
            .all(&orm)
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
        if let Some(employer_id) = employer_id.filter(|e| !e.is_empty())
            && d.profile.as_ref().map(|p| s(p, "employerId")) != Some(employer_id)
        {
            continue;
        }
        let start = d.profile.as_ref().and_then(|p| truthy_str(p, "startDate"));
        let ref_date = match start {
            Some(start) if start > today => start.to_owned(),
            _ => today.to_owned(),
        };
        let comp = compensation_on(&d.compensations, &ref_date)
            .or_else(|| compensation_on(&d.compensations, today));
        let empty = vec![];
        let employer_issues = d
            .employer
            .as_ref()
            .and_then(|e| employer_issues_by_id.get(s(e, "id")))
            .unwrap_or(&empty);
        let name = display_name_of(&d.employee);
        let schedule = d
            .profile
            .as_ref()
            .and_then(|p| truthy_str(p, "payScheduleId"));
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
pub(crate) async fn get_payroll_employee(
    db: &PgPool,
    employee_id: &str,
    keyring: &Keyring,
    today: &str,
) -> Result<Value, HrError> {
    let d = load_one(db, employee_id, keyring).await?;
    let employer_issues = match &d.employer {
        Some(e) => employer_issue_map(db, std::slice::from_ref(e), keyring, today)
            .await?
            .remove(s(e, "id"))
            .unwrap_or_default(),
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

async fn profiles_of_employer(
    db: &PgPool,
    employer_id: &str,
) -> Result<Vec<(String, Value)>, HrError> {
    Ok(hr_payroll_profiles::Entity::find()
        .select_only()
        .columns([
            hr_payroll_profiles::Column::EmployeeId,
            hr_payroll_profiles::Column::Nl,
        ])
        .filter(hr_payroll_profiles::Column::EmployerId.eq(employer_id))
        .into_tuple()
        .all(&orm(db))
        .await?)
}

/// `nextIncomeRelationshipNumber(db, employerId, exceptEmployeeId)`.
async fn next_income_relationship_number(
    db: &PgPool,
    employer_id: &str,
    except: &str,
) -> Result<f64, HrError> {
    let mut max: f64 = 0.0;
    for (employee, nl) in profiles_of_employer(db, employer_id).await? {
        if employee == except {
            continue;
        }
        let a = nl["incomeRelationshipNumber"].as_f64().unwrap_or(0.0);
        let b = nl["transitionIncomeRelationshipNumber"]
            .as_f64()
            .unwrap_or(0.0);
        max = max.max(a).max(b);
    }
    Ok(max + 1.0)
}

/// `transitionIncomeRelationshipNumber(db, employeeId)`.
pub(crate) async fn transition_income_relationship_number(
    db: &PgPool,
    employee_id: &str,
) -> Result<Option<f64>, HrError> {
    let Some(profile) = profile_of(db, employee_id).await? else {
        return Ok(None);
    };
    if let Some(n) = profile["nl"]["transitionIncomeRelationshipNumber"]
        .as_f64()
        .filter(|n| *n != 0.0)
    {
        return Ok(Some(n));
    }
    let next = next_income_relationship_number(db, s(&profile, "employerId"), employee_id).await?;
    let number = next.max(
        profile["nl"]["incomeRelationshipNumber"]
            .as_f64()
            .unwrap_or(0.0)
            + 1.0,
    );
    let mut nl = profile["nl"].as_object().cloned().unwrap_or_default();
    nl.insert(
        "transitionIncomeRelationshipNumber".into(),
        weldsuite_core_domain::js::number_value(number),
    );
    hr_payroll_profiles::Entity::update_many()
        .col_expr(
            hr_payroll_profiles::Column::Nl,
            Expr::value(Value::Object(nl)),
        )
        .col_expr(
            hr_payroll_profiles::Column::UpdatedAt,
            Expr::value(utc_now()),
        )
        .filter(hr_payroll_profiles::Column::Id.eq(s(&profile, "id")))
        .exec(&orm(db))
        .await?;
    Ok(Some(number))
}

/// `upsertProfile(db, employeeId, input)`.
pub(crate) async fn upsert_profile(
    db: &PgPool,
    employee_id: &str,
    input: &Value,
) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let employer_id = str_of(input, "employerId").unwrap_or("");
    let employer = find_employer_for_payroll(db, employer_id, &Keyring::default())
        .await?
        .map(|employer| employer.row)
        .filter(|employer| employer["deletedAt"].is_null());
    let Some(employer) = employer else {
        return Err(HrError::not_found("Payroll employer", employer_id));
    };
    if employer["isActive"] != true {
        return Err(HrError::validation("This employer is not active"));
    }
    // The employer is a payroll registration of the company that employs the employee.
    if let (Some(employee_entity), Some(employer_entity)) = (
        truthy_str(&employee, "legalEntityId"),
        truthy_str(&employer, "legalEntityId"),
    ) && employee_entity != employer_entity
    {
        return Err(HrError::validation(
            "This employer belongs to another legal entity than the employee. Move the employee to that entity first.",
        ));
    }
    if let Some(schedule_id) = truthy_str(input, "payScheduleId") {
        let schedule = hr_pay_schedules::Entity::find()
            .filter(hr_pay_schedules::Column::Id.eq(schedule_id))
            .filter(hr_pay_schedules::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?;
        match schedule.map(jsonb_row).transpose()? {
            Some(schedule) if schedule["employerId"] == employer["id"] => {
                if schedule["isActive"] != true {
                    return Err(HrError::validation("This pay schedule is not active"));
                }
            }
            _ => {
                return Err(HrError::validation(
                    "The pay schedule does not belong to this employer",
                ));
            }
        }
    }
    assert_date_order(
        str_of(input, "startDate"),
        str_of(input, "endDate"),
        "Payroll",
    )?;
    let existing = profile_of(db, employee_id).await?;
    if let Some(existing) = &existing
        && existing["employerId"] != employer["id"]
    {
        let finals = hr_payslips::Entity::find()
            .filter(hr_payslips::Column::EmployeeId.eq(employee_id))
            .filter(hr_payslips::Column::Status.eq("final"))
            .count(&orm(db))
            .await?;
        if finals > 0 {
            return Err(HrError::conflict(
                "This employee has payslips under another employer. End that payroll and start a new one.",
            ));
        }
    }
    let merge = |key: &str| -> Map<String, Value> {
        let mut out = existing
            .as_ref()
            .and_then(|e| e[key].as_object().cloned())
            .unwrap_or_default();
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
        let wanted = nl
            .get("incomeRelationshipNumber")
            .and_then(Value::as_f64)
            .filter(|n| *n != 0.0);
        if let Some(number) = wanted {
            let clash = profiles_of_employer(db, s(&employer, "id"))
                .await?
                .into_iter()
                .any(|(emp, other)| {
                    emp != employee_id && other["incomeRelationshipNumber"].as_f64() == Some(number)
                });
            if clash {
                return Err(HrError::conflict(format!(
                    "Income relationship number {} is already used at this employer",
                    weldsuite_core_domain::js::number_text(number)
                )));
            }
        } else if existing.as_ref().is_none_or(|e| {
            e["employerId"] != employer["id"]
                || e["nl"]["incomeRelationshipNumber"]
                    .as_f64()
                    .is_none_or(|n| n == 0.0)
        }) {
            let next = next_income_relationship_number(db, s(&employer, "id"), employee_id).await?;
            nl.insert(
                "incomeRelationshipNumber".into(),
                weldsuite_core_domain::js::number_value(next),
            );
        }
        if nl.get("contractHoursPerWeek").is_none_or(Value::is_null) {
            // As `to_jsonb` read the column: `40`, not the model's `40.0`.
            nl.insert(
                "contractHoursPerWeek".into(),
                weldsuite_core_domain::js::whole_numbers(&employee["weeklyHours"]),
            );
        }
    }
    let pick = |key: &str, fallback: Value| {
        if has(input, key) {
            input[key].clone()
        } else {
            fallback
        }
    };
    let previous = |key: &str| existing.as_ref().map_or(Value::Null, |e| e[key].clone());
    let schedule = pick("payScheduleId", previous("payScheduleId"));
    let status = input
        .get("status")
        .cloned()
        .or_else(|| existing.as_ref().map(|e| e["status"].clone()))
        .unwrap_or(json!("active"));
    let start = pg_date_opt(pick("startDate", previous("startDate")).as_str())?;
    let end = pg_date_opt(pick("endDate", previous("endDate")).as_str())?;
    let schedule = schedule.as_str().map(str::to_owned);
    // `status = $n`: a status that isn't text is a null the column refuses.
    let status = status.as_str().map(str::to_owned).ok_or_else(|| {
        HrError::Database(DbErr::Custom(
            "null value in column \"status\" of relation \"hr_payroll_profiles\"".into(),
        ))
    })?;
    let at = utc_now();
    let orm = orm(db);
    let id = if let Some(existing) = &existing {
        hr_payroll_profiles::Entity::update_many()
            .col_expr(
                hr_payroll_profiles::Column::EmployerId,
                Expr::value(s(&employer, "id")),
            )
            .col_expr(
                hr_payroll_profiles::Column::PayScheduleId,
                Expr::value(schedule),
            )
            .col_expr(hr_payroll_profiles::Column::Status, Expr::value(status))
            .col_expr(hr_payroll_profiles::Column::StartDate, Expr::value(start))
            .col_expr(hr_payroll_profiles::Column::EndDate, Expr::value(end))
            .col_expr(
                hr_payroll_profiles::Column::Nl,
                Expr::value(Value::Object(nl)),
            )
            .col_expr(
                hr_payroll_profiles::Column::Us,
                Expr::value(Value::Object(us)),
            )
            .col_expr(hr_payroll_profiles::Column::UpdatedAt, Expr::value(at))
            .filter(hr_payroll_profiles::Column::Id.eq(s(existing, "id")))
            .exec(&orm)
            .await?;
        s(existing, "id").to_owned()
    } else {
        let id = generate_id("hrpp");
        hr_payroll_profiles::Entity::insert(hr_payroll_profiles::ActiveModel {
            id: Set(id.clone()),
            employee_id: Set(employee_id.to_owned()),
            employer_id: Set(s(&employer, "id").to_owned()),
            pay_schedule_id: Set(schedule),
            status: Set(status),
            start_date: Set(start),
            end_date: Set(end),
            nl: Set(Value::Object(nl)),
            us: Set(Value::Object(us)),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm)
        .await?;
        id
    };
    let row = hr_payroll_profiles::Entity::find_by_id(id.as_str())
        .one(&orm)
        .await?
        .ok_or_else(|| crate::employees::no_row("hr_payroll_profiles"))?;
    Ok(to_profile_dto(&jsonb_row(row)?))
}

/// `lastApprovedPeriodEnd(db, employeeId)`.
pub(crate) async fn last_approved_period_end(
    db: &PgPool,
    employee_id: &str,
) -> Result<Option<String>, HrError> {
    let max: Option<Option<String>> = hr_payslips::Entity::find()
        .select_only()
        .column_as(
            sea_orm::ExprTrait::cast_as(
                Expr::expr(Func::max(Expr::col(hr_payslips::Column::PeriodEnd))),
                "text",
            ),
            "max",
        )
        .filter(hr_payslips::Column::EmployeeId.eq(employee_id))
        .filter(hr_payslips::Column::Status.eq("final"))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(max.flatten())
}

async fn compensation_row(db: &PgPool, id: &str) -> Result<Option<Value>, HrError> {
    hr_compensations::Entity::find_by_id(id)
        .one(&orm(db))
        .await?
        .map(jsonb_row)
        .transpose()
}

async fn compensations_of(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    jsonb_rows(
        hr_compensations::Entity::find()
            .filter(hr_compensations::Column::EmployeeId.eq(employee_id))
            .order_by_desc(hr_compensations::Column::EffectiveFrom)
            .all(&orm(db))
            .await?,
    )
}

/// `createCompensation(db, employeeId, input, ctx)`.
pub(crate) async fn create_compensation(
    db: &PgPool,
    employee_id: &str,
    input: &Value,
    created_by: &str,
) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let profile_employer = profile_employer_id(db, employee_id).await?;
    let currency_of_employer: Option<String> = match profile_employer {
        Some(employer_id) => find_employer_for_payroll(db, &employer_id, &Keyring::default())
            .await?
            .and_then(|employer| employer.row["currency"].as_str().map(str::to_owned)),
        None => None,
    };
    let pay_type = str_of(input, "payType").unwrap_or("");
    let period = str_of(input, "period").unwrap_or("");
    if pay_type == "hourly" && period != "hour" {
        return Err(HrError::validation("Hourly pay is an amount per hour"));
    }
    if pay_type == "salary" && period == "hour" {
        return Err(HrError::validation(
            "A salary is an amount per week, month or year",
        ));
    }
    let existing = compensations_of(db, employee_id).await?;
    let from = str_of(input, "effectiveFrom").unwrap_or("");
    if let Some(latest) = existing.first()
        && from <= s(latest, "effectiveFrom")
    {
        return Err(HrError::validation(format!(
            "A compensation effective from {} already exists; the new one must start after it",
            s(latest, "effectiveFrom")
        )));
    }
    let allow_retroactive = input
        .get("allowRetroactive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if let Some(last_end) = last_approved_period_end(db, employee_id).await?
        && from <= last_end.as_str()
        && !allow_retroactive
    {
        return Err(HrError::payroll(
            "RETROACTIVE_COMPENSATION",
            format!(
                "Pay was already approved up to {last_end}. Start the new compensation after that date, or confirm it is retroactive and correct the affected pay runs."
            ),
            409,
        ));
    }
    let at = utc_now();
    let id = generate_id("hrcmp");
    let currency = str_of(input, "currency")
        .map(str::to_owned)
        .or(currency_of_employer)
        .unwrap_or_else(|| "EUR".into())
        .to_uppercase();
    let hours = match input.get("hoursPerWeek") {
        Some(Value::Number(n)) => n.as_f64(),
        _ => employee["weeklyHours"].as_f64(),
    };
    // The latest compensation ends the day before the new one starts.
    let close = match existing.first().filter(|l| l["effectiveTo"].is_null()) {
        Some(latest) => Some((s(latest, "id").to_owned(), pg_date(&add_days(from, -1))?)),
        None => None,
    };
    let record = hr_compensations::ActiveModel {
        id: Set(id.clone()),
        employee_id: Set(employee_id.to_owned()),
        effective_from: Set(pg_date(from)?),
        effective_to: Set(None),
        pay_type: Set(pay_type.to_owned()),
        amount: Set(pg_numeric(&decimal4(
            input["amount"].as_f64().unwrap_or(0.0),
        ))?),
        period: Set(period.to_owned()),
        currency: Set(currency),
        hours_per_week: Set(hours),
        reason: Set(str_of(input, "reason").map(str::to_owned)),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    };
    atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            if let Some((latest, day_before)) = close {
                hr_compensations::Entity::update_many()
                    .col_expr(
                        hr_compensations::Column::EffectiveTo,
                        Expr::value(day_before),
                    )
                    .col_expr(hr_compensations::Column::UpdatedAt, Expr::value(at))
                    .filter(hr_compensations::Column::Id.eq(latest))
                    .exec(&tx)
                    .await?;
            }
            hr_compensations::Entity::insert(record)
                .exec_without_returning(&tx)
                .await?;
            Ok::<_, HrError>(())
        })
    })
    .await?;
    let row = compensation_row(db, &id)
        .await?
        .ok_or_else(|| HrError::internal("compensation vanished"))?;
    Ok(to_compensation_dto(&row))
}

/// `deleteCompensation(db, id)`: the employee it belonged to.
pub(crate) async fn delete_compensation(db: &PgPool, id: &str) -> Result<String, HrError> {
    let Some(row) = compensation_row(db, id).await? else {
        return Err(HrError::not_found("Compensation", id));
    };
    if !row["effectiveTo"].is_null() {
        return Err(HrError::conflict(
            "Only the newest compensation can be removed",
        ));
    }
    let employee_id = s(&row, "employeeId").to_owned();
    if let Some(last_end) = last_approved_period_end(db, &employee_id).await?
        && s(&row, "effectiveFrom") <= last_end.as_str()
    {
        return Err(HrError::conflict(
            "Pay approved under this compensation depends on it, so it cannot be removed",
        ));
    }
    let day_before = add_days(s(&row, "effectiveFrom"), -1);
    let previous = compensations_of(db, &employee_id)
        .await?
        .into_iter()
        .find(|r| r["id"] != id && r["effectiveTo"].as_str() == Some(day_before.as_str()));
    let id = id.to_owned();
    let previous = previous.map(|row| s(&row, "id").to_owned());
    atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            hr_compensations::Entity::delete_many()
                .filter(hr_compensations::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            if let Some(previous) = previous {
                hr_compensations::Entity::update_many()
                    .col_expr(
                        hr_compensations::Column::EffectiveTo,
                        Expr::value(Option::<time::Date>::None),
                    )
                    .col_expr(hr_compensations::Column::UpdatedAt, Expr::value(utc_now()))
                    .filter(hr_compensations::Column::Id.eq(previous))
                    .exec(&tx)
                    .await?;
            }
            Ok::<_, HrError>(())
        })
    })
    .await?;
    Ok(employee_id)
}

/// `employerCountryOf(db, employeeId)`.
async fn employer_country_of(db: &PgPool, employee_id: &str) -> Result<String, HrError> {
    let Some(employer_id) = profile_employer_id(db, employee_id).await? else {
        return Err(HrError::validation("Put the employee on payroll first"));
    };
    let employer = find_employer_for_payroll(db, &employer_id, &Keyring::default()).await?;
    employer
        .and_then(|employer| employer.row["country"].as_str().map(str::to_owned))
        .ok_or_else(|| HrError::validation("The employee's employer no longer exists"))
}

fn validate_component(
    country: &str,
    code: &str,
    amount: Option<f64>,
    params: &Value,
) -> Result<(), HrError> {
    let Some(def) = component_def(code) else {
        return Err(HrError::validation(format!(
            "Unknown pay component '{code}'"
        )));
    };
    let wanted = super::employers::country_of(country);
    if !def.countries.contains(&wanted) {
        return Err(HrError::validation(format!(
            "'{code}' is not available for {country} payroll"
        )));
    }
    if !def.recurring {
        return Err(HrError::validation(format!(
            "'{code}' is entered on a pay run, not as a recurring component"
        )));
    }
    let empty = Map::new();
    let params = params.as_object().unwrap_or(&empty);
    for (key, value) in params {
        let Some(spec) = def.params.iter().find(|p| p.key == key) else {
            return Err(HrError::validation(format!(
                "'{code}' has no parameter '{key}'"
            )));
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
            return Err(HrError::validation(format!(
                "Parameter '{key}' of '{code}' has the wrong type"
            )));
        }
    }
    for spec in def.params {
        if spec.required && params.get(spec.key).is_none_or(Value::is_null) {
            return Err(HrError::validation(format!(
                "'{code}' needs the parameter '{}'",
                spec.key
            )));
        }
    }
    if def.entry != ComponentEntry::Params
        && amount.is_none()
        && params.values().all(Value::is_null)
    {
        let tail = if def.params.is_empty() {
            ""
        } else {
            " or its parameters"
        };
        return Err(HrError::validation(format!(
            "'{code}' needs an amount{tail}"
        )));
    }
    Ok(())
}

async fn component_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, HrError> {
    let mut query = hr_pay_components::Entity::find().filter(hr_pay_components::Column::Id.eq(id));
    if live {
        query = query.filter(hr_pay_components::Column::DeletedAt.is_null());
    }
    query.one(&orm(db)).await?.map(jsonb_row).transpose()
}

/// `createComponent(db, employeeId, input, ctx)`.
pub(crate) async fn create_component(
    db: &PgPool,
    employee_id: &str,
    input: &Value,
    created_by: &str,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let country = employer_country_of(db, employee_id).await?;
    let code = str_of(input, "code").unwrap_or("");
    let amount = input.get("amount").and_then(Value::as_f64);
    validate_component(
        &country,
        code,
        amount,
        input.get("params").unwrap_or(&Value::Null),
    )?;
    assert_date_order(
        str_of(input, "effectiveFrom"),
        str_of(input, "effectiveTo"),
        "Component",
    )?;
    let id = generate_id("hrpc");
    hr_pay_components::Entity::insert(hr_pay_components::ActiveModel {
        id: Set(id.clone()),
        employee_id: Set(employee_id.to_owned()),
        code: Set(code.to_owned()),
        label: Set(str_of(input, "label").map(str::to_owned)),
        amount: Set(amount.map(|a| pg_numeric(&decimal2(a))).transpose()?),
        params: Set(input.get("params").cloned().unwrap_or_else(|| json!({}))),
        effective_from: Set(pg_date(str_of(input, "effectiveFrom").unwrap_or_default())?),
        effective_to: Set(pg_date_opt(str_of(input, "effectiveTo"))?),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    let row = component_row(db, &id, false)
        .await?
        .ok_or_else(|| HrError::internal("component vanished"))?;
    Ok(to_component_dto(&row))
}

/// `requireComponent(db, id)`.
pub(crate) async fn require_component(db: &PgPool, id: &str) -> Result<Value, HrError> {
    component_row(db, id, true)
        .await?
        .ok_or_else(|| HrError::not_found("Pay component", id))
}

/// `updateComponent(db, id, input)`.
pub(crate) async fn update_component(
    db: &PgPool,
    id: &str,
    input: &Value,
) -> Result<Value, HrError> {
    let row = require_component(db, id).await?;
    let country = employer_country_of(db, s(&row, "employeeId")).await?;
    let amount = if has(input, "amount") {
        input["amount"].as_f64()
    } else {
        row["amount"]
            .as_str()
            .map(weldsuite_kit::validation::js_number)
    };
    let params = input.get("params").unwrap_or(&row["params"]);
    validate_component(&country, s(&row, "code"), amount, params)?;
    let from = str_of(input, "effectiveFrom").unwrap_or(s(&row, "effectiveFrom"));
    let to = if has(input, "effectiveTo") {
        str_of(input, "effectiveTo")
    } else {
        row["effectiveTo"].as_str()
    };
    assert_date_order(Some(from), to, "Component")?;
    let mut update = hr_pay_components::Entity::update_many();
    if has(input, "label") {
        update = update.col_expr(
            hr_pay_components::Column::Label,
            Expr::value(str_of(input, "label").map(str::to_owned)),
        );
    }
    if has(input, "amount") {
        let amount = input.get("amount").and_then(Value::as_f64);
        update = update.col_expr(
            hr_pay_components::Column::Amount,
            Expr::value(amount.map(|a| pg_numeric(&decimal2(a))).transpose()?),
        );
    }
    if let Some(params) = input.get("params") {
        update = update.col_expr(
            hr_pay_components::Column::Params,
            Expr::value(params.clone()),
        );
    }
    if let Some(from) = str_of(input, "effectiveFrom") {
        update = update.col_expr(
            hr_pay_components::Column::EffectiveFrom,
            Expr::value(pg_date(from)?),
        );
    }
    if has(input, "effectiveTo") {
        update = update.col_expr(
            hr_pay_components::Column::EffectiveTo,
            Expr::value(pg_date_opt(str_of(input, "effectiveTo"))?),
        );
    }
    update
        .col_expr(hr_pay_components::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_pay_components::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    let row = component_row(db, id, false)
        .await?
        .ok_or_else(|| HrError::internal("component vanished"))?;
    Ok(to_component_dto(&row))
}

/// `deleteComponent(db, id)`: the employee it belonged to.
pub(crate) async fn delete_component(db: &PgPool, id: &str) -> Result<String, HrError> {
    let row = require_component(db, id).await?;
    let at = utc_now();
    hr_pay_components::Entity::update_many()
        .col_expr(hr_pay_components::Column::DeletedAt, Expr::value(at))
        .col_expr(hr_pay_components::Column::UpdatedAt, Expr::value(at))
        .filter(hr_pay_components::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(s(&row, "employeeId").to_owned())
}

/// `listElections(db, employeeId)`.
pub(crate) async fn list_elections(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    require_employee(db, employee_id).await?;
    let rows = jsonb_rows(
        hr_tax_elections::Entity::find()
            .filter(hr_tax_elections::Column::EmployeeId.eq(employee_id))
            .order_by_desc(hr_tax_elections::Column::EffectiveFrom)
            .order_by_desc(hr_tax_elections::Column::CreatedAt)
            .all(&orm(db))
            .await?,
    )?;
    Ok(rows.iter().map(to_election_dto).collect())
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
        return Err(HrError::validation(
            "The loonheffingskorting is a Dutch election",
        ));
    }
    if kind != "nl_loonheffingskorting" && country != "US" {
        return Err(HrError::validation(
            "W-4 and state certificates are US elections",
        ));
    }
    let state = if kind == "us_state_certificate" {
        str_of(input, "state")
    } else {
        None
    };
    if let Some(state) = state.filter(|s| !s.is_empty())
        && state_module(Some(state)).is_some_and(|m| m.certificate.is_none())
    {
        return Err(HrError::validation(format!(
            "{state} has no withholding certificate"
        )));
    }
    let signature =
        weldsuite_kit::validation::js_trim(str_of(input, "signatureName").unwrap_or(""));
    if signature.is_empty() {
        return Err(HrError::validation("The signature name is required"));
    }
    let at = utc_now();
    let id = generate_id("hrte");
    let orm = orm(db);
    hr_tax_elections::Entity::insert(hr_tax_elections::ActiveModel {
        id: Set(id.clone()),
        employee_id: Set(employee_id.to_owned()),
        kind: Set(kind.to_owned()),
        state: Set(state.map(str::to_owned)),
        effective_from: Set(pg_date(str_of(input, "effectiveFrom").unwrap_or_default())?),
        data: Set(input["data"].clone()),
        signed_by: Set(Some(signed_by.to_owned())),
        signature_name: Set(Some(signature.to_owned())),
        signed_at: Set(Some(at)),
        source: Set(source.to_owned()),
        created_at: Set(at),
    })
    .exec_without_returning(&orm)
    .await?;
    let row = hr_tax_elections::Entity::find_by_id(id.as_str())
        .one(&orm)
        .await?
        .ok_or_else(|| crate::employees::no_row("hr_tax_elections"))?;
    Ok(to_election_dto(&jsonb_row(row)?))
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
    hr_employees::Entity::update_many()
        .col_expr(
            hr_employees::Column::SensitiveEncrypted,
            Expr::value(sealed),
        )
        .col_expr(hr_employees::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_employees::Column::Id.eq(id))
        .exec(&orm(db))
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
    let profile_employer = profile_employer_id(db, employee_id).await?;
    let country: Option<String> = match profile_employer {
        Some(employer_id) => find_employer_for_payroll(db, &employer_id, &Keyring::default())
            .await?
            .and_then(|employer| employer.row["country"].as_str().map(str::to_owned)),
        None => None,
    };
    let today = today_iso();
    let mut patch: Vec<(String, Value)> = vec![];
    let mut set = |key: &str, value: Value| patch.push((key.to_owned(), value));
    let blank = |v: &Value| {
        v.is_null()
            || v.as_str()
                .is_some_and(|s| weldsuite_kit::validation::js_trim(s).is_empty())
    };
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
        if let Some(r) = v.as_str()
            && !is_valid_routing_number(r)
        {
            return Err(HrError::validation(
                "The routing number is not valid (checksum)",
            ));
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
        let holder = v
            .as_str()
            .map(|h| weldsuite_kit::validation::js_trim(h).to_owned())
            .filter(|h| !h.is_empty());
        set(
            "bankAccountHolder",
            holder.map_or(Value::Null, Value::String),
        );
    }
    for key in [
        "homeAddress",
        "idDocumentType",
        "idDocumentNumber",
        "idDocumentExpiresOn",
    ] {
        if let Some(v) = input.get(key) {
            set(key, v.clone());
        }
    }
    if !self_service && let Some(v) = input.get("idVerifiedAt") {
        set("idVerifiedAt", v.clone());
    }
    let mut id_verification_cleared = false;
    if self_service {
        let current = load_one(db, employee_id, keyring).await?.sensitive;
        let identity_changed = IDENTITY_FIELDS.iter().any(|key| {
            patch.iter().any(|(k, v)| {
                k == key
                    && js_json(&current.get(*key).cloned().unwrap_or(Value::Null)) != js_json(v)
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
    Ok(PaymentDetailsResult {
        details,
        changed_fields: changed,
        bank_changed,
        id_verification_cleared,
    })
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
pub(crate) async fn my_payroll_details(
    db: &PgPool,
    employee_id: &str,
    keyring: &Keyring,
    today: &str,
) -> Result<Value, HrError> {
    let d = load_one(db, employee_id, keyring).await?;
    let on_payroll =
        d.profile.as_ref().is_some_and(|p| p["status"] != "ended") && d.employer.is_some();
    let country = if on_payroll {
        d.employer.as_ref().and_then(|e| e["country"].as_str())
    } else {
        None
    };
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
            let work_state = d
                .profile
                .as_ref()
                .and_then(|p| truthy_str(&p["us"], "workState"))
                .map(str::to_uppercase);
            if let Some(state) = &work_state
                && state_certificate_required(Some(state))
                && election_of(&d.elections, today, "us_state_certificate", Some(state)).is_none()
            {
                required.push(json!({ "kind": "us_state_certificate", "state": state, "certificate": state_certificate_definition(state) }));
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
            if truthy_str(address, "line1").is_none() || truthy_str(address, "postalCode").is_none()
            {
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
