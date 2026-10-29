//! Subtask trees (`@weldsuite/flow-domain/task-tree`): a task deleted with
//! its whole subtask tree, its calendar slots, its comments and
//! attachments, and the links other tasks hold to it. flow-api's
//! `DELETE /api/tasks/:id`, external-api and the mcp-server share it.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_events::iso_timestamp;

/// How many subtask levels below a task are followed.
pub const MAX_SUBTASK_DEPTH: usize = 10;

/// A task removed by [`soft_delete_task_tree`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedTask {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub calendar_event_id: Option<String>,
}

type Row = (String, Option<String>, String, Option<String>);

impl From<Row> for RemovedTask {
    fn from((id, project_id, title, calendar_event_id): Row) -> Self {
        Self {
            id,
            project_id,
            title,
            calendar_event_id,
        }
    }
}

/// The ids under `frontier` (BFS over `parent_task_id`, live tasks only),
/// in the table's order, without the ones already `seen`.
pub async fn live_children(
    db: &PgPool,
    frontier: &[String],
) -> Result<Vec<(String, Option<String>, String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "select id, project_id, title, calendar_event_id from tasks
         where parent_task_id = any($1) and deleted_at is null",
    )
    .bind(frontier)
    .fetch_all(db)
    .await
}

/// `softDeleteTaskTree(db, id)`: the removed tasks, the requested one
/// first, or `None` when it does not exist or is already deleted. One
/// transaction: the tasks, their calendar slots, comments and attachment
/// rows, and the removed ids pruned from every other live task's
/// `dependsOn` / `blocks`. Publishing the events is the caller's job.
pub async fn soft_delete_task_tree(
    db: &PgPool,
    id: &str,
) -> Result<Option<Vec<RemovedTask>>, sqlx::Error> {
    let existing: Option<Row> = sqlx::query_as(
        "select id, project_id, title, calendar_event_id from tasks
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    let mut removed: Vec<RemovedTask> = vec![existing.into()];
    let mut removed_ids: Vec<String> = vec![id.to_owned()];
    let mut frontier = vec![id.to_owned()];
    for _ in 0..MAX_SUBTASK_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let children = live_children(db, &frontier).await?;
        let fresh: Vec<RemovedTask> = children
            .into_iter()
            .map(RemovedTask::from)
            .filter(|row| !removed_ids.contains(&row.id))
            .collect();
        if fresh.is_empty() {
            break;
        }
        removed_ids.extend(fresh.iter().map(|row| row.id.clone()));
        frontier = fresh.iter().map(|row| row.id.clone()).collect();
        removed.extend(fresh);
    }

    let dependents: Vec<(String, Option<Value>, Option<Value>)> = sqlx::query_as(
        "select id, depends_on, blocks from tasks
         where deleted_at is null
           and (depends_on::jsonb ?| $1::text[] or blocks::jsonb ?| $1::text[])",
    )
    .bind(&removed_ids)
    .fetch_all(db)
    .await?;
    let calendar_event_ids: Vec<String> = removed
        .iter()
        .filter_map(|row| row.calendar_event_id.clone())
        .filter(|id| !id.is_empty())
        .collect();

    write_removal(db, &removed_ids, &calendar_event_ids, dependents).await?;
    Ok(Some(removed))
}

/// The removal's writes, as one transaction.
async fn write_removal(
    db: &PgPool,
    removed_ids: &[String],
    calendar_event_ids: &[String],
    dependents: Vec<(String, Option<Value>, Option<Value>)>,
) -> Result<(), sqlx::Error> {
    let now = iso_timestamp(time::OffsetDateTime::now_utc());
    let mut tx = db.begin().await?;
    sqlx::query(
        "update tasks set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = any($1) and deleted_at is null",
    )
    .bind(removed_ids)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    if !calendar_event_ids.is_empty() {
        sqlx::query(
            "update calendar_events set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = any($1) and deleted_at is null",
        )
        .bind(calendar_event_ids)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "update task_comments set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where task_id = any($1) and deleted_at is null",
    )
    .bind(removed_ids)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update files set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where entity_type = 'task' and entity_id = any($1) and deleted_at is null",
    )
    .bind(removed_ids)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    for (dependent, depends_on, blocks) in dependents {
        if removed_ids.contains(&dependent) {
            continue;
        }
        let prune = |list: Option<Value>| {
            let items = match list {
                Some(Value::Array(items)) => items,
                _ => Vec::new(),
            };
            Value::Array(
                items
                    .into_iter()
                    .filter(|item| {
                        item.as_str()
                            .is_none_or(|item| !removed_ids.iter().any(|r| r == item))
                    })
                    .collect(),
            )
        };
        sqlx::query(
            "update tasks set depends_on = $2, blocks = $3, updated_at = $4::timestamp where id = $1",
        )
        .bind(&dependent)
        .bind(prune(depends_on))
        .bind(prune(blocks))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// The `{ id, title }` of a removed task, as the `deleted` events carry it.
pub fn removed_event_data(row: &RemovedTask) -> Value {
    json!({ "id": row.id, "title": row.title })
}
