//! Who may bring a workspace agent into a room, or hand it work
//! (`@weldsuite/agent-domain/access`: `agentViewerFor`, `inaccessibleAgentIds`;
//! `@weldsuite/core-domain/agent-access`: `canAccessAgent`). The agent rules
//! chat-api and the merge module read (an issue assigned to an agent), until
//! the agent module is ported with its own domain crate.

use sea_orm::sea_query::{Expr, Query};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_permissions::{PermissionSubject, has_app_permission, has_permission};
use weldsuite_schema::tenant::{
    weldagent_agent_members as agent_members, weldagent_agents as agents,
};

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
) -> Result<bool, DbErr> {
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
    let member: Option<String> = agent_members::Entity::find()
        .select_only()
        .column(agent_members::Column::Id)
        .filter(agent_members::Column::AgentId.eq(agent.id))
        .filter(agent_members::Column::UserId.eq(&viewer.user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(member.is_some())
}

/// `inaccessibleAgentIds(db, agentIds, viewer)`: the ids of `agent_ids` the
/// viewer may not use, in order.
pub async fn inaccessible_agent_ids(
    db: &PgPool,
    agent_ids: &[String],
    viewer: &AgentViewer,
) -> Result<Vec<String>, DbErr> {
    if viewer.can_manage_all || agent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ok: Vec<String> = agents::Entity::find()
        .select_only()
        .column(agents::Column::Id)
        .filter(agents::Column::Id.is_in(agent_ids.iter().map(String::as_str)))
        .filter(agents::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(agents::Column::OwnerId.eq(&viewer.user_id))
                .add(agents::Column::Visibility.eq("workspace"))
                .add(
                    Condition::all()
                        .add(agents::Column::Visibility.eq("members"))
                        .add(Expr::exists(listed_member(&viewer.user_id))),
                ),
        )
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(agent_ids
        .iter()
        .filter(|id| !ok.contains(id))
        .cloned()
        .collect())
}

/// `exists (select 1 from weldagent_agent_members m where m.agent_id = a.id
/// and m.user_id = $user)`.
fn listed_member(user_id: &str) -> sea_orm::sea_query::SelectStatement {
    use sea_orm::ExprTrait as _;
    Query::select()
        .expr(Expr::val(1))
        .from(agent_members::Entity)
        .and_where(
            Expr::col((agent_members::Entity, agent_members::Column::AgentId))
                .equals((agents::Entity, agents::Column::Id)),
        )
        .and_where(agent_members::Column::UserId.eq(user_id))
        .to_owned()
}
