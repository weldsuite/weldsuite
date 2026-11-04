//! Queries of the status reports and the stakeholder register
//! (`services/status-reports.ts` and `services/stakeholders.ts`): the project
//! a report reads, the data a draft is computed from, who it goes to, and the
//! register with the people behind it. The rules are
//! `weldsuite_flow_domain::status_report` and `::stakeholders`.

#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::similar_names,
    clippy::single_match_else
)]

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::js::iso_from_millis;
use weldsuite_flow_domain::raid::{RaidKind, raid_code};
use weldsuite_flow_domain::risk::risk_band;
use weldsuite_flow_domain::status_report::{
    AreaResult, BenefitInput, CHANGES_LISTED, DECISIONS_LISTED, FinanceFigures, ITEMS_LISTED,
    OpenRisk, RecipientCandidate, SNAPSHOT_VERSION, ScheduleItem, ScheduleRecipients, TOP_RISKS,
    add_days, benefits_area, budget_area, computed_areas_of, merge_areas, overall_colour,
    recipient_targets, risk_area, schedule_area, scope_area, start_of_day, window_days,
};
use weldsuite_kit::generate_id;

/// The default risk appetite (`DEFAULT_RISK_APPETITE`).
pub(crate) const DEFAULT_RISK_APPETITE: i64 = 9;

fn iso(ms: i64) -> String {
    iso_from_millis(ms).unwrap_or_default()
}

/// `epoch milliseconds` of a timestamp column.
macro_rules! ms {
    ($c:literal) => {
        concat!("(extract(epoch from ", $c, ") * 1000)::int8")
    };
}

/// The project columns a report reads.
#[derive(Debug, Clone)]
pub(crate) struct ReportProject {
    pub(crate) id: String,
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) status: String,
    pub(crate) project_manager_id: Option<String>,
    pub(crate) end_date: Option<i64>,
    pub(crate) budget_currency: Option<String>,
    pub(crate) settings: Value,
}

type ProjectRow = (
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<Value>,
);

fn project_of(row: ProjectRow) -> ReportProject {
    ReportProject {
        id: row.0,
        name: row.1,
        status: row.2,
        project_manager_id: row.3,
        end_date: row.4,
        budget_currency: row.5,
        settings: row.6.unwrap_or(Value::Null),
    }
}

pub(crate) const PROJECT_COLUMNS: &str = concat!(
    "id, name, status, project_manager_id, ",
    ms!("end_date"),
    ", budget_currency, settings"
);

/// The projects of a tenant that have a status report schedule and are still running.
pub(crate) async fn scheduled_projects(db: &PgPool) -> Result<Vec<ReportProject>, sqlx::Error> {
    let rows: Vec<ProjectRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {PROJECT_COLUMNS} from projects where deleted_at is null
           and jsonb_typeof(settings -> 'statusReport') = 'object'
           and lower(status) not in ('closed', 'completed', 'archived', 'cancelled')"
    )))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(project_of).collect())
}

/// `loadReportProject(db, projectId)`.
pub(crate) async fn load_report_project(
    db: &PgPool,
    project_id: &str,
) -> Result<Option<ReportProject>, sqlx::Error> {
    let row: Option<ProjectRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {PROJECT_COLUMNS} from projects where id = $1 and deleted_at is null limit 1"
    )))
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(project_of))
}

/// A schedule as `scheduleOf` reads it.
#[derive(Debug, Clone)]
pub(crate) struct Schedule {
    pub(crate) cadence: String,
    pub(crate) weekday: i64,
    pub(crate) hour: i64,
    pub(crate) recipients: ScheduleRecipients,
    pub(crate) recipients_json: Value,
}

/// `scheduleOf(project)`.
pub(crate) fn schedule_of(project: &ReportProject) -> Option<Schedule> {
    let stored = project
        .settings
        .get("statusReport")
        .filter(|v| !v.is_null())?;
    let recipients_json = stored
        .get("recipients")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let ids = recipients_json
        .get("stakeholderIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|i| i.as_str().map(str::to_owned))
                .collect()
        });
    Some(Schedule {
        cadence: stored.get("cadence").and_then(Value::as_str)?.to_owned(),
        weekday: stored.get("weekday").and_then(Value::as_i64).unwrap_or(1),
        hour: stored.get("hour").and_then(Value::as_i64).unwrap_or(9),
        recipients: ScheduleRecipients {
            stakeholder_ids: ids,
            rule: recipients_json
                .get("rule")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        recipients_json,
    })
}

/// `riskAppetiteOf(project)`.
pub(crate) fn risk_appetite_of(project: &ReportProject) -> i64 {
    project
        .settings
        .get("riskAppetite")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_RISK_APPETITE)
}

// ── Reports ─────────────────────────────────────────────────────────────────

/// `findReport(db, id)`: a live report.
pub(crate) async fn find_report(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from project_status_reports r where r.id = $1 and r.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `supersededByMap(db, ids)`.
pub(crate) async fn superseded_by_map(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, supersedes_id from project_status_reports
         where supersedes_id = any($1) and status = 'published' and deleted_at is null
         order by published_at asc, id asc",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, supersedes)| supersedes.map(|s| (s, id)))
        .collect())
}

/// `reportsOfPeriod(db, projectId, period)`: newest first.
pub(crate) async fn reports_of_period(
    db: &PgPool,
    project_id: &str,
    period: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from project_status_reports r
         where r.project_id = $1 and r.period = $2 and r.deleted_at is null
         order by r.created_at desc, r.id desc",
    )
    .bind(project_id)
    .bind(period)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// `periodHandled(db, projectId, period)`: any row, discarded ones too.
pub(crate) async fn period_handled(
    db: &PgPool,
    project_id: &str,
    period: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from project_status_reports where project_id = $1 and period = $2 limit 1",
    )
    .bind(project_id)
    .bind(period)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

// ── Computing a draft ───────────────────────────────────────────────────────

/// What a computation yields.
#[derive(Debug)]
pub(crate) struct ComputedReport {
    pub(crate) areas: [AreaResult; 5],
    pub(crate) overall: &'static str,
    pub(crate) snapshot: Value,
    pub(crate) done: Vec<Value>,
    pub(crate) next: Vec<Value>,
}

fn number(text: Option<String>) -> Option<f64> {
    text.map(|t| weldsuite_kit::validation::js_number(&t))
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn sort_items(items: &mut [Value], newest_first: bool) {
    let date = |v: &Value| {
        v.get("date")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let code = |v: &Value| {
        v.get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    items.sort_by(|a, b| {
        let by_date = if newest_first {
            date(b).cmp(&date(a))
        } else {
            date(a).cmp(&date(b))
        };
        by_date.then(code(a).cmp(&code(b)))
    });
}

type MilestoneRow = (String, String, Option<i64>, Option<i64>, String);
type DeliverableRow = (String, i32, String, Option<i64>, Option<i64>, String);

/// `computeReport(db, project, now, windowDays)`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn compute_report(
    db: &PgPool,
    project: &ReportProject,
    now: i64,
    window: i64,
) -> Result<ComputedReport, sqlx::Error> {
    let pid = project.id.as_str();
    let since_done = iso(add_days(start_of_day(now), -window));
    let day_start = iso(start_of_day(now));
    let until_next = iso(add_days(start_of_day(now), window + 1));

    let baseline: Option<(i32, Value)> = sqlx::query_as(
        "select version, snapshot from project_baselines where project_id = $1 order by version desc limit 1",
    )
    .bind(pid)
    .fetch_optional(db)
    .await?;
    let milestones: Vec<MilestoneRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select id, name, {}, {}, status from milestones where project_id = $1 and deleted_at is null",
        ms!("due_date"),
        ms!("completed_at")
    )))
    .bind(pid)
    .fetch_all(db)
    .await?;
    let deliverables: Vec<DeliverableRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select id, number, title, {}, {}, status from project_deliverables
         where project_id = $1 and deleted_at is null",
        ms!("planned_end"),
        ms!("accepted_at")
    )))
    .bind(pid)
    .fetch_all(db)
    .await?;
    let finance: Option<(String, Option<String>, String, String, String, Option<String>)> = sqlx::query_as(
        "select week, budget::text, planned_value::text, earned_value::text, actual_cost::text, forecast::text
         from project_finance_snapshots where project_id = $1 order by week desc limit 1",
    )
    .bind(pid)
    .fetch_optional(db)
    .await?;
    let pending: Vec<(String, i32, String, String, Option<String>, Option<i32>)> = sqlx::query_as(
        "select id, number, title, status, cost_delta::text, schedule_delta_days
         from project_change_requests
         where project_id = $1 and deleted_at is null and status = any(array['assessing','awaiting_approval'])
         order by number asc",
    )
    .bind(pid)
    .fetch_all(db)
    .await?;
    let risks: Vec<(String, i32, String, i32, Option<String>)> = sqlx::query_as(
        "select id, number, title, score, owner_id from project_raid_items
         where project_id = $1 and kind = 'risk' and deleted_at is null and closed_at is null and score is not null",
    )
    .bind(pid)
    .fetch_all(db)
    .await?;
    let benefit_rows: Vec<(
        String,
        i32,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        i64,
    )> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select id, number, status, baseline_value::text, target_value::text, {}, {}
         from project_benefits where project_id = $1 and deleted_at is null and status <> 'closed'
         order by number asc",
        ms!("realise_by"),
        ms!("created_at")
    )))
    .bind(pid)
    .fetch_all(db)
    .await?;
    let decisions: Vec<(String, i32, String, Option<String>, Option<i64>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select id, number, title, decider_id, {} from project_decisions
         where project_id = $1 and deleted_at is null and status = 'proposed'
         order by decision_due_at asc nulls last, number asc",
            ms!("decision_due_at")
        )))
        .bind(pid)
        .fetch_all(db)
        .await?;
    let done_tasks: Vec<(String, Option<i32>, String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select id, number, title, {} from tasks
         where project_id = $1 and deleted_at is null and status = 'done'
           and (completed_date >= $2::timestamp or (completed_date is null and updated_at >= $2::timestamp))",
        ms!("coalesce(completed_date, updated_at)")
    )))
    .bind(pid)
    .bind(&since_done)
    .fetch_all(db)
    .await?;
    let next_tasks: Vec<(String, Option<i32>, String, i64)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select id, number, title, {} from tasks
         where project_id = $1 and deleted_at is null and due_date is not null
           and due_date >= $2::timestamp and due_date <= $3::timestamp
           and status <> 'done' and status <> 'cancelled'",
            ms!("due_date")
        )))
        .bind(pid)
        .bind(&day_start)
        .bind(&until_next)
        .fetch_all(db)
        .await?;

    // Schedule.
    let frozen = baseline.as_ref().map(|b| &b.1);
    let date_of = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .and_then(weldsuite_flow_domain::js::millis_of)
    };
    let mut items: Vec<ScheduleItem> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for planned in frozen
        .and_then(|f| f.get("milestones"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(live) = milestones
            .iter()
            .find(|m| Some(m.0.as_str()) == planned.get("id").and_then(Value::as_str))
        else {
            continue;
        };
        seen.push(&live.0);
        items.push(ScheduleItem {
            kind: "milestone",
            id: Some(live.0.clone()),
            name: live.1.clone(),
            baseline: date_of(planned.get("dueDate")),
            current: live.2,
            done: live.3.is_some() || live.4 == "completed",
        });
    }
    for live in milestones.iter().filter(|m| !seen.contains(&m.0.as_str())) {
        items.push(ScheduleItem {
            kind: "milestone",
            id: Some(live.0.clone()),
            name: live.1.clone(),
            baseline: None,
            current: live.2,
            done: live.3.is_some() || live.4 == "completed",
        });
    }
    let dname = |d: &DeliverableRow| format!("D{} {}", d.1, d.2);
    let mut seen_d: Vec<&str> = Vec::new();
    for planned in frozen
        .and_then(|f| f.get("deliverables"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(live) = deliverables
            .iter()
            .find(|d| Some(d.0.as_str()) == planned.get("id").and_then(Value::as_str))
        else {
            continue;
        };
        seen_d.push(&live.0);
        items.push(ScheduleItem {
            kind: "deliverable",
            id: Some(live.0.clone()),
            name: dname(live),
            baseline: date_of(planned.get("plannedEnd")),
            current: live.3,
            done: live.5 == "accepted",
        });
    }
    for live in deliverables
        .iter()
        .filter(|d| !seen_d.contains(&d.0.as_str()) && d.3.is_some())
    {
        items.push(ScheduleItem {
            kind: "deliverable",
            id: Some(live.0.clone()),
            name: dname(live),
            baseline: None,
            current: live.3,
            done: live.5 == "accepted",
        });
    }
    let go_live_baseline = date_of(frozen.and_then(|f| f.get("goLive")));
    if go_live_baseline.is_some() || project.end_date.is_some() {
        items.push(ScheduleItem {
            kind: "go_live",
            id: None,
            name: "Go-live".to_owned(),
            baseline: go_live_baseline,
            current: project.end_date,
            done: false,
        });
    }
    let (schedule, rows) = schedule_area(baseline.as_ref().map(|b| i64::from(b.0)), &items, now);

    // Budget.
    let finance_figures = finance.map(|f| FinanceFigures {
        week: f.0,
        budget: f.1,
        planned_value: f.2,
        earned_value: f.3,
        actual_cost: f.4,
        forecast: f.5,
    });
    let (budget, budget_json) =
        budget_area(finance_figures.as_ref(), project.budget_currency.as_deref());

    let scope = scope_area(i64::try_from(pending.len()).unwrap_or(0));

    // Risk.
    let appetite = risk_appetite_of(project);
    let mut open: Vec<&(String, i32, String, i32, Option<String>)> = risks.iter().collect();
    open.sort_by(|a, b| b.3.cmp(&a.3).then(a.1.cmp(&b.1)));
    let risk = risk_area(
        &open
            .iter()
            .map(|r| OpenRisk {
                code: raid_code(RaidKind::Risk, i64::from(r.1)),
                score: i64::from(r.3),
            })
            .collect::<Vec<_>>(),
        appetite,
    );

    // Benefits.
    let benefit_ids: Vec<String> = benefit_rows.iter().map(|b| b.0.clone()).collect();
    let measurements: Vec<(String, String)> = if benefit_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select benefit_id, value::text from project_benefit_measurements
             where benefit_id = any($1) order by period desc",
        )
        .bind(&benefit_ids)
        .fetch_all(db)
        .await?
    };
    let mut latest: HashMap<&str, &str> = HashMap::new();
    for (id, value) in &measurements {
        latest.entry(id.as_str()).or_insert(value.as_str());
    }
    let benefits = benefits_area(
        &benefit_rows
            .iter()
            .map(|b| BenefitInput {
                code: format!("B-{}", b.1),
                status: b.2.clone(),
                baseline: number(b.3.clone()),
                target: number(b.4.clone()),
                latest: latest
                    .get(b.0.as_str())
                    .map(|v| weldsuite_kit::validation::js_number(v)),
                created_at: b.6,
                realise_by: b.5,
            })
            .collect::<Vec<_>>(),
        now,
    );

    let areas = [schedule, budget, scope, risk, benefits];
    let overall = overall_colour(&areas);

    // Top risks with the score of the assessment before the latest.
    let top: Vec<&&(String, i32, String, i32, Option<String>)> =
        open.iter().take(TOP_RISKS).collect();
    let mut previous: HashMap<String, i64> = HashMap::new();
    if !top.is_empty() {
        let ids: Vec<String> = top.iter().map(|r| r.0.clone()).collect();
        let assessments: Vec<(String, i16, i16)> = sqlx::query_as(
            "select item_id, probability, impact from project_raid_assessments
             where item_id = any($1) order by assessed_at desc, id desc",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?;
        let mut count: HashMap<&str, i32> = HashMap::new();
        for (item, p, i) in &assessments {
            let n = count.entry(item.as_str()).or_insert(0);
            *n += 1;
            if *n == 2 {
                previous.insert(item.clone(), i64::from(*p) * i64::from(*i));
            }
        }
    }
    let top_risks: Vec<Value> = top
        .iter()
        .map(|r| {
            let score = i64::from(r.3);
            json!({
                "id": r.0,
                "code": raid_code(RaidKind::Risk, i64::from(r.1)),
                "title": r.2,
                "score": score,
                "band": risk_band(score.max(1)).map_or("low", |b| b.as_str()),
                "ownerId": r.4,
                "previousScore": previous.get(&r.0),
            })
        })
        .collect();
    let decisions_json: Vec<Value> = decisions
        .iter()
        .take(DECISIONS_LISTED)
        .map(|d| {
            json!({
                "id": d.0,
                "code": format!("DEC-{}", d.1),
                "title": d.2,
                "deciderId": d.3,
                "dueAt": d.4.map(iso),
            })
        })
        .collect();
    let changes_json: Vec<Value> = pending
        .iter()
        .take(CHANGES_LISTED)
        .map(|c| {
            json!({
                "id": c.0,
                "code": format!("CR-{}", c.1),
                "title": c.2,
                "status": c.3,
                "costDelta": c.4,
                "scheduleDeltaDays": c.5,
            })
        })
        .collect();

    let task_code = |n: Option<i32>| n.map_or_else(|| "TASK".to_owned(), |n| format!("TASK-{n}"));
    let since_ms = add_days(start_of_day(now), -window);
    let mut done: Vec<Value> = done_tasks
        .iter()
        .map(|t| json!({ "taskId": t.0, "text": t.2, "code": task_code(t.1), "date": iso(t.3) }))
        .collect();
    done.extend(
        deliverables
            .iter()
            .filter(|d| d.5 == "accepted" && d.4.is_some_and(|at| at >= since_ms))
            .map(|d| json!({ "taskId": null, "text": d.2, "code": format!("D{}", d.1), "date": d.4.map(iso) })),
    );
    sort_items(&mut done, true);
    done.truncate(ITEMS_LISTED);

    let until_ms = add_days(start_of_day(now), window + 1);
    let mut next: Vec<Value> = next_tasks
        .iter()
        .map(|t| json!({ "taskId": t.0, "text": t.2, "code": task_code(t.1), "date": iso(t.3) }))
        .collect();
    next.extend(
        decisions
            .iter()
            .filter(|d| d.4.is_some_and(|at| at >= start_of_day(now) && at <= until_ms))
            .map(|d| json!({ "taskId": null, "text": d.2, "code": format!("DEC-{}", d.1), "date": d.4.map(iso) })),
    );
    sort_items(&mut next, false);
    next.truncate(ITEMS_LISTED);

    let snapshot = json!({
        "version": SNAPSHOT_VERSION,
        "asOf": iso(now),
        "baselineVersion": baseline.as_ref().map(|b| b.0),
        "currency": project.budget_currency,
        "computed": { "overall": overall, "areas": computed_areas_of(&areas) },
        "figures": {
            "budget": budget_json,
            "pendingChanges": pending.len(),
            "riskAppetite": appetite,
            "openRisks": open.len(),
            "highestRiskScore": open.first().map(|r| r.3),
        },
        "topRisks": top_risks,
        "decisions": decisions_json,
        "changes": changes_json,
        "milestones": rows,
    });
    Ok(ComputedReport {
        areas,
        overall,
        snapshot,
        done,
        next,
    })
}

/// `insertDraft(db, project, { period, now, createdBy, supersedes })`.
pub(crate) async fn insert_draft(
    db: &PgPool,
    project: &ReportProject,
    period: &str,
    now: i64,
    created_by: &str,
    supersedes: Option<&Value>,
) -> Result<Option<Value>, sqlx::Error> {
    let schedule = schedule_of(project);
    let cadence = schedule.as_ref().map(|s| s.cadence.as_str());
    let computed = compute_report(db, project, now, window_days(period, cadence)).await?;
    let id = generate_id("rpt");
    let recipients = schedule
        .as_ref()
        .and_then(|s| s.recipients.stakeholder_ids.clone())
        .map(|ids| json!({ "stakeholderIds": ids }));
    let client_visible = supersedes
        .and_then(|s| s.get("clientVisible"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    sqlx::query(
        "insert into project_status_reports (id, project_id, period, status, overall, areas, summary,
             done, next, snapshot, client_visible, supersedes_id, recipients, created_by, created_at, updated_at)
         values ($1, $2, $3, 'draft', $4, $5::jsonb, null, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb,
             $12, $13::timestamptz, $13::timestamptz)",
    )
    .bind(&id)
    .bind(&project.id)
    .bind(period)
    .bind(computed.overall)
    .bind(Value::Array(merge_areas(None, &computed.areas)))
    .bind(Value::Array(computed.done))
    .bind(Value::Array(computed.next))
    .bind(computed.snapshot)
    .bind(client_visible)
    .bind(supersedes.and_then(|s| text_of(s, "id")))
    .bind(recipients)
    .bind(created_by)
    .bind(iso(now))
    .execute(db)
    .await?;
    find_report(db, &id).await
}

// ── Stakeholders and recipients ─────────────────────────────────────────────

/// `findStakeholder(db, id)`.
pub(crate) async fn find_stakeholder(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from project_stakeholders s where s.id = $1 and s.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `stakeholdersOfProject(db, projectId)`: oldest first.
pub(crate) async fn stakeholders_of_project(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from project_stakeholders s
         where s.project_id = $1 and s.deleted_at is null order by s.created_at asc, s.id asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// A member's or contact's name and email.
pub(crate) type Identity = (Option<String>, Option<String>);

/// `memberIdentities(db, userIds)`.
pub(crate) async fn member_identities(
    db: &PgPool,
    user_ids: &[String],
) -> Result<HashMap<String, Identity>, sqlx::Error> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select user_id, name, email from workspace_members where user_id = any($1)",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    let mut out = HashMap::new();
    for (id, name, email) in rows {
        out.entry(id).or_insert((name, email));
    }
    Ok(out)
}

/// `contactIdentities(db, contactIds)`.
pub(crate) async fn contact_identities(
    db: &PgPool,
    contact_ids: &[String],
) -> Result<HashMap<String, Identity>, sqlx::Error> {
    if contact_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, display_name, email from people where id = any($1) and deleted_at is null",
    )
    .bind(contact_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, email)| (id, (name, email)))
        .collect())
}

fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `identitiesOf(db, rows)`: by stakeholder id.
pub(crate) async fn identities_of(
    db: &PgPool,
    rows: &[Value],
) -> Result<HashMap<String, Identity>, sqlx::Error> {
    let members: Vec<String> = rows
        .iter()
        .filter_map(|r| str_of(r, "memberId"))
        .map(str::to_owned)
        .collect();
    let contacts: Vec<String> = rows
        .iter()
        .filter_map(|r| str_of(r, "crmContactId"))
        .map(str::to_owned)
        .collect();
    let members = member_identities(db, &members).await?;
    let contacts = contact_identities(db, &contacts).await?;
    let mut out = HashMap::new();
    for row in rows {
        let found = str_of(row, "memberId")
            .and_then(|id| members.get(id))
            .or_else(|| str_of(row, "crmContactId").and_then(|id| contacts.get(id)));
        out.insert(
            str_of(row, "id").unwrap_or_default().to_owned(),
            found.cloned().unwrap_or((None, None)),
        );
    }
    Ok(out)
}

/// `memberExists(db, userId)`.
pub(crate) async fn member_exists(db: &PgPool, user_id: &str) -> Result<bool, sqlx::Error> {
    Ok(member_identities(db, &[user_id.to_owned()])
        .await?
        .contains_key(user_id))
}

/// `contactExists(db, contactId)`.
pub(crate) async fn contact_exists(db: &PgPool, contact_id: &str) -> Result<bool, sqlx::Error> {
    Ok(contact_identities(db, &[contact_id.to_owned()])
        .await?
        .contains_key(contact_id))
}

/// `recipientCandidates`: the register as candidates and the sponsor.
pub(crate) async fn recipient_candidates(
    db: &PgPool,
    project: &ReportProject,
) -> Result<(Vec<RecipientCandidate>, Option<RecipientCandidate>), sqlx::Error> {
    let rows = stakeholders_of_project(db, &project.id).await?;
    let identities = identities_of(db, &rows).await?;
    let register: Vec<RecipientCandidate> = rows
        .iter()
        .map(|row| {
            let id = str_of(row, "id").unwrap_or_default();
            let (name, email) = identities.get(id).cloned().unwrap_or((None, None));
            let member = str_of(row, "memberId");
            RecipientCandidate {
                stakeholder_id: Some(id.to_owned()),
                user_id: member.map(str::to_owned),
                name,
                email,
                kind: if member.is_some() {
                    "member"
                } else {
                    "contact"
                },
                portal_access: row
                    .get("portalAccess")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect();
    let sponsor_id = project
        .settings
        .get("sponsorId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| project.project_manager_id.clone());
    let mut sponsor = None;
    if let Some(id) = sponsor_id {
        let found = member_identities(db, std::slice::from_ref(&id))
            .await?
            .remove(&id);
        let on_register = register
            .iter()
            .find(|c| c.user_id.as_deref() == Some(id.as_str()));
        let (name, email) = found.unwrap_or((None, None));
        sponsor = Some(RecipientCandidate {
            stakeholder_id: on_register.and_then(|c| c.stakeholder_id.clone()),
            user_id: Some(id),
            name,
            email,
            kind: "member",
            portal_access: false,
        });
    }
    Ok((register, sponsor))
}

/// `targetsOf(db, project, stored)`.
pub(crate) async fn targets_of(
    db: &PgPool,
    project: &ReportProject,
    stored: Option<&Value>,
) -> Result<Vec<RecipientCandidate>, sqlx::Error> {
    let (register, sponsor) = recipient_candidates(db, project).await?;
    let schedule = schedule_of(project);
    let stored = stored.filter(|v| !v.is_null());
    Ok(recipient_targets(
        stored,
        schedule.as_ref().map(|s| &s.recipients),
        &register,
        sponsor.as_ref(),
    ))
}

/// `presentTarget(target)`.
pub(crate) fn present_target(target: &RecipientCandidate) -> Value {
    json!({
        "stakeholderId": target.stakeholder_id,
        "userId": target.user_id,
        "name": target.name,
        "email": target.email,
        "kind": target.kind,
    })
}
