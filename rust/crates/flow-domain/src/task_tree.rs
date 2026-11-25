//! Subtask trees (`@weldsuite/flow-domain/task-tree`): a task deleted with
//! its whole subtask tree, its calendar slots, its comments and
//! attachments, its project-control links, and the links other tasks hold
//! to it. flow-api's
//! `DELETE /api/tasks/:id`, external-api and the mcp-server share it.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, orm_error, utc_now};
use weldsuite_schema::tenant::{
    calendar_events, files, project_control_links, task_comments, task_dependencies, tasks,
};

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
) -> Result<Vec<(String, Option<String>, String, Option<String>)>, DbErr> {
    removal_columns()
        .filter(tasks::Column::ParentTaskId.is_in(frontier))
        .filter(tasks::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `select id, project_id, title, calendar_event_id from tasks`.
fn removal_columns() -> sea_orm::Select<tasks::Entity> {
    tasks::Entity::find().select_only().columns([
        tasks::Column::Id,
        tasks::Column::ProjectId,
        tasks::Column::Title,
        tasks::Column::CalendarEventId,
    ])
}

/// `softDeleteTaskTree(db, id)`: the removed tasks, the requested one
/// first, or `None` when it does not exist or is already deleted. One
/// transaction: the tasks, their calendar slots, comments and attachment
/// rows, their project-control links (deleted for real, FLOW-011), their typed
/// `task_dependencies` rows (deleted for real, FLOW-015), the removed ids
/// pruned from every other live task's `dependsOn` / `blocks`, and the
/// items of a removed epic or feature unlinked (FLOW-023; never deleted).
/// Publishing the events is the caller's job (no link events, as in
/// TypeScript).
pub async fn soft_delete_task_tree(
    db: &PgPool,
    id: &str,
) -> Result<Option<Vec<RemovedTask>>, DbErr> {
    let existing: Option<Row> = removal_columns()
        .filter(tasks::Column::Id.eq(id))
        .filter(tasks::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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

    // `depends_on ?| ids or blocks ?| ids`: the lists are arrays of ids, so
    // holding one of them is containing `[id]`.
    let mut holds_one = Condition::any();
    for column in [tasks::Column::DependsOn, tasks::Column::Blocks] {
        for removed_id in &removed_ids {
            holds_one = holds_one.add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
                Expr::col((tasks::Entity, column)),
                json!([removed_id]),
            ));
        }
    }
    let dependents: Vec<(String, Option<Value>, Option<Value>)> = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::Id,
            tasks::Column::DependsOn,
            tasks::Column::Blocks,
        ])
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(holds_one)
        .into_tuple()
        .all(&orm(db))
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
) -> Result<(), DbErr> {
    let now = utc_now();
    let mut tx = db.begin().await.map_err(orm_error)?;
    remove_on(
        &OrmConn::new(&mut tx),
        removed_ids,
        calendar_event_ids,
        dependents,
        now,
    )
    .await?;
    tx.commit().await.map_err(orm_error)
}

/// [`write_removal`]'s statements, in order, on its transaction.
async fn remove_on(
    tx: &impl ConnectionTrait,
    removed_ids: &[String],
    calendar_event_ids: &[String],
    dependents: Vec<(String, Option<Value>, Option<Value>)>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    tasks::Entity::update_many()
        .col_expr(tasks::Column::DeletedAt, Expr::val(now))
        .col_expr(tasks::Column::UpdatedAt, Expr::val(now))
        .filter(tasks::Column::Id.is_in(removed_ids))
        .filter(tasks::Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    // FLOW-023: the items of a removed epic or feature stay, unlinked.
    tasks::Entity::update_many()
        .col_expr(tasks::Column::EpicId, Expr::val(Option::<String>::None))
        .col_expr(tasks::Column::UpdatedAt, Expr::val(now))
        .filter(tasks::Column::EpicId.is_in(removed_ids))
        .filter(tasks::Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    if !calendar_event_ids.is_empty() {
        calendar_events::Entity::update_many()
            .col_expr(calendar_events::Column::DeletedAt, Expr::val(now))
            .col_expr(calendar_events::Column::UpdatedAt, Expr::val(now))
            .filter(calendar_events::Column::Id.is_in(calendar_event_ids))
            .filter(calendar_events::Column::DeletedAt.is_null())
            .exec(tx)
            .await?;
    }
    task_comments::Entity::update_many()
        .col_expr(task_comments::Column::DeletedAt, Expr::val(now))
        .col_expr(task_comments::Column::UpdatedAt, Expr::val(now))
        .filter(task_comments::Column::TaskId.is_in(removed_ids))
        .filter(task_comments::Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    files::Entity::update_many()
        .col_expr(files::Column::DeletedAt, Expr::val(now))
        .col_expr(files::Column::UpdatedAt, Expr::val(now))
        .filter(files::Column::EntityType.eq("task"))
        .filter(files::Column::EntityId.is_in(removed_ids))
        .filter(files::Column::DeletedAt.is_null())
        .exec(tx)
        .await?;
    // FLOW-011: a task's project-control links go with it, deleted for real.
    project_control_links::Entity::delete_many()
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(project_control_links::Column::FromType.eq("task"))
                        .add(project_control_links::Column::FromId.is_in(removed_ids)),
                )
                .add(
                    Condition::all()
                        .add(project_control_links::Column::ToType.eq("task"))
                        .add(project_control_links::Column::ToId.is_in(removed_ids)),
                ),
        )
        .exec(tx)
        .await?;
    // FLOW-015: so are the typed dependency rows.
    task_dependencies::Entity::delete_many()
        .filter(
            Condition::any()
                .add(task_dependencies::Column::PredecessorId.is_in(removed_ids))
                .add(task_dependencies::Column::SuccessorId.is_in(removed_ids)),
        )
        .exec(tx)
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
        tasks::Entity::update_many()
            .col_expr(tasks::Column::DependsOn, Expr::val(prune(depends_on)))
            .col_expr(tasks::Column::Blocks, Expr::val(prune(blocks)))
            .col_expr(tasks::Column::UpdatedAt, Expr::val(now))
            .filter(tasks::Column::Id.eq(&dependent))
            .exec(tx)
            .await?;
    }
    Ok(())
}

/// The `{ id, title }` of a removed task, as the `deleted` events carry it.
pub fn removed_event_data(row: &RemovedTask) -> Value {
    json!({ "id": row.id, "title": row.title })
}
