//! The WeldFlow rules the record chat providers read
//! (`@weldsuite/flow-domain/project-access`, `/project-stats`): who may
//! write in a project, and a project's computed counters.
//!
//! A copy of flow-domain's own, kept here because module crates don't
//! depend on each other and the flow port (its `weldsuite-flow-domain`
//! crate) lands separately; fold it into that crate once both are merged.

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{milestones, project_members, projects, tasks, time_entries};

/// `resolveProjectAccess(db, userId, { scopeAll }, projectId).canWrite`.
pub(crate) async fn can_write_project(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
    project_id: &str,
) -> Result<bool, DbErr> {
    let db = orm(db);
    let project: Option<(Option<String>, bool)> = projects::Entity::find()
        .select_only()
        .column(projects::Column::ProjectManagerId)
        .expr(projects::Column::DeletedAt.is_not_null())
        .filter(projects::Column::Id.eq(project_id))
        .into_tuple()
        .one(&db)
        .await?;
    let member_role: Option<String> = project_members::Entity::find()
        .select_only()
        .column(project_members::Column::Role)
        .filter(project_members::Column::ProjectId.eq(project_id))
        .filter(project_members::Column::UserId.eq(user_id))
        .filter(project_members::Column::IsActive.eq(true))
        .filter(project_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let (manager, deleted) = project.unwrap_or((None, false));
    if deleted {
        return Ok(false);
    }
    let is_manager = manager
        .as_deref()
        .is_some_and(|m| !m.is_empty() && m == user_id);
    let project_role = member_role
        .map(|role| role.to_lowercase())
        .filter(|role| !role.is_empty());
    let role = project_role.or_else(|| is_manager.then(|| "owner".to_owned()));
    let is_admin = scope_all || is_manager || matches!(role.as_deref(), Some("owner" | "admin"));
    Ok(is_admin || role.as_deref() == Some("member"))
}

/// `(Math.round(n * 100) / 100).toFixed(2)` for the non-negative values here.
fn two_decimals(value: f64) -> String {
    format!("{:.2}", (value * 100.0 + 0.5).floor() / 100.0)
}

/// `getProjectStats(db, [projectId]).get(projectId)`: the counters a
/// project's detail overlays on its row.
pub(crate) async fn project_stats(db: &PgPool, project_id: &str) -> Result<Value, DbErr> {
    let db = orm(db);
    // `count(*)::int` and `(count(*) filter (where …))::int`: the case is
    // null for the rows it leaves out, which COUNT skips.
    let int = |count: Expr| sea_orm::ExprTrait::cast_as(count, "int");
    let all = || int(Func::count(Expr::col(Asterisk)).into());
    let with_status = |column: Expr, status: &str| {
        int(Func::count(Expr::case(sea_orm::ExprTrait::eq(column, status), 1)).into())
    };
    let tasks: Option<(i32, i32, i32)> = tasks::Entity::find()
        .select_only()
        .expr(all())
        .expr(with_status(Expr::col(tasks::Column::Status), "done"))
        .expr(with_status(Expr::col(tasks::Column::Status), "cancelled"))
        .filter(tasks::Column::ProjectId.eq(project_id))
        .filter(tasks::Column::DeletedAt.is_null())
        .group_by(tasks::Column::ProjectId)
        .into_tuple()
        .one(&db)
        .await?;
    let milestones: Option<(i32, i32)> = milestones::Entity::find()
        .select_only()
        .expr(all())
        .expr(with_status(
            Expr::col(milestones::Column::Status),
            "completed",
        ))
        .filter(milestones::Column::ProjectId.eq(project_id))
        .filter(milestones::Column::DeletedAt.is_null())
        .group_by(milestones::Column::ProjectId)
        .into_tuple()
        .one(&db)
        .await?;
    let minutes: Option<Option<String>> = time_entries::Entity::find()
        .select_only()
        .expr(sea_orm::ExprTrait::cast_as(
            Func::sum(Expr::col(time_entries::Column::Duration)),
            "text",
        ))
        .filter(time_entries::Column::ProjectId.eq(project_id))
        .filter(time_entries::Column::DeletedAt.is_null())
        .filter(time_entries::Column::Status.ne("rejected"))
        .group_by(time_entries::Column::ProjectId)
        .into_tuple()
        .one(&db)
        .await?;
    let (total, completed, cancelled) = tasks.unwrap_or((0, 0, 0));
    let (total_milestones, completed_milestones) = milestones.unwrap_or((0, 0));
    let countable = total - cancelled;
    let progress = if countable <= 0 {
        "0.00".to_owned()
    } else {
        format!("{:.2}", f64::from(completed) / f64::from(countable) * 100.0)
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
