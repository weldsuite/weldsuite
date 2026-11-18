//! What WeldPanel's saved objects need from the server: the workspace behind
//! a public share link, opened through the app's `Workspaces`
//! (`getWorkspaceContextForOrg` on Global).

use weldsuite_db::WorkspaceError;
use weldsuite_panel::{OpenedWorkspace, WorkspaceTenants};
use weldsuite_ports::{BoxFuture, PortError};

use crate::cron::WorkspaceTenants as AppWorkspaces;

impl WorkspaceTenants for AppWorkspaces {
    fn open<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<OpenedWorkspace>, PortError>> {
        Box::pin(async move {
            match self.0.tenant(workspace_id).await {
                Ok(tenant) => Ok(Some(OpenedWorkspace {
                    db: tenant.db,
                    suspended: tenant.suspended,
                })),
                Err(WorkspaceError::NotFound) => Ok(None),
                Err(error) => Err(PortError::backend(error.to_string())),
            }
        })
    }
}
