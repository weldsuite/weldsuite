//! Closing a project, the database side (`services/project-closing.ts`): a
//! live project by id, the close checklist computed from the project's
//! tables. The rules are
//! `weldsuite_flow_domain::project_closing`.

use std::collections::HashMap;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::js_date;
use weldsuite_flow_domain::project_closing::{
    CloseCounts, CloseFinanceInput, FinanceSnapshot, can_request_close, close_checks,
    close_finance, close_progress, sign_off_state,
};
use weldsuite_flow_domain::raid::{RaidKind, raid_code};

use weldsuite_flow_domain::approvals::{ApprovalRow, list_subject_approvals, sponsor_of};
use weldsuite_schema::tenant::{
    project_baselines as baselines, project_benefit_measurements as measurements,
    project_benefits as benefits, project_change_requests as changes,
    project_deliverables as deliverables, project_finance_snapshots as snapshots,
    project_lessons as lessons, project_raid_items as raid_items, projects, time_entries,
};

use crate::{json_rows, row_json};

pub(crate) const PROJECT_DENIED: &str = "You are not a member of this project";
pub(crate) const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
pub(crate) const PROJECT_MANAGE_DENIED: &str =
    "You must be a project owner, admin, or manager to close this project";

/// `findLiveProject(db, id)`: a live project, as Drizzle reads it.
pub(crate) async fn find_live_project(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    projects::Entity::find_by_id(id.to_owned())
        .filter(projects::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `count(*)`.
fn count_all() -> Expr {
    Expr::from(Func::count(Expr::col(Asterisk)))
}

/// `count(*) filter (where condition)`.
fn count_where(condition: Expr) -> Expr {
    Expr::from(Func::count(Expr::case(condition, 1)))
}

/// A `numeric(…, 2)` as Postgres prints it (`::text`).
fn text2(value: &BigDecimal) -> String {
    value.with_scale(2).to_plain_string()
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

async fn read_tables(db: &PgPool, project_id: &str) -> Result<Tables, DbErr> {
    let conn = orm(db);
    let deliverables = deliverables::Entity::find()
        .filter(deliverables::Column::ProjectId.eq(project_id))
        .filter(deliverables::Column::DeletedAt.is_null())
        .order_by_asc(deliverables::Column::Position)
        .order_by_asc(deliverables::Column::Number)
        .all(&conn)
        .await?;
    let changes: Option<(i64, i64)> = changes::Entity::find()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(
            count_where(changes::Column::Status.is_in(["draft", "assessing", "awaiting_approval"])),
            "open",
        )
        .filter(changes::Column::ProjectId.eq(project_id))
        .filter(changes::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let raid = raid_items::Entity::find()
        .filter(raid_items::Column::ProjectId.eq(project_id))
        .filter(raid_items::Column::DeletedAt.is_null())
        .filter(raid_items::Column::ClosedAt.is_null())
        .all(&conn)
        .await?;
    let benefits = benefits::Entity::find()
        .filter(benefits::Column::ProjectId.eq(project_id))
        .filter(benefits::Column::DeletedAt.is_null())
        .filter(benefits::Column::Status.ne("closed"))
        .order_by_asc(benefits::Column::Number)
        .all(&conn)
        .await?;
    let locked = || time_entries::Column::Status.is_in(["approved", "billed"]);
    let time: Option<(i64, i64, i64, i64, Option<BigDecimal>)> = time_entries::Entity::find()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(
            count_where(time_entries::Column::Status.is_not_in(["approved", "billed"])),
            "open",
        )
        .column_as(
            count_where(time_entries::Column::Status.eq("approved")),
            "approved",
        )
        .column_as(
            count_where(time_entries::Column::Status.eq("billed")),
            "billed",
        )
        .column_as(
            Expr::from(Func::sum(Expr::case(
                locked(),
                Expr::col((time_entries::Entity, time_entries::Column::Cost)),
            ))),
            "cost",
        )
        .filter(time_entries::Column::ProjectId.eq(project_id))
        .filter(time_entries::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let (time_total, time_open, time_approved, time_billed, cost) = time.unwrap_or_default();
    // `coalesce(sum(cost) filter (…), 0)::text`.
    let cost = cost.map_or_else(|| "0".to_owned(), |cost| text2(&cost));
    let lessons: Option<(i64, i64)> = lessons::Entity::find()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(
            count_where(lessons::Column::KnowPageId.is_not_null()),
            "published",
        )
        .filter(lessons::Column::ProjectId.eq(project_id))
        // A sprint's retro cards (FLOW-024) are not the project's lessons.
        .filter(lessons::Column::SprintId.is_null())
        .filter(lessons::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&conn)
        .await?;
    let approvals: Vec<Value> = list_subject_approvals(db, "project_close", project_id)
        .await?
        .iter()
        .map(ApprovalRow::to_json)
        .collect();
    Ok(Tables {
        deliverables: json_rows(deliverables)?,
        changes: changes.unwrap_or_default(),
        raid: json_rows(raid)?,
        benefits: json_rows(benefits)?,
        time: (time_total, time_open, time_approved, time_billed, cost),
        lessons: lessons.unwrap_or_default(),
        approvals,
    })
}

/// The latest measurement of each benefit, by period.
async fn latest_measurements(
    db: &PgPool,
    benefits: &[Value],
) -> Result<HashMap<String, Value>, DbErr> {
    let ids: Vec<&str> = benefits.iter().filter_map(|row| row.text("id")).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = measurements::Entity::find()
        .filter(measurements::Column::BenefitId.is_in(ids))
        .order_by_desc(measurements::Column::Period)
        .order_by_desc(measurements::Column::Id)
        .all(&orm(db))
        .await?;
    let mut latest = HashMap::new();
    for row in json_rows(rows)? {
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
) -> Result<Value, DbErr> {
    let project_id = project.text("id").unwrap_or_default();
    let baseline: Option<(i32, Value)> = baselines::Entity::find()
        .select_only()
        .columns([baselines::Column::Version, baselines::Column::Snapshot])
        .filter(baselines::Column::ProjectId.eq(project_id))
        .order_by_desc(baselines::Column::Version)
        .into_tuple()
        .one(&orm(db))
        .await?;
    let snapshot: Option<(String, BigDecimal, BigDecimal, Option<BigDecimal>)> =
        snapshots::Entity::find()
            .select_only()
            .columns([
                snapshots::Column::Week,
                snapshots::Column::ActualCost,
                snapshots::Column::Committed,
                snapshots::Column::Forecast,
            ])
            .filter(snapshots::Column::ProjectId.eq(project_id))
            .order_by_desc(snapshots::Column::Week)
            .into_tuple()
            .one(&orm(db))
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
            actual_cost: text2(&actual_cost),
            committed: text2(&committed),
            forecast: forecast.as_ref().map(text2),
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
) -> Result<Value, DbErr> {
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
            "sponsorId": sponsor_of(Some(project.at("settings")), project.text("projectManagerId")),
            "approval": latest_approval.map(present_approval),
        },
    }))
}
