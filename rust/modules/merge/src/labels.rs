//! Issue labels: `/api/merge/labels`. Reading needs `merge_teams:read`,
//! changing a label `merge_teams:manage`. A label with no team is available
//! to every team.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::db::{Row, one_by_id, opt_text, rows_of, text};
use crate::mappers::label_dto;
use crate::schemas::{color, nothing_to_update};
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate, validate_query,
};

fn label_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_label",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "teamId": row["teamId"], "name": row["name"] }),
    )
}

async fn find_label(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(l) from merge_labels l where l.id = $1 and l.deleted_at is null limit 1",
        id,
    )
    .await
}

async fn name_taken(
    db: &PgPool,
    team_id: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select id from merge_labels where deleted_at is null \
         and (case when $1::text is null then team_id is null else team_id = $1 end) \
         and lower(name) = $2",
    )
    .bind(team_id)
    .bind(name.to_lowercase())
    .fetch_all(db)
    .await?;
    Ok(ids.iter().any(|id| Some(id.as_str()) != except))
}

/// `GET /?teamId=`: with a team id, that team's labels plus the
/// workspace-wide ones.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let team_id = validate_query(query.as_deref(), |issues, fields| {
        issues
            .text(fields, "teamId", Presence::Optional, None, None)
            .into_option()
    })?;
    // `teamId ? … : undefined`: an empty id lists every label.
    let team_id = team_id.filter(|t| !t.is_empty());
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(l) from merge_labels l where l.deleted_at is null \
             and ($1::text is null or l.team_id = $1 or l.team_id is null) \
             order by l.name asc, l.id asc",
        )
        .bind(team_id)
        .fetch_all(&caller.db)
        .await?,
    );
    Ok(all(rows.iter().map(label_dto).collect()))
}

pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (team_id, name, color) = validate(&headers, &body, |issues, fields| {
        (
            issues.text(fields, "teamId", Presence::Nullish, None, None),
            issues.text_with(
                fields,
                "name",
                Presence::Required,
                Text::trimmed(Some(1), Some(100)),
            ),
            color(issues, fields, Presence::Nullish),
        )
    })?;
    // `input.teamId ?? null`, and `if (teamId && …)` skips an empty id.
    let team_id = team_id.into_option();
    if let Some(team) = team_id.as_deref().filter(|t| !t.is_empty())
        && find_team(&caller.db, team).await?.is_none()
    {
        return Err(Refusal::not_found("Team", None));
    }
    let name = name.into_option().unwrap_or_default();
    // `teamId ? eq(teamId) : isNull(teamId)`: an empty id is no team.
    let scope = team_id.as_deref().filter(|t| !t.is_empty());
    if name_taken(&caller.db, scope, &name, None).await? {
        return Err(Refusal::conflict("A label with this name already exists"));
    }
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_labels (id, team_id, name, color, created_at, updated_at) \
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz) \
         returning to_jsonb(merge_labels.*)",
    )
    .bind(generate_id("mlb"))
    .bind(team_id)
    .bind(&name)
    .bind(color.into_option())
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![label_event(&row, "created")]);
    Ok(Created(label_dto(&row)).into_response())
}

pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (name, color) = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let read = (
            issues.text_with(
                fields,
                "name",
                Presence::Optional,
                Text::trimmed(Some(1), Some(100)),
            ),
            color(issues, fields, Presence::Nullish),
        );
        nothing_to_update(issues, start, fields, &["name", "color"]);
        read
    })?;
    let Some(existing) = find_label(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Label", Some(&id)));
    };
    let name = match name {
        Field::Set(name) => {
            let team = opt_text(&existing, "teamId");
            let scope = team.as_deref().filter(|t| !t.is_empty());
            if name_taken(&caller.db, scope, &name, Some(&id)).await? {
                return Err(Refusal::conflict("A label with this name already exists"));
            }
            Some(name)
        }
        _ => None,
    };
    let (set_color, color) = match color {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(color) => (true, Some(color)),
    };
    let row: Value = sqlx::query_scalar(
        "update merge_labels set updated_at = $2::timestamptz, \
           name = case when $3::text is null then name else $3 end, \
           color = case when $4 then $5 else color end \
         where id = $1 returning to_jsonb(merge_labels.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(name)
    .bind(set_color)
    .bind(color)
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![label_event(&row, "updated")]);
    Ok(Data(label_dto(&row)).into_response())
}

/// Soft delete. Issues keep the id in `label_ids`; readers ignore labels
/// that no longer exist.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    if find_label(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Label", Some(&id)));
    }
    let row: Value = sqlx::query_scalar(
        "update merge_labels set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_labels.*)",
    )
    .bind(&id)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![label_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}

/// Labels of `ids` that exist and belong to `team_id` or to every team.
pub(crate) async fn count_usable(
    db: &PgPool,
    ids: &[String],
    team_id: &str,
) -> Result<usize, sqlx::Error> {
    let found: Vec<String> = sqlx::query_scalar(
        "select id from merge_labels where id = any($1) and deleted_at is null \
         and (team_id = $2 or team_id is null)",
    )
    .bind(ids)
    .bind(team_id)
    .fetch_all(db)
    .await?;
    Ok(found.len())
}
