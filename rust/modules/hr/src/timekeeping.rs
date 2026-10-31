//! Shifts, attendance, leave types, allowances and requests
//! (`routes/weldhr/time.ts`, `services/weldhr/time.ts`). Instants are
//! milliseconds since the epoch, as JavaScript's `Date` holds them.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_ATTENDANCE_APPROVED, HR_ATTENDANCE_CREATED, HR_ATTENDANCE_DELETED, HR_ATTENDANCE_UPDATED,
    HR_LEAVE_REQUEST_APPROVED, HR_LEAVE_REQUEST_CREATED, HR_LEAVE_REQUEST_DELETED,
    HR_LEAVE_REQUEST_REJECTED, HR_LEAVE_REQUEST_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ATTENDANCE_APPROVE, ATTENDANCE_CREATE, ATTENDANCE_DELETE, ATTENDANCE_READ, ATTENDANCE_UPDATE,
    EMPLOYEES_MANAGE, EMPLOYEES_READ, LEAVE_APPROVE, LEAVE_CREATE, LEAVE_DELETE, LEAVE_READ,
    LEAVE_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, change, color, id, int, iso_date, iso_date_time, number, short_text, text_max};
use crate::work_locations::{ClockPlace, work_location_names};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, assert_date_order, company_names, employed_share_of_year,
    hr_json, js_number, js_round, member_names, now, number_text, query_date, query_param, query_text,
    query_values, text, today_iso, working_days_between, year_of,
};

const LATE_GRACE_MINUTES: f64 = 5.0;
const ATTENDANCE_STATUSES: [&str; 6] = ["present", "late", "absent", "excused", "remote", "half_day"];

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    Router::new()
        .route("/shifts", get(list_shifts_route).route_layer(gate.require([ATTENDANCE_READ])))
        .route("/shifts", post(create_shift_route).route_layer(gate.require([ATTENDANCE_CREATE])))
        .route("/shifts/{id}", patch(update_shift_route).route_layer(gate.require([ATTENDANCE_UPDATE])))
        .route("/shifts/{id}", delete(delete_shift_route).route_layer(gate.require([ATTENDANCE_DELETE])))
        .route("/attendance", get(list_attendance_route).route_layer(gate.require([ATTENDANCE_READ])))
        .route("/attendance/summary", get(summary_route).route_layer(gate.require([ATTENDANCE_READ])))
        .route("/attendance", post(create_attendance_route).route_layer(gate.require([ATTENDANCE_CREATE])))
        .route("/attendance/import", post(import_route).route_layer(gate.require([ATTENDANCE_CREATE])))
        .route("/attendance/approve", post(approve_route).route_layer(gate.require([ATTENDANCE_APPROVE])))
        .route("/attendance/{id}", patch(update_attendance_route).route_layer(gate.require([ATTENDANCE_UPDATE])))
        .route("/attendance/{id}", delete(delete_attendance_route).route_layer(gate.require([ATTENDANCE_DELETE])))
        .route("/leave-types", get(list_leave_types_route).route_layer(gate.require([LEAVE_READ, EMPLOYEES_READ])))
        .route("/leave-types", post(create_leave_type_route).route_layer(manage()))
        .route("/leave-types/{id}", patch(update_leave_type_route).route_layer(manage()))
        .route("/leave-types/{id}", delete(delete_leave_type_route).route_layer(manage()))
        .route(
            "/leave-allowances/balances/{employee_id}",
            get(balances_route).route_layer(gate.require([LEAVE_READ])),
        )
        .route("/leave-allowances", put(set_allowance_route).route_layer(gate.require([LEAVE_UPDATE])))
        .route("/leave-requests", get(list_leave_requests_route).route_layer(gate.require([LEAVE_READ])))
        .route("/leave-requests", post(create_leave_request_route).route_layer(gate.require([LEAVE_CREATE])))
        .route("/leave-requests/{id}/review", post(review_leave_route).route_layer(gate.require([LEAVE_APPROVE])))
        .route("/leave-requests/{id}/cancel", post(cancel_leave_route).route_layer(gate.require([LEAVE_UPDATE])))
        .route("/leave-requests/{id}", delete(delete_leave_route).route_layer(gate.require([LEAVE_DELETE])))
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/// `new Date(text).getTime()` for the ISO strings the schemas accept and
/// the rows hold: a date, a time with optional fraction (cut to
/// milliseconds) and an offset (`Z`, `+02`, `+0200`, `+02:00`).
pub(crate) fn instant(text: &str) -> Option<i64> {
    let (date, rest) = text.split_once('T')?;
    let day = crate::parse_date(date)?;
    let bytes = rest.as_bytes();
    let hour: i64 = rest.get(0..2)?.parse().ok()?;
    if bytes.get(2) != Some(&b':') {
        return None;
    }
    let minute: i64 = rest.get(3..5)?.parse().ok()?;
    let mut index = 5;
    let mut second = 0;
    let mut millis = 0;
    if bytes.get(5) == Some(&b':') {
        second = rest.get(6..8)?.parse().ok()?;
        index = 8;
        if bytes.get(8) == Some(&b'.') {
            let digits: String = rest[9..].chars().take_while(char::is_ascii_digit).collect();
            index = 9 + digits.len();
            let padded: String = digits.chars().chain("000".chars()).take(3).collect();
            millis = padded.parse().ok()?;
        }
    }
    let offset = &rest[index..];
    let offset_minutes: i64 = if offset == "Z" || offset.is_empty() {
        0
    } else {
        let sign = match offset.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
        let hours: i64 = digits.get(0..2)?.parse().ok()?;
        let minutes: i64 = digits.get(2..4).map_or(Some(0), |m| m.parse().ok())?;
        sign * (hours * 60 + minutes)
    };
    let days = (day - time::Date::from_calendar_date(1970, time::Month::January, 1).ok()?).whole_days();
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60) * 1000) + millis)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso(ms: i64) -> String {
    let at = time::OffsetDateTime::UNIX_EPOCH + time::Duration::milliseconds(ms);
    weldsuite_events::iso_timestamp(at)
}

/// `todayIso(new Date(ms))`.
pub(crate) fn date_of(ms: i64) -> String {
    iso(ms)[..10].to_owned()
}

/// A row's instant column.
pub(crate) fn row_instant(row: &Value, key: &str) -> Option<i64> {
    row[key].as_str().and_then(instant)
}

/// `employeeName(row)` over `employeeFirstName`/`LastName`/`PreferredName`.
fn employee_name_of(row: &Value) -> String {
    display_name_of(&json!({
        "firstName": row["employeeFirstName"],
        "lastName": row["employeeLastName"],
        "preferredName": row["employeePreferredName"],
    }))
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/// `listShifts(db, { from, to, employeeId, companyId })`.
pub(crate) async fn list_shifts(
    db: &PgPool,
    from: &str,
    to: &str,
    employee_id: Option<&str>,
    company_id: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(s), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name)
         from hr_shifts s join hr_employees e on e.id = s.employee_id
         where s.starts_at >= $1::timestamptz and s.starts_at <= $2::timestamptz and e.deleted_at is null
           and ($3::text is null or s.employee_id = $3)
           and ($4::text is null or s.company_id = $4)
         order by s.starts_at asc
         limit 2000",
    )
    .bind(format!("{from}T00:00:00Z"))
    .bind(format!("{to}T23:59:59Z"))
    .bind(employee_id)
    .bind(company_id)
    .fetch_all(db)
    .await?;
    let companies: Vec<Option<&str>> = rows.iter().map(|(s, _)| s["company_id"].as_str()).collect();
    let names = company_names(db, &companies).await?;
    Ok(rows
        .into_iter()
        .map(|(shift, names_row)| {
            let mut shift = js_row(shift);
            let company = shift["companyId"]
                .as_str()
                .filter(|c| !c.is_empty())
                .and_then(|c| names.get(c).cloned());
            if let Some(map) = shift.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&names_row)));
                map.insert("companyName".to_owned(), json!(company));
            }
            shift
        })
        .collect())
}

async fn require_shift(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_shifts t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Shift", id))
}

/// `assertShiftWindow(startsAt, endsAt)`.
pub(crate) fn assert_shift_window(starts: i64, ends: i64) -> Result<(), HrError> {
    if ends <= starts {
        return Err(HrError::validation("A shift must end after it starts"));
    }
    if ends - starts > 24 * 3600 * 1000 {
        return Err(HrError::validation("A shift cannot be longer than 24 hours"));
    }
    Ok(())
}

/// `assertNoOverlappingShift(db, employeeId, startsAt, endsAt, { exceptId, message })`.
pub(crate) async fn assert_no_overlapping_shift(
    db: &PgPool,
    employee_id: &str,
    starts: i64,
    ends: i64,
    except_id: Option<&str>,
    message: Option<&str>,
) -> Result<(), HrError> {
    let clash: Option<String> = sqlx::query_scalar(
        "select id from hr_shifts where employee_id = $1 and starts_at < $2::timestamptz
           and ends_at > $3::timestamptz and ($4::text is null or id <> $4) limit 1",
    )
    .bind(employee_id)
    .bind(iso(ends))
    .bind(iso(starts))
    .bind(except_id)
    .fetch_optional(db)
    .await?;
    if clash.is_some() {
        return Err(HrError::conflict(
            message.unwrap_or("This shift overlaps another shift of this employee"),
        ));
    }
    Ok(())
}

/// `assertShiftBreak(startsAt, endsAt, breakStartsAt, breakEndsAt)`.
pub(crate) fn assert_shift_break(
    starts: i64,
    ends: i64,
    break_starts: Option<i64>,
    break_ends: Option<i64>,
) -> Result<(), HrError> {
    match (break_starts, break_ends) {
        (None, None) => Ok(()),
        (Some(bs), Some(be)) => {
            if be <= bs {
                return Err(HrError::validation("A break must end after it starts"));
            }
            if bs < starts || be > ends {
                return Err(HrError::validation("A break must fall inside the shift"));
            }
            Ok(())
        }
        _ => Err(HrError::validation("A break needs both a start and an end time")),
    }
}

/// `resolveInstant(input, existing)`: absent keeps, null (or empty) clears.
pub(crate) fn resolve_instant(input: &Field<String>, existing: Option<i64>) -> Option<i64> {
    match input {
        Field::Absent => existing,
        Field::Null => None,
        Field::Set(text) => instant(text),
    }
}

/// `workType?.trim() || null`.
pub(crate) fn work_type_value(field: &Field<String>) -> Option<String> {
    field
        .as_set()
        .map(|w| crate::js_trim(w).to_owned())
        .filter(|w| !w.is_empty())
}

struct ShiftInput {
    employee_id: Field<String>,
    company_id: Field<String>,
    starts_at: Field<String>,
    ends_at: Field<String>,
    work_type: Field<String>,
    break_starts_at: Field<String>,
    break_ends_at: Field<String>,
    notes: Field<String>,
}

fn shift_input(issues: &mut Issues, fields: &Fields, partial: bool) -> ShiftInput {
    let required = if partial { Presence::Optional } else { Presence::Required };
    ShiftInput {
        employee_id: if partial { Field::Absent } else { id(issues, fields, "employeeId", Presence::Required) },
        company_id: id(issues, fields, "companyId", Presence::Nullish),
        starts_at: iso_date_time(issues, fields, "startsAt", required),
        ends_at: iso_date_time(issues, fields, "endsAt", required),
        work_type: short_text(issues, fields, "workType", Presence::Nullish, 100, false),
        break_starts_at: iso_date_time(issues, fields, "breakStartsAt", Presence::Nullish),
        break_ends_at: iso_date_time(issues, fields, "breakEndsAt", Presence::Nullish),
        notes: text_max(issues, fields, "notes", Presence::Nullish, 1000),
    }
}

/// What `createShift` writes besides the employee and the times.
pub(crate) struct ShiftDetails<'a> {
    pub(crate) company_id: Option<&'a str>,
    pub(crate) work_type: Option<String>,
    pub(crate) break_starts: Field<String>,
    pub(crate) break_ends: Field<String>,
    pub(crate) notes: Option<&'a str>,
}

/// `createShift(db, input, createdBy)`.
pub(crate) async fn create_shift(
    db: &PgPool,
    employee_id: &str,
    starts_at: &str,
    ends_at: &str,
    details: &ShiftDetails<'_>,
    created_by: &str,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let starts = instant(starts_at).unwrap_or(0);
    let ends = instant(ends_at).unwrap_or(0);
    assert_shift_window(starts, ends)?;
    let bs = resolve_instant(&details.break_starts, None);
    let be = resolve_instant(&details.break_ends, None);
    assert_shift_break(starts, ends, bs, be)?;
    assert_no_overlapping_shift(db, employee_id, starts, ends, None, None).await?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_shifts (id, employee_id, company_id, starts_at, ends_at, work_type,
             break_starts_at, break_ends_at, notes, created_by)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::timestamptz, $8::timestamptz, $9, $10)
         returning to_jsonb(hr_shifts)",
    )
    .bind(generate_id("hrshf"))
    .bind(employee_id)
    .bind(details.company_id)
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(&details.work_type)
    .bind(bs.map(iso))
    .bind(be.map(iso))
    .bind(details.notes)
    .bind(created_by)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

async fn list_shifts_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let from = query_date(&q, "from").unwrap_or_else(today_iso);
    let to = query_date(&q, "to").unwrap_or_else(|| add_days(&from, 6));
    if to < from || add_days(&from, 62) < to {
        return Err(HrError::bad_request("Pick a range of at most 62 days"));
    }
    let rows = list_shifts(
        &caller.db,
        &from,
        &to,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "companyId").as_deref(),
    )
    .await?;
    Ok(Data(rows).into_response())
}

async fn create_shift_route(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| shift_input(issues, fields, false))?;
    let details = ShiftDetails {
        company_id: input.company_id.as_set().map(String::as_str),
        work_type: work_type_value(&input.work_type),
        break_starts: input.break_starts_at.clone(),
        break_ends: input.break_ends_at.clone(),
        notes: input.notes.as_set().map(String::as_str),
    };
    let row = create_shift(
        &caller.db,
        input.employee_id.as_set().map_or("", String::as_str),
        input.starts_at.as_set().map_or("", String::as_str),
        input.ends_at.as_set().map_or("", String::as_str),
        &details,
        &caller.user_id,
    )
    .await?;
    Ok(Created(row).into_response())
}

async fn update_shift_route(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| shift_input(issues, fields, true))?;
    let db = &caller.db;
    let existing = require_shift(db, &id).await?;
    let pick = |field: &Field<String>, key: &str| {
        field
            .as_set()
            .filter(|s| !s.is_empty())
            .and_then(|s| instant(s))
            .or_else(|| row_instant(&existing, key))
            .unwrap_or(0)
    };
    let starts = pick(&input.starts_at, "startsAt");
    let ends = pick(&input.ends_at, "endsAt");
    assert_shift_window(starts, ends)?;
    let bs = resolve_instant(&input.break_starts_at, row_instant(&existing, "breakStartsAt"));
    let be = resolve_instant(&input.break_ends_at, row_instant(&existing, "breakEndsAt"));
    assert_shift_break(starts, ends, bs, be)?;
    assert_no_overlapping_shift(db, text(&existing, "employeeId"), starts, ends, Some(&id), None).await?;
    let (set_company, company) = change(&input.company_id);
    let set_work = !input.work_type.is_absent();
    let (set_notes, notes) = change(&input.notes);
    let row: Value = sqlx::query_scalar(
        "update hr_shifts set
             company_id = case when $2 then $3 else company_id end,
             work_type = case when $4 then $5 else work_type end,
             notes = case when $6 then $7 else notes end,
             starts_at = $8::timestamptz, ends_at = $9::timestamptz,
             break_starts_at = $10::timestamptz, break_ends_at = $11::timestamptz,
             updated_at = $12::timestamp
         where id = $1 returning to_jsonb(hr_shifts)",
    )
    .bind(&id)
    .bind(set_company)
    .bind(company)
    .bind(set_work)
    .bind(work_type_value(&input.work_type))
    .bind(set_notes)
    .bind(notes)
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(bs.map(iso))
    .bind(be.map(iso))
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn delete_shift_route(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_shift(&caller.db, &id).await?;
    sqlx::query("delete from hr_shifts where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    Ok(NoContent.into_response())
}

/// `shiftFor(db, employeeId, date, shiftId)`.
async fn shift_for(db: &PgPool, employee_id: &str, date: &str, shift_id: Option<&str>) -> Result<Option<Value>, HrError> {
    if let Some(shift_id) = shift_id.filter(|s| !s.is_empty()) {
        let own: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from hr_shifts s where s.id = $1 and s.employee_id = $2
               and s.starts_at <= $3::timestamptz and s.ends_at > $4::timestamptz limit 1",
        )
        .bind(shift_id)
        .bind(employee_id)
        .bind(format!("{date}T23:59:59Z"))
        .bind(format!("{date}T00:00:00Z"))
        .fetch_optional(db)
        .await?;
        if let Some(own) = own {
            return Ok(Some(js_row(own)));
        }
    }
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from hr_shifts s where s.employee_id = $1
           and s.starts_at >= $2::timestamptz and s.starts_at <= $3::timestamptz
         order by s.starts_at asc limit 1",
    )
    .bind(employee_id)
    .bind(format!("{date}T00:00:00Z"))
    .bind(format!("{date}T23:59:59Z"))
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/// `workedMinutes(clockIn, clockOut, breakMinutes)`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn worked_minutes(clock_in: Option<i64>, clock_out: Option<i64>, break_minutes: f64) -> Option<f64> {
    let (Some(start), Some(end)) = (clock_in, clock_out) else {
        return None;
    };
    let minutes = js_round((end - start) as f64 / 60_000.0) - break_minutes;
    Some(minutes.max(0.0))
}

/// `lateMinutesFor(clockIn, shiftStart)`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn late_minutes_for(clock_in: Option<i64>, shift_start: Option<i64>) -> f64 {
    let (Some(clock_in), Some(start)) = (clock_in, shift_start) else {
        return 0.0;
    };
    let late = js_round((clock_in - start) as f64 / 60_000.0);
    if late > LATE_GRACE_MINUTES { late } else { 0.0 }
}

/// `assertAttendanceTimes(clockIn, clockOut, breakMinutes)`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn assert_attendance_times(clock_in: Option<i64>, clock_out: Option<i64>, break_minutes: f64) -> Result<(), HrError> {
    let (Some(start), Some(end)) = (clock_in, clock_out) else {
        return Ok(());
    };
    if end <= start {
        return Err(HrError::validation("Clock-out must be after clock-in"));
    }
    let span = (end - start) as f64 / 60_000.0;
    if span > 24.0 * 60.0 {
        return Err(HrError::validation("A record cannot span more than 24 hours"));
    }
    if break_minutes >= span {
        return Err(HrError::validation(
            "The break must be shorter than the time between clock-in and clock-out",
        ));
    }
    Ok(())
}

struct Derived {
    shift_id: Option<String>,
    company_id: Option<String>,
    worked: Option<f64>,
    late: f64,
    status: String,
}

/// The times and status `derive` works from (`merged`).
struct Merged<'a> {
    date: &'a str,
    clock_in: Option<i64>,
    clock_out: Option<i64>,
    break_minutes: f64,
    status: Option<&'a str>,
    shift_id: Option<&'a str>,
}

/// `derive(db, employeeId, merged, explicitStatus)`.
async fn derive(db: &PgPool, employee_id: &str, merged: &Merged<'_>, explicit_status: bool) -> Result<Derived, HrError> {
    assert_attendance_times(merged.clock_in, merged.clock_out, merged.break_minutes)?;
    let shift = shift_for(db, employee_id, merged.date, merged.shift_id).await?;
    let late = late_minutes_for(merged.clock_in, shift.as_ref().and_then(|s| row_instant(s, "startsAt")));
    let mut status = merged.status.unwrap_or("present").to_owned();
    if !explicit_status && merged.clock_in.is_some() {
        status = if late > 0.0 { "late" } else { "present" }.to_owned();
    }
    Ok(Derived {
        shift_id: shift
            .as_ref()
            .and_then(|s| s["id"].as_str().map(str::to_owned))
            .or_else(|| merged.shift_id.map(str::to_owned)),
        company_id: shift.as_ref().and_then(|s| s["companyId"].as_str().map(str::to_owned)),
        worked: worked_minutes(merged.clock_in, merged.clock_out, merged.break_minutes),
        late,
        status,
    })
}

/// `requireAttendance(db, id)`.
pub(crate) async fn require_attendance(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_attendance_records t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Attendance record", id))
}

/// `AttendanceFilters`.
#[derive(Default)]
pub(crate) struct AttendanceFilters {
    pub(crate) employee_id: Option<String>,
    pub(crate) company_id: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) unapproved: bool,
    pub(crate) limit: Option<f64>,
    pub(crate) cursor: Option<String>,
}

/// `listAttendance(db, filters)`: `(data, totalCount, hasMore, cursor)`.
pub(crate) async fn list_attendance(
    db: &PgPool,
    filters: &AttendanceFilters,
) -> Result<(Vec<Value>, i64, bool, Option<String>), HrError> {
    #[allow(clippy::cast_possible_truncation)]
    let limit = filters.limit.unwrap_or(100.0).min(500.0) as i64;
    let statuses: Option<Vec<String>> = filters
        .status
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let cursor: Option<(String, String)> = match filters.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(cursor) => sqlx::query_as("select date::text, id from hr_attendance_records where id = $1 limit 1")
            .bind(cursor)
            .fetch_optional(db)
            .await?,
        None => None,
    };
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(a), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name)
         from hr_attendance_records a join hr_employees e on e.id = a.employee_id
         where e.deleted_at is null
           and ($1::text is null or a.employee_id = $1)
           and ($2::text is null or a.company_id = $2)
           and ($3::text is null or a.date >= $3::date)
           and ($4::text is null or a.date <= $4::date)
           and ($5::text[] is null or a.status = any($5))
           and (not $6 or a.approved_at is null)
           and ($7::text is null or (a.date, a.id) < ($7::date, $8))
         order by a.date desc, a.id desc
         limit $9",
    )
    .bind(&filters.employee_id)
    .bind(&filters.company_id)
    .bind(&filters.from)
    .bind(&filters.to)
    .bind(&statuses)
    .bind(filters.unapproved)
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from hr_attendance_records a join hr_employees e on e.id = a.employee_id
         where e.deleted_at is null
           and ($1::text is null or a.employee_id = $1)
           and ($2::text is null or a.company_id = $2)
           and ($3::text is null or a.date >= $3::date)
           and ($4::text is null or a.date <= $4::date)
           and ($5::text[] is null or a.status = any($5))
           and (not $6 or a.approved_at is null)",
    )
    .bind(&filters.employee_id)
    .bind(&filters.company_id)
    .bind(&filters.from)
    .bind(&filters.to)
    .bind(&statuses)
    .bind(filters.unapproved)
    .fetch_one(db)
    .await?;
    let page_size = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > page_size;
    let page: Vec<(Value, Value)> = rows.into_iter().take(page_size).collect();
    let companies: Vec<Option<&str>> = page.iter().map(|(r, _)| r["company_id"].as_str()).collect();
    let approvers: Vec<Option<&str>> = page.iter().map(|(r, _)| r["approved_by"].as_str()).collect();
    let places: Vec<Option<&str>> = page
        .iter()
        .flat_map(|(r, _)| [r["clock_in_location_id"].as_str(), r["clock_out_location_id"].as_str()])
        .collect();
    let company_name = company_names(db, &companies).await?;
    let approver_name = member_names(db, &approvers).await?;
    let place_name = work_location_names(db, &places).await?;
    let cursor_out = if has_more {
        page.last().map(|(r, _)| text(r, "id").to_owned())
    } else {
        None
    };
    let lookup = |map: &HashMap<String, String>, row: &Value, key: &str| -> Value {
        json!(row[key].as_str().filter(|v| !v.is_empty()).and_then(|v| map.get(v).cloned()))
    };
    let data = page
        .into_iter()
        .map(|(record, names_row)| {
            let mut record = js_row(record);
            let company = lookup(&company_name, &record, "companyId");
            let approver = lookup(&approver_name, &record, "approvedBy");
            let clock_in_place = lookup(&place_name, &record, "clockInLocationId");
            let clock_out_place = lookup(&place_name, &record, "clockOutLocationId");
            if let Some(map) = record.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&names_row)));
                map.insert("companyName".to_owned(), company);
                map.insert("approvedByName".to_owned(), approver);
                map.insert("clockInLocationName".to_owned(), clock_in_place);
                map.insert("clockOutLocationName".to_owned(), clock_out_place);
            }
            record
        })
        .collect();
    Ok((data, total, has_more, cursor_out))
}

/// What an attendance write sets (`AttendanceWrite`).
#[derive(Default, Clone)]
pub(crate) struct AttendanceWrite {
    pub(crate) company_id: Field<String>,
    pub(crate) date: Field<String>,
    pub(crate) clock_in: Field<String>,
    pub(crate) clock_out: Field<String>,
    pub(crate) break_minutes: Field<f64>,
    pub(crate) status: Field<String>,
    pub(crate) notes: Field<String>,
}

/// How `createAttendance` records a row (`opts`).
#[derive(Default)]
pub(crate) struct AttendanceOrigin<'a> {
    pub(crate) source: Option<&'a str>,
    pub(crate) shift_id: Option<&'a str>,
    pub(crate) place: Option<&'a ClockPlace>,
}

/// An instant field as `x ? new Date(x) : null`.
fn instant_of(field: &Field<String>) -> Option<i64> {
    field.as_set().filter(|c| !c.is_empty()).and_then(|c| instant(c))
}

/// `createAttendance(db, input, opts)`.
pub(crate) async fn create_attendance(
    db: &PgPool,
    employee_id: &str,
    date: &str,
    input: &AttendanceWrite,
    created_by: &str,
    origin: &AttendanceOrigin<'_>,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let clock_in = instant_of(&input.clock_in);
    let clock_out = instant_of(&input.clock_out);
    let break_minutes = input.break_minutes.as_set().copied().unwrap_or(0.0);
    let status = input.status.as_set().map(String::as_str);
    let merged = Merged {
        date,
        clock_in,
        clock_out,
        break_minutes,
        status,
        shift_id: origin.shift_id,
    };
    let derived = derive(db, employee_id, &merged, status.is_some_and(|s| !s.is_empty())).await?;
    let company = input.company_id.as_set().cloned().or(derived.company_id.clone());
    let place = origin.place;
    let row: Value = sqlx::query_scalar(
        "insert into hr_attendance_records (id, employee_id, company_id, shift_id, date, clock_in, clock_out,
             break_minutes, worked_minutes, late_minutes, status, source, notes, clock_in_location_id,
             clock_in_latitude, clock_in_longitude, created_by)
         values ($1, $2, $3, $4, $5::date, $6::timestamptz, $7::timestamptz, $8::int, $9::int, $10::int,
                 $11, $12, $13, $14, $15, $16, $17)
         returning to_jsonb(hr_attendance_records)",
    )
    .bind(generate_id("hratt"))
    .bind(employee_id)
    .bind(company)
    .bind(&derived.shift_id)
    .bind(date)
    .bind(clock_in.map(iso))
    .bind(clock_out.map(iso))
    .bind(int_of(break_minutes))
    .bind(derived.worked.map(int_of))
    .bind(int_of(derived.late))
    .bind(&derived.status)
    .bind(origin.source.unwrap_or("manual"))
    .bind(input.notes.as_set())
    .bind(place.and_then(|p| p.location_id.clone()))
    .bind(place.and_then(|p| p.latitude))
    .bind(place.and_then(|p| p.longitude))
    .bind(created_by)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

#[allow(clippy::cast_possible_truncation)]
fn int_of(x: f64) -> i32 {
    x as i32
}

/// `updateAttendance(db, id, input, { clockOutPlace })`.
pub(crate) async fn update_attendance(
    db: &PgPool,
    id: &str,
    input: &AttendanceWrite,
    clock_out_place: Option<&ClockPlace>,
) -> Result<Value, HrError> {
    let existing = require_attendance(db, id).await?;
    let date = input
        .date
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&existing, "date").to_owned());
    let next = |field: &Field<String>, key: &str| match field {
        Field::Absent => row_instant(&existing, key),
        Field::Null => None,
        Field::Set(value) if value.is_empty() => None,
        Field::Set(value) => instant(value),
    };
    let clock_in = next(&input.clock_in, "clockIn");
    let clock_out = next(&input.clock_out, "clockOut");
    let break_minutes = input
        .break_minutes
        .as_set()
        .copied()
        .unwrap_or_else(|| existing["breakMinutes"].as_f64().unwrap_or(0.0));
    let times_changed = !input.clock_in.is_absent() || !input.clock_out.is_absent() || !input.date.is_absent();
    let status = input
        .status
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&existing, "status").to_owned());
    let explicit = input.status.as_set().is_some_and(|s| !s.is_empty()) || !times_changed;
    let merged = Merged {
        date: &date,
        clock_in,
        clock_out,
        break_minutes,
        status: Some(&status),
        shift_id: existing["shiftId"].as_str(),
    };
    let derived = derive(db, text(&existing, "employeeId"), &merged, explicit).await?;
    let keep = |field: &Field<String>, key: &str| match field {
        Field::Absent => existing[key].as_str().map(str::to_owned),
        Field::Null => None,
        Field::Set(value) => Some(value.clone()),
    };
    let row: Value = sqlx::query_scalar(
        "update hr_attendance_records set company_id = $2, date = $3::date, clock_in = $4::timestamptz,
             clock_out = $5::timestamptz, break_minutes = $6::int, notes = $7, shift_id = $8,
             worked_minutes = $9::int, late_minutes = $10::int, status = $11,
             clock_out_location_id = case when $12 then $13 else clock_out_location_id end,
             clock_out_latitude = case when $12 then $14 else clock_out_latitude end,
             clock_out_longitude = case when $12 then $15 else clock_out_longitude end,
             approved_at = null, approved_by = null, updated_at = $16::timestamp
         where id = $1 returning to_jsonb(hr_attendance_records)",
    )
    .bind(id)
    .bind(keep(&input.company_id, "companyId"))
    .bind(&date)
    .bind(clock_in.map(iso))
    .bind(clock_out.map(iso))
    .bind(int_of(break_minutes))
    .bind(keep(&input.notes, "notes"))
    .bind(&derived.shift_id)
    .bind(derived.worked.map(int_of))
    .bind(int_of(derived.late))
    .bind(&derived.status)
    .bind(clock_out_place.is_some())
    .bind(clock_out_place.and_then(|p| p.location_id.clone()))
    .bind(clock_out_place.and_then(|p| p.latitude))
    .bind(clock_out_place.and_then(|p| p.longitude))
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

fn attendance_write(issues: &mut Issues, fields: &Fields, partial: bool) -> AttendanceWrite {
    AttendanceWrite {
        company_id: id(issues, fields, "companyId", Presence::Nullish),
        date: iso_date(issues, fields, "date", if partial { Presence::Optional } else { Presence::Required }),
        clock_in: iso_date_time(issues, fields, "clockIn", Presence::Nullish),
        clock_out: iso_date_time(issues, fields, "clockOut", Presence::Nullish),
        break_minutes: int(issues, fields, "breakMinutes", Presence::Optional, Some(0.0), Some(1440.0)),
        status: issues.choice(fields, "status", Presence::Optional, &ATTENDANCE_STATUSES),
        notes: text_max(issues, fields, "notes", Presence::Nullish, 2000),
    }
}

fn emit_attendance(caller: &Caller, state: &HrState, event: weldsuite_catalogs::entity_events::EventName, row: &Value) {
    caller.emit(
        state,
        event,
        text(row, "id"),
        &[
            ("employeeId", Some(row["employeeId"].clone())),
            ("status", Some(row["status"].clone())),
        ],
    );
}

async fn list_attendance_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let filters = AttendanceFilters {
        employee_id: query_text(&q, "employeeId"),
        company_id: query_text(&q, "companyId"),
        from: query_date(&q, "from"),
        to: query_date(&q, "to"),
        status: query_text(&q, "status"),
        unapproved: query_param(&q, "unapproved").as_deref() == Some("true"),
        limit: query_text(&q, "limit").map(|l| crate::js_number_of(&l)),
        cursor: query_text(&q, "cursor"),
    };
    let (data, total, has_more, cursor) = list_attendance(&caller.db, &filters).await?;
    Ok(List::new(data, Pagination::new(u64::try_from(total).unwrap_or_default(), has_more, cursor)).into_response())
}

/// `attendanceSummary(db, filters)`.
pub(crate) async fn attendance_summary(
    db: &PgPool,
    from: &str,
    to: &str,
    employee_ids: Option<&[String]>,
    company_id: Option<&str>,
) -> Result<Value, HrError> {
    if employee_ids.is_some_and(<[String]>::is_empty) {
        return Ok(json!({ "records": 0, "workedMinutes": 0, "lateMinutes": 0, "byStatus": {}, "attendanceRate": null }));
    }
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "select status, count(*), coalesce(sum(worked_minutes), 0)::bigint, coalesce(sum(late_minutes), 0)::bigint
         from hr_attendance_records
         where date >= $1::date and date <= $2::date
           and ($3::text[] is null or employee_id = any($3))
           and ($4::text is null or company_id = $4)
         group by status",
    )
    .bind(from)
    .bind(to)
    .bind(employee_ids.map(<[String]>::to_vec))
    .bind(company_id)
    .fetch_all(db)
    .await?;
    let mut by_status = Map::new();
    let (mut records, mut worked, mut late) = (0i64, 0i64, 0i64);
    for (status, count, w, l) in &rows {
        by_status.insert(status.clone(), json!(count));
        records += count;
        worked += w;
        late += l;
    }
    let absent = by_status.get("absent").and_then(Value::as_i64).unwrap_or(0);
    #[allow(clippy::cast_precision_loss)]
    let rate = (records != 0).then(|| js_number(js_round(((records - absent) as f64 / records as f64) * 1000.0) / 10.0));
    Ok(json!({
        "records": records,
        "workedMinutes": worked,
        "lateMinutes": late,
        "byStatus": by_status,
        "attendanceRate": rate,
    }))
}

async fn summary_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let to = query_date(&q, "to").unwrap_or_else(today_iso);
    let from = query_date(&q, "from").unwrap_or_else(|| add_days(&to, -29));
    let employee_ids = query_text(&q, "employeeId").map(|e| vec![e]);
    let summary = attendance_summary(
        &caller.db,
        &from,
        &to,
        employee_ids.as_deref(),
        query_text(&q, "companyId").as_deref(),
    )
    .await?;
    Ok(Data(summary).into_response())
}

async fn create_attendance_route(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (employee_id, write) = hr_json(&headers, &body, |issues, fields| {
        let employee = id(issues, fields, "employeeId", Presence::Required);
        (employee, attendance_write(issues, fields, false))
    })?;
    let date = write.date.as_set().cloned().unwrap_or_default();
    let row = create_attendance(
        &caller.db,
        employee_id.as_set().map_or("", String::as_str),
        &date,
        &write,
        &caller.user_id,
        &AttendanceOrigin::default(),
    )
    .await?;
    emit_attendance(&caller, &state, HR_ATTENDANCE_CREATED, &row);
    Ok(Created(row).into_response())
}

async fn update_attendance_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let write = hr_json(&headers, &body, |issues, fields| attendance_write(issues, fields, true))?;
    let row = update_attendance(&caller.db, &id, &write, None).await?;
    emit_attendance(&caller, &state, HR_ATTENDANCE_UPDATED, &row);
    Ok(Data(row).into_response())
}

async fn delete_attendance_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_attendance(&caller.db, &id).await?;
    require_attendance(&caller.db, &id).await?;
    sqlx::query("delete from hr_attendance_records where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    caller.emit(
        &state,
        HR_ATTENDANCE_DELETED,
        text(&row, "id"),
        &[("employeeId", Some(row["employeeId"].clone()))],
    );
    Ok(NoContent.into_response())
}

async fn approve_route(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let ids = hr_json(&headers, &body, |issues, fields| {
        issues.list(fields, "ids", Presence::Required, Some(1), Some(1000), |issues, item| {
            issues.item_text(item, Text::length(Some(1), Some(30)))
        })
    })?;
    let ids = ids.into_option().unwrap_or_default();
    let approved: Vec<(String, String)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "update hr_attendance_records set approved_at = $3::timestamp, approved_by = $2, updated_at = $3::timestamp
             where id = any($1) and approved_at is null returning id, employee_id",
        )
        .bind(&ids)
        .bind(&caller.user_id)
        .bind(now())
        .fetch_all(&caller.db)
        .await?
    };
    for (id, employee) in &approved {
        caller.emit(&state, HR_ATTENDANCE_APPROVED, id, &[("employeeId", Some(json!(employee)))]);
    }
    Ok(Data(json!({ "approved": approved.len() })).into_response())
}

/// `resolveEmployeeRefs(db, refs)`: email (case-insensitive) or employee number → id.
pub(crate) async fn resolve_employee_refs(db: &PgPool, refs: &[String]) -> Result<HashMap<String, String>, HrError> {
    let mut unique: Vec<String> = Vec::new();
    for r in refs {
        let trimmed = crate::js_trim(r).to_owned();
        if !trimmed.is_empty() && !unique.contains(&trimmed) {
            unique.push(trimmed);
        }
    }
    let mut out = HashMap::new();
    if unique.is_empty() {
        return Ok(out);
    }
    let lowered: Vec<String> = unique.iter().map(|r| r.to_lowercase()).collect();
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, email, employee_number from hr_employees
         where deleted_at is null and (lower(email) = any($1) or employee_number = any($2))",
    )
    .bind(&lowered)
    .bind(&unique)
    .fetch_all(db)
    .await?;
    for (id, email, number) in rows {
        out.insert(email.to_lowercase(), id.clone());
        if let Some(number) = number.filter(|n| !n.is_empty()) {
            out.insert(number, id);
        }
    }
    Ok(out)
}

/// `err.message` of what a service threw.
pub(crate) fn error_message(error: &HrError) -> String {
    match error {
        HrError::NotFound { user_message: Some(m), .. } => m.clone(),
        HrError::NotFound { resource, id, .. } => format!("{resource} {id} not found"),
        HrError::Validation { message, .. } | HrError::Conflict(message) | HrError::Payroll { message, .. } => {
            message.clone()
        }
        HrError::Database(error) => error.to_string(),
        HrError::Internal(reason) => reason.clone(),
        HrError::Response(_) => String::new(),
    }
}

/// One `importHrAttendanceSchema` row.
struct ImportRow {
    employee: String,
    date: String,
    clock_in: Field<String>,
    clock_out: Field<String>,
    break_minutes: Field<f64>,
    status: Field<String>,
    notes: Field<String>,
}

fn import_row(issues: &mut Issues, item: &Value) -> Option<ImportRow> {
    let fields = issues.object(item)?;
    let employee = issues.text(fields, "employee", Presence::Required, Some(1), Some(255));
    let date = iso_date(issues, fields, "date", Presence::Required);
    let clock_in = iso_date_time(issues, fields, "clockIn", Presence::Nullish);
    let clock_out = iso_date_time(issues, fields, "clockOut", Presence::Nullish);
    let break_minutes = int(issues, fields, "breakMinutes", Presence::Optional, Some(0.0), Some(1440.0));
    let status = issues.choice(fields, "status", Presence::Optional, &ATTENDANCE_STATUSES);
    let notes = text_max(issues, fields, "notes", Presence::Nullish, 2000);
    Some(ImportRow {
        employee: employee.into_option()?,
        date: date.into_option()?,
        clock_in,
        clock_out,
        break_minutes,
        status,
        notes,
    })
}

/// `importAttendanceRow`: `true` when it updated the day's imported record.
async fn import_attendance_row(
    db: &PgPool,
    employee_id: &str,
    row: ImportRow,
    created_by: &str,
    dry_run: bool,
) -> Result<bool, HrError> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from hr_attendance_records where employee_id = $1 and date = $2::date and source = 'import' limit 1",
    )
    .bind(employee_id)
    .bind(&row.date)
    .fetch_optional(db)
    .await?;
    if dry_run {
        assert_attendance_times(
            instant_of(&row.clock_in),
            instant_of(&row.clock_out),
            row.break_minutes.as_set().copied().unwrap_or(0.0),
        )?;
        return Ok(existing.is_some());
    }
    // `clockIn: row.clockIn ?? null`: an absent time is written as null.
    let null_if_absent = |field: Field<String>| match field {
        Field::Absent => Field::Null,
        other => other,
    };
    let write = AttendanceWrite {
        company_id: Field::Absent,
        date: Field::Absent,
        clock_in: null_if_absent(row.clock_in),
        clock_out: null_if_absent(row.clock_out),
        break_minutes: row.break_minutes,
        status: row.status,
        notes: null_if_absent(row.notes),
    };
    if let Some(existing) = existing {
        update_attendance(db, &existing, &write, None).await?;
        return Ok(true);
    }
    let origin = AttendanceOrigin { source: Some("import"), ..AttendanceOrigin::default() };
    create_attendance(db, employee_id, &row.date, &write, created_by, &origin).await?;
    Ok(false)
}

async fn import_route(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (rows, dry_run) = hr_json(&headers, &body, |issues, fields| {
        let rows = issues.list(fields, "rows", Presence::Required, Some(1), Some(5000), import_row);
        (rows, issues.boolean(fields, "dryRun", Presence::Optional))
    })?;
    let rows = rows.into_option().unwrap_or_default();
    let dry_run = dry_run.as_set() == Some(&true);
    let db = &caller.db;
    let refs: Vec<String> = rows.iter().map(|r| r.employee.clone()).collect();
    let resolved = resolve_employee_refs(db, &refs).await?;
    let (mut created, mut updated) = (0, 0);
    let mut errors: Vec<Value> = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let trimmed = crate::js_trim(&row.employee).to_owned();
        let Some(employee_id) = resolved
            .get(&trimmed.to_lowercase())
            .or_else(|| resolved.get(&trimmed))
            .cloned()
        else {
            errors.push(json!({ "row": index + 1, "reason": format!("No employee matches \"{}\"", row.employee) }));
            continue;
        };
        match import_attendance_row(db, &employee_id, row, &caller.user_id, dry_run).await {
            Ok(true) => updated += 1,
            Ok(false) => created += 1,
            Err(error) => errors.push(json!({ "row": index + 1, "reason": error_message(&error) })),
        }
    }
    Ok(Data(json!({ "created": created, "updated": updated, "errors": errors })).into_response())
}

/// The shift a self-service clock picks (`clockableShift`).
async fn clockable_shift(db: &PgPool, employee_id: &str, shift_id: &str, now_ms: i64) -> Result<Value, HrError> {
    let shift: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from hr_shifts s where s.id = $1 and s.employee_id = $2 limit 1",
    )
    .bind(shift_id)
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let Some(shift) = shift.map(js_row) else {
        return Err(HrError::not_found("Shift", shift_id));
    };
    if row_instant(&shift, "endsAt").unwrap_or(0) <= now_ms {
        return Err(HrError::validation("That shift has already ended"));
    }
    if date_of(row_instant(&shift, "startsAt").unwrap_or(0)) > date_of(now_ms) {
        return Err(HrError::validation("That shift is not today"));
    }
    Ok(shift)
}

/// `currentShift(db, employeeId, now)`.
async fn current_shift(db: &PgPool, employee_id: &str, now_ms: i64) -> Result<Option<Value>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from hr_shifts s where s.employee_id = $1 and s.ends_at > $2::timestamptz
           and s.starts_at <= $3::timestamptz order by s.starts_at asc limit 1",
    )
    .bind(employee_id)
    .bind(iso(now_ms))
    .bind(format!("{}T23:59:59Z", date_of(now_ms)))
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `openClockRecord(db, employeeId)`.
pub(crate) async fn open_clock_record(db: &PgPool, employee_id: &str) -> Result<Option<Value>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from hr_attendance_records a where a.employee_id = $1 and a.clock_out is null
           and a.clock_in is not null order by a.clock_in desc limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The current instant in milliseconds.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `clock(db, employeeId, action, now, createdBy, shiftId, place)`.
pub(crate) async fn clock(
    db: &PgPool,
    employee_id: &str,
    action: &str,
    now_ms: i64,
    created_by: &str,
    shift_id: Option<&str>,
    place: &ClockPlace,
) -> Result<Value, HrError> {
    let today = date_of(now_ms);
    let open = open_clock_record(db, employee_id).await?;
    if action == "in" {
        if open.is_some() {
            return Err(HrError::conflict("You are already clocked in"));
        }
        let shift = match shift_id {
            Some(shift_id) => Some(clockable_shift(db, employee_id, shift_id, now_ms).await?),
            None => current_shift(db, employee_id, now_ms).await?,
        };
        let write = AttendanceWrite {
            clock_in: Field::Set(iso(now_ms)),
            ..AttendanceWrite::default()
        };
        let origin = AttendanceOrigin {
            source: Some("portal"),
            shift_id: shift.as_ref().and_then(|s| s["id"].as_str()),
            place: Some(place),
        };
        return create_attendance(db, employee_id, &today, &write, created_by, &origin).await;
    }
    let Some(open) = open else {
        return Err(HrError::conflict("You are not clocked in"));
    };
    let write = AttendanceWrite {
        clock_out: Field::Set(iso(now_ms)),
        ..AttendanceWrite::default()
    };
    update_attendance(db, text(&open, "id"), &write, Some(place)).await
}

/// `switchShift(db, employeeId, shiftId, now, createdBy, place)`: `(closed, opened)`.
pub(crate) async fn switch_shift(
    db: &PgPool,
    employee_id: &str,
    shift_id: Option<&str>,
    now_ms: i64,
    created_by: &str,
    place: &ClockPlace,
) -> Result<(Value, Value), HrError> {
    let Some(shift_id) = shift_id.filter(|s| !s.is_empty()) else {
        return Err(HrError::validation("Pick the shift to switch to"));
    };
    let Some(open) = open_clock_record(db, employee_id).await? else {
        return Err(HrError::conflict("You are not clocked in"));
    };
    let shift = clockable_shift(db, employee_id, shift_id, now_ms).await?;
    if open["shiftId"] == shift["id"] {
        return Err(HrError::conflict("You are already on this shift"));
    }
    let closed = update_attendance(
        db,
        text(&open, "id"),
        &AttendanceWrite { clock_out: Field::Set(iso(now_ms)), ..AttendanceWrite::default() },
        Some(place),
    )
    .await?;
    let origin = AttendanceOrigin {
        source: Some("portal"),
        shift_id: shift["id"].as_str(),
        place: Some(place),
    };
    let opened = create_attendance(
        db,
        employee_id,
        &date_of(now_ms),
        &AttendanceWrite { clock_in: Field::Set(iso(now_ms)), ..AttendanceWrite::default() },
        created_by,
        &origin,
    )
    .await?;
    Ok((closed, opened))
}

// ---------------------------------------------------------------------------
// Leave types and allowances
// ---------------------------------------------------------------------------

/// `listLeaveTypes(db, includeInactive)`.
pub(crate) async fn list_leave_types(db: &PgPool, include_inactive: bool) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_leave_types t where ($1 or t.is_active = true) order by t.name asc",
    )
    .bind(include_inactive)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn require_leave_type(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_leave_types t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Leave type", id))
}

/// `ensureDefaultLeaveTypes(db)`: annual, sick and unpaid leave.
pub(crate) async fn ensure_default_leave_types(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_leave_types limit 1")
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    sqlx::query(
        "insert into hr_leave_types (id, name, color, is_paid, requires_approval, default_allowance_days) values
             ('hrlvt_default_annual', 'Annual leave', '#3b82f6', true, true, 20),
             ('hrlvt_default_sick', 'Sick leave', '#ef4444', true, false, null),
             ('hrlvt_default_unpaid', 'Unpaid leave', '#6b7280', false, true, null)
         on conflict do nothing",
    )
    .execute(db)
    .await?;
    Ok(())
}

async fn list_leave_types_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let include = query_param(&query_values(query.as_deref()), "includeInactive").as_deref() == Some("true");
    Ok(Data(list_leave_types(&caller.db, include).await?).into_response())
}

struct LeaveTypeInput {
    name: Field<String>,
    color: Field<String>,
    is_paid: Field<bool>,
    requires_approval: Field<bool>,
    default_allowance_days: Field<f64>,
    over_allowance: Field<String>,
    is_active: Field<bool>,
}

fn leave_type_input(issues: &mut Issues, fields: &Fields, partial: bool) -> LeaveTypeInput {
    LeaveTypeInput {
        name: short_text(issues, fields, "name", if partial { Presence::Optional } else { Presence::Required }, 120, true),
        color: color(issues, fields, "color"),
        is_paid: issues.boolean(fields, "isPaid", Presence::Optional),
        requires_approval: issues.boolean(fields, "requiresApproval", Presence::Optional),
        default_allowance_days: number(issues, fields, "defaultAllowanceDays", Presence::Nullish, Some(0.0), Some(366.0)),
        over_allowance: issues.choice(fields, "overAllowance", Presence::Optional, &["allow", "block"]),
        is_active: issues.boolean(fields, "isActive", Presence::Optional),
    }
}

async fn create_leave_type_route(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| leave_type_input(issues, fields, false))?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_leave_types (id, name, color, is_paid, requires_approval, default_allowance_days,
             over_allowance, is_active)
         values ($1, $2, $3, coalesce($4, true), coalesce($5, true), $6, coalesce($7, 'allow'), coalesce($8, true))
         returning to_jsonb(hr_leave_types)",
    )
    .bind(generate_id("hrlvt"))
    .bind(input.name.as_set())
    .bind(input.color.as_set())
    .bind(input.is_paid.as_set())
    .bind(input.requires_approval.as_set())
    .bind(input.default_allowance_days.as_set())
    .bind(input.over_allowance.as_set())
    .bind(input.is_active.as_set())
    .fetch_one(&caller.db)
    .await?;
    Ok(Created(js_row(row)).into_response())
}

async fn update_leave_type_route(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| leave_type_input(issues, fields, true))?;
    require_leave_type(&caller.db, &id).await?;
    let (set_name, name) = change(&input.name);
    let (set_color, color) = change(&input.color);
    let (set_paid, paid) = change(&input.is_paid);
    let (set_approval, approval) = change(&input.requires_approval);
    let (set_default, default) = change(&input.default_allowance_days);
    let (set_over, over) = change(&input.over_allowance);
    let (set_active, active) = change(&input.is_active);
    let row: Value = sqlx::query_scalar(
        "update hr_leave_types set
             name = case when $2 then $3 else name end,
             color = case when $4 then $5 else color end,
             is_paid = case when $6 then $7 else is_paid end,
             requires_approval = case when $8 then $9 else requires_approval end,
             default_allowance_days = case when $10 then $11 else default_allowance_days end,
             over_allowance = case when $12 then $13 else over_allowance end,
             is_active = case when $14 then $15 else is_active end,
             updated_at = $16::timestamp
         where id = $1 returning to_jsonb(hr_leave_types)",
    )
    .bind(&id)
    .bind(set_name)
    .bind(name)
    .bind(set_color)
    .bind(color)
    .bind(set_paid)
    .bind(paid)
    .bind(set_approval)
    .bind(approval)
    .bind(set_default)
    .bind(default)
    .bind(set_over)
    .bind(over)
    .bind(set_active)
    .bind(active)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn delete_leave_type_route(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    require_leave_type(db, &id).await?;
    let used: Option<String> = sqlx::query_scalar("select id from hr_leave_requests where leave_type_id = $1 limit 1")
        .bind(&id)
        .fetch_optional(db)
        .await?;
    if used.is_some() {
        sqlx::query("update hr_leave_types set is_active = false, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(now())
            .execute(db)
            .await?;
        return Ok(Data(json!({ "archived": true })).into_response());
    }
    sqlx::query("delete from hr_leave_allowances where leave_type_id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    sqlx::query("delete from hr_leave_types where id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    Ok(Data(json!({ "archived": false })).into_response())
}

async fn set_allowance_route(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (employee, leave_type, year, days) = hr_json(&headers, &body, |issues, fields| {
        (
            id(issues, fields, "employeeId", Presence::Required),
            id(issues, fields, "leaveTypeId", Presence::Required),
            int(issues, fields, "year", Presence::Required, Some(2000.0), Some(2100.0)),
            number(issues, fields, "days", Presence::Required, Some(0.0), Some(366.0)),
        )
    })?;
    let db = &caller.db;
    let employee = employee.into_option().unwrap_or_default();
    let leave_type = leave_type.into_option().unwrap_or_default();
    let year = int_of(year.into_option().unwrap_or_default());
    let days = days.into_option().unwrap_or_default();
    require_employee(db, &employee).await?;
    require_leave_type(db, &leave_type).await?;
    let existing: Option<String> = sqlx::query_scalar(
        "select id from hr_leave_allowances where employee_id = $1 and leave_type_id = $2 and year = $3 limit 1",
    )
    .bind(&employee)
    .bind(&leave_type)
    .bind(year)
    .fetch_optional(db)
    .await?;
    let row: Value = if let Some(existing) = existing {
        sqlx::query_scalar(
            "update hr_leave_allowances set days = $2, updated_at = $3::timestamp where id = $1
             returning to_jsonb(hr_leave_allowances)",
        )
        .bind(&existing)
        .bind(days)
        .bind(now())
        .fetch_one(db)
        .await?
    } else {
        sqlx::query_scalar(
            "insert into hr_leave_allowances (id, employee_id, leave_type_id, year, days)
             values ($1, $2, $3, $4, $5) returning to_jsonb(hr_leave_allowances)",
        )
        .bind(generate_id("hrlva"))
        .bind(&employee)
        .bind(&leave_type)
        .bind(year)
        .bind(days)
        .fetch_one(db)
        .await?
    };
    Ok(Data(js_row(row)).into_response())
}

/// `leaveBalances(db, employeeId, year)`.
pub(crate) async fn leave_balances(db: &PgPool, employee_id: &str, year: i32) -> Result<Vec<Value>, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let share = employed_share_of_year(year, employee["startDate"].as_str(), employee["endDate"].as_str());
    let types = list_leave_types(db, false).await?;
    let allowances: Vec<(String, f64)> = sqlx::query_as(
        "select leave_type_id, days from hr_leave_allowances where employee_id = $1 and year = $2",
    )
    .bind(employee_id)
    .bind(year)
    .fetch_all(db)
    .await?;
    let usage: Vec<(String, String, f64)> = sqlx::query_as(
        "select leave_type_id, status, coalesce(sum(days), 0)::float8 from hr_leave_requests
         where employee_id = $1 and status in ('approved', 'pending')
           and extract(year from start_date) = $2
         group by leave_type_id, status",
    )
    .bind(employee_id)
    .bind(year)
    .fetch_all(db)
    .await?;
    let overrides: HashMap<String, f64> = allowances.into_iter().collect();
    Ok(types
        .iter()
        .map(|leave_type| {
            let type_id = text(leave_type, "id");
            let explicit = overrides.get(type_id).copied();
            let full = explicit.or_else(|| leave_type["defaultAllowanceDays"].as_f64());
            let prorated = explicit.is_none() && full.is_some() && share < 1.0;
            let allowance = if prorated {
                full.map(|full| js_round(full * share * 2.0) / 2.0)
            } else {
                full
            };
            let sum_of = |status: &str| {
                usage
                    .iter()
                    .find(|(t, s, _)| t == type_id && s == status)
                    .map_or(0.0, |u| u.2)
            };
            let used = sum_of("approved");
            let pending = sum_of("pending");
            json!({
                "leaveTypeId": type_id,
                "name": leave_type["name"],
                "color": leave_type["color"],
                "isPaid": leave_type["isPaid"],
                "overAllowance": leave_type["overAllowance"],
                "allowance": allowance.map(js_number),
                "fullAllowance": full.map(js_number),
                "prorated": prorated,
                "used": js_number(used),
                "pending": js_number(pending),
                "remaining": allowance.map(|a| js_number(js_round((a - used) * 10.0) / 10.0)),
            })
        })
        .collect())
}

async fn balances_route(caller: Caller, Path(employee_id): Path<String>, RawQuery(query): RawQuery) -> HrResult {
    let year = query_param(&query_values(query.as_deref()), "year")
        .map(|y| crate::js_number_of(&y))
        .filter(|y| *y != 0.0 && !y.is_nan())
        .map_or_else(|| year_of(&today_iso()), int_of);
    Ok(Data(leave_balances(&caller.db, &employee_id, year).await?).into_response())
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

/// `assertWithinAllowance(db, request, pendingCounts)`.
async fn assert_within_allowance(
    db: &PgPool,
    employee_id: &str,
    leave_type_id: &str,
    start_date: &str,
    days: f64,
    pending_counts: bool,
) -> Result<(), HrError> {
    let balances = leave_balances(db, employee_id, year_of(start_date)).await?;
    let Some(balance) = balances.iter().find(|b| b["leaveTypeId"] == leave_type_id) else {
        return Ok(());
    };
    let Some(remaining) = balance["remaining"].as_f64() else {
        return Ok(());
    };
    if balance["overAllowance"] != "block" {
        return Ok(());
    }
    let pending = if pending_counts { balance["pending"].as_f64().unwrap_or(0.0) } else { 0.0 };
    let available = js_round((remaining - pending) * 10.0) / 10.0;
    if days > available {
        let name = text(balance, "name");
        return Err(HrError::conflict(format!(
            "This request is {} days, but only {} days of {name} are left, and {name} cannot go over the allowance",
            number_text(days),
            number_text(available.max(0.0)),
        )));
    }
    Ok(())
}

/// `requireLeaveRequest(db, id)`.
pub(crate) async fn require_leave_request(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_leave_requests t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Leave request", id))
}

/// `listLeaveRequests(db, filters)`.
pub(crate) async fn list_leave_requests(
    db: &PgPool,
    employee_id: Option<&str>,
    status: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(r), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name,
             'leaveTypeName', t.name, 'leaveTypeColor', t.color)
         from hr_leave_requests r join hr_employees e on e.id = r.employee_id
         left join hr_leave_types t on t.id = r.leave_type_id
         where e.deleted_at is null
           and ($1::text is null or r.employee_id = $1)
           and ($2::text[] is null or r.status = any($2))
           and ($3::text is null or r.end_date >= $3::date)
           and ($4::text is null or r.start_date <= $4::date)
         order by r.start_date desc
         limit 1000",
    )
    .bind(employee_id)
    .bind(&statuses)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    let reviewers: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["reviewed_by"].as_str()).collect();
    let names = member_names(db, &reviewers).await?;
    Ok(rows
        .into_iter()
        .map(|(request, extra)| {
            let mut request = js_row(request);
            let reviewer = request["reviewedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .and_then(|r| names.get(r).cloned());
            if let Some(map) = request.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&extra)));
                map.insert("leaveTypeName".to_owned(), extra["leaveTypeName"].clone());
                map.insert("leaveTypeColor".to_owned(), extra["leaveTypeColor"].clone());
                map.insert("reviewedByName".to_owned(), json!(reviewer));
            }
            request
        })
        .collect())
}

async fn list_leave_requests_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_leave_requests(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "status").as_deref(),
        query_date(&q, "from").as_deref(),
        query_date(&q, "to").as_deref(),
    )
    .await?;
    Ok(Data(rows).into_response())
}

/// A leave request to file (`createLeaveRequest`'s input).
pub(crate) struct LeaveRequestInput<'a> {
    pub(crate) employee_id: &'a str,
    pub(crate) leave_type_id: &'a str,
    pub(crate) start_date: &'a str,
    pub(crate) end_date: &'a str,
    pub(crate) days: Option<f64>,
    pub(crate) reason: Option<&'a str>,
}

/// `createLeaveRequest(db, input, requestedBy)`.
pub(crate) async fn create_leave_request(
    db: &PgPool,
    input: &LeaveRequestInput<'_>,
    requested_by: &str,
) -> Result<Value, HrError> {
    assert_date_order(Some(input.start_date), Some(input.end_date), "Leave")?;
    if year_of(input.end_date) - year_of(input.start_date) > 1 {
        return Err(HrError::validation("Split leave that spans more than one year into separate requests"));
    }
    require_employee(db, input.employee_id).await?;
    let leave_type = require_leave_type(db, input.leave_type_id).await?;
    if leave_type["isActive"] != true {
        return Err(HrError::validation("This leave type is no longer available"));
    }
    let overlap: Option<String> = sqlx::query_scalar(
        "select id from hr_leave_requests where employee_id = $1 and status in ('pending', 'approved')
           and start_date <= $2::date and end_date >= $3::date limit 1",
    )
    .bind(input.employee_id)
    .bind(input.end_date)
    .bind(input.start_date)
    .fetch_optional(db)
    .await?;
    if overlap.is_some() {
        return Err(HrError::conflict("This overlaps another leave request"));
    }
    #[allow(clippy::cast_precision_loss)]
    let days = input
        .days
        .unwrap_or_else(|| working_days_between(input.start_date, input.end_date) as f64);
    if days <= 0.0 {
        return Err(HrError::validation("The selected dates contain no working days"));
    }
    assert_within_allowance(db, input.employee_id, input.leave_type_id, input.start_date, days, true).await?;
    let auto_approve = leave_type["requiresApproval"] != true;
    let row: Value = sqlx::query_scalar(
        "insert into hr_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, reason,
             status, requested_by, reviewed_at)
         values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10::timestamp)
         returning to_jsonb(hr_leave_requests)",
    )
    .bind(generate_id("hrlvr"))
    .bind(input.employee_id)
    .bind(input.leave_type_id)
    .bind(input.start_date)
    .bind(input.end_date)
    .bind(days)
    .bind(input.reason)
    .bind(if auto_approve { "approved" } else { "pending" })
    .bind(requested_by)
    .bind(auto_approve.then(now))
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// The `hr_leave_request` event of a create (approved straight away, or
/// created) or of another change (updated).
pub(crate) fn emit_leave(caller: &Caller, state: &HrState, row: &Value, created: bool) {
    let event = if created {
        if row["status"] == "approved" { HR_LEAVE_REQUEST_APPROVED } else { HR_LEAVE_REQUEST_CREATED }
    } else {
        HR_LEAVE_REQUEST_UPDATED
    };
    caller.emit(
        state,
        event,
        text(row, "id"),
        &[("employeeId", Some(row["employeeId"].clone())), ("status", Some(row["status"].clone()))],
    );
}

async fn create_leave_request_route(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (employee, leave_type, start, end, days, reason) = hr_json(&headers, &body, |issues, fields| {
        (
            id(issues, fields, "employeeId", Presence::Required),
            id(issues, fields, "leaveTypeId", Presence::Required),
            iso_date(issues, fields, "startDate", Presence::Required),
            iso_date(issues, fields, "endDate", Presence::Required),
            number(issues, fields, "days", Presence::Optional, Some(0.5), Some(366.0)),
            text_max(issues, fields, "reason", Presence::Nullish, 2000),
        )
    })?;
    let input = LeaveRequestInput {
        employee_id: employee.as_set().map_or("", String::as_str),
        leave_type_id: leave_type.as_set().map_or("", String::as_str),
        start_date: start.as_set().map_or("", String::as_str),
        end_date: end.as_set().map_or("", String::as_str),
        days: days.as_set().copied(),
        reason: reason.as_set().map(String::as_str),
    };
    let row = create_leave_request(&caller.db, &input, &caller.user_id).await?;
    emit_leave(&caller, &state, &row, true);
    Ok(Created(row).into_response())
}

async fn review_leave_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (decision, note) = hr_json(&headers, &body, |issues, fields| {
        (
            issues.choice(fields, "decision", Presence::Required, &["approved", "rejected"]),
            text_max(issues, fields, "note", Presence::Nullish, 2000),
        )
    })?;
    let decision = decision.into_option().unwrap_or_default();
    let db = &caller.db;
    let existing = require_leave_request(db, &id).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!("This request is already {}", text(&existing, "status"))));
    }
    if decision == "approved" {
        assert_within_allowance(
            db,
            text(&existing, "employeeId"),
            text(&existing, "leaveTypeId"),
            text(&existing, "startDate"),
            existing["days"].as_f64().unwrap_or(0.0),
            false,
        )
        .await?;
    }
    let row: Value = sqlx::query_scalar(
        "update hr_leave_requests set status = $2, review_note = $3, reviewed_by = $4,
             reviewed_at = $5::timestamp, updated_at = $5::timestamp
         where id = $1 returning to_jsonb(hr_leave_requests)",
    )
    .bind(&id)
    .bind(&decision)
    .bind(note.as_set())
    .bind(&caller.user_id)
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let event = if row["status"] == "approved" { HR_LEAVE_REQUEST_APPROVED } else { HR_LEAVE_REQUEST_REJECTED };
    caller.emit(
        &state,
        event,
        text(&row, "id"),
        &[("employeeId", Some(row["employeeId"].clone())), ("status", Some(row["status"].clone()))],
    );
    Ok(Data(row).into_response())
}

/// `cancelLeaveRequest(db, id, onlyEmployeeId?)`.
pub(crate) async fn cancel_leave_request(db: &PgPool, id: &str, only_employee_id: Option<&str>) -> Result<Value, HrError> {
    let existing = require_leave_request(db, id).await?;
    if only_employee_id.is_some_and(|only| existing["employeeId"] != only) {
        return Err(HrError::not_found("Leave request", id));
    }
    let status = text(&existing, "status");
    if status == "cancelled" || status == "rejected" {
        return Err(HrError::conflict(format!("This request is already {status}")));
    }
    if only_employee_id.is_some() && status == "approved" && text(&existing, "startDate") <= today_iso().as_str() {
        return Err(HrError::conflict("Leave that has started can only be cancelled by HR"));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_leave_requests set status = 'cancelled', updated_at = $2::timestamp where id = $1
         returning to_jsonb(hr_leave_requests)",
    )
    .bind(id)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

async fn cancel_leave_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = cancel_leave_request(&caller.db, &id, None).await?;
    emit_leave(&caller, &state, &row, false);
    Ok(Data(row).into_response())
}

async fn delete_leave_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_leave_request(&caller.db, &id).await?;
    require_leave_request(&caller.db, &id).await?;
    sqlx::query("delete from hr_leave_requests where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    caller.emit(
        &state,
        HR_LEAVE_REQUEST_DELETED,
        text(&row, "id"),
        &[("employeeId", Some(row["employeeId"].clone()))],
    );
    Ok(NoContent.into_response())
}

/// `onLeaveOn(db, date)`: who is on approved leave that day.
pub(crate) async fn on_leave_on(db: &PgPool, date: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('employeeId', lr.employee_id, 'firstName', e.first_name,
             'lastName', e.last_name, 'preferredName', e.preferred_name,
             'leaveTypeName', lt.name, 'endDate', lr.end_date)
         from hr_leave_requests lr
         join hr_employees e on e.id = lr.employee_id
         left join hr_leave_types lt on lt.id = lr.leave_type_id
         where lr.status = 'approved' and lr.start_date <= $1::date and lr.end_date >= $1::date
           and e.deleted_at is null and e.status <> 'terminated'",
    )
    .bind(date)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "employeeId": row["employeeId"],
                "employeeName": display_name_of(row),
                "leaveTypeName": row["leaveTypeName"],
                "endDate": row["endDate"],
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_like_javascript() {
        assert_eq!(instant("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(instant("2026-10-31T10:00:00.123456+02:00"), instant("2026-10-31T08:00:00.123Z"));
        assert_eq!(instant("2026-10-31T10:00:00+0130"), instant("2026-10-31T08:30:00Z"));
        assert_eq!(iso(instant("2026-10-31T08:00:00.5Z").unwrap_or(0)), "2026-10-31T08:00:00.500Z");
        assert!((late_minutes_for(Some(6 * 60_000), Some(0)) - 6.0).abs() < f64::EPSILON);
        assert!(late_minutes_for(Some(5 * 60_000), Some(0)).abs() < f64::EPSILON);
    }
}
