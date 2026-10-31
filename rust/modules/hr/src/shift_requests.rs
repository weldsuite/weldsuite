//! Shift requests (`routes/weldhr/time.ts`, `services/weldhr/shift-requests.ts`):
//! an employee asking to work a shift, or signing up for an open one; a
//! manager approves (which puts the shift on the rooster) or rejects it.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_OPEN_SHIFT_UPDATED, HR_SHIFT_REQUEST_APPROVED, HR_SHIFT_REQUEST_REJECTED,
};
use weldsuite_catalogs::permission_keys::{ATTENDANCE_CREATE, ATTENDANCE_READ};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{display_name_of, require_employee};
use crate::fields::text_max;
use crate::open_shifts::{assert_can_sign_up, assert_open_shift_has_spot, settle_open_shift};
use crate::timekeeping::{
    ShiftDetails, assert_no_overlapping_shift, assert_shift_break, assert_shift_window, create_shift,
    instant, iso, now_ms, row_instant,
};
use crate::{Caller, HrError, HrResult, HrState, hr_json, js_trim, member_names, now, query_date, query_text, query_values, text};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/shift-requests", get(list).route_layer(gate.require([ATTENDANCE_READ])))
        .route(
            "/shift-requests/{id}/review",
            post(review).route_layer(gate.require([ATTENDANCE_CREATE])),
        )
}

/// `requireShiftRequest(db, id)`.
pub(crate) async fn require_shift_request(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_shift_requests t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Shift request", id))
}

/// `listShiftRequests(db, filters)`.
pub(crate) async fn list_shift_requests(
    db: &PgPool,
    id: Option<&str>,
    employee_id: Option<&str>,
    status: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(r), jsonb_build_object('firstName', e.first_name, 'lastName', e.last_name,
             'preferredName', e.preferred_name)
         from hr_shift_requests r join hr_employees e on e.id = r.employee_id
         where e.deleted_at is null
           and ($1::text is null or r.id = $1)
           and ($2::text is null or r.employee_id = $2)
           and ($3::text[] is null or r.status = any($3))
           and ($4::text is null or r.starts_at >= $4::timestamptz)
           and ($5::text is null or r.starts_at <= $5::timestamptz)
         order by r.starts_at desc limit 1000",
    )
    .bind(id)
    .bind(employee_id)
    .bind(&statuses)
    .bind(from.map(|f| format!("{f}T00:00:00Z")))
    .bind(to.map(|t| format!("{t}T23:59:59Z")))
    .fetch_all(db)
    .await?;
    let reviewers: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["reviewed_by"].as_str()).collect();
    let names = member_names(db, &reviewers).await?;
    Ok(rows
        .into_iter()
        .map(|(request, employee)| {
            let mut request = js_row(request);
            let reviewer = request["reviewedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .and_then(|r| names.get(r).cloned());
            if let Some(map) = request.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(display_name_of(&employee)));
                map.insert("reviewedByName".to_owned(), json!(reviewer));
            }
            request
        })
        .collect())
}

/// `shiftRequestWithNames(db, id)`.
async fn shift_request_with_names(db: &PgPool, id: &str) -> Result<Value, HrError> {
    list_shift_requests(db, Some(id), None, None, None, None)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| HrError::not_found("Shift request", id))
}

/// `toSelfShiftRequest(row)`.
pub(crate) fn to_self_shift_request(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "openShiftId": row["openShiftId"],
        "startsAt": row["startsAt"],
        "endsAt": row["endsAt"],
        "workType": row["workType"],
        "note": row["note"],
        "status": row["status"],
        "reviewedAt": row["reviewedAt"],
        "reviewedByName": row.get("reviewedByName").cloned().unwrap_or(Value::Null),
        "reviewNote": row["reviewNote"],
        "createdAt": row["createdAt"],
    })
}

/// `x?.trim() || null`.
fn trimmed(value: Option<&str>) -> Option<String> {
    value.map(|v| js_trim(v).to_owned()).filter(|v| !v.is_empty())
}

/// `requestShift(db, employeeId, input, requestedBy)`.
pub(crate) async fn request_shift(
    db: &PgPool,
    employee_id: &str,
    starts_at: &str,
    ends_at: &str,
    work_type: Option<&str>,
    note: Option<&str>,
    open_shift_id: Option<&str>,
    requested_by: &str,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    let starts = instant(starts_at).unwrap_or(0);
    let ends = instant(ends_at).unwrap_or(0);
    assert_shift_window(starts, ends)?;
    if starts <= now_ms() {
        return Err(HrError::validation("Ask for a shift that has not started yet"));
    }
    assert_no_overlapping_shift(db, employee_id, starts, ends, None, Some("You already have a shift at this time")).await?;
    let waiting: Option<String> = sqlx::query_scalar(
        "select id from hr_shift_requests where employee_id = $1 and status = 'pending'
           and starts_at < $2::timestamptz and ends_at > $3::timestamptz limit 1",
    )
    .bind(employee_id)
    .bind(iso(ends))
    .bind(iso(starts))
    .fetch_optional(db)
    .await?;
    if waiting.is_some() {
        return Err(HrError::conflict("You already asked for a shift at this time"));
    }
    let row: Value = sqlx::query_scalar(
        "insert into hr_shift_requests (id, employee_id, open_shift_id, starts_at, ends_at, work_type, note,
             status, requested_by)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, 'pending', $8)
         returning to_jsonb(hr_shift_requests)",
    )
    .bind(generate_id("hrsrq"))
    .bind(employee_id)
    .bind(open_shift_id)
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(trimmed(work_type))
    .bind(trimmed(note))
    .bind(requested_by)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// `signUpForOpenShift(db, employeeId, openShiftId, { note }, requestedBy)`.
pub(crate) async fn sign_up_for_open_shift(
    db: &PgPool,
    employee_id: &str,
    open_shift_id: &str,
    note: Option<&str>,
    requested_by: &str,
) -> Result<Value, HrError> {
    let open = assert_can_sign_up(db, employee_id, open_shift_id).await?;
    request_shift(
        db,
        employee_id,
        text(&open, "startsAt"),
        text(&open, "endsAt"),
        open["workType"].as_str(),
        note,
        Some(open_shift_id),
        requested_by,
    )
    .await
}

/// `claimOpenShiftSpot(db, request, open, note, reviewedBy)`.
async fn claim_open_shift_spot(
    db: &PgPool,
    request: &Value,
    open: &Value,
    note: Option<String>,
    reviewed_by: &str,
) -> Result<Value, HrError> {
    let starts = row_instant(request, "startsAt").unwrap_or(0);
    let ends = row_instant(request, "endsAt").unwrap_or(0);
    let bs = row_instant(open, "breakStartsAt");
    let be = row_instant(open, "breakEndsAt");
    assert_shift_window(starts, ends)?;
    assert_shift_break(starts, ends, bs, be)?;
    let employee_id = text(request, "employeeId").to_owned();
    assert_no_overlapping_shift(db, &employee_id, starts, ends, None, None).await?;
    let shift_id = generate_id("hrshf");
    let now = now();
    let request_id = text(request, "id").to_owned();
    let open_id = text(open, "id").to_owned();
    let mut tx = db.begin().await?;
    sqlx::query("update hr_open_shifts set updated_at = $2::timestamp where id = $1")
        .bind(&open_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "insert into hr_shifts (id, employee_id, company_id, starts_at, ends_at, work_type,
             break_starts_at, break_ends_at, notes, created_by)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::timestamptz, $8::timestamptz, $9, $10)",
    )
    .bind(&shift_id)
    .bind(&employee_id)
    .bind(open["companyId"].as_str())
    .bind(iso(starts))
    .bind(iso(ends))
    .bind(request["workType"].as_str())
    .bind(bs.map(iso))
    .bind(be.map(iso))
    .bind(open["notes"].as_str())
    .bind(reviewed_by)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update hr_shift_requests set status = 'approved', shift_id = $2, review_note = $3, reviewed_by = $4,
             reviewed_at = $5::timestamp, updated_at = $5::timestamp
         where id = $1 and status = 'pending'
           and (select count(*) from hr_shift_requests r join hr_shifts s on s.id = r.shift_id
                where r.open_shift_id = $6 and r.status = 'approved')
               < (select o.spots from hr_open_shifts o where o.id = $6 and o.status = 'open')",
    )
    .bind(&request_id)
    .bind(&shift_id)
    .bind(&note)
    .bind(reviewed_by)
    .bind(&now)
    .bind(&open_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "delete from hr_shifts where id = $1
           and not exists (select 1 from hr_shift_requests where id = $2 and shift_id = $1)",
    )
    .bind(&shift_id)
    .bind(&request_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let after = require_shift_request(db, &request_id).await?;
    if after["shiftId"] == shift_id.as_str() {
        return Ok(after);
    }
    if after["status"] != "pending" {
        return Err(HrError::conflict("This request was answered in the meantime"));
    }
    Err(HrError::conflict("All spots on this shift are filled"))
}

/// `reviewShiftRequest(db, id, input, reviewedBy)`.
async fn review_shift_request(
    db: &PgPool,
    id: &str,
    decision: &str,
    note: Option<&str>,
    reviewed_by: &str,
) -> Result<Value, HrError> {
    let existing = require_shift_request(db, id).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!("This request is already {}", text(&existing, "status"))));
    }
    if decision == "approved"
        && let Some(open_shift_id) = existing["openShiftId"].as_str().filter(|o| !o.is_empty())
    {
        let open = assert_open_shift_has_spot(db, open_shift_id).await?;
        return claim_open_shift_spot(db, &existing, &open, trimmed(note), reviewed_by).await;
    }
    let shift = if decision == "approved" {
        let details = ShiftDetails {
            company_id: None,
            work_type: trimmed(existing["workType"].as_str()),
            break_starts: Field::Absent,
            break_ends: Field::Absent,
            notes: None,
        };
        Some(
            create_shift(
                db,
                text(&existing, "employeeId"),
                text(&existing, "startsAt"),
                text(&existing, "endsAt"),
                &details,
                reviewed_by,
            )
            .await?,
        )
    } else {
        None
    };
    let row: Option<Value> = sqlx::query_scalar(
        "update hr_shift_requests set status = $2, shift_id = $3, review_note = $4, reviewed_by = $5,
             reviewed_at = $6::timestamp, updated_at = $6::timestamp
         where id = $1 and status = 'pending' returning to_jsonb(hr_shift_requests)",
    )
    .bind(id)
    .bind(decision)
    .bind(shift.as_ref().and_then(|s| s["id"].as_str()))
    .bind(trimmed(note))
    .bind(reviewed_by)
    .bind(now())
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        if let Some(shift) = &shift {
            sqlx::query("delete from hr_shifts where id = $1")
                .bind(text(shift, "id"))
                .execute(db)
                .await?;
        }
        return Err(HrError::conflict("This request was answered in the meantime"));
    };
    Ok(js_row(row))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_shift_requests(
        &caller.db,
        None,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "status").as_deref(),
        query_date(&q, "from").as_deref(),
        query_date(&q, "to").as_deref(),
    )
    .await?;
    Ok(Data(rows).into_response())
}

async fn review(
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
    let db = &caller.db;
    let row = review_shift_request(
        db,
        &id,
        decision.as_set().map_or("", String::as_str),
        note.as_set().map(String::as_str),
        &caller.user_id,
    )
    .await?;
    let event = if row["status"] == "approved" { HR_SHIFT_REQUEST_APPROVED } else { HR_SHIFT_REQUEST_REJECTED };
    caller.emit(
        &state,
        event,
        text(&row, "id"),
        &[("employeeId", Some(row["employeeId"].clone())), ("status", Some(row["status"].clone()))],
    );
    if let Some(open_shift_id) = row["openShiftId"].as_str().filter(|o| !o.is_empty())
        && row["status"] == "approved"
    {
        for (closed, employee, status) in settle_open_shift(db, open_shift_id, &caller.user_id).await? {
            caller.emit(
                &state,
                HR_SHIFT_REQUEST_REJECTED,
                &closed,
                &[("employeeId", Some(json!(employee))), ("status", Some(json!(status)))],
            );
        }
        caller.emit(&state, HR_OPEN_SHIFT_UPDATED, open_shift_id, &[]);
    }
    Ok(Data(shift_request_with_names(db, text(&row, "id")).await?).into_response())
}

/// `cancelShiftRequest(db, id, employeeId)`.
pub(crate) async fn cancel_shift_request(db: &PgPool, id: &str, employee_id: &str) -> Result<Value, HrError> {
    let existing = require_shift_request(db, id).await?;
    if existing["employeeId"] != employee_id {
        return Err(HrError::not_found("Shift request", id));
    }
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!("This request is already {}", text(&existing, "status"))));
    }
    let row: Option<Value> = sqlx::query_scalar(
        "update hr_shift_requests set status = 'cancelled', updated_at = $2::timestamp
         where id = $1 and status = 'pending' returning to_jsonb(hr_shift_requests)",
    )
    .bind(id)
    .bind(now())
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::conflict("This request was answered in the meantime"))
}
