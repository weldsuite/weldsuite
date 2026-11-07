//! Teams, the owners of issues (`PLAT`): `/api/merge/teams`.
//!
//! ```text
//!   GET    /      → teams, with their open issue counts   (merge_teams:read)
//!   GET    /:id   → one team                              (merge_teams:read)
//!   POST   /      → new team                              (merge_teams:manage)
//!   PATCH  /:id   → name, description, colour; the key only while the team has no issues (409)
//!   DELETE /:id   → refused (409) while the team has live issues
//! ```

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::db::{Row, int, is_unique_violation, one_by_id, rows_of, text};
use crate::mappers::team_dto;
use crate::schemas::{color, nothing_to_update, team_key};
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate};

/// Open (not done or canceled, not deleted) issue counts by team id.
async fn open_issue_counts(
    db: &PgPool,
    team_ids: &[String],
) -> Result<HashMap<String, i64>, sqlx::Error> {
    if team_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "select team_id, count(*)::int from merge_issues \
         where team_id = any($1) and deleted_at is null and status not in ('done', 'canceled') \
         group by team_id",
    )
    .bind(team_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, count)| (id, i64::from(count)))
        .collect())
}

/// `findTeam(db, id)`: a live team.
pub(crate) async fn find_team(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(t) from merge_teams t where t.id = $1 and t.deleted_at is null limit 1",
        id,
    )
    .await
}

async fn key_taken(db: &PgPool, key: &str, except: Option<&str>) -> Result<bool, sqlx::Error> {
    let ids: Vec<String> =
        sqlx::query_scalar("select id from merge_teams where key = $1 and deleted_at is null")
            .bind(key)
            .fetch_all(db)
            .await?;
    Ok(ids.iter().any(|id| Some(id.as_str()) != except))
}

fn team_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_team",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "key": row["key"], "name": row["name"] }),
    )
}

async fn dto(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
    let id = text(row, "id").to_owned();
    let counts = open_issue_counts(db, std::slice::from_ref(&id)).await?;
    Ok(team_dto(row, counts.get(&id).copied().unwrap_or(0)))
}

// ── GET / and GET /:id ──────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    let result: Result<Vec<Value>, sqlx::Error> = async {
        let rows = rows_of(
            sqlx::query_scalar(
                "select to_jsonb(t) from merge_teams t where t.deleted_at is null order by t.key asc",
            )
            .fetch_all(&caller.db)
            .await?,
        );
        let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
        let counts = open_issue_counts(&caller.db, &ids).await?;
        Ok(rows
            .iter()
            .map(|row| team_dto(row, counts.get(text(row, "id")).copied().unwrap_or(0)))
            .collect())
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => Refusal::from(error).into_response(),
    }
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let Some(row) = find_team(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Team", Some(&id)));
    };
    Ok(Data(dto(&caller.db, &row).await?).into_response())
}

// ── POST / and PATCH /:id ───────────────────────────────────────────────────

struct TeamInput {
    key: Field<String>,
    name: Field<String>,
    description: Field<String>,
    color: Field<String>,
}

/// `createMergeTeamSchema`, or its `.partial().refine(nonEmpty)`.
fn team_input(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<TeamInput, Refusal> {
    validate(headers, body, |issues, fields| {
        let required = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        let start = issues.count();
        let input = TeamInput {
            key: team_key(issues, fields, required),
            name: issues.text_with(fields, "name", required, Text::trimmed(Some(1), Some(255))),
            description: issues.text_with(
                fields,
                "description",
                Presence::Nullish,
                Text::trimmed(None, Some(2000)),
            ),
            color: color(issues, fields, Presence::Nullish),
        };
        if partial {
            nothing_to_update(
                issues,
                start,
                fields,
                &["key", "name", "description", "color"],
            );
        }
        input
    })
}

/// A nullish text field as `(set, value)` for an update.
fn patch_of(field: &Field<String>) -> (bool, Option<String>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = team_input(&headers, &body, false)?;
    let key = input.key.into_option().unwrap_or_default();
    if key_taken(&caller.db, &key, None).await? {
        return Err(Refusal::conflict("A team with this key already exists"));
    }
    let now = now();
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into merge_teams (id, key, name, description, color, created_by_user_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz) \
         returning to_jsonb(merge_teams.*)",
    )
    .bind(generate_id("mtm"))
    .bind(&key)
    .bind(input.name.into_option().unwrap_or_default())
    .bind(input.description.into_option())
    .bind(input.color.into_option())
    .bind(&caller.user_id)
    .bind(&now)
    .fetch_one(&caller.db)
    .await;
    let row = match inserted {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) if is_unique_violation(&error) => {
            return Err(Refusal::conflict("A team with this key already exists"));
        }
        Err(error) => return Err(error.into()),
    };
    publish(&state, &caller.events, vec![team_event(&row, "created")]);
    Ok(Created(team_dto(&row, 0)).into_response())
}

pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = team_input(&headers, &body, true)?;
    let Some(existing) = find_team(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Team", Some(&id)));
    };
    let mut new_key: Option<String> = None;
    if let Field::Set(key) = &input.key
        && key != text(&existing, "key")
    {
        if int(&existing, "issueCounter") > 0 {
            return Err(Refusal::conflict(
                "The key cannot change once the team has issues",
            ));
        }
        if key_taken(&caller.db, key, Some(&id)).await? {
            return Err(Refusal::conflict("A team with this key already exists"));
        }
        new_key = Some(key.clone());
    }
    let name = match &input.name {
        Field::Set(name) => Some(name.clone()),
        _ => None,
    };
    let (set_description, description) = patch_of(&input.description);
    let (set_color, color) = patch_of(&input.color);
    let updated: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "update merge_teams set updated_at = $2::timestamptz, \
           key = case when $3::text is null then key else $3 end, \
           name = case when $4::text is null then name else $4 end, \
           description = case when $5 then $6 else description end, \
           color = case when $7 then $8 else color end \
         where id = $1 returning to_jsonb(merge_teams.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(new_key)
    .bind(name)
    .bind(set_description)
    .bind(description)
    .bind(set_color)
    .bind(color)
    .fetch_one(&caller.db)
    .await;
    let row = match updated {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) if is_unique_violation(&error) => {
            return Err(Refusal::conflict("A team with this key already exists"));
        }
        Err(error) => return Err(error.into()),
    };
    let dto = dto(&caller.db, &row).await?;
    publish(&state, &caller.events, vec![team_event(&row, "updated")]);
    Ok(Data(dto).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// Soft-deletes a team that has no live issues, with its cycles and labels;
/// its repositories lose the team.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    if find_team(db, &id).await?.is_none() {
        return Err(Refusal::not_found("Team", Some(&id)));
    }
    let live: Option<String> = sqlx::query_scalar(
        "select id from merge_issues where team_id = $1 and deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(db)
    .await?;
    if live.is_some() {
        return Err(Refusal::conflict(
            "The team still has issues. Move or delete them first",
        ));
    }
    let now = now();
    sqlx::query(
        "update merge_cycles set deleted_at = $2::timestamptz where team_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update merge_labels set deleted_at = $2::timestamptz where team_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update merge_repositories set team_id = null, updated_at = $2::timestamptz where team_id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(db)
    .await?;
    let row: Value = sqlx::query_scalar(
        "update merge_teams set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_teams.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![team_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}
