//! WeldAgent's tools into the other modules (`weldsuite_agent::tools::ModuleTools`):
//! spreadsheets, boards and WeldMerge, in process.
//!
//! On Global agent-api calls `sheets-api`, `board-api` and `merge-api` over
//! their internal service bindings. Here the module crates' own library
//! surface does the work (`weldsuite_sheets::agent_call`,
//! `weldsuite_board::agent_call`, `weldsuite_merge::agent_tool`), installed
//! once when the server mounts the agent module. Each call acts for the person
//! the agent works for; the module checks their permissions and access as they
//! are now.
//!
//! Only `serve` installs it. The consume and cron roles do not run agents
//! themselves when they can avoid it: with `RESTATE_INGRESS_URL` the routine
//! sweep and the `weldagent` subscriber enqueue each run as a `weldagent.job`
//! (`weldsuite_agent::launch`), which `serve` runs with these tools. Without
//! a jobs backend that reaches `serve` they run inline and these three tools
//! answer that the module is not available to agents here.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_agent::tools::{ModuleCall, ModuleTools};
use weldsuite_db::{ReadOnlyReason, Tenant, Workspaces};
use weldsuite_ports::BoxFuture;

use super::{AppState, file_stores, merge_state};

pub(super) struct AppModules {
    sheets: weldsuite_sheets::SheetsState,
    board: weldsuite_board::BoardState,
    merge: weldsuite_merge::MergeState,
    workspaces: Arc<Workspaces>,
}

impl AppModules {
    pub(super) fn new(state: &AppState) -> Self {
        let events = state.infra.events.clone();
        Self {
            sheets: weldsuite_sheets::SheetsState {
                events: events.clone(),
                files: file_stores(state),
                collab: crate::collab::rooms(state),
            },
            board: weldsuite_board::BoardState {
                events,
                files: file_stores(state),
                collab: crate::collab::rooms(state),
                links: None,
                ai: None,
                master: Some(state.workspaces.master().clone()),
            },
            merge: merge_state(state),
            workspaces: Arc::clone(&state.workspaces),
        }
    }

    /// The workspace a call is for, from either id (a run carries whichever
    /// the event or request had): the same resolution the HTTP middleware
    /// does (cached, from the master `workspaces` row), so the restrictions
    /// are the ones a request to that workspace would meet right now.
    async fn workspace(&self, reference: &str) -> Result<WorkspaceScope, String> {
        match self.workspaces.tenant(reference).await {
            Ok(tenant) => Ok(WorkspaceScope::of(&tenant, reference)),
            Err(error) => {
                tracing::error!(%error, reference, "[weldagent] cannot resolve the workspace of a module tool");
                Err("Internal server error".to_owned())
            }
        }
    }
}

/// What a module call needs to know about its workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceScope {
    /// `workspaces.id`.
    id: String,
    /// The organization id (room names and bucket keys use it).
    org: String,
    /// Why the workspace may only be read (`readOnlyReason`).
    read_only: Option<ReadOnlyReason>,
}

impl WorkspaceScope {
    fn of(tenant: &Tenant, reference: &str) -> Self {
        Self {
            id: tenant.workspace_id.clone(),
            org: tenant
                .clerk_org_id
                .clone()
                .unwrap_or_else(|| reference.to_owned()),
            read_only: tenant
                .restrictions
                .read_only
                .then(|| tenant.read_only_reason())
                .flatten(),
        }
    }
}

impl ModuleTools for AppModules {
    fn call<'a>(&'a self, call: ModuleCall<'a>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let WorkspaceScope {
                id: workspace_id,
                org: clerk_org_id,
                read_only,
            } = self.workspace(call.workspace_id).await?;
            match call.module {
                "sheets" => {
                    let scope = weldsuite_sheets::AgentScope {
                        db: call.db,
                        user_id: call.user_id,
                        clerk_org_id: &clerk_org_id,
                        read_only,
                    };
                    weldsuite_sheets::agent_call(
                        &self.sheets,
                        &scope,
                        call.op,
                        call.id,
                        &call.input,
                    )
                    .await
                }
                "boards" => {
                    let scope = weldsuite_board::AgentScope {
                        db: call.db,
                        user_id: call.user_id,
                        clerk_org_id: &clerk_org_id,
                        workspace_id: &workspace_id,
                        read_only,
                    };
                    weldsuite_board::agent_call(&self.board, &scope, call.op, call.id, &call.input)
                        .await
                }
                "merge" => {
                    weldsuite_merge::agent_tool(
                        &self.merge,
                        call.db,
                        &workspace_id,
                        Some(&clerk_org_id),
                        call.user_id,
                        call.agent_id,
                        call.op,
                        &call.input,
                    )
                    .await
                }
                other => Err(format!("Unknown module {other}")),
            }
        })
    }
}

/// Installs the surface for the agent tools of this process.
pub(super) fn install(state: &AppState) {
    weldsuite_agent::tools::install_module_tools(Arc::new(AppModules::new(state)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_db::WorkspaceRestrictions;

    fn tenant(restrictions: WorkspaceRestrictions) -> Tenant {
        Tenant {
            workspace_id: "ws_1".into(),
            clerk_org_id: Some("org_1".into()),
            db: sqlx::PgPool::connect_lazy("postgres://localhost/none").expect("lazy"),
            suspended: false,
            restrictions,
        }
    }

    #[tokio::test]
    async fn a_writable_workspace_carries_no_read_only_reason() {
        let scope = WorkspaceScope::of(&tenant(WorkspaceRestrictions::default()), "ws_1");
        assert_eq!(scope.read_only, None);
        assert_eq!((scope.id.as_str(), scope.org.as_str()), ("ws_1", "org_1"));
    }

    #[tokio::test]
    async fn a_read_only_workspace_carries_its_reason() {
        for reason in [
            ReadOnlyReason::PartnerSuspended,
            ReadOnlyReason::LicenceInactive,
            ReadOnlyReason::DatabaseMove,
        ] {
            let scope = WorkspaceScope::of(
                &tenant(WorkspaceRestrictions {
                    licensed_apps: None,
                    read_only: true,
                    read_only_reason: Some(reason),
                }),
                "ws_1",
            );
            assert_eq!(scope.read_only, Some(reason));
        }
    }

    #[tokio::test]
    async fn the_organization_falls_back_to_the_reference() {
        let mut t = tenant(WorkspaceRestrictions::default());
        t.clerk_org_id = None;
        assert_eq!(WorkspaceScope::of(&t, "ws_1").org, "ws_1");
    }
}
