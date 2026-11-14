//! What the spreadsheet, board and WeldMerge tools reach: the other modules'
//! in-process surface.
//!
//! On Global these tools call `sheets-api`, `board-api` and `merge-api` over
//! their internal service bindings (`SheetsInternal`, `BoardsInternal`,
//! `MergeInternal.agentTool`). Here the module crates expose the same
//! operations as library functions (`weldsuite_sheets::agent_call`,
//! `weldsuite_board::agent_call`, `weldsuite_merge::agent_tool`); the binary
//! implements [`ModuleTools`] over them and installs it once at start
//! ([`install_module_tools`]), so the agent crate depends on none of them and
//! every place that builds a `ToolContext` (chat, runs, rooms, the consumer
//! and the cron) reaches the same implementation.
//!
//! Every call acts for the person the agent works for: the module checks
//! that member's permissions and drive or project access as they are now,
//! on top of the agent's own grants, which decided whether the tool was
//! offered at all.

use std::sync::{Arc, RwLock};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::BoxFuture;

use super::ToolContext;

/// One call into a module (a `sheets`, `boards` or `merge` operation).
pub struct ModuleCall<'a> {
    /// `sheets`, `boards` or `merge`.
    pub module: &'a str,
    /// The operation: `find`, `create`, `tabs`, `read`, `write`, `add`, `edit`,
    /// `update`, or a WeldMerge tool name (`merge_list_issues`).
    pub op: &'a str,
    /// The sheet or board the operation works on.
    pub id: Option<&'a str>,
    /// The workspace as the run carries it (`workspaces.id` or the Clerk org id).
    pub workspace_id: &'a str,
    /// The person the agent works for.
    pub user_id: &'a str,
    pub agent_id: &'a str,
    pub db: &'a PgPool,
    pub input: Value,
}

/// The modules' in-process surface. `Ok` is the operation's `data`; `Err` is
/// the refusal the module answered with, in words for the model.
pub trait ModuleTools: Send + Sync {
    fn call<'a>(&'a self, call: ModuleCall<'a>) -> BoxFuture<'a, Result<Value, String>>;
}

static INSTALLED: RwLock<Option<Arc<dyn ModuleTools>>> = RwLock::new(None);

/// Installs the process's module surface (the binary at start; a test its fake).
pub fn install_module_tools(tools: Arc<dyn ModuleTools>) {
    if let Ok(mut slot) = INSTALLED.write() {
        *slot = Some(tools);
    }
}

fn installed() -> Option<Arc<dyn ModuleTools>> {
    INSTALLED.read().ok().and_then(|slot| slot.clone())
}

/// Runs one module operation for the tool's context: the module's `data`, or
/// `{ "error": … }` the model can read (no surface installed, or a refusal).
pub(super) async fn call(
    ctx: &ToolContext,
    module: &str,
    op: &str,
    id: Option<&str>,
    input: Value,
    unavailable: &str,
) -> Value {
    let Some(tools) = installed() else {
        return json!({ "error": unavailable });
    };
    let call = ModuleCall {
        module,
        op,
        id,
        workspace_id: &ctx.workspace_id,
        user_id: &ctx.actor_user_id,
        agent_id: &ctx.agent_id,
        db: &ctx.db,
        input,
    };
    match tools.call(call).await {
        Ok(data) => data,
        Err(message) => json!({ "error": message }),
    }
}
