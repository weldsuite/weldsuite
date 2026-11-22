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
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::{Date, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    HR_CHECKLIST_CREATED, HR_EMPLOYEE_CREATED, HR_EMPLOYEE_DELETED, HR_EMPLOYEE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    EMPLOYEES_CREATE, EMPLOYEES_DELETE, EMPLOYEES_READ, EMPLOYEES_SENSITIVE, EMPLOYEES_UPDATE,
};
use weldsuite_core_domain::custom_field_values as custom_fields;
use weldsuite_core_domain::js::Js;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, decrypt_field, encrypt_field, orm, utc_now};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    entities, hr_client_assignments, hr_departments, hr_employees, hr_payroll_employers,
    hr_payroll_profiles, workspace_members,
};

use crate::entity_scope::{EMPLOYEE_RECORD, Scope, guard};
use crate::fields::{Fields, field_json, id, iso_date, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, assert_birth_date, assert_date_order, company_names,
    hr_json, js_number, now, text, today_iso, zod_query,
};

/// `hr_employees` written from a request body (`db.insert(hrEmployees)
/// .values({ ...input })`, `db.update(hrEmployees).set({ ...input })`).
const EMPLOYEES: JsonTable = JsonTable::of::<hr_employees::Entity>();

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
            get(available_members_route)
                .route_layer(gate.require([EMPLOYEES_CREATE, EMPLOYEES_UPDATE])),
        )
        .route("/employees/{id}", get(detail_route).route_layer(read()))
        .route(
            "/employees",
            post(create_route).route_layer(gate.require([EMPLOYEES_CREATE])),
        )
        .route(
            "/employees/from-member",
            post(from_member_route).route_layer(gate.require([EMPLOYEES_CREATE])),
        )
        .route(
            "/employees/{id}",
            patch(update_route).route_layer(gate.require([EMPLOYEES_UPDATE])),
        )
        .route(
            "/employees/{id}",
            delete(delete_route).route_layer(gate.require([EMPLOYEES_DELETE])),
        )
        .route(
            "/employees/{id}/sensitive",
            get(read_sensitive_route).route_layer(sensitive()),
        )
        .route(
            "/employees/{id}/sensitive",
            put(write_sensitive_route).route_layer(sensitive()),
        )
        .route("/org-chart", get(org_chart_route).route_layer(read()))
        // An employee of a legal entity the request may not touch is a 404 on every by-id route.
        .route_layer(guard("/employees", "Employee", EMPLOYEE_RECORD))
        .merge(crate::departments::routes(gate))
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/// `displayNameOf(e)`: the preferred name (trimmed) or the first name, then
/// the last name, trimmed.
pub(crate) fn display_name_of(row: &Value) -> String {
    display_name(
        text(row, "firstName"),
        text(row, "lastName"),
        row["preferredName"].as_str(),
    )
}

/// [`display_name_of`] over the name columns themselves.
pub(crate) fn display_name(first: &str, last: &str, preferred: Option<&str>) -> String {
    let preferred = preferred.map(str::trim).unwrap_or_default();
    let first = if preferred.is_empty() { first } else { preferred };
    format!("{first} {last}").trim().to_owned()
}

/// A row as the API returns it: the entity's model (or a partial row)
/// serialized as Drizzle returned it.
pub(crate) fn to_json<T: Serialize>(row: T) -> Result<Value, HrError> {
    serde_json::to_value(row).map_err(|error| HrError::internal(error.to_string()))
}

/// A `YYYY-MM-DD` the route binds as `$n::date`: a day that doesn't exist
/// fails the statement, as Postgres refuses it (the router's 500;
/// [`crate::shared::sql_date`]).
pub(crate) fn pg_date(text: &str) -> Result<Date, HrError> {
    Ok(crate::shared::sql_date(text)?)
}

/// [`pg_date`] for an optional day.
pub(crate) fn pg_date_opt(text: Option<&str>) -> Result<Option<Date>, HrError> {
    text.map(pg_date).transpose()
}

/// A `timestamp` as Drizzle hands a `Date` to `JSON.stringify`
/// (`toISOString()`); `null` for none.
pub(crate) fn js_timestamp(at: Option<PrimitiveDateTime>) -> Value {
    at.and_then(|at| {
        weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer).ok()
    })
    .unwrap_or(Value::Null)
}

/// A statement that had to change one row (`returning …` read with
/// `fetch_one`) and matched none: the router's 500.
pub(crate) fn no_row(table: &str) -> HrError {
    HrError::Database(DbErr::RecordNotFound(format!("{table}: no row")))
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
    let row = hr_employees::Entity::find()
        .filter(hr_employees::Column::Id.eq(id))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Employee", id))?)
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
    let on = pg_date(&on.map_or_else(today_iso, str::to_owned))?;
    let rows: Vec<(String, String, bool)> = hr_client_assignments::Entity::find()
        .select_only()
        .columns([
            hr_client_assignments::Column::EmployeeId,
            hr_client_assignments::Column::CompanyId,
            hr_client_assignments::Column::IsPrimary,
        ])
        .filter(hr_client_assignments::Column::EmployeeId.is_in(employee_ids.iter().map(String::as_str)))
        .filter(hr_client_assignments::Column::StartDate.lte(on))
        .filter(
            Condition::any()
                .add(hr_client_assignments::Column::EndDate.is_null())
                .add(hr_client_assignments::Column::EndDate.gte(on)),
        )
        .into_tuple()
        .all(&orm(db))
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
pub(crate) async fn employee_for_user(
    db: &PgPool,
    user_id: &str,
) -> Result<Option<Value>, HrError> {
    let row = hr_employees::Entity::find()
        .filter(hr_employees::Column::UserId.eq(user_id))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row
        .map(to_json)
        .transpose()?
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
    let entity_ids = unique("legalEntityId");
    let departments: Vec<(String, String)> = if department_ids.is_empty() {
        Vec::new()
    } else {
        hr_departments::Entity::find()
            .select_only()
            .columns([hr_departments::Column::Id, hr_departments::Column::Name])
            .filter(hr_departments::Column::Id.is_in(department_ids.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let managers: Vec<(String, String, String, Option<String>)> = if manager_ids.is_empty() {
        Vec::new()
    } else {
        hr_employees::Entity::find()
            .select_only()
            .columns([
                hr_employees::Column::Id,
                hr_employees::Column::FirstName,
                hr_employees::Column::LastName,
                hr_employees::Column::PreferredName,
            ])
            .filter(hr_employees::Column::Id.is_in(manager_ids.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let ids: Vec<String> = rows.iter().map(|row| text(row, "id").to_owned()).collect();
    let clients = active_clients_for(db, &ids, None).await?;
    let entities: Vec<(String, String)> = if entity_ids.is_empty() {
        Vec::new()
    } else {
        entities::Entity::find()
            .select_only()
            .columns([entities::Column::Id, entities::Column::Name])
            .filter(entities::Column::Id.is_in(entity_ids.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let entity_name: HashMap<String, String> = entities.into_iter().collect();
    let department_name: HashMap<String, String> = departments.into_iter().collect();
    let manager_name: HashMap<String, String> = managers
        .into_iter()
        .map(|(id, first, last, preferred)| {
            let name = display_name(&first, &last, preferred.as_deref());
            (id, name)
        })
        .collect();
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut out = to_public_employee(&row);
            let entity = row["legalEntityId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .and_then(|id| entity_name.get(id).cloned());
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
                map.insert("legalEntityName".to_owned(), json!(entity));
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
/// is the last row's id. `scope` is the request's entity scope.
async fn list_employees(
    pool: &PgPool,
    filters: &Map<String, Value>,
    scope: &Scope,
) -> Result<(Vec<Value>, u64, bool, Option<String>), HrError> {
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
    let today = pg_date(&today_iso())?;
    let db = &orm(pool);
    let cursor_row: Option<(String, String, String)> = match get("cursor").filter(|s| !s.is_empty())
    {
        Some(cursor) => {
            hr_employees::Entity::find()
                .select_only()
                .columns([
                    hr_employees::Column::LastName,
                    hr_employees::Column::FirstName,
                    hr_employees::Column::Id,
                ])
                .filter(hr_employees::Column::Id.eq(cursor))
                .into_tuple()
                .one(db)
                .await?
        }
        None => None,
    };
    let filters = EmployeeFilters {
        search: search.as_deref(),
        statuses: statuses.as_deref(),
        department: department.as_deref(),
        manager: manager.as_deref(),
        company: company.as_deref(),
        today,
        scope,
    }
    .condition();
    let mut page = hr_employees::Entity::find().filter(filters.clone());
    if let Some((last, first, id)) = &cursor_row {
        use sea_orm::ExprTrait as _;
        let column = |column: hr_employees::Column| Expr::col((hr_employees::Entity, column));
        page = page.filter(
            Expr::tuple([
                column(hr_employees::Column::LastName),
                column(hr_employees::Column::FirstName),
                column(hr_employees::Column::Id),
            ])
            .gt(Expr::tuple([
                Expr::val(last.as_str()),
                Expr::val(first.as_str()),
                Expr::val(id.as_str()),
            ])),
        );
    }
    let rows = page
        .order_by_asc(hr_employees::Column::LastName)
        .order_by_asc(hr_employees::Column::FirstName)
        .order_by_asc(hr_employees::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or_default())
        .all(db)
        .await?;
    let total = hr_employees::Entity::find()
        .filter(filters)
        .count(db)
        .await?;
    let mut rows: Vec<Value> = rows.into_iter().map(to_json).collect::<Result<_, _>>()?;
    let limit = usize::try_from(limit).unwrap_or(50);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last().map(|row| text(row, "id").to_owned())
    } else {
        None
    };
    Ok((decorate(pool, rows).await?, total, has_more, cursor))
}

/// The `where` of `listEmployees` without its cursor (the page and its
/// `count(*)` share it).
struct EmployeeFilters<'a> {
    /// The `ilike` pattern, already escaped and wrapped in `%`.
    search: Option<&'a str>,
    statuses: Option<&'a [String]>,
    department: Option<&'a str>,
    manager: Option<&'a str>,
    /// Employees assigned to this client on `today`.
    company: Option<&'a str>,
    today: Date,
    scope: &'a Scope,
}

impl EmployeeFilters<'_> {
    fn condition(&self) -> Condition {
        use hr_employees::Column;
        let mut all = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(search) = self.search {
            all = all.add(
                Condition::any()
                    .add(Column::FirstName.ilike(search))
                    .add(Column::LastName.ilike(search))
                    .add(Column::PreferredName.ilike(search))
                    .add(Column::Email.ilike(search))
                    .add(Column::EmployeeNumber.ilike(search))
                    .add(Column::JobTitle.ilike(search)),
            );
        }
        if let Some(statuses) = self.statuses {
            all = all.add(Column::Status.is_in(statuses.iter().map(String::as_str)));
        }
        if let Some(department) = self.department {
            all = all.add(Column::DepartmentId.eq(department));
        }
        if let Some(manager) = self.manager {
            all = all.add(Column::ManagerId.eq(manager));
        }
        if let Some(company) = self.company {
            use hr_client_assignments::Column as Assignment;
            all = all.add(
                Column::Id.in_subquery(
                    Query::select()
                        .column(Assignment::EmployeeId)
                        .from(hr_client_assignments::Entity)
                        .cond_where(
                            Condition::all()
                                .add(Assignment::CompanyId.eq(company))
                                .add(Assignment::StartDate.lte(self.today))
                                .add(
                                    Condition::any()
                                        .add(Assignment::EndDate.is_null())
                                        .add(Assignment::EndDate.gte(self.today)),
                                ),
                        )
                        .to_owned(),
                ),
            );
        }
        all.add(self.scope.condition(Column::LegalEntityId))
    }
}

async fn list_route(
    State(state): State<HrState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> HrResult {
    let filters = zod_query(query.as_deref(), |issues, q| {
        let mut out = Map::new();
        let mut keep = |key: &str, field: Field<String>| {
            if let Field::Set(value) = field {
                out.insert(key.to_owned(), Value::String(value));
            }
        };
        keep(
            "search",
            issues.text(q, "search", Presence::Optional, None, Some(200)),
        );
        keep(
            "status",
            issues.text(q, "status", Presence::Optional, None, Some(200)),
        );
        keep(
            "departmentId",
            id(issues, q, "departmentId", Presence::Optional),
        );
        keep("managerId", id(issues, q, "managerId", Presence::Optional));
        keep("companyId", id(issues, q, "companyId", Presence::Optional));
        let limit = issues.number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(200.0),
            },
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
    let scope = caller.scope().await?;
    let (data, total, has_more, cursor) = list_employees(&caller.db, &filters, &scope).await?;
    Ok(List::new(data, Pagination::new(total, has_more, cursor)).into_response())
}

/// `getEmployeeDetail(db, id)`: the decorated employee with direct reports.
async fn employee_detail(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = require_employee(db, id).await?;
    let mut decorated = decorate(db, vec![row]).await?.pop().unwrap_or(Value::Null);
    let reports: Vec<OrgChartPerson> = OrgChartPerson::select()
        .filter(hr_employees::Column::ManagerId.eq(id))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .order_by_asc(hr_employees::Column::LastName)
        .order_by_asc(hr_employees::Column::FirstName)
        .into_model()
        .all(&orm(db))
        .await?;
    let reports: Vec<Value> = reports
        .into_iter()
        .map(|report| report.json(false))
        .collect::<Result<_, _>>()?;
    if let Some(map) = decorated.as_object_mut() {
        map.insert("directReports".to_owned(), Value::Array(reports));
    }
    Ok(decorated)
}

async fn detail_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    link_invited_employees(&state, &caller, None, Some(&id)).await?;
    Ok(Data(employee_detail(&caller.db, &id).await?).into_response())
}

/// A person of the org chart (or a direct report: without `managerId` and
/// `departmentId`), as the route's `jsonb_build_object` had it, plus
/// `displayName`.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgChartPerson {
    id: String,
    first_name: String,
    last_name: String,
    preferred_name: Option<String>,
    job_title: Option<String>,
    avatar_url: Option<String>,
    manager_id: Option<String>,
    department_id: Option<String>,
    status: String,
}

impl OrgChartPerson {
    fn select() -> sea_orm::Select<hr_employees::Entity> {
        use hr_employees::Column;
        hr_employees::Entity::find().select_only().columns([
            Column::Id,
            Column::FirstName,
            Column::LastName,
            Column::PreferredName,
            Column::JobTitle,
            Column::AvatarUrl,
            Column::ManagerId,
            Column::DepartmentId,
            Column::Status,
        ])
    }

    /// The object with `displayName`; `with_place` keeps `managerId` and
    /// `departmentId` (the org chart's, not a direct report's).
    fn json(self, with_place: bool) -> Result<Value, HrError> {
        let name = display_name(
            &self.first_name,
            &self.last_name,
            self.preferred_name.as_deref(),
        );
        let mut row = to_json(self)?;
        if let Some(map) = row.as_object_mut() {
            if !with_place {
                map.remove("managerId");
                map.remove("departmentId");
            }
            map.insert("displayName".to_owned(), Value::String(name));
        }
        Ok(row)
    }
}

async fn org_chart_route(caller: Caller) -> HrResult {
    let scope = caller.scope().await?;
    let rows: Vec<OrgChartPerson> = OrgChartPerson::select()
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(hr_employees::Column::Status.ne("terminated"))
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_asc(hr_employees::Column::LastName)
        .order_by_asc(hr_employees::Column::FirstName)
        .into_model()
        .all(&orm(&caller.db))
        .await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| row.json(true))
        .collect::<Result<_, _>>()?;
    Ok(Data(rows).into_response())
}

async fn available_members_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    use workspace_members::Column as Member;
    let (search, limit) = zod_query(query.as_deref(), |issues, q| {
        (
            issues.text(q, "search", Presence::Optional, None, Some(200)),
            issues.number(
                q,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(200.0),
                },
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
    let mut members = workspace_members::Entity::find()
        .select_only()
        .columns([
            Member::UserId,
            Member::Name,
            Member::Email,
            Member::Title,
            Member::Phone,
            Member::MemberType,
        ])
        .filter(Member::DeletedAt.is_null())
        .filter(Member::Status.eq("ACTIVE"))
        .filter(Member::MemberType.is_in(EMPLOYABLE_MEMBER_TYPES))
        .filter(Member::UserId.not_like("invited\\_%"))
        .filter(Member::UserId.not_in_subquery(linked_user_ids()));
    if let Some(search) = &search {
        members = members.filter(
            Condition::any()
                .add(Member::Name.ilike(search))
                .add(Member::Email.ilike(search)),
        );
    }
    let members: Vec<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = members
        .order_by_asc(Member::Name)
        .order_by_asc(Member::Email)
        .limit(u64::try_from(limit).unwrap_or_default())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    let mut rows: Vec<Value> = members
        .into_iter()
        .map(|(user_id, name, email, title, phone, member_type)| {
            json!({
                "userId": user_id,
                "name": name,
                "email": email,
                "picture": null,
                "title": title,
                "phone": phone,
                "memberType": if member_type == "EMPLOYEE" { "EMPLOYEE" } else { "INTERNAL" },
            })
        })
        .collect();
    // Avatars are account pictures, not the member row's copy.
    weldsuite_db::overlay_account_pictures(caller.request_master(), &mut rows, "userId", "picture")
        .await;
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
    use workspace_members::Column as Member;
    let db = &orm(&caller.db);
    let mut candidates = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::Id)
        .column(Member::UserId)
        .filter(hr_employees::Column::UserId.is_null())
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(Member::DeletedAt.is_null())
        .filter(Member::Status.eq("ACTIVE"))
        .filter(Member::MemberType.is_in(EMPLOYABLE_MEMBER_TYPES))
        .filter(Member::UserId.not_like("invited\\_%"))
        .filter(Member::UserId.not_like("pending\\_clerk\\_%"))
        .filter(Member::UserId.not_in_subquery(linked_user_ids()));
    if let Some(user_id) = user_id {
        candidates = candidates.filter(Member::UserId.eq(user_id));
    }
    if let Some(employee_id) = employee_id {
        candidates = candidates.filter(hr_employees::Column::Id.eq(employee_id));
    }
    // `join workspace_members m on lower(m.email) = lower(t.email)`.
    QueryTrait::query(&mut candidates).join(
        JoinType::InnerJoin,
        workspace_members::Entity,
        sea_orm::ExprTrait::eq(
            Func::lower(Expr::col((workspace_members::Entity, Member::Email))),
            Func::lower(Expr::col((hr_employees::Entity, hr_employees::Column::Email))),
        ),
    );
    let candidates: Vec<(String, String)> = candidates.limit(50).into_tuple().all(db).await?;
    let mut linked = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    for (candidate_employee, candidate_user) in candidates {
        if taken.contains(&candidate_user) {
            continue;
        }
        let done = hr_employees::Entity::update_many()
            .col_expr(
                hr_employees::Column::UserId,
                Expr::value(candidate_user.as_str()),
            )
            .col_expr(hr_employees::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(hr_employees::Column::Id.eq(candidate_employee.as_str()))
            .filter(hr_employees::Column::UserId.is_null())
            .exec(db)
            .await?;
        if done.rows_affected == 0 {
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

/// `select user_id from hr_employees where deleted_at is null`: the members
/// already linked to an employee (`not exists (… where t.user_id =
/// m.user_id …)`; a null `user_id` is left out so `not in` stays the same
/// test).
fn linked_user_ids() -> sea_orm::sea_query::SelectStatement {
    Query::select()
        .column(hr_employees::Column::UserId)
        .from(hr_employees::Entity)
        .cond_where(
            Condition::all()
                .add(hr_employees::Column::DeletedAt.is_null())
                .add(hr_employees::Column::UserId.is_not_null()),
        )
        .to_owned()
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// The schema fields of an employee write, in `createHrEmployeeSchema`'s
/// order (the column each lands in).
const WRITE_KEYS: [(&str, &str); 23] = [
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
    ("legalEntityId", "legal_entity_id"),
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

const EMPLOYMENT_TYPES: [&str; 5] = [
    "full_time",
    "part_time",
    "contractor",
    "intern",
    "temporary",
];
const STATUSES: [&str; 5] = [
    "onboarding",
    "active",
    "on_leave",
    "offboarding",
    "terminated",
];
const SALARY_PERIODS: [&str; 3] = ["hour", "month", "year"];

/// `hrEmployeeSensitiveSchema`: the fields present, in schema order.
fn sensitive_fields(issues: &mut Issues, fields: &Fields) -> Vec<(&'static str, Value)> {
    let mut out: Vec<(&'static str, Value)> = Vec::new();
    let mut keep = |key: &'static str, value: Option<Value>| {
        if let Some(value) = value {
            out.push((key, value));
        }
    };
    keep(
        "dateOfBirth",
        field_json(&iso_date(issues, fields, "dateOfBirth", Presence::Nullish)),
    );
    keep(
        "nationalId",
        field_json(&short_text(
            issues,
            fields,
            "nationalId",
            Presence::Nullish,
            100,
            false,
        )),
    );
    keep(
        "taxId",
        field_json(&short_text(
            issues,
            fields,
            "taxId",
            Presence::Nullish,
            100,
            false,
        )),
    );
    keep(
        "address",
        field_json(&text_max(
            issues,
            fields,
            "address",
            Presence::Nullish,
            1000,
        )),
    );
    keep(
        "personalEmail",
        field_json(&issues.text_with(
            fields,
            "personalEmail",
            Presence::Nullish,
            Text {
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        )),
    );
    keep(
        "personalPhone",
        field_json(&short_text(
            issues,
            fields,
            "personalPhone",
            Presence::Nullish,
            50,
            false,
        )),
    );
    keep(
        "emergencyContactName",
        field_json(&short_text(
            issues,
            fields,
            "emergencyContactName",
            Presence::Nullish,
            255,
            false,
        )),
    );
    keep(
        "emergencyContactPhone",
        field_json(&short_text(
            issues,
            fields,
            "emergencyContactPhone",
            Presence::Nullish,
            50,
            false,
        )),
    );
    keep(
        "emergencyContactRelation",
        field_json(&short_text(
            issues,
            fields,
            "emergencyContactRelation",
            Presence::Nullish,
            100,
            false,
        )),
    );
    keep(
        "bankAccount",
        field_json(&short_text(
            issues,
            fields,
            "bankAccount",
            Presence::Nullish,
            100,
            false,
        )),
    );
    let salary = crate::fields::number(
        issues,
        fields,
        "salaryAmount",
        Presence::Nullish,
        Some(0.0),
        None,
    );
    keep(
        "salaryAmount",
        match salary {
            Field::Absent => None,
            Field::Null => Some(Value::Null),
            Field::Set(amount) => Some(js_number(amount)),
        },
    );
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
    keep(
        "salaryPeriod",
        field_json(&issues.choice(fields, "salaryPeriod", Presence::Nullish, &SALARY_PERIODS)),
    );
    keep(
        "notes",
        field_json(&text_max(issues, fields, "notes", Presence::Nullish, 5000)),
    );
    out
}

fn employee_body(issues: &mut Issues, fields: &Fields, schema: Schema) -> EmployeeBody {
    let partial = schema != Schema::Create;
    let required = |p: bool| {
        if p {
            Presence::Optional
        } else {
            Presence::Required
        }
    };
    let mut input: Vec<(&'static str, Value)> = Vec::new();
    let mut keep = |key: &'static str, value: Option<Value>| {
        if let Some(value) = value {
            input.push((key, value));
        }
    };
    keep(
        "employeeNumber",
        field_json(&short_text(
            issues,
            fields,
            "employeeNumber",
            Presence::Nullish,
            50,
            false,
        )),
    );
    keep(
        "firstName",
        field_json(&short_text(
            issues,
            fields,
            "firstName",
            required(partial),
            120,
            true,
        )),
    );
    keep(
        "lastName",
        field_json(&short_text(
            issues,
            fields,
            "lastName",
            required(partial),
            120,
            true,
        )),
    );
    keep(
        "preferredName",
        field_json(&short_text(
            issues,
            fields,
            "preferredName",
            Presence::Nullish,
            120,
            false,
        )),
    );
    keep(
        "email",
        field_json(&issues.text_with(
            fields,
            "email",
            required(partial),
            Text {
                trim: true,
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        )),
    );
    keep(
        "phone",
        field_json(&short_text(
            issues,
            fields,
            "phone",
            Presence::Nullish,
            50,
            false,
        )),
    );
    keep(
        "avatarUrl",
        field_json(&issues.text_with(
            fields,
            "avatarUrl",
            Presence::Nullish,
            Text {
                format: Some(Format::Url),
                max: Some(500),
                ..Text::default()
            },
        )),
    );
    keep(
        "pronouns",
        field_json(&short_text(
            issues,
            fields,
            "pronouns",
            Presence::Nullish,
            40,
            false,
        )),
    );
    keep(
        "jobTitle",
        field_json(&short_text(
            issues,
            fields,
            "jobTitle",
            Presence::Nullish,
            160,
            false,
        )),
    );
    keep(
        "departmentId",
        field_json(&id(issues, fields, "departmentId", Presence::Nullish)),
    );
    keep(
        "managerId",
        field_json(&id(issues, fields, "managerId", Presence::Nullish)),
    );
    keep(
        "legalEntityId",
        field_json(&id(issues, fields, "legalEntityId", Presence::Nullish)),
    );
    if schema != Schema::FromMember {
        keep(
            "userId",
            field_json(&issues.text_with(
                fields,
                "userId",
                Presence::Optional,
                Text::trimmed(Some(1), Some(255)),
            )),
        );
    }
    keep(
        "employmentType",
        field_json(&issues.choice(
            fields,
            "employmentType",
            Presence::Optional,
            &EMPLOYMENT_TYPES,
        )),
    );
    keep(
        "status",
        field_json(&issues.choice(fields, "status", Presence::Optional, &STATUSES)),
    );
    keep(
        "startDate",
        field_json(&iso_date(issues, fields, "startDate", Presence::Nullish)),
    );
    keep(
        "endDate",
        field_json(&iso_date(issues, fields, "endDate", Presence::Nullish)),
    );
    keep(
        "probationEndDate",
        field_json(&iso_date(
            issues,
            fields,
            "probationEndDate",
            Presence::Nullish,
        )),
    );
    keep(
        "location",
        field_json(&short_text(
            issues,
            fields,
            "location",
            Presence::Nullish,
            160,
            false,
        )),
    );
    keep(
        "timezone",
        field_json(&short_text(
            issues,
            fields,
            "timezone",
            Presence::Nullish,
            60,
            false,
        )),
    );
    let hours = crate::fields::number(
        issues,
        fields,
        "weeklyHours",
        Presence::Nullish,
        Some(0.0),
        Some(168.0),
    );
    keep(
        "weeklyHours",
        match hours {
            Field::Absent => None,
            Field::Null => Some(Value::Null),
            Field::Set(h) => Some(js_number(h)),
        },
    );
    let locations = issues.list(
        fields,
        "workLocationIds",
        Presence::Nullish,
        None,
        Some(50),
        |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
    );
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
            field_json(&issues.text_with(
                fields,
                "userId",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )),
        );
    }
    EmployeeBody {
        input,
        sensitive,
        onboarding_template_id: onboarding,
    }
}

/// `assertEmailFree(db, email, exceptId?)`.
async fn assert_email_free(
    db: &PgPool,
    email: &str,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let dupe: Option<String> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::Id)
        .filter(lower_email_is(hr_employees::Column::Email, email.to_lowercase()))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if dupe.is_some_and(|dupe| Some(dupe.as_str()) != except_id) {
        return Err(HrError::conflict(
            "Another employee already uses this email address",
        ));
    }
    Ok(())
}

/// `assertUserIdFree(db, userId, exceptId?)`.
async fn assert_user_id_free(
    db: &PgPool,
    user_id: Option<&str>,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let Some(user_id) = user_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let dupe: Option<String> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::Id)
        .filter(hr_employees::Column::UserId.eq(user_id))
        .filter(hr_employees::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
        return Err(HrError::validation(
            "That is not an active workspace member",
        ));
    }
    let row = workspace_members::Entity::find()
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(row) = row.map(to_json).transpose()? else {
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

/// `lower(email) = $n`.
fn lower_email_is(column: impl ColumnTrait, email: String) -> Expr {
    sea_orm::ExprTrait::eq(Func::lower(Expr::col(column.as_column_ref())), email)
}

/// `isPlaceholderUserId(userId)`.
fn is_placeholder_user_id(user_id: &str) -> bool {
    user_id.starts_with("invited_") || user_id.starts_with("pending_clerk_")
}

/// `memberForNewEmployee(db, email)`: an active member with that email, or
/// `None` for someone whose invite is pending.
async fn member_for_new_employee(db: &PgPool, email: &str) -> Result<Option<String>, HrError> {
    let rows: Vec<(String, String, String)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Status,
            workspace_members::Column::MemberType,
        ])
        .filter(lower_email_is(
            workspace_members::Column::Email,
            crate::js_trim(email).to_lowercase(),
        ))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
async fn assert_manager(
    db: &PgPool,
    manager_id: Option<&str>,
    self_id: Option<&str>,
) -> Result<(), HrError> {
    let Some(manager_id) = manager_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if Some(manager_id) == self_id {
        return Err(HrError::validation(
            "An employee cannot be their own manager",
        ));
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
        let next: Option<Option<String>> = hr_employees::Entity::find()
            .select_only()
            .column(hr_employees::Column::ManagerId)
            .filter(hr_employees::Column::Id.eq(current.as_str()))
            .into_tuple()
            .one(&orm(db))
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
pub(crate) fn encrypt_sensitive(
    value: &Value,
    keyring: &weldsuite_db::Keyring,
) -> Result<String, HrError> {
    if keyring.is_empty() {
        return Err(HrError::validation(
            "Sensitive employee data cannot be stored: the worker has no encryption key",
        ));
    }
    encrypt_field(&value.to_string(), keyring).map_err(|error| HrError::internal(error.to_string()))
}

/// The sensitive fields as the object `JSON.stringify` writes.
fn sensitive_object(fields: &[(&'static str, Value)]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
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
    assert_date_order(
        get_text("startDate"),
        get_text("probationEndDate"),
        "Probation",
    )?;
    let birth = sensitive.and_then(|fields| fields.iter().find(|(k, _)| *k == "dateOfBirth"));
    assert_birth_date(birth.and_then(|(_, v)| v.as_str()))?;
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
        Some(fields) => Some(encrypt_sensitive(
            &sensitive_object(fields),
            &caller.keyring(),
        )?),
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
    record
        .entry("status".to_owned())
        .or_insert_with(|| json!("onboarding"));
    record.insert("sensitive_encrypted".to_owned(), json!(sealed));
    record.insert("created_by".to_owned(), json!(caller.user_id));
    // `insert into hr_employees (<the route's columns>) select … from
    // jsonb_populate_record(…)`: every column the route names is in `record`.
    let row = EMPLOYEES.insert(&orm(db), record).await?;
    if has_custom {
        custom_fields::sync_values_for_entity(db, EMPLOYEE_CUSTOM_FIELD_ENTITY, &id, custom).await;
    }
    Ok(row)
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
            .audit(
                "employee.sensitive_updated",
                Some(&employee_id),
                json!({ "fields": fields }),
            )
            .await?;
    }
    caller.emit(
        state,
        HR_EMPLOYEE_CREATED,
        &employee_id,
        &[("status", Some(employee["status"].clone()))],
    );
    if let Some(template) = &body.onboarding_template_id {
        let checklist = crate::lifecycle::start_checklist(
            &caller.db,
            &employee_id,
            template,
            None,
            false,
            &caller.user_id,
        )
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

/// The route's `legalEntityId`: the body's is replaced by
/// `resolveNewEmployeeEntity(c, requested)` (the request's entity, else the
/// one named, else the default).
async fn with_new_employee_entity(caller: &Caller, body: &mut EmployeeBody) -> Result<(), HrError> {
    let requested = body.text("legalEntityId").map(str::to_owned);
    let resolved = caller
        .resolve_new_employee_entity(requested.as_deref())
        .await?;
    body.input.retain(|(key, _)| *key != "legalEntityId");
    body.input.push(("legalEntityId", json!(resolved)));
    Ok(())
}

/// `assertEntityFitsPayroll(db, employeeId, legalEntityId)`: moving an
/// employee to another legal entity is refused while their payroll profile
/// is under an employer of a different entity.
async fn assert_entity_fits_payroll(
    db: &PgPool,
    employee_id: &str,
    legal_entity_id: &str,
) -> Result<(), HrError> {
    let clash: Option<String> = hr_payroll_profiles::Entity::find()
        .select_only()
        .column(hr_payroll_profiles::Column::EmployerId)
        .join(
            JoinType::InnerJoin,
            hr_payroll_profiles::Entity::belongs_to(hr_payroll_employers::Entity)
                .from(hr_payroll_profiles::Column::EmployerId)
                .to(hr_payroll_employers::Column::Id)
                .into(),
        )
        .filter(hr_payroll_profiles::Column::EmployeeId.eq(employee_id))
        .filter(hr_payroll_profiles::Column::Status.ne("ended"))
        .filter(hr_payroll_employers::Column::LegalEntityId.is_not_null())
        .filter(hr_payroll_employers::Column::LegalEntityId.ne(legal_entity_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    if clash.is_some() {
        return Err(HrError::conflict(
            "This employee is on the payroll of an employer of another legal entity. Move or end their payroll profile first.",
        ));
    }
    Ok(())
}

async fn create_route(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let mut body = hr_json(&headers, &body, |issues, fields| {
        employee_body(issues, fields, Schema::Create)
    })?;
    with_new_employee_entity(&caller, &mut body).await?;
    if body.sensitive.is_some() && !caller.can(EMPLOYEES_SENSITIVE) {
        return Err(HrError::forbidden(
            "You do not have permission to set sensitive employee data",
        ));
    }
    let employee = create_employee(&caller, &body.input, body.sensitive.as_deref()).await?;
    after_create(&state, &caller, &employee, &body).await
}

async fn from_member_route(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let mut body = hr_json(&headers, &body, |issues, fields| {
        employee_body(issues, fields, Schema::FromMember)
    })?;
    with_new_employee_entity(&caller, &mut body).await?;
    if body.sensitive.is_some() && !caller.can(EMPLOYEES_SENSITIVE) {
        return Err(HrError::forbidden(
            "You do not have permission to set sensitive employee data",
        ));
    }
    let user_id = body.text("userId").unwrap_or_default().to_owned();
    let member = require_active_workspace_member(&caller.db, &user_id).await?;
    if member["email"].as_str().is_none_or(str::is_empty) && body.get("email").is_none() {
        return Err(HrError::validation(
            "This workspace member has no email address",
        ));
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
    set(
        "avatarUrl",
        given_or("avatarUrl", member["picture"].clone()),
    );
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
    let body = hr_json(&headers, &body, |issues, fields| {
        employee_body(issues, fields, Schema::Update)
    })?;
    if body.sensitive.is_some() {
        return Err(HrError::bad_request(
            "Update sensitive data through PUT /employees/:employeeId/sensitive",
        ));
    }
    // Moving an employee needs the same standing in the target entity as creating one there.
    let entity = body
        .text("legalEntityId")
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if let Some(entity) = &entity {
        caller.assert_entity_usable(entity)?;
    }
    let db = &caller.db;
    let existing = require_employee(db, &id).await?;
    let pick = |key: &str| -> Option<String> {
        match body.get(key) {
            Some(value) => value.as_str().map(str::to_owned),
            None => existing[key].as_str().map(str::to_owned),
        }
    };
    assert_date_order(
        pick("startDate").as_deref(),
        pick("endDate").as_deref(),
        "Employment",
    )?;
    // Only when the save touches either date, so older rows stay editable (TASK-1471).
    if body.get("startDate").is_some() || body.get("probationEndDate").is_some() {
        assert_date_order(
            pick("startDate").as_deref(),
            pick("probationEndDate").as_deref(),
            "Probation",
        )?;
    }
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
    if let Some(entity) = &entity
        && existing["legalEntityId"].as_str() != Some(entity.as_str())
    {
        assert_entity_fits_payroll(db, &id, entity).await?;
    }
    let custom = body.get("customFields");
    let has_custom = prepare_custom_fields(db, custom).await?;
    let mut record = Map::new();
    for (key, column) in WRITE_KEYS {
        if let Some(value) = body.get(key) {
            record.insert(column.to_owned(), value.clone());
        }
    }
    // `update hr_employees set <each column sent> = r.<column>, updated_at
    // = now from jsonb_populate_record(…) r where id = $id`.
    record.insert("updated_at".to_owned(), Value::String(now()));
    let row = EMPLOYEES
        .update(&orm(db), &id, record, false)
        .await?
        .ok_or_else(|| no_row("hr_employees"))?;
    if has_custom {
        custom_fields::sync_values_for_entity(db, EMPLOYEE_CUSTOM_FIELD_ENTITY, &id, custom).await;
    }
    caller.emit(
        &state,
        HR_EMPLOYEE_UPDATED,
        text(&row, "id"),
        &[("status", Some(row["status"].clone()))],
    );
    Ok(Data(to_public_employee(&row)).into_response())
}

async fn delete_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    require_employee(&caller.db, &id).await?;
    let now = utc_now();
    hr_employees::Entity::update_many()
        .col_expr(hr_employees::Column::DeletedAt, Expr::value(now))
        .col_expr(hr_employees::Column::UpdatedAt, Expr::value(now))
        .filter(hr_employees::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    caller
        .audit("employee.deleted", Some(&id), json!({}))
        .await?;
    caller.emit(&state, HR_EMPLOYEE_DELETED, &id, &[]);
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Sensitive block
// ---------------------------------------------------------------------------

/// `readSensitive(db, id, keyring)`: the opened block, `{}` without one.
pub(crate) async fn read_sensitive(
    db: &PgPool,
    id: &str,
    keyring: &weldsuite_db::Keyring,
) -> Result<Value, HrError> {
    let row = require_employee(db, id).await?;
    let Some(sealed) = row["sensitiveEncrypted"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(json!({}));
    };
    let plaintext =
        decrypt_field(sealed, keyring).map_err(|error| HrError::internal(error.to_string()))?;
    serde_json::from_str(&plaintext).map_err(|error| HrError::internal(error.to_string()))
}

async fn read_sensitive_route(caller: Caller, Path(id): Path<String>) -> HrResult {
    let value = read_sensitive(&caller.db, &id, &caller.keyring()).await?;
    caller
        .audit("employee.sensitive_viewed", Some(&id), json!({}))
        .await?;
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
    let birth = patch.iter().find(|(key, _)| *key == "dateOfBirth");
    assert_birth_date(birth.and_then(|(_, value)| value.as_str()))?;
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
        hr_employees::Entity::update_many()
            .col_expr(hr_employees::Column::SensitiveEncrypted, Expr::value(sealed))
            .col_expr(hr_employees::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(hr_employees::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller
            .audit(
                "employee.sensitive_updated",
                Some(&id),
                json!({ "fields": changed }),
            )
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
        assert_eq!(
            split_member_name(None),
            ("Unknown".to_owned(), "Member".to_owned())
        );
        assert_eq!(
            split_member_name(Some("Ann")),
            ("Ann".to_owned(), "Ann".to_owned())
        );
        assert_eq!(
            split_member_name(Some("  Ann  van der Berg ")),
            ("Ann".to_owned(), "van der Berg".to_owned())
        );
    }
}
