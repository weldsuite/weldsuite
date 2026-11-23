//! Checklist templates and on- and offboarding checklists
//! (`routes/weldhr/lifecycle.ts`, `services/weldhr/lifecycle.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_CHECKLIST_COMPLETED, HR_CHECKLIST_CREATED, HR_CHECKLIST_DELETED, HR_CHECKLIST_UPDATED,
    HR_EMPLOYEE_OFFBOARDED, HR_EMPLOYEE_ONBOARDED,
};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ, EMPLOYEES_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    hr_checklist_tasks as tasks, hr_checklist_templates as templates, hr_checklists as checklists,
    hr_employees,
};

use crate::assignments::end_assignments_for;
use crate::employees::{display_name, no_row, pg_date, pg_date_opt, require_employee, to_json};
use crate::entity_scope::{Scope, guard, via_employee};
use crate::fields::{Fields, change, id, int, iso_date, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, hr_json, member_names, query_text, query_values,
    text, today_iso,
};

/// `update hr_checklists set status = <status>, … where id = $1`.
async fn set_checklist_status(
    db: &PgPool,
    checklist_id: &str,
    status: &str,
    completed_at: Option<time::PrimitiveDateTime>,
    now: time::PrimitiveDateTime,
) -> Result<(), HrError> {
    checklists::Entity::update_many()
        .col_expr(checklists::Column::Status, Expr::value(status))
        .col_expr(checklists::Column::CompletedAt, Expr::value(completed_at))
        .col_expr(checklists::Column::UpdatedAt, Expr::value(now))
        .filter(checklists::Column::Id.eq(checklist_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `update hr_employees set status = <status>, updated_at = now where id = $1`.
async fn set_employee_status(
    db: &PgPool,
    employee_id: &str,
    status: &str,
    now: time::PrimitiveDateTime,
) -> Result<(), HrError> {
    hr_employees::Entity::update_many()
        .col_expr(hr_employees::Column::Status, Expr::value(status))
        .col_expr(hr_employees::Column::UpdatedAt, Expr::value(now))
        .filter(hr_employees::Column::Id.eq(employee_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

const KINDS: [&str; 2] = ["onboarding", "offboarding"];
const ROLES: [&str; 5] = ["hr", "manager", "it", "employee", "other"];

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    let update = || gate.require([EMPLOYEES_UPDATE]);
    Router::new()
        .route(
            "/checklist-templates",
            get(list_templates_route).route_layer(gate.require([EMPLOYEES_READ])),
        )
        .route(
            "/checklist-templates",
            post(create_template).route_layer(manage()),
        )
        .route(
            "/checklist-templates/{id}",
            patch(update_template).route_layer(manage()),
        )
        .route(
            "/checklist-templates/{id}",
            delete(delete_template).route_layer(manage()),
        )
        .route(
            "/checklists",
            get(list_checklists_route).route_layer(gate.require([EMPLOYEES_READ])),
        )
        .route("/checklists", post(start_route).route_layer(update()))
        .route(
            "/checklists/{id}/cancel",
            post(cancel_route).route_layer(update()),
        )
        .route(
            "/checklists/{id}",
            delete(delete_checklist_route).route_layer(update()),
        )
        .route(
            "/checklists/{id}/tasks",
            post(add_task_route).route_layer(update()),
        )
        .route(
            "/checklists/tasks/{task_id}",
            patch(update_task_route).route_layer(update()),
        )
        .route(
            "/checklists/tasks/{task_id}",
            delete(delete_task_route).route_layer(update()),
        )
        .route_layer(guard(
            "/checklists",
            "Checklist",
            via_employee!(hr_checklists),
        ))
        .route_layer(guard(
            "/checklists/tasks",
            "Checklist task",
            via_employee!(hr_checklist_tasks),
        ))
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async fn list_templates(db: &PgPool, kind: Option<&str>) -> Result<Vec<Value>, HrError> {
    let mut select = templates::Entity::find().filter(templates::Column::DeletedAt.is_null());
    if let Some(kind) = kind {
        select = select.filter(templates::Column::Kind.eq(kind));
    }
    let rows = select
        .order_by_asc(templates::Column::Kind)
        .order_by_asc(templates::Column::Name)
        .all(&orm(db))
        .await?;
    rows.into_iter().map(to_json).collect()
}

async fn require_template(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = templates::Entity::find()
        .filter(templates::Column::Id.eq(id))
        .filter(templates::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Checklist template", id))?)
}

async fn list_templates_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let kind = query_text(&query_values(query.as_deref()), "kind");
    Ok(Data(list_templates(&caller.db, kind.as_deref()).await?).into_response())
}

struct TemplateInput {
    name: Field<String>,
    description: Field<String>,
    kind: Field<String>,
    department_id: Field<String>,
    items: Field<Vec<Value>>,
    is_default: Field<bool>,
}

/// `hrChecklistTemplateItemSchema`: the item as Zod outputs it.
fn template_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let item_id = issues.text(fields, "id", Presence::Required, Some(1), Some(40));
    let title = short_text(issues, fields, "title", Presence::Required, 255, true);
    let description = text_max(issues, fields, "description", Presence::Nullish, 2000);
    let role = issues.choice(fields, "assigneeRole", Presence::Required, &ROLES);
    let offset = int(
        issues,
        fields,
        "dueOffsetDays",
        Presence::Required,
        Some(-365.0),
        Some(365.0),
    );
    let visible = issues.boolean(fields, "visibleToEmployee", Presence::Required);
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(item_id.as_set()?));
    out.insert("title".to_owned(), json!(title.as_set()?));
    match description {
        Field::Absent => {}
        Field::Null => {
            out.insert("description".to_owned(), Value::Null);
        }
        Field::Set(text) => {
            out.insert("description".to_owned(), json!(text));
        }
    }
    out.insert("assigneeRole".to_owned(), json!(role.as_set()?));
    out.insert(
        "dueOffsetDays".to_owned(),
        crate::js_number(*offset.as_set()?),
    );
    out.insert("visibleToEmployee".to_owned(), json!(visible.as_set()?));
    Some(Value::Object(out))
}

fn template_input(issues: &mut Issues, fields: &Fields, partial: bool) -> TemplateInput {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    TemplateInput {
        name: short_text(issues, fields, "name", required, 160, true),
        description: text_max(issues, fields, "description", Presence::Nullish, 2000),
        kind: issues.choice(fields, "kind", required, &KINDS),
        department_id: id(issues, fields, "departmentId", Presence::Nullish),
        items: issues.list(fields, "items", required, None, Some(200), template_item),
        is_default: issues.boolean(fields, "isDefault", Presence::Optional),
    }
}

/// `clearDefault(db, kind, exceptId?)`.
async fn clear_default(db: &PgPool, kind: &str, except_id: Option<&str>) -> Result<(), HrError> {
    let mut update = templates::Entity::update_many()
        .col_expr(templates::Column::IsDefault, Expr::value(false))
        .col_expr(templates::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(templates::Column::Kind.eq(kind))
        .filter(templates::Column::IsDefault.eq(true));
    if let Some(except_id) = except_id {
        update = update.filter(templates::Column::Id.ne(except_id));
    }
    update.exec(&orm(db)).await?;
    Ok(())
}

async fn create_template(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        template_input(issues, fields, false)
    })?;
    let kind = input.kind.as_set().cloned().unwrap_or_default();
    if input.is_default.as_set() == Some(&true) {
        clear_default(&caller.db, &kind, None).await?;
    }
    let row = templates::Entity::insert(templates::ActiveModel {
        id: Set(generate_id("hrctp")),
        name: Set(input.name.as_set().cloned().unwrap_or_default()),
        description: Set(input.description.as_set().cloned()),
        kind: Set(kind),
        department_id: Set(input.department_id.as_set().cloned()),
        items: Set(Value::Array(
            input.items.as_set().cloned().unwrap_or_default(),
        )),
        is_default: Set(input.is_default.as_set().copied().unwrap_or(false)),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await?;
    Ok(Created(to_json(row)?).into_response())
}

async fn update_template(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        template_input(issues, fields, true)
    })?;
    let existing = require_template(&caller.db, &id).await?;
    if input.is_default.as_set() == Some(&true) {
        let kind = input
            .kind
            .as_set()
            .cloned()
            .unwrap_or_else(|| text(&existing, "kind").to_owned());
        clear_default(&caller.db, &kind, Some(&id)).await?;
    }
    let mut update = templates::Entity::update_many();
    for (column, field) in [
        (templates::Column::Name, &input.name),
        (templates::Column::Description, &input.description),
        (templates::Column::Kind, &input.kind),
        (templates::Column::DepartmentId, &input.department_id),
    ] {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let (true, items) = change(&input.items) {
        update = update.col_expr(
            templates::Column::Items,
            Expr::value(items.map(Value::Array)),
        );
    }
    if let (true, default) = change(&input.is_default) {
        update = update.col_expr(templates::Column::IsDefault, Expr::value(default));
    }
    let row = update
        .col_expr(templates::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(templates::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(&caller.db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_checklist_templates"))?;
    Ok(Data(to_json(row)?).into_response())
}

async fn delete_template(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_template(&caller.db, &id).await?;
    let now = utc_now();
    templates::Entity::update_many()
        .col_expr(templates::Column::DeletedAt, Expr::value(now))
        .col_expr(templates::Column::UpdatedAt, Expr::value(now))
        .filter(templates::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

/// `requireChecklist(db, id)`.
pub(crate) async fn require_checklist(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = checklists::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Checklist", id))?)
}

/// `requireTask(db, id)`.
pub(crate) async fn require_task(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = tasks::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Checklist task", id))?)
}

/// `listChecklists(db, filters)`: with their tasks, newest first; `scope` is
/// the request's entity scope.
pub(crate) async fn list_checklists(
    db: &PgPool,
    employee_id: Option<&str>,
    status: Option<&str>,
    kind: Option<&str>,
    scope: &Scope,
) -> Result<Vec<Value>, HrError> {
    let mut select = checklists::Entity::find()
        .column_as(hr_employees::Column::FirstName, "employee_first_name")
        .column_as(hr_employees::Column::LastName, "employee_last_name")
        .column_as(
            hr_employees::Column::PreferredName,
            "employee_preferred_name",
        )
        .join(
            JoinType::InnerJoin,
            checklists::Entity::belongs_to(hr_employees::Entity)
                .from(checklists::Column::EmployeeId)
                .to(hr_employees::Column::Id)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null());
    if let Some(employee_id) = employee_id {
        select = select.filter(checklists::Column::EmployeeId.eq(employee_id));
    }
    if let Some(status) = status {
        select = select.filter(checklists::Column::Status.eq(status));
    }
    if let Some(kind) = kind {
        select = select.filter(checklists::Column::Kind.eq(kind));
    }
    let checklists: Vec<ChecklistWithEmployee> = select
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_desc(checklists::Column::StartedAt)
        .into_model()
        .all(&orm(db))
        .await?;
    if checklists.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = checklists
        .iter()
        .map(|row| row.checklist.id.as_str())
        .collect();
    let tasks = tasks::Entity::find()
        .filter(tasks::Column::ChecklistId.is_in(ids))
        .order_by_asc(tasks::Column::SortOrder)
        .order_by_asc(tasks::Column::DueDate)
        .all(&orm(db))
        .await?;
    let tasks: Vec<Value> = tasks.into_iter().map(to_json).collect::<Result<_, _>>()?;
    let people: Vec<Option<&str>> = tasks
        .iter()
        .flat_map(|task| {
            [
                task["assigneeUserId"].as_str(),
                task["completedBy"].as_str(),
            ]
        })
        .collect();
    let names = member_names(db, &people).await?;
    let mut by_checklist: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for mut task in tasks.clone() {
        let assignee = task["assigneeUserId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .and_then(|id| names.get(id).cloned());
        let completed_by = task["completedBy"]
            .as_str()
            .filter(|id| !id.is_empty() && !id.starts_with("portal:"))
            .and_then(|id| names.get(id).cloned());
        let checklist_id = text(&task, "checklistId").to_owned();
        if let Some(map) = task.as_object_mut() {
            map.insert("assigneeName".to_owned(), json!(assignee));
            map.insert("completedByName".to_owned(), json!(completed_by));
        }
        by_checklist.entry(checklist_id).or_default().push(task);
    }
    checklists
        .into_iter()
        .map(|row| {
            let mut checklist = to_json(&row.checklist)?;
            let list = by_checklist
                .remove(text(&checklist, "id"))
                .unwrap_or_default();
            let done = list
                .iter()
                .filter(|task| !task["completedAt"].is_null())
                .count();
            let total = list.len();
            if let Some(map) = checklist.as_object_mut() {
                map.insert(
                    "employeeName".to_owned(),
                    json!(display_name(
                        &row.employee_first_name,
                        &row.employee_last_name,
                        row.employee_preferred_name.as_deref(),
                    )),
                );
                map.insert("tasks".to_owned(), Value::Array(list));
                map.insert(
                    "progress".to_owned(),
                    json!({ "done": done, "total": total }),
                );
            }
            Ok(checklist)
        })
        .collect()
}

/// A checklist of the list with its employee's name.
#[derive(Debug, FromQueryResult)]
struct ChecklistWithEmployee {
    #[sea_orm(nested)]
    checklist: checklists::Model,
    employee_first_name: String,
    employee_last_name: String,
    employee_preferred_name: Option<String>,
}

async fn list_checklists_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_checklists(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "status").as_deref(),
        query_text(&q, "kind").as_deref(),
        &caller.scope().await?,
    )
    .await?;
    Ok(Data(rows).into_response())
}

/// `assertCanOffboard(employee, input)`.
fn assert_can_offboard(
    employee: &Value,
    anchor_date: Option<&str>,
    force: bool,
) -> Result<(), HrError> {
    let not_started = employee["status"] == "onboarding"
        || employee["startDate"]
            .as_str()
            .is_some_and(|start| start > today_iso().as_str());
    if not_started && !force {
        return Err(HrError::conflict(
            "This employee has not started yet (still onboarding or a start date in the future). Send force: true to offboard them anyway",
        ));
    }
    if anchor_date.is_none() && employee["endDate"].as_str().is_none() {
        return Err(HrError::validation(
            "Set the last working day (anchorDate) or the employee's end date before starting offboarding",
        ));
    }
    Ok(())
}

/// `managerUserIdOf(db, employee)`.
async fn manager_user_id_of(db: &PgPool, employee: &Value) -> Result<Option<String>, HrError> {
    let Some(manager_id) = employee["managerId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let user: Option<Option<String>> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::UserId)
        .filter(hr_employees::Column::Id.eq(manager_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(user.flatten())
}

/// `statusWhenStarting(kind, current)`.
fn status_when_starting(kind: &str, current: &str) -> Option<&'static str> {
    if kind == "offboarding" {
        return (current != "offboarding").then_some("offboarding");
    }
    (current != "active" && current != "onboarding").then_some("onboarding")
}

/// `startChecklist(db, employeeId, { templateId, anchorDate, force }, startedBy)`.
pub(crate) async fn start_checklist(
    db: &PgPool,
    employee_id: &str,
    template_id: &str,
    anchor_date: Option<&str>,
    force: bool,
    started_by: &str,
) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let template = require_template(db, template_id).await?;
    let kind = text(&template, "kind").to_owned();
    if kind == "offboarding" {
        assert_can_offboard(&employee, anchor_date, force)?;
    }
    let running = in_progress_checklist(db, employee_id, &kind, None).await?;
    if running.is_some() {
        return Err(HrError::conflict(format!(
            "This employee already has an {kind} checklist in progress"
        )));
    }
    let fallback = if kind == "onboarding" {
        employee["startDate"].as_str()
    } else {
        employee["endDate"].as_str()
    };
    let anchor = anchor_date
        .or(fallback)
        .map_or_else(today_iso, str::to_owned);
    let checklist_id = generate_id("hrchk");
    let checklist = checklists::Entity::insert(checklists::ActiveModel {
        id: Set(checklist_id.clone()),
        employee_id: Set(employee_id.to_owned()),
        template_id: Set(Some(text(&template, "id").to_owned())),
        kind: Set(kind.clone()),
        name: Set(text(&template, "name").to_owned()),
        status: Set("in_progress".to_owned()),
        anchor_date: Set(Some(pg_date(&anchor)?)),
        started_by: Set(Some(started_by.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let manager_user_id = manager_user_id_of(db, &employee).await?;
    let items = template["items"].as_array().cloned().unwrap_or_default();
    if !items.is_empty() {
        let mut rows = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let role = text(item, "assigneeRole").to_owned();
            let assignee = match role.as_str() {
                "manager" => manager_user_id.clone(),
                "employee" => employee["userId"].as_str().map(str::to_owned),
                _ => None,
            };
            #[allow(clippy::cast_possible_truncation)]
            let offset = item["dueOffsetDays"].as_f64().unwrap_or(0.0) as i64;
            rows.push(tasks::ActiveModel {
                id: Set(generate_id("hrtsk")),
                checklist_id: Set(checklist_id.clone()),
                employee_id: Set(employee_id.to_owned()),
                title: Set(text(item, "title").to_owned()),
                description: Set(item["description"].as_str().map(str::to_owned)),
                assignee_role: Set(role),
                assignee_user_id: Set(assignee),
                due_date: Set(Some(pg_date(&add_days(&anchor, offset))?)),
                visible_to_employee: Set(item["visibleToEmployee"] == true),
                sort_order: Set(i32::try_from(index).unwrap_or(i32::MAX)),
                ..Default::default()
            });
        }
        // One statement for every task, as the route's `insert … select from unnest(…)`.
        tasks::Entity::insert_many(rows)
            .exec_without_returning(&orm(db))
            .await?;
    }
    if let Some(status) = status_when_starting(&kind, text(&employee, "status")) {
        set_employee_status(db, employee_id, status, utc_now()).await?;
    }
    to_json(checklist)
}

/// `restoreStatusAfterOffboarding(db, checklist)`.
async fn restore_status_after_offboarding(db: &PgPool, checklist: &Value) -> Result<(), HrError> {
    if checklist["kind"] != "offboarding" || checklist["status"] == "completed" {
        return Ok(());
    }
    let employee = require_employee(db, text(checklist, "employeeId")).await?;
    if employee["status"] != "offboarding" {
        return Ok(());
    }
    let employee_id = text(&employee, "id");
    let other =
        in_progress_checklist(db, employee_id, "offboarding", Some(text(checklist, "id"))).await?;
    if other.is_some() {
        return Ok(());
    }
    let onboarding = in_progress_checklist(db, employee_id, "onboarding", None).await?;
    let not_started = employee["startDate"]
        .as_str()
        .is_some_and(|start| start > today_iso().as_str());
    let status = if onboarding.is_some() || not_started {
        "onboarding"
    } else {
        "active"
    };
    set_employee_status(db, employee_id, status, utc_now()).await?;
    Ok(())
}

/// `select id from hr_checklists where employee_id = $1 and kind = $2 and
/// status = 'in_progress' [and id <> $3] limit 1`.
async fn in_progress_checklist(
    db: &PgPool,
    employee_id: &str,
    kind: &str,
    except_id: Option<&str>,
) -> Result<Option<String>, HrError> {
    let mut select = checklists::Entity::find()
        .select_only()
        .column(checklists::Column::Id)
        .filter(checklists::Column::EmployeeId.eq(employee_id))
        .filter(checklists::Column::Kind.eq(kind))
        .filter(checklists::Column::Status.eq("in_progress"));
    if let Some(except_id) = except_id {
        select = select.filter(checklists::Column::Id.ne(except_id));
    }
    Ok(select.into_tuple().one(&orm(db)).await?)
}

/// `ChecklistOutcome`.
#[derive(Debug, Clone)]
pub(crate) struct ChecklistOutcome {
    pub(crate) checklist_completed: bool,
    pub(crate) kind: String,
    pub(crate) employee_id: String,
    pub(crate) employee_status: Option<&'static str>,
}

impl ChecklistOutcome {
    pub(crate) fn json(&self) -> Value {
        json!({
            "checklistCompleted": self.checklist_completed,
            "kind": self.kind,
            "employeeId": self.employee_id,
            "employeeStatus": self.employee_status,
        })
    }
}

/// `settleChecklist(db, checklistId)`: close a checklist whose tasks are all
/// done (and move the employee on), reopen one with a task open again.
pub(crate) async fn settle_checklist(
    db: &PgPool,
    checklist_id: &str,
) -> Result<ChecklistOutcome, HrError> {
    let checklist = require_checklist(db, checklist_id).await?;
    let mut outcome = ChecklistOutcome {
        checklist_completed: false,
        kind: text(&checklist, "kind").to_owned(),
        employee_id: text(&checklist, "employeeId").to_owned(),
        employee_status: None,
    };
    if checklist["status"] == "cancelled" {
        return Ok(outcome);
    }
    let (total, open): (i64, i64) = tasks::Entity::find()
        .select_only()
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total")
        .column_as(
            Expr::from(Func::count(Expr::case(
                tasks::Column::CompletedAt.is_null(),
                1,
            ))),
            "open",
        )
        .filter(tasks::Column::ChecklistId.eq(checklist_id))
        .into_tuple()
        .one(&orm(db))
        .await?
        .unwrap_or((0, 0));
    let now = utc_now();
    if total > 0 && open == 0 && checklist["status"] != "completed" {
        set_checklist_status(db, checklist_id, "completed", Some(now), now).await?;
        outcome.checklist_completed = true;
        let employee = require_employee(db, &outcome.employee_id).await?;
        if outcome.kind == "onboarding" && employee["status"] == "onboarding" {
            set_employee_status(db, &outcome.employee_id, "active", now).await?;
            outcome.employee_status = Some("active");
        }
        if outcome.kind == "offboarding" {
            let end_date = employee["endDate"]
                .as_str()
                .or_else(|| checklist["anchorDate"].as_str())
                .map_or_else(today_iso, str::to_owned);
            hr_employees::Entity::update_many()
                .col_expr(hr_employees::Column::Status, Expr::value("terminated"))
                .col_expr(
                    hr_employees::Column::EndDate,
                    Expr::value(pg_date(&end_date)?),
                )
                .col_expr(hr_employees::Column::UpdatedAt, Expr::value(now))
                .filter(hr_employees::Column::Id.eq(outcome.employee_id.as_str()))
                .exec(&orm(db))
                .await?;
            end_assignments_for(db, &outcome.employee_id, &end_date).await?;
            outcome.employee_status = Some("terminated");
        }
    } else if open > 0 && checklist["status"] == "completed" {
        set_checklist_status(db, checklist_id, "in_progress", None, now).await?;
    }
    Ok(outcome)
}

/// `emitOutcome(c, checklistId, outcome)`: the knock-on events of a task change.
fn emit_outcome(caller: &Caller, state: &HrState, checklist_id: &str, outcome: &ChecklistOutcome) {
    if !outcome.checklist_completed {
        return;
    }
    caller.emit(
        state,
        HR_CHECKLIST_COMPLETED,
        checklist_id,
        &[
            ("employeeId", Some(json!(outcome.employee_id))),
            ("status", Some(json!("completed"))),
        ],
    );
    match outcome.employee_status {
        Some("active") => caller.emit(
            state,
            HR_EMPLOYEE_ONBOARDED,
            &outcome.employee_id,
            &[("status", Some(json!("active")))],
        ),
        Some("terminated") => caller.emit(
            state,
            HR_EMPLOYEE_OFFBOARDED,
            &outcome.employee_id,
            &[("status", Some(json!("terminated")))],
        ),
        _ => {}
    }
}

async fn start_route(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (template_id, anchor, force, employee_id) = hr_json(&headers, &body, |issues, fields| {
        (
            id(issues, fields, "templateId", Presence::Required),
            iso_date(issues, fields, "anchorDate", Presence::Optional),
            issues.boolean(fields, "force", Presence::Optional),
            issues.text(fields, "employeeId", Presence::Required, Some(1), Some(30)),
        )
    })?;
    let employee_id = employee_id.into_option().unwrap_or_default();
    caller.assert_employee_visible(Some(&employee_id)).await?;
    let checklist = start_checklist(
        &caller.db,
        &employee_id,
        &template_id.into_option().unwrap_or_default(),
        anchor.as_set().map(String::as_str),
        force.as_set() == Some(&true),
        &caller.user_id,
    )
    .await?;
    caller.emit(
        &state,
        HR_CHECKLIST_CREATED,
        text(&checklist, "id"),
        &[
            ("employeeId", Some(json!(employee_id))),
            ("status", Some(checklist["status"].clone())),
        ],
    );
    Ok(Created(checklist).into_response())
}

async fn cancel_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let existing = require_checklist(&caller.db, &id).await?;
    let row = checklists::Entity::update_many()
        .col_expr(checklists::Column::Status, Expr::value("cancelled"))
        .col_expr(checklists::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(checklists::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(&caller.db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_checklists"))?;
    restore_status_after_offboarding(&caller.db, &existing).await?;
    let row = to_json(row)?;
    caller.emit(
        &state,
        HR_CHECKLIST_UPDATED,
        text(&row, "id"),
        &[
            ("employeeId", Some(row["employeeId"].clone())),
            ("status", Some(row["status"].clone())),
        ],
    );
    Ok(Data(row).into_response())
}

async fn delete_checklist_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let checklist = require_checklist(&caller.db, &id).await?;
    let existing = require_checklist(&caller.db, &id).await?;
    let db = &orm(&caller.db);
    tasks::Entity::delete_many()
        .filter(tasks::Column::ChecklistId.eq(id.as_str()))
        .exec(db)
        .await?;
    checklists::Entity::delete_by_id(id.clone())
        .exec(db)
        .await?;
    restore_status_after_offboarding(&caller.db, &existing).await?;
    caller.emit(
        &state,
        HR_CHECKLIST_DELETED,
        text(&checklist, "id"),
        &[("employeeId", Some(checklist["employeeId"].clone()))],
    );
    Ok(NoContent.into_response())
}

struct TaskInput {
    title: Field<String>,
    description: Field<String>,
    assignee_role: Field<String>,
    assignee_user_id: Field<String>,
    due_date: Field<String>,
    visible: Field<bool>,
    completed: Field<bool>,
}

fn task_input(issues: &mut Issues, fields: &Fields, partial: bool) -> TaskInput {
    TaskInput {
        title: short_text(
            issues,
            fields,
            "title",
            if partial {
                Presence::Optional
            } else {
                Presence::Required
            },
            255,
            true,
        ),
        description: text_max(issues, fields, "description", Presence::Nullish, 2000),
        assignee_role: issues.choice(fields, "assigneeRole", Presence::Optional, &ROLES),
        assignee_user_id: text_max(issues, fields, "assigneeUserId", Presence::Nullish, 255),
        due_date: iso_date(issues, fields, "dueDate", Presence::Nullish),
        visible: issues.boolean(fields, "visibleToEmployee", Presence::Optional),
        completed: if partial {
            issues.boolean(fields, "completed", Presence::Optional)
        } else {
            Field::Absent
        },
    }
}

async fn add_task_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(checklist_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        task_input(issues, fields, false)
    })?;
    let db = &caller.db;
    let checklist = require_checklist(db, &checklist_id).await?;
    // `coalesce(max(sort_order), -1)`.
    let max: Option<i32> = tasks::Entity::find()
        .select_only()
        .column_as(tasks::Column::SortOrder.max(), "max")
        .filter(tasks::Column::ChecklistId.eq(checklist_id.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?
        .flatten();
    let max = max.map_or(-1, i64::from);
    let row = tasks::Entity::insert(tasks::ActiveModel {
        id: Set(generate_id("hrtsk")),
        checklist_id: Set(checklist_id.clone()),
        employee_id: Set(text(&checklist, "employeeId").to_owned()),
        title: Set(input.title.as_set().cloned().unwrap_or_default()),
        description: Set(input.description.as_set().cloned()),
        assignee_role: Set(input
            .assignee_role
            .as_set()
            .map_or("hr", String::as_str)
            .to_owned()),
        assignee_user_id: Set(input.assignee_user_id.as_set().cloned()),
        due_date: Set(pg_date_opt(input.due_date.as_set().map(String::as_str))?),
        visible_to_employee: Set(input.visible.as_set().copied().unwrap_or(false)),
        sort_order: Set(i32::try_from(max + 1).unwrap_or(i32::MAX)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    if checklist["status"] == "completed" {
        set_checklist_status(db, &checklist_id, "in_progress", None, utc_now()).await?;
    }
    let task = to_json(row)?;
    caller.emit(
        &state,
        HR_CHECKLIST_UPDATED,
        &checklist_id,
        &[("employeeId", Some(task["employeeId"].clone()))],
    );
    Ok(Created(task).into_response())
}

/// `updateTask(db, taskId, input, actorId)`.
pub(crate) async fn update_task(
    db: &PgPool,
    task_id: &str,
    input: &TaskPatch,
    actor_id: &str,
) -> Result<(Value, ChecklistOutcome), HrError> {
    let task = require_task(db, task_id).await?;
    let now = utc_now();
    let mut update = tasks::Entity::update_many();
    for (column, field) in [
        (tasks::Column::Title, &input.title),
        (tasks::Column::Description, &input.description),
        (tasks::Column::AssigneeRole, &input.assignee_role),
        (tasks::Column::AssigneeUserId, &input.assignee_user_id),
    ] {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let (true, due) = change(&input.due_date) {
        let due = pg_date_opt(due.as_deref())?;
        update = update.col_expr(tasks::Column::DueDate, Expr::value(due));
    }
    if let (true, visible) = change(&input.visible) {
        update = update.col_expr(tasks::Column::VisibleToEmployee, Expr::value(visible));
    }
    // `completed: true` stamps a task not done yet; `false` clears the stamp.
    let completed = match input.completed {
        Some(true) if task["completedAt"].is_null() => Some((Some(now), Some(actor_id))),
        Some(false) => Some((None, None)),
        _ => None,
    };
    if let Some((completed_at, completed_by)) = completed {
        update = update
            .col_expr(tasks::Column::CompletedAt, Expr::value(completed_at))
            .col_expr(tasks::Column::CompletedBy, Expr::value(completed_by));
    }
    let row = update
        .col_expr(tasks::Column::UpdatedAt, Expr::value(now))
        .filter(tasks::Column::Id.eq(task_id))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_checklist_tasks"))?;
    let outcome = settle_checklist(db, text(&task, "checklistId")).await?;
    Ok((to_json(row)?, outcome))
}

/// The fields `updateTask` takes.
#[derive(Default)]
pub(crate) struct TaskPatch {
    pub(crate) title: Field<String>,
    pub(crate) description: Field<String>,
    pub(crate) assignee_role: Field<String>,
    pub(crate) assignee_user_id: Field<String>,
    pub(crate) due_date: Field<String>,
    pub(crate) visible: Field<bool>,
    pub(crate) completed: Option<bool>,
}

async fn update_task_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        task_input(issues, fields, true)
    })?;
    let patch = TaskPatch {
        title: input.title,
        description: input.description,
        assignee_role: input.assignee_role,
        assignee_user_id: input.assignee_user_id,
        due_date: input.due_date,
        visible: input.visible,
        completed: input.completed.as_set().copied(),
    };
    let (task, outcome) = update_task(&caller.db, &task_id, &patch, &caller.user_id).await?;
    let checklist_id = text(&task, "checklistId").to_owned();
    caller.emit(
        &state,
        HR_CHECKLIST_UPDATED,
        &checklist_id,
        &[("employeeId", Some(task["employeeId"].clone()))],
    );
    emit_outcome(&caller, &state, &checklist_id, &outcome);
    Ok(Data(json!({ "task": task, "outcome": outcome.json() })).into_response())
}

async fn delete_task_route(
    State(state): State<HrState>,
    caller: Caller,
    Path(task_id): Path<String>,
) -> HrResult {
    let task = require_task(&caller.db, &task_id).await?;
    // deleteTask reads the task again before deleting it.
    require_task(&caller.db, &task_id).await?;
    tasks::Entity::delete_by_id(task_id.clone())
        .exec(&orm(&caller.db))
        .await?;
    let checklist_id = text(&task, "checklistId").to_owned();
    let outcome = settle_checklist(&caller.db, &checklist_id).await?;
    caller.emit(
        &state,
        HR_CHECKLIST_UPDATED,
        &checklist_id,
        &[("employeeId", Some(task["employeeId"].clone()))],
    );
    emit_outcome(&caller, &state, &checklist_id, &outcome);
    Ok(NoContent.into_response())
}

/// `ensureDefaultTemplates(db)`: a first onboarding and offboarding
/// template for a new workspace, with fixed ids so racing requests seed one.
pub(crate) async fn ensure_default_templates(db: &PgPool) -> Result<(), HrError> {
    let db = &orm(db);
    let existing: Option<String> = templates::Entity::find()
        .select_only()
        .column(templates::Column::Id)
        .filter(templates::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let item = |title: &str, role: &str, offset: i64, visible: bool| {
        json!({
            "id": generate_id("item"),
            "title": title,
            "assigneeRole": role,
            "dueOffsetDays": offset,
            "visibleToEmployee": visible,
        })
    };
    let onboarding = json!([
        item("Send contract and collect signature", "hr", -10, false),
        item("Collect ID and tax documents", "hr", -5, true),
        item("Create accounts and order equipment", "it", -3, false),
        item(
            "Complete your profile and emergency contact",
            "employee",
            0,
            true
        ),
        item("Welcome meeting and team introduction", "manager", 0, true),
        item("Client account training", "manager", 5, true),
        item("30-day check-in", "manager", 30, true),
        item("Probation review", "hr", 90, false),
    ]);
    let offboarding = json!([
        item("Confirm last working day in writing", "hr", -14, false),
        item("Hand over client accounts", "manager", -7, true),
        item("Exit interview", "hr", -2, true),
        item("Return equipment", "employee", 0, true),
        item("Revoke system access", "it", 0, false),
        item("Final pay and documents", "hr", 7, false),
    ]);
    let template = |id: &str, name: &str, kind: &str, items: Value| templates::ActiveModel {
        id: Set(id.to_owned()),
        name: Set(name.to_owned()),
        kind: Set(kind.to_owned()),
        is_default: Set(true),
        items: Set(items),
        ..Default::default()
    };
    templates::Entity::insert_many([
        template(
            "hrctp_default_onboarding",
            "Standard onboarding",
            "onboarding",
            onboarding,
        ),
        template(
            "hrctp_default_offboarding",
            "Standard offboarding",
            "offboarding",
            offboarding,
        ),
    ])
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(db)
    .await?;
    Ok(())
}
