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

use sea_orm::sea_query::{Expr, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use sqlx::PgPool;
pub use weldsuite_chat_domain::agents::{
    AgentAccess, AgentViewer, agent_viewer_for, can_access_agent, inaccessible_agent_ids,
};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldagent_agent_members as members, weldagent_agents as agents};

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

/// `agentVisibleTo(viewer)` as a condition on `weldagent_agents`: owned by
/// the viewer, visible to the workspace, or shared with them as a member.
/// `None` means every agent.
pub fn visible_to(viewer: &AgentViewer) -> Option<Condition> {
    if viewer.can_manage_all {
        return None;
    }
    let member = Query::select()
        .expr(Expr::value(1))
        .from(members::Entity)
        .and_where(sea_orm::ExprTrait::equals(
            Expr::col((members::Entity, members::Column::AgentId)),
            (agents::Entity, agents::Column::Id),
        ))
        .and_where(sea_orm::ExprTrait::eq(
            Expr::col((members::Entity, members::Column::UserId)),
            viewer.user_id.clone(),
        ))
        .to_owned();
    Some(
        Condition::any()
            .add(agents::Column::OwnerId.eq(viewer.user_id.clone()))
            .add(agents::Column::Visibility.eq("workspace"))
            .add(
                Condition::all()
                    .add(agents::Column::Visibility.eq("members"))
                    .add(Expr::exists(member)),
            ),
    )
}

/// `listAgentMemberIds(db, agentId)`: members given access to the agent
/// (visibility `members`).
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_agent_member_ids(db: &PgPool, agent_id: &str) -> Result<Vec<String>, DbErr> {
    members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::AgentId.eq(agent_id))
        .into_tuple::<String>()
        .all(&orm(db))
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
) -> Result<(), DbErr> {
    let mut wanted: Vec<&String> = Vec::new();
    for id in user_ids {
        if !id.is_empty() && !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    let current = list_agent_member_ids(db, agent_id).await?;
    let to_remove: Vec<&String> = current.iter().filter(|id| !wanted.contains(id)).collect();
    let conn = orm(db);
    if !to_remove.is_empty() {
        members::Entity::delete_many()
            .filter(members::Column::AgentId.eq(agent_id))
            .filter(members::Column::UserId.is_in(to_remove.iter().map(|id| id.as_str())))
            .exec(&conn)
            .await?;
    }
    for user_id in wanted.into_iter().filter(|id| !current.contains(id)) {
        members::Entity::insert(members::ActiveModel {
            id: Set(generate_id("agm")),
            agent_id: Set(agent_id.to_owned()),
            user_id: Set(user_id.clone()),
            created_by: Set(Some(created_by.to_owned())),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&conn)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sea_orm::{DbBackend, QueryTrait};

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
    fn managers_see_every_agent() {
        assert!(visible_to(&viewer("u1", true)).is_none());
        let condition = visible_to(&viewer("u1", false)).unwrap();
        let sql = agents::Entity::find()
            .filter(condition)
            .build(DbBackend::Postgres)
            .to_string();
        assert!(sql.contains("'workspace'"), "{sql}");
        assert!(
            sql.contains("EXISTS(SELECT 1 FROM \"weldagent_agent_members\""),
            "{sql}"
        );
    }
}
