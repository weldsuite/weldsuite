//! The HR dashboard (`GET /dashboard`, `services/weldhr/dashboard.ts`).

use std::sync::Arc;

use axum::Router;
use axum::response::IntoResponse;
use axum::routing::get;
use sea_orm::sea_query::{Asterisk, Expr, Func, IntoCondition};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::{Date, Duration, OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::permission_keys::{
    ATTENDANCE_READ, COACHING_READ, EMPLOYEES_READ, EVALUATIONS_READ, LEAVE_READ,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    hr_attendance_records as attendance, hr_checklist_tasks as tasks, hr_checklists as checklists,
    hr_coaching_logs as coaching, hr_employees as employees, hr_evaluations as evaluations,
    hr_leave_requests as leave,
};

use crate::assignments::list_client_accounts;
use crate::employees::{display_name, js_timestamp, to_json};
use crate::entity_scope::Scope;
use crate::shared::iso_date;
use crate::timekeeping::on_leave_on;
use crate::{Caller, HrError, HrResult, HrState, js_number, js_round};

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
    let scope = caller.scope().await?;
    Ok(Data(hr_dashboard(&caller.db, &scope).await?).into_response())
}

/// `count(*)`.
fn count_all() -> Expr {
    Expr::from(Func::count(Expr::col(Asterisk)))
}

/// `count(*) filter (where condition)`: the rows the case keeps (it is null
/// otherwise).
fn count_where(condition: impl IntoCondition) -> Expr {
    Expr::from(Func::count(Expr::case(condition, 1)))
}

/// An evaluation of the dashboard's recent list, with its employee's name.
#[derive(Debug, FromQueryResult)]
struct RecentEvaluation {
    id: String,
    employee_id: String,
    overall_score: Option<f64>,
    status: String,
    submitted_at: Option<PrimitiveDateTime>,
    first_name: String,
    last_name: String,
    preferred_name: Option<String>,
}

/// An employee starting soon (`jsonb_build_object` of these columns).
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpcomingStart {
    id: String,
    first_name: String,
    last_name: String,
    preferred_name: Option<String>,
    job_title: Option<String>,
    #[serde(with = "weldsuite_schema::js::date::option")]
    start_date: Option<Date>,
    status: String,
}

/// `hrDashboard(db, entity)`: `scope` is the request's entity scope on the
/// employees.
async fn hr_dashboard(pool: &PgPool, scope: &Scope) -> Result<Value, HrError> {
    let day = OffsetDateTime::now_utc().date();
    let today = iso_date(day);
    let db = &orm(pool);
    let status_counts: Vec<(String, i64)> = employees::Entity::find()
        .select_only()
        .column(employees::Column::Status)
        .column_as(count_all(), "count")
        .filter(employees::Column::DeletedAt.is_null())
        .filter(scope.condition(employees::Column::LegalEntityId))
        .group_by(employees::Column::Status)
        .into_tuple()
        .all(db)
        .await?;
    let attendance: Vec<(String, i64, i64)> = attendance::Entity::find()
        .select_only()
        .column(attendance::Column::Status)
        .column_as(count_all(), "count")
        .column_as(
            count_where(
                Condition::all()
                    .add(attendance::Column::ClockIn.is_not_null())
                    .add(attendance::Column::ClockOut.is_null()),
            ),
            "open",
        )
        .filter(attendance::Column::Date.eq(day))
        .filter(scope.employee_id_in(attendance::Column::EmployeeId))
        .group_by(attendance::Column::Status)
        .into_tuple()
        .all(db)
        .await?;
    let (open_tasks, overdue_tasks): (i64, i64) = tasks::Entity::find()
        .select_only()
        .column_as(count_all(), "open")
        .column_as(count_where(tasks::Column::DueDate.lt(day)), "overdue")
        .join(
            JoinType::InnerJoin,
            tasks::Entity::belongs_to(checklists::Entity)
                .from(tasks::Column::ChecklistId)
                .to(checklists::Column::Id)
                .into(),
        )
        .filter(tasks::Column::CompletedAt.is_null())
        .filter(checklists::Column::Status.eq("in_progress"))
        .filter(scope.employee_id_in(tasks::Column::EmployeeId))
        .into_tuple()
        .one(db)
        .await?
        .unwrap_or((0, 0));
    let pending_leave = leave::Entity::find()
        .filter(leave::Column::Status.eq("pending"))
        .filter(scope.employee_id_in(leave::Column::EmployeeId))
        .count(db)
        .await?;
    let follow_ups = coaching::Entity::find()
        .filter(coaching::Column::DeletedAt.is_null())
        .filter(coaching::Column::Status.ne("closed"))
        .filter(coaching::Column::FollowUpDate.lte(day))
        .filter(scope.employee_id_in(coaching::Column::EmployeeId))
        .count(db)
        .await?;
    let recent: Vec<RecentEvaluation> = evaluations::Entity::find()
        .select_only()
        .columns([
            evaluations::Column::Id,
            evaluations::Column::EmployeeId,
            evaluations::Column::OverallScore,
            evaluations::Column::Status,
            evaluations::Column::SubmittedAt,
        ])
        .column_as(employees::Column::FirstName, "first_name")
        .column_as(employees::Column::LastName, "last_name")
        .column_as(employees::Column::PreferredName, "preferred_name")
        .join(
            JoinType::InnerJoin,
            evaluations::Entity::belongs_to(employees::Entity)
                .from(evaluations::Column::EmployeeId)
                .to(employees::Column::Id)
                .into(),
        )
        .filter(evaluations::Column::DeletedAt.is_null())
        .filter(employees::Column::DeletedAt.is_null())
        .filter(evaluations::Column::Status.is_in(["submitted", "acknowledged"]))
        .filter(scope.condition(employees::Column::LegalEntityId))
        .order_by_desc(evaluations::Column::SubmittedAt)
        .limit(5)
        .into_model()
        .all(db)
        .await?;
    // `submitted_at >= '<90 days ago>T00:00:00.000Z'::timestamptz`.
    let since = (day - Duration::days(90)).midnight();
    let average: Option<f64> = evaluations::Entity::find()
        .select_only()
        .column_as(
            Expr::from(Func::cast_as(
                Func::avg(Expr::col(evaluations::Column::OverallScore)),
                "float8",
            )),
            "average",
        )
        .filter(evaluations::Column::DeletedAt.is_null())
        .filter(evaluations::Column::Status.is_in(["submitted", "acknowledged"]))
        .filter(evaluations::Column::SubmittedAt.gte(since))
        .filter(scope.employee_id_in(evaluations::Column::EmployeeId))
        .into_tuple()
        .one(db)
        .await?
        .flatten();
    let upcoming: Vec<UpcomingStart> = employees::Entity::find()
        .select_only()
        .columns([
            employees::Column::Id,
            employees::Column::FirstName,
            employees::Column::LastName,
            employees::Column::PreferredName,
            employees::Column::JobTitle,
            employees::Column::StartDate,
            employees::Column::Status,
        ])
        .filter(employees::Column::DeletedAt.is_null())
        .filter(employees::Column::StartDate.gte(day))
        .filter(employees::Column::StartDate.lte(day + Duration::days(30)))
        .filter(scope.condition(employees::Column::LegalEntityId))
        .order_by_asc(employees::Column::StartDate)
        .limit(10)
        .into_model()
        .all(db)
        .await?;
    let on_leave = on_leave_on(pool, &today, scope).await?;
    let clients = list_client_accounts(pool, scope).await?;

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
        .map(|row| {
            let name = display_name(
                &row.first_name,
                &row.last_name,
                row.preferred_name.as_deref(),
            );
            let mut row = to_json(row)?;
            if let Some(map) = row.as_object_mut() {
                map.insert("displayName".to_owned(), Value::String(name));
            }
            Ok(row)
        })
        .collect::<Result<_, HrError>>()?;
    let recent: Vec<Value> = recent
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "employeeId": row.employee_id,
                "employeeName": display_name(&row.first_name, &row.last_name, row.preferred_name.as_deref()),
                "overallScore": row.overall_score.map_or(Value::Null, js_number),
                "status": row.status,
                "submittedAt": js_timestamp(row.submitted_at),
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
