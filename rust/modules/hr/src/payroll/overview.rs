//! The payroll landing page (`services/weldhr/payroll/overview.ts`):
//! employers and their issues, whether setup is complete, the next period
//! of each schedule, recent runs and filings due.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{Keyring, PgPool, orm};
use weldsuite_schema::tenant::hr_pay_runs;

use super::employees::list_payroll_employees;
use super::employers::{list_employers, list_schedules};
use super::filings::filings_due_soon;
use super::runs::{s, to_run_dtos};
use crate::HrError;
use crate::employees::to_json;
use crate::entity_scope::Scope;

/// `payrollOverview(db, keyring, { today, digipoortAvailable, employerEntity,
/// employeeEntity })`: `scope` is the request's entity scope, on the
/// employers and on the employees.
pub(crate) async fn payroll_overview(
    db: &PgPool,
    keyring: &Keyring,
    today: &str,
    scope: &Scope,
) -> Result<Value, HrError> {
    let employers: Vec<Value> = list_employers(db, keyring, scope)
        .await?
        .into_iter()
        .filter(|e| e["isActive"] == true)
        .collect();
    let schedules: Vec<Value> = list_schedules(db, None, scope)
        .await?
        .into_iter()
        .filter(|x| x["isActive"] == true && employers.iter().any(|e| e["id"] == x["employerId"]))
        .collect();
    let on_payroll = list_payroll_employees(db, None, Some(true), scope, keyring, today).await?;
    let schedule_ids: Vec<&str> = schedules.iter().map(|x| s(x, "id")).collect();
    let live_runs: Vec<(String, Option<String>, String, String)> = if schedule_ids.is_empty() {
        vec![]
    } else {
        hr_pay_runs::Entity::find()
            .select_only()
            .column(hr_pay_runs::Column::Id)
            .column(hr_pay_runs::Column::PayScheduleId)
            .column_as(
                sea_orm::ExprTrait::cast_as(Expr::col(hr_pay_runs::Column::PeriodStart), "text"),
                "period_start",
            )
            .column(hr_pay_runs::Column::Status)
            .filter(hr_pay_runs::Column::PayScheduleId.is_in(schedule_ids.iter().copied()))
            .filter(hr_pay_runs::Column::Kind.eq("regular"))
            .filter(hr_pay_runs::Column::Status.ne("cancelled"))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let mut upcoming: Vec<Value> = vec![];
    for schedule in &schedules {
        let next = &schedule["nextPeriod"];
        if next.is_null() {
            continue;
        }
        let Some(employer) = employers.iter().find(|e| e["id"] == schedule["employerId"]) else {
            continue;
        };
        let run = live_runs.iter().find(|(_, sid, start, _)| {
            sid.as_deref() == Some(s(schedule, "id")) && start.as_str() == s(next, "start")
        });
        upcoming.push(json!({
            "scheduleId": schedule["id"], "scheduleName": schedule["name"], "employerId": employer["id"],
            "employerName": employer["name"], "country": employer["country"], "period": next,
            "runId": run.map(|r| r.0.clone()), "runStatus": run.map(|r| r.3.clone()),
        }));
    }
    upcoming.sort_by(|a, b| s(&a["period"], "payDate").cmp(s(&b["period"], "payDate")));
    let recent: Vec<Value> = hr_pay_runs::Entity::find()
        .filter(hr_pay_runs::Column::Status.ne("cancelled"))
        .filter(scope.employer_id_in(hr_pay_runs::Column::EmployerId))
        .order_by_desc(hr_pay_runs::Column::PeriodStart)
        .order_by_desc(hr_pay_runs::Column::CreatedAt)
        .limit(6)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(to_json)
        .collect::<Result<_, _>>()?;
    let not_ready = on_payroll
        .iter()
        .filter(|e| {
            e["issues"]
                .as_array()
                .is_some_and(|i| i.iter().any(|x| x["severity"] == "error"))
        })
        .count();
    Ok(json!({
        "employers": employers.iter().map(|e| json!({
            "id": e["id"], "name": e["name"], "country": e["country"], "employeeCount": e["employeeCount"], "issues": e["issues"],
        })).collect::<Vec<_>>(),
        "setup": {
            "hasEmployer": !employers.is_empty(),
            "hasSchedule": !schedules.is_empty(),
            "employeesOnPayroll": on_payroll.len(),
            "employeesNotReady": not_ready,
        },
        "upcoming": upcoming,
        "recentRuns": to_run_dtos(db, &recent).await?,
        "filingsDue": filings_due_soon(db, today, scope).await?,
    }))
}
