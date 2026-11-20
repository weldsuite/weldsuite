//! Integrations act as the member who set them up (`services/creator-access.ts`,
//! ADR FORMS-006, as WeldConnect runs as its owner, CONN-004): each step
//! checks the creator's workspace permissions as they are now. A creator who
//! lost a permission, or left the workspace, makes the step skip with the
//! reason shown on the integration instead of writing records they could not
//! create themselves.
//!
//! Same rules as `requirePermission`: denies win, and a key refused in its
//! app but granted elsewhere is allowed unless app enforcement is on
//! (`PERMISSIONS_APP_ENFORCE`).

use sqlx::PgPool;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_permissions::{
    AppCheckMode, ResolvedPermissions, check_app_permission, resolve_effective_permissions,
};

use crate::common::{Env, Fail, FormsResult};

/// `CreatorForbiddenError`: the creator may not do this (or is no longer a
/// member). The step is skipped with this message, not retried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreatorForbidden(pub(crate) String);

impl std::fmt::Display for CreatorForbidden {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `CreatorAccess`.
#[derive(Debug, Clone)]
pub(crate) struct CreatorAccess {
    resolved: ResolvedPermissions,
    app_enforce: bool,
}

impl CreatorAccess {
    fn member(&self) -> bool {
        !self.resolved.role.is_empty()
    }

    /// Whether the creator holds `permission` in `app` right now.
    pub(crate) fn can(&self, permission: &str, app: &str) -> bool {
        if !self.member() {
            return false;
        }
        let in_app = check_app_permission(&self.resolved, permission, Some(app));
        let elsewhere = in_app.mode == AppCheckMode::App
            && check_app_permission(&self.resolved, permission, None).allowed;
        in_app.allowed || (elsewhere && !self.app_enforce)
    }

    /// `require(permission, app, doing)`: `doing` completes "is not allowed to …".
    pub(crate) fn require(
        &self,
        permission: &str,
        app: &str,
        doing: &str,
    ) -> Result<(), CreatorForbidden> {
        if !self.member() {
            return Err(CreatorForbidden(
                "The member who set up this integration is no longer in the workspace".to_owned(),
            ));
        }
        if !self.can(permission, app) {
            return Err(CreatorForbidden(format!(
                "The member who set up this integration is not allowed to {doing} ({permission})"
            )));
        }
        Ok(())
    }
}

/// `loadCreatorAccess(db, env, userId)`.
pub(crate) async fn load_creator_access(
    db: &PgPool,
    env: &Env,
    user_id: &str,
) -> FormsResult<CreatorAccess> {
    let queries = TenantPermissionQueries::new(db.clone());
    let resolved = resolve_effective_permissions(&queries, user_id)
        .await
        .map_err(|error| Fail::Internal(format!("forms: creator permissions: {error}")))?;
    Ok(CreatorAccess {
        resolved,
        app_enforce: env.get("PERMISSIONS_APP_ENFORCE").as_deref() == Some("true"),
    })
}
