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
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, is_unique_violation, orm, utc_now};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{
    merge_cycles, merge_issues, merge_labels, merge_repositories, merge_teams,
};

use crate::db::{Row, int, text};
use crate::mappers::team_dto;
use crate::schemas::{color, nothing_to_update, team_key};
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, publish, validate};

/// A row as Drizzle returned it: the entity's JSON (`serde_json::to_value`
/// of the model).
fn js(row: serde_json::Result<Value>) -> Result<Row, DbErr> {
    row.map_err(|error| DbErr::Json(error.to_string()))
}

/// The row a `.returning()` update answers with: none is the error
/// `fetch_one` raised (the route's 500).
fn returned(rows: Vec<merge_teams::Model>) -> Result<Row, DbErr> {
    let team = rows
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("merge_teams".to_owned()))?;
    js(serde_json::to_value(team))
}

/// Open (not done or canceled, not deleted) issue counts by team id.
async fn open_issue_counts(
    db: &PgPool,
    team_ids: &[String],
) -> Result<HashMap<String, i64>, DbErr> {
    if team_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64)> = merge_issues::Entity::find()
        .select_only()
        .column(merge_issues::Column::TeamId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(merge_issues::Column::TeamId.is_in(team_ids.iter().cloned()))
        .filter(merge_issues::Column::DeletedAt.is_null())
        .filter(merge_issues::Column::Status.is_not_in(["done", "canceled"]))
        .group_by(merge_issues::Column::TeamId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}

/// `findTeam(db, id)`: a live team.
pub(crate) async fn find_team(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_teams::Entity::find_by_id(id.to_owned())
        .filter(merge_teams::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|team| js(serde_json::to_value(team)))
        .transpose()
}

async fn key_taken(db: &PgPool, key: &str, except: Option<&str>) -> Result<bool, DbErr> {
    let ids: Vec<String> = merge_teams::Entity::find()
        .select_only()
        .column(merge_teams::Column::Id)
        .filter(merge_teams::Column::Key.eq(key))
        .filter(merge_teams::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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

async fn dto(db: &PgPool, row: &Row) -> Result<Value, DbErr> {
    let id = text(row, "id").to_owned();
    let counts = open_issue_counts(db, std::slice::from_ref(&id)).await?;
    Ok(team_dto(row, counts.get(&id).copied().unwrap_or(0)))
}

// ── GET / and GET /:id ──────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    let result: Result<Vec<Value>, DbErr> = async {
        let rows = merge_teams::Entity::find()
            .filter(merge_teams::Column::DeletedAt.is_null())
            .order_by_asc(merge_teams::Column::Key)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(|team| js(serde_json::to_value(team)))
            .collect::<Result<Vec<Row>, DbErr>>()?;
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
    let at = utc_now().assume_utc();
    let inserted = merge_teams::Entity::insert(merge_teams::ActiveModel {
        id: Set(generate_id("mtm")),
        key: Set(key),
        name: Set(input.name.into_option().unwrap_or_default()),
        description: Set(input.description.into_option()),
        color: Set(input.color.into_option()),
        created_by_user_id: Set(caller.user_id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await;
    let row = match inserted {
        Ok(row) => js(serde_json::to_value(row))?,
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
    let mut change = merge_teams::Entity::update_many().col_expr(
        merge_teams::Column::UpdatedAt,
        Expr::value(utc_now().assume_utc()),
    );
    if let Some(key) = new_key {
        change = change.col_expr(merge_teams::Column::Key, Expr::value(key));
    }
    if let Some(name) = name {
        change = change.col_expr(merge_teams::Column::Name, Expr::value(name));
    }
    if set_description {
        change = change.col_expr(merge_teams::Column::Description, Expr::value(description));
    }
    if set_color {
        change = change.col_expr(merge_teams::Column::Color, Expr::value(color));
    }
    let updated = change
        .filter(merge_teams::Column::Id.eq(&id))
        .exec_with_returning(&orm(&caller.db))
        .await;
    let row = match updated {
        Ok(rows) => returned(rows)?,
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
    let orm = orm(db);
    let live: Option<String> = merge_issues::Entity::find()
        .select_only()
        .column(merge_issues::Column::Id)
        .filter(merge_issues::Column::TeamId.eq(&id))
        .filter(merge_issues::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm)
        .await?;
    if live.is_some() {
        return Err(Refusal::conflict(
            "The team still has issues. Move or delete them first",
        ));
    }
    let at = utc_now().assume_utc();
    merge_cycles::Entity::update_many()
        .col_expr(merge_cycles::Column::DeletedAt, Expr::value(at))
        .filter(merge_cycles::Column::TeamId.eq(&id))
        .filter(merge_cycles::Column::DeletedAt.is_null())
        .exec(&orm)
        .await?;
    merge_labels::Entity::update_many()
        .col_expr(merge_labels::Column::DeletedAt, Expr::value(at))
        .filter(merge_labels::Column::TeamId.eq(&id))
        .filter(merge_labels::Column::DeletedAt.is_null())
        .exec(&orm)
        .await?;
    merge_repositories::Entity::update_many()
        .col_expr(
            merge_repositories::Column::TeamId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(merge_repositories::Column::UpdatedAt, Expr::value(at))
        .filter(merge_repositories::Column::TeamId.eq(&id))
        .exec(&orm)
        .await?;
    let row = returned(
        merge_teams::Entity::update_many()
            .col_expr(merge_teams::Column::DeletedAt, Expr::value(at))
            .col_expr(merge_teams::Column::UpdatedAt, Expr::value(at))
            .filter(merge_teams::Column::Id.eq(&id))
            .exec_with_returning(&orm)
            .await?,
    )?;
    publish(&state, &caller.events, vec![team_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}
