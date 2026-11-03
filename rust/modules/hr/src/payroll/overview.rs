//! The payroll landing page (`services/weldhr/payroll/overview.ts`):
//! employers and their issues, whether setup is complete, the next period
//! of each schedule, recent runs and filings due.

use serde_json::{Value, json};
use weldsuite_db::{Keyring, PgPool, js_row};

use super::employees::list_payroll_employees;
use super::employers::{list_employers, list_schedules};
use super::filings::filings_due_soon;
use super::runs::{s, to_run_dtos};
use crate::HrError;

/// `payrollOverview(db, keyring, { today, digipoortAvailable })`.
pub(crate) async fn payroll_overview(
    db: &PgPool,
    keyring: &Keyring,
    today: &str,
) -> Result<Value, HrError> {
    let employers: Vec<Value> = list_employers(db, keyring)
        .await?
        .into_iter()
        .filter(|e| e["isActive"] == true)
        .collect();
    let schedules: Vec<Value> = list_schedules(db, None)
        .await?
        .into_iter()
        .filter(|x| x["isActive"] == true && employers.iter().any(|e| e["id"] == x["employerId"]))
        .collect();
    let on_payroll = list_payroll_employees(db, None, Some(true), keyring, today).await?;
    let schedule_ids: Vec<&str> = schedules.iter().map(|x| s(x, "id")).collect();
    let live_runs: Vec<(String, Option<String>, String, String)> = if schedule_ids.is_empty() {
        vec![]
    } else {
        sqlx::query_as(
            "select id, pay_schedule_id, period_start::text, status from hr_pay_runs
             where pay_schedule_id = any($1) and kind = 'regular' and status <> 'cancelled'",
        )
        .bind(&schedule_ids)
        .fetch_all(db)
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
    let recent: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_pay_runs t where t.status <> 'cancelled' order by t.period_start desc, t.created_at desc limit 6",
    )
    .fetch_all(db)
    .await?;
    let recent: Vec<Value> = recent.into_iter().map(js_row).collect();
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
        "filingsDue": filings_due_soon(db, today).await?,
    }))
}
