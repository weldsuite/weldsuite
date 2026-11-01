//! Employees and the org chart (`routes/weldhr/employees.ts`,
//! `services/weldhr/employees.ts`); departments are in [`crate::departments`].
//!
//! The sensitive block (`sensitive_encrypted`) is sealed with the keyring
//! and only ever opened for `employees:sensitive` holders, every read audited.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{HR_CHECKLIST_CREATED, HR_EMPLOYEE_CREATED, HR_EMPLOYEE_DELETED, HR_EMPLOYEE_UPDATED};
use weldsuite_catalogs::permission_keys::{
    EMPLOYEES_CREATE, EMPLOYEES_DELETE, EMPLOYEES_READ, EMPLOYEES_SENSITIVE, EMPLOYEES_UPDATE,
};
use weldsuite_core_domain::custom_field_values as custom_fields;
use weldsuite_core_domain::js::Js;
use weldsuite_db::{PgPool, decrypt_field, encrypt_field, js_row};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::fields::{Fields, field_json, id, iso_date, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, assert_date_order, company_names, hr_json, js_number,
    now, text, today_iso, zod_query,
};

/// `custom_field_definitions.entity_type` for employees.
const EMPLOYEE_CUSTOM_FIELD_ENTITY: &str = "employee";
/// Member types that can be an employee.
const EMPLOYABLE_MEMBER_TYPES: [&str; 2] = ["INTERNAL", "EMPLOYEE"];

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([EMPLOYEES_READ]);
    let sensitive = || gate.require([EMPLOYEES_SENSITIVE]);
    Router::new()
        .route("/employees", get(list_route).route_layer(read()))
        .route(
            "/employees/available-members",
            get(available_members_route).route_layer(gate.require([EMPLOYEES_CREATE, EMPLOYEES_UPDATE])),
        )
        .route("/employees/{id}", get(detail_route).route_layer(read()))
        .route("/employees", post(create_route).route_layer(gate.require([EMPLOYEES_CREATE])))
        .route(
            "/employees/from-member",
            post(from_member_route).route_layer(gate.require([EMPLOYEES_CREATE])),
        )
        .route("/employees/{id}", patch(update_route).route_layer(gate.require([EMPLOYEES_UPDATE])))
        .route("/employees/{id}", delete(delete_route).route_layer(gate.require([EMPLOYEES_DELETE])))
        .route("/employees/{id}/sensitive", get(read_sensitive_route).route_layer(sensitive()))
        .route("/employees/{id}/sensitive", put(write_sensitive_route).route_layer(sensitive()))
        .route("/org-chart", get(org_chart_route).route_layer(read()))
        .merge(crate::departments::routes(gate))
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/// `displayNameOf(e)`: the preferred name (trimmed) or the first name, then
/// the last name, trimmed.
pub(crate) fn display_name_of(row: &Value) -> String {
    let preferred = row["preferredName"].as_str().map(str::trim).unwrap_or_default();
    let first = if preferred.is_empty() {
        text(row, "firstName")
    } else {
        preferred
    };
    format!("{first} {}", text(row, "lastName")).trim().to_owned()
}

/// `toPublicEmployee(row)`: the row without `sensitiveEncrypted`, with
/// `hasSensitive` and `displayName`.
pub(crate) fn to_public_employee(row: &Value) -> Value {
    let mut out = row.clone();
    let has_sensitive = match out
        .as_object_mut()
        .and_then(|map| map.remove("sensitiveEncrypted"))
    {
        Some(Value::String(sealed)) => !sealed.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    };
    let display_name = display_name_of(row);
    if let Some(map) = out.as_object_mut() {
        map.insert("hasSensitive".to_owned(), Value::Bool(has_sensitive));
        map.insert("displayName".to_owned(), Value::String(display_name));
    }
    out
}

/// `requireEmployee(db, id)`: the live employee row, or `Employee` 404.
pub(crate) async fn require_employee(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_employees t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Employee", id))
}

/// `existingEmployeeIds(db, ids)`: the live employees among `ids`.
pub(crate) async fn existing_employee_ids(
    db: &PgPool,
    ids: &[String],
) -> Result<HashSet<String>, HrError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "select id from hr_employees where id = any($1) and deleted_at is null",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// `activeClientsFor(db, employeeIds, on = todayIso())`: each employee's
/// assignments running on `on`, `{ companyId, companyName, isPrimary }`,
/// primary first (a stable sort, as `Array#sort`).
pub(crate) async fn active_clients_for(
    db: &PgPool,
    employee_ids: &[String],
    on: Option<&str>,
) -> Result<HashMap<String, Vec<Value>>, HrError> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let on = on.map_or_else(today_iso, str::to_owned);
    let rows: Vec<(String, String, bool)> = sqlx::query_as(
        "select employee_id, company_id, is_primary from hr_client_assignments
         where employee_id = any($1) and start_date <= $2::date
           and (end_date is null or end_date >= $2::date)",
    )
    .bind(employee_ids)
    .bind(&on)
    .fetch_all(db)
    .await?;
    let company_ids: Vec<Option<&str>> = rows.iter().map(|row| Some(row.1.as_str())).collect();
    let names = company_names(db, &company_ids).await?;
    for (employee_id, company_id, is_primary) in &rows {
        out.entry(employee_id.clone()).or_default().push(json!({
            "companyId": company_id,
            "companyName": names.get(company_id),
            "isPrimary": is_primary,
        }));
    }
    for list in out.values_mut() {
        list.sort_by_key(|client| client["isPrimary"] != true);
    }
    Ok(out)
}

/// `employeeForUser(db, userId)`: the caller's own employee, or `None` when
/// none is linked, it is deleted or terminated.
pub(crate) async fn employee_for_user(db: &PgPool, user_id: &str) -> Result<Option<Value>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_employees t where t.user_id = $1 and t.deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row
        .map(js_row)
        .filter(|row| row["status"] != "terminated"))
}

/// `decorate(db, rows)`: custom fields hydrated, department and manager
/// names, and the client accounts each one works on today.
async fn decorate(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, HrError> {
    let rows = custom_fields::hydrate(db, EMPLOYEE_CUSTOM_FIELD_ENTITY, rows, None).await?;
    let unique = |key: &str| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for row in &rows {
            if let Some(value) = row[key].as_str().filter(|v| !v.is_empty())
                && !out.iter().any(|known| known == value)
            {
                out.push(value.to_owned());
            }
        }
        out
    };
    let department_ids = unique("departmentId");
    let manager_ids = unique("managerId");
    let departments: Vec<(String, String)> = if department_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, name from hr_departments where id = any($1)")
            .bind(&department_ids)
            .fetch_all(db)
            .await?
    };
    let managers: Vec<Value> = if manager_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            "select jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
                 'preferredName', preferred_name)
             from hr_employees where id = any($1)",
        )
        .bind(&manager_ids)
        .fetch_all(db)
        .await?
    };
    let ids: Vec<String> = rows.iter().map(|row| text(row, "id").to_owned()).collect();
    let clients = active_clients_for(db, &ids, None).await?;
    let department_name: HashMap<String, String> = departments.into_iter().collect();
    let manager_name: HashMap<String, String> = managers
        .iter()
        .map(|m| (text(m, "id").to_owned(), display_name_of(m)))
        .collect();
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut out = to_public_employee(&row);
            let department = row["departmentId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .and_then(|id| department_name.get(id).cloned());
            let manager = row["managerId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .and_then(|id| manager_name.get(id).cloned());
            let client_list = clients.get(text(&row, "id")).cloned().unwrap_or_default();
            if let Some(map) = out.as_object_mut() {
                map.insert("departmentName".to_owned(), json!(department));
                map.insert("managerName".to_owned(), json!(manager));
                map.insert("clients".to_owned(), Value::Array(client_list));
            }
            out
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/// `term.replace(/[%_]/g, '\\$&')` (listEmployees escapes only these two).
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `escapeLikeTerm(term)`: `\`, `%` and `_` escaped.
fn escape_like_term(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `listEmployees(db, filters)`: by last name, first name, id; the cursor
/// is the last row's id.
async fn list_employees(db: &PgPool, filters: &Map<String, Value>) -> Result<(Vec<Value>, i64, bool, Option<String>), HrError> {
    let get = |key: &str| filters.get(key).and_then(Value::as_str).map(str::to_owned);
    #[allow(clippy::cast_possible_truncation)]
    let limit = filters
        .get("limit")
        .and_then(Value::as_f64)
        .map_or(50, |limit| limit as i64)
        .min(200);
    let search = get("search")
        .map(|s| crate::js_trim(&s).to_owned())
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", escape_like(&s)));
    let statuses: Option<Vec<String>> = get("status")
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.split(',')
                .map(|part| crate::js_trim(part).to_owned())
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty());
    let department = get("departmentId").filter(|s| !s.is_empty());
    let manager = get("managerId").filter(|s| !s.is_empty());
    let company = get("companyId").filter(|s| !s.is_empty());
    let today = today_iso();
    let cursor_row: Option<(String, String, String)> = match get("cursor").filter(|s| !s.is_empty()) {
        Some(cursor) => sqlx::query_as(
            "select last_name, first_name, id from hr_employees where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(db)
        .await?,
        None => None,
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_employees t
         where t.deleted_at is null
           and ($1::text is null or t.first_name ilike $1 or t.last_name ilike $1
                or t.preferred_name ilike $1 or t.email ilike $1 or t.employee_number ilike $1
                or t.job_title ilike $1)
           and ($2::text[] is null or t.status = any($2))
           and ($3::text is null or t.department_id = $3)
           and ($4::text is null or t.manager_id = $4)
           and ($5::text is null or t.id in (select a.employee_id from hr_client_assignments a
                where a.company_id = $5 and a.start_date <= $6::date
                  and (a.end_date is null or a.end_date >= $6::date)))
           and ($7::text is null or (t.last_name, t.first_name, t.id) > ($7, $8, $9))
         order by t.last_name asc, t.first_name asc, t.id asc
         limit $10",
    )
    .bind(&search)
    .bind(&statuses)
    .bind(&department)
    .bind(&manager)
    .bind(&company)
    .bind(&today)
    .bind(cursor_row.as_ref().map(|c| c.0.clone()))
    .bind(cursor_row.as_ref().map(|c| c.1.clone()))
    .bind(cursor_row.as_ref().map(|c| c.2.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from hr_employees t
         where t.deleted_at is null
           and ($1::text is null or t.first_name ilike $1 or t.last_name ilike $1
                or t.preferred_name ilike $1 or t.email ilike $1 or t.employee_number ilike $1
                or t.job_title ilike $1)
           and ($2::text[] is null or t.status = any($2))
           and ($3::text is null or t.department_id = $3)
           and ($4::text is null or t.manager_id = $4)
           and ($5::text is null or t.id in (select a.employee_id from hr_client_assignments a
                where a.company_id = $5 and a.start_date <= $6::date
                  and (a.end_date is null or a.end_date >= $6::date)))",
    )
    .bind(&search)
    .bind(&statuses)
    .bind(&department)
    .bind(&manager)
    .bind(&company)
    .bind(&today)
    .fetch_one(db)
    .await?;
    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    let limit = usize::try_from(limit).unwrap_or(50);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last().map(|row| text(row, "id").to_owned())
    } else {
        None
    };
    Ok((decorate(db, rows).await?, total, has_more, cursor))
}

async fn list_route(State(state): State<HrState>, caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let filters = zod_query(query.as_deref(), |issues, q| {
        let mut out = Map::new();
        let mut keep = |key: &str, field: Field<String>| {
            if let Field::Set(value) = field {
                out.insert(key.to_owned(), Value::String(value));
            }
        };
        keep("search", issues.text(q, "search", Presence::Optional, None, Some(200)));
        keep("status", issues.text(q, "status", Presence::Optional, None, Some(200)));
        keep("departmentId", id(issues, q, "departmentId", Presence::Optional));
        keep("managerId", id(issues, q, "managerId", Presence::Optional));
        keep("companyId", id(issues, q, "companyId", Presence::Optional));
        let limit = issues.number(
            q,
            "limit",
            Presence::Optional,
            Number { coerce: true, int: true, min: Some(1.0), max: Some(200.0) },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, Some(60));
        if let Field::Set(limit) = limit {
            out.insert("limit".to_owned(), json!(limit));
        }
        if let Field::Set(cursor) = cursor {
            out.insert("cursor".to_owned(), Value::String(cursor));
        }
        out
    })?;
    link_invited_employees(&state, &caller, None, None).await?;
    let (data, total, has_more, cursor) = list_employees(&caller.db, &filters).await?;
    Ok(List::new(
        data,
        Pagination::new(u64::try_from(total).unwrap_or_default(), has_more, cursor),
    )
    .into_response())
}

/// `getEmployeeDetail(db, id)`: the decorated employee with direct reports.
async fn employee_detail(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = require_employee(db, id).await?;
    let mut decorated = decorate(db, vec![row]).await?.pop().unwrap_or(Value::Null);
    let reports: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
             'preferredName', preferred_name, 'jobTitle', job_title, 'avatarUrl', avatar_url, 'status', status)
         from hr_employees where manager_id = $1 and deleted_at is null
         order by last_name asc, first_name asc",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let reports: Vec<Value> = reports
        .into_iter()
        .map(|mut report| {
            let name = display_name_of(&report);
            if let Some(map) = report.as_object_mut() {
                map.insert("displayName".to_owned(), Value::String(name));
            }
            report
        })
        .collect();
    if let Some(map) = decorated.as_object_mut() {
        map.insert("directReports".to_owned(), Value::Array(reports));
    }
    Ok(decorated)
}

async fn detail_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    link_invited_employees(&state, &caller, None, Some(&id)).await?;
    Ok(Data(employee_detail(&caller.db, &id).await?).into_response())
}

async fn org_chart_route(caller: Caller) -> HrResult {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
             'preferredName', preferred_name, 'jobTitle', job_title, 'avatarUrl', avatar_url,
             'managerId', manager_id, 'departmentId', department_id, 'status', status)
         from hr_employees where deleted_at is null and status <> 'terminated'
         order by last_name asc, first_name asc",
    )
    .fetch_all(&caller.db)
    .await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let name = display_name_of(&row);
            if let Some(map) = row.as_object_mut() {
                map.insert("displayName".to_owned(), Value::String(name));
            }
            row
        })
        .collect();
    Ok(Data(rows).into_response())
}

async fn available_members_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let (search, limit) = zod_query(query.as_deref(), |issues, q| {
        (
            issues.text(q, "search", Presence::Optional, None, Some(200)),
            issues.number(
                q,
                "limit",
                Presence::Optional,
                Number { coerce: true, int: true, min: Some(1.0), max: Some(200.0) },
            ),
        )
    })?;
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.as_set().map_or(100, |limit| *limit as i64).min(200);
    let search = search
        .into_option()
        .map(|s| crate::js_trim(&s).to_owned())
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", escape_like_term(&s)));
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('userId', m.user_id, 'name', m.name, 'email', m.email,
             'picture', m.picture, 'title', m.title, 'phone', m.phone,
             'memberType', case when m.member_type = 'EMPLOYEE' then 'EMPLOYEE' else 'INTERNAL' end)
         from workspace_members m
         where m.deleted_at is null and m.status = 'ACTIVE' and m.member_type = any($1)
           and m.user_id not like 'invited\\_%'
           and not exists (select 1 from hr_employees t where t.user_id = m.user_id and t.deleted_at is null)
           and ($2::text is null or m.name ilike $2 or m.email ilike $2)
         order by m.name asc, m.email asc
         limit $3",
    )
    .bind(EMPLOYABLE_MEMBER_TYPES.map(str::to_owned).to_vec())
    .bind(search)
    .bind(limit)
    .fetch_all(&caller.db)
    .await?;
    Ok(Data(rows).into_response())
}

/// `linkAcceptedInvites(db, scope)`, then what `linkInvitedEmployees` does
/// for each link: an `hr_employee` update and an `employee.linked` audit.
pub(crate) async fn link_invited_employees(
    state: &HrState,
    caller: &Caller,
    user_id: Option<&str>,
    employee_id: Option<&str>,
) -> Result<Vec<(String, String)>, HrError> {
    let candidates: Vec<(String, String)> = sqlx::query_as(
        "select t.id, m.user_id from hr_employees t
         join workspace_members m on lower(m.email) = lower(t.email)
         where t.user_id is null and t.deleted_at is null and m.deleted_at is null
           and m.status = 'ACTIVE' and m.member_type = any($1)
           and m.user_id not like 'invited\\_%' and m.user_id not like 'pending\\_clerk\\_%'
           and not exists (select 1 from hr_employees linked where linked.user_id = m.user_id
                           and linked.deleted_at is null)
           and ($2::text is null or m.user_id = $2)
           and ($3::text is null or t.id = $3)
         limit 50",
    )
    .bind(EMPLOYABLE_MEMBER_TYPES.map(str::to_owned).to_vec())
    .bind(user_id)
    .bind(employee_id)
    .fetch_all(&caller.db)
    .await?;
    let mut linked = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    for (candidate_employee, candidate_user) in candidates {
        if taken.contains(&candidate_user) {
            continue;
        }
        let row: Option<String> = sqlx::query_scalar(
            "update hr_employees set user_id = $2, updated_at = $3::timestamp
             where id = $1 and user_id is null returning id",
        )
        .bind(&candidate_employee)
        .bind(&candidate_user)
        .bind(now())
        .fetch_optional(&caller.db)
        .await?;
        if row.is_none() {
            continue;
        }
        taken.insert(candidate_user.clone());
        linked.push((candidate_employee, candidate_user));
    }
    for (employee, user) in &linked {
        caller.emit(state, HR_EMPLOYEE_UPDATED, employee, &[]);
        caller
            .audit(
                "employee.linked",
                Some(employee),
                json!({ "userId": user, "via": "invite_accepted" }),
            )
            .await?;
    }
    Ok(linked)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// The schema fields of an employee write, in `createHrEmployeeSchema`'s
/// order (the column each lands in).
const WRITE_KEYS: [(&str, &str); 22] = [
    ("employeeNumber", "employee_number"),
    ("firstName", "first_name"),
    ("lastName", "last_name"),
    ("preferredName", "preferred_name"),
    ("email", "email"),
    ("phone", "phone"),
    ("avatarUrl", "avatar_url"),
    ("pronouns", "pronouns"),
    ("jobTitle", "job_title"),
    ("departmentId", "department_id"),
    ("managerId", "manager_id"),
    ("userId", "user_id"),
    ("employmentType", "employment_type"),
    ("status", "status"),
    ("startDate", "start_date"),
    ("endDate", "end_date"),
    ("probationEndDate", "probation_end_date"),
    ("location", "location"),
    ("timezone", "timezone"),
    ("weeklyHours", "weekly_hours"),
    ("workLocationIds", "work_location_ids"),
    ("customFields", "custom_fields"),
];

/// A validated employee body: the write fields present (camelCase keys, in
/// schema order), the sensitive block and the onboarding template.
struct EmployeeBody {
    input: Vec<(&'static str, Value)>,
    sensitive: Option<Vec<(&'static str, Value)>>,
    onboarding_template_id: Option<String>,
}

impl EmployeeBody {
    fn get(&self, key: &str) -> Option<&Value> {
        self.input.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    fn text(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }
}

/// Which variant of the employee schema a body is read with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Schema {
    /// `createHrEmployeeSchema`.
    Create,
    /// `updateHrEmployeeSchema`: partial, no `onboardingTemplateId`.
    Update,
    /// `createHrEmployeeFromMemberSchema`: partial without `userId`, then a
    /// required `userId` at the end.
    FromMember,
}

const EMPLOYMENT_TYPES: [&str; 5] = ["full_time", "part_time", "contractor", "intern", "temporary"];
const STATUSES: [&str; 5] = ["onboarding", "active", "on_leave", "offboarding", "terminated"];
const SALARY_PERIODS: [&str; 3] = ["hour", "month", "year"];

/// `hrEmployeeSensitiveSchema`: the fields present, in schema order.
fn sensitive_fields(issues: &mut Issues, fields: &Fields) -> Vec<(&'static str, Value)> {
    let mut out: Vec<(&'static str, Value)> = Vec::new();
    let mut keep = |key: &'static str, value: Option<Value>| {
        if let Some(value) = value {
            out.push((key, value));
        }
    };
    keep("dateOfBirth", field_json(&iso_date(issues, fields, "dateOfBirth", Presence::Nullish)));
    keep("nationalId", field_json(&short_text(issues, fields, "nationalId", Presence::Nullish, 100, false)));
    keep("taxId", field_json(&short_text(issues, fields, "taxId", Presence::Nullish, 100, false)));
    keep("address", field_json(&text_max(issues, fields, "address", Presence::Nullish, 1000)));
    keep(
        "personalEmail",
        field_json(&issues.text_with(
            fields,
            "personalEmail",
            Presence::Nullish,
            Text { format: Some(Format::Email), max: Some(255), ..Text::default() },
        )),
    );
    keep("personalPhone", field_json(&short_text(issues, fields, "personalPhone", Presence::Nullish, 50, false)));
    keep(
        "emergencyContactName",
        field_json(&short_text(issues, fields, "emergencyContactName", Presence::Nullish, 255, false)),
    );
    keep(
        "emergencyContactPhone",
        field_json(&short_text(issues, fields, "emergencyContactPhone", Presence::Nullish, 50, false)),
    );
    keep(
        "emergencyContactRelation",
        field_json(&short_text(issues, fields, "emergencyContactRelation", Presence::Nullish, 100, false)),
    );
    keep("bankAccount", field_json(&short_text(issues, fields, "bankAccount", Presence::Nullish, 100, false)));
    let salary = crate::fields::number(issues, fields, "salaryAmount", Presence::Nullish, Some(0.0), None);
    keep("salaryAmount", match salary {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(amount) => Some(js_number(amount)),
    });
    let currency = issues.text(fields, "salaryCurrency", Presence::Nullish, None, None);
    let currency = match currency {
        Field::Set(code) => {
            let length = code.encode_utf16().count();
            if length == 3 {
                Field::Set(code)
            } else {
                issues.string_length("salaryCurrency", 3, length);
                Field::Absent
            }
        }
        other => other,
    };
    keep("salaryCurrency", field_json(&currency));
    keep("salaryPeriod", field_json(&issues.choice(fields, "salaryPeriod", Presence::Nullish, &SALARY_PERIODS)));
    keep("notes", field_json(&text_max(issues, fields, "notes", Presence::Nullish, 5000)));
    out
}

fn employee_body(issues: &mut Issues, fields: &Fields, schema: Schema) -> EmployeeBody {
    let partial = schema != Schema::Create;
    let required = |p: bool| if p { Presence::Optional } else { Presence::Required };
    let mut input: Vec<(&'static str, Value)> = Vec::new();
    let mut keep = |key: &'static str, value: Option<Value>| {
        if let Some(value) = value {
            input.push((key, value));
        }
    };
    keep("employeeNumber", field_json(&short_text(issues, fields, "employeeNumber", Presence::Nullish, 50, false)));
    keep("firstName", field_json(&short_text(issues, fields, "firstName", required(partial), 120, true)));
    keep("lastName", field_json(&short_text(issues, fields, "lastName", required(partial), 120, true)));
    keep("preferredName", field_json(&short_text(issues, fields, "preferredName", Presence::Nullish, 120, false)));
    keep(
        "email",
        field_json(&issues.text_with(
            fields,
            "email",
            required(partial),
            Text { trim: true, format: Some(Format::Email), max: Some(255), ..Text::default() },
        )),
    );
    keep("phone", field_json(&short_text(issues, fields, "phone", Presence::Nullish, 50, false)));
    keep(
        "avatarUrl",
        field_json(&issues.text_with(
            fields,
            "avatarUrl",
            Presence::Nullish,
            Text { format: Some(Format::Url), max: Some(500), ..Text::default() },
        )),
    );
    keep("pronouns", field_json(&short_text(issues, fields, "pronouns", Presence::Nullish, 40, false)));
    keep("jobTitle", field_json(&short_text(issues, fields, "jobTitle", Presence::Nullish, 160, false)));
    keep("departmentId", field_json(&id(issues, fields, "departmentId", Presence::Nullish)));
    keep("managerId", field_json(&id(issues, fields, "managerId", Presence::Nullish)));
    if schema != Schema::FromMember {
        keep(
            "userId",
            field_json(&issues.text_with(fields, "userId", Presence::Optional, Text::trimmed(Some(1), Some(255)))),
        );
    }
    keep("employmentType", field_json(&issues.choice(fields, "employmentType", Presence::Optional, &EMPLOYMENT_TYPES)));
    keep("status", field_json(&issues.choice(fields, "status", Presence::Optional, &STATUSES)));
    keep("startDate", field_json(&iso_date(issues, fields, "startDate", Presence::Nullish)));
    keep("endDate", field_json(&iso_date(issues, fields, "endDate", Presence::Nullish)));
    keep("probationEndDate", field_json(&iso_date(issues, fields, "probationEndDate", Presence::Nullish)));
    keep("location", field_json(&short_text(issues, fields, "location", Presence::Nullish, 160, false)));
    keep("timezone", field_json(&short_text(issues, fields, "timezone", Presence::Nullish, 60, false)));
    let hours = crate::fields::number(issues, fields, "weeklyHours", Presence::Nullish, Some(0.0), Some(168.0));
    keep("weeklyHours", match hours {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(h) => Some(js_number(h)),
    });
    let locations = issues.list(fields, "workLocationIds", Presence::Nullish, None, Some(50), |issues, item| {
        issues.item_text(item, Text::length(Some(1), Some(30)))
    });
    keep("workLocationIds", field_json(&locations));
    let custom = match fields.get("customFields") {
        None => None,
        Some(Value::Object(map)) => Some(Value::Object(map.clone())),
        Some(other) => {
            let path = issues.path_of("customFields");
            let received = match other {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
            };
            issues.push_issue(
                "customFields",
                json!({
                    "code": "invalid_type",
                    "expected": "object",
                    "received": received,
                    "message": format!("Expected object, received {received}"),
                    "path": path,
                }),
            );
            None
        }
    };
    keep("customFields", custom);
    let sensitive = issues
        .nested(fields, "sensitive", Presence::Optional, sensitive_fields)
        .into_option();
    let onboarding = if schema == Schema::Create {
        id(issues, fields, "onboardingTemplateId", Presence::Optional).into_option()
    } else {
        None
    };
    if schema == Schema::FromMember {
        keep(
            "userId",
            field_json(&issues.text_with(fields, "userId", Presence::Required, Text::trimmed(Some(1), Some(255)))),
        );
    }
    EmployeeBody {
        input,
        sensitive,
        onboarding_template_id: onboarding,
    }
}

/// `assertEmailFree(db, email, exceptId?)`.
async fn assert_email_free(db: &PgPool, email: &str, except_id: Option<&str>) -> Result<(), HrError> {
    let dupe: Option<String> = sqlx::query_scalar(
        "select id from hr_employees where lower(email) = $1 and deleted_at is null limit 1",
    )
    .bind(email.to_lowercase())
    .fetch_optional(db)
    .await?;
    if dupe.is_some_and(|dupe| Some(dupe.as_str()) != except_id) {
        return Err(HrError::conflict("Another employee already uses this email address"));
    }
    Ok(())
}

/// `assertUserIdFree(db, userId, exceptId?)`.
async fn assert_user_id_free(db: &PgPool, user_id: Option<&str>, except_id: Option<&str>) -> Result<(), HrError> {
    let Some(user_id) = user_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let dupe: Option<String> = sqlx::query_scalar(
        "select id from hr_employees where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if dupe.is_some_and(|dupe| Some(dupe.as_str()) != except_id) {
        return Err(HrError::conflict(
            "Another employee is already linked to this workspace member",
        ));
    }
    Ok(())
}

/// `requireActiveWorkspaceMember(db, userId)`.
async fn require_active_workspace_member(db: &PgPool, user_id: &str) -> Result<Value, HrError> {
    if user_id.is_empty() || user_id.starts_with("invited_") {
        return Err(HrError::validation("That is not an active workspace member"));
    }
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from workspace_members m where m.user_id = $1 and m.deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(js_row) else {
        return Err(HrError::not_found("Workspace member", user_id));
    };
    if row["status"] != "ACTIVE" {
        return Err(HrError::validation(
            "Only active workspace members can be linked to an employee",
        ));
    }
    if !EMPLOYABLE_MEMBER_TYPES.contains(&text(&row, "memberType")) {
        return Err(HrError::validation("External guests cannot be employees"));
    }
    Ok(row)
}

/// `isPlaceholderUserId(userId)`.
fn is_placeholder_user_id(user_id: &str) -> bool {
    user_id.starts_with("invited_") || user_id.starts_with("pending_clerk_")
}

/// `memberForNewEmployee(db, email)`: an active member with that email, or
/// `None` for someone whose invite is pending.
async fn member_for_new_employee(db: &PgPool, email: &str) -> Result<Option<String>, HrError> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select user_id, status, member_type from workspace_members
         where lower(email) = $1 and deleted_at is null",
    )
    .bind(crate::js_trim(email).to_lowercase())
    .fetch_all(db)
    .await?;
    let member = rows
        .iter()
        .find(|(user, status, _)| status == "ACTIVE" && !is_placeholder_user_id(user))
        .or_else(|| rows.iter().find(|(_, status, _)| status == "PENDING"));
    let Some((user, status, member_type)) = member else {
        return Err(HrError::validation(
            "An employee must be a member of this workspace. Invite them first.",
        ));
    };
    if !EMPLOYABLE_MEMBER_TYPES.contains(&member_type.as_str()) {
        return Err(HrError::validation("External guests cannot be employees"));
    }
    Ok((status == "ACTIVE").then(|| user.clone()))
}

/// `assertManager(db, managerId, selfId?)`.
async fn assert_manager(db: &PgPool, manager_id: Option<&str>, self_id: Option<&str>) -> Result<(), HrError> {
    let Some(manager_id) = manager_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if Some(manager_id) == self_id {
        return Err(HrError::validation("An employee cannot be their own manager"));
    }
    require_employee(db, manager_id).await?;
    let Some(self_id) = self_id else {
        return Ok(());
    };
    let mut cursor: Option<String> = Some(manager_id.to_owned());
    let mut depth = 0;
    while let Some(current) = cursor.filter(|_| depth < 50) {
        if current == self_id {
            return Err(HrError::validation("That manager reports to this employee"));
        }
        let next: Option<Option<String>> =
            sqlx::query_scalar("select manager_id from hr_employees where id = $1 limit 1")
                .bind(&current)
                .fetch_optional(db)
                .await?;
        cursor = next.flatten().filter(|id| !id.is_empty());
        depth += 1;
    }
    Ok(())
}

/// `prepareCustomFields(db, customFields)`: check the values against the
/// employee definitions before anything is written.
async fn prepare_custom_fields(db: &PgPool, values: Option<&Value>) -> Result<bool, HrError> {
    let Some(values) = values else {
        return Ok(false);
    };
    let definitions = custom_fields::definitions(db, EMPLOYEE_CUSTOM_FIELD_ENTITY).await?;
    if let Value::Object(values) = values {
        for definition in &definitions {
            let Some(raw) = values.get(&definition.slug) else {
                continue;
            };
            let raw = Js::from_jsonb(raw);
            if Js::is_empty_value(Some(&raw)) {
                continue;
            }
            if let Err(message) = custom_fields::coerce(definition, &raw) {
                return Err(HrError::validation(message));
            }
        }
    }
    Ok(true)
}

/// The sealed sensitive block (`encryptSensitive`).
pub(crate) fn encrypt_sensitive(value: &Value, keyring: &weldsuite_db::Keyring) -> Result<String, HrError> {
    if keyring.is_empty() {
        return Err(HrError::validation(
            "Sensitive employee data cannot be stored: the worker has no encryption key",
        ));
    }
    encrypt_field(&value.to_string(), keyring).map_err(|error| HrError::internal(error.to_string()))
}

/// The sensitive fields as the object `JSON.stringify` writes.
fn sensitive_object(fields: &[(&'static str, Value)]) -> Value {
    Value::Object(fields.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

/// `createEmployee(db, input, opts)`.
async fn create_employee(
    caller: &Caller,
    input: &[(&'static str, Value)],
    sensitive: Option<&[(&'static str, Value)]>,
) -> Result<Value, HrError> {
    let db = &caller.db;
    let get = |key: &str| input.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    let get_text = |key: &str| get(key).and_then(Value::as_str);
    assert_date_order(get_text("startDate"), get_text("endDate"), "Employment")?;
    let email = get_text("email").unwrap_or_default().to_owned();
    assert_email_free(db, &email, None).await?;
    let user_id = match get_text("userId").filter(|id| !id.is_empty()) {
        Some(user) => Some(user.to_owned()),
        None => member_for_new_employee(db, &email).await?,
    };
    if let Some(user) = &user_id {
        require_active_workspace_member(db, user).await?;
        assert_user_id_free(db, Some(user), None).await?;
    }
    assert_manager(db, get_text("managerId"), None).await?;
    let locations = location_ids(get("workLocationIds"));
    crate::work_locations::assert_work_locations(db, locations.as_deref()).await?;
    let custom = get("customFields");
    let has_custom = prepare_custom_fields(db, custom).await?;
    let id = generate_id("hremp");
    let sealed = match sensitive {
        Some(fields) => Some(encrypt_sensitive(&sensitive_object(fields), &caller.keyring())?),
        None => None,
    };
    let mut record = Map::new();
    for (key, column) in WRITE_KEYS {
        if let Some(value) = get(key) {
            record.insert(column.to_owned(), value.clone());
        }
    }
    record.insert("id".to_owned(), json!(id));
    record.insert("user_id".to_owned(), json!(user_id));
    record.insert("email".to_owned(), json!(crate::js_trim(&email)));
    record
        .entry("employment_type".to_owned())
        .or_insert_with(|| json!("full_time"));
    record.entry("status".to_owned()).or_insert_with(|| json!("onboarding"));
    record.insert("sensitive_encrypted".to_owned(), json!(sealed));
    record.insert("created_by".to_owned(), json!(caller.user_id));
    let row: Value = sqlx::query_scalar(
        "insert into hr_employees as t (id, employee_number, first_name, last_name, preferred_name, email,
             phone, avatar_url, pronouns, job_title, department_id, manager_id, user_id, employment_type,
             status, start_date, end_date, probation_end_date, location, timezone, weekly_hours,
             work_location_ids, sensitive_encrypted, custom_fields, created_by)
         select r.id, r.employee_number, r.first_name, r.last_name, r.preferred_name, r.email,
             r.phone, r.avatar_url, r.pronouns, r.job_title, r.department_id, r.manager_id, r.user_id,
             r.employment_type, r.status, r.start_date, r.end_date, r.probation_end_date, r.location,
             r.timezone, r.weekly_hours, r.work_location_ids, r.sensitive_encrypted, r.custom_fields,
             r.created_by
         from jsonb_populate_record(null::hr_employees, $1) r
         returning to_jsonb(t)",
    )
    .bind(Value::Object(record))
    .fetch_one(db)
    .await?;
    if has_custom {
        custom_fields::sync_values_for_entity(db, EMPLOYEE_CUSTOM_FIELD_ENTITY, &id, custom).await;
    }
    Ok(js_row(row))
}

fn location_ids(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|ids| {
        ids.iter()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect()
    })
}

/// `splitMemberName(name)`.
fn split_member_name(name: Option<&str>) -> (String, String) {
    let parts: Vec<&str> = name.unwrap_or_default().split_whitespace().collect();
    match parts.as_slice() {
        [] => ("Unknown".to_owned(), "Member".to_owned()),
        [one] => ((*one).to_owned(), (*one).to_owned()),
        [first, rest @ ..] => ((*first).to_owned(), rest.join(" ")),
    }
}

/// The route's work after creating: audit the sensitive block, publish, and
/// start the onboarding template.
async fn after_create(
    state: &HrState,
    caller: &Caller,
    employee: &Value,
    body: &EmployeeBody,
) -> HrResult {
    let employee_id = text(employee, "id").to_owned();
    if let Some(sensitive) = &body.sensitive {
        let fields: Vec<&str> = sensitive.iter().map(|(k, _)| *k).collect();
        caller
            .audit("employee.sensitive_updated", Some(&employee_id), json!({ "fields": fields }))
            .await?;
    }
    caller.emit(
        state,
        HR_EMPLOYEE_CREATED,
        &employee_id,
        &[("status", Some(employee["status"].clone()))],
    );
    if let Some(template) = &body.onboarding_template_id {
        let checklist =
            crate::lifecycle::start_checklist(&caller.db, &employee_id, template, None, false, &caller.user_id)
                .await?;
        caller.emit(
            state,
            HR_CHECKLIST_CREATED,
            text(&checklist, "id"),
            &[
                ("employeeId", Some(json!(employee_id))),
                ("status", Some(checklist["status"].clone())),
            ],
        );
    }
    Ok(Created(to_public_employee(employee)).into_response())
}

async fn create_route(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let body = hr_json(&headers, &body, |issues, fields| employee_body(issues, fields, Schema::Create))?;
    if body.sensitive.is_some() && !caller.can(EMPLOYEES_SENSITIVE) {
        return Err(HrError::forbidden(
            "You do not have permission to set sensitive employee data",
        ));
    }
    let employee = create_employee(&caller, &body.input, body.sensitive.as_deref()).await?;
    after_create(&state, &caller, &employee, &body).await
}

async fn from_member_route(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let body = hr_json(&headers, &body, |issues, fields| employee_body(issues, fields, Schema::FromMember))?;
    if body.sensitive.is_some() && !caller.can(EMPLOYEES_SENSITIVE) {
        return Err(HrError::forbidden(
            "You do not have permission to set sensitive employee data",
        ));
    }
    let user_id = body.text("userId").unwrap_or_default().to_owned();
    let member = require_active_workspace_member(&caller.db, &user_id).await?;
    if member["email"].as_str().is_none_or(str::is_empty) && body.get("email").is_none() {
        return Err(HrError::validation("This workspace member has no email address"));
    }
    let (first, last) = split_member_name(member["name"].as_str());
    // `member.hoursPerWeek == null ? null : Number(member.hoursPerWeek)`.
    let member_hours = match &member["hoursPerWeek"] {
        Value::Number(hours) => js_number(hours.as_f64().unwrap_or(f64::NAN)),
        Value::String(hours) => js_number(crate::js_trim(hours).parse::<f64>().unwrap_or(f64::NAN)),
        _ => Value::Null,
    };
    // `{ ...input, firstName, lastName, email, phone, … }`: the member's
    // values fill what the body left out.
    let mut input: Vec<(&'static str, Value)> = body.input.clone();
    let mut set = |key: &'static str, value: Value| {
        if let Some(slot) = input.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            input.push((key, value));
        }
    };
    let trimmed_or = |key: &str, fallback: &str| -> Value {
        let given = body.text(key).map(crate::js_trim).filter(|v| !v.is_empty());
        json!(given.unwrap_or(fallback))
    };
    set("firstName", trimmed_or("firstName", &first));
    set("lastName", trimmed_or("lastName", &last));
    let email = body
        .text("email")
        .or_else(|| member["email"].as_str())
        .map(crate::js_trim)
        .unwrap_or_default()
        .to_owned();
    set("email", json!(email));
    let given_or = |key: &str, member_value: Value| body.get(key).cloned().unwrap_or(member_value);
    set("phone", given_or("phone", member["phone"].clone()));
    set("jobTitle", given_or("jobTitle", member["title"].clone()));
    set("avatarUrl", given_or("avatarUrl", member["picture"].clone()));
    set("pronouns", given_or("pronouns", member["pronouns"].clone()));
    set("location", given_or("location", member["location"].clone()));
    set("weeklyHours", given_or("weeklyHours", member_hours));
    set("userId", member["userId"].clone());
    let employee = create_employee(&caller, &input, body.sensitive.as_deref()).await?;
    after_create(&state, &caller, &employee, &body).await
}

async fn update_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let body = hr_json(&headers, &body, |issues, fields| employee_body(issues, fields, Schema::Update))?;
    if body.sensitive.is_some() {
        return Err(HrError::bad_request(
            "Update sensitive data through PUT /employees/:employeeId/sensitive",
        ));
    }
    let db = &caller.db;
    let existing = require_employee(db, &id).await?;
    let pick = |key: &str| -> Option<String> {
        match body.get(key) {
            Some(value) => value.as_str().map(str::to_owned),
            None => existing[key].as_str().map(str::to_owned),
        }
    };
    assert_date_order(pick("startDate").as_deref(), pick("endDate").as_deref(), "Employment")?;
    if let Some(email) = body.text("email").filter(|e| !e.is_empty())
        && email.to_lowercase() != text(&existing, "email").to_lowercase()
    {
        assert_email_free(db, email, Some(&id)).await?;
    }
    if let Some(manager) = body.get("managerId") {
        assert_manager(db, manager.as_str(), Some(&id)).await?;
    }
    if let Some(user) = body.get("userId")
        && user.as_str() != existing["userId"].as_str()
    {
        let user = user.as_str().unwrap_or_default();
        if user.is_empty() {
            return Err(HrError::validation(
                "An employee stays linked to a workspace member. Link a different member instead.",
            ));
        }
        require_active_workspace_member(db, user).await?;
        assert_user_id_free(db, Some(user), Some(&id)).await?;
    }
    let locations = location_ids(body.get("workLocationIds"));
    crate::work_locations::assert_work_locations(db, locations.as_deref()).await?;
    let custom = body.get("customFields");
    let has_custom = prepare_custom_fields(db, custom).await?;
    let mut record = Map::new();
    for (key, column) in WRITE_KEYS {
        if let Some(value) = body.get(key) {
            record.insert(column.to_owned(), value.clone());
        }
    }
    let row: Value = sqlx::query_scalar(
        "update hr_employees as t set
             employee_number = case when $1 ? 'employee_number' then r.employee_number else t.employee_number end,
             first_name = case when $1 ? 'first_name' then r.first_name else t.first_name end,
             last_name = case when $1 ? 'last_name' then r.last_name else t.last_name end,
             preferred_name = case when $1 ? 'preferred_name' then r.preferred_name else t.preferred_name end,
             email = case when $1 ? 'email' then r.email else t.email end,
             phone = case when $1 ? 'phone' then r.phone else t.phone end,
             avatar_url = case when $1 ? 'avatar_url' then r.avatar_url else t.avatar_url end,
             pronouns = case when $1 ? 'pronouns' then r.pronouns else t.pronouns end,
             job_title = case when $1 ? 'job_title' then r.job_title else t.job_title end,
             department_id = case when $1 ? 'department_id' then r.department_id else t.department_id end,
             manager_id = case when $1 ? 'manager_id' then r.manager_id else t.manager_id end,
             user_id = case when $1 ? 'user_id' then r.user_id else t.user_id end,
             employment_type = case when $1 ? 'employment_type' then r.employment_type else t.employment_type end,
             status = case when $1 ? 'status' then r.status else t.status end,
             start_date = case when $1 ? 'start_date' then r.start_date else t.start_date end,
             end_date = case when $1 ? 'end_date' then r.end_date else t.end_date end,
             probation_end_date = case when $1 ? 'probation_end_date' then r.probation_end_date else t.probation_end_date end,
             location = case when $1 ? 'location' then r.location else t.location end,
             timezone = case when $1 ? 'timezone' then r.timezone else t.timezone end,
             weekly_hours = case when $1 ? 'weekly_hours' then r.weekly_hours else t.weekly_hours end,
             work_location_ids = case when $1 ? 'work_location_ids' then r.work_location_ids else t.work_location_ids end,
             custom_fields = case when $1 ? 'custom_fields' then r.custom_fields else t.custom_fields end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_employees, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(Value::Object(record))
    .bind(&id)
    .bind(now())
    .fetch_one(db)
    .await?;
    if has_custom {
        custom_fields::sync_values_for_entity(db, EMPLOYEE_CUSTOM_FIELD_ENTITY, &id, custom).await;
    }
    let row = js_row(row);
    caller.emit(&state, HR_EMPLOYEE_UPDATED, text(&row, "id"), &[("status", Some(row["status"].clone()))]);
    Ok(Data(to_public_employee(&row)).into_response())
}

async fn delete_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    require_employee(&caller.db, &id).await?;
    sqlx::query("update hr_employees set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
    caller.audit("employee.deleted", Some(&id), json!({})).await?;
    caller.emit(&state, HR_EMPLOYEE_DELETED, &id, &[]);
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Sensitive block
// ---------------------------------------------------------------------------

/// `readSensitive(db, id, keyring)`: the opened block, `{}` without one.
pub(crate) async fn read_sensitive(db: &PgPool, id: &str, keyring: &weldsuite_db::Keyring) -> Result<Value, HrError> {
    let row = require_employee(db, id).await?;
    let Some(sealed) = row["sensitiveEncrypted"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(json!({}));
    };
    let plaintext = decrypt_field(sealed, keyring).map_err(|error| HrError::internal(error.to_string()))?;
    serde_json::from_str(&plaintext).map_err(|error| HrError::internal(error.to_string()))
}

async fn read_sensitive_route(caller: Caller, Path(id): Path<String>) -> HrResult {
    let value = read_sensitive(&caller.db, &id, &caller.keyring()).await?;
    caller.audit("employee.sensitive_viewed", Some(&id), json!({})).await?;
    Ok(Data(value).into_response())
}

/// `JSON.stringify` of a JSON value, numbers as JavaScript prints them.
fn js_json(value: &Value) -> String {
    weldsuite_core_domain::js::stringify(&Js::from_jsonb(value))
}

async fn write_sensitive_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let patch = hr_json(&headers, &body, sensitive_fields)?;
    let keyring = caller.keyring();
    let current = read_sensitive(&caller.db, &id, &keyring).await?;
    let mut next = current.as_object().cloned().unwrap_or_default();
    let mut changed: Vec<&str> = Vec::new();
    for (key, value) in &patch {
        let before = current.get(*key).cloned().unwrap_or(Value::Null);
        if js_json(&before) != js_json(value) {
            changed.push(key);
        }
        next.insert((*key).to_owned(), value.clone());
    }
    if !changed.is_empty() {
        let sealed = encrypt_sensitive(&Value::Object(next), &keyring)?;
        sqlx::query("update hr_employees set sensitive_encrypted = $2, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(sealed)
            .bind(now())
            .execute(&caller.db)
            .await?;
        caller
            .audit("employee.sensitive_updated", Some(&id), json!({ "fields": changed }))
            .await?;
        // No field names on the event: which fields changed is itself personal.
        caller.emit(&state, HR_EMPLOYEE_UPDATED, &id, &[]);
    }
    Ok(Data(read_sensitive(&caller.db, &id, &keyring).await?).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_names_split_like_typescript() {
        assert_eq!(split_member_name(None), ("Unknown".to_owned(), "Member".to_owned()));
        assert_eq!(split_member_name(Some("Ann")), ("Ann".to_owned(), "Ann".to_owned()));
        assert_eq!(
            split_member_name(Some("  Ann  van der Berg ")),
            ("Ann".to_owned(), "van der Berg".to_owned())
        );
    }
}
