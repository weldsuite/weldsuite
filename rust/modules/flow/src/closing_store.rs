//! Closing a project, the database side (`services/project-closing.ts`): a
//! live project by id, the close checklist computed from the project's
//! tables, and the payload of an approval event. The rules are
//! `weldsuite_flow_domain::project_closing`.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::js_date;
use weldsuite_flow_domain::project_closing::{
    CloseCounts, CloseFinanceInput, FinanceSnapshot, can_request_close, close_checks,
    close_finance, close_progress, sign_off_state,
};
use weldsuite_flow_domain::raid::{RaidKind, raid_code};

use crate::approvals_adapter::{list_subject_approvals, sponsor_of};

pub(crate) const PROJECT_DENIED: &str = "You are not a member of this project";
pub(crate) const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
pub(crate) const PROJECT_MANAGE_DENIED: &str =
    "You must be a project owner, admin, or manager to close this project";

/// `findLiveProject(db, id)`: a live project, as Drizzle reads it.
pub(crate) async fn find_live_project(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!("p"),
        " from projects p where p.id = $1 and p.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The payload of a `flow_approval` event (`approvalEventData`).
pub(crate) fn approval_event_data(row: &Value) -> Value {
    json!({
        "id": row.at("id"),
        "projectId": row.at("projectId"),
        "subjectType": row.at("subjectType"),
        "subjectId": row.at("subjectId"),
        "approverKind": row.at("approverKind"),
        "approverId": row.at("approverId"),
        "step": row.at("step"),
        "ruleCode": row.at("rule").at("code"),
        "decision": row.at("decision"),
        "dueAt": row.at("dueAt"),
    })
}

fn kind_index(kind: Option<&str>) -> i64 {
    RaidKind::ALL
        .iter()
        .position(|k| Some(k.as_str()) == kind)
        .map_or(-1, |index| i64::try_from(index).unwrap_or(-1))
}

/// What the tables hold that the checklist counts.
struct Tables {
    deliverables: Vec<Value>,
    changes: (i64, i64),
    raid: Vec<Value>,
    benefits: Vec<Value>,
    /// `(total, open, approved, billed, cost)`.
    time: (i64, i64, i64, i64, String),
    lessons: (i64, i64),
    approvals: Vec<Value>,
}

async fn read_tables(db: &PgPool, project_id: &str) -> Result<Tables, sqlx::Error> {
    let deliverables: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_deliverables d
         where d.project_id = $1 and d.deleted_at is null order by d.position asc, d.number asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let changes: (i64, i64) = sqlx::query_as(
        "select count(*)::int8,
                (count(*) filter (where status in ('draft', 'assessing', 'awaiting_approval')))::int8
         from project_change_requests where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let raid: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from project_raid_items r
         where r.project_id = $1 and r.deleted_at is null and r.closed_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let benefits: Vec<Value> = sqlx::query_scalar(
        "select (to_jsonb(b) || jsonb_build_object('baseline_value', b.baseline_value::text,
                'target_value', b.target_value::text))
         from project_benefits b
         where b.project_id = $1 and b.deleted_at is null and b.status <> 'closed'
         order by b.number asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let time: (i64, i64, i64, i64, String) = sqlx::query_as(
        "select count(*)::int8,
                (count(*) filter (where status not in ('approved', 'billed')))::int8,
                (count(*) filter (where status = 'approved'))::int8,
                (count(*) filter (where status = 'billed'))::int8,
                coalesce(sum(cost) filter (where status in ('approved', 'billed')), 0)::text
         from time_entries where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let lessons: (i64, i64) = sqlx::query_as(
        "select count(*)::int8, (count(*) filter (where know_page_id is not null))::int8
         from project_lessons where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let approvals = list_subject_approvals(db, "project_close", project_id).await?;
    Ok(Tables {
        deliverables: deliverables.into_iter().map(js_row).collect(),
        changes,
        raid: raid.into_iter().map(js_row).collect(),
        benefits: benefits.into_iter().map(js_row).collect(),
        time,
        lessons,
        approvals,
    })
}

/// The latest measurement of each benefit, by period.
async fn latest_measurements(
    db: &PgPool,
    benefits: &[Value],
) -> Result<HashMap<String, Value>, sqlx::Error> {
    let ids: Vec<&str> = benefits.iter().filter_map(|row| row.text("id")).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select (to_jsonb(m) || jsonb_build_object('value', m.value::text))
         from project_benefit_measurements m where m.benefit_id = any($1)
         order by m.period desc, m.id desc",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut latest = HashMap::new();
    for row in rows.into_iter().map(js_row) {
        let benefit = row.text("benefitId").unwrap_or_default().to_owned();
        latest.entry(benefit).or_insert(row);
    }
    Ok(latest)
}

/// The budget on the latest baseline and the latest weekly snapshot.
async fn read_finance(
    db: &PgPool,
    project: &Value,
    time_cost: String,
    amounts_visible: bool,
) -> Result<Value, sqlx::Error> {
    let project_id = project.text("id").unwrap_or_default();
    let baseline: Option<(i32, Value)> = sqlx::query_as(
        "select version, snapshot from project_baselines where project_id = $1
         order by version desc limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let snapshot: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "select week, actual_cost::text, committed::text, forecast::text
         from project_finance_snapshots where project_id = $1 order by week desc limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let budget = baseline
        .as_ref()
        .and_then(|(_, snapshot)| snapshot.text("budgetedAmount"))
        .or_else(|| project.text("budgetedAmount"))
        .map(str::to_owned);
    Ok(close_finance(&CloseFinanceInput {
        currency: project.text("budgetCurrency").map(str::to_owned),
        amounts_visible,
        budget,
        time_cost,
        snapshot: snapshot.map(|(week, actual_cost, committed, forecast)| FinanceSnapshot {
            week,
            actual_cost,
            committed,
            forecast,
        }),
        baseline: baseline.map(|(version, snapshot)| {
            let go_live = snapshot
                .text("goLive")
                .filter(|text| !text.is_empty())
                .and_then(js_date);
            (i64::from(version), go_live)
        }),
    }))
}

fn present_benefit(row: &Value, latest: Option<&Value>) -> Value {
    json!({
        "id": row.at("id"),
        "code": format!("B-{}", row.int("number").unwrap_or(0)),
        "title": row.at("title"),
        "status": row.at("status"),
        "ownerId": row.at("ownerId"),
        "unit": row.at("unit"),
        "baselineValue": row.at("baselineValue"),
        "targetValue": row.at("targetValue"),
        "realiseBy": row.at("realiseBy"),
        "latest": latest.map(|m| json!({
            "period": m.at("period"), "value": m.at("value"), "measuredAt": m.at("measuredAt"),
        })),
    })
}

fn present_approval(row: &Value) -> Value {
    json!({
        "id": row.at("id"),
        "approverId": row.at("approverId"),
        "decision": row.at("decision"),
        "note": row.at("note"),
        "decidedAt": row.at("decidedAt"),
        "decidedBy": row.at("decidedBy"),
        "delegatedFrom": row.at("delegatedFrom"),
        "requestedAt": row.at("createdAt"),
    })
}

/// The close checklist of a project, computed from its tables
/// (`loadChecklist`): deliverables accepted, change requests decided, open
/// register items handed over, benefits with an owner and a final
/// measurement, time entries locked, lessons published and the state of the
/// sign-off.
#[allow(clippy::too_many_lines)] // the checklist's sections, in the TypeScript order
pub(crate) async fn load_checklist(
    db: &PgPool,
    project: &Value,
    amounts_visible: bool,
) -> Result<Value, sqlx::Error> {
    let project_id = project.text("id").unwrap_or_default();
    let handovers = project.at("settings").at("closing").at("handovers");
    let tables = read_tables(db, project_id).await?;
    let latest = latest_measurements(db, &tables.benefits).await?;

    let benefits: Vec<Value> = tables
        .benefits
        .iter()
        .map(|row| present_benefit(row, latest.get(row.text("id").unwrap_or_default())))
        .collect();
    let mut raid_rows: Vec<&Value> = tables.raid.iter().collect();
    raid_rows.sort_by_key(|row| (kind_index(row.text("kind")), row.int("number").unwrap_or(0)));
    let raid_items: Vec<Value> = raid_rows
        .iter()
        .map(|row| {
            let kind = row.text("kind").and_then(RaidKind::parse);
            json!({
                "id": row.at("id"),
                "kind": row.at("kind"),
                "code": kind.map(|kind| raid_code(kind, row.int("number").unwrap_or(0))),
                "title": row.at("title"),
                "status": row.at("status"),
                "ownerId": row.at("ownerId"),
                "handedOver": handovers.get(row.text("id").unwrap_or_default()).is_some(),
            })
        })
        .collect();

    let decisions: Vec<&str> = tables
        .approvals
        .iter()
        .filter_map(|row| row.text("decision"))
        .collect();
    let sign_off = sign_off_state(&decisions);
    let closed = project.text("status") == Some("Closed");
    let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
    let (time_total, time_open, time_approved, time_billed, time_cost) = tables.time;
    let counts = CloseCounts {
        closed,
        deliverables: (
            count(tables.deliverables.len()),
            count(
                tables
                    .deliverables
                    .iter()
                    .filter(|row| row.text("status") == Some("accepted"))
                    .count(),
            ),
        ),
        changes: tables.changes,
        raid: (
            count(raid_items.len()),
            count(
                raid_items
                    .iter()
                    .filter(|row| row.flag("handedOver"))
                    .count(),
            ),
        ),
        benefits: (
            count(benefits.len()),
            count(
                benefits
                    .iter()
                    .filter(|row| !row.at("ownerId").is_null() && !row.at("latest").is_null())
                    .count(),
            ),
        ),
        time: (time_total, time_open),
        lessons: tables.lessons,
        sign_off,
    };
    let checks = close_checks(&counts);
    let (done, total) = close_progress(&checks);
    let latest_approval = tables.approvals.iter().max_by(|a, b| {
        (a.text("createdAt"), a.text("id")).cmp(&(b.text("createdAt"), b.text("id")))
    });
    let closed_at = project.text("actualEndDate").filter(|_| closed);

    Ok(json!({
        "projectId": project_id,
        "projectName": project.at("name"),
        "status": project.at("status"),
        "closed": closed,
        "closedAt": closed_at,
        "checks": checks.iter().map(weldsuite_flow_domain::project_closing::CloseCheck::to_value).collect::<Vec<_>>(),
        "progress": { "done": done, "total": total },
        "canRequest": can_request_close(&checks, closed, sign_off),
        "deliverables": tables.deliverables.iter().map(|row| json!({
            "id": row.at("id"),
            "code": format!("D{}", row.int("number").unwrap_or(0)),
            "title": row.at("title"),
            "status": row.at("status"),
            "acceptedAt": row.at("acceptedAt"),
        })).collect::<Vec<_>>(),
        "raidItems": raid_items,
        "benefits": benefits,
        "time": { "total": time_total, "approved": time_approved, "billed": time_billed, "open": time_open },
        "finance": read_finance(db, project, time_cost, amounts_visible).await?,
        "lessons": { "total": tables.lessons.0, "published": tables.lessons.1 },
        "signOff": {
            "state": sign_off.as_str(),
            "sponsorId": sponsor_of(project.at("settings"), project.text("projectManagerId")),
            "approval": latest_approval.map(present_approval),
        },
    }))
}
