//! Who may bring a workspace agent into a room
//! (`@weldsuite/agent-domain/access`: `agentViewerFor`, `inaccessibleAgentIds`).
//! A copy of the agent rules chat-api reads, until the agent module is
//! ported with its own domain crate.

use sqlx::PgPool;
use weldsuite_permissions::{PermissionSubject, has_app_permission, has_permission};

/// `AgentViewer`: the person looking at agents, and whether they manage every agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentViewer {
    pub user_id: String,
    pub can_manage_all: bool,
}

/// `agentViewerFor(userId, permissions)`: `granterHolds(permissions, 'weldagent:manage')`.
pub fn agent_viewer_for<P: PermissionSubject + ?Sized>(user_id: &str, permissions: Option<&P>) -> AgentViewer {
    let can_manage_all = permissions.is_some_and(|p| {
        has_permission(p.permissions(), "weldagent:manage")
            || has_app_permission(p, "weldagent:manage", None)
    });
    AgentViewer {
        user_id: user_id.to_owned(),
        can_manage_all,
    }
}

/// `inaccessibleAgentIds(db, agentIds, viewer)`: the ids of `agent_ids` the
/// viewer may not use, in order.
pub async fn inaccessible_agent_ids(
    db: &PgPool,
    agent_ids: &[String],
    viewer: &AgentViewer,
) -> Result<Vec<String>, sqlx::Error> {
    if viewer.can_manage_all || agent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ok: Vec<String> = sqlx::query_scalar(
        "select a.id from weldagent_agents a
         where a.id = any($1) and a.deleted_at is null
           and (a.owner_id = $2 or a.visibility = 'workspace'
                or (a.visibility = 'members' and exists (
                     select 1 from weldagent_agent_members m
                     where m.agent_id = a.id and m.user_id = $2)))",
    )
    .bind(agent_ids)
    .bind(&viewer.user_id)
    .fetch_all(db)
    .await?;
    Ok(agent_ids.iter().filter(|id| !ok.contains(id)).cloned().collect())
}
