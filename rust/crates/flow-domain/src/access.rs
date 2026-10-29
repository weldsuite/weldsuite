//! What a user may do on one project (`@weldsuite/flow-domain/project-access`),
//! context-free so the WeldConnect `create_task` action can run the same
//! check for a workflow's owner.
//!
//! - admin: `projects:scope:all`, the project manager, or an owner/admin member
//! - write: admin, or a `member` role (viewers are read-only)
//! - read: write, or a `viewer` role
//!
//! Roles compare case-insensitively. A soft-deleted project grants nothing.

use sqlx::PgPool;

/// The resolved access (`ProjectAccess`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAccess {
    /// The member row's role (lowercased), else `owner` for the manager.
    pub role: Option<String>,
    pub is_manager: bool,
    pub scope_all: bool,
    /// An active member row exists (any role, unknown ones included).
    pub is_member: bool,
    pub can_read: bool,
    pub can_write: bool,
    pub is_admin: bool,
    /// The project is soft-deleted: nothing is granted.
    pub deleted: bool,
}

impl ProjectAccess {
    /// The read rule (`mayAccess`): a soft-deleted project is off-limits to
    /// everyone, scope:all holders included.
    pub fn may_access(&self) -> bool {
        !self.deleted && (self.scope_all || self.is_manager || self.is_member)
    }

    /// `canChangeOwners`: scope:all, the manager, or an owner member.
    pub fn can_change_owners(&self) -> bool {
        !self.deleted
            && (self.scope_all || self.is_manager || self.role.as_deref() == Some("owner"))
    }
}

/// `resolveProjectAccess(db, userId, { scopeAll }, projectId)`.
pub async fn resolve_project_access(
    db: &PgPool,
    user_id: Option<&str>,
    scope_all: bool,
    project_id: &str,
) -> Result<ProjectAccess, sqlx::Error> {
    let (is_manager, member_role, deleted) = if let Some(user_id) = user_id {
        let project: Option<(Option<String>, bool)> = sqlx::query_as(
            "select project_manager_id, deleted_at is not null from projects where id = $1 limit 1",
        )
        .bind(project_id)
        .fetch_optional(db)
        .await?;
        let role: Option<String> = sqlx::query_scalar(
            "select role from project_members
             where project_id = $1 and user_id = $2 and is_active = true and deleted_at is null
             limit 1",
        )
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?;
        let (manager, deleted) = project.unwrap_or((None, false));
        let is_manager = manager.is_some_and(|m| !m.is_empty() && m == user_id);
        (is_manager, role, deleted)
    } else {
        let deleted: Option<bool> =
            sqlx::query_scalar("select deleted_at is not null from projects where id = $1 limit 1")
                .bind(project_id)
                .fetch_optional(db)
                .await?;
        (false, None, deleted.unwrap_or(false))
    };
    if deleted {
        return Ok(ProjectAccess {
            role: None,
            is_manager: false,
            scope_all,
            is_member: false,
            can_read: false,
            can_write: false,
            is_admin: false,
            deleted: true,
        });
    }
    let project_role = member_role
        .as_deref()
        .map(str::to_lowercase)
        .filter(|role| !role.is_empty());
    let role = project_role.or_else(|| is_manager.then(|| "owner".to_owned()));
    let is_admin = scope_all || is_manager || matches!(role.as_deref(), Some("owner" | "admin"));
    let can_write = is_admin || role.as_deref() == Some("member");
    let can_read = can_write || role.as_deref() == Some("viewer");
    Ok(ProjectAccess {
        role,
        is_manager,
        scope_all,
        is_member: member_role.is_some(),
        can_read,
        can_write,
        is_admin,
        deleted: false,
    })
}

/// May this user write to this project (`canWriteProject`)?
pub async fn can_write_project(
    db: &PgPool,
    user_id: Option<&str>,
    scope_all: bool,
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    Ok(resolve_project_access(db, user_id, scope_all, project_id)
        .await?
        .can_write)
}

/// The live projects a user manages or actively belongs to
/// (`accessibleProjectIds` without scope:all): managed ones first, then
/// memberships, each once.
pub async fn member_project_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let managed: Vec<String> = sqlx::query_scalar(
        "select id from projects where project_manager_id = $1 and deleted_at is null",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let member_of: Vec<String> = sqlx::query_scalar(
        "select pm.project_id from project_members pm
         inner join projects p on p.id = pm.project_id
         where pm.user_id = $1 and pm.is_active = true and pm.deleted_at is null
           and p.deleted_at is null",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut ids: Vec<String> = Vec::with_capacity(managed.len() + member_of.len());
    for id in managed.into_iter().chain(member_of) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}
