//! Project-scoped references on a task (`@weldsuite/flow-domain/task-relations`):
//! its sprint, milestone, deliverable, pipeline stage and parent must belong
//! to the task's own project.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{milestones, project_deliverables, project_pipeline_stages, sprints, tasks};

/// The references a body may set; `None` (or empty) is "not set".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskReferences {
    pub sprint_id: Option<String>,
    pub milestone_id: Option<String>,
    pub deliverable_id: Option<String>,
    pub stage_id: Option<String>,
    pub parent_task_id: Option<String>,
}

fn set(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|id| !id.is_empty())
}

const SPRINT: [sprints::Column; 3] = [
    sprints::Column::Id,
    sprints::Column::ProjectId,
    sprints::Column::DeletedAt,
];
const MILESTONE: [milestones::Column; 3] = [
    milestones::Column::Id,
    milestones::Column::ProjectId,
    milestones::Column::DeletedAt,
];
const DELIVERABLE: [project_deliverables::Column; 3] = [
    project_deliverables::Column::Id,
    project_deliverables::Column::ProjectId,
    project_deliverables::Column::DeletedAt,
];
const STAGE: [project_pipeline_stages::Column; 3] = [
    project_pipeline_stages::Column::Id,
    project_pipeline_stages::Column::ProjectId,
    project_pipeline_stages::Column::DeletedAt,
];

/// `select id from <table> where id = $1 and project_id = $2 and deleted_at
/// is null limit 1` found a row. `columns` are the table's `id`,
/// `project_id` and `deleted_at`.
async fn exists_in_project<E: EntityTrait>(
    db: &PgPool,
    columns: [E::Column; 3],
    id: &str,
    project_id: &str,
) -> Result<bool, DbErr> {
    let [id_column, project_column, deleted_column] = columns;
    let found: Option<String> = E::find()
        .select_only()
        .column(id_column)
        .filter(id_column.eq(id))
        .filter(project_column.eq(project_id))
        .filter(deleted_column.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `findInvalidTaskReference(db, projectId, refs)`: the message of the
/// first invalid reference (sprint, milestone, deliverable, stage, parent), or
/// `None`.
pub async fn find_invalid_task_reference(
    db: &PgPool,
    project_id: Option<&str>,
    refs: &TaskReferences,
) -> Result<Option<String>, DbErr> {
    if let Some(sprint_id) = set(refs.sprint_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot be added to a sprint".to_owned(),
            ));
        };
        if !exists_in_project::<sprints::Entity>(db, SPRINT, sprint_id, project_id).await?
        {
            return Ok(Some(format!("Sprint {sprint_id} not found in this project")));
        }
    }
    if let Some(milestone_id) = set(refs.milestone_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot be added to a milestone".to_owned(),
            ));
        };
        if !exists_in_project::<milestones::Entity>(db, MILESTONE, milestone_id, project_id)
            .await?
        {
            return Ok(Some(format!(
                "Milestone {milestone_id} not found in this project"
            )));
        }
    }
    if let Some(deliverable_id) = set(refs.deliverable_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot count toward a deliverable".to_owned(),
            ));
        };
        if !exists_in_project::<project_deliverables::Entity>(
            db,
            DELIVERABLE,
            deliverable_id,
            project_id,
        )
        .await?
        {
            return Ok(Some(format!(
                "Deliverable {deliverable_id} not found in this project"
            )));
        }
    }
    if let Some(stage_id) = set(refs.stage_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot be placed in a pipeline stage".to_owned(),
            ));
        };
        if !exists_in_project::<project_pipeline_stages::Entity>(db, STAGE, stage_id, project_id)
            .await?
        {
            return Ok(Some(format!(
                "Pipeline stage {stage_id} not found in this project"
            )));
        }
    }
    if let Some(parent_id) = set(refs.parent_task_id.as_ref()) {
        let parent: Option<Option<String>> = tasks::Entity::find()
            .select_only()
            .column(tasks::Column::ProjectId)
            .filter(tasks::Column::Id.eq(parent_id))
            .filter(tasks::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        let Some(parent_project) = parent else {
            return Ok(Some(format!("Parent task {parent_id} not found")));
        };
        if parent_project.as_deref() != project_id {
            return Ok(Some(
                "Parent task must belong to the same project".to_owned(),
            ));
        }
    }
    Ok(None)
}

/// `changedTaskReferences(existing, data)`: the references a PATCH sets to
/// a value other than the stored one.
pub fn changed_task_references(existing: &TaskReferences, data: &TaskReferences) -> TaskReferences {
    let changed = |next: &Option<String>, current: &Option<String>| {
        next.as_ref()
            .filter(|next| !next.is_empty() && Some(*next) != current.as_ref())
            .cloned()
    };
    TaskReferences {
        sprint_id: changed(&data.sprint_id, &existing.sprint_id),
        milestone_id: changed(&data.milestone_id, &existing.milestone_id),
        deliverable_id: changed(&data.deliverable_id, &existing.deliverable_id),
        stage_id: changed(&data.stage_id, &existing.stage_id),
        parent_task_id: changed(&data.parent_task_id, &existing.parent_task_id),
    }
}
