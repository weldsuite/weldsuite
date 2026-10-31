//! Coaching, evaluation forms, evaluations, KPI definitions, KPI values and
//! milestones (`routes/weldhr/performance.ts`, `services/weldhr/performance.ts`).
//!
//! Writes that spread the validated body into Drizzle's `.values()` /
//! `.set()` go through `jsonb_populate_record`: the body's fields as columns,
//! a column the body left out keeping its value (or its default).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_COACHING_LOG_CREATED, HR_COACHING_LOG_DELETED, HR_COACHING_LOG_UPDATED, HR_EVALUATION_CREATED,
    HR_EVALUATION_DELETED, HR_EVALUATION_SUBMITTED, HR_EVALUATION_UPDATED, HR_KPI_VALUE_CREATED,
    HR_KPI_VALUE_DELETED, HR_KPI_VALUE_UPDATED, HR_MILESTONE_ACHIEVED, HR_MILESTONE_CREATED,
    HR_MILESTONE_DELETED, HR_MILESTONE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    COACHING_CREATE, COACHING_DELETE, COACHING_READ, COACHING_UPDATE, EMPLOYEES_MANAGE,
    EVALUATIONS_CREATE, EVALUATIONS_DELETE, EVALUATIONS_READ, EVALUATIONS_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, field_json, id, iso_date, number, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, assert_date_order, company_names, hr_json, js_number, js_round,
    member_names, now, query_date, query_param, query_text, query_values, text, today_iso,
};

const COACHING_CATEGORIES: [&str; 6] = ["performance", "quality", "behavior", "attendance", "development", "recognition"];
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
        .route("/coaching", get(list_coaching).route_layer(gate.require([COACHING_READ])))
        .route("/coaching/{id}", get(get_coaching).route_layer(gate.require([COACHING_READ])))
        .route("/coaching", post(create_coaching).route_layer(gate.require([COACHING_CREATE])))
        .route("/coaching/{id}", patch(update_coaching).route_layer(gate.require([COACHING_UPDATE])))
        .route("/coaching/{id}", delete(delete_coaching).route_layer(gate.require([COACHING_DELETE])))
        .route("/evaluation-forms", get(list_forms).route_layer(eval_read()))
        .route("/evaluation-forms", post(create_form).route_layer(manage()))
        .route("/evaluation-forms/{id}", patch(update_form).route_layer(manage()))
        .route("/evaluation-forms/{id}", delete(delete_form).route_layer(manage()))
        .route("/evaluations", get(list_evaluations_route).route_layer(eval_read()))
        .route("/evaluations/{id}", get(get_evaluation).route_layer(eval_read()))
        .route("/evaluations", post(create_evaluation).route_layer(gate.require([EVALUATIONS_CREATE])))
        .route("/evaluations/{id}", patch(update_evaluation).route_layer(gate.require([EVALUATIONS_UPDATE])))
        .route("/evaluations/{id}", delete(delete_evaluation).route_layer(gate.require([EVALUATIONS_DELETE])))
        .route("/kpis", get(list_kpis).route_layer(eval_read()))
        .route("/kpis", post(create_kpi).route_layer(manage()))
        .route("/kpis/{id}", patch(update_kpi).route_layer(manage()))
        .route("/kpis/{id}", delete(delete_kpi).route_layer(manage()))
        .route("/kpi-values", get(list_kpi_values_route).route_layer(eval_read()))
        .route("/kpi-values", post(create_kpi_value).route_layer(gate.require([EVALUATIONS_CREATE])))
        .route("/kpi-values/import", post(import_kpi_values).route_layer(gate.require([EVALUATIONS_CREATE])))
        .route("/kpi-values/{id}", patch(update_kpi_value).route_layer(gate.require([EVALUATIONS_UPDATE])))
        .route("/kpi-values/{id}", delete(delete_kpi_value).route_layer(gate.require([EVALUATIONS_DELETE])))
        .route("/milestones", get(list_milestones_route).route_layer(eval_read()))
        .route("/milestones", post(create_milestone).route_layer(gate.require([EVALUATIONS_CREATE])))
        .route("/milestones/{id}", patch(update_milestone).route_layer(gate.require([EVALUATIONS_UPDATE])))
        .route("/milestones/{id}", delete(delete_milestone).route_layer(gate.require([EVALUATIONS_DELETE])))
}

/// The body's present fields, keyed by column, for `jsonb_populate_record`.
fn record(fields: &[(&str, Option<Value>)]) -> Value {
    let mut out = Map::new();
    for (column, value) in fields {
        if let Some(value) = value {
            out.insert((*column).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn employee_name_of(row: &Value) -> String {
    display_name_of(&json!({
        "firstName": row["employeeFirstName"],
        "lastName": row["employeeLastName"],
        "preferredName": row["employeePreferredName"],
    }))
}

/// `{ employeeId, status }` / `{ employeeId, companyId }` event data.
fn emit(caller: &Caller, state: &HrState, event: weldsuite_catalogs::entity_events::EventName, row: &Value, keys: &[&str]) {
    let fields: Vec<(&str, Option<Value>)> = keys.iter().map(|k| (*k, Some(row[*k].clone()))).collect();
    caller.emit(state, event, text(row, "id"), &fields);
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

/// `requireCoachingLog(db, id)`.
pub(crate) async fn require_coaching_log(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_coaching_logs t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Coaching log", id))
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
}

pub(crate) async fn list_coaching_logs(db: &PgPool, filters: &CoachingFilters) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = filters
        .status
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(c), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name)
         from hr_coaching_logs c join hr_employees e on e.id = c.employee_id
         where c.deleted_at is null and e.deleted_at is null
           and ($1::text is null or c.employee_id = $1)
           and ($2::text is null or c.company_id = $2)
           and ($3::text[] is null or c.status = any($3))
           and ($4::text is null or c.category = $4)
           and ($5::text is null or c.session_date >= $5::date)
           and ($6::text is null or c.session_date <= $6::date)
           and ($7::text[] is null or c.visibility = any($7))
           and (not $8 or (c.follow_up_date is not null and c.follow_up_date <= current_date and c.status <> 'closed'))
         order by c.session_date desc, c.created_at desc limit 1000",
    )
    .bind(&filters.employee_id)
    .bind(&filters.company_id)
    .bind(&statuses)
    .bind(&filters.category)
    .bind(&filters.from)
    .bind(&filters.to)
    .bind(&filters.visibilities)
    .bind(filters.follow_up_due)
    .fetch_all(db)
    .await?;
    let coaches: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["coach_user_id"].as_str()).collect();
    let companies: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["company_id"].as_str()).collect();
    let coach_names = member_names(db, &coaches).await?;
    let company_name = company_names(db, &companies).await?;
    Ok(rows
        .into_iter()
        .map(|(log, extra)| {
            let mut log = js_row(log);
            let coach = if log["coachName"].is_null() {
                json!(log["coachUserId"].as_str().filter(|c| !c.is_empty()).and_then(|c| coach_names.get(c).cloned()))
            } else {
                log["coachName"].clone()
            };
            let company = log["companyId"].as_str().filter(|c| !c.is_empty()).and_then(|c| company_name.get(c).cloned());
            if let Some(map) = log.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&extra)));
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
fn coaching_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push(("employee_id", field_json(&id(issues, fields, "employeeId", Presence::Required))));
    }
    out.push(("company_id", field_json(&id(issues, fields, "companyId", Presence::Nullish))));
    out.push(("coach_user_id", field_json(&text_max(issues, fields, "coachUserId", Presence::Nullish, 255))));
    out.push(("coach_name", field_json(&short_text(issues, fields, "coachName", Presence::Nullish, 255, false))));
    out.push(("session_date", field_json(&iso_date(issues, fields, "sessionDate", required))));
    out.push(("category", field_json(&issues.choice(fields, "category", Presence::Optional, &COACHING_CATEGORIES))));
    out.push(("topic", field_json(&short_text(issues, fields, "topic", required, 255, true))));
    out.push(("notes", field_json(&text_max(issues, fields, "notes", Presence::Nullish, 20000))));
    out.push((
        "action_items",
        field_json(&issues.list(fields, "actionItems", Presence::Optional, None, Some(50), action_item)),
    ));
    out.push(("follow_up_date", field_json(&iso_date(issues, fields, "followUpDate", Presence::Nullish))));
    out.push(("status", field_json(&issues.choice(fields, "status", Presence::Optional, &COACHING_STATUSES))));
    out.push(("visibility", field_json(&issues.choice(fields, "visibility", Presence::Optional, &VISIBILITIES))));
    out
}

fn get_field<'a>(fields: &'a [(&str, Option<Value>)], column: &str) -> Option<&'a Value> {
    fields.iter().find(|(c, _)| *c == column).and_then(|(_, v)| v.as_ref())
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
        return Err(HrError::validation("The follow-up date cannot be before the session date"));
    }
    Ok(())
}

async fn create_coaching(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| coaching_fields(issues, fields, false))?;
    let db = &caller.db;
    let session = get_field(&input, "session_date").and_then(Value::as_str).unwrap_or_default().to_owned();
    assert_follow_up(&session, get_field(&input, "follow_up_date").and_then(Value::as_str))?;
    require_employee(db, get_field(&input, "employee_id").and_then(Value::as_str).unwrap_or_default()).await?;
    let coach_user = get_field(&input, "coach_user_id")
        .and_then(Value::as_str)
        .map_or_else(|| caller.user_id.clone(), str::to_owned);
    let mut coach_name = get_field(&input, "coach_name").and_then(Value::as_str).map(str::to_owned);
    if coach_name.as_deref().is_none_or(str::is_empty) {
        coach_name = member_names(db, &[Some(coach_user.as_str())]).await?.get(&coach_user).cloned();
    }
    set_field(&mut input, "coach_user_id", json!(coach_user));
    set_field(&mut input, "coach_name", json!(coach_name));
    if get_field(&input, "action_items").is_none() {
        set_field(&mut input, "action_items", json!([]));
    }
    set_field(&mut input, "id", json!(generate_id("hrcch")));
    let row: Value = sqlx::query_scalar(
        "insert into hr_coaching_logs as t (id, employee_id, company_id, coach_user_id, coach_name, session_date,
             category, topic, notes, action_items, follow_up_date, status, visibility)
         select r.id, r.employee_id, r.company_id, r.coach_user_id, r.coach_name, r.session_date,
             coalesce(r.category, 'performance'), r.topic, r.notes, r.action_items, r.follow_up_date,
             coalesce(r.status, 'open'), coalesce(r.visibility, 'employee')
         from jsonb_populate_record(null::hr_coaching_logs, $1) r returning to_jsonb(t)",
    )
    .bind(record(&input))
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_COACHING_LOG_CREATED, &row, &["employeeId", "status"]);
    Ok(Created(row).into_response())
}

async fn update_coaching(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| coaching_fields(issues, fields, true))?;
    let db = &caller.db;
    let before = require_coaching_log(db, &id).await?;
    let existing = require_coaching_log(db, &id).await?;
    let session = get_field(&input, "session_date")
        .and_then(Value::as_str)
        .unwrap_or_else(|| text(&existing, "sessionDate"))
        .to_owned();
    let follow_up = if input.iter().any(|(c, v)| *c == "follow_up_date" && v.is_some()) {
        get_field(&input, "follow_up_date").and_then(Value::as_str).map(str::to_owned)
    } else {
        existing["followUpDate"].as_str().map(str::to_owned)
    };
    assert_follow_up(&session, follow_up.as_deref())?;
    let row: Value = sqlx::query_scalar(
        "update hr_coaching_logs as t set
             company_id = case when $1 ? 'company_id' then r.company_id else t.company_id end,
             coach_user_id = case when $1 ? 'coach_user_id' then r.coach_user_id else t.coach_user_id end,
             coach_name = case when $1 ? 'coach_name' then r.coach_name else t.coach_name end,
             session_date = case when $1 ? 'session_date' then r.session_date else t.session_date end,
             category = case when $1 ? 'category' then r.category else t.category end,
             topic = case when $1 ? 'topic' then r.topic else t.topic end,
             notes = case when $1 ? 'notes' then r.notes else t.notes end,
             action_items = case when $1 ? 'action_items' then r.action_items else t.action_items end,
             follow_up_date = case when $1 ? 'follow_up_date' then r.follow_up_date else t.follow_up_date end,
             status = case when $1 ? 'status' then r.status else t.status end,
             visibility = case when $1 ? 'visibility' then r.visibility else t.visibility end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_coaching_logs, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(record(&input))
    .bind(text(&before, "id"))
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_COACHING_LOG_UPDATED, &row, &["employeeId", "status"]);
    Ok(Data(row).into_response())
}

async fn delete_coaching(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_coaching_log(&caller.db, &id).await?;
    require_coaching_log(&caller.db, &id).await?;
    sqlx::query("update hr_coaching_logs set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
    emit(&caller, &state, HR_COACHING_LOG_DELETED, &row, &["employeeId"]);
    Ok(NoContent.into_response())
}

/// `acknowledgeCoachingLog(db, id, employeeId, comment)`.
pub(crate) async fn acknowledge_coaching_log(db: &PgPool, id: &str, employee_id: &str, comment: Option<&str>) -> Result<Value, HrError> {
    let log = require_coaching_log(db, id).await?;
    if log["employeeId"] != employee_id || log["visibility"] == "internal" {
        return Err(HrError::not_found("Coaching log", id));
    }
    if !log["acknowledgedAt"].is_null() {
        return Err(HrError::conflict("Already acknowledged"));
    }
    let status = if log["status"] == "open" { "acknowledged" } else { text(&log, "status") };
    let row: Value = sqlx::query_scalar(
        "update hr_coaching_logs set acknowledged_at = $2::timestamp, employee_comment = $3, status = $4,
             updated_at = $2::timestamp
         where id = $1 returning to_jsonb(hr_coaching_logs)",
    )
    .bind(id)
    .bind(now())
    .bind(comment)
    .bind(status)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

// ---------------------------------------------------------------------------
// Evaluation forms
// ---------------------------------------------------------------------------

async fn list_evaluation_forms(db: &PgPool, include_inactive: bool) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_evaluation_forms t where t.deleted_at is null and ($1 or t.is_active = true)
         order by t.name asc",
    )
    .bind(include_inactive)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn require_evaluation_form(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_evaluation_forms t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Evaluation form", id))
}

async fn list_forms(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let include = query_param(&query_values(query.as_deref()), "activeOnly").as_deref() != Some("true");
    Ok(Data(list_evaluation_forms(&caller.db, include).await?).into_response())
}

/// `hrEvaluationCriterionSchema`.
fn criterion(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let item_id = issues.text(fields, "id", Presence::Required, Some(1), Some(40));
    let label = short_text(issues, fields, "label", Presence::Required, 200, true);
    let description = text_max(issues, fields, "description", Presence::Nullish, 1000);
    let weight = number(issues, fields, "weight", Presence::Required, Some(0.0), Some(100.0));
    let max_score = number(issues, fields, "maxScore", Presence::Required, Some(1.0), Some(100.0));
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
            return Err(HrError::validation(format!("Duplicate criterion id \"{id}\"")));
        }
        ids.push(id);
    }
    let total: f64 = criteria.iter().map(|c| c["weight"].as_f64().unwrap_or(0.0)).sum();
    if total <= 0.0 {
        return Err(HrError::validation("At least one criterion needs a weight above zero"));
    }
    Ok(())
}

fn form_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    vec![
        ("name", field_json(&short_text(issues, fields, "name", required, 160, true))),
        ("description", field_json(&text_max(issues, fields, "description", Presence::Nullish, 2000))),
        ("criteria", field_json(&issues.list(fields, "criteria", required, Some(1), Some(50), criterion))),
        ("is_active", field_json(&issues.boolean(fields, "isActive", Presence::Optional))),
    ]
}

async fn create_form(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| form_fields(issues, fields, false))?;
    let criteria = get_field(&input, "criteria").and_then(Value::as_array).cloned().unwrap_or_default();
    assert_criteria(&criteria)?;
    set_field(&mut input, "id", json!(generate_id("hrevf")));
    let row: Value = sqlx::query_scalar(
        "insert into hr_evaluation_forms as t (id, name, description, criteria, is_active)
         select r.id, r.name, r.description, r.criteria, coalesce(r.is_active, true)
         from jsonb_populate_record(null::hr_evaluation_forms, $1) r returning to_jsonb(t)",
    )
    .bind(record(&input))
    .fetch_one(&caller.db)
    .await?;
    Ok(Created(js_row(row)).into_response())
}

async fn update_form(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| form_fields(issues, fields, true))?;
    require_evaluation_form(&caller.db, &id).await?;
    if let Some(criteria) = get_field(&input, "criteria").and_then(Value::as_array) {
        assert_criteria(criteria)?;
    }
    let row: Value = sqlx::query_scalar(
        "update hr_evaluation_forms as t set
             name = case when $1 ? 'name' then r.name else t.name end,
             description = case when $1 ? 'description' then r.description else t.description end,
             criteria = case when $1 ? 'criteria' then r.criteria else t.criteria end,
             is_active = case when $1 ? 'is_active' then r.is_active else t.is_active end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_evaluation_forms, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(record(&input))
    .bind(&id)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn delete_form(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_evaluation_form(&caller.db, &id).await?;
    sqlx::query("update hr_evaluation_forms set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
        .map(|s| (text(s, "criterionId"), s["score"].as_f64().unwrap_or(f64::NAN)))
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

fn assert_submittable(criteria: &[Value], scores: &[Value], period_start: Option<&str>) -> Result<(), HrError> {
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
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_evaluations t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Evaluation", id))
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
}

pub(crate) async fn list_evaluations(db: &PgPool, filters: &EvaluationFilters) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = filters
        .status
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(ev), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name, 'formName', f.name)
         from hr_evaluations ev join hr_employees e on e.id = ev.employee_id
         left join hr_evaluation_forms f on f.id = ev.form_id
         where ev.deleted_at is null and e.deleted_at is null
           and ($1::text is null or ev.employee_id = $1)
           and ($2::text is null or ev.company_id = $2)
           and ($3::text[] is null or ev.status = any($3))
           and ($4::text is null or ev.form_id = $4)
           and ($5::text is null or coalesce(ev.period_end, ev.created_at::date) >= $5::date)
           and ($6::text is null or coalesce(ev.period_start, ev.created_at::date) <= $6::date)
         order by ev.created_at desc limit 1000",
    )
    .bind(&filters.employee_id)
    .bind(&filters.company_id)
    .bind(&statuses)
    .bind(&filters.form_id)
    .bind(&filters.from)
    .bind(&filters.to)
    .fetch_all(db)
    .await?;
    let evaluators: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["evaluator_user_id"].as_str()).collect();
    let companies: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["company_id"].as_str()).collect();
    let evaluator_names = member_names(db, &evaluators).await?;
    let company_name = company_names(db, &companies).await?;
    Ok(rows
        .into_iter()
        .map(|(evaluation, extra)| {
            let mut evaluation = js_row(evaluation);
            let evaluator = if evaluation["evaluatorName"].is_null() {
                json!(evaluation["evaluatorUserId"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .and_then(|e| evaluator_names.get(e).cloned()))
            } else {
                evaluation["evaluatorName"].clone()
            };
            let company = evaluation["companyId"].as_str().filter(|c| !c.is_empty()).and_then(|c| company_name.get(c).cloned());
            if let Some(map) = evaluation.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&extra)));
                map.insert("formName".to_owned(), extra["formName"].clone());
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
    let score = number(issues, fields, "score", Presence::Required, Some(0.0), Some(100.0));
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
        scores: issues.list(fields, "scores", Presence::Optional, None, Some(50), score_item),
        summary: text_max(issues, fields, "summary", Presence::Nullish, 20000),
        shared: issues.boolean(fields, "sharedWithClient", Presence::Optional),
        submit: issues.boolean(fields, "submit", Presence::Optional),
    }
}

async fn create_evaluation(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| evaluation_input(issues, fields, false))?;
    let db = &caller.db;
    assert_date_order(input.period_start.as_set().map(String::as_str), input.period_end.as_set().map(String::as_str), "Evaluation period")?;
    require_employee(db, input.employee_id.as_set().map_or("", String::as_str)).await?;
    let form = require_evaluation_form(db, input.form_id.as_set().map_or("", String::as_str)).await?;
    let criteria = form["criteria"].as_array().cloned().unwrap_or_default();
    let scores = input.scores.as_set().cloned().unwrap_or_default();
    assert_scores(&criteria, &scores)?;
    let submit = input.submit.as_set() == Some(&true);
    if submit {
        assert_submittable(&criteria, &scores, input.period_start.as_set().map(String::as_str))?;
    }
    let evaluator_name = member_names(db, &[Some(caller.user_id.as_str())]).await?.get(&caller.user_id).cloned();
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into hr_evaluations (id, employee_id, form_id, company_id, evaluator_user_id, evaluator_name,
             period_start, period_end, criteria, scores, overall_score, summary, shared_with_client, status,
             submitted_at)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15::timestamp)
         returning to_jsonb(hr_evaluations)",
    )
    .bind(generate_id("hrevl"))
    .bind(input.employee_id.as_set())
    .bind(text(&form, "id"))
    .bind(input.company_id.as_set())
    .bind(&caller.user_id)
    .bind(evaluator_name)
    .bind(input.period_start.as_set())
    .bind(input.period_end.as_set())
    .bind(Value::Array(criteria.clone()))
    .bind(Value::Array(scores.clone()))
    .bind(overall_score(&criteria, &scores))
    .bind(input.summary.as_set())
    .bind(input.shared.as_set().copied().unwrap_or(false))
    .bind(if submit { "submitted" } else { "draft" })
    .bind(submit.then_some(now))
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let event = if row["status"] == "submitted" { HR_EVALUATION_SUBMITTED } else { HR_EVALUATION_CREATED };
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
    let input = hr_json(&headers, &body, |issues, fields| evaluation_input(issues, fields, true))?;
    let db = &caller.db;
    let before = require_evaluation(db, &id).await?;
    let existing = require_evaluation(db, &id).await?;
    if existing["status"] == "acknowledged" && (input.scores.as_set().is_some() || !input.summary.is_absent()) {
        return Err(HrError::conflict("An acknowledged evaluation can no longer be rescored"));
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
    let fields = record(&[
        ("company_id", field_json(&input.company_id)),
        ("period_start", field_json(&input.period_start)),
        ("period_end", field_json(&input.period_end)),
        ("summary", field_json(&input.summary)),
        ("shared_with_client", field_json(&input.shared)),
    ]);
    let now = now();
    let row: Value = sqlx::query_scalar(
        "update hr_evaluations as t set
             company_id = case when $1 ? 'company_id' then r.company_id else t.company_id end,
             period_start = case when $1 ? 'period_start' then r.period_start else t.period_start end,
             period_end = case when $1 ? 'period_end' then r.period_end else t.period_end end,
             summary = case when $1 ? 'summary' then r.summary else t.summary end,
             shared_with_client = case when $1 ? 'shared_with_client' then r.shared_with_client else t.shared_with_client end,
             scores = $3, overall_score = $4,
             status = case when $5 then 'submitted' else t.status end,
             submitted_at = case when $5 then $6::timestamp else t.submitted_at end,
             updated_at = $6::timestamp
         from jsonb_populate_record(null::hr_evaluations, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(fields)
    .bind(&id)
    .bind(Value::Array(scores.clone()))
    .bind(overall_score(&criteria, &scores))
    .bind(submitting)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let just_submitted = before["status"] == "draft" && row["status"] == "submitted";
    let event = if just_submitted { HR_EVALUATION_SUBMITTED } else { HR_EVALUATION_UPDATED };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Data(row).into_response())
}

async fn delete_evaluation(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_evaluation(&caller.db, &id).await?;
    require_evaluation(&caller.db, &id).await?;
    sqlx::query("update hr_evaluations set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
    emit(&caller, &state, HR_EVALUATION_DELETED, &row, &["employeeId"]);
    Ok(NoContent.into_response())
}

/// `acknowledgeEvaluation(db, id, employeeId, comment)`.
pub(crate) async fn acknowledge_evaluation(db: &PgPool, id: &str, employee_id: &str, comment: Option<&str>) -> Result<Value, HrError> {
    let row = require_evaluation(db, id).await?;
    if row["employeeId"] != employee_id || row["status"] == "draft" {
        return Err(HrError::not_found("Evaluation", id));
    }
    if row["status"] == "acknowledged" {
        return Err(HrError::conflict("Already acknowledged"));
    }
    let updated: Value = sqlx::query_scalar(
        "update hr_evaluations set status = 'acknowledged', acknowledged_at = $2::timestamp,
             employee_comment = $3, updated_at = $2::timestamp
         where id = $1 returning to_jsonb(hr_evaluations)",
    )
    .bind(id)
    .bind(now())
    .bind(comment)
    .fetch_one(db)
    .await?;
    Ok(js_row(updated))
}

// ---------------------------------------------------------------------------
// KPI definitions
// ---------------------------------------------------------------------------

async fn require_kpi_definition(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_kpi_definitions t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("KPI", id))
}

async fn list_kpis(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let include = query_param(&q, "includeInactive").as_deref() == Some("true");
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_kpi_definitions t
         where ($1 or t.is_active = true) and ($2::text is null or (t.company_id is null or t.company_id = $2))
         order by t.name asc",
    )
    .bind(include)
    .bind(query_text(&q, "companyId"))
    .fetch_all(&caller.db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    let companies: Vec<Option<&str>> = rows.iter().map(|r| r["companyId"].as_str()).collect();
    let names = company_names(&caller.db, &companies).await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let company = row["companyId"].as_str().filter(|c| !c.is_empty()).and_then(|c| names.get(c).cloned());
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

fn kpi_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let mut out = vec![
        ("name", field_json(&short_text(issues, fields, "name", required, 120, true))),
        ("description", field_json(&text_max(issues, fields, "description", Presence::Nullish, 2000))),
        ("unit", field_json(&issues.choice(fields, "unit", Presence::Optional, &KPI_UNITS))),
        ("direction", field_json(&issues.choice(fields, "direction", Presence::Optional, &KPI_DIRECTIONS))),
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
    out.push(("company_id", field_json(&id(issues, fields, "companyId", Presence::Nullish))));
    out.push(("is_active", field_json(&issues.boolean(fields, "isActive", Presence::Optional))));
    out
}

async fn create_kpi(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| kpi_fields(issues, fields, false))?;
    let unit = get_field(&input, "unit").and_then(Value::as_str).unwrap_or("number").to_owned();
    assert_kpi_target(&unit, get_field(&input, "target").and_then(Value::as_f64))?;
    set_field(&mut input, "id", json!(generate_id("hrkpi")));
    let row: Value = sqlx::query_scalar(
        "insert into hr_kpi_definitions as t (id, name, description, unit, direction, target, company_id, is_active)
         select r.id, r.name, r.description, coalesce(r.unit, 'number'), coalesce(r.direction, 'higher_better'),
             r.target, r.company_id, coalesce(r.is_active, true)
         from jsonb_populate_record(null::hr_kpi_definitions, $1) r returning to_jsonb(t)",
    )
    .bind(record(&input))
    .fetch_one(&caller.db)
    .await?;
    Ok(Created(js_row(row)).into_response())
}

async fn update_kpi(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| kpi_fields(issues, fields, true))?;
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
    let row: Value = sqlx::query_scalar(
        "update hr_kpi_definitions as t set
             name = case when $1 ? 'name' then r.name else t.name end,
             description = case when $1 ? 'description' then r.description else t.description end,
             unit = case when $1 ? 'unit' then r.unit else t.unit end,
             direction = case when $1 ? 'direction' then r.direction else t.direction end,
             target = case when $1 ? 'target' then r.target else t.target end,
             company_id = case when $1 ? 'company_id' then r.company_id else t.company_id end,
             is_active = case when $1 ? 'is_active' then r.is_active else t.is_active end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_kpi_definitions, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(record(&input))
    .bind(&id)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn delete_kpi(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    require_kpi_definition(db, &id).await?;
    let used: Option<String> = sqlx::query_scalar("select id from hr_kpi_values where kpi_id = $1 limit 1")
        .bind(&id)
        .fetch_optional(db)
        .await?;
    if used.is_some() {
        sqlx::query("update hr_kpi_definitions set is_active = false, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(now())
            .execute(db)
            .await?;
        return Ok(Data(json!({ "archived": true })).into_response());
    }
    sqlx::query("delete from hr_kpi_definitions where id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    Ok(Data(json!({ "archived": false })).into_response())
}

// ---------------------------------------------------------------------------
// KPI values
// ---------------------------------------------------------------------------

/// `listKpiValues(db, filters)`.
pub(crate) async fn list_kpi_values(
    db: &PgPool,
    employee_id: Option<&str>,
    kpi_id: Option<&str>,
    company_id: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(v), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name,
             'kpiName', d.name, 'unit', d.unit, 'direction', d.direction, 'target', d.target)
         from hr_kpi_values v join hr_employees e on e.id = v.employee_id
         join hr_kpi_definitions d on d.id = v.kpi_id
         where e.deleted_at is null
           and ($1::text is null or v.employee_id = $1)
           and ($2::text is null or v.kpi_id = $2)
           and ($3::text is null or v.company_id = $3)
           and ($4::text is null or v.period_end >= $4::date)
           and ($5::text is null or v.period_start <= $5::date)
         order by v.period_start desc, d.name asc limit 5000",
    )
    .bind(employee_id)
    .bind(kpi_id)
    .bind(company_id)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(value, extra)| {
            let mut value = js_row(value);
            let on_target = extra["target"].as_f64().map(|target| {
                let v = value["value"].as_f64().unwrap_or(f64::NAN);
                if extra["direction"] == "lower_better" { v <= target } else { v >= target }
            });
            if let Some(map) = value.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&extra)));
                map.insert("kpiName".to_owned(), extra["kpiName"].clone());
                map.insert("unit".to_owned(), extra["unit"].clone());
                map.insert("direction".to_owned(), extra["direction"].clone());
                map.insert("target".to_owned(), extra["target"].clone());
                map.insert("onTarget".to_owned(), json!(on_target));
            }
            value
        })
        .collect())
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
    )
    .await?;
    Ok(Data(rows).into_response())
}

async fn require_kpi_value(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from hr_kpi_values t where t.id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("KPI value", id))
}

fn kpi_value_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push(("kpi_id", field_json(&id(issues, fields, "kpiId", Presence::Required))));
        out.push(("employee_id", field_json(&id(issues, fields, "employeeId", Presence::Required))));
    }
    out.push(("company_id", field_json(&id(issues, fields, "companyId", Presence::Nullish))));
    out.push(("period_start", field_json(&iso_date(issues, fields, "periodStart", required))));
    out.push(("period_end", field_json(&iso_date(issues, fields, "periodEnd", required))));
    let value = number(issues, fields, "value", required, None, None);
    out.push(("value", value.as_set().map(|v| js_number(*v))));
    out.push(("shared_with_client", field_json(&issues.boolean(fields, "sharedWithClient", Presence::Optional))));
    out
}

async fn create_kpi_value(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let mut input = hr_json(&headers, &body, |issues, fields| kpi_value_fields(issues, fields, false))?;
    let db = &caller.db;
    assert_date_order(
        get_field(&input, "period_start").and_then(Value::as_str),
        get_field(&input, "period_end").and_then(Value::as_str),
        "KPI period",
    )?;
    require_kpi_definition(db, get_field(&input, "kpi_id").and_then(Value::as_str).unwrap_or_default()).await?;
    require_employee(db, get_field(&input, "employee_id").and_then(Value::as_str).unwrap_or_default()).await?;
    if get_field(&input, "shared_with_client").is_none() {
        set_field(&mut input, "shared_with_client", json!(false));
    }
    set_field(&mut input, "id", json!(generate_id("hrkpv")));
    set_field(&mut input, "source", json!("manual"));
    set_field(&mut input, "created_by", json!(caller.user_id));
    let row: Value = sqlx::query_scalar(
        "insert into hr_kpi_values as t (id, kpi_id, employee_id, company_id, period_start, period_end, value,
             source, shared_with_client, created_by)
         select r.id, r.kpi_id, r.employee_id, r.company_id, r.period_start, r.period_end, r.value, r.source,
             r.shared_with_client, r.created_by
         from jsonb_populate_record(null::hr_kpi_values, $1) r returning to_jsonb(t)",
    )
    .bind(record(&input))
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_KPI_VALUE_CREATED, &row, &["employeeId", "companyId"]);
    Ok(Created(row).into_response())
}

async fn update_kpi_value(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| kpi_value_fields(issues, fields, true))?;
    let db = &caller.db;
    let before = require_kpi_value(db, &id).await?;
    let existing = require_kpi_value(db, &id).await?;
    assert_date_order(
        get_field(&input, "period_start").and_then(Value::as_str).or(existing["periodStart"].as_str()),
        get_field(&input, "period_end").and_then(Value::as_str).or(existing["periodEnd"].as_str()),
        "KPI period",
    )?;
    let row: Value = sqlx::query_scalar(
        "update hr_kpi_values as t set
             company_id = case when $1 ? 'company_id' then r.company_id else t.company_id end,
             period_start = case when $1 ? 'period_start' then r.period_start else t.period_start end,
             period_end = case when $1 ? 'period_end' then r.period_end else t.period_end end,
             value = case when $1 ? 'value' then r.value else t.value end,
             shared_with_client = case when $1 ? 'shared_with_client' then r.shared_with_client else t.shared_with_client end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_kpi_values, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(record(&input))
    .bind(text(&before, "id"))
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_KPI_VALUE_UPDATED, &row, &["employeeId", "companyId"]);
    Ok(Data(row).into_response())
}

async fn delete_kpi_value(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_kpi_value(&caller.db, &id).await?;
    require_kpi_value(&caller.db, &id).await?;
    sqlx::query("delete from hr_kpi_values where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    emit(&caller, &state, HR_KPI_VALUE_DELETED, &row, &["employeeId", "companyId"]);
    Ok(NoContent.into_response())
}

async fn import_kpi_values(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (kpi_id, start, end, shared, rows) = hr_json(&headers, &body, |issues, fields| {
        let kpi = id(issues, fields, "kpiId", Presence::Required);
        let start = iso_date(issues, fields, "periodStart", Presence::Required);
        let end = iso_date(issues, fields, "periodEnd", Presence::Required);
        let shared = issues.boolean(fields, "sharedWithClient", Presence::Optional);
        let rows = issues.list(fields, "rows", Presence::Required, Some(1), Some(5000), |issues, item| {
            let fields = issues.object(item)?;
            let employee = issues.text(fields, "employee", Presence::Required, Some(1), Some(255));
            let value = number(issues, fields, "value", Presence::Required, None, None);
            let company = id(issues, fields, "companyId", Presence::Nullish);
            Some((employee.into_option()?, value.into_option()?, company.into_option()))
        });
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
    let resolved = crate::timekeeping::resolve_employee_refs(db, &refs).await?;
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
        let existing: Option<String> = sqlx::query_scalar(
            "select id from hr_kpi_values where kpi_id = $1 and employee_id = $2 and period_start = $3::date
               and period_end = $4::date limit 1",
        )
        .bind(&kpi_id)
        .bind(&employee_id)
        .bind(&start)
        .bind(&end)
        .fetch_optional(db)
        .await?;
        if let Some(existing) = existing {
            sqlx::query(
                "update hr_kpi_values set value = $2, company_id = $3, shared_with_client = $4, source = 'import',
                     updated_at = $5::timestamp
                 where id = $1",
            )
            .bind(&existing)
            .bind(value)
            .bind(&company)
            .bind(shared)
            .bind(now())
            .execute(db)
            .await?;
            updated += 1;
        } else {
            sqlx::query(
                "insert into hr_kpi_values (id, kpi_id, employee_id, company_id, period_start, period_end, value,
                     shared_with_client, source, created_by)
                 values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, 'import', $9)",
            )
            .bind(generate_id("hrkpv"))
            .bind(&kpi_id)
            .bind(&employee_id)
            .bind(&company)
            .bind(&start)
            .bind(&end)
            .bind(value)
            .bind(shared)
            .bind(&caller.user_id)
            .execute(db)
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
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_milestones t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or_else(|| HrError::not_found("Milestone", id))
}

/// `listMilestones(db, filters)`.
pub(crate) async fn list_milestones(
    db: &PgPool,
    employee_id: Option<&str>,
    company_id: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let statuses: Option<Vec<String>> = status
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(m), jsonb_build_object('employeeFirstName', e.first_name,
             'employeeLastName', e.last_name, 'employeePreferredName', e.preferred_name)
         from hr_milestones m join hr_employees e on e.id = m.employee_id
         where m.deleted_at is null and e.deleted_at is null
           and ($1::text is null or m.employee_id = $1)
           and ($2::text is null or m.company_id = $2)
           and ($3::text[] is null or m.status = any($3))
         order by m.due_date asc nulls last, m.created_at desc limit 1000",
    )
    .bind(employee_id)
    .bind(company_id)
    .bind(&statuses)
    .fetch_all(db)
    .await?;
    let companies: Vec<Option<&str>> = rows.iter().map(|(r, _)| r["company_id"].as_str()).collect();
    let names = company_names(db, &companies).await?;
    Ok(rows
        .into_iter()
        .map(|(milestone, extra)| {
            let mut milestone = js_row(milestone);
            let company = milestone["companyId"].as_str().filter(|c| !c.is_empty()).and_then(|c| names.get(c).cloned());
            if let Some(map) = milestone.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(employee_name_of(&extra)));
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
    )
    .await?;
    Ok(Data(rows).into_response())
}

fn milestone_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> Vec<(&'static str, Option<Value>)> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let mut out: Vec<(&'static str, Option<Value>)> = Vec::new();
    if !partial {
        out.push(("employee_id", field_json(&id(issues, fields, "employeeId", Presence::Required))));
    }
    out.push(("company_id", field_json(&id(issues, fields, "companyId", Presence::Nullish))));
    out.push(("title", field_json(&short_text(issues, fields, "title", required, 255, true))));
    out.push(("description", field_json(&text_max(issues, fields, "description", Presence::Nullish, 5000))));
    out.push(("type", field_json(&issues.choice(fields, "type", Presence::Optional, &MILESTONE_TYPES))));
    out.push(("status", field_json(&issues.choice(fields, "status", Presence::Optional, &MILESTONE_STATUSES))));
    out.push(("due_date", field_json(&iso_date(issues, fields, "dueDate", Presence::Nullish))));
    out.push(("achieved_at", field_json(&iso_date(issues, fields, "achievedAt", Presence::Nullish))));
    out.push(("shared_with_client", field_json(&issues.boolean(fields, "sharedWithClient", Presence::Optional))));
    out
}

fn present(fields: &[(&'static str, Option<Value>)], column: &str) -> bool {
    fields.iter().any(|(c, v)| *c == column && v.is_some())
}

/// `withAchievedDate(input)`.
fn with_achieved_date(mut input: Vec<(&'static str, Option<Value>)>) -> Vec<(&'static str, Option<Value>)> {
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
        get_field(&input, "achieved_at").and_then(Value::as_str).map(str::to_owned)
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
        return Err(HrError::validation("A missed milestone cannot have an achieved date"));
    }
    set_field(&mut input, "status", json!("achieved"));
    Ok(input)
}

async fn create_milestone(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| milestone_fields(issues, fields, false))?;
    let db = &caller.db;
    require_employee(db, get_field(&input, "employee_id").and_then(Value::as_str).unwrap_or_default()).await?;
    let mut input = reconcile_milestone(with_achieved_date(input), "planned", None)?;
    set_field(&mut input, "id", json!(generate_id("hrmil")));
    set_field(&mut input, "created_by", json!(caller.user_id));
    let row: Value = sqlx::query_scalar(
        "insert into hr_milestones as t (id, employee_id, company_id, title, description, type, status, due_date,
             achieved_at, shared_with_client, created_by)
         select r.id, r.employee_id, r.company_id, r.title, r.description, coalesce(r.type, 'milestone'),
             coalesce(r.status, 'planned'), r.due_date, r.achieved_at, coalesce(r.shared_with_client, false),
             r.created_by
         from jsonb_populate_record(null::hr_milestones, $1) r returning to_jsonb(t)",
    )
    .bind(record(&input))
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let event = if row["status"] == "achieved" { HR_MILESTONE_ACHIEVED } else { HR_MILESTONE_CREATED };
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
    let input = hr_json(&headers, &body, |issues, fields| milestone_fields(issues, fields, true))?;
    let db = &caller.db;
    let before = require_milestone(db, &id).await?;
    let existing = require_milestone(db, &id).await?;
    let achieved = existing["achievedAt"].as_str().filter(|a| !a.is_empty());
    let input = if achieved.is_some() { input } else { with_achieved_date(input) };
    let patch = reconcile_milestone(input, text(&existing, "status"), achieved)?;
    let row: Value = sqlx::query_scalar(
        "update hr_milestones as t set
             company_id = case when $1 ? 'company_id' then r.company_id else t.company_id end,
             title = case when $1 ? 'title' then r.title else t.title end,
             description = case when $1 ? 'description' then r.description else t.description end,
             type = case when $1 ? 'type' then r.type else t.type end,
             status = case when $1 ? 'status' then r.status else t.status end,
             due_date = case when $1 ? 'due_date' then r.due_date else t.due_date end,
             achieved_at = case when $1 ? 'achieved_at' then r.achieved_at else t.achieved_at end,
             shared_with_client = case when $1 ? 'shared_with_client' then r.shared_with_client else t.shared_with_client end,
             updated_at = $3::timestamp
         from jsonb_populate_record(null::hr_milestones, $1) r
         where t.id = $2 returning to_jsonb(t)",
    )
    .bind(record(&patch))
    .bind(text(&before, "id"))
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let just_achieved = existing["status"] != "achieved" && row["status"] == "achieved";
    let event = if just_achieved { HR_MILESTONE_ACHIEVED } else { HR_MILESTONE_UPDATED };
    emit(&caller, &state, event, &row, &["employeeId", "status"]);
    Ok(Data(row).into_response())
}

async fn delete_milestone(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = require_milestone(&caller.db, &id).await?;
    require_milestone(&caller.db, &id).await?;
    sqlx::query("update hr_milestones set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
    emit(&caller, &state, HR_MILESTONE_DELETED, &row, &["employeeId"]);
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Starter data
// ---------------------------------------------------------------------------

/// `ensureDefaultEvaluationForm(db)`: the starter scorecard.
pub(crate) async fn ensure_default_evaluation_form(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_evaluation_forms limit 1")
        .fetch_optional(db)
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
    sqlx::query(
        "insert into hr_evaluation_forms (id, name, description, criteria)
         values ('hrevf_default_scorecard', 'Quality scorecard', 'Monthly quality and performance review.', $1)
         on conflict do nothing",
    )
    .bind(criteria)
    .execute(db)
    .await?;
    Ok(())
}

/// `ensureDefaultKpis(db)`: the starter KPI definitions.
pub(crate) async fn ensure_default_kpis(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_kpi_definitions limit 1")
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    sqlx::query(
        "insert into hr_kpi_definitions (id, name, unit, direction, target, description) values
             ('hrkpi_default_csat', 'CSAT', 'percent', 'higher_better', 90, 'Customer satisfaction score'),
             ('hrkpi_default_quality', 'Quality score', 'percent', 'higher_better', 85, null),
             ('hrkpi_default_aht', 'Average handle time', 'seconds', 'lower_better', 360, null),
             ('hrkpi_default_fcr', 'First contact resolution', 'percent', 'higher_better', 75, null)
         on conflict do nothing",
    )
    .execute(db)
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
        let scores = vec![json!({ "criterionId": "a", "score": 4 }), json!({ "criterionId": "b", "score": 3 })];
        assert_eq!(overall_score(&criteria, &scores), Some(66.0));
        assert_eq!(overall_score(&criteria, &[]), None);
    }
}
