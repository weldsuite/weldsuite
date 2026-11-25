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
use sea_orm::sea_query::{Alias, Expr, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::Date;
use weldsuite_catalogs::entity_events::{
    HR_ABSENCE_CREATED, HR_ABSENCE_DELETED, HR_ABSENCE_RECOVERED, HR_ABSENCE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ABSENCES_CREATE, ABSENCES_DELETE, ABSENCES_READ, ABSENCES_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{hr_absences as absences, hr_departments, hr_employees};

use crate::employees::{display_name, no_row, pg_date, pg_date_opt, require_employee, to_json};
use crate::entity_scope::{Scope, guard, via_employee};
use crate::fields::{Fields, id, iso_date};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, assert_date_order, hr_json, js_number, js_trim,
    member_names, query_param, query_text, query_values, text, today_iso, working_days_between,
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
        .route_layer(guard("/absences", "Absence", via_employee!(hr_absences)))
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
    let row = absences::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Sick report", id))?)
}

/// `assertNoOverlap(db, employeeId, startDate, endDate, exceptId?)`.
async fn assert_no_overlap(
    db: &PgPool,
    employee_id: &str,
    start_date: &str,
    end_date: Option<&str>,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let start_date = pg_date(start_date)?;
    let end_date = pg_date_opt(end_date)?;
    let mut overlap = absences::Entity::find()
        .select_only()
        .column(absences::Column::EndDate)
        .filter(absences::Column::EmployeeId.eq(employee_id))
        .filter(
            Condition::any()
                .add(absences::Column::EndDate.is_null())
                .add(absences::Column::EndDate.gte(start_date)),
        );
    if let Some(end_date) = end_date {
        overlap = overlap.filter(absences::Column::StartDate.lte(end_date));
    }
    if let Some(except_id) = except_id {
        overlap = overlap.filter(absences::Column::Id.ne(except_id));
    }
    let overlap: Option<Option<Date>> = overlap.into_tuple().one(&orm(db)).await?;
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
    let scope = caller.scope().await?;
    let orm_db = &orm(db);
    let cursor_row: Option<(Date, String)> = match &cursor {
        Some(cursor) => {
            absences::Entity::find()
                .select_only()
                .columns([absences::Column::StartDate, absences::Column::Id])
                .filter(absences::Column::Id.eq(cursor.as_str()))
                .into_tuple()
                .one(orm_db)
                .await?
        }
        None => None,
    };
    let filters = list_filters(
        employee_id.as_deref(),
        department_id.as_deref(),
        status.as_deref(),
        pg_date(&today)?,
        &scope,
    );
    let mut page = AbsenceListRow::select().filter(filters.clone());
    if let Some((start, id)) = &cursor_row {
        use sea_orm::ExprTrait as _;
        let column = |column: absences::Column| Expr::col((absences::Entity, column));
        page = page.filter(
            Expr::tuple([
                column(absences::Column::StartDate),
                column(absences::Column::Id),
            ])
            .lt(Expr::tuple([Expr::val(*start), Expr::val(id.as_str())])),
        );
    }
    // `limit $n` with a negative `limit + 1` fails the statement (a 500).
    let page_limit = u64::try_from(limit + 1).map_err(|_| {
        HrError::Database(sea_orm::DbErr::Custom(
            "LIMIT must not be negative".to_owned(),
        ))
    })?;
    let rows: Vec<AbsenceListRow> = page
        .order_by_desc(absences::Column::StartDate)
        .order_by_desc(absences::Column::Id)
        .limit(page_limit)
        .into_model()
        .all(orm_db)
        .await?;
    let total = absences::Entity::find()
        .join(JoinType::InnerJoin, with_employee())
        .filter(filters)
        .count(orm_db)
        .await?;
    let page_size = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > page_size;
    let page: Vec<AbsenceListRow> = rows.into_iter().take(page_size).collect();
    let reporters: Vec<Option<&str>> = page
        .iter()
        .map(|row| row.absence.reported_by.as_deref())
        .collect();
    let names = member_names(db, &reporters).await?;
    let cursor = if has_more {
        page.last().map(|row| row.absence.id.clone())
    } else {
        None
    };
    let data: Vec<Value> = page
        .into_iter()
        .map(|extra| {
            let absence = to_json(&extra.absence)?;
            let reported_by = absence["reportedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .map(str::to_owned);
            let employee_id = text(&absence, "employeeId").to_owned();
            let reported_by_self = reported_by.as_deref().is_some_and(|by| {
                Some(by) == extra.employee_user_id.as_deref()
                    || by == format!("portal:{employee_id}")
            });
            let reported_by_name = reported_by
                .as_deref()
                .filter(|_| !reported_by_self)
                .and_then(|by| names.get(by).cloned());
            let mut row = present(absence, &today);
            if let Some(map) = row.as_object_mut() {
                map.insert(
                    "employeeName".to_owned(),
                    json!(display_name(
                        &extra.employee_first_name,
                        &extra.employee_last_name,
                        extra.employee_preferred_name.as_deref(),
                    )),
                );
                map.insert("departmentName".to_owned(), json!(extra.department_name));
                map.insert("relapse".to_owned(), json!(extra.relapse));
                map.insert("reportedBySelf".to_owned(), json!(reported_by_self));
                map.insert("reportedByName".to_owned(), json!(reported_by_name));
            }
            Ok(row)
        })
        .collect::<Result<_, HrError>>()?;
    Ok(List::new(data, Pagination::new(total, has_more, cursor)).into_response())
}

/// `join hr_employees e on e.id = ab.employee_id`.
fn with_employee() -> sea_orm::RelationDef {
    absences::Entity::belongs_to(hr_employees::Entity)
        .from(absences::Column::EmployeeId)
        .to(hr_employees::Column::Id)
        .into()
}

/// The list's `where` without its cursor (the page and its `count(*)`
/// share it), over the absence joined with its employee.
fn list_filters(
    employee_id: Option<&str>,
    department_id: Option<&str>,
    status: Option<&str>,
    today: Date,
    scope: &Scope,
) -> Condition {
    let mut all = Condition::all().add(hr_employees::Column::DeletedAt.is_null());
    if let Some(employee_id) = employee_id {
        all = all.add(absences::Column::EmployeeId.eq(employee_id));
    }
    if let Some(department_id) = department_id {
        all = all.add(hr_employees::Column::DepartmentId.eq(department_id));
    }
    match status {
        Some("completed") => all = all.add(absences::Column::EndDate.lt(today)),
        Some("ongoing") => {
            all = all.add(
                Condition::any()
                    .add(absences::Column::EndDate.is_null())
                    .add(absences::Column::EndDate.gte(today)),
            );
        }
        _ => {}
    }
    all.add(scope.condition(hr_employees::Column::LegalEntityId))
}

/// A sick report of the list with its employee, department and whether it
/// is a relapse.
#[derive(Debug, FromQueryResult)]
struct AbsenceListRow {
    #[sea_orm(nested)]
    absence: absences::Model,
    employee_first_name: String,
    employee_last_name: String,
    employee_preferred_name: Option<String>,
    employee_user_id: Option<String>,
    department_name: Option<String>,
    relapse: bool,
}

impl AbsenceListRow {
    /// `select ab.*, e.first_name, …, d.name, exists (<an earlier report
    /// ending within 28 days before this one starts>) from hr_absences ab
    /// join hr_employees e … left join hr_departments d on d.id =
    /// e.department_id and d.deleted_at is null`.
    fn select() -> sea_orm::Select<absences::Entity> {
        use sea_orm::ExprTrait as _;
        let previous = Alias::new("previous");
        let outer = |column: absences::Column| Expr::col((absences::Entity, column));
        let earlier = |column: absences::Column| Expr::col((previous.clone(), column));
        let relapse = Query::select()
            .expr(Expr::val(1))
            .from_as(absences::Entity, previous.clone())
            .cond_where(
                Condition::all()
                    .add(
                        earlier(absences::Column::EmployeeId)
                            .eq(outer(absences::Column::EmployeeId)),
                    )
                    .add(earlier(absences::Column::Id).ne(outer(absences::Column::Id)))
                    .add(earlier(absences::Column::EndDate).lt(outer(absences::Column::StartDate)))
                    .add(
                        earlier(absences::Column::EndDate).gte(
                            outer(absences::Column::StartDate)
                                .sub(Expr::val(i32::try_from(RELAPSE_WINDOW_DAYS).unwrap_or(28))),
                        ),
                    ),
            )
            .to_owned();
        absences::Entity::find()
            .column_as(hr_employees::Column::FirstName, "employee_first_name")
            .column_as(hr_employees::Column::LastName, "employee_last_name")
            .column_as(
                hr_employees::Column::PreferredName,
                "employee_preferred_name",
            )
            .column_as(hr_employees::Column::UserId, "employee_user_id")
            .column_as(hr_departments::Column::Name, "department_name")
            .column_as(Expr::exists(relapse), "relapse")
            .join(JoinType::InnerJoin, with_employee())
            .join(
                JoinType::LeftJoin,
                hr_employees::Entity::belongs_to(hr_departments::Entity)
                    .from(hr_employees::Column::DepartmentId)
                    .to(hr_departments::Column::Id)
                    .on_condition(|_, department| {
                        Expr::col((department, hr_departments::Column::DeletedAt))
                            .is_null()
                            .into()
                    })
                    .into(),
            )
    }
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
    let now = utc_now();
    let row = absences::Entity::insert(absences::ActiveModel {
        id: Set(generate_id("hrabs")),
        employee_id: Set(employee_id.to_owned()),
        start_date: Set(pg_date(start_date)?),
        end_date: Set(pg_date_opt(end_date)?),
        first_day: Set(first_day.unwrap_or("full").to_owned()),
        note: Set(note),
        reported_by: Set(Some(reported_by.to_owned())),
        recovered_reported_by: Set(end_date.map(|_| reported_by.to_owned())),
        recovered_reported_at: Set(end_date.map(|_| now)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    to_json(row)
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
    caller
        .assert_employee_visible(employee_id.as_set().map(String::as_str))
        .await?;
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
    let now = utc_now();
    let closing = end_date.is_some() && existing["endDate"].is_null();
    let reopening = end_date.is_none() && !existing["endDate"].is_null();
    let note_out: Option<String> = match &note_field {
        Field::Absent => existing["note"].as_str().map(str::to_owned),
        _ => note_value(&note_field),
    };
    let mut update = absences::Entity::update_many()
        .col_expr(
            absences::Column::StartDate,
            Expr::value(pg_date(&start_date)?),
        )
        .col_expr(
            absences::Column::EndDate,
            Expr::value(pg_date_opt(end_date.as_deref())?),
        )
        .col_expr(
            absences::Column::FirstDay,
            Expr::value(
                first_day
                    .as_set()
                    .map_or_else(|| text(&existing, "firstDay").to_owned(), Clone::clone),
            ),
        )
        .col_expr(absences::Column::Note, Expr::value(note_out));
    // Closing records who reported the recovery; reopening clears it.
    if closing {
        update = update
            .col_expr(
                absences::Column::RecoveredReportedBy,
                Expr::value(caller.user_id.as_str()),
            )
            .col_expr(absences::Column::RecoveredReportedAt, Expr::value(now));
    } else if reopening {
        update = update
            .col_expr(
                absences::Column::RecoveredReportedBy,
                Expr::value(Option::<String>::None),
            )
            .col_expr(
                absences::Column::RecoveredReportedAt,
                Expr::value(Option::<time::PrimitiveDateTime>::None),
            );
    }
    let row = update
        .col_expr(absences::Column::UpdatedAt, Expr::value(now))
        .filter(absences::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_absences"))?;
    let row = to_json(row)?;
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
    let now = utc_now();
    let row = absences::Entity::update_many()
        .col_expr(absences::Column::EndDate, Expr::value(pg_date(end_date)?))
        .col_expr(
            absences::Column::RecoveredReportedBy,
            Expr::value(recovered_by),
        )
        .col_expr(absences::Column::RecoveredReportedAt, Expr::value(now))
        .col_expr(absences::Column::UpdatedAt, Expr::value(now))
        .filter(absences::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_absences"))?;
    to_json(row)
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
    absences::Entity::delete_by_id(id.clone())
        .exec(&orm(&caller.db))
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
    let rows = absences::Entity::find()
        .filter(absences::Column::EmployeeId.eq(employee_id))
        .order_by_desc(absences::Column::StartDate)
        .order_by_desc(absences::Column::Id)
        .limit(100)
        .all(&orm(db))
        .await?;
    let rows: Vec<Value> = rows.into_iter().map(to_json).collect::<Result<_, _>>()?;
    let reports: Vec<Value> = rows
        .into_iter()
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
