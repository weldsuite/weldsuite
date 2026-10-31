//! Open shifts (`routes/weldhr/time.ts`, `services/weldhr/open-shifts.ts`):
//! shifts posted for anyone to sign up; a sign-up is a shift request a
//! manager approves, until the spots are taken.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_OPEN_SHIFT_CANCELLED, HR_OPEN_SHIFT_CREATED, HR_OPEN_SHIFT_UPDATED, HR_SHIFT_REQUEST_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ATTENDANCE_CREATE, ATTENDANCE_DELETE, ATTENDANCE_READ, ATTENDANCE_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::departments::department_lineage;
use crate::employees::require_employee;
use crate::fields::{Fields, id, int, iso_date_time, short_text, text_max};
use crate::timekeeping::{
    assert_shift_break, assert_shift_window, instant, iso, now_ms, resolve_instant, row_instant,
    work_type_value,
};
use crate::{Caller, HrError, HrResult, HrState, company_names, hr_json, js_trim, now, query_date, query_text, query_values, text};

pub(crate) const OPEN_SHIFT_FULL_NOTE: &str = "All spots on this shift were filled";
pub(crate) const OPEN_SHIFT_WITHDRAWN_NOTE: &str = "This open shift was withdrawn";

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/open-shifts", get(list).route_layer(gate.require([ATTENDANCE_READ])))
        .route("/open-shifts", post(create).route_layer(gate.require([ATTENDANCE_CREATE])))
        .route("/open-shifts/{id}", patch(update).route_layer(gate.require([ATTENDANCE_UPDATE])))
        .route("/open-shifts/{id}/cancel", post(cancel).route_layer(gate.require([ATTENDANCE_DELETE])))
}

/// `requireOpenShift(db, id)`.
pub(crate) async fn require_open_shift(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_open_shifts t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Open shift", id))
}

/// `openShiftCounts(db, ids)`: approved sign-ups whose shift still exists, and pending ones.
pub(crate) async fn open_shift_counts(db: &PgPool, ids: &[String]) -> Result<HashMap<String, (i64, i64)>, HrError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Option<String>, i64, i64)> = sqlx::query_as(
        "select r.open_shift_id,
                count(*) filter (where r.status = 'approved' and s.id is not null),
                count(*) filter (where r.status = 'pending')
         from hr_shift_requests r left join hr_shifts s on s.id = r.shift_id
         where r.open_shift_id = any($1) group by r.open_shift_id",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, filled, pending)| id.map(|id| (id, (filled, pending))))
        .collect())
}

/// Filled spots of one open shift.
pub(crate) async fn filled_of(db: &PgPool, id: &str) -> Result<i64, HrError> {
    Ok(open_shift_counts(db, &[id.to_owned()])
        .await?
        .get(id)
        .map_or(0, |counts| counts.0))
}

/// `withDetails(db, rows)`.
async fn with_details(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, HrError> {
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts = open_shift_counts(db, &ids).await?;
    let companies: Vec<Option<&str>> = rows.iter().map(|r| r["companyId"].as_str()).collect();
    let company_name = company_names(db, &companies).await?;
    let departments: Vec<String> = rows
        .iter()
        .filter_map(|r| r["departmentId"].as_str().filter(|d| !d.is_empty()).map(str::to_owned))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let department_name: HashMap<String, String> = if departments.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>("select id, name from hr_departments where id = any($1)")
            .bind(&departments)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect()
    };
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let (filled, pending) = counts.get(text(&row, "id")).copied().unwrap_or((0, 0));
            let spots = row["spots"].as_i64().unwrap_or(0);
            let company = row["companyId"].as_str().filter(|c| !c.is_empty()).and_then(|c| company_name.get(c).cloned());
            let department = row["departmentId"]
                .as_str()
                .filter(|d| !d.is_empty())
                .and_then(|d| department_name.get(d).cloned());
            if let Some(map) = row.as_object_mut() {
                map.insert("companyName".to_owned(), json!(company));
                map.insert("departmentName".to_owned(), json!(department));
                map.insert("filled".to_owned(), json!(filled));
                map.insert("pending".to_owned(), json!(pending));
                map.insert("spotsLeft".to_owned(), json!((spots - filled).max(0)));
            }
            row
        })
        .collect())
}

/// `listOpenShifts(db, filters)`.
async fn list_open_shifts(
    db: &PgPool,
    id: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_open_shifts t
         where ($1::text is null or t.id = $1)
           and ($2::text is null or t.starts_at >= $2::timestamptz)
           and ($3::text is null or t.starts_at <= $3::timestamptz)
           and ($4::text[] is null or t.status = any($4))
         order by t.starts_at asc limit 1000",
    )
    .bind(id)
    .bind(from.map(|f| format!("{f}T00:00:00Z")))
    .bind(to.map(|t| format!("{t}T23:59:59Z")))
    .bind(&statuses)
    .fetch_all(db)
    .await?;
    with_details(db, rows.into_iter().map(js_row).collect()).await
}

/// `openShiftWithDetails(db, id)`.
pub(crate) async fn open_shift_with_details(db: &PgPool, id: &str) -> Result<Value, HrError> {
    list_open_shifts(db, Some(id), None, None, None)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| HrError::not_found("Open shift", id))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_open_shifts(
        &caller.db,
        None,
        query_date(&q, "from").as_deref(),
        query_date(&q, "to").as_deref(),
        query_text(&q, "status").as_deref(),
    )
    .await?;
    Ok(Data(rows).into_response())
}

async fn assert_department(db: &PgPool, department_id: Option<&str>) -> Result<(), HrError> {
    let Some(department_id) = department_id.filter(|d| !d.is_empty()) else {
        return Ok(());
    };
    let found: Option<String> = sqlx::query_scalar("select id from hr_departments where id = $1 limit 1")
        .bind(department_id)
        .fetch_optional(db)
        .await?;
    if found.is_none() {
        return Err(HrError::not_found("Department", department_id));
    }
    Ok(())
}

struct OpenShiftInput {
    company_id: Field<String>,
    department_id: Field<String>,
    starts_at: Field<String>,
    ends_at: Field<String>,
    work_type: Field<String>,
    break_starts_at: Field<String>,
    break_ends_at: Field<String>,
    notes: Field<String>,
    spots: Field<f64>,
}

fn open_shift_input(issues: &mut Issues, fields: &Fields, partial: bool) -> OpenShiftInput {
    let required = if partial { Presence::Optional } else { Presence::Required };
    OpenShiftInput {
        company_id: id(issues, fields, "companyId", Presence::Nullish),
        department_id: id(issues, fields, "departmentId", Presence::Nullish),
        starts_at: iso_date_time(issues, fields, "startsAt", required),
        ends_at: iso_date_time(issues, fields, "endsAt", required),
        work_type: short_text(issues, fields, "workType", Presence::Nullish, 100, false),
        break_starts_at: iso_date_time(issues, fields, "breakStartsAt", Presence::Nullish),
        break_ends_at: iso_date_time(issues, fields, "breakEndsAt", Presence::Nullish),
        notes: text_max(issues, fields, "notes", Presence::Nullish, 1000),
        spots: int(issues, fields, "spots", Presence::Optional, Some(1.0), Some(100.0)),
    }
}

/// `notes?.trim() || null`.
fn notes_value(field: &Field<String>) -> Option<String> {
    field.as_set().map(|n| js_trim(n).to_owned()).filter(|n| !n.is_empty())
}

async fn create(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| open_shift_input(issues, fields, false))?;
    let db = &caller.db;
    let starts = input.starts_at.as_set().and_then(|s| instant(s)).unwrap_or(0);
    let ends = input.ends_at.as_set().and_then(|s| instant(s)).unwrap_or(0);
    assert_shift_window(starts, ends)?;
    if ends <= now_ms() {
        return Err(HrError::validation("An open shift has to end in the future"));
    }
    let bs = resolve_instant(&input.break_starts_at, None);
    let be = resolve_instant(&input.break_ends_at, None);
    assert_shift_break(starts, ends, bs, be)?;
    assert_department(db, input.department_id.as_set().map(String::as_str)).await?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_open_shifts (id, company_id, department_id, starts_at, ends_at, work_type,
             break_starts_at, break_ends_at, notes, spots, status, created_by)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::timestamptz, $8::timestamptz, $9,
                 $10::int, 'open', $11)
         returning to_jsonb(hr_open_shifts)",
    )
    .bind(generate_id("hrosh"))
    .bind(input.company_id.as_set())
    .bind(input.department_id.as_set())
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(work_type_value(&input.work_type))
    .bind(bs.map(iso))
    .bind(be.map(iso))
    .bind(notes_value(&input.notes))
    .bind(input.spots.as_set().map_or(1, |s| *s as i32))
    .bind(&caller.user_id)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let id = text(&row, "id").to_owned();
    caller.emit(&state, HR_OPEN_SHIFT_CREATED, &id, &[("status", Some(row["status"].clone()))]);
    Ok(Created(open_shift_with_details(db, &id).await?).into_response())
}

async fn update(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| open_shift_input(issues, fields, true))?;
    let db = &caller.db;
    let existing = require_open_shift(db, &id).await?;
    if existing["status"] == "cancelled" {
        return Err(HrError::conflict("This open shift was withdrawn"));
    }
    let old_starts = row_instant(&existing, "startsAt").unwrap_or(0);
    let old_ends = row_instant(&existing, "endsAt").unwrap_or(0);
    let starts = input.starts_at.as_set().filter(|s| !s.is_empty()).and_then(|s| instant(s)).unwrap_or(old_starts);
    let ends = input.ends_at.as_set().filter(|s| !s.is_empty()).and_then(|s| instant(s)).unwrap_or(old_ends);
    assert_shift_window(starts, ends)?;
    let bs = resolve_instant(&input.break_starts_at, row_instant(&existing, "breakStartsAt"));
    let be = resolve_instant(&input.break_ends_at, row_instant(&existing, "breakEndsAt"));
    assert_shift_break(starts, ends, bs, be)?;
    if !input.department_id.is_absent() {
        assert_department(db, input.department_id.as_set().map(String::as_str)).await?;
    }
    let filled = filled_of(db, &id).await?;
    let times_moved = starts != old_starts || ends != old_ends;
    if times_moved && filled > 0 {
        return Err(HrError::conflict(
            "Someone is already on this shift. Change their shift on the rooster instead.",
        ));
    }
    if let Some(spots) = input.spots.as_set()
        && *spots < filled as f64
    {
        return Err(HrError::validation(format!(
            "{filled} people are already on this shift, so it needs at least {filled} spots"
        )));
    }
    let now = now();
    let row: Value = sqlx::query_scalar(
        "update hr_open_shifts set
             company_id = case when $2 then $3 else company_id end,
             department_id = case when $4 then $5 else department_id end,
             work_type = case when $6 then $7 else work_type end,
             notes = case when $8 then $9 else notes end,
             spots = coalesce($10::int, spots),
             starts_at = $11::timestamptz, ends_at = $12::timestamptz,
             break_starts_at = $13::timestamptz, break_ends_at = $14::timestamptz,
             updated_at = $15::timestamp
         where id = $1 returning to_jsonb(hr_open_shifts)",
    )
    .bind(&id)
    .bind(!input.company_id.is_absent())
    .bind(input.company_id.as_set())
    .bind(!input.department_id.is_absent())
    .bind(input.department_id.as_set())
    .bind(!input.work_type.is_absent())
    .bind(work_type_value(&input.work_type))
    .bind(!input.notes.is_absent())
    .bind(notes_value(&input.notes))
    .bind(input.spots.as_set().map(|s| *s as i32))
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(bs.map(iso))
    .bind(be.map(iso))
    .bind(&now)
    .fetch_one(db)
    .await?;
    if times_moved {
        sqlx::query(
            "update hr_shift_requests set starts_at = $2::timestamptz, ends_at = $3::timestamptz,
                 updated_at = $4::timestamp
             where open_shift_id = $1 and status = 'pending'",
        )
        .bind(&id)
        .bind(iso(starts))
        .bind(iso(ends))
        .bind(&now)
        .execute(db)
        .await?;
    }
    let row = js_row(row);
    caller.emit(&state, HR_OPEN_SHIFT_UPDATED, text(&row, "id"), &[("status", Some(row["status"].clone()))]);
    Ok(Data(open_shift_with_details(db, &id).await?).into_response())
}

/// `closePendingRequests(db, openShiftId, status, note, by)`: the closed
/// requests' `(id, employeeId, status)`.
async fn close_pending_requests(
    db: &PgPool,
    open_shift_id: &str,
    status: &str,
    note: &str,
    by: &str,
) -> Result<Vec<(String, String, String)>, HrError> {
    Ok(sqlx::query_as(
        "update hr_shift_requests set status = $2, review_note = $3, reviewed_by = $4,
             reviewed_at = $5::timestamp, updated_at = $5::timestamp
         where open_shift_id = $1 and status = 'pending' returning id, employee_id, status",
    )
    .bind(open_shift_id)
    .bind(status)
    .bind(note)
    .bind(by)
    .bind(now())
    .fetch_all(db)
    .await?)
}

async fn cancel(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let existing = require_open_shift(db, &id).await?;
    if existing["status"] == "cancelled" {
        return Err(HrError::conflict("This open shift was already withdrawn"));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_open_shifts set status = 'cancelled', updated_at = $2::timestamp where id = $1
         returning to_jsonb(hr_open_shifts)",
    )
    .bind(&id)
    .bind(now())
    .fetch_one(db)
    .await?;
    let closed = close_pending_requests(db, &id, "cancelled", OPEN_SHIFT_WITHDRAWN_NOTE, &caller.user_id).await?;
    let row = js_row(row);
    caller.emit(&state, HR_OPEN_SHIFT_CANCELLED, text(&row, "id"), &[("status", Some(row["status"].clone()))]);
    for (request, employee, status) in &closed {
        caller.emit(
            &state,
            HR_SHIFT_REQUEST_UPDATED,
            request,
            &[("employeeId", Some(json!(employee))), ("status", Some(json!(status)))],
        );
    }
    Ok(Data(open_shift_with_details(db, &id).await?).into_response())
}

/// `settleOpenShift(db, openShiftId, by)`: the last spot taken turns down
/// whoever still waits for it.
pub(crate) async fn settle_open_shift(db: &PgPool, open_shift_id: &str, by: &str) -> Result<Vec<(String, String, String)>, HrError> {
    let shift = require_open_shift(db, open_shift_id).await?;
    let filled = filled_of(db, open_shift_id).await?;
    if filled < shift["spots"].as_i64().unwrap_or(0) {
        return Ok(Vec::new());
    }
    close_pending_requests(db, open_shift_id, "rejected", OPEN_SHIFT_FULL_NOTE, by).await
}

/// `assertOpenShiftHasSpot(db, openShiftId)`.
pub(crate) async fn assert_open_shift_has_spot(db: &PgPool, open_shift_id: &str) -> Result<Value, HrError> {
    let shift = require_open_shift(db, open_shift_id).await?;
    if shift["status"] == "cancelled" {
        return Err(HrError::conflict("This open shift was withdrawn"));
    }
    if filled_of(db, open_shift_id).await? >= shift["spots"].as_i64().unwrap_or(0) {
        return Err(HrError::conflict("All spots on this shift are filled"));
    }
    Ok(shift)
}

fn visible_to(shift: &Value, lineage: &HashSet<String>) -> bool {
    shift["departmentId"]
        .as_str()
        .filter(|d| !d.is_empty())
        .is_none_or(|d| lineage.contains(d))
}

/// `openShiftsForEmployee(db, employeeId)`.
pub(crate) async fn open_shifts_for_employee(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_open_shifts t where t.status = 'open' and t.starts_at > $1::timestamptz
         order by t.starts_at asc limit 500",
    )
    .bind(iso(now_ms()))
    .fetch_all(db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(js_row).filter(|r| visible_to(r, &lineage)).collect();
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let detailed = with_details(db, rows).await?;
    let mine: Vec<(String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "select id, open_shift_id, status, review_note from hr_shift_requests
         where employee_id = $1 and open_shift_id = any($2) order by created_at asc",
    )
    .bind(employee_id)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut my_request: HashMap<String, Value> = HashMap::new();
    for (id, open_shift, status, note) in mine {
        if let Some(open_shift) = open_shift {
            my_request.insert(open_shift, json!({ "id": id, "status": status, "reviewNote": note }));
        }
    }
    Ok(detailed
        .into_iter()
        .map(|row| {
            json!({
                "id": row["id"],
                "startsAt": row["startsAt"],
                "endsAt": row["endsAt"],
                "workType": row["workType"],
                "breakStartsAt": row["breakStartsAt"],
                "breakEndsAt": row["breakEndsAt"],
                "notes": row["notes"],
                "companyName": row["companyName"],
                "departmentName": row["departmentName"],
                "spots": row["spots"],
                "spotsLeft": row["spotsLeft"],
                "myRequest": my_request.get(text(&row, "id")).cloned().unwrap_or(Value::Null),
            })
        })
        .filter(|row| row["spotsLeft"].as_i64().unwrap_or(0) > 0 || !row["myRequest"].is_null())
        .collect())
}

/// `assertCanSignUp(db, employeeId, openShiftId)`.
pub(crate) async fn assert_can_sign_up(db: &PgPool, employee_id: &str, open_shift_id: &str) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let shift = require_open_shift(db, open_shift_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    if !visible_to(&shift, &lineage) {
        return Err(HrError::not_found("Open shift", open_shift_id));
    }
    if shift["status"] == "cancelled" {
        return Err(HrError::conflict("This open shift was withdrawn"));
    }
    if row_instant(&shift, "startsAt").unwrap_or(0) <= now_ms() {
        return Err(HrError::validation("This shift has already started"));
    }
    let already: Option<String> = sqlx::query_scalar(
        "select status from hr_shift_requests where employee_id = $1 and open_shift_id = $2
           and status in ('pending', 'approved') limit 1",
    )
    .bind(employee_id)
    .bind(open_shift_id)
    .fetch_optional(db)
    .await?;
    if let Some(status) = already {
        return Err(HrError::conflict(if status == "approved" {
            "You are already on this shift"
        } else {
            "You already signed up for this shift"
        }));
    }
    if filled_of(db, open_shift_id).await? >= shift["spots"].as_i64().unwrap_or(0) {
        return Err(HrError::conflict("All spots on this shift are filled"));
    }
    Ok(shift)
}
