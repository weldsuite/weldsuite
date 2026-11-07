//! Cycles, a team's time-boxed iterations: `/api/merge/cycles`. Reading
//! needs `merge_teams:read`, changing a cycle `merge_teams:manage`. Numbers
//! run per team and are never reused; deleting a cycle leaves its issues
//! without one.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::db::{Row, is_unique_violation, one_by_id, rows_of, text};
use crate::mappers::cycle_dto;
use crate::schemas::{aborted, date_only, js_string_ge, nothing_to_update};
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate, validate_query,
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
async fn counts(db: &PgPool, rows: &[Row]) -> Result<HashMap<String, (i64, i64)>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let found: Vec<(Option<String>, i32, i32)> = sqlx::query_as(
        "select cycle_id, count(*)::int, count(*) filter (where status = 'done')::int \
         from merge_issues where cycle_id = any($1) and deleted_at is null group by cycle_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(found
        .into_iter()
        .filter_map(|(id, total, done)| id.map(|id| (id, (i64::from(total), i64::from(done)))))
        .collect())
}

async fn dto(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
    let counts = counts(db, std::slice::from_ref(row)).await?;
    let (total, done) = counts.get(text(row, "id")).copied().unwrap_or((0, 0));
    Ok(cycle_dto(row, total, done))
}

async fn find_cycle(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(c) from merge_cycles c where c.id = $1 and c.deleted_at is null limit 1",
        id,
    )
    .await
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
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(c) from merge_cycles c where c.deleted_at is null \
             and ($1::text is null or c.team_id = $1) \
             order by c.team_id asc, c.number desc",
        )
        .bind(team_id)
        .fetch_all(&caller.db)
        .await?,
    );
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
    let mut attempt = 0;
    let row = loop {
        // Numbers are never reused, so the max includes deleted cycles.
        let last: Option<i32> =
            sqlx::query_scalar("select max(number)::int from merge_cycles where team_id = $1")
                .bind(&team_id)
                .fetch_one(&caller.db)
                .await?;
        let now = now();
        let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
            "insert into merge_cycles (id, team_id, number, name, starts_at, ends_at, created_at, updated_at) \
             values ($1, $2, $3, $4, $5::date, $6::date, $7::timestamptz, $7::timestamptz) \
             returning to_jsonb(merge_cycles.*)",
        )
        .bind(generate_id("mcy"))
        .bind(&team_id)
        .bind(last.unwrap_or(0) + 1)
        .bind(&name)
        .bind(&starts_at)
        .bind(&ends_at)
        .bind(&now)
        .fetch_one(&caller.db)
        .await;
        match inserted {
            Ok(row) => break weldsuite_db::js_row(row),
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
    let row: Value = sqlx::query_scalar(
        "update merge_cycles set updated_at = $2::timestamptz, starts_at = $3::date, ends_at = $4::date, \
           name = case when $5 then $6 else name end \
         where id = $1 returning to_jsonb(merge_cycles.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(&starts_at)
    .bind(&ends_at)
    .bind(set_name)
    .bind(cycle_name(name))
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
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
    let now = now();
    sqlx::query(
        "update merge_issues set cycle_id = null, updated_at = $2::timestamptz where cycle_id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    let row: Value = sqlx::query_scalar(
        "update merge_cycles set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_cycles.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![cycle_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}
