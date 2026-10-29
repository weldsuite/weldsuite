//! `services/helpdesk/auto-assignment.ts`: hand a conversation to the next
//! agent of a department that has auto-assignment on (round robin over the
//! alphabetical roster, or the least loaded agent).

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::now;
use crate::tables::HELPDESK_AGENTS;

/// `autoAssignConversation(db, departmentId, conversationId)`: the agent's
/// user id and name, or `None` when nothing was assigned.
pub(crate) async fn auto_assign(
    db: &PgPool,
    department_id: &str,
    conversation_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let department: Option<(Option<bool>, Option<bool>)> = sqlx::query_as(
        "select auto_assignment, round_robin_assignment from helpdesk_departments
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(department_id)
    .fetch_optional(db)
    .await?;
    let Some((Some(true), round_robin)) = department else {
        return Ok(None);
    };
    let agents: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from helpdesk_agents a where a.status = 'active' and a.deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    let load = |agent: &Value| agent["currentActiveTickets"].as_f64().unwrap_or(0.0);
    let eligible: Vec<Value> = agents
        .into_iter()
        .map(|agent| HELPDESK_AGENTS.js(agent))
        .filter(|agent| {
            let in_department = agent["departmentId"].as_str() == Some(department_id)
                || agent["teamIds"]
                    .as_array()
                    .is_some_and(|teams| teams.iter().any(|t| t.as_str() == Some(department_id)));
            let cap = agent["maxActiveTickets"].as_f64().unwrap_or(10.0);
            in_department && load(agent) < cap
        })
        .collect();
    if eligible.is_empty() {
        return Ok(None);
    }
    let selected = if round_robin == Some(true) {
        let last: Option<Option<String>> = sqlx::query_scalar(
            "select assignee_id from helpdesk_conversations
             where department_id = $1 and deleted_at is null and assignee_id is not null
             order by updated_at desc limit 1",
        )
        .bind(department_id)
        .fetch_optional(db)
        .await?;
        let mut sorted = eligible;
        // `a.name.localeCompare(b.name)`: letters before case.
        sorted.sort_by(|a, b| {
            let (a, b) = (
                a["name"].as_str().unwrap_or_default(),
                b["name"].as_str().unwrap_or_default(),
            );
            a.to_lowercase()
                .cmp(&b.to_lowercase())
                .then_with(|| b.cmp(a))
        });
        let next = match last.flatten() {
            Some(last) => sorted
                .iter()
                .position(|a| a["userId"].as_str() == Some(last.as_str()))
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
    let user_id = selected["userId"].as_str().unwrap_or_default().to_owned();
    let name = selected["name"].as_str().unwrap_or_default().to_owned();
    let now = now();
    sqlx::query(
        "update helpdesk_conversations set assignee_id = $2, assignee_name = $3, updated_at = $4::timestamp where id = $1",
    )
    .bind(conversation_id)
    .bind(&user_id)
    .bind(&name)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update helpdesk_agents set current_active_tickets = current_active_tickets + 1, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(selected["id"].as_str().unwrap_or_default())
    .bind(&now)
    .execute(db)
    .await?;
    Ok(Some((user_id, name)))
}
