//! Run persistence (`packages/domains/agent/src/agents.ts`: `createAgentRun`,
//! `markRunRunning`, `completeAgentRun`, `findAgentsForEvent`). The agent loop
//! ([`crate::run`]) and the dispatchers write through these.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::agents::list_agents;

/// `createAgentRun(db, input)`: a run row (`queued` unless given).
///
/// # Errors
///
/// The tenant database fails.
pub async fn create_agent_run(
    db: &PgPool,
    agent_id: &str,
    status: Option<&str>,
    trigger_type: &str,
    trigger_data: Option<&Value>,
) -> Result<String, sqlx::Error> {
    let id = generate_id("run");
    sqlx::query(
        "insert into weldagent_agent_runs (id, agent_id, status, trigger_type, trigger_data, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)",
    )
    .bind(&id)
    .bind(agent_id)
    .bind(status.unwrap_or("queued"))
    .bind(trigger_type)
    .bind(trigger_data)
    .bind(crate::now())
    .execute(db)
    .await?;
    Ok(id)
}

/// `markRunRunning(db, runId)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn mark_run_running(db: &PgPool, run_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("update weldagent_agent_runs set status = 'running', started_at = $2::timestamptz where id = $1")
        .bind(run_id)
        .bind(crate::now())
        .execute(db)
        .await?;
    Ok(())
}

/// What `completeAgentRun` records.
#[derive(Debug, Default)]
pub struct RunCompletion {
    pub success: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub total_iterations: i64,
    pub total_tokens_used: i64,
    pub tool_call_count: i64,
}

/// `completeAgentRun(db, input)`: finish the run row and move the agent's run
/// counters.
///
/// # Errors
///
/// The tenant database fails.
pub async fn complete_agent_run(
    db: &PgPool,
    run_id: &str,
    agent_id: &str,
    done: RunCompletion,
) -> Result<(), sqlx::Error> {
    let stamp = crate::now();
    let status = if done.success { "completed" } else { "failed" };
    sqlx::query(
        "update weldagent_agent_runs
         set status = $2, completed_at = $3::timestamptz,
             duration_ms = case when started_at is null then null
                           else (extract(epoch from ($3::timestamptz - started_at)) * 1000)::int end,
             result = $4::jsonb, error = $5, total_iterations = $6::int, total_tokens_used = $7::int,
             tool_call_count = $8::int
         where id = $1",
    )
    .bind(run_id)
    .bind(status)
    .bind(&stamp)
    .bind(&done.result)
    .bind(&done.error)
    .bind(done.total_iterations)
    .bind(done.total_tokens_used)
    .bind(done.tool_call_count)
    .execute(db)
    .await?;
    sqlx::query(
        "update weldagent_agents
         set total_runs = total_runs + 1,
             successful_runs = successful_runs + case when $2 then 1 else 0 end,
             failed_runs = failed_runs + case when $2 then 0 else 1 end,
             last_run_at = $3::timestamptz, last_run_status = $4, updated_at = $3::timestamptz
         where id = $1",
    )
    .bind(agent_id)
    .bind(done.success)
    .bind(&stamp)
    .bind(status)
    .execute(db)
    .await?;
    Ok(())
}

/// `findAgentsForEvent(db, eventKey)`: active agents subscribed to an event
/// key (`person.created`) or to `*`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_agents_for_event(
    db: &PgPool,
    event_key: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let agents = list_agents(db, Some("active"), &crate::access::system_viewer()).await?;
    Ok(agents
        .into_iter()
        .filter(|agent| {
            agent["eventSubscriptions"]
                .as_array()
                .is_some_and(|subs| subs.iter().any(|s| s == event_key || s == "*"))
        })
        .collect())
}

/// `hasExistingAgentRunForEvent(db, agentId, eventId)`: whether this agent
/// already has a run whose `triggerData.eventId` matches (hub redelivery).
///
/// # Errors
///
/// The tenant database fails.
pub async fn has_existing_agent_run_for_event(
    db: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (select 1 from weldagent_agent_runs where agent_id = $1 and trigger_data->>'eventId' = $2)",
    )
    .bind(agent_id)
    .bind(event_id)
    .fetch_one(db)
    .await
}
