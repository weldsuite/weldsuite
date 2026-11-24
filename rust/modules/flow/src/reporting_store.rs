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

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
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
use weldsuite_schema::tenant::{
    milestones, people, project_baselines, project_benefit_measurements, project_benefits,
    project_change_requests, project_decisions, project_deliverables, project_finance_snapshots,
    project_raid_assessments, project_raid_items, project_stakeholders, project_status_reports,
    projects, tasks, workspace_members,
};

use crate::row_json;

/// The default risk appetite (`DEFAULT_RISK_APPETITE`).
pub(crate) const DEFAULT_RISK_APPETITE: i64 = 9;

fn iso(ms: i64) -> String {
    iso_from_millis(ms).unwrap_or_default()
}

/// `(extract(epoch from col) * 1000)::int8`: epoch milliseconds, the
/// microseconds rounded half away from zero as Postgres casts the numeric.
pub(crate) fn epoch_ms(at: OffsetDateTime) -> i64 {
    let micros = at.unix_timestamp_nanos() / 1_000;
    let millis = if micros >= 0 {
        (micros + 500) / 1_000
    } else {
        (micros - 500) / 1_000
    };
    i64::try_from(millis).unwrap_or(0)
}

/// [`epoch_ms`] of a `timestamp` column (UTC).
pub(crate) fn epoch_ms_utc(at: PrimitiveDateTime) -> i64 {
    epoch_ms(at.assume_utc())
}

/// `new Date(ms)`.
pub(crate) fn instant(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
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
    Option<PrimitiveDateTime>,
    Option<String>,
    Option<Value>,
);

fn project_of(row: ProjectRow) -> ReportProject {
    ReportProject {
        id: row.0,
        name: row.1,
        status: row.2,
        project_manager_id: row.3,
        end_date: row.4.map(epoch_ms_utc),
        budget_currency: row.5,
        settings: row.6.unwrap_or(Value::Null),
    }
}

/// The project columns a report reads.
fn report_projects() -> sea_orm::Select<projects::Entity> {
    projects::Entity::find().select_only().columns([
        projects::Column::Id,
        projects::Column::Name,
        projects::Column::Status,
        projects::Column::ProjectManagerId,
        projects::Column::EndDate,
        projects::Column::BudgetCurrency,
        projects::Column::Settings,
    ])
}

/// The projects of a tenant that have a status report schedule and are still running.
pub(crate) async fn scheduled_projects(db: &PgPool) -> Result<Vec<ReportProject>, DbErr> {
    // `jsonb_typeof(settings -> 'statusReport') = 'object'`.
    let schedule_kind = Func::cust("jsonb_typeof").arg(
        sea_orm::sea_query::extension::postgres::PgExpr::get_json_field(
            Expr::col(projects::Column::Settings),
            "statusReport",
        ),
    );
    let rows: Vec<ProjectRow> = report_projects()
        .filter(projects::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(Expr::from(schedule_kind), "object"))
        .filter(sea_orm::ExprTrait::is_not_in(
            Expr::from(Func::lower(Expr::col(projects::Column::Status))),
            ["closed", "completed", "archived", "cancelled"],
        ))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(project_of).collect())
}

/// `loadReportProject(db, projectId)`.
pub(crate) async fn load_report_project(
    db: &PgPool,
    project_id: &str,
) -> Result<Option<ReportProject>, DbErr> {
    let row: Option<ProjectRow> = report_projects()
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
pub(crate) async fn find_report(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    project_status_reports::Entity::find()
        .filter(project_status_reports::Column::Id.eq(id))
        .filter(project_status_reports::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `supersededByMap(db, ids)`.
pub(crate) async fn superseded_by_map(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, String>, DbErr> {
    use project_status_reports::Column;
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> = project_status_reports::Entity::find()
        .select_only()
        .columns([Column::Id, Column::SupersedesId])
        .filter(Column::SupersedesId.is_in(ids))
        .filter(Column::Status.eq("published"))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::PublishedAt)
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(db))
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
) -> Result<Vec<Value>, DbErr> {
    use project_status_reports::Column;
    project_status_reports::Entity::find()
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::Period.eq(period))
        .filter(Column::DeletedAt.is_null())
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// `periodHandled(db, projectId, period)`: any row, discarded ones too.
pub(crate) async fn period_handled(
    db: &PgPool,
    project_id: &str,
    period: &str,
) -> Result<bool, DbErr> {
    use project_status_reports::Column;
    let found: Option<String> = project_status_reports::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::Period.eq(period))
        .into_tuple()
        .one(&orm(db))
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

/// `col::text`: a `numeric` exactly as Postgres prints it.
fn as_text<C: ColumnTrait>(column: C) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::col(column), "text")
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
) -> Result<ComputedReport, DbErr> {
    let pid = project.id.as_str();
    let db = &orm(db);
    let since_done = utc_timestamp(instant(add_days(start_of_day(now), -window)));
    let day_start = utc_timestamp(instant(start_of_day(now)));
    let until_next = utc_timestamp(instant(add_days(start_of_day(now), window + 1)));

    let baseline: Option<(i32, Value)> = project_baselines::Entity::find()
        .select_only()
        .columns([
            project_baselines::Column::Version,
            project_baselines::Column::Snapshot,
        ])
        .filter(project_baselines::Column::ProjectId.eq(pid))
        .order_by_desc(project_baselines::Column::Version)
        .into_tuple()
        .one(db)
        .await?;
    let milestones: Vec<MilestoneRow> = {
        use milestones::Column;
        let rows: Vec<(
            String,
            String,
            PrimitiveDateTime,
            Option<PrimitiveDateTime>,
            String,
        )> = milestones::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Name,
                Column::DueDate,
                Column::CompletedAt,
                Column::Status,
            ])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(db)
            .await?;
        rows.into_iter()
            .map(|(id, name, due, completed, status)| {
                (
                    id,
                    name,
                    Some(epoch_ms_utc(due)),
                    completed.map(epoch_ms_utc),
                    status,
                )
            })
            .collect()
    };
    let deliverables: Vec<DeliverableRow> = {
        use project_deliverables::Column;
        let rows: Vec<(
            String,
            i32,
            String,
            Option<OffsetDateTime>,
            Option<OffsetDateTime>,
            String,
        )> = project_deliverables::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Number,
                Column::Title,
                Column::PlannedEnd,
                Column::AcceptedAt,
                Column::Status,
            ])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(db)
            .await?;
        rows.into_iter()
            .map(|(id, number, title, planned_end, accepted_at, status)| {
                (
                    id,
                    number,
                    title,
                    planned_end.map(epoch_ms),
                    accepted_at.map(epoch_ms),
                    status,
                )
            })
            .collect()
    };
    let finance: Option<(
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
    )> = {
        use project_finance_snapshots::Column;
        project_finance_snapshots::Entity::find()
            .select_only()
            .column(Column::Week)
            .column_as(as_text(Column::Budget), "budget")
            .column_as(as_text(Column::PlannedValue), "planned_value")
            .column_as(as_text(Column::EarnedValue), "earned_value")
            .column_as(as_text(Column::ActualCost), "actual_cost")
            .column_as(as_text(Column::Forecast), "forecast")
            .filter(Column::ProjectId.eq(pid))
            .order_by_desc(Column::Week)
            .into_tuple()
            .one(db)
            .await?
    };
    let pending: Vec<(String, i32, String, String, Option<String>, Option<i32>)> = {
        use project_change_requests::Column;
        project_change_requests::Entity::find()
            .select_only()
            .columns([Column::Id, Column::Number, Column::Title, Column::Status])
            .column_as(as_text(Column::CostDelta), "cost_delta")
            .column(Column::ScheduleDeltaDays)
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.is_in(["assessing", "awaiting_approval"]))
            .order_by_asc(Column::Number)
            .into_tuple()
            .all(db)
            .await?
    };
    let risks: Vec<(String, i32, String, i32, Option<String>)> = {
        use project_raid_items::Column;
        project_raid_items::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Number,
                Column::Title,
                Column::Score,
                Column::OwnerId,
            ])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::Kind.eq("risk"))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::ClosedAt.is_null())
            .filter(Column::Score.is_not_null())
            .into_tuple()
            .all(db)
            .await?
    };
    let benefit_rows: Vec<(
        String,
        i32,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        i64,
    )> = {
        use project_benefits::Column;
        let rows: Vec<(
            String,
            i32,
            String,
            Option<String>,
            Option<String>,
            Option<OffsetDateTime>,
            OffsetDateTime,
        )> = project_benefits::Entity::find()
            .select_only()
            .columns([Column::Id, Column::Number, Column::Status])
            .column_as(as_text(Column::BaselineValue), "baseline_value")
            .column_as(as_text(Column::TargetValue), "target_value")
            .columns([Column::RealiseBy, Column::CreatedAt])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.ne("closed"))
            .order_by_asc(Column::Number)
            .into_tuple()
            .all(db)
            .await?;
        rows.into_iter()
            .map(
                |(id, number, status, baseline, target, realise_by, created_at)| {
                    (
                        id,
                        number,
                        status,
                        baseline,
                        target,
                        realise_by.map(epoch_ms),
                        epoch_ms(created_at),
                    )
                },
            )
            .collect()
    };
    let decisions: Vec<(String, i32, String, Option<String>, Option<i64>)> = {
        use project_decisions::Column;
        let rows: Vec<(String, i32, String, Option<String>, Option<OffsetDateTime>)> =
            project_decisions::Entity::find()
                .select_only()
                .columns([
                    Column::Id,
                    Column::Number,
                    Column::Title,
                    Column::DeciderId,
                    Column::DecisionDueAt,
                ])
                .filter(Column::ProjectId.eq(pid))
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Status.eq("proposed"))
                .order_by_with_nulls(
                    Column::DecisionDueAt,
                    sea_orm::Order::Asc,
                    sea_orm::sea_query::NullOrdering::Last,
                )
                .order_by_asc(Column::Number)
                .into_tuple()
                .all(db)
                .await?;
        rows.into_iter()
            .map(|(id, number, title, decider, due)| {
                (id, number, title, decider, due.map(epoch_ms))
            })
            .collect()
    };
    let done_tasks: Vec<(String, Option<i32>, String, i64)> = {
        use tasks::Column;
        let rows: Vec<(
            String,
            Option<i32>,
            String,
            Option<PrimitiveDateTime>,
            PrimitiveDateTime,
        )> = tasks::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Number,
                Column::Title,
                Column::CompletedDate,
                Column::UpdatedAt,
            ])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.eq("done"))
            .filter(
                Condition::any()
                    .add(Column::CompletedDate.gte(since_done))
                    .add(
                        Condition::all()
                            .add(Column::CompletedDate.is_null())
                            .add(Column::UpdatedAt.gte(since_done)),
                    ),
            )
            .into_tuple()
            .all(db)
            .await?;
        // `coalesce(completed_date, updated_at)`.
        rows.into_iter()
            .map(|(id, number, title, completed, updated)| {
                (
                    id,
                    number,
                    title,
                    epoch_ms_utc(completed.unwrap_or(updated)),
                )
            })
            .collect()
    };
    let next_tasks: Vec<(String, Option<i32>, String, i64)> = {
        use tasks::Column;
        let rows: Vec<(String, Option<i32>, String, PrimitiveDateTime)> = tasks::Entity::find()
            .select_only()
            .columns([Column::Id, Column::Number, Column::Title, Column::DueDate])
            .filter(Column::ProjectId.eq(pid))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::DueDate.is_not_null())
            .filter(Column::DueDate.gte(day_start))
            .filter(Column::DueDate.lte(until_next))
            .filter(Column::Status.ne("done"))
            .filter(Column::Status.ne("cancelled"))
            .into_tuple()
            .all(db)
            .await?;
        rows.into_iter()
            .map(|(id, number, title, due)| (id, number, title, epoch_ms_utc(due)))
            .collect()
    };

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
        use project_benefit_measurements::Column;
        project_benefit_measurements::Entity::find()
            .select_only()
            .column(Column::BenefitId)
            .column_as(as_text(Column::Value), "value")
            .filter(Column::BenefitId.is_in(&benefit_ids))
            .order_by_desc(Column::Period)
            .into_tuple()
            .all(db)
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
        use project_raid_assessments::Column;
        let ids: Vec<String> = top.iter().map(|r| r.0.clone()).collect();
        let assessments: Vec<(String, i16, i16)> = project_raid_assessments::Entity::find()
            .select_only()
            .columns([Column::ItemId, Column::Probability, Column::Impact])
            .filter(Column::ItemId.is_in(&ids))
            .order_by_desc(Column::AssessedAt)
            .order_by_desc(Column::Id)
            .into_tuple()
            .all(db)
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
) -> Result<Option<Value>, DbErr> {
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
    let at = instant(now);
    project_status_reports::Entity::insert(project_status_reports::ActiveModel {
        id: Set(id.clone()),
        project_id: Set(project.id.clone()),
        period: Set(period.to_owned()),
        status: Set("draft".to_owned()),
        overall: Set(Some(computed.overall.to_owned())),
        areas: Set(Value::Array(merge_areas(None, &computed.areas))),
        summary: Set(None),
        done: Set(Value::Array(computed.done)),
        next: Set(Value::Array(computed.next)),
        snapshot: Set(Some(computed.snapshot)),
        client_visible: Set(client_visible),
        supersedes_id: Set(supersedes.and_then(|s| text_of(s, "id"))),
        recipients: Set(recipients),
        created_by: Set(created_by.to_owned()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    find_report(db, &id).await
}

// ── Stakeholders and recipients ─────────────────────────────────────────────

/// `findStakeholder(db, id)`.
pub(crate) async fn find_stakeholder(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    project_stakeholders::Entity::find()
        .filter(project_stakeholders::Column::Id.eq(id))
        .filter(project_stakeholders::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `stakeholdersOfProject(db, projectId)`: oldest first.
pub(crate) async fn stakeholders_of_project(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<Value>, DbErr> {
    use project_stakeholders::Column;
    project_stakeholders::Entity::find()
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// A member's or contact's name and email.
pub(crate) type Identity = (Option<String>, Option<String>);

/// `memberIdentities(db, userIds)`.
pub(crate) async fn member_identities(
    db: &PgPool,
    user_ids: &[String],
) -> Result<HashMap<String, Identity>, DbErr> {
    use workspace_members::Column;
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([Column::UserId, Column::Name, Column::Email])
        .filter(Column::UserId.is_in(user_ids))
        .into_tuple()
        .all(&orm(db))
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
) -> Result<HashMap<String, Identity>, DbErr> {
    use people::Column;
    if contact_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = people::Entity::find()
        .select_only()
        .columns([Column::Id, Column::DisplayName, Column::Email])
        .filter(Column::Id.is_in(contact_ids))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
) -> Result<HashMap<String, Identity>, DbErr> {
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
pub(crate) async fn member_exists(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    Ok(member_identities(db, &[user_id.to_owned()])
        .await?
        .contains_key(user_id))
}

/// `contactExists(db, contactId)`.
pub(crate) async fn contact_exists(db: &PgPool, contact_id: &str) -> Result<bool, DbErr> {
    Ok(contact_identities(db, &[contact_id.to_owned()])
        .await?
        .contains_key(contact_id))
}

/// `recipientCandidates`: the register as candidates and the sponsor.
pub(crate) async fn recipient_candidates(
    db: &PgPool,
    project: &ReportProject,
) -> Result<(Vec<RecipientCandidate>, Option<RecipientCandidate>), DbErr> {
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
) -> Result<Vec<RecipientCandidate>, DbErr> {
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
