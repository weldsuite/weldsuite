//! The WeldFlow rules the record chat providers read
//! (`@weldsuite/flow-domain/project-access`, `/project-stats`): who may
//! write in a project, and a project's computed counters.
//!
//! A copy of flow-domain's own, kept here because module crates don't
//! depend on each other and the flow port (its `weldsuite-flow-domain`
//! crate) lands separately; fold it into that crate once both are merged.

use serde_json::{Value, json};
use sqlx::PgPool;

/// `resolveProjectAccess(db, userId, { scopeAll }, projectId).canWrite`.
pub(crate) async fn can_write_project(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    let project: Option<(Option<String>, bool)> = sqlx::query_as(
        "select project_manager_id, deleted_at is not null from projects where id = $1 limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let member_role: Option<Option<String>> = sqlx::query_scalar(
        "select role from project_members
         where project_id = $1 and user_id = $2 and is_active = true and deleted_at is null
         limit 1",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (manager, deleted) = project.unwrap_or((None, false));
    if deleted {
        return Ok(false);
    }
    let is_manager = manager.as_deref().is_some_and(|m| !m.is_empty() && m == user_id);
    let project_role = member_role
        .map(|role| role.unwrap_or_default().to_lowercase())
        .filter(|role| !role.is_empty());
    let role = project_role.or_else(|| is_manager.then(|| "owner".to_owned()));
    let is_admin =
        scope_all || is_manager || matches!(role.as_deref(), Some("owner" | "admin"));
    Ok(is_admin || role.as_deref() == Some("member"))
}

/// `(Math.round(n * 100) / 100).toFixed(2)` for the non-negative values here.
fn two_decimals(value: f64) -> String {
    format!("{:.2}", (value * 100.0 + 0.5).floor() / 100.0)
}

/// `getProjectStats(db, [projectId]).get(projectId)`: the counters a
/// project's detail overlays on its row.
pub(crate) async fn project_stats(db: &PgPool, project_id: &str) -> Result<Value, sqlx::Error> {
    let tasks: Option<(i32, i32, i32)> = sqlx::query_as(
        "select count(*)::int,
                (count(*) filter (where status = 'done'))::int,
                (count(*) filter (where status = 'cancelled'))::int
         from tasks where project_id = $1 and deleted_at is null group by project_id",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let milestones: Option<(i32, i32)> = sqlx::query_as(
        "select count(*)::int, (count(*) filter (where status = 'completed'))::int
         from milestones where project_id = $1 and deleted_at is null group by project_id",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let minutes: Option<Option<String>> = sqlx::query_scalar(
        "select sum(duration)::text from time_entries
         where project_id = $1 and deleted_at is null and status <> 'rejected'
         group by project_id",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let (total, completed, cancelled) = tasks.unwrap_or((0, 0, 0));
    let (total_milestones, completed_milestones) = milestones.unwrap_or((0, 0));
    let countable = total - cancelled;
    let progress = if countable <= 0 {
        "0.00".to_owned()
    } else {
        format!(
            "{:.2}",
            f64::from(completed) / f64::from(countable) * 100.0
        )
    };
    let minutes: f64 = minutes
        .flatten()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0.0);
    let actual_hours = if minutes.is_finite() && minutes > 0.0 {
        two_decimals(minutes / 60.0)
    } else {
        "0.00".to_owned()
    };
    Ok(json!({
        "totalTasks": total,
        "completedTasks": completed,
        "openTasks": (total - completed - cancelled).max(0),
        "totalMilestones": total_milestones,
        "completedMilestones": completed_milestones,
        "progress": progress,
        "actualHours": actual_hours,
    }))
}
