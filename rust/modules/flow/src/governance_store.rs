//! Queries the governance routes share (`services/project-decisions.ts`,
//! `project-deliverables.ts`, `project-benefits.ts`): rows as Drizzle reads
//! them, task progress, the register items of a deliverable, the newest
//! measurement of each benefit, and the generic insert and update of a row
//! from its camelCase values.

use std::collections::HashMap;
use std::str::FromStr;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, Order, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::decisions::decision_code;
use weldsuite_flow_domain::raid::{RaidKind, raid_code};
use weldsuite_schema::tenant::{
    project_benefit_measurements as measurements, project_benefits as benefits,
    project_control_links as links, project_decisions as decisions,
    project_deliverables as deliverables, project_raid_items as raid_items, tasks,
};

use crate::raid::columns_of;
use crate::row_json;
use crate::raid_body::Body;

/// `project_deliverables`, written from a body.
pub(crate) const DELIVERABLES: JsonTable = JsonTable::of::<deliverables::Entity>();
/// `project_benefits`, written from a body.
pub(crate) const BENEFITS: JsonTable = JsonTable::of::<benefits::Entity>();

/// `values` (camelCase keys) keyed by their columns.
fn column_values(values: &Body) -> Map<String, Value> {
    match columns_of(values) {
        Value::Object(columns) => columns,
        _ => Map::new(),
    }
}

/// Insert `values` (camelCase keys) into `table`: the row comes from
/// `jsonb_populate_record`, so each value takes its column's type, and a
/// column left out takes its default. The keys are the code's, never a
/// request's.
pub(crate) async fn insert_values(
    db: &PgPool,
    table: JsonTable,
    values: &Body,
) -> Result<(), DbErr> {
    table.insert(&orm(db), column_values(values)).await?;
    Ok(())
}

/// Update the live row `id` of `table` with the keys of `set` (camelCase);
/// the other columns keep their values.
pub(crate) async fn update_values(
    db: &PgPool,
    table: JsonTable,
    set: &Body,
    id: &str,
) -> Result<(), DbErr> {
    table.update(&orm(db), id, column_values(set), true).await?;
    Ok(())
}

// ── Decisions ───────────────────────────────────────────────────────────────

/// `findDecision(db, id)`: a live decision.
pub(crate) async fn find_decision(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    decisions::Entity::find_by_id(id.to_owned())
        .filter(decisions::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `{ id, code, title }` of a decision.
fn decision_ref((id, number, title): (String, i32, String)) -> Value {
    serde_json::json!({ "id": id, "code": decision_code(i64::from(number)), "title": title })
}

/// `select({ id, number, title })` of the live decisions.
fn decision_refs() -> sea_orm::Select<decisions::Entity> {
    decisions::Entity::find()
        .select_only()
        .columns([
            decisions::Column::Id,
            decisions::Column::Number,
            decisions::Column::Title,
        ])
        .filter(decisions::Column::DeletedAt.is_null())
}

/// `findDecisionRef(db, id)`: a decision named by another, as
/// `{ id, code, title }`; `None` when there is none or it is gone.
pub(crate) async fn find_decision_ref(
    db: &PgPool,
    id: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    let Some(id) = id else {
        return Ok(None);
    };
    let row: Option<(String, i32, String)> = decision_refs()
        .filter(decisions::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(decision_ref))
}

/// `decisionsReplacedBy(db, id)`: the live decisions a decision replaced,
/// lowest number first.
pub(crate) async fn decisions_replaced_by(db: &PgPool, id: &str) -> Result<Vec<Value>, DbErr> {
    let rows: Vec<(String, i32, String)> = decision_refs()
        .filter(decisions::Column::SupersededById.eq(id))
        .order_by_asc(decisions::Column::Number)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(decision_ref).collect())
}

// ── Deliverables ────────────────────────────────────────────────────────────

/// `findDeliverable(db, id)`: a live deliverable.
pub(crate) async fn find_deliverable(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    deliverables::Entity::find_by_id(id.to_owned())
        .filter(deliverables::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `taskProgressForDeliverables(db, ids)`: per deliverable, the live,
/// non-cancelled tasks that count toward it, as `(done, total)`. One with none
/// is absent.
pub(crate) async fn task_progress_for_deliverables(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, (i64, i64)>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64, i64)> = tasks::Entity::find()
        .select_only()
        .column(tasks::Column::DeliverableId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total")
        .column_as(
            Expr::from(Func::count(Expr::case(
                tasks::Column::Status.eq("done"),
                1,
            ))),
            "done",
        )
        .filter(tasks::Column::DeliverableId.is_in(ids))
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(tasks::Column::Status.ne("cancelled"))
        .group_by(tasks::Column::DeliverableId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, total, done)| (id, (done, total)))
        .collect())
}

/// `innerJoin(projectRaidItems, eq(projectRaidItems.id, links.fromId))`.
fn link_source() -> RelationDef {
    links::Entity::belongs_to(raid_items::Entity)
        .from(links::Column::FromId)
        .to(raid_items::Column::Id)
        .into()
}

/// `raidForDeliverables(db, ids)`: the register items that affect or threaten
/// each deliverable, oldest link first.
pub(crate) async fn raid_for_deliverables(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String, String, i32, String)> = links::Entity::find()
        .select_only()
        .column(links::Column::ToId)
        .column(raid_items::Column::Id)
        .column(raid_items::Column::Kind)
        .column(raid_items::Column::Number)
        .column(raid_items::Column::Title)
        .join(JoinType::InnerJoin, link_source())
        .filter(links::Column::ToType.eq("deliverable"))
        .filter(links::Column::ToId.is_in(ids))
        .filter(links::Column::FromType.eq("raid_item"))
        .filter(links::Column::Relation.is_in(["affects", "threatens"]))
        .filter(raid_items::Column::DeletedAt.is_null())
        .order_by_asc(links::Column::CreatedAt)
        .order_by_asc(links::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    for (deliverable_id, id, kind, number, title) in rows {
        let code = RaidKind::parse(&kind)
            .map_or_else(String::new, |kind| raid_code(kind, i64::from(number)));
        out.entry(deliverable_id)
            .or_default()
            .push(serde_json::json!({
                "id": id, "kind": kind, "code": code, "title": title,
            }));
    }
    Ok(out)
}

/// `nextDeliverablePosition(db, projectId)`: after the last live deliverable.
pub(crate) async fn next_deliverable_position(
    db: &PgPool,
    project_id: &str,
) -> Result<i64, DbErr> {
    let max: Option<Option<i32>> = deliverables::Entity::find()
        .select_only()
        .column_as(deliverables::Column::Position.max(), "max")
        .filter(deliverables::Column::ProjectId.eq(project_id))
        .filter(deliverables::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(i64::from(max.flatten().unwrap_or(0)) + 1)
}

// ── Benefits ────────────────────────────────────────────────────────────────

/// `findBenefit(db, id)`: a live benefit, `numeric` columns as text.
pub(crate) async fn find_benefit(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    benefits::Entity::find_by_id(id.to_owned())
        .filter(benefits::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `latestMeasurements(db, benefitIds)`: the newest measurement of each
/// benefit (by month); a benefit with none is absent.
pub(crate) async fn latest_measurements(
    db: &PgPool,
    benefit_ids: &[String],
) -> Result<HashMap<String, Value>, DbErr> {
    if benefit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // `select distinct on (benefit_id) id … order by benefit_id, period desc`.
    let newest = Query::select()
        .column(measurements::Column::Id)
        .distinct_on([measurements::Column::BenefitId])
        .from(measurements::Entity)
        .and_where(measurements::Column::BenefitId.is_in(benefit_ids))
        .order_by(measurements::Column::BenefitId, Order::Asc)
        .order_by(measurements::Column::Period, Order::Desc)
        .to_owned();
    let rows = measurements::Entity::find()
        .filter(measurements::Column::Id.in_subquery(newest))
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| Ok((row.benefit_id.clone(), row_json(row)?)))
        .collect()
}

/// `measurementsOf(db, benefitId)`: every measurement, oldest month first.
pub(crate) async fn measurements_of(db: &PgPool, benefit_id: &str) -> Result<Vec<Value>, DbErr> {
    measurements::Entity::find()
        .filter(measurements::Column::BenefitId.eq(benefit_id))
        .order_by_asc(measurements::Column::Period)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// An ISO timestamp (`now`) as the `timestamptz` it is bound as.
fn timestamptz(text: &str) -> Result<OffsetDateTime, DbErr> {
    OffsetDateTime::parse(text, &Rfc3339).map_err(|error| DbErr::Type(error.to_string()))
}

/// `upsertMeasurement(db, ...)`: store a month's value. A manual entry
/// (`measured_by` set) replaces whatever the month holds; the monthly sweep
/// (`measured_by` null) never overwrites a value somebody typed in. The first
/// value of a planned benefit starts its measuring.
pub(crate) async fn upsert_measurement(
    db: &PgPool,
    benefit_id: &str,
    project_id: &str,
    period: &str,
    value: &str,
    measured_by: Option<&str>,
    now: &str,
) -> Result<(), DbErr> {
    let db = orm(db);
    let at = timestamptz(now)?;
    let value = BigDecimal::from_str(value).map_err(|error| DbErr::Type(error.to_string()))?;
    let mut upsert = OnConflict::columns([
        measurements::Column::BenefitId,
        measurements::Column::Period,
    ]);
    upsert.update_columns([
        measurements::Column::Value,
        measurements::Column::MeasuredAt,
        measurements::Column::MeasuredBy,
    ]);
    // `where ($by is not null or measured_by is null)`: a sweep's value never
    // replaces one somebody typed in.
    if measured_by.is_none() {
        upsert.action_and_where(measurements::Column::MeasuredBy.is_null());
    }
    measurements::Entity::insert(measurements::ActiveModel {
        id: Set(weldsuite_kit::generate_id("bmea")),
        benefit_id: Set(benefit_id.to_owned()),
        project_id: Set(project_id.to_owned()),
        period: Set(period.to_owned()),
        value: Set(value),
        measured_at: Set(at),
        measured_by: Set(measured_by.map(str::to_owned)),
        created_at: Set(at),
    })
    .on_conflict(upsert)
    .exec_without_returning(&db)
    .await?;
    benefits::Entity::update_many()
        .col_expr(benefits::Column::Status, Expr::value("measuring"))
        .col_expr(benefits::Column::UpdatedAt, Expr::value(at))
        .filter(benefits::Column::Id.eq(benefit_id))
        .filter(benefits::Column::Status.eq("planned"))
        .filter(benefits::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    Ok(())
}
