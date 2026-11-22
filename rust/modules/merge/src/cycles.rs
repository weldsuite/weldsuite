//! Cycles, a team's time-boxed iterations: `/api/merge/cycles`. Reading
//! needs `merge_teams:read`, changing a cycle `merge_teams:manage`. Numbers
//! run per team and are never reused; deleting a cycle leaves its issues
//! without one.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{merge_cycles, merge_issues};

use crate::db::{Row, date, is_unique_violation, json_row, json_rows, now_at, text};
use crate::mappers::cycle_dto;
use crate::schemas::{aborted, date_only, js_string_ge, nothing_to_update};
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, all, publish, validate, validate_query,
};

const RANGE: &str = "The cycle must end on or after its start";

fn cycle_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_cycle",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "teamId": row["teamId"], "number": row["number"], "name": row["name"] }),
    )
}

/// Issues in each cycle, and how many are done (`withCounts`).
async fn counts(db: &PgPool, rows: &[Row]) -> Result<HashMap<String, (i64, i64)>, DbErr> {
    if rows.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let done = Expr::case(merge_issues::Column::Status.eq("done"), 1);
    let found: Vec<(Option<String>, i64, i64)> = merge_issues::Entity::find()
        .select_only()
        .column(merge_issues::Column::CycleId)
        .column_as(merge_issues::Column::Id.count(), "total")
        .column_as(Expr::from(Func::count(done)), "done")
        .filter(merge_issues::Column::CycleId.is_in(ids))
        .filter(merge_issues::Column::DeletedAt.is_null())
        .group_by(merge_issues::Column::CycleId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .filter_map(|(id, total, done)| id.map(|id| (id, (total, done))))
        .collect())
}

async fn dto(db: &PgPool, row: &Row) -> Result<Value, DbErr> {
    let counts = counts(db, std::slice::from_ref(row)).await?;
    let (total, done) = counts.get(text(row, "id")).copied().unwrap_or((0, 0));
    Ok(cycle_dto(row, total, done))
}

fn cycle_row(cycle: merge_cycles::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(cycle))
}

async fn find_cycle(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_cycles::Entity::find_by_id(id.to_owned())
        .filter(merge_cycles::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(cycle_row)
        .transpose()
}

/// `input.name?.trim() || null`.
fn cycle_name(name: Field<String>) -> Option<String> {
    name.into_option()
        .map(|n| weldsuite_kit::validation::js_trim(&n).to_owned())
        .filter(|n| !n.is_empty())
}

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let team_id = validate_query(query.as_deref(), |issues, fields| {
        issues
            .text(fields, "teamId", Presence::Optional, None, None)
            .into_option()
    })?;
    let team_id = team_id.filter(|t| !t.is_empty());
    let mut select =
        merge_cycles::Entity::find().filter(merge_cycles::Column::DeletedAt.is_null());
    if let Some(team_id) = team_id {
        select = select.filter(merge_cycles::Column::TeamId.eq(team_id));
    }
    let rows = json_rows(
        select
            .order_by_asc(merge_cycles::Column::TeamId)
            .order_by_desc(merge_cycles::Column::Number)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    let counts = counts(&caller.db, &rows).await?;
    Ok(all(rows
        .iter()
        .map(|row| {
            let (total, done) = counts.get(text(row, "id")).copied().unwrap_or((0, 0));
            cycle_dto(row, total, done)
        })
        .collect()))
}

pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (team_id, name, starts_at, ends_at) = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let read = (
            issues.text(fields, "teamId", Presence::Required, Some(1), None),
            issues.text_with(
                fields,
                "name",
                Presence::Nullish,
                Text::trimmed(None, Some(255)),
            ),
            date_only(issues, fields, "startsAt", Presence::Required),
            date_only(issues, fields, "endsAt", Presence::Required),
        );
        // `.refine((v) => v.endsAt >= v.startsAt, { path: ['endsAt'] })`, on
        // the values as they parsed (a failed regex still runs it).
        if !aborted(issues, start)
            && let (Some(Value::String(starts)), Some(Value::String(ends))) =
                (fields.get("startsAt"), fields.get("endsAt"))
            && !js_string_ge(ends, starts)
        {
            issues.custom("endsAt", RANGE);
        }
        read
    })?;
    let team_id = team_id.into_option().unwrap_or_default();
    if find_team(&caller.db, &team_id).await?.is_none() {
        return Err(Refusal::not_found("Team", None));
    }
    let name = cycle_name(name);
    let starts_at = starts_at.into_option().unwrap_or_default();
    let ends_at = ends_at.into_option().unwrap_or_default();
    let db = orm(&caller.db);
    let mut attempt = 0;
    let row = loop {
        // Numbers are never reused, so the max includes deleted cycles.
        let last: Option<i32> = merge_cycles::Entity::find()
            .select_only()
            .column_as(merge_cycles::Column::Number.max(), "max")
            .filter(merge_cycles::Column::TeamId.eq(&team_id))
            .into_tuple::<Option<i32>>()
            .one(&db)
            .await?
            .flatten();
        let (_, at) = now_at();
        let inserted = merge_cycles::Entity::insert(merge_cycles::ActiveModel {
            id: Set(generate_id("mcy")),
            team_id: Set(team_id.clone()),
            number: Set(last.unwrap_or(0) + 1),
            name: Set(name.clone()),
            starts_at: Set(date(&starts_at)?),
            ends_at: Set(date(&ends_at)?),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_with_returning(&db)
        .await;
        match inserted {
            Ok(row) => break cycle_row(row)?,
            // Two cycles created at once picked the same number: take the next.
            Err(error) if is_unique_violation(&error) && attempt < 2 => attempt += 1,
            Err(error) => return Err(error.into()),
        }
    };
    publish(&state, &caller.events, vec![cycle_event(&row, "created")]);
    Ok(Created(cycle_dto(&row, 0, 0)).into_response())
}

pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (name, starts_at, ends_at) = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let read = (
            issues.text_with(
                fields,
                "name",
                Presence::Nullish,
                Text::trimmed(None, Some(255)),
            ),
            date_only(issues, fields, "startsAt", Presence::Optional),
            date_only(issues, fields, "endsAt", Presence::Optional),
        );
        nothing_to_update(issues, start, fields, &["name", "startsAt", "endsAt"]);
        read
    })?;
    let Some(existing) = find_cycle(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Cycle", Some(&id)));
    };
    let starts_at = starts_at
        .into_option()
        .unwrap_or_else(|| text(&existing, "startsAt").to_owned());
    let ends_at = ends_at
        .into_option()
        .unwrap_or_else(|| text(&existing, "endsAt").to_owned());
    if !js_string_ge(&ends_at, &starts_at) {
        return Err(Refusal::unprocessable(RANGE));
    }
    let set_name = !name.is_absent();
    let (_, at) = now_at();
    let mut cycle = merge_cycles::ActiveModel {
        id: Unchanged(id.clone()),
        updated_at: Set(at),
        starts_at: Set(date(&starts_at)?),
        ends_at: Set(date(&ends_at)?),
        ..Default::default()
    };
    if set_name {
        cycle.name = Set(cycle_name(name));
    }
    let row = cycle_row(cycle.update(&orm(&caller.db)).await?)?;
    let dto = dto(&caller.db, &row).await?;
    publish(&state, &caller.events, vec![cycle_event(&row, "updated")]);
    Ok(Data(dto).into_response())
}

/// Soft-deletes the cycle; its issues keep everything else and lose the cycle.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    if find_cycle(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Cycle", Some(&id)));
    }
    let (_, at) = now_at();
    let db = orm(&caller.db);
    merge_issues::Entity::update_many()
        .col_expr(
            merge_issues::Column::CycleId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(merge_issues::Column::UpdatedAt, Expr::value(at))
        .filter(merge_issues::Column::CycleId.eq(&id))
        .exec(&db)
        .await?;
    let row = cycle_row(
        merge_cycles::ActiveModel {
            id: Unchanged(id.clone()),
            deleted_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        }
        .update(&db)
        .await?,
    )?;
    publish(&state, &caller.events, vec![cycle_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}
