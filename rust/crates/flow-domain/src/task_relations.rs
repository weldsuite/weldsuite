//! Project-scoped references on a task (`@weldsuite/flow-domain/task-relations`):
//! its sprint, milestone, pipeline stage and parent must belong to the
//! task's own project.

use sqlx::PgPool;

/// The references a body may set; `None` (or empty) is "not set".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskReferences {
    pub sprint_id: Option<String>,
    pub milestone_id: Option<String>,
    pub stage_id: Option<String>,
    pub parent_task_id: Option<String>,
}

fn set(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|id| !id.is_empty())
}

async fn exists_in_project(
    db: &PgPool,
    sql: &'static str,
    id: &str,
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(sql)
        .bind(id)
        .bind(project_id)
        .fetch_optional(db)
        .await?;
    Ok(found.is_some())
}

/// `findInvalidTaskReference(db, projectId, refs)`: the message of the
/// first invalid reference (sprint, milestone, stage, parent), or `None`.
pub async fn find_invalid_task_reference(
    db: &PgPool,
    project_id: Option<&str>,
    refs: &TaskReferences,
) -> Result<Option<String>, sqlx::Error> {
    if let Some(sprint_id) = set(refs.sprint_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot be added to a sprint".to_owned(),
            ));
        };
        if !exists_in_project(
            db,
            "select id from sprints where id = $1 and project_id = $2 and deleted_at is null limit 1",
            sprint_id,
            project_id,
        )
        .await?
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
        if !exists_in_project(
            db,
            "select id from milestones where id = $1 and project_id = $2 and deleted_at is null limit 1",
            milestone_id,
            project_id,
        )
        .await?
        {
            return Ok(Some(format!(
                "Milestone {milestone_id} not found in this project"
            )));
        }
    }
    if let Some(stage_id) = set(refs.stage_id.as_ref()) {
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Ok(Some(
                "A task without a project cannot be placed in a pipeline stage".to_owned(),
            ));
        };
        if !exists_in_project(
            db,
            "select id from project_pipeline_stages
             where id = $1 and project_id = $2 and deleted_at is null limit 1",
            stage_id,
            project_id,
        )
        .await?
        {
            return Ok(Some(format!(
                "Pipeline stage {stage_id} not found in this project"
            )));
        }
    }
    if let Some(parent_id) = set(refs.parent_task_id.as_ref()) {
        let parent: Option<Option<String>> = sqlx::query_scalar(
            "select project_id from tasks where id = $1 and deleted_at is null limit 1",
        )
        .bind(parent_id)
        .fetch_optional(db)
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
        stage_id: changed(&data.stage_id, &existing.stage_id),
        parent_task_id: changed(&data.parent_task_id, &existing.parent_task_id),
    }
}
