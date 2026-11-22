//! Coaching, evaluation forms, evaluations, KPI definitions, KPI values and
//! milestones (`routes/weldhr/performance.ts`, `services/weldhr/performance.ts`).
//!
//! Writes that spread the validated body into Drizzle's `.values()` /
//! `.set()` go through the entity's [`JsonTable`] (`jsonb_populate_record`):
//! the body's fields as columns, a column the body left out keeping its
//! value (or its default).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, NullOrdering, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, Order,
    QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_COACHING_LOG_CREATED, HR_COACHING_LOG_DELETED, HR_COACHING_LOG_UPDATED,
    HR_EVALUATION_CREATED, HR_EVALUATION_DELETED, HR_EVALUATION_SUBMITTED, HR_EVALUATION_UPDATED,
    HR_KPI_VALUE_CREATED, HR_KPI_VALUE_DELETED, HR_KPI_VALUE_UPDATED, HR_MILESTONE_ACHIEVED,
    HR_MILESTONE_CREATED, HR_MILESTONE_DELETED, HR_MILESTONE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    COACHING_CREATE, COACHING_DELETE, COACHING_READ, COACHING_UPDATE, EMPLOYEES_MANAGE,
    EVALUATIONS_CREATE, EVALUATIONS_DELETE, EVALUATIONS_READ, EVALUATIONS_UPDATE,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    hr_coaching_logs, hr_employees, hr_evaluation_forms, hr_evaluations, hr_kpi_definitions,
    hr_kpi_values, hr_milestones,
};

use crate::employees::{display_name, require_employee};
use crate::entity_scope::{Scope, guard, via_employee};
use crate::fields::{Fields, field_json, id, iso_date, number, short_text, text_max};
use crate::shared::{row_json, sql_date};
use crate::{
    Caller, HrError, HrResult, HrState, assert_date_order, company_names, hr_json, js_number,
    js_round, member_names, now, query_date, query_param, query_text, query_values, text,
    today_iso,
};

const COACHING_LOGS: JsonTable = JsonTable::of::<hr_coaching_logs::Entity>();
const EVALUATION_FORMS: JsonTable = JsonTable::of::<hr_evaluation_forms::Entity>();
const EVALUATIONS: JsonTable = JsonTable::of::<hr_evaluations::Entity>();
const KPI_DEFINITIONS: JsonTable = JsonTable::of::<hr_kpi_definitions::Entity>();
const KPI_VALUES: JsonTable = JsonTable::of::<hr_kpi_values::Entity>();
const MILESTONES: JsonTable = JsonTable::of::<hr_milestones::Entity>();

const COACHING_CATEGORIES: [&str; 6] = [
    "performance",
    "quality",
    "behavior",
    "attendance",
    "development",
    "recognition",
];
const COACHING_STATUSES: [&str; 3] = ["open", "acknowledged", "closed"];
const VISIBILITIES: [&str; 3] = ["internal", "employee", "client"];
const KPI_UNITS: [&str; 5] = ["number", "percent", "seconds", "minutes", "currency"];
const KPI_DIRECTIONS: [&str; 2] = ["higher_better", "lower_better"];
const MILESTONE_TYPES: [&str; 3] = ["goal", "milestone", "certification"];
const MILESTONE_STATUSES: [&str; 4] = ["planned", "in_progress", "achieved", "missed"];

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    let eval_read = || gate.require([EVALUATIONS_READ]);
    Router::new()
        .route(
            "/coaching",
            get(list_coaching).route_layer(gate.require([COACHING_READ])),
        )
        .route(
            "/coaching/{id}",
            get(get_coaching).route_layer(gate.require([COACHING_READ])),
        )
        .route(
            "/coaching",
            post(create_coaching).route_layer(gate.require([COACHING_CREATE])),
        )
        .route(
            "/coaching/{id}",
            patch(update_coaching).route_layer(gate.require([COACHING_UPDATE])),
        )
        .route(
            "/coaching/{id}",
            delete(delete_coaching).route_layer(gate.require([COACHING_DELETE])),
        )
        .route(
            "/evaluation-forms",
            get(list_forms).route_layer(eval_read()),
        )
        .route("/evaluation-forms", post(create_form).route_layer(manage()))
        .route(
            "/evaluation-forms/{id}",
            patch(update_form).route_layer(manage()),
        )
        .route(
            "/evaluation-forms/{id}",
            delete(delete_form).route_layer(manage()),
        )
        .route(
            "/evaluations",
            get(list_evaluations_route).route_layer(eval_read()),
        )
        .route(
            "/evaluations/{id}",
            get(get_evaluation).route_layer(eval_read()),
        )
        .route(
            "/evaluations",
            post(create_evaluation).route_layer(gate.require([EVALUATIONS_CREATE])),
        )
        .route(
            "/evaluations/{id}",
            patch(update_evaluation).route_layer(gate.require([EVALUATIONS_UPDATE])),
        )
        .route(
            "/evaluations/{id}",
            delete(delete_evaluation).route_layer(gate.require([EVALUATIONS_DELETE])),
        )
        .route("/kpis", get(list_kpis).route_layer(eval_read()))
        .route("/kpis", post(create_kpi).route_layer(manage()))
        .route("/kpis/{id}", patch(update_kpi).route_layer(manage()))
        .route("/kpis/{id}", delete(delete_kpi).route_layer(manage()))
        .route(
            "/kpi-values",
            get(list_kpi_values_route).route_layer(eval_read()),
        )
        .route(
            "/kpi-values",
            post(create_kpi_value).route_layer(gate.require([EVALUATIONS_CREATE])),
        )
        .route(
            "/kpi-values/import",
            post(import_kpi_values).route_layer(gate.require([EVALUATIONS_CREATE])),
        )
        .route(
            "/kpi-values/{id}",
            patch(update_kpi_value).route_layer(gate.require([EVALUATIONS_UPDATE])),
        )
        .route(
            "/kpi-values/{id}",
            delete(delete_kpi_value).route_layer(gate.require([EVALUATIONS_DELETE])),
        )
        .route(
            "/milestones",
            get(list_milestones_route).route_layer(eval_read()),
        )
        .route(
            "/milestones",
            post(create_milestone).route_layer(gate.require([EVALUATIONS_CREATE])),
        )
        .route(
            "/milestones/{id}",
            patch(update_milestone).route_layer(gate.require([EVALUATIONS_UPDATE])),
        )
        .route(
            "/milestones/{id}",
            delete(delete_milestone).route_layer(gate.require([EVALUATIONS_DELETE])),
        )
        .route_layer(guard(
            "/coaching",
            "Coaching log",
            via_employee!("hr_coaching_logs"),
        ))
        .route_layer(guard(
            "/evaluations",
            "Evaluation",
            via_employee!("hr_evaluations"),
        ))
        .route_layer(guard(
            "/kpi-values",
            "KPI value",
            via_employee!("hr_kpi_values"),
        ))
        .route_layer(guard(
            "/milestones",
            "Milestone",
            via_employee!("hr_milestones"),
        ))
}

/// The body's present fields, keyed by column, for `jsonb_populate_record`.
fn record(fields: &[(&str, Option<Value>)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (column, value) in fields {
        if let Some(value) = value {
            out.insert((*column).to_owned(), value.clone());
        }
    }
    out
}

/// `insert into <table> as t (<columns>) select r.<column>, … from
/// jsonb_populate_record(null::<table>, $1) r returning to_jsonb(t)`: every
/// one of `columns` is written (NULL where the body has no value), each of
/// `defaults` as `coalesce(r.<column>, <default>)`.
async fn insert_record(
    db: &PgPool,
    table: JsonTable,
    mut values: Map<String, Value>,
    columns: &[&str],
    defaults: &[(&str, Value)],
) -> Result<Value, DbErr> {
    values.retain(|column, _| columns.contains(&column.as_str()));
    for column in columns {
        values.entry((*column).to_owned()).or_insert(Value::Null);
    }
    for (column, default) in defaults {
        if values.get(*column).is_none_or(Value::is_null) {
            values.insert((*column).to_owned(), default.clone());
        }
    }
    table.insert(&orm(db), values).await
}

/// `update <table> as t set <column> = case when $1 ? '<column>' then
/// r.<column> else t.<column> end, …, updated_at = $now from
/// jsonb_populate_record(null::<table>, $1) r where t.id = $id returning
/// to_jsonb(t)`: the fields `values` has change, and `updated_at` (now,
/// unless `values` sets it).
async fn update_record(
    db: &PgPool,
    table: JsonTable,
    id: &str,
    mut values: Map<String, Value>,
) -> Result<Value, DbErr> {
    values
        .entry("updated_at".to_owned())
        .or_insert_with(|| json!(now()));
    table
        .update(&orm(db), id, values, false)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("{} {id}", table.table_name())))
}

/// The display name columns of a row's employee
/// (`jsonb_build_object('employeeFirstName', e.first_name, …)`).
#[derive(FromQueryResult)]
struct EmployeeNames {
    #[sea_orm(alias = "employee_first_name")]
    first: String,
    #[sea_orm(alias = "employee_last_name")]
    last: String,
    #[sea_orm(alias = "employee_preferred_name")]
    preferred: Option<String>,
}

impl EmployeeNames {
    /// `employeeName(row)`.
    fn display(&self) -> String {
        display_name(&self.first, &self.last, self.preferred.as_deref())
    }
}

/// `select` joined to its row's employee (`join hr_employees e on e.id =
/// <employee_id> where e.deleted_at is null`), with [`EmployeeNames`].
fn with_employee<E: EntityTrait>(select: Select<E>, employee_id: E::Column) -> Select<E> {
    select
        .column_as(hr_employees::Column::FirstName, "employee_first_name")
        .column_as(hr_employees::Column::LastName, "employee_last_name")
        .column_as(
            hr_employees::Column::PreferredName,
            "employee_preferred_name",
        )
        .join(
            JoinType::InnerJoin,
            E::belongs_to(hr_employees::Entity)
                .from(employee_id)
                .to(hr_employees::Column::Id)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null())
}

/// `col = any($statuses)` for a comma separated `status` query.
fn statuses_of(status: Option<&str>) -> Option<Vec<String>> {
    status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect())
}

/// The entity's rows as the API returns them.
fn rows_json<T: serde::Serialize>(rows: Vec<T>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter().map(row_json).collect()
}

/// `{ employeeId, status }` / `{ employeeId, companyId }` event data.
fn emit(
    caller: &Caller,
    state: &HrState,
    event: weldsuite_catalogs::entity_events::EventName,
    row: &Value,
    keys: &[&str],
) {
    let fields: Vec<(&str, Option<Value>)> =
        keys.iter().map(|k| (*k, Some(row[*k].clone()))).collect();
    caller.emit(state, event, text(row, "id"), &fields);
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

/// `requireCoachingLog(db, id)`.
pub(crate) async fn require_coaching_log(db: &PgPool, id: &str) -> Result<Value, HrError> {
    COACHING_LOGS
        .find(&orm(db), id, true)
        .await?
        .ok_or_else(|| HrError::not_found("Coaching log", id))
}

/// `listCoachingLogs(db, filters)`.
#[derive(Default)]
pub(crate) struct CoachingFilters {
    pub(crate) employee_id: Option<String>,
    pub(crate) company_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) follow_up_due: bool,
    pub(crate) visibilities: Option<Vec<String>>,
    /// The request's entity scope on the employees.
    pub(crate) entity: Scope,
}

/// A coaching log with its employee's names.
#[derive(FromQueryResult)]
struct CoachingRow {
    #[sea_orm(nested)]
    log: hr_coaching_logs::Model,
    #[sea_orm(nested)]
    employee: EmployeeNames,
}

/// `c.follow_up_date is not null and c.follow_up_date <= current_date and
/// c.status <> 'closed'`.
fn follow_up_due() -> Condition {
    use hr_coaching_logs::{Column, Entity};
    use sea_orm::ExprTrait as _;
    Condition::all()
        .add(Column::FollowUpDate.is_not_null())
        .add(Expr::col((Entity, Column::FollowUpDate)).lte(Expr::current_date()))
        .add(Column::Status.ne("closed"))
}

pub(crate) async fn list_coaching_logs(
    db: &PgPool,
    filters: &CoachingFilters,
) -> Result<Vec<Value>, HrError> {
    use hr_coaching_logs::Column;
    let mut logs = with_employee(hr_coaching_logs::Entity::find(), Column::EmployeeId)
        .filter(Column::DeletedAt.is_null());
    if let Some(employee_id) = &filters.employee_id {
        logs = logs.filter(Column::EmployeeId.eq(employee_id.as_str()));
    }
    if let Some(company_id) = &filters.company_id {
        logs = logs.filter(Column::CompanyId.eq(company_id.as_str()));
    }
    if let Some(statuses) = statuses_of(filters.status.as_deref()) {
        logs = logs.filter(Column::Status.is_in(statuses));
    }
    if let Some(category) = &filters.category {
        logs = logs.filter(Column::Category.eq(category.as_str()));
    }
    if let Some(from) = &filters.from {
        logs = logs.filter(Column::SessionDate.gte(sql_date(from)?));
    }
    if let Some(to) = &filters.to {
        logs = logs.filter(Column::SessionDate.lte(sql_date(to)?));
    }
    if let Some(visibilities) = &filters.visibilities {
        logs = logs.filter(Column::Visibility.is_in(visibilities.iter().map(String::as_str)));
    }
    if filters.follow_up_due {
        logs = logs.filter(follow_up_due());
    }
    let rows: Vec<CoachingRow> = logs
        .filter(
            filters
                .entity
                .condition(hr_employees::Column::LegalEntityId),
        )
        .order_by_desc(Column::SessionDate)
        .order_by_desc(Column::CreatedAt)
        .limit(1000)
        .into_model()
        .all(&orm(db))
        .await?;
    let coaches: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.log.coach_user_id.as_deref())
        .collect();
    let companies: Vec<Option<&str>> = rows.iter().map(|r| r.log.company_id.as_deref()).collect();
    let coach_names = member_names(db, &coaches).await?;
    let company_name = company_names(db, &companies).await?;
    let rows: Vec<(Value, String)> = rows
        .into_iter()
        .map(|row| Ok((row_json(row.log)?, row.employee.display())))
        .collect::<Result<_, DbErr>>()?;
    Ok(rows
        .into_iter()
        .map(|(mut log, employee_name)| {
            let coach = if log["coachName"].is_null() {
                json!(
                    log["coachUserId"]
                        .as_str()
                        .filter(|c| !c.is_empty())
                        .and_then(|c| coach_names.get(c).cloned())
                )
            } else {
                log["coachName"].clone()
            };
            let company = log["companyId"]
                .as_str()
                .filter(|c| !c.is_empty())
                .and_then(|c| company_name.get(c).cloned());
            if let Some(map) = log.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name));
                map.insert("coachName".to_owned(), coach);
                map.insert("companyName".to_owned(), json!(company));
            }
            log
        })
        .collect())
}

async fn list_coaching(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let filters = CoachingFilters {
        employee_id: query_text(&q, "employeeId"),
        company_id: query_text(&q, "companyId"),
        status: query_text(&q, "status"),
        category: query_text(&q, "category"),
        from: query_date(&q, "from"),
        to: query_date(&q, "to"),
        follow_up_due: query_param(&q, "followUpDue").as_deref() == Some("true"),
        visibilities: None,
        entity: caller.scope().await?,
    };
    Ok(Data(list_coaching_logs(&caller.db, &filters).await?).into_response())
}

async fn get_coaching(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(require_coaching_log(&caller.db, &id).await?).into_response())
}

/// `hrCoachingActionItemSchema`.
fn action_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let item_id = issues.text(fields, "id", Presence::Required, Some(1), Some(40));
    let item_text = short_text(issues, fields, "text", Presence::Required, 500, true);
    let done = issues.boolean(fields, "done", Presence::Required);
    Some(json!({ "id": item_id.as_set()?, "text": item_text.as_set()?, "done": done.as_set()? }))
}

/// The coaching schema's fields by column, in order.
fn coaching_fields(
    issues: &mut Issues,
    fields: &Fields,
    partial: bool,
) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push((
            "employee_id",
            field_json(&id(issues, fields, "employeeId", Presence::Required)),
        ));
    }
    out.push((
        "company_id",
        field_json(&id(issues, fields, "companyId", Presence::Nullish)),
    ));
    out.push((
        "coach_user_id",
        field_json(&text_max(
            issues,
            fields,
            "coachUserId",
            Presence::Nullish,
            255,
        )),
    ));
    out.push((
        "coach_name",
        field_json(&short_text(
            issues,
            fields,
            "coachName",
            Presence::Nullish,
            255,
            false,
        )),
    ));
    out.push((
        "session_date",
        field_json(&iso_date(issues, fields, "sessionDate", required)),
    ));
    out.push((
        "category",
        field_json(&issues.choice(fields, "category", Presence::Optional, &COACHING_CATEGORIES)),
    ));
    out.push((
        "topic",
        field_json(&short_text(issues, fields, "topic", required, 255, true)),
    ));
    out.push((
        "notes",
        field_json(&text_max(issues, fields, "notes", Presence::Nullish, 20000)),
    ));
    out.push((
        "action_items",
        field_json(&issues.list(
            fields,
            "actionItems",
            Presence::Optional,
            None,
            Some(50),
            action_item,
        )),
    ));
    out.push((
        "follow_up_date",
        field_json(&iso_date(issues, fields, "followUpDate", Presence::Nullish)),
    ));
    out.push((
        "status",
        field_json(&issues.choice(fields, "status", Presence::Optional, &COACHING_STATUSES)),
    ));
    out.push((
        "visibility",
        field_json(&issues.choice(fields, "visibility", Presence::Optional, &VISIBILITIES)),
    ));
    out
}

fn get_field<'a>(fields: &'a [(&str, Option<Value>)], column: &str) -> Option<&'a Value> {
    fields
        .iter()
        .find(|(c, _)| *c == column)
        .and_then(|(_, v)| v.as_ref())
}

fn set_field(fields: &mut Vec<(&'static str, Option<Value>)>, column: &'static str, value: Value) {
    if let Some(slot) = fields.iter_mut().find(|(c, _)| *c == column) {
        slot.1 = Some(value);
    } else {
        fields.push((column, Some(value)));
    }
}

/// `assertFollowUpAfterSession(sessionDate, followUpDate)`.
fn assert_follow_up(session: &str, follow_up: Option<&str>) -> Result<(), HrError> {
    if let Some(follow_up) = follow_up.filter(|f| !f.is_empty())
        && follow_up < session
    {
        return Err(HrError::validation(
            "The follow-up date cannot be before the session date",
        ));
    }
    Ok(())
}

async fn create_coaching(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| {
        coaching_fields(issues, fields, false)
    })?;
    caller
        .assert_employee_visible(get_field(&input, "employee_id").and_then(Value::as_str))
        .await?;
    let db = &caller.db;
    let session = get_field(&input, "session_date")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    assert_follow_up(
        &session,
        get_field(&input, "follow_up_date").and_then(Value::as_str),
    )?;
    require_employee(
        db,
        get_field(&input, "employee_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .await?;
    let coach_user = get_field(&input, "coach_user_id")
        .and_then(Value::as_str)
        .map_or_else(|| caller.user_id.clone(), str::to_owned);
    let mut coach_name = get_field(&input, "coach_name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if coach_name.as_deref().is_none_or(str::is_empty) {
        coach_name = member_names(db, &[Some(coach_user.as_str())])
            .await?
            .get(&coach_user)
            .cloned();
    }
    set_field(&mut input, "coach_user_id", json!(coach_user));
    set_field(&mut input, "coach_name", json!(coach_name));
    if get_field(&input, "action_items").is_none() {
        set_field(&mut input, "action_items", json!([]));
    }
    set_field(&mut input, "id", json!(generate_id("hrcch")));
    let row = insert_record(
        db,
        COACHING_LOGS,
        record(&input),
        &[
            "id",
            "employee_id",
            "company_id",
            "coach_user_id",
            "coach_name",
            "session_date",
            "category",
            "topic",
            "notes",
            "action_items",
            "follow_up_date",
            "status",
            "visibility",
        ],
        &[
            ("category", json!("performance")),
            ("status", json!("open")),
            ("visibility", json!("employee")),
        ],
    )
    .await?;
    emit(
        &caller,
        &state,
        HR_COACHING_LOG_CREATED,
        &row,
        &["employeeId", "status"],
    );
    Ok(Created(row).into_response())
}

async fn update_coaching(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        coaching_fields(issues, fields, true)
    })?;
    let db = &caller.db;
    let before = require_coaching_log(db, &id).await?;
    let existing = require_coaching_log(db, &id).await?;
    let session = get_field(&input, "session_date")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(&existing, "sessionDate"))
        .to_owned();
    let follow_up = if input
        .iter()
        .any(|(c, v)| *c == "follow_up_date" && v.is_some())
    {
        get_field(&input, "follow_up_date")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        existing["followUpDate"].as_str().map(str::to_owned)
    };
    assert_follow_up(&session, follow_up.as_deref())?;
    let row = update_record(db, COACHING_LOGS, text(&before, "id"), record(&input)).await?;
    emit(
        &caller,
        &state,
        HR_COACHING_LOG_UPDATED,
        &row,
        &["employeeId", "status"],
    );
    Ok(Data(row).into_response())
}

async fn delete_coaching(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let row = require_coaching_log(&caller.db, &id).await?;
    require_coaching_log(&caller.db, &id).await?;
    let at = utc_now();
    hr_coaching_logs::Entity::update_many()
        .col_expr(hr_coaching_logs::Column::DeletedAt, Expr::value(at))
        .col_expr(hr_coaching_logs::Column::UpdatedAt, Expr::value(at))
        .filter(hr_coaching_logs::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    emit(
        &caller,
        &state,
        HR_COACHING_LOG_DELETED,
        &row,
        &["employeeId"],
    );
    Ok(NoContent.into_response())
}

/// `acknowledgeCoachingLog(db, id, employeeId, comment)`.
pub(crate) async fn acknowledge_coaching_log(
    db: &PgPool,
    id: &str,
    employee_id: &str,
    comment: Option<&str>,
) -> Result<Value, HrError> {
    use hr_coaching_logs::Column;
    let log = require_coaching_log(db, id).await?;
    if log["employeeId"] != employee_id || log["visibility"] == "internal" {
        return Err(HrError::not_found("Coaching log", id));
    }
    if !log["acknowledgedAt"].is_null() {
        return Err(HrError::conflict("Already acknowledged"));
    }
    let status = if log["status"] == "open" {
        "acknowledged"
    } else {
        text(&log, "status")
    };
    let at = utc_now();
    let row = hr_coaching_logs::Entity::update_many()
        .col_expr(Column::AcknowledgedAt, Expr::value(at))
        .col_expr(
            Column::EmployeeComment,
            Expr::value(comment.map(str::to_owned)),
        )
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound(format!("hr_coaching_logs {id}")))?;
    Ok(row_json(row)?)
}

// ---------------------------------------------------------------------------
// Evaluation forms
// ---------------------------------------------------------------------------

async fn list_evaluation_forms(db: &PgPool, include_inactive: bool) -> Result<Vec<Value>, HrError> {
    use hr_evaluation_forms::Column;
    let mut forms = hr_evaluation_forms::Entity::find().filter(Column::DeletedAt.is_null());
    if !include_inactive {
        forms = forms.filter(Column::IsActive.eq(true));
    }
    let rows = forms.order_by_asc(Column::Name).all(&orm(db)).await?;
    Ok(rows_json(rows)?)
}

async fn require_evaluation_form(db: &PgPool, id: &str) -> Result<Value, HrError> {
    EVALUATION_FORMS
        .find(&orm(db), id, true)
        .await?
        .ok_or_else(|| HrError::not_found("Evaluation form", id))
}

async fn list_forms(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let include =
        query_param(&query_values(query.as_deref()), "activeOnly").as_deref() != Some("true");
    Ok(Data(list_evaluation_forms(&caller.db, include).await?).into_response())
}

/// `hrEvaluationCriterionSchema`.
fn criterion(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let item_id = issues.text(fields, "id", Presence::Required, Some(1), Some(40));
    let label = short_text(issues, fields, "label", Presence::Required, 200, true);
    let description = text_max(issues, fields, "description", Presence::Nullish, 1000);
    let weight = number(
        issues,
        fields,
        "weight",
        Presence::Required,
        Some(0.0),
        Some(100.0),
    );
    let max_score = number(
        issues,
        fields,
        "maxScore",
        Presence::Required,
        Some(1.0),
        Some(100.0),
    );
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(item_id.as_set()?));
    out.insert("label".to_owned(), json!(label.as_set()?));
    if let Some(description) = field_json(&description) {
        out.insert("description".to_owned(), description);
    }
    out.insert("weight".to_owned(), js_number(*weight.as_set()?));
    out.insert("maxScore".to_owned(), js_number(*max_score.as_set()?));
    Some(Value::Object(out))
}

/// `assertCriteria(criteria)`.
fn assert_criteria(criteria: &[Value]) -> Result<(), HrError> {
    let mut ids: Vec<&str> = Vec::new();
    for c in criteria {
        let id = text(c, "id");
        if ids.contains(&id) {
            return Err(HrError::validation(format!(
                "Duplicate criterion id \"{id}\""
            )));
        }
        ids.push(id);
    }
    let total: f64 = criteria
        .iter()
        .map(|c| c["weight"].as_f64().unwrap_or(0.0))
        .sum();
    if total <= 0.0 {
        return Err(HrError::validation(
            "At least one criterion needs a weight above zero",
        ));
    }
    Ok(())
}

fn form_fields(
    issues: &mut Issues,
    fields: &Fields,
    partial: bool,
) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    vec![
        (
            "name",
            field_json(&short_text(issues, fields, "name", required, 160, true)),
        ),
        (
            "description",
            field_json(&text_max(
                issues,
                fields,
                "description",
                Presence::Nullish,
                2000,
            )),
        ),
        (
            "criteria",
            field_json(&issues.list(fields, "criteria", required, Some(1), Some(50), criterion)),
        ),
        (
            "is_active",
            field_json(&issues.boolean(fields, "isActive", Presence::Optional)),
        ),
    ]
}

async fn create_form(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| {
        form_fields(issues, fields, false)
    })?;
    let criteria = get_field(&input, "criteria")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_criteria(&criteria)?;
    set_field(&mut input, "id", json!(generate_id("hrevf")));
    let row = insert_record(
        &caller.db,
        EVALUATION_FORMS,
        record(&input),
        &["id", "name", "description", "criteria", "is_active"],
        &[("is_active", json!(true))],
    )
    .await?;
    Ok(Created(row).into_response())
}

async fn update_form(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        form_fields(issues, fields, true)
    })?;
    require_evaluation_form(&caller.db, &id).await?;
    if let Some(criteria) = get_field(&input, "criteria").and_then(Value::as_array) {
        assert_criteria(criteria)?;
    }
    let row = update_record(&caller.db, EVALUATION_FORMS, &id, record(&input)).await?;
    Ok(Data(row).into_response())
}

async fn delete_form(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_evaluation_form(&caller.db, &id).await?;
    let at = utc_now();
    hr_evaluation_forms::Entity::update_many()
        .col_expr(hr_evaluation_forms::Column::DeletedAt, Expr::value(at))
        .col_expr(hr_evaluation_forms::Column::UpdatedAt, Expr::value(at))
        .filter(hr_evaluation_forms::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

/// `overallScore(criteria, scores)`: the weighted mean of criterion
/// percentages, one decimal; `None` until something is scored.
pub(crate) fn overall_score(criteria: &[Value], scores: &[Value]) -> Option<f64> {
    let by_id: HashMap<&str, f64> = scores
        .iter()
        .map(|s| {
            (
                text(s, "criterionId"),
                s["score"].as_f64().unwrap_or(f64::NAN),
            )
        })
        .collect();
    let (mut weighted, mut weights) = (0.0, 0.0);
    for c in criteria {
        let weight = c["weight"].as_f64().unwrap_or(0.0);
        let max = c["maxScore"].as_f64().unwrap_or(0.0);
        let Some(score) = by_id.get(text(c, "id")) else {
            continue;
        };
        if weight <= 0.0 || max <= 0.0 {
            continue;
        }
        weighted += (score.min(max) / max) * weight;
        weights += weight;
    }
    if weights == 0.0 {
        return None;
    }
    Some(js_round((weighted / weights) * 1000.0) / 10.0)
}

fn assert_scores(criteria: &[Value], scores: &[Value]) -> Result<(), HrError> {
    for s in scores {
        let id = text(s, "criterionId");
        let Some(c) = criteria.iter().find(|c| c["id"] == id) else {
            return Err(HrError::validation(format!("Unknown criterion \"{id}\"")));
        };
        let max = c["maxScore"].as_f64().unwrap_or(0.0);
        if s["score"].as_f64().unwrap_or(0.0) > max {
            return Err(HrError::validation(format!(
                "\"{}\" is scored out of {}",
                text(c, "label"),
                crate::number_text(max)
            )));
        }
    }
    Ok(())
}

fn assert_submittable(
    criteria: &[Value],
    scores: &[Value],
    period_start: Option<&str>,
) -> Result<(), HrError> {
    let scored: Vec<&str> = scores.iter().map(|s| text(s, "criterionId")).collect();
    let missing: Vec<&str> = criteria
        .iter()
        .filter(|c| c["weight"].as_f64().unwrap_or(0.0) > 0.0 && !scored.contains(&text(c, "id")))
        .map(|c| text(c, "label"))
        .collect();
    if !missing.is_empty() {
        return Err(HrError::validation(format!(
            "Score every criterion before submitting. Missing: {}",
            missing.join(", ")
        )));
    }
    if let Some(start) = period_start.filter(|s| !s.is_empty())
        && start > today_iso().as_str()
    {
        return Err(HrError::validation(
            "An evaluation period that has not started yet cannot be submitted; save it as a draft",
        ));
    }
    Ok(())
}

/// `requireEvaluation(db, id)`.
pub(crate) async fn require_evaluation(db: &PgPool, id: &str) -> Result<Value, HrError> {
    EVALUATIONS
        .find(&orm(db), id, true)
        .await?
        .ok_or_else(|| HrError::not_found("Evaluation", id))
}

/// `listEvaluations(db, filters)`.
#[derive(Default)]
pub(crate) struct EvaluationFilters {
    pub(crate) employee_id: Option<String>,
    pub(crate) company_id: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) form_id: Option<String>,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
    /// The request's entity scope on the employees.
    pub(crate) entity: Scope,
}

/// An evaluation with its employee's names and its form's name.
#[derive(FromQueryResult)]
struct EvaluationRow {
    #[sea_orm(nested)]
    evaluation: hr_evaluations::Model,
    #[sea_orm(nested)]
    employee: EmployeeNames,
    form_name: Option<String>,
}

/// `coalesce(ev.<column>, ev.created_at::date)`: an evaluation without its
/// period counts from the day it was made.
fn evaluation_day(column: hr_evaluations::Column) -> Expr {
    use hr_evaluations::{Column, Entity};
    use sea_orm::ExprTrait as _;
    let created = Expr::col((Entity, Column::CreatedAt)).cast_as("date");
    Expr::from(Func::coalesce([Expr::col((Entity, column)), created]))
}

/// `coalesce(ev.period_end, ev.created_at::date) >= $from`.
fn evaluation_ends_from(from: time::Date) -> Expr {
    use sea_orm::ExprTrait as _;
    evaluation_day(hr_evaluations::Column::PeriodEnd).gte(from)
}

/// `coalesce(ev.period_start, ev.created_at::date) <= $to`.
fn evaluation_starts_by(to: time::Date) -> Expr {
    use sea_orm::ExprTrait as _;
    evaluation_day(hr_evaluations::Column::PeriodStart).lte(to)
}

pub(crate) async fn list_evaluations(
    db: &PgPool,
    filters: &EvaluationFilters,
) -> Result<Vec<Value>, HrError> {
    use hr_evaluations::Column;
    let mut evaluations = with_employee(hr_evaluations::Entity::find(), Column::EmployeeId)
        .column_as(hr_evaluation_forms::Column::Name, "form_name")
        .join(
            JoinType::LeftJoin,
            hr_evaluations::Entity::belongs_to(hr_evaluation_forms::Entity)
                .from(Column::FormId)
                .to(hr_evaluation_forms::Column::Id)
                .into(),
        )
        .filter(Column::DeletedAt.is_null());
    if let Some(employee_id) = &filters.employee_id {
        evaluations = evaluations.filter(Column::EmployeeId.eq(employee_id.as_str()));
    }
    if let Some(company_id) = &filters.company_id {
        evaluations = evaluations.filter(Column::CompanyId.eq(company_id.as_str()));
    }
    if let Some(statuses) = statuses_of(filters.status.as_deref()) {
        evaluations = evaluations.filter(Column::Status.is_in(statuses));
    }
    if let Some(form_id) = &filters.form_id {
        evaluations = evaluations.filter(Column::FormId.eq(form_id.as_str()));
    }
    if let Some(from) = &filters.from {
        evaluations = evaluations.filter(evaluation_ends_from(sql_date(from)?));
    }
    if let Some(to) = &filters.to {
        evaluations = evaluations.filter(evaluation_starts_by(sql_date(to)?));
    }
    let rows: Vec<EvaluationRow> = evaluations
        .filter(
            filters
                .entity
                .condition(hr_employees::Column::LegalEntityId),
        )
        .order_by_desc(Column::CreatedAt)
        .limit(1000)
        .into_model()
        .all(&orm(db))
        .await?;
    let evaluators: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.evaluation.evaluator_user_id.as_deref())
        .collect();
    let companies: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.evaluation.company_id.as_deref())
        .collect();
    let evaluator_names = member_names(db, &evaluators).await?;
    let company_name = company_names(db, &companies).await?;
    let rows: Vec<(Value, String, Option<String>)> = rows
        .into_iter()
        .map(|row| {
            Ok((
                row_json(row.evaluation)?,
                row.employee.display(),
                row.form_name,
            ))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(rows
        .into_iter()
        .map(|(mut evaluation, employee_name, form_name)| {
            let evaluator = if evaluation["evaluatorName"].is_null() {
                json!(
                    evaluation["evaluatorUserId"]
                        .as_str()
                        .filter(|e| !e.is_empty())
                        .and_then(|e| evaluator_names.get(e).cloned())
                )
            } else {
                evaluation["evaluatorName"].clone()
            };
            let company = evaluation["companyId"]
                .as_str()
                .filter(|c| !c.is_empty())
                .and_then(|c| company_name.get(c).cloned());
            if let Some(map) = evaluation.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name));
                map.insert("formName".to_owned(), json!(form_name));
                map.insert("evaluatorName".to_owned(), evaluator);
                map.insert("companyName".to_owned(), json!(company));
            }
            evaluation
        })
        .collect())
}

async fn list_evaluations_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let filters = EvaluationFilters {
        employee_id: query_text(&q, "employeeId"),
        company_id: query_text(&q, "companyId"),
        status: query_text(&q, "status"),
        form_id: query_text(&q, "formId"),
        from: query_date(&q, "from"),
        to: query_date(&q, "to"),
        entity: caller.scope().await?,
    };
    Ok(Data(list_evaluations(&caller.db, &filters).await?).into_response())
}

async fn get_evaluation(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(require_evaluation(&caller.db, &id).await?).into_response())
}

/// `hrEvaluationScoreSchema`.
fn score_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let criterion = issues.text(fields, "criterionId", Presence::Required, Some(1), Some(40));
    let score = number(
        issues,
        fields,
        "score",
        Presence::Required,
        Some(0.0),
        Some(100.0),
    );
    let comment = text_max(issues, fields, "comment", Presence::Nullish, 2000);
    let mut out = Map::new();
    out.insert("criterionId".to_owned(), json!(criterion.as_set()?));
    out.insert("score".to_owned(), js_number(*score.as_set()?));
    if let Some(comment) = field_json(&comment) {
        out.insert("comment".to_owned(), comment);
    }
    Some(Value::Object(out))
}

struct EvaluationInput {
    employee_id: Field<String>,
    form_id: Field<String>,
    company_id: Field<String>,
    period_start: Field<String>,
    period_end: Field<String>,
    scores: Field<Vec<Value>>,
    summary: Field<String>,
    shared: Field<bool>,
    submit: Field<bool>,
}

fn evaluation_input(issues: &mut Issues, fields: &Fields, partial: bool) -> EvaluationInput {
    let (employee_id, form_id) = if partial {
        (Field::Absent, Field::Absent)
    } else {
        (
            id(issues, fields, "employeeId", Presence::Required),
            id(issues, fields, "formId", Presence::Required),
        )
    };
    EvaluationInput {
        employee_id,
        form_id,
        company_id: id(issues, fields, "companyId", Presence::Nullish),
        period_start: iso_date(issues, fields, "periodStart", Presence::Nullish),
        period_end: iso_date(issues, fields, "periodEnd", Presence::Nullish),
        scores: issues.list(
            fields,
            "scores",
            Presence::Optional,
            None,
            Some(50),
            score_item,
        ),
        summary: text_max(issues, fields, "summary", Presence::Nullish, 20000),
        shared: issues.boolean(fields, "sharedWithClient", Presence::Optional),
        submit: issues.boolean(fields, "submit", Presence::Optional),
    }
}

async fn create_evaluation(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        evaluation_input(issues, fields, false)
    })?;
    caller
        .assert_employee_visible(input.employee_id.as_set().map(String::as_str))
        .await?;
    let db = &caller.db;
    assert_date_order(
        input.period_start.as_set().map(String::as_str),
        input.period_end.as_set().map(String::as_str),
        "Evaluation period",
    )?;
    require_employee(db, input.employee_id.as_set().map_or("", String::as_str)).await?;
    let form =
        require_evaluation_form(db, input.form_id.as_set().map_or("", String::as_str)).await?;
    let criteria = form["criteria"].as_array().cloned().unwrap_or_default();
    let scores = input.scores.as_set().cloned().unwrap_or_default();
    assert_scores(&criteria, &scores)?;
    let submit = input.submit.as_set() == Some(&true);
    if submit {
        assert_submittable(
            &criteria,
            &scores,
            input.period_start.as_set().map(String::as_str),
        )?;
    }
    let evaluator_name = member_names(db, &[Some(caller.user_id.as_str())])
        .await?
        .get(&caller.user_id)
        .cloned();
    let now = utc_now();
    let day = |field: &Field<String>| field.as_set().map(|d| sql_date(d)).transpose();
    let row = hr_evaluations::Entity::insert(hr_evaluations::ActiveModel {
        id: Set(generate_id("hrevl")),
        employee_id: Set(input.employee_id.as_set().cloned().unwrap_or_default()),
        form_id: Set(text(&form, "id").to_owned()),
        company_id: Set(input.company_id.as_set().cloned()),
        evaluator_user_id: Set(Some(caller.user_id.clone())),
        evaluator_name: Set(evaluator_name),
        period_start: Set(day(&input.period_start)?),
        period_end: Set(day(&input.period_end)?),
        criteria: Set(Value::Array(criteria.clone())),
        scores: Set(Value::Array(scores.clone())),
        overall_score: Set(overall_score(&criteria, &scores)),
        summary: Set(input.summary.as_set().cloned()),
        shared_with_client: Set(input.shared.as_set().copied().unwrap_or(false)),
        status: Set(if submit { "submitted" } else { "draft" }.to_owned()),
        submitted_at: Set(submit.then_some(now)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let row = row_json(row)?;
    let event = if row["status"] == "submitted" {
        HR_EVALUATION_SUBMITTED
    } else {
        HR_EVALUATION_CREATED
    };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Created(row).into_response())
}

async fn update_evaluation(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        evaluation_input(issues, fields, true)
    })?;
    let db = &caller.db;
    let before = require_evaluation(db, &id).await?;
    let existing = require_evaluation(db, &id).await?;
    if existing["status"] == "acknowledged"
        && (input.scores.as_set().is_some() || !input.summary.is_absent())
    {
        return Err(HrError::conflict(
            "An acknowledged evaluation can no longer be rescored",
        ));
    }
    let criteria = existing["criteria"].as_array().cloned().unwrap_or_default();
    let scores = input
        .scores
        .as_set()
        .cloned()
        .unwrap_or_else(|| existing["scores"].as_array().cloned().unwrap_or_default());
    if let Some(given) = input.scores.as_set() {
        assert_scores(&criteria, given)?;
    }
    let mut submitting = false;
    if input.submit.as_set() == Some(&true) && existing["status"] == "draft" {
        let start = match &input.period_start {
            Field::Absent => existing["periodStart"].as_str().map(str::to_owned),
            Field::Null => None,
            Field::Set(s) => Some(s.clone()),
        };
        assert_submittable(&criteria, &scores, start.as_deref())?;
        submitting = true;
    }
    let mut fields = record(&[
        ("company_id", field_json(&input.company_id)),
        ("period_start", field_json(&input.period_start)),
        ("period_end", field_json(&input.period_end)),
        ("summary", field_json(&input.summary)),
        ("shared_with_client", field_json(&input.shared)),
    ]);
    fields.insert("scores".to_owned(), Value::Array(scores.clone()));
    fields.insert(
        "overall_score".to_owned(),
        json!(overall_score(&criteria, &scores)),
    );
    let at = json!(now());
    if submitting {
        fields.insert("status".to_owned(), json!("submitted"));
        fields.insert("submitted_at".to_owned(), at.clone());
    }
    fields.insert("updated_at".to_owned(), at);
    let row = update_record(db, EVALUATIONS, &id, fields).await?;
    let just_submitted = before["status"] == "draft" && row["status"] == "submitted";
    let event = if just_submitted {
        HR_EVALUATION_SUBMITTED
    } else {
        HR_EVALUATION_UPDATED
    };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Data(row).into_response())
}

async fn delete_evaluation(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let row = require_evaluation(&caller.db, &id).await?;
    require_evaluation(&caller.db, &id).await?;
    let at = utc_now();
    hr_evaluations::Entity::update_many()
        .col_expr(hr_evaluations::Column::DeletedAt, Expr::value(at))
        .col_expr(hr_evaluations::Column::UpdatedAt, Expr::value(at))
        .filter(hr_evaluations::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    emit(
        &caller,
        &state,
        HR_EVALUATION_DELETED,
        &row,
        &["employeeId"],
    );
    Ok(NoContent.into_response())
}

/// `acknowledgeEvaluation(db, id, employeeId, comment)`.
pub(crate) async fn acknowledge_evaluation(
    db: &PgPool,
    id: &str,
    employee_id: &str,
    comment: Option<&str>,
) -> Result<Value, HrError> {
    let row = require_evaluation(db, id).await?;
    if row["employeeId"] != employee_id || row["status"] == "draft" {
        return Err(HrError::not_found("Evaluation", id));
    }
    if row["status"] == "acknowledged" {
        return Err(HrError::conflict("Already acknowledged"));
    }
    let at = utc_now();
    let updated = hr_evaluations::Entity::update_many()
        .col_expr(hr_evaluations::Column::Status, Expr::value("acknowledged"))
        .col_expr(hr_evaluations::Column::AcknowledgedAt, Expr::value(at))
        .col_expr(
            hr_evaluations::Column::EmployeeComment,
            Expr::value(comment.map(str::to_owned)),
        )
        .col_expr(hr_evaluations::Column::UpdatedAt, Expr::value(at))
        .filter(hr_evaluations::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound(format!("hr_evaluations {id}")))?;
    Ok(row_json(updated)?)
}

// ---------------------------------------------------------------------------
// KPI definitions
// ---------------------------------------------------------------------------

async fn require_kpi_definition(db: &PgPool, id: &str) -> Result<Value, HrError> {
    KPI_DEFINITIONS
        .find(&orm(db), id, false)
        .await?
        .ok_or_else(|| HrError::not_found("KPI", id))
}

async fn list_kpis(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    use hr_kpi_definitions::Column;
    let q = query_values(query.as_deref());
    let include = query_param(&q, "includeInactive").as_deref() == Some("true");
    let mut kpis = hr_kpi_definitions::Entity::find();
    if !include {
        kpis = kpis.filter(Column::IsActive.eq(true));
    }
    if let Some(company_id) = query_text(&q, "companyId") {
        kpis = kpis.filter(
            Condition::any()
                .add(Column::CompanyId.is_null())
                .add(Column::CompanyId.eq(company_id)),
        );
    }
    let rows = rows_json(
        kpis.order_by_asc(Column::Name)
            .all(&orm(&caller.db))
            .await?,
    )?;
    let companies: Vec<Option<&str>> = rows.iter().map(|r| r["companyId"].as_str()).collect();
    let names = company_names(&caller.db, &companies).await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let company = row["companyId"]
                .as_str()
                .filter(|c| !c.is_empty())
                .and_then(|c| names.get(c).cloned());
            if let Some(map) = row.as_object_mut() {
                map.insert("companyName".to_owned(), json!(company));
            }
            row
        })
        .collect();
    Ok(Data(rows).into_response())
}

/// `assertKpiTarget(unit, target)`.
fn assert_kpi_target(unit: &str, target: Option<f64>) -> Result<(), HrError> {
    if let Some(target) = target
        && matches!(unit, "percent" | "seconds" | "minutes")
        && target < 0.0
    {
        return Err(HrError::validation(
            "The target of a percentage or duration KPI cannot be negative",
        ));
    }
    Ok(())
}

fn kpi_fields(
    issues: &mut Issues,
    fields: &Fields,
    partial: bool,
) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = vec![
        (
            "name",
            field_json(&short_text(issues, fields, "name", required, 120, true)),
        ),
        (
            "description",
            field_json(&text_max(
                issues,
                fields,
                "description",
                Presence::Nullish,
                2000,
            )),
        ),
        (
            "unit",
            field_json(&issues.choice(fields, "unit", Presence::Optional, &KPI_UNITS)),
        ),
        (
            "direction",
            field_json(&issues.choice(fields, "direction", Presence::Optional, &KPI_DIRECTIONS)),
        ),
    ];
    let target = number(issues, fields, "target", Presence::Nullish, None, None);
    out.push((
        "target",
        match target {
            Field::Absent => None,
            Field::Null => Some(Value::Null),
            Field::Set(t) => Some(js_number(t)),
        },
    ));
    out.push((
        "company_id",
        field_json(&id(issues, fields, "companyId", Presence::Nullish)),
    ));
    out.push((
        "is_active",
        field_json(&issues.boolean(fields, "isActive", Presence::Optional)),
    ));
    out
}

async fn create_kpi(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| {
        kpi_fields(issues, fields, false)
    })?;
    let unit = get_field(&input, "unit")
        .and_then(Value::as_str)
        .unwrap_or("number")
        .to_owned();
    assert_kpi_target(&unit, get_field(&input, "target").and_then(Value::as_f64))?;
    set_field(&mut input, "id", json!(generate_id("hrkpi")));
    let row = insert_record(
        &caller.db,
        KPI_DEFINITIONS,
        record(&input),
        &[
            "id",
            "name",
            "description",
            "unit",
            "direction",
            "target",
            "company_id",
            "is_active",
        ],
        &[
            ("unit", json!("number")),
            ("direction", json!("higher_better")),
            ("is_active", json!(true)),
        ],
    )
    .await?;
    Ok(Created(row).into_response())
}

async fn update_kpi(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        kpi_fields(issues, fields, true)
    })?;
    let existing = require_kpi_definition(&caller.db, &id).await?;
    let unit = get_field(&input, "unit")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(&existing, "unit"))
        .to_owned();
    let target = if input.iter().any(|(c, v)| *c == "target" && v.is_some()) {
        get_field(&input, "target").and_then(Value::as_f64)
    } else {
        existing["target"].as_f64()
    };
    assert_kpi_target(&unit, target)?;
    let row = update_record(&caller.db, KPI_DEFINITIONS, &id, record(&input)).await?;
    Ok(Data(row).into_response())
}

async fn delete_kpi(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = orm(&caller.db);
    require_kpi_definition(&caller.db, &id).await?;
    let used: Option<String> = hr_kpi_values::Entity::find()
        .select_only()
        .column(hr_kpi_values::Column::Id)
        .filter(hr_kpi_values::Column::KpiId.eq(id.as_str()))
        .into_tuple()
        .one(&db)
        .await?;
    if used.is_some() {
        hr_kpi_definitions::Entity::update_many()
            .col_expr(hr_kpi_definitions::Column::IsActive, Expr::value(false))
            .col_expr(
                hr_kpi_definitions::Column::UpdatedAt,
                Expr::value(utc_now()),
            )
            .filter(hr_kpi_definitions::Column::Id.eq(id.as_str()))
            .exec(&db)
            .await?;
        return Ok(Data(json!({ "archived": true })).into_response());
    }
    hr_kpi_definitions::Entity::delete_by_id(id)
        .exec(&db)
        .await?;
    Ok(Data(json!({ "archived": false })).into_response())
}

// ---------------------------------------------------------------------------
// KPI values
// ---------------------------------------------------------------------------

/// `listKpiValues(db, filters)`; `scope` is the request's entity scope.
pub(crate) async fn list_kpi_values(
    db: &PgPool,
    employee_id: Option<&str>,
    kpi_id: Option<&str>,
    company_id: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    use hr_kpi_values::Column;
    let mut values = with_employee(hr_kpi_values::Entity::find(), Column::EmployeeId)
        .column_as(hr_kpi_definitions::Column::Name, "kpi_name")
        .column_as(hr_kpi_definitions::Column::Unit, "kpi_unit")
        .column_as(hr_kpi_definitions::Column::Direction, "kpi_direction")
        .column_as(hr_kpi_definitions::Column::Target, "kpi_target")
        .join(
            JoinType::InnerJoin,
            hr_kpi_values::Entity::belongs_to(hr_kpi_definitions::Entity)
                .from(Column::KpiId)
                .to(hr_kpi_definitions::Column::Id)
                .into(),
        );
    if let Some(employee_id) = employee_id {
        values = values.filter(Column::EmployeeId.eq(employee_id));
    }
    if let Some(kpi_id) = kpi_id {
        values = values.filter(Column::KpiId.eq(kpi_id));
    }
    if let Some(company_id) = company_id {
        values = values.filter(Column::CompanyId.eq(company_id));
    }
    if let Some(from) = from {
        values = values.filter(Column::PeriodEnd.gte(sql_date(from)?));
    }
    if let Some(to) = to {
        values = values.filter(Column::PeriodStart.lte(sql_date(to)?));
    }
    let rows: Vec<KpiValueRow> = values
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_desc(Column::PeriodStart)
        .order_by_asc(hr_kpi_definitions::Column::Name)
        .limit(5000)
        .into_model()
        .all(&orm(db))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let on_target = row.kpi_target.map(|target| {
            let v = row.value.value;
            if row.kpi_direction == "lower_better" {
                v <= target
            } else {
                v >= target
            }
        });
        let employee_name = row.employee.display();
        let mut value = row_json(row.value)?;
        if let Some(map) = value.as_object_mut() {
            map.insert("employeeName".to_owned(), json!(employee_name));
            map.insert("kpiName".to_owned(), json!(row.kpi_name));
            map.insert("unit".to_owned(), json!(row.kpi_unit));
            map.insert("direction".to_owned(), json!(row.kpi_direction));
            map.insert("target".to_owned(), json!(row.kpi_target));
            map.insert("onTarget".to_owned(), json!(on_target));
        }
        out.push(value);
    }
    Ok(out)
}

/// A KPI value with its employee's names and its KPI.
#[derive(FromQueryResult)]
struct KpiValueRow {
    #[sea_orm(nested)]
    value: hr_kpi_values::Model,
    #[sea_orm(nested)]
    employee: EmployeeNames,
    kpi_name: String,
    kpi_unit: String,
    kpi_direction: String,
    kpi_target: Option<f64>,
}

async fn list_kpi_values_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_kpi_values(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "kpiId").as_deref(),
        query_text(&q, "companyId").as_deref(),
        query_date(&q, "from").as_deref(),
        query_date(&q, "to").as_deref(),
        &caller.scope().await?,
    )
    .await?;
    Ok(Data(rows).into_response())
}

async fn require_kpi_value(db: &PgPool, id: &str) -> Result<Value, HrError> {
    KPI_VALUES
        .find(&orm(db), id, false)
        .await?
        .ok_or_else(|| HrError::not_found("KPI value", id))
}

fn kpi_value_fields(
    issues: &mut Issues,
    fields: &Fields,
    partial: bool,
) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push((
            "kpi_id",
            field_json(&id(issues, fields, "kpiId", Presence::Required)),
        ));
        out.push((
            "employee_id",
            field_json(&id(issues, fields, "employeeId", Presence::Required)),
        ));
    }
    out.push((
        "company_id",
        field_json(&id(issues, fields, "companyId", Presence::Nullish)),
    ));
    out.push((
        "period_start",
        field_json(&iso_date(issues, fields, "periodStart", required)),
    ));
    out.push((
        "period_end",
        field_json(&iso_date(issues, fields, "periodEnd", required)),
    ));
    let value = number(issues, fields, "value", required, None, None);
    out.push(("value", value.as_set().map(|v| js_number(*v))));
    out.push((
        "shared_with_client",
        field_json(&issues.boolean(fields, "sharedWithClient", Presence::Optional)),
    ));
    out
}

async fn create_kpi_value(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| {
        kpi_value_fields(issues, fields, false)
    })?;
    caller
        .assert_employee_visible(get_field(&input, "employee_id").and_then(Value::as_str))
        .await?;
    let db = &caller.db;
    assert_date_order(
        get_field(&input, "period_start").and_then(Value::as_str),
        get_field(&input, "period_end").and_then(Value::as_str),
        "KPI period",
    )?;
    require_kpi_definition(
        db,
        get_field(&input, "kpi_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .await?;
    require_employee(
        db,
        get_field(&input, "employee_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .await?;
    if get_field(&input, "shared_with_client").is_none() {
        set_field(&mut input, "shared_with_client", json!(false));
    }
    set_field(&mut input, "id", json!(generate_id("hrkpv")));
    set_field(&mut input, "source", json!("manual"));
    set_field(&mut input, "created_by", json!(caller.user_id));
    let row = insert_record(
        db,
        KPI_VALUES,
        record(&input),
        &[
            "id",
            "kpi_id",
            "employee_id",
            "company_id",
            "period_start",
            "period_end",
            "value",
            "source",
            "shared_with_client",
            "created_by",
        ],
        &[],
    )
    .await?;
    emit(
        &caller,
        &state,
        HR_KPI_VALUE_CREATED,
        &row,
        &["employeeId", "companyId"],
    );
    Ok(Created(row).into_response())
}

async fn update_kpi_value(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        kpi_value_fields(issues, fields, true)
    })?;
    let db = &caller.db;
    let before = require_kpi_value(db, &id).await?;
    let existing = require_kpi_value(db, &id).await?;
    assert_date_order(
        get_field(&input, "period_start")
            .and_then(Value::as_str)
            .or(existing["periodStart"].as_str()),
        get_field(&input, "period_end")
            .and_then(Value::as_str)
            .or(existing["periodEnd"].as_str()),
        "KPI period",
    )?;
    let row = update_record(db, KPI_VALUES, text(&before, "id"), record(&input)).await?;
    emit(
        &caller,
        &state,
        HR_KPI_VALUE_UPDATED,
        &row,
        &["employeeId", "companyId"],
    );
    Ok(Data(row).into_response())
}

async fn delete_kpi_value(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let row = require_kpi_value(&caller.db, &id).await?;
    require_kpi_value(&caller.db, &id).await?;
    hr_kpi_values::Entity::delete_by_id(id)
        .exec(&orm(&caller.db))
        .await?;
    emit(
        &caller,
        &state,
        HR_KPI_VALUE_DELETED,
        &row,
        &["employeeId", "companyId"],
    );
    Ok(NoContent.into_response())
}

async fn import_kpi_values(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (kpi_id, start, end, shared, rows) = hr_json(&headers, &body, |issues, fields| {
        let kpi = id(issues, fields, "kpiId", Presence::Required);
        let start = iso_date(issues, fields, "periodStart", Presence::Required);
        let end = iso_date(issues, fields, "periodEnd", Presence::Required);
        let shared = issues.boolean(fields, "sharedWithClient", Presence::Optional);
        let rows = issues.list(
            fields,
            "rows",
            Presence::Required,
            Some(1),
            Some(5000),
            |issues, item| {
                let fields = issues.object(item)?;
                let employee =
                    issues.text(fields, "employee", Presence::Required, Some(1), Some(255));
                let value = number(issues, fields, "value", Presence::Required, None, None);
                let company = id(issues, fields, "companyId", Presence::Nullish);
                Some((
                    employee.into_option()?,
                    value.into_option()?,
                    company.into_option(),
                ))
            },
        );
        (kpi, start, end, shared, rows)
    })?;
    let db = &caller.db;
    let kpi_id = kpi_id.into_option().unwrap_or_default();
    let start = start.into_option().unwrap_or_default();
    let end = end.into_option().unwrap_or_default();
    let shared = shared.as_set().copied().unwrap_or(false);
    let rows = rows.into_option().unwrap_or_default();
    assert_date_order(Some(&start), Some(&end), "KPI period")?;
    require_kpi_definition(db, &kpi_id).await?;
    let refs: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    // Employees outside the request's entity scope do not match, as if they did not exist.
    let scope = caller.scope().await?;
    let resolved = crate::timekeeping::resolve_employee_refs(db, &refs, &scope).await?;
    let (mut created, mut updated) = (0, 0);
    let mut errors: Vec<Value> = Vec::new();
    for (index, (employee, value, company)) in rows.into_iter().enumerate() {
        let trimmed = crate::js_trim(&employee).to_owned();
        let Some(employee_id) = resolved
            .get(&trimmed.to_lowercase())
            .or_else(|| resolved.get(&trimmed))
            .cloned()
        else {
            errors.push(json!({ "row": index + 1, "reason": format!("No employee matches \"{employee}\"") }));
            continue;
        };
        let (period_start, period_end) = (sql_date(&start)?, sql_date(&end)?);
        let existing: Option<String> = hr_kpi_values::Entity::find()
            .select_only()
            .column(hr_kpi_values::Column::Id)
            .filter(hr_kpi_values::Column::KpiId.eq(kpi_id.as_str()))
            .filter(hr_kpi_values::Column::EmployeeId.eq(employee_id.as_str()))
            .filter(hr_kpi_values::Column::PeriodStart.eq(period_start))
            .filter(hr_kpi_values::Column::PeriodEnd.eq(period_end))
            .into_tuple()
            .one(&orm(db))
            .await?;
        if let Some(existing) = existing {
            hr_kpi_values::Entity::update_many()
                .col_expr(hr_kpi_values::Column::Value, Expr::value(value))
                .col_expr(hr_kpi_values::Column::CompanyId, Expr::value(company))
                .col_expr(hr_kpi_values::Column::SharedWithClient, Expr::value(shared))
                .col_expr(hr_kpi_values::Column::Source, Expr::value("import"))
                .col_expr(hr_kpi_values::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(hr_kpi_values::Column::Id.eq(existing))
                .exec(&orm(db))
                .await?;
            updated += 1;
        } else {
            hr_kpi_values::Entity::insert(hr_kpi_values::ActiveModel {
                id: Set(generate_id("hrkpv")),
                kpi_id: Set(kpi_id.clone()),
                employee_id: Set(employee_id),
                company_id: Set(company),
                period_start: Set(period_start),
                period_end: Set(period_end),
                value: Set(value),
                shared_with_client: Set(shared),
                source: Set("import".to_owned()),
                created_by: Set(Some(caller.user_id.clone())),
                ..Default::default()
            })
            .exec_without_returning(&orm(db))
            .await?;
            created += 1;
        }
    }
    Ok(Data(json!({ "created": created, "updated": updated, "errors": errors })).into_response())
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

async fn require_milestone(db: &PgPool, id: &str) -> Result<Value, HrError> {
    MILESTONES
        .find(&orm(db), id, true)
        .await?
        .ok_or_else(|| HrError::not_found("Milestone", id))
}

/// A milestone with its employee's names.
#[derive(FromQueryResult)]
struct MilestoneRow {
    #[sea_orm(nested)]
    milestone: hr_milestones::Model,
    #[sea_orm(nested)]
    employee: EmployeeNames,
}

/// `listMilestones(db, filters)`; `scope` is the request's entity scope.
pub(crate) async fn list_milestones(
    db: &PgPool,
    employee_id: Option<&str>,
    company_id: Option<&str>,
    status: Option<&str>,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    use hr_milestones::Column;
    let mut milestones = with_employee(hr_milestones::Entity::find(), Column::EmployeeId)
        .filter(Column::DeletedAt.is_null());
    if let Some(employee_id) = employee_id {
        milestones = milestones.filter(Column::EmployeeId.eq(employee_id));
    }
    if let Some(company_id) = company_id {
        milestones = milestones.filter(Column::CompanyId.eq(company_id));
    }
    if let Some(statuses) = statuses_of(status) {
        milestones = milestones.filter(Column::Status.is_in(statuses));
    }
    let rows: Vec<MilestoneRow> = milestones
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_with_nulls(Column::DueDate, Order::Asc, NullOrdering::Last)
        .order_by_desc(Column::CreatedAt)
        .limit(1000)
        .into_model()
        .all(&orm(db))
        .await?;
    let companies: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.milestone.company_id.as_deref())
        .collect();
    let names = company_names(db, &companies).await?;
    let rows: Vec<(Value, String)> = rows
        .into_iter()
        .map(|row| Ok((row_json(row.milestone)?, row.employee.display())))
        .collect::<Result<_, DbErr>>()?;
    Ok(rows
        .into_iter()
        .map(|(mut milestone, employee_name)| {
            let company = milestone["companyId"]
                .as_str()
                .filter(|c| !c.is_empty())
                .and_then(|c| names.get(c).cloned());
            if let Some(map) = milestone.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name));
                map.insert("companyName".to_owned(), json!(company));
            }
            milestone
        })
        .collect())
}

async fn list_milestones_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_milestones(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "companyId").as_deref(),
        query_text(&q, "status").as_deref(),
        &caller.scope().await?,
    )
    .await?;
    Ok(Data(rows).into_response())
}

fn milestone_fields(
    issues: &mut Issues,
    fields: &Fields,
    partial: bool,
) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push((
            "employee_id",
            field_json(&id(issues, fields, "employeeId", Presence::Required)),
        ));
    }
    out.push((
        "company_id",
        field_json(&id(issues, fields, "companyId", Presence::Nullish)),
    ));
    out.push((
        "title",
        field_json(&short_text(issues, fields, "title", required, 255, true)),
    ));
    out.push((
        "description",
        field_json(&text_max(
            issues,
            fields,
            "description",
            Presence::Nullish,
            5000,
        )),
    ));
    out.push((
        "type",
        field_json(&issues.choice(fields, "type", Presence::Optional, &MILESTONE_TYPES)),
    ));
    out.push((
        "status",
        field_json(&issues.choice(fields, "status", Presence::Optional, &MILESTONE_STATUSES)),
    ));
    out.push((
        "due_date",
        field_json(&iso_date(issues, fields, "dueDate", Presence::Nullish)),
    ));
    out.push((
        "achieved_at",
        field_json(&iso_date(issues, fields, "achievedAt", Presence::Nullish)),
    ));
    out.push((
        "shared_with_client",
        field_json(&issues.boolean(fields, "sharedWithClient", Presence::Optional)),
    ));
    out
}

fn present(fields: &[(&'static str, Option<Value>)], column: &str) -> bool {
    fields.iter().any(|(c, v)| *c == column && v.is_some())
}

/// `withAchievedDate(input)`.
fn with_achieved_date(
    mut input: Vec<(&'static str, Option<Value>)>,
) -> Vec<(&'static str, Option<Value>)> {
    if get_field(&input, "status") == Some(&json!("achieved")) && !present(&input, "achieved_at") {
        set_field(&mut input, "achieved_at", json!(today_iso()));
    }
    input
}

/// `reconcileMilestone(input, current)`.
fn reconcile_milestone(
    mut input: Vec<(&'static str, Option<Value>)>,
    current_status: &str,
    current_achieved: Option<&str>,
) -> Result<Vec<(&'static str, Option<Value>)>, HrError> {
    let status = get_field(&input, "status")
        .and_then(Value::as_str)
        .unwrap_or(current_status)
        .to_owned();
    let achieved_at: Option<String> = if present(&input, "achieved_at") {
        get_field(&input, "achieved_at")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        current_achieved.map(str::to_owned)
    };
    if achieved_at.as_deref().is_none_or(str::is_empty) || status == "achieved" {
        return Ok(input);
    }
    let status_changed_only = present(&input, "status") && !present(&input, "achieved_at");
    if status_changed_only {
        set_field(&mut input, "achieved_at", Value::Null);
        return Ok(input);
    }
    if status == "missed" {
        return Err(HrError::validation(
            "A missed milestone cannot have an achieved date",
        ));
    }
    set_field(&mut input, "status", json!("achieved"));
    Ok(input)
}

async fn create_milestone(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        milestone_fields(issues, fields, false)
    })?;
    caller
        .assert_employee_visible(get_field(&input, "employee_id").and_then(Value::as_str))
        .await?;
    let db = &caller.db;
    require_employee(
        db,
        get_field(&input, "employee_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .await?;
    let mut input = reconcile_milestone(with_achieved_date(input), "planned", None)?;
    set_field(&mut input, "id", json!(generate_id("hrmil")));
    set_field(&mut input, "created_by", json!(caller.user_id));
    let row = insert_record(
        db,
        MILESTONES,
        record(&input),
        &[
            "id",
            "employee_id",
            "company_id",
            "title",
            "description",
            "type",
            "status",
            "due_date",
            "achieved_at",
            "shared_with_client",
            "created_by",
        ],
        &[
            ("type", json!("milestone")),
            ("status", json!("planned")),
            ("shared_with_client", json!(false)),
        ],
    )
    .await?;
    let event = if row["status"] == "achieved" {
        HR_MILESTONE_ACHIEVED
    } else {
        HR_MILESTONE_CREATED
    };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Created(row).into_response())
}

async fn update_milestone(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        milestone_fields(issues, fields, true)
    })?;
    let db = &caller.db;
    let before = require_milestone(db, &id).await?;
    let existing = require_milestone(db, &id).await?;
    let achieved = existing["achievedAt"].as_str().filter(|a| !a.is_empty());
    let input = if achieved.is_some() {
        input
    } else {
        with_achieved_date(input)
    };
    let patch = reconcile_milestone(input, text(&existing, "status"), achieved)?;
    let row = update_record(db, MILESTONES, text(&before, "id"), record(&patch)).await?;
    let just_achieved = existing["status"] != "achieved" && row["status"] == "achieved";
    let event = if just_achieved {
        HR_MILESTONE_ACHIEVED
    } else {
        HR_MILESTONE_UPDATED
    };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Data(row).into_response())
}

async fn delete_milestone(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let row = require_milestone(&caller.db, &id).await?;
    require_milestone(&caller.db, &id).await?;
    let at = utc_now();
    hr_milestones::Entity::update_many()
        .col_expr(hr_milestones::Column::DeletedAt, Expr::value(at))
        .col_expr(hr_milestones::Column::UpdatedAt, Expr::value(at))
        .filter(hr_milestones::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    emit(&caller, &state, HR_MILESTONE_DELETED, &row, &["employeeId"]);
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Starter data
// ---------------------------------------------------------------------------

/// `ensureDefaultEvaluationForm(db)`: the starter scorecard.
pub(crate) async fn ensure_default_evaluation_form(db: &PgPool) -> Result<(), HrError> {
    // Boxed: the ORM's futures are large, and the seed runs four at once.
    Box::pin(default_evaluation_form(db)).await
}

async fn default_evaluation_form(db: &PgPool) -> Result<(), HrError> {
    let db = orm(db);
    let existing: Option<String> = hr_evaluation_forms::Entity::find()
        .select_only()
        .column(hr_evaluation_forms::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let criteria = json!([
        { "id": "quality", "label": "Quality of work", "weight": 30, "maxScore": 5 },
        { "id": "productivity", "label": "Productivity", "weight": 25, "maxScore": 5 },
        { "id": "communication", "label": "Communication", "weight": 20, "maxScore": 5 },
        { "id": "reliability", "label": "Attendance and reliability", "weight": 15, "maxScore": 5 },
        { "id": "teamwork", "label": "Teamwork", "weight": 10, "maxScore": 5 },
    ]);
    hr_evaluation_forms::Entity::insert(hr_evaluation_forms::ActiveModel {
        id: Set("hrevf_default_scorecard".to_owned()),
        name: Set("Quality scorecard".to_owned()),
        description: Set(Some("Monthly quality and performance review.".to_owned())),
        criteria: Set(criteria),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&db)
    .await?;
    Ok(())
}

/// `ensureDefaultKpis(db)`: the starter KPI definitions.
pub(crate) async fn ensure_default_kpis(db: &PgPool) -> Result<(), HrError> {
    // Boxed, as [`ensure_default_evaluation_form`].
    Box::pin(default_kpis(db)).await
}

async fn default_kpis(db: &PgPool) -> Result<(), HrError> {
    let db = orm(db);
    let existing: Option<String> = hr_kpi_definitions::Entity::find()
        .select_only()
        .column(hr_kpi_definitions::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let kpi = |id: &str,
               name: &str,
               unit: &str,
               direction: &str,
               target: f64,
               description: Option<&str>| {
        hr_kpi_definitions::ActiveModel {
            id: Set(id.to_owned()),
            name: Set(name.to_owned()),
            unit: Set(unit.to_owned()),
            direction: Set(direction.to_owned()),
            target: Set(Some(target)),
            description: Set(description.map(str::to_owned)),
            ..Default::default()
        }
    };
    hr_kpi_definitions::Entity::insert_many([
        kpi(
            "hrkpi_default_csat",
            "CSAT",
            "percent",
            "higher_better",
            90.0,
            Some("Customer satisfaction score"),
        ),
        kpi(
            "hrkpi_default_quality",
            "Quality score",
            "percent",
            "higher_better",
            85.0,
            None,
        ),
        kpi(
            "hrkpi_default_aht",
            "Average handle time",
            "seconds",
            "lower_better",
            360.0,
            None,
        ),
        kpi(
            "hrkpi_default_fcr",
            "First contact resolution",
            "percent",
            "higher_better",
            75.0,
            None,
        ),
    ])
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_score_like_typescript() {
        let criteria = vec![
            json!({ "id": "a", "weight": 30, "maxScore": 5 }),
            json!({ "id": "b", "weight": 70, "maxScore": 5 }),
        ];
        let scores = vec![
            json!({ "criterionId": "a", "score": 4 }),
            json!({ "criterionId": "b", "score": 3 }),
        ];
        assert_eq!(overall_score(&criteria, &scores), Some(66.0));
        assert_eq!(overall_score(&criteria, &[]), None);
    }
}
