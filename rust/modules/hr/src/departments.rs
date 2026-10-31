//! Departments (`routes/weldhr/employees.ts` departments, and their part of
//! `services/weldhr/employees.ts`). Configuration: no entity events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::require_employee;
use crate::fields::{Fields, change, color, id, short_text, text_max};
use crate::{Caller, HrError, HrResult, HrState, hr_json, js_trim, now, text};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    Router::new()
        .route("/departments", get(list).route_layer(gate.require([EMPLOYEES_READ])))
        .route("/departments", post(create).route_layer(manage()))
        .route("/departments/{id}", patch(update).route_layer(manage()))
        .route("/departments/{id}", delete(remove).route_layer(manage()))
}

async fn list(caller: Caller) -> HrResult {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from hr_departments d where d.deleted_at is null order by d.name asc",
    )
    .fetch_all(&caller.db)
    .await?;
    let counts: Vec<(Option<String>, i64)> = sqlx::query_as(
        "select department_id, count(*) from hr_employees
         where deleted_at is null and status <> 'terminated' group by department_id",
    )
    .fetch_all(&caller.db)
    .await?;
    let by_department: HashMap<Option<String>, i64> = counts.into_iter().collect();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let mut row = js_row(row);
            let count = by_department
                .get(&Some(text(&row, "id").to_owned()))
                .copied()
                .unwrap_or(0);
            if let Some(map) = row.as_object_mut() {
                map.insert("employeeCount".to_owned(), json!(count));
            }
            row
        })
        .collect();
    Ok(Data(rows).into_response())
}

/// `requireDepartment(db, id)`.
pub(crate) async fn require_department(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from hr_departments d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Department", id))
}

/// `assertUniqueDepartmentName(db, name, exceptId?)`.
async fn assert_unique_name(db: &PgPool, name: &str, except_id: Option<&str>) -> Result<(), HrError> {
    let clash: Option<String> = sqlx::query_scalar(
        "select id from hr_departments where deleted_at is null and lower(name) = $1
           and ($2::text is null or id <> $2) limit 1",
    )
    .bind(js_trim(name).to_lowercase())
    .bind(except_id)
    .fetch_optional(db)
    .await?;
    if clash.is_some() {
        return Err(HrError::conflict(format!(
            "A department called \"{}\" already exists",
            js_trim(name)
        )));
    }
    Ok(())
}

/// The live tree as `(id, parentId)`.
pub(crate) async fn live_tree(db: &PgPool) -> Result<Vec<(String, Option<String>)>, HrError> {
    Ok(sqlx::query_as("select id, parent_id from hr_departments where deleted_at is null")
        .fetch_all(db)
        .await?)
}

/// `departmentAndDescendants(departments, rootId)`.
pub(crate) fn department_and_descendants(
    departments: &[(String, Option<String>)],
    root_id: &str,
) -> HashSet<String> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, parent) in departments {
        if let Some(parent) = parent.as_deref().filter(|p| !p.is_empty()) {
            children.entry(parent).or_default().push(id);
        }
    }
    let mut out: HashSet<String> = HashSet::from([root_id.to_owned()]);
    let mut queue: VecDeque<String> = VecDeque::from([root_id.to_owned()]);
    while let Some(next) = queue.pop_front() {
        for child in children.get(next.as_str()).cloned().unwrap_or_default() {
            if out.insert(child.to_owned()) {
                queue.push_back(child.to_owned());
            }
        }
    }
    out
}

/// `departmentLineage(db, departmentId)`: the department and every one above it.
pub(crate) async fn department_lineage(db: &PgPool, department_id: Option<&str>) -> Result<HashSet<String>, HrError> {
    let mut out = HashSet::new();
    let Some(department_id) = department_id.filter(|id| !id.is_empty()) else {
        return Ok(out);
    };
    let parent_of: HashMap<String, Option<String>> = live_tree(db).await?.into_iter().collect();
    let mut cursor = Some(department_id.to_owned());
    while let Some(current) = cursor {
        if out.contains(&current) || out.len() >= 100 {
            break;
        }
        out.insert(current.clone());
        cursor = parent_of.get(&current).cloned().flatten().filter(|p| !p.is_empty());
    }
    Ok(out)
}

/// `employeesInDepartments(db, departmentIds)`: active employees in any of
/// them or below; every active employee for an empty list.
pub(crate) async fn employees_in_departments(db: &PgPool, department_ids: &[String]) -> Result<Vec<Value>, HrError> {
    let reach: Option<Vec<String>> = if department_ids.is_empty() {
        None
    } else {
        let tree = live_tree(db).await?;
        let mut reach: Vec<String> = Vec::new();
        for root in department_ids {
            for id in department_and_descendants(&tree, root) {
                if !reach.contains(&id) {
                    reach.push(id);
                }
            }
        }
        Some(reach)
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'userId', user_id, 'firstName', first_name,
             'lastName', last_name, 'preferredName', preferred_name)
         from hr_employees
         where deleted_at is null and status <> 'terminated'
           and ($1::text[] is null or department_id = any($1))",
    )
    .bind(reach)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

struct DepartmentInput {
    name: Field<String>,
    description: Field<String>,
    parent_id: Field<String>,
    head_employee_id: Field<String>,
    color: Field<String>,
}

fn department_input(issues: &mut Issues, fields: &Fields, partial: bool) -> DepartmentInput {
    DepartmentInput {
        name: short_text(
            issues,
            fields,
            "name",
            if partial {
                Presence::Optional
            } else {
                Presence::Required
            },
            120,
            true,
        ),
        description: text_max(issues, fields, "description", Presence::Nullish, 2000),
        parent_id: id(issues, fields, "parentId", Presence::Nullish),
        head_employee_id: id(issues, fields, "headEmployeeId", Presence::Nullish),
        color: color(issues, fields, "color"),
    }
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| department_input(issues, fields, false))?;
    let db = &caller.db;
    let name = input.name.as_set().cloned().unwrap_or_default();
    assert_unique_name(db, &name, None).await?;
    if let Some(parent) = input.parent_id.as_set() {
        require_department(db, parent).await?;
    }
    if let Some(head) = input.head_employee_id.as_set() {
        require_employee(db, head).await?;
    }
    let row: Value = sqlx::query_scalar(
        "insert into hr_departments (id, name, description, parent_id, head_employee_id, color)
         values ($1, $2, $3, $4, $5, $6) returning to_jsonb(hr_departments)",
    )
    .bind(generate_id("hrdep"))
    .bind(&name)
    .bind(input.description.as_set())
    .bind(input.parent_id.as_set())
    .bind(input.head_employee_id.as_set())
    .bind(input.color.as_set())
    .fetch_one(db)
    .await?;
    Ok(Created(js_row(row)).into_response())
}

async fn update(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| department_input(issues, fields, true))?;
    let db = &caller.db;
    require_department(db, &id).await?;
    if let Some(name) = input.name.as_set() {
        assert_unique_name(db, name, Some(&id)).await?;
    }
    if input.parent_id.as_set() == Some(&id) {
        return Err(HrError::validation("A department cannot be its own parent"));
    }
    if let Some(parent) = input.parent_id.as_set() {
        require_department(db, parent).await?;
        let tree = live_tree(db).await?;
        if department_and_descendants(&tree, &id).contains(parent) {
            return Err(HrError::validation(
                "A department cannot be moved under one of its own sub-departments",
            ));
        }
    }
    if let Some(head) = input.head_employee_id.as_set() {
        require_employee(db, head).await?;
    }
    let (set_name, name) = change(&input.name);
    let (set_description, description) = change(&input.description);
    let (set_parent, parent) = change(&input.parent_id);
    let (set_head, head) = change(&input.head_employee_id);
    let (set_color, color) = change(&input.color);
    let row: Value = sqlx::query_scalar(
        "update hr_departments set
             name = case when $2 then $3 else name end,
             description = case when $4 then $5 else description end,
             parent_id = case when $6 then $7 else parent_id end,
             head_employee_id = case when $8 then $9 else head_employee_id end,
             color = case when $10 then $11 else color end,
             updated_at = $12::timestamp
         where id = $1 returning to_jsonb(hr_departments)",
    )
    .bind(&id)
    .bind(set_name)
    .bind(name)
    .bind(set_description)
    .bind(description)
    .bind(set_parent)
    .bind(parent)
    .bind(set_head)
    .bind(head)
    .bind(set_color)
    .bind(color)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn remove(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let department = require_department(db, &id).await?;
    let now = now();
    sqlx::query("update hr_departments set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(&now)
        .execute(db)
        .await?;
    sqlx::query("update hr_employees set department_id = null, updated_at = $2::timestamp where department_id = $1")
        .bind(&id)
        .bind(&now)
        .execute(db)
        .await?;
    sqlx::query("update hr_departments set parent_id = $2, updated_at = $3::timestamp where parent_id = $1")
        .bind(&id)
        .bind(department["parentId"].as_str())
        .bind(&now)
        .execute(db)
        .await?;
    Ok(NoContent.into_response())
}
