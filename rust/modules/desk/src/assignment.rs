//! `services/helpdesk/auto-assignment.ts`: hand a conversation to the next
//! agent of a department that has auto-assignment on (round robin over the
//! alphabetical roster, or the least loaded agent).

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_schema::tenant::{helpdesk_agents, helpdesk_conversations, helpdesk_departments};

/// `autoAssignConversation(db, departmentId, conversationId)`: the agent's
/// user id and name, or `None` when nothing was assigned.
pub(crate) async fn auto_assign(
    db: &PgPool,
    department_id: &str,
    conversation_id: &str,
) -> Result<Option<(String, String)>, DbErr> {
    let db = orm(db);
    let department: Option<(Option<bool>, Option<bool>)> = helpdesk_departments::Entity::find()
        .select_only()
        .column(helpdesk_departments::Column::AutoAssignment)
        .column(helpdesk_departments::Column::RoundRobinAssignment)
        .filter(helpdesk_departments::Column::Id.eq(department_id))
        .filter(helpdesk_departments::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&db)
        .await?;
    let Some((Some(true), round_robin)) = department else {
        return Ok(None);
    };
    let agents = helpdesk_agents::Entity::find()
        .filter(helpdesk_agents::Column::Status.eq("active"))
        .filter(helpdesk_agents::Column::DeletedAt.is_null())
        .all(&db)
        .await?;
    let load = |agent: &helpdesk_agents::Model| agent.current_active_tickets.unwrap_or(0);
    let eligible: Vec<helpdesk_agents::Model> = agents
        .into_iter()
        .filter(|agent| {
            let in_department = agent.department_id.as_deref() == Some(department_id)
                || agent
                    .team_ids
                    .as_ref()
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|teams| teams.iter().any(|t| t.as_str() == Some(department_id)));
            let cap = agent.max_active_tickets.unwrap_or(10);
            in_department && load(agent) < cap
        })
        .collect();
    if eligible.is_empty() {
        return Ok(None);
    }
    let selected = if round_robin == Some(true) {
        let last: Option<Option<String>> = helpdesk_conversations::Entity::find()
            .select_only()
            .column(helpdesk_conversations::Column::AssigneeId)
            .filter(helpdesk_conversations::Column::DepartmentId.eq(department_id))
            .filter(helpdesk_conversations::Column::DeletedAt.is_null())
            .filter(helpdesk_conversations::Column::AssigneeId.is_not_null())
            .order_by_desc(helpdesk_conversations::Column::UpdatedAt)
            .limit(1)
            .into_tuple()
            .one(&db)
            .await?;
        let mut sorted = eligible;
        // `a.name.localeCompare(b.name)`: letters before case.
        sorted.sort_by(|a, b| {
            let (a, b) = (a.name.as_str(), b.name.as_str());
            a.to_lowercase()
                .cmp(&b.to_lowercase())
                .then_with(|| b.cmp(a))
        });
        let next = match last.flatten() {
            Some(last) => sorted
                .iter()
                .position(|a| a.user_id == last)
                .map_or(0, |i| (i + 1) % sorted.len()),
            None => 0,
        };
        sorted.swap_remove(next)
    } else {
        let mut best = 0;
        for (index, agent) in eligible.iter().enumerate() {
            if load(agent) < load(&eligible[best]) {
                best = index;
            }
        }
        eligible[best].clone()
    };
    let now = utc_now();
    helpdesk_conversations::Entity::update_many()
        .col_expr(
            helpdesk_conversations::Column::AssigneeId,
            Expr::value(&selected.user_id),
        )
        .col_expr(
            helpdesk_conversations::Column::AssigneeName,
            Expr::value(&selected.name),
        )
        .col_expr(helpdesk_conversations::Column::UpdatedAt, Expr::value(now))
        .filter(helpdesk_conversations::Column::Id.eq(conversation_id))
        .exec(&db)
        .await?;
    helpdesk_agents::Entity::update_many()
        .col_expr(
            helpdesk_agents::Column::CurrentActiveTickets,
            sea_orm::ExprTrait::add(Expr::col(helpdesk_agents::Column::CurrentActiveTickets), 1),
        )
        .col_expr(helpdesk_agents::Column::UpdatedAt, Expr::value(now))
        .filter(helpdesk_agents::Column::Id.eq(&selected.id))
        .exec(&db)
        .await?;
    Ok(Some((selected.user_id, selected.name)))
}
