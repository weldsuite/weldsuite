//! Who may bring a workspace agent into a room, or hand it work
//! (`@weldsuite/agent-domain/access`: `agentViewerFor`, `inaccessibleAgentIds`;
//! `@weldsuite/core-domain/agent-access`: `canAccessAgent`). The agent rules
//! chat-api and the merge module read (an issue assigned to an agent), until
//! the agent module is ported with its own domain crate.

use sqlx::PgPool;
use weldsuite_permissions::{PermissionSubject, has_app_permission, has_permission};

/// `AgentViewer`: the person looking at agents, and whether they manage every agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentViewer {
    pub user_id: String,
    pub can_manage_all: bool,
}

/// `agentViewerFor(userId, permissions)`: `granterHolds(permissions, 'weldagent:manage')`.
pub fn agent_viewer_for<P: PermissionSubject + ?Sized>(
    user_id: &str,
    permissions: Option<&P>,
) -> AgentViewer {
    let can_manage_all = permissions.is_some_and(|p| {
        has_permission(p.permissions(), "weldagent:manage")
            || has_app_permission(p, "weldagent:manage", None)
    });
    AgentViewer {
        user_id: user_id.to_owned(),
        can_manage_all,
    }
}

/// What the rule reads of an agent row (`AgentAccessFields`).
#[derive(Debug, Clone, Copy)]
pub struct AgentAccess<'a> {
    pub id: &'a str,
    pub owner_id: Option<&'a str>,
    pub visibility: &'a str,
}

/// `canAccessAgent(db, agent, viewer)`: managers reach every agent, everyone
/// a `workspace` one, the owner their own, and a `members` agent its listed
/// members (`weldagent_agent_members`).
///
/// # Errors
///
/// The tenant database fails.
pub async fn can_access_agent(
    db: &PgPool,
    agent: &AgentAccess<'_>,
    viewer: &AgentViewer,
) -> Result<bool, sqlx::Error> {
    if viewer.can_manage_all || agent.visibility == "workspace" {
        return Ok(true);
    }
    if agent
        .owner_id
        .is_some_and(|owner| !owner.is_empty() && owner == viewer.user_id)
    {
        return Ok(true);
    }
    if agent.visibility != "members" {
        return Ok(false);
    }
    let member: Option<String> = sqlx::query_scalar(
        "select id from weldagent_agent_members where agent_id = $1 and user_id = $2 limit 1",
    )
    .bind(agent.id)
    .bind(&viewer.user_id)
    .fetch_optional(db)
    .await?;
    Ok(member.is_some())
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
    Ok(agent_ids
        .iter()
        .filter(|id| !ok.contains(id))
        .cloned()
        .collect())
}
