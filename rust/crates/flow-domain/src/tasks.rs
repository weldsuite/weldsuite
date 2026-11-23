//! Task creation (`@weldsuite/flow-domain/tasks`'s `createTask`) and the
//! next occurrence of a repeating task
//! (`@weldsuite/flow-domain/recurrence`'s `createNextOccurrence`), shared by
//! flow-api's task routes and WeldConnect's `create_task` action.
//!
//! Both take the task as JavaScript holds it: a JSON object with the
//! `tasks` columns' camelCase keys (dates as ISO strings). Only the keys
//! read below are written.
//!
//! Custom fields: TypeScript mirrors `customFields` into the typed values
//! table right after the insert (`syncValuesForEntity`). The callers do
//! that here (see the flow module's `custom_values`), until the shared
//! `weldsuite-core-domain` value store is wired in.

use sea_orm::sea_query::{Expr, Func, OnConflict, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::tasks;

use crate::js::{
    iso_from_millis, js_date, json_text, millis_of, row as entity_row, timestamp_of_millis,
};
use crate::numbering::allocate_task_number;
use crate::recurrence::{RepeatConfig, next_occurrence_date};
use crate::stage::{normalize_task_status, stage_for_status, status_from_stage};

/// What [`create_task`] answers: the row as read back, and the
/// normalised assignee ids.
#[derive(Debug, Clone)]
pub struct CreatedTask {
    pub row: Value,
    pub assignee_ids: Vec<String>,
}

/// Why a create failed.
#[derive(Debug)]
pub enum CreateError {
    Database(DbErr),
    /// A date JavaScript cannot turn into a timestamp (`toISOString` throws).
    InvalidDate,
}

impl From<DbErr> for CreateError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::InvalidDate => f.write_str("Invalid time value"),
        }
    }
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// A value to bind for a column the insert spreads: `undefined` and `null`
/// both store SQL `NULL` (the column has no other default).
fn nullable(data: &Map<String, Value>, key: &str) -> Value {
    data.get(key).cloned().unwrap_or(Value::Null)
}

/// `startDate ? new Date(startDate) : undefined`.
fn date_of(data: &Map<String, Value>, key: &str) -> Result<Option<String>, CreateError> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) if raw.is_empty() => Ok(None),
        Some(Value::String(raw)) => js_date(raw).map(Some).ok_or(CreateError::InvalidDate),
        Some(Value::Number(n)) => n.as_f64().filter(|n| *n != 0.0).map_or(Ok(None), |ms| {
            #[allow(clippy::cast_possible_truncation)]
            iso_from_millis(ms as i64)
                .map(Some)
                .ok_or(CreateError::InvalidDate)
        }),
        Some(_) => Err(CreateError::InvalidDate),
    }
}

/// `coalesce(max(position), 0) + 1` among the live tasks of the project
/// (or of the workspace for a task without one).
async fn next_position(db: &PgPool, project_id: Option<&str>) -> Result<i32, DbErr> {
    let mut live = Condition::all().add(tasks::Column::DeletedAt.is_null());
    if let Some(project_id) = project_id {
        live = live.add(tasks::Column::ProjectId.eq(project_id));
    }
    let max: Option<i32> = tasks::Entity::find()
        .select_only()
        .expr(sea_orm::ExprTrait::cast_as(
            Func::coalesce([
                Expr::from(Func::max(Expr::col(tasks::Column::Position))),
                Expr::val(0),
            ]),
            "int",
        ))
        .filter(live)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(max.unwrap_or(0).max(0) + 1)
}

/// The row as the task routes return it (numerics as their text).
async fn read_back(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = tasks::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(entity_row))
}

/// `$n::timestamp` of an ISO text (`NULL` stays `NULL`): Postgres reads it.
fn timestamp_text(value: Option<&str>) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::val(value), "timestamp")
}

/// `($n::jsonb #>> '{}')::<type>`: a JSON value converted by Postgres, as
/// the insert spreads it (a number or its text; `null` stays `NULL`).
fn json_cast(value: &Value, type_name: &'static str) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::val(json_text(value)), type_name)
}

/// The `'0'` the insert writes to `progress`.
fn zero_progress() -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::val("0"), "numeric")
}

/// Run an insert built with SeaQuery; its row count.
async fn run_insert(
    db: &impl ConnectionTrait,
    insert: &sea_orm::sea_query::InsertStatement,
) -> Result<u64, DbErr> {
    Ok(db.execute(insert).await?.rows_affected())
}

/// `jsonb` keeps `2.0` as written; JavaScript would store `2`.
fn whole(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            crate::js::number_value(n)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(whole).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, whole(v))).collect()),
        other => other,
    }
}

/// A `jsonb` column's value: `undefined` / `null` store `NULL`.
fn json_column(data: &Map<String, Value>, key: &str) -> Option<Value> {
    match data.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => Some(whole(value.clone())),
    }
}

/// `createTask(db, data, { projectId, userId })`.
pub async fn create_task(
    db: &PgPool,
    data: &Map<String, Value>,
    project_id: Option<&str>,
    user_id: &str,
) -> Result<CreatedTask, CreateError> {
    // A freshly generated id is never taken.
    insert_task(db, data, project_id, user_id, None)
        .await?
        .ok_or(CreateError::Database(DbErr::RecordNotInserted))
}

/// `createTaskOnce(db, data, { projectId, userId, id })`: `create_task` for a
/// task that must exist once. The caller names the id, and when a task with
/// that id is already there nothing is written: `None`. The primary key
/// decides, so two callers that run at the same time cannot both create it.
pub async fn create_task_once(
    db: &PgPool,
    data: &Map<String, Value>,
    project_id: Option<&str>,
    user_id: &str,
    id: &str,
) -> Result<Option<CreatedTask>, CreateError> {
    insert_task(db, data, project_id, user_id, Some(id)).await
}

#[allow(clippy::too_many_lines)] // the TypeScript function, one column at a time
async fn insert_task(
    db: &PgPool,
    data: &Map<String, Value>,
    project_id: Option<&str>,
    user_id: &str,
    fixed_id: Option<&str>,
) -> Result<Option<CreatedTask>, CreateError> {
    let project_id = project_id
        .map(str::to_owned)
        .or_else(|| text(data, "projectId").map(str::to_owned));
    let id = fixed_id.map_or_else(|| generate_id("task"), str::to_owned);
    let now = utc_now();
    let number = allocate_task_number(&orm(db)).await?;
    let stage_id = text(data, "stageId");

    let mut status = normalize_task_status(text(data, "status").unwrap_or("todo"));
    if let Some(stage_status) = status_from_stage(db, stage_id).await? {
        status = stage_status;
    }
    let position = next_position(db, project_id.as_deref()).await?;

    let mut priority = text(data, "priority").map(str::to_owned);
    let parent = text(data, "parentTaskId").filter(|p| !p.is_empty());
    if priority.as_deref().is_none_or(str::is_empty)
        && let Some(parent) = parent
    {
        priority = tasks::Entity::find()
            .select_only()
            .column(tasks::Column::Priority)
            .filter(tasks::Column::Id.eq(parent))
            .filter(tasks::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
    }

    let assignee_ids: Vec<String> = match data.get("assigneeIds") {
        Some(Value::Array(ids)) if !ids.is_empty() => ids
            .iter()
            .map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned))
            .collect(),
        _ => text(data, "assigneeId")
            .filter(|id| !id.is_empty())
            .map(|id| vec![id.to_owned()])
            .unwrap_or_default(),
    };
    let start_date = date_of(data, "startDate")?;
    let due_date = date_of(data, "dueDate")?;
    let kind = match data.get("type") {
        None | Some(Value::Null) => Some("task"),
        Some(kind) => kind.as_str(),
    };
    let reporter = text(data, "reporterId")
        .filter(|r| !r.is_empty())
        .unwrap_or(user_id);

    use tasks::Column as C;
    let mut insert = Query::insert();
    insert
        .into_table(tasks::Entity)
        .columns([
            C::Id,
            C::Number,
            C::ProjectId,
            C::Title,
            C::Description,
            C::Status,
            C::StageId,
            C::Priority,
            C::Type,
            C::AssigneeId,
            C::AssigneeIds,
            C::ReporterId,
            C::SprintId,
            C::MilestoneId,
            C::DeliverableId,
            C::ParentTaskId,
            C::StartDate,
            C::DueDate,
            C::EstimatedHours,
            C::Duration,
            C::StoryPoints,
            C::Tags,
            C::Labels,
            C::IsBillable,
            C::CustomerId,
            C::ContactId,
            C::PersonId,
            C::CustomFields,
            C::DependsOn,
            C::Blocks,
            C::Repeat,
            C::Position,
            C::Progress,
            C::CreatedAt,
            C::UpdatedAt,
            C::SourceType,
            C::SourceId,
        ])
        .values([
            Expr::val(&id),
            Expr::val(number),
            Expr::val(project_id.as_deref()),
            Expr::val(text(data, "title")),
            Expr::val(text(data, "description")),
            Expr::val(&status),
            Expr::val(stage_id),
            Expr::val(priority.as_deref().unwrap_or("medium")),
            Expr::val(kind),
            Expr::val(assignee_ids.first().map(String::as_str)),
            Expr::val((!assignee_ids.is_empty()).then(|| json!(assignee_ids))),
            Expr::val(reporter),
            Expr::val(text(data, "sprintId")),
            Expr::val(text(data, "milestoneId")),
            Expr::val(text(data, "deliverableId")),
            Expr::val(text(data, "parentTaskId")),
            timestamp_text(start_date.as_deref()),
            timestamp_text(due_date.as_deref()),
            json_cast(&nullable(data, "estimatedHours"), "numeric"),
            json_cast(&nullable(data, "duration"), "int"),
            json_cast(&nullable(data, "storyPoints"), "int"),
            Expr::val(json_column(data, "tags")),
            Expr::val(json_column(data, "labels")),
            Expr::val(
                data.get("isBillable")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            ),
            Expr::val(text(data, "customerId")),
            Expr::val(text(data, "contactId")),
            Expr::val(text(data, "personId")),
            Expr::val(json_column(data, "customFields")),
            Expr::val(json_column(data, "dependsOn")),
            Expr::val(json_column(data, "blocks")),
            Expr::val(json_column(data, "repeat")),
            Expr::val(position),
            zero_progress(),
            Expr::val(now),
            Expr::val(now),
            Expr::val(text(data, "sourceType")),
            Expr::val(text(data, "sourceId")),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .on_conflict(OnConflict::column(C::Id).do_nothing().to_owned());
    if run_insert(&orm(db), &insert).await? == 0 {
        return Ok(None);
    }

    let row = read_back(db, &id)
        .await?
        .unwrap_or_else(|| json!({ "id": id }));
    Ok(Some(CreatedTask { row, assignee_ids }))
}

/// `findExistingOccurrence`: an open copy due on the same date already
/// stands in for the next occurrence.
async fn existing_occurrence(
    db: &PgPool,
    source: &Map<String, Value>,
    due_ms: i64,
) -> Result<Option<String>, DbErr> {
    // `is not distinct from`: equal, or both null.
    let same = |column: tasks::Column, value: Option<&str>| match value {
        Some(value) => column.eq(value),
        None => column.is_null(),
    };
    tasks::Entity::find()
        .select_only()
        .column(tasks::Column::Id)
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(same(
            tasks::Column::ProjectId,
            text(source, "projectId").filter(|p| !p.is_empty()),
        ))
        .filter(tasks::Column::Title.eq(text(source, "title")))
        .filter(tasks::Column::DueDate.eq(timestamp_of_millis(due_ms)))
        .filter(tasks::Column::Status.is_not_in(["done", "cancelled"]))
        .filter(same(tasks::Column::AssigneeId, text(source, "assigneeId")))
        .filter(same(tasks::Column::ParentTaskId, text(source, "parentTaskId")))
        .filter(tasks::Column::Repeat.is_not_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `createNextOccurrence(db, source, now)`: a fresh `todo` copy of a
/// completed repeating task, due on its next date and placed in the
/// project's To Do stage. `None` when the task does not repeat (usably) or
/// an open copy already exists.
pub async fn create_next_occurrence(
    db: &PgPool,
    source: &Map<String, Value>,
    now_ms: i64,
) -> Result<Option<Value>, CreateError> {
    let Some(repeat) = source.get("repeat").filter(|r| !r.is_null()) else {
        return Ok(None);
    };
    let Some(config) = RepeatConfig::of(repeat).filter(|c| c.step().is_some()) else {
        return Ok(None);
    };
    let due_ms = match text(source, "dueDate").filter(|d| !d.is_empty()) {
        Some(due) => Some(millis_of(due).ok_or(CreateError::InvalidDate)?),
        None => None,
    };
    let next_due_ms = next_occurrence_date(due_ms, &config, now_ms);
    let next_due = iso_from_millis(next_due_ms).ok_or(CreateError::InvalidDate)?;
    if existing_occurrence(db, source, next_due_ms).await?.is_some() {
        return Ok(None);
    }
    let start_ms = text(source, "startDate")
        .filter(|s| !s.is_empty())
        .and_then(millis_of);
    let next_start = match (start_ms, due_ms) {
        (Some(start), Some(due)) => iso_from_millis(next_due_ms - (due - start)),
        _ => None,
    };
    let project_id = text(source, "projectId").filter(|p| !p.is_empty());
    let position = next_position(db, project_id).await?;
    let number = allocate_task_number(&orm(db)).await?;
    let stage_id = stage_for_status(db, project_id, None, "todo").await?;
    let id = generate_id("task");
    let now = timestamp_of_millis(now_ms).ok_or(CreateError::InvalidDate)?;
    let or_default = |key: &str, fallback: &str| {
        text(source, key)
            .filter(|v| !v.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    use tasks::Column as C;
    let mut insert = Query::insert();
    insert
        .into_table(tasks::Entity)
        .columns([
            C::Id,
            C::Number,
            C::ProjectId,
            C::StageId,
            C::SprintId,
            C::MilestoneId,
            C::ParentTaskId,
            C::CustomerId,
            C::ContactId,
            C::PersonId,
            C::Title,
            C::Description,
            C::Status,
            C::Priority,
            C::Type,
            C::AssigneeId,
            C::AssigneeIds,
            C::ReporterId,
            C::StartDate,
            C::DueDate,
            C::EstimatedHours,
            C::Duration,
            C::StoryPoints,
            C::Tags,
            C::Labels,
            C::IsBillable,
            C::Repeat,
            C::CustomFields,
            C::Position,
            C::Progress,
            C::CreatedAt,
            C::UpdatedAt,
        ])
        .values([
            Expr::val(&id),
            Expr::val(number),
            Expr::val(text(source, "projectId")),
            Expr::val(stage_id),
            Expr::val(text(source, "sprintId")),
            Expr::val(text(source, "milestoneId")),
            Expr::val(text(source, "parentTaskId")),
            Expr::val(text(source, "customerId")),
            Expr::val(text(source, "contactId")),
            Expr::val(text(source, "personId")),
            Expr::val(text(source, "title")),
            Expr::val(text(source, "description")),
            Expr::val("todo"),
            Expr::val(or_default("priority", "medium")),
            Expr::val(or_default("type", "task")),
            Expr::val(text(source, "assigneeId")),
            Expr::val(json_column(source, "assigneeIds")),
            Expr::val(text(source, "reporterId")),
            timestamp_text(next_start.as_deref()),
            timestamp_text(Some(&next_due)),
            json_cast(&nullable(source, "estimatedHours"), "numeric"),
            json_cast(&nullable(source, "duration"), "int"),
            json_cast(&nullable(source, "storyPoints"), "int"),
            Expr::val(json_column(source, "tags")),
            Expr::val(json_column(source, "labels")),
            Expr::val(
                source
                    .get("isBillable")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            ),
            Expr::val(whole(repeat.clone())),
            Expr::val(json_column(source, "customFields")),
            Expr::val(position),
            zero_progress(),
            Expr::val(now),
            Expr::val(now),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    run_insert(&orm(db), &insert).await?;
    Ok(read_back(db, &id).await?)
}
