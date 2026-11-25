//! The sprint lifecycle (EU and self-hosted only, ADR FLOW-024): no
//! TypeScript twin.
//!
//! ```text
//! POST /api/sprints/:id/start     commit to the items in it and start
//! POST /api/sprints/:id/complete  carry the unfinished items over, freeze the report
//! GET  /api/sprints/:id/report    the frozen report, or the live one
//! ```
//!
//! A sprint's items are its live top-level tasks; cancelled ones are left
//! out of every count. The numbers are worked out by
//! [`weldsuite_flow_domain::agile`]. A refusal of the sprint's state is a
//! 409 (`CONFLICT`).

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::{Expr, NullOrdering};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};
use weldsuite_catalogs::entity_events::{
    PROJECT_SPRINT_COMPLETED, PROJECT_SPRINT_CREATED, PROJECT_SPRINT_STARTED,
    PROJECT_SPRINT_UPDATED, PROJECT_TASK_UPDATED,
};
use weldsuite_db::{OrmConn, PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_flow_domain::agile::{
    CARRY_TARGETS, CarriedOver, CarryTarget, Committed, END_BEFORE_START, NEXT_SPRINT_INVALID,
    ReportInput, SPRINT_ALREADY_ACTIVE, SPRINT_NOT_ACTIVE, SPRINT_NOT_PLANNED, SprintDays,
    SprintItem, carry_over_plan, day_of_date, is_finished, is_frozen, next_sprint_name,
    sprint_length_days, sprint_report, start_report,
};
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::blueprint::Obj;
use weldsuite_flow_domain::js::{js_date_millis, timestamp_of_millis};
use weldsuite_flow_domain::task_tree::MAX_SUBTASK_DEPTH;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Data, generate_id};
use weldsuite_schema::tenant::tasks::{self, Column as Task};
use weldsuite_schema::tenant::{projects, sprints};

use crate::js::Js;
use crate::raid_body::parse_body;
use crate::sprints::{PROJECT_DENIED, PROJECT_WRITE_DENIED};
use crate::task_changes::{Update, build_task_changes};
use crate::{Caller, FlowState, Refusal, Reply, reply, row_json};

const SPRINT: &str = "Sprint";
const INVALID_DATE: &str = "Invalid date";
/// `z.string().min(1).max(255)`.
const IDENTIFIER: Text = Text::length(Some(1), Some(255));

// ── Shared ──────────────────────────────────────────────────────────────────

async fn find_sprint(db: &PgPool, id: &str) -> Result<Option<sprints::Model>, DbErr> {
    sprints::Entity::find_by_id(id.to_owned())
        .filter(sprints::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// The request's instant (the test's clock in conformance), to the
/// millisecond.
fn instant(caller: &Caller) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(caller.now_ms()) * 1_000_000)
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
}

fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// The UTC day of a stored timestamp.
fn day(at: PrimitiveDateTime) -> i64 {
    day_of_date(at.date())
}

/// The UTC day of an instant.
fn day_of_instant(at: OffsetDateTime) -> i64 {
    day_of_date(at.to_offset(UtcOffset::UTC).date())
}

/// Midnight (UTC) of an instant's day.
fn midnight(at: OffsetDateTime) -> PrimitiveDateTime {
    PrimitiveDateTime::new(at.to_offset(UtcOffset::UTC).date(), Time::MIDNIGHT)
}

/// Points as the `int` columns hold them.
fn int_points(points: i64) -> i32 {
    i32::try_from(points).unwrap_or(if points < 0 { i32::MIN } else { i32::MAX })
}

/// The payload of a sprint event, as the sprint routes publish it.
fn sprint_event(sprint: &sprints::Model) -> Value {
    json!({
        "id": sprint.id,
        "projectId": sprint.project_id,
        "name": sprint.name,
        "status": sprint.status,
    })
}

/// The live tasks in a sprint, subtasks included, by position.
async fn sprint_tasks(
    db: &impl ConnectionTrait,
    sprint_id: &str,
) -> Result<Vec<tasks::Model>, DbErr> {
    tasks::Entity::find()
        .filter(Task::SprintId.eq(sprint_id))
        .filter(Task::DeletedAt.is_null())
        .order_by_asc(Task::Position)
        .order_by_asc(Task::CreatedAt)
        .order_by_asc(Task::Id)
        .all(db)
        .await
}

/// The sprint's items (its top-level tasks) as the report counts them.
fn items_of(tasks: &[tasks::Model]) -> Vec<SprintItem> {
    tasks
        .iter()
        .filter(|task| task.parent_task_id.is_none())
        .map(|task| SprintItem {
            id: task.id.clone(),
            status: task.status.clone(),
            points: i64::from(task.story_points.unwrap_or(0)),
            completed_day: task.completed_date.map(day),
        })
        .collect()
}

/// The current points of the committed tasks that are no longer items of
/// the sprint, deleted ones included.
async fn left_points(
    db: &PgPool,
    committed: &Committed,
    items: &[SprintItem],
) -> Result<HashMap<String, i64>, DbErr> {
    let present: HashSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let missing: Vec<&str> = committed
        .task_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !present.contains(id))
        .collect();
    if missing.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<i32>)> = tasks::Entity::find()
        .select_only()
        .columns([Task::Id, Task::StoryPoints])
        .filter(Task::Id.is_in(missing))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, points)| (id, i64::from(points.unwrap_or(0))))
        .collect())
}

/// `settings.delivery.sprintLengthDays` of the project, else 14.
async fn sprint_length(db: &PgPool, project_id: &str) -> Result<i64, DbErr> {
    let settings: Option<Option<Value>> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Settings)
        .filter(projects::Column::Id.eq(project_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(sprint_length_days(settings.flatten().as_ref()))
}

/// A body that is empty (or only whitespace) reads as `{}`.
fn is_empty(body: &Bytes) -> bool {
    body.iter().all(u8::is_ascii_whitespace)
}

/// The read object of a body reader.
fn object(out: Value) -> Option<Map<String, Value>> {
    match out {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

// ── POST /:id/start ─────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct StartInput {
    start: Option<PrimitiveDateTime>,
    end: Option<PrimitiveDateTime>,
    /// `Null`: the goal is cleared.
    goal: Field<String>,
}

/// `{ startDate?, endDate?, goal? }`, strict: the dates are ISO dates or
/// timestamps, the goal at most 2000 characters.
fn read_start(issues: &mut Issues, body: &Value) -> Option<Map<String, Value>> {
    let fields = issues.object(body)?;
    let mut o = Obj::new(issues, fields);
    o.text("startDate", Presence::Optional, Text::default())
        .text("endDate", Presence::Optional, Text::default())
        .text("goal", Presence::Nullish, Text::length(None, Some(2_000)));
    let out = o.finish();
    for key in ["startDate", "endDate"] {
        if let Some(text) = out.get(key).and_then(Value::as_str)
            && js_date_millis(text).is_none()
        {
            issues.custom(key, INVALID_DATE);
        }
    }
    object(out)
}

fn start_input(body: &Bytes) -> Result<StartInput, Refusal> {
    if is_empty(body) {
        return Ok(StartInput::default());
    }
    let read = parse_body(body, read_start)?;
    let date = |key: &str| {
        read.get(key)
            .and_then(Value::as_str)
            .and_then(js_date_millis)
            .and_then(timestamp_of_millis)
    };
    Ok(StartInput {
        start: date("startDate"),
        end: date("endDate"),
        goal: match read.get("goal") {
            None => Field::Absent,
            Some(Value::String(goal)) => Field::Set(goal.clone()),
            Some(_) => Field::Null,
        },
    })
}

pub(crate) async fn start(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    reply(
        start_sprint(&state, &caller, &id, &body).await,
        "Failed to start sprint",
    )
}

/// The sprint row a start writes.
struct Started {
    sprint_id: String,
    project_id: String,
    start: PrimitiveDateTime,
    end: PrimitiveDateTime,
    goal: Field<String>,
    at: PrimitiveDateTime,
}

async fn start_sprint(state: &FlowState, caller: &Caller, id: &str, body: &Bytes) -> Reply {
    let db = &caller.db;
    let Some(sprint) = find_sprint(db, id).await? else {
        return Err(Refusal::not_found(SPRINT, id));
    };
    if !caller.can_write(&sprint.project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let input = start_input(body)?;
    if sprint.status != "planned" {
        return Err(Refusal::conflict(SPRINT_NOT_PLANNED));
    }
    let now = instant(caller);
    let length = sprint_length(db, &sprint.project_id).await?;
    let start = input
        .start
        .or(sprint.start_date)
        .unwrap_or_else(|| midnight(now));
    let end = input
        .end
        .or(sprint.end_date)
        .unwrap_or_else(|| start + Duration::days(length));
    if end < start {
        return Err(Refusal::bad_request(END_BEFORE_START));
    }
    let started = Started {
        sprint_id: sprint.id.clone(),
        project_id: sprint.project_id.clone(),
        start,
        end,
        goal: input.goal,
        at: utc_timestamp(now),
    };
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            write_start(&tx, &started).await
        })
    })
    .await?;
    let Some(sprint) = find_sprint(db, id).await? else {
        return Err(Refusal::not_found(SPRINT, id));
    };
    let event = sprint_event(&sprint);
    caller.publish(state, PROJECT_SPRINT_UPDATED, id, &event);
    caller.publish(state, PROJECT_SPRINT_STARTED, id, &event);
    Ok(Data(row_json(sprint)?).into_response())
}

/// The start's writes, in its transaction. The project's row is locked
/// first, so two sprints of one project cannot start at the same time.
async fn write_start(tx: &OrmConn<'_>, s: &Started) -> Result<(), Refusal> {
    use sprints::Column;
    projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::Id.eq(s.project_id.as_str()))
        .lock_exclusive()
        .into_tuple::<String>()
        .one(tx)
        .await?;
    let active = sprints::Entity::find()
        .filter(Column::ProjectId.eq(s.project_id.as_str()))
        .filter(Column::Status.eq("active"))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Id.ne(s.sprint_id.as_str()))
        .count(tx)
        .await?;
    if active > 0 {
        return Err(Refusal::conflict(SPRINT_ALREADY_ACTIVE));
    }
    let committed = Committed::of(&items_of(&sprint_tasks(tx, &s.sprint_id).await?));
    let mut update = sprints::Entity::update_many()
        .col_expr(Column::Status, Expr::value("active"))
        .col_expr(Column::StartedAt, Expr::value(s.at))
        .col_expr(Column::StartDate, Expr::value(s.start))
        .col_expr(Column::EndDate, Expr::value(s.end))
        .col_expr(
            Column::StoryPointsCommitted,
            Expr::value(int_points(committed.points)),
        )
        .col_expr(
            Column::Report,
            Expr::value(start_report(&committed, &iso(s.at))),
        )
        .col_expr(Column::UpdatedAt, Expr::value(s.at));
    match &s.goal {
        Field::Set(goal) => {
            update = update.col_expr(Column::Goal, Expr::value(goal.as_str()));
        }
        Field::Null => {
            update = update.col_expr(Column::Goal, Expr::value(Option::<String>::None));
        }
        Field::Absent => {}
    }
    let written = update
        .filter(Column::Id.eq(s.sprint_id.as_str()))
        .filter(Column::Status.eq("planned"))
        .filter(Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    if written.rows_affected == 0 {
        return Err(Refusal::conflict(SPRINT_NOT_PLANNED));
    }
    Ok(())
}

// ── POST /:id/complete ──────────────────────────────────────────────────────

#[derive(Debug)]
struct CompleteInput {
    goal_met: Option<bool>,
    move_to: CarryTarget,
    next_sprint_id: Option<String>,
    items: Vec<(String, CarryTarget)>,
}

/// `{ taskId, moveTo }`, strict.
fn read_carry_item(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let mut o = Obj::new(issues, fields);
    o.text("taskId", Presence::Required, IDENTIFIER).choice(
        "moveTo",
        Presence::Required,
        &CARRY_TARGETS,
    );
    Some(o.finish())
}

/// `{ goalMet?, moveTo?, nextSprintId?, items? }`, strict.
fn read_complete(issues: &mut Issues, body: &Value) -> Option<Map<String, Value>> {
    let fields = issues.object(body)?;
    let mut o = Obj::new(issues, fields);
    o.boolean("goalMet", Presence::Nullish)
        .choice("moveTo", Presence::Optional, &CARRY_TARGETS)
        .text("nextSprintId", Presence::Optional, IDENTIFIER)
        .list("items", Presence::Optional, Some(1_000), read_carry_item);
    object(o.finish())
}

fn complete_input(body: &Bytes) -> Result<CompleteInput, Refusal> {
    let read = if is_empty(body) {
        Map::new()
    } else {
        parse_body(body, read_complete)?
    };
    let target = |value: Option<&Value>| value.and_then(Value::as_str).and_then(CarryTarget::parse);
    let items = read
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let task = item.get("taskId")?.as_str()?.to_owned();
            Some((task, target(item.get("moveTo"))?))
        })
        .collect();
    Ok(CompleteInput {
        goal_met: read.get("goalMet").and_then(Value::as_bool),
        move_to: target(read.get("moveTo")).unwrap_or(CarryTarget::Next),
        next_sprint_id: read
            .get("nextSprintId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        items,
    })
}

pub(crate) async fn complete(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    reply(
        complete_sprint(&state, &caller, &id, &body).await,
        "Failed to complete sprint",
    )
}

/// A sprint to create for the carried-over items.
#[derive(Debug, Clone)]
struct NewSprint {
    id: String,
    name: String,
    start: PrimitiveDateTime,
    end: PrimitiveDateTime,
}

/// The planned sprint the carried-over items go to: the one asked for (a
/// live planned sprint of the project, else 400), or the project's first
/// planned one (by start date, then age).
async fn planned_target(
    db: &PgPool,
    sprint: &sprints::Model,
    asked: Option<&str>,
) -> Result<Option<String>, Refusal> {
    use sprints::Column;
    let planned = || {
        sprints::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::ProjectId.eq(sprint.project_id.as_str()))
            .filter(Column::Status.eq("planned"))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Id.ne(sprint.id.as_str()))
    };
    if let Some(asked) = asked {
        let found: Option<String> = planned()
            .filter(Column::Id.eq(asked))
            .into_tuple()
            .one(&orm(db))
            .await?;
        return found
            .map(Some)
            .ok_or_else(|| Refusal::bad_request(NEXT_SPRINT_INVALID));
    }
    Ok(planned()
        .order_by_with_nulls(Column::StartDate, Order::Asc, NullOrdering::Last)
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await?)
}

/// `roots` and their subtasks (any depth, live) that are in the sprint:
/// what moves when the roots move.
async fn with_subtasks(
    db: &PgPool,
    roots: &[String],
    sprint_id: &str,
) -> Result<Vec<String>, DbErr> {
    let mut moved = roots.to_vec();
    let mut seen: HashSet<String> = roots.iter().cloned().collect();
    let mut frontier = roots.to_vec();
    for _ in 0..MAX_SUBTASK_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let children: Vec<(String, Option<String>)> = tasks::Entity::find()
            .select_only()
            .columns([Task::Id, Task::SprintId])
            .filter(Task::ParentTaskId.is_in(frontier.iter().map(String::as_str)))
            .filter(Task::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?;
        frontier = Vec::new();
        for (child, sprint) in children {
            if !seen.insert(child.clone()) {
                continue;
            }
            if sprint.as_deref() == Some(sprint_id) {
                moved.push(child.clone());
            }
            frontier.push(child);
        }
    }
    Ok(moved)
}

/// The completion's writes, in one transaction.
struct Completion {
    sprint_id: String,
    project_id: String,
    at: PrimitiveDateTime,
    completed_points: i64,
    report: Value,
    new_sprint: Option<NewSprint>,
    next_id: Option<String>,
    to_next: Vec<String>,
    to_backlog: Vec<String>,
}

async fn write_completion(tx: &OrmConn<'_>, c: &Completion) -> Result<(), Refusal> {
    use sprints::Column;
    let points = int_points(c.completed_points);
    let written = sprints::Entity::update_many()
        .col_expr(Column::Status, Expr::value("completed"))
        .col_expr(Column::CompletedAt, Expr::value(c.at))
        .col_expr(Column::Velocity, Expr::value(points))
        .col_expr(Column::StoryPointsCompleted, Expr::value(points))
        .col_expr(Column::Report, Expr::value(c.report.clone()))
        .col_expr(Column::UpdatedAt, Expr::value(c.at))
        .filter(Column::Id.eq(c.sprint_id.as_str()))
        .filter(Column::Status.eq("active"))
        .filter(Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    if written.rows_affected == 0 {
        return Err(Refusal::conflict(SPRINT_NOT_ACTIVE));
    }
    if let Some(new) = &c.new_sprint {
        sprints::Entity::insert(sprints::ActiveModel {
            id: Set(new.id.clone()),
            created_at: Set(c.at),
            updated_at: Set(c.at),
            deleted_at: Set(None),
            project_id: Set(c.project_id.clone()),
            name: Set(new.name.clone()),
            goal: Set(None),
            status: Set("planned".to_owned()),
            start_date: Set(Some(new.start)),
            end_date: Set(Some(new.end)),
            started_at: Set(None),
            completed_at: Set(None),
            velocity: Set(None),
            story_points_committed: Set(None),
            story_points_completed: Set(None),
            report: Set(None),
        })
        .exec_without_returning(tx)
        .await?;
    }
    for (ids, target) in [(&c.to_next, c.next_id.clone()), (&c.to_backlog, None)] {
        if ids.is_empty() {
            continue;
        }
        tasks::Entity::update_many()
            .col_expr(Task::SprintId, Expr::value(target))
            .col_expr(Task::UpdatedAt, Expr::value(c.at))
            .filter(Task::Id.is_in(ids.iter().map(String::as_str)))
            .filter(Task::SprintId.eq(c.sprint_id.as_str()))
            .filter(Task::DeletedAt.is_null())
            .exec(tx)
            .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_lines)] // the completion's steps, in order
async fn complete_sprint(state: &FlowState, caller: &Caller, id: &str, body: &Bytes) -> Reply {
    let db = &caller.db;
    let Some(sprint) = find_sprint(db, id).await? else {
        return Err(Refusal::not_found(SPRINT, id));
    };
    if !caller.can_write(&sprint.project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let input = complete_input(body)?;
    if sprint.status != "active" {
        return Err(Refusal::conflict(SPRINT_NOT_ACTIVE));
    }
    let now = instant(caller);
    let today = day_of_instant(now);
    let all = sprint_tasks(&orm(db), id).await?;
    let items = items_of(&all);
    let committed =
        Committed::from_report(sprint.report.as_ref()).unwrap_or_else(|| Committed::of(&items));
    let unfinished: Vec<&SprintItem> = items
        .iter()
        .filter(|item| !is_finished(&item.status))
        .collect();
    let unfinished_ids: Vec<String> = unfinished.iter().map(|item| item.id.clone()).collect();
    let (next_roots, backlog_roots) = carry_over_plan(&unfinished_ids, input.move_to, &input.items);

    let planned = planned_target(db, &sprint, input.next_sprint_id.as_deref()).await?;
    let new_sprint = if planned.is_none() && !next_roots.is_empty() {
        let length = sprint_length(db, &sprint.project_id).await?;
        let start = sprint.end_date.unwrap_or_else(|| midnight(now));
        Some(NewSprint {
            id: generate_id("spr"),
            name: next_sprint_name(&sprint.name),
            start,
            end: start + Duration::days(length),
        })
    } else {
        None
    };
    let next_id = planned.or_else(|| new_sprint.as_ref().map(|new| new.id.clone()));
    let to_next = with_subtasks(db, &next_roots, id).await?;
    let to_backlog = with_subtasks(db, &backlog_roots, id).await?;

    let left = left_points(db, &committed, &items).await?;
    let carried = CarriedOver {
        task_ids: unfinished_ids.clone(),
        points: unfinished.iter().map(|item| item.points).sum(),
        to_sprint_id: if next_roots.is_empty() {
            None
        } else {
            next_id.clone()
        },
        to_backlog: i64::try_from(backlog_roots.len()).unwrap_or(i64::MAX),
    };
    let at = utc_timestamp(now);
    let report = sprint_report(&ReportInput {
        committed: &committed,
        items: &items,
        left_points: &left,
        carried_over: Some(&carried),
        goal_met: input.goal_met,
        days: SprintDays::of(
            sprint.start_date.map(day),
            sprint.end_date.map(day),
            sprint.started_at.map(day),
            today,
        ),
        today,
        started_at: sprint.started_at.map(iso),
        completed_at: Some(iso(at)),
    });
    let completion = Completion {
        sprint_id: id.to_owned(),
        project_id: sprint.project_id.clone(),
        at,
        completed_points: report["completed"]["points"].as_i64().unwrap_or(0),
        report: report.clone(),
        new_sprint: new_sprint.clone(),
        next_id: next_id.clone(),
        to_next: to_next.clone(),
        to_backlog: to_backlog.clone(),
    };
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            write_completion(&tx, &completion).await
        })
    })
    .await?;

    if let Some(new) = &new_sprint {
        caller.publish(
            state,
            PROJECT_SPRINT_CREATED,
            &new.id,
            &json!({
                "id": new.id,
                "projectId": sprint.project_id,
                "name": new.name,
                "status": "planned",
            }),
        );
    }
    let Some(completed) = find_sprint(db, id).await? else {
        return Err(Refusal::not_found(SPRINT, id));
    };
    let event = sprint_event(&completed);
    caller.publish(state, PROJECT_SPRINT_UPDATED, id, &event);
    caller.publish(state, PROJECT_SPRINT_COMPLETED, id, &event);
    publish_moves(state, caller, &all, &to_next, next_id.as_deref());
    publish_moves(state, caller, &all, &to_backlog, None);

    Ok(Data(json!({
        "sprint": row_json(completed)?,
        "nextSprintId": carried.to_sprint_id,
        "report": report,
    }))
    .into_response())
}

/// The `updated` event of every task moved out of the sprint, with its
/// `sprintId` change.
fn publish_moves(
    state: &FlowState,
    caller: &Caller,
    all: &[tasks::Model],
    moved: &[String],
    to: Option<&str>,
) {
    let now_ms = caller.now_ms();
    for task in all.iter().filter(|task| moved.contains(&task.id)) {
        let Ok(row) = row_json(task.clone()) else {
            continue;
        };
        let mut update = Update::default();
        update.set(
            "sprintId",
            to.map_or(Js::Null, |sprint| Js::String(sprint.to_owned())),
        );
        let changes = build_task_changes(&row, &update, &HashMap::new());
        caller.publish_changes(
            state,
            PROJECT_TASK_UPDATED,
            &task.id,
            task_analytics_payload(&row, &json!({ "sprintId": to }), now_ms),
            changes,
        );
    }
}

// ── GET /:id/report ─────────────────────────────────────────────────────────

pub(crate) async fn report(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        report_of(&caller, &id).await,
        "Failed to fetch the sprint report",
    )
}

async fn report_of(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(sprint) = find_sprint(db, id).await? else {
        return Err(Refusal::not_found(SPRINT, id));
    };
    if !caller.can_access(&sprint.project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    if sprint.status == "completed"
        && is_frozen(sprint.report.as_ref())
        && let Some(report) = sprint.report
    {
        return Ok(Data(report).into_response());
    }
    // A sprint completed without the route counts up to its completion.
    let today = match (sprint.status.as_str(), sprint.completed_at) {
        ("completed", Some(at)) => day(at),
        _ => day_of_instant(instant(caller)),
    };
    let items = items_of(&sprint_tasks(&orm(db), id).await?);
    let committed =
        Committed::from_report(sprint.report.as_ref()).unwrap_or_else(|| Committed::of(&items));
    let left = left_points(db, &committed, &items).await?;
    let report = sprint_report(&ReportInput {
        committed: &committed,
        items: &items,
        left_points: &left,
        carried_over: None,
        goal_met: None,
        days: SprintDays::of(
            sprint.start_date.map(day),
            sprint.end_date.map(day),
            sprint.started_at.map(day),
            today,
        ),
        today,
        started_at: sprint.started_at.map(iso),
        completed_at: sprint.completed_at.map(iso),
    });
    Ok(Data(report).into_response())
}
