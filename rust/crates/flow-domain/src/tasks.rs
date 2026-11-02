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

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::js_row;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

use crate::js::{iso_from_millis, js_date, millis_of};
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
    Database(sqlx::Error),
    /// A date JavaScript cannot turn into a timestamp (`toISOString` throws).
    InvalidDate,
}

impl From<sqlx::Error> for CreateError {
    fn from(error: sqlx::Error) -> Self {
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
async fn next_position(db: &PgPool, project_id: Option<&str>) -> Result<i32, sqlx::Error> {
    let max: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from tasks
         where ($1::text is null or project_id = $1) and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    Ok(max.max(0) + 1)
}

async fn read_back(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) || jsonb_build_object('progress', t.progress::text,
             'estimated_hours', t.estimated_hours::text, 'actual_hours', t.actual_hours::text)
         from tasks t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
    let project_id = project_id
        .map(str::to_owned)
        .or_else(|| text(data, "projectId").map(str::to_owned));
    let id = generate_id("task");
    let now = iso_timestamp(time::OffsetDateTime::now_utc());
    let number = allocate_task_number(db).await?;
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
        priority = sqlx::query_scalar(
            "select priority from tasks where id = $1 and deleted_at is null limit 1",
        )
        .bind(parent)
        .fetch_optional(db)
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

    sqlx::query(
        "insert into tasks (id, number, project_id, title, description, status, stage_id, priority,
             type, assignee_id, assignee_ids, reporter_id, sprint_id, milestone_id, parent_task_id,
             start_date, due_date, estimated_hours, duration, story_points, tags, labels,
             is_billable, customer_id, contact_id, person_id, custom_fields, depends_on, blocks,
             repeat, position, progress, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16::timestamp, $17::timestamp, ($18::jsonb #>> '{}')::numeric,
                 ($19::jsonb #>> '{}')::int, ($20::jsonb #>> '{}')::int, $21, $22,
                 $23, $24, $25, $26, $27, $28, $29, $30, $31, '0', $32::timestamp, $32::timestamp)",
    )
    .bind(&id)
    .bind(number)
    .bind(project_id.as_deref())
    .bind(text(data, "title"))
    .bind(text(data, "description"))
    .bind(&status)
    .bind(stage_id)
    .bind(priority.as_deref().unwrap_or("medium"))
    .bind(kind)
    .bind(assignee_ids.first())
    .bind((!assignee_ids.is_empty()).then(|| json!(assignee_ids)))
    .bind(reporter)
    .bind(text(data, "sprintId"))
    .bind(text(data, "milestoneId"))
    .bind(text(data, "parentTaskId"))
    .bind(start_date)
    .bind(due_date)
    .bind(nullable(data, "estimatedHours"))
    .bind(nullable(data, "duration"))
    .bind(nullable(data, "storyPoints"))
    .bind(json_column(data, "tags"))
    .bind(json_column(data, "labels"))
    .bind(
        data.get("isBillable")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    )
    .bind(text(data, "customerId"))
    .bind(text(data, "contactId"))
    .bind(text(data, "personId"))
    .bind(json_column(data, "customFields"))
    .bind(json_column(data, "dependsOn"))
    .bind(json_column(data, "blocks"))
    .bind(json_column(data, "repeat"))
    .bind(position)
    .bind(&now)
    .execute(db)
    .await?;

    let row = read_back(db, &id)
        .await?
        .unwrap_or_else(|| json!({ "id": id }));
    Ok(CreatedTask { row, assignee_ids })
}

/// `findExistingOccurrence`: an open copy due on the same date already
/// stands in for the next occurrence.
async fn existing_occurrence(
    db: &PgPool,
    source: &Map<String, Value>,
    due: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from tasks
         where deleted_at is null
           and (case when $1::text is null then project_id is null else project_id = $1 end)
           and title = $2 and due_date = $3::timestamp
           and status not in ('done', 'cancelled')
           and assignee_id is not distinct from $4
           and parent_task_id is not distinct from $5
           and repeat is not null
         limit 1",
    )
    .bind(text(source, "projectId").filter(|p| !p.is_empty()))
    .bind(text(source, "title"))
    .bind(due)
    .bind(text(source, "assigneeId"))
    .bind(text(source, "parentTaskId"))
    .fetch_optional(db)
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
    if existing_occurrence(db, source, &next_due).await?.is_some() {
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
    let number = allocate_task_number(db).await?;
    let stage_id = stage_for_status(db, project_id, None, "todo").await?;
    let id = generate_id("task");
    let now = iso_from_millis(now_ms).ok_or(CreateError::InvalidDate)?;
    let or_default = |key: &str, fallback: &str| {
        text(source, key)
            .filter(|v| !v.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    sqlx::query(
        "insert into tasks (id, number, project_id, stage_id, sprint_id, milestone_id,
             parent_task_id, customer_id, contact_id, person_id, title, description, status,
             priority, type, assignee_id, assignee_ids, reporter_id, start_date, due_date,
             estimated_hours, duration, story_points, tags, labels, is_billable, repeat,
             custom_fields, position, progress, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'todo', $13, $14, $15, $16,
                 $17, $18::timestamp, $19::timestamp, ($20::jsonb #>> '{}')::numeric,
                 ($21::jsonb #>> '{}')::int, ($22::jsonb #>> '{}')::int, $23, $24,
                 coalesce($25, true), $26, $27, $28, '0', $29::timestamp, $29::timestamp)",
    )
    .bind(&id)
    .bind(number)
    .bind(text(source, "projectId"))
    .bind(stage_id)
    .bind(text(source, "sprintId"))
    .bind(text(source, "milestoneId"))
    .bind(text(source, "parentTaskId"))
    .bind(text(source, "customerId"))
    .bind(text(source, "contactId"))
    .bind(text(source, "personId"))
    .bind(text(source, "title"))
    .bind(text(source, "description"))
    .bind(or_default("priority", "medium"))
    .bind(or_default("type", "task"))
    .bind(text(source, "assigneeId"))
    .bind(json_column(source, "assigneeIds"))
    .bind(text(source, "reporterId"))
    .bind(next_start)
    .bind(&next_due)
    .bind(nullable(source, "estimatedHours"))
    .bind(nullable(source, "duration"))
    .bind(nullable(source, "storyPoints"))
    .bind(json_column(source, "tags"))
    .bind(json_column(source, "labels"))
    .bind(source.get("isBillable").and_then(Value::as_bool))
    .bind(whole(repeat.clone()))
    .bind(json_column(source, "customFields"))
    .bind(position)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(read_back(db, &id).await?)
}
