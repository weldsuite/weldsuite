//! My HR (`routes/weldhr/me.ts`, `services/weldhr/self-service.ts`): the
//! signed-in member's own employee record. The employee is always the
//! `hr_employees` row whose `user_id` is the caller, never an id from the
//! request; a member HR added while their invite was pending is linked on
//! first use. Every route also needs `employees:self` (the router's layer).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_ABSENCE_CREATED, HR_ABSENCE_RECOVERED, HR_ATTENDANCE_CREATED, HR_ATTENDANCE_UPDATED,
    HR_CHECKLIST_COMPLETED, HR_CHECKLIST_UPDATED, HR_COACHING_LOG_ACKNOWLEDGED,
    HR_DECLARATION_CREATED, HR_DECLARATION_UPDATED, HR_EMPLOYEE_ONBOARDED,
    HR_EVALUATION_ACKNOWLEDGED, HR_SHIFT_REQUEST_CREATED, HR_SHIFT_REQUEST_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{
    active_clients_for, display_name_of, employee_for_user, link_invited_employees,
    require_employee,
};
use crate::fields::{id, iso_date, iso_date_time, number, short_text, text_max};
use crate::lifecycle::settle_checklist;
use crate::performance::{
    CoachingFilters, EvaluationFilters, acknowledge_coaching_log, acknowledge_evaluation,
    list_coaching_logs, list_evaluations, list_kpi_values, list_milestones,
};
use crate::settings::HrFeatures;
use crate::timekeeping::{
    AttendanceFilters, LeaveRequestInput, clock, emit_leave, leave_balances, list_attendance,
    list_leave_requests, list_leave_types, list_shifts, now_ms, open_clock_record, switch_shift,
};
use crate::work_locations::{GeoPoint, clock_place_for};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, hr_json, js_number, now, query_date, query_param,
    query_values, text, today_iso, year_of,
};

/// The routes, relative to `/api/weldhr/me`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(me))
        .route("/overview", get(overview))
        .route("/attendance", get(attendance))
        .route("/shift-requests", post(request_shift))
        .route("/shift-requests/{id}/cancel", post(cancel_shift_request))
        .route("/open-shifts", get(open_shifts))
        .route("/open-shifts/{id}/sign-up", post(sign_up))
        .route("/announcements", get(announcements))
        .route("/announcements/{id}/read", post(read_announcement))
        .route("/clock", post(clock_route))
        .route("/leave", get(leave).post(request_leave))
        .route("/leave/{id}/cancel", post(cancel_leave))
        .route("/declarations", get(declarations).post(file_declaration))
        .route("/declarations/{id}/cancel", post(cancel_declaration))
        .route(
            "/declarations/{id}/receipt",
            post(upload_receipt).get(download_receipt),
        )
        .route("/absences", get(absences).post(report_sick))
        .route("/absences/{id}/recover", post(recover))
        .route("/tasks", get(tasks))
        .route("/tasks/{id}/complete", post(complete_task))
        .route("/coaching", get(coaching))
        .route("/coaching/{id}/acknowledge", post(acknowledge_coaching))
        .route("/evaluations", get(evaluations))
        .route(
            "/evaluations/{id}/acknowledge",
            post(acknowledge_evaluation_route),
        )
        .route("/performance", get(performance))
}

/// `selfEmployee(c)`: the caller's employee, linked from an accepted invite
/// on first use.
pub(crate) async fn self_employee(
    state: &HrState,
    caller: &Caller,
) -> Result<Option<Value>, HrError> {
    if let Some(employee) = employee_for_user(&caller.db, &caller.user_id).await? {
        return Ok(Some(employee));
    }
    let linked = link_invited_employees(state, caller, Some(&caller.user_id), None).await?;
    if linked.is_empty() {
        return Ok(None);
    }
    employee_for_user(&caller.db, &caller.user_id).await
}

/// `selfEmployeeId(c)`: 404 without an (active) employee record.
pub(crate) async fn self_employee_id(state: &HrState, caller: &Caller) -> Result<String, HrError> {
    match self_employee(state, caller).await? {
        Some(employee) => Ok(text(&employee, "id").to_owned()),
        None => Err(HrError::not_found("Employee", "me")),
    }
}

/// The listed keys of a row, as a new object.
fn pick(row: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|k| ((*k).to_owned(), row[*k].clone()))
            .collect(),
    )
}

/// An entity event with `{ employeeId, status }`.
fn emit_status(
    caller: &Caller,
    state: &HrState,
    event: weldsuite_catalogs::entity_events::EventName,
    employee_id: &str,
    row: &Value,
) {
    caller.emit(
        state,
        event,
        text(row, "id"),
        &[
            ("employeeId", Some(json!(employee_id))),
            ("status", Some(row["status"].clone())),
        ],
    );
}

// ---------------------------------------------------------------------------
// Profile, overview, tasks
// ---------------------------------------------------------------------------

/// `employeeProfile(db, employeeId)`: nothing from the sensitive block.
async fn employee_profile(db: &PgPool, employee_id: &str) -> Result<Value, HrError> {
    let e = require_employee(db, employee_id).await?;
    let department: Option<String> = match e["departmentId"].as_str().filter(|d| !d.is_empty()) {
        Some(department) => {
            sqlx::query_scalar("select name from hr_departments where id = $1 limit 1")
                .bind(department)
                .fetch_optional(db)
                .await?
        }
        None => None,
    };
    let manager: Option<Value> = match e["managerId"].as_str().filter(|m| !m.is_empty()) {
        Some(manager) => {
            sqlx::query_scalar(
                "select jsonb_build_object('firstName', first_name, 'lastName', last_name,
                 'preferredName', preferred_name, 'email', email)
             from hr_employees where id = $1 limit 1",
            )
            .bind(manager)
            .fetch_optional(db)
            .await?
        }
        None => None,
    };
    let id = text(&e, "id").to_owned();
    let clients = active_clients_for(db, std::slice::from_ref(&id), None).await?;
    Ok(json!({
        "id": id,
        "displayName": display_name_of(&e),
        "firstName": e["firstName"],
        "lastName": e["lastName"],
        "email": e["email"],
        "phone": e["phone"],
        "avatarUrl": e["avatarUrl"],
        "jobTitle": e["jobTitle"],
        "employeeNumber": e["employeeNumber"],
        "status": e["status"],
        "employmentType": e["employmentType"],
        "startDate": e["startDate"],
        "location": e["location"],
        "departmentName": department,
        "manager": manager.map(|m| json!({ "displayName": display_name_of(&m), "email": m["email"] })),
        "clients": clients.get(&id).cloned().unwrap_or_default(),
    }))
}

/// `employeeTasks(db, employeeId)`.
async fn employee_tasks(db: &PgPool, employee_id: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<(Value, String, String, String)> = sqlx::query_as(
        "select to_jsonb(t), c.name, c.kind, c.status from hr_checklist_tasks t
         join hr_checklists c on c.id = t.checklist_id
         where t.employee_id = $1 and t.visible_to_employee = true and c.status in ('in_progress', 'completed')
         order by t.due_date asc, t.sort_order asc",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(task, name, kind, status)| {
            let task = js_row(task);
            json!({
                "id": task["id"],
                "title": task["title"],
                "description": task["description"],
                "dueDate": task["dueDate"],
                "assigneeRole": task["assigneeRole"],
                "completedAt": task["completedAt"],
                "canComplete": task["assigneeRole"] == "employee" && status == "in_progress",
                "checklistName": name,
                "checklistKind": kind,
            })
        })
        .collect())
}

async fn me(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee = self_employee(&state, &caller).await?;
    let features = HrFeatures::load(&caller.db).await?;
    let profile = match employee {
        Some(employee) => employee_profile(&caller.db, text(&employee, "id")).await?,
        None => Value::Null,
    };
    Ok(Data(json!({ "employee": profile, "features": features.json() })).into_response())
}

fn count(rows: &[Value], test: impl Fn(&Value) -> bool) -> usize {
    rows.iter().filter(|r| test(r)).count()
}

async fn overview(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let db = &caller.db;
    let today = today_iso();
    let profile = employee_profile(db, &employee_id).await?;
    let open_clock = open_clock_record(db, &employee_id).await?;
    let shifts = list_shifts(db, &today, &add_days(&today, 13), Some(&employee_id), None).await?;
    let balances = leave_balances(db, &employee_id, year_of(&today)).await?;
    let tasks = employee_tasks(db, &employee_id).await?;
    let coaching = list_coaching_logs(
        db,
        &CoachingFilters {
            employee_id: Some(employee_id.clone()),
            visibilities: Some(vec!["employee".to_owned(), "client".to_owned()]),
            ..CoachingFilters::default()
        },
    )
    .await?;
    let evaluations = list_evaluations(
        db,
        &EvaluationFilters {
            employee_id: Some(employee_id.clone()),
            status: Some("submitted,acknowledged".to_owned()),
            ..EvaluationFilters::default()
        },
    )
    .await?;
    let milestones = list_milestones(db, Some(&employee_id), None, None).await?;
    let unread = crate::announcements::unread_announcement_count(db, &employee_id).await?;
    let open_shifts = crate::open_shifts::open_shifts_for_employee(db, &employee_id).await?;
    let upcoming: Vec<Value> = shifts
        .iter()
        .map(|s| pick(s, &["id", "startsAt", "endsAt", "companyName"]))
        .collect();
    let latest = evaluations.first().map_or(Value::Null, |e| {
        pick(e, &["id", "overallScore", "formName", "submittedAt"])
    });
    Ok(Data(json!({
        "profile": profile,
        "clock": {
            "clockedIn": open_clock.is_some(),
            "since": open_clock.as_ref().map_or(Value::Null, |o| o["clockIn"].clone()),
            "shiftId": open_clock.as_ref().map_or(Value::Null, |o| o["shiftId"].clone()),
        },
        "upcomingShifts": upcoming,
        "leaveBalances": balances,
        "openTasks": count(&tasks, |t| t["completedAt"].is_null()),
        "toAcknowledge": {
            "coaching": count(&coaching, |c| c["acknowledgedAt"].is_null()),
            "evaluations": count(&evaluations, |e| e["status"] == "submitted"),
        },
        "latestEvaluation": latest,
        "milestones": {
            "achieved": count(&milestones, |m| m["status"] == "achieved"),
            "open": count(&milestones, |m| m["status"] == "planned" || m["status"] == "in_progress"),
        },
        "unreadAnnouncements": unread,
        "openShifts": count(&open_shifts, |s| s["myRequest"].is_null() && s["spotsLeft"].as_i64().unwrap_or(0) > 0),
    }))
    .into_response())
}

async fn tasks(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(Data(employee_tasks(&caller.db, &employee_id).await?).into_response())
}

async fn complete_task(
    State(state): State<HrState>,
    caller: Caller,
    Path(task_id): Path<String>,
    RawQuery(query): RawQuery,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let done = query_param(&query_values(query.as_deref()), "undo").as_deref() != Some("true");
    let db = &caller.db;
    let task: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_checklist_tasks t where t.id = $1 limit 1")
            .bind(&task_id)
            .fetch_optional(db)
            .await?;
    let Some(task) = task
        .map(js_row)
        .filter(|t| t["employeeId"] == employee_id.as_str() && t["visibleToEmployee"] == true)
    else {
        return Err(HrError::not_found("Task", &task_id));
    };
    if task["assigneeRole"] != "employee" {
        return Err(HrError::validation(
            "This task is completed by your team, not by you",
        ));
    }
    let now = now();
    sqlx::query(
        "update hr_checklist_tasks set completed_at = $2::timestamp, completed_by = $3, updated_at = $4::timestamp
         where id = $1",
    )
    .bind(&task_id)
    .bind(done.then(|| now.clone()))
    .bind(done.then(|| caller.user_id.clone()))
    .bind(&now)
    .execute(db)
    .await?;
    let checklist_id = text(&task, "checklistId").to_owned();
    let outcome = settle_checklist(db, &checklist_id).await?;
    let event = if outcome.checklist_completed {
        HR_CHECKLIST_COMPLETED
    } else {
        HR_CHECKLIST_UPDATED
    };
    caller.emit(
        &state,
        event,
        &checklist_id,
        &[("employeeId", Some(json!(employee_id)))],
    );
    if outcome.employee_status == Some("active") {
        caller.emit(
            &state,
            HR_EMPLOYEE_ONBOARDED,
            &employee_id,
            &[("status", Some(json!("active")))],
        );
    }
    Ok(
        Data(json!({ "ok": true, "checklistCompleted": outcome.checklist_completed }))
            .into_response(),
    )
}

// ---------------------------------------------------------------------------
// Attendance, clocking, shifts
// ---------------------------------------------------------------------------

/// `hourlyRateOf(comp)`.
fn hourly_rate_of(comp: &Value) -> Option<f64> {
    let amount = match &comp["amount"] {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => crate::js_number_of(s),
        _ => f64::NAN,
    };
    if !amount.is_finite() {
        return None;
    }
    let period = text(comp, "period");
    if period == "hour" {
        return Some(amount);
    }
    let hours = comp["hoursPerWeek"]
        .as_f64()
        .filter(|h| *h > 0.0)
        .unwrap_or(40.0);
    let per_year = match period {
        "week" => 52.0,
        "month" => 12.0,
        "year" => 1.0,
        _ => return None,
    };
    Some((amount * per_year) / (hours * 52.0))
}

/// `compensationOn(rows, date)`: the newest row covering `date`.
pub(crate) fn compensation_on<'a>(rows: &'a [Value], date: &str) -> Option<&'a Value> {
    let mut sorted: Vec<&Value> = rows.iter().collect();
    sorted.sort_by(|a, b| text(b, "effectiveFrom").cmp(text(a, "effectiveFrom")));
    sorted.into_iter().find(|row| {
        text(row, "effectiveFrom") <= date
            && row["effectiveTo"].as_str().is_none_or(|to| to >= date)
    })
}

/// `employeeAttendance(db, employeeId, from, to, { withPay: true, withRequests: true })`.
async fn employee_attendance(
    db: &PgPool,
    employee_id: &str,
    from: &str,
    to: &str,
) -> Result<Value, HrError> {
    let filters = AttendanceFilters {
        employee_id: Some(employee_id.to_owned()),
        from: Some(from.to_owned()),
        to: Some(to.to_owned()),
        limit: Some(500.0),
        ..AttendanceFilters::default()
    };
    let (records, ..) = list_attendance(db, &filters).await?;
    let shifts = list_shifts(db, from, to, Some(employee_id), None).await?;
    let compensations: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_compensations t where t.employee_id = $1")
            .bind(employee_id)
            .fetch_all(db)
            .await?;
    let compensations: Vec<Value> = compensations.into_iter().map(js_row).collect();
    let requests = crate::shift_requests::list_shift_requests(
        db,
        None,
        Some(employee_id),
        Some("pending,rejected"),
        Some(from),
        Some(to),
    )
    .await?;
    let pay_on = |date: &str, out: &mut serde_json::Map<String, Value>| {
        let comp = compensation_on(&compensations, date);
        out.insert(
            "hourlyRate".to_owned(),
            comp.and_then(hourly_rate_of).map_or(Value::Null, js_number),
        );
        out.insert(
            "currency".to_owned(),
            comp.map_or(Value::Null, |c| c["currency"].clone()),
        );
    };
    let records: Vec<Value> = records
        .iter()
        .map(|r| {
            let mut out = serde_json::Map::new();
            pay_on(text(r, "date"), &mut out);
            for key in [
                "id",
                "date",
                "clockIn",
                "clockOut",
                "breakMinutes",
                "workedMinutes",
                "lateMinutes",
                "status",
                "source",
            ] {
                out.insert(key.to_owned(), r[key].clone());
            }
            out.insert("approved".to_owned(), json!(!r["approvedAt"].is_null()));
            for key in ["companyName", "shiftId", "notes"] {
                out.insert(key.to_owned(), r[key].clone());
            }
            Value::Object(out)
        })
        .collect();
    let shifts: Vec<Value> = shifts
        .iter()
        .map(|s| {
            let mut out = serde_json::Map::new();
            let day: String = text(s, "startsAt").chars().take(10).collect();
            pay_on(&day, &mut out);
            for key in [
                "id",
                "startsAt",
                "endsAt",
                "workType",
                "breakStartsAt",
                "breakEndsAt",
                "companyName",
                "notes",
            ] {
                out.insert(key.to_owned(), s[key].clone());
            }
            Value::Object(out)
        })
        .collect();
    let requests: Vec<Value> = requests
        .iter()
        .map(crate::shift_requests::to_self_shift_request)
        .collect();
    Ok(json!({ "records": records, "shifts": shifts, "requests": requests }))
}

async fn attendance(
    State(state): State<HrState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let q = query_values(query.as_deref());
    let today = today_iso();
    let to = query_date(&q, "to").unwrap_or_else(|| add_days(&today, 14));
    let from = query_date(&q, "from").unwrap_or_else(|| add_days(&today, -30));
    if to < from || add_days(&from, 92) < to {
        return Err(HrError::bad_request("Pick a range of at most 92 days"));
    }
    Ok(Data(employee_attendance(&caller.db, &employee_id, &from, &to).await?).into_response())
}

async fn request_shift(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (starts, ends, work_type, note) = hr_json(&headers, &body, |issues, fields| {
        (
            iso_date_time(issues, fields, "startsAt", Presence::Required),
            iso_date_time(issues, fields, "endsAt", Presence::Required),
            short_text(issues, fields, "workType", Presence::Nullish, 100, false),
            text_max(issues, fields, "note", Presence::Nullish, 1000),
        )
    })?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::shift_requests::request_shift(
        &caller.db,
        &employee_id,
        starts.as_set().map_or("", String::as_str),
        ends.as_set().map_or("", String::as_str),
        work_type.as_set().map(String::as_str),
        note.as_set().map(String::as_str),
        None,
        &caller.user_id,
    )
    .await?;
    emit_status(
        &caller,
        &state,
        HR_SHIFT_REQUEST_CREATED,
        &employee_id,
        &row,
    );
    Ok(Created(crate::shift_requests::to_self_shift_request(&row)).into_response())
}

async fn cancel_shift_request(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::shift_requests::cancel_shift_request(&caller.db, &id, &employee_id).await?;
    emit_status(
        &caller,
        &state,
        HR_SHIFT_REQUEST_UPDATED,
        &employee_id,
        &row,
    );
    Ok(Data(crate::shift_requests::to_self_shift_request(&row)).into_response())
}

async fn open_shifts(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(
        Data(crate::open_shifts::open_shifts_for_employee(&caller.db, &employee_id).await?)
            .into_response(),
    )
}

async fn sign_up(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let note = hr_json(&headers, &body, |issues, fields| {
        text_max(issues, fields, "note", Presence::Nullish, 1000)
    })?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::shift_requests::sign_up_for_open_shift(
        &caller.db,
        &employee_id,
        &id,
        note.as_set().map(String::as_str),
        &caller.user_id,
    )
    .await?;
    emit_status(
        &caller,
        &state,
        HR_SHIFT_REQUEST_CREATED,
        &employee_id,
        &row,
    );
    Ok(Created(crate::shift_requests::to_self_shift_request(&row)).into_response())
}

async fn clock_route(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (action, shift_id, location) = hr_json(&headers, &body, |issues, fields| {
        (
            issues.choice(
                fields,
                "action",
                Presence::Required,
                &["in", "out", "switch"],
            ),
            id(issues, fields, "shiftId", Presence::Optional),
            issues.nested(fields, "location", Presence::Optional, |issues, fields| {
                let latitude = number(
                    issues,
                    fields,
                    "latitude",
                    Presence::Required,
                    Some(-90.0),
                    Some(90.0),
                );
                let longitude = number(
                    issues,
                    fields,
                    "longitude",
                    Presence::Required,
                    Some(-180.0),
                    Some(180.0),
                );
                let accuracy = number(
                    issues,
                    fields,
                    "accuracy",
                    Presence::Nullish,
                    Some(0.0),
                    Some(100_000.0),
                );
                GeoPoint {
                    latitude: latitude.into_option().unwrap_or_default(),
                    longitude: longitude.into_option().unwrap_or_default(),
                    accuracy: accuracy.into_option(),
                }
            }),
        )
    })?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let features = HrFeatures::load(&caller.db).await?;
    if !features.self_clock_in {
        return Err(HrError::forbidden("Clocking in yourself is turned off"));
    }
    let db = &caller.db;
    let place = clock_place_for(
        db,
        &employee_id,
        features.clock_in_requires_location,
        location.into_option(),
    )
    .await?;
    let action = action.into_option().unwrap_or_default();
    let shift_id = shift_id.into_option();
    let record = if action == "switch" {
        let (closed, opened) = switch_shift(
            db,
            &employee_id,
            shift_id.as_deref(),
            now_ms(),
            &caller.user_id,
            &place,
        )
        .await?;
        emit_status(
            &caller,
            &state,
            HR_ATTENDANCE_UPDATED,
            &employee_id,
            &closed,
        );
        emit_status(
            &caller,
            &state,
            HR_ATTENDANCE_CREATED,
            &employee_id,
            &opened,
        );
        opened
    } else {
        let record = clock(
            db,
            &employee_id,
            &action,
            now_ms(),
            &caller.user_id,
            shift_id.as_deref(),
            &place,
        )
        .await?;
        let event = if action == "in" {
            HR_ATTENDANCE_CREATED
        } else {
            HR_ATTENDANCE_UPDATED
        };
        emit_status(&caller, &state, event, &employee_id, &record);
        record
    };
    let keys = [
        "id",
        "date",
        "clockIn",
        "clockOut",
        "status",
        "workedMinutes",
        "lateMinutes",
    ];
    Ok(Data(pick(&record, &keys)).into_response())
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

async fn leave(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let db = &caller.db;
    let types = list_leave_types(db, false).await?;
    let balances = leave_balances(db, &employee_id, year_of(&today_iso())).await?;
    let requests = list_leave_requests(db, Some(&employee_id), None, None, None).await?;
    let type_keys = ["id", "name", "color", "requiresApproval"];
    let request_keys = [
        "id",
        "leaveTypeId",
        "leaveTypeName",
        "leaveTypeColor",
        "startDate",
        "endDate",
        "days",
        "reason",
        "status",
        "reviewNote",
        "reviewedAt",
        "reviewedByName",
        "createdAt",
    ];
    Ok(Data(json!({
        "types": types.iter().map(|t| pick(t, &type_keys)).collect::<Vec<_>>(),
        "balances": balances,
        "requests": requests.iter().map(|r| pick(r, &request_keys)).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn request_leave(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (leave_type, start, end, reason) = hr_json(&headers, &body, |issues, fields| {
        (
            id(issues, fields, "leaveTypeId", Presence::Required),
            iso_date(issues, fields, "startDate", Presence::Required),
            iso_date(issues, fields, "endDate", Presence::Required),
            text_max(issues, fields, "reason", Presence::Nullish, 2000),
        )
    })?;
    let employee_id = self_employee_id(&state, &caller).await?;
    if !HrFeatures::load(&caller.db).await?.leave_requests {
        return Err(HrError::forbidden("Leave requests are turned off"));
    }
    let input = LeaveRequestInput {
        employee_id: &employee_id,
        leave_type_id: leave_type.as_set().map_or("", String::as_str),
        start_date: start.as_set().map_or("", String::as_str),
        end_date: end.as_set().map_or("", String::as_str),
        days: None,
        reason: reason.as_set().map(String::as_str),
    };
    let row = crate::timekeeping::create_leave_request(&caller.db, &input, &caller.user_id).await?;
    emit_leave(&caller, &state, &row, true);
    Ok(Created(row).into_response())
}

async fn cancel_leave(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::timekeeping::cancel_leave_request(&caller.db, &id, Some(&employee_id)).await?;
    emit_leave(&caller, &state, &row, false);
    Ok(Data(row).into_response())
}

// ---------------------------------------------------------------------------
// Declarations and sick reports
// ---------------------------------------------------------------------------

async fn declarations(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(
        Data(crate::declarations::employee_declarations(&caller.db, &employee_id).await?)
            .into_response(),
    )
}

async fn file_declaration(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (_, input) = crate::declarations::declaration_body(&headers, &body, false)?;
    let employee_id = self_employee_id(&state, &caller).await?;
    if !HrFeatures::load(&caller.db).await?.declarations {
        return Err(HrError::forbidden("Expense declarations are turned off"));
    }
    let row =
        crate::declarations::create_declaration(&caller.db, &employee_id, &input, &caller.user_id)
            .await?;
    emit_status(&caller, &state, HR_DECLARATION_CREATED, &employee_id, &row);
    Ok(Created(crate::declarations::to_public_declaration(&row)).into_response())
}

async fn cancel_declaration(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::declarations::cancel_declaration(&caller.db, &id, Some(&employee_id)).await?;
    emit_status(&caller, &state, HR_DECLARATION_UPDATED, &employee_id, &row);
    Ok(Data(crate::declarations::to_public_declaration(&row)).into_response())
}

async fn upload_receipt(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let file = crate::declarations::receipt_file_from(request).await?;
    let storage = crate::declarations::receipt_bucket(&caller, &state)?;
    let row = crate::declarations::attach_declaration_receipt(
        &caller,
        &storage,
        &id,
        file,
        Some(&employee_id),
    )
    .await?;
    emit_status(&caller, &state, HR_DECLARATION_UPDATED, &employee_id, &row);
    Ok(Data(crate::declarations::to_public_declaration(&row)).into_response())
}

async fn download_receipt(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let storage = crate::declarations::receipt_bucket(&caller, &state)?;
    crate::declarations::receipt_response(&caller, &storage, &id, Some(&employee_id)).await
}

async fn absences(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(Data(crate::absences::employee_absences(&caller.db, &employee_id).await?).into_response())
}

async fn report_sick(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (start, first_day, note) = crate::absences::self_absence_body(&headers, &body)?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row =
        crate::absences::report_sick(&caller, &employee_id, &start, first_day.as_deref(), note)
            .await?;
    caller.emit(&state, HR_ABSENCE_CREATED, text(&row, "id"), &[]);
    Ok(Created(row).into_response())
}

async fn recover(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let end = crate::absences::recover_body(&headers, &body)?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = crate::absences::recover_absence(
        &caller.db,
        &id,
        &end,
        &caller.user_id,
        Some(&employee_id),
    )
    .await?;
    caller.emit(&state, HR_ABSENCE_RECOVERED, text(&row, "id"), &[]);
    Ok(Data(row).into_response())
}

// ---------------------------------------------------------------------------
// Announcements, coaching, evaluations, performance
// ---------------------------------------------------------------------------

async fn announcements(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(
        Data(crate::announcements::announcements_for_employee(&caller.db, &employee_id).await?)
            .into_response(),
    )
}

async fn read_announcement(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    Ok(
        Data(crate::announcements::mark_announcement_read(&caller.db, &id, &employee_id).await?)
            .into_response(),
    )
}

async fn coaching(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let logs = list_coaching_logs(
        &caller.db,
        &CoachingFilters {
            employee_id: Some(employee_id),
            visibilities: Some(vec!["employee".to_owned(), "client".to_owned()]),
            ..CoachingFilters::default()
        },
    )
    .await?;
    let keys = [
        "id",
        "sessionDate",
        "category",
        "topic",
        "notes",
        "actionItems",
        "followUpDate",
        "status",
        "coachName",
        "acknowledgedAt",
        "employeeComment",
    ];
    Ok(Data(logs.iter().map(|l| pick(l, &keys)).collect::<Vec<_>>()).into_response())
}

/// `hrSelfAcknowledgeSchema`: `{ comment }`.
fn acknowledge_body(headers: &HeaderMap, body: &Bytes) -> Result<Option<String>, HrError> {
    let comment = hr_json(headers, body, |issues, fields| {
        text_max(issues, fields, "comment", Presence::Nullish, 5000)
    })?;
    Ok(match comment {
        Field::Set(comment) => Some(comment),
        _ => None,
    })
}

async fn acknowledge_coaching(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let comment = acknowledge_body(&headers, &body)?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = acknowledge_coaching_log(&caller.db, &id, &employee_id, comment.as_deref()).await?;
    emit_status(
        &caller,
        &state,
        HR_COACHING_LOG_ACKNOWLEDGED,
        &employee_id,
        &row,
    );
    Ok(Data(pick(&row, &["id", "acknowledgedAt", "status"])).into_response())
}

async fn evaluations(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let rows = list_evaluations(
        &caller.db,
        &EvaluationFilters {
            employee_id: Some(employee_id),
            status: Some("submitted,acknowledged".to_owned()),
            ..EvaluationFilters::default()
        },
    )
    .await?;
    let keys = [
        "id",
        "formName",
        "periodStart",
        "periodEnd",
        "criteria",
        "scores",
        "overallScore",
        "summary",
        "status",
        "evaluatorName",
        "submittedAt",
        "acknowledgedAt",
        "employeeComment",
    ];
    Ok(Data(rows.iter().map(|r| pick(r, &keys)).collect::<Vec<_>>()).into_response())
}

async fn acknowledge_evaluation_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let comment = acknowledge_body(&headers, &body)?;
    let employee_id = self_employee_id(&state, &caller).await?;
    let row = acknowledge_evaluation(&caller.db, &id, &employee_id, comment.as_deref()).await?;
    emit_status(
        &caller,
        &state,
        HR_EVALUATION_ACKNOWLEDGED,
        &employee_id,
        &row,
    );
    Ok(Data(pick(&row, &["id", "acknowledgedAt", "status"])).into_response())
}

async fn performance(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee_id = self_employee_id(&state, &caller).await?;
    let since = add_days(&today_iso(), -365);
    let kpis = list_kpi_values(
        &caller.db,
        Some(&employee_id),
        None,
        None,
        Some(&since),
        None,
    )
    .await?;
    let milestones = list_milestones(&caller.db, Some(&employee_id), None, None).await?;
    let kpi_keys = [
        "id",
        "kpiId",
        "kpiName",
        "unit",
        "direction",
        "target",
        "value",
        "onTarget",
        "periodStart",
        "periodEnd",
    ];
    let milestone_keys = [
        "id",
        "title",
        "description",
        "type",
        "status",
        "dueDate",
        "achievedAt",
        "companyName",
    ];
    Ok(Data(json!({
        "kpis": kpis.iter().map(|k| pick(k, &kpi_keys)).collect::<Vec<_>>(),
        "milestones": milestones.iter().map(|m| pick(m, &milestone_keys)).collect::<Vec<_>>(),
    }))
    .into_response())
}
