//! Who can see, use and change a WeldAgent agent
//! (`packages/domains/agent/src/access.ts`).
//!
//! An agent is treated like a teammate with a manager: its owner decides who
//! may work with it (`visibility`), can change it, and receives its approvals.
//! Workspace permissions open the door (`weldagent:read` to see agents,
//! `weldagent:use` to chat, `weldagent:update` to edit); this adds the
//! per-agent layer on top. Holders of `weldagent:manage` see and fix every
//! agent.
//!
//! The visibility rule itself (`canAccessAgent`, `agentVisibleTo`) is shared
//! with chat and merge in `weldsuite_chat_domain::agents`.

use sqlx::PgPool;
pub use weldsuite_chat_domain::agents::{
    AgentAccess, AgentViewer, agent_viewer_for, can_access_agent, inaccessible_agent_ids,
};
use weldsuite_kit::generate_id;

/// `AGENT_VISIBILITIES`.
pub const AGENT_VISIBILITIES: [&str; 3] = ["private", "members", "workspace"];

/// `SYSTEM_VIEWER`: an unattended caller (event runs, routines, jobs) sees
/// every agent.
pub fn system_viewer() -> AgentViewer {
    AgentViewer {
        user_id: String::new(),
        can_manage_all: true,
    }
}

/// `canEditAgent(agent, viewer)`: the owner or a manager; an ownerless legacy
/// agent stays editable by anyone with `weldagent:update`, as before
/// ownership existed.
pub fn can_edit_agent(owner_id: Option<&str>, viewer: &AgentViewer) -> bool {
    if viewer.can_manage_all {
        return true;
    }
    match owner_id {
        None | Some("") => true,
        Some(owner) => owner == viewer.user_id,
    }
}

/// `agentVisibleTo(viewer)` as a SQL condition on `weldagent_agents a`, with
/// the viewer's user id as parameter `$user` (the caller binds it). `None`
/// means every agent.
pub fn visible_to_sql(viewer: &AgentViewer, user_param: &str) -> Option<String> {
    if viewer.can_manage_all {
        return None;
    }
    Some(format!(
        "(a.owner_id = {user_param} or a.visibility = 'workspace' or (a.visibility = 'members' \
         and exists (select 1 from weldagent_agent_members m where m.agent_id = a.id and m.user_id = {user_param})))"
    ))
}

/// `listAgentMemberIds(db, agentId)`: members given access to the agent
/// (visibility `members`).
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_agent_member_ids(
    db: &PgPool,
    agent_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("select user_id from weldagent_agent_members where agent_id = $1")
        .bind(agent_id)
        .fetch_all(db)
        .await
}

/// `setAgentMembers(db, agentId, userIds, createdBy)`: replace the agent's
/// member list.
///
/// # Errors
///
/// The tenant database fails.
pub async fn set_agent_members(
    db: &PgPool,
    agent_id: &str,
    user_ids: &[String],
    created_by: &str,
) -> Result<(), sqlx::Error> {
    let mut wanted: Vec<&String> = Vec::new();
    for id in user_ids {
        if !id.is_empty() && !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    let current = list_agent_member_ids(db, agent_id).await?;
    let to_remove: Vec<&String> = current.iter().filter(|id| !wanted.contains(id)).collect();
    if !to_remove.is_empty() {
        sqlx::query(
            "delete from weldagent_agent_members where agent_id = $1 and user_id = any($2)",
        )
        .bind(agent_id)
        .bind(to_remove)
        .execute(db)
        .await?;
    }
    for user_id in wanted.into_iter().filter(|id| !current.contains(id)) {
        sqlx::query(
            "insert into weldagent_agent_members (id, agent_id, user_id, created_by)
             values ($1, $2, $3, $4) on conflict do nothing",
        )
        .bind(generate_id("agm"))
        .bind(agent_id)
        .bind(user_id)
        .bind(created_by)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(user: &str, manage: bool) -> AgentViewer {
        AgentViewer {
            user_id: user.to_owned(),
            can_manage_all: manage,
        }
    }

    #[test]
    fn owner_and_managers_edit_ownerless_agents_are_open() {
        assert!(can_edit_agent(Some("u1"), &viewer("u1", false)));
        assert!(!can_edit_agent(Some("u1"), &viewer("u2", false)));
        assert!(can_edit_agent(Some("u1"), &viewer("u2", true)));
        assert!(can_edit_agent(None, &viewer("u2", false)));
    }

    #[test]
    fn managers_see_every_agent_in_sql() {
        assert!(visible_to_sql(&viewer("u1", true), "$1").is_none());
        let sql = visible_to_sql(&viewer("u1", false), "$1").unwrap();
        assert!(sql.contains("a.visibility = 'workspace'"));
        assert!(sql.contains("weldagent_agent_members"));
    }
}
