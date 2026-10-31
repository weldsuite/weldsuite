//! Shifts, attendance, leave types, allowances and requests
//! (`routes/weldhr/time.ts`, `services/weldhr/time.ts`).

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::employees::display_name_of;
use crate::{HrError, HrState};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}

/// `ensureDefaultLeaveTypes(db)`: annual, sick and unpaid leave.
pub(crate) async fn ensure_default_leave_types(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_leave_types limit 1")
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    sqlx::query(
        "insert into hr_leave_types (id, name, color, is_paid, requires_approval, default_allowance_days) values
             ('hrlvt_default_annual', 'Annual leave', '#3b82f6', true, true, 20),
             ('hrlvt_default_sick', 'Sick leave', '#ef4444', true, false, null),
             ('hrlvt_default_unpaid', 'Unpaid leave', '#6b7280', false, true, null)
         on conflict do nothing",
    )
    .execute(db)
    .await?;
    Ok(())
}

/// `onLeaveOn(db, date)`: who is on approved leave that day.
pub(crate) async fn on_leave_on(db: &PgPool, date: &str) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('employeeId', lr.employee_id, 'firstName', e.first_name,
             'lastName', e.last_name, 'preferredName', e.preferred_name,
             'leaveTypeName', lt.name, 'endDate', lr.end_date)
         from hr_leave_requests lr
         join hr_employees e on e.id = lr.employee_id
         left join hr_leave_types lt on lt.id = lr.leave_type_id
         where lr.status = 'approved' and lr.start_date <= $1::date and lr.end_date >= $1::date
           and e.deleted_at is null and e.status <> 'terminated'",
    )
    .bind(date)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "employeeId": row["employeeId"],
                "employeeName": display_name_of(row),
                "leaveTypeName": row["leaveTypeName"],
                "endDate": row["endDate"],
            })
        })
        .collect())
}
