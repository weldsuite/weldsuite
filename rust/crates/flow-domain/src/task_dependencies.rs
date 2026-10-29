//! Task relation guards (`@weldsuite/flow-domain/task-dependencies`):
//! dependency links (`dependsOn` / `blocks`) with cycle detection and the
//! reciprocal side kept in sync, and the `parentTaskId` / `projectId`
//! checks of a write.
//!
//! The public API's workspace-wide keys and the MCP server check no
//! per-user project boundary ([`LinkAccess::Unchecked`]); flow-api adds the
//! caller's accessible projects ([`LinkAccess::Projects`]), as its own copy
//! of the plan does.

use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use weldsuite_events::iso_timestamp;

use crate::task_tree::soft_delete_task_tree;

/// Why a dependency change was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyFailure {
    /// The task itself is missing (`kind: 'not-found'`).
    NotFound(String),
    /// A bad link (`kind: 'invalid'`): a 400 with the message.
    Invalid(String),
    /// A linked task in a project the caller cannot see (`kind: 'forbidden'`).
    Forbidden(String),
}

impl DependencyFailure {
    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(message) | Self::Invalid(message) | Self::Forbidden(message) => message,
        }
    }
}

/// Which linked tasks a caller may add.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkAccess {
    /// Any live task (no per-user boundary).
    Unchecked,
    /// Tasks without a project, or in one of these projects; `None` is
    /// `projects:scope:all`.
    Projects(Option<Vec<String>>),
}

const LINKED_TASK_DENIED: &str = "You are not a member of a linked task's project";
const CIRCULAR: &str = "Circular dependency detected";

/// The links a body sets; `None` leaves that list as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkInput {
    pub depends_on: Option<Vec<String>>,
    pub blocks: Option<Vec<String>>,
}

/// A linked task's side of the change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReciprocalLink {
    pub id: String,
    pub blocks: Option<Vec<String>>,
    pub depends_on: Option<Vec<String>>,
}

/// What [`commit_dependency_update`] writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyPlan {
    pub depends_on: Vec<String>,
    pub blocks: Vec<String>,
    pub reciprocal: Vec<ReciprocalLink>,
}

/// `[...new Set(ids)]`.
pub fn unique(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// A `jsonb` string list (`(row.x as string[]) || []`).
pub fn id_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `detectCycle(db, taskId, newDependsOn)`: following `dependsOn` from
/// `new_depends_on` reaches `task_id`.
pub async fn detect_cycle(
    db: &PgPool,
    task_id: &str,
    new_depends_on: &[String],
) -> Result<bool, sqlx::Error> {
    let mut visited: Vec<String> = Vec::new();
    let mut queue: std::collections::VecDeque<String> = new_depends_on.iter().cloned().collect();
    while let Some(current) = queue.pop_front() {
        if current == task_id {
            return Ok(true);
        }
        if visited.contains(&current) {
            continue;
        }
        visited.push(current.clone());
        let depends_on: Option<Option<Value>> =
            sqlx::query_scalar("select depends_on from tasks where id = $1 limit 1")
                .bind(&current)
                .fetch_optional(db)
                .await?;
        if let Some(Some(depends_on)) = depends_on {
            queue.extend(id_list(Some(&depends_on)));
        }
    }
    Ok(false)
}

/// Every added link must be a live task other than `self_id`, in a
/// project the caller may access.
async fn check_links(
    db: &PgPool,
    self_id: Option<&str>,
    added: &[String],
    access: &LinkAccess,
) -> Result<Option<DependencyFailure>, sqlx::Error> {
    if added.is_empty() {
        return Ok(None);
    }
    if self_id.is_some_and(|me| added.iter().any(|id| id == me)) {
        return Ok(Some(DependencyFailure::Invalid(
            "A task cannot depend on or block itself".to_owned(),
        )));
    }
    let rows: Vec<(String, Option<String>, bool)> = sqlx::query_as(
        "select id, project_id, deleted_at is not null from tasks where id = any($1)",
    )
    .bind(added)
    .fetch_all(db)
    .await?;
    for linked in added {
        let live = rows.iter().any(|(id, _, deleted)| id == linked && !deleted);
        if !live {
            return Ok(Some(DependencyFailure::Invalid(format!(
                "Linked task {linked} not found"
            ))));
        }
    }
    if let LinkAccess::Projects(Some(accessible)) = access
        && rows.iter().any(|(_, project, _)| {
            project.as_deref().is_some_and(|project| {
                !project.is_empty() && !accessible.iter().any(|a| a == project)
            })
        })
    {
        return Ok(Some(DependencyFailure::Forbidden(
            LINKED_TASK_DENIED.to_owned(),
        )));
    }
    Ok(None)
}

async fn any_cycle(
    db: &PgPool,
    blocked: &[String],
    depends_on: &[String],
) -> Result<bool, sqlx::Error> {
    for blocked_id in blocked {
        if detect_cycle(db, blocked_id, depends_on).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `checkNewTaskLinks(db, input)`: the links of a task about to be
/// created exist and close no cycle.
pub async fn check_new_task_links(
    db: &PgPool,
    input: &LinkInput,
) -> Result<Option<DependencyFailure>, sqlx::Error> {
    let depends_on = unique(input.depends_on.as_deref().unwrap_or_default());
    let blocks = unique(input.blocks.as_deref().unwrap_or_default());
    let mut all = depends_on.clone();
    all.extend(blocks.iter().cloned());
    if let Some(failure) = check_links(db, None, &all, &LinkAccess::Unchecked).await? {
        return Ok(Some(failure));
    }
    if depends_on.iter().any(|id| blocks.contains(id))
        || any_cycle(db, &blocks, &depends_on).await?
    {
        return Ok(Some(DependencyFailure::Invalid(CIRCULAR.to_owned())));
    }
    Ok(None)
}

/// `planDependencyUpdate(db, id, input)`: the new lists and the
/// reciprocal rows, once the added links pass (existence, access,
/// cycles). Writes nothing.
pub async fn plan_dependency_update(
    db: &PgPool,
    id: &str,
    input: &LinkInput,
    access: &LinkAccess,
) -> Result<Result<DependencyPlan, DependencyFailure>, sqlx::Error> {
    let current: Option<(Option<Value>, Option<Value>)> = sqlx::query_as(
        "select depends_on, blocks from tasks where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((old_depends_on, old_blocks)) = current else {
        return Ok(Err(DependencyFailure::NotFound(format!(
            "Task {id} not found"
        ))));
    };
    let old_depends_on = id_list(old_depends_on.as_ref());
    let old_blocks = id_list(old_blocks.as_ref());
    let new_depends_on = input
        .depends_on
        .as_deref()
        .map_or_else(|| old_depends_on.clone(), unique);
    let new_blocks = input
        .blocks
        .as_deref()
        .map_or_else(|| old_blocks.clone(), unique);

    let minus = |a: &[String], b: &[String]| -> Vec<String> {
        a.iter().filter(|x| !b.contains(x)).cloned().collect()
    };
    let added_deps = minus(&new_depends_on, &old_depends_on);
    let removed_deps = minus(&old_depends_on, &new_depends_on);
    let added_blocks = minus(&new_blocks, &old_blocks);
    let removed_blocks = minus(&old_blocks, &new_blocks);

    let mut added = added_deps.clone();
    added.extend(added_blocks.iter().cloned());
    if let Some(failure) = check_links(db, Some(id), &added, access).await? {
        return Ok(Err(failure));
    }
    let cyclic = (!added_deps.is_empty() && detect_cycle(db, id, &added_deps).await?)
        || any_cycle(db, &added_blocks, &new_depends_on).await?;
    if cyclic {
        return Ok(Err(DependencyFailure::Invalid(CIRCULAR.to_owned())));
    }

    let mut linked: Vec<String> = Vec::new();
    for list in [&added_deps, &removed_deps, &added_blocks, &removed_blocks] {
        for linked_id in list {
            if !linked.contains(linked_id) {
                linked.push(linked_id.clone());
            }
        }
    }
    let mut reciprocal = Vec::new();
    if !linked.is_empty() {
        let rows: Vec<(String, Option<Value>, Option<Value>)> =
            sqlx::query_as("select id, blocks, depends_on from tasks where id = any($1)")
                .bind(&linked)
                .fetch_all(db)
                .await?;
        let with_self = |ids: Vec<String>| {
            let mut ids = unique(&ids);
            if !ids.iter().any(|x| x == id) {
                ids.push(id.to_owned());
            }
            ids
        };
        let without_self =
            |ids: Vec<String>| ids.into_iter().filter(|x| x != id).collect::<Vec<_>>();
        for (row_id, blocks, depends_on) in rows {
            let row_blocks = id_list(blocks.as_ref());
            let row_depends_on = id_list(depends_on.as_ref());
            let mut link = ReciprocalLink {
                id: row_id.clone(),
                blocks: None,
                depends_on: None,
            };
            if added_deps.contains(&row_id) {
                link.blocks = Some(with_self(row_blocks.clone()));
            }
            if removed_deps.contains(&row_id) {
                link.blocks = Some(without_self(row_blocks.clone()));
            }
            if added_blocks.contains(&row_id) {
                link.depends_on = Some(with_self(row_depends_on.clone()));
            }
            if removed_blocks.contains(&row_id) {
                link.depends_on = Some(without_self(row_depends_on.clone()));
            }
            reciprocal.push(link);
        }
    }
    Ok(Ok(DependencyPlan {
        depends_on: new_depends_on,
        blocks: new_blocks,
        reciprocal,
    }))
}

/// The reciprocal rows and the task's own lists, on a transaction the
/// caller opened (it may write the task's other columns on it too).
/// `now` is the `updatedAt` written.
pub async fn write_dependency_rows(
    conn: &mut PgConnection,
    id: &str,
    plan: &DependencyPlan,
    now: &str,
) -> Result<(), sqlx::Error> {
    for link in &plan.reciprocal {
        sqlx::query(
            "update tasks set
                 blocks = case when $2 then $3 else blocks end,
                 depends_on = case when $4 then $5 else depends_on end,
                 updated_at = $6::timestamp
             where id = $1",
        )
        .bind(&link.id)
        .bind(link.blocks.is_some())
        .bind(link.blocks.as_ref().map(|ids| serde_json::json!(ids)))
        .bind(link.depends_on.is_some())
        .bind(link.depends_on.as_ref().map(|ids| serde_json::json!(ids)))
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "update tasks set depends_on = $2, blocks = $3, updated_at = $4::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(serde_json::json!(plan.depends_on))
    .bind(serde_json::json!(plan.blocks))
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `commitDependencyUpdate(db, id, plan)`: the plan as one transaction.
pub async fn commit_dependency_update(
    db: &PgPool,
    id: &str,
    plan: &DependencyPlan,
) -> Result<(), sqlx::Error> {
    let now = iso_timestamp(time::OffsetDateTime::now_utc());
    let mut tx = db.begin().await?;
    write_dependency_rows(&mut tx, id, plan, &now).await?;
    tx.commit().await
}

/// `linkCreatedTask(db, id, input)`: the links of a task just created;
/// when they cannot be written the task is taken back out (soft-deleted)
/// and the failure returned.
pub async fn link_created_task(
    db: &PgPool,
    id: &str,
    input: &LinkInput,
) -> Result<Option<DependencyFailure>, sqlx::Error> {
    let planned = async {
        match plan_dependency_update(db, id, input, &LinkAccess::Unchecked).await? {
            Ok(plan) => commit_dependency_update(db, id, &plan).await.map(|()| None),
            Err(failure) => Ok(Some(failure)),
        }
    }
    .await;
    match planned {
        Ok(None) => Ok(None),
        Ok(Some(failure)) => {
            let _ = soft_delete_task_tree(db, id).await;
            Ok(Some(failure))
        }
        Err(error) => {
            let _ = soft_delete_task_tree(db, id).await;
            Err(error)
        }
    }
}

/// `isDescendantOf(db, candidateId, ancestorId)`: the candidate is the
/// ancestor or sits below it (its parent chain, at most 100 steps).
pub async fn is_descendant_of(
    db: &PgPool,
    candidate_id: &str,
    ancestor_id: &str,
) -> Result<bool, sqlx::Error> {
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = Some(candidate_id.to_owned());
    for _ in 0..100 {
        let Some(current) = cursor.filter(|id| !id.is_empty()) else {
            return Ok(false);
        };
        if current == ancestor_id {
            return Ok(true);
        }
        if seen.contains(&current) {
            return Ok(false);
        }
        let parent: Option<Option<String>> =
            sqlx::query_scalar("select parent_task_id from tasks where id = $1 limit 1")
                .bind(&current)
                .fetch_optional(db)
                .await?;
        seen.push(current);
        cursor = parent.flatten();
    }
    Ok(false)
}

/// The parent a write checks: `parentTaskId` absent, `null` or set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParentChange {
    Absent,
    Null,
    Set(String),
}

/// The new parent's own checks, shared by flow-api's PATCH and
/// [`validate_task_relations`]: a live task of `project_id`, not the task
/// itself or one of its descendants. `None` when fine.
pub async fn parent_error(
    db: &PgPool,
    id: Option<&str>,
    current_parent: Option<&str>,
    project_id: Option<&str>,
    parent: &ParentChange,
) -> Result<Option<String>, sqlx::Error> {
    let ParentChange::Set(parent_id) = parent else {
        return Ok(None);
    };
    if Some(parent_id.as_str()) == current_parent {
        return Ok(None);
    }
    if id == Some(parent_id.as_str()) {
        return Ok(Some("A task cannot be its own parent".to_owned()));
    }
    let row: Option<(Option<String>, bool)> = sqlx::query_as(
        "select project_id, deleted_at is not null from tasks where id = $1 limit 1",
    )
    .bind(parent_id)
    .fetch_optional(db)
    .await?;
    let Some((parent_project, false)) = row else {
        return Ok(Some(format!("Parent task {parent_id} not found")));
    };
    if parent_project.as_deref() != project_id {
        return Ok(Some(
            "Parent task must belong to the same project".to_owned(),
        ));
    }
    if let Some(id) = id
        && is_descendant_of(db, parent_id, id).await?
    {
        return Ok(Some(
            "Cannot move a task under itself or one of its subtasks".to_owned(),
        ));
    }
    Ok(None)
}

/// `validateTaskRelations(db, existing, id, data)`: a PATCH may only
/// repeat the task's project; a changed parent must pass
/// [`parent_error`]. `existing` is `(projectId, parentTaskId)`, `None` on
/// create; `project` is the body's `projectId` (`None` absent,
/// `Some(None)` null).
pub async fn validate_task_relations(
    db: &PgPool,
    existing: Option<(Option<&str>, Option<&str>)>,
    id: Option<&str>,
    project: Option<Option<&str>>,
    parent: &ParentChange,
) -> Result<Option<String>, sqlx::Error> {
    let current_project = existing.and_then(|(project, _)| project);
    if existing.is_some()
        && let Some(sent) = project
        && sent != current_project
    {
        return Ok(Some("projectId cannot be changed with PATCH".to_owned()));
    }
    let project_id = if existing.is_some() {
        current_project
    } else {
        project.flatten()
    };
    let current_parent = existing.and_then(|(_, parent)| parent);
    parent_error(db, id, current_parent, project_id, parent).await
}
