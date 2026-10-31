//! Employees, departments and the org chart (`routes/weldhr/employees.ts`,
//! `services/weldhr/employees.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{HrError, HrState, company_names, today_iso};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}

/// A text field of a row, `""` when missing or null.
fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// `displayNameOf(e)`: the preferred name (trimmed) or the first name, then
/// the last name, trimmed.
pub(crate) fn display_name_of(row: &Value) -> String {
    let preferred = row["preferredName"]
        .as_str()
        .map(str::trim)
        .unwrap_or_default();
    let first = if preferred.is_empty() {
        text(row, "firstName")
    } else {
        preferred
    };
    format!("{first} {}", text(row, "lastName"))
        .trim()
        .to_owned()
}

/// `toPublicEmployee(row)`: the row without `sensitiveEncrypted`, with
/// `hasSensitive` and `displayName`.
pub(crate) fn to_public_employee(row: &Value) -> Value {
    let mut out = row.clone();
    let has_sensitive = match out
        .as_object_mut()
        .and_then(|map| map.remove("sensitiveEncrypted"))
    {
        Some(Value::String(sealed)) => !sealed.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    };
    let display_name = display_name_of(row);
    if let Some(map) = out.as_object_mut() {
        map.insert("hasSensitive".to_owned(), Value::Bool(has_sensitive));
        map.insert("displayName".to_owned(), Value::String(display_name));
    }
    out
}

/// `requireEmployee(db, id)`: the live employee row, or `Employee` 404.
pub(crate) async fn require_employee(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_employees t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Employee", id))
}

/// `existingEmployeeIds(db, ids)`: the live employees among `ids`.
pub(crate) async fn existing_employee_ids(
    db: &PgPool,
    ids: &[String],
) -> Result<HashSet<String>, HrError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> =
        sqlx::query_scalar("select id from hr_employees where id = any($1) and deleted_at is null")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// `activeClientsFor(db, employeeIds, on = todayIso())`: each employee's
/// assignments running on `on`, `{ companyId, companyName, isPrimary }`,
/// primary first (a stable sort, as `Array#sort`).
pub(crate) async fn active_clients_for(
    db: &PgPool,
    employee_ids: &[String],
    on: Option<&str>,
) -> Result<HashMap<String, Vec<Value>>, HrError> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let on = on.map_or_else(today_iso, str::to_owned);
    let rows: Vec<(String, String, bool)> = sqlx::query_as(
        "select employee_id, company_id, is_primary from hr_client_assignments
         where employee_id = any($1) and start_date <= $2::date
           and (end_date is null or end_date >= $2::date)",
    )
    .bind(employee_ids)
    .bind(&on)
    .fetch_all(db)
    .await?;
    let company_ids: Vec<Option<&str>> = rows.iter().map(|row| Some(row.1.as_str())).collect();
    let names = company_names(db, &company_ids).await?;
    for (employee_id, company_id, is_primary) in &rows {
        out.entry(employee_id.clone()).or_default().push(json!({
            "companyId": company_id,
            "companyName": names.get(company_id),
            "isPrimary": is_primary,
        }));
    }
    for list in out.values_mut() {
        list.sort_by_key(|client| client["isPrimary"] != true);
    }
    Ok(out)
}

/// `employeeForUser(db, userId)`: the caller's own employee, or `None` when
/// none is linked, it is deleted or terminated.
pub(crate) async fn employee_for_user(
    db: &PgPool,
    user_id: &str,
) -> Result<Option<Value>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_employees t where t.user_id = $1 and t.deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row).filter(|row| row["status"] != "terminated"))
}
