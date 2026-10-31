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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_CLIENT_ASSIGNMENT_CREATED, HR_CLIENT_ASSIGNMENT_DELETED, HR_CLIENT_ASSIGNMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_READ, EMPLOYEES_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, change, id, iso_date, number, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, assert_date_order, company_names, hr_json, js_round,
    locale_compare, now, query_param, query_text, query_values, text, today_iso,
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
        .route("/clients", get(clients).route_layer(read()))
        .route("/clients/{company_id}", get(client).route_layer(read()))
}

/// `requireCompany(db, companyId)`: a live CRM company, `{ id, name }`.
pub(crate) async fn require_company(db: &PgPool, company_id: &str) -> Result<Value, HrError> {
    let row: Option<(String, String, bool)> = sqlx::query_as(
        "select id, display_name, deleted_at is not null from companies where id = $1 limit 1",
    )
    .bind(company_id)
    .fetch_optional(db)
    .await?;
    let Some((id, name, deleted)) = row else {
        return Err(HrError::not_found("Company", company_id));
    };
    if deleted {
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
async fn deleted_company_ids(db: &PgPool, company_ids: &[String]) -> Result<HashSet<String>, HrError> {
    if company_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "select id from companies where id = any($1) and deleted_at is not null",
    )
    .bind(company_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// `requireAssignment(db, id)`.
pub(crate) async fn require_assignment(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_client_assignments t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Assignment", id))
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
    let clash: Option<String> = sqlx::query_scalar(
        "select id from hr_client_assignments
         where employee_id = $1 and company_id = $2
           and (end_date is null or end_date >= $3::date)
           and ($4::text is null or start_date <= $4::date)
           and ($5::text is null or id <> $5)
         limit 1",
    )
    .bind(employee_id)
    .bind(company_id)
    .bind(start_date)
    .bind(end_date)
    .bind(except_id)
    .fetch_optional(db)
    .await?;
    if clash.is_some() {
        return Err(HrError::conflict(
            "This employee is already assigned to this client for (part of) these dates",
        ));
    }
    Ok(())
}

/// `listAssignments(db, filters)`.
pub(crate) async fn list_assignments(
    db: &PgPool,
    employee_id: Option<&str>,
    company_id: Option<&str>,
    active_only: bool,
) -> Result<Vec<Value>, HrError> {
    let today = today_iso();
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(a), jsonb_build_object('firstName', e.first_name, 'lastName', e.last_name,
                 'preferredName', e.preferred_name, 'jobTitle', e.job_title,
                 'avatarUrl', e.avatar_url, 'status', e.status)
         from hr_client_assignments a
         join hr_employees e on e.id = a.employee_id
         where e.deleted_at is null
           and ($1::text is null or a.employee_id = $1)
           and ($2::text is null or a.company_id = $2)
           and (not $3 or (a.start_date <= $4::date and (a.end_date is null or a.end_date >= $4::date)))
         order by a.start_date desc, e.last_name asc",
    )
    .bind(employee_id)
    .bind(company_id)
    .bind(active_only)
    .bind(&today)
    .fetch_all(db)
    .await?;
    let company_ids: Vec<String> = rows
        .iter()
        .map(|(a, _)| a["company_id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let refs: Vec<Option<&str>> = company_ids.iter().map(|id| Some(id.as_str())).collect();
    let names = company_names(db, &refs).await?;
    let mut unique = company_ids.clone();
    unique.sort();
    unique.dedup();
    let deleted = deleted_company_ids(db, &unique).await?;
    let mut out = Vec::with_capacity(rows.len());
    for (assignment, employee) in rows {
        let assignment = js_row(assignment);
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
            map.insert("employeeName".to_owned(), Value::String(display_name_of(&employee)));
            map.insert("employeeJobTitle".to_owned(), employee["jobTitle"].clone());
            map.insert("employeeAvatarUrl".to_owned(), employee["avatarUrl"].clone());
            map.insert("employeeStatus".to_owned(), employee["status"].clone());
            map.insert("isActive".to_owned(), Value::Bool(active));
        }
        out.push(row);
    }
    Ok(out)
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_assignments(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "companyId").as_deref(),
        query_param(&q, "active").as_deref() == Some("true"),
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
        allocation_percent: number(issues, fields, "allocationPercent", Presence::Optional, Some(0.0), Some(100.0)),
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
async fn clear_primary(db: &PgPool, employee_id: &str, except_id: Option<&str>) -> Result<(), HrError> {
    sqlx::query(
        "update hr_client_assignments set is_primary = false, updated_at = $3::timestamp
         where employee_id = $1 and is_primary = true and ($2::text is null or id <> $2)",
    )
    .bind(employee_id)
    .bind(except_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// The `hr_client_assignment` event data: `{ id, employeeId, companyId }`.
fn emit_assignment(caller: &Caller, state: &HrState, event: weldsuite_catalogs::entity_events::EventName, row: &Value) {
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

async fn create(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| assignment_input(issues, fields, false))?;
    let employee_id = input.employee_id.as_set().cloned().unwrap_or_default();
    let company_id = input.company_id.as_set().cloned().unwrap_or_default();
    let start_date = input.start_date.as_set().cloned().unwrap_or_default();
    let end_date = input.end_date.as_set().cloned();
    assert_date_order(Some(&start_date), end_date.as_deref(), "Assignment")?;
    let db = &caller.db;
    require_employee(db, &employee_id).await?;
    require_company(db, &company_id).await?;
    assert_no_overlapping_assignment(db, &employee_id, &company_id, &start_date, end_date.as_deref(), None).await?;
    if input.is_primary.as_set() == Some(&true) {
        clear_primary(db, &employee_id, None).await?;
    }
    let row: Value = sqlx::query_scalar(
        "insert into hr_client_assignments
             (id, employee_id, company_id, role, allocation_percent, is_primary, start_date, end_date, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10)
         returning to_jsonb(hr_client_assignments)",
    )
    .bind(generate_id("hrasg"))
    .bind(&employee_id)
    .bind(&company_id)
    .bind(input.role.as_set())
    .bind(input.allocation_percent.as_set().copied().unwrap_or(100.0))
    .bind(input.is_primary.as_set().copied().unwrap_or(false))
    .bind(&start_date)
    .bind(end_date.as_deref())
    .bind(input.notes.as_set())
    .bind(&caller.user_id)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
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
    let input = hr_json(&headers, &body, |issues, fields| assignment_input(issues, fields, true))?;
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
    let (set_role, role) = change(&input.role);
    let (set_alloc, alloc) = change(&input.allocation_percent);
    let (set_primary, primary) = change(&input.is_primary);
    let (set_start, start) = change(&input.start_date);
    let (set_end, end) = change(&input.end_date);
    let (set_notes, notes) = change(&input.notes);
    let row: Value = sqlx::query_scalar(
        "update hr_client_assignments set
             role = case when $2 then $3 else role end,
             allocation_percent = case when $4 then $5 else allocation_percent end,
             is_primary = case when $6 then $7 else is_primary end,
             start_date = case when $8 then $9::date else start_date end,
             end_date = case when $10 then $11::date else end_date end,
             notes = case when $12 then $13 else notes end,
             updated_at = $14::timestamp
         where id = $1 returning to_jsonb(hr_client_assignments)",
    )
    .bind(&id)
    .bind(set_role)
    .bind(role)
    .bind(set_alloc)
    .bind(alloc)
    .bind(set_primary)
    .bind(primary)
    .bind(set_start)
    .bind(start)
    .bind(set_end)
    .bind(end)
    .bind(set_notes)
    .bind(notes)
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit_assignment(&caller, &state, HR_CLIENT_ASSIGNMENT_UPDATED, &row);
    Ok(Data(row).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let existing = require_assignment(&caller.db, &id).await?;
    // deleteAssignment looks the row up again before deleting it.
    require_assignment(&caller.db, &id).await?;
    sqlx::query("delete from hr_client_assignments where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    emit_assignment(&caller, &state, HR_CLIENT_ASSIGNMENT_DELETED, &existing);
    Ok(NoContent.into_response())
}

/// `endAssignmentsFor(db, employeeId, endDate)`: end every open assignment.
pub(crate) async fn end_assignments_for(db: &PgPool, employee_id: &str, end_date: &str) -> Result<(), HrError> {
    sqlx::query(
        "update hr_client_assignments set end_date = $2::date, updated_at = $3::timestamp
         where employee_id = $1 and (end_date is null or end_date > $2::date)",
    )
    .bind(employee_id)
    .bind(end_date)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `listClientAccounts(db)`: client accounts with (or that had) anyone
/// assigned, with live headcount, by name.
pub(crate) async fn list_client_accounts(db: &PgPool) -> Result<Vec<Value>, HrError> {
    let today = today_iso();
    let rows: Vec<(String, i64, i64, f64)> = sqlx::query_as(
        "select a.company_id,
                count(*) filter (where a.start_date <= $1::date and (a.end_date is null or a.end_date >= $1::date)),
                count(distinct a.employee_id),
                (coalesce(sum(a.allocation_percent) filter (where a.start_date <= $1::date
                     and (a.end_date is null or a.end_date >= $1::date)), 0) / 100.0)::float8
         from hr_client_assignments a
         join hr_employees e on e.id = a.employee_id
         join companies c on c.id = a.company_id
         where e.deleted_at is null and c.deleted_at is null
         group by a.company_id",
    )
    .bind(&today)
    .fetch_all(db)
    .await?;
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
            entry.insert("fte".to_owned(), crate::js_number(js_round(fte * 100.0) / 100.0));
            (name.unwrap_or_default(), Value::Object(entry))
        })
        .collect();
    out.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(out.into_iter().map(|(_, row)| row).collect())
}

async fn clients(caller: Caller) -> HrResult {
    Ok(Data(list_client_accounts(&caller.db).await?).into_response())
}

async fn client(caller: Caller, Path(company_id): Path<String>) -> HrResult {
    let company = require_company(&caller.db, &company_id).await?;
    let assignments = list_assignments(&caller.db, None, Some(&company_id), false).await?;
    Ok(Data(json!({ "company": company, "assignments": assignments })).into_response())
}
