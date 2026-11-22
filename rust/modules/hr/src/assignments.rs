//! Client assignments and client accounts (`routes/weldhr/assignments.ts`,
//! `services/weldhr/assignments.ts`). A client account is a CRM company;
//! assignments are ended rather than deleted, so a client's team over time
//! stays readable.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Date, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    HR_CLIENT_ASSIGNMENT_CREATED, HR_CLIENT_ASSIGNMENT_DELETED, HR_CLIENT_ASSIGNMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_READ, EMPLOYEES_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{companies, hr_client_assignments as assignments, hr_employees};

use crate::employees::{display_name, no_row, pg_date, pg_date_opt, require_employee, to_json};
use crate::entity_scope::{Scope, guard, via_employee};
use crate::fields::{Fields, change, id, iso_date, number, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, assert_date_order, company_names, hr_json, js_round,
    locale_compare, query_param, query_text, query_values, text, today_iso,
};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([EMPLOYEES_READ]);
    let update = || gate.require([EMPLOYEES_UPDATE]);
    Router::new()
        .route("/assignments", get(list).route_layer(read()))
        .route("/assignments", post(create).route_layer(update()))
        .route("/assignments/{id}", patch(edit).route_layer(update()))
        .route("/assignments/{id}", delete(remove).route_layer(update()))
        .route_layer(guard(
            "/assignments",
            "Assignment",
            via_employee!("hr_client_assignments"),
        ))
        .route("/clients", get(clients).route_layer(read()))
        .route("/clients/{company_id}", get(client).route_layer(read()))
}

/// `requireCompany(db, companyId)`: a live CRM company, `{ id, name }`.
pub(crate) async fn require_company(db: &PgPool, company_id: &str) -> Result<Value, HrError> {
    let row: Option<(String, String, Option<PrimitiveDateTime>)> = companies::Entity::find()
        .select_only()
        .columns([
            companies::Column::Id,
            companies::Column::DisplayName,
            companies::Column::DeletedAt,
        ])
        .filter(companies::Column::Id.eq(company_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((id, name, deleted_at)) = row else {
        return Err(HrError::not_found("Company", company_id));
    };
    if deleted_at.is_some() {
        let label = if name.is_empty() {
            "This company"
        } else {
            name.as_str()
        };
        return Err(HrError::not_found_message(
            "Company",
            company_id,
            &format!("{label} was deleted in WeldCRM"),
        ));
    }
    Ok(json!({ "id": id, "name": name }))
}

/// `deletedCompanyIds(db, companyIds)`.
async fn deleted_company_ids(
    db: &PgPool,
    company_ids: &[String],
) -> Result<HashSet<String>, HrError> {
    if company_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = companies::Entity::find()
        .select_only()
        .column(companies::Column::Id)
        .filter(companies::Column::Id.is_in(company_ids.iter().map(String::as_str)))
        .filter(companies::Column::DeletedAt.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}

/// `requireAssignment(db, id)`.
pub(crate) async fn require_assignment(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = assignments::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Assignment", id))?)
}

fn is_active(row: &Value, on: &str) -> bool {
    text(row, "startDate") <= on && row["endDate"].as_str().is_none_or(|end| end >= on)
}

/// `assertNoOverlappingAssignment`.
async fn assert_no_overlapping_assignment(
    db: &PgPool,
    employee_id: &str,
    company_id: &str,
    start_date: &str,
    end_date: Option<&str>,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let start_date = pg_date(start_date)?;
    let end_date = pg_date_opt(end_date)?;
    let mut clash = assignments::Entity::find()
        .select_only()
        .column(assignments::Column::Id)
        .filter(assignments::Column::EmployeeId.eq(employee_id))
        .filter(assignments::Column::CompanyId.eq(company_id))
        .filter(
            Condition::any()
                .add(assignments::Column::EndDate.is_null())
                .add(assignments::Column::EndDate.gte(start_date)),
        );
    if let Some(end_date) = end_date {
        clash = clash.filter(assignments::Column::StartDate.lte(end_date));
    }
    if let Some(except_id) = except_id {
        clash = clash.filter(assignments::Column::Id.ne(except_id));
    }
    let clash: Option<String> = clash.into_tuple().one(&orm(db)).await?;
    if clash.is_some() {
        return Err(HrError::conflict(
            "This employee is already assigned to this client for (part of) these dates",
        ));
    }
    Ok(())
}

/// `listAssignments(db, filters)`; `scope` is the request's entity scope.
pub(crate) async fn list_assignments(
    db: &PgPool,
    employee_id: Option<&str>,
    company_id: Option<&str>,
    active_only: bool,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    let today = today_iso();
    let day = pg_date(&today)?;
    let mut select = assignments::Entity::find()
        .column_as(hr_employees::Column::FirstName, "employee_first_name")
        .column_as(hr_employees::Column::LastName, "employee_last_name")
        .column_as(
            hr_employees::Column::PreferredName,
            "employee_preferred_name",
        )
        .column_as(hr_employees::Column::JobTitle, "employee_job_title")
        .column_as(hr_employees::Column::AvatarUrl, "employee_avatar_url")
        .column_as(hr_employees::Column::Status, "employee_status")
        .join(JoinType::InnerJoin, with_employee())
        .filter(hr_employees::Column::DeletedAt.is_null());
    if let Some(employee_id) = employee_id {
        select = select.filter(assignments::Column::EmployeeId.eq(employee_id));
    }
    if let Some(company_id) = company_id {
        select = select.filter(assignments::Column::CompanyId.eq(company_id));
    }
    if active_only {
        select = select.filter(running_on(day));
    }
    let rows: Vec<AssignmentWithEmployee> = select
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_desc(assignments::Column::StartDate)
        .order_by_asc(hr_employees::Column::LastName)
        .into_model()
        .all(&orm(db))
        .await?;
    let company_ids: Vec<String> = rows
        .iter()
        .map(|row| row.assignment.company_id.clone())
        .collect();
    let refs: Vec<Option<&str>> = company_ids.iter().map(|id| Some(id.as_str())).collect();
    let names = company_names(db, &refs).await?;
    let mut unique = company_ids.clone();
    unique.sort();
    unique.dedup();
    let deleted = deleted_company_ids(db, &unique).await?;
    let mut out = Vec::with_capacity(rows.len());
    for employee in rows {
        let assignment = to_json(&employee.assignment)?;
        let company_id = text(&assignment, "companyId").to_owned();
        let company_deleted = deleted.contains(&company_id);
        let active = !company_deleted && is_active(&assignment, &today);
        if active_only && !active {
            continue;
        }
        let mut row = assignment;
        if let Some(map) = row.as_object_mut() {
            map.insert("companyName".to_owned(), json!(names.get(&company_id)));
            map.insert("companyDeleted".to_owned(), Value::Bool(company_deleted));
            map.insert(
                "employeeName".to_owned(),
                Value::String(display_name(
                    &employee.employee_first_name,
                    &employee.employee_last_name,
                    employee.employee_preferred_name.as_deref(),
                )),
            );
            map.insert(
                "employeeJobTitle".to_owned(),
                json!(employee.employee_job_title),
            );
            map.insert(
                "employeeAvatarUrl".to_owned(),
                json!(employee.employee_avatar_url),
            );
            map.insert("employeeStatus".to_owned(), json!(employee.employee_status));
            map.insert("isActive".to_owned(), Value::Bool(active));
        }
        out.push(row);
    }
    Ok(out)
}

/// `join hr_employees e on e.id = a.employee_id`.
fn with_employee() -> sea_orm::RelationDef {
    assignments::Entity::belongs_to(hr_employees::Entity)
        .from(assignments::Column::EmployeeId)
        .to(hr_employees::Column::Id)
        .into()
}

/// `a.start_date <= day and (a.end_date is null or a.end_date >= day)`.
fn running_on(day: Date) -> Condition {
    Condition::all()
        .add(assignments::Column::StartDate.lte(day))
        .add(
            Condition::any()
                .add(assignments::Column::EndDate.is_null())
                .add(assignments::Column::EndDate.gte(day)),
        )
}

/// An assignment with the employee columns the list shows
/// (`jsonb_build_object('firstName', e.first_name, …)`).
#[derive(Debug, FromQueryResult)]
struct AssignmentWithEmployee {
    #[sea_orm(nested)]
    assignment: assignments::Model,
    employee_first_name: String,
    employee_last_name: String,
    employee_preferred_name: Option<String>,
    employee_job_title: Option<String>,
    employee_avatar_url: Option<String>,
    employee_status: String,
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_assignments(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "companyId").as_deref(),
        query_param(&q, "active").as_deref() == Some("true"),
        &caller.scope().await?,
    )
    .await?;
    Ok(Data(rows).into_response())
}

struct AssignmentInput {
    employee_id: Field<String>,
    company_id: Field<String>,
    role: Field<String>,
    allocation_percent: Field<f64>,
    is_primary: Field<bool>,
    start_date: Field<String>,
    end_date: Field<String>,
    notes: Field<String>,
}

fn assignment_input(issues: &mut Issues, fields: &Fields, partial: bool) -> AssignmentInput {
    let (employee_id, company_id) = if partial {
        (Field::Absent, Field::Absent)
    } else {
        (
            id(issues, fields, "employeeId", Presence::Required),
            id(issues, fields, "companyId", Presence::Required),
        )
    };
    AssignmentInput {
        employee_id,
        company_id,
        role: short_text(issues, fields, "role", Presence::Nullish, 120, false),
        allocation_percent: number(
            issues,
            fields,
            "allocationPercent",
            Presence::Optional,
            Some(0.0),
            Some(100.0),
        ),
        is_primary: issues.boolean(fields, "isPrimary", Presence::Optional),
        start_date: iso_date(
            issues,
            fields,
            "startDate",
            if partial {
                Presence::Optional
            } else {
                Presence::Required
            },
        ),
        end_date: iso_date(issues, fields, "endDate", Presence::Nullish),
        notes: text_max(issues, fields, "notes", Presence::Nullish, 2000),
    }
}

/// `clearPrimary(db, employeeId, exceptId?)`.
async fn clear_primary(
    db: &PgPool,
    employee_id: &str,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let mut update = assignments::Entity::update_many()
        .col_expr(assignments::Column::IsPrimary, Expr::value(false))
        .col_expr(assignments::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(assignments::Column::EmployeeId.eq(employee_id))
        .filter(assignments::Column::IsPrimary.eq(true));
    if let Some(except_id) = except_id {
        update = update.filter(assignments::Column::Id.ne(except_id));
    }
    update.exec(&orm(db)).await?;
    Ok(())
}

/// The `hr_client_assignment` event data: `{ id, employeeId, companyId }`.
fn emit_assignment(
    caller: &Caller,
    state: &HrState,
    event: weldsuite_catalogs::entity_events::EventName,
    row: &Value,
) {
    caller.emit(
        state,
        event,
        text(row, "id"),
        &[
            ("employeeId", Some(row["employeeId"].clone())),
            ("companyId", Some(row["companyId"].clone())),
        ],
    );
}

async fn create(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        assignment_input(issues, fields, false)
    })?;
    let employee_id = input.employee_id.as_set().cloned().unwrap_or_default();
    caller.assert_employee_visible(Some(&employee_id)).await?;
    let company_id = input.company_id.as_set().cloned().unwrap_or_default();
    let start_date = input.start_date.as_set().cloned().unwrap_or_default();
    let end_date = input.end_date.as_set().cloned();
    assert_date_order(Some(&start_date), end_date.as_deref(), "Assignment")?;
    let db = &caller.db;
    require_employee(db, &employee_id).await?;
    require_company(db, &company_id).await?;
    assert_no_overlapping_assignment(
        db,
        &employee_id,
        &company_id,
        &start_date,
        end_date.as_deref(),
        None,
    )
    .await?;
    if input.is_primary.as_set() == Some(&true) {
        clear_primary(db, &employee_id, None).await?;
    }
    let row = assignments::Entity::insert(assignments::ActiveModel {
        id: Set(generate_id("hrasg")),
        employee_id: Set(employee_id),
        company_id: Set(company_id),
        role: Set(input.role.as_set().cloned()),
        allocation_percent: Set(input.allocation_percent.as_set().copied().unwrap_or(100.0)),
        is_primary: Set(input.is_primary.as_set().copied().unwrap_or(false)),
        start_date: Set(pg_date(&start_date)?),
        end_date: Set(pg_date_opt(end_date.as_deref())?),
        notes: Set(input.notes.as_set().cloned()),
        created_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let row = to_json(row)?;
    emit_assignment(&caller, &state, HR_CLIENT_ASSIGNMENT_CREATED, &row);
    Ok(Created(row).into_response())
}

async fn edit(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        assignment_input(issues, fields, true)
    })?;
    let db = &caller.db;
    let existing = require_assignment(db, &id).await?;
    let start_date = input
        .start_date
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&existing, "startDate").to_owned());
    let end_date: Option<String> = match &input.end_date {
        Field::Absent => existing["endDate"].as_str().map(str::to_owned),
        Field::Null => None,
        Field::Set(end) => Some(end.clone()),
    };
    assert_date_order(Some(&start_date), end_date.as_deref(), "Assignment")?;
    if !input.start_date.is_absent() || !input.end_date.is_absent() {
        assert_no_overlapping_assignment(
            db,
            text(&existing, "employeeId"),
            text(&existing, "companyId"),
            &start_date,
            end_date.as_deref(),
            Some(&id),
        )
        .await?;
    }
    if input.is_primary.as_set() == Some(&true) {
        clear_primary(db, text(&existing, "employeeId"), Some(&id)).await?;
    }
    let mut update = assignments::Entity::update_many();
    if let (true, role) = change(&input.role) {
        update = update.col_expr(assignments::Column::Role, Expr::value(role));
    }
    if let (true, alloc) = change(&input.allocation_percent) {
        update = update.col_expr(assignments::Column::AllocationPercent, Expr::value(alloc));
    }
    if let (true, primary) = change(&input.is_primary) {
        update = update.col_expr(assignments::Column::IsPrimary, Expr::value(primary));
    }
    if let (true, start) = change(&input.start_date) {
        let start = pg_date_opt(start.as_deref())?;
        update = update.col_expr(assignments::Column::StartDate, Expr::value(start));
    }
    if let (true, end) = change(&input.end_date) {
        let end = pg_date_opt(end.as_deref())?;
        update = update.col_expr(assignments::Column::EndDate, Expr::value(end));
    }
    if let (true, notes) = change(&input.notes) {
        update = update.col_expr(assignments::Column::Notes, Expr::value(notes));
    }
    let row = update
        .col_expr(assignments::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(assignments::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_client_assignments"))?;
    let row = to_json(row)?;
    emit_assignment(&caller, &state, HR_CLIENT_ASSIGNMENT_UPDATED, &row);
    Ok(Data(row).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let existing = require_assignment(&caller.db, &id).await?;
    // deleteAssignment looks the row up again before deleting it.
    require_assignment(&caller.db, &id).await?;
    assignments::Entity::delete_by_id(id.clone())
        .exec(&orm(&caller.db))
        .await?;
    emit_assignment(&caller, &state, HR_CLIENT_ASSIGNMENT_DELETED, &existing);
    Ok(NoContent.into_response())
}

/// `endAssignmentsFor(db, employeeId, endDate)`: end every open assignment.
pub(crate) async fn end_assignments_for(
    db: &PgPool,
    employee_id: &str,
    end_date: &str,
) -> Result<(), HrError> {
    let end_date = pg_date(end_date)?;
    assignments::Entity::update_many()
        .col_expr(assignments::Column::EndDate, Expr::value(end_date))
        .col_expr(assignments::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(assignments::Column::EmployeeId.eq(employee_id))
        .filter(
            Condition::any()
                .add(assignments::Column::EndDate.is_null())
                .add(assignments::Column::EndDate.gt(end_date)),
        )
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `listClientAccounts(db, entity)`: client accounts with (or that had)
/// anyone assigned, with live headcount, by name.
pub(crate) async fn list_client_accounts(
    db: &PgPool,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    let day = pg_date(&today_iso())?;
    let allocated = || {
        Expr::from(Func::sum(Expr::case(
            running_on(day),
            Expr::col((assignments::Entity, assignments::Column::AllocationPercent)),
        )))
    };
    // `coalesce(sum(…) filter (…), 0)`; divided by 100 below, as `::float8`.
    let rows: Vec<(String, i64, i64, f64)> = assignments::Entity::find()
        .select_only()
        .column(assignments::Column::CompanyId)
        .column_as(
            Expr::from(Func::count(Expr::case(running_on(day), 1))),
            "active",
        )
        .column_as(
            Expr::from(Func::count_distinct(Expr::col((
                assignments::Entity,
                assignments::Column::EmployeeId,
            )))),
            "total",
        )
        .column_as(
            Expr::from(Func::coalesce([allocated(), Expr::val(0.0_f64)])),
            "allocated",
        )
        .join(JoinType::InnerJoin, with_employee())
        .join(
            JoinType::InnerJoin,
            assignments::Entity::belongs_to(companies::Entity)
                .from(assignments::Column::CompanyId)
                .to(companies::Column::Id)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(companies::Column::DeletedAt.is_null())
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .group_by(assignments::Column::CompanyId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let rows: Vec<(String, i64, i64, f64)> = rows
        .into_iter()
        .map(|(company, active, total, allocated)| (company, active, total, allocated / 100.0))
        .collect();
    let refs: Vec<Option<&str>> = rows.iter().map(|row| Some(row.0.as_str())).collect();
    let names = company_names(db, &refs).await?;
    let mut out: Vec<(String, Value)> = rows
        .iter()
        .map(|(company_id, active, total, fte)| {
            let name = names.get(company_id).cloned();
            let mut entry = Map::new();
            entry.insert("companyId".to_owned(), json!(company_id));
            entry.insert("companyName".to_owned(), json!(name));
            entry.insert("activeCount".to_owned(), json!(active));
            entry.insert("totalCount".to_owned(), json!(total));
            entry.insert(
                "fte".to_owned(),
                crate::js_number(js_round(fte * 100.0) / 100.0),
            );
            (name.unwrap_or_default(), Value::Object(entry))
        })
        .collect();
    out.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(out.into_iter().map(|(_, row)| row).collect())
}

async fn clients(caller: Caller) -> HrResult {
    let scope = caller.scope().await?;
    Ok(Data(list_client_accounts(&caller.db, &scope).await?).into_response())
}

async fn client(caller: Caller, Path(company_id): Path<String>) -> HrResult {
    let company = require_company(&caller.db, &company_id).await?;
    let scope = caller.scope().await?;
    let assignments = list_assignments(&caller.db, None, Some(&company_id), false, &scope).await?;
    Ok(Data(json!({ "company": company, "assignments": assignments })).into_response())
}
