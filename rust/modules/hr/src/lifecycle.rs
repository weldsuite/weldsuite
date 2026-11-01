//! Checklist templates and on- and offboarding checklists
//! (`routes/weldhr/lifecycle.ts`, `services/weldhr/lifecycle.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_CHECKLIST_COMPLETED, HR_CHECKLIST_CREATED, HR_CHECKLIST_DELETED, HR_CHECKLIST_UPDATED,
    HR_EMPLOYEE_OFFBOARDED, HR_EMPLOYEE_ONBOARDED,
};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ, EMPLOYEES_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::assignments::end_assignments_for;
use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, change, id, int, iso_date, short_text, text_max};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, hr_json, member_names, now, query_text,
    query_values, text, today_iso,
};

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
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async fn list_templates(db: &PgPool, kind: Option<&str>) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_checklist_templates t
         where t.deleted_at is null and ($1::text is null or t.kind = $1)
         order by t.kind asc, t.name asc",
    )
    .bind(kind)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn require_template(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_checklist_templates t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Checklist template", id))
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
    sqlx::query(
        "update hr_checklist_templates set is_default = false, updated_at = $3::timestamp
         where kind = $1 and is_default = true and ($2::text is null or id <> $2)",
    )
    .bind(kind)
    .bind(except_id)
    .bind(now())
    .execute(db)
    .await?;
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
    let row: Value = sqlx::query_scalar(
        "insert into hr_checklist_templates (id, name, description, kind, department_id, items, is_default)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, false))
         returning to_jsonb(hr_checklist_templates)",
    )
    .bind(generate_id("hrctp"))
    .bind(input.name.as_set())
    .bind(input.description.as_set())
    .bind(&kind)
    .bind(input.department_id.as_set())
    .bind(Value::Array(input.items.as_set().cloned().unwrap_or_default()))
    .bind(input.is_default.as_set())
    .fetch_one(&caller.db)
    .await?;
    Ok(Created(js_row(row)).into_response())
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
    let (set_name, name) = change(&input.name);
    let (set_description, description) = change(&input.description);
    let (set_kind, kind) = change(&input.kind);
    let (set_department, department) = change(&input.department_id);
    let (set_items, items) = change(&input.items);
    let (set_default, default) = change(&input.is_default);
    let row: Value = sqlx::query_scalar(
        "update hr_checklist_templates set
             name = case when $2 then $3 else name end,
             description = case when $4 then $5 else description end,
             kind = case when $6 then $7 else kind end,
             department_id = case when $8 then $9 else department_id end,
             items = case when $10 then $11 else items end,
             is_default = case when $12 then $13 else is_default end,
             updated_at = $14::timestamp
         where id = $1 returning to_jsonb(hr_checklist_templates)",
    )
    .bind(&id)
    .bind(set_name)
    .bind(name)
    .bind(set_description)
    .bind(description)
    .bind(set_kind)
    .bind(kind)
    .bind(set_department)
    .bind(department)
    .bind(set_items)
    .bind(items.map(Value::Array))
    .bind(set_default)
    .bind(default)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn delete_template(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_template(&caller.db, &id).await?;
    sqlx::query(
        "update hr_checklist_templates set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(now())
    .execute(&caller.db)
    .await?;
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

/// `requireChecklist(db, id)`.
pub(crate) async fn require_checklist(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_checklists t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Checklist", id))
}

/// `requireTask(db, id)`.
pub(crate) async fn require_task(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_checklist_tasks t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Checklist task", id))
}

/// `listChecklists(db, filters)`: with their tasks, newest first.
pub(crate) async fn list_checklists(
    db: &PgPool,
    employee_id: Option<&str>,
    status: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Value>, HrError> {
    let checklists: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(c), jsonb_build_object('firstName', e.first_name, 'lastName', e.last_name,
                 'preferredName', e.preferred_name)
         from hr_checklists c
         join hr_employees e on e.id = c.employee_id
         where e.deleted_at is null
           and ($1::text is null or c.employee_id = $1)
           and ($2::text is null or c.status = $2)
           and ($3::text is null or c.kind = $3)
         order by c.started_at desc",
    )
    .bind(employee_id)
    .bind(status)
    .bind(kind)
    .fetch_all(db)
    .await?;
    if checklists.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = checklists
        .iter()
        .map(|(c, _)| c["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let tasks: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_checklist_tasks t where t.checklist_id = any($1)
         order by t.sort_order asc, t.due_date asc",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let tasks: Vec<Value> = tasks.into_iter().map(js_row).collect();
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
    Ok(checklists
        .into_iter()
        .map(|(checklist, employee)| {
            let mut checklist = js_row(checklist);
            let list = by_checklist
                .remove(text(&checklist, "id"))
                .unwrap_or_default();
            let done = list
                .iter()
                .filter(|task| !task["completedAt"].is_null())
                .count();
            let total = list.len();
            if let Some(map) = checklist.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(display_name_of(&employee)));
                map.insert("tasks".to_owned(), Value::Array(list));
                map.insert(
                    "progress".to_owned(),
                    json!({ "done": done, "total": total }),
                );
            }
            checklist
        })
        .collect())
}

async fn list_checklists_route(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let rows = list_checklists(
        &caller.db,
        query_text(&q, "employeeId").as_deref(),
        query_text(&q, "status").as_deref(),
        query_text(&q, "kind").as_deref(),
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
    let user: Option<Option<String>> =
        sqlx::query_scalar("select user_id from hr_employees where id = $1 limit 1")
            .bind(manager_id)
            .fetch_optional(db)
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
    let running: Option<String> = sqlx::query_scalar(
        "select id from hr_checklists where employee_id = $1 and kind = $2 and status = 'in_progress' limit 1",
    )
    .bind(employee_id)
    .bind(&kind)
    .fetch_optional(db)
    .await?;
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
    let checklist: Value = sqlx::query_scalar(
        "insert into hr_checklists (id, employee_id, template_id, kind, name, status, anchor_date, started_by)
         values ($1, $2, $3, $4, $5, 'in_progress', $6::date, $7)
         returning to_jsonb(hr_checklists)",
    )
    .bind(&checklist_id)
    .bind(employee_id)
    .bind(text(&template, "id"))
    .bind(&kind)
    .bind(text(&template, "name"))
    .bind(&anchor)
    .bind(started_by)
    .fetch_one(db)
    .await?;
    let manager_user_id = manager_user_id_of(db, &employee).await?;
    let items = template["items"].as_array().cloned().unwrap_or_default();
    if !items.is_empty() {
        let mut ids = Vec::new();
        let mut titles = Vec::new();
        let mut descriptions: Vec<Option<String>> = Vec::new();
        let mut roles = Vec::new();
        let mut assignees: Vec<Option<String>> = Vec::new();
        let mut dues = Vec::new();
        let mut visibles = Vec::new();
        let mut orders = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let role = text(item, "assigneeRole").to_owned();
            ids.push(generate_id("hrtsk"));
            titles.push(text(item, "title").to_owned());
            descriptions.push(item["description"].as_str().map(str::to_owned));
            assignees.push(match role.as_str() {
                "manager" => manager_user_id.clone(),
                "employee" => employee["userId"].as_str().map(str::to_owned),
                _ => None,
            });
            roles.push(role);
            #[allow(clippy::cast_possible_truncation)]
            let offset = item["dueOffsetDays"].as_f64().unwrap_or(0.0) as i64;
            dues.push(add_days(&anchor, offset));
            visibles.push(item["visibleToEmployee"] == true);
            orders.push(i32::try_from(index).unwrap_or(i32::MAX));
        }
        sqlx::query(
            "insert into hr_checklist_tasks
                 (id, checklist_id, employee_id, title, description, assignee_role, assignee_user_id,
                  due_date, visible_to_employee, sort_order)
             select u.id, $2, $3, u.title, u.description, u.role, u.assignee, u.due::date, u.visible, u.ord
             from unnest($1::varchar[], $4::varchar[], $5::text[], $6::varchar[], $7::varchar[],
                         $8::text[], $9::boolean[], $10::int[])
                  as u(id, title, description, role, assignee, due, visible, ord)",
        )
        .bind(&ids)
        .bind(&checklist_id)
        .bind(employee_id)
        .bind(&titles)
        .bind(&descriptions)
        .bind(&roles)
        .bind(&assignees)
        .bind(&dues)
        .bind(&visibles)
        .bind(&orders)
        .execute(db)
        .await?;
    }
    if let Some(status) = status_when_starting(&kind, text(&employee, "status")) {
        sqlx::query(
            "update hr_employees set status = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(employee_id)
        .bind(status)
        .bind(now())
        .execute(db)
        .await?;
    }
    Ok(js_row(checklist))
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
    let other: Option<String> = sqlx::query_scalar(
        "select id from hr_checklists where employee_id = $1 and kind = 'offboarding'
           and status = 'in_progress' and id <> $2 limit 1",
    )
    .bind(employee_id)
    .bind(text(checklist, "id"))
    .fetch_optional(db)
    .await?;
    if other.is_some() {
        return Ok(());
    }
    let onboarding: Option<String> = sqlx::query_scalar(
        "select id from hr_checklists where employee_id = $1 and kind = 'onboarding' and status = 'in_progress' limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let not_started = employee["startDate"]
        .as_str()
        .is_some_and(|start| start > today_iso().as_str());
    let status = if onboarding.is_some() || not_started {
        "onboarding"
    } else {
        "active"
    };
    sqlx::query("update hr_employees set status = $2, updated_at = $3::timestamp where id = $1")
        .bind(employee_id)
        .bind(status)
        .bind(now())
        .execute(db)
        .await?;
    Ok(())
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
    let (total, open): (i64, i64) = sqlx::query_as(
        "select count(*), count(*) filter (where completed_at is null)
         from hr_checklist_tasks where checklist_id = $1",
    )
    .bind(checklist_id)
    .fetch_one(db)
    .await?;
    let now = now();
    if total > 0 && open == 0 && checklist["status"] != "completed" {
        sqlx::query(
            "update hr_checklists set status = 'completed', completed_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(checklist_id)
        .bind(&now)
        .execute(db)
        .await?;
        outcome.checklist_completed = true;
        let employee = require_employee(db, &outcome.employee_id).await?;
        if outcome.kind == "onboarding" && employee["status"] == "onboarding" {
            sqlx::query("update hr_employees set status = 'active', updated_at = $2::timestamp where id = $1")
                .bind(&outcome.employee_id)
                .bind(&now)
                .execute(db)
                .await?;
            outcome.employee_status = Some("active");
        }
        if outcome.kind == "offboarding" {
            let end_date = employee["endDate"]
                .as_str()
                .or_else(|| checklist["anchorDate"].as_str())
                .map_or_else(today_iso, str::to_owned);
            sqlx::query(
                "update hr_employees set status = 'terminated', end_date = $2::date, updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&outcome.employee_id)
            .bind(&end_date)
            .bind(&now)
            .execute(db)
            .await?;
            end_assignments_for(db, &outcome.employee_id, &end_date).await?;
            outcome.employee_status = Some("terminated");
        }
    } else if open > 0 && checklist["status"] == "completed" {
        sqlx::query(
            "update hr_checklists set status = 'in_progress', completed_at = null, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(checklist_id)
        .bind(&now)
        .execute(db)
        .await?;
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
    let row: Value = sqlx::query_scalar(
        "update hr_checklists set status = 'cancelled', updated_at = $2::timestamp where id = $1
         returning to_jsonb(hr_checklists)",
    )
    .bind(&id)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    restore_status_after_offboarding(&caller.db, &existing).await?;
    let row = js_row(row);
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
    sqlx::query("delete from hr_checklist_tasks where checklist_id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    sqlx::query("delete from hr_checklists where id = $1")
        .bind(&id)
        .execute(&caller.db)
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
    let max: i64 = sqlx::query_scalar(
        "select coalesce(max(sort_order), -1)::bigint from hr_checklist_tasks where checklist_id = $1",
    )
    .bind(&checklist_id)
    .fetch_one(db)
    .await?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_checklist_tasks
             (id, checklist_id, employee_id, title, description, assignee_role, assignee_user_id,
              due_date, visible_to_employee, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
         returning to_jsonb(hr_checklist_tasks)",
    )
    .bind(generate_id("hrtsk"))
    .bind(&checklist_id)
    .bind(text(&checklist, "employeeId"))
    .bind(input.title.as_set())
    .bind(input.description.as_set())
    .bind(input.assignee_role.as_set().map_or("hr", String::as_str))
    .bind(input.assignee_user_id.as_set())
    .bind(input.due_date.as_set())
    .bind(input.visible.as_set().copied().unwrap_or(false))
    .bind(i32::try_from(max + 1).unwrap_or(i32::MAX))
    .fetch_one(db)
    .await?;
    if checklist["status"] == "completed" {
        sqlx::query(
            "update hr_checklists set status = 'in_progress', completed_at = null, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&checklist_id)
        .bind(now())
        .execute(db)
        .await?;
    }
    let task = js_row(row);
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
    let now = now();
    // `completed: true` stamps a task not done yet; `false` clears the stamp.
    let (set_completed, completed_at, completed_by) = match input.completed {
        Some(true) if task["completedAt"].is_null() => {
            (true, Some(now.clone()), Some(actor_id.to_owned()))
        }
        Some(false) => (true, None, None),
        _ => (false, None, None),
    };
    let (set_title, title) = change(&input.title);
    let (set_description, description) = change(&input.description);
    let (set_role, role) = change(&input.assignee_role);
    let (set_assignee, assignee) = change(&input.assignee_user_id);
    let (set_due, due) = change(&input.due_date);
    let (set_visible, visible) = change(&input.visible);
    let row: Value = sqlx::query_scalar(
        "update hr_checklist_tasks set
             title = case when $2 then $3 else title end,
             description = case when $4 then $5 else description end,
             assignee_role = case when $6 then $7 else assignee_role end,
             assignee_user_id = case when $8 then $9 else assignee_user_id end,
             due_date = case when $10 then $11::date else due_date end,
             visible_to_employee = case when $12 then $13 else visible_to_employee end,
             completed_at = case when $14 then $15::timestamp else completed_at end,
             completed_by = case when $14 then $16 else completed_by end,
             updated_at = $17::timestamp
         where id = $1 returning to_jsonb(hr_checklist_tasks)",
    )
    .bind(task_id)
    .bind(set_title)
    .bind(title)
    .bind(set_description)
    .bind(description)
    .bind(set_role)
    .bind(role)
    .bind(set_assignee)
    .bind(assignee)
    .bind(set_due)
    .bind(due)
    .bind(set_visible)
    .bind(visible)
    .bind(set_completed)
    .bind(completed_at)
    .bind(completed_by)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let outcome = settle_checklist(db, text(&task, "checklistId")).await?;
    Ok((js_row(row), outcome))
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
    sqlx::query("delete from hr_checklist_tasks where id = $1")
        .bind(&task_id)
        .execute(&caller.db)
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
    let existing: Option<String> = sqlx::query_scalar(
        "select id from hr_checklist_templates where deleted_at is null limit 1",
    )
    .fetch_optional(db)
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
    sqlx::query(
        "insert into hr_checklist_templates (id, name, kind, is_default, items)
         values ('hrctp_default_onboarding', 'Standard onboarding', 'onboarding', true, $1),
                ('hrctp_default_offboarding', 'Standard offboarding', 'offboarding', true, $2)
         on conflict do nothing",
    )
    .bind(onboarding)
    .bind(offboarding)
    .execute(db)
    .await?;
    Ok(())
}
