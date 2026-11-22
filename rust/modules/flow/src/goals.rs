//! `/api/goals` (`routes/goals/index.ts`): a project's goals canvas, one
//! `project_goals` row per project holding the mission and the goal cards
//! (`by-project`), plus row-level reads and writes.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_GOAL_CREATED, PROJECT_GOAL_DELETED, PROJECT_GOAL_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::js::{civil_from_days, iso_from_millis, js_date_millis};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_goals as goals_table;

use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, fetch_limit, forbidden, json_rows,
    keyset_before, keyset_cursor_tz, list_limit, outside, page, paged, reply, row_json, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const GOAL_STATUSES: [&str; 5] = [
    "on-track",
    "at-risk",
    "off-track",
    "not-started",
    "completed",
];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("projects:create")),
        )
        .route(
            "/by-project/{project_id}",
            get(canvas).route_layer(need("projects:read")),
        )
        .route(
            "/by-project/{project_id}",
            put(save).route_layer(need("projects:update")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("projects:delete")),
        )
        .with_state(state)
}

fn default_mission() -> Value {
    json!({
        "id": "mission-1",
        "title": "Project Mission",
        "description": "Our mission",
        "x": 600,
        "y": 50,
        "width": 320,
        "height": 160,
        "subGoals": [],
    })
}

async fn goal_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    goals_table::Entity::find_by_id(id.to_owned())
        .filter(goals_table::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// The project's canvas row (`findCanvasRow`): one with data wins over an
/// empty one, then the latest written, then the id.
async fn canvas_row(db: &PgPool, project_id: &str) -> Result<Option<Value>, DbErr> {
    use sea_orm::ExprTrait as _;
    // `jsonb_array_length(coalesce(goals, '[]'::jsonb)) > 0`.
    let has_goals = Expr::from(Func::cust("jsonb_array_length").arg(Func::coalesce([
        Expr::col((goals_table::Entity, goals_table::Column::Goals)),
        Expr::val(json!([])),
    ])))
    .gt(0);
    let has_data = Condition::any()
        .add(goals_table::Column::Mission.is_not_null())
        .add(has_goals);
    let rank: Expr = Expr::case(has_data, 0).finally(1).into();
    goals_table::Entity::find()
        .filter(goals_table::Column::ProjectId.eq(project_id))
        .filter(goals_table::Column::DeletedAt.is_null())
        .order_by_asc(rank)
        .order_by_desc(goals_table::Column::UpdatedAt)
        .order_by_desc(goals_table::Column::Id)
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `new Date()` as the `timestamptz` it is written as (UTC, milliseconds).
fn now_at() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// `saveCanvas`: updates the canvas row or creates it under a fixed id.
/// The row id and whether it was created.
async fn save_canvas(
    db: &PgPool,
    project_id: &str,
    mission: &Value,
    goals: &Value,
    user: Option<&str>,
) -> Result<(String, bool), DbErr> {
    let now = now_at();
    let mission = (!mission.is_null()).then(|| mission.clone());
    let user = user.map(str::to_owned);
    if let Some(existing) = canvas_row(db, project_id).await? {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        goals_table::Entity::update_many()
            .col_expr(goals_table::Column::Mission, Expr::value(mission))
            .col_expr(goals_table::Column::Goals, Expr::value(goals.clone()))
            .col_expr(goals_table::Column::LastEditedBy, Expr::value(user))
            .col_expr(goals_table::Column::UpdatedAt, Expr::value(now))
            .filter(goals_table::Column::Id.eq(&id))
            .exec(&orm(db))
            .await?;
        return Ok((id, false));
    }
    let candidate = format!("gcv_{project_id}");
    let id = if candidate.chars().count() <= 30 {
        candidate
    } else {
        generate_id("goal")
    };
    goals_table::Entity::insert(goals_table::ActiveModel {
        id: Set(id.clone()),
        project_id: Set(project_id.to_owned()),
        mission: Set(mission),
        goals: Set(Some(goals.clone())),
        last_edited_by: Set(user),
        created_at: Set(Some(now)),
        updated_at: Set(Some(now)),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(goals_table::Column::Id)
            .update_columns([
                goals_table::Column::Mission,
                goals_table::Column::Goals,
                goals_table::Column::LastEditedBy,
                goals_table::Column::UpdatedAt,
            ])
            .value(
                goals_table::Column::DeletedAt,
                Expr::value(None::<OffsetDateTime>),
            )
            .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await?;
    Ok((id, true))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_goals(&caller, &q).await)
}

async fn list_goals(caller: &Caller, q: &Query) -> Reply {
    use goals_table::Column;
    let db = &caller.db;
    let limit = list_limit(q, 25, 100);
    let project_id = q.present("projectId").map(str::to_owned);
    // `applyProjectScope`: an explicit project, else the caller's projects
    // (scope:all: every row).
    let (scoped, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (false, Vec::new())
    } else {
        let (all, ids) = access_scope(caller).await?;
        (!all, ids)
    };
    let cursor = match q.present("cursor") {
        Some(cursor) => keyset_cursor_tz(db, Column::Id, Column::CreatedAt, cursor).await?,
        None => None,
    };
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let db = orm(db);
        let mut filters = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(project_id) = &project_id {
            filters = filters.add(Column::ProjectId.eq(project_id));
        }
        if scoped {
            filters = filters.add(Column::ProjectId.is_in(&ids));
        }
        let mut page_filters = filters.clone();
        if let Some(cursor) = &cursor {
            page_filters = page_filters.add(keyset_before(Column::Id, Column::CreatedAt, cursor));
        }
        let rows = goals_table::Entity::find()
            .filter(page_filters)
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(fetch_limit(limit)?)
            .all(&db)
            .await?;
        let total = goals_table::Entity::find()
            .filter(filters)
            .count(&db)
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let (rows, has_more, next) = page(json_rows(rows)?, limit);
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list goals"))
}

// ── /by-project/:projectId ──────────────────────────────────────────────────

async fn canvas(caller: Caller, Path(project_id): Path<String>) -> Response {
    match caller.can_access(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let Some(row) = canvas_row(&caller.db, &project_id).await? else {
                return Ok(
                    Data(json!({ "mission": default_mission(), "goals": [] })).into_response()
                );
            };
            let mission = match &row["mission"] {
                Value::Null => default_mission(),
                mission => mission.clone(),
            };
            let goals = match &row["goals"] {
                Value::Null => json!([]),
                goals => goals.clone(),
            };
            Ok(Data(json!({ "mission": mission, "goals": goals })).into_response())
        }
        .await,
        "Failed to fetch project goals",
    )
}

async fn save(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (mission, goals) = match validate(&headers, &body, |issues, fields| {
        let goals = issues
            .list(
                fields,
                "goals",
                Presence::Optional,
                None,
                None,
                |_, item| Some(item.clone()),
            )
            .into_option()
            .unwrap_or_default();
        (
            fields.get("mission").cloned().unwrap_or(Value::Null),
            Value::Array(goals),
        )
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match caller.can_write(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let (id, created) =
                save_canvas(&caller.db, &project_id, &mission, &goals, caller.user()).await?;
            let event = if created {
                PROJECT_GOAL_CREATED
            } else {
                PROJECT_GOAL_UPDATED
            };
            caller.publish(
                &state,
                event,
                &id,
                &json!({ "id": id, "projectId": project_id }),
            );
            let body = json!({ "id": id });
            Ok(if created {
                Created(body).into_response()
            } else {
                Data(body).into_response()
            })
        }
        .await,
        "Failed to save project goals",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = goal_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Goal", &id));
            };
            if let Some(project) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch goal",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct NewGoal {
    project_id: String,
    title: Option<String>,
    name: Option<String>,
    description: Option<String>,
    status: Option<String>,
    progress: Option<i64>,
    due_date: Option<String>,
    owner_id: Option<String>,
}

/// `Q4 2026`.
fn quarter_label(millis: i64) -> String {
    let (year, month, _) = civil_from_days(millis.div_euclid(86_400_000));
    format!("Q{} {year}", (month - 1) / 3 + 1)
}

/// `newGoalCard`.
fn new_goal_card(input: &NewGoal, position: usize) -> (String, Value) {
    let millis = input
        .due_date
        .as_deref()
        .and_then(js_date_millis)
        .unwrap_or_else(|| {
            let now = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
            i64::try_from(now).unwrap_or(0) + 90 * 24 * 60 * 60 * 1000
        });
    let id = generate_id("goal");
    let mut card = json!({
        "id": id,
        "title": input.title.clone().or_else(|| input.name.clone()).unwrap_or_else(|| "Untitled goal".to_owned()),
        "description": input.description.clone().unwrap_or_default(),
        "owner": { "name": "Unassigned", "initials": "?", "color": "#94a3b8" },
        "status": input.status.clone().unwrap_or_else(|| "not-started".to_owned()),
        "progress": input.progress.unwrap_or(0),
        "dueDate": iso_from_millis(millis),
        "timePeriod": quarter_label(millis),
        "type": "company",
        "x": 100 + position * 350,
        "y": 300,
        "width": 320,
        "height": 200,
        "subGoals": [],
        "updates": 0,
        "comments": 0,
        "attachments": 0,
    });
    if let Some(owner) = input.owner_id.as_deref().filter(|o| !o.is_empty()) {
        card["ownerId"] = json!(owner);
    }
    (id, card)
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let trimmed = Text::trimmed(Some(1), Some(255));
        NewGoal {
            project_id: issues
                .text(fields, "projectId", Presence::Required, Some(1), Some(30))
                .into_option()
                .unwrap_or_default(),
            title: issues
                .text_with(fields, "title", Presence::Optional, trimmed)
                .into_option(),
            name: issues
                .text_with(fields, "name", Presence::Optional, trimmed)
                .into_option(),
            description: issues
                .text(fields, "description", Presence::Optional, None, Some(5000))
                .into_option(),
            status: issues
                .choice(fields, "status", Presence::Optional, &GOAL_STATUSES)
                .into_option(),
            progress: issues
                .whole_number(
                    fields,
                    "progress",
                    Presence::Optional,
                    weldsuite_kit::validation::Number {
                        coerce: false,
                        int: true,
                        min: Some(0.0),
                        max: Some(100.0),
                    },
                )
                .into_option(),
            due_date: issues
                .text(fields, "dueDate", Presence::Optional, None, Some(40))
                .into_option(),
            owner_id: issues
                .text(fields, "ownerId", Presence::Nullish, None, Some(255))
                .into_option(),
        }
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match caller.can_write(&input.project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let existing = canvas_row(&caller.db, &input.project_id).await?;
            let mut goals: Vec<Value> = existing
                .as_ref()
                .and_then(|row| row["goals"].as_array().cloned())
                .unwrap_or_default();
            let (goal_id, card) = new_goal_card(&input, goals.len());
            goals.push(card);
            let mission = existing
                .as_ref()
                .map_or(Value::Null, |row| row["mission"].clone());
            let (id, created) = save_canvas(
                &caller.db,
                &input.project_id,
                &mission,
                &Value::Array(goals),
                caller.user(),
            )
            .await?;
            let event = if created {
                PROJECT_GOAL_CREATED
            } else {
                PROJECT_GOAL_UPDATED
            };
            caller.publish(
                &state,
                event,
                &id,
                &json!({ "id": id, "projectId": input.project_id }),
            );
            Ok(Created(json!({ "id": id, "goalId": goal_id })).into_response())
        }
        .await,
        "Failed to create goal",
    )
}

// ── PATCH /:id, DELETE /:id ─────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        let mission = issues.nested(fields, "mission", Presence::Nullish, |_, map| {
            Value::Object(map.clone())
        });
        let goals = issues.list(
            fields,
            "goals",
            Presence::Optional,
            None,
            None,
            |_, item| Some(item.clone()),
        );
        let mut data = Map::new();
        match mission {
            Field::Set(mission) => {
                data.insert("mission".to_owned(), mission);
            }
            Field::Null => {
                data.insert("mission".to_owned(), Value::Null);
            }
            Field::Absent => {}
        }
        if let Field::Set(goals) = goals {
            data.insert("goals".to_owned(), Value::Array(goals));
        }
        data
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let Some(existing) = goal_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Goal", &id));
            };
            if let Some(project) = existing["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            let mut change = goals_table::Entity::update_many();
            if let Some(mission) = data.get("mission") {
                let mission = (!mission.is_null()).then(|| mission.clone());
                change = change.col_expr(goals_table::Column::Mission, Expr::value(mission));
            }
            if let Some(goals) = data.get("goals") {
                change = change.col_expr(goals_table::Column::Goals, Expr::value(goals.clone()));
            }
            change
                .col_expr(
                    goals_table::Column::LastEditedBy,
                    Expr::value(caller.user().map(str::to_owned)),
                )
                .col_expr(goals_table::Column::UpdatedAt, Expr::value(now_at()))
                .filter(goals_table::Column::Id.eq(&id))
                .filter(goals_table::Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(
                &state,
                PROJECT_GOAL_UPDATED,
                &id,
                &json!({ "id": id, "projectId": existing["projectId"] }),
            );
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
        "Failed to update goal",
    )
}

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(existing) = goal_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Goal", &id));
            };
            if let Some(project) = existing["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            let now = now_at();
            goals_table::Entity::update_many()
                .col_expr(goals_table::Column::DeletedAt, Expr::value(now))
                .col_expr(goals_table::Column::UpdatedAt, Expr::value(now))
                .filter(goals_table::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(
                &state,
                PROJECT_GOAL_DELETED,
                &id,
                &json!({ "id": id, "projectId": existing["projectId"] }),
            );
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete goal",
    )
}
