//! Sick reports (`routes/weldhr/absences.ts`, `services/weldhr/absences.ts`).
//! The back office routes are here; employees report themselves sick under
//! `/me` ([`crate::me`]). The `hr_absence` events carry the report id only.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_ABSENCE_CREATED, HR_ABSENCE_DELETED, HR_ABSENCE_RECOVERED, HR_ABSENCE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ABSENCES_CREATE, ABSENCES_DELETE, ABSENCES_READ, ABSENCES_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, id, iso_date};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, assert_date_order, hr_json, js_number, js_trim,
    member_names, now, query_param, query_text, query_values, text, today_iso,
    working_days_between,
};

/// A sick report that starts within this many days of the previous one's end is a relapse.
pub(crate) const RELAPSE_WINDOW_DAYS: i64 = 28;
const FIRST_DAYS: [&str; 2] = ["full", "half"];

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/absences",
            get(list).route_layer(gate.require([ABSENCES_READ])),
        )
        .route(
            "/absences",
            post(create).route_layer(gate.require([ABSENCES_CREATE])),
        )
        .route(
            "/absences/{id}",
            patch(update).route_layer(gate.require([ABSENCES_UPDATE])),
        )
        .route(
            "/absences/{id}/recover",
            post(recover).route_layer(gate.require([ABSENCES_UPDATE])),
        )
        .route(
            "/absences/{id}",
            delete(remove).route_layer(gate.require([ABSENCES_DELETE])),
        )
}

/// `absenceStatus(endDate, today)`.
fn absence_status(end_date: Option<&str>, today: &str) -> &'static str {
    match end_date {
        None => "ongoing",
        Some(end) if end >= today => "ongoing",
        Some(_) => "completed",
    }
}

/// `absenceDays(absence, today)`: working days, half a day less for a
/// half first day that falls on a working day.
#[allow(clippy::cast_precision_loss)]
fn absence_days(row: &Value, today: &str) -> f64 {
    let start = text(row, "startDate");
    let end = row["endDate"].as_str().unwrap_or(today);
    let days = working_days_between(start, end) as f64;
    let starts_on_working_day = working_days_between(start, start) == 1;
    if row["firstDay"] == "half" && starts_on_working_day && days > 0.0 {
        days - 0.5
    } else {
        days
    }
}

/// `present(row, today)`: the row with its status and days.
fn present(mut row: Value, today: &str) -> Value {
    let status = absence_status(row["endDate"].as_str(), today);
    let days = absence_days(&row, today);
    if let Some(map) = row.as_object_mut() {
        map.insert("status".to_owned(), json!(status));
        map.insert("days".to_owned(), js_number(days));
    }
    row
}

/// `requireAbsence(db, id)`.
async fn require_absence(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_absences t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Sick report", id))
}

/// `assertNoOverlap(db, employeeId, startDate, endDate, exceptId?)`.
async fn assert_no_overlap(
    db: &PgPool,
    employee_id: &str,
    start_date: &str,
    end_date: Option<&str>,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let overlap: Option<Option<String>> = sqlx::query_scalar(
        "select end_date::text from hr_absences
         where employee_id = $1 and (end_date is null or end_date >= $2::date)
           and ($3::text is null or start_date <= $3::date)
           and ($4::text is null or id <> $4)
         limit 1",
    )
    .bind(employee_id)
    .bind(start_date)
    .bind(end_date)
    .bind(except_id)
    .fetch_optional(db)
    .await?;
    match overlap {
        None => Ok(()),
        Some(None) => Err(HrError::conflict("There is already an open sick report")),
        Some(Some(_)) => Err(HrError::conflict("This overlaps another sick report")),
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let status = query_param(&q, "status").filter(|s| s == "ongoing" || s == "completed");
    let employee_id = query_text(&q, "employeeId");
    let department_id = query_text(&q, "departmentId");
    #[allow(clippy::cast_possible_truncation)]
    let limit = query_text(&q, "limit")
        .map_or(50.0, |limit| crate::js_number_of(&limit))
        .min(200.0) as i64;
    let cursor = query_text(&q, "cursor");
    let today = today_iso();
    let db = &caller.db;
    let cursor_row: Option<(String, String)> = match &cursor {
        Some(cursor) => {
            sqlx::query_as("select start_date::text, id from hr_absences where id = $1 limit 1")
                .bind(cursor)
                .fetch_optional(db)
                .await?
        }
        None => None,
    };
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(ab), jsonb_build_object('firstName', e.first_name, 'lastName', e.last_name,
             'preferredName', e.preferred_name, 'employeeUserId', e.user_id, 'departmentName', d.name,
             'relapse', exists (
                 select 1 from hr_absences previous
                 where previous.employee_id = ab.employee_id and previous.id <> ab.id
                   and previous.end_date < ab.start_date
                   and previous.end_date >= ab.start_date - 28::int))
         from hr_absences ab
         join hr_employees e on e.id = ab.employee_id
         left join hr_departments d on d.id = e.department_id and d.deleted_at is null
         where e.deleted_at is null
           and ($1::text is null or ab.employee_id = $1)
           and ($2::text is null or e.department_id = $2)
           and ($3::text is null or ($3 = 'completed' and ab.end_date < $4::date)
                or ($3 = 'ongoing' and (ab.end_date is null or ab.end_date >= $4::date)))
           and ($5::text is null or (ab.start_date, ab.id) < ($5::date, $6))
         order by ab.start_date desc, ab.id desc
         limit $7",
    )
    .bind(&employee_id)
    .bind(&department_id)
    .bind(&status)
    .bind(&today)
    .bind(cursor_row.as_ref().map(|c| c.0.clone()))
    .bind(cursor_row.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from hr_absences ab join hr_employees e on e.id = ab.employee_id
         where e.deleted_at is null
           and ($1::text is null or ab.employee_id = $1)
           and ($2::text is null or e.department_id = $2)
           and ($3::text is null or ($3 = 'completed' and ab.end_date < $4::date)
                or ($3 = 'ongoing' and (ab.end_date is null or ab.end_date >= $4::date)))",
    )
    .bind(&employee_id)
    .bind(&department_id)
    .bind(&status)
    .bind(&today)
    .fetch_one(db)
    .await?;
    let page_size = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > page_size;
    let page: Vec<(Value, Value)> = rows.into_iter().take(page_size).collect();
    let reporters: Vec<Option<&str>> = page
        .iter()
        .map(|(a, _)| a["reported_by"].as_str())
        .collect();
    let names = member_names(db, &reporters).await?;
    let cursor = if has_more {
        page.last().map(|(a, _)| text(a, "id").to_owned())
    } else {
        None
    };
    let data: Vec<Value> = page
        .into_iter()
        .map(|(absence, extra)| {
            let absence = js_row(absence);
            let reported_by = absence["reportedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .map(str::to_owned);
            let employee_id = text(&absence, "employeeId").to_owned();
            let reported_by_self = reported_by.as_deref().is_some_and(|by| {
                Some(by) == extra["employeeUserId"].as_str()
                    || by == format!("portal:{employee_id}")
            });
            let reported_by_name = reported_by
                .as_deref()
                .filter(|_| !reported_by_self)
                .and_then(|by| names.get(by).cloned());
            let mut row = present(absence, &today);
            if let Some(map) = row.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(display_name_of(&extra)));
                map.insert("departmentName".to_owned(), extra["departmentName"].clone());
                map.insert("relapse".to_owned(), json!(extra["relapse"] == true));
                map.insert("reportedBySelf".to_owned(), json!(reported_by_self));
                map.insert("reportedByName".to_owned(), json!(reported_by_name));
            }
            row
        })
        .collect();
    Ok(List::new(
        data,
        Pagination::new(u64::try_from(total).unwrap_or_default(), has_more, cursor),
    )
    .into_response())
}

/// `absenceNote`: `z.string().trim().max(1000).nullable().optional()`.
fn note(issues: &mut Issues, fields: &Fields) -> Field<String> {
    issues.text_with(
        fields,
        "note",
        Presence::Nullish,
        Text::trimmed(None, Some(1000)),
    )
}

/// `note?.trim() || null`.
fn note_value(field: &Field<String>) -> Option<String> {
    field
        .as_set()
        .map(|note| js_trim(note).to_owned())
        .filter(|note| !note.is_empty())
}

/// `createAbsence(db, input, reportedBy)`.
pub(crate) async fn create_absence(
    db: &PgPool,
    employee_id: &str,
    start_date: &str,
    first_day: Option<&str>,
    end_date: Option<&str>,
    note: Option<String>,
    reported_by: &str,
) -> Result<Value, HrError> {
    require_employee(db, employee_id).await?;
    assert_date_order(Some(start_date), end_date, "Sick report")?;
    assert_no_overlap(db, employee_id, start_date, end_date, None).await?;
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into hr_absences
             (id, employee_id, start_date, end_date, first_day, note, reported_by,
              recovered_reported_by, recovered_reported_at)
         values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9::timestamp)
         returning to_jsonb(hr_absences)",
    )
    .bind(generate_id("hrabs"))
    .bind(employee_id)
    .bind(start_date)
    .bind(end_date)
    .bind(first_day.unwrap_or("full"))
    .bind(note)
    .bind(reported_by)
    .bind(end_date.map(|_| reported_by))
    .bind(end_date.map(|_| now.clone()))
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

async fn create(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (employee_id, start, first_day, end, note_field) =
        hr_json(&headers, &body, |issues, fields| {
            (
                id(issues, fields, "employeeId", Presence::Required),
                iso_date(issues, fields, "startDate", Presence::Required),
                issues.choice(fields, "firstDay", Presence::Optional, &FIRST_DAYS),
                iso_date(issues, fields, "endDate", Presence::Nullish),
                note(issues, fields),
            )
        })?;
    let row = create_absence(
        &caller.db,
        employee_id.as_set().map_or("", String::as_str),
        start.as_set().map_or("", String::as_str),
        first_day.as_set().map(String::as_str),
        end.as_set().map(String::as_str),
        note_value(&note_field),
        &caller.user_id,
    )
    .await?;
    caller.emit(&state, HR_ABSENCE_CREATED, text(&row, "id"), &[]);
    Ok(Created(row).into_response())
}

async fn update(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (start, first_day, end, note_field) = hr_json(&headers, &body, |issues, fields| {
        (
            iso_date(issues, fields, "startDate", Presence::Optional),
            issues.choice(fields, "firstDay", Presence::Optional, &FIRST_DAYS),
            iso_date(issues, fields, "endDate", Presence::Nullish),
            note(issues, fields),
        )
    })?;
    let db = &caller.db;
    let existing = require_absence(db, &id).await?;
    let start_date = start
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&existing, "startDate").to_owned());
    let end_date: Option<String> = match &end {
        Field::Absent => existing["endDate"].as_str().map(str::to_owned),
        Field::Null => None,
        Field::Set(end) => Some(end.clone()),
    };
    assert_date_order(Some(&start_date), end_date.as_deref(), "Sick report")?;
    assert_no_overlap(
        db,
        text(&existing, "employeeId"),
        &start_date,
        end_date.as_deref(),
        Some(&id),
    )
    .await?;
    let now = now();
    let closing = end_date.is_some() && existing["endDate"].is_null();
    let reopening = end_date.is_none() && !existing["endDate"].is_null();
    let note_out: Option<String> = match &note_field {
        Field::Absent => existing["note"].as_str().map(str::to_owned),
        _ => note_value(&note_field),
    };
    let row: Value = sqlx::query_scalar(
        "update hr_absences set start_date = $2::date, end_date = $3::date, first_day = $4, note = $5,
             recovered_reported_by = case when $6 then $7 when $8 then null else recovered_reported_by end,
             recovered_reported_at = case when $6 then $9::timestamp when $8 then null else recovered_reported_at end,
             updated_at = $9::timestamp
         where id = $1 returning to_jsonb(hr_absences)",
    )
    .bind(&id)
    .bind(&start_date)
    .bind(&end_date)
    .bind(first_day.as_set().map_or_else(|| text(&existing, "firstDay").to_owned(), Clone::clone))
    .bind(note_out)
    .bind(closing)
    .bind(&caller.user_id)
    .bind(reopening)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    caller.emit(&state, HR_ABSENCE_UPDATED, text(&row, "id"), &[]);
    Ok(Data(row).into_response())
}

/// `recoverAbsence(db, id, endDate, recoveredBy, onlyEmployeeId?)`.
pub(crate) async fn recover_absence(
    db: &PgPool,
    id: &str,
    end_date: &str,
    recovered_by: &str,
    only_employee_id: Option<&str>,
) -> Result<Value, HrError> {
    let existing = require_absence(db, id).await?;
    if only_employee_id.is_some_and(|only| existing["employeeId"] != only) {
        return Err(HrError::not_found("Sick report", id));
    }
    if !existing["endDate"].is_null() {
        return Err(HrError::conflict("This sick report is already closed"));
    }
    assert_date_order(
        existing["startDate"].as_str(),
        Some(end_date),
        "Sick report",
    )?;
    if only_employee_id.is_some() && end_date > today_iso().as_str() {
        return Err(HrError::validation(
            "The last sick day cannot be in the future",
        ));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_absences set end_date = $2::date, recovered_reported_by = $3,
             recovered_reported_at = $4::timestamp, updated_at = $4::timestamp
         where id = $1 returning to_jsonb(hr_absences)",
    )
    .bind(id)
    .bind(end_date)
    .bind(recovered_by)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// `recoverHrAbsenceSchema`: `{ endDate }`.
pub(crate) fn recover_body(headers: &HeaderMap, body: &Bytes) -> Result<String, HrError> {
    let end = hr_json(headers, body, |issues, fields| {
        iso_date(issues, fields, "endDate", Presence::Required)
    })?;
    Ok(end.into_option().unwrap_or_default())
}

async fn recover(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let end = recover_body(&headers, &body)?;
    let row = recover_absence(&caller.db, &id, &end, &caller.user_id, None).await?;
    caller.emit(&state, HR_ABSENCE_RECOVERED, text(&row, "id"), &[]);
    Ok(Data(row).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_absence(&caller.db, &id).await?;
    require_absence(&caller.db, &id).await?;
    sqlx::query("delete from hr_absences where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    caller.emit(&state, HR_ABSENCE_DELETED, text(&row, "id"), &[]);
    Ok(NoContent.into_response())
}

/// `hrSelfAbsenceSchema`: `(startDate, firstDay, note)`.
pub(crate) fn self_absence_body(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(String, Option<String>, Option<String>), HrError> {
    let (start, first_day, note_field) = hr_json(headers, body, |issues, fields| {
        (
            iso_date(issues, fields, "startDate", Presence::Required),
            issues.choice(fields, "firstDay", Presence::Optional, &FIRST_DAYS),
            note(issues, fields),
        )
    })?;
    Ok((
        start.into_option().unwrap_or_default(),
        first_day.into_option(),
        note_value(&note_field),
    ))
}

/// `reportSick(db, employeeId, input, reportedBy)`.
pub(crate) async fn report_sick(
    caller: &Caller,
    employee_id: &str,
    start: &str,
    first_day: Option<&str>,
    note: Option<String>,
) -> Result<Value, HrError> {
    let today = today_iso();
    if start > today.as_str() {
        return Err(HrError::validation(
            "The first sick day cannot be in the future",
        ));
    }
    if start < add_days(&today, -RELAPSE_WINDOW_DAYS).as_str() {
        return Err(HrError::validation(
            "Ask HR to add a sick report that started more than four weeks ago",
        ));
    }
    create_absence(
        &caller.db,
        employee_id,
        start,
        first_day,
        None,
        note,
        &caller.user_id,
    )
    .await
}

/// `employeeAbsences(db, employeeId)`: the open report and the history.
pub(crate) async fn employee_absences(db: &PgPool, employee_id: &str) -> Result<Value, HrError> {
    let today = today_iso();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_absences t where t.employee_id = $1
         order by t.start_date desc, t.id desc limit 100",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    let reports: Vec<Value> = rows
        .into_iter()
        .map(js_row)
        .map(|row| {
            json!({
                "id": row["id"],
                "startDate": row["startDate"],
                "endDate": row["endDate"],
                "firstDay": row["firstDay"],
                "note": row["note"],
                "status": absence_status(row["endDate"].as_str(), &today),
                "days": js_number(absence_days(&row, &today)),
                "createdAt": row["createdAt"],
            })
        })
        .collect();
    let current = reports
        .iter()
        .find(|report| report["endDate"].is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let history: Vec<Value> = reports
        .into_iter()
        .filter(|report| !report["endDate"].is_null())
        .collect();
    Ok(json!({ "current": current, "history": history }))
}
