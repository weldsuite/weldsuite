//! Keeping a task's `status` and its board stage in step
//! (`@weldsuite/flow-domain/task-stage`), and the task status spellings
//! (`@weldsuite/app-api-client/schemas/tasks`).

use sqlx::PgPool;

/// The built-in task statuses.
pub const TASK_STATUSES: [&str; 7] = [
    "backlog",
    "todo",
    "in_progress",
    "review",
    "testing",
    "done",
    "cancelled",
];

/// `normalizeTaskStatus`: legacy spellings (`in_review`) map to `review`.
pub fn normalize_task_status(status: &str) -> String {
    if status == "in_review" {
        "review".to_owned()
    } else {
        status.to_owned()
    }
}

/// [`normalize_task_status`] over an optional status.
pub fn normalize_status_opt(status: Option<&str>) -> Option<String> {
    status.map(normalize_task_status)
}

/// `taskStatusAliases`: every stored spelling of a status.
pub fn task_status_aliases(status: &str) -> Vec<String> {
    let canonical = normalize_task_status(status);
    let mut out = vec![canonical.clone()];
    if canonical == "review" {
        out.push("in_review".to_owned());
    }
    out
}

async fn live_stages(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "select id, system_status from project_pipeline_stages
         where project_id = $1 and deleted_at is null
         order by position asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
}

/// `statusFromStage`: the status a stage stands for, `None` for no stage,
/// an unknown one, or one without a status.
pub async fn status_from_stage(
    db: &PgPool,
    stage_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(stage_id) = stage_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let status: Option<Option<String>> = sqlx::query_scalar(
        "select system_status from project_pipeline_stages where id = $1 limit 1",
    )
    .bind(stage_id)
    .fetch_optional(db)
    .await?;
    Ok(status
        .flatten()
        .map(|s| normalize_task_status(&s))
        .filter(|s| !s.is_empty()))
}

/// `stageForStatus`: the stage a task moves to on a status-only change;
/// `None` leaves it as is.
pub async fn stage_for_status(
    db: &PgPool,
    project_id: Option<&str>,
    stage_id: Option<&str>,
    status: &str,
) -> Result<Option<String>, sqlx::Error> {
    let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let stages = live_stages(db, project_id).await?;
    let target = normalize_task_status(status);
    let matches =
        |s: &Option<String>| normalize_status_opt(s.as_deref()).as_deref() == Some(&target);
    if let Some(current) = stages.iter().find(|s| Some(s.0.as_str()) == stage_id)
        && matches(&current.1)
    {
        return Ok(None);
    }
    Ok(stages.iter().find(|s| matches(&s.1)).map(|s| s.0.clone()))
}

/// Where a task lands in a project with its status (`stagePlacement`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub stage_id: Option<String>,
    pub status: Option<String>,
    pub matched: bool,
}

/// A project's stages, ready to place tasks (`stagePlacement(db, projectId)`).
#[derive(Debug, Clone)]
pub struct StagePlacement {
    by_status: Vec<(Option<String>, String)>,
    fallback: Placement,
}

impl StagePlacement {
    /// `place(status)`.
    pub fn place(&self, status: Option<&str>) -> Placement {
        let target = normalize_status_opt(status);
        if let Some(target) = target.filter(|t| !t.is_empty())
            && let Some((_, stage_id)) = self
                .by_status
                .iter()
                .find(|(s, _)| s.as_deref() == Some(target.as_str()))
        {
            return Placement {
                stage_id: Some(stage_id.clone()),
                status: Some(target),
                matched: true,
            };
        }
        self.fallback.clone()
    }
}

/// `stagePlacement(db, projectId)`.
pub async fn stage_placement(db: &PgPool, project_id: &str) -> Result<StagePlacement, sqlx::Error> {
    let stages = live_stages(db, project_id).await?;
    let mut by_status: Vec<(Option<String>, String)> = Vec::new();
    for (id, system_status) in &stages {
        let status = normalize_status_opt(system_status.as_deref());
        if !by_status.iter().any(|(s, _)| *s == status) {
            by_status.push((status, id.clone()));
        }
    }
    let fallback = match stages.first() {
        Some((id, status)) => Placement {
            stage_id: Some(id.clone()),
            status: normalize_status_opt(status.as_deref()),
            matched: false,
        },
        None => Placement {
            stage_id: None,
            status: Some("todo".to_owned()),
            matched: false,
        },
    };
    Ok(StagePlacement {
        by_status,
        fallback,
    })
}

/// What `applyStatusChange` decided for an update.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusChange {
    /// The status to write (`update.status`), when it changes.
    pub status: Option<String>,
    /// The stage to write (`update.stageId`), when a status-only change moves it.
    pub stage_id: Option<String>,
    /// The task moves to done: stamp `completedDate`.
    pub completes: bool,
    /// The status the task ends up with.
    pub resolved: Option<String>,
}

/// `applyStatusChange(db, existing, data, update)`: a stage change sets
/// the status, a status-only change moves the stage, and a move to done
/// stamps the completion. `status` is the update's status so far (the
/// body's), `stage_sent` whether the body carried `stageId` at all.
pub async fn apply_status_change(
    db: &PgPool,
    existing_project: Option<&str>,
    existing_stage: Option<&str>,
    existing_status: Option<&str>,
    stage_sent: Option<Option<&str>>,
    status: Option<String>,
) -> Result<StatusChange, sqlx::Error> {
    let mut status = status;
    let mut stage_id = None;
    if let Some(stage_status) = status_from_stage(db, stage_sent.flatten()).await? {
        status = Some(stage_status);
    }
    if stage_sent.is_none()
        && let Some(next) = &status
    {
        stage_id = stage_for_status(db, existing_project, existing_stage, next).await?;
    }
    let resolved = status
        .clone()
        .or_else(|| existing_status.map(str::to_owned));
    let completes = resolved.as_deref() == Some("done") && existing_status != Some("done");
    Ok(StatusChange {
        status,
        stage_id,
        completes,
        resolved,
    })
}
