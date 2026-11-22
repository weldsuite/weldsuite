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
use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use weldsuite_catalogs::entity_events::{
    HR_OPEN_SHIFT_UPDATED, HR_SHIFT_REQUEST_APPROVED, HR_SHIFT_REQUEST_REJECTED,
};
use weldsuite_catalogs::permission_keys::{ATTENDANCE_CREATE, ATTENDANCE_READ};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{hr_employees, hr_open_shifts, hr_shift_requests, hr_shifts};

use crate::employees::{display_name, require_employee};
use crate::entity_scope::{Scope, guard, via_employee};
use crate::fields::text_max;
use crate::open_shifts::{assert_can_sign_up, assert_open_shift_has_spot, settle_open_shift};
use crate::shared::{parse_date, row_json};
use crate::timekeeping::{
    ShiftDetails, assert_no_overlapping_shift, assert_shift_break, assert_shift_window,
    create_shift, instant, now_ms, row_instant,
};
use crate::{
    Caller, HrError, HrResult, HrState, hr_json, js_trim, member_names, query_date, query_text,
    query_values, text,
};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/shift-requests",
            get(list).route_layer(gate.require([ATTENDANCE_READ])),
        )
        .route(
            "/shift-requests/{id}/review",
            post(review).route_layer(gate.require([ATTENDANCE_CREATE])),
        )
        .route_layer(guard(
            "/shift-requests",
            "Shift request",
            via_employee!("hr_shift_requests"),
        ))
}

/// `new Date(ms)`, the instant a `timestamptz` column is written with.
fn at(ms: i64) -> OffsetDateTime {
    OffsetDateTime::UNIX_EPOCH + time::Duration::milliseconds(ms)
}

/// `${date}T<time>Z` read as a `timestamptz` (the query checks only the
/// shape): a day that doesn't exist fails the statement, as Postgres refused
/// it.
fn day_at(date: &str, time: Time) -> Result<OffsetDateTime, DbErr> {
    parse_date(date)
        .filter(|day: &Date| day.year() >= 1)
        .map(|day| PrimitiveDateTime::new(day, time).assume_utc())
        .ok_or_else(|| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp with time zone: \"{date}\""
            ))
        })
}

/// `requireShiftRequest(db, id)`.
pub(crate) async fn require_shift_request(db: &PgPool, id: &str) -> Result<Value, HrError> {
    match hr_shift_requests::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
    {
        Some(row) => Ok(row_json(row)?),
        None => Err(HrError::not_found("Shift request", id)),
    }
}

/// A shift request with its employee's names.
#[derive(FromQueryResult)]
struct RequestRow {
    #[sea_orm(nested)]
    request: hr_shift_requests::Model,
    employee_first_name: String,
    employee_last_name: String,
    employee_preferred_name: Option<String>,
}

/// `listShiftRequests(db, filters)`; `scope` is the request's entity scope.
pub(crate) async fn list_shift_requests(
    db: &PgPool,
    id: Option<&str>,
    employee_id: Option<&str>,
    status: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    use hr_shift_requests::Column;
    let statuses: Option<Vec<String>> = status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let mut requests = hr_shift_requests::Entity::find()
        .column_as(hr_employees::Column::FirstName, "employee_first_name")
        .column_as(hr_employees::Column::LastName, "employee_last_name")
        .column_as(hr_employees::Column::PreferredName, "employee_preferred_name")
        .join(
            JoinType::InnerJoin,
            hr_shift_requests::Entity::belongs_to(hr_employees::Entity)
                .from(Column::EmployeeId)
                .to(hr_employees::Column::Id)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null());
    if let Some(id) = id {
        requests = requests.filter(Column::Id.eq(id));
    }
    if let Some(employee_id) = employee_id {
        requests = requests.filter(Column::EmployeeId.eq(employee_id));
    }
    if let Some(statuses) = statuses {
        requests = requests.filter(Column::Status.is_in(statuses));
    }
    if let Some(from) = from {
        requests = requests.filter(Column::StartsAt.gte(day_at(from, Time::MIDNIGHT)?));
    }
    if let Some(to) = to {
        let end = Time::from_hms(23, 59, 59).unwrap_or(Time::MIDNIGHT);
        requests = requests.filter(Column::StartsAt.lte(day_at(to, end)?));
    }
    let rows: Vec<RequestRow> = requests
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_desc(Column::StartsAt)
        .limit(1000)
        .into_model()
        .all(&orm(db))
        .await?;
    let reviewers: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.request.reviewed_by.as_deref())
        .collect();
    let names = member_names(db, &reviewers).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let reviewer = row
            .request
            .reviewed_by
            .as_deref()
            .filter(|r| !r.is_empty())
            .and_then(|r| names.get(r).cloned());
        let name = display_name(
            &row.employee_first_name,
            &row.employee_last_name,
            row.employee_preferred_name.as_deref(),
        );
        let mut request = row_json(row.request)?;
        if let Some(map) = request.as_object_mut() {
            map.insert("employeeName".to_owned(), json!(name));
            map.insert("reviewedByName".to_owned(), json!(reviewer));
        }
        out.push(request);
    }
    Ok(out)
}

/// `shiftRequestWithNames(db, id)`.
async fn shift_request_with_names(db: &PgPool, id: &str) -> Result<Value, HrError> {
    list_shift_requests(db, Some(id), None, None, None, None, &Scope::ALL)
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
    value
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty())
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
    use hr_shift_requests::Column;
    require_employee(db, employee_id).await?;
    let starts = instant(starts_at).unwrap_or(0);
    let ends = instant(ends_at).unwrap_or(0);
    assert_shift_window(starts, ends)?;
    if starts <= now_ms() {
        return Err(HrError::validation(
            "Ask for a shift that has not started yet",
        ));
    }
    assert_no_overlapping_shift(
        db,
        employee_id,
        starts,
        ends,
        None,
        Some("You already have a shift at this time"),
    )
    .await?;
    let db = orm(db);
    let waiting: Option<String> = hr_shift_requests::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::EmployeeId.eq(employee_id))
        .filter(Column::Status.eq("pending"))
        .filter(Column::StartsAt.lt(at(ends)))
        .filter(Column::EndsAt.gt(at(starts)))
        .into_tuple()
        .one(&db)
        .await?;
    if waiting.is_some() {
        return Err(HrError::conflict(
            "You already asked for a shift at this time",
        ));
    }
    let row = hr_shift_requests::Entity::insert(hr_shift_requests::ActiveModel {
        id: Set(generate_id("hrsrq")),
        employee_id: Set(employee_id.to_owned()),
        open_shift_id: Set(open_shift_id.map(str::to_owned)),
        starts_at: Set(at(starts)),
        ends_at: Set(at(ends)),
        work_type: Set(trimmed(work_type)),
        note: Set(trimmed(note)),
        status: Set("pending".to_owned()),
        requested_by: Set(Some(requested_by.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await?;
    Ok(row_json(row)?)
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
    let now = utc_now();
    let request_id = text(request, "id").to_owned();
    let open_id = text(open, "id").to_owned();
    let mut tx = db.begin().await?;
    {
        let tx = OrmConn::new(&mut tx);
        hr_open_shifts::Entity::update_many()
            .col_expr(hr_open_shifts::Column::UpdatedAt, Expr::value(now))
            .filter(hr_open_shifts::Column::Id.eq(open_id.as_str()))
            .exec(&tx)
            .await?;
        hr_shifts::Entity::insert(hr_shifts::ActiveModel {
            id: Set(shift_id.clone()),
            employee_id: Set(employee_id.clone()),
            company_id: Set(open["companyId"].as_str().map(str::to_owned)),
            starts_at: Set(at(starts)),
            ends_at: Set(at(ends)),
            work_type: Set(request["workType"].as_str().map(str::to_owned)),
            break_starts_at: Set(bs.map(at)),
            break_ends_at: Set(be.map(at)),
            notes: Set(open["notes"].as_str().map(str::to_owned)),
            created_by: Set(Some(reviewed_by.to_owned())),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        // Approved only while the open shift has a spot left.
        hr_shift_requests::Entity::update_many()
            .col_expr(hr_shift_requests::Column::Status, Expr::value("approved"))
            .col_expr(
                hr_shift_requests::Column::ShiftId,
                Expr::value(shift_id.as_str()),
            )
            .col_expr(hr_shift_requests::Column::ReviewNote, Expr::value(note))
            .col_expr(
                hr_shift_requests::Column::ReviewedBy,
                Expr::value(reviewed_by),
            )
            .col_expr(hr_shift_requests::Column::ReviewedAt, Expr::value(now))
            .col_expr(hr_shift_requests::Column::UpdatedAt, Expr::value(now))
            .filter(hr_shift_requests::Column::Id.eq(request_id.as_str()))
            .filter(hr_shift_requests::Column::Status.eq("pending"))
            .filter(spot_left(&open_id))
            .exec(&tx)
            .await?;
        // The shift goes again when the request wasn't approved with it.
        let kept = Query::select()
            .expr(Expr::val(1))
            .from(hr_shift_requests::Entity)
            .and_where(hr_shift_requests::Column::Id.eq(request_id.as_str()))
            .and_where(hr_shift_requests::Column::ShiftId.eq(shift_id.as_str()))
            .to_owned();
        hr_shifts::Entity::delete_many()
            .filter(hr_shifts::Column::Id.eq(shift_id.as_str()))
            .filter(Condition::all().add(Expr::exists(kept)).not())
            .exec(&tx)
            .await?;
    }
    tx.commit().await?;
    let after = require_shift_request(db, &request_id).await?;
    if after["shiftId"] == shift_id.as_str() {
        return Ok(after);
    }
    if after["status"] != "pending" {
        return Err(HrError::conflict(
            "This request was answered in the meantime",
        ));
    }
    Err(HrError::conflict("All spots on this shift are filled"))
}

/// `(select count(*) from hr_shift_requests r join hr_shifts s on s.id =
/// r.shift_id where r.open_shift_id = $open and r.status = 'approved') <
/// (select o.spots from hr_open_shifts o where o.id = $open and o.status =
/// 'open')`: the open shift still has a spot.
fn spot_left(open_id: &str) -> Expr {
    use sea_orm::ExprTrait as _;
    let (r, s) = (Alias::new("r"), Alias::new("s"));
    let approved: SelectStatement = Query::select()
        .expr(Func::count(Expr::col(Asterisk)))
        .from_as(hr_shift_requests::Entity, r.clone())
        .join_as(
            JoinType::InnerJoin,
            hr_shifts::Entity,
            s.clone(),
            Expr::col((s, hr_shifts::Column::Id))
                .equals((r.clone(), hr_shift_requests::Column::ShiftId)),
        )
        .and_where(Expr::col((r.clone(), hr_shift_requests::Column::OpenShiftId)).eq(open_id))
        .and_where(Expr::col((r, hr_shift_requests::Column::Status)).eq("approved"))
        .to_owned();
    let o = Alias::new("o");
    let spots: SelectStatement = Query::select()
        .column((o.clone(), hr_open_shifts::Column::Spots))
        .from_as(hr_open_shifts::Entity, o.clone())
        .and_where(Expr::col((o.clone(), hr_open_shifts::Column::Id)).eq(open_id))
        .and_where(Expr::col((o, hr_open_shifts::Column::Status)).eq("open"))
        .to_owned();
    Expr::from(approved).lt(Expr::from(spots))
}

/// `reviewShiftRequest(db, id, input, reviewedBy)`.
async fn review_shift_request(
    db: &PgPool,
    id: &str,
    decision: &str,
    note: Option<&str>,
    reviewed_by: &str,
) -> Result<Value, HrError> {
    use hr_shift_requests::Column;
    let existing = require_shift_request(db, id).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!(
            "This request is already {}",
            text(&existing, "status")
        )));
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
    let now = utc_now();
    let row = hr_shift_requests::Entity::update_many()
        .col_expr(Column::Status, Expr::value(decision))
        .col_expr(
            Column::ShiftId,
            Expr::value(shift.as_ref().and_then(|s| s["id"].as_str()).map(str::to_owned)),
        )
        .col_expr(Column::ReviewNote, Expr::value(trimmed(note)))
        .col_expr(Column::ReviewedBy, Expr::value(reviewed_by))
        .col_expr(Column::ReviewedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::Status.eq("pending"))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    let Some(row) = row else {
        if let Some(shift) = &shift {
            hr_shifts::Entity::delete_by_id(text(shift, "id").to_owned())
                .exec(&orm(db))
                .await?;
        }
        return Err(HrError::conflict(
            "This request was answered in the meantime",
        ));
    };
    Ok(row_json(row)?)
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
        &caller.scope().await?,
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
            issues.choice(
                fields,
                "decision",
                Presence::Required,
                &["approved", "rejected"],
            ),
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
    let event = if row["status"] == "approved" {
        HR_SHIFT_REQUEST_APPROVED
    } else {
        HR_SHIFT_REQUEST_REJECTED
    };
    caller.emit(
        &state,
        event,
        text(&row, "id"),
        &[
            ("employeeId", Some(row["employeeId"].clone())),
            ("status", Some(row["status"].clone())),
        ],
    );
    if let Some(open_shift_id) = row["openShiftId"].as_str().filter(|o| !o.is_empty())
        && row["status"] == "approved"
    {
        for (closed, employee, status) in
            settle_open_shift(db, open_shift_id, &caller.user_id).await?
        {
            caller.emit(
                &state,
                HR_SHIFT_REQUEST_REJECTED,
                &closed,
                &[
                    ("employeeId", Some(json!(employee))),
                    ("status", Some(json!(status))),
                ],
            );
        }
        caller.emit(&state, HR_OPEN_SHIFT_UPDATED, open_shift_id, &[]);
    }
    Ok(Data(shift_request_with_names(db, text(&row, "id")).await?).into_response())
}

/// `cancelShiftRequest(db, id, employeeId)`.
pub(crate) async fn cancel_shift_request(
    db: &PgPool,
    id: &str,
    employee_id: &str,
) -> Result<Value, HrError> {
    let existing = require_shift_request(db, id).await?;
    if existing["employeeId"] != employee_id {
        return Err(HrError::not_found("Shift request", id));
    }
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!(
            "This request is already {}",
            text(&existing, "status")
        )));
    }
    let row = hr_shift_requests::Entity::update_many()
        .col_expr(hr_shift_requests::Column::Status, Expr::value("cancelled"))
        .col_expr(hr_shift_requests::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_shift_requests::Column::Id.eq(id))
        .filter(hr_shift_requests::Column::Status.eq("pending"))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    match row {
        Some(row) => Ok(row_json(row)?),
        None => Err(HrError::conflict(
            "This request was answered in the meantime",
        )),
    }
}
