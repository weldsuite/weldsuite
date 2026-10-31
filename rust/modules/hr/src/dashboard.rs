//! The HR dashboard (`GET /dashboard`, `services/weldhr/dashboard.ts`).

use std::sync::Arc;

use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{
    ATTENDANCE_READ, COACHING_READ, EMPLOYEES_READ, EVALUATIONS_READ, LEAVE_READ,
};
use weldsuite_db::PgPool;
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::assignments::list_client_accounts;
use crate::employees::display_name_of;
use crate::timekeeping::on_leave_on;
use crate::{Caller, HrError, HrResult, HrState, add_days, js_number, js_round, today_iso};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/dashboard",
        get(dashboard).route_layer(gate.require([
            EMPLOYEES_READ,
            ATTENDANCE_READ,
            LEAVE_READ,
            COACHING_READ,
            EVALUATIONS_READ,
        ])),
    )
}

async fn dashboard(caller: Caller) -> HrResult {
    Ok(Data(hr_dashboard(&caller.db).await?).into_response())
}

/// `hrDashboard(db)`.
async fn hr_dashboard(db: &PgPool) -> Result<Value, HrError> {
    let today = today_iso();
    let status_counts: Vec<(String, i64)> = sqlx::query_as(
        "select status, count(*) from hr_employees where deleted_at is null group by status",
    )
    .fetch_all(db)
    .await?;
    let attendance: Vec<(String, i64, i64)> = sqlx::query_as(
        "select status, count(*), count(*) filter (where clock_in is not null and clock_out is null)
         from hr_attendance_records where date = $1::date group by status",
    )
    .bind(&today)
    .fetch_all(db)
    .await?;
    let (open_tasks, overdue_tasks): (i64, i64) = sqlx::query_as(
        "select count(*), count(*) filter (where t.due_date < $1::date)
         from hr_checklist_tasks t join hr_checklists c on c.id = t.checklist_id
         where t.completed_at is null and c.status = 'in_progress'",
    )
    .bind(&today)
    .fetch_one(db)
    .await?;
    let pending_leave: i64 =
        sqlx::query_scalar("select count(*) from hr_leave_requests where status = 'pending'")
            .fetch_one(db)
            .await?;
    let follow_ups: i64 = sqlx::query_scalar(
        "select count(*) from hr_coaching_logs
         where deleted_at is null and status <> 'closed' and follow_up_date <= $1::date",
    )
    .bind(&today)
    .fetch_one(db)
    .await?;
    let recent: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', ev.id, 'employeeId', ev.employee_id,
             'overallScore', ev.overall_score, 'status', ev.status, 'submittedAt', ev.submitted_at,
             'firstName', e.first_name, 'lastName', e.last_name, 'preferredName', e.preferred_name)
         from hr_evaluations ev join hr_employees e on e.id = ev.employee_id
         where ev.deleted_at is null and e.deleted_at is null
           and ev.status in ('submitted', 'acknowledged')
         order by ev.submitted_at desc
         limit 5",
    )
    .fetch_all(db)
    .await?;
    let since = format!("{}T00:00:00.000Z", add_days(&today, -90));
    let average: Option<f64> = sqlx::query_scalar(
        "select avg(overall_score)::float8 from hr_evaluations
         where deleted_at is null and status in ('submitted', 'acknowledged')
           and submitted_at >= $1::timestamptz",
    )
    .bind(&since)
    .fetch_one(db)
    .await?;
    let upcoming: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'firstName', first_name, 'lastName', last_name,
             'preferredName', preferred_name, 'jobTitle', job_title, 'startDate', start_date,
             'status', status)
         from hr_employees
         where deleted_at is null and start_date >= $1::date and start_date <= $2::date
         order by start_date
         limit 10",
    )
    .bind(&today)
    .bind(add_days(&today, 30))
    .fetch_all(db)
    .await?;
    let on_leave = on_leave_on(db, &today).await?;
    let clients = list_client_accounts(db).await?;

    let mut by_status = Map::new();
    let mut total = 0;
    for (status, count) in &status_counts {
        by_status.insert(status.clone(), json!(count));
        if status != "terminated" {
            total += count;
        }
    }
    let mut attendance_by_status = Map::new();
    let mut clocked_in = 0;
    for (status, count, open) in &attendance {
        attendance_by_status.insert(status.clone(), json!(count));
        clocked_in += open;
    }
    let upcoming: Vec<Value> = upcoming
        .into_iter()
        .map(|mut row| {
            let name = display_name_of(&row);
            if let Some(map) = row.as_object_mut() {
                map.insert("displayName".to_owned(), Value::String(name));
            }
            row
        })
        .collect();
    let recent: Vec<Value> = recent
        .into_iter()
        .map(|row| {
            json!({
                "id": row["id"],
                "employeeId": row["employeeId"],
                "employeeName": display_name_of(&row),
                "overallScore": row["overallScore"],
                "status": row["status"],
                "submittedAt": row["submittedAt"].as_str().and_then(weldsuite_db::js_timestamp),
            })
        })
        .collect();
    let clients: Vec<Value> = clients
        .into_iter()
        .filter(|client| client["activeCount"].as_i64().unwrap_or(0) > 0)
        .collect();
    Ok(json!({
        "headcount": { "total": total, "byStatus": by_status },
        "today": {
            "date": today,
            "clockedIn": clocked_in,
            "byStatus": attendance_by_status,
            "onLeave": on_leave,
        },
        "lifecycle": {
            "openTasks": open_tasks,
            "overdueTasks": overdue_tasks,
            "upcomingStarts": upcoming,
        },
        "pendingLeaveRequests": pending_leave,
        "coachingFollowUpsDue": follow_ups,
        "evaluations": {
            "averageScore90d": average.map(|a| js_number(js_round(a * 10.0) / 10.0)),
            "recent": recent,
        },
        "clients": clients,
    }))
}
