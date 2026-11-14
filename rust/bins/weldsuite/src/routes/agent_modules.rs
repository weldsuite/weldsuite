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
//! Only `serve` installs it: the consume and cron roles run agents without
//! these tools (they answer that the module is not available to agents here).

use std::sync::Arc;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_agent::tools::{ModuleCall, ModuleTools};
use weldsuite_ports::BoxFuture;

use super::{AppState, file_stores, merge_state};

pub(super) struct AppModules {
    sheets: weldsuite_sheets::SheetsState,
    board: weldsuite_board::BoardState,
    merge: weldsuite_merge::MergeState,
    master: PgPool,
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
            master: state.workspaces.master().clone(),
        }
    }

    /// `workspaces.id` and the Clerk org id, from either (a run carries
    /// whichever the event or request had).
    async fn workspace(&self, reference: &str) -> (String, String) {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, clerk_org_id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(reference)
        .fetch_optional(&self.master)
        .await
        .unwrap_or(None);
        match row {
            Some((id, org)) => (id, org.unwrap_or_else(|| reference.to_owned())),
            None => (reference.to_owned(), reference.to_owned()),
        }
    }
}

impl ModuleTools for AppModules {
    fn call<'a>(&'a self, call: ModuleCall<'a>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let (workspace_id, clerk_org_id) = self.workspace(call.workspace_id).await;
            match call.module {
                "sheets" => {
                    let scope = weldsuite_sheets::AgentScope {
                        db: call.db,
                        user_id: call.user_id,
                        clerk_org_id: &clerk_org_id,
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
