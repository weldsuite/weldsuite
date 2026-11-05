//! Queries the governance routes share (`services/project-decisions.ts`,
//! `project-deliverables.ts`, `project-benefits.ts`): rows as Drizzle reads
//! them, task progress, the register items of a deliverable, the newest
//! measurement of each benefit, and the generic insert and update of a row
//! from its camelCase values.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use sqlx::{AssertSqlSafe, PgPool, Postgres};
use weldsuite_db::js_row;
use weldsuite_flow_domain::decisions::decision_code;
use weldsuite_flow_domain::raid::{RaidKind, raid_code};

use crate::raid::columns_of;
use crate::raid_body::Body;

/// `camelCase` → `snake_case`, for a column.
fn snake(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The statement of an insert of `values` (camelCase keys) into `table`: the row
/// comes from `jsonb_populate_record`, so each value takes its column's type.
/// The table and the column names are the code's, never a request's.
pub(crate) fn insert_statement(
    table: &str,
    values: &Body,
) -> Query<'static, Postgres, PgArguments> {
    let columns: Vec<String> = values.keys().map(|key| snake(key)).collect();
    let list = columns.join(", ");
    let selected = columns
        .iter()
        .map(|column| format!("p.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "insert into {table} ({list}) select {selected} from jsonb_populate_record(null::{table}, $1) p"
    );
    sqlx::query(AssertSqlSafe(sql)).bind(columns_of(values))
}

/// The statement of an update of the live row of `table` with the keys of
/// `set` (camelCase); the other columns keep their values.
pub(crate) fn update_statement(
    table: &str,
    set: &Body,
    id: &str,
) -> Query<'static, Postgres, PgArguments> {
    let columns: Vec<String> = set.keys().map(|key| snake(key)).collect();
    let list = columns.join(", ");
    let selected = columns
        .iter()
        .map(|column| format!("p.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "update {table} r set ({list}) = (select {selected} from jsonb_populate_record(r, $1) p)
         where r.id = $2 and r.deleted_at is null"
    );
    sqlx::query(AssertSqlSafe(sql))
        .bind(columns_of(set))
        .bind(id.to_owned())
}

// ── Decisions ───────────────────────────────────────────────────────────────

/// `findDecision(db, id)`: a live decision.
pub(crate) async fn find_decision(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_decisions d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `findDecisionRef(db, id)`: a decision named by another, as
/// `{ id, code, title }`; `None` when there is none or it is gone.
pub(crate) async fn find_decision_ref(
    db: &PgPool,
    id: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(id) = id else {
        return Ok(None);
    };
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "select id, number, title from project_decisions
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, number, title)| {
        serde_json::json!({ "id": id, "code": decision_code(i64::from(number)), "title": title })
    }))
}

/// `decisionsReplacedBy(db, id)`: the live decisions a decision replaced,
/// lowest number first.
pub(crate) async fn decisions_replaced_by(
    db: &PgPool,
    id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<(String, i32, String)> = sqlx::query_as(
        "select id, number, title from project_decisions
         where superseded_by_id = $1 and deleted_at is null order by number asc",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, number, title)| {
            serde_json::json!({ "id": id, "code": decision_code(i64::from(number)), "title": title })
        })
        .collect())
}

// ── Deliverables ────────────────────────────────────────────────────────────

/// `findDeliverable(db, id)`: a live deliverable.
pub(crate) async fn find_deliverable(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from project_deliverables d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `taskProgressForDeliverables(db, ids)`: per deliverable, the live,
/// non-cancelled tasks that count toward it, as `(done, total)`. One with none
/// is absent.
pub(crate) async fn task_progress_for_deliverables(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, (i64, i64)>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "select t.deliverable_id, count(*)::int8,
                (count(*) filter (where t.status = 'done'))::int8
         from tasks t
         where t.deliverable_id = any($1) and t.deleted_at is null and t.status <> 'cancelled'
         group by t.deliverable_id",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, total, done)| (id, (done, total)))
        .collect())
}

/// `raidForDeliverables(db, ids)`: the register items that affect or threaten
/// each deliverable, oldest link first.
pub(crate) async fn raid_for_deliverables(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, sqlx::Error> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String, String, i32, String)> = sqlx::query_as(
        "select l.to_id, i.id, i.kind, i.number, i.title
         from project_control_links l
         inner join project_raid_items i on i.id = l.from_id
         where l.to_type = 'deliverable' and l.to_id = any($1) and l.from_type = 'raid_item'
           and l.relation = any($2) and i.deleted_at is null
         order by l.created_at asc, l.id asc",
    )
    .bind(ids)
    .bind(["affects", "threatens"].as_slice())
    .fetch_all(db)
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
) -> Result<i64, sqlx::Error> {
    let max: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from project_deliverables
         where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    Ok(i64::from(max) + 1)
}

// ── Benefits ────────────────────────────────────────────────────────────────

/// `findBenefit(db, id)`: a live benefit, `numeric` columns as text.
pub(crate) async fn find_benefit(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        benefit_json!("b"),
        " from project_benefits b where b.id = $1 and b.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `latestMeasurements(db, benefitIds)`: the newest measurement of each
/// benefit (by month); a benefit with none is absent.
pub(crate) async fn latest_measurements(
    db: &PgPool,
    benefit_ids: &[String],
) -> Result<HashMap<String, Value>, sqlx::Error> {
    if benefit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        measurement_json!("m"),
        " from project_benefit_measurements m where m.id in (",
        "select distinct on (benefit_id) id from project_benefit_measurements",
        " where benefit_id = any($1) order by benefit_id, period desc)"
    ))
    .bind(benefit_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .filter_map(|row| {
            row["benefitId"]
                .as_str()
                .map(str::to_owned)
                .map(|id| (id, row))
        })
        .collect())
}

/// `measurementsOf(db, benefitId)`: every measurement, oldest month first.
pub(crate) async fn measurements_of(
    db: &PgPool,
    benefit_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        measurement_json!("m"),
        " from project_benefit_measurements m where m.benefit_id = $1 order by m.period asc"
    ))
    .bind(benefit_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
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
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into project_benefit_measurements
             (id, benefit_id, project_id, period, value, measured_at, measured_by, created_at)
         values ($1, $2, $3, $4, $5::numeric, $6::timestamptz, $7, $6::timestamptz)
         on conflict (benefit_id, period) do update
             set value = excluded.value, measured_at = excluded.measured_at,
                 measured_by = excluded.measured_by
             where ($7::text is not null or project_benefit_measurements.measured_by is null)",
    )
    .bind(weldsuite_kit::generate_id("bmea"))
    .bind(benefit_id)
    .bind(project_id)
    .bind(period)
    .bind(value)
    .bind(now)
    .bind(measured_by)
    .execute(db)
    .await?;
    sqlx::query(
        "update project_benefits set status = 'measuring', updated_at = $2::timestamptz
         where id = $1 and status = 'planned' and deleted_at is null",
    )
    .bind(benefit_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
