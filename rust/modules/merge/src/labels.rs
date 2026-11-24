//! Issue labels: `/api/merge/labels`. Reading needs `merge_teams:read`,
//! changing a label `merge_teams:manage`. A label with no team is available
//! to every team.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::json;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::merge_labels;

use crate::db::{Row, json_row, json_rows, now_at, opt_text, same_or_null, text};
use crate::mappers::label_dto;
use crate::schemas::{color, nothing_to_update};
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, all, publish, validate, validate_query,
};

fn label_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_label",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "teamId": row["teamId"], "name": row["name"] }),
    )
}

/// A label row as the services read it.
pub(crate) fn label_row(label: merge_labels::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(label))
}

async fn find_label(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_labels::Entity::find_by_id(id.to_owned())
        .filter(merge_labels::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(label_row)
        .transpose()
}

/// `lower(name)`.
pub(crate) fn lower_name() -> Expr {
    Func::lower(merge_labels::Column::Name.into_expr()).into()
}

async fn name_taken(
    db: &PgPool,
    team_id: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> Result<bool, DbErr> {
    let ids: Vec<String> = merge_labels::Entity::find()
        .select_only()
        .column(merge_labels::Column::Id)
        .filter(merge_labels::Column::DeletedAt.is_null())
        .filter(same_or_null(merge_labels::Column::TeamId, team_id))
        .filter(sea_orm::ExprTrait::eq(lower_name(), name.to_lowercase()))
        .into_tuple::<String>()
        .all(&orm(db))
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
    let mut select = merge_labels::Entity::find().filter(merge_labels::Column::DeletedAt.is_null());
    if let Some(team_id) = team_id {
        select = select.filter(
            Condition::any()
                .add(merge_labels::Column::TeamId.eq(team_id))
                .add(merge_labels::Column::TeamId.is_null()),
        );
    }
    let rows = json_rows(
        select
            .order_by_asc(merge_labels::Column::Name)
            .order_by_asc(merge_labels::Column::Id)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
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
    let (_, at) = now_at();
    let row = label_row(
        merge_labels::Entity::insert(merge_labels::ActiveModel {
            id: Set(generate_id("mlb")),
            team_id: Set(team_id),
            name: Set(name),
            color: Set(color.into_option()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_with_returning(&orm(&caller.db))
        .await?,
    )?;
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
    let (_, at) = now_at();
    let mut label = merge_labels::ActiveModel {
        id: Unchanged(id.clone()),
        updated_at: Set(at),
        ..Default::default()
    };
    if let Some(name) = name {
        label.name = Set(name);
    }
    match color {
        Field::Absent => {}
        Field::Null => label.color = Set(None),
        Field::Set(color) => label.color = Set(Some(color)),
    }
    let row = label_row(label.update(&orm(&caller.db)).await?)?;
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
    let (_, at) = now_at();
    let row = label_row(
        merge_labels::ActiveModel {
            id: Unchanged(id.clone()),
            deleted_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        }
        .update(&orm(&caller.db))
        .await?,
    )?;
    publish(&state, &caller.events, vec![label_event(&row, "deleted")]);
    Ok(NoContent.into_response())
}

/// Labels of `ids` that exist and belong to `team_id` or to every team.
pub(crate) async fn count_usable(
    db: &PgPool,
    ids: &[String],
    team_id: &str,
) -> Result<usize, DbErr> {
    let found: Vec<String> = merge_labels::Entity::find()
        .select_only()
        .column(merge_labels::Column::Id)
        .filter(merge_labels::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(merge_labels::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(merge_labels::Column::TeamId.eq(team_id))
                .add(merge_labels::Column::TeamId.is_null()),
        )
        .into_tuple::<String>()
        .all(&orm(db))
        .await?;
    Ok(found.len())
}
