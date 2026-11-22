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
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{EMPLOYEES_MANAGE, EMPLOYEES_READ};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{hr_departments, hr_employees};

use crate::employees::{no_row, require_employee, to_json};
use crate::fields::{Fields, change, color, id, short_text, text_max};
use crate::{Caller, HrError, HrResult, HrState, hr_json, js_trim, text};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    Router::new()
        .route(
            "/departments",
            get(list).route_layer(gate.require([EMPLOYEES_READ])),
        )
        .route("/departments", post(create).route_layer(manage()))
        .route("/departments/{id}", patch(update).route_layer(manage()))
        .route("/departments/{id}", delete(remove).route_layer(manage()))
}

async fn list(caller: Caller) -> HrResult {
    let db = &orm(&caller.db);
    let rows = hr_departments::Entity::find()
        .filter(hr_departments::Column::DeletedAt.is_null())
        .order_by_asc(hr_departments::Column::Name)
        .all(db)
        .await?;
    let counts: Vec<(Option<String>, i64)> = hr_employees::Entity::find()
        .select_only()
        .column(hr_employees::Column::DepartmentId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(hr_employees::Column::Status.ne("terminated"))
        .group_by(hr_employees::Column::DepartmentId)
        .into_tuple()
        .all(db)
        .await?;
    let by_department: HashMap<Option<String>, i64> = counts.into_iter().collect();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let mut row = to_json(row)?;
            let count = by_department
                .get(&Some(text(&row, "id").to_owned()))
                .copied()
                .unwrap_or(0);
            if let Some(map) = row.as_object_mut() {
                map.insert("employeeCount".to_owned(), json!(count));
            }
            Ok(row)
        })
        .collect::<Result<_, HrError>>()?;
    Ok(Data(rows).into_response())
}

/// `requireDepartment(db, id)`.
pub(crate) async fn require_department(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = hr_departments::Entity::find()
        .filter(hr_departments::Column::Id.eq(id))
        .filter(hr_departments::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Department", id))?)
}

/// `assertUniqueDepartmentName(db, name, exceptId?)`.
async fn assert_unique_name(
    db: &PgPool,
    name: &str,
    except_id: Option<&str>,
) -> Result<(), HrError> {
    let mut clash = hr_departments::Entity::find()
        .select_only()
        .column(hr_departments::Column::Id)
        .filter(hr_departments::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(
            Func::lower(Expr::col(hr_departments::Column::Name)),
            js_trim(name).to_lowercase(),
        ));
    if let Some(except_id) = except_id {
        clash = clash.filter(hr_departments::Column::Id.ne(except_id));
    }
    let clash: Option<String> = clash.into_tuple().one(&orm(db)).await?;
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
    Ok(hr_departments::Entity::find()
        .select_only()
        .columns([hr_departments::Column::Id, hr_departments::Column::ParentId])
        .filter(hr_departments::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
pub(crate) async fn department_lineage(
    db: &PgPool,
    department_id: Option<&str>,
) -> Result<HashSet<String>, HrError> {
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
        cursor = parent_of
            .get(&current)
            .cloned()
            .flatten()
            .filter(|p| !p.is_empty());
    }
    Ok(out)
}

/// `employeesInDepartments(db, departmentIds)`: active employees in any of
/// them or below; every active employee for an empty list.
pub(crate) async fn employees_in_departments(
    db: &PgPool,
    department_ids: &[String],
) -> Result<Vec<Value>, HrError> {
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
    let mut rows = hr_employees::Entity::find()
        .select_only()
        .columns([
            hr_employees::Column::Id,
            hr_employees::Column::UserId,
            hr_employees::Column::FirstName,
            hr_employees::Column::LastName,
            hr_employees::Column::PreferredName,
        ])
        .filter(hr_employees::Column::DeletedAt.is_null())
        .filter(hr_employees::Column::Status.ne("terminated"));
    if let Some(reach) = &reach {
        rows = rows.filter(hr_employees::Column::DepartmentId.is_in(reach.iter().map(String::as_str)));
    }
    let rows: Vec<(String, Option<String>, String, String, Option<String>)> =
        rows.into_tuple().all(&orm(db)).await?;
    Ok(rows
        .into_iter()
        .map(|(id, user_id, first_name, last_name, preferred_name)| {
            json!({
                "id": id,
                "userId": user_id,
                "firstName": first_name,
                "lastName": last_name,
                "preferredName": preferred_name,
            })
        })
        .collect())
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
    let input = hr_json(&headers, &body, |issues, fields| {
        department_input(issues, fields, false)
    })?;
    let db = &caller.db;
    let name = input.name.as_set().cloned().unwrap_or_default();
    assert_unique_name(db, &name, None).await?;
    if let Some(parent) = input.parent_id.as_set() {
        require_department(db, parent).await?;
    }
    if let Some(head) = input.head_employee_id.as_set() {
        require_employee(db, head).await?;
    }
    let row = hr_departments::Entity::insert(hr_departments::ActiveModel {
        id: Set(generate_id("hrdep")),
        name: Set(name),
        description: Set(input.description.as_set().cloned()),
        parent_id: Set(input.parent_id.as_set().cloned()),
        head_employee_id: Set(input.head_employee_id.as_set().cloned()),
        color: Set(input.color.as_set().cloned()),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(Created(to_json(row)?).into_response())
}

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        department_input(issues, fields, true)
    })?;
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
    let mut update = hr_departments::Entity::update_many();
    for (column, field) in [
        (hr_departments::Column::Name, &input.name),
        (hr_departments::Column::Description, &input.description),
        (hr_departments::Column::ParentId, &input.parent_id),
        (hr_departments::Column::HeadEmployeeId, &input.head_employee_id),
        (hr_departments::Column::Color, &input.color),
    ] {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    let row = update
        .col_expr(hr_departments::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(hr_departments::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_departments"))?;
    Ok(Data(to_json(row)?).into_response())
}

async fn remove(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let department = require_department(db, &id).await?;
    let now = utc_now();
    let db = &orm(db);
    hr_departments::Entity::update_many()
        .col_expr(hr_departments::Column::DeletedAt, Expr::value(now))
        .col_expr(hr_departments::Column::UpdatedAt, Expr::value(now))
        .filter(hr_departments::Column::Id.eq(id.as_str()))
        .exec(db)
        .await?;
    hr_employees::Entity::update_many()
        .col_expr(
            hr_employees::Column::DepartmentId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(hr_employees::Column::UpdatedAt, Expr::value(now))
        .filter(hr_employees::Column::DepartmentId.eq(id.as_str()))
        .exec(db)
        .await?;
    hr_departments::Entity::update_many()
        .col_expr(
            hr_departments::Column::ParentId,
            Expr::value(department["parentId"].as_str().map(str::to_owned)),
        )
        .col_expr(hr_departments::Column::UpdatedAt, Expr::value(now))
        .filter(hr_departments::Column::ParentId.eq(id.as_str()))
        .exec(db)
        .await?;
    Ok(NoContent.into_response())
}
